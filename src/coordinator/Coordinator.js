'use strict';

const crypto = require('node:crypto');
const { DomainError, isDomainError } = require('../errors/DomainError');
const { splitQuota, partitionRegion } = require('../scheduler/quotaMath');
const { SkinManager } = require('../skins/SkinGenerator');
const { SchematicRegistry } = require('../schematics/SchematicBuilder');
const { listZeroAiCommands } = require('../commands/ZeroAiCommandDeck');

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
    this._knowledge = options.worldKnowledgeStore || null;
    this._logger = options.logger || null;
    this._operatingMode = String(this._config.operatingMode || 'HYBRID')
      .trim()
      .toUpperCase();
    if (this._scheduler && typeof this._scheduler.setOperatingMode === 'function') {
      this._scheduler.setOperatingMode(this._operatingMode);
    }
    this._safeMode = false;
    this._safeModeReason = null;
    this._inFlightIdempotency = new Map();
    this.skinManager = new SkinManager();
    this.schematicRegistry = new SchematicRegistry();
    this._observedPlayers = new Map();
    this._playerRelations = new Map(); // lowerUsername -> 'ally' | 'kos' | 'neutral'
    this._botTacticalStates = new Map();
  }

  get safeMode() {
    return this._safeMode;
  }

  get operatingMode() {
    return this._operatingMode;
  }

  get worldKnowledgeStore() {
    return this._knowledge;
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
      priority = 'normal',
      forceAI = false,
      conversationContext = ''
    } = intentRequest;

    authorizeRole(actor, source === 'chat' ? 'chat_allowed' : 'operator');
    if (source === 'chat' && this._config.envProfile === 'private_offline_test' && !this._config.chat?.allowInsecureOfflineChat) {
      throw new DomainError(
        'CHAT_DISABLED_IN_OFFLINE_MODE',
        'Chat commands are disabled in private_offline_test mode to prevent UUID spoofing (HIGH-06)'
      );
    }
    this._assertWritable();
    if (forceAI) {
      const activeProvider = this._ai.listProviders?.().find((provider) => provider.active);
      if (!activeProvider?.available) {
        throw new DomainError(
          'AI_PROVIDER_UNAVAILABLE',
          'No active AI provider is available. Configure and activate one in the System & AI tab, then retry.'
        );
      }
    }

    const idemKey = idempotencyKey ? String(idempotencyKey) : null;
    if (idemKey && this._inFlightIdempotency.has(idemKey)) {
      return this._inFlightIdempotency.get(idemKey);
    }

    const executeSubmit = async () => {
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
            idempotencyKey: idemKey,
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
          idempotencyKey: idemKey,
          actorId: actor.principalId,
          source,
          rawText: text,
          priority,
          initialState: 'planning'
        });

        // If idempotencyKey matched an already-existing task, return it immediately
        if (created.taskId !== taskId || created.planVersion > 0 || created.state !== 'planning') {
          return created;
        }

        const planResult = await this._ai.createPlan({
          requestId,
          taskId: created.taskId,
          userText: text,
          compactContext: {
            ...this.buildSwarmWorldContext(),
            ...(typeof conversationContext === 'string' && conversationContext.trim()
              ? { conversationContext: conversationContext.trim().slice(-1200) }
              : {})
          },
          forceAI: Boolean(forceAI)
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
    };

    if (!idemKey) {
      return executeSubmit();
    }

    const p = executeSubmit().finally(() => {
      if (this._inFlightIdempotency.get(idemKey) === p) {
        this._inFlightIdempotency.delete(idemKey);
      }
    });
    this._inFlightIdempotency.set(idemKey, p);
    return p;
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

  async clarifyTask({ actor, taskId, answerText, forceAI = false, conversationContext = '' }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const existing = this._tasks.getTask(taskId);
    if (existing.state !== 'clarification_required') {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Task ${taskId} is in state ${existing.state}, not clarification_required`
      );
    }

    const clarification = String(answerText || '').trim().slice(0, 500);
    if (forceAI) {
      const activeProvider = this._ai.listProviders?.().find((provider) => provider.active);
      if (!activeProvider?.available) {
        throw new DomainError('AI_PROVIDER_UNAVAILABLE', 'The active AI provider is unavailable. Reconnect Ollama in System & AI before answering this clarification.');
      }
    }
    const planResult = await this._ai.createPlan({
      requestId: crypto.randomUUID(),
      taskId,
      userText: clarification || existing.rawText,
      compactContext: {
        ...this.buildSwarmWorldContext(),
        conversationContext: [
          existing.rawText.slice(0, 500),
          typeof conversationContext === 'string' ? conversationContext.slice(-700) : ''
        ].filter(Boolean).join('\n').slice(-1200)
      },
      forceAI: Boolean(forceAI)
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
        compactContext: this.buildSwarmWorldContext()
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

  /**
   * Switch swarm operating mode at runtime (`SYNCHRONIZED`, `DISTRIBUTED`, `HYBRID` - `ADR-003`).
   */
  async setOperatingMode({ actor, mode }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const normalized = String(mode || '').trim().toUpperCase();
    if (!['SYNCHRONIZED', 'DISTRIBUTED', 'HYBRID'].includes(normalized)) {
      throw new DomainError(
        'SCHEMA_VALIDATION_FAILED',
        `operatingMode must be SYNCHRONIZED, DISTRIBUTED or HYBRID (got "${mode}")`
      );
    }
    const previousMode = this._operatingMode;
    this._operatingMode = normalized;
    if (this._scheduler && typeof this._scheduler.setOperatingMode === 'function') {
      this._scheduler.setOperatingMode(normalized);
    }
    const nowIso = new Date().toISOString();
    this._store.transaction(() => {
      this._store.setSetting('operating_mode', normalized, nowIso);
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: actor.actorType || 'human',
        actorId: actor.principalId,
        action: 'swarm.operating_mode_changed',
        outcome: 'ok',
        details: { previousMode, operatingMode: normalized }
      });
    });

    await this.scheduleReadyObjectives(null);
    const payload = { previousMode, operatingMode: normalized, updatedAt: nowIso };
    this._publishPostCommit('swarm.mode_changed', 'operating_mode', payload);
    return payload;
  }

  /**
   * Switch performance profile at runtime (`ULTRA_LOW`..`MAXIMUM_THROUGHPUT` - `ADR-004`).
   */
  async setPerformanceProfile({ actor, profile }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const normalized = String(profile || '').trim().toUpperCase();
    let directives;
    try {
      directives = this._governor.setProfile(normalized);
    } catch (err) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', err.message);
    }
    const nowIso = new Date().toISOString();
    this._store.transaction(() => {
      this._store.setSetting('performance_profile', normalized, nowIso);
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: actor.actorType || 'human',
        actorId: actor.principalId,
        action: 'swarm.performance_profile_changed',
        outcome: 'ok',
        details: { profile: normalized }
      });
    });
    await this.scheduleReadyObjectives(null);
    this._publishPostCommit('swarm.profile_changed', 'performance_profile', {
      profile: normalized,
      directives
    });
    return { profile: normalized, directives };
  }

  async setEnabledBotsCap({ actor, enabledBotsCap }) {
    authorizeRole(actor, 'admin');
    this._assertWritable();
    const cap = Math.trunc(Number(enabledBotsCap));
    this._registry.setEnabledBotsCap(cap);
    this._governor.setConfiguredBotCap(cap);
    const nowIso = new Date().toISOString();
    this._store.transaction(() => {
      this._store.setSetting('enabled_bots_cap', String(cap), nowIso);
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: actor.actorType || 'human',
        actorId: actor.principalId,
        action: 'swarm.enabled_bots_cap_changed',
        outcome: 'ok',
        details: { enabledBotsCap: cap }
      });
    });
    await this.scheduleReadyObjectives(null);
    this._publishPostCommit('swarm.bot_cap_changed', 'enabled_bots_cap', { enabledBotsCap: cap });
    return { enabledBotsCap: cap };
  }

  async updateTaskPriority({ actor, taskId, priority }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const updated = this._tasks.updateTaskPriority(taskId, priority);
    await this.scheduleReadyObjectives(null);
    const refreshed = this._tasks.getTask(taskId);
    this._publishPostCommit('task.updated', taskId, refreshed);
    return refreshed;
  }

  /**
   * Safely revoke a bot's active assignment and reallocate, enforcing `minAssignmentHoldMs`
   * anti-oscillation hysteresis unless `force === true` (`ADR-003`).
   */
  async reassignBot({ actor, botId, force = false }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();

    const activeAsgs = this._store.all(
      `SELECT * FROM assignments
       WHERE bot_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
      String(botId)
    );
    if (activeAsgs.length === 0) {
      return { botId: String(botId), revokedCount: 0, rescheduled: 0 };
    }

    const nowMs = Date.now();
    const minHoldMs = this._config.capacity?.minAssignmentHoldMs ?? 8_000;
    if (!force && minHoldMs > 0) {
      for (const asg of activeAsgs) {
        const ageMs = nowMs - Date.parse(asg.issued_at);
        if (ageMs >= 0 && ageMs < minHoldMs) {
          throw new DomainError(
            'CONFLICT',
            `Assignment ${asg.assignment_id} on ${botId} is within anti-oscillation hold window (${ageMs}ms < ${minHoldMs}ms); pass force=true to override`
          );
        }
      }
    }

    const nowIso = new Date(nowMs).toISOString();
    this._store.transaction(() => {
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
               state = CASE
                 WHEN state IN ('assigned', 'running') AND (
                   SELECT COUNT(*) FROM assignments
                   WHERE objective_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')
                 ) = 0 THEN 'ready'
                 ELSE state
               END,
               version = version + 1
           WHERE objective_id = ? AND state NOT IN ('completed', 'cancelled')`,
          uncredited,
          asg.objective_id,
          asg.objective_id
        );
        this._tasks._enqueueWorkerCommand(asg.worker_id, 'cancel', {
          assignmentId: asg.assignment_id,
          leaseId: asg.lease_id,
          botId: asg.bot_id,
          reason: 'operator_reassigned'
        });
      }
    });

    const sched = await this.scheduleReadyObjectives(null);
    this._publishPostCommit('bot.reassigned', String(botId), {
      botId: String(botId),
      revokedCount: activeAsgs.length,
      rescheduled: sched.scheduled
    });
    return {
      botId: String(botId),
      revokedCount: activeAsgs.length,
      rescheduled: sched.scheduled
    };
  }

  async emergencyStopAll({ actor }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const bots = this._registry.listBots();
    const results = [];
    for (const b of bots) {
      results.push(await this.safeStopBot({ actor, botId: b.botId }));
    }
    this._publishPostCommit('swarm.emergency_stop', 'all', { stoppedBots: results.length });
    return { stoppedBots: results.length, results };
  }

  /**
   * Perform an online verified SQLite backup (`admin` role).
   */
  async createBackup({ actor, destPath }) {
    authorizeRole(actor, 'admin');
    const fs = require('node:fs');
    const res = await this._store.backup(destPath);
    const bytes = fs.existsSync(res.destPath) ? fs.statSync(res.destPath).size : 0;
    const nowIso = res.backedUpAt || new Date().toISOString();
    this._store.recordAudit({
      occurredAt: nowIso,
      actorType: actor.actorType || 'human',
      actorId: actor.principalId,
      action: 'system.backup_created',
      outcome: 'ok',
      details: { path: res.destPath, bytes }
    });
    return {
      ok: true,
      backupPath: res.destPath,
      bytes,
      verified: res.verified,
      createdAt: nowIso
    };
  }

  /**
   * Recover out of read-only persistence safe mode once SQLite WAL health is verified (`admin`).
   */
  async exitSafeMode({ actor }) {
    authorizeRole(actor, 'admin');
    const dbHealth = this._store.health();
    if (dbHealth.status !== 'healthy') {
      throw new DomainError(
        'PERSISTENCE_UNAVAILABLE',
        `Cannot exit safe mode while SQLite health is "${dbHealth.status}"`
      );
    }
    const previousReason = this._safeModeReason;
    this._safeMode = false;
    this._safeModeReason = null;
    const nowIso = new Date().toISOString();
    this._store.recordAudit({
      occurredAt: nowIso,
      actorType: actor.actorType || 'human',
      actorId: actor.principalId,
      action: 'system.safe_mode_exited',
      outcome: 'ok',
      details: { previousReason }
    });
    await this.scheduleReadyObjectives(null);
    this._publishPostCommit('system.safe_mode_exited', 'safe_mode', {
      safeMode: false,
      previousReason,
      updatedAt: nowIso
    });
    return { safeMode: false, previousReason };
  }

  async recordWorldKnowledge({ actor, observation }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    if (!this._knowledge) {
      throw new DomainError('NOT_IMPLEMENTED', 'WorldKnowledgeStore is not configured');
    }
    const entry = this._knowledge.recordObservation(observation);
    this._publishPostCommit('knowledge.updated', entry.knowledgeId, entry);
    return entry;
  }

  async queryWorldKnowledge({ actor, filters = {} }) {
    authorizeRole(actor, 'viewer');
    if (!this._knowledge) return [];
    return this._knowledge.query(filters);
  }

  async getSystemStatus({ actor }) {
    authorizeRole(actor, 'viewer');
    const sample = this._monitor.sampleNow();
    const swarmContext = this.buildSwarmWorldContext();
    const activeAssignments = this._store
      .all(
        `SELECT assignment_id, task_id, objective_id, worker_id, bot_id, allocation_epoch,
                state, action_type, item_key, quota_quantity, credited_quantity, scope_json,
                issued_at, expires_at
         FROM assignments
         WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')
         ORDER BY issued_at DESC
         LIMIT 100`
      )
      .map((a) => {
        let scope = {};
        try {
          scope = JSON.parse(a.scope_json || '{}');
        } catch {
          scope = {};
        }
        return {
          assignmentId: a.assignment_id,
          taskId: a.task_id,
          objectiveId: a.objective_id,
          workerId: a.worker_id,
          botId: a.bot_id,
          allocationEpoch: a.allocation_epoch,
          state: a.state,
          actionType: a.action_type,
          resourceId: a.item_key,
          quotaQuantity: a.quota_quantity,
          creditedQuantity: a.credited_quantity,
          partitionId: scope.partitionId || null,
          regionBounds: scope.regionBounds || null,
          role: scope.role || null,
          issuedAt: a.issued_at,
          expiresAt: a.expires_at
        };
      });

    const recentDecisions = this._store
      .all(
        `SELECT decision_id, task_id, objective_id, allocation_epoch, selected_bot_ids_json,
                quotas_json, single_bot_p90_sec, selected_subset_p90_sec, marginal_gain,
                decision_reason, created_at
         FROM scheduler_decisions
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .map((d) => ({
        decisionId: d.decision_id,
        taskId: d.task_id,
        objectiveId: d.objective_id,
        allocationEpoch: d.allocation_epoch,
        selectedBotIds: JSON.parse(d.selected_bot_ids_json || '[]'),
        quotas: JSON.parse(d.quotas_json || '[]'),
        singleBotP90Sec: d.single_bot_p90_sec,
        selectedSubsetP90Sec: d.selected_subset_p90_sec,
        marginalGain: d.marginal_gain,
        reason: d.decision_reason,
        createdAt: d.created_at
      }));

    const recentAudit = this._store
      .all(
        `SELECT audit_id, occurred_at, actor_type, actor_id, action, target_id, outcome
         FROM audit_events
         ORDER BY occurred_at DESC
         LIMIT 25`
      )
      .map((e) => ({
        auditId: e.audit_id,
        occurredAt: e.occurred_at,
        actorType: e.actor_type,
        actorId: e.actor_id,
        action: e.action,
        targetId: e.target_id,
        outcome: e.outcome
      }));

    return {
      schemaVersion: 1,
      envProfile: this._config.envProfile,
      operatingMode: this._operatingMode,
      performanceProfile: this._governor.profile,
      safeMode: this._safeMode,
      safeModeReason: this._safeModeReason,
      governorState: this._governor.state,
      governorDirectives: this._governor.getDirectives(),
      pausedGovernorTasks: this._governor.pausedTaskCount,
      enabledBotsCap: this._registry.enabledBotsCap,
      globalMaxBots: this._config.capacity?.globalMaxBots ?? 20,
      aiBrain: {
        activeProvider: this._ai.activeProvider || 'ollama',
        providers: typeof this._ai.listProviders === 'function' ? this._ai.listProviders() : [],
        stats: typeof this._ai.stats === 'function' ? this._ai.stats() : {}
      },
      swarmState: swarmContext.swarmState,
      worldKnowledge: this._knowledge ? this._knowledge.getCompactSummary(6) : null,
      storageLocks: this._knowledge ? this._knowledge.listStorageLocks() : [],
      activeAssignments,
      recentDecisions,
      recentAudit,
      workers: this._registry.listWorkers(),
      bots: this._registry.listBots().map((b, idx) => ({
        ...b,
        skin: this.skinManager.resolveBotSkin(b.botId, idx),
        tacticalState: this._botTacticalStates.get(b.botId) || { mode: 'idle', targetPlayer: null }
      })),
      players: this._listServerPlayersInternal(),
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

  /**
   * Build compact, bounded NEXUS-20 swarm world-state snapshot for the central AI brain.
   * Summarizes online/offline/busy bots, positions, tools, inventories, task states, and swarm resources.
   */
  buildSwarmWorldContext() {
    const allCapBots = this._registry.eligibleBots({ onlyReady: false });
    const allListedBots = this._registry.listBots();
    const capById = new Map(allCapBots.map((b) => [b.botId, b]));

    let onlineBotCount = 0;
    let offlineBotCount = 0;
    let busyBotCount = 0;
    const availableResources = {};

    for (const b of allListedBots) {
      if (!b.enabled) continue;
      const cap = capById.get(b.botId);
      if (cap && cap.connected) {
        onlineBotCount += 1;
        if (cap.busy) busyBotCount += 1;
        for (const [itemKey, count] of Object.entries(cap.itemCounts || {})) {
          if (Number.isFinite(count) && count > 0) {
            availableResources[itemKey] = (availableResources[itemKey] || 0) + count;
          }
        }
      } else {
        offlineBotCount += 1;
      }
    }

    const taskCounts = this._store.get(
      `SELECT
         SUM(CASE WHEN state IN ('queued', 'ready', 'running') THEN 1 ELSE 0 END) AS availableTasks,
         SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blockedTasks
       FROM tasks`
    );
    const completedObjRow = this._store.get(
      `SELECT COUNT(*) AS cnt FROM objectives WHERE state = 'completed'`
    );
    const reqObjRows = this._store.all(
      `SELECT resource_id, SUM(MAX(0, target_quantity - verified_quantity)) AS needed
       FROM objectives
       WHERE resource_id IS NOT NULL
         AND target_quantity IS NOT NULL
         AND state NOT IN ('completed', 'cancelled', 'failed')
       GROUP BY resource_id`
    );
    const requiredResources = {};
    for (const r of reqObjRows) {
      if (r.resource_id && Number(r.needed) > 0) {
        requiredResources[r.resource_id] = Number(r.needed);
      }
    }

    return {
      maxBots: this._registry.enabledBotsCap,
      serverRemainingSlots: Math.max(0, this._registry.enabledBotsCap - busyBotCount),
      swarmState: {
        operatingMode: this._operatingMode,
        performanceProfile: this._governor.profile,
        onlineBotCount,
        offlineBotCount,
        busyBotCount,
        availableTaskCount: Number(taskCounts?.availableTasks || 0),
        blockedTaskCount: Number(taskCounts?.blockedTasks || 0),
        completedObjectiveCount: Number(completedObjRow?.cnt || 0),
        availableResources,
        requiredResources,
        ...(this._knowledge ? { worldKnowledge: this._knowledge.getCompactSummary(4) } : {})
      },
      candidates: allCapBots
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

    if (Array.isArray(heartbeatDto.observedPlayers)) {
      const nowIso = new Date().toISOString();
      for (const p of heartbeatDto.observedPlayers.slice(0, 64)) {
        if (!p || typeof p.username !== 'string' || !p.username.trim()) continue;
        const uname = p.username.trim().slice(0, 32);
        this._observedPlayers.set(uname.toLowerCase(), {
          username: uname,
          uuid: p.uuid || null,
          ping: p.ping ?? null,
          visible: Boolean(p.visible),
          isSwarmBot: Boolean(p.isSwarmBot),
          position: p.position || null,
          distance: p.distance ?? null,
          health: p.health ?? null,
          seenByBotId: p.seenByBotId || null,
          lastSeenAt: nowIso
        });
      }
    }

    if (heartbeatDto.botTacticalStates && typeof heartbeatDto.botTacticalStates === 'object') {
      for (const [bId, tState] of Object.entries(heartbeatDto.botTacticalStates)) {
        if (tState && typeof tState === 'object') {
          this._botTacticalStates.set(String(bId), tState);
        }
      }
    }

    // Optional piggybacked world observations from bots (`ADR-005`)
    if (this._knowledge && Array.isArray(heartbeatDto.worldObservations)) {
      for (const obs of heartbeatDto.worldObservations.slice(0, 20)) {
        try {
          this._knowledge.recordObservation(obs);
        } catch {
          // Ignore malformed individual observation without failing worker heartbeat
        }
      }
    }

    if (ack.expiredLeaseIds.length > 0 && !this._safeMode) {
      this._tasks.expireLeases(ack.serverTime, ack.expiredLeaseIds);
    }
    if (!this._safeMode) {
      await this.scheduleReadyObjectives(null);
    }
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
    const pendingChatIntents = [];
    for (const env of events) {
      const ack = this._tasks.applyWorkerEvent(authWorker.workerId, env, authWorker);
      results.push(ack);
      if (env.payload?.taskId) touchedTaskIds.add(env.payload.taskId);
      if (Array.isArray(ack.affectedTaskIds)) {
        for (const tId of ack.affectedTaskIds) touchedTaskIds.add(tId);
      }
      if (!ack.duplicate && env.eventType === 'chat_intent' && env.payload) {
        pendingChatIntents.push(env.payload);
      }
    }

    // Execute authorised in-game `!swarm` chat intents when chat control is explicitly enabled (`SECURITY_PLAN.md` §7)
    if (!this._safeMode && this._config.chat?.enabled === true && pendingChatIntents.length > 0) {
      const allowedSet = new Set(this._config.chat.allowedPlayerUuids || []);
      for (const intent of pendingChatIntents) {
        if (!intent.senderUuid || !allowedSet.has(intent.senderUuid)) continue;
        const chatActor = {
          principalId: `mc:${intent.senderUuid}`,
          role: 'chat_allowed',
          actorType: 'ingame_player'
        };
        try {
          if (intent.verb === 'task' && intent.argumentText) {
            await this.submitIntent({
              actor: chatActor,
              source: 'chat',
              text: intent.argumentText
            });
          } else if (intent.verb === 'pause' && intent.argumentText) {
            await this.pauseTask({ actor: { ...chatActor, role: 'operator' }, taskId: intent.argumentText.trim() });
          } else if (intent.verb === 'resume' && intent.argumentText) {
            await this.resumeTask({ actor: { ...chatActor, role: 'operator' }, taskId: intent.argumentText.trim() });
          } else if (intent.verb === 'cancel' && intent.argumentText) {
            await this.cancelTask({
              actor: { ...chatActor, role: 'operator' },
              taskId: intent.argumentText.trim(),
              reason: 'ingame_chat_cancel'
            });
          }
        } catch (err) {
          this._logger?.warn('In-game chat_intent command rejected', {
            senderUuid: intent.senderUuid,
            verb: intent.verb,
            err
          });
        }
      }
    }

    if (!this._safeMode) {
      await this.scheduleReadyObjectives(null);
    }

    for (const tId of touchedTaskIds) {
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
    // Restore persisted runtime operatingMode, performanceProfile & enabledBotsCap (`ADR-003`, `ADR-004`)
    const savedMode = this._store.getSetting('operating_mode', null);
    if (savedMode && ['SYNCHRONIZED', 'DISTRIBUTED', 'HYBRID'].includes(savedMode)) {
      this._operatingMode = savedMode;
      if (this._scheduler && typeof this._scheduler.setOperatingMode === 'function') {
        this._scheduler.setOperatingMode(savedMode);
      }
    }
    const savedProfile = this._store.getSetting('performance_profile', null);
    if (savedProfile) {
      try {
        this._governor.setProfile(savedProfile);
      } catch {
        // Ignore invalid legacy profile
      }
    }
    const savedCap = this._store.getSetting('enabled_bots_cap', null);
    if (savedCap !== null) {
      const parsedCap = Math.trunc(Number(savedCap));
      if (Number.isSafeInteger(parsedCap) && parsedCap >= 1) {
        try {
          this._registry.setEnabledBotsCap(parsedCap);
          this._governor.setConfiguredBotCap(parsedCap);
        } catch {
          // Clamp if config ceiling lowered
        }
      }
    }

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

    if (!this._safeMode) {
      await this.scheduleReadyObjectives(null);
    }

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

  _listServerPlayersInternal() {
    const out = [];
    for (const [lowName, info] of this._observedPlayers.entries()) {
      out.push({
        ...info,
        relation: this._playerRelations.get(lowName) || (info.isSwarmBot ? 'ally' : 'neutral')
      });
    }
    for (const [lowName, rel] of this._playerRelations.entries()) {
      if (!this._observedPlayers.has(lowName)) {
        out.push({
          username: lowName,
          uuid: null,
          ping: null,
          visible: false,
          isSwarmBot: false,
          position: null,
          distance: null,
          health: null,
          seenByBotId: null,
          lastSeenAt: null,
          relation: rel
        });
      }
    }
    return out.sort((a, b) => Number(b.visible) - Number(a.visible) || a.username.localeCompare(b.username));
  }

  async listServerPlayers({ actor }) {
    authorizeRole(actor, 'viewer');
    return {
      players: this._listServerPlayersInternal(),
      tacticalByBot: Object.fromEntries(this._botTacticalStates)
    };
  }

  async dispatchPlayerTacticalAction({
    actor,
    mode,
    targetPlayer = null,
    targetPosition = null,
    botId = '*',
    preferredWeaponStyle = 'auto',
    itemFilter = null,
    relation = null,
    autoEat = undefined,
    autoArmor = undefined,
    preemptTask = false
  }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();

    if (targetPlayer && relation && ['ally', 'kos', 'neutral'].includes(relation)) {
      const low = String(targetPlayer).trim().toLowerCase();
      if (relation === 'neutral') this._playerRelations.delete(low);
      else this._playerRelations.set(low, relation);
    }

    const allies = [];
    const kosPlayers = [];
    for (const [low, rel] of this._playerRelations.entries()) {
      if (rel === 'ally') allies.push(low);
      if (rel === 'kos') kosPlayers.push(low);
    }

    const cleanMode = String(mode || 'idle').trim().toLowerCase();
    let cleanTargetPosition = null;
    if (cleanMode === 'goto') {
      const x = targetPosition?.x;
      const y = targetPosition?.y;
      const z = targetPosition?.z;
      if (
        ![x, y, z].every((coord) => typeof coord === 'number' && Number.isFinite(coord)) ||
        Math.abs(x) > 29_999_984 || y < -2048 || y > 2048 || Math.abs(z) > 29_999_984
      ) {
        throw new DomainError('SCHEMA_VALIDATION_FAILED', 'goto requires finite x/y/z coordinates within world bounds');
      }
      cleanTargetPosition = { x, y, z };
    }
    const workers = this._registry.listWorkers();
    const enqueued = [];

    this._store.transaction(() => {
      if (botId && botId !== '*') {
        const botRow = this._store.get('SELECT * FROM bots WHERE bot_id = ?', String(botId));
        if (!botRow) throw new DomainError('NOT_FOUND', `Bot ${botId} not found`);
        const env = this._tasks._enqueueWorkerCommand(botRow.worker_id, 'tactical_order', {
          botId: botRow.bot_id,
          mode: cleanMode,
          targetPlayer: targetPlayer ? String(targetPlayer).trim() : null,
          targetPosition: cleanTargetPosition,
          preferredWeaponStyle,
          itemFilter,
          allies,
          kosPlayers,
          autoEat,
          autoArmor,
          preemptTask: Boolean(preemptTask)
        });
        this._botTacticalStates.set(botRow.bot_id, {
          mode: cleanMode,
          targetPlayer: targetPlayer || null,
          targetPosition: cleanTargetPosition,
          preferredWeaponStyle
        });
        enqueued.push(env.commandId);
      } else {
        for (const w of workers) {
          const env = this._tasks._enqueueWorkerCommand(w.workerId, 'tactical_order', {
            botId: '*',
            mode: cleanMode,
            targetPlayer: targetPlayer ? String(targetPlayer).trim() : null,
            targetPosition: cleanTargetPosition,
            preferredWeaponStyle,
            itemFilter,
            allies,
            kosPlayers,
            autoEat,
            autoArmor,
            preemptTask: Boolean(preemptTask)
          });
          enqueued.push(env.commandId);
        }
        for (const b of this._registry.listBots()) {
          this._botTacticalStates.set(b.botId, {
            mode: cleanMode,
            targetPlayer: targetPlayer || null,
            targetPosition: cleanTargetPosition,
            preferredWeaponStyle
          });
        }
      }
    });

    this._publishPostCommit('players.tactical_updated', targetPlayer || 'swarm', {
      mode: cleanMode,
      targetPlayer,
      targetPosition: cleanTargetPosition,
      botId,
      preferredWeaponStyle,
      enqueuedCount: enqueued.length
    });

    return {
      ok: true,
      mode: cleanMode,
      targetPlayer,
      targetPosition: cleanTargetPosition,
      botId,
      preferredWeaponStyle,
      enqueuedCommandIds: enqueued,
      players: this._listServerPlayersInternal()
    };
  }

  async updateAiProviderConfig({ actor, provider, apiKey, model, baseUrl }) {
    authorizeRole(actor, 'admin');
    if (typeof this._ai.configureProvider !== 'function') {
      throw new DomainError('NOT_IMPLEMENTED', 'AI runtime provider configuration is unavailable');
    }
    let updated;
    try {
      updated = this._ai.configureProvider({ provider, apiKey, model, baseUrl });
    } catch (err) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', err.message || 'Invalid AI provider settings');
    }
    this._publishPostCommit('system.ai_provider_changed', updated.name, {
      activeProvider: updated.name,
      model: updated.model
    });
    return {
      activeProvider: this._ai.activeProvider,
      updated,
      providers: this._ai.listProviders()
    };
  }

  async listZeroAiDeck({ actor, category, search, limit, offset }) {
    authorizeRole(actor, 'viewer');
    return listZeroAiCommands({ category, search, limit, offset });
  }

  async listSkins({ actor }) {
    authorizeRole(actor, 'viewer');
    const bots = this._registry.listBots().map((b, idx) => ({
      botId: b.botId,
      username: b.username,
      skin: this.skinManager.resolveBotSkin(b.botId, idx)
    }));
    return {
      skins: this.skinManager.listSkins(),
      botSkins: bots
    };
  }

  async assignSkin({ actor, botId, skinId, preset, publicBaseUrl }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const allBots = this._registry.listBots();

    if (preset) {
      this.skinManager.applySwarmPreset(
        preset,
        allBots.map((b) => b.botId)
      );
    } else if (botId && skinId) {
      if (!this.skinManager.isValidSkinId(skinId)) {
        throw new DomainError('SCHEMA_VALIDATION_FAILED', `Unknown skinId: ${skinId}`);
      }
      if (botId === '*') {
        for (const b of allBots) this.skinManager.assignBotSkin(b.botId, skinId);
      } else {
        this.skinManager.assignBotSkin(botId, skinId);
      }
    }

    // Push live `apply_skin` command to online worker bots (applies via SkinsRestorer when present)
    this._store.transaction(() => {
      const targetBots = botId && botId !== '*' && !preset
        ? allBots.filter((b) => b.botId === botId)
        : allBots;
      for (const [idx, b] of targetBots.entries()) {
        const resolved = this.skinManager.resolveBotSkin(b.botId, idx);
        const pngUrl = publicBaseUrl
          ? `${String(publicBaseUrl).replace(/\/+$/, '')}${resolved.pngUrl}`
          : null;
        try {
          this._tasks._enqueueWorkerCommand(b.workerId, 'apply_skin', {
            botId: b.botId,
            skinId: resolved.skinId,
            publicPngUrl: pngUrl
          });
        } catch {
          // Ignore if worker row not present
        }
      }
    });

    this._publishPostCommit('skins.updated', botId || preset || 'swarm', {});
    return this.listSkins({ actor });
  }

  async listSchematics({ actor }) {
    authorizeRole(actor, 'viewer');
    return { schematics: this.schematicRegistry.listSchematics() };
  }

  async registerCustomSchematic({ actor, spec }) {
    authorizeRole(actor, 'operator');
    try {
      const entry = this.schematicRegistry.registerCustomSchematic(spec);
      return { schematic: entry, schematics: this.schematicRegistry.listSchematics() };
    } catch (err) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', err.message || 'Invalid custom schematic');
    }
  }

  async buildSchematicNow({ actor, schematicId, botId = null }) {
    authorizeRole(actor, 'operator');
    this._assertWritable();
    const sch = this.schematicRegistry.getSchematic(schematicId);
    if (!sch) {
      throw new DomainError('NOT_FOUND', `Unknown schematic: ${schematicId}`);
    }

    if (!sch.builtin) {
      // Custom runtime schematic: push full block array directly to target bot or first ready bot
      const bots = this._registry.listBots();
      const chosen =
        (botId && botId !== '*' ? bots.find((b) => b.botId === botId) : null) ||
        bots.find((b) => b.status === 'ready') ||
        bots[0];
      if (!chosen) {
        throw new DomainError('NOT_FOUND', 'No enrolled bot available to build custom schematic');
      }
      const env = this._store.transaction(() =>
        this._tasks._enqueueWorkerCommand(chosen.workerId, 'build_schematic', {
          botId: chosen.botId,
          schematic: sch
        })
      );
      return {
        mode: 'direct_custom_schematic',
        botId: chosen.botId,
        commandId: env.commandId,
        schematicId: sch.schematicId,
        blockCount: sch.blockCount
      };
    }

    // Built-in schematic: submit as tracked Zero-AI Swarm Task so progress & leases appear in Task Queue!
    return this.submitIntent({
      actor,
      source: 'dashboard',
      text: `build schematic ${sch.schematicId}`,
      priority: 'normal'
    });
  }
}

module.exports = {
  Coordinator,
  authorizeRole
};
