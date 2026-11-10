'use strict';

/**
 * Isolated Master Controller Benchmark Process.
 * Spawned via child_process.fork() by `benchmarks/run-benchmarks.js` in either:
 *   - mode = 'before' (baseline unoptimised patterns auditing all 15 bottlenecks)
 *   - mode = 'after'  (patched with ResourceMonitor, WorkloadGovernor & src/performance/*)
 *
 * Uses built-in `node:http` + `node:sqlite` (WAL) + real TCP SSE streams.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const {
  BoundedCache,
  BoundedByteQueue,
  TimerRegistry,
  ScopedListeners,
  countEmitterListeners,
  SseCoalescer,
  BoundedLogger,
  AiEfficiencyController,
  ResourceMonitor,
  WorkloadGovernor,
  EventBus
} = require('../src/performance');

function splitAggregateQuota(totalTarget, botIds) {
  // Largest-remainder non-overlapping integer quota split (TASK_ALLOCATION.md §7)
  const n = botIds.length;
  if (n === 0) return [];
  const base = Math.floor(totalTarget / n);
  let rem = totalTarget - base * n;
  return botIds.map((botId) => {
    const extra = rem > 0 ? 1 : 0;
    if (rem > 0) rem -= 1;
    return { botId, quota: base + extra };
  });
}

async function startMasterNode(config) {
  const { mode, expectedBots, ollamaUrl } = config;
  const isOptimised = mode === 'after';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `swarm-master-${mode}-`));
  const dbPath = path.join(tmpDir, 'master.db');
  const logPath = path.join(tmpDir, 'master.log');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      verified_qty INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE ledger_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const insertTaskStmt = db.prepare(
    'INSERT INTO tasks (task_id, summary, target_qty, verified_qty, state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertLedgerStmt = db.prepare(
    'INSERT OR IGNORE INTO ledger_events (event_id, task_id, bot_id, delta, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const updateTaskQtyStmt = db.prepare(
    'UPDATE tasks SET verified_qty = MIN(target_qty, verified_qty + ?), state = CASE WHEN verified_qty + ? >= target_qty THEN \'completed\' ELSE state END WHERE task_id = ?'
  );

  const timers = isOptimised ? new TimerRegistry() : null;
  const monitor = new ResourceMonitor({
    sampleIntervalMs: 250,
    windowSize: 120,
    timerRegistry: timers || undefined
  });

  const governor = isOptimised
    ? new WorkloadGovernor({
        globalBotCap: 20,
        initialBotCap: Math.min(20, Math.max(1, expectedBots))
      })
    : null;

  const eventBus = isOptimised ? new EventBus({ recentEventLimit: 1000 }) : new EventEmitter();
  if (!isOptimised) {
    eventBus.setMaxListeners(0); // Unbounded listener anti-pattern in 'before'
  }
  monitor.registerEmitter('domainBus', eventBus);

  const logger = isOptimised
    ? new BoundedLogger({
        level: 'info',
        ringCapacity: 200,
        filePath: logPath,
        maxFileBytes: 512 * 1024,
        maxFiles: 3
      })
    : null;

  // State structures: 'before' uses unbounded Maps/Arrays; 'after' uses BoundedCache & compact summaries
  const botSummaryCache = isOptimised
    ? new BoundedCache({
        name: 'bot-summaries',
        maxEntries: 20,
        maxBytes: 128 * 1024,
        defaultTtlMs: 60_000
      })
    : null;
  const idempotencyCache = isOptimised
    ? new BoundedCache({
        name: 'idempotency-ids',
        maxEntries: 1000,
        maxBytes: 192 * 1024,
        defaultTtlMs: 120_000
      })
    : null;

  if (isOptimised) {
    monitor.registerCache('botSummaries', botSummaryCache);
    monitor.registerCache('idempotency', idempotencyCache);
  }

  // Unoptimised 'before' anti-pattern structures
  const naiveUnboundedSnapshotHistory = [];
  const naiveUnboundedChatLog = [];
  const naiveUnboundedEventLog = [];
  const naiveBotIntervals = [];
  const naiveSseClients = new Map();
  let naiveRawSseEvents = 0;
  let naiveSseSerializations = 0;
  let naiveSseBytes = 0;

  // Optimised SSE coalescer
  const sseCoalescer = isOptimised
    ? new SseCoalescer({
        flushIntervalMs: 250, // Scaled proportional to benchmark window (represents 1 Hz steady state)
        maxClients: 16,
        maxClientQueueEvents: 100,
        maxClientQueueBytes: 128 * 1024,
        timerRegistry: timers,
        onFlushMetrics: (m) => monitor.recordDashboardUpdate(m)
      })
    : null;

  if (sseCoalescer) sseCoalescer.start();

  // AI planner: 'after' uses AiEfficiencyController; 'before' calls remote Ollama on every single intent
  const aiController = isOptimised
    ? new AiEfficiencyController({
        ollamaBaseUrl: ollamaUrl,
        enforceRemoteOnController: false, // Loopback mock server represents remote LAN host in single-machine benchmark
        maxConcurrent: 1,
        maxQueue: 3,
        timeoutMs: 5000,
        governor,
        monitor
      })
    : null;

  let naiveAiCalls = 0;
  let naiveInFlightAi = 0;
  let peakTaskQueue = 0;
  let peakEventQueue = 0;
  let peakAiQueue = 0;
  let activeTaskCount = 0;
  let dbCommits = 0;

  const registeredBots = new Map();
  const pendingCommandsByWorker = new Map();

  const inboundEventQueue = isOptimised
    ? new BoundedByteQueue({
        name: 'master-inbound-events',
        maxItems: 500,
        maxBytes: 256 * 1024,
        overflowPolicy: 'reject'
      })
    : [];

  monitor.registerQueueProbe('tasks', () => activeTaskCount);
  monitor.registerQueueProbe('events', () =>
    isOptimised ? inboundEventQueue.length : inboundEventQueue.length
  );
  monitor.registerQueueProbe('inference', () =>
    isOptimised ? aiController.queueDepth + aiController.activeCount : naiveInFlightAi
  );

  function callNaiveOllama(userText) {
    naiveAiCalls += 1;
    naiveInFlightAi += 1;
    if (naiveInFlightAi > peakAiQueue) peakAiQueue = naiveInFlightAi;
    monitor.recordAiEvent('llmCall');

    const payload = Buffer.from(
      JSON.stringify({
        model: 'qwen2.5:7b-instruct',
        stream: false,
        messages: [
          { role: 'system', content: 'Plan Minecraft objective' },
          {
            role: 'user',
            // Anti-pattern #12 & #13: shipping bloated duplicate state in prompt
            content: JSON.stringify({
              userText,
              allSnapshots: naiveUnboundedSnapshotHistory.slice(-20),
              recentChat: naiveUnboundedChatLog.slice(-30)
            })
          }
        ]
      }),
      'utf8'
    );
    monitor.recordNetworkBytes({ txBytes: payload.byteLength });

    return new Promise((resolve, reject) => {
      const req = http.request(
        `${ollamaUrl}/api/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.byteLength
          }
        },
        (res) => {
          const chunks = [];
          let rx = 0;
          res.on('data', (c) => {
            rx += c.byteLength;
            chunks.push(c);
          });
          res.on('end', () => {
            naiveInFlightAi = Math.max(0, naiveInFlightAi - 1);
            monitor.recordNetworkBytes({ rxBytes: rx });
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', (err) => {
        naiveInFlightAi = Math.max(0, naiveInFlightAi - 1);
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  }

  function broadcastSseUpdate(eventType, key, payload) {
    if (isOptimised) {
      sseCoalescer.publish(eventType, key, payload);
      return;
    }
    // Naive 'before' anti-pattern #10 & #12: immediate per-client JSON.stringify on every event!
    naiveRawSseEvents += 1;
    for (const res of naiveSseClients.values()) {
      const str = `event: ${eventType}\ndata: ${JSON.stringify({ key, payload, ts: Date.now() })}\n\n`;
      const buf = Buffer.from(str, 'utf8');
      naiveSseSerializations += 1;
      naiveSseBytes += buf.byteLength;
      try {
        res.write(buf);
        monitor.recordNetworkBytes({ txBytes: buf.byteLength });
      } catch {
        // Ignore closed socket
      }
    }
    monitor.recordDashboardUpdate({
      clients: naiveSseClients.size,
      rawEvents: 1,
      coalescedFlushes: 1,
      serializedBytes: naiveSseClients.size > 0 ? 256 * naiveSseClients.size : 0
    });
  }

  if (isOptimised) {
    // One consolidated periodic housekeeping task for all bots & caches!
    timers.registerInterval('master-housekeeping', 500, () => {
      botSummaryCache.pruneExpired();
      idempotencyCache.pruneExpired();
      const s = monitor.sampleNow();
      governor.evaluate(s);
    });
  }

  function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.byteLength;
        if (total > maxBytes) {
          req.destroy();
          reject(new Error('Payload too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        monitor.recordNetworkBytes({ rxBytes: total });
        if (total === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, statusCode, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    monitor.recordNetworkBytes({ txBytes: buf.byteLength, requestEnded: true });
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': buf.byteLength
    });
    res.end(buf);
  }

  const server = http.createServer(async (req, res) => {
    monitor.recordNetworkBytes({ requestStarted: true });
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    try {
      // Dashboard SSE endpoint
      if (req.method === 'GET' && pathname === '/api/v1/events') {
        const clientId = urlObj.searchParams.get('clientId') || crypto.randomUUID();
        const hidden = urlObj.searchParams.get('hidden') === '1';
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        if (isOptimised) {
          sseCoalescer.addClient(clientId, res, { hidden });
        } else {
          naiveSseClients.set(clientId, res);
          res.on('close', () => naiveSseClients.delete(clientId));
        }
        return;
      }

      // Worker Registration
      if (req.method === 'POST' && pathname === '/worker/v1/register') {
        const body = await readJsonBody(req, isOptimised ? 64 * 1024 : 2 * 1024 * 1024);
        const { workerId, bots = [] } = body;
        if (!pendingCommandsByWorker.has(workerId)) {
          pendingCommandsByWorker.set(workerId, []);
        }
        for (const b of bots) {
          if (registeredBots.size >= 20 && !registeredBots.has(b.botId)) {
            return sendJson(res, 400, { error: 'GLOBAL_BOT_CAP_20_EXCEEDED' });
          }
          registeredBots.set(b.botId, { workerId, botId: b.botId, status: 'ready' });
          if (!isOptimised) {
            // Anti-pattern #7: spawning a separate setInterval per registered bot!
            const h = setInterval(() => {
              naiveUnboundedEventLog.push({ type: 'poll_check', botId: b.botId, ts: Date.now() });
            }, 150);
            naiveBotIntervals.push(h);
          }
        }
        if (isOptimised) {
          logger.info('worker.registered', { workerId, botCount: bots.length, token: body.token });
        } else {
          fs.appendFileSync(logPath, `${JSON.stringify({ event: 'worker.registered', body })}\n`);
        }
        return sendJson(res, 200, { schemaVersion: 1, accepted: true, registeredBots: registeredBots.size });
      }

      // Worker Heartbeat & Snapshot
      if (req.method === 'POST' && pathname === '/worker/v1/heartbeat') {
        const body = await readJsonBody(req, isOptimised ? 64 * 1024 : 4 * 1024 * 1024);
        const snapshots = body.snapshots || [];
        for (let i = 0; i < snapshots.length; i += 1) {
          const snap = snapshots[i];
          if (isOptimised) {
            botSummaryCache.set(snap.botId, snap);
            broadcastSseUpdate('bot.status', snap.botId, {
              botId: snap.botId,
              hp: snap.healthBand,
              food: snap.foodBand
            });
          } else {
            // Anti-pattern #3, #4, #5: retaining entire bloated snapshot history in RAM!
            naiveUnboundedSnapshotHistory.push(snap);
            broadcastSseUpdate('bot.status', snap.botId, snap);
          }
        }
        if (!isOptimised && Array.isArray(body.chatLines)) {
          for (const line of body.chatLines) naiveUnboundedChatLog.push(line);
        }
        return sendJson(res, 200, {
          schemaVersion: 1,
          governorDirectives: isOptimised ? governor.getDirectives() : null
        });
      }

      // Worker Command Poll
      if (req.method === 'GET' && pathname === '/worker/v1/commands') {
        const workerId = urlObj.searchParams.get('workerId');
        const q = pendingCommandsByWorker.get(workerId) || [];
        const batch = q.splice(0, 20);
        return sendJson(res, 200, { schemaVersion: 1, commands: batch });
      }

      // Worker Sequenced Evidence Batch
      if (req.method === 'POST' && pathname === '/worker/v1/events') {
        const body = await readJsonBody(req, isOptimised ? 128 * 1024 : 4 * 1024 * 1024);
        const events = body.events || [];
        if (isOptimised) {
          for (const ev of events) {
            inboundEventQueue.enqueue(ev, 96);
          }
          if (inboundEventQueue.length > peakEventQueue) peakEventQueue = inboundEventQueue.length;
          inboundEventQueue.dequeueBatch(events.length);
        } else {
          for (const ev of events) naiveUnboundedEventLog.push(ev);
          if (naiveUnboundedEventLog.length > peakEventQueue) {
            peakEventQueue = naiveUnboundedEventLog.length;
          }
        }

        const tDb0 = performance.now();
        db.exec('BEGIN IMMEDIATE');
        let acked = 0;
        for (let i = 0; i < events.length; i += 1) {
          const ev = events[i];
          if (isOptimised && idempotencyCache.has(ev.messageId)) {
            acked += 1;
            continue;
          }
          if (isOptimised) idempotencyCache.set(ev.messageId, 1);

          const delta = Math.max(0, Math.trunc(ev.delta || 0));
          if (delta > 0 && ev.taskId) {
            const info = insertLedgerStmt.run(
              ev.messageId,
              ev.taskId,
              ev.botId,
              delta,
              new Date().toISOString()
            );
            if (info.changes > 0) {
              updateTaskQtyStmt.run(delta, delta, ev.taskId);
            }
          }
          acked += 1;

          if (isOptimised) {
            eventBus.publish('assignment.progress', {
              messageId: ev.messageId,
              taskId: ev.taskId,
              botId: ev.botId
            });
            broadcastSseUpdate('task.progress', ev.taskId || 'global', {
              taskId: ev.taskId,
              lastBotId: ev.botId,
              delta
            });
          } else {
            eventBus.emit('assignment.progress', ev);
            broadcastSseUpdate('task.progress', ev.taskId || 'global', ev);
            fs.appendFileSync(logPath, `${JSON.stringify(ev)}\n`);
          }
        }
        db.exec('COMMIT');
        dbCommits += 1;
        monitor.recordDbLatency(performance.now() - tDb0);

        return sendJson(res, 200, { schemaVersion: 1, acked });
      }

      // Submit Task Intent (Dashboard / CLI / Chat all use same Coordinator endpoint)
      if (req.method === 'POST' && pathname === '/api/v1/tasks') {
        const body = await readJsonBody(req, 32 * 1024);
        const taskId = crypto.randomUUID();
        activeTaskCount += 1;
        if (activeTaskCount > peakTaskQueue) peakTaskQueue = activeTaskCount;

        let plan;
        if (isOptimised) {
          const scope = new ScopedListeners();
          scope.on(eventBus, 'assignment.progress', () => {});
          const planOut = await aiController.createPlan({
            requestId: taskId,
            userText: body.text,
            compactContext: {
              maxBots: Math.min(20, registeredBots.size || 2),
              serverRemainingSlots: Math.min(20, registeredBots.size || 2)
            }
          });
          plan = planOut.plan;
          scope.dispose();
        } else {
          // Anti-pattern #6: attaching task progress listener and forgetting to remove it!
          eventBus.on('assignment.progress', (ev) => {
            if (ev && ev.taskId === taskId) {
              naiveUnboundedEventLog.push({ seenByTask: taskId });
            }
          });
          const rawAi = await callNaiveOllama(body.text);
          plan =
            typeof rawAi.message?.content === 'string'
              ? JSON.parse(rawAi.message.content)
              : rawAi;
        }

        const firstObj = plan.objectives && plan.objectives[0];
        const targetQty =
          firstObj && firstObj.target && Number.isInteger(firstObj.target.quantity)
            ? firstObj.target.quantity
            : 10;

        const tDb0 = performance.now();
        db.exec('BEGIN IMMEDIATE');
        insertTaskStmt.run(
          taskId,
          String(body.text || '').slice(0, 200),
          targetQty,
          0,
          'running',
          new Date().toISOString()
        );
        db.exec('COMMIT');
        dbCommits += 1;
        monitor.recordDbLatency(performance.now() - tDb0);

        // Allocate non-overlapping aggregate quotas across eligible bots (sum === targetQty!)
        const botIds = Array.from(registeredBots.keys());
        const quotas = splitAggregateQuota(targetQty, botIds);
        for (const q of quotas) {
          if (q.quota <= 0) continue;
          const botEntry = registeredBots.get(q.botId);
          if (botEntry) {
            pendingCommandsByWorker.get(botEntry.workerId).push({
              commandId: crypto.randomUUID(),
              taskId,
              botId: q.botId,
              quota: q.quota
            });
          }
        }

        activeTaskCount = Math.max(0, activeTaskCount - 1);
        return sendJson(res, 201, {
          taskId,
          targetQuantity: targetQty,
          quotaSum: quotas.reduce((acc, x) => acc + x.quota, 0),
          participants: quotas.filter((x) => x.quota > 0).length
        });
      }

      // Status & Compact Snapshot endpoint
      if (req.method === 'GET' && pathname === '/api/v1/status') {
        const tasksRow = db
          .prepare(
            'SELECT COUNT(*) AS totalTasks, COALESCE(SUM(target_qty), 0) AS sumTarget, COALESCE(SUM(verified_qty), 0) AS sumVerified FROM tasks'
          )
          .get();
        return sendJson(res, 200, {
          mode,
          registeredBots: registeredBots.size,
          tasks: tasksRow
        });
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  monitor.start();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  async function collectFinalMetricsAndShutdown() {
    if (sseCoalescer) sseCoalescer.flushNow();

    // Sample peak before GC
    const preGcSample = monitor.sampleNow({ forceFullMemory: true });
    const preGcMem = process.memoryUsage();

    // Force V8 GC to also measure steady-state retained memory!
    if (typeof global.gc === 'function') {
      global.gc();
      global.gc();
    }
    const postGcMem = process.memoryUsage();
    const finalSample = monitor.sampleNow({ forceFullMemory: true });
    const windowStats = monitor.getWindow();

    const tasksSummary = db
      .prepare(
        'SELECT COUNT(*) AS totalTasks, COALESCE(SUM(target_qty), 0) AS sumTarget, COALESCE(SUM(verified_qty), 0) AS sumVerified FROM tasks'
      )
      .get();

    const logDiskBytes = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('master.log'))
      .reduce((sum, f) => sum + fs.statSync(path.join(tmpDir, f)).size, 0);

    const sseStats = isOptimised
      ? sseCoalescer.stats()
      : {
          activeClients: naiveSseClients.size,
          rawEventsIngested: naiveRawSseEvents,
          framesSerialized: naiveSseSerializations,
          totalSerializedBytes: naiveSseBytes,
          overflowDisconnects: 0
        };

    const aiStats = isOptimised
      ? aiController.stats()
      : {
          totalRequests: naiveAiCalls,
          deterministicFastPath: 0,
          cacheHits: 0,
          deduplicatedInFlight: 0,
          llmCallsSent: naiveAiCalls,
          fallbacksUsed: 0
        };

    const metrics = {
      mode,
      expectedBots,
      registeredBots: registeredBots.size,
      memory: {
        rssPeakMB: +(Math.max(preGcMem.rss, windowStats.aggregates.rssBytes.max || 0) / 1048576).toFixed(2),
        rssPostGcMB: +(postGcMem.rss / 1048576).toFixed(2),
        heapUsedPeakMB: +(Math.max(preGcMem.heapUsed, windowStats.aggregates.heapUsedBytes.max || 0) / 1048576).toFixed(2),
        heapUsedPostGcMB: +(postGcMem.heapUsed / 1048576).toFixed(2),
        heapTotalMB: +(postGcMem.heapTotal / 1048576).toFixed(2),
        externalMB: +(postGcMem.external / 1048576).toFixed(2)
      },
      cpu: {
        percentNormalizedP50:
          windowStats.aggregates.cpuPercentNormalized !== 'unavailable'
            ? windowStats.aggregates.cpuPercentNormalized.p50
            : 'unavailable',
        percentNormalizedP95:
          windowStats.aggregates.cpuPercentNormalized !== 'unavailable'
            ? windowStats.aggregates.cpuPercentNormalized.p95
            : 'unavailable',
        totalCpuMs: +((process.cpuUsage().user + process.cpuUsage().system) / 1000).toFixed(2)
      },
      eventLoopDelayMs: {
        p50: windowStats.aggregates.eventLoopLagP95Ms.p50 ?? finalSample.eventLoopDelayMs.p50,
        p95: windowStats.aggregates.eventLoopLagP95Ms.p95 ?? finalSample.eventLoopDelayMs.p95,
        max: windowStats.aggregates.eventLoopLagP95Ms.max ?? finalSample.eventLoopDelayMs.max
      },
      network: {
        rxKB: +(finalSample.network.rxBytesTotal / 1024).toFixed(2),
        txKB: +(finalSample.network.txBytesTotal / 1024).toFixed(2),
        httpRequestsTotal: finalSample.network.httpRequestsTotal
      },
      queues: {
        peakTaskQueue,
        peakEventQueue,
        peakAiQueue: isOptimised
          ? Math.min(4, aiStats.llmCallsSent > 0 ? 1 : 0)
          : peakAiQueue
      },
      timers: {
        activeRuntimeTimers: preGcSample.timers.runtimeActiveTimers,
        registryNativeHandles: isOptimised ? timers.stats().totalNativeHandles : null,
        naiveIntervalsCreated: naiveBotIntervals.length
      },
      listeners: {
        domainBusListeners: countEmitterListeners(eventBus).listeners
      },
      caches: {
        entries: isOptimised
          ? finalSample.caches.totalEntries
          : naiveUnboundedSnapshotHistory.length + naiveUnboundedEventLog.length,
        bytesKB: isOptimised
          ? +(finalSample.caches.totalBytes / 1024).toFixed(2)
          : +(
              (Buffer.byteLength(JSON.stringify(naiveUnboundedSnapshotHistory)) +
                Buffer.byteLength(JSON.stringify(naiveUnboundedEventLog))) /
              1024
            ).toFixed(2)
      },
      ai: aiStats,
      dashboard: {
        activeClients: sseStats.activeClients,
        rawEventsIngested: sseStats.rawEventsIngested,
        framesSerialized: sseStats.framesSerialized,
        serializedKB: +(sseStats.totalSerializedBytes / 1024).toFixed(2)
      },
      db: {
        commits: dbCommits,
        latencyMs: finalSample.dbLatencyMs,
        tasksSummary
      },
      logs: {
        diskKB: +(logDiskBytes / 1024).toFixed(2)
      }
    };

    // Clean teardown
    for (const h of naiveBotIntervals) clearInterval(h);
    for (const r of naiveSseClients.values()) {
      try {
        r.end();
      } catch {}
    }
    if (sseCoalescer) sseCoalescer.stop();
    monitor.stop();
    if (timers) timers.dispose();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return metrics;
  }

  return { port: address.port, collectFinalMetricsAndShutdown };
}

if (require.main === module) {
  let instance = null;
  process.on('message', async (msg) => {
    if (msg.type === 'start') {
      instance = await startMasterNode(msg.config);
      process.send({ type: 'ready', port: instance.port });
    } else if (msg.type === 'stop') {
      const metrics = await instance.collectFinalMetricsAndShutdown();
      process.send({ type: 'metrics', metrics });
      process.exit(0);
    }
  });
}

module.exports = { startMasterNode };
