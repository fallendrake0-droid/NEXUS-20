# Independent Adversarial Design Test Scenarios — Mineflayer AI Swarm

**Document:** `CLAUDE_TEST_SCENARIOS.md`  
**Reviewer Role:** Independent Principal Software Architect  
**Purpose:** Stress-test the architecture against 9 mandatory real-world operational scenarios, exposing where the unpatched v1.1.0 spec fails and defining the exact deterministic behaviour required to pass.

---

## Scenario 1: One Bot Should Be Selected

### 1.1 Sub-Case A — Single-Unit Non-Partitionable Task (`"Craft a wooden pickaxe"`)
- **Initial State:**
  - `enabledBots = 4` (`bot-1..bot-4` all connected, healthy, idle).
  - `bot-1` at `(10, 64, 10)` has `3 minecraft:oak_planks`, `2 minecraft:stick`, `1 minecraft:crafting_table` in inventory.
  - `bot-2` at `(12, 64, 10)` has `2 minecraft:oak_log` (`0` planks/sticks).
  - `bot-3`, `bot-4` at `(200, 64, -150)` have empty inventories.
- **Expected Correct System Behaviour:**
  1. **AI / Fast-Path:** Matches deterministic `craft` template (`0` Ollama calls, `< 1 ms`) -> `TaskPlanV1` with 1 objective: `kind: 'craft'`, `resourceId: 'minecraft:wooden_pickaxe'`, `targetQuantity: 1`, `parallelism: 'single'`, `verification: 'crafted_output'`.
  2. **Eligibility & Capability Check:** `bot-1` has immediate inputs + crafting table (`T_setup = 2.5s` to place table, `T_work_p90 = 3.0s`, `T_total_p90 = 5.5s`). `bot-3`/`bot-4` lack inputs.
  3. **Scheduler Gate:** Because `parallelism === 'single'` and `Q_rem === 1`, `chooseParticipants` immediately returns `|S| = 1` (`selected = ['bot-1']`, `quotaQuantity = 1`). Bots `2, 3, 4` remain `ready` (idle).
  4. **Verification:** `bot-1` reports `beforeSnapshot` (`planks: 3, stick: 2, wooden_pickaxe: 0`) and `afterSnapshot` (`planks: 0, stick: 0, wooden_pickaxe: 1`). `InventoryLedger` verifies `+1 wooden_pickaxe` **and** `-3 planks, -2 stick` consumption -> credits `verifiedQuantity = 1/1` -> Task `completed`.

### 1.2 Sub-Case B — Partitionable Task Where Travel + Overhead Makes 2 Bots Slower (`"Mine 8 cobblestone"`)
- **Initial State:**
  - `bot-1` at `(100, 64, 100)`, `4` blocks from stone (`T_travel_p90 = 1.5s`), holds `iron_pickaxe` (`r_p50 = 1.0/s`, `r_p10 = 0.8/s`).
  - `bot-2` at `(240, 64, 100)`, `140` blocks away (`T_travel_p90 = 40.0s`), holds `stone_pickaxe` (`r_p50 = 0.65/s`, `r_p10 = 0.5/s`).
- **Worked Math:**
  - **1-bot (`{bot-1}`, `q_1 = 8`):** `T_p90({bot-1}) = 1.5s + 0s + (8 / 0.8) = 11.5s`.
  - **2-bot trial (`{bot-1, bot-2}`):** Even giving `bot-2` minimal `q_2 = 1`, `T_p90({bot-2}, 1) = 40.0s + 2.0s = 42.0s` (+ `T_coord = 1.85s` = `43.85s` >> `11.5s`!). With water-filling `splitQuota` (`CLAUDE_RECOMMENDATIONS.md` §2.3), `F_2 = 32s > T* = 9.2s`, so `bot-2` is pruned automatically!
- **Expected Correct System Behaviour:** `RelativeGain < 0` -> Scheduler assigns **only `bot-1`** (`quota = 8`), logs `decisionReason: "single_bot_faster_than_subset"` in `scheduler_decisions`, and finishes in `~9.5s` instead of `44s`.

---

## Scenario 2: Two Bots Should Share an Objective (`"Mine 100 cobblestone"`)

- **Initial State:**
  - `enabledBots = 3`.
  - `bot-1` at `(100, 64, 100)` (`10` blocks from stone quarry, `F_1 = 3s`), `stone_pickaxe` (`r_p50 = 0.60/s`, `r_p10 = 0.48/s`, durability `95`).
  - `bot-2` at `(190, 64, 100)` (`90` blocks from quarry, `F_2 = 22s`), `iron_pickaxe` (`r_p50 = 1.00/s`, `r_p10 = 0.80/s`, durability `180`).
  - `bot-3` at `(105, 64, 102)`, `health = 4.0` (`healthBand: 'critical'`), `wooden_pickaxe` (`durability = 3`).
- **Audit Challenge Exposed (`HIGH-03a`):**
  - Unpatched `splitQuota` (`w_k = r / (1 + T_travel/60)`) gives `w_1 = 0.60 / 1.05 = 0.571`, `w_2 = 1.00 / 1.367 = 0.732` -> `q_1 = 44, q_2 = 56`: `bot-1` finishes at `3 + 44/0.6 = 76.3s`, `bot-2` finishes at `22 + 56/1.0 = 78.0s` (close here, **but** at `Q = 500` it skews `219` vs `281` -> `368s` vs `303s`, wasting `65s`!).
  - Corrected water-filling (`T* = (100 + 0.6*3 + 1.0*22) / (0.6 + 1.0) = 123.8 / 1.6 = 77.375s`) gives `exact_1 = 0.6 * (77.375 - 3) = 44.625 -> 45`, `exact_2 = 1.0 * (77.375 - 22) = 55.375 -> 55` (`45 + 55 = 100`), equalizing completion to `< 0.7s`!
- **Expected Correct System Behaviour:**
  1. **Eligibility:** `bot-3` is rejected with `UNSAFE_HEALTH` (and `LOW_DURABILITY`).
  2. **Marginal Benefit Check:**
     - `1-bot` best (`bot-2`, `q = 100`): `T_p90 = 27.5s + 100/0.80 = 152.5s`.
     - `2-bot` (`{bot-1: 45, bot-2: 55}` across wide quarry `W_faces = 6`, `T_contention = 0`, `T_coord = 1.85s`): `T_crit_p90 = max(3.8 + 45/0.48, 27.5 + 55/0.80) = max(97.55s, 96.25s) = 97.55s` -> `T_total_p90 = 99.4s`.
     - `RelativeGain = (152.5 - 99.4) / 152.5 = 34.8% >= 10%`, `zScore >= 1.0` -> **Both `bot-1` (`45`) and `bot-2` (`55`) selected!**
  3. **Single Aggregate Target Enforcement:** SQLite `objectives` stores `target_quantity = 100, verified_quantity = 0, reserved_quantity = 100` (`45 + 55 <= 100`). Neither bot is ever told `"mine 100"`.
  4. **Completion:** `bot-1` verifies `+45`, `bot-2` verifies `+55` -> `verified_quantity = 100`, `reserved_quantity = 0` -> Objective `completed` at **exact aggregate `100`**.

---

## Scenario 3: Three Bots Should Be Assigned Different Objectives

### 3.1 Multi-Resource + Role Prompt: `"Collect 100 cobblestone and 40 coal while one bot guards the base"`
- **Initial State:**
  - `bot-1` near stone pit `(105, 64, 100)`, `iron_pickaxe`, `sword: none`.
  - `bot-2` near exposed coal cliff `(40, 78, -30)`, `stone_pickaxe`.
  - `bot-3` at base `(0, 65, 0)`, holds `iron_sword`, `shield`, `12 cooked_beef`, `pickaxe: none`.
- **Audit Challenge Exposed (`HIGH-02b`, `HIGH-03c`):**
  - If `bot-2` is currently holding a `torch` in `heldItem` with its `stone_pickaxe` in slot 2, unpatched `CompactSnapshotCodec` hides the pickaxe (`HIGH-02b`).
  - Unpatched finish-to-start DAG edges (`HIGH-03c`) cannot express `"while one bot guards"` concurrently with collection.
- **Expected Correct System Behaviour (With Corrections Applied):**
  1. **Plan Decomposition (`TaskPlanV1`):** 3 distinct objectives:
     - `obj_cobble`: `kind: 'collect'`, `resourceId: 'minecraft:cobblestone'`, `quantity: 100`, `parallelism: 'partitionable'`.
     - `obj_coal`: `kind: 'collect'`, `resourceId: 'minecraft:coal'`, `quantity: 40`, `parallelism: 'partitionable'`.
     - `obj_guard`: `kind: 'guard'`, `regionLabel: 'base'`, `parallelism: 'role_based'`, `verification: 'role_duration'`, `dependencies: [{ localId: 'obj_cobble', edgeType: 'start_with' }, { localId: 'obj_coal', edgeType: 'start_with' }]`.
  2. **Role & Proximity Matching:**
     - `obj_guard` -> `bot-3` (`0m` travel to base, equipped with `iron_sword`, lacks pickaxe so ineligible for mining).
     - `obj_coal` -> `bot-2` (`0m` from coal cliff; pulling `bot-1` `160m` away fails the `>= 10%` marginal gain gate after travel).
     - `obj_cobble` -> `bot-1` (`5m` from stone pit, fast `iron_pickaxe`).
  3. **Lifecycle:** All 3 bots execute **simultaneously** on 3 separate `BotAssignmentV1` leases; when both `obj_cobble` (`100/100`) and `obj_coal` (`40/40`) reach `completed`, Master signals `obj_guard` completion verification (`patrolSeconds` verified inside base radius) -> Task `completed`.

---

## Scenario 4: A Bot Loses Its Tools Mid-Task

- **Initial State:**
  - Objective: `"Mine 60 cobblestone"`, assigned `30` to `bot-1` and `30` to `bot-2` (`allocationEpoch = 1`).
  - `bot-1` (`stone_pickaxe` had `18` durability left) mines `18` cobblestone (`baseline = 0 -> current = 18`), at which point its `stone_pickaxe` breaks (`durability -> 0`, item disappears from slot).
- **Expected Correct System Behaviour:**
  1. **Immediate Local Detection (Never Punch Stone by Hand):** Before digging block #19, `ActionExecutor` checks required harvest tool (`canHarvestBlock` + tool tier). Seeing `0` pickaxes in `bot-1`'s inventory, it **immediately aborts digging** (mining stone bare-handed takes `7.5s` and drops **0 items**!).
  2. **Tiered Recovery Decision:**
     - **Case 4A (Spare pickaxe already in `bot-1` inventory slot 0..35):** `ActionExecutor` equips the spare pickaxe (`T_setup` deterministic Level-1 action, `0` Master/AI round-trips) and finishes the remaining `12` blocks.
     - **Case 4B (No spare pickaxe on `bot-1`, `bot-2` still active with high durability):**
       1. `bot-1` emits `FailureReportV1` with `failureCode: 'TOOL_BROKEN_OR_MISSING'`, `retryable: false`, `safeState: 'idle_safe'`, and embedded `partialReport` (`before: 0, after: 18, claimedDelta: 18`).
       2. Inside one `StateStore.transaction`, `TaskManager` verifies and credits `+18` (`verifiedQuantity = 18`), marks `bot-1`'s assignment `failed` (`credited = 18`), releases the uncollected reservation `30 - 18 = 12` (`reservedQuantity: 60 -> 30`, `remainingQuantity = 12`), and updates `bot-1`'s `BotSnapshot` (`bestToolsByClass.pickaxe = null`).
       3. `TaskScheduler` runs for `remainingQuantity = 12`: `bot-1` is now rejected (`MISSING_TOOL`). Once `bot-2` finishes its `30` (`verified = 48`), `bot-2` receives a follow-up lease for the remaining `12` (`48 + 12 = 60` total).
     - **Case 4C (All bots lack pickaxes):** Objective transitions to `blocked` (`ALL_CANDIDATES_MISSING_TOOL`), triggering `ReasoningEngine.replan(ReplanRequestV1)` (`triggerReason: 'MISSING_PREREQUISITE_TOOL'`), which prepends deterministic prerequisite objectives (`collect oak_log -> craft planks/sticks -> craft pickaxe`) into `planVersion = 2` while preserving `verifiedQuantity = 18`!

---

## Scenario 5: A Worker Disconnects Mid-Task

- **Initial State:**
  - `WorkerHost-A` (`bot-1`, lease `L1`, `quota = 50`, `leaseTtlMs = 30,000`, `allocationEpoch = 1`) and `WorkerHost-B` (`bot-2`, lease `L2`, `quota = 50`, `allocationEpoch = 1`) are mining `100` cobblestone.
  - At `t = 10s`, `bot-1` reported progress `+20` (`verifiedQuantity = 20`).
  - At `t = 12s`, `WorkerHost-A`'s Wi-Fi drops (`bot-1` mines `7` more blocks locally between `t = 12s` and local lease stop, holding `27` total).
- **Expected Correct System Behaviour:**
  1. **Worker-Side Monotonic Lease Stop (`HIGH-05a` fix):** `WorkerHost-A`'s monotonic timer (`90% × 30,000 ms = 27s` since last heartbeat renewal at `t = 10s` -> `t = 37s`) fires `LEASE_EXPIRED_LOCALLY`. `BotController` (`bot-1`) **immediately halts digging/movement**, writes local checkpoint (`assignmentId: L1, epoch: 1, postStopCount: 27`), and waits in `safeState: 'idle_safe'`.
  2. **Master Liveness & Epoch Fencing:**
     - At `t = 17.5s` (`1.5 × 5s`), Master marks `WorkerHost-A` `degraded`.
     - At `t = 40s` (`expiresAt` + grace), `TaskManager.expireLeases()` runs atomically:
       - Increments `objectives.allocation_epoch` from `1 -> 2`.
       - Marks `L1` `expired` (`credited_quantity` stays `20`).
       - Releases uncredited `50 - 20 = 30` from `reserved_quantity` (`remainingQuantity = 30`).
     - Meanwhile `bot-2` (`WorkerHost-B`) finishes its `50` (`verifiedQuantity = 70`), and `TaskScheduler` issues a new `epoch = 2` lease `L3` (`quota = 30`) to `bot-2`.
  3. **Late Reconnect Fencing (Zero Double-Counting / Zero Over-Mining):**
     - Suppose `WorkerHost-A` reconnects at `t = 55s` and flushes its buffered `t = 37s` report (`epoch = 1`, `claimedDelta = +7`).
     - Master checks `event.allocationEpoch (1) < objective.allocationEpoch (2)` -> rejects `L1` credit with `STALE_ALLOCATION_EPOCH` (logging the `7` extra physical blocks in `bot-1`'s `held_stock` inventory snapshot without double-crediting the fenced lease), synchronizes `lastAckedWorkerSequence` (`HIGH-05b`), and sends `stop_and_fence`. Aggregate task finishes cleanly at `verifiedQuantity = 100`.

---

## Scenario 6: The AI Returns Invalid JSON

Test three realistic failure modes from remote Ollama (`POST /api/chat`):
- **Sub-Case 6A (Malformed / Truncated JSON):** Ollama returns `{"schemaVersion": 1, "intentSummary": "Mine...` (broken stream/OOM on Ollama host).
- **Sub-Case 6B (Schema Violation / Prompt Injection):** Ollama returns extra field `"execShell": "rm -rf /"`, `"workerCountHint": 50`, or a cyclic dependency `obj_a -> obj_b -> obj_a`.
- **Sub-Case 6C (Ambiguous Clarification Edge Case — `CRIT-01`):** User asks `"Help me prepare"`, Ollama returns `clarificationRequired: true, clarificationQuestion: "What would you like to prepare for (mining, building, or night survival)?", objectives: []`.

- **Expected Correct System Behaviour:**
  1. **Sub-Cases 6A & 6B:**
     - `JSON.parse` or `SchemaValidator.validatePlanSemantics` rejects the payload immediately (`AI_INVALID_RESPONSE`).
     - **Zero blind retries** on malformed/invalid model output (prevents burning inference queue and stalling the operator).
     - `ResourceMonitor.recordAiEvent('validationFailure')` increments telemetry; raw snippet (secrets redacted, truncated to `<= 512 chars`) is logged to `audit_events`.
     - `ReasoningEngine` falls back to `buildDeterministicPlan()`: if the user text matches a safe template, the task proceeds deterministically; otherwise the task transitions cleanly to `clarification_required` with a deterministic prompt asking the operator to restate the goal clearly. **Zero shell execution, zero process crash.**
  2. **Sub-Case 6C (Requires `CRIT-01` Fix):**
     - With `CRIT-01` patched, `clarificationRequired: true` + `objectives: []` **passes** validation cleanly (`Task.state -> 'clarification_required'`), surfacing `clarificationQuestion` on the Dashboard/CLI/Chat without failing schema validation!

---

## Scenario 7: Ollama Becomes Unavailable

- **Initial State:** User's LAN PC hosting Ollama is powered off or unreachable (`ECONNREFUSED` / `ETIMEDOUT` on `https://192.168.1.50:11434`). Operator submits:
  1. `"Collect 100 cobblestone and 40 coal"`
  2. `"Make that cool castle design we talked about"`
- **Expected Correct System Behaviour:**
  1. **Zero Paid Fallback (`£0` Invariant):** `OllamaClient` **never** falls back to OpenAI, Anthropic, Gemini, or any external API (`FORBIDDEN_PAID_DOMAINS` enforced).
  2. **Intent #1 (`"Collect 100 cobblestone and 40 coal"`):** `AiEfficiencyController` matches the deterministic multi-resource parser **before** touching the network (`0` ms spent waiting on the offline Ollama PC!), creates the 2-objective `TaskPlanV1`, schedules bots, and completes `100` cobblestone + `40` coal normally!
  3. **Intent #2 (Unstructured ambiguous intent):**
     - Misses deterministic fast-path -> `OllamaClient` fails fast on the `2,500 ms` TCP connection timeout (`MED-01` fix, rather than hanging `20s`).
     - `AiEfficiencyController` opens a `30s` circuit-breaker cooldown (so subsequent intents don't wait `2.5s` per request while the PC is off), marks AI status `degraded` on Dashboard, and transitions Intent #2 to `clarification_required` (`"Remote Ollama planner is currently unreachable; please issue a direct task such as 'collect <N> <item>', 'craft <N> <item>', 'explore <radius>', or 'guard <region>'."`).
     - Active running tasks on `WorkerHost`s experience **zero interruption**.

---

## Scenario 8: Two Bots Attempt to Collect the Same Resources

- **Initial State:**
  - Small exposed coal seam containing **only `5` coal_ore blocks** at `(50, 70, 50)..(52, 70, 51)`.
  - Operator requests `"Collect 20 coal"`. `bot-1` and `bot-2` are both `8` blocks away and assigned `10 + 10` (`target = 20`).
- **Audit Challenges Exposed (`HIGH-02`, `HIGH-07a`):**
  1. Without `BlockClaimRegistry`, both bots swing at `(50, 70, 50)` simultaneously.
  2. When `(50, 70, 50)` breaks, `bot-2` stands `1.2` blocks away and vacuums the coal item that `bot-1` mined.
  3. After all `5` coal blocks are mined (`verified = 5`), `15` coal remain uncollectable in the local chunk.
- **Expected Correct System Behaviour (With Corrections Applied):**
  1. **Disjoint Block Claims (`HIGH-07a` fix):** `bot-1` claims `(50, 70, 50)` (+ `4`-block preference buffer / hash-salted tie-break); `bot-2` selects `(52, 70, 51)` on the opposite end of the seam. Zero synchronized swings on the same coordinate.
  2. **Exact Conservation Under Item Pickup (`HIGH-02` fix):** Even if `bot-2` picks up `3` coal and `bot-1` picks up `2` coal (`3 + 2 = 5`), `InventoryLedger` credits `bot-2` with `+3` (from `before: 0 -> after: 3`) and `bot-1` with `+2` (`before: 0 -> after: 2`). Total `verifiedQuantity = 5` — **exact match to the 5 physical coal items in inventories (`0` double-counted, `0` lost)**.
  3. **Depletion Handling & Replan:** Both bots scan shells `8 -> 16 -> 32` via `BlockSearchCache`, find `0` remaining `minecraft:coal_ore`, and report `FailureReportV1` (`failureCode: 'RESOURCE_NOT_FOUND'`, with partial reports `+2` and `+3`). `CapabilityProfiler` logs the low yield (`MED-03`), `TaskManager` keeps `verifiedQuantity = 5` (`remainingQuantity = 15`), and `ReasoningEngine` triggers `ReplanRequestV1` (`triggerReason: 'RESOURCE_DEPLETED'`) -> proposes exploring an adjacent sector or asks operator clarification rather than spinning in infinite A* loops.

---

## Scenario 9: The Master Restarts During a Task

- **Initial State:**
  - Task `T1` (`"Mine 100 cobblestone"`): `verified_quantity = 40`, `reserved_quantity = 60` (`bot-1` lease `L1` quota `30`, `bot-2` lease `L2` quota `30`, `allocation_epoch = 1`).
  - Tasks `T2`, `T3` (`priority: 'low'`): arrived while phone was in `constrained` pressure state and were paused/deferred by `WorkloadGovernor`.
  - Android / operator abruptly kills and restarts the Termux Master Node process (`SIGKILL` -> cold start `8s` later).
- **Audit Challenge Exposed (`CRIT-03`, `HIGH-05`):**
  - Without `CRIT-03` fix, `T2` and `T3` in `WorkloadGovernor._pausedLowPriorityTasks` **vanish forever** on `SIGKILL`!
- **Expected Correct System Behaviour (With Corrections Applied):**
  1. **SQLite WAL Recovery (`StateStore.open`):** Replays `-wal` journal cleanly (`PRAGMA synchronous = NORMAL` + `foreign_keys = ON`), restoring `T1` (`40` verified, `L1` & `L2` active), **plus** `T2` and `T3` (`state = 'paused', pause_reason = 'WORKLOAD_GOVERNOR'`).
  2. **Pre-Ingress Reconciliation (`Coordinator.recover()`):**
     - Loads non-terminal tasks and re-hydrates `WorkloadGovernor`'s deferred queue from SQLite (`T2`, `T3` preserved!).
     - Places active leases `L1` and `L2` into startup reconciliation hold: **no quota is re-allocated** before existing `expiresAt` / worker snapshot check.
  3. **Seamless Worker Re-Attachment (`< 5s`):**
     - `WorkerHost-1` and `WorkerHost-2` reconnect via `/worker/v1/heartbeat` + `/worker/v1/snapshots` (`checkpointReason: 'startup_reconcile'`).
     - Because `L1` and `L2` have **not** expired (`t = +8s < 30s` TTL), Master responds `reconcileActions: [{ assignmentId: L1, directive: 'continue' }, { assignmentId: L2, directive: 'continue' }]` along with `lastAckedWorkerSequence`, renews both leases (`leaseTtlMs = 30000`), and emits `event: reload_required` to reconnecting browser Dashboard tabs.
     - If a worker failed to reconnect before `expiresAt + graceMs`, Master increments `allocation_epoch = 2`, fences the missing lease, and reallocates only the unverified remainder.
  4. **End Result:** `T1` finishes at **exact `100/100` verified cobblestone**, and `T2`/`T3` resume automatically in FIFO order once `WorkloadGovernor` confirms `normal` post-restart memory health.
