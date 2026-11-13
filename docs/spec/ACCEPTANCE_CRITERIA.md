# Acceptance Criteria, Staged Rollout & Open Decisions

**Document:** `docs/spec/ACCEPTANCE_CRITERIA.md`  
**Specification version:** 1.1.0  
**Related:** `MASTER_SPEC.md`, `TEST_PLAN.md`, `PERFORMANCE_PLAN.md`

---

## 1. Automated Release Gates (`G-01 .. G-18`)

No stage is complete until every gate below passes in automated tests without manual log inspection:

| Gate | Requirement | Automated Verification | Pass Threshold |
|---|---|---|---|
| `G-01` | Phone lightweight separation | Dependency & module graph scan on Master entrypoint | `0` imports of `mineflayer`, `prismarine-world`, `mineflayer-pathfinder`, or `minecraft-data` |
| `G-02` | Hard 20-bot ceiling | `config.test.js` + `WorkerRegistry` + `TaskScheduler` | `globalMaxBots > 20` rejected; active assignments `<= min(20, enabledBots, serverCap, hostCaps)` |
| `G-03` | Single-bot preference | `taskScheduler.test.js` (`Q=1` craft & high-travel small mine) | Selects `1` bot (`100%` of cases where multi-bot gain `< 10%`) |
| `G-04` | Subset & swarm scaling | `taskScheduler.test.js` (contended vs wide uncontested batch) | Selects subset `1 < |S| < |E|` under contention and `|E|` when uncontested & faster |
| `G-05` | Single aggregate quota conservation | Fuzz `1,000` `splitQuota` runs + SQLite `CHECK` constraints | `sum(quotas) === remaining` and `verified + reserved <= target` (`0` violations) |
| `G-06` | DAG dependency enforcement | `taskManager.test.js` (`logs -> planks -> sticks -> pickaxe`) | `0` assignments offered for dependent objective before predecessors reach `completed` |
| `G-07` | Anti-false-progress verification | `inventoryLedger.test.js` (baseline stock, wrong item, drop, craft, transfer) | `0` false credits; two-bot `transferId` preserves exact net count |
| `G-08` | Lease fencing & idempotency | `persistenceRecovery.test.js` + `workerProtocol.test.js` | Duplicate `messageId` & stale `allocationEpoch` produce `0` duplicate credits |
| `G-09` | Remote-only bounded AI | `schemaValidator.test.js` + `aiFallback.test.js` | Localhost & paid APIs blocked; `PlanningContextV1 <= 8 KiB`; offline AI degrades cleanly |
| `G-10` | Unified Coordinator boundary | `coordinatorFlow.test.js` (Dashboard + CLI + Chat) | Identical `TaskSummary` state transitions & RBAC enforcement across all 3 surfaces |
| `G-11` | Secure auth, CSRF & worker tokens | `authService.test.js` + `workerProtocol.test.js` | RBAC enforced; missing CSRF/Origin `403`; replayed bootstrap or revoked worker `401` |
| `G-12` | Bounded memory & zero leaks | `npm run test:leaks` (`--expose-gc`) | `0` leaked listeners, `0` ref'd background timers, `< 2.0 MiB` post-GC heap growth |
| `G-13` | Adaptive pressure without task loss | `governor-and-ai.test.js` + `npm run bench` | `tasksSilentlyDiscarded === 0`; survival/safety preserved `100%`; hysteresis prevents thrash |
| `G-14` | Termux & Galaxy A06 readiness | `npm run check:termux` | `$HOME` WAL DB + atomic backup pass; unavailable OS metrics report `'unavailable'`, never `0` |
| `G-15` | Crash recovery | Kill/restart Master mid-task (`persistenceRecovery.test.js`) | Verified progress intact; expired leases reclaimed cleanly on restart |
| `G-16` | Safe disconnect / server respect | `botController.test.js` | Immediate stop (`retryable: false`) on kick/ban/auth failure; `allowPvp === false` |
| `G-17` | Coalesced Dashboard responsiveness | `modules.test.js` + `npm run bench` | SSE `<= 1 Hz` normal (`<= 0.2 Hz` critical); slow client dropped without Master stall |
| `G-18` | Multi-process scale benchmark | `npm run bench` (`0, 1, 2, 5, 10, 20` bots) | `20/20` tasks completed; Master RSS flat (`< 140 MiB` target on `256 MiB` heap cap) |

---

## 2. Staged Implementation & Delivery Roadmap (`0 -> 1 -> 2 -> 5 -> 10 -> 20` Bots)

Coding agents implement and merge in strict stage order so parallel tracks never integrate against unverified foundations:

### Stage 0 — Architecture Spec & Low-Memory Performance Foundation (**Completed on `main`**)
- Complete 9-document v1.1.0 specification in `docs/spec/`.
- Implemented `ResourceMonitor`, `WorkloadGovernor`, `EventBus`, `src/performance/*` (`12` modules), `19/19` tests, `--expose-gc` leak suite, Termux probe, and `0..20` bot benchmark (`be0133f`).

### Stage 1 — Persistence, Schemas, Security & Coordinator Core (`0 -> 1` Simulated Bot)
- Parallelizable tracks:
  - **Track 1A:** `loadConfig.js` + `SchemaValidator.js` (compiling all `AI_PROTOCOL.md` schemas).
  - **Track 1B:** `StateStore.js` (`node:sqlite` WAL migrations + backup) + `AuthService.js`.
  - **Track 1C:** `InventoryLedger.js` + `TaskManager.js` + `Coordinator.js`.
  - **Track 1D:** `WorkerRegistry.js` + `WorkerGateway.js` + simulated 1-bot `WorkerHost` E2E test.
- **Stage 1 Gate:** 1 simulated bot completes single-step tasks end-to-end with crash recovery, RBAC/CSRF, and `0` leaks.

### Stage 2 — Real Mineflayer WorkerHost & Initial 2-Bot Validation (`1 -> 2` Real Bots)
- Parallelizable tracks:
  - **Track 2A:** `BotController.js` + `ActionExecutor.js` (`mine`, `collect`, `craft`, `explore`, `guard`, `transfer`, `safe_stop`) + `CapabilityProfiler.js`.
  - **Track 2B:** `TaskScheduler.js` (`chooseParticipants`, `splitQuota`, `partitionRegion`, DAG unlocking).
  - **Track 2C:** `ReasoningEngine.js` + `OllamaClient.js` (wired to `AiEfficiencyController`) + `CLI` + `DashboardServer` (`SseCoalescer`).
- **Stage 2 Gate (`enabledBots = 2`):**
  1. `"Craft 1 wooden pickaxe"` -> Scheduler assigns **1 bot** (`G-03`).
  2. `"Collect 64 cobblestone"` -> Scheduler splits quota across **2 bots** (`e.g. 32 + 32` or capability-weighted), verifies exact ledger sum `64`, stops at `64` (`G-05`, `G-07`).
  3. Kill Worker 2 mid-task -> lease expires, `allocationEpoch` increments, Bot 1 finishes remaining unverified delta without over-collection (`G-08`, `G-15`).

### Stage 3 — Multi-Objective DAG, Replanning & 5-Bot Subset Allocation (`2 -> 5` Bots)
- Validate mixed-capability subset selection (e.g. `2` miners + `1` builder + `1` guard while `1` distant low-durability bot stays idle), container deposit verification, two-bot `transferId` handoffs, and `ReplanRequestV1` recovery when a tool breaks or vein depletes.

### Stage 4 — Multi-Worker Coordination & Pressure Soak (`5 -> 10` Bots across `>= 2` WorkerHosts)
- Run `>= 2` authorised `WorkerHost` machines connected over TLS to Master on Samsung Galaxy A06 (`NODE_OPTIONS="--max-old-space-size=256"`, `termux-wake-lock`); run 60-minute soak + induced `constrained`/`critical` `WorkloadGovernor` drill (`0` tasks lost, `0` OOM kills).

### Stage 5 — Full Authorised Swarm Ceiling (`10 -> 20` Bots across `2..4` WorkerHosts)
- Scale `enabledBots` stepwise `10 -> 15 -> 20` only after each step passes `G-01..G-18`, per-host RAM/CPU budgets, and operator server approval. Verify `21st` bot slot request is deterministically rejected (`CAPACITY_EXCEEDED`).

---

## 3. Authoritative Unresolved Decisions (`U-01 .. U-14`)

Per Chief Architect governance, unresolved deployment choices are isolated behind `loadConfig` and **never** silently invented:

| ID | Decision Required from Operator / Lead Developer | Safe Default Until Resolved | Blocking Stage |
|---|---|---|---|
| `U-01` | Target Minecraft Java version(s) & protocol support matrix | Pin single configured version (`1.20.4`) per server profile | Stage 2 |
| `U-02` | Minecraft authentication mode (`offline` LAN test vs `microsoft` online) | `offline` on isolated local test server only | Stage 2 |
| `U-03` | Physical Galaxy A06 Termux check (`node:sqlite` availability & idle `MemAvailable` after Android 16 boot) | Run `npm run check:termux` on device before Stage 1 sign-off | Stage 1 / Stage 4 |
| `U-04` | Remote Ollama host hardware, LAN/VPN URL, and model tag (`qwen2.5:7b-instruct` vs `llama3.1:8b`) | Require explicit `SWARM_OLLAMA_BASE_URL`; fast-path works without Ollama | Stage 2C |
| `U-05` | Private PKI / mTLS vs WireGuard / Tailscale overlay for Master <-> Worker & Ollama TLS | Require HTTPS cert/key paths for any non-loopback bind | Stage 2 |
| `U-06` | Hardware specs & `maxBotSlots` per remote `WorkerHost` (`2..4` hosts for 20 bots) | Conservative `maxBotSlots = 5` per worker host | Stage 4 / Stage 5 |
| `U-07` | Target Minecraft server concurrency, anti-cheat rate limits, and connection-throttle spacing | `enabledBots = 2`, staggered login spacing `>= 2,500 ms` | Stage 2+ |
| `U-08` | Default `allowExistingStock` policy when operator says `"collect X"` without qualifier | `false` (`newly_collected` delta required unless explicitly requested) | Resolved by default; configurable |
| `U-09` | Item equivalence policy (`oak_planks` vs any `#minecraft:planks`, `cobblestone` vs `cobbled_deepslate`) | Exact registry ID match unless objective sets `allowTagEquivalents: true` | Stage 2 |
| `U-10` | Build blueprint format (`schem`/JSON block list vs parameterized templates like shelter/wall/torch-grid) | Parameterized deterministic templates in v1; arbitrary schematics deferred | Stage 3 |
| `U-11` | In-game chat command authorisation mode (disabled vs static UUID/username allowlist + `!swarm` prefix) | Chat commands **disabled by default** (`chatCommandsEnabled: false`) | Stage 2C |
| `U-12` | Device-calibrated `ResourceMonitor` `MemAvailable` thresholds on physical Galaxy A06 | Calibrate from `npm run check:termux` + `npm run bench` on phone | Stage 4 |
| `U-13` | Completed-task & audit retention window before SQLite pruning/archival | Retain `7 days` or `1,000` terminal tasks, whichever comes first | Stage 3 |
| `U-14` | Protected-area / world-modification guard coordinates (bases/chests bots must never mine) | Require explicit `protectedRegions` list in server profile before `mine`/`build` on shared servers | Stage 2 |
