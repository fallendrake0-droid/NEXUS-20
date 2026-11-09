# Acceptance Criteria and Delivery Gates

**Specification:** 1.0.0  
**Release status:** Not yet implemented or tested by this specification.  
**Rule:** A stage cannot advance until its required evidence is attached to the repository.

## 1. Global invariants

| ID | Acceptance criterion | Evidence |
|---|---|---|
| G-01 | One authoritative TaskManager owns tasks, objective state, leases and progress | Unit/integration tests and architecture review |
| G-02 | Dashboard, CLI and chat route through the same Coordinator | End-to-end tests showing identical task IDs/state |
| G-03 | Shared quantity target is aggregate, never multiplied by bot count | Two-bot test for target 100 with quotas summing to 100 |
| G-04 | One bot is selected when extra bots do not produce material improvement | Scheduler regression test |
| G-05 | Multiple bots are selected only when feasible and expected improvement passes threshold | Benchmark-backed allocation decision record |
| G-06 | Dependencies are acyclic and respected | DAG validation and execution-order test |
| G-07 | Actual inventory/evidence is verified before progress is credited | InventoryLedger tests |
| G-08 | Duplicate/stale worker events cannot double-credit | Idempotency and epoch-fencing tests |
| G-09 | Worker loss is reconciled before its unverified quota is reassigned | Failure-injection test |
| G-10 | AI output cannot directly execute game actions | Schema/policy/security tests |
| G-11 | Deterministic supported tasks work without Ollama | Offline fallback test |
| G-12 | No paid inference/API fallback exists | Config inspection and network test |
| G-13 | Phone runs no local LLM and no twenty-client production load | Deployment configuration review |
| G-14 | No server authentication, anti-cheat, access or connection limits are bypassed | Security test and operator config review |
| G-15 | All external protocols are versioned and strictly validated | Contract tests |
| G-16 | Persistence survives restart and backup is restorable | Restart and restore test |
| G-17 | Logs, queues, caches and dashboard clients are bounded | Stress/overflow tests |
| G-18 | No untested package or Minecraft compatibility is represented as supported | Compatibility matrix review |

## 2. Stage 0 — coordinator foundation (zero bots)

Must pass:
- Config validation and secret redaction.
- StateStore migrations and restart recovery.
- Coordinator routes for dashboard, CLI and mock chat adapter.
- Task and objective lifecycle.
- Scheduler unit/property tests with fake bots.
- Worker protocol schemas and authentication.
- Dashboard login, CSRF, roles and safe session handling.
- ResourceMonitor and bounded queues.
- Ollama unavailable fallback.
- No real Minecraft account or bot connection required.

Exit gate: all stage-0 automated tests pass; no unresolved critical security defects; compatibility decisions recorded.

## 3. Stage 1 — one bot

Must pass:
- One approved worker host registers.
- One legitimate bot account connects to the private authorised server.
- Bot reports heartbeat, capabilities and compact snapshots.
- One simple objective executes deterministically.
- Initial inventory baseline and final evidence reconcile.
- Task progress is updated only by the coordinator ledger.
- Disconnect, death, low food, tool failure and cancellation are safe.
- Master or worker restart does not duplicate progress.
- Ollama may be unavailable without affecting supported deterministic actions.

Exit gate: one-bot end-to-end suite passes, two-hour soak completes without unbounded resource growth, actual benchmark captured.

## 4. Stage 2 — two bots (initial target)

Must pass:
- Two independent BotControllers connect through one or more worker hosts.
- Shared target of 100 cobblestone is divided into non-overlapping quotas whose sum is exactly 100.
- Each bot's actual inventory change is verified.
- A bot with unsuitable tool/health/position can be excluded.
- Scheduler uses one bot for a single craft operation when that is more efficient.
- Two resource targets can be scheduled independently.
- One worker loss releases only its unverified quota after reconciliation.
- Stale worker events and duplicate completion messages cannot double-count.
- Builder + guard roles use separate objectives.

Exit gate: all shared-task correctness and recovery tests pass; measured two-bot makespan compared with one-bot baseline; phone memory/CPU and worker memory results recorded.

## 5. Stage 3 — five bots

Must pass:
- Global and per-worker slot limits.
- Quota split among 1–5 candidates with exact integer total.
- Scheduler does not always use all five.
- Spatial exploration partitions are disjoint.
- Resource contention is measured and penalised.
- Load, SSE, database, heartbeat and network-partition tests pass.
- Phone coordinator retains compact state only.

Exit gate: five-bot soak and fault-injection evidence; no correctness regression from stage 2.

## 6. Stage 4 — ten bots

Must pass:
- Multiple authorised worker hosts.
- Worker registration and independent revocation.
- Reconnection jitter avoids synchronized reconnect storm.
- One slow worker does not block all workers.
- Command/event throughput remains bounded.
- Database reconciliation and recovery succeed under concurrent worker failures.
- Dashboard remains usable and bounded.

Exit gate: ten-bot soak, benchmark and security review.

## 7. Stage 5 — twenty bots

Must pass:
- Twenty bot identities distributed across authorised worker devices.
- Configured server connection cap is respected; if the server cap is lower than twenty, the stage cannot be tested on that server and must use a separate authorised test environment.
- Master rejects bot 21.
- No phone-side Mineflayer sessions required.
- Scheduling evaluates only feasible bots and uses all twenty only when the measured improvement is beneficial.
- Worker failures and reconnects do not duplicate assignments or progress.
- All task, security, performance and persistence tests pass.
- Actual per-device resource results are documented.

Exit gate: twenty-bot controlled soak, full regression, recovery evidence, server/operator authorisation and signed-off compatibility matrix.

## 8. Release readiness checklist

- [ ] Master context and all spec docs are consistent.
- [ ] All open decisions have an owner and status.
- [ ] Node and package lockfile are committed.
- [ ] Exact Minecraft protocol compatibility is proven.
- [ ] Database driver works on Termux and has tested backup/restore.
- [ ] Dashboard, CLI and chat adapter share Coordinator.
- [ ] Worker auth and revocation are tested.
- [ ] Minecraft account credentials remain on worker devices.
- [ ] Ollama endpoint is private and no paid fallback is configured.
- [ ] Shared target and resource ledger invariants pass.
- [ ] Failure/reconnection tests pass.
- [ ] Performance results come from the actual Galaxy A06.
- [ ] No placeholder functions remain in implemented modules.
- [ ] All required tests pass; skipped tests are listed as blockers.
- [ ] Security review has no unresolved critical/high issues.

## 9. Explicit unresolved decisions

| ID | Decision | Required resolution |
|---|---|---|
| U-01 | Exact Minecraft Java server version | Select private authorised target and verify protocol tuple |
| U-02 | Mineflayer and plugin package versions | Pin exact versions after connection/action tests |
| U-03 | SQLite driver for Termux | Benchmark built-in node:sqlite versus maintained package; verify crash recovery and Android filesystem |
| U-04 | Initial worker hardware and OS | Name worker hosts and set per-host bot limits |
| U-05 | Server max connections | Set operator-approved explicit cap |
| U-06 | Online auth provider/flow | Verify legitimate Mineflayer auth implementation for pinned package |
| U-07 | Remote Ollama model and hardware | Test free model schema adherence, planning quality, latency and stability |
| U-08 | High-risk task approval policy | Define hazards and approval thresholds |
| U-09 | Chat allowlist and prefix | Configure player UUIDs and allowed verbs per server |
| U-10 | Human dashboard administrator bootstrap/MFA | Define first-admin provisioning and recovery |
| U-11 | Worker transport identity | Decide bearer-only versus mutual TLS plus bearer |
| U-12 | Performance SLOs and thresholds | Derive from on-device benchmark; do not invent |
| U-13 | Worker local checkpoint durability | Select local store format and test crash recovery |
| U-14 | Multi-bot server behaviour | Verify server permits multiple authorised accounts and independent sessions |

No unresolved item may be silently converted into a production assumption.

## 10. Definition of done

The project is done only when:
- every global criterion G-01 through G-18 passes;
- each requested scale stage has passed its exit gate or is explicitly marked unsupported with evidence;
- exact dependency and Minecraft compatibility are documented;
- no known critical correctness/security issue remains;
- measured resource performance is acceptable on the actual controller and worker hardware;
- the source implementation has no placeholder methods, fake success responses or untested compatibility claims.

A written specification alone does not satisfy implementation acceptance.

