# Mineflayer AI Swarm — Development Status & Specialist Task Packages

**Last Updated:** 2026-11-10  
**Current Stage:** NEXUS-20 v0.4.0 — Master Control Plane + Distributed WorkerHost Tier + Unified CLI + Control Centre Complete (`54/54` tests passing, `3/3` leak suites passing)  
**Integration Owner:** Lead Software Engineer & Repository Integration Owner

---

## 1. Architecture Review Reconciliation Summary (`CLAUDE_*.md`)

Before writing Stage-1 domain code, all Critical and High findings from `CLAUDE_ARCHITECTURE_REVIEW.md`, `CLAUDE_RISK_REGISTER.md`, and `CLAUDE_RECOMMENDATIONS.md` were critically evaluated and reconciled across both `docs/spec/*.md` and `src/`:

| Finding | Issue Summary | Resolution Implemented & Tested |
|---|---|---|
| `CRIT-01` | `AI_PROTOCOL.md` vs `AiEfficiencyController.js` `TaskPlanV1` contract mismatch & broken `clarificationRequired: true` validation (`objectives: []` rejected) | Unified on integer `schemaVersion: 1`, `objectives: []` required iff `clarificationRequired === true`, aligned objective enums with SQLite `CHECK` constraints |
| `CRIT-02` | `WorkloadGovernor` `300 MiB` RSS critical threshold unreachable before `256 MiB` V8 heap OOM abort; `heapRatio` & `/proc/meminfo` ignored | Lowered Master defaults to `175 MiB` (`constrained`) / `215 MiB` (`critical`), wired `heapRatio >= 0.70 / 0.85` and `/proc/meminfo` `MemAvailable <= 550 / 350 MiB` |
| `CRIT-03` | `WorkloadGovernor._pausedLowPriorityTasks` volatile in-RAM `Map` lost tasks on restart; `os.freemem()` conflated Android `MemFree` with `MemAvailable` | Persisted deferred tasks in SQLite `tasks(state='paused', pause_reason='WORKLOAD_GOVERNOR')` with `Coordinator.recover()` rehydration; gated OS memory check on `source === '/proc/meminfo'` |
| `HIGH-01` | Divergent REST routes, `dimension` strings (`overworld` vs `minecraft:overworld`), and `U-04..U-14` acceptance IDs across spec docs | Synchronized `MASTER_SPEC.md`, `SECURITY_PLAN.md`, `ARCHITECTURE.md`, and normalized dimensions via `CompactSnapshotCodec.normalizeDimension()` |
| `HIGH-02` | `CompactSnapshotCodec` missed tools in non-held slots and truncated late-alphabet objective items; orphaned two-bot item transfers | Added `bestToolsByClass`, `hasCraftingTable`, `freeSlots`, `options.pinnedItemKeys`, and `InventoryLedger.expireStaleTransfers()` |
| `HIGH-03` | `splitQuota` `60s` travel heuristic skewed large quotas; `finish_to_start`-only DAG prevented concurrent `"Build while one bot guards"` | Implemented exact makespan-equalizing water-filling `splitQuota` (`src/scheduler/quotaMath.js`) and `start_with` companion DAG edges in `TaskManager` |
| `HIGH-04` | Missing SQLite eMMC wear-protection pragmas, ledger FK indexes, and sliding-window table pruning | Added `synchronous=NORMAL`, `wal_autocheckpoint=500`, `journal_size_limit=8388608`, `cache_size=-4096`, FK indexes, and `StateStore.pruneMaintenance()` |
| `HIGH-05` | Cross-host wall-clock skew on `expiresAt` and worker sequence rollback after crash | Added relative `leaseTtlMs` (`3000..120000 ms`) to `BotAssignmentV1` & SQLite `assignments`, plus `lastAckedWorkerSequence` in `BotRegistry.heartbeat()` |
| `HIGH-06` | Spoofable `!swarm` chat in `private_offline_test`, plaintext CSRF column, missing `tls.caCertPath` | Enforced `CHAT_DISABLED_IN_OFFLINE_MODE` in `loadConfig`, renamed `sessions.csrf_token_hash`, added `tls.caCertPath` |

---

## 2. Foundation Module Completion & Verification Matrix

All core foundation modules are implemented in CommonJS (`'use strict'`), zero external dependencies, and verified passing:

| Module | File Path | Status | Verification Coverage |
|---|---|---|---|
| Entrypoint & CLI probes | `index.js`, `src/master/createMaster.js` | **Complete** | `G-01` zero-Mineflayer gate, `--check-config`, `--health`, graceful shutdown |
| Configuration & Env Template | `src/config/loadConfig.js`, `.env.example` | **Complete** | `<=20` cap, TLS rules, £0 remote-only AI, FUSE DB block, offline chat lock |
| Shared Error Handling | `src/errors/DomainError.js` | **Complete** | Canonical error codes, HTTP status mapping, stack/path sanitization |
| Structured Logging | `src/logging/createLogger.js` | **Complete** | Child context propagation, credential scrubbing, `5 MiB x 3` rotation |
| Protocol Validation | `src/protocol/SchemaValidator.js` | **Complete** | `TaskPlanV1`, `BotAssignmentV1`, completion/failure reports, command/event envelopes |
| SQLite WAL State Manager | `src/persistence/StateStore.js` | **Complete** | 15 tables, `CHECK` invariants, nested `SAVEPOINT` tx, verified online backup, pruning |
| Authoritative Ledger | `src/inventory/InventoryLedger.js` | **Complete** | Baseline delta, craft input verification, clamped credit, transfer expiry |
| Worker & Bot Registry | `src/workers/BotRegistry.js`, `WorkerRegistry.js` | **Complete** | Single-use SHA-256 bootstrap tokens, `timingSafeEqual` auth, `<=20` cap, liveness, revoke |
| Quota & TaskScheduler | `src/scheduler/quotaMath.js`, `TaskScheduler.js` | **Complete** | Water-filling `splitQuota`, `TaskScheduler` (`p50`/`p90`, 1-step craft lookahead, empirical rates, priority preemption) |
| Task & Lease State Machine | `src/tasks/TaskManager.js` | **Complete** | `finish_to_start` + `start_with` DAG, outbox commands, seq dedup, epoch fencing, incremental baseline & cancel safety |
| Central Coordinator | `src/coordinator/Coordinator.js` | **Complete** | NEXUS-20 full swarm world-state (`buildSwarmWorldContext`), runtime `SYNCHRONIZED`/`DISTRIBUTED`/`HYBRID` modes, RBAC, idempotency, durable governor deferral/recovery |
| Runtime Monitoring & AI | `src/monitoring/*`, `src/performance/*`, `src/events/*` | **Complete** | `ResourceMonitor`, 5-profile `WorkloadGovernor`, pluggable-provider `AiEfficiencyController`, `SseCoalescer` |
| Shared World Knowledge | `src/knowledge/WorldKnowledgeStore.js` | **Complete** | 10 categories, TTL expiry, multi-bot confidence verification, bounded row cap, chest mutex locks |
| Operator Auth & Security | `src/security/AuthService.js` | **Complete** | Concurrency-1 `scrypt` queue (`<=16 MiB` flood RSS), `HttpOnly` sessions, CSRF hash check, RBAC, rate limiter |
| HTTP/SSE Gateway & Dashboard | `src/interfaces/http/MasterHttpServer.js`, `src/dashboard/public/*` | **Complete** | Zero-dep `/api/v1/*` + `/worker/v1/*` + SSE stream + Vanilla HTML/CSS/JS NEXUS-20 Control Centre |
| Distributed WorkerHost Runtime | `src/worker/{MasterClient,SkillExecutor,BotRunner,WorkerHost}.js` | **Complete** | Live TCP enrollment/reconcile, staggered spawn, monotonic lease self-fencing, non-`eval` skills, priority-0 survival reflex, `!swarm` chat relay |

### Verified Test & Benchmark Results (2026-11-10 — v0.4.0)
- `npm test`: **54 / 54 passing** (`0` failures, `0` skipped) across `tests/foundation/*.test.js` (including `nexus20-core-and-http.test.js` and `worker-and-cli-e2e.test.js`), `tests/adversarial/*.test.js` (`REG-01..08`, `BUG-F01..F17`, `ADV-01..04` 200-step randomized fuzz), and `tests/performance/*.test.js`.
- `npm run test:leaks`: **3 / 3 passing** under `--expose-gc` (`0` retained world buffers, SSE client buffers, or native timers).
- `npm run check:termux`: **Passing** (`node:sqlite` v3.51.3 WAL + online backup verified, `/proc/meminfo` & `crypto.scrypt` verified).
- `npm run bench`: **Passing** (`20_bots_distributed` Master Peak RSS `62.71 MiB`, Post-GC Heap `6.36 MiB`, Loop p95 `27.85 ms`, `0` tasks discarded).

---

## 3. Isolated Specialist Task Packages (Stage-2 Expansion)

Each specialist agent is assigned an **isolated branch** and a **strictly disjoint file manifest** to prevent merge conflicts and duplicate implementations. All specialists MUST follow `CONTRIBUTING.md` and `docs/spec/MODULE_INTERFACES.md`.

---

### Package 1 — Google Antigravity: Mineflayer Bot Runtime, Survival & Bounded Skills
- **Branch Name:** `specialist/antigravity-mineflayer-bot`
- **Exclusive File Ownership (Create/Edit ONLY these paths):**
  - `src/worker/bot/BotRunner.js`
  - `src/worker/bot/SurvivalMonitor.js`
  - `src/worker/bot/BlockClaimRegistry.js`
  - `src/worker/bot/WorkerPathfindingScheduler.js`
  - `src/worker/safety/ActionSafetyFilter.js`
  - `src/worker/skills/SkillExecutor.js`
  - `src/worker/skills/mineSkill.js`
  - `src/worker/skills/collectSkill.js`
  - `src/worker/skills/craftSkill.js`
  - `src/worker/skills/buildSkill.js`
  - `src/worker/skills/guardSkill.js`
  - `src/worker/skills/exploreSkill.js`
  - `src/worker/skills/depositTransferSkill.js`
  - `src/interfaces/chat/ChatIngressAdapter.js`
  - `tests/worker-bot/*.test.js`
- **Required Interfaces & Reuse Rules:**
  - Implement `BotRunner` & `SkillExecutor` per `docs/spec/MODULE_INTERFACES.md` §3.9.
  - Reuse existing `ScopedListeners`, `PathfindingGuard`, `BlockSearchCache`, `ChatHistoryGuard`, and `toCompactBotSnapshot` from `src/performance/` — **do NOT duplicate them**.
  - Implement `HIGH-07` safeguards (`CLAUDE_RECOMMENDATIONS.md` §2.7):
    1. `BlockClaimRegistry` + `(x,y,z,botId)` hash tie-breaker (`>= 4`-block mining separation).
    2. `ActionSafetyFilter`: `movements.canDig = false` on non-mining travel, `protectedRegions` break blocklist, `allowPvp === false` hard block against player entities, lava/void adjacency abort.
    3. `WorkerPathfindingScheduler`: `<= 2` concurrent A* searches per `WorkerHost`, `tickTimeout: 15`, `thinkTimeout: 3000`.
    4. Immediate local survival interrupt (`health <= 8.0` or `food <= 6` or creeper/lava hazard) pre-empting active skill within `<= 250 ms` without waiting on Master RTT (`G-16`).
- **Acceptance Tests (`tests/worker-bot/*.test.js`):**
  1. Mocked Mineflayer bot executes `mine`, `craft` (verifying `consumedInputs`), `build`, `guard`, `explore`, and two-bot `transferId` handoff producing schema-valid `TaskCompletionReportV1` / `FailureReportV1`.
  2. Two co-located bots never target the same `(x,y,z)` block (`0` block-claim collisions across 500 simulated veins).
  3. Survival interrupt halts `mineSkill` within `< 50 ms` when `health` drops to `7` or lava is exposed, emitting `survival_interrupt` and leaving `ScopedListeners.activeCount === 0` on stop.
  4. `ActionSafetyFilter` rejects PvP target packets and digging inside `protectedRegions`.

---

### Package 2 — OpenCode: Distributed Worker Transport, HTTP/SSE Gateway, CLI & Dashboard
- **Branch Name:** `specialist/opencode-distributed-networking`
- **Exclusive File Ownership (Create/Edit ONLY these paths):**
  - `src/interfaces/http/MasterHttpServer.js`
  - `src/interfaces/http/SessionAuthManager.js`
  - `src/interfaces/http/WorkerGatewayRoutes.js`
  - `src/interfaces/http/DashboardStaticRoutes.js`
  - `src/interfaces/dashboard/public/index.html`
  - `src/interfaces/dashboard/public/app.js`
  - `src/interfaces/dashboard/public/styles.css`
  - `src/interfaces/cli/swarmCli.js`
  - `src/worker/transport/MasterClient.js`
  - `src/worker/createWorker.js`
  - `tests/networking/*.test.js`
- **Required Interfaces & Reuse Rules:**
  - Implement all canonical routes in `docs/spec/MASTER_SPEC.md` §8 & `SECURITY_PLAN.md` §4 using Node built-in `node:http` / `node:https` (zero Express/Fastify dependencies).
  - Route all operator/worker actions exclusively through injected `Coordinator`, `BotRegistry`, `SseCoalescer`, and `toErrorEnvelope` (`MODULE_INTERFACES.md` §3.2, §3.3, §3.7).
  - Implement `HIGH-05` & `HIGH-06` safeguards:
    1. `MasterClient` enforces local lease self-fencing via monotonic `process.hrtime.bigint()` at `0.90 * leaseTtlMs` (`HIGH-05a`) and resynchronizes sequence counters from `lastAckedWorkerSequence` (`HIGH-05b`).
    2. `SessionAuthManager` hashes passwords with `crypto.scrypt`, sets `HttpOnly; SameSite=Strict` session cookies, stores SHA-256 `csrf_token_hash` in SQLite `sessions`, and rate-limits `/api/v1/auth/login` (`5 / 15 min / IP`) and `/worker/v1/register` (`10 / 10 min / IP`).
    3. Bind `0.0.0.0` when configured for remote/preview access with strict `64 KiB` JSON body caps (`128 KiB` on `/worker/v1/events`) and `10s` header timeout.
- **Acceptance Tests (`tests/networking/*.test.js`):**
  1. Full HTTP round-trip: admin login + CSRF -> mint bootstrap token -> `MasterClient` enrolls `createWorker` -> heartbeats deliver `assign` command -> worker posts `assignment_completed` -> SSE stream receives coalesced `task.updated`.
  2. Network partition & reconnect drill: `MasterClient` buffers outbound events in `BoundedByteQueue`, self-fences lease at `0.90 * leaseTtlMs` using monotonic clock, reconnects with `reconcile`, and flushes without duplicate credit.
  3. Oversized (`> 64 KiB`) body returns `413`, missing CSRF returns `403`, brute-force login/register triggers `429 RATE_LIMITED`.

---

### Package 3 — Kilo Code: Performance Analysis, WAL Flash Profiling & Soak Harness
- **Branch Name:** `specialist/kilocode-performance-analysis`
- **Exclusive File Ownership (Create/Edit ONLY these paths):**
  - `src/monitoring/SoakAnalyzer.js`
  - `benchmarks/foundation-soak.js`
  - `benchmarks/sqlite-wal-flash-bench.js`
  - `tests/performance/foundation-budget.test.js`
  - `docs/reports/KILOCODE_PERFORMANCE_ANALYSIS.md`
- **Required Interfaces & Reuse Rules:**
  - Exercise the real `createMaster`, `StateStore` (on-disk WAL), `Coordinator`, `TaskManager`, `BotRegistry`, and `WorkloadGovernor` across `0, 1, 2, 5, 10, 20` simulated distributed bots.
  - Measure SQLite WAL write amplification (bytes written per verified assignment lifecycle), `StateStore.pruneMaintenance()` latency, p50/p95/p99 event-loop lag, post-GC heap slope across rapid task create/cancel/lease-expire churn, and `256 MiB` `--max-old-space-size` headroom on Galaxy A06 constraints.
- **Acceptance Tests (`tests/performance/foundation-budget.test.js`):**
  1. Automated budget gate asserting Master Peak RSS `< 150 MiB`, Event-Loop p95 `< 40 ms`, SQLite `commitAssignments` + `applyWorkerEvent` p95 `< 15 ms`, and post-GC heap drift `< 4 MiB` after 500 full 20-bot task lifecycles.
  2. Written bottleneck & eMMC wear report in `docs/reports/KILOCODE_PERFORMANCE_ANALYSIS.md`.

---

### Package 4 — Google Jules: Pluggable `TaskScheduler` Scorer & Adversarial Edge-Case Tests
- **Branch Name:** `specialist/jules-isolated-tests-and-fixes`
- **Exclusive File Ownership (Create/Edit ONLY these paths):**
  - `src/scheduler/TaskScheduler.js`
  - `tests/adversarial/protocol-fuzz.test.js`
  - `tests/adversarial/epoch-split-brain.test.js`
  - `tests/adversarial/security-rbac-offline.test.js`
- **Required Interfaces & Reuse Rules:**
  - Implement the full multi-factor `TaskScheduler` (`MODULE_INTERFACES.md` §3.6 & `TASK_ALLOCATION.md` §2–§7) pluggable into `Coordinator({ taskScheduler })`, reusing `splitQuota` and `partitionRegion` from `src/scheduler/quotaMath.js` and `action_rate_samples` EWMA/p50 rates from `StateStore`.
  - Include 1-step setup lookahead (`HIGH-03b`: bot with `oak_planks + stick` eligible for mining prerequisite), hysteresis anti-thrashing (`>= 20%` ETA improvement required to preempt healthy lease), and spatial sector non-overlap checks.
  - Build adversarial & property-based tests targeting `CLAUDE_TEST_SCENARIOS.md` Scenarios 3, 5, 6, 7, 8, and 10 (hostile Ollama JSON injection, split-brain epoch races, offline UUID spoofing attempts, inventory delta lies, and 1,000-seed quota/DAG fuzzing).
- **Acceptance Tests (`tests/adversarial/*.test.js`):**
  1. `TaskScheduler` passes all `TASK_ALLOCATION.md` §8 unit & hysteresis invariants when injected into `createMaster({ ..., dependencies: { taskScheduler } })`.
  2. Adversarial fuzz suite achieves `0` uncaught exceptions, `0` quota over-allocations (`verified + reserved <= target`), and `0` RBAC/epoch bypasses across 1,000 randomized failure/replay sequences.

---

### Package 5 — GitHub Copilot: Final Cross-Module Security Audit & `U-01..U-14` Acceptance Gate
- **Branch Name:** `specialist/copilot-final-review`
- **Exclusive File Ownership (Create/Edit ONLY these paths):**
  - `tests/acceptance/u01-u14-gate.test.js`
  - `docs/reviews/COPILOT_FINAL_REVIEW.md`
- **Required Interfaces & Reuse Rules:**
  - Runs **after** Packages 1–4 are reviewed by the Integration Owner.
  - Audits every merged module against `docs/spec/MODULE_INTERFACES.md`, `docs/spec/SECURITY_PLAN.md`, `docs/spec/ACCEPTANCE_CRITERIA.md` (`U-01..U-14` & `G-01..G-18`), and `CLAUDE_RISK_REGISTER.md`.
  - Implements the unified end-to-end `U-01..U-14` automated acceptance gate suite in `tests/acceptance/u01-u14-gate.test.js` and records line-referenced findings + release readiness verdict in `docs/reviews/COPILOT_FINAL_REVIEW.md`.
- **Acceptance Tests (`tests/acceptance/u01-u14-gate.test.js`):**
  1. Executable end-to-end verification of `U-01` through `U-14` (`<= 20` cap, 1-bot preference, 100-cobblestone exact aggregate, concurrent build+guard, broken-tool reallocation, worker crash epoch fencing, Master crash recovery, £0 Ollama-down deterministic fallback, pressure governor survival preservation, unauthorized command rejection, and graceful shutdown).
