# NEXUS-20 Architectural Decision Records (ADRs)

**Repository:** `fallendrake0-droid/mineflayer-ai-swarm`  
**Project Identity:** NEXUS-20 (Networked EXecution and Unified Swarm)  
**Last Updated:** 2026-11-10

This document records significant architectural decisions and resolves specification conflicts between the v1.1.0 repository specifications (`docs/spec/*.md`, `MASTER_PROJECT_CONTEXT.md`) and the NEXUS-20 Master Development Specification.

---

## ADR-001: Built-in `node:http` / `node:https` Instead of Express on the Master Controller

- **Context / Conflict:** Part 16 & Part 21 of the NEXUS-20 Master Prompt suggest `Express + HTML + CSS + Vanilla JS`, whereas `docs/spec/MASTER_SPEC.md`, `PERFORMANCE_PLAN.md`, and `CONTRIBUTING.md` mandate zero external npm framework dependencies on the Master coordinator to protect the 4 GB Samsung Galaxy A06 / 8 GB Chromebook RAM budget and eliminate transitive supply-chain risk.
- **Decision:** Implement `src/interfaces/http/MasterHttpServer.js` directly on Node.js 22 built-in `node:http` / `node:https` + `URL` routing + `SseCoalescer`, serving Vanilla HTML/CSS/JS static assets from `src/dashboard/public/`.
- **Rationale:** Built-in `node:http` adds `0 B` of npm dependencies, starts instantaneously in Termux/Linux containers, enforces strict `64 KiB` / `128 KiB` stream byte caps before JSON parsing, and supports `0.0.0.0` + `process.env.PORT` identically to Express.

---

## ADR-002: Default 20-Bot Cap (`G-02`) with Configurable `maxArchitecturalBots` Ceiling

- **Context / Conflict:** `docs/spec/MASTER_SPEC.md` (`G-02`) rejects `globalMaxBots > 20` by default, while NEXUS-20 Part 2 states that 20 is the initial operational target rather than a permanent architectural ceiling.
- **Decision:** Keep `capacity.maxArchitecturalBots = 20` and `capacity.globalMaxBots = 20` by default (preserving `G-02` release gate compliance out of the box), while removing hardcoded `20` literals from SQL/scheduler internals in favour of `config.capacity.globalMaxBots` bounded by `config.capacity.maxArchitecturalBots`.
- **Rationale:** Preserves all existing safety gates for the 20-bot target while allowing future expansion (`> 20` bots across additional VPS workers) via explicit operator configuration without redesigning `TaskManager`, `TaskScheduler`, or `StateStore`.

---

## ADR-003: First-Class Runtime Swarm Operating Modes (`SYNCHRONIZED`, `DISTRIBUTED`, `HYBRID`) Over One `TaskManager`

- **Context / Conflict:** Earlier foundation code inferred bot parallelism solely per objective (`single`, `partitionable`, `spatial`, `role_based`). NEXUS-20 Part 7 requires three explicit, runtime-switchable swarm operating modes (`SYNCHRONIZED`, `DISTRIBUTED`, `HYBRID` default) without creating a second `TaskManager`.
- **Decision:** Persist `operating_mode` in SQLite `system_settings` (default `HYBRID`) and enforce mode semantics inside `TaskScheduler` + `Coordinator`:
  - **`SYNCHRONIZED`:** Concentrates eligible bots onto the highest-priority active shared objective, assigning each bot both a water-filled `quotaQuantity` AND a disjoint spatial work sector (`regionBounds` `Area-1..Area-N`) to prevent duplicate block interactions and congestion.
  - **`DISTRIBUTED`:** Assigns distinct ready objectives across distinct capability-matched bots (`1` bot per independent objective unless overridden).
  - **`HYBRID` (Default):** Schedules multi-bot shared objectives and independent/role-based objectives concurrently across the swarm, guarded by `minAssignmentHoldMs` hysteresis to prevent oscillation.

---

## ADR-004: Five NEXUS-20 Performance Profiles Integrated into `WorkloadGovernor`

- **Context / Conflict:** Stage-0 `WorkloadGovernor` implemented three pressure states (`normal`, `constrained`, `critical`), whereas NEXUS-20 Part 13.6 specifies five profiles (`ULTRA_LOW`, `LOW`, `BALANCED` [default], `PERFORMANCE`, `MAXIMUM_THROUGHPUT`) with automatic pressure adaptation and hysteresis.
- **Decision:** Integrate all five profiles directly into `WorkloadGovernor` (zero duplicate governor classes). Each profile defines baseline budgets (`botCapFraction`, `dashboardFlushIntervalMs`, `maxBlockSearchRadius`, `maxConcurrentAi`, `allowNonEssentialAi`, `allowNonEssentialScanning`), which are automatically clamped downward when measured `ResourceMonitor` pressure enters `constrained` or `critical` states and restored with hold-window hysteresis.

---

## ADR-005: Bounded SQLite-Backed Shared World Knowledge (`WorldKnowledgeStore`)

- **Context:** NEXUS-20 Part 6.1 & Part 11 require bots to share verified world discoveries (resource veins, storage chests, structures, hazards, explored areas, routes, bases) with bounded retention and TTL expiry so stale observations are never treated as guaranteed facts.
- **Decision:** Add `world_knowledge` and `storage_locks` tables to `StateStore` (`src/knowledge/WorldKnowledgeStore.js`) with hard row caps (`maxEntries = 2000`), mandatory `expires_at` timestamps, confidence scoring (`0.0..1.0`), verification states (`observed | verified | disputed`), and mutex-like TTL chest/storage locks so two bots never conflict on the same chest simultaneously.

---

## ADR-006: Pluggable AI Provider Adapter Boundary Preserving £0 Default Policy

- **Context:** NEXUS-20 Part 6.3 requires remote Ollama as primary inference provider plus a configurable provider interface so future providers can be registered without rewriting the central brain.
- **Decision:** Add a provider adapter registry (`registerProvider`, `setProvider`) inside `AiEfficiencyController` with `ollama` registered by default. All providers remain subject to identical prompt compaction (`<= 6 KiB`), concurrency/rate limits, `TaskPlanV1` schema validation, and deterministic fallback.

---

## ADR-007: Preserving Reconciled Repository Paths & Managed Edge-TLS Proxy Support

- **Context:** NEXUS-20 Part 22 illustrates a proposed folder tree (`src/brain/`, `src/state/`, etc.) with an explicit instruction to *"Use existing files wherever possible... Adapt the structure to existing code."* Additionally, Part 21 requires `0.0.0.0` + `process.env.PORT` compatibility in container environments where TLS terminates at an edge proxy.
- **Decision:** Retain all tested foundation module paths (`src/coordinator/`, `src/tasks/`, `src/scheduler/`, `src/workers/`, `src/persistence/`, `src/inventory/`, `src/performance/`, `src/monitoring/`) without duplicate files, add `process.env.PORT` fallback in `loadConfig.js`, and support explicit `SWARM_TRUST_EDGE_TLS_PROXY=true` alongside native HTTPS TLS.
