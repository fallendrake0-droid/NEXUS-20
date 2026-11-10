'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, createMaster } = require('../../index');
const { createLogger } = require('../../src/logging/createLogger');
const { SseCoalescer } = require('../../src/performance/SseCoalescer');
const { toCompactBotSnapshot } = require('../../src/performance/CompactSnapshotCodec');
const { PathfindingGuard } = require('../../src/performance/PathfindingGuard');
const { BlockSearchCache } = require('../../src/performance/BlockSearchCache');
const { ChatHistoryGuard } = require('../../src/performance/ChatHistoryGuard');

const ADMIN = { principalId: 'admin-audit', actorType: 'human', role: 'admin', serverId: null };
const OPERATOR = { principalId: 'op-audit', actorType: 'human', role: 'operator', serverId: null };
const VIEWER = { principalId: 'view-audit', actorType: 'human', role: 'viewer', serverId: null };

function tempDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nexus20-audit-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'swarm.db'),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createTestConfig(dbPath, overrides = {}) {
  return loadConfig({
    SWARM_DB_PATH: dbPath,
    SWARM_OLLAMA_URL: 'http://100.64.0.10:11434',
    SWARM_OLLAMA_MODEL: 'qwen2.5:3b',
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_PORT: '0',
    SWARM_ENABLED_BOTS: '20',
    SWARM_OPERATING_MODE: 'HYBRID',
    SWARM_PERFORMANCE_PROFILE: 'PERFORMANCE',
    ...overrides
  });
}

async function enrollWorkerWithBots(master, workerId, botIds) {
  const { bootstrapToken } = master.botRegistry.createBootstrapToken({ createdBy: workerId });
  const reg = master.botRegistry.register({
    bootstrapToken,
    workerInfo: {
      schemaVersion: 1,
      workerId,
      hostname: `${workerId}.lan`,
      maxBotSlots: Math.max(4, botIds.length),
      configuredBots: botIds.map((id) => ({
        botId: id,
        username: id.replace(/[^a-zA-Z0-9_]/g, '_'),
        serverId: 'survival-main',
        authMode: 'online_microsoft'
      }))
    }
  });
  const auth = master.botRegistry.verifyWorkerToken(workerId, reg.workerToken);
  await master.coordinator.handleWorkerHeartbeat(auth, {
    botSnapshots: botIds.map((id, idx) => ({
      botId: id,
      status: 'ready',
      health: 20,
      food: 20,
      dimension: 'minecraft:overworld',
      position: { x: idx * 8, y: 64, z: 0 },
      inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 }]
    }))
  });
  return { reg, auth };
}

function httpJson({ port, method = 'GET', path: reqPath, headers = {}, body = undefined }) {
  return new Promise((resolve, reject) => {
    const rawBody =
      body === undefined ? null : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (rawBody !== null) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = rawBody.byteLength;
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      }
    );
    req.on('error', reject);
    if (rawBody !== null) req.write(rawBody);
    req.end();
  });
}

// ============================================================================
// BUG-F01 & BUG-F03: Shared-objective sibling epoch isolation + instant disconnect lease release
// ============================================================================
test('BUG-F01 & BUG-F03: Sibling worker keeps valid issued epoch when peer bot disconnects and quota reallocates immediately', async () => {
  const tmp = tempDbPath('f01-f03');
  const master = createMaster(createTestConfig(tmp.dbPath));
  await master.start();

  try {
    const w1 = await enrollWorkerWithBots(master, 'worker-a', ['bot-a1']);
    const w2 = await enrollWorkerWithBots(master, 'worker-b', ['bot-b1']);

    await master.coordinator.setOperatingMode({ actor: OPERATOR, mode: 'SYNCHRONIZED' });
    const created = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Collect 100 cobblestone.'
    });

    const initial = await master.coordinator.getTask({ actor: VIEWER, taskId: created.taskId });
    assert.equal(initial.activeAssignments.length, 2);
    const asgA = initial.activeAssignments.find((a) => a.botId === 'bot-a1');
    const asgB = initial.activeAssignments.find((a) => a.botId === 'bot-b1');
    assert.equal(asgA.allocationEpoch, 1);
    assert.equal(asgB.allocationEpoch, 1);

    // BUG-F03: Worker A reports bot-a1 disconnected via heartbeat (with ~30s lease TTL still left!).
    // Quota must be fenced & released IMMEDIATELY without waiting 30s!
    const hbAck = await master.coordinator.handleWorkerHeartbeat(w1.auth, {
      botSnapshots: [{ botId: 'bot-a1', status: 'disconnected' }]
    });
    assert.ok(hbAck.expiredLeaseIds.includes(asgA.leaseId));

    const afterDisc = await master.coordinator.getTask({ actor: VIEWER, taskId: created.taskId });
    assert.equal(afterDisc.objectives[0].allocationEpoch, 2);
    assert.equal(afterDisc.activeAssignments.some((a) => a.botId === 'bot-a1'), false);

    // BUG-F01: Worker B (unaware of Worker A's disconnect) reports completion using its ORIGINAL issued epoch=1!
    const nowIso = new Date().toISOString();
    const w2Res = await master.coordinator.handleWorkerEventBatch(w2.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-b',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgB.assignmentId,
          leaseId: asgB.leaseId,
          allocationEpoch: 1, // Issued epoch on Worker B!
          taskId: created.taskId,
          objectiveId: asgB.objectiveId,
          workerId: 'worker-b',
          botId: 'bot-b1',
          outcome: 'completed',
          durationMs: 4000,
          beforeSnapshot: { botId: 'bot-b1', capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: {
            botId: 'bot-b1',
            capturedAt: nowIso,
            itemCounts: { 'minecraft:cobblestone': asgB.quotaQuantity }
          },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'inventory_delta',
              itemKey: 'minecraft:cobblestone',
              claimedDelta: asgB.quotaQuantity,
              details: {}
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(w2Res[0].status, 'accepted');
    assert.equal(w2Res[0].creditedDelta, asgB.quotaQuantity);

    // Meanwhile, fenced bot-a1 attempting a late epoch=1 report MUST still be rejected with STALE_ALLOCATION_EPOCH!
    const staleRes = await master.coordinator.handleWorkerEventBatch(w1.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-a',
        workerSequence: 1,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asgA.assignmentId,
          leaseId: asgA.leaseId,
          allocationEpoch: 1,
          taskId: created.taskId,
          objectiveId: asgA.objectiveId,
          workerId: 'worker-a',
          botId: 'bot-a1',
          outcome: 'completed',
          durationMs: 4000,
          beforeSnapshot: { botId: 'bot-a1', capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: 'bot-a1', capturedAt: nowIso, itemCounts: { 'minecraft:cobblestone': 50 } },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'inventory_delta',
              itemKey: 'minecraft:cobblestone',
              claimedDelta: 50,
              details: {}
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(staleRes[0].status, 'rejected');
    assert.equal(staleRes[0].rejectionCode, 'STALE_ALLOCATION_EPOCH');
  } finally {
    await master.stop();
    tmp.cleanup();
  }
});

// ============================================================================
// BUG-F02: Spatial multi-bot exploration waits for all sectors & recovers failed sector only
// ============================================================================
test('BUG-F02: Spatial exploration waits for all sectors, ignores progress/partial completion, and recovers failed sector', async () => {
  const tmp = tempDbPath('f02');
  const master = createMaster(createTestConfig(tmp.dbPath));
  await master.start();

  try {
    const w = await enrollWorkerWithBots(master, 'worker-sp', ['bot-1', 'bot-2', 'bot-3']);
    await master.coordinator.setOperatingMode({ actor: OPERATOR, mode: 'SYNCHRONIZED' });

    const task = master.taskManager.createTask({
      actorId: OPERATOR.principalId,
      actorRole: OPERATOR.role,
      source: 'cli',
      idempotencyKey: 'spatial-3-sector-test',
      rawText: 'Explore 3 sectors around spawn',
      priority: 'normal'
    });
    const defaultConstraints = {
      maxRisk: 'low',
      avoidHazards: ['lava', 'void'],
      allowExistingStock: false,
      maxTravelBlocks: 256
    };
    master.taskManager.attachPlan({
      taskId: task.taskId,
      plan: {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        intentSummary: 'Explore 3 sectors',
        clarificationRequired: false,
        clarificationQuestion: null,
        riskLevel: 'low',
        notes: ['audit_spatial_test'],
        objectives: [
          {
            localId: 'explore_all',
            kind: 'explore',
            target: { resourceId: null, quantity: null, regionLabel: 'spawn_basin', description: 'Explore spawn' },
            dependencies: [],
            parallelism: 'spatial',
            workerCountHint: 3,
            verification: 'region_visited',
            constraints: defaultConstraints
          }
        ]
      }
    });
    await master.coordinator.scheduleReadyObjectives(task.taskId);

    const t1 = master.taskManager.getTask(task.taskId);
    assert.equal(t1.activeAssignments.length, 3);
    const [a1, a2, a3] = t1.activeAssignments;
    const nowIso = new Date().toISOString();
    let seq = 0;

    // 1. Progress report on sector 1 MUST NOT complete the objective
    const progRes = await master.coordinator.handleWorkerEventBatch(w.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-sp',
        workerSequence: ++seq,
        createdAt: nowIso,
        eventType: 'assignment_progress',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: a1.assignmentId,
          leaseId: a1.leaseId,
          allocationEpoch: a1.allocationEpoch,
          taskId: task.taskId,
          objectiveId: a1.objectiveId,
          workerId: 'worker-sp',
          botId: a1.botId,
          outcome: 'partial',
          durationMs: 1000,
          beforeSnapshot: { botId: a1.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: a1.botId, capturedAt: nowIso, itemCounts: {} },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'region_visited',
              claimedDelta: 1,
              details: { coverageRatio: 0.9, visitedCells: 8 }
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);
    assert.equal(progRes[0].status, 'accepted');
    assert.notEqual(master.taskManager.getTask(task.taskId).objectives[0].state, 'completed');

    // 2. Sector 1 completes while Sectors 2 & 3 are still running -> objective MUST stay running/assigned!
    await master.coordinator.handleWorkerEventBatch(w.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-sp',
        workerSequence: ++seq,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: a1.assignmentId,
          leaseId: a1.leaseId,
          allocationEpoch: a1.allocationEpoch,
          taskId: task.taskId,
          objectiveId: a1.objectiveId,
          workerId: 'worker-sp',
          botId: a1.botId,
          outcome: 'completed',
          durationMs: 2500,
          beforeSnapshot: { botId: a1.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: a1.botId, capturedAt: nowIso, itemCounts: {} },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'region_visited',
              claimedDelta: 1,
              details: { coverageRatio: 0.95, visitedCells: 16 }
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);
    assert.notEqual(master.taskManager.getTask(task.taskId).objectives[0].state, 'completed');

    // 3. Sector 2 fails transiently (e.g. PATH_TIMEOUT), Sector 3 completes -> only Sector 2 should be re-allocated!
    await master.coordinator.handleWorkerEventBatch(w.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-sp',
        workerSequence: ++seq,
        createdAt: nowIso,
        eventType: 'assignment_failed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: a2.assignmentId,
          leaseId: a2.leaseId,
          allocationEpoch: a2.allocationEpoch,
          taskId: task.taskId,
          objectiveId: a2.objectiveId,
          workerId: 'worker-sp',
          botId: a2.botId,
          failureCode: 'ACTION_TIMEOUT',
          retryable: true,
          safeState: 'idle_safe',
          summary: 'Temporary terrain lag',
          reportedAt: nowIso
        }
      },
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-sp',
        workerSequence: ++seq,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: a3.assignmentId,
          leaseId: a3.leaseId,
          allocationEpoch: a3.allocationEpoch,
          taskId: task.taskId,
          objectiveId: a3.objectiveId,
          workerId: 'worker-sp',
          botId: a3.botId,
          outcome: 'completed',
          durationMs: 2500,
          beforeSnapshot: { botId: a3.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: a3.botId, capturedAt: nowIso, itemCounts: {} },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'region_visited',
              claimedDelta: 1,
              details: { coverageRatio: 0.95, visitedCells: 16 }
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);

    const afterSector2Retry = master.taskManager.getTask(task.taskId);
    assert.notEqual(afterSector2Retry.objectives[0].state, 'completed');
    assert.equal(afterSector2Retry.activeAssignments.length, 1);
    const recoveryAsg = afterSector2Retry.activeAssignments[0];
    assert.equal(recoveryAsg.partitionId, a2.partitionId);

    // 4. Recovery bot finishes Sector 2 -> NOW all 3 sectors are complete, so task completes!
    await master.coordinator.handleWorkerEventBatch(w.auth, [
      {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-sp',
        workerSequence: ++seq,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: recoveryAsg.assignmentId,
          leaseId: recoveryAsg.leaseId,
          allocationEpoch: recoveryAsg.allocationEpoch,
          taskId: task.taskId,
          objectiveId: recoveryAsg.objectiveId,
          workerId: 'worker-sp',
          botId: recoveryAsg.botId,
          outcome: 'completed',
          durationMs: 2200,
          beforeSnapshot: { botId: recoveryAsg.botId, capturedAt: nowIso, itemCounts: {} },
          afterSnapshot: { botId: recoveryAsg.botId, capturedAt: nowIso, itemCounts: {} },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'region_visited',
              claimedDelta: 1,
              details: { coverageRatio: 0.96, visitedCells: 16 }
            }
          ],
          reportedAt: nowIso
        }
      }
    ]);

    const done = master.taskManager.getTask(task.taskId);
    assert.equal(done.objectives[0].state, 'completed');
    assert.equal(done.state, 'completed');
  } finally {
    await master.stop();
    tmp.cleanup();
  }
});

// ============================================================================
// BUG-F04, BUG-F05 & BUG-F06: pause/resume outbox, replan fencing/completion, BotRegistry non-quota recovery
// ============================================================================
test('BUG-F04, BUG-F05 & BUG-F06: resumeTask enqueues resume commands, attachPlan fences spec mutations, and BotRegistry recovers non-quota objectives', async () => {
  const tmp = tempDbPath('f04-f06');
  const master = createMaster(createTestConfig(tmp.dbPath));
  await master.start();

  try {
    // BUG-F06a: Duplicate botId in configuredBots batch must be rejected
    const dupBoot = master.botRegistry.createBootstrapToken({ createdBy: 'admin' });
    assert.throws(
      () =>
        master.botRegistry.register({
          bootstrapToken: dupBoot.bootstrapToken,
          workerInfo: {
            schemaVersion: 1,
            workerId: 'worker-dup',
            hostname: 'dup.lan',
            maxBotSlots: 4,
            configuredBots: [
              { botId: 'bot-same', username: 'Same1', serverId: 's1' },
              { botId: 'bot-same', username: 'Same2', serverId: 's1' }
            ]
          }
        }),
      (err) => err.code === 'SCHEMA_VALIDATION_FAILED'
    );

    const w1 = await enrollWorkerWithBots(master, 'worker-r1', ['bot-r1']);
    await enrollWorkerWithBots(master, 'worker-r2', ['bot-r2']);

    // BUG-F04: pauseTask + resumeTask must enqueue both `pause` and `resume` outbox commands and return `running`
    const created = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'cli',
      text: 'Collect 20 oak_log.'
    });
    const createdDetail = await master.coordinator.getTask({ actor: VIEWER, taskId: created.taskId });
    const assignedWorker = createdDetail.activeAssignments[0].workerId;
    const initialLocalId = createdDetail.objectives[0].localId;
    // Drain initial `assign` command
    const initialCmds = master.taskManager.pollWorkerCommands(assignedWorker, 10);
    for (const c of initialCmds) master.taskManager.ackWorkerCommand(assignedWorker, c.commandId);

    const paused = await master.coordinator.pauseTask({ actor: OPERATOR, taskId: created.taskId, reason: 'check' });
    assert.equal(paused.state, 'paused');
    const pauseCmds = master.taskManager.pollWorkerCommands(assignedWorker, 10);
    assert.equal(pauseCmds.some((c) => c.commandType === 'pause'), true);
    for (const c of pauseCmds) master.taskManager.ackWorkerCommand(assignedWorker, c.commandId);

    const resumed = await master.coordinator.resumeTask({ actor: OPERATOR, taskId: created.taskId });
    assert.equal(resumed.state, 'running');
    const resumeCmds = master.taskManager.pollWorkerCommands(assignedWorker, 10);
    assert.equal(resumeCmds.some((c) => c.commandType === 'resume'), true);
    for (const c of resumeCmds) master.taskManager.ackWorkerCommand(assignedWorker, c.commandId);

    const defaultConstraints = {
      maxRisk: 'low',
      avoidHazards: ['lava', 'void'],
      allowExistingStock: false,
      maxTravelBlocks: 256
    };
    // BUG-F05: Mutating objective resourceId on replan revokes active assignment & enqueues `cancel`
    master.taskManager.attachPlan({
      taskId: created.taskId,
      plan: {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        intentSummary: 'Collect 20 birch_log instead',
        clarificationRequired: false,
        clarificationQuestion: null,
        riskLevel: 'low',
        notes: ['audit_replan_test'],
        objectives: [
          {
            localId: initialLocalId,
            kind: 'collect',
            target: { resourceId: 'minecraft:birch_log', quantity: 20, regionLabel: null, description: 'birch' },
            dependencies: [],
            parallelism: 'partitionable',
            workerCountHint: 1,
            verification: 'newly_collected',
            constraints: defaultConstraints
          }
        ]
      }
    });
    const replanCancelCmds = master.taskManager.pollWorkerCommands(assignedWorker, 10);
    assert.equal(replanCancelCmds.some((c) => c.commandType === 'cancel'), true);
    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: created.taskId, reason: 'done_test' });

    // BUG-F06b: Non-quantified (`build`, target_quantity: null) objective held by revoked worker returns to `ready`
    const buildTask = master.taskManager.createTask({
      actorId: OPERATOR.principalId,
      actorRole: OPERATOR.role,
      source: 'cli',
      idempotencyKey: 'non-quota-revoke-test',
      rawText: 'Build shelter',
      priority: 'normal'
    });
    master.taskManager.attachPlan({
      taskId: buildTask.taskId,
      plan: {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        intentSummary: 'Build shelter',
        clarificationRequired: false,
        clarificationQuestion: null,
        riskLevel: 'low',
        notes: ['audit_build_test'],
        objectives: [
          {
            localId: 'build_shelter',
            kind: 'build',
            target: { resourceId: null, quantity: null, regionLabel: 'camp', description: 'Build shelter' },
            dependencies: [],
            parallelism: 'single',
            workerCountHint: 1,
            verification: 'block_state',
            constraints: defaultConstraints
          }
        ]
      }
    });
    await master.coordinator.scheduleReadyObjectives(buildTask.taskId);
    const assignedBuild = master.taskManager.getTask(buildTask.taskId);
    assert.equal(assignedBuild.objectives[0].state, 'assigned');
    const holderWorkerId = assignedBuild.activeAssignments[0].workerId;

    master.botRegistry.revoke(holderWorkerId, 'compromised_host');
    const afterRevoke = master.taskManager.getTask(buildTask.taskId);
    assert.equal(afterRevoke.objectives[0].state, 'ready');

    // Remaining healthy worker picks up the recovered non-quota objective immediately!
    await master.coordinator.scheduleReadyObjectives(buildTask.taskId);
    const reallocated = master.taskManager.getTask(buildTask.taskId);
    assert.equal(reallocated.activeAssignments.length, 1);
    assert.notEqual(reallocated.activeAssignments[0].workerId, holderWorkerId);
    void w1;
  } finally {
    await master.stop();
    tmp.cleanup();
  }
});

// ============================================================================
// BUG-F07, BUG-F08, BUG-F09 & BUG-F14 (HTTP/Auth/SSE/Routes): Multi-tab CSRF, 413, reconcile & revoke
// ============================================================================
test('BUG-F07, BUG-F08, BUG-F09 & BUG-F14: Multi-tab session recovers CSRF token, oversize body returns 413, and reconcile/revoke routes work', async () => {
  const tmp = tempDbPath('f07-http');
  const master = createMaster(createTestConfig(tmp.dbPath));
  await master.start({ listenHttp: true });
  const port = master.httpServer.port;

  try {
    // 1. Setup initial admin on Tab 1
    const setupRes = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/auth/setup',
      body: { username: 'nexus_admin', password: 'StrongPassword#2026!' }
    });
    assert.equal(setupRes.status, 201);
    const cookie = setupRes.headers['set-cookie'][0].split(';')[0];

    // 2. BUG-F07: Simulate Tab 2 opening with ONLY the HttpOnly cookie (empty sessionStorage)
    const tab2Sess = await httpJson({
      port,
      method: 'GET',
      path: '/api/v1/auth/session',
      headers: { Cookie: cookie }
    });
    assert.equal(tab2Sess.status, 200);
    assert.equal(tab2Sess.json.authenticated, true);
    assert.equal(tab2Sess.json.csrfToken, setupRes.json.csrfToken);

    // Tab 2 mutating POST succeeds using the recovered csrfToken!
    const modePost = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/swarm/mode',
      headers: { Cookie: cookie, 'X-CSRF-Token': tab2Sess.json.csrfToken },
      body: { mode: 'DISTRIBUTED' }
    });
    assert.equal(modePost.status, 200);
    assert.equal(modePost.json.operatingMode, 'DISTRIBUTED');

    // Missing CSRF header STILL returns 403 FORBIDDEN!
    const missingCsrf = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/swarm/mode',
      headers: { Cookie: cookie },
      body: { mode: 'HYBRID' }
    });
    assert.equal(missingCsrf.status, 403);

    // 3. BUG-F14: Oversized JSON body (> 4096B on /api/v1/swarm/mode) returns 413 PAYLOAD_TOO_LARGE
    const hugeBody = JSON.stringify({ mode: 'HYBRID', pad: 'x'.repeat(8192) });
    const tooLarge = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/swarm/mode',
      headers: { Cookie: cookie, 'X-CSRF-Token': tab2Sess.json.csrfToken },
      body: hugeBody
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.json.error.code, 'PAYLOAD_TOO_LARGE');

    // 4. BUG-F14: Worker `/worker/v1/reconcile` and Admin `/api/v1/workers/:id/revoke` HTTP routes
    const bootRes = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/workers/bootstrap-token',
      headers: { Cookie: cookie, 'X-CSRF-Token': tab2Sess.json.csrfToken },
      body: { ttlMs: 60000 }
    });
    assert.equal(bootRes.status, 201);

    const regRes = await httpJson({
      port,
      method: 'POST',
      path: '/worker/v1/register',
      body: {
        bootstrapToken: bootRes.json.bootstrapToken,
        workerInfo: {
          schemaVersion: 1,
          workerId: 'worker-http-rec',
          hostname: 'rec.lan',
          maxBotSlots: 2,
          configuredBots: [{ botId: 'bot-rec-1', username: 'BotRec1', serverId: 's1' }]
        }
      }
    });
    assert.equal(regRes.status, 201);

    const recRes = await httpJson({
      port,
      method: 'POST',
      path: '/worker/v1/reconcile',
      headers: {
        'X-Worker-Id': 'worker-http-rec',
        Authorization: `Bearer ${regRes.json.workerToken}`
      },
      body: { activeLeases: [] }
    });
    assert.equal(recRes.status, 200);
    assert.equal(recRes.json.workerId, 'worker-http-rec');

    const revRes = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/workers/worker-http-rec/revoke',
      headers: { Cookie: cookie, 'X-CSRF-Token': tab2Sess.json.csrfToken },
      body: { reason: 'audit_test_revoke' }
    });
    assert.equal(revRes.status, 200);
    assert.equal(revRes.json.status, 'disabled');

    // 5. BUG-F08 & BUG-F09: Verify app.js listens to `summary` & `reload_required` and SseCoalescer.dispose() works
    const appJsRes = await httpJson({ port, method: 'GET', path: '/app.js' });
    assert.equal(appJsRes.status, 200);
    assert.match(appJsRes.text, /addEventListener\('summary'/);
    assert.match(appJsRes.text, /addEventListener\('reload_required'/);

    const coalescer = new SseCoalescer({ flushIntervalMs: 500 });
    coalescer.dispose();

    // 6. Expired/stale cookie logout clears cookie gracefully with 200 OK instead of 401 lockout
    const staleLogout = await httpJson({
      port,
      method: 'POST',
      path: '/api/v1/auth/logout',
      headers: { Cookie: 'nexus_session=expired_unknown_token' },
      body: {}
    });
    assert.equal(staleLogout.status, 200);
    assert.match(String(staleLogout.headers['set-cookie'][0]), /Max-Age=0/);
  } finally {
    await master.stop();
    tmp.cleanup();
  }
});

// ============================================================================
// BUG-F10, BUG-F11, BUG-F12, BUG-F13 & BUG-F14 (Performance & Guard Modules)
// ============================================================================
test('BUG-F10..F14: createLogger ringSize, 0-durability tool guard, PathfindingGuard sequential stuck retries, cross-sector BlockSearchCache & ChatHistoryGuard prefix boundary', async () => {
  // BUG-F10: createLogger forwards ringSize & dedupWindowMs to BoundedLogger
  const logger = createLogger({ level: 'info', ringSize: 7, dedupWindowMs: 4000 });
  assert.equal(logger.stats().ringCapacity, 7);

  // BUG-F11: 0-durability broken pickaxe must NOT be classified as a usable tool
  const snapBroken = toCompactBotSnapshot({
    botId: 'bot-broken',
    status: 'ready',
    health: 20,
    food: 20,
    heldItem: { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 250 },
    inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 250 }]
  });
  assert.equal(snapBroken.bestToolsByClass.pickaxe, undefined);
  assert.equal(snapBroken.activeTool, null);

  // BUG-F12: PathfindingGuard enforces maxStuckRetries across sequential awaited forceReplan calls
  const pf = new PathfindingGuard({ maxStuckRetries: 3, maxComputeMs: 200 });
  for (let i = 0; i < 3; i += 1) {
    const res = await pf.computePath({
      botId: 'bot-pf',
      from: { x: 0, y: 64, z: 0 },
      to: { x: 20, y: 64, z: 0 },
      forceReplan: true,
      computeFn: async () => ({ status: 'NO_PATH', nodes: [] })
    });
    assert.equal(res.status, 'NO_PATH');
  }
  const fourth = await pf.computePath({
    botId: 'bot-pf',
    from: { x: 0, y: 64, z: 0 },
    to: { x: 20, y: 64, z: 0 },
    forceReplan: true,
    computeFn: async () => ({ status: 'success', nodes: [{ x: 20, y: 64, z: 0 }] })
  });
  assert.equal(fourth.status, 'NO_PATH');
  assert.equal(fourth.reason, 'MAX_STUCK_RETRIES_EXCEEDED');

  // BUG-F13: BlockSearchCache.onBlockUpdate invalidates across 16-block sector boundaries
  let orePresent = true;
  const bsc = new BlockSearchCache({ defaultMaxRadius: 32 });
  const firstScan = bsc.findBlocks({
    dimension: 'minecraft:overworld',
    origin: { x: 2, y: 64, z: 2 }, // sector (0, 4, 0)
    targetId: 'diamond_ore',
    maxRadius: 24,
    matchesAt: (x, y, z) => orePresent && x === 20 && y === 64 && z === 2 // sector (1, 4, 0)!
  });
  assert.equal(firstScan.positions.length, 1);

  orePresent = false;
  const evicted = bsc.onBlockUpdate(
    'minecraft:overworld',
    { x: 20, y: 64, z: 2 },
    'diamond_ore',
    'air'
  );
  assert.ok(evicted >= 1);

  const secondScan = bsc.findBlocks({
    dimension: 'minecraft:overworld',
    origin: { x: 2, y: 64, z: 2 },
    targetId: 'diamond_ore',
    maxRadius: 24,
    matchesAt: (x, y, z) => orePresent && x === 20 && y === 64 && z === 2
  });
  assert.equal(secondScan.positions.length, 0);
  assert.equal(secondScan.fromCache, false);

  // BUG-F14: ChatHistoryGuard rejects `!swarmstatus` (missing whitespace after prefix)
  const chatGuard = new ChatHistoryGuard({
    prefix: '!swarm',
    allowedPlayerUuids: ['uuid-admin-1']
  });
  const spoofed = chatGuard.inspectChat({
    senderUuid: 'uuid-admin-1',
    text: '!swarmstatus'
  });
  assert.equal(spoofed.accepted, false);
  assert.equal(spoofed.reason, 'NOT_PREFIXED');

  const validCmd = chatGuard.inspectChat({
    senderUuid: 'uuid-admin-1',
    text: '!swarm status'
  });
  assert.equal(validCmd.accepted, true);
  assert.equal(validCmd.intent.verb, 'status');
  void ADMIN;
});
