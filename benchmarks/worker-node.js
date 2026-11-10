'use strict';

/**
 * Isolated Distributed Worker Host Benchmark Process.
 * Hosts `botCount` independent simulated BotControllers communicating with the Master
 * Controller over real HTTP (`/worker/v1/*`).
 *
 * Separates Worker-side costs (voxel block search, A* pathfinding, bot listeners,
 * inventory snapshots, chat filtering, outbound queues) from Master Controller costs!
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const {
  BoundedByteQueue,
  TimerRegistry,
  ScopedListeners,
  countEmitterListeners,
  toCompactBotSnapshot,
  fingerprintSnapshot,
  PathfindingGuard,
  BlockSearchCache,
  ChatHistoryGuard,
  inspectRuntimeHandles
} = require('../src/performance');

function httpRequestJson(baseUrl, method, urlPath, bodyObj, agent) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        agent,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.byteLength
            }
          : {}
      },
      (res) => {
        const chunks = [];
        let rxBytes = 0;
        res.on('data', (c) => {
          rxBytes += c.byteLength;
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const parsed =
              rxBytes > 0 ? JSON.parse(Buffer.concat(chunks, rxBytes).toString('utf8')) : {};
            resolve({
              data: parsed,
              txBytes: payload ? payload.byteLength : 0,
              rxBytes
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Deterministic bounded A* / grid route finder for realistic CPU benchmarking.
 */
function runGridAStar(from, to) {
  const open = [{ x: from.x, y: from.y, z: from.z, g: 0, f: 0 }];
  const visited = new Set();
  const nodes = [];
  let steps = 0;
  while (open.length > 0 && steps < 450) {
    steps += 1;
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    const key = `${cur.x},${cur.y},${cur.z}`;
    if (visited.has(key)) continue;
    visited.add(key);
    nodes.push({ x: cur.x, y: cur.y, z: cur.z });
    if (cur.x === to.x && cur.z === to.z) {
      return { status: 'success', cost: cur.g, nodes };
    }
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (let i = 0; i < dirs.length; i += 1) {
      const nx = cur.x + dirs[i][0];
      const nz = cur.z + dirs[i][1];
      const nKey = `${nx},${cur.y},${nz}`;
      if (!visited.has(nKey)) {
        const g = cur.g + 1;
        const h = Math.abs(to.x - nx) + Math.abs(to.z - nz);
        open.push({ x: nx, y: cur.y, z: nz, g, f: g + h });
      }
    }
  }
  return { status: 'success', cost: steps, nodes };
}

async function runWorkerWorkload(config) {
  const { workerId, botIds, masterUrl, mode, ticks = 24 } = config;
  const isOptimised = mode === 'after';

  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();

  const timers = isOptimised ? new TimerRegistry() : null;
  const pathGuard = isOptimised ? new PathfindingGuard({ minReplanIntervalMs: 1000 }) : null;
  const blockCache = isOptimised ? new BlockSearchCache({ defaultMaxRadius: 32 }) : null;
  const chatGuard = isOptimised
    ? new ChatHistoryGuard({
        prefix: '!swarm',
        allowedPlayerUuids: ['admin-player-uuid'],
        botUuids: botIds,
        receiptRingCapacity: 50
      })
    : null;

  const outboundQueue = isOptimised
    ? new BoundedByteQueue({
        name: `worker-${workerId}-events`,
        maxItems: 200,
        maxBytes: 128 * 1024,
        overflowPolicy: 'pause_and_checkpoint'
      })
    : [];

  let txBytesTotal = 0;
  let rxBytesTotal = 0;
  let pathRequested = 0;
  let pathExecuted = 0;
  let voxelsVisitedTotal = 0;
  let blockQueriesTotal = 0;
  let peakRss = 0;
  let peakHeap = 0;

  // Simulated local bot state per botId (Worker owns rich world state; Master NEVER gets chunks!)
  const bots = botIds.map((botId, idx) => {
    const emitter = new EventEmitter();
    if (!isOptimised) emitter.setMaxListeners(0);
    // Simulate per-bot loaded chunk column buffer on WorkerHost (~512 KiB compact vs 2.5 MiB unpruned far viewDistance)
    const worldChunkBuffer = Buffer.alloc(isOptimised ? 512 * 1024 : 2560 * 1024, idx + 1);
    return {
      botId,
      emitter,
      worldChunkBuffer,
      position: { x: idx * 16, y: 64, z: 0 },
      health: 20,
      food: 19,
      cobbleCollected: 0,
      lastFingerprint: null,
      naiveChatHistory: [],
      naiveIntervals: [],
      assignmentQueue: []
    };
  });

  if (isOptimised) {
    timers.registerInterval('worker-bg-check', 250, () => {});
  } else {
    for (const bot of bots) {
      bot.naiveIntervals.push(setInterval(() => {}, 100));
      bot.naiveIntervals.push(setInterval(() => {}, 150));
    }
  }

  // Register worker + bots with Master
  const regRes = await httpRequestJson(
    masterUrl,
    'POST',
    '/worker/v1/register',
    {
      workerId,
      token: 'worker-secret-token-xyz',
      bots: bots.map((b) => ({ botId: b.botId }))
    },
    keepAliveAgent
  );
  txBytesTotal += regRes.txBytes;
  rxBytesTotal += regRes.rxBytes;

  let allTasksSubmitted = false;
  process.on('message', (m) => {
    if (m && m.type === 'all_tasks_submitted') {
      allTasksSubmitted = true;
    }
  });

  if (typeof process.send === 'function') {
    process.send({ type: 'registered', workerId, botCount: bots.length });
  }

  // Deterministic ore placement predicate: ore vein at dx=+5, dz=+4 from each bot's spawn
  const matchesOreForBot = (botOrigin) => (x, y, z) =>
    x === botOrigin.x + 5 && y === 64 && z === botOrigin.z + 4;

  for (let tick = 0; tick < ticks; tick += 1) {
    // 1. Poll Master for leased commands
    const cmdRes = await httpRequestJson(
      masterUrl,
      'GET',
      `/worker/v1/commands?workerId=${encodeURIComponent(workerId)}`,
      null,
      keepAliveAgent
    );
    txBytesTotal += cmdRes.txBytes;
    rxBytesTotal += cmdRes.rxBytes;

    const commands = cmdRes.data.commands || [];
    for (const cmd of commands) {
      const targetBot = bots.find((b) => b.botId === cmd.botId);
      if (targetBot) {
        targetBot.assignmentQueue.push({
          taskId: cmd.taskId,
          remainingQuota: cmd.quota
        });
      }
    }

    const snapshotsToSend = [];
    const naiveChatBatch = [];

    // 2. Execute per-bot deterministic simulation step
    for (let bIdx = 0; bIdx < bots.length; bIdx += 1) {
      const bot = bots[bIdx];
      const spawnOrigin = { x: bIdx * 16, y: 64, z: 0 };
      const oreTarget = { x: spawnOrigin.x + 5, y: 64, z: spawnOrigin.z + 4 };

      // Attach action listener (scoped & disposed in 'after'; leaked in 'before'!)
      const scope = isOptimised ? new ScopedListeners() : null;
      if (isOptimised) {
        scope.on(bot.emitter, 'physicTick', () => {});
      } else if (tick % 2 === 0) {
        bot.emitter.on('physicTick', () => bot.worldChunkBuffer[0]);
      }

      // A) Block search
      blockQueriesTotal += 1;
      if (isOptimised) {
        const searchOut = blockCache.findBlocks({
          origin: spawnOrigin,
          targetId: 'minecraft:cobblestone',
          count: 2,
          matchesAt: matchesOreForBot(spawnOrigin)
        });
        voxelsVisitedTotal += searchOut.voxelsVisited;
      } else {
        // Naive uncached r=28 scan allocating {x,y,z} objects per voxel!
        const pred = matchesOreForBot(spawnOrigin);
        let visited = 0;
        const found = [];
        for (let dx = -28; dx <= 28; dx += 1) {
          for (let dz = -28; dz <= 28; dz += 1) {
            for (let dy = -8; dy <= 8; dy += 1) {
              visited += 1;
              const vObj = { x: spawnOrigin.x + dx, y: 64 + dy, z: spawnOrigin.z + dz };
              if (pred(vObj.x, vObj.y, vObj.z)) found.push(vObj);
            }
          }
        }
        voxelsVisitedTotal += visited;
      }

      // B) Pathfinding to ore vein
      pathRequested += 1;
      if (isOptimised) {
        await pathGuard.computePath({
          botId: bot.botId,
          from: { x: spawnOrigin.x + (tick % 2) * 0.2, y: 64, z: spawnOrigin.z },
          to: { x: oreTarget.x + 0.1, y: 64, z: oreTarget.z },
          computeFn: async ({ from, to }) => {
            pathExecuted += 1;
            return runGridAStar(from, to);
          }
        });
      } else {
        pathExecuted += 1;
        runGridAStar(spawnOrigin, oreTarget);
      }

      // C) Chat ingress stream (3 public chatter lines per bot per tick)
      for (let c = 0; c < 3; c += 1) {
        const chatMsg = {
          senderUuid: 'random-public-player',
          text: `[PublicChat] Player_${c}: trading 64 dirt near spawn tick=${tick} bot=${bot.botId}`
        };
        if (isOptimised) {
          chatGuard.inspectChat(chatMsg);
        } else {
          bot.naiveChatHistory.push(chatMsg);
          naiveChatBatch.push(chatMsg);
        }
      }

      // D) Progress toward leased assignment quotas in FIFO order
      while (bot.assignmentQueue.length > 0 && bot.assignmentQueue[0].remainingQuota <= 0) {
        bot.assignmentQueue.shift();
      }
      if (bot.assignmentQueue.length > 0) {
        const current = bot.assignmentQueue[0];
        const minedNow = Math.min(80, current.remainingQuota);
        current.remainingQuota -= minedNow;
        if (current.remainingQuota <= 0) {
          bot.assignmentQueue.shift();
        }
        bot.cobbleCollected += minedNow;

        const ev = {
          messageId: crypto.randomUUID(),
          taskId: current.taskId,
          botId: bot.botId,
          delta: minedNow,
          seq: tick + 1
        };

        if (isOptimised) {
          outboundQueue.enqueue(ev, 96);
        } else {
          outboundQueue.push({
            ...ev,
            // Naive duplicate state in event payload
            fullInventoryDump: Array.from({ length: 36 }, (_, s) => ({
              slot: s,
              name: s === 0 ? 'minecraft:cobblestone' : 'minecraft:air',
              count: s === 0 ? bot.cobbleCollected : 0,
              nbt: { display: 'raw_slot_dump' }
            }))
          });
        }
      }

      // E) Snapshot preparation
      if (isOptimised) {
        const compact = toCompactBotSnapshot({
          botId: bot.botId,
          health: bot.health,
          food: bot.food,
          position: bot.position,
          heldItem: { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 10 },
          itemCounts: { cobblestone: bot.cobbleCollected }
        });
        const fp = fingerprintSnapshot(compact);
        if (fp !== bot.lastFingerprint || tick === 0) {
          bot.lastFingerprint = fp;
          snapshotsToSend.push(compact);
        }
        scope.dispose();
      } else {
        snapshotsToSend.push({
          botId: bot.botId,
          health: bot.health,
          food: bot.food,
          position: bot.position,
          slots: Array.from({ length: 45 }, (_, s) => ({
            slot: s,
            item: s === 0 ? 'minecraft:cobblestone' : null,
            count: s === 0 ? bot.cobbleCollected : 0,
            nbtBytes: '00'.repeat(48)
          })),
          nearbyEntities: Array.from({ length: 24 }, (_, e) => ({
            id: e,
            type: 'zombie',
            pos: { x: e, y: 64, z: e }
          }))
        });
      }
    }

    // 3. Flush outbound events in bounded batch (or every tick naively)
    const eventsBatch = isOptimised
      ? outboundQueue.dequeueBatch(100, 64 * 1024)
      : outboundQueue.splice(0, outboundQueue.length);

    if (eventsBatch.length > 0) {
      const evRes = await httpRequestJson(
        masterUrl,
        'POST',
        '/worker/v1/events',
        { workerId, events: eventsBatch },
        keepAliveAgent
      );
      txBytesTotal += evRes.txBytes;
      rxBytesTotal += evRes.rxBytes;
    }

    // 4. Send heartbeat / changed snapshots (every 4th tick in 'after' unless snapshot changed; every tick in 'before')
    if (!isOptimised || snapshotsToSend.length > 0 || tick % 4 === 0) {
      const hbRes = await httpRequestJson(
        masterUrl,
        'POST',
        '/worker/v1/heartbeat',
        {
          workerId,
          snapshots: snapshotsToSend,
          ...(isOptimised ? {} : { chatLines: naiveChatBatch })
        },
        keepAliveAgent
      );
      txBytesTotal += hbRes.txBytes;
      rxBytesTotal += hbRes.rxBytes;

      if (isOptimised && hbRes.data.governorDirectives) {
        blockCache.applyGovernorDirectives(hbRes.data.governorDirectives);
      }
    }

    const memNow = process.memoryUsage();
    if (memNow.rss > peakRss) peakRss = memNow.rss;
    if (memNow.heapUsed > peakHeap) peakHeap = memNow.heapUsed;

    await new Promise((r) => setTimeout(r, 8));
  }

  // Wait until test harness confirms all 20 task intents have been submitted before final drain
  while (!allTasksSubmitted) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Final drain so every task reaches 100% completion before teardown
  for (let drain = 0; drain < 4; drain += 1) {
    const cmdRes = await httpRequestJson(
      masterUrl,
      'GET',
      `/worker/v1/commands?workerId=${encodeURIComponent(workerId)}`,
      null,
      keepAliveAgent
    );
    const cmds = cmdRes.data.commands || [];
    const finishEvents = [];
    for (const cmd of cmds) {
      finishEvents.push({
        messageId: crypto.randomUUID(),
        taskId: cmd.taskId,
        botId: cmd.botId,
        delta: cmd.quota,
        seq: 999 + drain
      });
    }
    for (const bot of bots) {
      while (bot.assignmentQueue.length > 0) {
        const rem = bot.assignmentQueue.shift();
        if (rem.remainingQuota > 0) {
          finishEvents.push({
            messageId: crypto.randomUUID(),
            taskId: rem.taskId,
            botId: bot.botId,
            delta: rem.remainingQuota,
            seq: 1100 + drain
          });
        }
      }
    }
    if (finishEvents.length > 0) {
      const r = await httpRequestJson(
        masterUrl,
        'POST',
        '/worker/v1/events',
        { workerId, events: finishEvents },
        keepAliveAgent
      );
      txBytesTotal += r.txBytes;
      rxBytesTotal += r.rxBytes;
    }
  }

  const preGcHandles = inspectRuntimeHandles();
  const totalBotListeners = bots.reduce(
    (sum, b) => sum + countEmitterListeners(b.emitter).listeners,
    0
  );
  const retainedChatItems = isOptimised
    ? chatGuard.stats().retainedReceipts
    : bots.reduce((sum, b) => sum + b.naiveChatHistory.length, 0);

  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
  const postGc = process.memoryUsage();
  const cpu = process.cpuUsage();

  const metrics = {
    workerId,
    botCount: bots.length,
    rssPeakMB: +(Math.max(peakRss, postGc.rss) / 1048576).toFixed(2),
    rssPostGcMB: +(postGc.rss / 1048576).toFixed(2),
    heapPeakMB: +(Math.max(peakHeap, postGc.heapUsed) / 1048576).toFixed(2),
    heapPostGcMB: +(postGc.heapUsed / 1048576).toFixed(2),
    cpuTotalMs: +((cpu.user + cpu.system) / 1000).toFixed(2),
    eventLoopP95Ms: eld.count > 0 ? +(eld.percentile(95) / 1e6).toFixed(2) : 0,
    txKB: +(txBytesTotal / 1024).toFixed(2),
    rxKB: +(rxBytesTotal / 1024).toFixed(2),
    pathfinding: {
      requested: pathRequested,
      executed: pathExecuted,
      avoided: pathRequested - pathExecuted
    },
    blockSearch: {
      queries: blockQueriesTotal,
      voxelsVisited: voxelsVisitedTotal,
      avgVoxelsPerQuery: Math.round(voxelsVisitedTotal / Math.max(1, blockQueriesTotal))
    },
    chatRetainedItems: retainedChatItems,
    activeTimers: preGcHandles.activeTimers,
    botListeners: totalBotListeners
  };

  // Cleanup worker timers/sockets
  for (const bot of bots) {
    for (const h of bot.naiveIntervals) clearInterval(h);
    bot.emitter.removeAllListeners();
  }
  if (timers) timers.dispose();
  eld.disable();
  keepAliveAgent.destroy();

  return metrics;
}

if (require.main === module) {
  process.on('message', async (msg) => {
    if (msg.type === 'run') {
      const metrics = await runWorkerWorkload(msg.config);
      process.send({ type: 'done', metrics });
      process.exit(0);
    }
  });
}

module.exports = { runWorkerWorkload };
