# Verification, Leak & Staged Rollout Test Plan

**Document:** `docs/spec/TEST_PLAN.md`  
**Specification version:** 1.1.0  
**Test Runner:** Built-in `node:test` + `node:assert/strict` (zero bloated test-framework dependencies on Termux)  
**Current Baseline on `main`:** `19/19` tests passing (`npm test`), `3/3` `--expose-gc` leak suites passing (`npm run test:leaks`), multi-process `0..20` bot benchmark passing (`npm run bench`).

---

## 1. Test Pyramid & Directory Layout

~~~text
tests/
├── unit/
│   ├── config.test.js              # loadConfig caps (<=20), TLS rules, Ollama URL policy
│   ├── schemaValidator.test.js     # All JSON Schemas (AI_PROTOCOL.md) + DAG cycle rejection
│   ├── taskManager.test.js         # Legal/illegal state transitions, idempotency, epoch fencing
│   ├── taskScheduler.test.js       # 1-bot vs subset vs swarm, splitQuota, partitionRegion
│   ├── inventoryLedger.test.js     # All 7 verification policies, pickup-drop, atomic transferId
│   ├── capabilityProfiler.test.js  # Exponential decay p50/p10 + conservative cold-start priors
│   └── authService.test.js         # Bounded scrypt concurrency, session hashing, CSRF, RBAC
├── integration/
│   ├── persistenceRecovery.test.js # SQLite WAL crash recovery, lease expiry, backup/verify
│   ├── workerProtocol.test.js      # Bootstrap -> register -> heartbeat -> long-poll -> ack -> fence
│   ├── coordinatorFlow.test.js     # Dashboard/CLI/Chat unified submission + clarification
│   └── aiFallback.test.js          # Mock Ollama valid/malformed/timeout/offline + fast-path
├── e2e/
│   ├── simulatedSwarm.test.js      # Multi-process Master + WorkerHosts at 1, 2, 5, 10, 20 bots
│   └── minecraftHarness.test.js    # Controlled local test server harness (Stage 2+)
└── performance/                    # IMPLEMENTED ON MAIN (19/19 passing)
    ├── modules.test.js             # RingBuffer, BoundedCache, ByteQueue, Timers, CompactCodec, etc.
    ├── governor-and-ai.test.js     # ResourceMonitor, WorkloadGovernor hysteresis, AiEfficiencyController
    └── memory-leaks.test.js        # --expose-gc reconnect, SSE backpressure, task retention checks
~~~

---

## 2. Mandatory Unit & Contract Test Cases

### 2.1 Allocation & Quota Precision (`tests/unit/taskScheduler.test.js`)
1. **Single-bot wins trivial task:** `"Craft 1 wooden_pickaxe"` (`Q = 1`, `parallelism = 'single'`) with `10` idle bots -> selects `1` bot (`quotas = [{ botId, quantity: 1 }]`).
2. **Single-bot wins high-travel small batch:** `"Mine 6 cobblestone"` when `bot-1` is `4` blocks away (`r_p50 = 0.8/s`) and `bot-2..5` are `120` blocks away -> selects `bot-1` alone (`RelativeGain < 0.10`).
3. **Cooperating subset wins medium batch with contention:** `"Collect 64 oak_log"` with `2` nearby grove work faces and `6` eligible bots -> selects `2` or `3` bots where `T_contention` halts adding a 4th bot.
4. **Full eligible swarm wins wide uncontested batch:** `"Collect 400 cobblestone"` across `5` uncontested mining lanes with `5` nearby bots -> selects all `5`, `sum(quotas) === 400`.
5. **Exact quota conservation (`splitQuota`):** Fuzz `1,000` random `(remainingQuantity in 1..5000, botWeights in 1..20)` cases -> assert integer `q_k >= 1` and `sum(q_k) === remainingQuantity` in `100%` of cases.
6. **Spatial exploration (`partitionRegion`):** `128x128` region across `4` bots -> `4` disjoint sub-boxes with exact area conservation and `0` overlap.
7. **Cold-start uncertainty gate:** Unmeasured bots (`sampleCount = 0`) require `>= 0.18` relative gain and `z >= 1.0` before expanding past `1` bot.

### 2.2 Evidence & Anti-False-Progress (`tests/unit/inventoryLedger.test.js`)
1. **Pre-existing stock rejected:** Bot starts assignment with `baseline = 32 cobblestone`, mines `0`, reports `after = 32` -> `creditedDelta === 0`.
2. **Unrelated item rejected:** Objective targets `minecraft:cobblestone`; bot picks up `64 minecraft:dirt` and `5 minecraft:cobbled_deepslate` -> `creditedDelta === 0` (unless `allowEquivalentVariants` explicitly enabled).
3. **Pickup-then-drop before report:** Bot starts at `0`, picks up `10` mid-run (unreported), drops `4`, reports `after = 6` -> `creditedDelta === 6`; under `held_stock`, subsequent loss reduces held balance.
4. **Two-bot transfer conservation:** Bot A (`+20` mined) transfers `20` to Carrier Bot B under shared `transferId` -> total swarm `newly_collected` credit remains `20` (never `40`, never `0`).
5. **Crafted output verification:** Claiming `+1 minecraft:wooden_pickaxe` without `-3 planks` and `-2 sticks` delta fails `crafted_output` verification (`disputed: true, creditableDelta: 0`).
6. **Duplicate & out-of-epoch reports:** Replaying identical `messageId` or `evidenceId` returns idempotent ack (`creditedDelta === 0`); submitting report with `allocationEpoch = 1` after Master fenced to `epoch = 2` returns `STALE_ALLOCATION_EPOCH`.

### 2.3 AI Protocol & Fallback (`tests/unit/schemaValidator.test.js`, `tests/integration/aiFallback.test.js`)
1. Reject extra keys (`additionalProperties: false`), cyclic `dependencies`, missing `clarificationQuestion` when `clarificationRequired: true`, and `workerCountHint > 20`.
2. Reject `OllamaClient` config pointing to `http://127.0.0.1:11434`, `http://localhost:11434`, or `https://api.openai.com`.
3. Assert `PlanningContextV1` never exceeds `8,192 bytes` and contains zero chunk/chat/secret fields.
4. Simulate Ollama timeout, `500`, and malformed JSON -> assert `0` retries on malformed schema, clean deterministic fallback or `clarification_required`, and `0` crashed processes.

---

## 3. Recovery, Security & Leak Suites

### 3.1 Crash & Partition Recovery (`tests/integration/persistenceRecovery.test.js`)
1. Start task (`target = 100`), credit `40` verified units on Lease 1 (`quota = 60`), kill Master abruptly, advance clock past `expiresAt`, run `Coordinator.recover()` -> assert `verified = 40`, `reserved = 0`, `remaining = 60`, `allocationEpoch = 2`, and late Lease-1 report is fenced.
2. Simulate lost assignment ack (`offered` command executed by worker while ack dropped) -> worker reconnects with `snapshots` + `events` prior to expiry -> Master reconciles `40` units without duplicate assignment.

### 3.2 Security Controls (`tests/unit/authService.test.js`, `tests/integration/workerProtocol.test.js`)
1. `viewer` role receives `403 FORBIDDEN` on task creation, cancel, safe-stop, and worker enrollment.
2. Valid session cookie **without** `X-CSRF-Token` or with cross-site `Origin: https://evil.example` receives `403 CSRF_INVALID`.
3. Consumed or expired `bootstrapToken` fails replay (`401`); revoked `workerToken` immediately fails `/worker/v1/heartbeat` and fences active assignments.
4. `10` simultaneous login requests execute through concurrency-1 KDF queue (`<= 4` queued, excess `429`) without exceeding bounded `scrypt` memory.

### 3.3 Automated Memory-Leak & Scale Regression (`tests/performance/memory-leaks.test.js` & `benchmarks/run-benchmarks.js`)
1. `npm run test:leaks` (`node --expose-gc`):
   - `20` bot connect/disconnect cycles -> `0` retained `EventEmitter` listeners, `0` ref'd timers, `< 2.0 MiB` post-GC heap delta.
   - `600` rapid dashboard mutations across slow/disconnecting SSE clients -> coalesced emission, `0` leaked stream sockets.
   - `100` full task lifecycles -> bounded ring/cache sizes, flat post-GC heap.
2. `npm run bench`:
   - Runs `0, 1, 2, 5, 10, 20` bot multi-process suite and verifies `20/20` tasks completed, `0` silently discarded tasks under `WorkloadGovernor` pressure, and flat Master RSS.

---

## 4. CI & Pre-Merge Command Checklist

Every coding agent PR MUST pass all four commands cleanly (`exit code 0`):

~~~bash
npm test
npm run test:leaks
npm run check:termux
npm run bench
~~~
