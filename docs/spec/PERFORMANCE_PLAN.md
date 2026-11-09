# Performance Plan — Galaxy A06 Coordinator and Distributed Workers

**Specification:** 1.0.0  
**Target controller:** Samsung Galaxy A06, Android 16, Termux, 4 GB RAM.  
**Core requirement:** the phone is a lightweight coordinator and must not run the local LLM or twenty Mineflayer clients.

## 1. Performance model

The physical RAM label is not the memory available to the Termux process. Android, the kernel, services and other applications consume memory. The coordinator must measure actual process and system conditions on the device before setting production thresholds.

Remote Mineflayer bots consume memory on their worker hosts. The phone holds only bounded summaries and durable state. Do not ship chunk columns, full entity maps, full packet buffers, pathfinder state or Mineflayer objects to the phone.

## 2. Capacity policy

| Limit | Initial policy |
|---|---|
| Global registered bots | Hard cap 20 |
| Initial enabled bots | 2 |
| Phone-local bot slots | 0 by default |
| Per-worker bot slots | Explicit per-host config; benchmark before increasing |
| Server bot slots | Operator-approved server-specific cap; never exceed |
| Concurrent Ollama requests | 1 by default |
| Ollama pending queue | Small bounded queue; initial maximum 3 |
| Worker long polls | One outstanding request per worker host |
| Event batch | Bounded; initial maximum 100 events/request |
| HTTP body | Strict configured size cap per route |
| Dashboard SSE | Bounded clients and per-client queue |
| Task plan | Maximum 20 objectives per plan |
| Active objective count | Configurable bounded cap; start low and benchmark |

Twenty bots is architectural capacity across authorised worker machines, not a claim that the Galaxy A06 can host twenty Mineflayer sessions or that a Minecraft server allows twenty connections.

## 3. Memory and CPU measurement

Sample at a low, configurable frequency (initial target: every 5 seconds) and record:

- process RSS;
- heapTotal and heapUsed;
- external memory;
- arrayBuffers;
- process uptime;
- operating-system total and available memory when the platform exposes a meaningful value;
- CPU usage delta over a sampling interval;
- event-loop delay;
- active worker count;
- bot count (remote summary only);
- active HTTP requests and SSE clients;
- inference queue depth;
- command/event queue sizes;
- state-store query/transaction latency.

Node's process.memoryUsage() reports RSS, heap, external and array-buffer memory in bytes. RSS is not the same as V8 heap. process.memoryUsage.rss() can be used for a cheaper RSS-only sample. Platform metrics unavailable on Android must be marked unavailable, never reported as zero.

Reference: https://nodejs.org/api/process.html

Use a small rolling sample buffer and aggregate p50/p95/max. Avoid frequent full process-memory snapshots if RSS-only measurement is sufficient.

## 4. Baseline and budget derivation

Before enabling workers:

1. Reboot the phone and record idle system memory and process baseline.
2. Start coordinator only; measure after warm-up for at least 15 minutes.
3. Exercise dashboard, CLI, DB writes, heartbeats and long polls.
4. Run two remote bots and record phone plus worker host resource use.
5. Ramp remote bot counts to five, ten and twenty while holding the same coordinator workload shape.
6. Repeat with Ollama unreachable and with inference enabled (the model itself remains remote).
7. Record memory and CPU p50/p95/max, event-loop lag, GC pauses where instrumented, DB latency and missed heartbeat rate.
8. Repeat after Android background/foreground transitions and Termux process resume.

Set RSS warning and critical levels from the measured stable envelope and observed Android memory pressure. Configure a safety margin below the first repeatable OOM/LMK or latency-collapse point. Do not set thresholds solely as a fraction of 4 GB. Document the derived thresholds and evidence in PERFORMANCE_RESULTS.md.

Suggested pass criteria are relative to a measured baseline:
- no unbounded RSS growth during a 2-hour two-bot soak;
- no unbounded queues or heap growth;
- no lost committed task state;
- no repeated event-loop stalls that cause heartbeat or lease expiry;
- p95 coordinator API latency remains within the configured SLO under tested load;
- critical memory pressure triggers safe mode before process termination.

Exact numeric SLOs and memory caps remain to be filled from actual device benchmarks. The project must not invent guaranteed values.

## 5. Adaptive concurrency

Use a WorkloadGovernor with states normal, constrained and critical.

### Normal
- accept work within configured global and worker caps;
- allow normal bounded telemetry and one inference request;
- schedule only eligible workers.

### Constrained
Triggered by measured memory/CPU/lag thresholds or persistent queue pressure:
- stop admitting new optional tasks;
- pause or reject non-essential AI inference;
- reduce dashboard detail and telemetry cadence;
- coalesce worker updates;
- stop retaining high-cardinality event histories;
- reduce new assignment concurrency;
- continue durable state, heartbeats, lease safety and cancellation.

### Critical
- reject new tasks and new leases;
- stop new AI inference;
- close excess SSE clients;
- preserve database writes required for safe stop and reconciliation;
- send pause/stop commands to workers where transport is available;
- workers stop beginning new actions if leases cannot be renewed;
- keep local event log small;
- emit one critical alert and enter controlled recovery.

Recovery:
- require measurements below recovery threshold for a configured cool-down window;
- restore one level at a time;
- do not automatically replay commands whose execution outcome is uncertain.

Concurrency is bounded by the minimum of:
- global configured bot cap;
- server-specific available slots;
- worker-host available slots;
- capability-eligible bots;
- WorkloadGovernor's current concurrency cap.

The coordinator should never use memory pressure to silently increase bot concurrency.

## 6. Cache and queue limits

All caches use explicit maximum size and TTL; all queues use backpressure.

Initial starting caps to benchmark:
- bot/worker summary cache: 20 bot summaries + worker summaries;
- recent UI event ring: 1,000 compact events;
- per-client SSE queue: 100 events; on overflow disconnect and require a fresh snapshot;
- dashboard history: 60 aggregated samples;
- in-memory idempotency cache: 1,000 recent IDs, with durable deduplication in SQLite;
- inference queue: 3 waiting requests and one active;
- worker outbound local event queue: bounded by count and serialized byte size; overflow triggers safe pause and durable checkpoint, never unbounded buffering;
- HTTP request body and event batch byte caps: configurable, strict and tested.

Cache eviction must never evict authoritative ledger or task state. Cache loss must be recoverable from StateStore or worker snapshots.

## 7. Log management

- Structured, single-line logs.
- Secret and credential redaction before serialization.
- Default INFO or WARN; DEBUG only temporarily.
- Rotate by size and keep a small configured number of files.
- Initial candidate: 5 MiB per file and three files; validate filesystem behaviour and free-space margin on Termux.
- Never log full world/chunk data, raw packets, password/token values, Microsoft credentials or full private chat.
- Rate-limit repetitive errors and emit counters for suppressed events.
- Audit logs for security and task state changes are durable separately from verbose diagnostics.

## 8. Dashboard update strategy

- Dashboard initial load: one compact snapshot.
- Live updates: SSE, event-driven.
- Coalesce high-frequency metrics into a summary at most once per second.
- Worker liveness is based on heartbeat, not browser polling.
- Send detailed task updates only when state/progress changes.
- UI may render at 1–2 Hz; no need to repaint for every Minecraft movement.
- If the browser cannot keep up, drop intermediate telemetry and let it reload a snapshot.
- Use visibility handling to reduce client rendering when the dashboard tab is backgrounded.

## 9. CPU and event-loop control

- No large pathfinding computation on the phone.
- No AI inference on the phone.
- No synchronous file scans or large JSON serialization in request handlers.
- Keep SQLite transactions short; no network calls while a transaction is open.
- Paginate dashboard/task queries.
- Debounce task replans and group related failure events.
- Use event-driven Mineflayer observation on workers, not fast global polling.
- Measure event-loop delay; if the phone stalls, reduce optional work and increase safe backpressure.

## 10. Worker-side performance

Each worker host reports its own resource metrics and per-bot slot capacity. It must bound:
- number of active Mineflayer clients;
- chunk/entity data retained by each client;
- pathfinding CPU and timeout;
- action retry loops;
- inventory snapshots and event queue;
- logs and reconnect attempts.

Never infer that a device can host N bots from its RAM specification alone. Benchmark each worker model and server combination.

## 11. Benchmark matrix

| Test | Controller load | Worker load | Pass requirement |
|---|---|---|---|
| Idle baseline | coordinator only | none | stable baseline recorded |
| API load | dashboard + CLI | none | bounded latency and queues |
| Two bots | normal | two Mineflayer sessions | no correctness/resource regression |
| Five bots | normal | distributed workers | cap and heartbeat correctness |
| Ten bots | normal | distributed workers | stable bounded summaries |
| Twenty bots | normal | multiple hosts | no phone-side world-state growth |
| Ollama unavailable | fallback | tasks continue where supported | no paid fallback, no crash |
| Memory pressure | constrained/critical | active tasks | safe admission and recovery |
| Long soak | two then scale | stable scenario | no unbounded memory or queue growth |
| Network partition | active leases | workers isolated | fenced leases and no duplicate credit |

## 12. Performance results requirement

Every release candidate records:
- device model, Android version, Termux version and Node version;
- coordinator and worker process versions;
- Minecraft/server/protocol tuple;
- Ollama host/model/digest, if enabled;
- bots and worker hosts;
- duration, scenario and concurrency;
- process/system memory p50/p95/max;
- CPU and event-loop lag;
- task time prediction error;
- event/command queue maximum;
- heartbeat misses and reconnect count;
- DB latency and durable event counts.

If a metric is unavailable, label it unavailable. A successful load test on one worker machine does not prove all worker devices can host the same number of bots.

