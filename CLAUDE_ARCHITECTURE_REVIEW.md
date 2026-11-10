# Independent Principal Architecture Review — Mineflayer AI Swarm

**Reviewer Role:** Independent Principal Software Architect  
**Scope:** Full adversarial audit of `MASTER_PROJECT_CONTEXT.md`, `AGENTS.md`, `docs/spec/*.md` (v1.1.0), `PERFORMANCE_REPORT.md`, and Stage-0 implementation (`src/monitoring/*`, `src/performance/*`, `src/events/*`, `benchmarks/*`)  
**Review Date:** 2026-11-10  
**Overall Verdict:** **CONDITIONAL PASS — DO NOT START STAGE 1 UNTIL 3 CRITICAL AND 7 HIGH DEFECTS ARE FIXED**

---

## Executive Summary

The **macro-architecture is sound and should be preserved**: splitting the system into a zero-Mineflayer coordinator on the Samsung Galaxy A06, remote Mineflayer `WorkerHost` processes on authorised machines, and an advisory-only self-hosted remote Ollama endpoint (`£0` inference cost) is the right topology for a 4 GB RAM Android phone. Do **not** rewrite the architecture from scratch.

However, challenging the specification against the already-merged Stage-0 codebase and real Mineflayer / Android 16 / distributed-systems mechanics reveals **19 concrete defects (`3 Critical`, `7 High`, `6 Medium`, `3 Low`)** that were masked by clean prose and simulated benchmarks:

1. **`CRIT-01` (Broken Schema Contract):** `docs/spec/AI_PROTOCOL.md` (`TaskPlanV1`) and the already-merged `src/performance/AiEfficiencyController.js` (`validateTaskPlanV1`) define **mutually incompatible schemas**. Even worse, when `clarificationRequired === true`, `AI_PROTOCOL.md` mandates `objectives.length === 0` while `AiEfficiencyController.js` mandates `objectives.length >= 1` — a mathematical impossibility (`0 >= 1`) that guarantees 100% failure on ambiguous prompts.
2. **`CRIT-02` (V8 OOM Before Governor Critical Threshold):** `PERFORMANCE_PLAN.md` mandates `NODE_OPTIONS="--max-old-space-size=256"`, yet `src/monitoring/WorkloadGovernor.js` defaults `criticalRssBytes` to **`300 MiB`** and completely ignores both `heapUsed / v8HeapLimit` and `/proc/meminfo` `MemAvailable`. On a 256 MiB V8 heap limit, Node aborts with a fatal OOM around `~255–275 MiB` RSS **before** the `300 MiB` critical governor state can ever trigger.
3. **`CRIT-03` (Volatile Task Deferral & Android `os.freemem()` Trap):** `WorkloadGovernor._pausedLowPriorityTasks` stores paused tasks in an **in-memory `Map`**, violating crash durability if Termux restarts under memory pressure. Simultaneously, `ResourceMonitor.readSystemMemory()` falls back to `os.freemem()` (`MemFree` without page cache), which on Android routinely reports `< 80 MiB` even on healthy devices and will lock the governor in permanent false-positive `critical` mode if wired directly to `MemAvailable` thresholds.

Every finding is audited across the 14 review areas below, catalogued in `CLAUDE_RISK_REGISTER.md`, given exact engineering patches in `CLAUDE_RECOMMENDATIONS.md`, and stress-tested in `CLAUDE_TEST_SCENARIOS.md`.

---

## Area-by-Area Technical Audit (1–14)

### 1. Is the architecture realistic for a Samsung Galaxy A06 with 4 GB RAM?
**Verdict: Realistic in topology; FLAWED in current governor/storage details (`CRIT-02`, `CRIT-03`, `HIGH-04`, `MED-05`).**

- **What holds up:** Banning `mineflayer` and `minecraft-data` (`499 MiB` unpacked, `+38–45 MiB` RSS) from the phone process is essential and empirically justified (`PERFORMANCE_REPORT.md` §3). Keeping phone RSS around `~62–85 MiB` leaves ample headroom inside a `256 MiB` V8 cap. Using built-in `node:sqlite` and concurrency-1 `node:crypto.scrypt` avoids compiling native C++ addons (`better-sqlite3`, `argon2`, `bcrypt`) that ship zero `android-arm64` Bionic prebuilds.
- **Where it fails under scrutiny:**
  1. **`WorkloadGovernor` threshold inversion (`CRIT-02`):** `WorkloadGovernor.js:54` sets `constrainedRssBytes = 220 MiB` and `criticalRssBytes = 300 MiB` (contradicting `PERFORMANCE_PLAN.md` §5.1's `180 MiB` / `230 MiB`), and `evaluate()` (`WorkloadGovernor.js:106-157`) **never reads `sample.systemMemory.availableBytes` or V8 heap ratio**. Under `--max-old-space-size=256`, V8 crashes before RSS hits `300 MiB`, and Android `lmkd` kills Termux based on system-wide `MemAvailable`, not Node's RSS alone.
  2. **Synchronous SQLite on eMMC 5.1 flash (`HIGH-04`):** `node:sqlite` (`DatabaseSync`) blocks the single Node.js event loop thread on every `COMMIT` and WAL auto-checkpoint. Benchmark numbers (`0.32 ms` p95) were recorded on fast container storage, **not** Samsung Galaxy A06 eMMC flash contended by Android 16 background I/O, where `fsync` spikes reach `50–250 ms`. `ARCHITECTURE.md` §4 omits `PRAGMA synchronous = NORMAL` and idle `wal_checkpoint(TRUNCATE)`.
  3. **Samsung OneUI background killing (`MED-05`):** `termux-wake-lock` only holds a CPU `PARTIAL_WAKE_LOCK`; without OneUI "Unrestricted battery" and Android 14–16 `Disable child process restrictions`, Android still freezes or throttles long-lived sockets.

---

### 2. Does the distributed worker design make sense?
**Verdict: Yes — clean control/execution split, marred by cross-document route drift (`HIGH-01`) and long-poll NAT fragility (`MED-02`).**

- **What holds up:** Having workers pull commands via HTTP long-polling (`GET /worker/v1/commands`) avoids opening inbound firewall ports on worker laptops/PCs and keeps Master as a single authoritative state machine. Sharing one `minecraft-data` singleton across up to 5 bots per `WorkerHost` saves `~90+ MiB` per host.
- **Where it fails under scrutiny:**
  1. **Cross-spec endpoint drift (`HIGH-01`):** `ARCHITECTURE.md` §2.2/§2.3 and `SECURITY_PLAN.md` §3 define **different URLs for the same endpoints** (`/worker/v1/commands/ack` vs `/worker/v1/ack`; `/api/v1/events` vs `/api/v1/stream`; `/api/v1/workers/bootstrap` vs `/api/v1/workers/bootstrap-tokens`), different command enums (`assignment.start` vs `assign`), and **conflicting `U-04..U-14` IDs** between `MASTER_SPEC.md` §10 and `ACCEPTANCE_CRITERIA.md` §3. Parallel coding agents following different docs will build incompatible routers.
  2. **Silent long-poll blackholes (`MED-02`):** A `25,000 ms` idle HTTP GET over Wi-Fi/VPN can silently blackhole across NAT tables, delaying emergency `safe_stop` commands by up to `25s` unless urgent stop directives are also piggybacked onto `5s` `/worker/v1/heartbeat` responses.

---

### 3. Can the system reliably coordinate multiple Mineflayer clients?
**Verdict: NO — three real-game Mineflayer failure modes are unaddressed (`HIGH-07`, `MED-04`).**

- **Where the spec is naive about Mineflayer:**
  1. **Synchronized pickaxe collision (`HIGH-07a`):** `BlockSearchCache` is deterministic (`8 -> 16 -> 32` shell scan). Two bots near `(100, 64, 100)` assigned quotas `50 + 50` cobblestone will target the **exact same block `(102, 64, 100)`**, body-block each other, waste mining swings, and race for the single item drop. There is no `BlockClaimRegistry` or minimum inter-bot target separation.
  2. **Destructive default pathfinding (`HIGH-07b`):** `mineflayer-pathfinder`'s default `Movements` enables `canDig = true` and `allow1by1towers = true`. Unless explicitly overridden per `actionType`, bots assigned to `explore`, `guard`, or `transfer` will **dig through player walls/shelters** to shorten an A* path, violating `protectedRegions` (`U-14`).
  3. **Intra-process event-loop starvation (`HIGH-07c`):** `mineflayer-pathfinder` runs synchronous JS A* ticks. Five bots in one `WorkerHost` running `thinkTimeout = 1500 ms` searches concurrently can stall the worker event loop for `>1–3 seconds`, causing missed `keep_alive` packets, physics rubber-banding, and server anti-cheat kicks.
  4. **3×3 Crafting Table blindness (`MED-04`):** `wooden_pickaxe` requires an in-world `minecraft:crafting_table` (`3×3` grid), whereas `planks` and `sticks` use the `2×2` inventory grid. Neither `BotCapabilities` nor `TaskPlanV1` tracks crafting-table availability or intermediate inventory slot pressure (`>= 2–3` free slots needed during multi-step recipes).

---

### 4. Does the task scheduler correctly handle shared objectives?
**Verdict: Quota invariant is strong, but `splitQuota` math and concurrent role DAGs are flawed (`HIGH-03`).**

- **What holds up:** Enforcing `verified_quantity + reserved_quantity <= target_quantity` both in `TaskManager` transactions and as a SQLite `CHECK` constraint (`ARCHITECTURE.md:299`) is first-rate defensive engineering. Largest-remainder integer rounding guarantees `sum(q_k) === remaining` without off-by-one over-collection.
- **Where it fails under scrutiny:**
  1. **Broken `60s` horizon constant in `splitQuota` (`HIGH-03a`):** `TASK_ALLOCATION.md` §6.1 weights bots by `w_k = r_p50 / (1 + T_travel / 60)`. For a large shared task (`Q_rem = 1,000` cobblestone, `~700s` horizon), a fast iron-pickaxe bot (`r = 1.0/s`) `60s` away gets weighted `1.0 / 2 = 0.5`, identical to a slow wooden-pickaxe bot (`r = 0.5/s`) `0s` away (`w = 0.5`). Both receive `500` quota: Bot 2 finishes in `560s` and sits idle for **`440 seconds`** while Bot 1 grinds until `1,000s`! Quota splitting must equalize total completion time (`T_travel_k + q_k / r_k = T*` via water-filling), not divide by an arbitrary `60s` constant.
  2. **DAG cannot express `"while"` concurrency (`HIGH-03c`):** `TASK_ALLOCATION.md` §1.4 only supports finish-to-start dependencies (`u` must be `completed` before `v` is `ready`). For Mandatory Example #5 (`"Build a shelter while one bot guards"`), an edge `build -> guard` guards *after* building; `guard -> build` builds *after* guarding; no edge allows `guard` (`role_duration`) to start with **no builder assigned yet** or run indefinitely after `build` finishes! The DAG requires a `co_execute` (`start_with` / `bound_to`) relationship.

---

### 5. Can it determine when using one bot is better than using multiple bots?
**Verdict: Mostly yes — strong 1-bot bias, with two edge-case blind spots (`HIGH-02b`, `HIGH-03b`).**

- **What holds up:** `parallelism === 'single'` and `Q_rem <= 1` hard-lock `"Craft a wooden pickaxe"` to `1` bot. Requiring `RelativeGain >= 0.10` (`>= 0.18` on cold-start priors) and `zScore >= 1.0` on `p90` makespan cleanly prevents fan-out on small or uncertain tasks.
- **Where it fails under scrutiny:**
  1. **Tool inventory blindness (`HIGH-02b`):** `CompactSnapshotCodec.js:90-99` inspects **only `rawBot.heldItem`**, ignoring tools in inventory slots `0..35`. A bot holding bread or torches while carrying a diamond pickaxe in slot 1 is misclassified as `MISSING_TOOL` (`TASK_ALLOCATION.md` §2 rule 8), causing the scheduler either to pick a worse bot or block the objective!
  2. **Greedy 1-step horizon (`HIGH-03b`):** Stopping immediately when `|S|=1 -> |S|=2` gives `< 10%` gain can miss cases where a fixed deposit/container setup penalty is amortized at `|S|=3`, though for `<20` bots a 1-step lookahead fixes this cheaply.

---

### 6. Does the allocation algorithm account for travel and coordination overhead?
**Verdict: Yes on `chooseParticipants` makespan; inconsistent with `splitQuota` (`HIGH-03a`, `MED-03`).**

- `TASK_ALLOCATION.md` §4 models `T_travel_p90` (horizontal + vertical penalty + unknown-region multiplier `1.60`), `T_setup` (tool equip + food), `T_coord(m)` (linear lease + quadratic pair term), `T_contention(S, j)` (`c_vein * max(0, m_same - W_faces)^2` + shared chest penalty), and `T_merge`.
- **Two flaws to fix:** (1) `splitQuota` uses `w_k` with the hardcoded `60s` factor instead of the makespan model from §4, feeding non-optimal trial quotas into `chooseParticipants` (`HIGH-03a`); (2) `CapabilityProfiler` only records completed runs (`MED-03`), creating survivorship bias when veins are depleted or obstructed.

---

### 7. Can collected items be verified without double-counting?
**Verdict: Partially — baseline deltas prevent naive cheating, but 4 real double-count/miscount vectors remain (`HIGH-02`).**

- **What holds up:** Keying `ledger_transactions` by `UNIQUE(evidence_id)`, clamping credit to `min(quota - credited, target - verified)`, and rejecting pre-existing `baselineCount` under `newly_collected` blocks basic false reporting.
- **Where it fails under scrutiny (`HIGH-02`):**
  1. **Nearby bot item-magnet cross-looting:** When Bot A breaks stone `1.5` blocks from Bot B, Minecraft's server-side pickup check can award the item entity to Bot B's inventory (`+1` for Bot B, `+0` for Bot A). Under pure inventory-delta accounting without spatial separation, Bot A keeps mining extra blocks beyond its broken count while Bot B hits quota early, or dropped overflow items from a full inventory get credited to a passerby bot as "newly collected"!
  2. **Half-completed `transferId` deadlock/loss:** `TASK_ALLOCATION.md` §8.4 assumes two-sided `transferId` deltas arrive atomically. In Minecraft, item handoffs happen via tossing items or chest deposit: if Bot A drops `-20` cobble and Bot B crashes (or lava/5-minute despawn destroys the entity), the `-20` leg hangs forever with no timeout/reconciliation rule.
  3. **Alphabetical 45-item truncation in `CompactSnapshotCodec` (`CompactSnapshotCodec.js:83`):** `sortedKeys.slice(0, maxDistinctItems)` drops lexically late items (`minecraft:wooden_pickaxe`, `minecraft:white_wool`) if a snapshot has `>45` distinct keys, corrupting `diff()` into seeing a fake `-N` or `+N` delta!
  4. **Mid-lease survival/recipe consumption:** If a bot mines `20` coal and crafts `4` torches (`-1` coal) to survive darkness during the same lease, naive `afterCount - baselineCount` credits only `19` unless authorized local consumption is tracked.

---

### 8. Does the AI reasoning layer have too much control?
**Verdict: No — the AI containment boundary is one of the strongest parts of the design.**

- Remote Ollama cannot call Mineflayer methods, execute code, spawn bots, override `safetyPolicy.allowPvp: false`, or dictate bot counts (`workerCountHint` is strictly advisory; `TaskScheduler` computes authoritative assignments). Prompt injection from public chat is blocked at worker ingress by `ChatHistoryGuard` (`O(1)` prefix + UUID allowlist drop).

---

### 9. Are Ollama requests efficient?
**Verdict: High token/call efficiency, but vulnerable to cold-load timeouts (`MED-01`) and schema-rejection loops (`CRIT-01`).**

- **Strengths:** `AiEfficiencyController` handles canonical structured intents (`mine`, `collect`, `craft`, `explore`, `guard`, `build ... while one bot guards`) in `< 1 ms` with **0 LLM calls** (`95%` call reduction in benchmarks), deduplicates identical in-flight prompts, caps concurrency at `1` active + `3` queued, caches normalized plans with TTL, and bounds context to `<= 8 KiB` without chunk/entity dumps.
- **Weaknesses:** (1) `CRIT-01` schema mismatch causes valid Ollama responses to fail validation; (2) `timeoutMs = 8000` (`MASTER_SPEC.md` §7) is too aggressive when a home £0 Ollama host reloads a `7B/8B` GGUF model from disk after 5 minutes idle (`6–20s` cold load, `MED-01`).

---

### 10. Are JSON responses validated?
**Verdict: Strict validation philosophy, BROKEN by a critical spec-vs-code contradiction (`CRIT-01`) and validator duplication (`MED-06`).**

- Both `AI_PROTOCOL.md` and `AiEfficiencyController.js` enforce `additionalProperties: false`, enum checks, UUID checks, and Kahn topological cycle detection.
- **Critical defect (`CRIT-01`):** `AI_PROTOCOL.md` §4 (`TaskPlanV1`) and `src/performance/AiEfficiencyController.js` (`TASK_PLAN_V1_SCHEMA` + `validateTaskPlanV1`) disagree on `schemaVersion` (`"1.0"` vs `1`), top-level keys (`constraints`+`assumptions` vs `notes`), objective shape (flat `objectiveId`/`resourceId`/`targetQuantity`/`verificationPolicy` vs nested `localId`/`target`/`constraints`/`verification`), enum values (`serial`, `operator_review`), and empty-objectives rules (`0` vs `>=1` on `clarificationRequired: true`). In addition, `CompactSnapshotCodec.js` outputs `dimension: "minecraft:overworld"` which fails `AI_PROTOCOL.md`'s `["overworld", "the_nether", "the_end", "unknown"]` enum (`HIGH-01`).

---

### 11. Can the system recover after worker or master failure?
**Verdict: Good epoch-fencing concept; BROKEN in 3 edge cases (`CRIT-03`, `HIGH-05a`, `HIGH-05b`).**

- **What holds up:** Incrementing `allocation_epoch` before releasing unverified reserved quota prevents split-brain double-execution.
- **Where it fails under scrutiny:**
  1. **Cross-host wall-clock skew (`HIGH-05a`):** `BotAssignmentV1` enforces lease expiry via absolute `expiresAt` ISO strings (`AI_PROTOCOL.md` §5). A `10–15s` NTP clock drift between the phone and a worker PC causes either premature local aborts or **post-fence zombie mining** while a replacement bot is already assigned! Workers must enforce relative `leaseDurationMs` (`ttlMs`) on a monotonic clock (`process.hrtime.bigint()`).
  2. **Post-crash `workerSequence` amnesia (`HIGH-05b`):** If a worker crashes after sending `workerSequence = 42` when its disk checkpoint was `39`, reconnecting and sending `40` violates Master's `strictly monotonic workerSequence` rule (`ARCHITECTURE.md` §2.2) unless `/worker/v1/snapshots` returns `lastAckedWorkerSequence` for worker counter resynchronization.
  3. **Master crash loses governor-deferred tasks (`CRIT-03`):** Tasks paused in `WorkloadGovernor._pausedLowPriorityTasks` live only in RAM unless persisted in SQLite `tasks(state = 'paused')`.

---

### 12. Are security boundaries sufficient?
**Verdict: Good RBAC/token baseline, with 3 actionable security holes (`HIGH-06`, `LOW-02`).**

- **Strengths:** SHA-256 hashed session/worker tokens (`timingSafeEqual`), concurrency-1 `scrypt` login mutex (`32 MiB` bounded), RBAC separation (`viewer` / `operator` / `admin` / `worker`), and worker-local Minecraft credential isolation.
- **Gaps (`HIGH-06`):**
  1. **Offline-mode chat spoofing (`HIGH-06a`):** On `private_offline_test` servers, player UUIDs derive deterministically from unauthenticated usernames (`OfflinePlayer:<name>`), allowing any LAN tester to join as an allowlisted name and inject `!swarm` commands unless chat commands are hard-disabled in offline mode.
  2. **Plaintext `csrf_secret` in SQLite DDL (`HIGH-06b`):** `ARCHITECTURE.md:245` stores plaintext `csrf_secret TEXT NOT NULL`, contradicting `SECURITY_PLAN.md` §2.2 (`csrf_token_hash`).
  3. **Missing `tls.caCertPath` & `/worker/v1/register` brute-force rate limit (`HIGH-06c`):** Private LAN TLS requires pinning a local CA certificate in `WorkerHost`, `CLI`, and `OllamaClient`, which is missing from `MASTER_SPEC.md` §7 `loadConfig`.
  4. **DOM XSS in vanilla dashboard (`LOW-02`):** Must mandate `textContent` (forbidding `innerHTML` for chat/task/bot strings) alongside CSP.

---

### 13. Are the suggested libraries and interfaces technically compatible?
**Verdict: Mostly compatible on Node 22.5+/24, with explicit caveats (`HIGH-01`, `MED-06`, `LOW-03`).**

- Built-in `node:sqlite`, `node:crypto`, `node:http`/`node:https`, and `node:test` work cleanly in CommonJS on Node `>=22.5.0` and Termux Node `24.17.0` without `node-gyp` Bionic build failures.
- **Caveats:** (1) `node:sqlite` emits `ExperimentalWarning` on stderr in Node 22 (`LOW-03`) and remains unverified on physical Galaxy A06 hardware (`U-03`); (2) `express@5.x` changed wildcard route syntax (`path-to-regexp@8`) and async error handling compared to Express 4 — coding agents trained on Express 4 idioms will write broken wildcard routes (`app.get('*', ...)` throws at startup in Express 5!) unless explicitly warned (`MED-06`); (3) `AI_PROTOCOL.md` vs `AiEfficiencyController.js` interface mismatch (`CRIT-01`) blocks immediate integration.

---

### 14. Are there unnecessary dependencies or processes?
**Verdict: Clean single-process phone footprint; keep `ajv` and Express bloat in check (`HIGH-04`, `MED-06`).**

- Running **1 Node.js process on the phone** (`0` local Mineflayer processes, `0` local Ollama processes, `0` external DB daemons, `2` `.unref()`'d timer buckets via `TimerRegistry`) is optimal for Android 16's phantom-process killer.
- **Avoid adding bloat in Stage 1:** Stage-0 currently has **zero** npm dependencies (`47.6 MiB` RSS). Adding `ajv@8` + `ajv-formats` + `express@5` adds `~24.5 MiB` RSS (`PERFORMANCE_REPORT.md` §3). Since `AiEfficiencyController` already implements fast zero-dependency deterministic schema + DAG validation, unify `SchemaValidator.js` around deterministic compiled JS validators (or a single startup-compiled validator) rather than maintaining two separate validation engines (`MED-06`), and add SQLite table-pruning jobs so `worker_inbound_messages` does not bloat Termux flash storage (`HIGH-04`).

---

## Consolidated Findings Matrix

| ID | Severity | Area | Summary | Specific Correction Provided In |
|---|---|---|---|---|
| `CRIT-01` | **Critical** | AI Schema / Code | `AI_PROTOCOL.md` (`TaskPlanV1`) and merged `AiEfficiencyController.js` reject each other's payloads and contradict on `clarificationRequired` | `CLAUDE_RECOMMENDATIONS.md` §1.1 |
| `CRIT-02` | **Critical** | Phone RAM / Governor | `WorkloadGovernor` default `criticalRssBytes = 300 MiB` exceeds `--max-old-space-size=256` OOM point and ignores V8 heap ratio & `/proc/meminfo` `MemAvailable` | `CLAUDE_RECOMMENDATIONS.md` §1.2 |
| `CRIT-03` | **Critical** | Durability / Android RAM | Deferred tasks in `WorkloadGovernor._pausedLowPriorityTasks` are volatile RAM-only; `os.freemem()` fallback misreads Android `MemFree` as `MemAvailable` | `CLAUDE_RECOMMENDATIONS.md` §1.3 |
| `HIGH-01` | **High** | Wire & Spec Drift | Conflicting REST paths, command enums, `dimension` namespace (`minecraft:overworld` vs `overworld`), and `U-04..U-14` IDs across specs/code | `CLAUDE_RECOMMENDATIONS.md` §2.1 |
| `HIGH-02` | **High** | Inventory Verification | `CompactSnapshotCodec` ignores non-held tools & truncates >45 sorted items; `InventoryLedger` vulnerable to magnet cross-looting & half-dead `transferId` | `CLAUDE_RECOMMENDATIONS.md` §2.2 |
| `HIGH-03` | **High** | Task Allocation & DAG | `splitQuota` fixed-`60s` travel denominator causes up to `44%` idle skew; finish-to-start DAG cannot run `"build while one bot guards"` concurrently | `CLAUDE_RECOMMENDATIONS.md` §2.3 |
| `HIGH-04` | **High** | SQLite / eMMC Storage | Synchronous `DatabaseSync` lacks `synchronous=NORMAL`/checkpoint tuning; `worker_inbound_messages` grows `>400k rows/day`; missing FK indexes on `ledger_transactions` | `CLAUDE_RECOMMENDATIONS.md` §2.4 |
| `HIGH-05` | **High** | Failure Recovery | Wall-clock `expiresAt` breaks under NTP skew; crashed worker `workerSequence` rollback deadlocks strict monotonic ingress | `CLAUDE_RECOMMENDATIONS.md` §2.5 |
| `HIGH-06` | **High** | Security Boundaries | Offline-mode UUID chat spoofing; plaintext `csrf_secret` in SQLite DDL; missing `tls.caCertPath` and `/worker/v1/register` rate limit | `CLAUDE_RECOMMENDATIONS.md` §2.6 |
| `HIGH-07` | **High** | Multi-Bot Mineflayer | Same-block mining collisions, `mineflayer-pathfinder` digging through walls (`canDig: true` default), and 5-bot A* event-loop starvation on `WorkerHost` | `CLAUDE_RECOMMENDATIONS.md` §2.7 |
| `MED-01` | **Medium** | Ollama Efficiency | `8,000 ms` flat timeout fails when self-hosted £0 Ollama cold-loads `7B/8B` weights from disk (`6–20s`) | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `MED-02` | **Medium** | Worker Transport | `25s` silent long-poll blackholes over mobile Wi-Fi NAT delay `safe_stop` unless piggybacked on `5s` heartbeats | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `MED-03` | **Medium** | Rate Profiling | Recording only successful completions biases `r_p50`/`r_p10` upward in depleted/blocked terrain | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `MED-04` | **Medium** | Crafting Execution | Missing `3×3` `crafting_table` requirement & free-slot check for multi-stage recipes (`wooden_pickaxe`) | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `MED-05` | **Medium** | Termux / OneUI Ops | Samsung OneUI battery optimization & Android 16 phantom process restrictions kill sockets despite `termux-wake-lock` | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `MED-06` | **Medium** | Dependencies / Express 5 | `express@5` wildcard route breaking change + duplicate validator overhead (`ajv` vs handwritten validator) | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `LOW-01` | **Low** | Scheduler DB Cost | Re-scanning raw `action_rate_samples` per candidate instead of cached/materialized quantile buckets | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `LOW-02` | **Low** | Dashboard Security | Potential DOM XSS if chat/intent text rendered with `innerHTML` instead of `textContent` | `CLAUDE_RECOMMENDATIONS.md` §3 |
| `LOW-03` | **Low** | CLI Cleanliness | Node 22 `ExperimentalWarning: SQLite` stderr output corrupts merged CLI JSON pipelines if unhandled | `CLAUDE_RECOMMENDATIONS.md` §3 |
