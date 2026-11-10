# Contributing & Repository Integration Governance

**Integration Owner:** Lead Software Engineer & Repository Integration Owner  
**Canonical Contract Suite:** `docs/spec/*.md` (v1.1.0, reconciled against `CLAUDE_*.md`)

This repository is governed under strict single-owner integration control so multiple engineering agents (**Google Antigravity**, **OpenCode**, **Kilo Code**, **Google Jules**, and **GitHub Copilot**) can work in parallel without file collisions, duplicate subsystems, unvalidated AI payloads, or memory regressions on the 4 GB Samsung Galaxy A06 master controller.

---

## 1. Non-Negotiable Architectural & Safety Invariants

Every pull request MUST preserve all system invariants:

1. **Zero Mineflayer on the Master Phone (`G-01`):** Nothing imported by `index.js`, `src/master/*`, `src/coordinator/*`, `src/tasks/*`, `src/workers/*`, `src/persistence/*`, `src/inventory/*`, or `src/interfaces/http/*` may require `mineflayer`, `prismarine-world`, `mineflayer-pathfinder`, or `minecraft-data`.
2. **Bounded Swarm Allocation (`G-02`, `G-03`, `G-05`):**
   - Hard ceiling: **`<= 20` registered/concurrent bots** (`GLOBAL_BOT_CAP_EXCEEDED` above 20).
   - Default active concurrency: **`2` bots**, selecting **`1` bot** whenever `parallelism === 'single'` or marginal makespan improvement from an extra bot fails to clear **`>= 10%` and `>= 5s`**.
   - Aggregate targets (`"Mine 100 cobblestone"`) mean **100 verified swarm-total**, never 100 per bot (`verified_quantity + reserved_quantity <= target_quantity`).
3. **£0 Inference & Zero Unvalidated AI Execution (`G-09`, `G-10`):**
   - Zero paid cloud LLM providers (`openai.com`, `anthropic.com`, `googleapis.com`, `openrouter.ai`, etc.) and zero phone-local Ollama (`localhost` / `127.0.0.1` forbidden on Master).
   - Every AI response MUST pass `SchemaValidator.validate('TaskPlanV1', ...)` before persistence, and models NEVER emit executable JS, shell commands, SQL, or raw packets.
4. **Authoritative Verification & Lease Fencing (`G-06`, `G-08`):**
   - Workers report structured snapshots and evidence; only `InventoryLedger` + `TaskManager` credit progress, clamped to `[0, quota - credited]`.
   - Expired or revoked leases increment `objectives.allocation_epoch` **before** releasing `reserved_quantity`; stale reports are rejected with `STALE_ALLOCATION_EPOCH`.
5. **Authorised Servers & Zero Hardcoded Secrets (`G-17`):**
   - Only private test servers or servers with explicit bot permission are supported; PvP, bypasses, and griefing are disabled (`allowPvp: false`).
   - Never commit credentials, tokens, TLS private keys, or `.env` files.

---

## 2. Coding & Module Conventions

| Area | Mandatory Standard |
|---|---|
| Module system | Node.js `>= 22.5.0` CommonJS (`'use strict';` on line 1 of every `.js` file) |
| Control flow | `async/await` for async boundaries; synchronous `StateStore.transaction(() => ...)` for atomic SQLite mutations |
| Dependencies | **Zero external npm dependencies** in Master/Foundation packages; `mineflayer` & plugins permitted **only** inside isolated `WorkerHost` package scope with Integration Owner sign-off |
| Configuration | Single source of truth: `src/config/loadConfig.js` + `.env.example`. Never read `process.env.*` directly inside domain modules |
| Error handling | Throw `DomainError(code, message, options)` from `src/errors/DomainError.js` using canonical codes (`MODULE_INTERFACES.md` §2.4). Map HTTP responses exclusively via `toErrorEnvelope()` |
| Persistence | All SQLite access goes through `src/persistence/StateStore.js` (`SAVEPOINT`-safe `transaction()`). Never instantiate ad-hoc `DatabaseSync` handles |
| Logging | Use child loggers from `src/logging/createLogger.js` (`BoundedLogger`-backed). Never log tokens, passwords, cookies, or session headers |
| Timers & listeners | Register recurring intervals on `TimerRegistry` and per-assignment listeners on `ScopedListeners` |

---

## 3. Exclusive File Ownership & Branch Isolation Rules

1. **One Branch Per Specialist Task Package:** Every specialist works exclusively on their assigned branch (`specialist/<agent>-<scope>`) listed in `DEVELOPMENT_STATUS.md`.
2. **Disjoint Write Sets:** No two active specialist tasks may edit the same file simultaneously. Shared foundation modules (`index.js`, `package.json`, `.env.example`, `src/errors/*`, `src/config/*`, `src/logging/*`, `src/protocol/*`, `src/persistence/*`, `src/inventory/*`, `src/workers/*`, `src/tasks/*`, `src/scheduler/quotaMath.js`, `src/coordinator/*`, `src/master/*`, `src/performance/*`, `src/monitoring/ResourceMonitor.js`, `src/monitoring/WorkloadGovernor.js`) are **Integration-Owner Locked**.
3. **Interface Change Requests:** If a specialist discovers a missing method or DTO field in `docs/spec/MODULE_INTERFACES.md`, they MUST stop and request an interface amendment from the Integration Owner rather than monkey-patching or duplicating foundation classes.

---

## 4. Integration Review & Pre-Merge Gate Checklist

Before any specialist branch is merged by the Integration Owner, all of the following gates MUST pass honestly with zero skipped or stubbed assertions:

```bash
npm run check:config
npm test
npm run test:leaks
npm run check:termux
npm run bench
```

Every PR review verifies:
- [ ] Only files listed in the specialist's assigned ownership manifest were modified.
- [ ] Zero duplicate implementations of `BoundedLogger`, `SchemaValidator`, `StateStore`, `CompactSnapshotCodec`, `TimerRegistry`, or `splitQuota`.
- [ ] All public signatures and DTO schemas match `docs/spec/MODULE_INTERFACES.md` and `docs/spec/AI_PROTOCOL.md` (`schemaVersion: 1`).
- [ ] Master RSS stays `< 175 MiB` (`~64 MiB` benchmarked at 20 distributed bots) with zero Mineflayer imports in Master `require.cache`.
- [ ] Zero credentials, tokens, or `.db` / `.log` artifacts committed to Git.
