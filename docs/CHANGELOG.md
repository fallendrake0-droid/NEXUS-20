# NEXUS-20 Changelog

## [0.4.0] — 2026-11-10 (Unified CLI Entrypoint, Distributed WorkerHost Tier & Control Centre Enhancements)

### Added
- **Unified Master + Worker Entrypoint & Operator CLI (`index.js`, `package.json`, `loadConfig.js`):**
  - Dual-role daemon launch (`node index.js` for Master Controller, `node index.js --role=worker` for Distributed `WorkerHost`) with lazy `createWorker` loading so `G-01` zero-Mineflayer isolation on the Galaxy A06 Master remains 100% enforced.
  - Operator subcommands: `mint-token`, `status`, `submit "<intent>"`, `backup`, `--help`, `--check-config`, and local/remote `--health [--url=...]`.
  - Full `worker` configuration validation in `src/config/loadConfig.js` and documented worker env template in `.env.example`.
- **Distributed Worker Runtime Tier (`src/worker/*`):**
  - `MasterClient.js`: Zero-dependency `node:http`/`node:https` client for `/worker/v1/{register,heartbeat,commands,commands/:id/ack,events,reconcile}` with monotonic `workerSequence`, `BoundedByteQueue` offline event buffering, and custom TLS CA support.
  - `SkillExecutor.js`: Deterministic, strictly non-`eval` skill executor for `mine`, `collect`, `craft`, `build`, `explore`, `guard`, `transfer`, `repair`, `inspect`, and `safe_stop` with `performance.now()` monotonic local lease self-fencing (`LEASE_EXPIRED_LOCALLY`), mid-step `pause`/`resume`/`cancel`/`fence_epoch` preemption, checkpoints, and schema-valid `TaskCompletionReportV1` / `FailureReportV1` evidence.
  - `BotRunner.js`: Per-bot lifecycle with `ScopedListeners` cleanup, priority-0 Survival Reflex auto-eat + `survival_override` emission, `ChatHistoryGuard` `!swarm` ingress filtering, `BlockSearchCache` governor propagation, `SimulatedBotDriver` (`SWARM_WORKER_SIMULATION=true`), and lazy `createMineflayerDriver`.
  - `WorkerHost.js`: Single-use bootstrap enrollment with `0600` credential persistence, automatic reconnect `/worker/v1/reconcile`, staggered bot spawn ramp (`spawnStaggerMs`), piggybacked `WorldKnowledgeStore` observations, and consolidated `TimerRegistry` loops.
- **Master Gateway, Chat Loop & Control Centre UI Improvements (`Coordinator.js`, `MasterHttpServer.js`, `src/dashboard/public/*`):**
  - End-to-end execution of allowlisted in-game `!swarm` `chat_intent` events (`task`, `pause`, `resume`, `cancel`) in `Coordinator.handleWorkerEventBatch` (enforcing `HIGH-06` offline chat lock).
  - Verified online SQLite WAL backup endpoint (`POST /api/v1/system/backup` + UI button in Tab 6) and persistence safe-mode recovery endpoint (`POST /api/v1/system/exit-safe-mode` + UI recovery button).
  - Control Centre UX upgrades: Quick-Intent preset chips, inline live Task Priority selector, inline Clarification response banner, copy-ready Worker launch command snippet on token mint, Worker Revoke button, and zero inline `.style.*` CSP compliance.
- **End-to-End Verification (`tests/foundation/worker-and-cli-e2e.test.js`):** Added `E2E-01..04` (`54/54` tests passing, `3/3` leak suites passing).

## [0.3.1] — 2026-11-10 (Repository-Wide Deep Bug Audit & 16 Root-Cause Fixes)

### Fixed
- **`BUG-F01` (`TaskManager` Shared-Objective Sibling Epoch Isolation):** Active unexpired sibling leases on multi-bot objectives now validate `asg.allocation_epoch <= report.allocationEpoch <= obj.allocation_epoch` while fenced (`expired | revoked | failed`) leases require `report.allocationEpoch >= obj.allocation_epoch`, preventing a single bot's disconnect/expiry from poisoning concurrent healthy bots on other workers.
- **`BUG-F02` (`InventoryLedger` & `TaskManager` / `TaskScheduler` Non-Quantified & Spatial Sector Completion):** Prevented premature completion of `target_quantity === null` (`explore`, `build`, `guard`) objectives on `assignment_progress` or when the first of `K` spatial sectors finished; added `missingPartitions` recovery so failed/expired spatial sectors are selectively re-allocated without re-exploring completed sectors.
- **`BUG-F03` (`Coordinator.handleWorkerHeartbeat`, `TaskManager.expireLeases`, `createMaster`):** Heartbeat-reported disconnected bot leases (`ack.expiredLeaseIds`) are now fenced and released immediately (`< 5 ms` instead of waiting up to `30 s`), and periodic `master-lease-liveness-sweep` triggers `scheduleReadyObjectives` when leases expire or workers become unreachable.
- **`BUG-F04` (`TaskManager.resumeTask`):** Enqueues `'resume'` outbox commands to active workers and restores `tasks.state` to `'running'` when active assignments exist.
- **`BUG-F05` & `BUG-F16` (`TaskManager.attachPlan` Live Replan Safety):** Added `running -> planning | ready` legal transitions for live replans, enqueued `'cancel'` outbox commands for omitted objectives and spec-mutated (`kind`/`resourceId`/`verification`) active objectives, and finalized all-completed replans cleanly to `'completed'`.
- **`BUG-F06` (`BotRegistry.register` & `BotRegistry.revoke`):** Rejected duplicate `botId`s within `configuredBots` batches and recovered non-quantified (`target_quantity === null`) objectives back to `'ready'` on worker revocation/re-enrollment when zero sibling assignments remain.
- **`BUG-F07` (`AuthService`, `MasterHttpServer`, `app.js` Multi-Tab CSRF Recovery):** Derived deterministic per-session `HMAC-SHA256` CSRF tokens (hashed via `SHA-256` in SQLite `sessions.csrf_token_hash`) and returned `csrfToken` on same-origin `GET /api/v1/auth/session` so new browser tabs and reloads never lose CSRF state; made expired-cookie `POST /api/v1/auth/logout` clear cookies gracefully.
- **`BUG-F08` & `BUG-F09` (`app.js` & `SseCoalescer`):** Subscribed Dashboard `EventSource` to coalesced `summary` and `reload_required` SSE frames matching `SseCoalescer` wire format, and added `SseCoalescer.dispose()`.
- **`BUG-F10` (`createLogger` & `BoundedLogger`):** Forwarded `ringSize` / `dedupWindowMs` to `BoundedLogger` (`ringCapacity` / `rateLimitWindowMs`) so `SWARM_LOG_RING_SIZE` is honoured.
- **`BUG-F11` (`CompactSnapshotCodec` & `TaskScheduler`):** Excluded `0`-durability broken tools (`durabilityUsed >= maxDurability`) from `bestToolsByClass`, `activeTool`, and `TaskScheduler` eligibility.
- **`BUG-F12` (`PathfindingGuard`):** Persisted sequential stuck-retry counts across awaited `forceReplan` calls to enforce `MAX_STUCK_RETRIES_EXCEEDED` and kept timeout timers reffed until `finally` cleanup.
- **`BUG-F13` (`BlockSearchCache`):** Extended `onBlockUpdate` invalidation across adjacent 16-block sector boundaries within `ceil(maxRadius / 16)`.
- **`BUG-F14` & `BUG-F15` (`ChatHistoryGuard`, `DomainError`, `MasterHttpServer`, `SchemaValidator`, `loadConfig`):** Enforced whitespace word boundary after `!swarm`; added `413 PAYLOAD_TOO_LARGE` (`Connection: close`) and `501 NOT_IMPLEMENTED`; exposed `POST /worker/v1/reconcile` and `POST /api/v1/workers/:workerId/revoke`; allowed omitted `undefined` optional fields (`itemKey`, `partialReport`, `resourceId`, `quotaQuantity`) and up to 128-char `objectiveId`s in `SchemaValidator`; supported `{ env, fileConfig }` wrapper in `loadConfig`.
- **Regression Suite:** Added `tests/adversarial/deep-audit-bugfixes.test.js` (`50/50` total tests passing).

## [0.3.0] — 2026-11-10 (Phase 0 Audit & Phase 1 Master Control Plane Completion)

### Added
- **Phase 0 Baseline Audit & ADRs:** `docs/NEXUS20_PHASE0_AUDIT.md` and `docs/DECISIONS.md` (`ADR-001` through `ADR-007`), reconciling all conflicts between `docs/spec/*.md` (v1.1.0) and the NEXUS-20 Master Specification.
- **Operator Security (`src/security/AuthService.js`):** Concurrency-1 `crypto.scrypt` KDF queue (`N=4096, r=8, p=4`, `maxQueue=4`) keeping 20-request login floods under `16 MiB` RSS; `HttpOnly` session cookies (`SameSite=Strict` on direct binds, `SameSite=None; Secure; Partitioned` behind edge TLS proxies); SHA-256 CSRF verification; RBAC (`viewer`, `operator`, `admin`); sliding-window rate limiter.
- **Shared World Knowledge (`src/knowledge/WorldKnowledgeStore.js`):** Bounded (`maxEntries=2000`), TTL-expiring SQLite knowledge store across 10 categories with multi-bot confidence verification (`observed -> verified`), depletion invalidation, and TTL-bounded chest/storage mutex locks (`storage_locks`).
- **Runtime Swarm Operating Modes (`ADR-003`):** `SYNCHRONIZED` (shared parent objective with water-filling quotas + disjoint `Area-1..Area-N` spatial sectors), `DISTRIBUTED` (independent capability-matched objectives), and `HYBRID` (default; concurrent shared + role objectives with `minAssignmentHoldMs` hysteresis), persisted across Master restarts in SQLite `system_settings`.
- **Five NEXUS-20 Performance Profiles (`ADR-004`):** `ULTRA_LOW`, `LOW`, `BALANCED` (default), `PERFORMANCE`, and `MAXIMUM_THROUGHPUT` integrated into `WorkloadGovernor` with automatic pressure clamping.
- **Pluggable AI Provider Registry (`ADR-006`):** `registerProvider`, `setProvider`, and `listProviders` on `AiEfficiencyController` with remote Ollama as default.
- **Zero-Dependency HTTP/SSE Gateway & Control Centre (`src/interfaces/http/MasterHttpServer.js`, `src/dashboard/public/*`):** Full `/api/v1/*` + `/worker/v1/*` + coalesced SSE (`/api/v1/events`) server and Vanilla HTML/CSS/JS NEXUS-20 Control Centre driven exclusively by real backend state.
- **Tests:** `tests/foundation/nexus20-core-and-http.test.js` (`NEXUS-01..04` covering KDF flood protection, CSRF, `WorldKnowledgeStore`, chest mutexes, operating modes, restart persistence, and full TCP HTTP/SSE/Worker wire integration).
