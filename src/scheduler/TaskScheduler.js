'use strict';

const crypto = require('node:crypto');
const { splitQuota, partitionRegion } = require('./quotaMath');

const PRIORITY_RANK = Object.freeze({
  low: 1,
  normal: 2,
  high: 3,
  safety: 4,
  survival: 5
});

const TOOL_TIER_RANK = Object.freeze({
  hand: 0,
  wooden: 1,
  golden: 1,
  stone: 2,
  copper: 2,
  iron: 3,
  diamond: 4,
  netherite: 5
});

const TOOL_SPEED_UNITS_PER_SEC = Object.freeze({
  hand: 0.35,
  wooden: 0.65,
  golden: 1.1,
  stone: 0.9,
  iron: 1.2,
  diamond: 1.6,
  netherite: 1.8
});

function requiredPickaxeTierRank(resourceId) {
  if (!resourceId) return 0;
  const r = String(resourceId).toLowerCase();
  if (r.includes('obsidian') || r.includes('ancient_debris')) return TOOL_TIER_RANK.diamond;
  if (r.includes('diamond') || r.includes('emerald') || r.includes('gold_ore') || r.includes('redstone')) {
    return TOOL_TIER_RANK.iron;
  }
  if (r.includes('iron_ore') || r.includes('lapis') || r.includes('copper_ore')) {
    return TOOL_TIER_RANK.stone;
  }
  if (
    r.includes('cobblestone') ||
    r.includes('stone') ||
    r.includes('coal') ||
    r.includes('andesite') ||
    r.includes('diorite') ||
    r.includes('granite') ||
    r.includes('deepslate') ||
    r.includes('netherrack')
  ) {
    return TOOL_TIER_RANK.wooden;
  }
  return 0;
}

function canCraftWoodenPickaxe1Step(itemCounts = {}) {
  const planks =
    (itemCounts['minecraft:oak_planks'] || 0) +
    (itemCounts['minecraft:spruce_planks'] || 0) +
    (itemCounts['minecraft:birch_planks'] || 0);
  const sticks = itemCounts['minecraft:stick'] || 0;
  const logs =
    (itemCounts['minecraft:oak_log'] || 0) +
    (itemCounts['minecraft:spruce_log'] || 0) +
    (itemCounts['minecraft:birch_log'] || 0);
  return (planks >= 3 && sticks >= 2) || logs >= 2;
}

/**
 * Intelligent Evidence-Driven Task Allocation Engine (`MODULE_INTERFACES.md` §3.5 & `TASK_ALLOCATION.md`).
 *
 * Supports all 4 NEXUS-20 dynamic orchestration modes:
 * 1. Identical objective partitioned across up to 20 bots (`splitQuota` / `partitionRegion`).
 * 2. Different objectives simultaneously assigned to disjoint optimal bots.
 * 3. Combined shared + individual role objectives (`start_with` concurrent DAG).
 * 4. Priority-ordered dynamic allocation & safe preemption of unstarted `offered` leases.
 */
class TaskScheduler {
  /**
   * @param {object} options
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {import('../tasks/TaskManager').TaskManager} options.taskManager
   * @param {import('../workers/BotRegistry').BotRegistry} options.botRegistry
   * @param {import('../monitoring/WorkloadGovernor').WorkloadGovernor} options.governor
   * @param {object} [options.config]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    if (!options.stateStore || !options.taskManager || !options.botRegistry || !options.governor) {
      throw new TypeError('TaskScheduler requires stateStore, taskManager, botRegistry and governor');
    }
    this._store = options.stateStore;
    this._tasks = options.taskManager;
    this._registry = options.botRegistry;
    this._governor = options.governor;
    this._config = options.config || {};
    this._logger = options.logger || null;
  }

  lookupRateEstimate(botId, actionKey) {
    const samples = this._store.all(
      `SELECT units_completed / duration_sec AS rate
       FROM action_rate_samples
       WHERE bot_id = ? AND action_key = ?
       ORDER BY observed_at DESC
       LIMIT 15`,
      botId,
      actionKey
    );
    if (samples.length === 0) {
      return {
        actionKey,
        sampleCount: 0,
        p50UnitsPerSec: null,
        p10UnitsPerSec: null,
        confidence: 'none',
        isPrior: true
      };
    }
    const sorted = samples.map((s) => Number(s.rate)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const p50 = sorted[mid];
    const p10 = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];
    const confidence = sorted.length >= 8 ? 'high' : sorted.length >= 3 ? 'medium' : 'low';
    return {
      actionKey,
      sampleCount: sorted.length,
      p50UnitsPerSec: p50,
      p10UnitsPerSec: p10,
      confidence,
      isPrior: false
    };
  }

  estimateCandidate({ objective, candidate, rateEstimate = null, targetPosition = null }) {
    if (!candidate.connected || candidate.busy) {
      return {
        botId: candidate.botId,
        eligible: false,
        rejectionCode: 'BOT_NOT_READY',
        travelSecP50: null,
        travelSecP90: null,
        setupSec: 0,
        workSecP50: null,
        workSecP90: null,
        returnSec: 0,
        riskSec: 0,
        totalSecP50: null,
        totalSecP90: null,
        varianceSec2: 0,
        confidence: 'none',
        rateP50: 0
      };
    }

    if (candidate.healthBand === 'critical' || candidate.foodBand === 'critical') {
      return {
        botId: candidate.botId,
        eligible: false,
        rejectionCode: 'SURVIVAL_CRITICAL',
        travelSecP50: null,
        travelSecP90: null,
        setupSec: 0,
        workSecP50: null,
        workSecP90: null,
        returnSec: 0,
        riskSec: 0,
        totalSecP50: null,
        totalSecP90: null,
        varianceSec2: 0,
        confidence: 'none',
        rateP50: 0
      };
    }

    const acquiresItems = ['mine', 'collect', 'craft'].includes(objective.kind);
    if (acquiresItems && candidate.freeSlotEstimate <= 0) {
      return {
        botId: candidate.botId,
        eligible: false,
        rejectionCode: 'INVENTORY_FULL',
        travelSecP50: null,
        travelSecP90: null,
        setupSec: 0,
        workSecP50: null,
        workSecP90: null,
        returnSec: 0,
        riskSec: 0,
        totalSecP50: null,
        totalSecP90: null,
        varianceSec2: 0,
        confidence: 'none',
        rateP50: 0
      };
    }

    let setupSec = 2;
    let basePriorRate = 1.0;

    if (objective.kind === 'mine') {
      const reqRank = requiredPickaxeTierRank(objective.resourceId);
      const pick = candidate.toolClasses?.pickaxe || null;
      const heldRank = pick ? TOOL_TIER_RANK[pick.tier] ?? 1 : 0;

      if (reqRank > 0 && heldRank < reqRank) {
        // 1-step craftable wooden pickaxe lookahead (`HIGH-03b`)
        if (reqRank === TOOL_TIER_RANK.wooden && canCraftWoodenPickaxe1Step(candidate.itemCounts)) {
          setupSec += 6;
          basePriorRate = TOOL_SPEED_UNITS_PER_SEC.wooden;
        } else {
          return {
            botId: candidate.botId,
            eligible: false,
            rejectionCode: 'TOOL_BROKEN_OR_MISSING',
            travelSecP50: null,
            travelSecP90: null,
            setupSec: 0,
            workSecP50: null,
            workSecP90: null,
            returnSec: 0,
            riskSec: 0,
            totalSecP50: null,
            totalSecP90: null,
            varianceSec2: 0,
            confidence: 'none',
            rateP50: 0
          };
        }
      } else if (pick) {
        basePriorRate = TOOL_SPEED_UNITS_PER_SEC[pick.tier] || 1.0;
      }
    }

    const rateP50 = Math.max(0.1, rateEstimate?.p50UnitsPerSec || basePriorRate);
    const rateP10 = Math.max(0.08, rateEstimate?.p10UnitsPerSec || rateP50 * 0.75);

    let travelSecP50 = 0;
    if (targetPosition && candidate.position) {
      const dist =
        Math.abs(targetPosition.x - candidate.position.x) +
        Math.abs((targetPosition.y ?? 64) - (candidate.position.y ?? 64)) +
        Math.abs(targetPosition.z - candidate.position.z);
      travelSecP50 = dist / 4.3;
    }
    const travelSecP90 = travelSecP50 * 1.25;

    const qty = Math.max(1, objective.remainingQuantity ?? 1);
    const workSecP50 = qty / rateP50;
    const workSecP90 = qty / rateP10;
    const riskSec = candidate.healthBand === 'low' || candidate.foodBand === 'low' ? 8 : 0;

    const totalSecP50 = travelSecP50 + setupSec + workSecP50 + riskSec;
    const totalSecP90 = travelSecP90 + setupSec + workSecP90 + riskSec;
    const spread = Math.max(0, totalSecP90 - totalSecP50);

    return {
      botId: candidate.botId,
      workerId: candidate.workerId,
      eligible: true,
      rejectionCode: null,
      travelSecP50,
      travelSecP90,
      setupSec,
      workSecP50,
      workSecP90,
      returnSec: 0,
      riskSec,
      totalSecP50,
      totalSecP90,
      varianceSec2: spread * spread,
      confidence: rateEstimate?.confidence || 'low',
      rateP50
    };
  }

  chooseParticipants({ objective, candidates, maxAllowed }) {
    const actionKey = objective.resourceId ? `${objective.kind}:${objective.resourceId}` : objective.kind;
    const rejectedCandidates = [];
    const scored = [];

    // Disqualify bots that failed this exact objective with TOOL_BROKEN_OR_MISSING or INVENTORY_FULL
    // UNLESS a newer heartbeat snapshot arrived after that failure showing recovery
    const failedRows = this._store.all(
      `SELECT a.bot_id, a.failure_code, MAX(a.completed_at) AS failed_at, b.updated_at AS bot_updated_at
       FROM assignments a
       JOIN bots b ON b.bot_id = a.bot_id
       WHERE a.objective_id = ? AND a.state = 'failed'
         AND a.failure_code IN ('TOOL_BROKEN_OR_MISSING', 'INVENTORY_FULL')
       GROUP BY a.bot_id, a.failure_code`,
      objective.objectiveId
    );
    const disqualifiedMap = new Map();
    for (const r of failedRows) {
      const failedMs = r.failed_at ? Date.parse(r.failed_at) : 0;
      const updatedMs = r.bot_updated_at ? Date.parse(r.bot_updated_at) : 0;
      if (updatedMs <= failedMs) {
        disqualifiedMap.set(r.bot_id, r.failure_code);
      }
    }

    for (const cand of candidates) {
      if (disqualifiedMap.has(cand.botId)) {
        rejectedCandidates.push({ botId: cand.botId, code: disqualifiedMap.get(cand.botId) });
        continue;
      }
      const rateEst = this.lookupRateEstimate(cand.botId, actionKey);
      const est = this.estimateCandidate({ objective, candidate: cand, rateEstimate: rateEst });
      if (!est.eligible) {
        rejectedCandidates.push({ botId: cand.botId, code: est.rejectionCode });
      } else {
        scored.push({ candidate: cand, estimate: est });
      }
    }

    if (scored.length === 0 || maxAllowed <= 0) {
      return {
        objectiveId: objective.objectiveId,
        allocationEpoch: objective.allocationEpoch,
        feasible: false,
        blockedReason: maxAllowed <= 0 ? 'NO_CONCURRENCY_SLOTS' : 'NO_ELIGIBLE_BOTS',
        selectedCount: 0,
        quotas: [],
        singleBotP90Sec: null,
        selectedSubsetP90Sec: null,
        relativeGain: 0,
        coordinationSec: 0,
        contentionSec: 0,
        rejectedCandidates,
        reason: 'no_feasible_candidates'
      };
    }

    // Sort best single-bot candidates first (lowest totalSecP90, deterministic botId tie-breaker)
    scored.sort(
      (a, b) =>
        a.estimate.totalSecP90 - b.estimate.totalSecP90 ||
        a.candidate.botId.localeCompare(b.candidate.botId)
    );

    const singleBotP90Sec = scored[0].estimate.totalSecP90;
    const cap = Math.min(maxAllowed, scored.length, 20);
    let quotas = [];
    let selectedSubsetP90Sec = singleBotP90Sec;
    let reason = 'single_bot_optimal';

    if (
      objective.parallelism === 'single' ||
      objective.parallelism === 'serial' ||
      objective.parallelism === 'role_based' ||
      (objective.remainingQuantity !== null && objective.remainingQuantity <= 1)
    ) {
      const top = scored[0].candidate;
      quotas = [
        {
          botId: top.botId,
          workerId: top.workerId,
          quantity: objective.remainingQuantity,
          partitionId: null,
          regionBounds: null,
          role: objective.kind
        }
      ];
    } else if (objective.parallelism === 'spatial') {
      const k = Math.min(cap, Math.max(1, objective.workerCountHint || 2));
      quotas = partitionRegion(
        { dimension: 'minecraft:overworld', minX: -64, maxX: 64, minZ: -64, maxZ: 64 },
        scored.slice(0, k).map((s) => s.candidate)
      );
      selectedSubsetP90Sec = singleBotP90Sec / Math.max(1, quotas.length);
      reason = quotas.length > 1 ? 'spatial_sector_partition' : 'single_bot_spatial';
    } else if (objective.remainingQuantity !== null && objective.remainingQuantity > 1) {
      const pool = scored.slice(0, cap).map((s) => ({
        botId: s.candidate.botId,
        workerId: s.candidate.workerId,
        rateP50: s.estimate.rateP50,
        travelSec: s.estimate.travelSecP50,
        setupSec: s.estimate.setupSec
      }));

      if (objective.remainingQuantity < 16 || pool.length === 1) {
        quotas = splitQuota(objective.remainingQuantity, pool.slice(0, 1));
      } else {
        const estMap = new Map(pool.map((p) => [p.botId, p]));
        const subsetP90 = (qs) => {
          let maxFinish = 0;
          const coordOverhead = (qs.length - 1) * 1.2;
          for (const q of qs) {
            const p = estMap.get(q.botId);
            const finish = (p.travelSec + p.setupSec + q.quantity / p.rateP50) * 1.2 + coordOverhead;
            if (finish > maxFinish) maxFinish = finish;
          }
          return maxFinish;
        };

        let bestQuotas = splitQuota(objective.remainingQuantity, pool.slice(0, 1));
        let bestP90 = subsetP90(bestQuotas);

        for (let k = 2; k <= Math.min(pool.length, objective.remainingQuantity); k += 1) {
          const trial = splitQuota(objective.remainingQuantity, pool.slice(0, k));
          if (trial.length < k) break;
          const trialP90 = subsetP90(trial);
          const savedSec = bestP90 - trialP90;
          const relGain = bestP90 > 0 ? savedSec / bestP90 : 0;
          if ((savedSec >= 5 && relGain >= 0.1) || savedSec >= 10) {
            bestQuotas = trial;
            bestP90 = trialP90;
            reason = `water_filling_${k}_bots`;
          } else {
            break;
          }
        }
        quotas = bestQuotas;
        selectedSubsetP90Sec = bestP90;
      }
    }

    const relativeGain =
      singleBotP90Sec && singleBotP90Sec > 0
        ? Math.max(0, (singleBotP90Sec - selectedSubsetP90Sec) / singleBotP90Sec)
        : 0;

    return {
      objectiveId: objective.objectiveId,
      allocationEpoch: objective.allocationEpoch,
      feasible: quotas.length > 0,
      blockedReason: null,
      selectedCount: quotas.length,
      quotas,
      singleBotP90Sec,
      selectedSubsetP90Sec,
      relativeGain,
      coordinationSec: Math.max(0, (quotas.length - 1) * 1.2),
      contentionSec: 0,
      rejectedCandidates,
      reason
    };
  }

  /**
   * Schedule ready objectives across either one `taskId` or all active tasks in strict priority order.
   */
  async scheduleReadyObjectives(targetTaskId = null) {
    const directives = this._governor.getDirectives({
      serverAvailableSlots: this._registry.enabledBotsCap,
      workerAvailableSlots: this._registry.enabledBotsCap,
      capabilityEligibleBots: this._registry.enabledBotsCap
    });
    if (directives.effectiveBotConcurrency <= 0) {
      return { scheduled: 0, reason: 'governor_concurrency_zero' };
    }

    const taskRows = targetTaskId
      ? this._store.all(
          `SELECT task_id, priority FROM tasks WHERE task_id = ? AND state IN ('ready', 'running')`,
          targetTaskId
        )
      : this._store.all(
          `SELECT task_id, priority, created_at FROM tasks WHERE state IN ('ready', 'running')`
        );

    taskRows.sort(
      (a, b) =>
        (PRIORITY_RANK[b.priority] || 2) - (PRIORITY_RANK[a.priority] || 2) ||
        String(a.created_at || '').localeCompare(String(b.created_at || ''))
    );

    let scheduledCount = 0;
    const nowIso = new Date().toISOString();

    for (const tRow of taskRows) {
      const readyList = this._tasks.readyObjectives(tRow.task_id);
      if (readyList.length === 0) continue;

      const incomingRank = PRIORITY_RANK[tRow.priority] || 2;

      // Dynamic priority preemption for `high`/`safety`/`survival` tasks if slots are saturated by lower-priority `offered` leases
      if (incomingRank >= PRIORITY_RANK.high) {
        const busyCountRow = this._store.get(
          `SELECT COUNT(DISTINCT bot_id) AS cnt FROM assignments
           WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`
        );
        const busyCount = Number(busyCountRow?.cnt || 0);
        const freeSlots = directives.effectiveBotConcurrency - busyCount;
        const neededMin = Math.min(readyList.length, directives.effectiveBotConcurrency);
        if (freeSlots < neededMin) {
          this._tasks.preemptOfferedAssignments({
            neededSlots: neededMin - freeSlots,
            incomingPriorityRank: incomingRank,
            priorityRankMap: PRIORITY_RANK
          });
        }
      }

      // Fair slot distribution when a single task has multiple concurrent ready objectives (e.g. "Collect 100 cobble and 40 coal" or "Build while 1 bot guards")
      for (let idx = 0; idx < readyList.length; idx += 1) {
        const obj = readyList[idx];
        const busyRows = this._store.all(
          `SELECT DISTINCT bot_id FROM assignments
           WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`
        );
        const busyIds = new Set(busyRows.map((r) => r.bot_id));
        const totalRemainingSlots = directives.effectiveBotConcurrency - busyIds.size;
        if (totalRemainingSlots <= 0) break;

        // Reserve at least 1 slot for each remaining sibling ready objective in the same task when slots allow
        const remainingSiblings = readyList.length - idx - 1;
        const maxForThisObjective =
          totalRemainingSlots > remainingSiblings
            ? totalRemainingSlots - remainingSiblings
            : totalRemainingSlots;

        const candidates = this._registry
          .eligibleBots({ onlyReady: true })
          .filter((b) => !busyIds.has(b.botId));

        const decision = this.chooseParticipants({
          objective: obj,
          candidates,
          maxAllowed: maxForThisObjective
        });

        if (decision.feasible && decision.quotas.length > 0) {
          const created = this._tasks.commitAssignments({
            objectiveId: obj.objectiveId,
            allocationEpoch: obj.allocationEpoch,
            quotas: decision.quotas,
            leaseDurationMs: this._config.capacity?.defaultLeaseDurationMs ?? 30_000,
            checkpointIntervalMs: this._config.capacity?.heartbeatIntervalMs ?? 5_000
          });
          scheduledCount += created.length;

          this._store.run(
            `INSERT INTO scheduler_decisions (
              decision_id, task_id, objective_id, allocation_epoch,
              selected_bot_ids_json, quotas_json, single_bot_p90_sec,
              selected_subset_p90_sec, marginal_gain, decision_reason, trace_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            tRow.task_id,
            obj.objectiveId,
            obj.allocationEpoch,
            JSON.stringify(decision.quotas.map((q) => q.botId)),
            JSON.stringify(decision.quotas),
            decision.singleBotP90Sec,
            decision.selectedSubsetP90Sec,
            decision.relativeGain,
            decision.reason,
            JSON.stringify({ rejectedCandidates: decision.rejectedCandidates }),
            nowIso
          );
        }
      }
    }

    return { scheduled: scheduledCount };
  }
}

module.exports = {
  TaskScheduler,
  PRIORITY_RANK,
  requiredPickaxeTierRank
};
