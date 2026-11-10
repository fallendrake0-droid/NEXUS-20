'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createMaster, loadConfig } = require('../../index');

const ADMIN = { principalId: 'admin-1', actorType: 'human', role: 'admin', serverId: null };
const OPERATOR = { principalId: 'op-1', actorType: 'human', role: 'operator', serverId: null };
const VIEWER = { principalId: 'view-1', actorType: 'human', role: 'viewer', serverId: null };

function enrollReadyWorker(master, workerId, botIds) {
  const { bootstrapToken } = master.botRegistry.createBootstrapToken({ createdBy: ADMIN.principalId });
  const reg = master.botRegistry.register({
    bootstrapToken,
    workerInfo: {
      workerId,
      hostname: `${workerId}.lan`,
      maxBotSlots: botIds.length + 2,
      configuredBots: botIds.map((botId, idx) => ({
        botId,
        username: `Bot_${botId}`,
        serverId: 'srv-main',
        authMode: 'online_microsoft'
      }))
    }
  });
  const auth = master.botRegistry.verifyWorkerToken(workerId, reg.workerToken);
  master.botRegistry.heartbeat(workerId, {
    botSnapshots: botIds.map((botId, idx) => ({
      botId,
      status: 'ready',
      dimension: 'minecraft:overworld',
      position: { x: idx * 8, y: 64, z: 0 },
      health: 20,
      food: 20,
      inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
    }))
  });
  return { reg, auth };
}

test('G-01: Master runtime loads ZERO mineflayer, prismarine-world or minecraft-data modules', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:'
  });
  const master = createMaster(cfg);
  await master.start();
  try {
    const loadedPaths = Object.keys(require.cache);
    const forbidden = loadedPaths.filter((p) =>
      /node_modules[\\/](mineflayer|prismarine-world|mineflayer-pathfinder|minecraft-data)/.test(p)
    );
    assert.deepEqual(forbidden, []);
    const health = await master.health();
    assert.equal(health.status, 'ok');
  } finally {
    await master.stop();
  }
});

test('End-to-end Coordinator: 1-bot craft vs 2-bot shared 100-cobble quota, tool break reallocation, dedup & epoch fencing', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '2'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    const w1 = enrollReadyWorker(master, 'worker-1', ['bot-1', 'bot-2']);
    const w2 = enrollReadyWorker(master, 'worker-2', ['bot-3']);

    // RBAC: viewer cannot submit tasks
    await assert.rejects(
      () => master.coordinator.submitIntent({ actor: VIEWER, source: 'dashboard', text: 'Craft a wooden pickaxe.' }),
      (err) => err.code === 'FORBIDDEN'
    );

    // Scenario 1: "Craft a wooden pickaxe." -> selects ONLY 1 bot despite 3 ready bots!
    const craftTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      idempotencyKey: 'idem-craft-1',
      text: 'Craft a wooden pickaxe.'
    });
    assert.equal(craftTask.activeAssignments.length, 1);
    assert.equal(craftTask.activeAssignments[0].quotaQuantity, 1);

    // Idempotent replay returns exact same task without duplicate assignments
    const dupCraft = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      idempotencyKey: 'idem-craft-1',
      text: 'Craft a wooden pickaxe.'
    });
    assert.equal(dupCraft.taskId, craftTask.taskId);
    assert.equal(dupCraft.activeAssignments.length, 1);

    // Complete craft task with verified crafted_output delta
    const craftAsg = craftTask.activeAssignments[0];
    master.taskManager.acknowledgeAssignment({
      workerId: 'worker-1',
      assignmentId: craftAsg.assignmentId,
      leaseId: craftAsg.leaseId,
      allocationEpoch: 1,
      decision: 'accepted',
      baselineSnapshot: { botId: craftAsg.botId, capturedAt: new Date().toISOString(), itemCounts: { 'minecraft:oak_planks': 3, 'minecraft:stick': 2 } }
    });
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1,
        createdAt: new Date().toISOString(),
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: craftAsg.assignmentId,
          leaseId: craftAsg.leaseId,
          allocationEpoch: 1,
          taskId: craftTask.taskId,
          objectiveId: craftAsg.objectiveId,
          workerId: 'worker-1',
          botId: craftAsg.botId,
          outcome: 'completed',
          durationMs: 2500,
          beforeSnapshot: { botId: craftAsg.botId, capturedAt: new Date().toISOString(), itemCounts: { 'minecraft:oak_planks': 3, 'minecraft:stick': 2 } },
          afterSnapshot: { botId: craftAsg.botId, capturedAt: new Date().toISOString(), itemCounts: { 'minecraft:wooden_pickaxe': 1 } },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'craft_delta',
              itemKey: 'minecraft:wooden_pickaxe',
              claimedDelta: 1,
              details: { consumedInputs: { 'minecraft:oak_planks': 3, 'minecraft:stick': 2 } }
            }
          ],
          reportedAt: new Date().toISOString()
        }
      }
    ]);
    assert.equal((await master.coordinator.getTask({ actor: VIEWER, taskId: craftTask.taskId })).state, 'completed');

    // Scenario 2 + Scenario 4: "Mine 100 cobblestone." shared across 2 bots (50 + 50 = 100 aggregate!)
    const mineTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 100 cobblestone.'
    });
    assert.equal(mineTask.objectives[0].targetQuantity, 100);
    assert.equal(mineTask.objectives[0].reservedQuantity, 100);
    assert.equal(mineTask.activeAssignments.length, 2);
    const sumQuotas = mineTask.activeAssignments.reduce((s, a) => s + a.quotaQuantity, 0);
    assert.equal(sumQuotas, 100);

    const [asgA, asgB] = mineTask.activeAssignments;
    const nowIso = new Date().toISOString();

    // Bot A breaks pickaxe at 18/50 -> submits FailureReportV1 with partialReport (+18); Bot 3 automatically picks up remaining 32!
    const failMsgId = crypto.randomUUID();
    const partialEvId = crypto.randomUUID();
    const batch1 = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: failMsgId,
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: nowIso,
        eventType: 'assignment_failed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgA.assignmentId,
          leaseId: asgA.leaseId,
          allocationEpoch: 1,
          taskId: mineTask.taskId,
          objectiveId: asgA.objectiveId,
          workerId: 'worker-1',
          botId: asgA.botId,
          failureCode: 'TOOL_BROKEN_OR_MISSING',
          retryable: true,
          safeState: 'idle_safe',
          summary: 'Pickaxe broke at 18 cobblestone',
          partialReport: {
            schemaVersion: 1,
            reportId: crypto.randomUUID(),
            assignmentId: asgA.assignmentId,
            leaseId: asgA.leaseId,
            allocationEpoch: 1,
            taskId: mineTask.taskId,
            objectiveId: asgA.objectiveId,
            workerId: 'worker-1',
            botId: asgA.botId,
            outcome: 'partial',
            durationMs: 12000,
            beforeSnapshot: { botId: asgA.botId, capturedAt: nowIso, itemCounts: {} },
            afterSnapshot: { botId: asgA.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 18 } },
            evidence: [
              {
                evidenceId: partialEvId,
                kind: 'inventory_delta',
                itemKey: 'minecraft:cobblestone',
                claimedDelta: 18,
                details: {}
              }
            ],
            reportedAt: nowIso
          },
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(batch1[0].creditedDelta, 18);

    // Replaying identical messageId produces duplicate ack with ZERO extra credit (G-08)
    const replayAck = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: failMsgId,
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: nowIso,
        eventType: 'assignment_failed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgA.assignmentId,
          leaseId: asgA.leaseId,
          allocationEpoch: 1,
          taskId: mineTask.taskId,
          objectiveId: asgA.objectiveId,
          workerId: 'worker-1',
          botId: asgA.botId,
          failureCode: 'TOOL_BROKEN_OR_MISSING',
          retryable: true,
          safeState: 'idle_safe',
          summary: 'dup',
          partialReport: null,
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(replayAck[0].status, 'duplicate');

    const midDetail = await master.coordinator.getTask({ actor: VIEWER, taskId: mineTask.taskId });
    assert.equal(midDetail.objectives[0].verifiedQuantity, 18);
    assert.equal(midDetail.objectives[0].reservedQuantity, 82); // 50 (Bot B) + 32 (reallocated to Bot 3)!

    const asgC = midDetail.activeAssignments.find((a) => a.botId === 'bot-3' && a.state === 'offered');
    assert.ok(asgC);
    assert.equal(asgC.quotaQuantity, 32);

    // Complete Bot B (+50) and Bot 3 (+32) -> exact 18 + 50 + 32 = 100!
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 3,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgB.assignmentId,
          leaseId: asgB.leaseId,
          allocationEpoch: 1,
          taskId: mineTask.taskId,
          objectiveId: asgB.objectiveId,
          workerId: 'worker-1',
          botId: asgB.botId,
          outcome: 'completed',
          durationMs: 20000,
          beforeSnapshot: { botId: asgB.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asgB.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 50 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 50, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);

    await master.coordinator.handleWorkerEventBatch(w2.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-2',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgC.assignmentId,
          leaseId: asgC.leaseId,
          allocationEpoch: 1,
          taskId: mineTask.taskId,
          objectiveId: asgC.objectiveId,
          workerId: 'worker-2',
          botId: asgC.botId,
          outcome: 'completed',
          durationMs: 15000,
          beforeSnapshot: { botId: 'bot-3', capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: 'bot-3', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 32 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 32, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);

    const doneMine = await master.coordinator.getTask({ actor: VIEWER, taskId: mineTask.taskId });
    assert.equal(doneMine.state, 'completed');
    assert.equal(doneMine.objectives[0].verifiedQuantity, 100);
    assert.equal(doneMine.objectives[0].reservedQuantity, 0);

    // Scenario 3 / HIGH-03c: Concurrent `start_with` DAG ("Build a shelter while one bot guards.")
    const buildGuard = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Build a shelter while one bot guards.'
    });
    assert.equal(buildGuard.objectives.length, 2);
    // Both build and guard are assigned concurrently to 2 distinct bots!
    assert.equal(buildGuard.activeAssignments.length, 2);
    assert.notEqual(buildGuard.activeAssignments[0].botId, buildGuard.activeAssignments[1].botId);

    const buildAsg = buildGuard.activeAssignments.find((a) => a.actionType === 'build');
    const buildWorkerAuth = buildAsg.workerId === 'worker-1' ? w1.auth : w2.auth;
    const nextSeq = buildAsg.workerId === 'worker-1' ? 4 : 2;

    await master.coordinator.handleWorkerEventBatch(buildWorkerAuth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: buildAsg.workerId,
        workerSequence: nextSeq,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: buildAsg.assignmentId,
          leaseId: buildAsg.leaseId,
          allocationEpoch: 1,
          taskId: buildGuard.taskId,
          objectiveId: buildAsg.objectiveId,
          workerId: buildAsg.workerId,
          botId: buildAsg.botId,
          outcome: 'completed',
          durationMs: 18000,
          beforeSnapshot: { botId: buildAsg.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: buildAsg.botId, capturedAt: nowIso, itemCounts: {} },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'block_state', itemKey: null, claimedDelta: 24, details: { verifiedBlocks: 24 } }],
          reportedAt: nowIso
        }
      }
    ]);

    const finishedBG = await master.coordinator.getTask({ actor: VIEWER, taskId: buildGuard.taskId });
    assert.equal(finishedBG.state, 'completed'); // Guard start_with companion auto-completed with build!
  } finally {
    await master.stop();
  }
});

test('Scenario 5 & 9: Crash recovery preserves SQLite governor-deferred tasks (CRIT-03), fences expired leases & CLI flags pass', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-crash-'));
  const dbPath = path.join(tmpDir, 'crash.db');

  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: dbPath,
    SWARM_HEARTBEAT_INTERVAL_MS: '1000',
    SWARM_LEASE_DURATION_MS: '3000'
  });

  // 1. Start Master #1, trigger constrained governor via V8 heapRatio (CRIT-02), submit low-priority task + active task
  const master1 = createMaster(cfg);
  await master1.start();

  const w1 = enrollReadyWorker(master1, 'worker-1', ['bot-1']);
  const runningTask = await master1.coordinator.submitIntent({
    actor: OPERATOR,
    source: 'cli',
    text: 'Mine 40 cobblestone.'
  });
  const lease1 = runningTask.activeAssignments[0];

  // Trigger constrained state via heapRatio >= 0.70 (CRIT-02 fix)
  master1.governor.evaluate({
    memory: {
      rssBytes: 90 * 1024 * 1024,
      heapUsedBytes: 190 * 1024 * 1024,
      v8HeapLimitBytes: 256 * 1024 * 1024,
      systemMemorySource: '/proc/meminfo',
      systemAvailableBytes: 900 * 1024 * 1024
    },
    cpu: { percentNormalized: 20 },
    eventLoopDelayMs: { p95: 5 },
    queues: { tasks: 1 }
  });
  assert.equal(master1.governor.state, 'constrained');

  const deferredTask = await master1.coordinator.submitIntent({
    actor: OPERATOR,
    source: 'cli',
    priority: 'low',
    text: 'Explore the area.'
  });
  assert.equal(deferredTask.state, 'paused');
  assert.equal(deferredTask.pauseReason, 'WORKLOAD_GOVERNOR');

  // Stop Master #1 abruptly (simulating restart while lease1 expires)
  await master1.stop();

  // 2. Start Master #2 on the same SQLite DB after lease1 expiry window
  const futureNowIso = new Date(Date.now() + 10_000).toISOString();
  const master2 = createMaster(cfg);
  await master2.start();
  try {
    const recReport = await master2.coordinator.recover(futureNowIso);
    assert.equal(recReport.rehydratedGovernorPausedCount, 1);
    assert.equal(master2.governor.pausedTaskCount, 1); // Deferred task survived restart!
    assert.equal(recReport.fencedExpiredLeases, 1);

    // Worker-1 reconnects and submits stale epoch=1 report -> rejected with STALE_ALLOCATION_EPOCH!
    const recon = master2.taskManager.reconcileWorker('worker-1', {
      activeLeases: [{ assignmentId: lease1.assignmentId, leaseId: lease1.leaseId, allocationEpoch: 1 }]
    });
    assert.equal(recon.reconcileActions[0].directive, 'stop_and_fence');
    assert.equal(recon.reconcileActions[0].currentAllocationEpoch, 2);

    const w1Auth = { workerId: 'worker-1', allowedBotIds: ['bot-1'] };
    const staleAck = await master2.coordinator.handleWorkerEventBatch(w1Auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1,
        createdAt: new Date().toISOString(),
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: lease1.assignmentId,
          leaseId: lease1.leaseId,
          allocationEpoch: 1, // Stale!
          taskId: runningTask.taskId,
          objectiveId: lease1.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'completed',
          durationMs: 5000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: new Date().toISOString(), itemCounts: {} },
          afterSnapshot: { botId: 'bot-1', capturedAt: new Date().toISOString(), itemCounts: { 'minecraft:cobblestone': 40 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 40, details: {} }],
          reportedAt: new Date().toISOString()
        }
      }
    ]);
    assert.equal(staleAck[0].status, 'rejected');
    assert.equal(staleAck[0].rejectionCode, 'STALE_ALLOCATION_EPOCH');
    assert.equal(staleAck[0].creditedDelta, 0);

    // Emergency safeStopBot works cleanly
    const stopRes = await master2.coordinator.safeStopBot({ actor: OPERATOR, botId: 'bot-1' });
    assert.equal(stopRes.status, 'enqueued');
  } finally {
    await master2.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Verify root index.js CLI --check-config & --health flags execute cleanly
  const cfgOut = execFileSync(process.execPath, ['index.js', '--check-config'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_DB_PATH: ':memory:' },
    encoding: 'utf8'
  });
  assert.equal(JSON.parse(cfgOut).valid, true);

  const healthOut = execFileSync(process.execPath, ['index.js', '--health'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_DB_PATH: ':memory:' },
    encoding: 'utf8'
  });
  assert.equal(JSON.parse(healthOut).status, 'ok');
});
