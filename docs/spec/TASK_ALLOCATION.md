# Intelligent Task Allocation and Verification

**Specification:** 1.0.0  
**Core rule:** choose the smallest capable bot subset that gives a material, evidence-supported improvement.

## 1. Allocation objectives

The scheduler must decide for each objective whether to use one bot, a cooperating subset, role-specific bots or a spatially partitioned subset. It must never fan every objective out to the whole swarm by default.

Inputs include:

- current bot position and dimension;
- path/travel estimate to target region;
- inventory and available capacity;
- tool type, enchantment where relevant and remaining durability;
- health, food, air and survival state;
- action capability and recent success/failure history;
- measured material-specific action rate;
- local resource availability and contention;
- task quantity, complexity and dependency readiness;
- risk estimate and safety constraints;
- server connection cap, per-worker bot cap and global cap;
- coordination/startup/communication overhead;
- uncertainty and freshness of each measurement.

Unknown data remains unknown and lowers confidence. The system must not fabricate a location, tool, resource deposit or performance rate.

## 2. Objective classes and default parallelism

| Objective | Default strategy | When to parallelise |
|---|---|---|
| Mine/collect a single aggregate quantity | One bot baseline | Disjoint resource areas or measured faster shared quota |
| Collect multiple resource types | Separate objective per resource | Allocate each independently to suitable bots |
| Craft one item | Single capable bot | Only if recipe has independent parallel batches and merge cost is beneficial |
| Craft many items | Single baseline | Split independent batches only if inventories/materials permit |
| Explore | Spatial partition | Distinct sectors with disjoint search bounds |
| Build shelter | Single builder baseline | Separate construction zones or explicit roles such as builder + guard |
| Guard | One guard per protected region unless explicitly requested otherwise | Several guarded regions or independent patrol sectors |
| Transfer/deposit | Single transfer owner per transaction | Parallel only across separate destinations and disjoint cargo |
| Dependency chain | Respect DAG | Parallelise only independent ready nodes |

The strategy may be changed when measured execution evidence shows another method is better.

## 3. Deterministic estimate model

For bot i and objective j:

- Ttravel(i,j): estimated route time from current position to work region.
- Tsetup(i,j): preparation time, including tool selection, inventory rearrangement, food and crafting prerequisites.
- Twork(i,j,q): expected work time for quantity q using measured rate and uncertainty.
- Treturn(i,j): return/deposit time when objective requires delivery.
- Trisk(i,j): expected delay/cost for risk mitigation or recovery.
- Tcoord(S,j): coordination overhead for participant set S.
- Tcontention(S,j): expected penalty from bots competing for the same blocks, path or containers.

A single-bot estimate:

~~~text
T(i,j,q) = Ttravel + Tsetup + Twork(q) + Treturn + Trisk
~~~

Twork uses a robust measured rate distribution, not a generic hard-coded blocks-per-second constant. Store sample count, median/trimmed mean, p50, p90 and confidence. Measurements are segmented by server/version, dimension, material, tool class and environmental conditions where useful. Decay stale samples and retain a low-confidence flag.

For a selected subset S and a set of disjoint work partitions P:

~~~text
T(S,j) = Tcritical_path(P) + Tcoord(S,j) + Tcontention(S,j)
          + Tmerge_or_delivery(S,j)
~~~

Tcritical_path is the longest predicted partition completion time plus any prerequisite chain. For one aggregate quantity, work is divided into non-overlapping quotas. For exploration, each participant receives a separate region/sector. For role work, the DAG contains distinct roles and dependencies.

A task containing multiple objectives is estimated as a DAG: independent ready objectives can run concurrently; a dependent objective starts only when all required predecessors have completed. Overall predicted completion time is the DAG critical path, not the sum of every objective duration.

## 4. Candidate feasibility

A bot is eligible only if all hard requirements pass:

- connected and spawned;
- authenticated legitimately;
- registered, enabled and not already committed beyond capacity;
- server/worker/global caps have available slots;
- correct dimension and access to target region;
- required tool or a safe, achievable preparation path;
- sufficient health/food/durability for the risk policy;
- action module exists and declares support for the current protocol tuple;
- no conflicting active assignment on the same bot;
- objective is ready and lease budget is available.

Soft suitability scores never override hard constraints. If a bot is ineligible, record a typed reason such as NOT_CONNECTED, WRONG_DIMENSION, MISSING_TOOL, UNSAFE_HEALTH, SERVER_CAP or ACTION_UNSUPPORTED.

## 5. Participant search

For at most twenty configured bot identities, exhaustive subset enumeration is possible in the worst case but 2^20 candidate sets is unnecessarily expensive. Use bounded search:

1. Build eligible candidate list.
2. Keep at most K candidates after filtering by capability, travel and confidence. K is configurable and must be benchmarked.
3. Evaluate the one-bot baseline for every eligible candidate.
4. Greedily add the candidate with the greatest marginal reduction in predicted completion time, recalculating quota splits and contention.
5. Stop when no candidate creates material improvement, a cap is reached, or adding a participant makes the objective infeasible.
6. For high-impact cases, run a bounded local search over alternatives to avoid a poor greedy partition. Record search budget and decision trace.
7. Select minimum-cost subset among candidates whose expected completion improvement passes the benefit threshold.

Participant count is an output of deterministic scheduling, not a fixed global fan-out setting. Ollama may suggest a parallelism mode or preferred count, but the scheduler can reduce, increase or reject it.

## 6. Marginal benefit rule

Compare the proposed subset S with S plus candidate b:

~~~text
Benefit(b | S) = (T_p90(S) - T_p90(S union {b})) / T_p90(S)
~~~

Add b only when:

- the new subset is feasible;
- predicted p90 completion time improves by at least configured MIN_RELATIVE_GAIN (initial candidate: 0.10);
- the expected improvement exceeds model uncertainty, using measured confidence intervals;
- the reduction remains after coordination, contention, travel and return/merge costs;
- the objective can be partitioned without duplicated or conflicting work.

If benchmark evidence is sparse, increase the safety margin or stay with one bot. The 10% starting value is a policy default to be calibrated, not a guaranteed optimal constant.

After the task completes, compare predicted and actual makespan and update rates/overhead estimates. Store allocation decision features so later scheduler benchmarks are reproducible.

## 7. Splitting aggregate quantity targets

For objective target Q:

~~~text
remaining = max(0, Q - verified - reserved)
~~~

Only remaining can be assigned. Compute each selected bot's weight from its estimated sustainable throughput over the planned interval, adjusted for travel, tool availability, risk and uncertainty. Allocate integer quotas using largest-remainder rounding:

1. compute ideal share = remaining × weight / sum(weights);
2. assign floor(ideal share);
3. distribute remaining units by descending fractional remainder, with deterministic bot-ID tie break;
4. do not allocate zero quota unless the bot has a role-only assignment;
5. assert sum(quotas) === remaining;
6. persist all quotas in one TaskManager transaction.

Do not assign Q independently to each bot. For example, if a shared target is 100 cobblestone and three bots receive quotas 40, 35 and 25, the objective remains 100, not 300. If only one bot is beneficial, it receives 100.

Reservations are not verified progress. The dashboard must display verified, reserved and remaining separately.

## 8. Multiple resource types

“Collect 100 cobblestone and 40 coal” creates two objectives:

- cobblestone target: 100;
- coal target: 40.

The scheduler considers eligible bots separately for each objective. It may assign one bot to each, both bots to one resource if parallelism is justified, or one bot sequentially for both if that is faster. If the tasks share a travel route or tool setup, include that saved setup cost in the estimate.

## 9. Dependencies and critical path

Represent dependencies as a DAG. Validate:

- every dependency points to an objective in the same task;
- no self-reference;
- no cycle;
- dependency state is complete before dependent objective is assigned;
- a failed prerequisite blocks dependent nodes and triggers explicit replan or operator action.

Examples:

- obtain logs → craft planks → craft table → craft tool;
- acquire materials → build foundation → build walls → add roof;
- explore sector → identify target region → mine target.

Do not treat a model-proposed dependency as true without semantic validation. Use a deterministic topological sort for scheduling.

## 10. Role and spatial tasks

### Builder + guard

Create separate objectives with explicit role capabilities. Builder assignment owns the construction scope; guard assignment owns the protected region and duration/conditions. They are independent unless the guard must remain active until construction ends, in which case builder completion is a dependency or stop condition for the guard. A guard should not also be assigned mining/building unless the policy explicitly defines safe context switching.

### Exploration

Partition a requested region into disjoint sectors, with deterministic sector IDs and bounds. The sum of region coverage must equal the task's declared area. Bots report sampled waypoints, visited chunks/region cells and discovery evidence. Avoid sending entire entity/chunk maps to the phone or Ollama. Do not report an unexplored sector complete because a bot merely reached its initial waypoint.

## 11. Inventory and resource verification

### 11.1 Assignment baseline

At assignment start, worker provides a canonical inventory snapshot and equipment summary. TaskManager stores baseline inventory per bot and assignment ID. Existing inventory does not count as newly collected unless the objective explicitly says to use existing stock.

Canonical item key:
- registry namespace/name;
- relevant metadata, damage, enchantments or NBT fingerprint if the requested item distinguishes variants;
- stack count is a quantity, not part of the identity.

### 11.2 Evidence flow

1. BotController captures baseline inventory.
2. Mineflayer events such as playerCollect, itemDrop and block updates may provide timing/context hints.
3. Action module reports intended operation and its result.
4. BotController captures post-action inventory snapshots.
5. Worker submits evidence with assignment ID, epoch, sequence and sample time.
6. TaskManager verifies active lease and event idempotency.
7. InventoryLedger computes observed deltas and checks target item identity.
8. Task-specific policy determines whether this delta is creditable.
9. Ledger transaction records unique evidence IDs and updates verified quantity atomically.
10. Dashboard progress is computed from ledger totals, never from raw worker-reported counters.

Mineflayer's playerCollect event identifies an entity pickup, and world blockUpdate is available for block changes; neither alone proves the final quantity held by the bot. Verify against the actual inventory state. Mineflayer API reference: https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md

### 11.3 Avoiding duplicate or incorrect credits

- Deduplicate by messageId/evidenceId and worker sequence.
- Reject events for expired/revoked leases or stale allocation epochs.
- Never credit more than assignment quota.
- Never credit more than remaining objective target.
- Do not count initial baseline stock as newly acquired by default.
- Deduct verified losses, drops, consumption or transfers when objective semantics require held stock.
- For transfers, use one globally unique transfer ID and a two-sided transaction: sender debit and receiver credit commit once.
- For containers, snapshot destination before and after deposit; do not credit based solely on a bot saying “deposited”.
- For items consumed by crafting, transfer the relevant input quantities into a consumption ledger and verify output separately.
- If inventory changes cannot be reconciled, mark evidence disputed and keep it out of verified progress.

### 11.4 Objective verification policies

| Policy | Credit condition |
|---|---|
| newly_collected | Net positive item delta after assignment baseline, with no later loss if held-stock semantics apply |
| held_stock | Verified total currently held by participating bots, excluding double-counted transfers |
| deposited_stock | Verified decrease in bot inventory plus matching increase at the designated container |
| crafted_output | Verified output delta and action/recipe evidence |
| block_state | All required target coordinates match expected block state |
| region_visited | Required region cells/waypoints are observed as visited |
| role_duration | Required role is active for the declared bounded duration and safety conditions |

The default interpretation of “collect X” is newly_collected. If the user intends to use existing stock, record that explicitly in the plan.

## 12. Lease and failure recovery

Every assignment has:
- assignmentId;
- workerId and botId;
- allocationEpoch;
- leaseId;
- issuedAt and expiresAt;
- quota and work scope;
- objective version;
- action constraints.

A lease is renewed by accepted heartbeats/progress while the worker is active. The master uses server time. If the lease expires:

1. stop counting new evidence for that lease after the expiry cutoff;
2. request final worker checkpoint if reachable;
3. reconcile inventory and action checkpoint;
4. commit verified evidence already received;
5. release the unverified reservation;
6. increment allocationEpoch;
7. reschedule remaining target.

Do not reassign until the old lease is fenced. Workers must stop executing expired assignments when they cannot renew; they must not continue indefinitely offline.

## 13. Scheduler decision record

Every allocation stores:
- candidate bot IDs (not secrets);
- capabilities and telemetry age;
- travel estimate and uncertainty;
- rate estimate/sample count;
- resource/tool constraints;
- predicted single-bot completion p50/p90;
- predicted selected-subset completion p50/p90;
- coordination and contention cost;
- expected marginal gain;
- selected count and reason;
- quota split;
- model hint if any;
- rejected candidate reasons;
- scheduler algorithm/config version.

This record is essential for auditability and tuning.

## 14. Calibration and anti-regression

Benchmark one-bot and multi-bot variants on the same private test world, resource distribution and server settings. Track:
- prediction error p50/p90;
- observed completion time;
- travel fraction;
- time spent preparing;
- idle/coordination fraction;
- duplicate work;
- resource contention;
- failure/retry time;
- actual verified progress per minute.

A scheduler release must not regress correctness or create larger measured makespan on standard fixtures without an explained and tested policy change.

