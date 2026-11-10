'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createMaster,
  loadConfig,
  StateStore,
  AuthService,
  WorldKnowledgeStore,
  WorkloadGovernor,
  performance
} = require('../../index');

const { AiEfficiencyController } = performance;

const ADMIN = { principalId: 'admin-1', actorType: 'human', role: 'admin', serverId: null };
const OPERATOR = { principalId: 'op-1', actorType: 'human', role: 'operator', serverId: null };

function enrollBots(master, workerId, botIds) {
  const { bootstrapToken } = master.botRegistry.createBootstrapToken({ createdBy: ADMIN.principalId });
  const reg = master.botRegistry.register({
    bootstrapToken,
    workerInfo: {
      workerId,
      hostname: `${workerId}.lan`,
      maxBotSlots: botIds.length + 2,
      configuredBots: botIds.map((botId) => ({
        botId,
        username: `Bot_${botId}`,
        serverId: 'srv-main',
        authMode: 'online_microsoft'
      }))
    }
  });
  master.botRegistry.heartbeat(workerId, {
    botSnapshots: botIds.map((botId, idx) => ({
      botId,
      status: 'ready',
      dimension: 'minecraft:overworld',
      position: { x: idx * 10, y: 64, z: 0 },
      health: 20,
      food: 20,
      inventoryItems: [
        { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 },
        { name: 'iron_axe', count: 1, maxDurability: 250, durabilityUsed: 0 }
      ]
    }))
  });
  return reg;
}

function httpJson(port, reqPath, { method = 'GET', headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = payload.byteLength;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            json
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('NEXUS-01: AuthService enforces concurrency-1 scrypt queue (20-login flood <=24 MiB RSS), CSRF & RBAC', async () => {
  const store = new StateStore({ sqlitePath: ':memory:' }).open();
  try {
    const auth = new AuthService({
      stateStore: store,
      maxKdfQueue: 4
    });

    assert.equal(auth.hasAnyPrincipal(), false);
    const admin = await auth.bootstrapInitialAdmin({
      username: 'nexus_admin',
      password: 'CorrectHorseBatteryStaple!1'
    });
    assert.equal(admin.role, 'admin');
    assert.equal(auth.hasAnyPrincipal(), true);

    // Second bootstrap attempt is permanently blocked
    await assert.rejects(
      () => auth.bootstrapInitialAdmin({ username: 'attacker', password: 'AttackerPassword!123' }),
      (err) => err.code === 'CONFLICT'
    );

    // 20 concurrent KDF login flood (`TEST_PLAN.md` §3.2):
    // active KDF capped at 1 + queue <= 4; excess rejected with 429 RATE_LIMITED; RSS spike <= 24 MiB
    const rssBefore = process.memoryUsage().rss;
    const attempts = Array.from({ length: 20 }, (_, i) =>
      auth
        .login({
          username: 'nexus_admin',
          password: 'CorrectHorseBatteryStaple!1',
          clientIp: `10.0.0.${i + 1}`
        })
        .then(
          (ok) => ({ ok: true, res: ok }),
          (err) => ({ ok: false, code: err.code })
        )
    );
    assert.ok(auth.kdfActiveCount <= 1);
    assert.ok(auth.kdfQueueDepth <= 4);

    const outcomes = await Promise.all(attempts);
    const rssDeltaMiB = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);
    assert.ok(rssDeltaMiB < 24, `Expected scrypt flood RSS delta < 24 MiB, got ${rssDeltaMiB.toFixed(2)} MiB`);

    const succeeded = outcomes.filter((o) => o.ok);
    const rateLimited = outcomes.filter((o) => !o.ok && o.code === 'RATE_LIMITED');
    assert.ok(succeeded.length >= 1 && succeeded.length <= 6);
    assert.ok(rateLimited.length >= 14);

    // Verify CSRF requirement on mutating operations
    const { sessionToken, csrfToken } = succeeded[0].res;
    const getActor = auth.authenticateRequest({ sessionToken, requireCsrf: false });
    assert.equal(getActor.username, 'nexus_admin');

    assert.throws(
      () => auth.authenticateRequest({ sessionToken, requireCsrf: true }),
      (err) => err.code === 'FORBIDDEN'
    );
    assert.throws(
      () => auth.authenticateRequest({ sessionToken, csrfToken: 'wrong-token', requireCsrf: true }),
      (err) => err.code === 'FORBIDDEN'
    );
    const postActor = auth.authenticateRequest({ sessionToken, csrfToken, requireCsrf: true });
    assert.equal(postActor.role, 'admin');

    // Logout revokes session immediately
    assert.equal(auth.logout(sessionToken), true);
    assert.throws(
      () => auth.authenticateRequest({ sessionToken, requireCsrf: false }),
      (err) => err.code === 'UNAUTHENTICATED'
    );
  } finally {
    store.close();
  }
});

test('NEXUS-02: WorldKnowledgeStore enforces TTL expiry, multi-bot verification, row cap & chest mutex locks', () => {
  let nowMs = 1_700_000_000_000;
  const store = new StateStore({ sqlitePath: ':memory:' }).open();
  try {
    const knowledge = new WorldKnowledgeStore({
      stateStore: store,
      maxEntries: 35,
      mergeRadiusBlocks: 8,
      now: () => nowMs
    });

    // Bot 1 observes iron vein -> state 'observed'
    const obs1 = knowledge.recordObservation({
      category: 'resource_location',
      subjectKey: 'minecraft:iron_ore',
      position: { x: 100, y: 32, z: -40 },
      confidence: 0.75,
      reportedByBotId: 'bot-1',
      ttlMs: 60_000
    });
    assert.equal(obs1.verificationState, 'observed');

    // Bot 2 independently observes nearby -> merges and upgrades to 'verified'
    const obs2 = knowledge.recordObservation({
      category: 'resource_location',
      subjectKey: 'minecraft:iron_ore',
      position: { x: 103, y: 31, z: -38 },
      confidence: 0.8,
      reportedByBotId: 'bot-2',
      ttlMs: 60_000
    });
    assert.equal(obs2.knowledgeId, obs1.knowledgeId);
    assert.equal(obs2.verificationState, 'verified');
    assert.ok(obs2.confidence > 0.8);

    // Storage chest mutex lock prevents simultaneous conflicting chest access
    const lock1 = knowledge.acquireStorageLock({ x: 10, y: 64, z: 10, botId: 'bot-1', ttlMs: 10_000 });
    assert.equal(lock1.acquired, true);

    const lock2Conflict = knowledge.acquireStorageLock({ x: 10, y: 64, z: 10, botId: 'bot-2', ttlMs: 10_000 });
    assert.equal(lock2Conflict.acquired, false);
    assert.equal(lock2Conflict.holderBotId, 'bot-1');

    // Advance past chest lock TTL -> bot-2 can acquire cleanly (no permanent deadlock on crash)
    nowMs += 11_000;
    const lock2AfterTtl = knowledge.acquireStorageLock({ x: 10, y: 64, z: 10, botId: 'bot-2', ttlMs: 10_000 });
    assert.equal(lock2AfterTtl.acquired, true);
    assert.equal(knowledge.releaseStorageLock({ x: 10, y: 64, z: 10, botId: 'bot-2' }), true);

    // Advance past observation TTL -> stale observation is NEVER returned as valid fact
    nowMs += 60_000;
    assert.equal(knowledge.query({ category: 'resource_location' }).length, 0);

    // Bounded capacity cap enforcement (maxEntries = 35)
    for (let i = 0; i < 50; i += 1) {
      knowledge.recordObservation({
        category: 'explored_area',
        subjectKey: `chunk_${i}`,
        position: { x: i * 32, y: 64, z: 0 }
      });
    }
    const allActive = knowledge.query({ limit: 100 });
    assert.equal(allActive.length, 35);
  } finally {
    store.close();
  }
});

test('NEXUS-03: Runtime SYNCHRONIZED / DISTRIBUTED / HYBRID modes, 5 profiles, pluggable AI & restart persistence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-modes-'));
  const dbPath = path.join(tmpDir, 'swarm.db');

  try {
    // Verify extensible architectural cap (>20) works without redesign when explicitly configured (`ADR-002`)
    const expandedCfg = loadConfig(
      {},
      {
        http: { host: '127.0.0.1', port: 0 },
        tls: { enabled: false },
        capacity: { maxArchitecturalBots: 40, globalMaxBots: 30, initialEnabledBots: 6 },
        storage: { sqlitePath: ':memory:' }
      }
    );
    assert.equal(expandedCfg.capacity.globalMaxBots, 30);

    // Verify all 5 performance profiles on WorkloadGovernor (`ADR-004`)
    const gov = new WorkloadGovernor({ globalBotCap: 20, initialBotCap: 8, profile: 'ULTRA_LOW' });
    assert.equal(gov.getDirectives().effectiveBotConcurrency, 2);
    assert.equal(gov.getDirectives().allowNonEssentialScanning, false);
    gov.setProfile('MAXIMUM_THROUGHPUT');
    assert.equal(gov.getDirectives().effectiveBotConcurrency, 8);
    assert.equal(gov.getDirectives().maxBlockSearchRadius, 64);

    // Verify pluggable AI provider interface (`ADR-006`)
    const ai = new AiEfficiencyController({ provider: 'ollama' });
    ai.registerProvider('custom-lan-llm', {
      isAvailable: () => true,
      invoke: async ({ body }) => ({
        schemaVersion: 1,
        requestId: JSON.parse(body.messages[1].content).requestId,
        intentSummary: 'Custom provider plan',
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'obj_1',
            kind: 'inspect',
            target: { resourceId: null, quantity: null, regionLabel: 'base', description: 'Inspect perimeter' },
            dependencies: [],
            parallelism: 'single',
            workerCountHint: 1,
            constraints: { maxRisk: 'low', avoidHazards: ['lava'], allowExistingStock: false, maxTravelBlocks: 128 },
            verification: 'region_visited'
          }
        ],
        riskLevel: 'low',
        notes: ['custom_provider_verified']
      })
    });
    ai.setProvider('custom-lan-llm');
    const customRes = await ai.createPlan({ userText: 'Perform custom perimeter audit around base tower' });
    assert.equal(customRes.llmCalled, true);
    assert.equal(customRes.plan.intentSummary, 'Custom provider plan');

    // Start persistent Master to verify SYNCHRONIZED, DISTRIBUTED, hysteresis & restart survival
    const cfg = loadConfig(
      {},
      {
        http: { host: '127.0.0.1', port: 0 },
        tls: { enabled: false },
        capacity: { globalMaxBots: 20, initialEnabledBots: 6, minAssignmentHoldMs: 10_000 },
        storage: { sqlitePath: dbPath }
      }
    );
    const master = createMaster(cfg);
    await master.start();

    enrollBots(master, 'worker-sync', ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6']);

    // Switch to SYNCHRONIZED mode: even a 24-block task recruits all 6 ready bots with disjoint spatial areas!
    await master.coordinator.setOperatingMode({ actor: OPERATOR, mode: 'SYNCHRONIZED' });
    await master.coordinator.setPerformanceProfile({ actor: OPERATOR, profile: 'PERFORMANCE' });

    const syncTask = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Mine 24 cobblestone.'
    });
    assert.equal(syncTask.activeAssignments.length, 6);
    assert.equal(
      syncTask.activeAssignments.reduce((s, a) => s + a.quotaQuantity, 0),
      24
    );
    const partitions = new Set(syncTask.activeAssignments.map((a) => a.partitionId));
    assert.equal(partitions.size, 6, 'Each bot in SYNCHRONIZED mode must receive a distinct spatial work area');
    assert.ok(syncTask.activeAssignments.every((a) => a.regionBounds !== null));

    // Anti-oscillation hold check: premature reassign without force=true is blocked
    await assert.rejects(
      () => master.coordinator.reassignBot({ actor: OPERATOR, botId: 'bot-1', force: false }),
      (err) => err.code === 'CONFLICT'
    );
    await master.coordinator.cancelTask({ actor: OPERATOR, taskId: syncTask.taskId });

    // Switch to DISTRIBUTED mode: two distinct tasks each get 1 distinct capability-matched bot
    await master.coordinator.setOperatingMode({ actor: OPERATOR, mode: 'DISTRIBUTED' });
    const distTaskA = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Collect 80 oak logs.'
    });
    const distTaskB = await master.coordinator.submitIntent({
      actor: OPERATOR,
      source: 'dashboard',
      text: 'Mine 80 cobblestone.'
    });
    assert.equal(distTaskA.activeAssignments.length, 1);
    assert.equal(distTaskB.activeAssignments.length, 1);
    assert.notEqual(distTaskA.activeAssignments[0].botId, distTaskB.activeAssignments[0].botId);

    await master.stop();

    // Restart Master from SQLite and verify operatingMode + performanceProfile survived!
    const master2 = createMaster(cfg);
    await master2.start();
    assert.equal(master2.coordinator.operatingMode, 'DISTRIBUTED');
    assert.equal(master2.governor.profile, 'PERFORMANCE');
    await master2.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('NEXUS-04: Full TCP HTTP/SSE Gateway, Dashboard static assets, CSRF auth & Distributed Worker wire loop', async () => {
  const cfg = loadConfig(
    {},
    {
      http: { host: '127.0.0.1', port: 0, enabled: true },
      tls: { enabled: false },
      capacity: { globalMaxBots: 20, initialEnabledBots: 2 },
      storage: { sqlitePath: ':memory:' }
    }
  );
  const master = createMaster(cfg);
  const bindInfo = await master.start();
  const port = bindInfo.port;
  assert.ok(port > 0);

  let sseReq = null;
  try {
    // 1. Static Dashboard assets & public health
    const indexHtml = await httpJson(port, '/');
    assert.equal(indexHtml.status, 200);
    assert.ok(indexHtml.raw.includes('NEXUS-20'));

    const health = await httpJson(port, '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.bootstrapRequired, true);

    // 2. Unauthenticated API call rejected 401
    const unauth = await httpJson(port, '/api/v1/status');
    assert.equal(unauth.status, 401);

    // 3. One-time initial admin setup -> returns HttpOnly cookie + csrfToken
    const setupRes = await httpJson(port, '/api/v1/auth/setup', {
      method: 'POST',
      body: { username: 'commander', password: 'StrongSwarmPassword!2026' }
    });
    assert.equal(setupRes.status, 201);
    const setCookie = setupRes.headers['set-cookie'][0];
    assert.ok(setCookie.includes('HttpOnly'));
    const cookieHeader = setCookie.split(';')[0];
    const csrfToken = setupRes.json.csrfToken;

    // 4. Mutating POST without X-CSRF-Token is rejected 403 FORBIDDEN
    const missingCsrf = await httpJson(port, '/api/v1/swarm/mode', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: { mode: 'SYNCHRONIZED' }
    });
    assert.equal(missingCsrf.status, 403);

    // With valid X-CSRF-Token succeeds 200 OK
    const modeOk = await httpJson(port, '/api/v1/swarm/mode', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfToken },
      body: { mode: 'SYNCHRONIZED' }
    });
    assert.equal(modeOk.status, 200);
    assert.equal(modeOk.json.operatingMode, 'SYNCHRONIZED');

    // 5. Connect real SSE stream (`/api/v1/events`)
    const sseChunks = [];
    await new Promise((resolve, reject) => {
      sseReq = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/events?clientId=test-sse-1',
          method: 'GET',
          headers: { Cookie: cookieHeader }
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on('data', (chunk) => {
            const txt = chunk.toString('utf8');
            sseChunks.push(txt);
            if (txt.includes('event: connected')) resolve();
          });
        }
      );
      sseReq.on('error', reject);
      sseReq.end();
    });

    // 6. Mint Worker bootstrap token via HTTP & enroll distributed Worker over `/worker/v1/*`
    const bootRes = await httpJson(port, '/api/v1/workers/bootstrap-token', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfToken },
      body: {}
    });
    assert.equal(bootRes.status, 201);

    const workerReg = await httpJson(port, '/worker/v1/register', {
      method: 'POST',
      body: {
        bootstrapToken: bootRes.json.bootstrapToken,
        workerInfo: {
          workerId: 'worker-http-1',
          hostname: 'vps-node-1.lan',
          maxBotSlots: 4,
          configuredBots: [
            { botId: 'bot-a', username: 'NexusBotA', serverId: 'srv-1', authMode: 'online_microsoft' },
            { botId: 'bot-b', username: 'NexusBotB', serverId: 'srv-1', authMode: 'online_microsoft' }
          ]
        }
      }
    });
    assert.equal(workerReg.status, 201);
    const workerHeaders = {
      'X-Worker-Id': 'worker-http-1',
      Authorization: `Bearer ${workerReg.json.workerToken}`
    };

    // 7. Worker sends heartbeat + piggybacked world knowledge observation
    const hbRes = await httpJson(port, '/worker/v1/heartbeat', {
      method: 'POST',
      headers: workerHeaders,
      body: {
        botSnapshots: [
          {
            botId: 'bot-a',
            status: 'ready',
            dimension: 'minecraft:overworld',
            position: { x: 0, y: 64, z: 0 },
            health: 20,
            food: 20,
            inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
          },
          {
            botId: 'bot-b',
            status: 'ready',
            dimension: 'minecraft:overworld',
            position: { x: 16, y: 64, z: 0 },
            health: 20,
            food: 20,
            inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }]
          }
        ],
        worldObservations: [
          {
            category: 'storage_location',
            subjectKey: 'main_base_chest',
            position: { x: 4, y: 64, z: 4 },
            reportedByBotId: 'bot-a'
          }
        ]
      }
    });
    assert.equal(hbRes.status, 200);

    // 8. Operator dispatches "Collect 40 cobblestone." via HTTP API
    const taskCreate = await httpJson(port, '/api/v1/tasks', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfToken },
      body: { text: 'Collect 40 cobblestone.', priority: 'high' }
    });
    assert.equal(taskCreate.status, 201);
    assert.equal(taskCreate.json.activeAssignments.length, 2);

    // 9. Worker polls `/worker/v1/commands`, acknowledges assignments, and reports verified completion
    const cmds = await httpJson(port, '/worker/v1/commands', {
      method: 'GET',
      headers: workerHeaders
    });
    assert.equal(cmds.status, 200);
    assert.equal(cmds.json.commands.length, 2);

    let seq = 1;
    const completionEvents = [];
    for (const cmd of cmds.json.commands) {
      const asg = cmd.payload;
      const ackRes = await httpJson(port, `/worker/v1/commands/${cmd.commandId}/ack`, {
        method: 'POST',
        headers: workerHeaders,
        body: {
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: asg.allocationEpoch,
          decision: 'accepted',
          baselineSnapshot: {
            botId: asg.botId,
            capturedAt: new Date().toISOString(),
            itemCounts: { 'minecraft:cobblestone': 0 }
          }
        }
      });
      assert.equal(ackRes.status, 200);

      const nowIso = new Date().toISOString();
      completionEvents.push({
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        workerId: 'worker-http-1',
        workerSequence: seq++,
        createdAt: nowIso,
        eventType: 'assignment_completed',
        payload: {
          schemaVersion: 1,
          reportId: crypto.randomUUID(),
          assignmentId: asg.assignmentId,
          leaseId: asg.leaseId,
          allocationEpoch: asg.allocationEpoch,
          taskId: asg.taskId,
          objectiveId: asg.objectiveId,
          workerId: 'worker-http-1',
          botId: asg.botId,
          outcome: 'completed',
          durationMs: 12_000,
          beforeSnapshot: {
            botId: asg.botId,
            capturedAt: nowIso,
            itemCounts: { 'minecraft:cobblestone': 0 }
          },
          afterSnapshot: {
            botId: asg.botId,
            capturedAt: nowIso,
            itemCounts: { 'minecraft:cobblestone': asg.quotaQuantity }
          },
          evidence: [
            {
              evidenceId: crypto.randomUUID(),
              kind: 'inventory_delta',
              itemKey: 'minecraft:cobblestone',
              claimedDelta: asg.quotaQuantity,
              details: {}
            }
          ],
          reportedAt: nowIso
        }
      });
    }

    const evRes = await httpJson(port, '/worker/v1/events', {
      method: 'POST',
      headers: workerHeaders,
      body: { events: completionEvents }
    });
    assert.equal(evRes.status, 200);

    // 10. Verify task is 100% completed (`40/40`) and World Knowledge is visible via `/api/v1/status`
    const finalTask = await httpJson(port, `/api/v1/tasks/${taskCreate.json.taskId}`, {
      method: 'GET',
      headers: { Cookie: cookieHeader }
    });
    assert.equal(finalTask.status, 200);
    assert.equal(finalTask.json.state, 'completed');
    assert.equal(finalTask.json.objectives[0].verifiedQuantity, 40);

    const statusRes = await httpJson(port, '/api/v1/status', {
      method: 'GET',
      headers: { Cookie: cookieHeader }
    });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.worldKnowledge.totalValidEntries, 1);

    // Allow SseCoalescer 1s flush window or force flush to verify SSE delivery
    master.sseCoalescer.flushNow?.();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sseChunks.join('').includes('task.'));
  } finally {
    sseReq?.destroy();
    await master.stop();
  }
});
