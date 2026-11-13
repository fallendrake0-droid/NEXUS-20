# Principal Architect Recommendations & Specific Corrections

**Document:** `CLAUDE_RECOMMENDATIONS.md`  
**Reviewer Role:** Independent Principal Software Architect  
**Principle:** Do **not** rewrite the sound 3-tier architecture. Apply the surgical, deterministic corrections below before Stage-1 coding agents begin parallel implementation, preserving £0 self-hosted Ollama inference, Node.js CommonJS, Express + vanilla JS dashboard, and evidence-driven task allocation.

---

## 1. Specific Corrections for All Critical Issues (`CRIT-01 .. CRIT-03`)

### 1.1 Correction for `CRIT-01` — Unify `TaskPlanV1` Across `AI_PROTOCOL.md`, `ARCHITECTURE.md` & `AiEfficiencyController.js`

**Problem:** `docs/spec/AI_PROTOCOL.md` §4 and `src/performance/AiEfficiencyController.js` define incompatible JSON schemas (`schemaVersion: "1.0"` vs `1`, flat vs nested objective fields, missing `'serial'` / `'operator_review'` enums, and contradictory `objectives` length rules when `clarificationRequired === true`).

**Specific Correction:**
1. **Standardize `schemaVersion` to integer `1`** across every wire envelope and AI schema (`ARCHITECTURE.md` §2.1 already uses integer `1`).
2. **Fix the `clarificationRequired` contradiction in `src/performance/AiEfficiencyController.js` (`TASK_PLAN_V1_SCHEMA` & `validateTaskPlanV1`):**
   - Change `TASK_PLAN_V1_SCHEMA.properties.objectives.minItems` from `1` to `0`.
   - In `validateTaskPlanV1(plan)`:
     ~~~js
     if (plan.clarificationRequired === true) {
       if (!Array.isArray(plan.objectives) || plan.objectives.length !== 0) {
         errors.push('objectives must be empty ([]) when clarificationRequired is true');
       }
       return { valid: errors.length === 0, errors };
     }
     if (!Array.isArray(plan.objectives) || plan.objectives.length < 1 || plan.objectives.length > 16) {
       errors.push('objectives must contain 1..16 items when clarificationRequired is false');
       return { valid: false, errors };
     }
     ~~~
3. **Adopt ONE canonical objective shape matching `ARCHITECTURE.md` §4 SQLite `objectives` DDL** in both `AI_PROTOCOL.md` §4 and `AiEfficiencyController.js`:
   - Top-level keys: `["schemaVersion", "requestId", "intentSummary", "clarificationRequired", "clarificationQuestion", "riskLevel", "objectives", "notes"]`.
   - Objective keys: `["localId", "kind", "target", "dependencies", "parallelism", "workerCountHint", "constraints", "verification"]`, where:
     - `parallelism` enum is `["single", "partitionable", "spatial", "role_based", "serial"]` (matching SQLite `CHECK`).
     - `verification` enum is `["newly_collected", "held_stock", "deposited_stock", "crafted_output", "block_state", "region_visited", "role_duration", "operator_review"]` (matching SQLite `CHECK`).
     - `dependencies` entries allow either `"obj_1"` (`string` shorthand for `finish_to_start`) or `{ "localId": "obj_1", "edgeType": "finish_to_start" | "start_with" }` (see §2.3 below).

---

### 1.2 Correction for `CRIT-02` — Align `WorkloadGovernor` Thresholds Below the `256 MiB` V8 Heap Limit & Wire OS `MemAvailable`

**Problem:** Under `NODE_OPTIONS="--max-old-space-size=256"`, V8 aborts with fatal heap OOM at `~255–275 MiB` total process RSS, before `WorkloadGovernor.js`'s `300 MiB` `criticalRssBytes` threshold ever fires. Furthermore, `WorkloadGovernor.evaluate(sample)` ignores both `heapUsed / v8HeapLimit` and `/proc/meminfo` `MemAvailable`.

**Specific Correction (`src/monitoring/WorkloadGovernor.js` & `ResourceMonitor.js`):**
1. **Recalibrate default Master RSS thresholds strictly inside the `256 MiB` V8 ceiling:**
   - `constrainedRssBytes`: **`175 * 1024 * 1024`** (`175 MiB`), `recoverFromConstrainedRssBytes`: **`150 * 1024 * 1024`** (`150 MiB`).
   - `criticalRssBytes`: **`215 * 1024 * 1024`** (`215 MiB`), `recoverFromCriticalRssBytes`: **`185 * 1024 * 1024`** (`185 MiB`).
2. **Add V8 Heap Ratio & `/proc/meminfo` `MemAvailable` checks directly inside `WorkloadGovernor.evaluate(sample)`:**
   ~~~js
   const heapUsed = sample?.memory?.heapUsedBytes ?? 0;
   const heapLimit = sample?.memory?.v8HeapLimitBytes ?? (256 * 1024 * 1024);
   const heapRatio = heapLimit > 0 ? heapUsed / heapLimit : 0;

   // Only trust OS MemAvailable when read from /proc/meminfo (NEVER node:os MemFree!)
   const sysMem = sample?.systemMemory;
   const osAvailBytes =
     sysMem && sysMem.source === '/proc/meminfo' && typeof sysMem.availableBytes === 'number'
       ? sysMem.availableBytes
       : null;

   if (heapRatio >= 0.85) {
     desiredRank = STATE_RANK.critical;
     reasons.push(`heapRatio(${heapRatio.toFixed(2)}) >= 0.85`);
   } else if (heapRatio >= 0.70) {
     desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
     reasons.push(`heapRatio(${heapRatio.toFixed(2)}) >= 0.70`);
   }

   if (osAvailBytes !== null && osAvailBytes <= th.criticalOsAvailableBytes /* 350 MiB */) {
     desiredRank = STATE_RANK.critical;
     reasons.push(`osMemAvailable(${osAvailBytes}) <= critical(${th.criticalOsAvailableBytes})`);
   } else if (osAvailBytes !== null && osAvailBytes <= th.constrainedOsAvailableBytes /* 550 MiB */) {
     desiredRank = Math.max(desiredRank, STATE_RANK.constrained);
     reasons.push(`osMemAvailable(${osAvailBytes}) <= constrained(${th.constrainedOsAvailableBytes})`);
   }
   ~~~

---

### 1.3 Correction for `CRIT-03` — Persist Deferred Tasks in SQLite & Isolate `os.freemem()` Fallback

**Problem:** `WorkloadGovernor._pausedLowPriorityTasks` stores paused low-priority tasks only in a volatile `Map`, losing them if Termux restarts during an OOM event; `ResourceMonitor.readSystemMemory()` equates `os.freemem()` (`MemFree`) with `MemAvailable`.

**Specific Correction:**
1. **Durable Deferral in `Coordinator.submitIntent`:**
   - Always insert every accepted `IntentRequest` into SQLite `tasks` **first**: if `WorkloadGovernor.classifyWork(...)` returns `pause_and_defer`, commit the task row in `state = 'paused'` with `pause_reason = 'WORKLOAD_GOVERNOR'` inside `StateStore.transaction(...)`, and pass only `{ taskId, priority, createdAt }` to `WorkloadGovernor`.
   - On Master restart, `Coordinator.recover()` queries `SELECT task_id, priority, created_at FROM tasks WHERE state = 'paused' AND pause_reason = 'WORKLOAD_GOVERNOR' ORDER BY created_at ASC` to repopulate the resume queue with zero task loss.
2. **Tag `node:os` memory fallback accurately in `ResourceMonitor.js`:**
   - Rename fallback field from `availableBytes: free` to `availableBytes: 'unavailable', rawFreeBytes: free, source: 'node:os_memfree'` so no caller mistakes raw Android `MemFree` (`< 80 MiB`) for reclaimable `MemAvailable`.

---

## 2. Specific Corrections for All High Issues (`HIGH-01 .. HIGH-07`)

### 2.1 Correction for `HIGH-01` — Canonical Route, Enum, Dimension & Open-Decision Alignment

Update `SECURITY_PLAN.md`, `AI_PROTOCOL.md`, `MASTER_SPEC.md`, and `CompactSnapshotCodec.js` to match this single source of truth:

| Item | Canonical Value (Use Everywhere) | Deprecated / Remove |
|---|---|---|
| SSE stream route | `GET /api/v1/events` | `/api/v1/stream` |
| Worker command ack route | `POST /worker/v1/commands/ack` | `/worker/v1/ack` |
| Worker bootstrap token route | `POST /api/v1/workers/bootstrap` | `/api/v1/workers/bootstrap-tokens` |
| Dashboard status routes | `GET /api/v1/snapshot` & `GET /api/v1/diagnostics` | `/api/v1/status`, `/api/v1/health` (keep `/api/v1/healthz` unauth liveness only if needed) |
| `CommandEnvelopeV1.commandType` | `'assign' \| 'cancel' \| 'pause' \| 'resume' \| 'safe_stop' \| 'request_snapshot' \| 'fence_epoch'` | `'assignment.start'`, `'assignment.pause'` |
| `dimension` string | `'minecraft:overworld' \| 'minecraft:the_nether' \| 'minecraft:the_end' \| 'unknown'` | Bare `'overworld'` without namespace |
| Open Decisions `U-01..U-14` | Use the table in `ACCEPTANCE_CRITERIA.md` §3 verbatim and replace `MASTER_SPEC.md` §10 with a direct reference + identical ID mapping | Divergent `U-04..U-14` summary in `MASTER_SPEC.md` §10 |

---

### 2.2 Correction for `HIGH-02` — Harden `CompactSnapshotCodec` & `InventoryLedger` Attribution

1. **Extract full `toolInventory` and pinned target keys in `src/performance/CompactSnapshotCodec.js`:**
   - Scan all inventory slots (`0..45`, including off-hand slot `45`) to populate `bestToolsByClass: Record<'pickaxe'|'axe'|'shovel'|'sword'|'hoe'|'shears', { itemKey, tierRank, remainingDurability }>` and `hasCraftingTable: boolean` (`itemCounts['minecraft:crafting_table'] > 0`).
   - Pass `options.pinnedItemKeys` (all active objective `resourceId`s + recipe inputs) into `toCompactBotSnapshot`: pinned keys are **always** included in `itemCounts` before applying the `maxDistinctItems` cap to miscellaneous clutter, eliminating alphabetical truncation bugs!
2. **Prevent nearby-bot magnet cross-looting & orphaned `transferId`s in `InventoryLedger`:**
   - **Spatial separation (`>= 4` blocks):** Bots mining partitionable quotas maintain `>= 4` blocks horizontal separation (§2.7) outside Minecraft's `~1.5`-block item pickup radius.
   - **Swarm-level cap:** Even if Bot B walks past Bot A and picks up `+2` cobblestone, `InventoryLedger` clamps Bot B's credit to `min(b.quota - b.credited, objective.target - objective.verified)`; Bot A's `ActionExecutor` checks live `credited + localInventoryDelta` and halts as soon as its inventory holds its remaining quota.
   - **Bounded two-phase `transferId`:** Add `transfers(transfer_id PRIMARY KEY, objective_id, sender_bot_id, receiver_bot_id, item_key, sent_qty, received_qty, state CHECK (state IN ('in_flight','completed','timed_out_disputed')), expires_at)` to SQLite. If `received_qty < sent_qty` after `60s`, transition to `timed_out_disputed`, deduct `(sent_qty - received_qty)` from `held_stock`, and release the lost quantity back into `remainingQuantity` so a replacement bot can re-collect what burned/despawned!

---

### 2.3 Correction for `HIGH-03` — Makespan-Equalizing Water-Filling `splitQuota` & Concurrent `start_with` DAG Edges

1. **Replace `w_k = r_p50 / (1 + T_travel / 60)` (`TASK_ALLOCATION.md` §6.1) with exact Water-Filling Makespan Equalization:**
   Given remaining integer target `Q_rem > 0` and selected bots `b_k in S` (`k = 1..m`) with fixed startup delay `F_k = T_travel_p50(b_k) + T_setup(b_k)` and steady-state rate `r_k = r_p50(b_k) > 0`:
   ~~~text
   Goal: Find common finish horizon T* > min_k(F_k) such that:
         sum_{k=1..m} r_k * max(0, T* - F_k) = Q_rem

   Exact O(m log m) closed-form water-filling algorithm:
   1. Sort bots ascending by F_k: F_1 <= F_2 <= ... <= F_m.
   2. Find largest active prefix p (1 <= p <= m) where bots 1..p finish AFTER F_p:
      T* = (Q_rem + sum_{k=1..p} (r_k * F_k)) / (sum_{k=1..p} r_k)
      such that T* > F_p and (p == m OR T* <= F_{p+1}).
      (Any bot k > p has F_k >= T*, meaning the task finishes before bot k could even arrive -> drop bot k from S!)
   3. Continuous shares for k = 1..p:
      exact_k = r_k * (T* - F_k)
   4. Apply largest-remainder integer rounding on exact_1..exact_p with q_k >= 1 and sum(q_k) === Q_rem.
   ~~~
   *Why this is strictly superior:* It eliminates the arbitrary `60s` magic constant, automatically drops bots whose travel time `F_k >= T*` exceeds the swarm's finish time, and equalizes completion times across asymmetric tools and distances!
2. **Add 1-Step Lookahead (`k + 2`) in `chooseParticipants`:** When `|S| -> |S|+1` fails `minRelativeGain` solely due to a one-time setup jump (`c_chest`), test best pair `|S|+2` if `|S|+2 <= maxAllowed` before terminating expansion.
3. **Support Concurrent Co-Execution (`"Build a shelter while one bot guards"`) in Objective DAGs:**
   - Add column `edge_type TEXT NOT NULL DEFAULT 'finish_to_start' CHECK (edge_type IN ('finish_to_start', 'start_with'))` to `objective_dependencies`.
   - Semantics of `(guard_obj) --[start_with]--> (build_obj)`:
     - `guard_obj` becomes `ready` simultaneously with `build_obj` **only if** at least `2` distinct eligible bots exist (`1` for `build_obj`, `1` for `guard_obj`); if only `1` bot is online, `TaskScheduler` runs `inspect/clear perimeter -> build` sequentially or blocks if strict concurrent guard was mandated.
     - `guard_obj` (`verification: 'role_duration'`) automatically completes as soon as `build_obj` transitions to `completed` (provided the guard bot maintained continuous healthy presence inside `protectedRadiusBlocks` during `build_obj`'s active window).

---

### 2.4 Correction for `HIGH-04` — SQLite eMMC Flash Tuning, FK Indexes & Bounded Table Pruning

Add to `StateStore.open()` and `ARCHITECTURE.md` §4 DDL:
~~~sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;          -- Safe in WAL mode; eliminates double fsync stalls on Galaxy A06 eMMC!
PRAGMA busy_timeout = 3000;
PRAGMA wal_autocheckpoint = 500;      -- Smaller incremental checkpoints (~2 MiB) instead of 4 MiB spikes
PRAGMA journal_size_limit = 8388608;  -- Cap -wal file on disk to 8 MiB after checkpoint
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -4096;            -- Hard-cap SQLite page cache inside Node process to 4 MiB!

-- Missing Foreign Key & Pruning Indexes:
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger_transactions(task_id);
CREATE INDEX IF NOT EXISTS idx_ledger_objective ON ledger_transactions(objective_id);
CREATE INDEX IF NOT EXISTS idx_ledger_assignment ON ledger_transactions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_inbound_received ON worker_inbound_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at);
~~~
- **Periodic Maintenance Job (every `10 minutes` on shared `TimerRegistry` when idle):**
  1. `DELETE FROM worker_inbound_messages WHERE received_at < datetime('now', '-24 hours')` (safe because `workers.last_event_seq` watermark rejects older sequences in `O(1)`!).
  2. `DELETE FROM command_outbox WHERE acked_at IS NOT NULL AND acked_at < datetime('now', '-1 hour')`.
  3. Keep only the latest `50` rows per `(server_id, dimension, action_key, tool_class)` in `action_rate_samples`.
  4. Run `PRAGMA wal_checkpoint(PASSIVE)` (or `TRUNCATE` when zero active assignments).

---

### 2.5 Correction for `HIGH-05` — Monotonic Relative Lease `leaseTtlMs` & Post-Crash Sequence Handshake

1. **Eliminate cross-host NTP clock skew:**
   - Add required field `"leaseTtlMs": integer (5000..120000)` to `BotAssignmentV1` and `/worker/v1/heartbeat` renewal responses (`renewedLeases: [{ leaseId, leaseTtlMs }]`).
   - On `WorkerHost`, compute local monotonic deadline on receipt:
     `deadlineNs = process.hrtime.bigint() + BigInt(Math.floor(leaseTtlMs * 0.90)) * 1_000_000n`
     (`10%` safety margin guarantees the worker stops digging **before** Master's wall-clock `expiresAt` can fence and reassign the quota, regardless of NTP clock offset!).
2. **Eliminate post-crash `workerSequence` rollback deadlocks:**
   - Include `lastAckedWorkerSequence: integer` in the response of `POST /worker/v1/snapshots` (`checkpointReason: 'startup_reconcile'`) and `POST /worker/v1/heartbeat`.
   - On startup/reconnect, `WorkerHost` sets `this._nextWorkerSequence = Math.max(localCheckpointSeq, masterAckedSeq) + 1` before flushing queued events.

---

### 2.6 Correction for `HIGH-06` — Close Offline-Chat Spoofing, CSRF Hash & Private-CA Config Gaps

1. **Offline-mode chat lock (`ChatCommandAdapter` & `loadConfig`):** If `serverProfile.authMode === 'private_offline_test'`, reject in-game `!swarm` chat commands by default (`CHAT_DISABLED_IN_OFFLINE_MODE`) unless `chat.allowInsecureOfflineChat === true` is explicitly enabled on `127.0.0.1` private dev harnesses.
2. **Hash CSRF secret in SQLite:** Rename `sessions.csrf_secret` in `ARCHITECTURE.md` §4 to `csrf_token_hash TEXT NOT NULL` (storing `SHA-256` hex, compared via `crypto.timingSafeEqual`).
3. **Add `tls.caCertPath`, `tls.certPath`, `tls.keyPath` to `loadConfig` (`MASTER_SPEC.md` §7)** so `WorkerHost`, `CLI`, and `OllamaClient` verify private LAN CA certificates without ever setting `NODE_TLS_REJECT_UNAUTHORIZED=0`.
4. **Rate-limit `/worker/v1/register`:** Apply the same bounded sliding-window limiter (`5` failed attempts / `15 minutes` per source IP -> `429 RATE_LIMITED`) used on `/api/v1/auth/login`.

---

### 2.7 Correction for `HIGH-07` — Multi-Bot `BlockClaimRegistry`, Safe `Movements` & A* Time-Slicing

1. **`BlockClaimRegistry` on `WorkerHost` (+ Partition Seed from Master):**
   - Each `WorkerHost` maintains a bounded `BoundedCache` (`maxEntries: 256`, `ttlMs: 15_000`) mapping `"dim:x:y:z" -> botId`.
   - When `BlockSearchCache` returns candidate blocks for `botId`, filter out any coordinate claimed by another bot **or within Chebyshev distance `< 4` blocks** of another friendly bot's claimed block or live position; break ties using `(distance * 4) + ((hash(botId, x, y, z) % 7))` so bots across **different** `WorkerHost` processes also fan out across a vein instead of colliding on block #0!
2. **Action-Scoped `mineflayer-pathfinder` `Movements` Policy:**
   - For `explore`, `guard`, `transfer`, `inspect`, `craft`, `safe_stop`: set `movements.canDig = false` and `movements.allow1by1towers = false`.
   - For `mine`, `collect`, `build`: set `movements.allow1by1towers = false` (unless vertical scaffold sub-step explicitly active) and push a `movements.exclusionAreasBreak` callback rejecting every coordinate inside `serverProfile.protectedRegions` (`U-14`).
3. **Host-Wide `WorkerPathfindingScheduler`:**
   - Cap Mineflayer per-tick A* budget (`bot.pathfinder.thinkTimeout = 1500` total deadline, **`tickTimeout = 15` ms per 50ms physics tick** — supported natively by `mineflayer-pathfinder`!) and allow **at most `2` bots per `WorkerHost`** to be actively computing A* simultaneously, queuing the 3rd–5th bots for `< 100 ms`. This keeps worst-case event-loop stall `< 30 ms` (`20 TPS` physics and `keep_alive` packets never miss a beat).

---

## 3. Concise Corrections for Medium & Low Issues (`MED-01 .. LOW-03`)

- **`MED-01` (Ollama Cold-Load Timeout):** Use a `2,500 ms` TCP/TLS socket connection timeout so unreachable hosts fail fast, paired with a `20,000 ms` response timeout on the first call after `>4 minutes` idle (`8,000 ms` when warm) and `"keep_alive": "15m"` in `/api/chat` body.
- **`MED-02` (Long-Poll Safety Piggyback):** Reduce `GET /worker/v1/commands` `wait_ms` max from `25,000` to `15,000 ms` and add `urgentStopBotIds: string[]` + `revokedLeaseIds: string[]` to `POST /worker/v1/heartbeat` responses (`<= 5s` worst-case stop latency).
- **`MED-03` (Unbiased Rate Samples):** Record `ActionSample` on `completed`, `partial`, **and** `RESOURCE_NOT_FOUND` outcomes (`unitsCompleted / Math.max(1, durationSec)`).
- **`MED-04` (Crafting Table & Free Slots):** Require `freeSlotEstimate >= 2` and `(recipeGrid === '2x2' || nearbyCraftingTable || hasCraftingTable || inventory.oak_planks >= 4 || inventory.oak_log >= 1)` for `craft` eligibility; `ActionExecutor.craft` automatically places & reclaims a portable crafting table when needed.
- **`MED-05` (Galaxy A06 OneUI Preflight):** Add a Termux operational preflight check in `check:termux` warning operators to set OneUI Battery = **Unrestricted** and Android Developer Options -> **Disable child process restrictions**.
- **`MED-06` (Zero-Bloat Validation & Express 5):** Reuse deterministic compiled validators in `src/protocol/SchemaValidator.js` (avoiding `ajv` `+18 MiB` heap/codegen overhead on the phone) and add an integration test for Express 5 route patterns.
- **`LOW-01` / `LOW-02` / `LOW-03`:** Cache `RateEstimate` in `BoundedCache(128)`; enforce `textContent`-only DOM rendering in `src/dashboard/` with ESLint/regex test banning `.innerHTML =`; keep `src/cli/` free of `node:sqlite` imports so `--json` stdout stays pure JSON.
