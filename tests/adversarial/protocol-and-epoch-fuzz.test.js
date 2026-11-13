'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createMaster, loadConfig } = require('../../index');

const ADMIN = { principalId: 'admin-1', actorType: 'human', role: 'admin', serverId: null };
const OPERATOR = { principalId: 'op-1', actorType: 'human', role: 'operator', serverId: null };
const VIEWER = { principalId: 'view-1', actorType: 'human', role: 'viewer', serverId: null };

function setupWorker(master, workerId, bots) {
  const { bootstrapToken } = master.botRegistry.createBootstrapToken({ createdBy: ADMIN.principalId });
  const reg = master.botRegistry.register({
    bootstrapToken,
    workerInfo: {
      workerId,
      hostname: `${workerId}.local`,
      maxBotSlots: Math.min(20, Math.max(4, bots.length)),
      configuredBots: bots.map((b) => ({
        botId: b.botId,
        username: `Name_${b.botId}`,
        serverId: 'srv-1',
        authMode: 'online_microsoft'
      }))
    }
  });
  const auth = master.botRegistry.verifyWorkerToken(workerId, reg.workerToken);
  master.botRegistry.heartbeat(workerId, {
    botSnapshots: bots.map((b, i) => ({
      botId: b.botId,
      status: b.status || 'ready',
      dimension: 'minecraft:overworld',
      position: b.position || { x: i * 6, y: 64, z: 0 },
      health: b.health ?? 20,
      food: b.food ?? 20,
      inventoryItems:
        b.inventoryItems ?? [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
    }))
  });
  return { reg, auth };
}

test('ADV-01: Master restart mid-task recovers partial verified progress, fences expired lease, and completes exact remaining target', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-master-restart-'));
  const dbPath = path.join(tmpDir, 'restart.db');

  let clock = Date.parse('2026-11-10T15:00:00.000Z');
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: dbPath,
    SWARM_HEARTBEAT_INTERVAL_MS: '1000',
    SWARM_LEASE_DURATION_MS: '4000',
    SWARM_ENABLED_BOTS: '2'
  });

  // Master #1 starts and credits +35/100 cobblestone before abrupt restart
  const master1 = createMaster(cfg);
  master1.botRegistry._now = () => clock;
  master1.taskManager._now = () => clock;
  await master1.start();

  const w1 = setupWorker(master1, 'worker-1', [{ botId: 'bot-1' }]);
  const task = await master1.coordinator.submitIntent({
    actor: OPERATOR,
    source: 'cli',
    text: 'Mine 100 cobblestone.'
  });
  const asg1 = task.activeAssignments[0];

  await master1.coordinator.handleWorkerEventBatch(w1.auth, [
    {
      schemaVersion: 1,
      messageId: crypto.randomUUID(),
      workerId: 'worker-1',
      workerSequence: 1,
      createdAt: new Date(clock).toISOString(),
      eventType: 'assignment_progress',
      payload: {
        schemaVersion: 1,
        reportId: crypto.randomUUID(),
        assignmentId: asg1.assignmentId,
        leaseId: asg1.leaseId,
        allocationEpoch: 1,
        taskId: task.taskId,
        objectiveId: asg1.objectiveId,
        workerId: 'worker-1',
        botId: 'bot-1',
        outcome: 'partial',
        durationMs: 5000,
        beforeSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: {} },
        afterSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: { 'minecraft:cobblestone': 35 } },
        evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 35, details: {} }],
        reportedAt: new Date(clock).toISOString()
      }
    }
  ]);

  await master1.stop();

  // Advance clock +8s so lease expires while Master is offline
  clock += 8_000;

  const master2 = createMaster(cfg);
  master2.botRegistry._now = () => clock;
  master2.taskManager._now = () => clock;
  await master2.start();

  try {
    await master2.coordinator.recover(new Date(clock).toISOString());

    const afterRecover = await master2.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(afterRecover.objectives[0].verifiedQuantity, 35);
    assert.equal(afterRecover.objectives[0].reservedQuantity, 0);
    assert.equal(afterRecover.objectives[0].remainingQuantity, 65);
    assert.equal(afterRecover.objectives[0].allocationEpoch, 2);

    // Worker-1 reconnects with fresh heartbeat -> Master #2 automatically assigns exact remaining 65!
    const auth2 = master2.botRegistry.verifyWorkerToken('worker-1', w1.reg.workerToken);
    await master2.coordinator.handleWorkerHeartbeat(auth2, {
      botSnapshots: [
        {
          botId: 'bot-1',
          status: 'ready',
          dimension: 'minecraft:overworld',
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 20 }]
        }
      ]
    });

    const resumed = await master2.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(resumed.activeAssignments.length, 1);
    assert.equal(resumed.activeAssignments[0].quotaQuantity, 65);
    assert.equal(resumed.activeAssignments[0].allocationEpoch, 2);

    const asg2 = resumed.activeAssignments[0];
    await master2.coordinator.handleWorkerEventBatch(auth2, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: new Date(clock).toISOString(),
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg2.assignmentId,
          leaseId: asg2.leaseId,
          allocationEpoch: 2,
          taskId: task.taskId,
          objectiveId: asg2.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'completed',
          durationMs: 12000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: { 'minecraft:cobblestone': 35 } },
          afterSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: { 'minecraft:cobblestone': 100 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 65, details: {} }],
          reportedAt: new Date(clock).toISOString()
        }
      }
    ]);

    const done = await master2.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(done.state, 'completed');
    assert.equal(done.objectives[0].verifiedQuantity, 100);
  } finally {
    await master2.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ADV-02: Duplicate task messages, out-of-order sequences & duplicate evidenceId produce zero double side-effects', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '2'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    const w1 = setupWorker(master, 'worker-1', [{ botId: 'bot-1' }, { botId: 'bot-2' }]);

    // 10 concurrent identical submitIntent requests with same idempotencyKey
    const submissions = await Promise.all(
      Array.from({ length: 10 }, () =>
        master.coordinator.submitIntent({
          actor: OPERATOR,
          source: 'dashboard',
          idempotencyKey: 'dup-storm-key-1',
          text: 'Mine 40 cobblestone.'
        })
      )
    );
    const uniqueTaskIds = new Set(submissions.map((t) => t.taskId));
    assert.equal(uniqueTaskIds.size, 1);

    const list = await master.coordinator.listTasks({ actor: VIEWER });
    assert.equal(list.items.length, 1);

    const asg = submissions[0].activeAssignments[0];
    const nowIso = new Date().toISOString();
    const sharedEvidenceId = crypto.randomUUID();

    // Event seq=5 arrives first (+10 cobblestone)
    const first = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 5,
        createdAt: nowIso,
        eventType: 'assignment_progress',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: submissions[0].taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: asg.botId,
          outcome: 'partial',
          durationMs: 2000,
          beforeSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 10 } },
          evidence: [{ evidenceId: sharedEvidenceId, kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 10, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(first[0].creditedDelta, 10);

    // Out-of-order lower sequence seq=4 (fresh messageId!) is rejected as duplicate
    const lowerSeq = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 4,
        createdAt: nowIso,
        eventType: 'assignment_progress',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: submissions[0].taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: asg.botId,
          outcome: 'partial',
          durationMs: 2000,
          beforeSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 20 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 20, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(lowerSeq[0].status, 'duplicate');
    assert.equal(lowerSeq[0].creditedDelta, 0);

    // Higher sequence seq=6 re-submitting the SAME evidenceId credits 0 additional units!
    const dupEv = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 6,
        createdAt: nowIso,
        eventType: 'assignment_progress',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: submissions[0].taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: asg.botId,
          outcome: 'partial',
          durationMs: 3000,
          beforeSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asg.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 20 } },
          evidence: [{ evidenceId: sharedEvidenceId, kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 10, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(dupEv[0].creditedDelta, 0);
    assert.equal(
      (await master.coordinator.getTask({ actor: VIEWER, taskId: submissions[0].taskId })).objectives[0]
        .verifiedQuantity,
      10
    );
  } finally {
    await master.stop();
  }
});

test('ADV-03: NEXUS-20 Mode 1 (20-bot shared objective), Mode 3 (shared + guard role), 1-step craft lookahead & empirical rate learning', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_GLOBAL_MAX_BOTS: '20',
    SWARM_ENABLED_BOTS: '20'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    // 1. 1-step wooden pickaxe lookahead (`HIGH-03b`): bot-craftable has planks+sticks; bot-bare has empty inventory
    setupWorker(master, 'worker-lookahead', [
      {
        botId: 'bot-bare',
        inventoryItems: []
      },
      {
        botId: 'bot-craftable',
        inventoryItems: [
          { name: 'oak_planks', count: 3 },
          { name: 'stick', count: 2 }
        ]
      }
    ]);

    const smallMine = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 10 cobblestone.'
    });
    assert.equal(smallMine.activeAssignments.length, 1);
    assert.equal(smallMine.activeAssignments[0].botId, 'bot-craftable');

    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: smallMine.taskId });

    // 2. Mode 3: Combined shared partitionable objective + individual guard role ("Mine 100 cobblestone while one bot guards.")
    setupWorker(master, 'worker-team', [
      { botId: 'bot-t1' },
      { botId: 'bot-t2' },
      { botId: 'bot-t3' }
    ]);
    const combined = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Mine 100 cobblestone while one bot guards.'
    });
    const guardAsgs = combined.activeAssignments.filter((a) => a.actionType === 'guard');
    const mineAsgs = combined.activeAssignments.filter((a) => a.actionType === 'mine');
    assert.equal(guardAsgs.length, 1);
    assert.ok(mineAsgs.length >= 2);
    assert.equal(mineAsgs.reduce((s, a) => s + a.quotaQuantity, 0), 100);
    assert.equal(mineAsgs.some((a) => a.botId === guardAsgs[0].botId), false);

    // Record empirical fast rate on bot-t1 by completing its mining quota rapidly
    const t1Asg = mineAsgs.find((a) => a.botId === 'bot-t1') || mineAsgs[0];
    const teamAuth = master.botRegistry.listWorkers().find((w) => w.workerId === 'worker-team');
    assert.ok(teamAuth);
    const nowIso = new Date().toISOString();
    await master.coordinator.handleWorkerEventBatch(
      { workerId: t1Asg.workerId, allowedBotIds: ['bot-craftable', 'bot-t1', 'bot-t2', 'bot-t3'] },
      [
        {
          schemaVersion: 1,
          messageId: crypto.randomUUID(),
          workerId: t1Asg.workerId,
          workerSequence: 1,
          createdAt: nowIso,
          eventType: 'assignment_completed',
          payload: {
            schemaVersion: 1,
            reportId: crypto.randomUUID(),
            assignmentId: t1Asg.assignmentId,
            leaseId: t1Asg.leaseId,
            allocationEpoch: 1,
            taskId: combined.taskId,
            objectiveId: t1Asg.objectiveId,
            workerId: t1Asg.workerId,
            botId: t1Asg.botId,
            outcome: 'completed',
            durationMs: 20000, // Realistic fast empirical rate (~2.5 blocks/sec vs 1.2 prior)
            beforeSnapshot: { botId: t1Asg.botId, capturedAt: nowIso, itemCounts: {} },
            afterSnapshot: { botId: t1Asg.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': t1Asg.quotaQuantity } },
            evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: t1Asg.quotaQuantity, details: {} }],
            reportedAt: nowIso
          }
        }
      ]
    );

    const learned = master.taskScheduler.lookupRateEstimate(t1Asg.botId, 'mine:minecraft:cobblestone');
    assert.equal(learned.isPrior, false);
    assert.equal(learned.sampleCount, 1);

    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: combined.taskId });

    // 3. Mode 1: Large objective ("Mine 5000 cobblestone.") across 20 bots
    setupWorker(
      master,
      'worker-fleet',
      Array.from({ length: 15 }, (_, i) => ({ botId: `bot-fleet-${i + 1}` }))
    );
    const mega = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Mine 5000 cobblestone.'
    });
    assert.ok(mega.activeAssignments.length >= 8 && mega.activeAssignments.length <= 20);
    assert.equal(
      mega.activeAssignments.reduce((s, a) => s + a.quotaQuantity, 0),
      5000
    );
  } finally {
    await master.stop();
  }
});

test('ADV-04: 200-step randomized failure/disconnect/expiry/replay fuzz preserves exact quota conservation invariant', async () => {
  let clock = Date.parse('2026-11-10T18:00:00.000Z');
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '4',
    SWARM_LEASE_DURATION_MS: '6000',
    SWARM_HEARTBEAT_INTERVAL_MS: '1000'
  });
  const master = createMaster(cfg);
  master.botRegistry._now = () => clock;
  master.taskManager._now = () => clock;
  await master.start();

  try {
    const botIds = ['fuzz-1', 'fuzz-2', 'fuzz-3', 'fuzz-4', 'fuzz-5', 'fuzz-6'];
    const w = setupWorker(
      master,
      'worker-fuzz',
      botIds.map((botId) => ({ botId }))
    );

    const task = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 250 cobblestone.'
    });

    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };

    let seq = 0;
    for (let step = 0; step < 200; step += 1) {
      clock += 500;
      const nowIso = new Date(clock).toISOString();

      // Always refresh bots periodically so recovered bots re-enter pool
      if (step % 4 === 0) {
        await master.coordinator.handleWorkerHeartbeat(w.auth, {
          botSnapshots: botIds.map((botId, idx) => ({
            botId,
            status: 'ready',
            dimension: 'minecraft:overworld',
            position: { x: idx * 5, y: 64, z: 0 },
            health: 20,
            food: 20,
            inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
          }))
        });
      }

      const cur = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
      const obj = cur.objectives[0];
      // Core conservation invariant after EVERY step!
      assert.ok(obj.verifiedQuantity >= 0 && obj.reservedQuantity >= 0);
      assert.ok(
        obj.verifiedQuantity + obj.reservedQuantity <= obj.targetQuantity,
        `Invariant violated at step ${step}: verified=${obj.verifiedQuantity}, reserved=${obj.reservedQuantity}`
      );
      if (cur.state === 'completed') break;

      if (cur.activeAssignments.length === 0) {
        clock += 6_500;
        master.taskManager.expireLeases(new Date(clock).toISOString());
        continue;
      }

      const pick = cur.activeAssignments[Math.floor(rand() * cur.activeAssignments.length)];
      const roll = rand();

      if (roll < 0.45) {
        // Complete or partial progress
        seq += 1;
        const remQuota = Math.max(1, pick.quotaQuantity - pick.creditedQuantity);
        const gain = Math.max(1, Math.min(remQuota, Math.ceil(rand() * remQuota)));
        const isDone = pick.creditedQuantity + gain >= pick.quotaQuantity;
        await master.coordinator.handleWorkerEventBatch(w.auth, [
          {
            schemaVersion: 1,
            messageId: crypto.randomUUID(),
            workerId: 'worker-fuzz',
            workerSequence: seq,
            createdAt: nowIso,
            eventType: isDone ? 'assignment_completed' : 'assignment_progress',
            payload: {
              schemaVersion: 1,
              reportId: crypto.randomUUID(),
              assignmentId: pick.assignmentId,
              leaseId: pick.leaseId,
              allocationEpoch: obj.allocationEpoch,
              taskId: task.taskId,
              objectiveId: obj.objectiveId,
              workerId: 'worker-fuzz',
              botId: pick.botId,
              outcome: isDone ? 'completed' : 'partial',
              durationMs: 1500,
              beforeSnapshot: { botId: pick.botId, capturedAt: nowIso, itemCounts: {} },
              afterSnapshot: {
                botId: pick.botId,
                capturedAt: nowIso,
                itemCounts: { 'minecraft:cobblestone': pick.creditedQuantity + gain }
              },
              evidence: [
                {
                  evidenceId: crypto.randomUUID(),
                  kind: 'inventory_delta',
                  itemKey: 'minecraft:cobblestone',
                  claimedDelta: gain,
                  details: {}
                }
              ],
              reportedAt: nowIso
            }
          }
        ]);
      } else if (roll < 0.7) {
        // Tool break or inventory full failure
        seq += 1;
        const code = rand() < 0.5 ? 'TOOL_BROKEN_OR_MISSING' : 'INVENTORY_FULL';
        await master.coordinator.handleWorkerEventBatch(w.auth, [
          {
            schemaVersion: 1,
            messageId: crypto.randomUUID(),
            workerId: 'worker-fuzz',
            workerSequence: seq,
            createdAt: nowIso,
            eventType: 'assignment_failed',
            payload: {
              schemaVersion: 1,
              reportId: crypto.randomUUID(),
              assignmentId: pick.assignmentId,
              leaseId: pick.leaseId,
              allocationEpoch: obj.allocationEpoch,
              taskId: task.taskId,
              objectiveId: obj.objectiveId,
              workerId: 'worker-fuzz',
              botId: pick.botId,
              failureCode: code,
              retryable: true,
              safeState: 'idle_safe',
              summary: 'fuzz failure',
              partialReport: null,
              reportedAt: nowIso
            }
          }
        ]);
      } else if (roll < 0.85) {
        // Bot disconnect mid-mining
        seq += 1;
        await master.coordinator.handleWorkerEventBatch(w.auth, [
          {
            schemaVersion: 1,
            messageId: crypto.randomUUID(),
            workerId: 'worker-fuzz',
            workerSequence: seq,
            createdAt: nowIso,
            eventType: 'bot_lifecycle',
            payload: { botId: pick.botId, status: 'disconnected' }
          }
        ]);
      } else {
        // Lease expiry jump
        clock += 6_500;
        master.taskManager.expireLeases(new Date(clock).toISOString());
      }
    }

    const finalTask = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(finalTask.state, 'completed');
    assert.equal(finalTask.objectives[0].verifiedQuantity, 250);
    assert.equal(finalTask.objectives[0].reservedQuantity, 0);
  } finally {
    await master.stop();
  }
});
