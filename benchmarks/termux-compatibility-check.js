'use strict';

/**
 * Termux / Android 16 / Low-Memory Compatibility & Baseline Probe
 *
 * Run on the target Samsung Galaxy A06 (Termux Node 24.17.0) AND in CI:
 *   node benchmarks/termux-compatibility-check.js
 *
 * Verifies platform capabilities without fabricating unavailable metrics (AGENTS.md):
 * - Runtime & V8 heap ceiling (`--max-old-space-size` audit for 4 GB RAM devices)
 * - Android / Termux environment & SELinux `/proc` readability (`/proc/meminfo`, `/proc/stat`, `/proc/loadavg`)
 * - Built-in `node:sqlite` WAL + durable transaction + backup verification (Decision U-03 evidence)
 * - Built-in `node:crypto.scrypt` bounded-memory password KDF verification
 * - Event-loop delay histogram precision (`perf_hooks.monitorEventLoopDelay`)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { readSystemMemory, computePercentiles } = require('../src/monitoring/ResourceMonitor');

function probeProcFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { readable: true, firstLine: content.split('\n')[0].slice(0, 120) };
  } catch (err) {
    return { readable: false, code: err.code || 'ERROR', message: err.message };
  }
}

function probeAndroidProps() {
  const isTermuxEnv = Boolean(
    process.env.TERMUX_VERSION ||
      (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) ||
      process.platform === 'android'
  );
  if (!isTermuxEnv) {
    return {
      isAndroidOrTermux: false,
      termuxVersion: 'not_termux_environment',
      androidRelease: 'unavailable',
      deviceModel: 'unavailable'
    };
  }

  const readProp = (prop) => {
    try {
      return execFileSync('getprop', [prop], { encoding: 'utf8', timeout: 1500 }).trim() || 'unavailable';
    } catch {
      return 'unavailable';
    }
  };

  return {
    isAndroidOrTermux: true,
    termuxVersion: process.env.TERMUX_VERSION || 'unknown',
    prefix: process.env.PREFIX || 'unknown',
    androidRelease: readProp('ro.build.version.release'),
    deviceModel: readProp('ro.product.model')
  };
}

async function probeNodeSqlite() {
  let sqliteMod;
  try {
    sqliteMod = require('node:sqlite');
  } catch (err) {
    return { supported: false, error: err.message };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sqlite-probe-'));
  const dbPath = path.join(tmpDir, 'state.db');
  const backupPath = path.join(tmpDir, 'backup.db');

  try {
    const rssBefore = process.memoryUsage.rss();
    const db = new sqliteMod.DatabaseSync(dbPath);
    const journalRow = db.prepare('PRAGMA journal_mode = WAL').get();
    db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        target_qty INTEGER NOT NULL,
        verified_qty INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const insertStmt = db.prepare(
      'INSERT INTO tasks (task_id, state, target_qty, verified_qty, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const txLatenciesMs = [];

    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      db.exec('BEGIN IMMEDIATE');
      insertStmt.run(`task-${i}`, 'running', 100, i, new Date().toISOString());
      db.exec('COMMIT');
      txLatenciesMs.push(+(performance.now() - t0).toFixed(3));
    }

    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get();

    let backupSupported = false;
    if (typeof sqliteMod.backup === 'function') {
      await sqliteMod.backup(db, backupPath);
      const restored = new sqliteMod.DatabaseSync(backupPath);
      const restoredCount = restored.prepare('SELECT COUNT(*) AS cnt FROM tasks').get();
      backupSupported = restoredCount.cnt === 100;
      restored.close();
    }

    db.close();
    const rssAfter = process.memoryUsage.rss();

    return {
      supported: true,
      sqliteVersion: process.versions.sqlite || 'unknown',
      journalMode: journalRow ? Object.values(journalRow)[0] : 'unknown',
      committedRows: countRow.cnt,
      backupVerified: backupSupported,
      txLatencyMs: computePercentiles(txLatenciesMs),
      rssDeltaKB: Math.round((rssAfter - rssBefore) / 1024)
    };
  } catch (err) {
    return { supported: false, error: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function probeBoundedScrypt() {
  const rssBefore = process.memoryUsage.rss();
  const t0 = performance.now();
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      'correct-horse-battery-staple',
      crypto.randomBytes(16),
      32,
      { N: 16384, r: 8, p: 1, maxmem: 36 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
  const durationMs = +(performance.now() - t0).toFixed(2);
  const rssAfter = process.memoryUsage.rss();
  return {
    supported: derived.byteLength === 32,
    durationMs,
    rssDeltaMB: +((rssAfter - rssBefore) / (1024 * 1024)).toFixed(2)
  };
}

async function probeEventLoopHistogram() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await new Promise((r) => setTimeout(r, 60));
  const result = {
    supported: h.count > 0,
    samples: h.count,
    p50Ms: +(h.percentile(50) / 1e6).toFixed(2),
    p95Ms: +(h.percentile(95) / 1e6).toFixed(2)
  };
  h.disable();
  return result;
}

async function main() {
  const heapStats = v8.getHeapStatistics();
  const heapLimitMB = Math.round(heapStats.heap_size_limit / (1024 * 1024));
  const sysMem = readSystemMemory();
  const androidInfo = probeAndroidProps();

  const report = {
    checkedAt: new Date().toISOString(),
    runtime: {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      sqliteVersion: process.versions.sqlite || 'unavailable',
      opensslVersion: process.versions.openssl,
      platform: process.platform,
      arch: process.arch,
      cpuParallelism:
        typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : (os.cpus() || []).length,
      v8HeapSizeLimitMB: heapLimitMB,
      recommendedMasterNodeFlags: '--max-old-space-size=256',
      heapLimitAdvisory:
        heapLimitMB > 512
          ? `V8 default heap_size_limit is ${heapLimitMB} MiB. On a 4 GB Android/Termux controller, set NODE_OPTIONS="--max-old-space-size=256" so V8 GCs proactively before Android lmkd SIGKILLs Termux.`
          : 'V8 heap limit is appropriately bounded for a 4 GB controller.'
    },
    androidTermux: androidInfo,
    procFilesystem: {
      meminfo: probeProcFile('/proc/meminfo'),
      stat: probeProcFile('/proc/stat'),
      loadavg: probeProcFile('/proc/loadavg'),
      selfStatus: probeProcFile('/proc/self/status')
    },
    systemMemory: {
      totalMB:
        typeof sysMem.totalBytes === 'number'
          ? +(sysMem.totalBytes / (1024 * 1024)).toFixed(1)
          : 'unavailable',
      availableMB:
        typeof sysMem.availableBytes === 'number'
          ? +(sysMem.availableBytes / (1024 * 1024)).toFixed(1)
          : 'unavailable',
      source: sysMem.source
    },
    probes: {
      nodeSqlite: await probeNodeSqlite(),
      cryptoScrypt: await probeBoundedScrypt(),
      eventLoopDelay: await probeEventLoopHistogram()
    }
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
