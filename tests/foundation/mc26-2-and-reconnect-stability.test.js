'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { loadConfig } = require('../../src/config/loadConfig');
const { loadDotEnvFile } = require('../../src/config/envFile');
const { runSetupWizard, formatSavedConfigBanner } = require('../../src/cli/setupWizard');
const {
  DEFAULT_MINECRAFT_VERSION,
  load26_2Bundle,
  installBotProtocolStabilizer
} = require('../../src/worker/mc26_2Compat');
const {
  BotRunner,
  probeMinecraftServer,
  formatDisconnectReason
} = require('../../src/worker/BotRunner');
const {
  getBrigadierCompletions,
  createReadlineCompleter,
  resolveUnifiedCommandExecution
} = require('../../src/commands/CommandCompleter');
const { parseExtendedZeroAiIntent } = require('../../src/commands/ZeroAiCommandDeck');
const { createMaster, enterTerminalAlternateScreen } = require('../../index');

describe('MC26-2: Minecraft 26.2 Default Protocol & Anti-Reconnect-Loop Stabilizer', () => {
  it('MC26-01: defaults worker.minecraftVersion to 26.2 and spawnStaggerMs to 4500ms in loadConfig & setupWizard', async () => {
    assert.equal(DEFAULT_MINECRAFT_VERSION, '26.2');

    const cfg = loadConfig({
      env: {
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_AI_ENABLED: 'false'
      }
    });
    assert.equal(cfg.worker.minecraftVersion, '26.2');
    assert.equal(cfg.worker.spawnStaggerMs, 4500);

    // Explicit override still works
    const customCfg = loadConfig({
      env: {
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_AI_ENABLED: 'false',
        SWARM_MC_VERSION: '1.21.4',
        SWARM_SPAWN_STAGGER_MS: '5000'
      }
    });
    assert.equal(customCfg.worker.minecraftVersion, '1.21.4');
    assert.equal(customCfg.worker.spawnStaggerMs, 5000);

    // Verify setupWizard writes SWARM_MC_VERSION=26.2 and displays MC 26.2 in banner
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-mc26-wiz-'));
    try {
      const envPath = path.join(tmpDir, '.env');
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let outText = '';
      stdout.on('data', (chunk) => {
        outText += chunk.toString('utf8');
      });

      stdin.end(
        [
          '2',                             // 1. role = worker
          'thebasement-wUr4.aternos.me',   // 2. server
          '25565',                         // 3. port
          'yes',                           // 4. cracked
          '4',                             // 5. initial_bots
          'Nexus',                         // 6. bot_prefix
          '1',                             // 7. mode
          '3',                             // 8. performance
          'no',                            // 9. ai
          'http://192.168.1.168:8443',     // 10. master_url
          'worker-1',                      // 11. worker_id
          'tok_test_123456',               // 12. bootstrap_token
          '',                              // 13. spawn_stagger_ms (accept default 4500)
          'yes'                            // 14. simulation
        ].join('\n') + '\n'
      );

      await runSetupWizard({
        envFilePath: envPath,
        input: stdin,
        output: stdout,
        autoInstallDeps: false
      });

      const saved = loadDotEnvFile(envPath).values;
      assert.equal(saved.SWARM_MC_VERSION, '26.2');
      assert.equal(saved.SWARM_SPAWN_STAGGER_MS, '4500');
      assert.match(outText, /\(MC 26\.2\)/);
      assert.match(formatSavedConfigBanner({}), /\(MC 26\.2\)/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('MC26-02: bundles complete verified pc/26.2 dataset (protocol 776, 40 entity attributes, mappers, loginPacket & windows)', () => {
    const bundle = load26_2Bundle();
    assert.ok(bundle && bundle.files);
    const f = bundle.files;

    assert.equal(f['version.json'].minecraftVersion, '26.2');
    assert.equal(f['version.json'].version, 776);
    assert.equal(f['version.json'].majorVersion, '26.2');
    assert.ok(Array.isArray(f['blocks.json']) && f['blocks.json'].length > 1000);
    assert.ok(Array.isArray(f['items.json']) && f['items.json'].length > 1200);
    assert.ok(Array.isArray(f['entities.json']) && f['entities.json'].length > 120);
    assert.ok(f['loginPacket.json'] && f['loginPacket.json'].dimensionCodec);
    assert.ok(Array.isArray(bundle.windows1203) && bundle.windows1203.length > 0);

    // Verify PR #1344 critical fixes: 40 attributes (0..39) + movement_speed at 21 + hand/attack/respawn schemas
    const toClientTypes = f['protocol.json'].play.toClient.types;
    const toServerTypes = f['protocol.json'].play.toServer.types;
    const attrPacket = toClientTypes.packet_entity_update_attributes[1];
    const propsField = attrPacket.find((field) => field.name === 'properties');
    const keyMappings = propsField.type[1].type[1].find((field) => field.name === 'key').type[1].mappings;
    assert.equal(Object.keys(keyMappings).length, 40);
    assert.ok(Object.values(keyMappings).includes('generic.movement_speed'));

    assert.ok(toServerTypes.packet_attack, '26.2 must define dedicated play.toServer packet_attack');
    assert.ok(toServerTypes.packet_tick_end, '26.2 must define play.toServer packet_tick_end');
    const armHandType = toServerTypes.packet_arm_animation[1].find((field) => field.name === 'hand').type;
    assert.equal(armHandType[0], 'mapper');
    assert.equal(armHandType[1].mappings['0'], 'main_hand');
    assert.equal(armHandType[1].mappings['1'], 'off_hand');
  });

  it('MC26-03: installBotProtocolStabilizer prevents invalid_player_movement kicks & translates 26.2 packets', async () => {
    const bundle = load26_2Bundle();
    const proto262 = bundle.files['protocol.json'];

    const sent = [];
    const fakeClient = Object.assign(new EventEmitter(), {
      state: 'play',
      serializer: {
        proto: {
          types: proto262.play.toServer.types
        }
      },
      write(name, params) {
        sent.push({ name, params });
      }
    });
    const fakeBot = Object.assign(new EventEmitter(), {
      _client: fakeClient
    });

    installBotProtocolStabilizer(fakeBot);

    // 1. Simulate TWO consecutive position_look packets in the same tick (PR #4201 teleport + physics bug):
    //    Stabilizer MUST inject `tick_end` between them AND at `physicsTick` so 26.2 never kicks!
    fakeBot._client.write('position_look', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0 });
    fakeBot._client.write('position', { x: 0.2, y: 64, z: 0, flags: 1 });
    fakeBot.emit('physicsTick');
    await new Promise((r) => setImmediate(r));

    const names = sent.map((p) => p.name);
    assert.deepEqual(names, ['position_look', 'tick_end', 'position', 'tick_end']);

    // 2. Verify 26.2 packet translations: attack, hand mapper, perform_respawn, stop_sleeping, NaN chunk batch
    sent.length = 0;
    fakeBot._client.write('use_entity', { target: 42, mouse: 1, sneaking: false });
    fakeBot._client.write('use_entity', { target: 42, mouse: 0, hand: 0, sneaking: false });
    fakeBot._client.write('arm_animation', { hand: 0 });
    fakeBot._client.write('use_item', { hand: 1, sequence: 3, rotation: { x: 0, y: 0 } });
    fakeBot._client.write('client_command', { actionId: 0 });
    fakeBot._client.write('entity_action', { entityId: 1, actionId: 2, jumpBoost: 0 });
    fakeBot._client.write('chunk_batch_received', { chunksPerTick: Number.NaN });

    assert.deepEqual(sent[0], { name: 'attack', params: { entityId: 42 } });
    assert.equal(sent[1].name, 'use_entity');
    assert.equal(sent[1].params.hand, 'main_hand');
    assert.deepEqual(sent[1].params.location, { x: 0, y: 0, z: 0 });
    assert.deepEqual(sent[2], { name: 'arm_animation', params: { hand: 'main_hand' } });
    assert.equal(sent[3].params.hand, 'off_hand');
    assert.deepEqual(sent[4], { name: 'client_command', params: { actionId: 'perform_respawn' } });
    assert.equal(sent[5].params.actionId, 'stop_sleeping');
    assert.equal(sent[6].params.chunksPerTick, 3.5);

    fakeBot.emit('end');
  });

  it('MC26-04: parses 26.2 NBT kick reasons cleanly, probes Aternos offline vs online 26.2, and prevents rapid join-leave flap', async () => {
    // 1. Prismarine 1.20.3+ / 26.2 NBT compound kick reason formatting (never "[object Object]")
    const nbtKick = {
      type: 'compound',
      value: {
        translate: { type: 'string', value: 'multiplayer.disconnect.invalid_player_movement' }
      }
    };
    assert.equal(formatDisconnectReason(nbtKick), 'multiplayer.disconnect.invalid_player_movement');

    const nbtExtra = {
      type: 'compound',
      value: {
        text: { type: 'string', value: 'Connection throttled! ' },
        extra: {
          type: 'list',
          value: {
            type: 'compound',
            value: [{ text: { type: 'string', value: 'Please wait before reconnecting.' } }]
          }
        }
      }
    };
    assert.equal(formatDisconnectReason(nbtExtra), 'Connection throttled! Please wait before reconnecting.');

    // 2. probeMinecraftServer honors default 26.2 when online AND catches Aternos Offline before login
    const fakeMpOffline = {
      ping(_opts, cb) {
        cb(null, {
          version: { name: '§4● Offline', protocol: -1 },
          description: { text: 'This server is offline.' }
        });
      }
    };
    await assert.rejects(
      () =>
        probeMinecraftServer(fakeMpOffline, null, null, {
          host: 'thebasement-wUr4.aternos.me',
          port: 25565,
          requestedVersion: '26.2'
        }),
      /Offline/
    );

    const fakeMpOnline = {
      ping(_opts, cb) {
        cb(null, {
          version: { name: 'Paper 26.2', protocol: 776 },
          description: { text: 'Welcome!' }
        });
      }
    };
    const onlineTarget = await probeMinecraftServer(fakeMpOnline, null, null, {
      host: 'thebasement-wUr4.aternos.me',
      port: 25565,
      requestedVersion: undefined
    });
    assert.equal(onlineTarget.version, '26.2');

    // 3. Anti-flap reconnect backoff: rapid post-spawn disconnect MUST increment _reconnectAttempt (not reset to 0!)
    const flapDriver = Object.assign(new EventEmitter(), {
      connected: false,
      async connect() {
        this.connected = true;
      },
      async disconnect() {
        this.connected = false;
      },
      async captureState() {
        return { connected: this.connected, health: 20, food: 20, inventoryItems: [], itemCounts: {} };
      }
    });

    const runner = new BotRunner({
      workerId: 'w-flap',
      botId: 'bot-01',
      username: 'Nexus_01',
      driver: flapDriver,
      reconnectBaseMs: 500
    });

    await runner.start();
    // Simulate rapid kick 20ms after spawn (before 60s stability window)
    flapDriver.connected = false;
    flapDriver.emit('end', nbtExtra);
    assert.equal(runner._reconnectAttempt, 1);

    await runner.stop();
  });

  it('MC26-05: throttled Minecraft reconnects back off for a minute and stagger sibling bots per server', async () => {
    const serverHost = `throttle-test-${Date.now()}.example.invalid`;
    const makeRunner = (botId) => {
      const driver = Object.assign(new EventEmitter(), {
        connected: false,
        async disconnect() {
          this.connected = false;
        }
      });
      const runner = new BotRunner({
        workerId: 'w-throttle',
        botId,
        username: botId,
        serverId: 'throttle-test',
        minecraftConfig: { minecraftHost: serverHost, minecraftPort: 25565 },
        driver,
        reconnectBaseMs: 500
      });
      runner._simulationMode = false;
      return runner;
    };

    const first = makeRunner('throttle-bot-1');
    const second = makeRunner('throttle-bot-2');
    first._scheduleReconnect('Kicked by server: Connection throttled! Please wait before reconnecting.');
    second._scheduleReconnect('Kicked by server: Connection throttled! Please wait before reconnecting.');
    const firstDelayMs = first._reconnectTimer?._idleTimeout || 0;
    const secondDelayMs = second._reconnectTimer?._idleTimeout || 0;
    assert.ok(firstDelayMs >= 60_000, `first retry should wait at least 60s, got ${firstDelayMs}ms`);
    assert.ok(secondDelayMs > firstDelayMs, 'sibling bot retry should be staggered behind the first bot');
    await Promise.all([first.stop(), second.stop()]);
  });

  it('MC26-06: TTY terminal uses alternate screen and restores the prior shell screen on close', () => {
    const writes = [];
    const stdout = {
      write(chunk) {
        writes.push(String(chunk));
        return true;
      }
    };

    const restoreScreen = enterTerminalAlternateScreen(stdout, true);
    assert.deepEqual(writes, ['\u001b[?1049h\u001b[2J\u001b[H']);
    restoreScreen();
    restoreScreen();
    assert.deepEqual(writes, ['\u001b[?1049h\u001b[2J\u001b[H', '\u001b[?1049l']);

    const nonTtyWrites = [];
    const noopRestore = enterTerminalAlternateScreen({ write: (chunk) => nonTtyWrites.push(chunk) }, false);
    noopRestore();
    assert.deepEqual(nonTtyWrites, [], 'non-TTY/test streams must not receive terminal control sequences');
  });

  it('MC26-07: Minecraft Brigadier Tab autocomplete & slash-free commands work end-to-end across Web UI, API & CLI', async () => {
    const ctx = {
      players: ['DragonSlayer', 'Alex'],
      bots: ['bot-01', 'bot-02']
    };

    // 1. Step-by-step Brigadier Tab progression: `mi` -> `mine ` -> `mine di` -> `mine diamond ` -> `64`
    const step1 = getBrigadierCompletions('mi', ctx);
    assert.equal(step1.suggestions[0].token, 'mine');
    assert.equal(step1.suggestions[0].applyValue, 'mine ');

    const slashCompat = getBrigadierCompletions('/mine di', ctx);
    assert.equal(slashCompat.suggestions[0].applyValue, '/mine diamond ');

    const step2 = getBrigadierCompletions('mine di', ctx);
    assert.equal(step2.suggestions[0].token, 'diamond');
    assert.equal(step2.suggestions[0].applyValue, 'mine diamond ');

    const step3 = getBrigadierCompletions('mine diamond ', ctx);
    assert.equal(step3.suggestions[0].token, '64');
    assert.equal(step3.suggestions[0].applyValue, 'mine diamond 64');

    // 2. PvP & Schematic & Kit Brigadier suggestions
    const pvp1 = getBrigadierCompletions('kill ', ctx);
    assert.equal(pvp1.suggestions[0].token, 'DragonSlayer');
    const pvp2 = getBrigadierCompletions('kill DragonSlayer ma', ctx);
    assert.equal(pvp2.suggestions[0].token, 'mace');
    assert.equal(pvp2.suggestions[0].applyValue, 'kill DragonSlayer mace ');

    const build1 = getBrigadierCompletions('build wa', ctx);
    assert.equal(build1.suggestions[0].token, 'watchtower');

    const kit1 = getBrigadierCompletions('kit full', ctx);
    assert.equal(kit1.suggestions[0].token, 'full_iron_kit');

    // 3. Readline completer for Termux / Linux terminal
    const rlCompleter = createReadlineCompleter(() => ctx);
    const [hits] = rlCompleter('mi');
    assert.deepEqual(hits, ['mine ']);

    const cycleCompleter = createReadlineCompleter(() => ctx);
    const [cycleOne] = cycleCompleter('k');
    const [cycleTwo] = cycleCompleter(cycleOne[0]);
    const [cycleThree] = cycleCompleter(cycleTwo[0]);
    assert.deepEqual([cycleOne[0], cycleTwo[0], cycleThree[0]], ['kit', 'kill', 'kos']);

    // 4. Unified command execution & Minecraft `<verb> <item> <count>` Zero-AI parsing
    const killExec = resolveUnifiedCommandExecution('kill DragonSlayer mace bot-01');
    assert.equal(killExec.type, 'player_action');
    assert.equal(killExec.payload.mode, 'attack_player');
    assert.equal(killExec.payload.targetPlayer, 'DragonSlayer');
    assert.equal(killExec.payload.preferredWeaponStyle, 'mace');
    assert.equal(killExec.payload.botId, 'bot-01');

    const slashFreePlans = [
      ['mine diamond 64', 'minecraft:diamond', 64],
      ['collect oak_log 64', 'minecraft:oak_log', 64],
      ['craft diamond_pickaxe 1', 'minecraft:diamond_pickaxe', 1],
      ['smelt iron_ingot 32', 'minecraft:iron_ingot', 32],
      ['deposit cobblestone 64', 'minecraft:cobblestone', 64]
    ];
    for (const [text, resourceId, quantity] of slashFreePlans) {
      const plan = parseExtendedZeroAiIntent(text);
      assert.ok(plan && plan.objectives.length === 1, `${text} should parse as one deterministic objective`);
      assert.equal(plan.objectives[0].target.resourceId, resourceId, `${text} resource`);
      assert.equal(plan.objectives[0].target.quantity, quantity, `${text} quantity`);
    }

    const kitPlan = parseExtendedZeroAiIntent('kit full_iron_kit');
    assert.ok(kitPlan && kitPlan.objectives.length >= 10);

    // 5. Live HTTP `/api/v1/commands/autocomplete` endpoint
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-mc-auto-'));
    const cliToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const master = createMaster(
      loadConfig({
        env: {
          SWARM_ENV_PROFILE: 'private_offline_test',
          SWARM_BIND_HOST: '127.0.0.1',
          SWARM_PORT: '0',
          SWARM_HTTP_ENABLED: 'true',
          SWARM_AI_ENABLED: 'false',
          SWARM_CLI_TOKEN: cliToken,
          SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      })
    );
    try {
      const { port } = await master.start({ listenHttp: true });
      const resDict = await fetch(`http://127.0.0.1:${port}/api/v1/commands/autocomplete?dictionary=1`, {
        headers: { Authorization: `Bearer ${cliToken}` }
      });
      assert.equal(resDict.status, 200);
      const bodyDict = await resDict.json();
      assert.ok(Array.isArray(bodyDict.dictionary.rootCommands) && bodyDict.dictionary.rootCommands.length >= 20);

      const resRoot = await fetch(
        `http://127.0.0.1:${port}/api/v1/commands/autocomplete?q=${encodeURIComponent('mi')}`,
        { headers: { Authorization: `Bearer ${cliToken}` } }
      );
      const bodyRoot = await resRoot.json();
      assert.equal(bodyRoot.suggestions[0].applyValue, 'mine ');

      const resCatalog = await fetch(
        `http://127.0.0.1:${port}/api/v1/commands/autocomplete?q=${encodeURIComponent('wooden')}`,
        { headers: { Authorization: `Bearer ${cliToken}` } }
      );
      const bodyCatalog = await resCatalog.json();
      assert.equal(bodyCatalog.suggestions[0].applyValue, 'get wooden tools');

      const resQuery = await fetch(
        `http://127.0.0.1:${port}/api/v1/commands/autocomplete?q=${encodeURIComponent('mine di')}`,
        { headers: { Authorization: `Bearer ${cliToken}` } }
      );
      assert.equal(resQuery.status, 200);
      const bodyQuery = await resQuery.json();
      assert.equal(bodyQuery.suggestions[0].applyValue, 'mine diamond ');
    } finally {
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
