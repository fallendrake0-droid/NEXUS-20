'use strict';

/**
 * Full Multi-Process Before-vs-After Benchmark Runner
 *
 * Executes isolated OS Master Controller + Distributed Worker Host processes across:
 *   - 0 bots (Master Controller idle baseline)
 *   - 1 bot  (1 worker host)
 *   - 2 bots (1 worker host — initial deployment target)
 *   - 5 bots (2 worker hosts: 3 + 2)
 *   - 10 bots (2 worker hosts: 5 + 5)
 *   - 20 distributed bots (4 worker hosts: 5 + 5 + 5 + 5 — global architectural max)
 * Plus an empirical Adaptive WorkloadGovernor pressure & recovery benchmark.
 *
 * Saves complete raw before/after measurements to `benchmarks/results/latest-benchmark.json`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const {
  WorkloadGovernor,
  BlockSearchCache,
  SseCoalescer,
  AiEfficiencyController,
  buildDeterministicPlan
} = require('../src/performance');

function startMockRemoteOllama() {
  let active = 0;
  let peakConcurrent = 0;
  let totalCalls = 0;
  let rxBytes = 0;
  let txBytes = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => {
      rxBytes += c.byteLength;
      chunks.push(c);
    });
    req.on('end', async () => {
      totalCalls += 1;
      active += 1;
      if (active > peakConcurrent) peakConcurrent = active;

      // Simulate realistic remote LAN Ollama structured inference latency (~25ms scaled)
      await new Promise((r) => setTimeout(r, 25));

      let reqId = crypto.randomUUID();
      let rawUserText = '';
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const userStr = parsed.messages && parsed.messages[1] ? parsed.messages[1].content : '{}';
        const inner = JSON.parse(userStr);
        if (inner.requestId) reqId = inner.requestId;
        rawUserText = inner.userObjective || inner.userText || '';
      } catch {
        // Fallback random UUID
      }

      // Return identical objective semantics for identical prompts so before/after execute 100% equivalent work
      const matchedDet = buildDeterministicPlan(reqId, rawUserText);
      const plan = matchedDet.matched
        ? matchedDet.plan
        : {
            schemaVersion: 1,
            requestId: reqId,
            intentSummary: 'Remote Ollama strategic objective plan',
            clarificationRequired: false,
            clarificationQuestion: null,
            objectives: [
              {
                localId: 'obj_remote_1',
                kind: 'mine',
                target: {
                  resourceId: 'minecraft:cobblestone',
                  quantity: 100,
                  regionLabel: 'sector_alpha',
                  description: 'Aggregate shared cobblestone target 100'
                },
                dependencies: [],
                parallelism: 'partitionable',
                workerCountHint: 2,
                constraints: {
                  maxRisk: 'low',
                  avoidHazards: ['lava'],
                  allowExistingStock: false,
                  maxTravelBlocks: 256
                },
                verification: 'newly_collected'
              }
            ],
            riskLevel: 'low',
            notes: ['mock_remote_ollama']
          };

      const body = Buffer.from(
        JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(plan) } }),
        'utf8'
      );
      txBytes += body.byteLength;
      active -= 1;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength
      });
      res.end(body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        resetCounters() {
          active = 0;
          peakConcurrent = 0;
          totalCalls = 0;
          rxBytes = 0;
          txBytes = 0;
        },
        stats() {
          return {
            totalCalls,
            peakConcurrent,
            rxKB: +(rxBytes / 1024).toFixed(2),
            txKB: +(txBytes / 1024).toFixed(2)
          };
        },
        close() {
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

function connectSseClient(masterUrl, clientId, hidden = false) {
  return new Promise((resolve, reject) => {
    let bytesReceived = 0;
    let chunksReceived = 0;
    const req = http.get(
      `${masterUrl}/api/v1/events?clientId=${encodeURIComponent(clientId)}&hidden=${hidden ? '1' : '0'}`,
      (res) => {
        res.on('data', (chunk) => {
          bytesReceived += chunk.byteLength;
          chunksReceived += 1;
        });
        resolve({
          stats: () => ({ bytesReceived, chunksReceived }),
          close: () => {
            req.destroy();
          }
        });
      }
    );
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

function postJson(baseUrl, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': buf.byteLength
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function runSingleScenario({ label, totalBots, workerTopology, mode, ollama }) {
  ollama.resetCounters();
  const tStart = performance.now();

  const execArgv =
    mode === 'after'
      ? ['--expose-gc', '--max-old-space-size=256']
      : ['--expose-gc'];

  // 1. Spawn isolated Master Controller OS process
  const masterProc = fork(path.join(__dirname, 'master-node.js'), [], {
    execArgv,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });

  const masterPort = await new Promise((resolve, reject) => {
    masterProc.once('message', (msg) => {
      if (msg.type === 'ready') resolve(msg.port);
    });
    masterProc.once('error', reject);
    masterProc.send({
      type: 'start',
      config: { mode, expectedBots: totalBots, ollamaUrl: ollama.url }
    });
  });

  const masterUrl = `http://127.0.0.1:${masterPort}`;

  // 2. Connect 3 live SSE Dashboard streams (2 foreground + 1 backgrounded tab)
  const sseClients = await Promise.all([
    connectSseClient(masterUrl, 'operator-main', false),
    connectSseClient(masterUrl, 'operator-tablet', false),
    connectSseClient(masterUrl, 'operator-bg-tab', true)
  ]);

  let workerMetricsList = [];
  let submittedTasks = [];

  if (totalBots > 0) {
    // 3. Spawn distributed Worker Host child processes
    let botIndex = 1;
    const workerProcs = workerTopology.map((botsOnHost, hostIdx) => {
      const botIds = Array.from({ length: botsOnHost }, () => {
        const id = `bot-${String(botIndex).padStart(2, '0')}`;
        botIndex += 1;
        return id;
      });
      const proc = fork(path.join(__dirname, 'worker-node.js'), [], {
        execArgv: ['--expose-gc'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      let resolveRegistered;
      const registeredPromise = new Promise((r) => {
        resolveRegistered = r;
      });
      const donePromise = new Promise((resolve, reject) => {
        proc.on('message', (msg) => {
          if (msg.type === 'registered') resolveRegistered();
          if (msg.type === 'done') resolve(msg.metrics);
        });
        proc.once('error', reject);
      });
      proc.send({
        type: 'run',
        config: {
          workerId: `worker-host-${hostIdx + 1}`,
          botIds,
          masterUrl,
          mode,
          ticks: 24
        }
      });
      return { proc, registeredPromise, donePromise };
    });

    // Deterministically wait for every distributed worker host to complete registration
    await Promise.all(workerProcs.map((w) => w.registeredPromise));

    // 4. Submit identical mix of 20 intents (12 canonical deterministic + 4 concurrent duplicate complex + 4 cached complex)
    const canonicalIntents = [
      'Mine 100 cobblestone.',
      'Collect 100 cobblestone and 40 coal.',
      'Craft a wooden pickaxe.',
      'Explore the area.',
      'Build a shelter while one bot guards.',
      'Mine 100 cobblestone.',
      'Collect 60 oak_log and 20 coal.',
      'Craft 4 torch.',
      'Mine 100 cobblestone.',
      'Explore north_ridge.',
      'Craft a stone_pickaxe.',
      'Mine 100 cobblestone.'
    ];

    for (const text of canonicalIntents) {
      submittedTasks.push(await postJson(masterUrl, '/api/v1/tasks', { text }));
    }

    // Concurrent burst of 4 identical complex planning intents (tests deduplication!)
    const complexIntent =
      'Plan a multi-stage deep cave expedition if underground ravines near sector alpha are safe';
    const burstResults = await Promise.all(
      Array.from({ length: 4 }, () => postJson(masterUrl, '/api/v1/tasks', { text: complexIntent }))
    );
    submittedTasks.push(...burstResults);

    // 4 subsequent identical complex intents (tests bounded plan cache!)
    for (let i = 0; i < 4; i += 1) {
      submittedTasks.push(await postJson(masterUrl, '/api/v1/tasks', { text: complexIntent }));
    }

    for (const w of workerProcs) {
      w.proc.send({ type: 'all_tasks_submitted' });
    }

    workerMetricsList = await Promise.all(workerProcs.map((w) => w.donePromise));
  } else {
    // Idle 0-bot baseline window
    await new Promise((r) => setTimeout(r, 250));
  }

  // Close SSE clients & collect Master Controller final metrics
  const sseClientRxBytes = sseClients.reduce((sum, c) => sum + c.stats().bytesReceived, 0);
  for (const c of sseClients) c.close();

  const masterMetrics = await new Promise((resolve, reject) => {
    masterProc.once('message', (msg) => {
      if (msg.type === 'metrics') resolve(msg.metrics);
    });
    masterProc.once('error', reject);
    masterProc.send({ type: 'stop' });
  });

  const durationMs = +(performance.now() - tStart).toFixed(1);

  // Aggregate Worker Host costs separately from Master Controller!
  const workerSummary =
    workerMetricsList.length === 0
      ? null
      : {
          workerProcessCount: workerMetricsList.length,
          totalBotsHosted: workerMetricsList.reduce((s, w) => s + w.botCount, 0),
          sumWorkerRssPeakMB: +workerMetricsList
            .reduce((s, w) => s + w.rssPeakMB, 0)
            .toFixed(2),
          avgPerWorkerRssPeakMB: +(
            workerMetricsList.reduce((s, w) => s + w.rssPeakMB, 0) / workerMetricsList.length
          ).toFixed(2),
          sumWorkerHeapPostGcMB: +workerMetricsList
            .reduce((s, w) => s + w.heapPostGcMB, 0)
            .toFixed(2),
          sumWorkerCpuMs: +workerMetricsList
            .reduce((s, w) => s + w.cpuTotalMs, 0)
            .toFixed(2),
          maxWorkerEventLoopP95Ms: Math.max(...workerMetricsList.map((w) => w.eventLoopP95Ms)),
          sumWorkerTxKB: +workerMetricsList.reduce((s, w) => s + w.txKB, 0).toFixed(2),
          pathfindingRequested: workerMetricsList.reduce((s, w) => s + w.pathfinding.requested, 0),
          pathfindingExecuted: workerMetricsList.reduce((s, w) => s + w.pathfinding.executed, 0),
          voxelsVisitedTotal: workerMetricsList.reduce((s, w) => s + w.blockSearch.voxelsVisited, 0),
          chatRetainedItemsTotal: workerMetricsList.reduce((s, w) => s + w.chatRetainedItems, 0),
          totalBotListeners: workerMetricsList.reduce((s, w) => s + w.botListeners, 0),
          perHost: workerMetricsList
        };

  // Verify aggregate quota invariant across all tasks (quotaSum === targetQuantity)
  const quotaInvariantPassed = submittedTasks.every(
    (t) => t.quotaSum === t.targetQuantity
  );

  return {
    label,
    mode,
    totalBots,
    workerTopology,
    durationMs,
    quotaInvariantPassed,
    sseClientRxKB: +(sseClientRxBytes / 1024).toFixed(2),
    ollamaRemoteServer: ollama.stats(),
    masterController: masterMetrics,
    distributedWorkers: workerSummary
  };
}

/**
 * Empirical benchmark of Adaptive WorkloadGovernor under Normal -> Constrained -> Critical -> Recovery.
 */
async function runAdaptiveGovernorBenchmark() {
  let fakeClock = 100_000;
  const gov = new WorkloadGovernor({
    globalBotCap: 20,
    initialBotCap: 10,
    recoveryCooldownMs: 10_000,
    thresholds: {
      constrainedRssBytes: 220 * 1024 * 1024,
      criticalRssBytes: 300 * 1024 * 1024,
      recoverFromCriticalRssBytes: 255 * 1024 * 1024,
      recoverFromConstrainedRssBytes: 190 * 1024 * 1024
    },
    now: () => fakeClock
  });

  const blockCache = new BlockSearchCache({ defaultMaxRadius: 32 });
  const sse = new SseCoalescer({ flushIntervalMs: 1000, maxClients: 12 });
  const ai = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.12:11434',
    governor: gov,
    transportOverride: async ({ body }) => {
      const dto = JSON.parse(body.messages[1].content);
      return {
        schemaVersion: 1,
        requestId: dto.requestId,
        intentSummary: 'Normal-state remote plan',
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'obj_1',
            kind: 'explore',
            target: {
              resourceId: null,
              quantity: null,
              regionLabel: 'ridge',
              description: 'Explore ridge'
            },
            dependencies: [],
            parallelism: 'spatial',
            workerCountHint: 2,
            constraints: {
              maxRisk: 'low',
              avoidHazards: [],
              allowExistingStock: false,
              maxTravelBlocks: 256
            },
            verification: 'region_visited'
          }
        ],
        riskLevel: 'low',
        notes: []
      };
    }
  });

  const phases = [];
  let survivalTasksSubmitted = 0;
  let survivalTasksExecutedImmediately = 0;
  let optionalTasksSubmitted = 0;
  let optionalTasksPaused = 0;

  const recordPhase = async (phaseName, sample) => {
    gov.evaluate(sample);
    const directives = gov.getDirectives({
      serverAvailableSlots: 20,
      workerAvailableSlots: 20,
      capabilityEligibleBots: 10
    });
    blockCache.applyGovernorDirectives(directives);
    sse.applyGovernorPolicy({
      flushIntervalMs: directives.dashboardFlushIntervalMs,
      maxClients: directives.maxSseClients
    });

    // Submit 5 survival/safety operations + 5 optional low-priority tasks in each phase
    for (let i = 0; i < 5; i += 1) {
      survivalTasksSubmitted += 1;
      const surv = gov.classifyWork({
        taskId: `${phaseName}-surv-${i}`,
        priority: i % 2 === 0 ? 'survival' : 'safety'
      });
      if (surv.decision === 'execute_now') survivalTasksExecutedImmediately += 1;

      optionalTasksSubmitted += 1;
      const opt = gov.classifyWork({
        taskId: `${phaseName}-opt-${i}`,
        priority: 'low',
        payload: { intent: 'Explore optional sector' }
      });
      if (opt.decision === 'paused_and_queued') optionalTasksPaused += 1;
    }

    const aiPlan = await ai.createPlan({
      userText: `Ambiguous strategic objective under pressure ${phaseName}`
    });

    phases.push({
      phaseName,
      state: gov.state,
      effectiveBotConcurrency: directives.effectiveBotConcurrency,
      dashboardFlushIntervalMs: directives.dashboardFlushIntervalMs,
      maxSseClients: directives.maxSseClients,
      maxBlockSearchRadius: directives.maxBlockSearchRadius,
      allowNonEssentialScanning: directives.allowNonEssentialScanning,
      aiSource: aiPlan.source,
      pausedQueueDepth: gov.pausedTaskCount
    });
  };

  // Phase 1: Normal
  await recordPhase('1_normal', {
    memory: { rssBytes: 95 * 1024 * 1024 },
    cpu: { percentNormalized: 18 },
    eventLoopDelayMs: { p95: 4 },
    queues: { tasks: 2 }
  });

  // Phase 2: Constrained
  fakeClock += 5000;
  await recordPhase('2_constrained', {
    memory: { rssBytes: 245 * 1024 * 1024 },
    cpu: { percentNormalized: 78 },
    eventLoopDelayMs: { p95: 72 },
    queues: { tasks: 12 }
  });

  // Phase 3: Critical
  fakeClock += 5000;
  await recordPhase('3_critical', {
    memory: { rssBytes: 318 * 1024 * 1024 },
    cpu: { percentNormalized: 94 },
    eventLoopDelayMs: { p95: 195 },
    queues: { tasks: 30 }
  });

  // Phase 4: Cooldown recovery critical -> constrained -> normal
  const healthySample = {
    memory: { rssBytes: 98 * 1024 * 1024 },
    cpu: { percentNormalized: 14 },
    eventLoopDelayMs: { p95: 3 },
    queues: { tasks: 1 }
  };
  fakeClock += 1000;
  gov.evaluate(healthySample);
  fakeClock += 11_000;
  gov.evaluate(healthySample); // -> constrained
  fakeClock += 1000;
  gov.evaluate(healthySample);
  fakeClock += 11_000;
  await recordPhase('4_recovered_normal', healthySample); // -> normal

  const resumed = gov.drainResumableTasks(100);
  sse.stop();

  return {
    phases,
    invariants: {
      survivalTasksSubmitted,
      survivalTasksExecutedImmediately,
      optionalTasksSubmitted,
      optionalTasksPausedDuringPressure: optionalTasksPaused,
      optionalTasksResumedAfterRecovery: resumed.length,
      tasksSilentlyDiscarded: optionalTasksPaused - resumed.length
    },
    sampleReductionReports: gov.getReductionReports(6)
  };
}

async function main() {
  const ollama = await startMockRemoteOllama();

  try {
    const scaleMatrix = [
      { label: '0_bots_master_idle', totalBots: 0, workerTopology: [] },
      { label: '1_bot', totalBots: 1, workerTopology: [1] },
      { label: '2_bots', totalBots: 2, workerTopology: [2] },
      { label: '5_bots', totalBots: 5, workerTopology: [3, 2] },
      { label: '10_bots', totalBots: 10, workerTopology: [5, 5] },
      { label: '20_bots_distributed', totalBots: 20, workerTopology: [5, 5, 5, 5] }
    ];

    const comparisons = [];

    for (const stage of scaleMatrix) {
      const before = await runSingleScenario({ ...stage, mode: 'before', ollama });
      const after = await runSingleScenario({ ...stage, mode: 'after', ollama });
      comparisons.push({
        stage: stage.label,
        totalBots: stage.totalBots,
        workerTopology: stage.workerTopology,
        before,
        after
      });
    }

    const governorBenchmark = await runAdaptiveGovernorBenchmark();

    const output = {
      generatedAt: new Date().toISOString(),
      environment: {
        note: 'Measured in Linux CI/sandbox VM; physical Samsung Galaxy A06 Termux Node 24.17.0 validation required to close U-03/U-12.',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: (os.cpus()[0] && os.cpus()[0].model) || 'unknown',
        cpuCores:
          typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : os.cpus().length,
        totalSystemRamMB: +(os.totalmem() / 1048576).toFixed(1)
      },
      scaleComparisons: comparisons,
      adaptiveGovernorBenchmark: governorBenchmark
    };

    const outDir = path.join(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'latest-benchmark.json');
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

    // Print concise human-readable summary table
    console.log('\n=== MINEFLAYER AI SWARM — MULTI-PROCESS BEFORE vs AFTER BENCHMARK SUMMARY ===');
    console.log(
      `Environment: Node ${output.environment.nodeVersion} | ${output.environment.platform}/${output.environment.arch} | ${output.environment.cpuCores} cores | ${output.environment.totalSystemRamMB} MiB RAM\n`
    );
    for (const row of comparisons) {
      const mb = row.before.masterController;
      const ma = row.after.masterController;
      const wb = row.before.distributedWorkers;
      const wa = row.after.distributedWorkers;

      console.log(
        `[${row.stage}] (Bots=${row.totalBots}, Workers=${row.workerTopology.length})`
      );
      console.log(
        `  MASTER RSS Peak:     ${mb.memory.rssPeakMB} MiB -> ${ma.memory.rssPeakMB} MiB  | Post-GC Heap: ${mb.memory.heapUsedPostGcMB} MiB -> ${ma.memory.heapUsedPostGcMB} MiB`
      );
      console.log(
        `  MASTER CPU / Lag:    ${mb.cpu.totalCpuMs} ms -> ${ma.cpu.totalCpuMs} ms | Loop p95: ${mb.eventLoopDelayMs.p95} ms -> ${ma.eventLoopDelayMs.p95} ms`
      );
      console.log(
        `  MASTER Network:      RX ${mb.network.rxKB} KB -> ${ma.network.rxKB} KB | TX ${mb.network.txKB} KB -> ${ma.network.txKB} KB`
      );
      console.log(
        `  MASTER Timers/Listn: Timers ${mb.timers.activeRuntimeTimers} -> ${ma.timers.activeRuntimeTimers} | Listeners ${mb.listeners.domainBusListeners} -> ${ma.listeners.domainBusListeners}`
      );
      console.log(
        `  MASTER Cache/Retain: ${mb.caches.entries} items (${mb.caches.bytesKB} KB) -> ${ma.caches.entries} items (${ma.caches.bytesKB} KB)`
      );
      console.log(
        `  MASTER AI Calls:     ${row.before.ollamaRemoteServer.totalCalls} remote calls (peak conc ${row.before.ollamaRemoteServer.peakConcurrent}) -> ${row.after.ollamaRemoteServer.totalCalls} remote calls (peak conc ${row.after.ollamaRemoteServer.peakConcurrent})`
      );
      console.log(
        `  MASTER SSE Overhead: ${mb.dashboard.framesSerialized} serializations (${mb.dashboard.serializedKB} KB) -> ${ma.dashboard.framesSerialized} serializations (${ma.dashboard.serializedKB} KB)`
      );
      if (wb && wa) {
        console.log(
          `  WORKERS Separate:    Sum RSS ${wb.sumWorkerRssPeakMB} MiB -> ${wa.sumWorkerRssPeakMB} MiB | CPU ${wb.sumWorkerCpuMs} ms -> ${wa.sumWorkerCpuMs} ms`
        );
        console.log(
          `  WORKERS Path/Blocks: Paths executed ${wb.pathfindingExecuted}/${wb.pathfindingRequested} -> ${wa.pathfindingExecuted}/${wa.pathfindingRequested} | Voxels ${wb.voxelsVisitedTotal} -> ${wa.voxelsVisitedTotal}`
        );
        console.log(
          `  WORKERS Chat/Listen: Retained chat ${wb.chatRetainedItemsTotal} -> ${wa.chatRetainedItemsTotal} | Bot listeners ${wb.totalBotListeners} -> ${wa.totalBotListeners}`
        );
      }
      console.log('');
    }

    console.log(
      'Adaptive WorkloadGovernor Invariants:',
      JSON.stringify(governorBenchmark.invariants)
    );
    console.log(`Saved full benchmark dataset to: ${outPath}`);
  } finally {
    await ollama.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
