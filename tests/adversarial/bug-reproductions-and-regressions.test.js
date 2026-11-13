'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createMaster,
  loadConfig,
  DomainError,
  SchemaValidator,
  performance
} = require('../../index');

const { AiEfficiencyController, buildCompactAiInput } = performance;

const ADMIN = { principalId: 'admin-1', actorType: 'human', role: 'admin', serverId: null };
const OPERATOR = { principalId: 'op-1', actorType: 'human', role: 'operator', serverId: null };
const VIEWER = { principalId: 'view-1', actorType: 'human', role: 'viewer', serverId: null };

function enrollWorkerWithBots(master, workerId, botsSpec) {
  const { bootstrapToken } = master.botRegistry.createBootstrapToken({ createdBy: ADMIN.principalId });
  const reg = master.botRegistry.register({
    bootstrapToken,
    workerInfo: {
      workerId,
      hostname: `${workerId}.lan`,
      maxBotSlots: Math.max(4, botsSpec.length),
      configuredBots: botsSpec.map((b) => ({
        botId: b.botId,
        username: b.username || `User_${b.botId}`,
        serverId: 'srv-nexus',
        authMode: 'online_microsoft'
      }))
    }
  });
  const auth = master.botRegistry.verifyWorkerToken(workerId, reg.workerToken);
  master.botRegistry.heartbeat(workerId, {
    botSnapshots: botsSpec.map((b, idx) => ({
      botId: b.botId,
      status: b.status || 'ready',
      dimension: b.dimension || 'minecraft:overworld',
      position: b.position || { x: idx * 10, y: 64, z: 0 },
      health: b.health ?? 20,
      food: b.food ?? 20,
      inventoryItems: b.inventoryItems || [
        { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }
      ]
    }))
  });
  return { reg, auth };
}

test('REG-01: Invalid config handling enforces AI timeout inequalities and rejects invalid boolean strings', () => {
  // connectTimeoutMs > timeoutMs must fail
  assert.throws(
    () =>
      loadConfig({
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_TLS_ENABLED: 'false',
        SWARM_AI_CONNECT_TIMEOUT_MS: '10000',
        SWARM_AI_TIMEOUT_MS: '4000',
        SWARM_AI_COLD_TIMEOUT_MS: '20000'
      }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  // timeoutMs > coldLoadTimeoutMs must fail
  assert.throws(
    () =>
      loadConfig({
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_TLS_ENABLED: 'false',
        SWARM_AI_CONNECT_TIMEOUT_MS: '2000',
        SWARM_AI_TIMEOUT_MS: '25000',
        SWARM_AI_COLD_TIMEOUT_MS: '15000'
      }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  // Malformed boolean string (e.g. typo in SWARM_TLS_ENABLED) must NOT silently coerce to false
  assert.throws(
    () =>
      loadConfig({
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_TLS_ENABLED: 'definitely_not_a_boolean'
      }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );
});

test('REG-02: Ollama unavailable, AI timeout, and invalid/truncated/primitive model JSON degrade cleanly with accurate stats', async () => {
  // 1. Truncated / malformed JSON in Ollama message.content -> schema_rejected_fallback (0 retries!)
  let malformedCalls = 0;
  const badJsonAi = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.5:11434',
    model: 'qwen2.5:7b',
    timeoutMs: 300,
    transportOverride: async () => {
      malformedCalls += 1;
      return { message: { content: '{"schemaVersion": 1, "objectives": [BROKEN_JSON' } };
    }
  });

  const badJsonRes = await badJsonAi.createPlan({
    requestId: crypto.randomUUID(),
    userText: 'Organize complex multi-stage base fortification near river'
  });
  assert.equal(malformedCalls, 1); // Must NOT retry invalid model JSON!
  assert.equal(badJsonRes.source, 'schema_rejected_fallback');
  assert.equal(badJsonAi.stats().validationFailures, 1);
  assert.equal(badJsonAi.stats().transportErrors, 0);
  assert.equal(badJsonRes.plan.clarificationRequired, true);

  // 2. Non-object JSON primitive ("null" / "42" / array) returned by model -> schema_rejected_fallback without crash
  const primitiveAi = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.5:11434',
    model: 'qwen2.5:7b',
    timeoutMs: 300,
    transportOverride: async () => ({ message: { content: 'null' } })
  });
  const primRes = await primitiveAi.createPlan({
    requestId: crypto.randomUUID(),
    userText: 'Coordinate custom redstone sorting logistics'
  });
  assert.equal(primRes.source, 'schema_rejected_fallback');
  assert.equal(primitiveAi.stats().validationFailures, 1);

  // 3. AI Timeout handling: slow remote Ollama aborts at timeoutMs without retrying and falls back cleanly
  let slowCalls = 0;
  let signalAborted = false;
  const slowAi = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.5:11434',
    model: 'qwen2.5:7b',
    timeoutMs: 120,
    transportOverride: ({ signal }) =>
      new Promise((resolve, reject) => {
        slowCalls += 1;
        signal.addEventListener('abort', () => {
          signalAborted = true;
          const e = new Error('aborted');
          e.code = 'AI_TIMEOUT';
          reject(e);
        });
      })
  });
  const timeoutRes = await slowAi.createPlan({
    requestId: crypto.randomUUID(),
    userText: 'Prepare intricate nether hub expedition'
  });
  assert.equal(slowCalls, 1); // Never retry on timeout!
  assert.equal(signalAborted, true);
  assert.equal(timeoutRes.errorCode, 'AI_TIMEOUT');
  assert.equal(slowAi.stats().timeouts, 1);

  // 4. Ollama completely unavailable (ECONNREFUSED) retries once then falls back deterministically
  let downCalls = 0;
  const downAi = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.5:11434',
    model: 'qwen2.5:7b',
    timeoutMs: 300,
    transportOverride: async () => {
      downCalls += 1;
      const err = new Error('connect ECONNREFUSED 10.8.0.5:11434');
      err.code = 'AI_TRANSPORT_ERROR';
      throw err;
    }
  });
  const downRes = await downAi.createPlan({
    requestId: crypto.randomUUID(),
    userText: 'Prepare intricate castle layout with watchtowers'
  });
  assert.equal(downCalls, 2); // Initial + 1 transient retry
  assert.equal(downRes.source, 'error_fallback');
  assert.equal(downRes.plan.clarificationRequired, true);
});

test('REG-03: Task cancelled halfway through clears activeAssignments, preserves partial verified credit, is idempotent, and rejects late reports', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '2'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    const w1 = enrollWorkerWithBots(master, 'worker-1', [{ botId: 'bot-1' }, { botId: 'bot-2' }]);
    const task = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Mine 100 cobblestone.'
    });
    assert.equal(task.activeAssignments.length, 2);
    const [asg1, asg2] = task.activeAssignments;
    const nowIso = new Date().toISOString();

    // Bot 1 completes its 50 cobblestone quota halfway through overall 100-cobble task
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg1.assignmentId,
          leaseId: asg1.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: asg1.objectiveId,
          workerId: 'worker-1',
          botId: asg1.botId,
          outcome: 'completed',
          durationMs: 9000,
          beforeSnapshot: { botId: asg1.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asg1.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 50 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 50, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);

    // Operator cancels halfway through!
    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: task.taskId, reason: 'abort_mission' });
    const afterCancel = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });

    assert.equal(afterCancel.state, 'cancelled');
    assert.equal(afterCancel.pauseReason, null); // Cancellation reason must NOT pollute pauseReason
    assert.equal(afterCancel.activeAssignments.length, 0); // ZERO active assignments after cancel!
    assert.equal(afterCancel.objectives[0].verifiedQuantity, 50); // Verified partial progress preserved!
    assert.equal(afterCancel.objectives[0].reservedQuantity, 0);

    const epochAfterFirstCancel = afterCancel.objectives[0].allocationEpoch;

    // Duplicate cancel call must be idempotent (must NOT bump epoch or throw)
    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: task.taskId, reason: 'abort_mission' });
    const afterSecondCancel = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(afterSecondCancel.objectives[0].allocationEpoch, epochAfterFirstCancel);

    // Late report from Bot 2 after cancellation is fenced & rejected with 0 credit
    const lateAck = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg2.assignmentId,
          leaseId: asg2.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: asg2.objectiveId,
          workerId: 'worker-1',
          botId: asg2.botId,
          outcome: 'completed',
          durationMs: 9000,
          beforeSnapshot: { botId: asg2.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: asg2.botId, capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 50 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 50, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(lateAck[0].status, 'rejected');
    assert.equal(lateAck[0].creditedDelta, 0);
  } finally {
    await master.stop();
  }
});

test('REG-04: Duplicate objective prevention rejects duplicate parallel objectives and cleans up superseded objectives on replan', async () => {
  const validator = new SchemaValidator();

  // Two parallel objectives mining the exact same resource with no dependency edge must be rejected or coalesced
  const dupPlan = {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    intentSummary: 'Duplicate cobblestone objectives',
    clarificationRequired: false,
    clarificationQuestion: null,
    objectives: [
      {
        localId: 'obj_a',
        kind: 'mine',
        target: { resourceId: 'minecraft:cobblestone', quantity: 50, regionLabel: null, description: 'Mine 50 cobble' },
        dependencies: [],
        parallelism: 'partitionable',
        workerCountHint: 2,
        constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 128 },
        verification: 'newly_collected'
      },
      {
        localId: 'obj_b',
        kind: 'mine',
        target: { resourceId: 'minecraft:cobblestone', quantity: 50, regionLabel: null, description: 'Mine another 50 cobble' },
        dependencies: [],
        parallelism: 'partitionable',
        workerCountHint: 2,
        constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 128 },
        verification: 'newly_collected'
      }
    ],
    riskLevel: 'low',
    notes: []
  };
  const check = validator.validatePlanSemantics(dupPlan);
  assert.equal(check.valid, false);

  // Fast-path planner coalesces "Mine 60 cobblestone and 40 cobblestone" into ONE 100-cobblestone objective!
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:'
  });
  const master = createMaster(cfg);
  await master.start();
  try {
    const coalesced = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 60 cobblestone and 40 cobblestone.'
    });
    assert.equal(coalesced.objectives.length, 1);
    assert.equal(coalesced.objectives[0].targetQuantity, 100);

    // Replanning a task that previously had an obsolete objective cancels the obsolete objective so the task can complete
    const t = master.taskManager.createTask({
      actorId: 'op-1',
      source: 'cli',
      rawText: 'Gather stone then replan',
      initialState: 'planning'
    });
    master.taskManager.attachPlan({
      taskId: t.taskId,
      plan: {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        intentSummary: 'Plan v1',
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'obsolete_obj',
            kind: 'mine',
            target: { resourceId: 'minecraft:obsidian', quantity: 10, regionLabel: null, description: 'Mine obsidian' },
            dependencies: [],
            parallelism: 'single',
            workerCountHint: 1,
            constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 64 },
            verification: 'newly_collected'
          }
        ],
        riskLevel: 'low',
        notes: []
      }
    });
    master.taskManager.pauseTask(t.taskId, 'replan');
    master.taskManager.attachPlan({
      taskId: t.taskId,
      plan: {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        intentSummary: 'Plan v2',
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'new_obj',
            kind: 'craft',
            target: { resourceId: 'minecraft:wooden_pickaxe', quantity: 1, regionLabel: null, description: 'Craft pick' },
            dependencies: [],
            parallelism: 'single',
            workerCountHint: 1,
            constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 64 },
            verification: 'crafted_output'
          }
        ],
        riskLevel: 'low',
        notes: []
      }
    });
    const afterReplan = master.taskManager.getTask(t.taskId);
    const obsolete = afterReplan.objectives.find((o) => o.localId === 'obsolete_obj');
    assert.equal(obsolete.state, 'cancelled');
  } finally {
    await master.stop();
  }
});

test('REG-05: Inventory verification preserves baseline across incremental progress, accepts heldTool, and keeps lease open on rejected completion', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '1'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    const w1 = enrollWorkerWithBots(master, 'worker-1', [{ botId: 'bot-1' }]);
    const task = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 50 cobblestone.'
    });
    const asg = task.activeAssignments[0];
    const nowIso = new Date().toISOString();

    // 1. Fraudulent/mistaken completion report (0 delta, pre-existing 10 cobble) MUST be rejected WITHOUT closing the assignment!
    const badComplete = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'completed',
          durationMs: 1000,
          beforeSnapshot: {
            botId: 'bot-1',
            capturedAt: nowIso,
            itemCounts: { 'minecraft:cobblestone': 10 },
            heldTool: { itemKey: 'minecraft:iron_pickaxe', remainingDurability: 240 }
          },
          afterSnapshot: {
            botId: 'bot-1',
            capturedAt: nowIso,
            itemCounts: { 'minecraft:cobblestone': 10 },
            heldTool: { itemKey: 'minecraft:iron_pickaxe', remainingDurability: 240 }
          },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 10, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(badComplete[0].status, 'rejected');
    assert.equal(badComplete[0].rejectionCode, 'PRE_EXISTING_STOCK_NOT_CREDITED');

    // Assignment must STILL be active (not falsely marked 'completed')!
    const stillActive = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(stillActive.activeAssignments.length, 1);

    // 2. Two incremental progress checkpoints (10 -> 30, then 30 -> 60) WITHOUT prior acknowledgeAssignment
    const prog1 = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: nowIso,
        eventType: 'assignment_progress',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'partial',
          durationMs: 4000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 10 } },
          afterSnapshot: { botId: 'bot-1', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 30 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 20, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(prog1[0].status, 'accepted');
    assert.equal(prog1[0].creditedDelta, 20);

    // Second checkpoint (30 -> 60 = +30 more above baseline 10 -> total +50!)
    const prog2 = await master.coordinator.handleWorkerEventBatch(w1.auth, [
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
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'completed',
          durationMs: 8000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 30 } },
          afterSnapshot: { botId: 'bot-1', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 60 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 30, details: {} }],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(prog2[0].status, 'accepted');
    assert.equal(prog2[0].creditedDelta, 30);

    const finished = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(finished.state, 'completed');
    assert.equal(finished.objectives[0].verifiedQuantity, 50);
  } finally {
    await master.stop();
  }
});

test('REG-06: Bot disconnecting while mining, inventory becoming full, and resource disappearing reallocate or block cleanly', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_ENABLED_BOTS: '2'
  });
  const master = createMaster(cfg);
  await master.start();

  try {
    const w1 = enrollWorkerWithBots(master, 'worker-1', [
      { botId: 'bot-1' },
      { botId: 'bot-2' },
      { botId: 'bot-3' }
    ]);

    const task = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 100 cobblestone.'
    });
    assert.equal(task.activeAssignments.length, 2);
    const [asg1, asg2] = task.activeAssignments;
    const nowIso = new Date().toISOString();

    // 1. Bot 1 disconnects mid-mining (`bot_lifecycle` status='disconnected'):
    //    Heartbeat MUST NOT renew disconnected bot-1's lease, and bot-1's uncredited quota (50) must immediately reallocate to bot-3!
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'bot_lifecycle',
        payload: {
          botId: asg1.botId,
          status: 'disconnected',
          reason: 'socket_closed'
        }
      }
    ]);

    const hbAfterDisc = await master.coordinator.handleWorkerHeartbeat(w1.auth, {
      botSnapshots: [
        { botId: 'bot-1', status: 'disconnected' },
        { botId: 'bot-2', status: 'busy', health: 20, food: 20, inventoryItems: [{ name: 'iron_pickaxe', count: 1 }] },
        { botId: 'bot-3', status: 'ready', health: 20, food: 20, inventoryItems: [{ name: 'iron_pickaxe', count: 1 }] }
      ]
    });
    assert.equal(hbAfterDisc.renewedLeaseIds.includes(asg1.leaseId), false);

    const afterDiscTask = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(afterDiscTask.activeAssignments.some((a) => a.botId === 'bot-1'), false);
    const bot3Asg = afterDiscTask.activeAssignments.find((a) => a.botId === 'bot-3');
    assert.ok(bot3Asg, 'Healthy reserve bot-3 must take over disconnected bot-1 quota');
    assert.equal(bot3Asg.quotaQuantity, 50);

    // 2. Bot 2 fills its inventory at 30/50 (`INVENTORY_FULL` with partialReport +30):
    //    Bot 2 must NOT be re-assigned the remaining 20 while its inventory is full!
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 2,
        createdAt: nowIso,
        eventType: 'assignment_failed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg2.assignmentId,
          leaseId: asg2.leaseId,
          allocationEpoch: afterDiscTask.objectives[0].allocationEpoch,
          taskId: task.taskId,
          objectiveId: asg2.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-2',
          failureCode: 'INVENTORY_FULL',
          retryable: true,
          safeState: 'idle_safe',
          summary: '36/36 slots occupied',
          partialReport: {
            schemaVersion: 1,
            reportId: crypto.randomUUID(),
            assignmentId: asg2.assignmentId,
            leaseId: asg2.leaseId,
            allocationEpoch: afterDiscTask.objectives[0].allocationEpoch,
            taskId: task.taskId,
            objectiveId: asg2.objectiveId,
            workerId: 'worker-1',
            botId: 'bot-2',
            outcome: 'partial',
            durationMs: 7000,
            beforeSnapshot: { botId: 'bot-2', capturedAt: nowIso, itemCounts: {} },
            afterSnapshot: { botId: 'bot-2', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 30 } },
            evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 30, details: {} }],
            reportedAt: nowIso
          },
          reportedAt: nowIso
        }
      }
    ]);

    const afterFullTask = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(afterFullTask.objectives[0].verifiedQuantity, 30);
    // Bot 2 must NOT have been re-assigned while disqualified by INVENTORY_FULL!
    assert.equal(afterFullTask.activeAssignments.some((a) => a.botId === 'bot-2'), false);

    // 3. Resource disappearing (`RESOURCE_NOT_FOUND`, retryable: false) transitions task cleanly to `blocked`
    const resTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 10 diamond_ore.'
    });
    // Bring bot-1 back online so it picks up diamond_ore after bot-3 finishes or free a slot
    await master.coordinator.handleWorkerHeartbeat(w1.auth, {
      botSnapshots: [
        { botId: 'bot-1', status: 'ready', health: 20, food: 20, inventoryItems: [{ name: 'iron_pickaxe', count: 1 }] }
      ]
    });
    const refreshedResTask = await master.coordinator.getTask({ actor: VIEWER, taskId: resTask.taskId });
    assert.equal(refreshedResTask.activeAssignments.length, 1);
    const diamondAsg = refreshedResTask.activeAssignments[0];

    await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 3,
        createdAt: nowIso,
        eventType: 'assignment_failed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: diamondAsg.assignmentId,
          leaseId: diamondAsg.leaseId,
          allocationEpoch: 1,
          taskId: resTask.taskId,
          objectiveId: diamondAsg.objectiveId,
          workerId: 'worker-1',
          botId: diamondAsg.botId,
          failureCode: 'RESOURCE_NOT_FOUND',
          retryable: false,
          safeState: 'idle_safe',
          summary: 'Vein mined out / disappeared',
          partialReport: null,
          reportedAt: nowIso
        }
      }
    ]);
    const blockedTask = await master.coordinator.getTask({ actor: VIEWER, taskId: resTask.taskId });
    assert.equal(blockedTask.state, 'blocked');
    assert.equal(blockedTask.objectives[0].state, 'blocked');
  } finally {
    await master.stop();
  }
});

test('REG-07: Worker reconnecting after assignment expiry & worker re-enrollment reset sequences and reschedule waiting tasks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-recon-'));
  const dbPath = path.join(tmpDir, 'recon.db');

  let clock = Date.parse('2026-11-10T12:00:00.000Z');
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: dbPath,
    SWARM_HEARTBEAT_INTERVAL_MS: '1000',
    SWARM_LEASE_DURATION_MS: '4000',
    SWARM_ENABLED_BOTS: '2'
  });

  const master = createMaster(cfg);
  // Inject deterministic clock on registry & taskManager for precise expiry testing
  master.botRegistry._now = () => clock;
  master.taskManager._now = () => clock;
  await master.start();

  try {
    const w1 = enrollWorkerWithBots(master, 'worker-1', [{ botId: 'bot-1' }]);
    const task = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Mine 40 cobblestone.'
    });
    const firstAsg = task.activeAssignments[0];

    // Send 1 progress event so worker.last_event_seq becomes 1
    await master.coordinator.handleWorkerEventBatch(w1.auth, [
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
          assignmentId: firstAsg.assignmentId,
          leaseId: firstAsg.leaseId,
          allocationEpoch: 1,
          taskId: task.taskId,
          objectiveId: firstAsg.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'partial',
          durationMs: 1000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: {} },
          afterSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: { 'minecraft:cobblestone': 10 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 10, details: {} }],
          reportedAt: new Date(clock).toISOString()
        }
      }
    ]);

    // Advance clock past lease expiry (+6s > 4s TTL) BEFORE periodic timer sweep runs!
    clock += 6_000;

    // Worker reconnects and calls reconcileWorker: must fence epoch 1 -> 2 and release remaining 30 cobble!
    const recon = master.taskManager.reconcileWorker('worker-1', {
      activeLeases: [{ assignmentId: firstAsg.assignmentId, leaseId: firstAsg.leaseId, allocationEpoch: 1 }]
    });
    assert.equal(recon.reconcileActions[0].directive, 'stop_and_fence');
    assert.equal(recon.reconcileActions[0].currentAllocationEpoch, 2);

    const mid = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(mid.objectives[0].reservedQuantity, 0);
    assert.equal(mid.objectives[0].remainingQuantity, 30);

    // Worker process crashes & re-enrolls from scratch (workerSequence restarts at 1):
    // Re-enrollment must reset last_event_seq to 0 so sequence=1 is ACCEPTED, not dropped as duplicate!
    const w1Reborn = enrollWorkerWithBots(master, 'worker-1', [{ botId: 'bot-1' }]);
    assert.equal(w1Reborn.reg.lastAckedWorkerSequence, 0);

    // Heartbeat from reborn worker triggers automatic scheduling of remaining 30 cobblestone!
    await master.coordinator.handleWorkerHeartbeat(w1Reborn.auth, {
      botSnapshots: [
        {
          botId: 'bot-1',
          status: 'ready',
          dimension: 'minecraft:overworld',
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
        }
      ]
    });

    const reassigned = await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId });
    assert.equal(reassigned.activeAssignments.length, 1);
    assert.equal(reassigned.activeAssignments[0].quotaQuantity, 30);
    assert.equal(reassigned.activeAssignments[0].allocationEpoch, 2);

    const newAsg = reassigned.activeAssignments[0];
    const rebornAck = await master.coordinator.handleWorkerEventBatch(w1Reborn.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-1',
        workerSequence: 1, // Restarted at 1!
        createdAt: new Date(clock).toISOString(),
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: newAsg.assignmentId,
          leaseId: newAsg.leaseId,
          allocationEpoch: 2,
          taskId: task.taskId,
          objectiveId: newAsg.objectiveId,
          workerId: 'worker-1',
          botId: 'bot-1',
          outcome: 'completed',
          durationMs: 5000,
          beforeSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: {} },
          afterSnapshot: { botId: 'bot-1', capturedAt: new Date(clock).toISOString(), itemCounts: { 'minecraft:cobblestone': 30 } },
          evidence: [{ evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 30, details: {} }],
          reportedAt: new Date(clock).toISOString()
        }
      }
    ]);
    assert.equal(rebornAck[0].status, 'accepted');
    assert.equal(rebornAck[0].creditedDelta, 30);
    assert.equal((await master.coordinator.getTask({ actor: VIEWER, taskId: task.taskId })).state, 'completed');
  } finally {
    await master.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REG-08: NEXUS-20 full swarm world-state awareness & dynamic priority/multi-objective allocation across 20 bots', async () => {
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_GLOBAL_MAX_BOTS: '20',
    SWARM_ENABLED_BOTS: '20'
  });

  let capturedAiInput = null;
  const master = createMaster(cfg, {
    aiTransportOverride: async ({ body }) => {
      capturedAiInput = JSON.parse(body.messages[1].content);
      return {
        schemaVersion: 1,
        requestId: capturedAiInput.requestId,
        intentSummary: 'Swarm state verified',
        clarificationRequired: true,
        clarificationQuestion: 'Ready for coordinates?',
        objectives: [],
        riskLevel: 'low',
        notes: []
      };
    }
  });
  master.aiController._endpoint = new URL('https://10.8.0.9:11434');
  await master.start();

  try {
    // Enroll 20 bots across 2 distributed workers (18 ready + 2 offline)
    const w1Bots = Array.from({ length: 10 }, (_, i) => ({
      botId: `bot-${i + 1}`,
      status: i === 9 ? 'disconnected' : 'ready',
      position: { x: i * 12, y: 64, z: -5 },
      inventoryItems: [
        { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 10 },
        { name: 'cobblestone', count: 16 }
      ]
    }));
    const w2Bots = Array.from({ length: 10 }, (_, i) => ({
      botId: `bot-${i + 11}`,
      status: i === 9 ? 'disconnected' : 'ready',
      position: { x: i * 12, y: 64, z: 25 },
      inventoryItems: [
        { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 5 },
        { name: 'coal', count: 8 }
      ]
    }));
    enrollWorkerWithBots(master, 'worker-alpha', w1Bots);
    enrollWorkerWithBots(master, 'worker-beta', w2Bots);

    // 1. Mode 2: Different objectives to different bots ("Collect 100 cobblestone and 40 coal.")
    const multiObjTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      priority: 'low',
      text: 'Collect 100 cobblestone and 40 coal.'
    });
    assert.equal(multiObjTask.objectives.length, 2);
    const cobbleBots = multiObjTask.activeAssignments
      .filter((a) => a.resourceId === 'minecraft:cobblestone')
      .map((a) => a.botId);
    const coalBots = multiObjTask.activeAssignments
      .filter((a) => a.resourceId === 'minecraft:coal')
      .map((a) => a.botId);
    assert.ok(cobbleBots.length >= 2);
    assert.ok(coalBots.length >= 2);
    // Disjoint bot sets simultaneously working on different objectives!
    assert.equal(cobbleBots.some((id) => coalBots.includes(id)), false);

    // 2. Full NEXUS-20 AI world-state inspection on non-fast-path strategic prompt
    await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Evaluate current swarm readiness for deep cavern staging'
    });
    assert.ok(capturedAiInput, 'AI brain received compact world-state payload');
    assert.equal(capturedAiInput.swarmState.onlineBotCount, 18);
    assert.equal(capturedAiInput.swarmState.offlineBotCount, 2);
    assert.ok(capturedAiInput.swarmState.busyBotCount >= 4);
    assert.equal(capturedAiInput.swarmState.availableResources['minecraft:cobblestone'], 9 * 16);
    assert.equal(capturedAiInput.swarmState.availableResources['minecraft:coal'], 9 * 8);
    assert.equal(capturedAiInput.swarmState.requiredResources['minecraft:cobblestone'], 100);
    assert.ok(capturedAiInput.candidates[0].tool.includes('pickaxe'));
    assert.ok(capturedAiInput.candidates[0].capabilities.includes('mine'));
    assert.ok(capturedAiInput.candidates[0].position !== null);

    // 3. Mode 4: Dynamic priority preemption when urgent `safety` task arrives while all slots are offered!
    master.botRegistry.setEnabledBotsCap(4); // Restrict cap to 4 (currently held by low-priority `offered` leases)
    const urgentTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      priority: 'safety',
      text: 'Build a shelter while one bot guards.'
    });
    // Urgent safety task dynamically preempts 2 unstarted low-priority `offered` leases so shelter + guard start immediately!
    assert.equal(urgentTask.activeAssignments.length, 2);
  } finally {
    await master.stop();
  }
});
