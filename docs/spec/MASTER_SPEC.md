# Mineflayer AI Swarm — Master Implementation Specification

**Document:** MASTER_SPEC.md  
**Specification version:** 1.0.0  
**Status:** Baseline for implementation; unresolved decisions are listed in this document and in ACCEPTANCE_CRITERIA.md.  
**Source of truth:** The repository-root MASTER_PROJECT_CONTEXT.md plus this specification.  
**Target controller:** Samsung Galaxy A06, Android 16, Termux, Node.js, 4 GB physical RAM.  
**Target game:** Minecraft Java Edition through Mineflayer, initially in a private authorised test environment.

## 1. Purpose

Define the shared technical contract for a distributed Mineflayer swarm whose central coordinator runs on the Galaxy A06 and whose worker processes may run on other authorised devices. The initial operational target is two bots. The architecture must support at most twenty concurrently registered bot identities across all workers, subject to independently configured device, server and operator limits.

The coordinator is the only authority for task state, objective totals, assignment leases, resource credit and scheduling. All user interfaces submit commands to the same coordinator. Workers execute bounded instructions and report observations; they do not create competing task truth.

This is an implementation specification, not a claim that code has been built or tested.

## 2. Non-negotiable invariants

1. One shared TaskManager owns all tasks, objectives, assignment leases, verified progress and state transitions.
2. A target quantity belongs to an objective, not to each bot. For example, “mine 100 cobblestone” means one aggregate target of 100.
3. No objective is assigned to every bot by default. Candidate participants are selected by measured capability and predicted benefit.
4. A one-bot solution wins whenever adding bots does not produce a material, confidence-supported improvement.
5. Different resources become separate objectives. Dependencies form a directed acyclic graph (DAG).
6. All execution-critical behaviour is deterministic JavaScript. Ollama proposes plans and strategy; validators and policy code decide what may execute.
7. No LLM inference is performed for each movement, inventory slot update or routine survival action.
8. The phone runs the coordinator only by default. It must not host twenty Mineflayer clients or a local LLM.
9. No paid API, subscription or paid inference fallback is permitted. If remote Ollama is unavailable, deterministic planning and execution continue where safe.
10. Minecraft online-mode accounts use legitimate, separately authenticated accounts. Offline-mode identities are permitted only on a private server explicitly controlled for testing.
11. Never bypass server authentication, anti-cheat, player limits, rate limits or access restrictions.
12. No worker, dashboard, CLI or chat adapter may maintain a separate task scheduler or progress ledger.
13. A worker report is evidence, not verified completion. The coordinator verifies it against snapshots, leases, sequence numbers and task-specific proof.
14. Every externally visible protocol message is versioned, bounded in size and validated with a strict schema.
15. Never claim compatibility or successful operation without running the corresponding compatibility and acceptance tests.

## 3. Scope

### Included

- Master controller and shared coordinator services.
- Independent Mineflayer bot controllers hosted by worker processes.
- Worker registration, heartbeats, leases, commands, acknowledgements and recovery.
- Natural-language objective parsing and DAG planning through remote Ollama.
- Deterministic candidate evaluation and task allocation.
- Aggregate quantity accounting and inventory verification.
- Individual and shared objectives, role tasks, spatial exploration and dependencies.
- Persistence, monitoring, logs, dashboard, CLI and allowlisted Minecraft chat commands.
- Security boundaries, automated tests and staged scaling from one to twenty bots.

### Excluded

- Public-server automation without explicit server authorisation.
- Circumvention of anti-cheat, authentication, CAPTCHA, connection quotas or moderation.
- A Mineflayer client running on the Galaxy A06 as a production requirement.
- A local language model on the phone.
- Paid hosted inference or a paid cloud coordinator.
- Direct AI execution of arbitrary JavaScript, shell commands, packet manipulation or unrestricted game actions.
- Guaranteeing that twenty bots can connect to one game server or be hosted on one device.

## 4. Runtime and implementation constraints

- Language: JavaScript, CommonJS modules, async/await and classes where they clarify ownership.
- Runtime: Node.js 24 or newer. The initial target must be tested on the user's Termux Node 24.17.0; Node 26 LTS compatibility should be included in CI where the project dependencies support it.
- Package installation: exact versions recorded in package-lock.json. No floating production dependency ranges.
- Game client: Mineflayer. Optional navigation and game plugins must be pinned and tested against the selected Mineflayer, minecraft-protocol, minecraft-data and server versions.
- Coordinator API: Express, with built-in HTTP(S), streams and Node APIs used where practical.
- Dashboard: vanilla HTML, CSS and JavaScript served by Express. Do not replace it with React or a frontend build system.
- Persistence: transactional SQLite behind a StateStore interface. Select the concrete SQLite driver only after it passes Termux and target-Node compatibility tests; see unresolved decisions.
- Worker transport: versioned HTTPS REST with bounded long polling for commands and event submissions. No mandatory message broker.
- Browser updates: Server-Sent Events (SSE) for dashboard snapshots and event summaries.
- Local CLI: Node CLI that calls the coordinator's local API; it does not open its own database connection.
- AI: Ollama on a separately controlled device, reachable only through a private LAN or VPN and protected network boundary.

## 5. Logical topology

There are three deployment roles:

1. **Master controller:** runs on the Galaxy A06. Hosts the coordinator, TaskManager, scheduler, worker registry/gateway, persistence, dashboard API, CLI API, chat-intent ingress, monitoring and Ollama client.
2. **Worker host:** runs on each authorised worker device. Hosts one WorkerHost process, one or more independent BotController instances, deterministic action modules and local snapshots. A worker host may be the same machine as the coordinator during isolated development, but this is not the default deployment.
3. **Remote Ollama host:** runs the selected model on a separate device. It receives compact task context and returns schema-constrained plans. It is never trusted to issue executable commands.

The number of workers is not the number of bot accounts. A worker host can own multiple bot sessions, with explicit per-host and global limits.

## 6. Shared interfaces

All three control interfaces must route through the same application service:

- Minecraft chat: an allowlisted player's prefixed command is converted to an IntentRequest and submitted to Coordinator.
- Dashboard: authenticated HTTP action is converted to an IntentRequest or operator action and submitted to Coordinator.
- Termux CLI: authenticated local API call is converted to the same application request.

No interface directly calls Mineflayer methods, writes task rows or edits progress totals.

## 7. Two-level intelligence

### Level 1 — deterministic execution and control

Owns movement, pathfinding, mining, crafting, building primitives, inventory operations, eating, tool selection, health checks, survival, task progress events, reconnection and safe cancellation. It uses local Mineflayer state and does not wait for an LLM for ordinary actions.

### Level 2 — remote strategic reasoning

Uses Ollama for natural-language interpretation, objective decomposition, dependencies, high-level parallelism hints, ambiguity detection and strategic replanning. It returns JSON constrained by the schemas in AI_PROTOCOL.md.

The coordinator validates every proposal, resolves registry identifiers, rejects impossible dependencies or unsafe bounds, and runs the deterministic scheduler. AI recommendations are advisory; policy, evidence and scheduling constraints override them.

## 8. Objective and assignment model

A task is a user-requested goal. A task contains one or more objectives. An objective has one aggregate target and optionally one or more dependencies. An assignment is a time-limited lease of a bounded portion of an objective to one bot.

For a quantity objective:

- targetQuantity is the task-wide target.
- verifiedQuantity is the authoritative amount already credited.
- reservedQuantity is the sum of active, unexpired, non-overlapping assignment quotas.
- remainingQuantity = max(0, targetQuantity - verifiedQuantity - reservedQuantity).
- The scheduler divides only remainingQuantity.
- The sum of newly created assignment quotas must equal remainingQuantity exactly.
- Assignment expiry, cancellation or worker loss releases only its unverified reservation after reconciliation.
- A stale assignment epoch cannot mutate a newer assignment.

For non-quantity objectives, the scheduler uses one assignment or an explicit spatial/role decomposition with disjoint work scopes.

## 9. Task lifecycle

Task states: queued, planning, ready, running, paused, blocked, completed, failed, cancelled.

Objective states: pending, ready, assigned, running, verifying, completed, blocked, failed, cancelled.

Assignment states: offered, accepted, running, reporting, verifying, completed, failed, revoked, expired.

All state changes occur through TaskManager transactions. Terminal states are immutable except for a specifically audited administrative correction event. Dependencies must be completed before dependent objectives become ready. Cyclic dependency graphs are rejected.

## 10. Verification and evidence

The worker submits an initial baseline snapshot when an assignment begins and subsequent bounded snapshots or action evidence. The coordinator credits only evidence consistent with the current assignment lease and objective verification policy.

For item acquisition, canonical item identity includes registry name plus relevant metadata/NBT fingerprint when relevant. Inventory counts are derived from Mineflayer inventory state; pickup events are hints and not sole proof. The default acquisition objective counts net newly acquired units after the assignment baseline, not pre-existing inventory. A task may explicitly allow existing stock, in which case the baseline policy is different and recorded.

For resource transfer, the ledger debits and credits through one transfer transaction with a unique transfer ID. For deposit objectives, both the bot's inventory decrease and destination container increase must be verified when the container is accessible. For crafting, the output inventory delta and recipe/action record are checked. For building, the requested block positions are checked against the loaded world state; unloaded or unavailable positions remain unverified. The full verification model is in TASK_ALLOCATION.md.

## 11. Failure and recovery

- Workers send a heartbeat every configured interval and reconnect with exponential backoff plus jitter.
- Worker state is alive, degraded, unreachable or disabled.
- Lost worker leases expire after a bounded grace period and are reconciled before reassignment.
- The coordinator persists transitions before acknowledging accepted commands.
- Messages are idempotent by message ID and worker sequence number.
- A recovered worker reports current bot identity, task lease, inventory snapshot and local execution checkpoint before receiving new work.
- The coordinator never repeats a non-idempotent action solely because an acknowledgement was lost. It first reconciles observed state.
- On bot death or disconnect, the bot controller stops movement, records a failure report and enters bounded reconnect logic. It does not create an independent replacement task.
- Reconnection must use legitimate account authentication already configured on the worker.

## 12. Security boundaries

Separate credentials and authorisation for:
- Human dashboard sessions.
- Local CLI access.
- Worker service identity.
- Minecraft account authentication.
- Ollama network access.

Store no plaintext credentials in source, logs, task plans or Ollama prompts. Worker credentials must be distinct, revocable and least-privilege. Minecraft credentials remain on the worker device. Do not expose the Ollama API directly to the public internet. Dashboard and worker transport require HTTPS over a private LAN/VPN. The complete controls are in SECURITY_PLAN.md.

## 13. Performance objectives

The phone is the coordinator, not a game simulation host. It should hold compact summaries, not chunks, entity graphs, pathfinding maps or Mineflayer bot objects for remote bots.

- Global maximum: 20 bot identities, hard rejected above this setting.
- Initial runtime setting: two bots; scale only after each stage's acceptance gate.
- Local phone bot slots: zero by default.
- AI inference concurrency: one by default; bounded queue.
- Dashboard: event-driven SSE, with coalesced summary updates; no high-frequency full-state polling.
- Memory and CPU budgets: measured on the actual device, not assumed from the 4 GB label.
- Caches, event buffers, SSE client queues and logs have explicit caps.
- Under memory pressure, stop accepting additional work, reduce telemetry and inference, preserve durable state, and allow workers to finish or safely pause.

PERFORMANCE_PLAN.md defines measurement and initial configurable starting caps.

## 14. Compatibility policy

The target Minecraft Java version, Mineflayer version, minecraft-protocol version, minecraft-data version, Node version and optional plugin versions form one tested compatibility tuple. Do not infer support from a package's current release number or from support for a nearby Minecraft version. A connection smoke test and core action tests must pass for each tuple before it is marked supported.

At project start, the exact game/server version and package versions are not fixed by this specification. The implementation must maintain a compatibility matrix in the repository and fail closed or require an explicit experimental flag for an untested tuple.

## 15. Required repository documents

- ARCHITECTURE.md — deployment and component topology.
- MODULE_INTERFACES.md — module ownership and APIs.
- TASK_ALLOCATION.md — scheduling, estimates, quotas and verification.
- AI_PROTOCOL.md — JSON schemas and Ollama contract.
- PERFORMANCE_PLAN.md — device budgets and benchmarks.
- SECURITY_PLAN.md — identities, transport, secrets and abuse controls.
- TEST_PLAN.md — test layers and scenarios.
- ACCEPTANCE_CRITERIA.md — release gates and unresolved decisions.

## 16. Decision log and unresolved choices

The following must remain visible until proven by tests or explicitly decided:

1. **Exact Minecraft Java version and server implementation:** user supplied target environment is private/authorised, but the version tuple is not stated in this master context. Resolve before dependency pinning.
2. **Mineflayer compatibility:** confirm support for the exact game protocol through an integration test. Never fabricate support for future or recent releases.
3. **SQLite driver:** choose between Node's built-in SQLite and a maintained package after checking stability, Node 24/26 compatibility, Android/Termux support, WAL behaviour and crash recovery. Keep StateStore independent of the driver.
4. **Worker placement:** specify which physical devices host the initial one- and two-bot stages. The phone remains coordinator-only by default.
5. **Server bot limit:** obtain explicit operator-approved connection cap; global project capacity of twenty does not override it.
6. **Online authentication method:** select supported legitimate Mineflayer auth mode and worker-local credential handling for the exact package version.
7. **Ollama model and host hardware:** select a free self-hosted model that passes schema adherence, planning quality and latency benchmarks. No paid fallback.
8. **Default task risk policy:** agree whether high-risk actions (lava, hostile areas, PvP zones, unknown blocks, building near other players) require operator confirmation.
9. **Chat authorisation:** configure allowed player UUIDs and command prefix per server.
10. **Dashboard human account provisioning and MFA:** choose initial administrator bootstrap process and recovery procedure.

A decision is closed only when recorded in a short ADR or an updated specification, with tests where relevant.

## 17. Source references

Verified against public documentation on 2026-11-09; package compatibility still requires project tests.

- Mineflayer API and event reference: https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- Mineflayer pathfinder interface and goals: https://github.com/PrismarineJS/mineflayer-pathfinder
- Ollama API and structured output format: https://github.com/ollama/ollama/blob/main/docs/api.md
- Node.js process memory measurements: https://nodejs.org/api/process.html
- Node.js releases: https://nodejs.org/en/about/previous-releases
- Node.js SQLite API and stability notes: https://nodejs.org/api/sqlite.html

