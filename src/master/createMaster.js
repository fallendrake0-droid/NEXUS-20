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
const { Coordinator } = require('../coordinator/Coordinator');

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
      globalBotCap: config.capacity.globalMaxBots,
      initialBotCap: config.capacity.initialEnabledBots
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
      taskScheduler: dependencies.taskScheduler || null,
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
          if (summary.state === 'ready') {
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
    aiController,
    coordinator,

    async start() {
      if (started) {
        return { host: config.http.host, port: config.http.port };
      }
      try {
        stateStore.open();
        monitor.registerEmitter('eventBus', eventBus);
        monitor.registerQueueProbe('governorPaused', () => governor.pausedTaskCount);
        monitor.start();

        const recoveryReport = await coordinator.recover();

        // Consolidate lease expiry + worker liveness onto shared TimerRegistry bucket
        stopSweep = timers.registerInterval(
          'master-lease-liveness-sweep',
          config.capacity.heartbeatIntervalMs,
          () => {
            if (!stateStore.isOpen || stopping) return;
            taskManager.expireLeases();
            botRegistry.sweepLiveness();
            inventoryLedger.expireStaleTransfers();
          }
        );

        // Periodic bounded SQLite table & WAL maintenance (`HIGH-04`)
        stopMaint = timers.registerInterval('master-sqlite-maintenance', 600_000, () => {
          if (!stateStore.isOpen || stopping) return;
          stateStore.pruneMaintenance();
        });

        started = true;
        eventBus.publish('master.started', {
          host: config.http.host,
          port: config.http.port,
          recoveryReport
        });
        logger.info('Master runtime started', {
          host: config.http.host,
          port: config.http.port,
          enabledBotsCap: botRegistry.enabledBotsCap
        });

        return {
          host: config.http.host,
          port: config.http.port,
          recoveryReport
        };
      } catch (err) {
        // Reverse-order teardown on partial startup failure (`MODULE_INTERFACES.md` §3.1)
        try {
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
        stopSweep?.();
        stopMaint?.();
        sseCoalescer.dispose?.();
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

    async health() {
      const dbHealth = stateStore.health();
      const pressure = monitor.pressureState();
      const healthy = started && !coordinator.safeMode && dbHealth.status === 'healthy';
      return {
        schemaVersion: 1,
        status: healthy ? (pressure === 'normal' ? 'ok' : 'degraded') : 'unhealthy',
        started,
        safeMode: coordinator.safeMode,
        governorState: governor.state,
        pressure,
        enabledBotsCap: botRegistry.enabledBotsCap,
        persistence: dbHealth
      };
    }
  };
}

module.exports = { createMaster };
