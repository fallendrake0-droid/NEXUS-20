'use strict';

/**
 * Mineflayer AI Swarm — Repository Entry Point & Foundation Barrel (`index.js`).
 *
 * Architectural Rule (`MASTER_SPEC.md` §4):
 * This Master/Foundation entry point NEVER imports `mineflayer`, `prismarine-world`,
 * `mineflayer-pathfinder`, or `minecraft-data` so the 4 GB Samsung Galaxy A06
 * coordinator stays lightweight (~60 MiB RSS).
 */

const { DomainError, ERROR_REGISTRY, isDomainError, toErrorEnvelope } = require('./src/errors/DomainError');
const { loadConfig, validateConfig, redactConfig } = require('./src/config/loadConfig');
const { createLogger } = require('./src/logging/createLogger');
const { SchemaValidator } = require('./src/protocol/SchemaValidator');
const { StateStore, StateManager } = require('./src/persistence/StateStore');
const { InventoryLedger } = require('./src/inventory/InventoryLedger');
const { BotRegistry, WorkerRegistry } = require('./src/workers/BotRegistry');
const { TaskManager } = require('./src/tasks/TaskManager');
const { TaskScheduler } = require('./src/scheduler/TaskScheduler');
const { splitQuota, partitionRegion } = require('./src/scheduler/quotaMath');
const { Coordinator, authorizeRole } = require('./src/coordinator/Coordinator');
const { createMaster } = require('./src/master/createMaster');
const performance = require('./src/performance');

async function runCliEntry(argv = process.argv.slice(2)) {
  const config = loadConfig(process.env);

  if (argv.includes('--check-config')) {
    process.stdout.write(`${JSON.stringify({ valid: true, config: redactConfig(config) }, null, 2)}\n`);
    return 0;
  }

  const master = createMaster(config);
  await master.start();

  if (argv.includes('--health')) {
    const health = await master.health();
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    await master.stop();
    return health.status === 'unhealthy' ? 1 : 0;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    master.logger.info('Received shutdown signal', { signal });
    await master.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return 0;
}

if (require.main === module) {
  runCliEntry().catch((err) => {
    const envelope = toErrorEnvelope(err, 'startup');
    process.stderr.write(`${JSON.stringify(envelope.body)}\n`);
    process.exit(1);
  });
}

module.exports = {
  createMaster,
  loadConfig,
  validateConfig,
  redactConfig,
  createLogger,
  DomainError,
  ERROR_REGISTRY,
  isDomainError,
  toErrorEnvelope,
  SchemaValidator,
  StateStore,
  StateManager,
  InventoryLedger,
  BotRegistry,
  WorkerRegistry,
  TaskManager,
  TaskScheduler,
  Coordinator,
  authorizeRole,
  splitQuota,
  partitionRegion,
  performance
};
