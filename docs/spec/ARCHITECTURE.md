# Architecture — Mineflayer AI Swarm

**Specification:** 1.0.0  
**Related:** MASTER_SPEC.md, MODULE_INTERFACES.md, AI_PROTOCOL.md

## 1. Deployment view

The Samsung Galaxy A06 is the single master controller. It owns durable task truth and makes allocation decisions. Remote worker hosts own Mineflayer connections and execute deterministic actions. A separate authorised device runs Ollama.

~~~mermaid
flowchart TB
  subgraph Interfaces
    CHAT[Minecraft chat adapter]
    WEB[Express API + vanilla dashboard]
    CLI[Termux CLI]
  end

  subgraph PHONE[Galaxy A06 — Master controller]
    AUTH[Authentication and policy]
    COORD[Coordinator / application service]
    TASK[Shared TaskManager]
    SCHED[Deterministic TaskScheduler]
    REG[Worker registry + lease manager]
    STORE[(SQLite StateStore)]
    MON[Resource monitor]
    SSE[Dashboard SSE]
    OCLIENT[Ollama client]
  end

  subgraph WORKERS[Authorised worker devices]
    W1[WorkerHost A]
    W2[WorkerHost B]
    BC1[BotController 1]
    BC2[BotController 2]
    BC3[BotController N]
    EXEC[Deterministic action modules]
  end

  subgraph AI[Private LAN / VPN]
    OLLAMA[Remote Ollama model]
  end

  CHAT --> COORD
  WEB --> AUTH --> COORD
  CLI --> AUTH
  CLI --> COORD
  COORD --> TASK
  TASK --> SCHED
  SCHED --> REG
  TASK <--> STORE
  REG <--> STORE
  MON --> COORD
  COORD --> SSE --> WEB
  COORD <--> OCLIENT <--> OLLAMA
  REG <-->|HTTPS: heartbeat, long poll, events| W1
  REG <-->|HTTPS: heartbeat, long poll, events| W2
  W1 --> BC1
  W1 --> BC2
  W2 --> BC3
  BC1 --> EXEC
  BC2 --> EXEC
  BC3 --> EXEC
~~~

## 2. Process ownership

### 2.1 Master process — phone

One Node.js CommonJS process runs:

- Express HTTP(S) server and API routes.
- Coordinator application service.
- TaskManager and TaskScheduler.
- WorkerRegistry, lease manager and WorkerGateway.
- AuthService and policy checks.
- StateStore connection.
- OllamaClient and bounded inference queue.
- ResourceMonitor and bounded telemetry.
- SSE publisher and dashboard assets.
- CLI API surface and chat-intent API surface.

Only this process can commit task, objective, lease or resource-ledger changes. There must be one active writer for the SQLite database. Do not run multiple coordinator replicas against the same local database.

### 2.2 Worker process — remote device

A WorkerHost process runs independently on each authorised device. It:

- Authenticates to the master using its own worker identity.
- Registers its configured bot identities.
- Sends heartbeats and capability summaries.
- Long-polls for bounded command batches.
- Creates and supervises one BotController per active bot session.
- Enforces local bot slot limits and server-specific configuration.
- Runs deterministic action modules.
- Emits sequenced evidence, completion and failure events.
- Maintains only bounded local checkpoints needed for safe reconnect.

A WorkerHost may supervise several BotControllers in one process. BotController state is isolated by bot ID; mutable bot state is never shared across controllers. Process-per-bot isolation is an optional later topology, not required for the first release.

### 2.3 Ollama process — separate device

Ollama runs on the user's own/controlled device, not on the Galaxy A06. It must be reachable only over a private LAN or VPN and protected by firewall/TLS or an authenticated reverse proxy. The coordinator sends a compact JSON context and a JSON Schema-constrained request. Ollama cannot call the coordinator, inspect the Minecraft world or dispatch work.

## 3. Communication paths

### 3.1 Interface-to-coordinator

- Dashboard requests: authenticated HTTPS REST to Express.
- Dashboard live view: authenticated SSE stream. Events are summaries, not complete bot world state.
- CLI: loopback API request with a dedicated local operator credential. It does not write the database.
- Minecraft chat: WorkerHost forwards only allowlisted, prefixed command intents with sender UUID, server ID and message ID. Coordinator verifies the allowlist and parses an explicit command grammar. Chat is never an unauthenticated admin channel.

All ingress paths call the same Coordinator methods: submitIntent, pauseTask, resumeTask, cancelTask, inspectStatus and controlBot (only for allowlisted safe controls).

### 3.2 Coordinator-to-worker

Use versioned HTTPS REST and one outstanding long-poll request per worker host:

1. Worker authenticates and registers.
2. Worker posts a heartbeat and compact capability snapshot.
3. Worker calls the command endpoint with its last accepted sequence and waits for up to the configured long-poll duration.
4. Coordinator returns a bounded command batch, or an empty response on timeout.
5. Worker acknowledges command acceptance before execution.
6. Worker submits progress/evidence/failure events with unique message IDs and monotonic per-worker sequence numbers.
7. Coordinator deduplicates, validates lease epoch and writes durable changes before returning success.

Long polling avoids a mandatory broker and avoids constant rapid polling. HTTP keep-alive may be enabled. Workers reconnect with exponential backoff and jitter. Commands are leases with expiry and fencing epochs; they are not fire-and-forget messages.

### 3.3 Worker-to-coordinator event flow

~~~mermaid
sequenceDiagram
  participant W as WorkerHost
  participant G as WorkerGateway
  participant T as TaskManager
  participant DB as StateStore
  W->>G: heartbeat + capabilities
  G->>DB: persist worker status
  W->>G: long-poll(nextSequence)
  G->>T: request eligible leased commands
  T->>DB: commit offer/lease
  DB-->>T: committed
  T-->>G: command envelope
  G-->>W: command
  W->>G: accepted(commandId, epoch)
  G->>T: acknowledge lease
  W->>W: execute deterministic action
  W->>G: event(evidence, seq, lease)
  G->>T: verify evidence and deduplicate
  T->>DB: ledger + state transaction
  DB-->>T: committed
  T-->>G: accepted / rejected
  G-->>W: event acknowledgement
~~~

## 4. Task execution flow

1. An interface submits a natural-language objective.
2. Coordinator authenticates the actor, applies rate and policy limits, creates a task record and stores the original bounded text.
3. ReasoningEngine asks Ollama for a typed objective DAG when the task is complex or ambiguous. Simple commands may use deterministic intent templates.
4. SchemaValidator validates the response. Semantic validation resolves item/block IDs using the worker/server registry, checks quantities, bounds, dependencies and risk.
5. TaskManager stores objectives and dependency edges.
6. TaskScheduler takes current worker capabilities, resource snapshots, measured rates, travel estimates, server limits and active assignments.
7. Scheduler enumerates candidate bot subsets and work partitions. It chooses the smallest subset with a material measured benefit.
8. TaskManager creates non-overlapping leases and quota reservations transactionally.
9. WorkerGateway offers assignments to workers.
10. BotController verifies preconditions, snapshots baseline, executes deterministic actions, and reports evidence.
11. TaskManager reconciles evidence and updates the aggregate ledger.
12. A dependent objective becomes ready only after all prerequisite objectives are verified complete.
13. Task completes only when all required objectives are verified complete.

~~~mermaid
flowchart TD
  A[Intent arrives] --> B[Authenticate and validate]
  B --> C{Simple and unambiguous?}
  C -- Yes --> D[Deterministic intent template]
  C -- No --> E[Remote Ollama plan]
  E --> F[Schema and semantic validation]
  D --> F
  F --> G[Persist objective DAG]
  G --> H[Estimate candidate assignments]
  H --> I[Choose subset and quotas]
  I --> J[Commit leases]
  J --> K[Worker executes]
  K --> L[Evidence submitted]
  L --> M[Verify and update ledger]
  M --> N{Objective complete?}
  N -- No --> H
  N -- Yes --> O[Unlock dependent objectives]
  O --> P{All objectives complete?}
  P -- No --> H
  P -- Yes --> Q[Complete task]
~~~

## 5. State ownership

| State | Authoritative owner | Replicated where |
|---|---|---|
| User tasks and intent | TaskManager | Dashboard summaries |
| Objective DAG | TaskManager | Worker gets only assigned objective details |
| Assignment leases and epochs | TaskManager | Current worker lease |
| Worker registration/status | WorkerRegistry | Dashboard summary |
| Bot game session | BotController on worker | Compact heartbeat snapshot |
| Raw nearby entities/chunks | Mineflayer worker only | Never copied to master by default |
| Inventory snapshot | BotController observation | Compact item counts sent to master |
| Verified resource ledger | TaskManager | Dashboard totals |
| Strategic plan proposal | ReasoningEngine response | Persist schema-valid plan and version |
| AI model/session state | Ollama host | Not required on phone |
| Runtime metrics | ResourceMonitor | Bounded recent summary |

Workers may cache their own observations, but they may not decide that a shared task is complete. The master does not maintain a second copy of the full Minecraft world.

## 6. Persistence model

SQLite is the initial durable store, behind a StateStore interface:

- users and role/permission records;
- workers and credential hashes;
- bot registrations and server profiles;
- tasks, objectives and dependency edges;
- assignments, leases, epochs and quotas;
- worker event deduplication watermarks;
- evidence records and resource ledger transactions;
- measured action rates and travel samples;
- audit events and configuration versions.

State transitions and their event records are committed atomically. Store schema version and use forward-only migrations with a tested backup/restore path. Use WAL only after verifying it on the target Android filesystem. The driver choice remains an explicit decision; never assume an SQLite native package works in Termux.

Operational logs and dashboard telemetry are not the source of truth and must be bounded.

## 7. Network/API shape

All application APIs are under /api/v1. Worker endpoints are separately namespaced under /worker/v1. Each request has:

- protocol version;
- message/request ID;
- authenticated principal;
- server receive timestamp;
- bounded JSON body;
- schema validation;
- idempotency/deduplication policy.

Proposed worker endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /worker/v1/register | Bootstrap and register worker host |
| POST | /worker/v1/heartbeat | Liveness and compact capability update |
| GET | /worker/v1/commands?after_seq=&wait_ms= | Long poll for commands |
| POST | /worker/v1/commands/ack | Accept/reject offered lease |
| POST | /worker/v1/events | Submit sequenced event batch |
| POST | /worker/v1/snapshots | Submit compact inventory/status snapshot |
| POST | /worker/v1/unregister | Graceful worker shutdown |

The worker API is not the human dashboard API. Worker credentials cannot log in to the dashboard or invoke administrative routes.

Dashboard endpoints are authenticated separately:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/session | Current human principal |
| POST | /api/v1/tasks | Submit intent |
| GET | /api/v1/tasks | List task summaries |
| GET | /api/v1/tasks/:id | Task and objective detail |
| POST | /api/v1/tasks/:id/pause | Pause task safely |
| POST | /api/v1/tasks/:id/resume | Resume task |
| POST | /api/v1/tasks/:id/cancel | Cancel task |
| GET | /api/v1/workers | Worker summaries |
| GET | /api/v1/events | SSE dashboard stream |
| POST | /api/v1/bots/:id/safe-stop | Request controlled stop |

CLI commands call these same endpoints. Routes are illustrative contracts and must be captured in an OpenAPI file during implementation.

## 8. Dashboard

The dashboard is a light Express-served vanilla HTML/CSS/JS application. It displays:

- coordinator health and memory/CPU;
- registered workers and heartbeat age;
- bots and connection status;
- tasks, objectives, aggregate verified/target quantities;
- assignment state, quota and lease expiry;
- recent warnings/failures and audit actions;
- Ollama reachable/unavailable status and last inference duration.

It does not display or expose raw credentials, complete world state, private auth data or unbounded logs. SSE events are coalesced and client queues are capped. If a browser disconnects, it reconnects and obtains a fresh compact snapshot.

## 9. CLI

The CLI is a thin authenticated client. It must support at least:

- status;
- workers list;
- bots list;
- task submit <natural-language objective>;
- task show <id>;
- task pause/resume/cancel <id>;
- bot safe-stop <id>;
- diagnostics;
- version and compatibility report.

CLI and dashboard do not have different business logic. CLI authentication uses a local token or OS-protected credential file, never a Minecraft account password.

## 10. Chat interface

The chat adapter accepts a single configured prefix and strict allowlist. It ignores bot-originated messages and messages from users not mapped to an authorised player UUID. It supports a small command grammar such as help, status, task, pause, resume and cancel. Natural-language text is accepted only after the sender has passed authorization and coordinator rate limits. The adapter responds with short status identifiers and never reveals tokens, internal file paths or private configuration.

## 11. Failure domains

| Failure | Expected containment |
|---|---|
| Ollama down | Deterministic parser/planner continues for supported tasks; complex ambiguous task is marked needs-clarification or queued |
| Worker down | Worker marked unreachable; lease grace expires; evidence reconciled before reassignment |
| One bot disconnects | Only its BotController and assignment are affected |
| Master restarts | SQLite restores tasks, leases and event watermarks; worker re-registration reconciles state |
| Dashboard disconnects | No task execution impact |
| CLI exits | No task execution impact |
| Bad AI schema | Proposal rejected; no assignment created |
| DB unavailable | Coordinator enters read-only/safe-stop mode; no new leases |
| Memory pressure | Stop accepting work, reduce telemetry and inference, pause safe tasks if thresholds require |
| Server rejects login | No auth bypass; classify reason and wait/operator action |

## 12. Scaling model

| Stage | Bots | Worker topology | Gate |
|---|---:|---|---|
| 0 | 0 | Coordinator and fake worker | API, persistence, scheduler and recovery tests |
| 1 | 1 | One authorised worker host | Full one-bot acceptance suite |
| 2 | 2 | One or two worker hosts | Shared objective, concurrency and failure tests |
| 3 | 5 | Multiple authorised hosts | Load, server limit and resource budgets |
| 4 | 10 | Multiple authorised hosts | Fault injection and recovery |
| 5 | 20 | Multiple authorised hosts | Full soak, security and aggregate verification gates |

Global capacity must be configured no higher than 20. Each worker host and Minecraft server has a lower independently configured capacity. A stage is not approved merely because bots can connect; all task correctness and resource gates must pass.

## 13. Observability

Use structured logs with correlation fields: taskId, objectiveId, assignmentId, workerId, botId and messageId. Do not log secrets or full chat conversations by default. Metrics include worker heartbeat age, queue depth, inference latency/timeout, assignment latency, task ETA error, verified progress, stale events, reconnect count, RSS, heap, external memory, system available memory and event-loop lag.

The ResourceMonitor samples at a configured low frequency and never scans world data. It records a rolling bounded window only.

