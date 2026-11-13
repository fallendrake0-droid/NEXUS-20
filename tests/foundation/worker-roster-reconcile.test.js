'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../../src/config/loadConfig');
const { createMaster } = require('../../src/master/createMaster');
const { createWorker } = require('../../src/worker/WorkerHost');

test('standalone worker re-enrolls a changed roster before sending snapshots for newly added bots', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worker-roster-'));
  const workerStatePath = path.join(tmpDir, 'worker-state.json');
  const master = createMaster(loadConfig({ env: {
    SWARM_ENV_PROFILE: 'private_offline_test',
    SWARM_BIND_HOST: '127.0.0.1',
    SWARM_PORT: '0',
    SWARM_HTTP_ENABLED: 'true',
    SWARM_ENABLED_BOTS: '5',
    SWARM_AI_ENABLED: 'false',
    SWARM_DB_PATH: path.join(tmpDir, 'master.db'),
    SWARM_BACKUP_DIR: path.join(tmpDir, 'backups')
  } }));
  let firstWorker;
  let updatedWorker;
  try {
    const { port } = await master.start({ listenHttp: true });
    const masterUrl = `http://127.0.0.1:${port}`;
    const workerEnv = (count, bootstrapToken) => ({
      SWARM_ROLE: 'worker',
      SWARM_ENV_PROFILE: 'private_offline_test',
      SWARM_MASTER_URL: masterUrl,
      SWARM_WORKER_ID: 'local-worker',
      SWARM_WORKER_BOT_COUNT: String(count),
      SWARM_BOT_NAME_PREFIX: 'Nexus',
      SWARM_WORKER_STATE_PATH: workerStatePath,
      SWARM_WORKER_SIMULATION: 'true',
      SWARM_SPAWN_STAGGER_MS: '0',
      SWARM_WORKER_POLL_MS: '100',
      SWARM_AI_ENABLED: 'false',
      SWARM_DB_PATH: path.join(tmpDir, 'unused.db'),
      SWARM_BACKUP_DIR: path.join(tmpDir, 'backups'),
      ...(bootstrapToken ? { SWARM_BOOTSTRAP_TOKEN: bootstrapToken } : {})
    });

    firstWorker = createWorker(loadConfig({ env: workerEnv(2, master.botRegistry.createBootstrapToken().bootstrapToken) }));
    await firstWorker.start();
    await firstWorker.stop();
    firstWorker = null;

    // The old saved worker token owns two bots; setup now requests five and has a fresh token.
    updatedWorker = createWorker(loadConfig({ env: workerEnv(5, master.botRegistry.createBootstrapToken().bootstrapToken) }));
    await updatedWorker.start();

    const bots = master.botRegistry.listBots().filter((bot) => bot.enabled);
    assert.deepEqual(bots.map((bot) => bot.botId), ['bot-01', 'bot-02', 'bot-03', 'bot-04', 'bot-05']);
    assert.ok(bots.every((bot) => bot.connectionState === 'ready'));
    assert.equal(updatedWorker.bots.size, 5);
  } finally {
    if (firstWorker) await firstWorker.stop();
    if (updatedWorker) await updatedWorker.stop();
    await master.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
