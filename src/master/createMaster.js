'use strict';

const { loadConfig } = require('../config/loadConfig');
const { createLogger } = require('../logging/createLogger');
const { TimerRegistry } = require('../performance/TimerRegistry');
const { SseCoalescer } = require('../performance/SseCoalescer');
const { AiEfficiencyController } = require('../performance/AiEfficiencyController');
const { ResourceMonitor } = require('../monitoring/ResourceMonitor');
const { WorkloadGovernor } = require('../monitoring/WorkloadGovernor');
const { EventBus } = require('../events/EventBus');
const { StateStore } = require('../persistence/StateStore');
const { SchemaValidator } = require('../protocol/SchemaValidator');
const { InventoryLedger } = require('../inventory/InventoryLedger');
const { BotRegistry } = require('../workers/BotRegistry');
const { TaskManager } = require('../tasks/TaskManager');
const { TaskScheduler } = require('../scheduler/TaskScheduler');
const { Coordinator } = require('../coordinator/Coordinator');
const { WorldKnowledgeStore } = require('../knowledge/WorldKnowledgeStore');
const { AuthService } = require('../security/AuthService');
const { MasterHttpServer } = require('../interfaces/http/MasterHttpServer');

/**
 * Master Runtime Bootstrap (`MODULE_INTERFACES.md` §3.1).
 *
 * Validates config before opening resources, runs `StateStore` migrations & `Coordinator.recover()`,
 * wires `ResourceMonitor` -> `WorkloadGovernor` -> `SseCoalescer` / `Logger` pressure reactions,
 * provides `health()` probes, and performs deterministic reverse-order graceful shutdown.
 */
function createMaster(rawOrFrozenConfig = {}, dependencies = {}) {
  const config = Object.isFrozen(rawOrFrozenConfig)
    ? rawOrFrozenConfig
    : loadConfig({}, rawOrFrozenConfig);

  const timers = dependencies.timers || new TimerRegistry();
  const logger =
    dependencies.logger ||
    createLogger({
      level: config.logging.level,
      ringSize: config.logging.ringSize,
      filePath: config.logging.filePath,
      maxFileBytes: config.logging.maxFileBytes,
      maxFiles: config.logging.maxFiles,
      defaultFields: { service: 'master' }
    });

  const eventBus = dependencies.eventBus || new EventBus({ recentEventLimit: 500 });

  const governor =
    dependencies.governor ||
    new WorkloadGovernor({
      maxArchitecturalBots: config.capacity.maxArchitecturalBots ?? 20,
      globalBotCap: config.capacity.globalMaxBots,
      initialBotCap: config.capacity.initialEnabledBots,
      profile: config.performanceProfile || 'BALANCED'
    });

  const monitor =
    dependencies.monitor ||
    new ResourceMonitor({
      sampleIntervalMs: config.capacity.heartbeatIntervalMs,
      windowSize: 60,
      timerRegistry: timers,
      onSample: (sample) => {
        governor.evaluate(sample);
      }
    });

  const sseCoalescer =
    dependencies.sseCoalescer ||
    new SseCoalescer({
      flushIntervalMs: 1000,
      maxClients: 8,
      timerRegistry: timers,
      onFlushMetrics: (m) => monitor.recordDashboardUpdate(m)
    });

  const stateStore =
    dependencies.stateStore ||
    new StateStore({
      sqlitePath: config.storage.sqlitePath,
      monitor,
      logger: logger.child({ module: 'StateStore' })
    });

  const schemaValidator =
    dependencies.schemaValidator ||
    new SchemaValidator({
      allowedResources: dependencies.allowedResources || null
    });

  const inventoryLedger =
    dependencies.inventoryLedger ||
    new InventoryLedger({
      stateStore,
      logger: logger.child({ module: 'InventoryLedger' })
    });

  const botRegistry =
    dependencies.botRegistry ||
    new BotRegistry({
      stateStore,
      config,
      logger: logger.child({ module: 'BotRegistry' })
    });

  const taskManager =
    dependencies.taskManager ||
    new TaskManager({
      stateStore,
      inventoryLedger,
      schemaValidator,
      logger: logger.child({ module: 'TaskManager' })
    });

  const aiController =
    dependencies.aiController ||
    new AiEfficiencyController({
      provider: config.ai.provider || 'ollama',
      ollamaBaseUrl: config.ai.enabled ? config.ai.ollamaBaseUrl : null,
      model: config.ai.model,
      enforceRemoteOnController: config.role === 'master',
      maxConcurrent: config.ai.maxConcurrent,
      maxQueue: config.ai.maxQueue,
      timeoutMs: config.ai.timeoutMs,
      governor,
      monitor,
      transportOverride: dependencies.aiTransportOverride || null
    });

  const worldKnowledgeStore =
    dependencies.worldKnowledgeStore ||
    new WorldKnowledgeStore({
      stateStore,
      logger: logger.child({ module: 'WorldKnowledgeStore' })
    });

  const authService =
    dependencies.authService ||
    new AuthService({
      stateStore,
      config,
      logger: logger.child({ module: 'AuthService' })
    });

  const taskScheduler =
    dependencies.taskScheduler ||
    new TaskScheduler({
      stateStore,
      taskManager,
      botRegistry,
      governor,
      config,
      operatingMode: config.operatingMode || 'HYBRID',
      logger: logger.child({ module: 'TaskScheduler' })
    });

  const coordinator =
    dependencies.coordinator ||
    new Coordinator({
      config,
      stateStore,
      taskManager,
      botRegistry,
      aiController,
      monitor,
      governor,
      eventBus,
      sseCoalescer,
      taskScheduler,
      worldKnowledgeStore,
      logger: logger.child({ module: 'Coordinator' })
    });

  // Wire adaptive pressure reactions (`PERFORMANCE_PLAN.md` §5.2)
  const onGovernorChange = (report) => {
    const d = governor.getDirectives();
    sseCoalescer.applyGovernorPolicy({
      flushIntervalMs: d.dashboardFlushIntervalMs,
      maxClients: d.maxSseClients
    });
    if (d.state === 'critical') {
      logger.setLevel('warn');
      eventBus.trimForMemoryPressure();
    } else {
      logger.setLevel(config.logging.level);
    }
    eventBus.publish('resource.pressure', report);

    if (d.state === 'normal' || d.state === 'constrained') {
      const drained = governor.drainResumableTasks(5);
      for (const item of drained) {
        try {
          const summary = taskManager.resumeTask(item.taskId);
          if (['ready', 'running'].includes(summary.state)) {
            coordinator.scheduleReadyObjectives(item.taskId).catch((err) => {
              logger.warn('Deferred task schedule retry failed', {
                taskId: item.taskId,
                err: err.message
              });
            });
          }
        } catch {
          // Task may have been manually cancelled while paused
        }
      }
    }
  };
  governor.on('workload.changed', onGovernorChange);

  let started = false;
  let stopping = false;
  let stopSweep = null;
  let stopMaint = null;

  const healthProbe = async () => {
    const dbHealth = stateStore.health();
    const pressure = monitor.pressureState();
    const healthy = started && !coordinator.safeMode && dbHealth.status === 'healthy';
    return {
      schemaVersion: 1,
      status: healthy ? (pressure === 'normal' ? 'ok' : 'degraded') : 'unhealthy',
      healthy,
      started,
      httpListening: Boolean(httpServer && httpServer.listening),
      httpPort: httpServer ? httpServer.port : null,
      operatingMode: coordinator.operatingMode,
      performanceProfile: governor.profile,
      safeMode: coordinator.safeMode,
      governorState: governor.state,
      pressure,
      enabledBotsCap: botRegistry.enabledBotsCap,
      persistence: dbHealth
    };
  };

  const httpServer =
    dependencies.httpServer ||
    new MasterHttpServer({
      config,
      coordinator,
      authService,
      botRegistry,
      taskManager,
      sseCoalescer,
      monitor,
      logger: logger.child({ module: 'MasterHttpServer' }),
      healthProbe
    });

  return {
    config,
    logger,
    timers,
    eventBus,
    monitor,
    governor,
    sseCoalescer,
    stateStore,
    schemaValidator,
    inventoryLedger,
    botRegistry,
    taskManager,
    taskScheduler,
    aiController,
    worldKnowledgeStore,
    authService,
    httpServer,
    coordinator,

    async start(startOptions = {}) {
      const shouldListenHttp =
        startOptions.listenHttp !== undefined
          ? Boolean(startOptions.listenHttp)
          : Boolean(config.http?.enabled);

      if (started) {
        if (shouldListenHttp && !httpServer.listening) {
          await httpServer.start();
        }
        return {
          host: config.http.host,
          port: httpServer.port || config.http.port
        };
      }
      try {
        stateStore.open();
        monitor.registerEmitter('eventBus', eventBus);
        monitor.registerQueueProbe('governorPaused', () => governor.pausedTaskCount);
        monitor.registerQueueProbe('authKdfQueue', () => authService.kdfQueueDepth);
        monitor.start();

        const recoveryReport = await coordinator.recover();
        await authService.ensureEnvAdminBootstrap();

        // Consolidate lease expiry + worker liveness onto shared TimerRegistry bucket
        stopSweep = timers.registerInterval(
          'master-lease-liveness-sweep',
          config.capacity.heartbeatIntervalMs,
          () => {
            if (!stateStore.isOpen || stopping) return;
            const expired = taskManager.expireLeases();
            const liveness = botRegistry.sweepLiveness();
            inventoryLedger.expireStaleTransfers();
            if (
              !coordinator.safeMode &&
              (expired.length > 0 || liveness.some((t) => t.to === 'unreachable'))
            ) {
              coordinator.scheduleReadyObjectives(null).catch((err) => {
                logger.warn('Periodic sweep re-allocation failed', { err: err.message });
              });
            }
          }
        );

        // Periodic bounded SQLite table & WAL maintenance (`HIGH-04`)
        stopMaint = timers.registerInterval('master-sqlite-maintenance', 600_000, () => {
          if (!stateStore.isOpen || stopping) return;
          stateStore.pruneMaintenance();
        });

        started = true;
        if (shouldListenHttp) {
          await httpServer.start();
        }

        const effectivePort = httpServer.port || config.http.port;
        eventBus.publish('master.started', {
          host: config.http.host,
          port: effectivePort,
          httpListening: httpServer.listening,
          operatingMode: coordinator.operatingMode,
          performanceProfile: governor.profile,
          recoveryReport
        });
        logger.info('Master runtime started', {
          host: config.http.host,
          port: effectivePort,
          httpListening: httpServer.listening,
          operatingMode: coordinator.operatingMode,
          performanceProfile: governor.profile,
          enabledBotsCap: botRegistry.enabledBotsCap
        });

        return {
          host: config.http.host,
          port: effectivePort,
          httpListening: httpServer.listening,
          recoveryReport
        };
      } catch (err) {
        // Reverse-order teardown on partial startup failure (`MODULE_INTERFACES.md` §3.1)
        started = false;
        try {
          await httpServer.stop();
          monitor.stop();
          timers.dispose();
          stateStore.close();
        } catch {
          // ignore cleanup secondary error
        }
        throw err;
      }
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      eventBus.publish('master.stopping', { stoppedAt: new Date().toISOString() });
      logger.info('Master runtime stopping gracefully');

      try {
        await httpServer.stop();
        stopSweep?.();
        stopMaint?.();
        sseCoalescer.stop();
        monitor.stop();
        timers.dispose();
        governor.off('workload.changed', onGovernorChange);
        // Active leases intentionally remain in SQLite with their `expires_at` timestamps
        // so unfinished work is reconciled on restart, NEVER falsely marked completed!
        stateStore.close();
      } finally {
        started = false;
        stopping = false;
        eventBus.publish('master.stopped', { stoppedAt: new Date().toISOString() });
      }
    },

    health: healthProbe
  };
}

module.exports = { createMaster };
