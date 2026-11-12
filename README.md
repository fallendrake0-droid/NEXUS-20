# mineflayer-ai-swarm

Distributed Mineflayer AI Swarm. The root [MASTER_PROJECT_CONTEXT.md](./MASTER_PROJECT_CONTEXT.md) is the project brief.

> **Termux / Linux quick start:** See [`docs/TERMUX_LINUX_QUICKSTART.md`](docs/TERMUX_LINUX_QUICKSTART.md) for installation, Master/Worker setup, Control Centre access, and the Tab-autocomplete command console.

## Coding agent entry point

All repository coding agents must follow [AGENTS.md](./AGENTS.md). For agents that do not automatically read repository instructions, provide [CODING_AGENT_BOOTSTRAP.md](./docs/spec/CODING_AGENT_BOOTSTRAP.md) as their first prompt. These instructions require reading the master specification, module contracts and AI protocol before implementation.

## Implementation specification (v1.1.0)

Read the documents in this exact order before implementing modules:

1. [MASTER_SPEC.md](./docs/spec/MASTER_SPEC.md) — normative invariants (`G-01..G-18`), formal state transition tables, error taxonomy and configuration contract.
2. [ARCHITECTURE.md](./docs/spec/ARCHITECTURE.md) — 3-tier deployment topology, `/worker/v1/*` and `/api/v1/*` wire protocols, reconciliation sequence and SQLite logical DDL.
3. [MODULE_INTERFACES.md](./docs/spec/MODULE_INTERFACES.md) — shared DTO dictionary and complete module contracts (Responsibilities, Inputs, Outputs, Public methods, Events, Failure behaviour).
4. [TASK_ALLOCATION.md](./docs/spec/TASK_ALLOCATION.md) — deterministic 1-bot vs subset vs swarm math, `splitQuota`, `partitionRegion`, DAG critical path and `InventoryLedger` verification.
5. [AI_PROTOCOL.md](./docs/spec/AI_PROTOCOL.md) — strict JSON Schema Draft 2020-12 contracts (`additionalProperties: false`) and remote Ollama data-minimisation boundary.
6. [PERFORMANCE_PLAN.md](./docs/spec/PERFORMANCE_PLAN.md) — Samsung Galaxy A06 (4 GB RAM, Android 16, Termux) low-memory architecture, adaptive `WorkloadGovernor` and empirical benchmarks ([PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)).
7. [SECURITY_PLAN.md](./docs/spec/SECURITY_PLAN.md) — endpoint RBAC matrix, session/CSRF controls, worker token enrollment/revocation and Minecraft account safety.
8. [TEST_PLAN.md](./docs/spec/TEST_PLAN.md) — unit, schema, integration, recovery, security and `--expose-gc` memory-leak test suites.
9. [ACCEPTANCE_CRITERIA.md](./docs/spec/ACCEPTANCE_CRITERIA.md) — automated release gates (`G-01..G-18`), staged `0 -> 1 -> 2 -> 5 -> 10 -> 20` rollout and open decisions (`U-01..U-14`).

## Current repository baseline (NEXUS-20 Phase 0 & Phase 1 Complete)

- **Stage 0 & Phase 1 Master Control Plane implemented & verified (`45/45` tests, `3/3` GC leak suites):**
  - Low-memory runtime primitives (`src/performance/*`), `ResourceMonitor` and 5-profile `WorkloadGovernor` (`ULTRA_LOW`, `LOW`, `BALANCED`, `PERFORMANCE`, `MAXIMUM_THROUGHPUT`).
  - Authoritative SQLite WAL `StateStore` (`18` tables), `InventoryLedger`, `BotRegistry`, single `TaskManager` (`finish_to_start` + `start_with` DAG, epoch fencing), `TaskScheduler` (`SYNCHRONIZED`, `DISTRIBUTED`, `HYBRID` modes + disjoint spatial sectors), and `Coordinator`.
  - Pluggable AI Brain (`AiEfficiencyController`), bounded TTL `WorldKnowledgeStore` + chest mutex locks (`src/knowledge/WorldKnowledgeStore.js`), `AuthService` (`scrypt` concurrency-1 queue, `HttpOnly` sessions, CSRF, RBAC, rate limits), and zero-dependency `MasterHttpServer` + Vanilla JS NEXUS-20 Control Centre (`src/interfaces/http/MasterHttpServer.js`, `src/dashboard/public/*`).
  - Architectural decisions & Phase 0 audit: [docs/DECISIONS.md](./docs/DECISIONS.md), [docs/NEXUS20_PHASE0_AUDIT.md](./docs/NEXUS20_PHASE0_AUDIT.md), [docs/CHANGELOG.md](./docs/CHANGELOG.md).
- **Phase 2+ planned next (Live Minecraft Worker Tier):** `WorkerHost` client loop (`MasterClient`) and Mineflayer `BotRunner` + survival/navigation/mining/crafting/building/storage/exploration/combat skills (`mineflayer` & `mineflayer-pathfinder` isolated strictly to the Worker tier). Coding agents must reuse existing primitives without duplicating them and respect open decisions (`U-01..U-14`).
