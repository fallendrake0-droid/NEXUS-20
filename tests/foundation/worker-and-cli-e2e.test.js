'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

const { createMaster, createWorker, loadConfig, runCli } = require('../../index');
const { loadDotEnvFile } = require('../../src/config/envFile');
const { SkillExecutor } = require('../../src/worker/SkillExecutor');
const { BotRunner, SimulatedBotDriver } = require('../../src/worker/BotRunner');
const { WorkerHost } = require('../../src/worker/WorkerHost');

function createCaptureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  return {
    stream,
    readText: () => Buffer.concat(chunks).toString('utf8')
  };
}

async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe('NEXUS-20 Distributed WorkerHost + Unified CLI End-to-End Suite', () => {
  it('prints the Minecraft connection failure and retry delay to stderr without requiring a TTY', async () => {
    const driver = new EventEmitter();
    driver.connected = false;
    driver.connect = async () => { throw new Error('connect ECONNREFUSED 203.0.113.2:25565'); };
    driver.disconnect = async () => {};
    const runner = new BotRunner({
      workerId: 'worker-terminal-test',
      botId: 'bot-terminal-test',
      username: 'Nexus_Terminal_Test',
      minecraftConfig: { minecraftHost: 'mc.example.test', minecraftPort: 25565 },
      driver,
      logger: { info() {}, warn() {}, error() {} }
    });
    // Injected drivers default to simulation behavior; exercise the real connection diagnostics path.
    runner._simulationMode = false;
    const originalWrite = process.stderr.write;
    let terminalOutput = '';
    process.stderr.write = function capture(chunk) {
      terminalOutput += String(chunk);
      return true;
    };
    try {
      await runner.start();
    } finally {
      await runner.stop('test_cleanup');
      process.stderr.write = originalWrite;
    }
    assert.match(terminalOutput, /Nexus_Terminal_Test -> mc\.example\.test:25565/);
    assert.match(terminalOutput, /ECONNREFUSED 203\.0\.113\.2:25565/);
    assert.match(terminalOutput, /reconnect attempt 1 scheduled in \d+s/);
  });

  it('watchdog schedules one reconnect if a disconnected driver misses its end event', async () => {
    const runner = new BotRunner({
      workerId: 'worker-watchdog-test',
      botId: 'bot-watchdog-test',
      driver: { connected: false, async disconnect() {} },
      reconnectBaseMs: 500
    });
    assert.equal(runner.ensureConnected(), true);
    assert.ok(runner._reconnectTimer);
    assert.equal(runner.ensureConnected(), false, 'must not schedule duplicate retries');
    await runner.stop('test_cleanup');
    assert.equal(runner._reconnectTimer, null);
  });

  it('keeps Master heartbeats moving while a survival food hunt is still in progress and coalesces overlapping ticks', async () => {
    let finishSurvival;
    const survivalPromise = new Promise((resolve) => { finishSurvival = resolve; });
    let heartbeatCalls = 0;
    let finishHeartbeat;
    const worker = Object.create(WorkerHost.prototype);
    Object.assign(worker, {
      _stopping: false,
      _needsReconcile: false,
      _heartbeatPromise: null,
      bots: new Map([['bot-01', {
        botId: 'bot-01',
        survivalCheckInFlight: false,
        checkSurvivalReflexes: () => survivalPromise,
        async getHeartbeatSnapshot() { return { botId: 'bot-01', status: 'ready' }; },
        getTacticalState() { return { mode: 'idle' }; },
        async listOnlinePlayers() { return []; },
        drainWorldObservations() { return []; }
      }]]),
      logger: { warn() {} },
      client: {
        workerId: 'worker-heartbeat-test',
        async heartbeat() {
          heartbeatCalls += 1;
          return new Promise((resolve) => { finishHeartbeat = resolve; });
        }
      }
    });

    const first = worker.tickHeartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    const overlapping = worker.tickHeartbeat();
    assert.equal(heartbeatCalls, 1, 'a slow heartbeat must not cause concurrent posts');
    finishHeartbeat({});
    assert.deepEqual(await first, {});
    assert.deepEqual(await overlapping, {});
    finishSurvival();
  });

  it('coalesces overlapping survival checks for one bot', async () => {
    let finishCapture;
    let captureCalls = 0;
    const runner = new BotRunner({
      workerId: 'worker-survival-test',
      botId: 'bot-survival-test',
      driver: {
        async captureState() {
          captureCalls += 1;
          return new Promise((resolve) => { finishCapture = resolve; });
        }
      }
    });
    const first = runner.checkSurvivalReflexes();
    const second = runner.checkSurvivalReflexes();
    assert.equal(captureCalls, 1);
    finishCapture({ connected: true, health: 20, food: 20, inventoryItems: [] });
    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.equal(runner.survivalCheckInFlight, false);
  });

  it('does not fabricate location, health, or hunger for a disconnected bot snapshot', async () => {
    const runner = new BotRunner({
      workerId: 'worker-snapshot-test',
      botId: 'bot-snapshot-test',
      driver: {
        connected: false,
        async captureState() {
          return { connected: false, position: null, dimension: 'unknown', health: 0, food: 0, inventoryItems: [], freeSlots: 0 };
        }
      }
    });
    const snapshot = await runner.getHeartbeatSnapshot();
    assert.equal(snapshot.status, 'disconnected');
    assert.equal(snapshot.position, null);
    assert.equal(snapshot.dimension, 'unknown');
    assert.equal(snapshot.health, null);
    assert.equal(snapshot.food, null);
  });

  it('does not mark a build task complete when the driver reports zero verified block changes', async () => {
    const executor = new SkillExecutor({ leaseSafetyMarginMs: 100, stepIntervalMs: 5 });
    const driver = {
      connected: true,
      async captureState() { return { itemCounts: {} }; },
      async safeStop() { return { ok: true }; },
      async performBlockTask() { return { ok: true, verifiedBlocks: 0 }; }
    };
    const outcome = await executor.execute({
      assignment: {
        assignmentId: '11111111-1111-4111-8111-111111111111', leaseId: '22222222-2222-4222-8222-222222222222',
        allocationEpoch: 1, taskId: '33333333-3333-4333-8333-333333333333', objectiveId: 'build-shelter',
        workerId: 'worker-build', botId: 'bot-build', actionType: 'build', quotaQuantity: 1,
        leaseTtlMs: 10_000, checkpointIntervalMs: 5000
      },
      driver,
      getControlState: () => ({ paused: false, cancelled: false, fenced: false, disconnected: false, monotonicDeadlineMs: performance.now() + 20_000 })
    });
    assert.equal(outcome.type, 'failed');
    assert.equal(outcome.report.failureCode, 'PATH_BLOCKED');
    assert.match(outcome.report.summary, /without verified block changes/);
  });

  it('E2E-01: Master + WorkerHost (2 bots) enroll, split quota, execute mine skill, verify ledger & record world knowledge over live TCP', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-worker-e2e1-'));
    const cliToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const workerCredPath = path.join(tmpDir, 'worker-1-creds.json');

    const masterConfig = loadConfig({
      env: {
        SWARM_ROLE: 'master',
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_OPERATING_MODE: 'SYNCHRONIZED',
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_PORT: '0',
        SWARM_HTTP_ENABLED: 'true',
        SWARM_ENABLED_BOTS: '4',
        SWARM_AI_ENABLED: 'false',
        SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
        SWARM_BACKUP_DIR: path.join(tmpDir, 'backups'),
        SWARM_CLI_TOKEN: cliToken
      }
    });

    const master = createMaster(masterConfig);
    let worker = null;
    try {
      const startInfo = await master.start({ listenHttp: true });
      const masterUrl = `http://127.0.0.1:${startInfo.port}`;

      // 1. Mint bootstrap token via unified CLI (`index.js mint-token --url=...`)
      const mintOut = createCaptureStream();
      const mintRes = await runCli(
        ['mint-token', `--url=${masterUrl}`, `--token=${cliToken}`],
        {
          stdout: mintOut.stream,
          env: {
            SWARM_AI_ENABLED: 'false',
            SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        }
      );
      assert.equal(mintRes.exitCode, 0);
      const minted = JSON.parse(mintOut.readText());
      assert.ok(minted.bootstrapToken);

      // 2. Start distributed WorkerHost with 2 simulated bots
      const workerConfig = loadConfig({
        env: {
          SWARM_ROLE: 'worker',
          SWARM_ENV_PROFILE: 'private_offline_test',
          SWARM_MASTER_URL: masterUrl,
          SWARM_WORKER_ID: 'worker-alpha',
          SWARM_BOOTSTRAP_TOKEN: minted.bootstrapToken,
          SWARM_WORKER_STATE_PATH: workerCredPath,
          SWARM_SPAWN_STAGGER_MS: '20',
          SWARM_WORKER_POLL_MS: '100',
          SWARM_HEARTBEAT_INTERVAL_MS: '1000',
          SWARM_WORKER_SIMULATION: 'true',
          SWARM_AI_ENABLED: 'false',
          SWARM_WORKER_BOTS: 'bot-1:AlphaOne,bot-2:AlphaTwo',
          SWARM_DB_PATH: path.join(tmpDir, 'unused-worker.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });

      worker = createWorker(workerConfig);
      await worker.start();

      // Verify saved worker credentials file exists with 0600 permissions
      assert.ok(fs.existsSync(workerCredPath));
      const mode = fs.statSync(workerCredPath).mode & 0o777;
      assert.equal(mode, 0o600);

      // 3. Submit "Collect 40 cobblestone" via CLI (`index.js submit ...`)
      const subOut = createCaptureStream();
      const subRes = await runCli(
        ['submit', 'Collect 40 cobblestone', '--priority=high', `--url=${masterUrl}`, `--token=${cliToken}`],
        {
          stdout: subOut.stream,
          env: {
            SWARM_AI_ENABLED: 'false',
            SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        }
      );
      assert.equal(subRes.exitCode, 0);
      const createdTask = JSON.parse(subOut.readText());
      assert.ok(createdTask.taskId);

      // 4. Wait for WorkerHost to execute both bot leases and drive task to completed!
      const completedTask = await waitFor(() => {
        const t = master.taskManager.getTask(createdTask.taskId);
        return t && t.state === 'completed' ? t : null;
      });
      assert.equal(completedTask.state, 'completed');
      assert.equal(completedTask.objectives[0].verifiedQuantity, 40);

      // Send one extra heartbeat so piggybacked resource_location discoveries arrive in WorldKnowledgeStore
      await worker.tickHeartbeat();
      const knowledge = master.worldKnowledgeStore.query({ category: 'resource_location' });
      assert.ok(knowledge.length >= 1, 'Expected piggybacked resource_location world knowledge from WorkerHost');
    } finally {
      if (worker) await worker.stop();
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('E2E-02: WorkerHost credential resume + /reconcile, priority-0 Survival Reflex eat/override, and local monotonic lease self-fencing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-worker-e2e2-'));
    const workerCredPath = path.join(tmpDir, 'worker-resume-creds.json');

    const masterConfig = loadConfig({
      env: {
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_PORT: '0',
        SWARM_HTTP_ENABLED: 'true',
        SWARM_ENABLED_BOTS: '2',
        SWARM_AI_ENABLED: 'false',
        SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
        SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
      }
    });

    const master = createMaster(masterConfig);
    let worker1 = null;
    let worker2 = null;
    try {
      const startInfo = await master.start({ listenHttp: true });
      const masterUrl = `http://127.0.0.1:${startInfo.port}`;
      const minted = master.botRegistry.createBootstrapToken({ createdBy: 'test' });

      const wCfg1 = loadConfig({
        env: {
          SWARM_ROLE: 'worker',
          SWARM_ENV_PROFILE: 'private_offline_test',
          SWARM_MASTER_URL: masterUrl,
          SWARM_WORKER_ID: 'worker-resumable',
          SWARM_BOOTSTRAP_TOKEN: minted.bootstrapToken,
          SWARM_WORKER_STATE_PATH: workerCredPath,
          SWARM_SPAWN_STAGGER_MS: '0',
          SWARM_WORKER_POLL_MS: '100',
          SWARM_WORKER_SIMULATION: 'true',
          SWARM_AI_ENABLED: 'false',
          SWARM_WORKER_BOTS: 'bot-s1:SurvivorBot',
          SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });

      worker1 = createWorker(wCfg1);
      await worker1.start();
      await worker1.stop();
      worker1 = null;

      // Resume WITHOUT SWARM_BOOTSTRAP_TOKEN using persisted 0600 statePath -> calls /worker/v1/reconcile!
      const wCfg2 = loadConfig({
        env: {
          SWARM_ROLE: 'worker',
          SWARM_ENV_PROFILE: 'private_offline_test',
          SWARM_MASTER_URL: masterUrl,
          SWARM_WORKER_ID: 'worker-resumable',
          SWARM_WORKER_STATE_PATH: workerCredPath,
          SWARM_SPAWN_STAGGER_MS: '0',
          SWARM_WORKER_POLL_MS: '100',
          SWARM_WORKER_SIMULATION: 'true',
          SWARM_AI_ENABLED: 'false',
          SWARM_WORKER_BOTS: 'bot-s1:SurvivorBot',
          SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });

      worker2 = createWorker(wCfg2);
      await worker2.start();
      assert.equal(worker2.health().started, true);

      // Trigger priority-0 Survival Reflex (`health = 4 <= minHealth 8`)
      const runner = worker2.bots.get('bot-s1');
      runner.driver.health = 4;
      runner.driver.food = 5;
      const override = await runner.checkSurvivalReflexes();
      assert.ok(override);
      assert.equal(override.trigger, 'low_health');
      assert.equal(override.recovered, true);
      assert.equal(runner.driver.health, 8);
      await worker2.flushAndPoll();

      // Verify local monotonic lease self-fencing (`LEASE_EXPIRED_LOCALLY`)
      const executor = new SkillExecutor({ leaseSafetyMarginMs: 500, stepIntervalMs: 10 });
      const simDriver = new SimulatedBotDriver({ botId: 'bot-fence' });
      await simDriver.connect();
      const outcome = await executor.execute({
        assignment: {
          schemaVersion: 1,
          assignmentId: '11111111-1111-4111-8111-111111111111',
          leaseId: '22222222-2222-4222-8222-222222222222',
          allocationEpoch: 1,
          taskId: '33333333-3333-4333-8333-333333333333',
          objectiveId: 'collect_stone',
          workerId: 'worker-resumable',
          botId: 'bot-fence',
          actionType: 'mine',
          resourceId: 'minecraft:cobblestone',
          quotaQuantity: 20,
          leaseTtlMs: 400
        },
        driver: simDriver,
        getControlState: () => ({
          paused: false,
          cancelled: false,
          fenced: false,
          disconnected: false,
          monotonicDeadlineMs: performance.now() + 200 // Already inside 500ms safety margin!
        })
      });
      assert.equal(outcome.type, 'failed');
      assert.equal(outcome.report.failureCode, 'LEASE_EXPIRED_LOCALLY');
    } finally {
      if (worker1) await worker1.stop();
      if (worker2) await worker2.stop();
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('E2E-03: Authorised in-game !swarm chat_intent dispatches & completes task while unauthorised spoof is dropped', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-worker-e2e3-'));
    const allowedUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    const masterConfig = loadConfig({
      env: {
        SWARM_ENV_PROFILE: 'authorised_online',
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_PORT: '0',
        SWARM_HTTP_ENABLED: 'true',
        SWARM_ENABLED_BOTS: '2',
        SWARM_AI_ENABLED: 'false',
        SWARM_CHAT_ENABLED: 'true',
        SWARM_CHAT_PREFIX: '!swarm',
        SWARM_CHAT_ALLOWED_UUIDS: allowedUuid,
        SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
        SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
      }
    });

    const master = createMaster(masterConfig);
    let worker = null;
    try {
      const startInfo = await master.start({ listenHttp: true });
      const masterUrl = `http://127.0.0.1:${startInfo.port}`;
      const minted = master.botRegistry.createBootstrapToken({ createdBy: 'test' });

      const workerConfig = loadConfig({
        env: {
          SWARM_ROLE: 'worker',
          SWARM_ENV_PROFILE: 'authorised_online',
          SWARM_MASTER_URL: masterUrl,
          SWARM_WORKER_ID: 'worker-chat',
          SWARM_BOOTSTRAP_TOKEN: minted.bootstrapToken,
          SWARM_SPAWN_STAGGER_MS: '0',
          SWARM_WORKER_POLL_MS: '100',
          SWARM_WORKER_SIMULATION: 'true',
          SWARM_AI_ENABLED: 'false',
          SWARM_CHAT_ENABLED: 'true',
          SWARM_CHAT_PREFIX: '!swarm',
          SWARM_CHAT_ALLOWED_UUIDS: allowedUuid,
          SWARM_WORKER_BOTS: 'bot-c1:ChatRelayBot',
          SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });

      worker = createWorker(workerConfig);
      await worker.start();
      const runner = worker.bots.get('bot-c1');

      // 1. Unauthorised player chat -> dropped immediately on Worker
      runner.driver.emit('chat', {
        senderName: 'Griefer99',
        senderUuid: '99999999-9999-4999-8999-999999999999',
        text: '!swarm task Collect 10 dirt'
      });
      await worker.flushAndPoll();
      assert.equal(master.taskManager.listTasks().items.length, 0);

      // 2. Allowlisted operator player chat -> creates & completes exploration task end-to-end!
      runner.driver.emit('chat', {
        senderName: 'TrustedCommander',
        senderUuid: allowedUuid,
        text: '!swarm task Explore spawn_basin'
      });
      await worker.flushAndPoll();

      const doneTask = await waitFor(() => {
        const list = master.taskManager.listTasks().items;
        return list.length === 1 && list[0].state === 'completed' ? list[0] : null;
      });
      assert.equal(doneTask.state, 'completed');
    } finally {
      if (worker) await worker.stop();
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('E2E-04: CLI diagnostics, verified SQLite WAL backup, safe-mode exit endpoint & G-01 zero-Mineflayer check', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-worker-e2e4-'));
    const cliToken = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

    // 1. CLI --help & --check-config
    const helpCap = createCaptureStream();
    assert.equal((await runCli(['--help'], { stdout: helpCap.stream })).exitCode, 0);
    assert.match(helpCap.readText(), /mint-token/);

    const cfgCap = createCaptureStream();
    assert.equal(
      (
        await runCli(['--check-config'], {
          stdout: cfgCap.stream,
          env: {
            SWARM_ENV_PROFILE: 'private_offline_test',
            SWARM_AI_ENABLED: 'false',
            SWARM_CLI_TOKEN: cliToken,
            SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        })
      ).exitCode,
      0
    );
    assert.doesNotMatch(cfgCap.readText(), new RegExp(cliToken));

    // 2. Boot Master and test remote CLI --health, status, backup & exit-safe-mode
    const masterConfig = loadConfig({
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
    });
    const master = createMaster(masterConfig);
    try {
      const startInfo = await master.start({ listenHttp: true });
      const masterUrl = `http://127.0.0.1:${startInfo.port}`;

      const healthCap = createCaptureStream();
      const hRes = await runCli(['--health', `--url=${masterUrl}`], {
        stdout: healthCap.stream,
        env: {
          SWARM_AI_ENABLED: 'false',
          SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });
      assert.equal(hRes.exitCode, 0);
      assert.equal(JSON.parse(healthCap.readText()).healthy, true);

      const backupCap = createCaptureStream();
      const bRes = await runCli(['backup', `--url=${masterUrl}`, `--token=${cliToken}`], {
        stdout: backupCap.stream,
        env: {
          SWARM_AI_ENABLED: 'false',
          SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
          SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
        }
      });
      assert.equal(bRes.exitCode, 0);
      const parsedBackup = JSON.parse(backupCap.readText());
      assert.equal(parsedBackup.ok, true);
      assert.ok(fs.existsSync(parsedBackup.backupPath));
      assert.ok(parsedBackup.bytes > 4096);

      // Simulate transient safe-mode entry, verify write block, then recover via /api/v1/system/exit-safe-mode
      master.coordinator._enterSafeMode(new Error('transient_disk_busy'));
      assert.equal(master.coordinator.safeMode, true);

      const recoverRes = await fetch(`${masterUrl}/api/v1/system/exit-safe-mode`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cliToken}`,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      assert.equal(recoverRes.status, 200);
      assert.equal(master.coordinator.safeMode, false);

      // Verify G-01: zero Mineflayer / Prismarine packages loaded in require.cache!
      const loadedPaths = Object.keys(require.cache);
      for (const forbidden of ['mineflayer', 'prismarine-world', 'mineflayer-pathfinder', 'minecraft-data']) {
        const hit = loadedPaths.find((p) => p.includes(`node_modules/${forbidden}`));
        assert.equal(hit, undefined, `Forbidden package ${forbidden} must never load on Master!`);
      }
    } finally {
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('E2E-05: Sticky bot usernames (Nexus_01, Nexus_02) persist across restarts & re-enrollments, Aternos URL sanitizes cleanly, and RFC1918 192.168.1.168 LAN bind works', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-worker-e2e5-'));

    // 1. Verify 192.168.1.168 private LAN HTTP opt-in & Aternos URL sanitization
    const lanCfg = loadConfig({
      env: {
        SWARM_BIND_HOST: '192.168.1.168',
        SWARM_ALLOW_PRIVATE_LAN_HTTP: 'true',
        SWARM_AI_ENABLED: 'false',
        SWARM_MC_HOST: 'http://thebasement-wUr4.aternos.me/',
        SWARM_DB_PATH: path.join(tmpDir, 'lan.db'),
        SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
      }
    });
    assert.equal(lanCfg.http.host, '192.168.1.168');
    assert.equal(lanCfg.tls.enabled, false);
    assert.equal(lanCfg.worker.minecraftHost, 'thebasement-wUr4.aternos.me');
    assert.equal(lanCfg.worker.minecraftPort, 25565);

    // Public 0.0.0.0 bind with SWARM_ALLOW_PRIVATE_LAN_HTTP=true MUST still fail without TLS/proxy!
    assert.throws(() =>
      loadConfig({
        env: {
          SWARM_BIND_HOST: '0.0.0.0',
          SWARM_ALLOW_PRIVATE_LAN_HTTP: 'true',
          SWARM_TLS_ENABLED: 'false',
          SWARM_AI_ENABLED: 'false'
        }
      })
    );

    // 2. Verify sticky bot usernames stay locked across re-enrollment on a brand-new machine
    const masterCfg = loadConfig({
      env: {
        SWARM_ENV_PROFILE: 'private_offline_test',
        SWARM_BIND_HOST: '127.0.0.1',
        SWARM_PORT: '0',
        SWARM_HTTP_ENABLED: 'true',
        SWARM_AI_ENABLED: 'false',
        SWARM_ENABLED_BOTS: '4',
        SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
        SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
      }
    });
    const master = createMaster(masterCfg);
    let w1 = null;
    let w2 = null;
    let w3 = null;
    try {
      const startInfo = await master.start({ listenHttp: true });
      const masterUrl = `http://127.0.0.1:${startInfo.port}`;
      const tok1 = master.botRegistry.createBootstrapToken({ createdBy: 'test' });

      // First WorkerHost run: generates deterministic bot-01 -> Nexus_01, bot-02 -> Nexus_02
      w1 = createWorker(
        loadConfig({
          env: {
            SWARM_ROLE: 'worker',
            SWARM_ENV_PROFILE: 'private_offline_test',
            SWARM_MASTER_URL: masterUrl,
            SWARM_WORKER_ID: 'worker-sticky',
            SWARM_BOOTSTRAP_TOKEN: tok1.bootstrapToken,
            SWARM_WORKER_STATE_PATH: path.join(tmpDir, 'pc1-state.json'),
            SWARM_BOT_NAME_PREFIX: 'Nexus',
            SWARM_WORKER_BOT_COUNT: '2',
            SWARM_SPAWN_STAGGER_MS: '0',
            SWARM_WORKER_SIMULATION: 'true',
            SWARM_AI_ENABLED: 'false',
            SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        })
      );
      await w1.start();
      assert.equal(w1.bots.get('bot-01').username, 'Nexus_01');
      assert.equal(w1.bots.get('bot-02').username, 'Nexus_02');
      await w1.stop();
      w1 = null;

      // Second WorkerHost run on a DIFFERENT PC (no state file, accidental different prefix "AccidentalName"):
      // Master locks & returns canonical usernames Nexus_01 & Nexus_02 so bots keep 100% of their Aternos items!
      const tok2 = master.botRegistry.createBootstrapToken({ createdBy: 'test' });
      w2 = createWorker(
        loadConfig({
          env: {
            SWARM_ROLE: 'worker',
            SWARM_ENV_PROFILE: 'private_offline_test',
            SWARM_MASTER_URL: masterUrl,
            SWARM_WORKER_ID: 'worker-sticky',
            SWARM_BOOTSTRAP_TOKEN: tok2.bootstrapToken,
            SWARM_WORKER_STATE_PATH: path.join(tmpDir, 'pc2-state.json'),
            SWARM_BOT_NAME_PREFIX: 'OtherName',
            SWARM_WORKER_BOT_COUNT: '2',
            SWARM_SPAWN_STAGGER_MS: '0',
            SWARM_WORKER_SIMULATION: 'true',
            SWARM_AI_ENABLED: 'false',
            SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        })
      );
      await w2.start();
      assert.equal(w2.bots.get('bot-01').username, 'Nexus_01');
      assert.equal(w2.bots.get('bot-02').username, 'Nexus_02');
      await w2.stop();
      w2 = null;

      // Changing the prefix on the same offline worker uses a fresh bootstrap token to update Master names.
      const tok3 = master.botRegistry.createBootstrapToken({ createdBy: 'test-prefix-rename' });
      w3 = createWorker(
        loadConfig({
          env: {
            SWARM_ROLE: 'worker',
            SWARM_ENV_PROFILE: 'private_offline_test',
            SWARM_MASTER_URL: masterUrl,
            SWARM_WORKER_ID: 'worker-sticky',
            SWARM_BOOTSTRAP_TOKEN: tok3.bootstrapToken,
            SWARM_WORKER_STATE_PATH: path.join(tmpDir, 'pc2-state.json'),
            SWARM_BOT_NAME_PREFIX: 'Changed',
            SWARM_WORKER_BOT_COUNT: '2',
            SWARM_SPAWN_STAGGER_MS: '0',
            SWARM_WORKER_SIMULATION: 'true',
            SWARM_AI_ENABLED: 'false',
            SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
            SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
          }
        })
      );
      await w3.start();
      assert.equal(w3.bots.get('bot-01').username, 'Changed_01');
      assert.equal(w3.bots.get('bot-02').username, 'Changed_02');
    } finally {
      if (w1) await w1.stop();
      if (w2) await w2.stop();
      if (w3) await w3.stop();
      await master.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('E2E-06: Interactive one-by-one setup wizard saves 0600 .env and auto-launches on first interactive npm start', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus20-wizard-e2e6-'));
    const envPath1 = path.join(tmpDir, 'master.env');
    const envPath2 = path.join(tmpDir, 'autosim.env');

    let booted = null;
    try {
      // 1. Test `node index.js setup` stepping through every prompt one by one
      const stdin1 = new PassThrough();
      const stdout1 = createCaptureStream();
      const answers1 = [
        '1',                                // 1. role = master
        'http://thebasement-wUr4.aternos.me', // 2. server
        '25565',                            // 3. server_port
        'yes',                              // 4. cracked = yes
        '4',                                // 5. initial_bots = 4
        'Nexus',                            // 6. bot_prefix = Nexus
        '1',                                // 7. mode = HYBRID
        '3',                                // 8. performance = BALANCED
        'no',                               // 9. ai = no (£0 built-in planner)
        '192.168.1.168',                    // 10. bind_ip
        '8443',                             // 11. port
        'commander',                        // 12. admin_user
        'StrongPass#2026',                  //     admin_password
        'no'                                // 13. ingame_chat
      ];
      stdin1.end(`${answers1.join('\n')}\n`);

      const setupRes = await runCli([`--env-file=${envPath1}`, 'setup'], {
        stdin: stdin1,
        stdout: stdout1.stream,
        env: {},
        autoInstallDeps: false
      });
      assert.equal(setupRes.exitCode, 0);
      assert.ok(fs.existsSync(envPath1));
      assert.equal(fs.statSync(envPath1).mode & 0o777, 0o600);

      const parsed = loadDotEnvFile(envPath1).values;
      assert.equal(parsed.SWARM_ROLE, 'master');
      assert.equal(parsed.SWARM_MC_HOST, 'thebasement-wUr4.aternos.me');
      assert.equal(parsed.SWARM_ENV_PROFILE, 'private_offline_test');
      assert.equal(parsed.SWARM_ENABLED_BOTS, '4');
      assert.equal(parsed.SWARM_BOT_NAME_PREFIX, 'Nexus');
      assert.equal(parsed.SWARM_AI_ENABLED, 'false');
      assert.equal(parsed.SWARM_BIND_HOST, '192.168.1.168');
      assert.equal(parsed.SWARM_ALLOW_PRIVATE_LAN_HTTP, 'true');
      assert.equal(parsed.SWARM_ADMIN_USERNAME, 'commander');

      // 2. Test first-run interactive `npm start` (no .env yet -> runs wizard automatically + boots!)
      const stdin2 = new PassThrough();
      const stdout2 = createCaptureStream();
      const answers2 = [
        '3',                                // 1. role = local_sim (Master + Simulated Bots)
        'thebasement-wUr4.aternos.me',      // 2. server
        '25565',                            // 3. server_port
        'yes',                              // 4. cracked
        '2',                                // 5. initial_bots = 2
        'Nexus',                            // 6. bot_prefix
        '1',                                // 7. mode = HYBRID
        '3',                                // 8. performance = BALANCED
        'no',                               // 9. ai = no
        '127.0.0.1',                        // 10. bind_ip
        '18943',                            // 11. port
        '',                                 // 12. admin_user (skip)
        'no'                                // 13. ingame_chat
      ];
      stdin2.end(`${answers2.join('\n')}\n`);

      booted = await runCli([`--env-file=${envPath2}`], {
        stdin: stdin2,
        stdout: stdout2.stream,
        interactive: true,
        env: {},
        autoInstallDeps: false
      });
      assert.equal(booted.role, 'master');
      assert.ok(booted.embeddedSimWorker);
      assert.equal(booted.embeddedSimWorker.bots.size, 2);
      assert.equal(booted.embeddedSimWorker.bots.get('bot-01').username, 'Nexus_01');
      assert.equal(booted.embeddedSimWorker.bots.get('bot-02').username, 'Nexus_02');
      assert.match(stdout2.readText(), /NEXUS-20 Master Controller is LIVE/);

      // Stop first boot and verify second `npm start` shows saved config & quick-starts on [Enter]
      await booted.embeddedSimWorker.stop();
      await booted.instance.stop();
      booted = null;

      const stdin3 = new PassThrough();
      const stdout3 = createCaptureStream();
      stdin3.end('\n'); // Press [Enter] to start immediately from saved .env

      booted = await runCli([`--env-file=${envPath2}`], {
        stdin: stdin3,
        stdout: stdout3.stream,
        interactive: true,
        env: {},
        autoInstallDeps: false
      });
      assert.equal(booted.role, 'master');
      assert.equal(booted.embeddedSimWorker.bots.size, 2);
      assert.match(stdout3.readText(), /Saved Configuration \(\.env\)/);
      assert.match(stdout3.readText(), /Press \[Enter\] to start now, or type \[e\] to edit config one-by-one/);
    } finally {
      if (booted?.embeddedSimWorker) await booted.embeddedSimWorker.stop();
      if (booted?.instance) await booted.instance.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
