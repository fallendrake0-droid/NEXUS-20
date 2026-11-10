# NEXUS-20 Changelog

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
