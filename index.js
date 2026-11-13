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
const { loadDotEnvFile } = require('./src/config/envFile');
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
    } else if (arg === '--setup') {
      flags.setup = true;
    } else if (arg === '--no-wizard') {
      flags['no-wizard'] = true;
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
      'Interactive Setup & Daemons:',
      '  npm start                                                Interactive setup (first run) + start',
      '  npm run setup   (or: node index.js setup)                Configure options one-by-one (.env)',
      '  node --max-old-space-size=256 index.js [--no-wizard]     Start Master Controller & Web UI',
      '  node index.js console                                     Start Master + interactive Tab-completing prompt',
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

function ensureModernMineflayerOnDisk(cwd, stdout) {
  let needsUpgrade = false;
  try {
    const mfPkg = require.resolve('mineflayer/package.json', { paths: [cwd, __dirname] });
    const mfDir = path.dirname(mfPkg);
    const mcDataPkg = require.resolve('minecraft-data/package.json', { paths: [mfDir, cwd, __dirname] });
    const pc261Dir = path.join(path.dirname(mcDataPkg), 'minecraft-data', 'data', 'pc', '26.1');
    if (!fs.existsSync(pc261Dir)) {
      needsUpgrade = true;
    }
  } catch {
    needsUpgrade = true;
  }
  if (!needsUpgrade) return;
  try {
    // eslint-disable-next-line global-require
    const { execFileSync } = require('node:child_process');
    stdout.write('Updating mineflayer + protocol packages for Minecraft 26.2 support...\n');
    execFileSync(
      'npm',
      [
        'install',
        '--no-save',
        'mineflayer@latest',
        'mineflayer-pathfinder@latest',
        'minecraft-data@latest',
        'minecraft-protocol@latest'
      ],
      { cwd, stdio: 'inherit' }
    );
  } catch {
    // Non-fatal: BotRunner will report a clear actionable error if mineflayer is absent
  }
}

function enterTerminalAlternateScreen(stdout, isTty) {
  if (!isTty || !stdout || typeof stdout.write !== 'function') return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write('\u001b[?1049l');
    process.removeListener('exit', restore);
  };

  // Save the current terminal buffer, use a clean alternate screen for NEXUS,
  // and restore the user's shell scrollback when the process exits.
  stdout.write('\u001b[?1049h\u001b[2J\u001b[H');
  process.once('exit', restore);
  return restore;
}

function startMasterTtyCommandConsole(master, uiUrl, stdin, stdout, onQuit) {
  // eslint-disable-next-line global-require
  const readline = require('node:readline');
  // eslint-disable-next-line global-require
  const {
    createReadlineCompleter,
    resolveUnifiedCommandExecution
  } = require('./src/commands/CommandCompleter');

  const actor = { principalId: 'cli:tty', username: 'cli-admin', role: 'admin' };
  let autocompleteContext = { bots: [], players: [] };
  const refreshAutocompleteContext = async () => {
    try {
      const [playersRes, bots] = await Promise.all([
        master.coordinator.listServerPlayers({ actor }),
        Promise.resolve(master.botRegistry.listBots())
      ]);
      autocompleteContext = {
        bots: bots.map((b) => b.botId || b.username).filter(Boolean),
        players: (playersRes.players || [])
          .filter((p) => !p.isSwarmBot && p.username)
          .map((p) => p.username)
      };
    } catch {
      // Retain the last successful snapshot; the CLI completer itself has safe fallbacks.
    }
  };
  const contextRefreshTimer = setInterval(refreshAutocompleteContext, 5000);
  contextRefreshTimer.unref?.();
  void refreshAutocompleteContext();

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    completer: createReadlineCompleter(() => autocompleteContext),
    prompt: 'nexus> ',
    historySize: 100
  });

  rl.on('close', () => {
    clearInterval(contextRefreshTimer);
    onQuit('TTY_CLOSED');
  });
  rl.on('SIGINT', () => {
    rl.close();
    onQuit('SIGINT');
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/quit') {
      rl.close();
      onQuit('SIGINT');
      return;
    }
    if (trimmed === 'help' || trimmed === '/help' || trimmed === '?') {
      stdout.write(
        '  Commands (press [Tab] after any word to auto-complete!):\n' +
          '    mine <ore_or_block> [count]     tree [count]  collect <resource> [count]\n' +
          '    food [bot]  mobs [bot]           goto <x> <y> <z> [bot]\n' +
          '    craft <item> [count]            smelt <item> [count]\n' +
          '    kit <progression_kit>           build <schematic> [bot]\n' +
          '    kill <player> [weapon] [bot]    follow <player>  protect <player>\n' +
          '    surround <player>               drop <player> [item]  hunt\n' +
          '    skin sync                       mode <HYBRID|SYNCHRONIZED|DISTRIBUTED>\n' +
          '    botcap <1..20>                  stop              quit\n'
      );
      rl.prompt();
      return;
    }

    try {
      const schRes = await master.coordinator.listSchematics({ actor }).catch(() => ({ schematics: [] }));
      const schIds = new Set((schRes.schematics || []).map((s) => s.schematicId || s.id));
      const action = resolveUnifiedCommandExecution(trimmed, schIds);

      if (action?.type === 'invalid_command') {
        stdout.write(`  [ERR] ${action.message}\n`);
      } else if (action?.type === 'emergency_stop') {
        const res = await master.coordinator.emergencyStopAll({ actor });
        await master.coordinator.dispatchPlayerTacticalAction({ actor, mode: 'idle', botId: '*' }).catch(() => {});
        stdout.write(`  [OK] Emergency stop & ceasefire sent (${res.stoppedBots || 0} bots)\n`);
      } else if (action?.type === 'swarm_mode') {
        await master.coordinator.setOperatingMode({ actor, mode: action.mode });
        stdout.write(`  [OK] Operating mode -> ${action.mode}\n`);
      } else if (action?.type === 'swarm_profile') {
        await master.coordinator.setPerformanceProfile({ actor, profile: action.profile });
        stdout.write(`  [OK] Performance profile -> ${action.profile}\n`);
      } else if (action?.type === 'bot_cap') {
        await master.coordinator.setEnabledBotsCap({ actor, enabledBotsCap: action.enabledBotsCap });
        stdout.write(`  [OK] Enabled bot cap -> ${action.enabledBotsCap}\n`);
      } else if (action?.type === 'skin_sync') {
        await master.coordinator.assignSkin({
          actor,
          preset: action.preset,
          botId: action.botId,
          publicBaseUrl: uiUrl
        });
        stdout.write('  [OK] Crimson Shadow Knight skin synced across swarm\n');
      } else if (action?.type === 'player_action') {
        const res = await master.coordinator.dispatchPlayerTacticalAction({
          actor,
          ...action.payload
        });
        stdout.write(`  [OK] Tactical order: ${res.mode}${res.targetPlayer ? ` -> ${res.targetPlayer}` : ''}\n`);
      } else if (action?.type === 'build_schematic') {
        const res = await master.coordinator.buildSchematicNow({
          actor,
          schematicId: action.schematicId,
          botId: action.botId
        });
        stdout.write(`  [OK] Building schematic: ${res.schematic?.name || action.schematicId}\n`);
      } else if (action?.type === 'task_intent') {
        const created = await master.coordinator.submitIntent({
          actor,
          source: 'cli',
          text: action.text,
          priority: 'normal'
        });
        stdout.write(`  [OK] Dispatched: ${created.intentSummary || action.text} [${created.state}]\n`);
      }
    } catch (err) {
      stdout.write(`  [ERR] ${err?.message || err}\n`);
    }
    rl.prompt();
  });

  rl.prompt();
  return rl;
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
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const callerEnv = io.env || process.env;
  const env = { ...callerEnv };

  const { flags, positionals } = parseCliArgs(argv);
  const rawSub = positionals[0] ? positionals[0].toLowerCase() : null;
  if (flags.help || rawSub === 'help') {
    printHelp(stdout);
    return { exitCode: 0 };
  }

  const subcommand = rawSub === 'start' || rawSub === 'console' ? null : rawSub;
  const envFilePath =
    typeof flags['env-file'] === 'string'
      ? path.resolve(flags['env-file'])
      : path.resolve(io.cwd || process.cwd(), '.env');

  // Explicit `node index.js setup` / `config` / `--setup` subcommand: run interactive wizard one-by-one
  if (subcommand === 'setup' || subcommand === 'config' || flags.setup) {
    // eslint-disable-next-line global-require
    const { runSetupWizard } = require('./src/cli/setupWizard');
    await runSetupWizard({
      envFilePath,
      input: stdin,
      output: stdout,
      autoInstallDeps: io.autoInstallDeps !== false
    });
    if (!flags.start) {
      stdout.write('Setup complete! Run "npm start" anytime to launch NEXUS-20.\n');
      return { exitCode: 0 };
    }
  }

  // Auto-detect interactive terminal launch (`npm start` / `node index.js` with no subcommands)
  const isDaemonLaunch = !subcommand && !flags.checkConfig && !flags.health;
  const hasExplicitSwarmEnv = Object.keys(callerEnv).some(
    (k) => k.startsWith('SWARM_') && callerEnv[k] !== undefined && callerEnv[k] !== ''
  );
  const isInteractive =
    Boolean(io.interactive ?? (stdin.isTTY && stdout.isTTY)) &&
    !flags['no-wizard'] &&
    env.SWARM_NO_WIZARD !== 'true';

  let dotEnv = loadDotEnvFile(envFilePath);

  if (isDaemonLaunch && isInteractive && !hasExplicitSwarmEnv && !flags.role) {
    // eslint-disable-next-line global-require
    const { runSetupWizard, promptQuickStartOrEdit } = require('./src/cli/setupWizard');
    if (!dotEnv.exists) {
      const wiz = await runSetupWizard({
        envFilePath,
        input: stdin,
        output: stdout,
        autoInstallDeps: io.autoInstallDeps !== false
      });
      dotEnv = { exists: true, values: wiz.envVars };
    } else {
      const action = await promptQuickStartOrEdit({
        input: stdin,
        output: stdout,
        savedValues: dotEnv.values
      });
      if (action === 'edit') {
        const wiz = await runSetupWizard({
          envFilePath,
          input: stdin,
          output: stdout,
          autoInstallDeps: io.autoInstallDeps !== false
        });
        dotEnv = { exists: true, values: wiz.envVars };
      }
    }
  }

  // Merge saved `.env` values ONLY when not explicitly overridden in environment
  if (dotEnv.exists) {
    for (const [k, v] of Object.entries(dotEnv.values)) {
      if (env[k] === undefined || (!hasExplicitSwarmEnv && isDaemonLaunch && isInteractive)) {
        env[k] = v;
      }
    }
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
          launchHint: `SWARM_ROLE=worker SWARM_ENV_PROFILE=${config.envProfile} SWARM_MASTER_URL=${masterUrl} SWARM_BOOTSTRAP_TOKEN=${minted.bootstrapToken} SWARM_WORKER_ID=worker-1 SWARM_WORKER_STATE_PATH=./data/worker-1-state.json SWARM_MC_HOST=thebasement-wUr4.aternos.me SWARM_SPAWN_STAGGER_MS=4000 SWARM_BOT_NAME_PREFIX=Nexus SWARM_WORKER_BOT_COUNT=2 npm run start:worker`
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
    if (isInteractive && !flags['no-wizard']) {
      let hasSavedWorkerToken = false;
      try {
        const sp = config.worker?.statePath ? path.resolve(config.worker.statePath) : null;
        if (sp && fs.existsSync(sp)) {
          const saved = JSON.parse(fs.readFileSync(sp, 'utf8'));
          hasSavedWorkerToken = Boolean(saved && saved.workerToken);
        }
      } catch {
        hasSavedWorkerToken = false;
      }

      const hasToken =
        Boolean(config.worker?.workerToken) ||
        hasSavedWorkerToken ||
        Boolean(config.worker?.bootstrapToken);
      const isCrostiniSelfUrl = String(config.worker?.masterUrl || '').includes('100.115.92.');

      if (!hasToken || isCrostiniSelfUrl) {
        // eslint-disable-next-line global-require
        const { promptMissingWorkerEnrollment } = require('./src/cli/setupWizard');
        const filled = await promptMissingWorkerEnrollment({
          envFilePath,
          input: stdin,
          output: stdout,
          currentEnv: env
        });
        Object.assign(env, filled.envVars);
        config = loadConfig(env, fileConfig);
      }
    }

    if (!config.worker?.simulationMode && io.autoInstallDeps !== false && isInteractive) {
      ensureModernMineflayerOnDisk(path.dirname(envFilePath), stdout);
    }

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
    if (isInteractive) {
      const runners = Array.from(worker.bots.values());
      const botNames = runners.map((b) => b.username).join(', ');
      const pendingErr = runners.find((b) => b.lastConnectError)?.lastConnectError || null;
      stdout.write(
        [
          '',
          '============================================================',
          '  NEXUS-20 Worker is LIVE & Enrolled!',
          `  Master Link   : ${config.worker.masterUrl} (${config.worker.workerId})`,
          `  MC Target     : ${config.worker.minecraftHost}:${config.worker.minecraftPort} (MC ${config.worker.minecraftVersion})`,
          `  Active Bots   : ${botNames || started.botCount}`,
          ...(pendingErr
            ? [
                `  MC Status     : Waiting for Minecraft server (${pendingErr})`,
                '                  Auto-retrying in background — keep this window open!'
              ]
            : ['  MC Status     : Connected & spawned in Minecraft!']),
          '  (Press Ctrl+C to disconnect cleanly)',
          '============================================================',
          ''
        ].join('\n')
      );
    }
    worker.logger.info('WorkerHost ready', started);
    return { role: 'worker', instance: worker };
  }

  const master = createMaster(config);
  const startInfo = await master.start({ listenHttp: true });
  let embeddedSimWorker = null;

  // Optional all-in-one local mode (`SWARM_LOCAL_SIM=true` or `SWARM_LOCAL_STANDALONE=true`)
  if (env.SWARM_LOCAL_SIM === 'true' || env.SWARM_LOCAL_STANDALONE === 'true') {
    const isRealStandalone = env.SWARM_LOCAL_STANDALONE === 'true';
    if (isRealStandalone && io.autoInstallDeps !== false && isInteractive) {
      ensureModernMineflayerOnDisk(path.dirname(envFilePath), stdout);
    }
    try {
      const simToken = master.botRegistry.createBootstrapToken({
        createdBy: isRealStandalone ? 'local_standalone' : 'local_sim'
      });
      const connectHost =
        startInfo.host === '0.0.0.0' || startInfo.host === '::' ? '127.0.0.1' : startInfo.host;
      const connectScheme = config.tls.enabled ? 'https' : 'http';
      const localUrl = `${connectScheme}://${connectHost}:${startInfo.port}`;
      const simStatePath = path.join(
        path.dirname(path.resolve(config.storage.sqlitePath)),
        isRealStandalone ? 'local-standalone-worker-state.json' : 'local-sim-worker-state.json'
      );
      const simWorkerCfg = loadConfig({
        ...env,
        SWARM_ROLE: 'worker',
        SWARM_MASTER_URL: localUrl,
        SWARM_WORKER_ID: isRealStandalone ? 'local-worker' : 'local-sim-worker',
        SWARM_WORKER_STATE_PATH: simStatePath,
        SWARM_BOOTSTRAP_TOKEN: simToken.bootstrapToken,
        SWARM_WORKER_SIMULATION: isRealStandalone ? 'false' : 'true',
        SWARM_SPAWN_STAGGER_MS: isRealStandalone
          ? String(env.SWARM_SPAWN_STAGGER_MS || '4500')
          : '150'
      });
      embeddedSimWorker = createWorker(simWorkerCfg);
      await embeddedSimWorker.start();
    } catch (err) {
      if (embeddedSimWorker) await embeddedSimWorker.stop();
      await master.stop();
      throw err;
    }
  }

  let shuttingDown = false;
  const shutdownMaster = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    master.logger.info('Received shutdown signal', { signal: sig });
    if (embeddedSimWorker) await embeddedSimWorker.stop();
    await master.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdownMaster('SIGINT'));
  process.once('SIGTERM', () => shutdownMaster('SIGTERM'));

  const uiHost =
    startInfo.host === '0.0.0.0' || startInfo.host === '::' ? '127.0.0.1' : startInfo.host;
  const uiScheme = config.tls.enabled ? 'https' : 'http';
  const uiUrl = `${uiScheme}://${uiHost}:${startInfo.port}`;

  if (isInteractive) {
    const workers = master.botRegistry.listWorkers();
    let tokenLine = '  Worker Status : Enrolled (' + workers.length + ' worker(s))';
    if (workers.length === 0 && !embeddedSimWorker) {
      const autoToken = master.botRegistry.createBootstrapToken({
        createdBy: 'startup:auto',
        ttlMs: 30 * 60 * 1000
      });
      tokenLine = `  Worker Token  : ${autoToken.bootstrapToken}  (paste into Step 12 on your Worker PC)`;
    }
    enterTerminalAlternateScreen(stdout, stdin.isTTY === true && stdout.isTTY === true);
    stdout.write(
      [
        '',
        '============================================================',
        '  NEXUS-20 Master Controller is LIVE!',
        `  Control Centre: ${uiUrl}`,
        `  MC Target     : ${config.worker.minecraftHost}:${config.worker.minecraftPort} (MC ${config.worker.minecraftVersion}, ${config.envProfile === 'private_offline_test' ? 'Cracked/Offline' : 'Microsoft Online'})`,
        tokenLine,
        '  Command Bar   : Type a command and press [Tab] below (or in the Web UI) to autocomplete!',
        '  (Press Ctrl+C to stop cleanly)',
        '============================================================',
        ''
      ].join('\n')
    );
    if (stdin.isTTY === true && stdout.isTTY === true) {
      startMasterTtyCommandConsole(master, uiUrl, stdin, stdout, shutdownMaster);
    }
  }

  master.logger.info('Master ready', {
    health: await master.health(),
    listen: { host: startInfo.host, port: startInfo.port }
  });
  return { role: 'master', instance: master, embeddedSimWorker };
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
      if (process.env.NEXUS_DEBUG_STARTUP === '1') {
        const stack = err instanceof Error ? err.stack || err.message : String(err);
        process.stderr.write(`[NEXUS_DEBUG_STARTUP] ${stack}\n`);
      }
      const envelope = toErrorEnvelope(err, 'startup');
      process.stderr.write(`${JSON.stringify(envelope.body)}\n`);
      process.exit(1);
    }
  );
}

const { SkinManager } = require('./src/skins/SkinGenerator');
const { SchematicRegistry } = require('./src/schematics/SchematicBuilder');
const { listZeroAiCommands, MASTER_ZERO_AI_CATALOG } = require('./src/commands/ZeroAiCommandDeck');
const {
  buildAutocompleteDictionary,
  getBrigadierCompletions,
  resolveUnifiedCommandExecution,
  createReadlineCompleter
} = require('./src/commands/CommandCompleter');
const { AI_PROVIDER_CATALOG } = require('./src/ai/AiProviderRegistry');
const { CombatAndSurvivalEngine } = require('./src/combat/CombatAndSurvivalEngine');

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
  runCliEntry,
  enterTerminalAlternateScreen,
  SkinManager,
  SchematicRegistry,
  listZeroAiCommands,
  MASTER_ZERO_AI_CATALOG,
  buildAutocompleteDictionary,
  getBrigadierCompletions,
  resolveUnifiedCommandExecution,
  createReadlineCompleter,
  AI_PROVIDER_CATALOG,
  CombatAndSurvivalEngine
};
