'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  loadConfig,
  validateConfig,
  redactConfig,
  DomainError,
  toErrorEnvelope,
  createLogger,
  SchemaValidator,
  splitQuota,
  partitionRegion,
  performance
} = require('../../index');

const { toCompactBotSnapshot } = performance;

test('loadConfig enforces <=20 bot cap, TLS rules, remote-only £0 AI, POSIX DB path and offline chat lock', () => {
  // Valid loopback development config
  const cfg = loadConfig({
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_TLS_ENABLED: 'false',
    SWARM_GLOBAL_MAX_BOTS: '20',
    SWARM_ENABLED_BOTS: '2',
    SWARM_CLI_TOKEN: 'super-secret-cli-token-value'
  });
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.capacity), true);
  assert.equal(cfg.capacity.globalMaxBots, 20);

  // Secret redaction
  const redacted = redactConfig(cfg);
  assert.notEqual(redacted.security.cliOperatorToken, 'super-secret-cli-token-value');

  // > 20 bots rejected (G-02)
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_GLOBAL_MAX_BOTS: '21' }),
    (err) => err instanceof DomainError && err.code === 'GLOBAL_BOT_CAP_EXCEEDED'
  );

  // Phone local bot slots > 0 on master rejected (G-01)
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_PHONE_LOCAL_BOT_SLOTS: '1' }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  // Non-loopback without TLS rejected (SECURITY_PLAN.md §4)
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '0.0.0.0', SWARM_TLS_ENABLED: 'false' }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  // Localhost Ollama on Master rejected (G-09)
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_OLLAMA_URL: 'http://127.0.0.1:11434' }),
    (err) => err instanceof DomainError && err.code === 'AI_LOCAL_HOST_FORBIDDEN'
  );

  // Paid cloud AI rejected (£0 requirement)
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_OLLAMA_URL: 'https://api.openai.com/v1' }),
    (err) => err instanceof DomainError && err.code === 'AI_PAID_PROVIDER_FORBIDDEN'
  );

  // Android FUSE /sdcard SQLite path rejected
  assert.throws(
    () => loadConfig({ SWARM_BIND_HOST: '127.0.0.1', SWARM_TLS_ENABLED: 'false', SWARM_DB_PATH: '/sdcard/swarm.db' }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  // Offline-mode chat spoofing lock (HIGH-06)
  assert.throws(
    () =>
      loadConfig({
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_TLS_ENABLED: 'false',
        SWARM_CHAT_ENABLED: 'true'
      }),
    (err) => err instanceof DomainError && err.code === 'CHAT_DISABLED_IN_OFFLINE_MODE'
  );

  // Unknown fileConfig section rejected
  assert.throws(
    () => loadConfig({}, { unknownSection: true }),
    (err) => err instanceof DomainError && err.code === 'SCHEMA_VALIDATION_FAILED'
  );

  assert.equal(validateConfig(cfg).valid, true);
});

test('DomainError & createLogger format safe envelopes and redact credentials', () => {
  const domErr = new DomainError('CONFLICT', 'Version mismatch', { details: { expected: 2 } });
  const env = toErrorEnvelope(domErr, 'req-123');
  assert.equal(env.httpStatus, 409);
  assert.equal(env.body.error.code, 'CONFLICT');
  assert.equal(env.body.error.retryable, true);
  assert.equal('stack' in env.body.error, false);

  const generic = toErrorEnvelope(new Error('/home/user/secret/path failed'), 'req-456');
  assert.equal(generic.httpStatus, 500);
  assert.equal(generic.body.error.code, 'INTERNAL_ERROR');
  assert.equal(generic.body.error.message.includes('/home/user'), false);

  const log = createLogger({ level: 'info', defaultFields: { service: 'test' } });
  const child = log.child({ module: 'Auth' });
  child.info('Worker enrolled', { workerToken: 'secret-token-xyz', workerId: 'w-1' });
  const entries = child.recentEntries(5);
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries[0]);
  assert.equal(serialized.includes('secret-token-xyz'), false);
  assert.equal(entries[0].data.module, 'Auth');
});

test('SchemaValidator & CompactSnapshotCodec reconcile CRIT-01, HIGH-01 and HIGH-02', () => {
  const validator = new SchemaValidator();

  // CRIT-01: clarificationRequired: true MUST succeed with objectives: [] and fail with non-empty objectives
  const clarifyPlan = {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    intentSummary: 'Ambiguous preparation intent',
    clarificationRequired: true,
    clarificationQuestion: 'Which material should the bots gather?',
    objectives: [],
    riskLevel: 'low',
    notes: []
  };
  assert.equal(validator.validate('TaskPlanV1', clarifyPlan).valid, true);
  assert.equal(
    validator.validate('TaskPlanV1', {
      ...clarificationWithExtra(clarifyPlan)
    }).valid,
    false
  );

  // Unsupported schemaVersion rejected
  const badVer = validator.validate('TaskPlanV1', { ...clarifyPlan, schemaVersion: 2 });
  assert.equal(badVer.valid, false);
  assert.equal(badVer.code, 'PROTOCOL_VERSION_UNSUPPORTED');

  // HIGH-02: CompactSnapshotCodec extracts non-held slot tools & preserves pinned late-alphabet items
  const manyItems = [];
  for (let i = 0; i < 50; i += 1) {
    manyItems.push({ name: `aa_item_${String(i).padStart(2, '0')}`, count: 1 });
  }
  manyItems.push({
    name: 'iron_pickaxe',
    count: 1,
    maxDurability: 250,
    durabilityUsed: 20
  });
  manyItems.push({
    name: 'wooden_pickaxe',
    count: 1,
    maxDurability: 59,
    durabilityUsed: 0
  });
  manyItems.push({ name: 'crafting_table', count: 1 });

  const snap = toCompactBotSnapshot(
    {
      botId: 'bot-alpha',
      dimension: 'overworld', // Bare dimension normalized to minecraft:overworld (HIGH-01)
      position: { x: 10.4, y: 64, z: -20.6 },
      health: 19,
      food: 18,
      heldItem: { name: 'torch', count: 12 }, // Holding torch, NOT pickaxe!
      inventoryItems: manyItems
    },
    { maxDistinctItems: 10, pinnedItemKeys: ['minecraft:wooden_pickaxe'] }
  );

  assert.equal(snap.dimension, 'minecraft:overworld');
  assert.equal(snap.hasCraftingTable, true);
  assert.equal(snap.bestToolsByClass.pickaxe.itemKey, 'minecraft:iron_pickaxe');
  assert.equal(snap.bestToolsByClass.pickaxe.remainingDurability, 230);
  assert.equal(snap.itemCounts['minecraft:wooden_pickaxe'], 1); // Preserved despite maxDistinctItems: 10!
});

function clarificationWithExtra(plan) {
  return {
    ...plan,
    objectives: [
      {
        localId: 'bad',
        kind: 'inspect',
        target: { resourceId: null, quantity: null, regionLabel: null, description: 'x' },
        dependencies: [],
        parallelism: 'single',
        workerCountHint: 1,
        constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 10 },
        verification: 'operator_review'
      }
    ]
  };
}

test('splitQuota water-filling equalizes makespan, prunes late arrivals, and conserves exact sum across 250 fuzz runs', () => {
  // HIGH-03 proof: Q=1000, Bot 1 slow nearby (r=0.5, travel=0s), Bot 2 fast 60s away (r=1.0, travel=60s)
  const split = splitQuota(1000, [
    { botId: 'bot-1', workerId: 'w1', rateP50: 0.5, travelSec: 0 },
    { botId: 'bot-2', workerId: 'w1', rateP50: 1.0, travelSec: 60 }
  ]);
  const b1 = split.find((q) => q.botId === 'bot-1');
  const b2 = split.find((q) => q.botId === 'bot-2');
  assert.equal(b1.quantity + b2.quantity, 1000);
  // Optimal T* = (1000 + 60) / 1.5 = 706.67s -> b1 ~ 353, b2 ~ 647 (NOT 500/500!)
  assert.ok(b2.quantity >= 640 && b2.quantity <= 650);
  assert.ok(b1.quantity >= 350 && b1.quantity <= 360);

  // Prunes distant bot whose travel delay exceeds swarm completion horizon
  const pruned = splitQuota(8, [
    { botId: 'near', workerId: 'w1', rateP50: 1.0, travelSec: 1 },
    { botId: 'far', workerId: 'w2', rateP50: 0.8, travelSec: 45 }
  ]);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].botId, 'near');
  assert.equal(pruned[0].quantity, 8);

  // Deterministic 250-case fuzz test for exact conservation (G-05)
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let t = 0; t < 250; t += 1) {
    const rem = 1 + Math.floor(rand() * 2500);
    const nBots = 1 + Math.floor(rand() * 20);
    const cands = Array.from({ length: nBots }, (_, idx) => ({
      botId: `bot-${idx + 1}`,
      workerId: `w-${(idx % 4) + 1}`,
      rateP50: 0.1 + rand() * 2.0,
      travelSec: Math.floor(rand() * 120),
      setupSec: Math.floor(rand() * 5)
    }));
    const res = splitQuota(rem, cands);
    assert.ok(res.length >= 1 && res.length <= Math.min(rem, nBots));
    const sum = res.reduce((acc, q) => acc + q.quantity, 0);
    assert.equal(sum, rem);
    assert.ok(res.every((q) => Number.isSafeInteger(q.quantity) && q.quantity >= 1));
  }

  // Disjoint spatial region partitioning
  const sectors = partitionRegion(
    { dimension: 'minecraft:overworld', minX: 0, maxX: 99, minZ: 0, maxZ: 49 },
    [
      { botId: 'bot-1', workerId: 'w1' },
      { botId: 'bot-2', workerId: 'w1' },
      { botId: 'bot-3', workerId: 'w2' },
      { botId: 'bot-4', workerId: 'w2' }
    ]
  );
  assert.equal(sectors.length, 4);
  assert.equal(sectors[0].regionBounds.minX, 0);
  assert.equal(sectors[3].regionBounds.maxX, 99);
  for (let i = 1; i < sectors.length; i += 1) {
    assert.equal(sectors[i].regionBounds.minX, sectors[i - 1].regionBounds.maxX + 1);
  }
});
