'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  RingBuffer,
  BoundedCache,
  BoundedByteQueue,
  TimerRegistry,
  ScopedListeners,
  countEmitterListeners,
  toCompactBotSnapshot,
  fingerprintSnapshot,
  SseCoalescer,
  BoundedLogger,
  PathfindingGuard,
  BlockSearchCache,
  ChatHistoryGuard,
  EventBus
} = require('../../src/performance');

test('RingBuffer maintains O(1) FIFO order and overwrites oldest item at capacity', () => {
  const rb = new RingBuffer(3);
  assert.equal(rb.size, 0);
  rb.push('a');
  rb.push('b');
  rb.push('c');
  assert.deepEqual(rb.toArray(), ['a', 'b', 'c']);
  const res = rb.push('d');
  assert.equal(res.overwritten, true);
  assert.equal(rb.size, 3);
  assert.deepEqual(rb.toArray(), ['b', 'c', 'd']);
  assert.deepEqual(rb.toArray(2), ['c', 'd']);
  assert.equal(rb.latest(), 'd');
  assert.equal(rb.shift(), 'b');
  assert.deepEqual(rb.toArray(), ['c', 'd']);
  rb.clear();
  assert.equal(rb.size, 0);
  assert.equal(rb.latest(), undefined);
});

test('BoundedCache enforces maxEntries, maxBytes, TTL and shrinkToFraction', () => {
  let clock = 1000;
  const cache = new BoundedCache({
    name: 'unit',
    maxEntries: 3,
    maxBytes: 512,
    defaultTtlMs: 500,
    now: () => clock
  });

  assert.equal(cache.set('k1', { n: 1 }), true);
  assert.equal(cache.set('k2', { n: 2 }), true);
  assert.equal(cache.set('k3', { n: 3 }), true);
  // Touch k1 so k2 becomes least-recently-used
  assert.deepEqual(cache.get('k1'), { n: 1 });
  assert.equal(cache.set('k4', { n: 4 }), true);
  assert.equal(cache.get('k2'), undefined); // Evicted by LRU
  assert.deepEqual(cache.get('k1'), { n: 1 });

  // Oversize entry rejected cleanly without corrupting cache
  assert.equal(cache.set('huge', 'x'.repeat(1024)), false);
  assert.equal(cache.stats().rejectedOversize, 1);

  // TTL expiry
  clock += 600;
  assert.equal(cache.get('k1'), undefined);
  assert.ok(cache.stats().expiredEvictions >= 1);

  // Shrink under pressure
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.shrinkToFraction(0.34);
  assert.ok(cache.size <= 1);
});

test('BoundedByteQueue enforces item & byte limits and invokes overflow policy without silent drops', () => {
  const overflows = [];
  const q = new BoundedByteQueue({
    name: 'worker-events',
    maxItems: 3,
    maxBytes: 256,
    overflowPolicy: 'pause_and_checkpoint',
    onOverflow: (ctx) => overflows.push(ctx)
  });

  assert.equal(q.enqueue({ seq: 1 }, 80).ok, true);
  assert.equal(q.enqueue({ seq: 2 }, 80).ok, true);
  assert.equal(q.enqueue({ seq: 3 }, 80).ok, true);

  // 4th item hits maxItems
  const over1 = q.enqueue({ seq: 4 }, 20);
  assert.equal(over1.ok, false);
  assert.equal(over1.reason, 'MAX_ITEMS_REACHED');
  assert.equal(over1.policy, 'pause_and_checkpoint');
  assert.equal(overflows.length, 1);

  const batch = q.dequeueBatch(2, 160);
  assert.equal(batch.length, 2);
  assert.equal(q.length, 1);

  // Byte cap breach
  const over2 = q.enqueue({ seq: 5 }, 200);
  assert.equal(over2.ok, false);
  assert.equal(over2.reason, 'MAX_BYTES_REACHED');
});

test('TimerRegistry consolidates multiple logical intervals onto one native timer per bucket', async () => {
  const reg = new TimerRegistry();
  let ticksA = 0;
  let ticksB = 0;

  const stopA = reg.registerInterval('bot-1-check', 40, () => {
    ticksA += 1;
  });
  reg.registerInterval('bot-2-check', 40, () => {
    ticksB += 1;
  });

  // Two logical periodic tasks share ONE native interval handle!
  assert.equal(reg.stats().logicalPeriodicTasks, 2);
  assert.equal(reg.stats().nativeIntervalHandles, 1);

  await new Promise((r) => setTimeout(r, 110));
  assert.ok(ticksA >= 1);
  assert.ok(ticksB >= 1);

  stopA();
  assert.equal(reg.stats().logicalPeriodicTasks, 1);
  assert.equal(reg.stats().nativeIntervalHandles, 1);

  reg.dispose();
  assert.equal(reg.stats().totalNativeHandles, 0);
});

test('ScopedListeners enforces per-event caps, isolates callback errors and cleans up completely', () => {
  const emitter = new EventEmitter();
  const caught = [];
  const scope = new ScopedListeners({
    maxListenersPerEvent: 2,
    onError: (err, ev) => caught.push({ msg: err.message, ev })
  });

  scope.on(emitter, 'move', () => {
    throw new Error('boom');
  });
  scope.on(emitter, 'move', () => {});

  assert.throws(
    () => scope.on(emitter, 'move', () => {}),
    (err) => err.code === 'LISTENER_CAP_EXCEEDED'
  );

  // Emitting does not crash caller despite throwing listener
  emitter.emit('move');
  assert.equal(caught.length, 1);
  assert.equal(countEmitterListeners(emitter).listeners, 2);

  scope.dispose();
  assert.equal(countEmitterListeners(emitter).listeners, 0);
  assert.equal(scope.activeCount, 0);
});

test('CompactSnapshotCodec detaches heavy world references and aggregates canonical inventory counts', () => {
  const giantChunkBuffer = Buffer.alloc(65536, 7);
  const rawBot = {
    botId: 'bot-01',
    health: 18.44,
    food: 9.0,
    entity: { position: { x: 102.7, y: 64.01, z: -44.9 }, giantChunkBuffer },
    game: { dimension: 'minecraft:overworld' },
    heldItem: { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 50 },
    inventory: {
      items: () => [
        { name: 'cobblestone', count: 64, nbt: { big: giantChunkBuffer } },
        { name: 'cobblestone', count: 36, nbt: { big: giantChunkBuffer } },
        { name: 'minecraft:coal', count: 12 }
      ]
    },
    world: { chunks: giantChunkBuffer }
  };

  const snap1 = toCompactBotSnapshot(rawBot);
  assert.equal(snap1.itemCounts['minecraft:cobblestone'], 100);
  assert.equal(snap1.itemCounts['minecraft:coal'], 12);
  assert.deepEqual(snap1.position, { x: 103, y: 64, z: -45 });
  assert.equal(snap1.healthBand, 'normal');
  assert.equal(snap1.foodBand, 'low');
  assert.equal(snap1.activeTool.durabilityBand, 'normal');
  assert.equal('world' in snap1, false);

  const snap2 = toCompactBotSnapshot(rawBot);
  assert.equal(fingerprintSnapshot(snap1), fingerprintSnapshot(snap2));
});

test('SseCoalescer coalesces bursts, serializes once for N clients and disconnects overflowed slow clients', () => {
  const coalescer = new SseCoalescer({
    flushIntervalMs: 1000,
    maxClients: 3,
    maxClientQueueEvents: 2,
    maxClientQueueBytes: 4096
  });

  const makeMockRes = (backpressure = false) => {
    const emitter = new EventEmitter();
    const written = [];
    emitter.writableEnded = false;
    emitter.write = (buf) => {
      written.push(buf);
      return !backpressure;
    };
    emitter.end = () => {
      emitter.writableEnded = true;
    };
    emitter.written = written;
    return emitter;
  };

  // Publishing with 0 clients does zero serialization
  coalescer.publish('bot.status', 'bot-1', { hp: 20 });
  assert.equal(coalescer.stats().framesSerialized, 0);

  const c1 = makeMockRes(false);
  const c2 = makeMockRes(false);
  const slow = makeMockRes(true); // Always returns false -> queues frames
  coalescer.addClient('c1', c1);
  coalescer.addClient('c2', c2);
  coalescer.addClient('slow', slow);

  // 50 rapid updates to the same bot coalesce into 1 entry and 1 shared Buffer!
  for (let i = 1; i <= 50; i += 1) {
    coalescer.publish('bot.status', 'bot-1', { step: i });
  }
  const f1 = coalescer.flushNow();
  assert.equal(f1.flushedEvents, 1);
  assert.equal(coalescer.stats().framesSerialized, 1);
  // Exact same Buffer instance written to c1, c2 and slow!
  assert.equal(c1.written[0], c2.written[0]);

  // Push slow client past queue cap (maxClientQueueEvents = 2)
  coalescer.publish('bot.status', 'bot-1', { step: 51 });
  coalescer.flushNow();
  coalescer.publish('bot.status', 'bot-1', { step: 52 });
  coalescer.flushNow();
  coalescer.publish('bot.status', 'bot-1', { step: 53 });
  coalescer.flushNow();

  assert.equal(slow.writableEnded, true);
  assert.equal(coalescer.stats().overflowDisconnects, 1);
  assert.equal(coalescer.clientCount, 2);

  coalescer.stop();
});

test('BoundedLogger redacts secrets, rate-limits duplicate errors and rotates bounded log files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-log-'));
  const logFile = path.join(tmpDir, 'master.log');
  try {
    let now = 10_000;
    const logger = new BoundedLogger({
      level: 'info',
      ringCapacity: 20,
      filePath: logFile,
      maxFileBytes: 600,
      maxFiles: 3,
      rateLimitWindowMs: 5000,
      maxRepeatsPerWindow: 2,
      now: () => now
    });

    // Debug skipped at info level
    assert.equal(logger.debug('dbg.skip', { x: 1 }), false);

    // Secret redaction
    logger.info('worker.registered', {
      workerId: 'w1',
      workerToken: 'super-secret-token-12345',
      authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload'
    });
    const line = logger.recentLines(1)[0];
    assert.equal(line.includes('super-secret-token-12345'), false);
    assert.equal(line.includes('secretpayload'), false);
    assert.equal(line.includes('[REDACTED]'), true);

    // Error storm rate limit
    for (let i = 0; i < 10; i += 1) {
      logger.error('socket.timeout', { attempt: i });
    }
    assert.equal(logger.stats().suppressedTotal, 8);

    // Trigger file rotations while capping total files <= maxFiles
    for (let i = 0; i < 20; i += 1) {
      logger.info(`task.step.${i}`, { summary: 'bounded log rotation check payload' });
    }
    const files = fs.readdirSync(tmpDir);
    assert.ok(files.length <= 3, `Expected <= 3 rotated files, found ${files.length}`);
    assert.ok(logger.stats().rotations >= 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PathfindingGuard deduplicates concurrent calls, caches routes, invalidates on blockUpdate and times out', async () => {
  let clock = 5000;
  const guard = new PathfindingGuard({
    minReplanIntervalMs: 1000,
    cacheTtlMs: 10_000,
    maxComputeMs: 60,
    now: () => clock
  });

  let computeCount = 0;
  const computeFn = async ({ from, to }) => {
    computeCount += 1;
    await new Promise((r) => setTimeout(r, 15));
    return {
      status: 'success',
      cost: 10,
      nodes: [from, { x: 5, y: 64, z: 5 }, to]
    };
  };

  // Two concurrent calls with sub-block jitter share ONE computation
  const [p1, p2] = await Promise.all([
    guard.computePath({
      botId: 'b1',
      from: { x: 0.2, y: 64, z: 0.1 },
      to: { x: 10.8, y: 64, z: 10.4 },
      computeFn
    }),
    guard.computePath({
      botId: 'b1',
      from: { x: 0.9, y: 64, z: 0.4 },
      to: { x: 10.1, y: 64, z: 10.9 },
      computeFn
    })
  ]);
  assert.equal(computeCount, 1);
  assert.equal(p1.status, 'success');
  assert.equal(p2.status, 'success');

  // Repeat call hits route cache (0 new computations)
  const p3 = await guard.computePath({
    botId: 'b1',
    from: { x: 0.4, y: 64, z: 0.2 },
    to: { x: 10.5, y: 64, z: 10.2 },
    computeFn
  });
  assert.equal(p3.fromCache, true);
  assert.equal(computeCount, 1);

  // Block update along corridor invalidates cached route
  const removed = guard.onBlockUpdate('minecraft:overworld', { x: 5, y: 64, z: 5 });
  assert.equal(removed, 1);

  // Timeout check
  const slowOut = await guard.computePath({
    botId: 'b2',
    from: { x: 100, y: 64, z: 100 },
    to: { x: 200, y: 64, z: 200 },
    computeFn: () => new Promise((r) => setTimeout(r, 200))
  });
  assert.equal(slowOut.failureCode, 'PATH_TIMEOUT');
});

test('BlockSearchCache scans progressively, caches sectors, invalidates on blockUpdate and respects governor', () => {
  const oreSet = new Set(['4,64,3', '5,64,3']);
  const cache = new BlockSearchCache({ defaultMaxRadius: 32, verticalHalfSpan: 8 });

  const r1 = cache.findBlocks({
    origin: { x: 0, y: 64, z: 0 },
    targetId: 'minecraft:coal_ore',
    count: 2,
    matchesAt: (x, y, z) => oreSet.has(`${x},${y},${z}`)
  });
  assert.equal(r1.positions.length, 2);
  assert.equal(r1.fromCache, false);
  // Progressive shell stopped inside r=8 (<= 17^3 = 4,913 voxels, NOT 65^2*17 = 71,825!)
  assert.ok(r1.voxelsVisited <= 4913);

  // Second query hits cache and checks only the 2 cached coordinates!
  const r2 = cache.findBlocks({
    origin: { x: 2, y: 64, z: 2 },
    targetId: 'minecraft:coal_ore',
    count: 2,
    matchesAt: (x, y, z) => oreSet.has(`${x},${y},${z}`)
  });
  assert.equal(r2.fromCache, true);
  assert.equal(r2.voxelsVisited, 2);

  // Governor critical disables nonessential scanning while preserving survival scans
  cache.applyGovernorDirectives({ maxBlockSearchRadius: 8, allowNonEssentialScanning: false });
  const throttled = cache.findBlocks({
    origin: { x: 50, y: 64, z: 50 },
    targetId: 'minecraft:diamond_ore',
    matchesAt: () => false
  });
  assert.equal(throttled.throttled, true);
  assert.equal(throttled.voxelsVisited, 0);

  const survival = cache.findBlocks({
    origin: { x: 0, y: 64, z: 0 },
    targetId: 'minecraft:coal_ore',
    essentialSurvival: true,
    matchesAt: (x, y, z) => oreSet.has(`${x},${y},${z}`)
  });
  assert.equal(survival.throttled, false);
  assert.ok(survival.positions.length > 0);
});

test('ChatHistoryGuard drops unprefixed/unauthorized/bot messages at ingress and rate-limits commands', () => {
  let now = 1000;
  const guard = new ChatHistoryGuard({
    prefix: '!swarm',
    allowedPlayerUuids: ['uuid-admin-1'],
    botUuids: ['uuid-bot-1'],
    maxCommandsPerWindow: 2,
    rateLimitWindowMs: 10_000,
    receiptRingCapacity: 5,
    now: () => now
  });

  assert.equal(
    guard.inspectChat({ senderUuid: 'uuid-random', text: 'hello everyone' }).reason,
    'NOT_PREFIXED'
  );
  assert.equal(
    guard.inspectChat({ senderUuid: 'uuid-bot-1', text: '!swarm status' }).reason,
    'BOT_ORIGINATED'
  );
  assert.equal(
    guard.inspectChat({ senderUuid: 'uuid-hacker', text: '!swarm status' }).reason,
    'UNAUTHORIZED_PLAYER'
  );

  const ok1 = guard.inspectChat({
    senderUuid: 'uuid-admin-1',
    text: '!swarm task mine 100 cobblestone'
  });
  assert.equal(ok1.accepted, true);
  assert.equal(ok1.intent.verb, 'task');
  assert.equal(ok1.intent.argumentText, 'mine 100 cobblestone');

  assert.equal(
    guard.inspectChat({ senderUuid: 'uuid-admin-1', text: '!swarm status' }).accepted,
    true
  );
  assert.equal(
    guard.inspectChat({ senderUuid: 'uuid-admin-1', text: '!swarm status' }).reason,
    'RATE_LIMITED'
  );
});

test('EventBus bounds recent events and isolates subscriber errors', () => {
  const errs = [];
  const bus = new EventBus({
    recentEventLimit: 4,
    onSubscriberError: (e) => errs.push(e)
  });

  bus.on('task.updated', () => {
    throw new Error('subscriber failure');
  });

  let delivered = 0;
  bus.on('task.updated', () => {
    delivered += 1;
  });

  for (let i = 0; i < 10; i += 1) {
    bus.publish('task.updated', { messageId: `m-${i}`, taskId: 't1' });
  }

  assert.equal(delivered, 10);
  assert.equal(errs.length, 10);
  assert.equal(bus.recentEvents().length, 4);
});
