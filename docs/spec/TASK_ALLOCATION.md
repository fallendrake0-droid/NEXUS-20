# Intelligent Task Allocation, DAG Scheduling & Evidence Verification

**Document:** `docs/spec/TASK_ALLOCATION.md`  
**Specification version:** 1.1.0  
**Related:** `MASTER_SPEC.md`, `MODULE_INTERFACES.md`, `AI_PROTOCOL.md`  
**Core Invariant:** Never assign every bot by default. Select **1 bot** unless adding another eligible participant produces a confidence-supported `>= 10%` reduction in predicted `p90` makespan after travel, setup, coordination, contention and delivery costs.

---

## 1. Decision Scope

For every ready `ObjectiveDTO` in a task's acyclic dependency graph (DAG), `TaskScheduler` deterministically decides:

1. **Single-bot execution (`|S| = 1`):** Default winner whenever one capable bot finishes faster or within `< 10%` of multi-bot alternatives, when target quantity is small (`Q = 1`, e.g. `"craft a wooden pickaxe"`), or when workspace/container contention negates parallel speedup.
2. **Cooperating subset (`2 <= |S| < |E|`):** Chosen when an objective is `partitionable` (shared aggregate quantity split across bots), `spatial` (disjoint exploration sectors), or `role_based` (separate objectives in the DAG such as `build` + `guard`), and each added bot satisfies the marginal benefit & confidence gate (§5).
3. **Entire eligible swarm (`|S| = |E|`, bounded by caps):** Chosen **only** when every eligible bot up to `C_max` continues passing the marginal benefit & confidence gate (e.g., large aggregate mining target across wide uncontested terrain or large-radius multi-sector exploration).
4. **Objective splitting & DAG sequencing:**
   - Distinct resources (`"Collect 100 cobblestone and 40 coal"`) are separate independent objectives (`obj_collect_1`, `obj_collect_2`) that can be allocated concurrently to different bots (e.g., Bot 1 on cobblestone near stone, Bot 2 on coal near an exposed seam) or sequentially to one bot if faster.
   - Dependent steps (`logs -> planks -> sticks -> wooden_pickaxe`) form directed edges `(u -> v)`. Node `v` remains `pending` until every predecessor `u` reaches `state === 'completed'` via verified `InventoryLedger` evidence.

---

## 2. Hard Candidate Eligibility Filter (`evaluateEligibility`)

Before scoring speed, each registered bot `i` is checked against all hard constraints in exact order. The first failing rule marks `eligible: false` with a typed `rejectionCode`:

1. `NOT_CONNECTED`: `!candidate.connected || !candidate.spawned`
2. `STALE_TELEMETRY`: `candidate.telemetryAgeMs > maxTelemetryAgeMs` (default `15,000 ms`)
3. `BUSY_CONFLICT`: bot holds an active non-terminal assignment (`offered | accepted | running | reporting | verifying`)
4. `WRONG_DIMENSION`: `objective.requiredDimension && candidate.dimension !== objective.requiredDimension`
5. `ACTION_UNSUPPORTED`: `!candidate.supportedActions.includes(objective.kind)`
6. `UNSAFE_HEALTH`: `candidate.healthBand === 'critical' || (objective.maxRisk === 'low' && candidate.healthBand === 'low')`
7. `UNSAFE_FOOD`: `candidate.foodBand === 'critical'`
8. `MISSING_TOOL`: objective requires tool tier (e.g., `stone_pickaxe` for `iron_ore`) and bot neither holds it nor has an approved prerequisite objective
9. `LOW_DURABILITY`: required tool remaining durability `< minSafeDurabilityUnits` (default `8`)
10. `INVENTORY_FULL`: `objective.kind in {'mine','collect','craft'}` and `candidate.freeSlotEstimate < 1`

Simultaneously, the maximum number of bots `C_max` that may be allocated across this scheduling pass is bounded by (`PERFORMANCE_PLAN.md` §5):

~~~text
C_max = min(
  config.capacity.globalMaxBots,          // <= 20 hard ceiling
  config.capacity.enabledBots,            // initial: 2
  serverAvailableBotSlots,                // operator-approved server cap
  sum(workerAvailableSlots),              // per-host caps
  eligibleCandidates.length,
  workloadGovernor.effectiveBotConcurrency // shrinks in constrained (50%) and critical (0)
)
~~~

If `C_max === 0` or `eligibleCandidates.length === 0`, the objective stays `ready`/`blocked` with `blockedReason` recorded; no assignment is fabricated.

---

## 3. Measured Rate & Uncertainty Model (`CapabilityProfiler`)

Rates are **never** hard-coded global constants. For key `(serverId, dimension, actionKey, toolClass)`:

1. Collect recent samples `(u_k, d_k, t_k)` where rate `r_k = u_k / d_k` (units/sec) and age `age_k = now - t_k`.
2. Weight each sample exponentially by freshness: `w_k = 0.5 ^ (age_k / halfLifeMs)` (default `halfLifeMs = 1,800,000 ms` = 30 min). Discard samples older than `6 × halfLifeMs`.
3. Compute weighted quantiles over `(r_k, w_k)`:
   - `r_p50`: weighted median throughput (typical rate).
   - `r_p10`: weighted 10th-percentile throughput (pessimistic rate -> yields `p90` duration!).
4. **Cold-start / unknown handling (`sampleCount < 3`):**
   - Mark `isPrior = true` and `confidence = sampleCount === 0 ? 'none' : 'low'`.
   - Use conservative fallback prior `r_prior` (e.g., `0.25 blocks/sec` for mining, `0.20 items/sec` for crafting) with wide pessimistic spread `r_p10 = 0.45 * r_prior` so unmeasured uncertainty penalises speculative swarm fan-out.

---

## 4. Deterministic Completion-Time Equations

### 4.1 Single-Bot Completion Time `T({i}, j, q)`

For bot `i` executing quantity `q` (or unit work `q = 1` for non-quantity objectives):

~~~text
T_travel_p50(i, j) = horizDist(i, j) / v_walk_p50 + vertClimbPenalty(i, j)
T_travel_p90(i, j) = T_travel_p50(i, j) * (regionKnown ? 1.25 : 1.60)

T_setup(i, j)      = equipToolSec(i, j) + (foodBand === 'low' ? eatSec : 0)

T_work_p50(i, j, q) = q / r_p50(i, j)
T_work_p90(i, j, q) = q / r_p10(i, j)

T_return(i, j)     = requiresDeposit(j) ? T_travel_p90(i, depositTarget) + containerInteractSec : 0
T_risk(i, j)       = riskPenaltySec(j.maxRisk, i.healthBand)

T_p50({i}, j, q)   = T_travel_p50 + T_setup + T_work_p50 + T_return + T_risk
T_p90({i}, j, q)   = T_travel_p90 + T_setup + T_work_p90 + T_return + T_risk
sigma({i}, j, q)   = max(1.0, (T_p90({i}, j, q) - T_p50({i}, j, q)) / 1.2816)
~~~

*(If bot `i`'s coordinates or target region coordinates are unknown, `T_travel_p50 = unknownTravelPriorSec` and `confidence` drops to `'low'` — never `0`.)*

### 4.2 Cooperating Subset Completion Time `T(S, j, Q_rem)`

Given candidate subset `S = {b_1, ..., b_m}` (`m = |S| >= 1`) and remaining aggregate quantity `Q_rem` partitioned into integer quotas `(q_1, ..., q_m)` with `sum(q_k) = Q_rem`:

~~~text
1. Parallel critical path:
   T_crit_p50(S) = max_{b_k in S} T_p50({b_k}, j, q_k)
   T_crit_p90(S) = max_{b_k in S} T_p90({b_k}, j, q_k)

2. Coordination & lease-management overhead:
   T_coord(m)    = c_lease * (m - 1) + c_pair * (m * (m - 1) / 2)
   (defaults: c_lease = 1.5s, c_pair = 0.35s)

3. Spatial / resource contention penalty:
   Let m_same = max bots assigned to the same non-disjoint resource cluster,
   and W_faces = estimated independent work faces in that cluster (default 2 if unmeasured, Infinity for disjoint sectors):
   T_contention(S, j) = c_vein * max(0, m_same - W_faces)^2
                      + (requiresSharedContainer(j) ? c_chest * (m - 1) : 0)
   (defaults: c_vein = 4.0s, c_chest = 2.5s)

4. Merge / delivery cost:
   T_merge(S, j) = (verificationPolicy === 'deposited_stock' || singleCollectorRequired)
                 ? c_merge * (m - 1)
                 : 0

5. Total subset makespan & combined uncertainty:
   T_total_p90(S, j) = T_crit_p90(S) + T_coord(m) + T_contention(S, j) + T_merge(S, j)
   Var(S, j)         = max_{b_k in S} (sigma({b_k}, j, q_k)^2) + (0.25 * T_contention(S, j))^2
~~~

Notice why **1 bot automatically wins** for `"Craft a wooden pickaxe"` (`Q_rem = 1`, `parallelism = 'single'`) or `"Mine 4 cobblestone"` when a second bot is 80 blocks away:
- For `Q_rem = 1` or `parallelism === 'single'`, partitioning is disabled (`m = 1`).
- When Bot 2 is far away (`T_travel = 22s`) while Bot 1 mines 4 blocks in `8s`, splitting `3 + 1` yields `T_crit_p90({1,2}) >= 24s + T_coord > 8s`, so `RelativeGain < 0` and Bot 1 alone receives all `4`!

---

## 5. Marginal Benefit & Confidence Algorithm (`chooseParticipants`)

~~~text
Input: objective j, eligible bots E, remaining target Q_rem, cap C_max, policy
Output: AllocationDecision

1. Pre-filter & bound search width:
   Sort E ascending by single-bot T_p90({b}, j, Q_rem) (tie-break by lexicographic botId).
   Keep top K candidates where K = min(|E|, WorkloadGovernor.maxCandidateSubsetSearch)
   (K = 8 in normal, 3 in constrained, 1 in critical).

2. Evaluate 1-bot baseline:
   b_best1 = E_K[0]
   S = [b_best1]
   If j.parallelism in {'single', 'serial'} OR C_max == 1 OR (Q_rem !== null && Q_rem <= 1):
     Return single-bot AllocationDecision(S, quota = Q_rem)

3. Iterative marginal-benefit expansion:
   maxAllowed = (Q_rem !== null) ? min(C_max, Q_rem) : C_max
   While |S| < maxAllowed:
     bestCandidate = null
     bestGain = -Infinity
     For each b in E_K \ S:
       S_trial = S U {b}
       quotas_trial = splitQuota(Q_rem, S_trial) // or partitionRegion for 'spatial'
       If any quota in quotas_trial is 0: continue
       deltaSec = T_total_p90(S, j) - T_total_p90(S_trial, j)
       relGain  = deltaSec / T_total_p90(S, j)
       zScore   = deltaSec / sqrt(Var(S, j) + Var(S_trial, j))

       // Require higher relative gain (0.18) when candidate rate is unmeasured prior
       threshold = hasUnmeasuredPrior(S_trial) ? max(policy.minRelativeGain, 0.18) : policy.minRelativeGain
       If relGain >= threshold AND zScore >= policy.minConfidenceZ (default 1.0):
         If relGain > bestGain:
           bestGain = relGain
           bestCandidate = b

     If bestCandidate === null:
       break // Adding any further bot fails to improve completion time materially!
     S.push(bestCandidate)

4. Persist SchedulerDecision trace and return AllocationDecision(S, splitQuota(Q_rem, S)).
~~~

---

## 6. Aggregate Quota Splitting (`splitQuota`)

For any quantity objective (`targetQuantity = Q`), only `remaining = max(0, Q - verified - reserved)` may be allocated:

1. For each selected bot `b_k in S`, compute sustainable effective weight over planned horizon:
   `w_k = max(0.05, r_p50(b_k, j) / (1 + T_travel_p50(b_k, j) / 60))`
2. If `remaining < |S|`, keep only the top `remaining` bots by `w_k` (so every assigned bot gets `>= 1` unit).
3. Compute exact real shares: `exact_k = remaining * (w_k / sum_m w_m)`.
4. Assign integer base: `q_k = max(1, floor(exact_k))` (if `sum(q_k) > remaining` due to the `max(1, ...)` floor when weights are extreme, initialize `q_k = 1` for all `k` and distribute `remaining - |S|` proportionally).
5. Distribute `rem = remaining - sum(q_k)` one unit at a time to bots sorted descending by `(exact_k - floor(exact_k))`, breaking ties deterministically by ascending `botId`.
6. **Hard Post-Condition Assertion (enforced in code & SQLite `CHECK`):**
   - Every `q_k` is a safe integer `>= 1`.
   - `sum_{k=1..|S|} q_k === remaining`.
   - `verified + existingReserved + sum(q_k) <= Q`.

---

## 7. Spatial Exploration Partitioning & DAG Critical Path

- **Spatial Exploration (`partitionRegion`):** Given axis-aligned bounding box `[minX..maxX, minZ..maxZ]` and `m = |S|` selected bots, split along the longer axis into `m` contiguous, non-overlapping sub-rectangles `R_1 .. R_m` whose union equals the exact parent box (`partitionId: "sector-1-of-m"`). Each bot receives interior grid waypoints (`spacing = 16` blocks) and must observe `>= 85%` of sector cells in loaded chunk state before reporting `region_visited`.
- **DAG Critical Path (`computeCriticalPath`):** Given objective durations `D(v) = T_total_p90(S_v, v)`, topological dynamic programming computes `EarliestFinish(v) = D(v) + max_{u in deps(v)} EarliestFinish(u)`. Task ETA is `max_v EarliestFinish(v)`.

---

## 8. Actual Inventory & World Evidence Verification (`InventoryLedger`)

Workers **never** directly increment `verifiedQuantity`. Every credit requires passing this 6-step deterministic pipeline inside `TaskManager.applyWorkerEvent`:

1. **Idempotency & Sequence Gate:** Check `worker_inbound_messages(message_id)` and `worker_sequence`. Duplicate messages replay their stored ack with zero ledger change.
2. **Lease & Epoch Fence Gate:** Verify `assignment.workerId === authWorker.workerId`, `assignment.allocationEpoch === event.allocationEpoch`, and `serverReceiveTime <= assignment.expiresAt` (or within active reconciliation cutoff prior to epoch increment). Stale epochs are rejected with `STALE_ALLOCATION_EPOCH`.
3. **Canonical Item Identity:** `canonicalItemKey` normalizes registry ID (`minecraft:cobblestone`) plus required variant attributes (e.g., potion/enchantment/damage discriminator when specified by the objective). Unrelated item pickups (`minecraft:dirt` during a `minecraft:cobblestone` task) produce `0` delta.
4. **Baseline-Relative Policy Verification:**
   - **`newly_collected` (default for `mine` / `collect`):**
     - At `assignment.start`, worker records `baselineCount = baselineSnapshot.itemCounts[targetKey] || 0`.
     - On progress/completion snapshot `afterCount`, net acquired on this lease is `netAcquired = max(0, afterCount - baselineCount - netInboundTransfers + verifiedDeposits)`.
     - New incremental credit is `delta = clamp(netAcquired - assignment.creditedQuantity, 0, min(assignment.quotaQuantity - assignment.creditedQuantity, objective.targetQuantity - objective.verifiedQuantity))`.
     - Pre-existing baseline stock (`baselineCount`) is **never** credited unless `constraints.allowExistingStock === true` was explicitly recorded in the task plan!
   - **`held_stock`:** Verifies current sum held across active snapshots minus double-counted in-flight transfers; if a bot drops or loses items before objective completion, negative delta reduces held balance so lost items never count as held!
   - **`deposited_stock`:** Requires matching decrease in bot `InventorySnapshot` **and** matching increase in observed container before/after snapshot (`container_delta` with container block coordinates + dimension).
   - **`crafted_output`:** Verifies positive delta of output `itemKey` **plus** expected consumption delta of recipe input items so pre-existing crafted items are not falsely claimed.
   - **`transfer` (Two-Sided Atomic `transferId`):** A bot-to-bot item handoff uses a single UUID `transferId`. Sender's negative delta and receiver's positive delta are linked to `transferId` so swarm-wide `newly_collected` / `held_stock` neither loses nor double-counts transferred items!
   - **`block_state` / `region_visited` / `role_duration`:** Verifies target coordinate block states in loaded chunks (`block_state`), distinct sector waypoint observations (`region_visited`), or continuous healthy patrol heartbeats inside the protected radius over the required duration (`role_duration`).
5. **Dispute Containment:** If `afterCount < baselineCount + assignment.creditedQuantity` unexpectedly without a recorded transfer/deposit/craft consumption, the discrepancy is flagged `disputed` in `audit_events` and never increments `verifiedQuantity`.
6. **Lease Expiry Reconciliation:** When a worker disconnects and its lease expires:
   - Any valid evidence already committed remains in `verifiedQuantity`.
   - Uncredited reservation `unverifiedRemainder = assignment.quotaQuantity - assignment.creditedQuantity` is released from `reservedQuantity` **only after** `allocationEpoch` is incremented (`+1`) and the old lease is marked `expired`, guaranteeing the recovered worker cannot later double-credit stale work.
