'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../../src/config/loadConfig');
const { createMaster } = require('../../src/master/createMaster');
const { createWorker } = require('../../src/worker/WorkerHost');
const { SkinManager } = require('../../src/skins/SkinGenerator');
const {
  MASTER_ZERO_AI_CATALOG,
  listZeroAiCommands
} = require('../../src/commands/ZeroAiCommandDeck');
const {
  buildDeterministicPlan,
  validateTaskPlanV1
} = require('../../src/performance/AiEfficiencyController');
const {
  scoreArmorItem,
  scoreWeaponItem,
  scoreMiningToolItem,
  CombatAndSurvivalEngine,
  FOOD_MOBS
} = require('../../src/combat/CombatAndSurvivalEngine');
const { SchematicRegistry } = require('../../src/schematics/SchematicBuilder');
const { resolveUnifiedCommandExecution } = require('../../src/commands/CommandCompleter');

test('NEXUS-SKINS: Exclusively equips all bots (bot-01..bot-20) with the 64x64 Crimson Shadow Knight skin', () => {
  const sm = new SkinManager();
  const skins = sm.listSkins();
  assert.equal(skins.length, 1, 'Only the Crimson Shadow Knight skin should be registered');
  assert.equal(skins[0].skinId, 'knight_crimson');
  assert.equal(skins[0].archetype, 'knight');

  const png = sm.getPngBuffer('knight_crimson');
  // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR width=64, height=64, bitDepth=8, colorType=6 (RGBA)
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  assert.equal(skins[0].preview.head.length, 8);
  assert.equal(skins[0].preview.body.length, 12);

  // Every bot in the entire 20-bot swarm strictly wears `knight_crimson`
  for (let i = 1; i <= 20; i += 1) {
    const botId = `bot-${String(i).padStart(2, '0')}`;
    const resolved = sm.resolveBotSkin(botId, i - 1);
    assert.equal(resolved.skinId, 'knight_crimson', `${botId} must wear knight_crimson`);
    assert.equal(resolved.archetype, 'knight');
  }
  assert.equal(sm.isValidSkinId('robe_gold'), false);
});

test('NEXUS-ZERO-AI: curated distinct commands resolve through deterministic tasks or explicit actions', () => {
  assert.ok(MASTER_ZERO_AI_CATALOG.length >= 350 && MASTER_ZERO_AI_CATALOG.length < 600, `Expected a compact curated deck, got ${MASTER_ZERO_AI_CATALOG.length}`);
  const commandFamilies = MASTER_ZERO_AI_CATALOG.map((item) => item.commandText.toLowerCase().replace(/\b\d+\b/g, '#'));
  assert.equal(new Set(commandFamilies).size, commandFamilies.length, 'Quantity-only duplicate command presets must be omitted');

  for (const entry of MASTER_ZERO_AI_CATALOG) {
    const direct = resolveUnifiedCommandExecution(entry.commandText);
    if (direct.type === 'player_action') {
      assert.ok(direct.payload.mode, `Direct action has a mode: ${entry.commandText}`);
      continue;
    }
    const det = buildDeterministicPlan(null, entry.commandText);
    assert.equal(det.matched, true, `Catalog command did not match Zero-AI: "${entry.commandText}"`);
    const v = validateTaskPlanV1(det.plan);
    assert.equal(v.valid, true, `Invalid TaskPlanV1 for "${entry.commandText}": ${v.errors.join('; ')}`);
  }

  // User's exact requested phrases!
  const phrases = [
    ['collect 64 logs', 1, 'minecraft:oak_log', 64],
    ['collect stone', 1, 'minecraft:cobblestone', 64],
    ['get stone tools', 11, 'minecraft:oak_log', 8],
    ['mine iron ,gold,diamonds', 3, 'minecraft:raw_iron', 32],
    ['get iron tools', 9, 'minecraft:coal', 12],
    ['get full iron kit', 14, 'minecraft:oak_log', 8],
    ['get diamond tools', 5, 'minecraft:diamond', 11],
    ['get mace kit', 4, 'minecraft:mace', 1],
    ['get spear kit', 3, 'minecraft:diamond_spear', 1],
    ['smelt 32 iron', 1, 'minecraft:iron_ingot', 32],
    ['build watchtower', 1, null, 1]
  ];

  for (const [text, expectedObjCount, firstRes, firstQty] of phrases) {
    const det = buildDeterministicPlan(null, text);
    assert.equal(det.matched, true, `Expected "${text}" to match Zero-AI`);
    assert.equal(validateTaskPlanV1(det.plan).valid, true, `Plan invalid for "${text}"`);
    assert.equal(det.plan.objectives.length, expectedObjCount, `Objective count mismatch for "${text}"`);
    assert.equal(det.plan.objectives[0].target.resourceId, firstRes);
    assert.equal(det.plan.objectives[0].target.quantity, firstQty);
  }

  const searchRes = listZeroAiCommands({ search: 'diamond', limit: 50 });
  assert.ok(searchRes.matchedCount >= 10);
});

test('NEXUS-FOOD-HUNT: Low-food bots hunt passive meat mobs, collect drops, and eat without targeting hostiles', async () => {
  assert.deepEqual([...FOOD_MOBS].sort(), ['chicken', 'cow', 'mooshroom', 'pig', 'rabbit', 'sheep']);
  const pos = (x) => ({ x, y: 64, z: 0, distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); } });
  const pig = { id: 7, name: 'pig', position: pos(4), health: 10 };
  const zombie = { id: 8, name: 'zombie', position: pos(1), health: 20 };
  const nearby = { entity: { position: pos(0) }, entities: { 7: pig, 8: zombie } };
  const engine = new CombatAndSurvivalEngine({ botId: 'bot-01', username: 'Nexus_01' });
  assert.equal(engine.findNearestFoodMob(nearby, nearby.entity.position), pig);

  let food = 5;
  const inventoryItems = [];
  const target = { id: 11, name: 'pig', position: pos(3), health: 10 };
  const bot = {
    entity: { position: pos(0) }, entities: { 11: target }, health: 20,
    get food() { return food; }, inventory: { items: () => inventoryItems }, equip: async () => {},
    consume: async () => { inventoryItems.splice(0, 1); food = 20; }
  };
  engine.engageTarget = async (_bot, mob) => {
    delete bot.entities[mob.id];
    inventoryItems.push({ name: 'porkchop', count: 1 });
    return { acted: true };
  };
  const result = await engine.tick(bot, async () => true);
  assert.equal(result.targetMob, 'pig');
  assert.equal(result.foodCollected, 1);
  assert.equal(result.ate, true);
  assert.equal(food, 20);
});

test('NEXUS-PVP-SURVIVAL: Mace aerial smash, Axe shield-break, Spear reach, Enchanted Armor & Auto-Feed', async () => {
  // 1. Enchanted Diamond Chestplate (Prot IV + Mending + Unbreaking III) beats plain Iron & rejects Curse of Binding
  const plainIron = { name: 'iron_chestplate', enchants: [] };
  const protDiamond = {
    name: 'diamond_chestplate',
    enchants: [
      { name: 'protection', lvl: 4 },
      { name: 'mending', lvl: 1 },
      { name: 'unbreaking', lvl: 3 }
    ]
  };
  const cursedNetherite = {
    name: 'netherite_chestplate',
    enchants: [{ name: 'binding_curse', lvl: 1 }]
  };
  assert.ok(scoreArmorItem(protDiamond) > scoreArmorItem(plainIron));
  assert.ok(scoreArmorItem(cursedNetherite) < 0);

  // 2. Dynamic PvP Weapon Switching:
  //    - Falling smash -> Heavy Mace (`density` + `wind_burst`) wins!
  //    - Enemy blocking with shield -> Axe wins!
  //    - 3.5m reach window -> Spear / Trident wins!
  //    - Grounded close melee -> Sharpness V Sword wins!
  const mace = {
    name: 'mace',
    enchants: [{ name: 'density', lvl: 5 }, { name: 'wind_burst', lvl: 2 }]
  };
  const sword = {
    name: 'diamond_sword',
    enchants: [{ name: 'sharpness', lvl: 5 }, { name: 'fire_aspect', lvl: 2 }]
  };
  const axe = {
    name: 'diamond_axe',
    enchants: [{ name: 'sharpness', lvl: 4 }]
  };
  const spear = {
    name: 'netherite_spear',
    enchants: [{ name: 'impaling', lvl: 5 }, { name: 'sharpness', lvl: 4 }]
  };

  assert.ok(
    scoreWeaponItem(mace, { isFallingSmash: true, distance: 2.5 }) >
      scoreWeaponItem(sword, { isFallingSmash: true, distance: 2.5 }),
    'Mace must win during falling aerial smash'
  );
  assert.ok(
    scoreWeaponItem(axe, { targetBlocking: true, distance: 2.5, onGroundCooldown: true }) >
      scoreWeaponItem(sword, { targetBlocking: true, distance: 2.5, onGroundCooldown: true }),
    'Axe must win to disable raised enemy shields'
  );
  assert.ok(
    scoreWeaponItem(spear, { distance: 3.5, onGroundCooldown: true }) >
      scoreWeaponItem(axe, { distance: 3.5, onGroundCooldown: true }),
    'Spear must beat axe in 3.5m reach window'
  );

  // 3. Fortune III + Efficiency V Pickaxe beats unenchanted pickaxe
  const plainPick = { name: 'diamond_pickaxe', enchants: [] };
  const godPick = {
    name: 'diamond_pickaxe',
    enchants: [{ name: 'efficiency', lvl: 5 }, { name: 'fortune', lvl: 3 }]
  };
  assert.ok(scoreMiningToolItem(godPick, 'diamond_ore') > scoreMiningToolItem(plainPick, 'diamond_ore'));

  // 4. Auto-Feed consumes highest saturation food (Golden Carrot over Apple)
  const equipped = [];
  let consumed = 0;
  const mockBot = {
    health: 15,
    food: 12,
    heldItem: sword,
    inventory: {
      slots: [],
      items: () => [
        { name: 'apple', count: 4, slot: 10 },
        { name: 'golden_carrot', count: 8, slot: 11 },
        protDiamond,
        { name: 'totem_of_undying', count: 1, slot: 12 }
      ]
    },
    equip: async (item, dest) => {
      equipped.push({ name: item.name, dest });
    },
    consume: async () => {
      consumed += 1;
    }
  };
  const engine = new CombatAndSurvivalEngine({ botId: 'bot-01', username: 'Nexus_01' });
  await engine.autoEquipBestGear(mockBot, true);
  const ate = await engine.autoFeedIfNeeded(mockBot, false);
  assert.equal(ate, true);
  assert.equal(consumed, 1);
  assert.ok(equipped.some((e) => e.name === 'golden_carrot' && e.dest === 'hand'));
  assert.ok(equipped.some((e) => e.name === 'diamond_chestplate' && e.dest === 'torso'));
  assert.ok(equipped.some((e) => e.name === 'totem_of_undying' && e.dest === 'off-hand'));
});

test('NEXUS-E2E-MEGA: HTTP Skins, 16+ AI Providers, Live Player PvP Orders, Custom Schematics & Strict CSP', async () => {
  // Verify strict zero inline styles in dashboard HTML & JS
  const html = fs.readFileSync(path.join(__dirname, '../../src/dashboard/public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../../src/dashboard/public/app.js'), 'utf8');
  const cli = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
  assert.equal(/\sstyle\s*=/.test(html), false, 'index.html must contain zero inline style="" attributes');
  assert.equal(/\.style\./.test(js), false, 'app.js must contain zero element.style.* mutations');
  assert.match(html, /placeholder="Type a command \(e\.g\. mine diamond 64\) · press Tab for suggestions"/);
  assert.match(html, /id="noai-search-input" type="search"/);
  assert.match(html, /Popular shortcuts/);
  assert.match(html, /add-worker-form/);
  assert.match(js, /requestSeq !== state\.noaiRequestSeq/);
  assert.match(js, /noaiLimit: 24/);
  assert.match(js, /\.filter\(\(task\) => task\.state !== 'cancelled'\)/);
  assert.match(js, /Cancelled tasks are hidden/);
  assert.doesNotMatch(html, /mc-slash-badge/);
  assert.match(cli, /prompt: 'nexus> '/);
  assert.match(cli, /principalId: 'cli:tty'/);
  assert.match(cli, /createReadlineCompleter\(\(\) => autocompleteContext\)/);
  assert.match(js, /api\('\/api\/v1\/commands\/autocomplete\?q='/);
  assert.match(js, /options\.playerOnly/);

  // Verify SchematicRegistry custom ASCII-layer schematic parsing
  const schReg = new SchematicRegistry();
  assert.ok(schReg.listSchematics().length >= 18);
  const survivalBlueprintIds = new Set(schReg.listSchematics().map((entry) => entry.schematicId));
  assert.ok(survivalBlueprintIds.has('animal_pen'));
  assert.ok(survivalBlueprintIds.has('torch_waystation'));
  const custom = schReg.registerCustomSchematic({
    name: 'Test Beacon Pyramid',
    palette: { I: 'iron_block', B: 'beacon' },
    layers: [
      ['III', 'III', 'III'],
      ['...', '.B.', '...']
    ]
  });
  assert.equal(custom.blockCount, 10);

  // Spin up live Master + 2-bot WorkerHost and exercise all new endpoints end-to-end
  const masterCfg = loadConfig({
    SWARM_ROLE: 'master',
    SWARM_ENV_PROFILE: 'private_offline_test',
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_PORT: '0',
    SWARM_TLS_ENABLED: 'false',
    SWARM_DB_PATH: ':memory:',
    SWARM_AI_ENABLED: 'false'
  });
  const master = createMaster(masterCfg);
  const info = await master.start({ listenHttp: true });
  const baseUrl = `http://127.0.0.1:${info.port}`;

  let worker = null;
  try {
    // 1. Public 64x64 Knight PNG route works directly
    const pngRes = await fetch(`${baseUrl}/skins/knight_crimson.png`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    const pngBuf = Buffer.from(await pngRes.arrayBuffer());
    assert.equal(pngBuf[0], 137);

    // 2. Bootstrap Admin & Enroll 2-bot Simulated Worker
    const setupRes = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'supersecretpassword123' })
    });
    assert.equal(setupRes.status, 201);
    const cookie = setupRes.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await setupRes.json();
    const authHeaders = {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken
    };

    const tokRes = await fetch(`${baseUrl}/api/v1/workers/bootstrap-token`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}'
    });
    const { bootstrapToken } = await tokRes.json();

    const workerCfg = loadConfig({
      SWARM_ROLE: 'worker',
      SWARM_ENV_PROFILE: 'private_offline_test',
      SWARM_MASTER_URL: baseUrl,
      SWARM_BOOTSTRAP_TOKEN: bootstrapToken,
      SWARM_WORKER_ID: 'worker-mega',
      SWARM_WORKER_SIMULATION: 'true',
      SWARM_SPAWN_STAGGER_MS: '10',
      SWARM_WORKER_POLL_MS: '100',
      SWARM_BOT_NAME_PREFIX: 'Nexus',
      SWARM_WORKER_BOT_COUNT: '2'
    });
    worker = createWorker(workerCfg);
    await worker.start();

    // 3. Switch AI Brain across Gemini, ChatGPT, Claude, Groq, OpenRouter & Zero-AI!
    for (const [prov, key, model] of [
      ['gemini', 'AIzaTestKey1234', 'gemini-2.5-flash'],
      ['chatgpt', 'sk-testOpenAi9999', 'gpt-4o-mini'],
      ['claude', 'sk-ant-testClaude8888', 'claude-sonnet-4-20250514'],
      ['groq', 'gsk_testGroq7777', 'llama-3.3-70b-versatile'],
      ['none', '', 'deterministic-v2']
    ]) {
      const aiRes = await fetch(`${baseUrl}/api/v1/ai/config`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ provider: prov, apiKey: key, model })
      });
      assert.equal(aiRes.status, 200);
      const aiJson = await aiRes.json();
      assert.ok(aiJson.providers.length >= 16, 'All 16+ AI providers listed');
    }

    // 4. Live Server Players detected from Worker heartbeat + PvP Kill / Protect / Drop-Loot orders!
    const plRes = await fetch(`${baseUrl}/api/v1/players`, { headers: { Cookie: cookie } });
    const plJson = await plRes.json();
    assert.ok(plJson.players.some((p) => p.username === 'Steve'));

    const pvpRes = await fetch(`${baseUrl}/api/v1/players/action`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        mode: 'attack_player',
        targetPlayer: 'Steve',
        botId: '*',
        preferredWeaponStyle: 'mace',
        relation: 'kos',
        preemptTask: true
      })
    });
    assert.equal(pvpRes.status, 200);
    await worker.flushAndPoll();
    assert.equal(worker.bots.get('bot-01').getTacticalState().mode, 'attack_player');
    assert.equal(worker.bots.get('bot-01').getTacticalState().preferredWeaponStyle, 'mace');

    // Reset tactical to idle & dispatch Zero-AI multi-step "get stone tools" progression task!
    await fetch(`${baseUrl}/api/v1/players/action`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'idle' })
    });
    await worker.flushAndPoll();

    const gotoRes = await fetch(`${baseUrl}/api/v1/players/action`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'goto', targetPosition: { x: 123.5, y: 70, z: -45 }, botId: 'bot-01', preemptTask: true })
    });
    assert.equal(gotoRes.status, 200);
    await worker.flushAndPoll();
    assert.deepEqual(worker.bots.get('bot-01').getTacticalState().targetPosition, { x: 123.5, y: 70, z: -45 });
    assert.deepEqual(worker.bots.get('bot-01').driver.position, { x: 123.5, y: 70, z: -45 });
    const swarmGotoRes = await fetch(`${baseUrl}/api/v1/players/action`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'goto', targetPosition: { x: 10, y: 64, z: 20 }, botId: '*', preemptTask: true })
    });
    assert.equal(swarmGotoRes.status, 200);
    await worker.flushAndPoll();
    for (const botId of ['bot-01', 'bot-02']) {
      assert.deepEqual(worker.bots.get(botId).getTacticalState().targetPosition, { x: 10, y: 64, z: 20 });
    }
    await fetch(`${baseUrl}/api/v1/players/action`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ mode: 'idle' })
    });
    await worker.flushAndPoll();

    const taskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: 'get stone tools', priority: 'high' })
    });
    assert.equal(taskRes.status, 201);
    const taskDetail = await taskRes.json();
    assert.equal(taskDetail.objectives.length, 11);
  } finally {
    if (worker) await worker.stop();
    await master.stop();
  }
});
