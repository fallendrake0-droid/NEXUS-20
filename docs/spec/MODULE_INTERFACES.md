# Module Interfaces & DTO Contracts — Mineflayer AI Swarm

**Document:** `docs/spec/MODULE_INTERFACES.md`  
**Specification version:** 1.1.0  
**Language:** CommonJS JavaScript (`'use strict'`, `async`/`await`)  
**Rule:** Every module has a single owner directory. Modules pass immutable JSON-serializable DTOs and never mutate another module's internal state or serialize raw Mineflayer `Bot`, `World`, `Chunk`, `Entity`, `Item`, `Block`, `Vec3` or `Buffer` instances across boundaries.

---

## 1. Shared DTO Dictionary

Coding agents **must** use these exact property names across modules:

- **`ActorPrincipal`**:
  `{ principalId: string, actorType: 'human'|'cli'|'chat'|'worker'|'system', role: 'viewer'|'operator'|'admin'|'worker'|'chat_allowed', serverId: string|null }`
- **`IntentRequest`**:
  `{ requestId: string, idempotencyKey: string, actor: ActorPrincipal, source: 'dashboard'|'cli'|'chat', text: string, allowExistingStock: boolean, priority: 'survival'|'safety'|'high'|'normal'|'low' }`
- **`TaskSummary`**:
  `{ taskId: string, state: string, intentSummary: string, priority: string, riskLevel: 'low'|'medium'|'high', objectiveCount: number, completedObjectiveCount: number, createdAt: string, updatedAt: string }`
- **`ObjectiveDTO`**:
  `{ objectiveId: string, taskId: string, localId: string, kind: string, resourceId: string|null, targetQuantity: number|null, verifiedQuantity: number, reservedQuantity: number, remainingQuantity: number|null, regionLabel: string|null, description: string, dependencies: string[], parallelism: string, workerCountHint: number, verificationPolicy: string, allocationEpoch: number, state: string, version: number }`
- **`TaskDetail`**:
  `TaskSummary & { rawText: string, planVersion: number, clarificationQuestion: string|null, objectives: ObjectiveDTO[], activeAssignments: AssignmentDTO[] }`
- **`AssignmentDTO`**:
  Matches `BotAssignmentV1` (`AI_PROTOCOL.md` §5) plus `{ state: string, creditedQuantity: number }`.
- **`BotSnapshot`** (produced by `CompactSnapshotCodec.toCompactBotSnapshot`):
  `{ botId: string, status: 'ready'|'busy'|'degraded'|'disconnected', dimension: string, position: { x: number, y: number, z: number }|null, health: number|null, food: number|null, healthBand: 'critical'|'low'|'normal'|'unknown', foodBand: 'critical'|'low'|'normal'|'unknown', occupiedSlots: number, activeTool: { name: string, durabilityBand: string }|null, itemCounts: Record<string, number> }`
- **`InventorySnapshot`**:
  `{ botId: string, capturedAt: string, itemCounts: Record<string, number>, heldTool: { itemKey: string, remainingDurability: number|null }|null }`
- **`BotCapabilities`**:
  `{ botId: string, workerId: string, serverId: string, connected: boolean, spawned: boolean, dimension: string, position: { x: number, y: number, z: number }|null, healthBand: string, foodBand: string, freeSlotEstimate: number, toolClasses: Record<string, { tier: string, remainingDurability: number|null }>, supportedActions: string[], telemetryAgeMs: number }`
- **`RateEstimate`**:
  `{ actionKey: string, sampleCount: number, p50UnitsPerSec: number|null, p10UnitsPerSec: number|null, confidence: 'none'|'low'|'medium'|'high', isPrior: boolean }`
- **`Estimate`**:
  `{ botId: string, eligible: boolean, rejectionCode: string|null, travelSecP50: number|null, travelSecP90: number|null, setupSec: number, workSecP50: number|null, workSecP90: number|null, returnSec: number, riskSec: number, totalSecP50: number|null, totalSecP90: number|null, varianceSec2: number, confidence: 'none'|'low'|'medium'|'high' }`
- **`Quota`**:
  `{ botId: string, workerId: string, quantity: number|null, partitionId: string|null, regionBounds: { minX: number, maxX: number, minZ: number, maxZ: number }|null, role: string|null }`
- **`AllocationDecision`**:
  `{ objectiveId: string, allocationEpoch: number, feasible: boolean, blockedReason: string|null, selectedCount: number, quotas: Quota[], singleBotP90Sec: number|null, selectedSubsetP90Sec: number|null, relativeGain: number, coordinationSec: number, contentionSec: number, rejectedCandidates: Array<{ botId: string, code: string }>, reason: string }`
- **`VerificationResult`**:
  `{ valid: boolean, creditableDelta: number, rejectionCode: string|null, disputed: boolean, canonicalItemKey: string|null }`
- **`LedgerReceipt`**:
  `{ transactionId: string, evidenceId: string, objectiveId: string, assignmentId: string, creditedDelta: number, newVerifiedQuantity: number, remainingQuantity: number|null, objectiveCompleted: boolean }`

---

## 2. Module Ownership Inventory

| Module | File Path | Process | Status |
|---|---|---|---|
| Master bootstrap | `src/master/createMaster.js` | Phone | Specified |
| Config loader | `src/config/loadConfig.js` | Phone & Worker | Specified |
| Coordinator | `src/coordinator/Coordinator.js` | Phone | Specified |
| TaskManager | `src/tasks/TaskManager.js` | Phone | Specified |
| TaskScheduler | `src/scheduler/TaskScheduler.js` | Phone | Specified |
| InventoryLedger | `src/inventory/InventoryLedger.js` | Phone | Specified |
| WorkerRegistry | `src/workers/WorkerRegistry.js` | Phone | Specified |
| WorkerGateway | `src/workers/WorkerGateway.js` | Phone | Specified |
| WorkerHost | `src/worker/WorkerHost.js` | Worker | Specified |
| BotController | `src/bots/BotController.js` | Worker | Specified |
| ActionExecutor | `src/actions/ActionExecutor.js` | Worker | Specified |
| CapabilityProfiler | `src/bots/CapabilityProfiler.js` | Worker & Phone | Specified |
| ReasoningEngine | `src/ai/ReasoningEngine.js` | Phone | Specified |
| OllamaClient | `src/ai/OllamaClient.js` | Phone | Specified |
| SchemaValidator | `src/protocol/SchemaValidator.js` | Phone & Worker | Specified |
| StateStore | `src/persistence/StateStore.js` | Phone | Specified |
| AuthService | `src/security/AuthService.js` | Phone | Specified |
| DashboardServer | `src/dashboard/createDashboard.js` | Phone | Specified |
| CLI | `src/cli/commands.js` | Termux CLI | Specified |
| ChatCommandAdapter | `src/chat/ChatCommandAdapter.js` | Worker + Phone | Specified |
| ResourceMonitor | `src/monitoring/ResourceMonitor.js` | Phone & Worker | **Implemented on `main`** |
| WorkloadGovernor | `src/monitoring/WorkloadGovernor.js` | Phone | **Implemented on `main`** |
| EventBus | `src/events/EventBus.js` | Per-process | **Implemented on `main`** |
| Low-memory primitives | `src/performance/*.js` | Phone & Worker | **Implemented on `main`** (must reuse; do not duplicate) |

---

## 3. Module Contracts

### 3.1 Master Bootstrap (`src/master/createMaster.js`)
- **Responsibilities:** Validate configuration before binding sockets; acquire single-writer lock on `StateStore`; wire `TimerRegistry`, `ResourceMonitor`, `WorkloadGovernor`, `EventBus`, `BoundedLogger`, `AuthService`, `InventoryLedger`, `TaskManager`, `TaskScheduler`, `AiEfficiencyController`, `ReasoningEngine`, `WorkerRegistry`, `WorkerGateway`, `Coordinator`, `SseCoalescer` and `DashboardServer`; run `Coordinator.recover()` before accepting worker commands; perform ordered graceful shutdown.
- **Inputs:** `{ config: Config, dependencies?: Partial<MasterDependencies> }`.
- **Outputs:** `MasterRuntime` (`{ start, stop, health, address }`).
- **Public methods:**
  - `createMaster(config, dependencies): MasterRuntime`
  - `runtime.start(): Promise<{ host: string, port: number }>`
  - `runtime.stop({ graceMs?: number }): Promise<void>`
  - `runtime.health(): Promise<MasterHealth>`
- **Events:** `master.started`, `master.recovered`, `master.stopping`, `master.stopped`.
- **Failure behaviour:** Invalid config or failed DB migration aborts before opening network ports; partial startup tears down opened resources in reverse order; shutdown timeout closes sockets and leaves unfinished leases to expire cleanly via DB timestamps (never marking them complete).

### 3.2 Config Loader (`src/config/loadConfig.js`)
- **Responsibilities:** Parse env vars + config file into deeply frozen `Config`; enforce `globalMaxBots <= 20`, TLS rules, non-local/non-paid Ollama URL rules and timeout inequalities; redact secrets for diagnostics.
- **Inputs:** `(env: Record<string, string|undefined>, fileConfig?: object)`.
- **Outputs:** Frozen `Config` or `ValidationResult` (`{ valid: boolean, errors: string[] }`).
- **Public methods:**
  - `loadConfig(env, fileConfig): Config`
  - `validateConfig(rawConfig): ValidationResult`
  - `redactConfig(config): SafeConfig`
- **Events:** `config.loaded`, `config.invalid`.
- **Failure behaviour:** Throws `DomainError('SCHEMA_VALIDATION_FAILED' | 'AI_POLICY_VIOLATION')` on unknown keys, `globalMaxBots > 20`, non-loopback HTTP without TLS, or forbidden AI endpoints. Never logs raw secret values.

### 3.3 Coordinator (`src/coordinator/Coordinator.js`)
- **Responsibilities:** Single application use-case boundary shared by Dashboard, CLI, Chat and WorkerGateway; enforce authorization, idempotency and `WorkloadGovernor.classifyWork(...)`; orchestrate `ReasoningEngine` -> `TaskManager` -> `TaskScheduler` -> `SseCoalescer`.
- **Inputs:** Authenticated `ActorPrincipal` or `AuthenticatedWorker` plus validated request DTOs.
- **Outputs:** `TaskSummary`, `TaskDetail`, `SystemStatus`, `CommandReceipt`, `EventAck`, `HeartbeatAck`, `RecoveryReport`.
- **Public methods:**
  - `submitIntent(intentRequest: IntentRequest): Promise<TaskSummary>`
  - `clarifyTask({ actor, taskId, answerText, idempotencyKey }): Promise<TaskSummary>`
  - `pauseTask({ actor, taskId, reason, idempotencyKey }): Promise<TaskSummary>`
  - `resumeTask({ actor, taskId, idempotencyKey }): Promise<TaskSummary>`
  - `cancelTask({ actor, taskId, reason, idempotencyKey }): Promise<TaskSummary>`
  - `getTask({ actor, taskId }): Promise<TaskDetail>`
  - `listTasks({ actor, state?, limit?, cursor? }): Promise<{ items: TaskSummary[], nextCursor: string|null }>`
  - `getSystemStatus({ actor }): Promise<SystemStatus>`
  - `safeStopBot({ actor, botId, idempotencyKey }): Promise<CommandReceipt>`
  - `handleWorkerHeartbeat(authWorker, heartbeatDto): Promise<HeartbeatAck>`
  - `handleWorkerEventBatch(authWorker, events): Promise<EventAck[]>`
  - `recover(): Promise<RecoveryReport>`
- **Events (published via `EventBus` AFTER durable SQLite commit):** `task.created`, `task.updated`, `task.completed`, `task.failed`, `task.cancelled`, `objective.ready`, `objective.completed`, `objective.blocked`, `assignment.offered`, `assignment.accepted`, `assignment.expired`, `worker.connected`, `worker.degraded`, `worker.unreachable`, `resource.pressure`, `system.safe_mode`.
- **Failure behaviour:** `StateStore` failure switches Coordinator into read-only safe mode (`PERSISTENCE_ERROR`) and halts new lease offers; `WorkloadGovernor` pressure pauses/defers low-priority tasks (`paused_and_queued`, never dropped) while preserving `survival`/`safety` actions; AI failure degrades gracefully to deterministic templates or `clarification_required`.

### 3.4 TaskManager (`src/tasks/TaskManager.js`)
- **Responsibilities:** Authoritative state machine and lease manager; validate acyclic objective DAGs; commit non-overlapping quota reservations; enforce `verified + reserved <= target`; deduplicate worker sequences/message IDs; fence stale `allocationEpoch`s; delegate delta proof checks to `InventoryLedger`.
- **Inputs:** Validated `TaskPlanV1`, `AllocationDecision`, `AuthenticatedWorker` acks/events/checkpoints.
- **Outputs:** `TaskDetail`, `TaskSummary[]`, `ObjectiveDTO[]`, `AssignmentDTO[]`, `EventAck`, `ExpiredLease[]`, `ReconciliationResult`.
- **Public methods:**
  - `createTask({ taskId, idempotencyKey, actorId, source, rawText, priority }): Promise<TaskDetail>`
  - `attachPlan({ taskId, plan, expectedVersion }): Promise<TaskDetail>`
  - `getTask(taskId): Promise<TaskDetail>`
  - `listTasks({ state?, limit?, cursor? }): Promise<{ items: TaskSummary[], nextCursor: string|null }>`
  - `readyObjectives(taskId): Promise<ObjectiveDTO[]>`
  - `commitAssignments({ objectiveId, allocationEpoch, quotas, expectedVersion, leaseDurationMs }): Promise<AssignmentDTO[]>`
  - `acknowledgeAssignment({ workerId, commandId, assignmentId, leaseId, allocationEpoch, decision, rejectionCode, baselineSnapshot }): Promise<{ status: string }>`
  - `applyWorkerEvent(workerId, eventEnvelope): Promise<EventAck>`
  - `pauseTask(taskId, reason): Promise<TaskSummary>`
  - `resumeTask(taskId): Promise<TaskSummary>`
  - `cancelTask(taskId, reason): Promise<TaskSummary>`
  - `expireLeases(nowIso): Promise<ExpiredLease[]>`
  - `reconcileWorker(workerId, snapshotPayload): Promise<ReconciliationResult>`
- **Events:** `ledger.credited`, `lease.fenced`, `objective.unlocked`.
- **Failure behaviour:** Version mismatch throws `CONFLICT`; stale epoch returns `{ status: 'rejected', rejectionCode: 'STALE_ALLOCATION_EPOCH' }`; duplicate `messageId` returns cached prior ack without re-applying side effects; invalid evidence records audit rejection with zero credit.

### 3.5 TaskScheduler (`src/scheduler/TaskScheduler.js`)
- **Responsibilities:** Deterministic participant selection and work partitioning (`TASK_ALLOCATION.md`); evaluate hard feasibility; compute `p50`/`p90` makespans including travel, setup, coordination, contention and delivery; apply marginal-benefit & confidence gate favouring 1 bot when extra bots give `< 10%` net improvement; split aggregate remaining quantities via largest-remainder rounding; partition spatial exploration sectors; persist `scheduler_decisions`.
- **Inputs:** `{ objective: ObjectiveDTO, candidates: BotCapabilities[], rateLookup, capacity: CapacityContext, policy: SchedulerPolicy }`.
- **Outputs:** `Estimate`, `AllocationDecision`, `Quota[]`, `ScheduleResult`.
- **Public methods:**
  - `estimateCandidate({ objective, candidate, rateEstimate, worldSummary }): Estimate`
  - `chooseParticipants({ objective, candidates, rateLookup, capacity, policy }): AllocationDecision`
  - `splitQuota(remainingQuantity, weightedCandidates): Quota[]`
  - `partitionRegion(regionSpec, selectedCandidates): Quota[]`
  - `scheduleReadyObjectives(taskId): Promise<ScheduleResult>`
- **Events:** `allocation.proposed`, `allocation.committed`, `allocation.blocked`.
- **Failure behaviour:** Zero eligible candidates leaves objective `blocked` with typed per-bot rejection reasons (never crashes); missing rate data marks `confidence: 'low'` and biases toward 1 bot; respects `WorkloadGovernor.getDirectives().maxCandidateSubsetSearch` (`8 -> 3 -> 1`) under pressure.

### 3.6 InventoryLedger (`src/inventory/InventoryLedger.js`)
- **Responsibilities:** Canonicalize item keys (`namespace:item` + variant discriminator when requested); compute inventory/container deltas relative to assignment baseline; enforce all 7 verification policies; execute atomic two-sided transfers (`transferId`); prevent double-counting across bots or crafting inputs/outputs.
- **Inputs:** `InventorySnapshot` pairs, `ObjectiveDTO`, `AssignmentDTO`, `TaskCompletionReportV1` evidence items.
- **Outputs:** Canonical `string`, `InventoryDelta[]`, `VerificationResult`, `LedgerReceipt`, `Balance`.
- **Public methods:**
  - `canonicalItemKey(itemDescriptor): string`
  - `diff(beforeSnapshot, afterSnapshot): Array<{ itemKey: string, before: number, after: number, netDelta: number }>`
  - `verifyEvidence({ objective, assignment, baselineSnapshot, evidenceItem, priorCredited }): VerificationResult`
  - `recordVerifiedCredit(txContext): LedgerReceipt` *(called inside `StateStore.transaction`)*
  - `recordVerifiedTransfer(txContext): LedgerReceipt`
  - `getObjectiveBalance(objectiveId): Promise<{ target: number|null, verified: number, reserved: number, remaining: number|null }>`
- **Events:** `inventory.verified`, `inventory.disputed`.
- **Failure behaviour:** Missing baseline or mismatched item variant returns `{ valid: false, creditableDelta: 0, disputed: true, rejectionCode }`; credit is hard-clamped to `min(assignment.quota - assignment.credited, objective.target - objective.verified)`.

### 3.7 WorkerRegistry & WorkerGateway (`src/workers/`)
- **Responsibilities:** Bootstrap registration, SHA-256 token verification (`crypto.timingSafeEqual`), worker liveness sweeps, per-host & per-server bot slot tracking, one-outstanding-long-poll-per-worker command delivery, payload size & schema checks.
- **Inputs:** HTTP `/worker/v1/*` requests, `bootstrapToken` / `workerToken`, `BotSnapshot[]`.
- **Outputs:** `WorkerCredential`, `WorkerSummary[]`, `BotCapabilities[]`, `CommandEnvelopeV1[]`, `EventAck[]`.
- **Public methods (`WorkerRegistry`):** `createBootstrapToken({ createdBy, ttlMs })`, `register({ bootstrapToken, workerInfo })`, `verifyWorkerToken(workerId, rawToken)`, `revoke(workerId, reason)`, `heartbeat(workerId, payload)`, `sweepLiveness(nowIso)`, `eligibleBots(filter)`, `listWorkers()`.
- **Public methods (`WorkerGateway`):** `createRouter()`, `enqueueCommand(workerId, commandEnvelope)`, `offerCommands(workerId, afterSeq, waitMs)`, `acknowledgeCommand(workerId, ack)`, `acceptEvents(workerId, batch)`, `acceptSnapshots(workerId, payload)`.
- **Events:** `worker.registered`, `worker.revoked`, `worker.degraded`, `worker.unreachable`, `command.dispatched`.
- **Failure behaviour:** Invalid token increments rate-limiter and returns `401 UNAUTHENTICATED`; second concurrent long-poll from same `workerId` aborts older poll cleanly (`200` empty commands); oversize or out-of-order batch returns `400 SCHEMA_VALIDATION_FAILED`.

### 3.8 WorkerHost (`src/worker/WorkerHost.js`)
- **Responsibilities:** Authenticate to Master; supervise `1..maxBotSlots` `BotController` instances; share a single immutable `minecraft-data` instance per protocol tuple across local bots; run heartbeat and long-poll loops with exponential backoff + full jitter; buffer outbound events in `BoundedByteQueue` (`pause_and_checkpoint` on overflow); halt active bot actions immediately if a lease expires while offline.
- **Inputs:** Worker `Config`, `CommandEnvelopeV1` batches, local `BotController` events.
- **Outputs:** `WorkerStatus`, sequenced `/worker/v1/*` payloads, atomic local checkpoint JSON.
- **Public methods:** `start()`, `stop({ graceMs })`, `register()`, `heartbeat()`, `pollCommandsLoop()`, `acknowledge(commandId, result)`, `enqueueEvent(event)`, `getLocalStatus()`, `reconcileOnReconnect()`.
- **Events:** `worker.ready`, `worker.disconnected`, `worker.paused_backpressure`, `bot.ready`, `bot.failed`, `command.received`, `command.completed`.
- **Failure behaviour:** `401`/`403` (revoked credential) immediately triggers `safeStop` on all local `BotController`s and halts reconnect loops; network unreachable triggers jittered backoff (`500ms -> 30s`) while enforcing local lease-expiry stop deadlines.

### 3.9 BotController & ActionExecutor (`src/bots/BotController.js`, `src/actions/ActionExecutor.js`)
- **Responsibilities:** Own one Mineflayer client (`viewDistance: 4` default); attach event listeners exclusively via `ScopedListeners`; filter chat via `ChatHistoryGuard`; execute allowlisted deterministic actions (`mine`, `collect`, `craft`, `build`, `explore`, `guard`, `transfer`, `repair`, `inspect`, `eat_survival`) using `PathfindingGuard` and `BlockSearchCache`; capture before/after `InventorySnapshot`s via `CompactSnapshotCodec`.
- **Inputs:** `BotConfig` (worker-local auth), `BotAssignmentV1`, `AbortSignal`.
- **Outputs:** `BotSnapshot` (compact), `InventorySnapshot`, `ExecutionReport`, `FailureReportV1`.
- **Public methods (`BotController`):** `connect()`, `disconnect(reason)`, `executeAssignment(assignment)`, `cancelAssignment(assignmentId, reason)`, `safeStop(reason)`, `snapshot()`, `inventorySnapshot()`, `capabilities()`, `healthCheck()`.
- **Public methods (`ActionExecutor`):** `canExecute(actionType, assignment, snapshot)`, `execute(assignment, botContext, signal)`, `cancel(assignmentId, reason)`.
- **Events:** `bot.spawned`, `bot.died`, `bot.kicked`, `bot.disconnected`, `bot.survival_triggered`, `assignment.progress`, `assignment.finished`.
- **Failure behaviour:** Unknown `actionType` fails closed (`ACTION_UNSUPPORTED`); death/disconnect/critical-health aborts active movement & digging immediately, disposes `ScopedListeners`, emits `FailureReportV1` (`safeState: 'stopped' | 'disconnected'`), and applies rate-limited reconnect rules (never bypassing server bans/kicks or auth errors).

### 3.10 CapabilityProfiler (`src/bots/CapabilityProfiler.js`)
- **Responsibilities:** Compute `BotCapabilities` from compact snapshots; maintain exponentially time-decayed rate distributions (`action_rate_samples`) segmented by `(serverId, dimension, actionKey, toolClass)`.
- **Inputs:** `BotSnapshot`, `ActionSample` (`{ serverId, dimension, actionKey, toolClass, botId, unitsCompleted, durationSec, observedAt }`).
- **Outputs:** `BotCapabilities`, `RateEstimate`.
- **Public methods:** `deriveCapabilities(botSnapshot, workerMeta)`, `recordSample(sample)`, `getRateEstimate({ serverId, dimension, actionKey, toolClass, botId })`, `decayStaleMeasurements(nowMs)`.
- **Events:** `capability.updated`.
- **Failure behaviour:** Zero samples returns `{ p50UnitsPerSec: conservativePrior, p10UnitsPerSec: conservativePrior * 0.5, confidence: 'none', isPrior: true }` — never fabricates high-confidence rates.

### 3.11 ReasoningEngine, AiEfficiencyController & OllamaClient (`src/ai/`, `src/performance/AiEfficiencyController.js`)
- **Responsibilities:** Delegate intent planning through the implemented `AiEfficiencyController` pipeline: (1) deterministic fast-path templates (`0` LLM calls for supported commands), (2) `BoundedCache` lookup, (3) in-flight fingerprint deduplication & per-task replan supersession abort, (4) `WorkloadGovernor` admission check, (5) `1` active + `3` waiting concurrency gate, (6) `OllamaClient` `POST /api/chat` (`stream: false`, `format: TASK_PLAN_V1_SCHEMA`, `AbortController` timeout), (7) `SchemaValidator` + DAG validation, (8) deterministic fallback (`clarificationRequired: true` for complex unsupported intents when AI is down).
- **Inputs:** `{ requestId, taskId?, userText, compactContext }` or `ReplanRequestV1`.
- **Outputs:** Validated `TaskPlanV1` + `{ source: string, llmCalled: boolean }`.
- **Public methods (`ReasoningEngine`):** `createPlan(params)`, `replan(replanRequest)`, `shouldUseAI(userText, options)`, `fallbackPlan(requestId, userText)`.
- **Public methods (`OllamaClient`):** `health()`, `generateStructured({ model, schema, systemPrompt, userPayload, timeoutMs, signal })`, `abort(requestId)`.
- **Events:** `ai.plan_created`, `ai.fallback_used`, `ai.validation_failed`.
- **Failure behaviour:** Rejects phone-local (`127.0.0.1`/`localhost`) and paid cloud URLs at construction (`AI_LOCAL_HOST_FORBIDDEN` / `AI_PAID_PROVIDER_FORBIDDEN`); retries at most once on transient socket error; **never** retries invalid model JSON schemas.

### 3.12 SchemaValidator (`src/protocol/SchemaValidator.js`)
- **Responsibilities:** Compile all JSON Schema Draft 2020-12 schemas **once** at startup; validate wire envelopes, `TaskPlanV1`, `BotAssignmentV1`, `ReplanRequestV1`, `TaskCompletionReportV1` and `FailureReportV1`; enforce DAG acyclicity, unique `localId`s, item registry membership and quota bounds.
- **Inputs:** `(schemaId: string, payload: unknown, semanticContext?: object)`.
- **Outputs:** `{ valid: boolean, errors: string[] }`.
- **Public methods:** `validate(schemaId, value)`, `validatePlanSemantics(plan, registryContext)`, `validateAssignment(assignment, botCapabilities)`, `validateWorkerEvent(envelope, authWorker)`.
- **Events:** None (pure synchronous validator).
- **Failure behaviour:** Unknown `schemaVersion` returns `PROTOCOL_VERSION_UNSUPPORTED`; extra properties, oversized arrays or cyclic dependencies return `valid: false` with deterministic path errors.

### 3.13 StateStore (`src/persistence/StateStore.js`)
- **Responsibilities:** Own single-writer SQLite connection (`ARCHITECTURE.md` §4 DDL); run versioned forward migrations; execute short synchronous `BEGIN IMMEDIATE ... COMMIT` transactions with zero network I/O inside transactions; record transaction latencies in `ResourceMonitor`; perform verified atomic backups (`backup`).
- **Inputs:** Domain persistence records and parameterized query filters.
- **Outputs:** Plain DTO rows, `BackupResult`, `StoreHealth`.
- **Public methods:** `open()`, `close()`, `transaction(fn)`, `migrate()`, `backup(destPath)`, `verifyBackup(backupPath)`, `health()`, plus repository methods used exclusively by `TaskManager`, `WorkerRegistry`, `InventoryLedger` and `AuthService`.
- **Events:** `store.opened`, `store.error`, `store.backup_completed`.
- **Failure behaviour:** Never falls back to in-memory storage when persistent path fails; throws `DomainError('PERSISTENCE_ERROR')` so `Coordinator` enters safe mode.

### 3.14 ResourceMonitor, WorkloadGovernor & EventBus (`src/monitoring/`, `src/events/` — Implemented on `main`)
- **Responsibilities:** Sample all 11 performance domains (`RSS`, `heap`, OS `MemAvailable`, `CPU`, `eventLoopDelay`, `network`, `queues`, `timers`, `listeners`, `caches`, `AI`, `dashboard`, `dbLatency`); drive `normal | constrained | critical` state transitions with stepwise hysteresis cooldown recovery; pause/defer low-priority work (`0` tasks dropped) while preserving survival, safety, heartbeats, lease fencing and durable commits; publish bounded in-process domain events with isolated subscriber error handling.
- **Inputs:** Runtime handles, `/proc/meminfo`, registered cache/queue/emitter probes, and domain event payloads.
- **Outputs:** `MonitorSample`, `MonitorWindow`, `GovernorDirectives`, `WorkClassification`, `ReductionReport[]`.
- **Public methods (`ResourceMonitor`):** `start()`, `stop()`, `sampleNow(opts)`, `getWindow()`, `pressureState()`, `recordEventLoopLag(ms)`, `recordDbLatency(ms)`, `recordNetworkBytes(meta)`, `recordAiEvent(kind)`, `recordDashboardUpdate(meta)`, `registerQueueProbe(name, fn)`, `unregisterQueueProbe(name)`, `registerCache(name, cache)`, `unregisterCache(name)`, `registerEmitter(name, emitter)`, `unregisterEmitter(name)`.
- **Public methods (`WorkloadGovernor`):** `setConfiguredBotCap(cap)`, `evaluate(sample)`, `getDirectives(capacity)`, `classifyWork(taskReq)`, `drainResumableTasks(maxCount)`, `getReductionReports(limit)`.
- **Public methods (`EventBus`):** `publish(eventType, payload)`, `on(eventType, handler)`, `off(eventType, handler)`, `recentEvents(limit)`, `trimForMemoryPressure()`, `stats()`.
- **Events:** `workload.changed`, `workload.reduction`, `workload.tasks_resumed`.
- **Failure behaviour:** Unavailable OS `/proc` metrics return `'unavailable'` (never `0`); throwing `EventBus` subscribers are isolated and counted without crashing emitters.

### 3.15 AuthService, DashboardServer, CLI & ChatCommandAdapter
- **`AuthService` (`src/security/AuthService.js`):**
  - *Responsibilities:* Concurrency-1 bounded password hashing (`crypto.scrypt` / verified Argon2id), opaque session lifecycle (`__Host-swarm_session`), CSRF token generation/verification, RBAC role guards (`viewer < operator < admin`), login rate-limiting.
  - *Methods:* `bootstrapAdmin(creds)`, `login({ username, password, ip })`, `logout(sessionId)`, `authenticateSession(req)`, `verifyCsrf(req, session)`, `authenticateCliToken(token)`, `authorize(principal, requiredRole)`.
- **`DashboardServer` (`src/dashboard/createDashboard.js`):**
  - *Responsibilities:* Express HTTPS routes (`/api/v1/*`), static vanilla HTML/CSS/JS assets, security headers (CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`), and live updates via `SseCoalescer`.
  - *Methods:* `start()`, `stop()`, `publishSummary(eventType, key, dto)`, `buildSnapshot(actor)`.
- **`CLI` (`src/cli/commands.js`):**
  - *Responsibilities:* Loopback API client (`status`, `workers list`, `bots list`, `task submit`, `task show`, `task clarify`, `task pause`, `task resume`, `task cancel`, `bot safe-stop`, `diagnostics`, `version`). Never imports `StateStore` or `mineflayer`.
  - *Methods:* `parseArgs(argv)`, `execute(cmd, apiClient)`, `formatOutput(result, jsonMode)`.
- **`ChatCommandAdapter` (`src/chat/ChatCommandAdapter.js`):**
  - *Responsibilities:* Wrap `ChatHistoryGuard` on WorkerHost to drop unprefixed/bot/unauthorised lines in `O(1)` and submit authorised `ChatIntent` DTOs to `Coordinator.submitIntent` / status queries on Master.
  - *Methods:* `inspectIncomingChat(msg)`, `toCoordinatorRequest(chatIntent, serverProfile)`, `formatSafeChatReply(receipt)` *(max `120` chars, zero secrets/paths)*.
