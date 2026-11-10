'use strict';

const { EventEmitter } = require('node:events');
const { RingBuffer } = require('../performance/RingBuffer');

const STATE_RANK = Object.freeze({
  normal: 0,
  constrained: 1,
  critical: 2
});

const RANK_TO_STATE = Object.freeze(['normal', 'constrained', 'critical']);

/**
 * Adaptive Workload Governor (PERFORMANCE_PLAN.md §5 + Prompt "Adaptive workload controller").
 *
 * States: 'normal' | 'constrained' | 'critical'
 *
 * Core Safety & Correctness Invariants:
 * 1. NEVER silently discards tasks: low-priority tasks under pressure are explicitly
 *    paused/deferred in a tracked durable-ready queue (`deferTask`) with structured reason
 *    codes and resumed cleanly in FIFO order once pressure recovers.
 * 2. ALWAYS preserves survival, safety-stop, heartbeat, lease-fencing and durable state
 *    commits even in `critical` state.
 * 3. NEVER increases bot concurrency due to memory pressure; concurrency is bounded by:
 *    min(globalBotCap, serverAvailableSlots, workerAvailableSlots, capabilityEligibleBots, governorCap).
 * 4. Recovery is stepwise (`critical -> constrained -> normal`) only after measurements
 *    stay below hysteresis recovery thresholds for `recoveryCooldownMs`.
 * 5. Every reduction and state change produces an auditable WorkloadReductionReport.
 */
class WorkloadGovernor extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.globalBotCap=20] Hard global architecture cap <= 20
   * @param {number} [options.initialBotCap=2] Initial runtime cap
   * @param {number} [options.recoveryCooldownMs=15000] Cooldown before stepping down one pressure level
   * @param {object} [options.thresholds]
   * @param {number} [options.reportHistorySize=100]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    super();
    const configuredGlobal = options.globalBotCap ?? 20;
    if (!Number.isSafeInteger(configuredGlobal) || configuredGlobal < 1 || configuredGlobal > 20) {
      throw new RangeError('Global bot cap must be between 1 and 20 (MASTER_SPEC.md §2)');
    }

    this._globalBotCap = configuredGlobal;
    this._configuredBotCap = Math.min(configuredGlobal, options.initialBotCap ?? 2);
    this._recoveryCooldownMs = options.recoveryCooldownMs ?? 15_000;
    this._now = options.now || Date.now;

    const th = options.thresholds || {};
    this._thresholds = {
      constrainedRssBytes: th.constrainedRssBytes ?? 220 * 1024 * 1024,
      criticalRssBytes: th.criticalRssBytes ?? 300 * 1024 * 1024,
      recoverFromCriticalRssBytes: th.recoverFromCriticalRssBytes ?? 255 * 1024 * 1024,
      recoverFromConstrainedRssBytes: th.recoverFromConstrainedRssBytes ?? 190 * 1024 * 1024,

      constrainedCpuPercent: th.constrainedCpuPercent ?? 75,
      criticalCpuPercent: th.criticalCpuPercent ?? 92,
      recoverCpuPercent: th.recoverCpuPercent ?? 60,

      constrainedLagMs: th.constrainedLagMs ?? 60,
      criticalLagMs: th.criticalLagMs ?? 180,
      recoverLagMs: th.recoverLagMs ?? 35,

      constrainedTaskQueue: th.constrainedTaskQueue ?? 25,
      criticalTaskQueue: th.criticalTaskQueue ?? 60,
      recoverTaskQueue: th.recoverTaskQueue ?? 12,

      constrainedSseClients: th.constrainedSseClients ?? 6,
      normalMaxSseClients: th.normalMaxSseClients ?? 16
    };

    this._state = 'normal';
    this._belowThresholdSinceMs = null;
    this._lastTransitionMs = this._now();
    this._reports = new RingBuffer(options.reportHistorySize || 100);

    /**
     * Tracked paused/deferred low-priority tasks — NEVER silently dropped!
     * @type {Map<string, { taskId: string, priority: string, pausedAt: string, reason: string, payload: object }>}
     */
    this._pausedLowPriorityTasks = new Map();
    this._maxDeferredTasks = options.maxDeferredTasks || 500;
  }

  get state() {
    return this._state;
  }

  get pausedTaskCount() {
    return this._pausedLowPriorityTasks.size;
  }

  setConfiguredBotCap(botCap) {
    if (!Number.isSafeInteger(botCap) || botCap < 1 || botCap > this._globalBotCap) {
      throw new RangeError(`configuredBotCap must be an integer in [1..${this._globalBotCap}]`);
    }
    this._configuredBotCap = botCap;
  }

  /**
   * Evaluate a ResourceMonitor sample (and optional queue pressures) and update governor state.
   * Escalation is immediate on breach; recovery requires sustained `recoveryCooldownMs` hysteresis.
   *
   * @param {object} sample ResourceSample from ResourceMonitor
   * @returns {{ state: string, changed: boolean, report: object | null }}
   */
  evaluate(sample) {
    const now = this._now();
    const reasons = [];
    let desiredRank = STATE_RANK.normal;

    const rss = sample?.memory?.rssBytes ?? 0;
    const cpu =
      typeof sample?.cpu?.percentNormalized === 'number' ? sample.cpu.percentNormalized : null;
    const lag = sample?.eventLoopDelayMs?.p95 ?? 0;
    const taskQueueLen =
      typeof sample?.queues?.tasks === 'number' ? sample.queues.tasks : 0;

    const th = this._thresholds;

    // Critical checks
    if (rss >= th.criticalRssBytes) {
      desiredRank = STATE_RANK.critical;
      reasons.push(`rssBytes(${rss}) >= critical(${th.criticalRssBytes})`);
    }
    if (cpu !== null && cpu >= th.criticalCpuPercent) {
      desiredRank = STATE_RANK.critical;
      reasons.push(`cpuPercent(${cpu}) >= critical(${th.criticalCpuPercent})`);
    }
    if (lag >= th.criticalLagMs) {
      desiredRank = STATE_RANK.critical;
      reasons.push(`eventLoopP95Ms(${lag}) >= critical(${th.criticalLagMs})`);
    }
    if (taskQueueLen >= th.criticalTaskQueue) {
      desiredRank = STATE_RANK.critical;
      reasons.push(`taskQueue(${taskQueueLen}) >= critical(${th.criticalTaskQueue})`);
    }

    // Constrained checks (if not already critical)
    if (desiredRank < STATE_RANK.critical) {
      if (rss >= th.constrainedRssBytes) {
        desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
        reasons.push(`rssBytes(${rss}) >= constrained(${th.constrainedRssBytes})`);
      }
      if (cpu !== null && cpu >= th.constrainedCpuPercent) {
        desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
        reasons.push(`cpuPercent(${cpu}) >= constrained(${th.constrainedCpuPercent})`);
      }
      if (lag >= th.constrainedLagMs) {
        desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
        reasons.push(`eventLoopP95Ms(${lag}) >= constrained(${th.constrainedLagMs})`);
      }
      if (taskQueueLen >= th.constrainedTaskQueue) {
        desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
        reasons.push(`taskQueue(${taskQueueLen}) >= constrained(${th.constrainedTaskQueue})`);
      }
    }

    const currentRank = STATE_RANK[this._state];

    // Immediate escalation
    if (desiredRank > currentRank) {
      this._belowThresholdSinceMs = null;
      const prevState = this._state;
      this._state = RANK_TO_STATE[desiredRank];
      this._lastTransitionMs = now;
      const report = this._recordTransitionReport(prevState, this._state, reasons, sample, now);
      return { state: this._state, changed: true, report };
    }

    // Stepwise hysteresis recovery (one level at a time)
    if (currentRank > STATE_RANK.normal) {
      const canRecoverOneStep = this._isBelowRecoveryBand(currentRank, {
        rss,
        cpu,
        lag,
        taskQueueLen
      });

      if (canRecoverOneStep) {
        if (this._belowThresholdSinceMs === null) {
          this._belowThresholdSinceMs = now;
        } else if (now - this._belowThresholdSinceMs >= this._recoveryCooldownMs) {
          const prevState = this._state;
          this._state = RANK_TO_STATE[currentRank - 1];
          this._belowThresholdSinceMs = null;
          this._lastTransitionMs = now;
          const report = this._recordTransitionReport(
            prevState,
            this._state,
            [`sustained_recovery_${this._recoveryCooldownMs}ms`],
            sample,
            now
          );
          return { state: this._state, changed: true, report };
        }
      } else {
        this._belowThresholdSinceMs = null;
      }
    }

    return { state: this._state, changed: false, report: null };
  }

  _isBelowRecoveryBand(currentRank, metrics) {
    const th = this._thresholds;
    const cpuOk = metrics.cpu === null || metrics.cpu <= th.recoverCpuPercent;
    const lagOk = metrics.lag <= th.recoverLagMs;
    const queueOk = metrics.taskQueueLen <= th.recoverTaskQueue;

    if (currentRank === STATE_RANK.critical) {
      return (
        metrics.rss <= th.recoverFromCriticalRssBytes &&
        (metrics.cpu === null || metrics.cpu < th.constrainedCpuPercent) &&
        metrics.lag < th.constrainedLagMs &&
        metrics.taskQueueLen < th.constrainedTaskQueue
      );
    }

    // Constrained -> Normal
    return metrics.rss <= th.recoverFromConstrainedRssBytes && cpuOk && lagOk && queueOk;
  }

  /**
   * Compute exact runtime directives for Coordinator, TaskScheduler, Dashboard, AI and Workers.
   *
   * @param {object} [capacity]
   * @param {number} [capacity.serverAvailableSlots=20]
   * @param {number} [capacity.workerAvailableSlots=20]
   * @param {number} [capacity.capabilityEligibleBots=20]
   */
  getDirectives(capacity = {}) {
    const serverSlots = Math.max(0, Math.trunc(capacity.serverAvailableSlots ?? this._configuredBotCap));
    const workerSlots = Math.max(0, Math.trunc(capacity.workerAvailableSlots ?? this._configuredBotCap));
    const eligibleBots = Math.max(0, Math.trunc(capacity.capabilityEligibleBots ?? this._configuredBotCap));

    let governorConcurrencyCap;
    if (this._state === 'normal') {
      governorConcurrencyCap = this._configuredBotCap;
    } else if (this._state === 'constrained') {
      governorConcurrencyCap = Math.max(1, Math.floor(this._configuredBotCap * 0.5));
    } else {
      // Critical: 0 new optional assignments; active leases safely pause/finish
      governorConcurrencyCap = 0;
    }

    // PERFORMANCE_PLAN.md §5: Concurrency is bounded by the minimum of all 5 caps
    const effectiveBotConcurrency = Math.min(
      this._globalBotCap,
      this._configuredBotCap,
      serverSlots,
      workerSlots,
      eligibleBots,
      governorConcurrencyCap
    );

    if (this._state === 'normal') {
      return {
        state: 'normal',
        admitOptionalTasks: true,
        lowPriorityAction: 'execute',
        allowNonEssentialScanning: true,
        scanIntervalMultiplier: 1,
        maxBlockSearchRadius: 32,
        dashboardFlushIntervalMs: 1000,
        maxSseClients: this._thresholds.normalMaxSseClients,
        backgroundCalcBudget: 'full',
        maxCandidateSubsetSearch: 8,
        allowNonEssentialAi: true,
        maxConcurrentAi: 1,
        effectiveBotConcurrency,
        governorConcurrencyCap,
        // Mandatory safety & survival preservation invariants:
        preserveSurvivalAndSafety: true,
        preserveHeartbeatsAndLeases: true,
        preserveDurableStateCommits: true
      };
    }

    if (this._state === 'constrained') {
      return {
        state: 'constrained',
        admitOptionalTasks: false,
        lowPriorityAction: 'pause_and_defer',
        allowNonEssentialScanning: true,
        scanIntervalMultiplier: 3,
        maxBlockSearchRadius: 16,
        dashboardFlushIntervalMs: 3000,
        maxSseClients: this._thresholds.constrainedSseClients,
        backgroundCalcBudget: 'reduced',
        maxCandidateSubsetSearch: 3,
        allowNonEssentialAi: false,
        maxConcurrentAi: 1,
        effectiveBotConcurrency,
        governorConcurrencyCap,
        preserveSurvivalAndSafety: true,
        preserveHeartbeatsAndLeases: true,
        preserveDurableStateCommits: true
      };
    }

    return {
      state: 'critical',
      admitOptionalTasks: false,
      lowPriorityAction: 'pause_and_defer',
      allowNonEssentialScanning: false,
      scanIntervalMultiplier: 0,
      maxBlockSearchRadius: 8,
      dashboardFlushIntervalMs: 5000,
      maxSseClients: 1,
      backgroundCalcBudget: 'minimal',
      maxCandidateSubsetSearch: 1,
      allowNonEssentialAi: false,
      maxConcurrentAi: 0,
      effectiveBotConcurrency: 0,
      governorConcurrencyCap: 0,
      preserveSurvivalAndSafety: true,
      preserveHeartbeatsAndLeases: true,
      preserveDurableStateCommits: true
    };
  }

  /**
   * Handle task admission / low-priority work without EVER silently discarding a task!
   *
   * - Survival/safety operations (`priority: 'survival' | 'safety'`) ALWAYS proceed immediately.
   * - Normal/low-priority tasks under pressure are paused/deferred in `_pausedLowPriorityTasks`
   *   and reported via `workload.task_deferred` so Coordinator/TaskManager persists their state.
   *
   * @param {object} taskRequest
   * @param {string} taskRequest.taskId
   * @param {'survival'|'safety'|'high'|'normal'|'low'} [taskRequest.priority='normal']
   * @param {object} [taskRequest.payload]
   */
  classifyWork(taskRequest) {
    if (!taskRequest || !taskRequest.taskId) {
      throw new TypeError('taskRequest.taskId is required');
    }
    const priority = taskRequest.priority || 'normal';

    // Survival & safety operations NEVER get paused or rejected even in critical state
    if (priority === 'survival' || priority === 'safety') {
      return {
        decision: 'execute_now',
        preservedSafety: true,
        state: this._state
      };
    }

    if (this._state === 'normal') {
      return {
        decision: 'execute_now',
        preservedSafety: false,
        state: 'normal'
      };
    }

    if (this._state === 'constrained' && priority === 'high') {
      return {
        decision: 'execute_reduced_concurrency',
        preservedSafety: false,
        state: 'constrained'
      };
    }

    // Pause / defer low-priority or optional work explicitly (NEVER silent drop!)
    if (
      !this._pausedLowPriorityTasks.has(taskRequest.taskId) &&
      this._pausedLowPriorityTasks.size >= this._maxDeferredTasks
    ) {
      return {
        decision: 'reject_backpressure',
        reason: 'DEFERRED_TASK_CAP_REACHED',
        state: this._state,
        message: 'Coordinator under sustained pressure; retry after workload recovers'
      };
    }

    const record = {
      taskId: String(taskRequest.taskId),
      priority,
      pausedAt: new Date(this._now()).toISOString(),
      reason: this._state === 'critical' ? 'WORKLOAD_CRITICAL' : 'WORKLOAD_CONSTRAINED',
      payload: taskRequest.payload || null
    };
    this._pausedLowPriorityTasks.set(record.taskId, record);

    const reductionEvent = {
      type: 'task_paused_for_pressure',
      occurredAt: record.pausedAt,
      state: this._state,
      taskId: record.taskId,
      priority,
      reason: record.reason,
      pausedQueueDepth: this._pausedLowPriorityTasks.size
    };
    this._reports.push(reductionEvent);
    this.emit('workload.reduction', reductionEvent);

    return {
      decision: 'paused_and_queued',
      reason: record.reason,
      state: this._state,
      pausedQueueDepth: this._pausedLowPriorityTasks.size
    };
  }

  /**
   * Release up to `maxCount` paused tasks in FIFO order once governor returns to normal
   * (or constrained for high-priority items).
   * @param {number} [maxCount=10]
   */
  drainResumableTasks(maxCount = 10) {
    if (this._state === 'critical' || this._pausedLowPriorityTasks.size === 0) {
      return [];
    }
    const resumed = [];
    for (const [taskId, record] of this._pausedLowPriorityTasks.entries()) {
      if (resumed.length >= maxCount) break;
      if (this._state === 'constrained' && record.priority === 'low') {
        continue;
      }
      this._pausedLowPriorityTasks.delete(taskId);
      resumed.push(record);
    }
    if (resumed.length > 0) {
      this.emit('workload.tasks_resumed', {
        state: this._state,
        resumedCount: resumed.length,
        remainingPaused: this._pausedLowPriorityTasks.size
      });
    }
    return resumed;
  }

  _recordTransitionReport(fromState, toState, reasons, sample, nowMs) {
    const directives = this.getDirectives();
    const reductions = [];
    if (!directives.allowNonEssentialScanning) {
      reductions.push('disabled_nonessential_scanning');
    } else if (directives.scanIntervalMultiplier > 1) {
      reductions.push(`reduced_scanning_${directives.scanIntervalMultiplier}x_radius_${directives.maxBlockSearchRadius}`);
    }
    if (directives.dashboardFlushIntervalMs > 1000) {
      reductions.push(`reduced_dashboard_cadence_${directives.dashboardFlushIntervalMs}ms_maxClients_${directives.maxSseClients}`);
    }
    if (directives.backgroundCalcBudget !== 'full') {
      reductions.push(`background_calculations_${directives.backgroundCalcBudget}_maxCandidates_${directives.maxCandidateSubsetSearch}`);
    }
    if (!directives.allowNonEssentialAi) {
      reductions.push('paused_nonessential_ai_deterministic_fallback_active');
    }
    if (directives.governorConcurrencyCap < this._configuredBotCap) {
      reductions.push(`reduced_concurrency_cap_${directives.governorConcurrencyCap}_of_${this._configuredBotCap}`);
    }

    const report = {
      type: 'state_transition',
      occurredAt: new Date(nowMs).toISOString(),
      fromState,
      toState,
      reasons,
      activeReductions: reductions,
      preservedOperations: [
        'survival_actions',
        'safety_stops',
        'worker_heartbeats',
        'lease_fencing_and_reconciliation',
        'durable_sqlite_commits'
      ],
      pausedTaskCount: this._pausedLowPriorityTasks.size,
      snapshotSummary: {
        rssBytes: sample?.memory?.rssBytes ?? null,
        cpuPercentNormalized: sample?.cpu?.percentNormalized ?? 'unavailable',
        eventLoopP95Ms: sample?.eventLoopDelayMs?.p95 ?? null
      }
    };

    this._reports.push(report);
    this.emit('workload.changed', report);
    if (reductions.length > 0) {
      this.emit('workload.reduction', report);
    }
    return report;
  }

  getReductionReports(limit = 50) {
    return this._reports.toArray(limit);
  }
}

module.exports = { WorkloadGovernor, STATE_RANK };
