# Test Plan — Mineflayer AI Swarm

**Specification:** 1.0.0  
**Test environment:** private authorised Minecraft Java server and controlled worker devices.  
**Test philosophy:** tests prove correctness and safety before scale. A successful bot login is not acceptance.

## 1. Test layers

### Unit tests

Use Node's test runner or a pinned compatible test runner. Use deterministic fake clocks and fake transports.

Cover:
- config parsing and validation;
- task/objective state transitions;
- dependency graph and cycle rejection;
- quota splitting and aggregate arithmetic;
- candidate eligibility;
- travel/rate estimator and confidence handling;
- marginal benefit rule;
- lease expiration and epoch fencing;
- inventory identity, deltas and transfer deduplication;
- event/message idempotency;
- schema validation and semantic validation;
- chat parser and player allowlist;
- auth role checks and CSRF middleware;
- resource governor state transitions;
- cache and queue bounds.

### Contract tests

- Master and worker accept only declared protocol versions.
- JSON schemas reject missing/extra/wrong-type fields.
- Assignment ownership and sequence checks hold.
- Event acknowledgement is idempotent.
- Worker cannot read another worker's bot/task evidence.
- Command envelope can be encoded/decoded across supported Node versions.
- Ollama response matches the strict schema or is rejected.

### Integration tests

Run:
- Coordinator + StateStore with migrations.
- Coordinator + mock worker transport.
- WorkerHost + fake Mineflayer adapter.
- One actual Mineflayer bot on a private test server.
- Two independently connected bots using a shared objective.
- Ollama host available and unavailable.
- Dashboard, CLI and Minecraft chat ingress against the same coordinator.

### End-to-end tests

Use exact supported version tuple: Node, Mineflayer, minecraft-protocol, minecraft-data, optional plugins, Minecraft server version and server settings.

Scenarios:
1. Start one bot and inspect status.
2. Submit a bounded collection task.
3. Collect a shared quantity and verify the ledger.
4. Submit two resource objectives.
5. Craft one item and verify output.
6. Explore two disjoint regions.
7. Build while a separate bot guards.
8. Disconnect worker during task and recover.
9. Kill/restart master and reconcile active worker leases.
10. Pause/cancel during navigation and mining.
11. Lose Ollama during a task.
12. Hit server connection cap and confirm no extra bot connects.
13. Send unauthorised chat command and confirm no action.
14. Re-send duplicate worker events and confirm only one ledger credit.
15. Submit stale assignment epoch and confirm rejection.

### Security tests

- Invalid/missing dashboard session.
- Viewer attempting operator/admin operation.
- CSRF token missing or wrong.
- Wrong Origin/CORS.
- Brute-force login rate limiting and account enumeration.
- Replayed worker message and stale sequence.
- Revoked worker token.
- Oversized payload, deep JSON, unknown fields and invalid schema.
- Chat injection and prompt-injection strings.
- Ollama response with arbitrary command or unknown action.
- Secret scanner and log redaction.
- HTTPS requirement and certificate validation.
- Unauthorised server host rejection.
- Offline-mode config refused outside private test profile.
- Server kick/auth failure does not trigger bypass or infinite reconnect.

### Performance and resilience tests

- Baseline memory/CPU on actual Galaxy A06.
- Two-bot two-hour soak.
- Five, ten and twenty remote-bot scale runs.
- SSE slow client and disconnected client behaviour.
- Worker/network partition and reconnect storm.
- Ollama timeout, slow output and invalid output.
- StateStore busy/corrupt/unavailable scenarios.
- Disk full and backup restore.
- Android app backgrounding, Termux pause/resume and low-memory pressure.
- Queue overflow and rate limiting.
- Event-loop lag and CPU saturation.

## 2. Test fixtures

Maintain deterministic fixtures:
- fake worker with configurable latency and failures;
- fake bot snapshot and inventory;
- fake world with known resource nodes and route costs;
- inventory baselines with pre-existing items;
- duplicate pickup/drop/transfer events;
- fixed task DAGs;
- controlled action-rate sample distributions;
- Ollama valid, invalid, timed out and malformed responses;
- private server profile with approved maximum connections.

Every fixture must state server version, item registry version and expected result. Avoid relying on public servers.

## 3. Allocation tests

Required cases:
- one bot faster than two after overhead;
- two bots faster than one beyond benefit threshold;
- one bot has tool and other does not;
- nearest bot has poor tool durability;
- bot has low health/food and becomes ineligible;
- bots share one narrow resource node causing contention;
- resources in disjoint regions enable parallelism;
- task quantity smaller than number of bots;
- quota integer rounding;
- candidate data stale or unknown;
- server cap reached;
- multiple objectives with independent or dependent DAG nodes;
- role-based builder + guard;
- scheduler sees no expected improvement and chooses one bot.

Property-based invariants:
- sum of assigned quotas never exceeds remaining target;
- verified + reserved never exceeds target;
- no objective starts before dependencies complete;
- at most one active conflicting assignment exists per bot;
- no allocation references an unregistered bot;
- stale epoch cannot change current state;
- task completion requires verified objective completion.

## 4. Inventory verification tests

1. Baseline inventory already contains target item; newly_collected does not credit it.
2. After snapshot shows a valid positive target-item delta; credit only delta and within quota.
3. Another item increases; target progress unchanged.
4. Item picked up then dropped; held_stock does not count dropped amount.
5. Item is consumed by crafting; input debit and crafted output credit are distinct.
6. Transfer occurs; both bots do not count the same item twice.
7. Duplicate evidence message is replayed; ledger updates once.
8. Evidence from an expired lease is rejected or reconciled under the expiry cutoff.
9. More quantity is reported than quota; credit capped/rejected and discrepancy recorded.
10. Registry item variant mismatch; no credit until canonical identity matches.
11. Container deposit is reported but destination inventory did not increase; no deposit credit.
12. Inventory snapshot is unavailable; mark progress uncertain, never complete.

## 5. Recovery tests

- Worker disconnects before command acknowledgement.
- Worker disconnects after acknowledgement but before action.
- Worker disconnects after action but before completion event.
- Master restarts while worker is active.
- Worker restarts while master is active.
- Lease expires while worker still has stale command.
- Old worker returns after lease has been reallocated.
- Event sequence skips or duplicates.
- DB commit succeeds but response is lost.
- Bot reconnects with different entity ID but same configured bot identity.
- Two events race to complete the same objective.

At every boundary, verify no duplicated command side effect and no duplicated resource credit.

## 6. Cross-platform compatibility

- Termux on the Galaxy A06 with the exact installed Node version.
- Each authorised worker operating system and Node version.
- Exact Minecraft server/client protocol tuple.
- Exact Mineflayer and plugin versions.
- TLS/certificate configuration for private LAN/VPN.
- SQLite driver, filesystem, WAL and crash recovery on Android/Termux.

Do not infer compatibility from desktop Linux results.

## 7. Test output and evidence

CI and release evidence must include:
- test command and exit status;
- Node and package versions;
- schema version;
- Minecraft/server compatibility tuple;
- performance benchmark result;
- acceptance criterion IDs;
- known flaky tests and reason;
- failures not yet resolved.

No test may be reported as passed if it was skipped. A skipped test is an open acceptance item.

