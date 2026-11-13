# Low-Memory Performance Architecture — Samsung Galaxy A06 (4 GB RAM)

**Document:** `docs/spec/PERFORMANCE_PLAN.md`  
**Specification version:** 1.1.0  
**Evidence Baseline:** `PERFORMANCE_REPORT.md` & `benchmarks/results/latest-benchmark.json` (empirical Node v22 measurements)  
**Implemented Primitives (`main`):** `src/monitoring/ResourceMonitor.js`, `src/monitoring/WorkloadGovernor.js`, `src/events/EventBus.js`, `src/performance/*.js`

---

## 1. Hardware Reality & Non-Negotiable Constraints

The Master Controller runs inside Termux on a **Samsung Galaxy A06 (4 GB total system RAM, Android 16, ARM64)**:

1. **Shared OS memory:** Android 16 kernel, GPU carve-outs, System UI, Launcher and background services consume a majority of the 4 GB total RAM before Termux starts. **Never** assume 4 GB is available to Node.js, and **never** invent guaranteed device memory numbers — measure on the target device (`npm run check:termux`, `npm run bench`) and report unavailable OS files as `'unavailable'`.
2. **V8 default heap trap (proven empirically):** On a 4 GB host, Node 22 defaults `v8.getHeapStatistics().heap_size_limit` to **`1,954 MiB`** (`~2 GB`), allowing V8 lazy GC to balloon RSS until Android `lmkd` kills Termux (`SIGKILL`).
   - **Mandatory launch flag on Galaxy A06:** `NODE_OPTIONS="--max-old-space-size=256"`.
3. **Zero `mineflayer` / `minecraft-data` on the phone (proven empirically):**
   - `minecraft-data@3.119.0` unpacks to **`499 MiB`** on disk (`1,344` files) and adds **`+23.5 to +45.4 MiB`** RSS when loaded; `mineflayer + pathfinder` adds **`+37.9 MiB`** RSS.
   - The phone **never** installs or `require()`s `mineflayer`, `prismarine-world`, `mineflayer-pathfinder` or full `minecraft-data`. Only remote `WorkerHost` machines load Mineflayer, and each `WorkerHost` shares **one** immutable `minecraft-data` instance across its local bots.
4. **Termux / Android Bionic native addon reality:**
   - Audited npm releases of `better-sqlite3@13.0.3`, `argon2@0.45.2`, `bcrypt@6.0.0`, and `sqlite3@6.0.1` ship **zero** `android-arm64` Bionic prebuilds.
   - Built-in **`node:sqlite` (`DatabaseSync`)** (`+2.21 MiB` RSS, `0.025 ms` p50 WAL commit, native `sqlite.backup`) and concurrency-1 **`node:crypto.scrypt`** (`73.5 ms`, `32 MiB` bounded `N=32768, r=8, p=1, maxmem=36 MiB`) require zero C++ addon compilation (subject to physical Galaxy A06 verification `U-03`).
5. **Android 16 Phantom Process Killer & Doze rules:**
   - Run `termux-wake-lock` while Master is active.
   - Store SQLite WAL databases strictly inside Termux `$HOME` (`~/.local/share/mineflayer-ai-swarm/`), **never** on `/sdcard` or `/storage/emulated/0` FUSE mounts (broken `mmap`/POSIX locks + 10x–50x I/O latency).
   - Keep phone process count to **1 persistent Node.js daemon** (`0` worker child processes, `0` background shell pollers).

---

## 2. Empirical Baseline vs Optimised Architecture (`benchmarks/results/latest-benchmark.json`)

Measured across real separate OS processes (`1` Master + `1..4` WorkerHost processes, `0 -> 1 -> 2 -> 5 -> 10 -> 20` bots, `20/20` tasks and `1,396/1,396` verified units completed in both modes):

| Metric (20-Bot `4×5` Swarm) | Naive Baseline | Optimised Architecture | Measured Delta | Design Target |
|---|---:|---:|---:|---|
| Master Peak RSS | `84.76 MiB` | **`62.47 MiB`** | **`-26.3%`** | `< 140 MiB` normal, `< 180 MiB` constrained |
| Master Post-GC Heap Used | `13.20 MiB` | **`6.30 MiB`** | **`-52.3%`** | Flat `O(active_bots)`, zero leak slope |
| Master Total CPU Time | `599.4 ms` | **`299.6 ms`** | **`-50.0%`** | Minimal coordinator serialization |
| Master DB Commit `p95` | `1.039 ms` | **`0.321 ms`** | **`-69.1%`** | `< 10 ms` normal |
| Master Inbound / Outbound Wire | `4,809 / 17,111 KB` | **`138.7 / 83.5 KB`** | **`-97.1%` / `-99.5%`** | Compact DTOs + coalesced SSE |
| Dashboard SSE Frames (3 clients) | `2,388` | **`3`** | **`-99.9%`** | `<= 1 Hz` normal |
| Remote AI Calls (`20` intents) | `20` | **`1`** | **`-95.0%`** | Fast-path + cache + dedupe |
| Worker Hosts Sum Peak RSS (`4` hosts) | `373.60 MiB` | **`255.15 MiB`** | **`-31.7%`** | Shared `mcData` + `viewDistance: 4` |
| Worker Hosts Sum CPU | `3,698.0 ms` | **`1,029.4 ms`** | **`-72.2%`** | `PathfindingGuard` + `BlockSearchCache` |
| Voxels Scanned (`20` tasks) | `26,512,000` | **`2,112,000`** | **`-92.0%`** | Cached chunk-local lookup |
| Leaked Bot Listeners / Timers | `240` / `20` | **`0` / `0`** | **`-100%`** | `ScopedListeners` + `TimerRegistry` |

Master RSS remains virtually flat across scale (**`61.5 MiB` at 1 bot -> `62.5 MiB` at 20 bots**).

---

## 3. Continuous Runtime Measurement (`ResourceMonitor`)

`src/monitoring/ResourceMonitor.js` samples on a single `.unref()`'d timer (`2,000 ms` normal, `5,000 ms` constrained/critical) into a fixed-capacity `RingBuffer` (`120` samples max):

1. **Process memory:** `rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`, `v8HeapLimit` (`process.memoryUsage()` + `v8.getHeapStatistics()`).
2. **OS memory:** Linux/Android `/proc/meminfo` (`MemAvailable`, `MemTotal`) via pre-allocated `4 KB` scratch `Buffer`; reports `'unavailable'` when unreadable by Android SELinux.
3. **CPU & Event Loop:** `process.cpuUsage()` utilization % and `perf_hooks.monitorEventLoopDelay` (`p50`, `p95`, `p99`, `max` in ms).
4. **SQLite latency:** `p50`, `p95`, `max` ms per transaction.
5. **Queues, caches, timers, listeners, network, AI & SSE:** Registered live probes with zero unbounded arrays.

---

## 4. Hard Memory, Cache, Log & Stream Bounds

Every in-memory structure on Master and WorkerHost MUST use the bounded primitives in `src/performance/`:

| Subsystem | Primitive (`src/performance/`) | Normal Cap | Constrained / Critical | Overflow / Eviction Policy |
|---|---|---|---|---|
| Plan & template cache | `BoundedCache` | `64` entries / `256 KiB`, TTL `10m` | `16` entries / `0` entries (flushed) | LRU + byte budget + TTL |
| Scheduler rate cache | `BoundedCache` | `128` entries / `128 KiB`, TTL `5m` | `32` entries / `16` entries | LRU + byte budget |
| Diagnostics log ring | `BoundedLogger` | `200` entries (`info` level) | `warn` level in critical | Overwrite oldest in memory; rotate `5 MiB × 3` JSONL files |
| Worker outbound event queue | `BoundedByteQueue` | `256` msgs / `512 KiB` | Pause non-survival bot intake (`pause_and_checkpoint`) | Never drop completion/failure evidence |
| Dashboard live stream | `SseCoalescer` | `1,000 ms` (`1 Hz`), max `4` clients | `3,000 ms` (`0.33 Hz`) / `5,000 ms` (`0.2 Hz`) | Keyed state overwrite per `botId`/`taskId`; drop slow socket > `64 KiB` buffered (`res.writableNeedDrain`) |
| Worker telemetry heartbeat | `CompactSnapshotCodec` | `5,000 ms` (`<= 2.5 KiB`/bot) | `10,000 ms` / `15,000 ms` | Latest compact snapshot overwrites prior |
| Bot Mineflayer world | `BotController` config | `viewDistance: 4` | `viewDistance: 3` on host pressure | Distant chunks unloaded by Mineflayer |
| Bot block search | `BlockSearchCache` | `64` keys, radius `<= 32`, `4,096` blocks/scan | Radius `<= 16` | Dirty-chunk `(cx, cz)` invalidation |
| Bot pathfinding | `PathfindingGuard` | `thinkTimeout <= 1,500 ms`, cooldown `1,000 ms` | `thinkTimeout <= 800 ms` | Single active run per bot; stuck detector (`3` windows -> abort) |
| Bot chat filter | `ChatHistoryGuard` | `0` ambient chat lines retained (`maxRetained = 8`) | Same | Immediate `O(1)` prefix + allowlist drop |

---

## 5. Adaptive Concurrency & Memory-Pressure Recovery (`WorkloadGovernor`)

### 5.1 Pressure Thresholds (Default Galaxy A06 Profile)

| Metric | `normal -> constrained` | `constrained -> critical` | Hysteresis Exit Rule |
|---|---|---|---|
| Master RSS (`--max-old-space-size=256`) | `>= 175 MiB` | `>= 215 MiB` | Stay `<= 185 MiB` (`critical -> constrained`) / `<= 150 MiB` (`constrained -> normal`) for `recoveryCooldownMs` |
| Heap ratio (`heapUsed / v8HeapLimit`) | `>= 0.70` | `>= 0.85` | Stepwise only: `critical -> constrained -> normal` (`<= 0.60` for `normal`) |
| OS `MemAvailable` (`/proc/meminfo` only) | `<= 550 MiB` | `<= 350 MiB` | Ignored cleanly if `'unavailable'` or `node:os_memfree` (`CRIT-03`) |
| Event-loop `p95` lag | `>= 60 ms` | `>= 180 ms` | Stay `<= 35 ms` for `normal` |
| Task queue depth | `>= 25` | `>= 60` | Drains cleanly before restoring concurrency |

### 5.2 Deterministic Shedding & Recovery Sequence (`0` Tasks Silently Discarded)

- **Entering `constrained`:**
  1. Evict expired entries and shrink `BoundedCache` budgets to `25%`.
  2. Throttle Dashboard `SseCoalescer` to `3,000 ms` (`0.33 Hz`) and Worker non-critical telemetry to `10,000 ms`.
  3. Cap `TaskScheduler` subset candidate search width `K = 3` and reduce `effectiveBotConcurrency` to `ceil(0.5 * configuredCap)`.
  4. Defer new `low`-priority tasks (`action: 'paused_and_queued'` in durable queue — **never discarded**) while allowing `survival`, `safety`, `high` and `normal` tasks.
  5. Emit structured `workload.reduction` audit report.
- **Entering `critical`:**
  1. Clear **all** regenerable caches (`0` bytes retained; all persistent state remains safe in SQLite).
  2. Reject new non-essential AI planning requests (`fast-path` / deterministic fallback only) and abort waiting low-priority AI queue items into `paused_and_queued`.
  3. Throttle Dashboard SSE to `5,000 ms` (`0.2 Hz`), log level to `warn`, and pause all active `low`/`normal` non-safety objectives cleanly at next checkpoint (`effectiveBotConcurrency = 0` for non-safety work).
  4. **Never shed:** bot survival (`eat_survival`, hazard escape), `safe_stop`, lease-expiry fencing, worker heartbeats, and SQLite durability commits.
- **Recovery (`critical -> constrained -> normal`):**
  - After `3` consecutive healthy samples and `cooldownMs`, `WorkloadGovernor` steps down one level and drains paused tasks in FIFO priority order via `drainResumableTasks`.

---

## 6. Galaxy A06 On-Device Benchmark Protocol (`U-03`, `U-12`)

Before increasing `enabledBots` past `2` on the physical phone, the operator runs:
1. `npm run check:termux` -> verifies Android kernel, `/proc/meminfo` visibility, `$HOME` SQLite WAL + backup, `crypto.scrypt` latency, and `--max-old-space-size=256`.
2. `npm run test:leaks` -> verifies `< 2 MiB` post-GC heap retention across `20` connect/disconnect cycles, `600` SSE frames, and `100` task lifecycles.
3. `npm run bench` -> records device-specific `benchmarks/results/galaxy-a06-benchmark.json` for `0, 1, 2, 5, 10, 20` simulated remote bots.
