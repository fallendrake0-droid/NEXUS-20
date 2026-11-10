'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  StateStore,
  BotRegistry,
  InventoryLedger,
  loadConfig,
  DomainError
} = require('../../index');

test('StateStore executes nested SAVEPOINT transactions, enforces SQLite CHECK invariants, backs up and prunes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
  const dbPath = path.join(tmpDir, 'swarm.db');
  const backupPath = path.join(tmpDir, 'backups', 'swarm-backup.db');

  const store = new StateStore({ sqlitePath: dbPath }).open();
  try {
    assert.equal(store.health().status, 'healthy');

    // Nested transaction rollback leaves outer transaction intact
    store.transaction(() => {
      store.recordAudit({ actorType: 'admin', actorId: 'a1', action: 'outer.keep', outcome: 'ok' });
      assert.throws(() => {
        store.transaction(() => {
          store.recordAudit({ actorType: 'admin', actorId: 'a1', action: 'inner.discard', outcome: 'ok' });
          throw new DomainError('CONFLICT', 'abort inner savepoint');
        });
      });
    });

    const audits = store.all('SELECT action FROM audit_events');
    assert.deepEqual(audits.map((a) => a.action), ['outer.keep']);

    // SQLite CHECK constraint blocks verified + reserved > target at database level!
    store.run(
      `INSERT INTO tasks (task_id, actor_id, source_interface, raw_text, state, created_at, updated_at)
       VALUES ('t1', 'op', 'cli', 'mine 10 cobble', 'running', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`
    );
    assert.throws(() => {
      store.run(
        `INSERT INTO objectives (
          objective_id, task_id, local_id, kind, resource_id, target_quantity,
          verified_quantity, reserved_quantity, description, parallelism, worker_count_hint,
          verification_policy, constraints_json, allocation_epoch, state
        ) VALUES ('o1', 't1', 'loc1', 'mine', 'minecraft:cobblestone', 10, 6, 5, 'desc', 'partitionable', 2, 'newly_collected', '{}', 1, 'running')`
      );
    });

    // Online atomic backup & integrity verification
    const bk = await store.backup(backupPath);
    assert.equal(bk.verified, true);
    assert.equal(store.verifyBackup(backupPath).valid, true);

    // Maintenance pruning
    const maint = store.pruneMaintenance();
    assert.equal(typeof maint.prunedInboundMessages, 'number');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BotRegistry enforces single-use bootstrap tokens, <=20 global cap, auth profile, liveness and revocation', () => {
  let clock = Date.parse('2026-11-10T10:00:00.000Z');
  const store = new StateStore({ sqlitePath: ':memory:' }).open();
  const config = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_ENV_PROFILE: 'authorised_online'
  });

  const registry = new BotRegistry({ stateStore: store, config, now: () => clock });

  try {
    const { bootstrapToken } = registry.createBootstrapToken({ createdBy: 'admin-1', ttlMs: 60_000 });

    // Offline bot rejected when envProfile === 'authorised_online'
    assert.throws(
      () =>
        registry.register({
          bootstrapToken,
          workerInfo: {
            workerId: 'worker-bad',
            hostname: 'pc-1',
            maxBotSlots: 2,
            configuredBots: [{ botId: 'b-off', username: 'BotOff', serverId: 'srv-1', authMode: 'private_offline_test' }]
          }
        }),
      (err) => err.code === 'FORBIDDEN'
    );

    // Legitimate online enrollment succeeds and consumes bootstrapToken
    const reg1 = registry.register({
      bootstrapToken,
      workerInfo: {
        workerId: 'worker-1',
        hostname: 'pc-1',
        maxBotSlots: 12,
        configuredBots: Array.from({ length: 12 }, (_, i) => ({
          botId: `bot-${i + 1}`,
          username: `SwarmBot${i + 1}`,
          serverId: 'srv-1',
          authMode: 'online_microsoft'
        }))
      }
    });
    assert.equal(reg1.acceptedBotIds.length, 12);

    // Replaying consumed bootstrap token fails with 401
    assert.throws(
      () =>
        registry.register({
          bootstrapToken,
          workerInfo: { workerId: 'worker-replay', hostname: 'pc-2', maxBotSlots: 1, configuredBots: [] }
        }),
      (err) => err.code === 'UNAUTHENTICATED'
    );

    // Registering 9 more bots (12 + 9 = 21 > 20) fails with GLOBAL_BOT_CAP_EXCEEDED!
    const { bootstrapToken: boot2 } = registry.createBootstrapToken({ createdBy: 'admin-1' });
    assert.throws(
      () =>
        registry.register({
          bootstrapToken: boot2,
          workerInfo: {
            workerId: 'worker-2',
            hostname: 'pc-2',
            maxBotSlots: 10,
            configuredBots: Array.from({ length: 9 }, (_, i) => ({
              botId: `bot-extra-${i + 1}`,
              username: `Extra${i + 1}`,
              serverId: 'srv-1',
              authMode: 'online_microsoft'
            }))
          }
        }),
      (err) => err.code === 'GLOBAL_BOT_CAP_EXCEEDED'
    );

    // Verify worker token & cross-bot impersonation block
    const authW1 = registry.verifyWorkerToken('worker-1', reg1.workerToken);
    assert.equal(authW1.allowedBotIds.length, 12);
    assert.throws(
      () =>
        registry.heartbeat('worker-1', {
          botSnapshots: [{ botId: 'unowned-bot-99', health: 20, food: 20 }]
        }),
      (err) => err.code === 'FORBIDDEN'
    );

    // Valid heartbeat marks bot ready
    registry.heartbeat('worker-1', {
      botSnapshots: [
        {
          botId: 'bot-1',
          status: 'ready',
          dimension: 'minecraft:overworld',
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          inventoryItems: [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 }]
        }
      ]
    });
    const ready = registry.eligibleBots({ onlyReady: true });
    assert.equal(ready.length, 1);
    assert.equal(ready[0].toolClasses.pickaxe.itemKey, 'minecraft:iron_pickaxe');

    // Liveness sweep transitions alive -> degraded -> unreachable
    clock += 8_000; // > 1.5 * 5000ms
    const deg = registry.sweepLiveness(new Date(clock).toISOString());
    assert.equal(deg[0].to, 'degraded');

    clock += 10_000; // > 3 * 5000ms
    const unreach = registry.sweepLiveness(new Date(clock).toISOString());
    assert.equal(unreach[0].to, 'unreachable');

    // Revocation immediately disables worker token
    registry.revoke('worker-1', 'security_drill');
    assert.throws(
      () => registry.verifyWorkerToken('worker-1', reg1.workerToken),
      (err) => err.code === 'UNAUTHENTICATED'
    );
  } finally {
    store.close();
  }
});

test('InventoryLedger prevents pre-existing stock fraud, wrong-item credit, fake crafts and orphaned transfers', () => {
  const store = new StateStore({ sqlitePath: ':memory:' }).open();
  const ledger = new InventoryLedger({ stateStore: store });

  try {
    const obj = {
      objective_id: 'obj-1',
      resource_id: 'minecraft:cobblestone',
      verification_policy: 'newly_collected'
    };
    const asg = { assignment_id: 'asg-1', quota_quantity: 32 };

    // 1. Pre-existing stock (baseline 32 -> after 32) receives ZERO credit
    const preExisting = ledger.verifyEvidence({
      objective: obj,
      assignment: asg,
      baselineSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: { 'minecraft:cobblestone': 32 } },
      beforeSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: { 'minecraft:cobblestone': 32 } },
      afterSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:01:00Z', itemCounts: { 'minecraft:cobblestone': 32 } },
      evidenceItem: { evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:cobblestone', claimedDelta: 32, details: {} },
      priorCredited: 0,
      allowExistingStock: false
    });
    assert.equal(preExisting.valid, false);
    assert.equal(preExisting.creditableDelta, 0);
    assert.equal(preExisting.rejectionCode, 'PRE_EXISTING_STOCK_NOT_CREDITED');

    // 2. Wrong item key (dirt instead of cobblestone) receives ZERO credit
    const wrongItem = ledger.verifyEvidence({
      objective: obj,
      assignment: asg,
      baselineSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      beforeSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      afterSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:01:00Z', itemCounts: { 'minecraft:dirt': 64 } },
      evidenceItem: { evidenceId: crypto.randomUUID(), kind: 'inventory_delta', itemKey: 'minecraft:dirt', claimedDelta: 64, details: {} }
    });
    assert.equal(wrongItem.valid, false);
    assert.equal(wrongItem.rejectionCode, 'RESOURCE_MISMATCH');

    // 3. Craft verification rejects output without consumedInputs proof
    const craftObj = {
      objective_id: 'obj-craft',
      resource_id: 'minecraft:wooden_pickaxe',
      verification_policy: 'crafted_output'
    };
    const fakeCraft = ledger.verifyEvidence({
      objective: craftObj,
      assignment: { assignment_id: 'asg-2', quota_quantity: 1 },
      baselineSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      beforeSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      afterSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:01:00Z', itemCounts: { 'minecraft:wooden_pickaxe': 1 } },
      evidenceItem: { evidenceId: crypto.randomUUID(), kind: 'craft_delta', itemKey: 'minecraft:wooden_pickaxe', claimedDelta: 1, details: {} }
    });
    assert.equal(fakeCraft.valid, false);
    assert.equal(fakeCraft.rejectionCode, 'CRAFT_INPUT_CONSUMPTION_MISSING');

    const validCraft = ledger.verifyEvidence({
      objective: craftObj,
      assignment: { assignment_id: 'asg-2', quota_quantity: 1 },
      baselineSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      beforeSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:00:00Z', itemCounts: {} },
      afterSnapshot: { botId: 'b1', capturedAt: '2026-11-10T00:01:00Z', itemCounts: { 'minecraft:wooden_pickaxe': 1 } },
      evidenceItem: {
        evidenceId: crypto.randomUUID(),
        kind: 'craft_delta',
        itemKey: 'minecraft:wooden_pickaxe',
        claimedDelta: 1,
        details: { consumedInputs: { 'minecraft:oak_planks': 3, 'minecraft:stick': 2 } }
      }
    });
    assert.equal(validCraft.valid, true);
    assert.equal(validCraft.creditableDelta, 1);

    // 4. Two-bot transfer timeout reconciliation (HIGH-02)
    store.run(
      `INSERT INTO workers (worker_id, token_verifier_hash, hostname, status, max_bot_slots, registered_at)
       VALUES ('w1', 'h', 'host', 'alive', 2, '2026-11-10T00:00:00Z')`
    );
    store.run(
      `INSERT INTO bots (bot_id, worker_id, username, server_id, auth_mode, enabled, connection_state, updated_at)
       VALUES ('b1', 'w1', 'B1', 's1', 'online_microsoft', 1, 'ready', '2026-11-10T00:00:00Z'),
              ('b2', 'w1', 'B2', 's1', 'online_microsoft', 1, 'ready', '2026-11-10T00:00:00Z')`
    );
    store.run(
      `INSERT INTO tasks (task_id, actor_id, source_interface, raw_text, state, created_at, updated_at)
       VALUES ('t1', 'op', 'cli', 'collect cobble', 'running', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`
    );
    store.run(
      `INSERT INTO objectives (
        objective_id, task_id, local_id, kind, resource_id, target_quantity,
        verified_quantity, reserved_quantity, description, parallelism, worker_count_hint,
        verification_policy, constraints_json, allocation_epoch, state
      ) VALUES ('o1', 't1', 'l1', 'collect', 'minecraft:cobblestone', 40, 0, 0, 'd', 'partitionable', 2, 'newly_collected', '{}', 1, 'running')`
    );

    const txId = crypto.randomUUID();
    const tStart = ledger.recordVerifiedTransfer({
      transferId: txId,
      objectiveId: 'o1',
      senderBotId: 'b1',
      receiverBotId: 'b2',
      itemKey: 'minecraft:cobblestone',
      sentQuantity: 20,
      ttlMs: 10_000,
      nowIso: '2026-11-10T00:00:00.000Z'
    });
    assert.equal(tStart.state, 'in_flight');

    // Despawn timeout at +15s marks transfer timed_out_disputed with lostQuantity = 20
    const timedOut = ledger.expireStaleTransfers('2026-11-10T00:00:15.000Z');
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].lostQuantity, 20);
  } finally {
    store.close();
  }
});
