# Mineflayer AI Swarm — Master Implementation Specification

**Document:** `docs/spec/MASTER_SPEC.md`  
**Specification version:** 1.1.0  
**Status:** Authoritative implementation baseline. Performance monitoring primitives (`src/monitoring/*`, `src/performance/*`, `src/events/EventBus.js`) are implemented; core orchestration, persistence, worker and UI modules are specified here for implementation. Unresolved decisions are tracked in §17 and `ACCEPTANCE_CRITERIA.md`.  
**Source of truth:** Repository-root `MASTER_PROJECT_CONTEXT.md` plus `docs/spec/*.md`.  
**Target controller:** Samsung Galaxy A06, Android 16, Termux, Node.js, 4 GB physical RAM.  
**Target game:** Minecraft Java Edition through Mineflayer, initially in a private authorised test environment.

---

## 1. Purpose

Define the complete, unambiguous technical contract for an intelligent, distributed Mineflayer multi-bot system whose central coordinator runs on a Samsung Galaxy A06 (`4 GB` RAM, Android 16, Termux) and whose Mineflayer worker processes run on authorised worker devices.

- **Initial operational deployment:** `2` bots.
- **Global architectural ceiling:** `20` concurrently registered bot identities distributed across authorised worker hosts, subject to independently configured per-worker, per-server and adaptive workload caps.
- **Single source of task truth:** Exactly one central `Coordinator` and one authoritative `TaskManager` own all user intents, objective DAGs, assignment leases, resource accounting and state transitions. All interfaces (Minecraft chat, Express web dashboard and Termux CLI) submit requests through `Coordinator`. Workers execute bounded deterministic instructions and submit verifiable evidence; they never maintain competing schedulers or progress ledgers.

---

## 2. Non-Negotiable Architectural & Correctness Invariants

1. **Single Authoritative Ledger (`G-01`):** One shared `TaskManager` (backed by `StateStore` transactions and `InventoryLedger`) owns all tasks, objectives, assignment leases, verified progress and state transitions.
2. **Aggregate Quantity Semantics (`G-03`):** A target quantity belongs to the objective across the entire swarm, never per bot. `"Mine 100 cobblestone"` means `targetQuantity = 100` total across all participating bots, never `100 × N`.
3. **Quota Conservation (`G-03`):** At every point in time for any quantity objective:
   - `0 <= verifiedQuantity <= targetQuantity`
   - `reservedQuantity = sum(active, unexpired assignment quotas)`
   - `verifiedQuantity + reservedQuantity <= targetQuantity`
   - `remainingQuantity = max(0, targetQuantity - verifiedQuantity - reservedQuantity)`
   - Newly allocated assignment quotas are strictly positive integers, non-overlapping, and sum to at most `remainingQuantity` (equalling `remainingQuantity` when partitioning the full remainder).
4. **Evidence-Driven Participant Count (`G-04`, `G-05`):** Never assign every bot by default. Prefer a **1-bot** assignment unless adding another eligible bot reduces predicted `p90` completion time by at least `MIN_RELATIVE_GAIN` (default `0.10`) beyond estimation uncertainty after travel, setup, coordination, contention and delivery/merge costs.
5. **Multi-Resource & Role Separation (`G-06`):** Distinct resource types (`"100 cobblestone and 40 coal"`) and distinct roles (`"build a shelter while one bot guards"`) become separate objectives connected by an explicit directed acyclic graph (DAG). Cyclic graphs are rejected.
6. **Two-Level Intelligence (`G-10`, `G-11`):**
   - **Level 1 (Deterministic JavaScript):** Owns movement, pathfinding, mining, crafting, building primitives, inventory management, eating, survival, progress evidence, reconnection and lease enforcement. Never calls an LLM on movement ticks, slot updates or routine survival checks.
   - **Level 2 (Remote Ollama):** Used only for natural-language interpretation, complex DAG decomposition, parallelism hints, ambiguity detection and event-triggered strategic replanning. AI output is untrusted data validated against strict JSON Schemas (`AI_PROTOCOL.md`) and semantic rules before `TaskScheduler` makes authoritative decisions.
7. **Hardware & Financial Exclusions (`G-12`, `G-13`):**
   - **Never run Ollama or any local LLM on the Galaxy A06.**
   - **Never run 20 Mineflayer clients on the Galaxy A06** (`localBotSlots = 0` by default).
   - **Zero paid APIs, paid subscriptions, cloud inference endpoints or automatic paid fallbacks.** When remote Ollama is unreachable or throttled, deterministic planning continues for supported tasks and complex ambiguous intents return `clarification_required`.
8. **Legitimate Server & Account Operation (`G-14`):** Online-mode connections require legitimate, separately authenticated Minecraft/Microsoft accounts stored only on the worker device that hosts each bot. Offline-mode identities are permitted solely inside an explicit `private_offline_test` server profile controlled by the project owner. Never bypass authentication, anti-cheat, CAPTCHAs, player caps, rate limits or moderation.
9. **Shared Ingress Boundary (`G-02`):** Minecraft chat, Web Dashboard and Termux CLI all call the same `Coordinator` use-case methods. None may mutate `StateStore` or invoke Mineflayer directly.
10. **Evidence Over Claims (`G-07`, `G-08`, `G-09`):** Worker reports are untrusted evidence. Progress is credited only after verifying baseline-to-post-action inventory/container/world deltas under an active lease, valid `allocationEpoch`, monotonic `workerSequence` and unique `messageId`/`evidenceId`. Lost acknowledgements trigger state reconciliation before any retry of a non-idempotent action.
11. **Strict Protocol & Resource Bounds (`G-15`, `G-17`):** Every external payload carries `schemaVersion`, enforces `additionalProperties: false` and strict byte caps, and every cache, queue, SSE stream and log file has hard upper bounds. Low-priority work may be paused/deferred under memory pressure, **never silently discarded**.
12. **Honest Engineering (`G-18`):** Never invent package APIs, Minecraft version support, test results or device RAM numbers. Unknown platform metrics are reported as `'unavailable'`, never `0`.

---

## 3. Scope

### 3.1 Included
- Master controller process on Samsung Galaxy A06 (Termux, Node.js CommonJS).
- Remote `WorkerHost` processes supervising isolated `BotController` instances.
- Authenticated worker registration, token rotation/revocation, heartbeats, long-polled lease commands, acknowledgements, sequenced evidence batches and crash/network reconciliation.
- Two-level planning: deterministic intent templates + remote Ollama structured DAG planning (`TaskPlanV1`) and replanning (`ReplanRequestV1`).
- Capability profiling, travel/rate/contention estimation, marginal-benefit participant selection, largest-remainder aggregate quota splitting and spatial/role partitioning.
- Canonical item identity (`InventoryLedger`) and multi-policy progress verification.
- Transactional SQLite persistence (`StateStore`) with forward-only migrations and verified backup/restore.
- Adaptive resource monitoring (`ResourceMonitor`) and pressure governance (`WorkloadGovernor`).
- Express HTTPS API, vanilla HTML/CSS/JS dashboard with coalesced SSE (`SseCoalescer`), Termux CLI and UUID-allowlisted `ChatCommandAdapter`.
- Automated unit, contract, integration, security, leak and multi-bot scale tests (`1 -> 2 -> 5 -> 10 -> 20`).

### 3.2 Excluded
- Unauthorised automation on public or third-party servers.
- Bypassing authentication, anti-cheat, connection limits, bans or server rules.
- Running a local LLM or production multi-bot Mineflayer load on the Galaxy A06.
- Any paid API, metered cloud AI fallback, TypeScript/ESM backend rewrite or React/SPA build toolchain.
- AI execution of arbitrary code, shell commands, raw packets or unvalidated Mineflayer methods.

---

## 4. Runtime, Language & Dependency Constraints

- **Language & Module System:** JavaScript (`'use strict'`), CommonJS (`require` / `module.exports`), `async`/`await`.
- **Node.js Runtime:** Minimum `>=22.5.0` (verified in CI on `v22.22.3`); production target is Termux `Node.js 24.17.0` (and `Node 26 LTS` forward compatibility).
- **Phone Launch Flags:** Master Controller on the 4 GB Galaxy A06 must run with `NODE_OPTIONS="--max-old-space-size=256"` under `termux-wake-lock` so V8 performs proactive garbage collection well below Android `lmkd` thresholds (see `PERFORMANCE_PLAN.md` §3).
- **Package Separation & Pinning:**
  - Exact versions pinned in `package-lock.json` (no caret/tilde ranges in production dependencies).
  - **Master Controller process MUST NEVER `require('mineflayer')`, `mineflayer-pathfinder`, `prismarine-world`, or full `minecraft-data`** (empirically measured at `540 MiB` unpacked disk and `+37.9 to +45.4 MiB` RSS). Master uses a compact exported registry allowlist JSON (`< 100 KiB`) matching the active server version tuple.
  - Native C++ addons lacking `android-arm64` Bionic prebuilds (`better-sqlite3`, `argon2`, `bcrypt`, `sqlite3`) must not be made mandatory on Termux without an approved ADR; prefer Node's built-in `node:sqlite` (pending on-device `U-03` closure) and concurrency-1 bounded `node:crypto.scrypt` (or verified built-in `crypto.argon2`).

---

## 5. Formal Lifecycle State Machines

All state transitions execute inside `StateStore.transaction(...)` owned by `TaskManager`. Any unlisted transition throws `DomainError('INVALID_STATE_TRANSITION')`.

### 5.1 Task State Machine
- **States:** `queued`, `planning`, `clarification_required`, `ready`, `running`, `paused`, `blocked`, `completed`, `failed`, `cancelled`.
- **Terminal states (immutable):** `completed`, `failed`, `cancelled`.
- **Legal transitions:**
  - `queued -> planning | cancelled`
  - `planning -> ready | clarification_required | failed | cancelled`
  - `clarification_required -> planning | cancelled` *(when operator supplies clarification)*
  - `ready -> running | paused | blocked | cancelled`
  - `running -> paused | blocked | completed | failed | cancelled`
  - `paused -> ready | running | cancelled`
  - `blocked -> planning | ready | paused | failed | cancelled`

### 5.2 Objective State Machine
- **States:** `pending`, `ready`, `assigned`, `running`, `verifying`, `completed`, `blocked`, `failed`, `cancelled`.
- **Terminal states:** `completed`, `failed`, `cancelled`.
- **Legal transitions:**
  - `pending -> ready | blocked | cancelled` *(becomes `ready` iff all `dependencies` are `completed`)*
  - `ready -> assigned | blocked | cancelled`
  - `assigned -> running | ready | blocked | failed | cancelled` *(`-> ready` if all leases expire/reject with remaining > 0)*
  - `running -> verifying | assigned | ready | blocked | completed | failed | cancelled`
  - `verifying -> completed | running | ready | blocked | failed | cancelled`
  - `blocked -> ready | failed | cancelled`

### 5.3 Assignment (Lease) State Machine
- **States:** `offered`, `accepted`, `running`, `reporting`, `verifying`, `completed`, `failed`, `revoked`, `expired`.
- **Terminal states:** `completed`, `failed`, `revoked`, `expired`.
- **Legal transitions:**
  - `offered -> accepted | revoked | expired | failed`
  - `accepted -> running | revoked | expired | failed`
  - `running -> reporting | verifying | completed | failed | revoked | expired`
  - `reporting -> verifying | running | completed | failed | revoked | expired`
  - `verifying -> completed | running | failed | revoked | expired`

### 5.4 Worker Health State Machine
- **States:** `alive`, `degraded`, `unreachable`, `disabled`.
- **Transitions:**
  - `alive -> degraded` *(missed 1 heartbeat interval: `now - lastHeartbeatAt > heartbeatIntervalMs * 1.5`)*
  - `alive | degraded -> unreachable` *(`now - lastHeartbeatAt > leaseGraceMs`, default `3 × heartbeatIntervalMs`; triggers lease expiry & reconciliation)*
  - `degraded | unreachable -> alive` *(authenticated heartbeat + `reconcileWorker` completed)*
  - `* -> disabled` *(explicit operator disable or token revocation; revokes active leases immediately)*

---

## 6. Canonical Domain Error Taxonomy

All modules throw or return structured `DomainError` instances (`{ code, message, retryable, httpStatus, details }`), never raw strings or stack traces to external clients:

| Error Code | HTTP | Retryable | Meaning |
|---|---:|---|---|
| `UNAUTHENTICATED` | `401` | No | Missing, expired or invalid session/token |
| `FORBIDDEN` | `403` | No | Principal role or worker ownership lacks permission |
| `CSRF_INVALID` | `403` | No | Missing or mismatched `X-CSRF-Token` / `Origin` |
| `RATE_LIMITED` | `429` | Yes | Per-principal, login, worker or chat rate cap exceeded |
| `PROTOCOL_VERSION_UNSUPPORTED` | `400` | No | Unsupported `schemaVersion` |
| `SCHEMA_VALIDATION_FAILED` | `400` | No | Payload violates strict JSON Schema or byte cap |
| `SEMANTIC_VALIDATION_FAILED` | `422` | No | Cyclic DAG, unknown `resourceId` or invalid bounds |
| `NOT_FOUND` | `404` | No | Unknown `taskId`, `objectiveId`, `workerId` or `botId` |
| `CONFLICT` | `409` | Yes | Optimistic version mismatch or concurrent state mutation |
| `INVALID_STATE_TRANSITION` | `409` | No | Disallowed lifecycle transition (e.g. mutating terminal state) |
| `STALE_ALLOCATION_EPOCH` | `409` | No | Worker submitted event/ack for superseded `allocationEpoch` |
| `LEASE_EXPIRED` | `409` | No | Assignment lease passed `expiresAt` on server clock |
| `GLOBAL_BOT_CAP_EXCEEDED` | `409` | No | Attempted to register > 20 bot identities |
| `WORKLOAD_CONSTRAINED` | `503` | Yes | `WorkloadGovernor` paused/rejected optional admission under pressure |
| `AI_UNAVAILABLE` | `503` | Yes | Remote Ollama unreachable or timed out (triggers fallback) |
| `AI_INVALID_RESPONSE` | `502` | No | Remote Ollama output failed schema/semantic validation |
| `AI_POLICY_VIOLATION` | `400` | No | Local phone Ollama host or paid cloud provider configured |
| `PERSISTENCE_ERROR` | `500` | Yes | SQLite busy/I/O failure; coordinator enters safe mode |

---

## 7. Canonical Configuration Schema (`loadConfig`)

Configuration is loaded from environment variables and optional JSON config file, deeply frozen, and redacted via `redactConfig()`:

| Config Path / Env Var | Type | Default | Constraint / Rule |
|---|---|---|---|
| `envProfile` (`SWARM_ENV_PROFILE`) | `'private_offline_test' \| 'authorised_online'` | `'authorised_online'` | Offline Minecraft auth refused unless `'private_offline_test'` |
| `http.host` (`SWARM_BIND_HOST`) | `string` | `'127.0.0.1'` | Non-loopback requires TLS (`tls.enabled = true`) |
| `http.port` (`SWARM_PORT`) | `integer` | `8443` | `1024..65535` |
| `tls.enabled` (`SWARM_TLS_ENABLED`) | `boolean` | `true` | `false` allowed ONLY when `http.host === '127.0.0.1'` in dev/test |
| `tls.certPath` (`SWARM_TLS_CERT_PATH`) | `string \| null` | `null` | Required when `tls.enabled === true` |
| `tls.keyPath` (`SWARM_TLS_KEY_PATH`) | `string \| null` | `null` | Required when `tls.enabled === true` |
| `tls.caCertPath` (`SWARM_TLS_CA_PATH`) | `string \| null` | `null` | Private LAN CA root pinned by `WorkerHost`, `CLI` & `OllamaClient` (`HIGH-06`) |
| `capacity.globalMaxBots` | `integer` | `20` | **Hard validation error if `> 20` or `< 1`** |
| `capacity.initialEnabledBots` | `integer` | `2` | `1..globalMaxBots` |
| `capacity.phoneLocalBotSlots` | `integer` | `0` | Must be `0` in production on Galaxy A06 |
| `capacity.defaultLeaseDurationMs` | `integer` | `30000` | `5000..120000` |
| `capacity.heartbeatIntervalMs` | `integer` | `5000` | `1000..30000`; `leaseDurationMs >= 3 * heartbeatIntervalMs` |
| `ai.enabled` (`SWARM_AI_ENABLED`) | `boolean` | `true` | Deterministic tasks work when `false` |
| `ai.ollamaBaseUrl` (`SWARM_OLLAMA_URL`) | `string \| null` | `null` | Rejects `localhost`/`127.0.0.1` on phone & all paid cloud domains |
| `ai.model` (`SWARM_OLLAMA_MODEL`) | `string` | `'unresolved'` | Must match tested `U-07` model |
| `ai.maxConcurrent` | `integer` | `1` | `1..2` |
| `ai.maxQueue` | `integer` | `3` | `0..10` |
| `ai.timeoutMs` | `integer` | `8000` | `1000..30000` |
| `storage.sqlitePath` (`SWARM_DB_PATH`) | `string` | `'./data/swarm.db'` | Must reside on native POSIX FS (`$HOME`), never `/sdcard` |
| `logging.level` (`SWARM_LOG_LEVEL`) | `'debug'\|'info'\|'warn'\|'error'` | `'info'` | Secrets redacted before serialization |
| `logging.maxFileBytes` | `integer` | `5242880` | `5 MiB` per file, `maxFiles = 3` |
| `chat.commandPrefix` | `string` | `'!swarm'` | Non-empty, `<= 16` chars |
| `chat.allowedPlayerUuids` | `string[]` | `[]` | Explicit UUID v4 allowlist per server profile |

---

## 8. Compatibility Governance

The tuple `(Node version, Mineflayer version, minecraft-protocol, minecraft-data, optional plugins, Minecraft Java server version, auth mode)` is governed by an explicit repository compatibility table (`compatibility.json` once `U-01`/`U-02` close). Untested tuples fail closed unless an operator explicitly sets `allowExperimentalProtocolTuple: true` in `private_offline_test` mode.

---

## 9. Required Specification Suite

1. `docs/spec/MASTER_SPEC.md` — Normative rules, invariants, lifecycles, errors and config contract (this document).
2. `docs/spec/ARCHITECTURE.md` — Process topology, wire REST/SSE protocol contracts and SQLite DDL schema.
3. `docs/spec/MODULE_INTERFACES.md` — Module ownership, DTO dictionary, inputs, outputs, methods, events and failure modes.
4. `docs/spec/TASK_ALLOCATION.md` — Mathematical estimation, marginal benefit algorithm, quota splitting, DAG scheduling and verification ledger.
5. `docs/spec/AI_PROTOCOL.md` — Strict JSON Schema Draft 2020-12 definitions and Ollama data-minimisation boundary.
6. `docs/spec/PERFORMANCE_PLAN.md` — Galaxy A06 4 GB RAM budgets, adaptive `WorkloadGovernor`, Termux constraints and benchmark evidence.
7. `docs/spec/SECURITY_PLAN.md` — Principal RBAC matrix, session/CSRF/token controls, Minecraft auth isolation and incident response.
8. `docs/spec/TEST_PLAN.md` — Unit, contract, integration, E2E, security, recovery and memory-leak test specifications.
9. `docs/spec/ACCEPTANCE_CRITERIA.md` — Global invariants `G-01..G-18`, Stage `0..5` rollout gates and Unresolved Decisions `U-01..U-14`.

---

## 10. Authoritative Unresolved Decisions (`U-01` – `U-14`)

Full resolution criteria are maintained in `ACCEPTANCE_CRITERIA.md` §3 (single canonical ID table — reconciled per `HIGH-01`). Coding agents **must not** silently invent production values for open items:

- **`U-01`:** Target Minecraft Java version(s) & protocol support matrix (default pinned profile: `1.20.4`).
- **`U-02`:** Minecraft authentication mode (`private_offline_test` vs `online_microsoft`).
- **`U-03`:** Physical Galaxy A06 Termux check (`node:sqlite` WAL + `backup` and idle `MemAvailable` after Android 16 boot via `npm run check:termux`).
- **`U-04`:** Remote Ollama host hardware, LAN/VPN URL, and model tag (`qwen2.5:7b-instruct` vs `llama3.1:8b`).
- **`U-05`:** Private PKI / mTLS vs WireGuard / Tailscale overlay (`tls.caCertPath`, `tls.certPath`, `tls.keyPath`).
- **`U-06`:** Hardware specs & `maxBotSlots` per remote `WorkerHost` (`2..4` hosts for 20 bots; default `5` bots/host).
- **`U-07`:** Target Minecraft server concurrency, anti-cheat rate limits, and connection-throttle spacing (`>= 2,500 ms`).
- **`U-08`:** Default `allowExistingStock` policy when operator says `"collect X"` (`false` by default).
- **`U-09`:** Item equivalence policy (`oak_planks` vs `#minecraft:planks`, `cobblestone` vs `cobbled_deepslate`).
- **`U-10`:** Build blueprint format (parameterized deterministic templates in v1).
- **`U-11`:** In-game chat command authorisation mode (disabled by default; hard-disabled in `private_offline_test`).
- **`U-12`:** Device-calibrated `ResourceMonitor` / `WorkloadGovernor` thresholds on physical Galaxy A06 (`175 MiB` constrained / `215 MiB` critical RSS defaults under `--max-old-space-size=256`).
- **`U-13`:** Completed-task & audit retention window (`7 days` or `1,000` terminal tasks; `24h` dedup pruning).
- **`U-14`:** Protected-area / world-modification guard coordinates (`protectedRegions` list per server profile).
