# Module Interfaces — Mineflayer AI Swarm

**Specification:** 1.0.0  
**Language:** CommonJS JavaScript with async/await  
**Rule:** Each public method has one owner. Shared state is passed by immutable DTOs or retrieved through the owning service; modules must not mutate another module's private objects.

## 1. Conventions

- Factories/classes are CommonJS exports.
- Async public operations return Promises.
- DTOs are plain JSON-compatible objects; do not serialize Mineflayer Bot, Entity, Vec3, Block, Item, Buffer or Error instances directly.
- IDs are UUIDs unless a field explicitly says otherwise.
- All timestamps crossing process boundaries are UTC RFC 3339 strings. Server receipt time is authoritative for leases.
- All quantities are non-negative safe integers unless a schema says otherwise.
- Every command/event carries schemaVersion, messageId, actor/worker identity and correlation IDs.
- Failure returns typed domain errors; it must not silently convert failure into completion.

## 2. Module inventory

| Module | Location | Process | Owns |
|---|---|---|---|
| Master bootstrap | src/master/createMaster.js | Phone | Construction and shutdown |
| Config loader | src/config/loadConfig.js | Both | Validation of configuration |
| Coordinator | src/coordinator/Coordinator.js | Phone | Use-case orchestration |
| TaskManager | src/tasks/TaskManager.js | Phone | Task/objective/lease lifecycle |
| TaskScheduler | src/scheduler/TaskScheduler.js | Phone | Candidate evaluation and allocation |
| WorkerRegistry | src/workers/WorkerRegistry.js | Phone | Worker/bot registration and liveness |
| WorkerGateway | src/workers/WorkerGateway.js | Phone | Authenticated worker protocol |
| WorkerHost | src/worker/WorkerHost.js | Worker | Local bot supervision and transport |
| BotController | src/bots/BotController.js | Worker | One Mineflayer bot lifecycle |
| ActionExecutor | src/actions/ActionExecutor.js | Worker | Deterministic action dispatch |
| CapabilityProfiler | src/bots/CapabilityProfiler.js | Worker/master | Capability and measured rate summaries |
| InventoryLedger | src/inventory/InventoryLedger.js | Phone | Verified item accounting |
| ReasoningEngine | src/ai/ReasoningEngine.js | Phone | Plan/replan use cases |
| OllamaClient | src/ai/OllamaClient.js | Phone | HTTP transport to Ollama |
| SchemaValidator | src/protocol/SchemaValidator.js | Both | Strict schema and semantic validation |
| StateStore | src/persistence/StateStore.js | Phone | Durable transactions and queries |
| ResourceMonitor | src/monitoring/ResourceMonitor.js | Phone/worker | Resource measurements |
| DashboardServer | src/dashboard/createDashboard.js | Phone | Express routes, auth and SSE |
| CLI | src/cli/commands.js | CLI process | Thin API client |
| ChatCommandAdapter | src/chat/ChatCommandAdapter.js | Worker ingress + phone policy | Allowlisted chat intent |
| AuthService | src/security/AuthService.js | Phone/worker | Principal and credential validation |
| EventBus | src/events/EventBus.js | Per process | Bounded internal domain events |

## 3. Master bootstrap

### createMaster(config, dependencies)

Responsibilities:
- Load and validate config before opening sockets.
- Construct one StateStore, TaskManager, TaskScheduler, WorkerRegistry and Coordinator.
- Inject interfaces rather than import singletons.
- Start HTTP server, monitor and recovery sequence in safe order.
- Prevent a second active writer for the same database.
- Close streams, stop accepting new leases, drain operations and close database on shutdown.

Public methods:
- start(): Promise<MasterRuntime>
- stop({graceMs}): Promise<void>
- health(): MasterHealth

Failure behaviour:
- Invalid config: fail before binding ports.
- Database migration failure: do not start worker command service.
- Partial startup failure: close already-opened resources in reverse order.
- Shutdown deadline exceeded: leave unacknowledged leases to expire; never mark them complete.

## 4. ConfigLoader

### loadConfig(env, fileConfig)

Inputs:
- Environment variables and optional local config file.
- No secret values are written back to source config.

Outputs:
- Deeply validated immutable configuration with defaults and source metadata.

Public methods:
- loadConfig(env, fileConfig): Config
- validateConfig(config): ValidationResult
- redactConfig(config): SafeConfig

Events: config.loaded, config.invalid.

Failure behaviour:
- Unknown keys: reject in strict mode, or warn only for explicitly documented extension keys.
- Invalid max bots, ports, paths, TLS settings, worker limits or timeout relationships: reject.
- Never log raw secret-bearing config values.

## 5. Coordinator

Responsibilities:
- Be the one use-case boundary for all ingress interfaces.
- Authenticate actor, authorize operation, normalize intent and correlate events.
- Call ReasoningEngine when required, then TaskManager and TaskScheduler.
- Publish summaries after durable commits.

Public methods:
- submitIntent({actor, text, source, idempotencyKey}): Promise<TaskSummary>
- pauseTask({actor, taskId}): Promise<TaskSummary>
- resumeTask({actor, taskId}): Promise<TaskSummary>
- cancelTask({actor, taskId, reason}): Promise<TaskSummary>
- getTask({actor, taskId}): Promise<TaskDetail>
- getSystemStatus({actor}): Promise<SystemStatus>
- safeStopBot({actor, botId}): Promise<CommandReceipt>
- handleWorkerEvent(authenticatedWorker, event): Promise<EventAck>
- handleWorkerHeartbeat(authenticatedWorker, heartbeat): Promise<HeartbeatAck>
- recover(): Promise<RecoveryReport>

Events emitted after commit:
- task.created, task.updated, task.completed, task.failed;
- objective.ready, objective.completed, objective.blocked;
- assignment.offered, assignment.accepted, assignment.expired;
- worker.connected, worker.degraded, worker.unreachable;
- resource.pressure, system.safe_mode.

Failure behaviour:
- If StateStore fails, reject new writes and enter safe mode.
- If AI fails, use supported deterministic fallback or return needs-clarification.
- If a downstream worker is unavailable, do not fabricate an execution result.

## 6. TaskManager

Responsibilities:
- Validate and persist task/objective state transitions.
- Enforce dependency DAG and immutable terminal states.
- Create/revoke/expire assignment leases and quota reservations atomically.
- Deduplicate worker events and protect against stale epochs.
- Update verified quantity ledger only after evidence verification.

Public methods:
- createTask({actorId, normalizedIntent, plan}): Promise<TaskDetail>
- getTask(taskId): Promise<TaskDetail>
- listTasks(filters): Promise<TaskSummary[]>
- readyObjectives(taskId): Promise<Objective[]>
- commitAssignments(objectiveId, assignments, expectedVersion): Promise<Assignment[]>
- acceptAssignment({workerId, assignmentId, epoch}): Promise<void>
- startAssignment({workerId, assignmentId, epoch, baselineSnapshot}): Promise<void>
- applyWorkerEvent(workerId, event): Promise<EventAck>
- pauseTask(taskId, reason): Promise<void>
- resumeTask(taskId): Promise<void>
- cancelTask(taskId, reason): Promise<void>
- expireLeases(now): Promise<ExpiredLease[]>
- reconcileWorker(workerId, checkpoint): Promise<ReconciliationResult>

Invariants:
- All changes are transaction-bound.
- Assignment quotas for a quantity objective never overlap.
- Sum of verified and active reservations never exceeds target.
- No assignment is created before dependencies are complete.
- A sequence number or message ID is applied at most once.
- Old allocation epochs cannot change a newly allocated task.

Failure behaviour:
- Conflict/version mismatch: return CONFLICT and reload/replan.
- Invalid proof: record rejection reason; no progress credit.
- Duplicate message: return the original acknowledgement.
- Unknown worker/bot/assignment: reject and audit.

## 7. TaskScheduler

Responsibilities:
- Determine suitable participants from current worker/bot capabilities.
- Predict task time and uncertainty using measured rates.
- Compare one bot, subsets and partitions up to available configured capacity.
- Include travel, setup, resource/tool availability, risk, overhead and server limits.
- Prefer the smallest subset with a material expected improvement.
- Produce non-overlapping aggregate quotas.

Public methods:
- estimateCandidate({objective, botSnapshot, worldSummary, measurements}): Estimate
- chooseParticipants({objective, candidates, policy, capacity}): AllocationDecision
- splitQuota(totalRemaining, selectedCandidates): Quota[]
- scheduleReadyObjectives(taskId): Promise<ScheduleResult>
- updateMeasurements(sample): void

Events:
- allocation.proposed, allocation.rejected, allocation.committed.

Failure behaviour:
- Missing/stale telemetry: mark candidate confidence low; do not invent exact location or rates.
- No capable bot: objective remains blocked with a typed reason.
- No measurable speedup: select one bot.
- Capacity/server cap reached: leave work queued.
- AI hints never bypass deterministic selection.

## 8. WorkerRegistry and WorkerGateway

### WorkerRegistry

Owns worker identity, approved bot identities, worker capabilities, last heartbeat, health state, per-host slots and server connection allocation.

Methods:
- register({bootstrapCredential, workerInfo}): Promise<WorkerCredential>
- revoke(workerId, reason): Promise<void>
- heartbeat(workerId, snapshot): Promise<HeartbeatAck>
- markUnhealthy(now): Promise<WorkerStatusChange[]>
- availableBots(requirements): Promise<BotCandidate[]>
- getWorker(workerId): Promise<WorkerSummary>
- listWorkers(): Promise<WorkerSummary[]>

Never return raw worker credentials after bootstrap.

### WorkerGateway

Owns worker HTTPS routes, authentication, schemas, idempotency and bounded command long polling.

Methods:
- authenticateRequest(request): AuthenticatedWorker
- offerCommands(workerId, afterSequence, waitMs): Promise<CommandEnvelope[]>
- acknowledgeCommand(workerId, acknowledgement): Promise<void>
- acceptEvents(workerId, events): Promise<EventAck[]>
- acceptSnapshot(workerId, snapshot): Promise<void>

Failure behaviour:
- Bad authentication: reject and rate limit.
- Wrong protocol version: return version error, never guess field meaning.
- Invalid sequence/oversize message: reject.
- Long-poll cancellation: release connection; command lease remains governed by DB expiry.
- Too many outstanding long polls: reject or replace old poll according to one-poll-per-worker invariant.

## 9. WorkerHost

Responsibilities:
- Run on authorised worker device.
- Register and authenticate with master.
- Maintain bounded bot slot count.
- Create one BotController per bot identity.
- Own transport reconnect and local checkpoint.
- Dispatch only known versioned commands through ActionExecutor.
- Forward compact telemetry and evidence.
- Never decide the global objective total or global allocation.

Methods:
- start(): Promise<void>
- stop({graceMs}): Promise<void>
- register(): Promise<void>
- heartbeat(): Promise<void>
- pollCommands(): Promise<void>
- acknowledge(commandId, result): Promise<void>
- submitEvent(event): Promise<EventAck>
- getLocalStatus(): WorkerStatus
- reconcile(checkpoint): Promise<void>

Events: worker.ready, worker.disconnected, bot.ready, bot.failed, command.received, command.completed.

Failure behaviour:
- Coordinator unavailable: bounded backoff, retain only safe local checkpoint, stop issuing new actions when lease cannot be renewed.
- Credential revoked: stop accepting commands and stop bots safely.
- Worker process restarts: reauthenticate and reconcile snapshots before resuming.
- Per-host bot cap reached: reject excess bot registration locally and report capacity.

## 10. BotController

Responsibilities:
- Own exactly one Mineflayer client and its local state.
- Register only supported Mineflayer listeners and plugin APIs.
- Track health, food, position, dimension, tool, durability, inventory summary and connection state.
- Enforce action preconditions, cancellation and local safety stop.
- Execute tasks through ActionExecutor, never through arbitrary AI text.
- Report initial and final inventory snapshots for assigned work.

Methods:
- connect(): Promise<BotReady>
- disconnect(reason): Promise<void>
- executeAssignment(assignment): Promise<ExecutionReport>
- cancelAssignment(assignmentId, reason): Promise<void>
- snapshot(): BotSnapshot
- inventorySnapshot(): InventorySnapshot
- capabilities(): BotCapabilities
- healthCheck(): SafetyDecision

Required Mineflayer lifecycle handling includes supported events such as spawn, kicked, end, error, death, health, chat/whisper and relevant world block/item events. Verify exact event names and arguments against the pinned Mineflayer API documentation. Avoid attaching heavyweight listeners to every movement or chunk if a task does not need them.

Failure behaviour:
- No spawn or login: report connect failure.
- Death: stop current action, emit failure evidence and wait for safe recovery.
- Disconnect: release movement and mark bot disconnected.
- Unsupported plugin/version: refuse task capability rather than call a guessed method.
- Listener errors must be contained; an unhandled EventEmitter error must not crash the worker host.

## 11. ActionExecutor and deterministic action modules

Responsibilities:
- Map an allowlisted action type to a concrete module.
- Validate task requirements, world context and safety preconditions.
- Execute bounded action steps with cancellation and timeout.
- Return typed results and evidence, not free-form completion claims.

Required initial action modules:
- navigation;
- inventory and item selection;
- mine/collect;
- craft;
- place/build primitive;
- eat/survival;
- guard/observe;
- explore bounded region;
- transfer/deposit when implemented and verified.

Methods:
- canExecute(action, snapshot): SafetyDecision
- execute(action, context): Promise<ActionResult>
- cancel(executionId, reason): Promise<void>

Unknown action types fail closed. All movement loops and interaction retries have finite bounds. Pathfinding calls must use the pinned plugin API and include stuck/no-path/timeout handling.

## 12. CapabilityProfiler

Responsibilities:
- Derive capabilities from inventory, equipment, health, food, durability, world dimension, known tool classes and measured action history.
- Keep a compact capability profile; do not export complete entity/chunk maps.
- Track rate distributions by action/material/server conditions.

Methods:
- deriveCapabilities(botSnapshot): BotCapabilities
- recordSample(actionSample): void
- getRateEstimate(botId, actionKey): RateEstimate
- decayStaleMeasurements(now): void

No measured rate means unknown, not a fabricated default. A conservative prior may be used only if labelled low-confidence and replaced by measured samples.

## 13. InventoryLedger

Responsibilities:
- Canonicalize item identity.
- Reconcile baseline and current inventory.
- Deduplicate evidence.
- Apply verified credits/debits and transfers in transactions.
- Maintain objective-wide quantity totals.

Methods:
- canonicalItemKey(item): string
- diff(beforeSnapshot, afterSnapshot): InventoryDelta[]
- verifyEvidence(objective, assignment, evidence): VerificationResult
- applyCredit(verifiedDelta, transactionId): Promise<LedgerReceipt>
- applyTransfer(transferEvidence): Promise<LedgerReceipt>
- getObjectiveBalance(objectiveId): Promise<Balance>

Never credit an item solely because a worker claims it collected it. Never count the same transfer on both bots.

## 14. ReasoningEngine and OllamaClient

### ReasoningEngine

Methods:
- createPlan({requestId, userText, compactContext}): Promise<TaskPlan>
- replan({requestId, activePlan, failureContext, currentState}): Promise<TaskPlanDelta>
- shouldUseAI(intent, policy): boolean
- fallbackPlan(intent): TaskPlan | NeedsClarification

Validates schema and semantic rules before returning a plan. It does not dispatch assignments.

### OllamaClient

Methods:
- health(): Promise<OllamaHealth>
- generateStructured({model, schema, systemPrompt, userPayload, timeoutMs}): Promise<StructuredResult>
- abort(requestId): void

Use Ollama's documented API with a JSON Schema in the format field, stream disabled for deterministic parsing, bounded context/output and explicit timeout. Remote endpoint must be secured at network layer. No paid or third-party fallback.

Failure behaviour:
- Connection refused, timeout or malformed response: typed AI_UNAVAILABLE/AI_INVALID_RESPONSE.
- Caller uses deterministic fallback or marks clarification required.
- Bounded inference queue rejects excess requests instead of accumulating memory.

## 15. SchemaValidator

Methods:
- validate(schemaName, value): ValidationResult
- validatePlanSemantics(plan, context): SemanticValidationResult
- validateAssignment(assignment, workerSnapshot): ValidationResult
- validateWorkerEvent(event, authenticatedWorker): ValidationResult

Strictly reject unknown properties, invalid IDs, quantities, unsupported items/actions, missing fields, oversized arrays and invalid dependency graphs. Use a maintained JSON Schema 2020-12 validator pinned in package-lock.json. Schema validation does not replace business-rule validation.

## 16. StateStore

Responsibilities:
- Own all durable database access.
- Expose transaction methods, not raw database connection to other modules.
- Apply versioned migrations and integrity checks.
- Enforce unique event IDs, per-worker sequence constraints and objective/assignment foreign keys.

Methods:
- open(): Promise<void>
- close(): Promise<void>
- transaction(callback): Promise<T>
- createTaskRecord(data): Promise<void>
- savePlan(taskId, plan): Promise<void>
- saveAssignment(assignment): Promise<void>
- appendEvent(event): Promise<void>
- queryTasks(filters): Promise<TaskSummary[]>
- loadRecoveryState(): Promise<RecoveryState>
- backup(destination): Promise<BackupResult>
- health(): Promise<StoreHealth>

Use parameterized queries only. Database errors propagate as typed persistence errors. Do not silently fall back to memory-only storage.

## 17. ResourceMonitor

Methods:
- start(): void
- stop(): void
- sampleNow(): ResourceSample
- getWindow(): ResourceWindow
- pressureState(): normal | warning | critical
- recordEventLoopLag(ms): void

Measures process RSS, heap, external and arrayBuffers; operating-system available memory when supported; CPU/event-loop lag; worker count; in-flight HTTP/SSE; queue lengths. Sampling must be low-frequency and bounded. Missing platform metrics are reported as unavailable, not zero.

## 18. DashboardServer, CLI and ChatCommandAdapter

### DashboardServer

Methods:
- start(): Promise<void>
- stop(): Promise<void>
- publish(event): void
- snapshot(actor): Promise<DashboardSnapshot>

Owns Express routes, human auth, CSRF protection, role checks, SSE subscriptions and static vanilla assets. It never owns task decisions.

### CLI

Methods:
- parseArgs(argv): CliCommand
- execute(command, apiClient): Promise<CliResult>
- printResult(result): void

The CLI is an API client only. It never imports StateStore or Mineflayer.

### ChatCommandAdapter

Methods:
- parseChat(message, sender): ChatIntent | null
- authorize(sender, serverProfile): boolean
- submit(intent): Promise<CommandReceipt>

Only allowlisted player UUIDs can invoke control commands. Never parse arbitrary JavaScript, shell or plugin commands. Escape outbound status messages and apply per-sender rate limits.

## 19. Domain event envelope

All internal and inter-process events use this conceptual envelope:

~~~json
{
  "schemaVersion": 1,
  "messageId": "uuid",
  "eventType": "assignment.progress",
  "occurredAt": "2026-11-09T12:00:00.000Z",
  "correlationId": "uuid",
  "workerId": "uuid",
  "botId": "uuid",
  "assignmentId": "uuid",
  "allocationEpoch": 1,
  "workerSequence": 42,
  "payload": {}
}
~~~

The specific payload is validated by event type. Worker-supplied occurredAt is informational; master receipt time determines lease and timeout behaviour.

