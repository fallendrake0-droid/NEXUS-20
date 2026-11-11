'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logging/createLogger');
const { buildDeterministicBotRoster } = require('../config/loadConfig');
const { TimerRegistry } = require('../performance/TimerRegistry');
const { MasterClient } = require('./MasterClient');
const { BotRunner } = require('./BotRunner');
const { DomainError } = require('../errors/DomainError');

function loadSavedWorkerCredentials(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed.workerToken === 'string' && parsed.workerToken.length > 0) {
      return parsed;
    }
  } catch {
    // Ignore corrupted credential file
  }
  return null;
}

function saveWorkerCredentials(statePath, data) {
  if (!statePath) return;
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Distributed WorkerHost daemon (`ARCHITECTURE.md` §3, NEXUS-20 Phase 2/3).
 *
 * Connects to the Master Controller over `/worker/v1/*`, manages 1..N `BotRunner` instances
 * with staggered connection ramp, executes deterministic skills, forwards compact snapshots
 * and world observations, enforces governor scan caps, and reconciles active leases on reconnect.
 */
class WorkerHost {
  /**
   * @param {object} options
   * @param {object} options.config Frozen config from `loadConfig`
   * @param {MasterClient} [options.client]
   * @param {(botCfg: object) => object} [options.driverFactory] Optional custom BotDriver factory
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    if (!options.config) {
      throw new TypeError('WorkerHost requires config');
    }
    this.config = options.config;
    const wCfg = this.config.worker || {};

    this.logger =
      options.logger ||
      createLogger({
        level: this.config.logging.level,
        filePath: this.config.logging.filePath,
        maxFileBytes: this.config.logging.maxFileBytes,
        maxFiles: this.config.logging.maxFiles,
        ringCapacity: this.config.logging.ringSize,
        defaultFields: { role: 'worker', workerId: wCfg.workerId }
      });

    this.timers = new TimerRegistry({
      onError: (err, taskName) => {
        this.logger.error('Worker periodic timer failed', { taskName, err });
      }
    });

    const saved = loadSavedWorkerCredentials(wCfg.statePath);
    this._savedState = saved;
    const initialToken = wCfg.workerToken || saved?.workerToken || null;

    this.client =
      options.client ||
      new MasterClient({
        masterUrl: wCfg.masterUrl,
        workerId: wCfg.workerId,
        workerToken: initialToken,
        caCertPath: this.config.tls?.caCertPath || null,
        logger: this.logger.child({ module: 'MasterClient' })
      });

    this._driverFactory = typeof options.driverFactory === 'function' ? options.driverFactory : null;
    /** @type {Map<string, BotRunner>} */
    this.bots = new Map();
    this._started = false;
    this._stopping = false;
    this._heartbeatIntervalMs = this.config.capacity?.heartbeatIntervalMs ?? 5_000;
    this._pollIntervalMs = wCfg.commandPollIntervalMs ?? 1_000;
    this._needsReconcile = false;
    this._tickInFlight = false;
  }

  get started() {
    return this._started;
  }

  /**
   * Enroll with Master (or reconcile existing session), spawn configured bots with stagger,
   * and start consolidated heartbeat + command-polling loops.
   */
  async start() {
    if (this._started) return { workerId: this.client.workerId, bots: this.bots.size };

    const wCfg = this.config.worker;
    const baseDefs =
      Array.isArray(wCfg.bots) && wCfg.bots.length > 0
        ? wCfg.bots
        : buildDeterministicBotRoster({
            prefix: wCfg.botNamePrefix || 'Nexus',
            count: wCfg.botCount || 2,
            startIndex: wCfg.botStartIndex || 1
          });

    // Preserve sticky usernames from saved worker state file so bots NEVER lose their Minecraft inventory!
    const savedById = new Map(
      Array.isArray(this._savedState?.bots)
        ? this._savedState.bots.map((b) => [String(b.botId), b])
        : []
    );
    let botDefs = baseDefs.map((b) => {
      const prior = !wCfg.forceRenameBots ? savedById.get(String(b.botId)) : null;
      return {
        botId: b.botId,
        username: prior?.username || b.username,
        serverId: b.serverId || prior?.serverId || wCfg.serverId || 'survival-main',
        authMode: b.authMode || prior?.authMode || wCfg.authMode || 'online_microsoft'
      };
    });

    // 1. Enroll or reconcile with Master (adopting Master's authoritative canonical usernames if already registered)
    let activeWorkerToken = wCfg.workerToken || this._savedState?.workerToken || null;
    if (!this.client.hasCredentials) {
      if (!wCfg.bootstrapToken) {
        throw new DomainError(
          'UNAUTHENTICATED',
          'WorkerHost requires either SWARM_WORKER_TOKEN (or saved statePath) or single-use SWARM_BOOTSTRAP_TOKEN to enroll'
        );
      }
      const reg = await this.client.register({
        bootstrapToken: wCfg.bootstrapToken,
        workerInfo: {
          schemaVersion: 1,
          workerId: wCfg.workerId,
          hostname: wCfg.hostname,
          maxBotSlots: Math.max(wCfg.maxBotSlots, botDefs.length),
          allowUsernameChange: Boolean(wCfg.forceRenameBots),
          configuredBots: botDefs
        }
      });
      activeWorkerToken = reg.workerToken;
      this._heartbeatIntervalMs = reg.heartbeatIntervalMs || this._heartbeatIntervalMs;
      if (Array.isArray(reg.canonicalBots) && reg.canonicalBots.length > 0) {
        const canonById = new Map(reg.canonicalBots.map((c) => [String(c.botId), c]));
        botDefs = botDefs.map((b) => {
          const canon = canonById.get(String(b.botId));
          return canon ? { ...b, username: canon.username } : b;
        });
      }
    } else {
      const rec = await this.client.reconcile([]);
      if (Array.isArray(rec.canonicalBots) && rec.canonicalBots.length > 0) {
        const canonById = new Map(rec.canonicalBots.map((c) => [String(c.botId), c]));
        botDefs = botDefs.map((b) => {
          const canon = canonById.get(String(b.botId));
          return canon ? { ...b, username: canon.username } : b;
        });
      }
    }

    if (wCfg.statePath && activeWorkerToken) {
      saveWorkerCredentials(wCfg.statePath, {
        workerId: wCfg.workerId,
        workerToken: activeWorkerToken,
        bots: botDefs,
        enrolledAt: this._savedState?.enrolledAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    // 2. Spawn BotRunners with staggered delay to avoid Minecraft login-throttle kicks
    for (let i = 0; i < botDefs.length; i += 1) {
      if (i > 0 && wCfg.spawnStaggerMs > 0) {
        await new Promise((r) => setTimeout(r, wCfg.spawnStaggerMs));
      }
      const def = botDefs[i];
      const runner = new BotRunner({
        workerId: wCfg.workerId,
        botId: def.botId,
        username: def.username,
        serverId: def.serverId || wCfg.serverId,
        authMode: def.authMode || wCfg.authMode,
        simulationMode: Boolean(wCfg.simulationMode),
        driver: this._driverFactory ? this._driverFactory(def) : undefined,
        minecraftConfig: {
          minecraftHost: wCfg.minecraftHost,
          minecraftPort: wCfg.minecraftPort,
          minecraftVersion: wCfg.minecraftVersion
        },
        chatConfig: this.config.chat,
        logger: this.logger.child({ botId: def.botId })
      });

      this._wireBotEvents(runner);
      await runner.start();
      this.bots.set(def.botId, runner);
    }

    // 3. Send immediate initial heartbeat so Master sees all bots ready right away
    await this.tickHeartbeat();
    await this.flushAndPoll();

    // 4. Register consolidated periodic loops
    this.timers.registerInterval('worker-heartbeat', this._heartbeatIntervalMs, () => {
      if (!this._stopping) this.tickHeartbeat().catch(() => {});
    });
    this.timers.registerInterval('worker-command-poll', this._pollIntervalMs, () => {
      if (!this._stopping) this.flushAndPoll().catch(() => {});
    });

    this._started = true;
    this.logger.info('WorkerHost started', {
      workerId: wCfg.workerId,
      bots: Array.from(this.bots.keys()),
      masterUrl: wCfg.masterUrl
    });

    return {
      workerId: wCfg.workerId,
      bots: Array.from(this.bots.keys())
    };
  }

  _wireBotEvents(runner) {
    for (const evType of [
      'assignment_progress',
      'assignment_completed',
      'assignment_failed',
      'bot_lifecycle',
      'survival_override',
      'chat_intent'
    ]) {
      runner.on(evType, (payload) => {
        this.client.enqueueEvent(evType, payload);
        if (evType === 'assignment_completed' || evType === 'assignment_failed' || evType === 'survival_override') {
          this.client.flushEvents(25).catch(() => {
            this._needsReconcile = true;
          });
        }
      });
    }
  }

  async tickHeartbeat() {
    const botSnapshots = [];
    const worldObservations = [];

    for (const runner of this.bots.values()) {
      await runner.checkSurvivalReflexes();
      botSnapshots.push(await runner.getHeartbeatSnapshot());
      const obs = runner.drainWorldObservations(5);
      for (const item of obs) worldObservations.push(item);
    }

    try {
      if (this._needsReconcile) {
        await this.reconcileActiveLeases();
        this._needsReconcile = false;
      }

      const ack = await this.client.heartbeat({ botSnapshots, worldObservations });

      // Extend monotonic lease deadlines for renewed leases
      if (Array.isArray(ack.renewedLeases)) {
        for (const r of ack.renewedLeases) {
          for (const runner of this.bots.values()) {
            runner.extendLeaseMonotonic(r.leaseId, r.leaseTtlMs);
          }
        }
      }

      // Immediately fence any leases Master flagged as expired
      if (Array.isArray(ack.expiredLeaseIds) && ack.expiredLeaseIds.length > 0) {
        const expSet = new Set(ack.expiredLeaseIds);
        for (const runner of this.bots.values()) {
          if (runner.activeLease && expSet.has(runner.activeLease.assignment.leaseId)) {
            runner.cancelOrFenceLease(runner.activeLease.assignment.assignmentId, true);
          }
        }
      }

      // Honour urgent safe-stop directives piggybacked on heartbeat ack
      if (Array.isArray(ack.urgentStopBotIds)) {
        for (const botId of ack.urgentStopBotIds) {
          const runner = this.bots.get(botId);
          if (runner) await runner.safeStopNow('heartbeat_urgent_safe_stop');
        }
      }

      // Propagate Master WorkloadGovernor scan radius directives to every bot's BlockSearchCache
      if (ack.governorDirectives) {
        for (const runner of this.bots.values()) {
          runner.applyGovernorDirectives(ack.governorDirectives);
        }
      }

      return ack;
    } catch (err) {
      this._needsReconcile = true;
      throw err;
    }
  }

  async reconcileActiveLeases() {
    const activeLeases = [];
    for (const runner of this.bots.values()) {
      if (runner.activeLease) {
        const asg = runner.activeLease.assignment;
        activeLeases.push({
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: asg.allocationEpoch
        });
      }
    }
    const res = await this.client.reconcile(activeLeases);
    if (Array.isArray(res.reconcileActions)) {
      for (const act of res.reconcileActions) {
        if (act.directive === 'stop_and_fence') {
          for (const runner of this.bots.values()) {
            runner.cancelOrFenceLease(act.assignmentId, true);
          }
        }
      }
    }
    return res;
  }

  async flushAndPoll() {
    if (this._tickInFlight || this._stopping) return;
    this._tickInFlight = true;
    try {
      await this.client.flushEvents(50);
      const commands = await this.client.pollCommands(25);
      for (const cmd of commands) {
        await this._dispatchCommand(cmd);
      }
    } catch {
      this._needsReconcile = true;
    } finally {
      this._tickInFlight = false;
    }
  }

  async _dispatchCommand(cmd) {
    const { commandId, commandType, payload = {} } = cmd;

    if (commandType === 'assign') {
      const runner = this.bots.get(payload.botId);
      if (!runner) {
        await this.client.ackCommand(commandId, {
          assignmentId: payload.assignmentId,
          leaseId: payload.leaseId,
          allocationEpoch: payload.allocationEpoch,
          decision: 'rejected',
          rejectionCode: 'BOT_DISCONNECTED'
        });
        return;
      }
      const offerRes = await runner.acceptAssignment(payload);
      const ackRes = await this.client.ackCommand(commandId, {
        assignmentId: payload.assignmentId,
        leaseId: payload.leaseId,
        allocationEpoch: payload.allocationEpoch,
        decision: offerRes.decision,
        rejectionCode: offerRes.rejectionCode,
        baselineSnapshot: offerRes.baselineSnapshot
      });
      if (ackRes && ackRes.status === 'stale_rejected') {
        runner.cancelOrFenceLease(payload.assignmentId, true);
      }
      return;
    }

    if (commandType === 'pause') {
      const runner = this.bots.get(payload.botId);
      if (runner) runner.pauseLease(payload.assignmentId);
      await this.client.ackCommand(commandId, {});
      return;
    }

    if (commandType === 'resume') {
      const runner = this.bots.get(payload.botId);
      if (runner) runner.resumeLease(payload.assignmentId);
      await this.client.ackCommand(commandId, {});
      return;
    }

    if (commandType === 'cancel' || commandType === 'fence_epoch') {
      for (const runner of this.bots.values()) {
        runner.cancelOrFenceLease(payload.assignmentId, commandType === 'fence_epoch');
      }
      await this.client.ackCommand(commandId, {});
      return;
    }

    if (commandType === 'safe_stop') {
      const runner = this.bots.get(payload.botId);
      if (runner) await runner.safeStopNow(payload.reason || 'safe_stop');
      await this.client.ackCommand(commandId, {});
      return;
    }

    if (commandType === 'request_snapshot') {
      await this.tickHeartbeat();
      await this.client.ackCommand(commandId, {});
      return;
    }

    await this.client.ackCommand(commandId, {});
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    this.timers.dispose();

    for (const runner of this.bots.values()) {
      await runner.stop('worker_shutdown');
    }
    try {
      await this.client.flushEvents(100);
    } catch {
      // Ignore final flush error if Master is already offline
    }
    if (typeof this.client.destroy === 'function') {
      this.client.destroy();
    }
    this.bots.clear();
    this._started = false;
    this._stopping = false;
  }

  health() {
    return {
      schemaVersion: 1,
      role: 'worker',
      started: this._started,
      workerId: this.client.workerId,
      botCount: this.bots.size,
      client: this.client.stats()
    };
  }
}

function createWorker(config, options = {}) {
  return new WorkerHost({ config, ...options });
}

module.exports = { WorkerHost, createWorker };
