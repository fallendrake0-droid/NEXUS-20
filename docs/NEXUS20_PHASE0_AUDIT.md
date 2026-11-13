# NEXUS-20 — Phase 0 Complete Repository Audit, Gap Analysis & Implementation Plan

**Audit Date:** 2026-11-10  
**Repository:** `https://github.com/fallendrake0-droid/mineflayer-ai-swarm.git`  
**Active Branch:** `arena/3074f45c-mineflayer-ai-swarm`  
**Baseline Commit Inspected:** `18769aa` (4 commits ahead of `origin/main` `be0133f`)  
**Uncommitted Changes at Audit Start:** `0` (clean working tree)  
**Runtime Environment:** Node.js `v22.22.3` (V8 `12.4.254.21`, built-in `node:sqlite` `v3.51.3`, OpenSSL `3.5.6`), npm `10.9.8`, Linux x64 (`2` cores, `3,939.9 MiB` RAM)

---

## 1. Repository & Documentation Inventory (Part 27 Steps 1–6)

### 1.1 Specifications & Review Documents Inspected
- **Root context & reviews:** `MASTER_PROJECT_CONTEXT.md`, `AGENTS.md`, `README.md`, `PERFORMANCE_REPORT.md`, `CONTRIBUTING.md`, `DEVELOPMENT_STATUS.md`, `CLAUDE_ARCHITECTURE_REVIEW.md`, `CLAUDE_RISK_REGISTER.md`, `CLAUDE_RECOMMENDATIONS.md`, `CLAUDE_TEST_SCENARIOS.md`.
- **Canonical v1.1.0 specifications (`docs/spec/`):** `MASTER_SPEC.md`, `ARCHITECTURE.md`, `MODULE_INTERFACES.md`, `TASK_ALLOCATION.md`, `AI_PROTOCOL.md`, `PERFORMANCE_PLAN.md`, `SECURITY_PLAN.md`, `TEST_PLAN.md`, `ACCEPTANCE_CRITERIA.md`, `CODING_AGENT_BOOTSTRAP.md`.
- **Note on historical reference:** `docs/implementation-spec` (`536a941`) referenced in Part 4 was previously merged and upgraded to v1.1.0 (`b4cd044`) and reconciled against Claude's architecture review (`0db66dc`, `18769aa`).

### 1.2 Installed Dependencies
- **External npm packages in `package.json` / `node_modules`:** **None (`0` packages).**
- **Assessment:** Intentional and verified (`G-01`). The Master Coordinator uses Node 22 built-in `node:sqlite`, `node:crypto`, `node:http`, `node:https`, `node:perf_hooks`, and `node:test`. Real Mineflayer packages (`mineflayer`, `mineflayer-pathfinder`, `minecraft-data`) are not yet installed and must remain isolated to the Worker tier (Phase 2) so the Master Coordinator stays lightweight.

---

## 2. Implemented & Verified Modules Baseline (Part 27 Steps 4–5 & 9–12)

| Subsystem | Implemented Files | Verified Capabilities |
|---|---|---|
| Entrypoint & Lifecycle | `index.js`, `src/master/createMaster.js` | Config check (`--check-config`), health probe (`--health`), `Coordinator.recover()` on boot, reverse-order SIGINT/SIGTERM shutdown |
| Configuration & Errors | `src/config/loadConfig.js`, `.env.example`, `src/errors/DomainError.js` | Frozen config, `<=20` default bot cap, TLS rules, £0 remote-only AI policy, timeout inequalities, sanitized error envelopes |
| Logging & Events | `src/logging/createLogger.js`, `src/performance/BoundedLogger.js`, `src/events/EventBus.js` | Secret redaction, duplicate storm suppression, `5 MiB x 3` rotation, bounded memory rings |
| Persistence (`StateStore`) | `src/persistence/StateStore.js` | Single-writer `node:sqlite` WAL, eMMC wear pragmas, 15 relational tables + `CHECK` invariants, nested `SAVEPOINT` transactions, verified online backup, sliding-window pruning |
| Protocol & AI Brain Core | `src/protocol/SchemaValidator.js`, `src/performance/AiEfficiencyController.js` | Strict `TaskPlanV1`, `BotAssignmentV1`, completion/failure/command/event schemas; deterministic fast-path, bounded cache, in-flight dedup, supersession abort, safe malformed-JSON/timeout fallback |
| Authoritative Verification | `src/inventory/InventoryLedger.js` | 7 verification policies (`newly_collected`, `held_stock`, `deposited_stock`, `crafted_output`, `block_state`, `region_visited`, `role_duration`), clamped credits, two-bot `transferId` timeout reconciliation |
| Worker & Bot Registry | `src/workers/BotRegistry.js`, `WorkerRegistry.js` | Single-use SHA-256 bootstrap tokens, constant-time bearer auth, `<=20` cap, heartbeats, liveness sweeps, revocation fencing |
| Task & Lease Engine | `src/tasks/TaskManager.js`, `src/scheduler/TaskScheduler.js`, `src/scheduler/quotaMath.js` | Single authoritative `TaskManager`, `finish_to_start` + `start_with` DAG, water-filling `splitQuota`, `partitionRegion`, `p50`/`p90` candidate scoring, 1-step craft lookahead, `allocation_epoch` fencing, priority preemption |
| Monitoring & Low-RAM Primitives | `src/monitoring/ResourceMonitor.js`, `WorkloadGovernor.js`, `src/performance/*.js` | RSS/V8-heap/`/proc/meminfo` pressure hysteresis, durable SQLite task deferral, `CompactSnapshotCodec`, `SseCoalescer`, `TimerRegistry`, `ScopedListeners`, `PathfindingGuard`, `BlockSearchCache`, `ChatHistoryGuard` |

### Measured Performance Baseline (Verified Simulated Multi-Process Run)
- **Test baseline:** `41 / 41` unit/foundation/adversarial tests passing (`npm test`), `3 / 3` `--expose-gc` leak tests passing (`npm run test:leaks`), `npm run check:termux` passing.
- **20-bot distributed benchmark (`benchmarks/results/latest-benchmark.json` — simulated workers, NOT live Minecraft):**
  - Master Peak RSS: **`64.05 MiB`** | Post-GC Heap: **`6.32 MiB`** | Event-loop p95: **`25.28 ms`** | Tasks silently discarded under pressure: **`0`**.

---

## 3. Can the Current System Support 20 Bots? (Part 27 Step 13)

- **Coordinator / Persistence / Scheduler Tier:** **YES (Verified in multi-process simulation).** `StateStore`, `TaskManager`, `TaskScheduler`, `BotRegistry`, `AiEfficiencyController`, and `SseCoalescer` handle 20 bots across 4 worker processes at `64 MiB` Master RSS with exact quota conservation (`200-step` randomized fuzz verified).
- **End-to-End Real Minecraft Swarm:** **NOT YET.** A live 20-bot Minecraft swarm cannot run yet because:
  1. HTTP/HTTPS + SSE network routes (`/api/v1/*` and `/worker/v1/*`) and `AuthService` are not yet wired to sockets.
  2. The `WorkerHost` process and Mineflayer `BotController` / skills (`mine`, `navigate`, `survive`, `construct`, `deposit`) are not yet implemented.
  3. Operating mode switching (`SYNCHRONIZED` / `DISTRIBUTED` / `HYBRID`), the 5 NEXUS-20 performance profiles, `WorldKnowledgeStore`, and the web Dashboard UI are not yet implemented.

---

## 4. Architecture Conflicts Identified & Resolved (Part 27 Step 8)

All 7 conflicts between `docs/spec/*.md` and the NEXUS-20 Master Prompt are formally resolved in `docs/DECISIONS.md`:
1. **`ADR-001`:** Built-in `node:http`/`node:https` instead of Express (zero npm bloat on Master, full `0.0.0.0` + `PORT` + Vanilla JS dashboard support).
2. **`ADR-002`:** Default `20`-bot cap (`G-02`) backed by configurable `maxArchitecturalBots` so scaling beyond 20 requires zero redesign.
3. **`ADR-003`:** Explicit runtime-switchable `SYNCHRONIZED`, `DISTRIBUTED`, and `HYBRID` modes on top of the single authoritative `TaskManager`.
4. **`ADR-004`:** Five NEXUS-20 performance profiles (`ULTRA_LOW`, `LOW`, `BALANCED`, `PERFORMANCE`, `MAXIMUM_THROUGHPUT`) unified inside `WorkloadGovernor`.
5. **`ADR-005`:** Bounded, TTL-expiring SQLite `WorldKnowledgeStore` + chest/storage lock coordination.
6. **`ADR-006`:** Pluggable AI provider adapter registry inside `AiEfficiencyController` with remote Ollama as default.
7. **`ADR-007`:** Preservation of existing tested module paths (`src/tasks/TaskManager.js`, etc.) + `process.env.PORT` and `SWARM_TRUST_EDGE_TLS_PROXY` support.

---

## 5. Detailed Gap Analysis & Prioritised Implementation Plan (Part 27 Steps 14–15)

| Priority | Phase | Gap / Deliverable | Target Modules | Status |
|---|---|---|---|---|
| **P0 (Now)** | Phase 1 + 4/5/6/8 Core | `AuthService` (`scrypt` concurrency-1 queue, sessions, CSRF, rate limits) | `src/security/AuthService.js` | Implementing in this turn |
| **P0 (Now)** | Phase 5 + 9 Core | 3 Operating Modes (`SYNCHRONIZED` spatial+quota, `DISTRIBUTED`, `HYBRID` + hold-time hysteresis) & 5 Performance Profiles (`ULTRA_LOW..MAXIMUM_THROUGHPUT`) + Pluggable AI Provider registry | `src/monitoring/WorkloadGovernor.js`, `src/scheduler/TaskScheduler.js`, `src/coordinator/Coordinator.js`, `src/performance/AiEfficiencyController.js` | Implementing in this turn |
| **P0 (Now)** | Phase 6 Core | Bounded SQLite `WorldKnowledgeStore` (10 categories, TTL expiry, confidence merge, storage chest mutex locks) | `src/knowledge/WorldKnowledgeStore.js`, `src/persistence/StateStore.js` | Implementing in this turn |
| **P0 (Now)** | Phase 1 + 8 Core | Authenticated HTTP/SSE Gateway (`/api/v1/*` + `/worker/v1/*`) & genuine Vanilla JS NEXUS-20 Control Centre Dashboard | `src/interfaces/http/MasterHttpServer.js`, `src/dashboard/public/{index.html,style.css,app.js}` | Implementing in this turn |
| **P1 (Next)** | Phase 2 & 3 | Distributed `WorkerHost` client (`MasterClient`, monotonic lease self-fencing) + Mineflayer single-bot & 2-bot vertical slice (`BotController`, survival, navigation, mining) | `src/worker/*`, `src/bots/*` | Planned next phase |
| **P2** | Phase 7 | Advanced Mineflayer capabilities: blueprint construction, chest deposit/withdraw skills, exploration scanner, permission-gated defensive combat | `src/worker/skills/*` | Planned |
| **P3** | Phase 11 & 12 | Real Minecraft Java server `1 -> 2 -> 5 -> 10 -> 20` staged integration harness, 60-min soak, final production release audit | `tests/e2e/*`, `docs/` | Planned |
