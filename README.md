# mineflayer-ai-swarm

Distributed Mineflayer AI Swarm. The root [MASTER_PROJECT_CONTEXT.md](./MASTER_PROJECT_CONTEXT.md) is the project brief.

## Coding agent entry point

All repository coding agents must follow [AGENTS.md](./AGENTS.md). For agents that do not automatically read repository instructions, provide [CODING_AGENT_BOOTSTRAP.md](./docs/spec/CODING_AGENT_BOOTSTRAP.md) as their first prompt. These instructions require reading the master specification, module contracts and AI protocol before implementation.

## Implementation specification

Read the documents in this order before implementing modules:

1. [MASTER_SPEC.md](./docs/spec/MASTER_SPEC.md) — normative project rules and decisions.
2. [ARCHITECTURE.md](./docs/spec/ARCHITECTURE.md) — deployment topology and data flow.
3. [MODULE_INTERFACES.md](./docs/spec/MODULE_INTERFACES.md) — module ownership and contracts.
4. [TASK_ALLOCATION.md](./docs/spec/TASK_ALLOCATION.md) — scheduling, shared quotas and inventory verification.
5. [AI_PROTOCOL.md](./docs/spec/AI_PROTOCOL.md) — strict JSON schemas and Ollama boundary.
6. [PERFORMANCE_PLAN.md](./docs/spec/PERFORMANCE_PLAN.md) — Galaxy A06 and worker performance budgets.
7. [SECURITY_PLAN.md](./docs/spec/SECURITY_PLAN.md) — credentials, trust boundaries and safe operation.
8. [TEST_PLAN.md](./docs/spec/TEST_PLAN.md) — required automated and integration tests.
9. [ACCEPTANCE_CRITERIA.md](./docs/spec/ACCEPTANCE_CRITERIA.md) — staged rollout gates and unresolved decisions.

The specification is a design baseline, not a claim that the system has been implemented or tested. All unresolved decisions and compatibility requirements must be closed before the relevant production stage.
