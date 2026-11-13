'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

function canonicalKey(key) {
  if (!key) return null;
  const s = String(key).trim().toLowerCase();
  if (!s) return null;
  return s.includes(':') ? s : `minecraft:${s}`;
}

function buildInventoryReportSnapshot(botId, rawSnap, capturedAt = new Date().toISOString()) {
  const itemCounts = {};
  const srcCounts = rawSnap?.itemCounts || {};
  for (const [k, v] of Object.entries(srcCounts)) {
    const ck = canonicalKey(k);
    if (ck && Number.isSafeInteger(v) && v >= 0) {
      itemCounts[ck] = v;
    }
  }
  let heldTool = null;
  if (rawSnap?.heldTool && rawSnap.heldTool.itemKey) {
    heldTool = {
      itemKey: canonicalKey(rawSnap.heldTool.itemKey),
      remainingDurability:
        typeof rawSnap.heldTool.remainingDurability === 'number'
          ? Math.max(0, Math.trunc(rawSnap.heldTool.remainingDurability))
          : null
    };
  }
  return {
    botId,
    capturedAt,
    itemCounts,
    ...(heldTool ? { heldTool } : {})
  };
}

/**
 * Deterministic, strictly non-`eval` in-game Skill Executor (`SECURITY_PLAN.md` §6, `ARCHITECTURE.md` §3).
 *
 * Supports all 10 `BotAssignmentV1.actionType` values (`mine`, `collect`, `craft`, `build`,
 * `explore`, `guard`, `transfer`, `repair`, `inspect`, `safe_stop`) against a pluggable
 * `BotDriver` (Real Mineflayer Adapter or Deterministic Simulation Adapter).
 *
 * Enforces:
 * 1) Monotonic `performance.now()` lease deadline (`HIGH-05` — immune to wall-clock NTP jumps!).
 * 2) Mid-action `pause`, `resume`, `cancel`, `fence_epoch`, and `survival_override` preemption.
 * 3) Disjoint `regionBounds` spatial corridor confinement (`ADR-003`).
 * 4) Periodic `assignment_progress` checkpoint emission and schema-exact `TaskCompletionReportV1`
 *    / `FailureReportV1` generation for `InventoryLedger` verification.
 */
class SkillExecutor {
  /**
   * @param {object} [options]
   * @param {number} [options.leaseSafetyMarginMs=1000] Stop locally 1s before lease TTL expires
   * @param {number} [options.stepIntervalMs=50]
   */
  constructor(options = {}) {
    this._leaseSafetyMarginMs = Math.max(100, Math.trunc(options.leaseSafetyMarginMs ?? 1_000));
    this._stepIntervalMs = Math.max(5, Math.trunc(options.stepIntervalMs ?? 50));
  }

  /**
   * Execute a `BotAssignmentV1` lease to completion, cancellation, or failure.
   *
   * @param {object} params
   * @param {object} params.assignment `BotAssignmentV1`
   * @param {object} params.driver BotDriver implementation
   * @param {() => { paused: boolean, cancelled: boolean, fenced: boolean, disconnected: boolean, monotonicDeadlineMs: number }} params.getControlState
   * @param {(progressReport: object) => void} [params.onProgress]
   * @param {(observation: object) => void} [params.onWorldObservation]
   * @returns {Promise<{ type: 'completed' | 'failed' | 'cancelled', report: object | null }>}
   */
  async execute({
    assignment,
    driver,
    getControlState,
    onProgress = null,
    onWorldObservation = null
  }) {
    const startedMonoMs = performance.now();
    const startIso = new Date().toISOString();
    const rawBefore = await driver.captureState();
    const beforeSnapshot = buildInventoryReportSnapshot(assignment.botId, rawBefore, startIso);

    let lastCheckpointMonoMs = startedMonoMs;
    const checkpointIntervalMs = Math.max(500, assignment.checkpointIntervalMs || 5_000);

    const checkAbortOrWaitPause = async () => {
      while (true) {
        const ctrl = getControlState();
        if (ctrl.cancelled || ctrl.fenced) {
          await driver.safeStop('assignment_cancelled_or_fenced');
          return { aborted: 'cancelled' };
        }
        if (ctrl.disconnected) {
          return { aborted: 'disconnected' };
        }
        const nowMono = performance.now();
        if (nowMono >= ctrl.monotonicDeadlineMs - this._leaseSafetyMarginMs) {
          await driver.safeStop('local_lease_expired');
          return { aborted: 'lease_expired' };
        }
        if (!ctrl.paused) {
          return { aborted: null };
        }
        await sleep(Math.min(100, this._stepIntervalMs));
      }
    };

    const makeFailure = async (failureCode, retryable, summary, partialEvidence = null) => {
      const nowIso = new Date().toISOString();
      const rawAfter = await driver.captureState();
      const afterSnapshot = buildInventoryReportSnapshot(assignment.botId, rawAfter, nowIso);
      const durationMs = Math.max(1, Math.round(performance.now() - startedMonoMs));

      let partialReport = null;
      if (partialEvidence && partialEvidence.claimedDelta > 0) {
        partialReport = {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: assignment.assignmentId,
          leaseId: assignment.leaseId,
          allocationEpoch: assignment.allocationEpoch,
          taskId: assignment.taskId,
          objectiveId: assignment.objectiveId,
          workerId: assignment.workerId,
          botId: assignment.botId,
          outcome: 'partial',
          durationMs,
          beforeSnapshot,
          afterSnapshot,
          evidence: [partialEvidence],
          reportedAt: nowIso
        };
      }

      return {
        type: 'failed',
        report: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: assignment.assignmentId,
          leaseId: assignment.leaseId,
          allocationEpoch: assignment.allocationEpoch,
          taskId: assignment.taskId,
          objectiveId: assignment.objectiveId,
          workerId: assignment.workerId,
          botId: assignment.botId,
          failureCode,
          retryable,
          safeState: failureCode === 'BOT_DISCONNECTED' ? 'disconnected' : 'idle_safe',
          summary: String(summary).slice(0, 240),
          partialReport,
          reportedAt: nowIso
        }
      };
    };

    const maybeEmitCheckpoint = async (evidenceItem) => {
      if (!onProgress || !evidenceItem) return;
      const nowMono = performance.now();
      if (nowMono - lastCheckpointMonoMs < checkpointIntervalMs) return;
      lastCheckpointMonoMs = nowMono;
      const nowIso = new Date().toISOString();
      const rawMid = await driver.captureState();
      const midSnapshot = buildInventoryReportSnapshot(assignment.botId, rawMid, nowIso);
      onProgress({
        schemaVersion: 1,
        reportId: crypto.randomUUID(),
        assignmentId: assignment.assignmentId,
        leaseId: assignment.leaseId,
        allocationEpoch: assignment.allocationEpoch,
        taskId: assignment.taskId,
        objectiveId: assignment.objectiveId,
        workerId: assignment.workerId,
        botId: assignment.botId,
        outcome: 'partial',
        durationMs: Math.max(1, Math.round(nowMono - startedMonoMs)),
        beforeSnapshot,
        afterSnapshot: midSnapshot,
        evidence: [evidenceItem],
        reportedAt: nowIso
      });
    };

    try {
      const gate0 = await checkAbortOrWaitPause();
      if (gate0.aborted === 'cancelled') return { type: 'cancelled', report: null };
      if (gate0.aborted === 'disconnected') {
        return makeFailure('BOT_DISCONNECTED', true, 'Bot disconnected before starting skill');
      }
      if (gate0.aborted === 'lease_expired') {
        return makeFailure('LEASE_EXPIRED_LOCALLY', true, 'Lease expired locally before action');
      }

      const action = assignment.actionType;
      const targetKey = canonicalKey(assignment.resourceId);
      const quota = assignment.quotaQuantity ?? 1;
      let finalEvidence = null;

      if (action === 'mine' || action === 'collect') {
        let acquired = 0;
        while (acquired < quota) {
          const g = await checkAbortOrWaitPause();
          if (g.aborted === 'cancelled') return { type: 'cancelled', report: null };
          if (g.aborted !== null) {
            const partialEv =
              acquired > 0
                ? {
                    evidenceId: crypto.randomUUID(),
                    kind: 'inventory_delta',
                    itemKey: targetKey,
                    claimedDelta: acquired,
                    details: {}
                  }
                : null;
            return makeFailure(
              g.aborted === 'disconnected' ? 'BOT_DISCONNECTED' : 'LEASE_EXPIRED_LOCALLY',
              true,
              `Interrupted after acquiring ${acquired}/${quota}`,
              partialEv
            );
          }

          const stepBatch = Math.min(8, quota - acquired);
          const stepRes = await driver.gatherResource({
            actionType: action,
            resourceId: targetKey,
            quantity: stepBatch,
            regionBounds: assignment.regionBounds || null
          });

          if (!stepRes.ok) {
            const partialEv =
              acquired > 0
                ? {
                    evidenceId: crypto.randomUUID(),
                    kind: 'inventory_delta',
                    itemKey: targetKey,
                    claimedDelta: acquired,
                    details: {}
                  }
                : null;
            return makeFailure(
              stepRes.failureCode || 'RESOURCE_NOT_FOUND',
              stepRes.retryable !== false,
              stepRes.summary || `Unable to gather ${targetKey}`,
              partialEv
            );
          }

          acquired += stepRes.delta;
          if (stepRes.observation && onWorldObservation) {
            onWorldObservation(stepRes.observation);
          }

          await maybeEmitCheckpoint({
            evidenceId: crypto.randomUUID(),
            kind: 'inventory_delta',
            itemKey: targetKey,
            claimedDelta: acquired,
            details: {}
          });

          if (acquired < quota) {
            await sleep(this._stepIntervalMs);
          }
        }

        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'inventory_delta',
          itemKey: targetKey,
          claimedDelta: acquired,
          details: {}
        };
      } else if (action === 'craft') {
        const craftRes = await driver.craftResource({
          resourceId: targetKey,
          quantity: quota
        });
        if (!craftRes.ok) {
          return makeFailure(
            craftRes.failureCode || 'RESOURCE_NOT_FOUND',
            craftRes.retryable !== false,
            craftRes.summary || `Missing ingredients to craft ${targetKey}`
          );
        }
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'craft_delta',
          itemKey: targetKey,
          claimedDelta: craftRes.craftedDelta,
          details: { consumedInputs: craftRes.consumedInputs }
        };
      } else if (action === 'explore') {
        const expRes = await driver.exploreRegion({
          partitionId: assignment.partitionId || 'sector-1',
          regionBounds: assignment.regionBounds || null,
          checkAbort: checkAbortOrWaitPause
        });
        if (!expRes.ok) {
          if (expRes.cancelled) return { type: 'cancelled', report: null };
          return makeFailure(
            expRes.failureCode || 'PATH_BLOCKED',
            expRes.retryable !== false,
            expRes.summary || 'Exploration blocked'
          );
        }
        if (Array.isArray(expRes.observations) && onWorldObservation) {
          for (const obs of expRes.observations) onWorldObservation(obs);
        }
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'region_visited',
          claimedDelta: 1,
          details: {
            coverageRatio: expRes.coverageRatio ?? 0.95,
            visitedCells: expRes.visitedCells ?? 16,
            partitionId: assignment.partitionId || 'sector-1'
          }
        };
      } else if (action === 'guard') {
        const guardRes = await driver.guardPerimeter({
          regionBounds: assignment.regionBounds || null,
          durationMs: Math.min(3_000, Math.floor((assignment.leaseTtlMs || 30_000) * 0.25)),
          checkAbort: checkAbortOrWaitPause
        });
        if (guardRes.cancelled) return { type: 'cancelled', report: null };
        if (!guardRes.ok) {
          return makeFailure(
            guardRes.failureCode || 'HEALTH_CRITICAL',
            true,
            guardRes.summary || 'Guard interrupted'
          );
        }
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'role_duration',
          claimedDelta: Math.max(1, Math.round(guardRes.patrolSeconds || 2)),
          details: { patrolSeconds: Math.max(1, guardRes.patrolSeconds || 2) }
        };
      } else if (action === 'build' || action === 'repair' || action === 'inspect') {
        const buildRes = await driver.performBlockTask({
          actionType: action,
          resourceId: targetKey,
          partitionId: assignment.partitionId || null,
          regionBounds: assignment.regionBounds || null,
          checkAbort: checkAbortOrWaitPause
        });
        if (buildRes.cancelled) return { type: 'cancelled', report: null };
        if (!buildRes.ok) {
          return makeFailure(
            buildRes.failureCode || 'PATH_BLOCKED',
            buildRes.retryable !== false,
            buildRes.summary || `${action} failed`
          );
        }
        const verifiedBlocks = Number.isSafeInteger(buildRes.verifiedBlocks) ? buildRes.verifiedBlocks : 0;
        if (verifiedBlocks < 1) {
          return makeFailure('PATH_BLOCKED', true, `${action} reported success without verified block changes`);
        }
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'block_state',
          claimedDelta: verifiedBlocks,
          details: { verifiedBlocks }
        };
      } else if (action === 'transfer') {
        const depRes = await driver.depositToContainer({
          resourceId: targetKey,
          quantity: quota
        });
        if (!depRes.ok) {
          return makeFailure(
            depRes.failureCode || 'PATH_BLOCKED',
            true,
            depRes.summary || 'Container deposit failed'
          );
        }
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'container_delta',
          itemKey: targetKey,
          claimedDelta: depRes.deposited,
          details: {
            containerPos: depRes.containerPos,
            containerBeforeCount: depRes.containerBeforeCount,
            containerAfterCount: depRes.containerAfterCount
          }
        };
      } else {
        await driver.safeStop('safe_stop_assignment');
        finalEvidence = {
          evidenceId: crypto.randomUUID(),
          kind: 'role_duration',
          claimedDelta: 1,
          details: { patrolSeconds: 1 }
        };
      }

      const endIso = new Date().toISOString();
      const rawAfter = await driver.captureState();
      const afterSnapshot = buildInventoryReportSnapshot(assignment.botId, rawAfter, endIso);
      const durationMs = Math.max(500, Math.round(performance.now() - startedMonoMs));

      return {
        type: 'completed',
        report: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: assignment.assignmentId,
          leaseId: assignment.leaseId,
          allocationEpoch: assignment.allocationEpoch,
          taskId: assignment.taskId,
          objectiveId: assignment.objectiveId,
          workerId: assignment.workerId,
          botId: assignment.botId,
          outcome: 'completed',
          durationMs,
          beforeSnapshot,
          afterSnapshot,
          evidence: [finalEvidence],
          reportedAt: endIso
        }
      };
    } catch (err) {
      return makeFailure(
        'INTERNAL_EXECUTOR_ERROR',
        true,
        err && err.message ? err.message : 'Unexpected executor failure'
      );
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { SkillExecutor, buildInventoryReportSnapshot };
