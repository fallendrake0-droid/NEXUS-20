# Repository-wide coding agent instructions

You are contributing to one shared project: the Mineflayer AI Swarm. These instructions apply to every coding agent and every task in this repository.

## Mandatory reading before changing code

Read these files in full, in this order:

1. \`MASTER_PROJECT_CONTEXT.md\` — user requirements and exclusions.
2. \`docs/spec/MASTER_SPEC.md\` — normative project rules.
3. \`docs/spec/ARCHITECTURE.md\` — deployment and communication topology.
4. \`docs/spec/MODULE_INTERFACES.md\` — ownership, public methods, events and failure behaviour.
5. \`docs/spec/TASK_ALLOCATION.md\` — allocation mathematics, shared quotas and evidence verification.
6. \`docs/spec/AI_PROTOCOL.md\` — versioned JSON schemas and Ollama trust boundary.
7. \`docs/spec/PERFORMANCE_PLAN.md\` — resource limits and measurement approach.
8. \`docs/spec/SECURITY_PLAN.md\` — identity, authentication and safety.
9. \`docs/spec/TEST_PLAN.md\` — required tests.
10. \`docs/spec/ACCEPTANCE_CRITERIA.md\` — stage gates and unresolved decisions.

Do not rely on README summaries or another agent's recollection instead of reading the relevant source documents.

Before implementation, provide a short preflight in your task notes or pull request:
- which documents you read;
- the module(s) and exact files you own;
- public contracts you will use;
- invariants affected;
- unresolved decisions that block or constrain the change;
- tests you will add or run.

If your environment cannot read these repository files, stop and report that limitation. Do not guess the interfaces.

## Normative architecture rules

- The Galaxy A06 is the lightweight master coordinator, not the production host for twenty Mineflayer clients and not a local LLM host.
- Use Node.js, CommonJS, async/await and modular JavaScript. Do not silently migrate the backend to TypeScript, ESM, a frontend framework or a build system.
- The dashboard remains Express-served vanilla HTML/CSS/JavaScript unless the project owner explicitly changes the master context.
- One central Coordinator and one authoritative TaskManager own all interfaces and task state.
- Dashboard, CLI and Minecraft chat must submit actions through the same Coordinator. None may write task state or call Mineflayer directly.
- Workers execute deterministic actions. They do not own global scheduling, target totals or verified progress.
- Deterministic JavaScript owns movement, navigation, survival, inventory operations, execution, evidence and recovery.
- Remote Ollama is for natural-language understanding and strategic proposals only. AI output is untrusted, schema-validated and semantically validated. It never directly executes code or issues arbitrary commands.
- No local LLM on the Galaxy A06. No paid API, subscription, cloud inference fallback or paid automatic fallback.
- Do not waste inference requests on movement ticks or routine actions. Deterministic fallback is required for supported tasks.
- The initial target is two bots. Scale only through the gates: one, two, five, ten and twenty.
- Global architecture capacity is at most twenty bot identities across authorised worker devices. It does not imply the phone can host twenty clients or that a Minecraft server permits twenty connections.
- Use only authorised Minecraft servers and legitimate separately authenticated accounts. Offline-mode identities are only for private testing on a server controlled by the project owner. Never bypass authentication, anti-cheat, moderation, player limits or access restrictions.

## Correctness invariants

- A quantity target is aggregate across the entire task. Never assign the full target independently to every bot.
- For each quantity objective: verified + active reserved must never exceed target; assignment quotas must be non-overlapping and sum only to the remaining target.
- Prefer one bot unless additional participants provide a measured, confidence-supported improvement after travel, setup, coordination, contention and merge costs.
- Multiple resources are separate objectives. Dependencies form an acyclic graph and must be respected.
- Reservations are not verified progress.
- Worker reports are evidence, not truth. Verify inventory/world/container deltas under the active lease before crediting progress.
- Deduplicate messages and evidence. Reject stale allocation epochs and expired leases.
- Never repeat a non-idempotent action merely because an acknowledgement was lost; reconcile observed state first.
- Never fabricate compatibility, test results, resource numbers or completion.
- Unknown telemetry is unknown, not zero or an assumed fact.

## Shared repository collaboration

- Do not create competing implementations of an existing module.
- Check current files, exports and package scripts before editing.
- Make the smallest coherent change within your assigned file ownership.
- Coordinate shared-interface changes before changing consumers. Update the specification and tests in the same change when a contract genuinely needs to evolve.
- Do not rename public methods, event names, protocol fields or schema versions without updating every consumer and contract test.
- Avoid modifying files outside your assigned scope. Report conflicts instead of overwriting another agent's work.
- Use feature branches and reviewable commits. Never force-push shared branches.
- Keep configuration secrets out of Git. Update \`.env.example\` only with dummy values.
- Do not introduce a dependency without documenting why it is required, checking current compatibility and pinning it in the lockfile.
- Do not use guessed APIs. Verify the exact installed package API and the exact supported Minecraft protocol tuple.
- Do not leave TODO stubs, fake success paths, placeholder methods or silently swallowed errors in completed modules.

## Handling unresolved decisions

Open decisions are recorded in \`docs/spec/ACCEPTANCE_CRITERIA.md\` and \`docs/spec/MASTER_SPEC.md\`.

Before coding, check which decisions affect your module:
- You may implement isolated stage-0 logic using fakes and stable interfaces while real-game compatibility decisions remain open.
- Do not implement or claim a real Mineflayer connection, authentication flow, SQLite driver deployment or Ollama model compatibility until its relevant decision has been verified.
- If a decision blocks your work, stop at the boundary and report the exact decision needed. Do not silently choose a production value.
- A decision can be closed only through an explicit owner decision or a documented, tested ADR. Do not edit an item from “open” to “resolved” without evidence.

## Required engineering workflow

For each change:

1. Read the relevant requirements and current implementation.
2. State the exact contract and file ownership.
3. Implement the smallest complete vertical slice.
4. Add unit/contract/integration tests appropriate to the change.
5. Run the relevant tests and report exact commands/results.
6. Check error paths, cancellation, timeouts, bounds and cleanup.
7. Check memory/queue/log limits for any long-lived state.
8. Update documentation when behaviour or interfaces change.
9. Report what is implemented, what is tested, what is not tested and remaining blockers.

A test not run is not a passing test. A stub is not an implementation. A successful compile is not proof of runtime compatibility.

## Module work ownership

Before editing shared files, declare ownership of the affected module(s). The module contracts in \`docs/spec/MODULE_INTERFACES.md\` are authoritative. If several agents work in parallel, assign non-overlapping module directories and nominate one integration owner for cross-module contract changes.

Preferred first implementation order:
1. Stage-0 config, protocol schemas, StateStore abstraction and migration tests.
2. TaskManager with transactional task/objective/lease invariants.
3. Worker protocol and fake WorkerHost.
4. TaskScheduler and allocation tests.
5. Coordinator integration and dashboard/CLI adapters.
6. Ollama client and deterministic reasoning fallback.
7. Real WorkerHost/BotController after compatibility and deployment decisions are closed.
8. One-bot then two-bot private-server integration.

Do not jump to twenty bots before the earlier acceptance gates pass.
