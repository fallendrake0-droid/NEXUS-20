'use strict';

const crypto = require('node:crypto');
const { DomainError, isDomainError } = require('../errors/DomainError');
const { splitQuota, partitionRegion } = require('../scheduler/quotaMath');

const ROLE_RANK = Object.freeze({
  viewer: 1,
  chat_allowed: 2,
  operator: 3,
  admin: 4
});

function estimateMakespanSec(quotas, candidatesById) {
  let maxSec = 0;
  for (const q of quotas) {
    const c = candidatesById.get(q.botId);
    const rate = Math.max(0.05, Number(c?.rateP50 ?? 1.0));
    const delay = Math.max(0, Number(c?.travelSec ?? 0)) + Math.max(0, Number(c?.setupSec ?? 2));
    const finish = delay + q.quantity / rate;
    if (finish > maxSec) maxSec = finish;
  }
  return maxSec;
}

function selectOptimalPartitionQuotas(remainingQuantity, candidates, maxAllowed) {
  if (remainingQuantity < 16 || maxAllowed <= 1 || candidates.length <= 1) {
    return splitQuota(remainingQuantity, candidates.slice(0, 1));
  }
  const byId = new Map(candidates.map((c) => [c.botId, c]));
  const upper = Math.min(maxAllowed, remainingQuantity, 20);
  let bestQuotas = splitQuota(remainingQuantity, candidates.slice(0, 1));
  let bestMakespan = estimateMakespanSec(bestQuotas, byId);

  for (let k = 2; k <= upper; k += 1) {
    const trialQuotas = splitQuota(remainingQuantity, candidates.slice(0, k));
    if (trialQuotas.length < k) break;
    const trialMakespan = estimateMakespanSec(trialQuotas, byId);
    const savedSec = bestMakespan - trialMakespan;
    const savedRatio = bestMakespan > 0 ? savedSec / bestMakespan : 0;
    // `TASK_ALLOCATION.md` §3: add bot k only when marginal improvement >= 10% AND >= 5s
    if (savedSec >= 5 && savedRatio >= 0.1) {
      bestQuotas = trialQuotas;
      bestMakespan = trialMakespan;
    } else {
      break;
    }
  }
  return bestQuotas;
}

function authorizeRole(actor, minRole) {
  if (!actor || !actor.principalId || !ROLE_RANK[actor.role]) {
    throw new DomainError('UNAUTHENTICATED', 'Missing or invalid actor principal');
  }
  if (ROLE_RANK[actor.role] < ROLE_RANK[minRole]) {
    throw new DomainError(
      'FORBIDDEN',
      `Role '${actor.role}' is not authorised for action requiring '${minRole}'`
    );
  }
}

/**
 * Single Central Application Boundary (`MODULE_INTERFACES.md` §3.3).
 *
 * Shared by Web Dashboard, Termux CLI, Minecraft Chat, and WorkerGateway.
 * Enforces RBAC, idempotency, durable `WorkloadGovernor` task deferral (`CRIT-03`),
 * safe-mode read-only fallback on persistence failure, and post-commit `EventBus` / SSE updates.
 */
class Coordinator {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {import('../tasks/TaskManager').TaskManager} options.taskManager
   * @param {import('../workers/BotRegistry').BotRegistry} options.botRegistry
   * @param {import('../performance/AiEfficiencyController').AiEfficiencyController} options.aiController
   * @param {import('../monitoring/ResourceMonitor').ResourceMonitor} options.monitor
   * @param {import('../monitoring/WorkloadGovernor').WorkloadGovernor} options.governor
   * @param {import('../events/EventBus').EventBus} options.eventBus
   * @param {import('../performance/SseCoalescer').SseCoalescer} [options.sseCoalescer]
   * @param {object} [options.taskScheduler] Optional specialist TaskScheduler override
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    if (
      !options.config ||
      !options.stateStore ||
      !options.taskManager ||
      !options.botRegistry ||
      !options.aiController ||
      !options.monitor ||
      !options.governor ||
      !options.eventBus
    ) {
      throw new TypeError(
        'Coordinator requires config, stateStore, taskManager, botRegistry, aiController, monitor, governor and eventBus'
      );
    }

    this._config = options.config;
    this._store = options.stateStore;
    this._tasks = options.taskManager;
    this._registry = options.botRegistry;
    this._ai = options.aiController;
    this._monitor = options.monitor;
    this._governor = options.governor;
    this._bus = options.eventBus;
    this._sse = options.sseCoalescer || null;
    this._scheduler = options.taskScheduler || null;
    this._logger = options.logger || null;
    this._safeMode = false;
    this._safeModeReason = null;
  }

  get safeMode() {
    return this._safeMode;
  }

  _enterSafeMode(err) {
    this._safeMode = true;
    this._safeModeReason = err?.message || 'persistence_error';
    this._logger?.error('Coordinator entered read-only safe mode', { reason: this._safeModeReason });
    this._bus.publish('system.safe_mode', { reason: this._safeModeReason });
  }

  _assertWritable() {
    if (this._safeMode) {
      throw new DomainError(
        'PERSISTENCE_ERROR',
        `Coordinator is in read-only safe mode: ${this._safeModeReason}`
      );
    }
  }

  _publishPostCommit(eventType, key, payload) {
    this._bus.publish(eventType, payload);
    if (this._sse) {
      this._sse.publish(eventType, key, payload);
    }
  }

  /**
   * Submit a natural-language or structured intent from Dashboard, CLI or Chat (`G-02`, `G-10`).
   */
  async submitIntent(intentRequest) {
    if (!intentRequest || typeof intentRequest !== 'object') {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'intentRequest is required');
    }
    const {
      requestId = crypto.randomUUID(),
      idempotencyKey = requestId,
      actor,
      source = 'cli',
      text,
      priority = 'normal'
    } = intentRequest;

    authorizeRole(actor, source === 'chat' ? 'chat_allowed' : 'operator');
    if (source === 'chat' && this._config.envProfile === 'private_offline_test' && !this._config.chat?.allowInsecureOfflineChat) {
      throw new DomainError(
        'CHAT_DISABLED_IN_OFFLINE_MODE',
        'Chat commands are disabled in private_offline_test mode to prevent UUID spoofing (HIGH-06)'
      );
    }
    this._assertWritable();

    const taskId = crypto.randomUUID();
    const govDecision = this._governor.classifyWork({ taskId, priority });
    if (govDecision.decision === 'reject_backpressure') {
      throw new DomainError('WORKLOAD_CONSTRAINED', govDecision.message || 'Deferred queue full');
    }

    try {
      // CRIT-03 reconciliation: Persist task in SQLite BEFORE returning even if paused by Governor!
      if (govDecision.decision === 'paused_and_queued') {
        const pausedDetail = this._tasks.createTask({
          taskId,
          idempotencyKey,
          actorId: actor.principalId,
          source,
          rawText: text,
          priority,
          initialState: 'paused',
          pauseReason: 'WORKLOAD_GOVERNOR'
        });
        this._publishPostCommit('task.created', pausedDetail.taskId, pausedDetail);
        return pausedDetail;
      }

      const created = this._tasks.createTask({
        taskId,
        idempotencyKey,
        actorId: actor.principalId,
        source,
        rawText: text,
        priority,
        initialState: 'planning'
      });

      // If idempotencyKey matched an already-planned task, return it immediately
      if (created.planVersion > 0 || created.state !== 'planning') {
        return created;
      }

      const candidates = this._registry.eligibleBots({ onlyReady: true });
      const planResult = await this._ai.createPlan({
        requestId,
        taskId: created.taskId,
        userText: text,
        compactContext: {
          maxBots: this._registry.enabledBotsCap,
          serverRemainingSlots: this._registry.enabledBotsCap,
          candidates
        }
      });

      const planned = this._tasks.attachPlan({
        taskId: created.taskId,
        plan: planResult.plan
      });

      if (planned.state === 'ready') {
        await this.scheduleReadyObjectives(planned.taskId);
      }

      const finalTask = this._tasks.getTask(created.taskId);
      this._publishPostCommit('task.created', finalTask.taskId, finalTask);
      return finalTask;
    } catch (err) {
      if (isDomainError(err) && err.code === 'PERSISTENCE_ERROR') {
        this._enterSafeMode(err);
      }
      throw err;
    }
  }

  /**
   * Foundation scheduling pass: delegates to injected `TaskScheduler` if present,
   * otherwise runs deterministic foundation allocation (1-bot preference for `single`/`Q=1`,
   * water-filling `splitQuota` for partitionable objectives, `partitionRegion` for spatial).
   */
  async scheduleReadyObjectives(taskId) {
    if (this._scheduler && typeof this._scheduler.scheduleReadyObjectives === 'function') {
      return this._scheduler.scheduleReadyObjectives(taskId);
    }

    const directives = this._governor.getDirectives({
      serverAvailableSlots: this._registry.enabledBotsCap,
      workerAvailableSlots: this._registry.enabledBotsCap,
      capabilityEligibleBots: this._registry.enabledBotsCap
    });
    if (directives.effectiveBotConcurrency <= 0) {
      return { scheduled: 0, reason: 'governor_concurrency_zero' };
    }

    const readyList = this._tasks.readyObjectives(taskId);
    let scheduledCount = 0;

    for (const obj of readyList) {
      const busyBotRows = this._store.all(
        `SELECT DISTINCT bot_id FROM assignments
         WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`
      );
      const busyBotIds = new Set(busyBotRows.map((r) => r.bot_id));
      const remainingSlots = directives.effectiveBotConcurrency - busyBotIds.size;
      if (remainingSlots <= 0) break;

      const brokenToolRows = this._store.all(
        `SELECT DISTINCT bot_id FROM assignments
         WHERE objective_id = ? AND state = 'failed' AND failure_code = 'TOOL_BROKEN_OR_MISSING'`,
        obj.objectiveId
      );
      const disqualifiedBotIds = new Set(brokenToolRows.map((r) => r.bot_id));

      const candidates = this._registry
        .eligibleBots({ onlyReady: true })
        .filter((b) => !busyBotIds.has(b.botId) && !disqualifiedBotIds.has(b.botId));
      if (candidates.length === 0) continue;

      const maxAllowed = Math.min(remainingSlots, candidates.length);
      let quotas = [];

      if (
        obj.parallelism === 'single' ||
        obj.parallelism === 'serial' ||
        obj.parallelism === 'role_based' ||
        (obj.remainingQuantity !== null && obj.remainingQuantity <= 1)
      ) {
        // Strictly select 1 best eligible bot (`G-03`)
        const picked = candidates[0];
        quotas = [
          {
            botId: picked.botId,
            workerId: picked.workerId,
            quantity: obj.remainingQuantity,
            partitionId: null,
            regionBounds: null,
            role: obj.kind
          }
        ];
      } else if (obj.parallelism === 'spatial') {
        const subsetCount = Math.min(maxAllowed, Math.max(1, obj.workerCountHint || 2));
        quotas = partitionRegion(
          { dimension: 'minecraft:overworld', minX: -64, maxX: 64, minZ: -64, maxZ: 64 },
          candidates.slice(0, subsetCount)
        );
      } else if (obj.remainingQuantity !== null && obj.remainingQuantity > 1) {
        // `TASK_ALLOCATION.md` §1 & §3: workerCountHint is advisory; select k via marginal makespan gain (>=10% and >=5s)
        quotas = selectOptimalPartitionQuotas(obj.remainingQuantity, candidates, maxAllowed);
      }

      if (quotas.length > 0) {
        const created = this._tasks.commitAssignments({
          objectiveId: obj.objectiveId,
          allocationEpoch: obj.allocationEpoch,
          quotas,
          leaseDurationMs: this._config.capacity?.defaultLeaseDurationMs ?? 30_000,
          checkpointIntervalMs: this._config.capacity?.heartbeatIntervalMs ?? 5_000
        });
        scheduledCount += created.length;
      }
    }

    return { scheduled: scheduledCount };
  }

  async clarifyTask({ actor, taskId, answerText }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const existing = this._tasks.getTask(taskId);
    if (existing.state !== 'clarification_required') {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Task ${taskId} is in state ${existing.state}, not clarification_required`
      );
    }

    const combinedText = `${existing.rawText} — Clarification: ${String(answerText || '').trim()}`;
    const planResult = await this._ai.createPlan({
      requestId: crypto.randomUUID(),
      taskId,
      userText: answerText || combinedText,
      compactContext: {
        maxBots: this._registry.enabledBotsCap,
        candidates: this._registry.eligibleBots({ onlyReady: true })
      }
    });

    const updated = this._tasks.attachPlan({ taskId, plan: planResult.plan });
    if (updated.state === 'ready') {
      await this.scheduleReadyObjectives(taskId);
    }
    const detail = this._tasks.getTask(taskId);
    this._publishPostCommit('task.updated', taskId, detail);
    return detail;
  }

  async pauseTask({ actor, taskId, reason = 'operator_paused' }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const summary = this._tasks.pauseTask(taskId, reason);
    this._publishPostCommit('task.updated', taskId, summary);
    return summary;
  }

  async resumeTask({ actor, taskId }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    this._governor.removePausedTask(taskId);
    const summary = this._tasks.resumeTask(taskId);
    if (summary.state === 'queued') {
      const full = this._tasks.getTask(taskId);
      const planRes = await this._ai.createPlan({
        requestId: crypto.randomUUID(),
        taskId,
        userText: full.rawText,
        compactContext: {
          maxBots: this._registry.enabledBotsCap,
          candidates: this._registry.eligibleBots({ onlyReady: true })
        }
      });
      this._tasks.attachPlan({ taskId, plan: planRes.plan });
    }
    await this.scheduleReadyObjectives(taskId);
    const refreshed = this._tasks.getTask(taskId);
    this._publishPostCommit('task.updated', taskId, refreshed);
    return refreshed;
  }

  async cancelTask({ actor, taskId, reason = 'operator_cancelled' }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    this._governor.removePausedTask(taskId);
    const summary = this._tasks.cancelTask(taskId, reason);
    this._publishPostCommit('task.cancelled', taskId, summary);
    return summary;
  }

  async getTask({ actor, taskId }) {
    authorizeRole(actor, 'viewer');
    return this._tasks.getTask(taskId);
  }

  async listTasks({ actor, state = null, limit = 20, cursor = null }) {
    authorizeRole(actor, 'viewer');
    return this._tasks.listTasks({ state, limit, cursor });
  }

  async getSystemStatus({ actor }) {
    authorizeRole(actor, 'viewer');
    const sample = this._monitor.sampleNow();
    return {
      schemaVersion: 1,
      safeMode: this._safeMode,
      safeModeReason: this._safeModeReason,
      governorState: this._governor.state,
      governorDirectives: this._governor.getDirectives(),
      pausedGovernorTasks: this._governor.pausedTaskCount,
      enabledBotsCap: this._registry.enabledBotsCap,
      workers: this._registry.listWorkers(),
      bots: this._registry.listBots(),
      persistence: this._store.health(),
      resources: sample
    };
  }

  /**
   * Emergency priority safety stop bypassing optional workload queues (`SECURITY_PLAN.md` §7).
   */
  async safeStopBot({ actor, botId }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();

    const botRow = this._store.get('SELECT * FROM bots WHERE bot_id = ?', String(botId));
    if (!botRow) {
      throw new DomainError('NOT_FOUND', `Bot ${botId} not found`);
    }

    const nowIso = new Date().toISOString();
    const commandEnvelope = this._store.transaction(() => {
      const activeAsgs = this._store.all(
        `SELECT * FROM assignments
         WHERE bot_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        botRow.bot_id
      );
      for (const asg of activeAsgs) {
        const uncredited =
          asg.quota_quantity !== null ? Math.max(0, asg.quota_quantity - asg.credited_quantity) : 0;
        this._store.run(
          `UPDATE assignments SET state = 'revoked', completed_at = ? WHERE assignment_id = ?`,
          nowIso,
          asg.assignment_id
        );
        this._store.run(
          `UPDATE objectives
           SET allocation_epoch = allocation_epoch + 1,
               reserved_quantity = MAX(0, reserved_quantity - ?),
               state = CASE WHEN state IN ('assigned', 'running') THEN 'ready' ELSE state END,
               version = version + 1
           WHERE objective_id = ? AND state <> 'completed'`,
          uncredited,
          asg.objective_id
        );
      }

      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: actor.actorType || 'human',
        actorId: actor.principalId,
        action: 'bot.safe_stop',
        targetId: botRow.bot_id,
        outcome: 'ok',
        details: { revokedAssignments: activeAsgs.length }
      });

      return this._tasks._enqueueWorkerCommand(botRow.worker_id, 'safe_stop', {
        botId: botRow.bot_id,
        reason: 'operator_safe_stop'
      });
    });

    this._publishPostCommit('bot.safe_stop', botRow.bot_id, {
      botId: botRow.bot_id,
      commandId: commandEnvelope.commandId
    });
    return {
      schemaVersion: 1,
      botId: botRow.bot_id,
      workerId: botRow.worker_id,
      commandId: commandEnvelope.commandId,
      status: 'enqueued'
    };
  }

  async handleWorkerHeartbeat(authWorker, heartbeatDto = {}) {
    if (!authWorker || !authWorker.workerId) {
      throw new DomainError('UNAUTHENTICATED', 'Unauthenticated worker heartbeat');
    }
    // Pin all active objective resource IDs so snapshot compaction never drops them (`HIGH-02`)
    const activeResRows = this._store.all(
      `SELECT DISTINCT resource_id FROM objectives
       WHERE resource_id IS NOT NULL AND state IN ('ready', 'assigned', 'running', 'verifying')`
    );
    const pinnedItemKeys = activeResRows.map((r) => r.resource_id);

    const ack = this._registry.heartbeat(authWorker.workerId, heartbeatDto, { pinnedItemKeys });
    const d = this._governor.getDirectives();
    return {
      ...ack,
      governorDirectives: {
        state: d.state,
        maxBlockSearchRadius: d.maxBlockSearchRadius,
        allowNonEssentialScanning: d.allowNonEssentialScanning,
        scanIntervalMultiplier: d.scanIntervalMultiplier
      }
    };
  }

  async handleWorkerEventBatch(authWorker, events = []) {
    if (!authWorker || !authWorker.workerId) {
      throw new DomainError('UNAUTHENTICATED', 'Unauthenticated worker event batch');
    }
    if (!Array.isArray(events) || events.length > 100) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'events must be an array of <= 100 envelopes');
    }

    const results = [];
    const touchedTaskIds = new Set();
    for (const env of events) {
      const ack = this._tasks.applyWorkerEvent(authWorker.workerId, env, authWorker);
      results.push(ack);
      if (env.payload?.taskId) touchedTaskIds.add(env.payload.taskId);
    }

    for (const tId of touchedTaskIds) {
      const detail = this._tasks.getTask(tId);
      if (detail.state === 'running' || detail.state === 'ready') {
        await this.scheduleReadyObjectives(tId);
      }
      this._publishPostCommit('task.updated', tId, this._tasks.getTask(tId));
    }

    return results;
  }

  /**
   * Startup crash recovery (`G-15` & `CRIT-03`):
   * - Sweeps expired leases (`allocation_epoch + 1` fencing before releasing unverified quota).
   * - Reconciles timed-out transfers.
   * - Rehydrates `WorkloadGovernor` paused tasks from SQLite so zero deferred tasks are lost!
   */
  async recover(nowIso = new Date().toISOString()) {
    const expiredLeases = this._tasks.expireLeases(nowIso);
    const expiredTransfers = this._tasks._ledger.expireStaleTransfers(nowIso);
    const livenessChanges = this._registry.sweepLiveness(nowIso);

    const pausedGovernorRows = this._store.all(
      `SELECT task_id AS taskId, priority, updated_at AS pausedAt, pause_reason AS reason
       FROM tasks
       WHERE state = 'paused' AND pause_reason = 'WORKLOAD_GOVERNOR'
       ORDER BY created_at ASC`
    );
    this._governor.rehydratePausedTasks(pausedGovernorRows);

    const nonTerminal = this._store.all(
      `SELECT task_id FROM tasks WHERE state IN ('queued', 'planning', 'ready', 'running', 'paused', 'blocked')`
    );

    const report = {
      recoveredAt: nowIso,
      activeTaskCount: nonTerminal.length,
      rehydratedGovernorPausedCount: pausedGovernorRows.length,
      fencedExpiredLeases: expiredLeases.length,
      timedOutTransfers: expiredTransfers.length,
      workerLivenessUpdates: livenessChanges.length
    };

    this._logger?.info('Coordinator startup recovery completed', report);
    this._bus.publish('master.recovered', report);
    return report;
  }
}

module.exports = {
  Coordinator,
  authorizeRole
};
