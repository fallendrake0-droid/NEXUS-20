'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  RingBuffer,
  BoundedCache,
  BoundedByteQueue,
  TimerRegistry,
  ScopedListeners,
  countEmitterListeners,
  toCompactBotSnapshot,
  SseCoalescer,
  BoundedLogger,
  PathfindingGuard,
  BlockSearchCache,
  ChatHistoryGuard,
  AiEfficiencyController,
  ResourceMonitor,
  WorkloadGovernor,
  EventBus
} = require('../../src/performance');

function forceGcAndMeasureHeap() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
  return process.memoryUsage().heapUsed;
}

test('Memory Leak Test 1: 2,000 bot snapshot + listener scope cycles retain zero world buffers or listeners', () => {
  const longLivedBotEmitter = new EventEmitter();
  const snapshotCache = new BoundedCache({
    name: 'bot-summaries',
    maxEntries: 20,
    maxBytes: 64 * 1024
  });

  // Warmup
  for (let i = 0; i < 50; i += 1) {
    const scope = new ScopedListeners();
    scope.on(longLivedBotEmitter, 'physicTick', () => {});
    scope.dispose();
  }

  const baselineHeap = forceGcAndMeasureHeap();

  for (let i = 0; i < 2000; i += 1) {
    const transientWorldChunk = Buffer.allocUnsafe(128 * 1024); // 128 KiB x 2000 = 250 MiB total transient data!
    const rawBot = {
      botId: `bot-${i % 20}`,
      health: 20,
      food: 18,
      entity: { position: { x: i, y: 64, z: -i }, chunkRef: transientWorldChunk },
      inventoryItems: [
        { name: 'cobblestone', count: (i % 64) + 1, rawNbt: transientWorldChunk },
        { name: 'coal', count: 10, rawNbt: transientWorldChunk }
      ],
      world: transientWorldChunk
    };

    const scope = new ScopedListeners();
    scope.on(longLivedBotEmitter, 'spawn', () => rawBot.health);
    scope.on(longLivedBotEmitter, 'health', () => rawBot.food);
    scope.on(longLivedBotEmitter, 'blockUpdate', () => {});

    const compact = toCompactBotSnapshot(rawBot);
    snapshotCache.set(compact.botId, compact);

    scope.dispose();
  }

  const finalHeap = forceGcAndMeasureHeap();
  const heapDeltaMB = (finalHeap - baselineHeap) / (1024 * 1024);

  assert.equal(countEmitterListeners(longLivedBotEmitter).listeners, 0);
  assert.ok(snapshotCache.size <= 20);
  assert.ok(
    heapDeltaMB < 4.0,
    `Expected post-GC heap growth < 4.0 MiB after 250 MiB transient world churn, got ${heapDeltaMB.toFixed(2)} MiB`
  );
});

test('Memory Leak Test 2: SSE client connect/overflow/disconnect churn + 20,000 events retain zero client buffers', () => {
  const coalescer = new SseCoalescer({
    flushIntervalMs: 1000,
    maxClients: 8,
    maxClientQueueEvents: 10,
    maxClientQueueBytes: 16 * 1024
  });

  const baselineHeap = forceGcAndMeasureHeap();

  for (let cycle = 0; cycle < 300; cycle += 1) {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.write = () => cycle % 3 !== 0; // Every 3rd client simulates slow socket backpressure
    res.end = () => {
      res.writableEnded = true;
    };

    coalescer.addClient(`client-${cycle % 6}`, res);
    for (let e = 0; e < 70; e += 1) {
      coalescer.publish('bot.status', `bot-${e % 20}`, {
        botId: `bot-${e % 20}`,
        verified: e,
        bigTransient: undefined
      });
    }
    coalescer.flushNow();
  }

  coalescer.stop();
  const finalHeap = forceGcAndMeasureHeap();
  const heapDeltaMB = (finalHeap - baselineHeap) / (1024 * 1024);

  assert.equal(coalescer.clientCount, 0);
  assert.equal(coalescer.stats().queuedBytesTotal, 0);
  assert.ok(
    heapDeltaMB < 4.0,
    `Expected post-GC SSE churn heap growth < 4.0 MiB, got ${heapDeltaMB.toFixed(2)} MiB`
  );
});

test('Memory Leak Test 3: TimerRegistry + AiEfficiencyController + Soak rings flatten out with zero timer leaks', async () => {
  const timers = new TimerRegistry();
  const monitor = new ResourceMonitor({ timerRegistry: timers, sampleIntervalMs: 1000, windowSize: 60 });
  const governor = new WorkloadGovernor({ globalBotCap: 20, initialBotCap: 10 });
  const bus = new EventBus({ recentEventLimit: 1000 });
  const logger = new BoundedLogger({ level: 'info', ringCapacity: 200 });
  const chatGuard = new ChatHistoryGuard({
    allowedPlayerUuids: ['admin-uuid'],
    receiptRingCapacity: 50
  });
  const pathGuard = new PathfindingGuard({ maxCacheEntries: 128 });
  const blockCache = new BlockSearchCache({ maxCacheEntries: 256 });
  const outboundQueue = new BoundedByteQueue({
    name: 'outbound',
    maxItems: 100,
    maxBytes: 64 * 1024
  });

  const ai = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.12:11434',
    cacheMaxEntries: 64,
    governor,
    monitor,
    transportOverride: async ({ body }) => {
      const dto = JSON.parse(body.messages[1].content);
      return {
        schemaVersion: 1,
        requestId: dto.requestId,
        intentSummary: dto.userObjective.slice(0, 80),
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'obj_1',
            kind: 'mine',
            target: {
              resourceId: 'minecraft:cobblestone',
              quantity: 32,
              regionLabel: null,
              description: 'mine cobble'
            },
            dependencies: [],
            parallelism: 'partitionable',
            workerCountHint: 1,
            constraints: {
              maxRisk: 'low',
              avoidHazards: [],
              allowExistingStock: false,
              maxTravelBlocks: 128
            },
            verification: 'newly_collected'
          }
        ],
        riskLevel: 'low',
        notes: []
      };
    }
  });

  monitor.start();

  // Warmup phase (fill bounded caches & rings to steady-state capacity)
  for (let i = 0; i < 200; i += 1) {
    await ai.createPlan({ userText: `Complex warmup expedition variant ${i}` });
    bus.publish('assignment.progress', { messageId: `w-${i}`, botId: `b-${i % 20}` });
  }

  const postWarmupHeap = forceGcAndMeasureHeap();
  const checkpoints = [postWarmupHeap];

  // 4 soak epochs x 2,500 operations = 10,000 mixed swarm operations
  for (let epoch = 0; epoch < 4; epoch += 1) {
    for (let step = 0; step < 2500; step += 1) {
      const id = epoch * 2500 + step;
      bus.publish('assignment.progress', { messageId: `m-${id}`, botId: `b-${id % 20}` });
      logger.info('assignment.step', { id, token: 'secret-redact-me' });
      chatGuard.inspectChat({ senderUuid: 'public-chatter', text: `random chat line ${id} `.repeat(4) });
      outboundQueue.enqueue({ seq: id, delta: 1 }, 64);
      if (outboundQueue.length >= 50) {
        outboundQueue.dequeueBatch(50);
      }

      if (step % 25 === 0) {
        await ai.createPlan({ userText: `Complex soak expedition variant ${id % 300}` });
        await pathGuard.computePath({
          botId: `b-${id % 20}`,
          from: { x: id % 40, y: 64, z: 0 },
          to: { x: (id % 40) + 12, y: 64, z: 12 },
          computeFn: async ({ from, to }) => ({ status: 'success', cost: 12, nodes: [from, to] })
        });
        blockCache.findBlocks({
          origin: { x: (id % 16) * 16, y: 64, z: 0 },
          targetId: 'minecraft:stone',
          count: 1,
          matchesAt: () => true
        });
      }
    }
    monitor.sampleNow({ forceFullMemory: true });
    checkpoints.push(forceGcAndMeasureHeap());
  }

  monitor.stop();
  timers.dispose();

  // Verify zero leaked native timers or in-flight AI promises
  assert.equal(timers.stats().totalNativeHandles, 0);
  assert.equal(ai.stats().activeCount, 0);
  assert.equal(ai.stats().inFlightDedupKeys, 0);
  assert.ok(ai.cache.size <= 64);
  assert.equal(bus.recentEvents(2000).length, 1000);

  // Heap growth from post-warmup steady state to after 10,000 soak operations must stay flat
  const soakGrowthMB = (checkpoints[checkpoints.length - 1] - postWarmupHeap) / (1024 * 1024);
  assert.ok(
    soakGrowthMB < 5.0,
    `Expected steady-state soak heap growth < 5.0 MiB across 10,000 ops, got ${soakGrowthMB.toFixed(2)} MiB`
  );
});
