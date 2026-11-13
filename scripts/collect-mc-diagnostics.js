'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns').promises;
const net = require('node:net');
const { loadDotEnvFile } = require('../src/config/envFile');
const { parseMinecraftEndpoint } = require('../src/config/loadConfig');

const ROOT = path.resolve(__dirname, '..');
const DOTENV_PATH = path.join(ROOT, '.env');
const TCP_TIMEOUT_MS = 4_000;

function parseArgs(argv) {
  const args = { logFile: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--log-file' && argv[i + 1]) args.logFile = argv[++i];
    else if (argv[i].startsWith('--log-file=')) args.logFile = argv[i].slice('--log-file='.length);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function effectiveValue(env, key, fallback = '') {
  return process.env[key] !== undefined ? process.env[key] : env[key] !== undefined ? env[key] : fallback;
}

function redactedTail(filePath) {
  const resolved = path.resolve(filePath);
  let text;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return '[Not a regular file; skipped]';
    const fd = fs.openSync(resolved, 'r');
    try {
      const size = Math.min(stat.size, 32 * 1024);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `[Could not read the supplied log file: ${err.code || 'read_error'}]`;
  }

  const tail = text.split(/\r?\n/).slice(-100).join('\n');
  return tail
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:authorization|(?:swarm_)?(?:bootstrap_)?token|password|secret|api[_-]?key|credential)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .slice(-16_000);
}

function dnsLookup(host) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS lookup timed out after 4s')), 4_000);
    dns.lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () => finish({ ok: false, reason: `timeout after ${TCP_TIMEOUT_MS}ms` }));
    socket.once('connect', () => finish({ ok: true, remoteAddress: socket.remoteAddress || null }));
    socket.once('error', (err) => finish({ ok: false, reason: `${err.code || 'network_error'}: ${err.message}` }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'NEXUS-20 Minecraft connection diagnostic collector\n\n' +
      'Run from the NEXUS-20 repository directory:\n' +
      '  node scripts/collect-mc-diagnostics.js\n\n' +
      'Optionally include the tail of a saved worker console log (review it before sharing):\n' +
      '  node scripts/collect-mc-diagnostics.js --log-file ./worker.log\n'
    );
    return;
  }

  const dotenv = loadDotEnvFile(DOTENV_PATH);
  const env = dotenv.values;
  const rawHost = effectiveValue(env, 'SWARM_MC_HOST', '127.0.0.1');
  const rawPort = effectiveValue(env, 'SWARM_MC_PORT', undefined);
  const endpoint = parseMinecraftEndpoint(rawHost, rawPort, 25565);
  const host = endpoint.host.replace(/^\[|\]$/g, '');
  const port = endpoint.port;
  const prefix = String(effectiveValue(env, 'SWARM_BOT_NAME_PREFIX', 'Nexus')).replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'Nexus';
  const count = Math.max(1, Math.min(20, Number.parseInt(effectiveValue(env, 'SWARM_WORKER_BOT_COUNT', '2'), 10) || 2));
  const start = Math.max(1, Math.min(20, Number.parseInt(effectiveValue(env, 'SWARM_WORKER_BOT_START_INDEX', '1'), 10) || 1));
  const explicitBots = String(effectiveValue(env, 'SWARM_WORKER_BOTS', '')).split(',').map((x) => x.trim()).filter(Boolean);
  const botNames = explicitBots.length
    ? explicitBots.map((entry) => entry.split(':').slice(1).join(':') || entry).slice(0, 20)
    : Array.from({ length: count }, (_, i) => `${prefix}_${String(start + i).padStart(2, '0')}`.slice(0, 16));

  let dnsResult;
  try {
    const records = await dnsLookup(host);
    dnsResult = records.map((record) => `${record.address} (IPv${record.family})`);
  } catch (err) {
    dnsResult = [`FAILED: ${err.code ? `${err.code}: ` : ''}${err.message}`];
  }

  const tcpResult = await tcpProbe(host, port);
  const report = [
    '=== NEXUS-20 Minecraft connection diagnostics ===',
    `Generated UTC: ${new Date().toISOString()}`,
    `App version: ${require('../package.json').version}`,
    `OS: ${os.type()} ${os.release()} (${os.arch()})`,
    `Node.js: ${process.version}`,
    `Repository .env found: ${dotenv.exists ? 'yes' : 'no (using defaults and process environment)'}`,
    '',
    '[Configuration (secrets intentionally omitted)]',
    `Runtime role: ${effectiveValue(env, 'SWARM_ROLE', 'master')}`,
    `Deployment mode: ${effectiveValue(env, 'SWARM_LOCAL_STANDALONE', 'false') === 'true' ? 'standalone (Master + real bots on this machine)' : effectiveValue(env, 'SWARM_LOCAL_SIM', 'false') === 'true' ? 'local simulation' : effectiveValue(env, 'SWARM_ROLE', 'master')}`,
    `Environment profile: ${effectiveValue(env, 'SWARM_ENV_PROFILE', 'authorised_online')}`,
    `Worker ID: ${effectiveValue(env, 'SWARM_WORKER_ID', 'worker-1')}`,
    `Minecraft target: ${host}:${port}`,
    `Configured Minecraft version: ${effectiveValue(env, 'SWARM_MC_VERSION', '26.2')}`,
    `Authentication mode: ${effectiveValue(env, 'SWARM_MC_AUTH_MODE', effectiveValue(env, 'SWARM_ENV_PROFILE', 'authorised_online') === 'private_offline_test' ? 'private_offline_test' : 'online_microsoft')}`,
    `Simulation mode: ${effectiveValue(env, 'SWARM_WORKER_SIMULATION', 'false')}`,
    `Spawn stagger: ${effectiveValue(env, 'SWARM_SPAWN_STAGGER_MS', '4500')} ms`,
    `Configured bot usernames: ${botNames.join(', ')}`,
    '',
    '[Network check from this device; this does NOT log a bot in]',
    `DNS: ${dnsResult.join('; ')}`,
    `TCP ${host}:${port}: ${tcpResult.ok ? `CONNECTED${tcpResult.remoteAddress ? ` (resolved address ${tcpResult.remoteAddress})` : ''}` : `FAILED (${tcpResult.reason})`}`,
    'Note: TCP success only proves the port accepted a connection at this moment; it does not prove Minecraft login, protocol, or server plugin behavior.',
    ''
  ];

  if (args.logFile) {
    report.push('[Optional saved console log tail; last 100 lines, token-like values redacted]');
    report.push(redactedTail(args.logFile));
    report.push('');
  } else {
    report.push('[Console log] Not included. If available, re-run with --log-file PATH to include a saved worker log.');
    report.push('');
  }
  report.push('Review this report before sharing. It contains the Minecraft server hostname/IP, bot usernames, and may include console text if a log file was supplied. No passwords, auth tokens, or .env secrets are intentionally included.');
  process.stdout.write(`${report.join('\n')}\n`);
}

main().catch((err) => {
  process.stderr.write(`Diagnostic collector failed: ${err.message}\n`);
  process.exitCode = 1;
});
