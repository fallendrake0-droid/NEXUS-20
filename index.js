'use strict';

/**
 * NEXUS-20 Mineflayer AI Swarm — Repository Entry Point, CLI & Foundation Barrel (`index.js`).
 *
 * Architectural Rule (`MASTER_SPEC.md` §4 / `G-01`):
 * This Master/Foundation entry point NEVER eagerly imports `mineflayer`, `prismarine-world`,
 * `mineflayer-pathfinder`, or `minecraft-data` so the 4 GB Samsung Galaxy A06
 * coordinator stays lightweight (~62 MiB RSS).
 * Distributed WorkerHost (`role=worker`) modules are loaded lazily ONLY when invoked.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

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
const { WorldKnowledgeStore } = require('./src/knowledge/WorldKnowledgeStore');
const { AuthService } = require('./src/security/AuthService');
const { MasterHttpServer } = require('./src/interfaces/http/MasterHttpServer');
const { createMaster } = require('./src/master/createMaster');
const { WorkloadGovernor } = require('./src/monitoring/WorkloadGovernor');
const { ResourceMonitor } = require('./src/monitoring/ResourceMonitor');
const performance = require('./src/performance');

function createWorker(config, options = {}) {
  // Lazy require preserves G-01 zero-Mineflayer isolation on Master Controller
  // eslint-disable-next-line global-require
  const { createWorker: createWorkerImpl } = require('./src/worker/WorkerHost');
  return createWorkerImpl(config, options);
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--check-config') {
      flags.checkConfig = true;
    } else if (arg === '--health') {
      flags.health = true;
    } else if (arg === '--worker') {
      flags.role = 'worker';
    } else if (arg === '--master') {
      flags.role = 'master';
    } else if (arg === '--simulation') {
      flags.simulation = true;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq);
      const val = arg.slice(eq + 1);
      flags[key] = val;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        flags[key] = String(next);
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

function printHelp(stdout = process.stdout) {
  stdout.write(
    [
      'NEXUS-20 Mineflayer AI Swarm — CLI & Runtime Entrypoint',
      '',
      'Daemons:',
      '  node --max-old-space-size=256 index.js [--config=path]   Start Master Controller & Web UI',
      '  node index.js --role=worker [--simulation]               Start Distributed WorkerHost',
      '',
      'Diagnostics:',
      '  node index.js --check-config                             Validate & print redacted config',
      '  node index.js --health [--url=http://127.0.0.1:8443]     Check Master/SQLite health',
      '',
      'Operator Commands:',
      '  node index.js mint-token [--url=...] [--ttl-ms=600000]   Mint single-use Worker Bootstrap Token',
      '  node index.js status [--url=...]                         Query live Master swarm status',
      '  node index.js submit "<intent>" [--priority=normal]      Submit global swarm task via CLI',
      '  node index.js backup [--dest=./path.db] [--url=...]      Create verified SQLite WAL backup',
      ''
    ].join('\n')
  );
}

function cliHttpRequest(
  baseUrlStr,
  method,
  reqPath,
  { token = null, body = undefined, timeoutMs = 8000 } = {}
) {
  const target = new URL(reqPath, baseUrlStr);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payloadBuf = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payloadBuf !== null) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = payloadBuf.byteLength;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const code = parsed?.error?.code || 'UPSTREAM_ERROR';
            const msg = parsed?.error?.message || `HTTP ${res.statusCode}`;
            reject(new DomainError(code, msg));
          }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`CLI HTTP timeout (${timeoutMs}ms) contacting ${target.origin}`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (payloadBuf !== null) req.write(payloadBuf);
    req.end();
  });
}

function defaultMasterUrlFromConfig(config, explicitUrl) {
  if (explicitUrl) return String(explicitUrl);
  const scheme = config.tls.enabled ? 'https' : 'http';
  const rawHost = config.http.host || '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  return `${scheme}://${host}:${config.http.port}`;
}

/**
 * Execute CLI command or boot long-running Master / Worker daemon.
 * Returns `{ exitCode }` for one-shot commands, or `{ role, instance }` when starting a daemon.
 */
async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = { ...(io.env || process.env) };

  const { flags, positionals } = parseCliArgs(argv);
  if (flags.help) {
    printHelp(stdout);
    return { exitCode: 0 };
  }

  if (typeof flags.role === 'string') env.SWARM_ROLE = flags.role;
  if (flags.simulation) env.SWARM_WORKER_SIMULATION = 'true';
  if (typeof flags['master-url'] === 'string') env.SWARM_MASTER_URL = flags['master-url'];
  if (typeof flags['worker-id'] === 'string') env.SWARM_WORKER_ID = flags['worker-id'];
  if (typeof flags['bootstrap-token'] === 'string') {
    env.SWARM_BOOTSTRAP_TOKEN = flags['bootstrap-token'];
  }

  let fileConfig = {};
  if (typeof flags.config === 'string') {
    const resolvedPath = path.resolve(flags.config);
    fileConfig = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  }

  let config;
  try {
    config = loadConfig(env, fileConfig);
  } catch (err) {
    const envelope = toErrorEnvelope(err, 'startup');
    stderr.write(`${JSON.stringify(envelope.body)}\n`);
    return { exitCode: 1 };
  }

  if (flags.checkConfig) {
    stdout.write(`${JSON.stringify({ valid: true, config: redactConfig(config) }, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (flags.health) {
    if (typeof flags.url === 'string') {
      try {
        const remoteHealth = await cliHttpRequest(flags.url, 'GET', '/api/v1/health');
        stdout.write(`${JSON.stringify(remoteHealth, null, 2)}\n`);
        const isOk = remoteHealth.healthy !== false && remoteHealth.status !== 'unhealthy';
        return { exitCode: isOk ? 0 : 1 };
      } catch (err) {
        stderr.write(`${JSON.stringify({ healthy: false, status: 'unhealthy', error: err.message })}\n`);
        return { exitCode: 1 };
      }
    }
    const master = createMaster(config);
    await master.start({ listenHttp: false });
    const h = await master.health();
    await master.stop();
    stdout.write(`${JSON.stringify(h, null, 2)}\n`);
    return { exitCode: h.status === 'unhealthy' || h.healthy === false ? 1 : 0 };
  }

  const subcommand = positionals[0] ? positionals[0].toLowerCase() : null;
  const cliToken =
    typeof flags.token === 'string' ? flags.token : config.security?.cliOperatorToken || null;

  if (subcommand === 'mint-token') {
    const ttlMs = flags['ttl-ms'] ? Number(flags['ttl-ms']) : undefined;
    if (flags.url) {
      const minted = await cliHttpRequest(flags.url, 'POST', '/api/v1/workers/bootstrap-token', {
        token: cliToken,
        body: { ...(ttlMs ? { ttlMs } : {}) }
      });
      stdout.write(`${JSON.stringify(minted, null, 2)}\n`);
      return { exitCode: 0 };
    }
    const master = createMaster(config);
    await master.start({ listenHttp: false });
    const minted = master.botRegistry.createBootstrapToken({
      createdBy: 'cli:local',
      ttlMs
    });
    const masterUrl = defaultMasterUrlFromConfig(config);
    await master.stop();
    stdout.write(
      `${JSON.stringify(
        {
          ...minted,
          launchHint: `SWARM_ROLE=worker SWARM_MASTER_URL=${masterUrl} SWARM_BOOTSTRAP_TOKEN=${minted.bootstrapToken} SWARM_WORKER_ID=worker-1 SWARM_WORKER_STATE_PATH=./data/worker-1-state.json SWARM_MC_HOST=thebasement-wUr4.aternos.me SWARM_BOT_NAME_PREFIX=Nexus SWARM_WORKER_BOT_COUNT=2 node index.js`
        },
        null,
        2
      )}\n`
    );
    return { exitCode: 0 };
  }

  if (subcommand === 'status') {
    const targetUrl = defaultMasterUrlFromConfig(config, flags.url);
    const st = await cliHttpRequest(targetUrl, 'GET', '/api/v1/status', { token: cliToken });
    stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (subcommand === 'submit') {
    const intentText = positionals.slice(1).join(' ').trim();
    if (!intentText) {
      stderr.write('Usage: node index.js submit "<intent text>" [--priority=normal]\n');
      return { exitCode: 1 };
    }
    const targetUrl = defaultMasterUrlFromConfig(config, flags.url);
    const priority = typeof flags.priority === 'string' ? flags.priority : 'normal';
    const created = await cliHttpRequest(targetUrl, 'POST', '/api/v1/tasks', {
      token: cliToken,
      body: { text: intentText, priority }
    });
    stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (subcommand === 'backup') {
    if (flags.url) {
      const remoteBackup = await cliHttpRequest(flags.url, 'POST', '/api/v1/system/backup', {
        token: cliToken,
        body: {}
      });
      stdout.write(`${JSON.stringify(remoteBackup, null, 2)}\n`);
      return { exitCode: 0 };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest =
      typeof flags.dest === 'string'
        ? path.resolve(flags.dest)
        : path.resolve(config.storage.backupDir, `swarm-backup-${stamp}.db`);
    const master = createMaster(config);
    await master.start({ listenHttp: false });
    const resBackup = await master.stateStore.backup(dest);
    const bytes = fs.existsSync(resBackup.destPath) ? fs.statSync(resBackup.destPath).size : 0;
    await master.stop();
    stdout.write(
      `${JSON.stringify(
        { ok: true, backupPath: resBackup.destPath, bytes, verified: resBackup.verified, createdAt: resBackup.backedUpAt },
        null,
        2
      )}\n`
    );
    return { exitCode: 0 };
  }

  if (subcommand) {
    stderr.write(`Unknown subcommand "${subcommand}". Run "node index.js --help" for usage.\n`);
    return { exitCode: 1 };
  }

  // Long-running daemon mode: WorkerHost vs Master Controller
  if (config.role === 'worker') {
    const worker = createWorker(config);
    const started = await worker.start();
    let shuttingDown = false;
    const shutdownWorker = async (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;
      worker.logger.info('Shutting down WorkerHost cleanly', { signal: sig });
      await worker.stop();
      process.exit(0);
    };
    process.once('SIGINT', () => shutdownWorker('SIGINT'));
    process.once('SIGTERM', () => shutdownWorker('SIGTERM'));
    worker.logger.info('WorkerHost ready', started);
    return { role: 'worker', instance: worker };
  }

  const master = createMaster(config);
  const startInfo = await master.start({ listenHttp: true });
  let shuttingDown = false;
  const shutdownMaster = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    master.logger.info('Received shutdown signal', { signal: sig });
    await master.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdownMaster('SIGINT'));
  process.once('SIGTERM', () => shutdownMaster('SIGTERM'));
  master.logger.info('Master ready', {
    health: await master.health(),
    listen: { host: startInfo.host, port: startInfo.port }
  });
  return { role: 'master', instance: master };
}

async function runCliEntry(argv = process.argv.slice(2)) {
  const res = await runCli(argv);
  return typeof res?.exitCode === 'number' ? res.exitCode : 0;
}

if (require.main === module) {
  runCli().then(
    (res) => {
      if (res && typeof res.exitCode === 'number') {
        process.exit(res.exitCode);
      }
    },
    (err) => {
      const envelope = toErrorEnvelope(err, 'startup');
      process.stderr.write(`${JSON.stringify(envelope.body)}\n`);
      process.exit(1);
    }
  );
}

module.exports = {
  createMaster,
  createWorker,
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
  WorldKnowledgeStore,
  AuthService,
  MasterHttpServer,
  WorkloadGovernor,
  ResourceMonitor,
  splitQuota,
  partitionRegion,
  performance,
  parseCliArgs,
  runCli,
  runCliEntry
};
