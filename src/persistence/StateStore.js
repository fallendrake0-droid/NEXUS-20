'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { DomainError, isDomainError } = require('../errors/DomainError');

const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  mfa_secret_enc TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);

CREATE TABLE IF NOT EXISTS worker_bootstrap_tokens (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_worker_id TEXT
);

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  token_verifier_hash TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('alive', 'degraded', 'unreachable', 'disabled')),
  max_bot_slots INTEGER NOT NULL CHECK (max_bot_slots >= 0),
  last_heartbeat_at TEXT,
  last_command_seq INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS bots (
  bot_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  server_id TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('online_microsoft', 'private_offline_test')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  connection_state TEXT NOT NULL CHECK (connection_state IN ('disconnected', 'connecting', 'ready', 'degraded')),
  compact_snapshot_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  actor_id TEXT NOT NULL,
  source_interface TEXT NOT NULL CHECK (source_interface IN ('dashboard', 'cli', 'chat')),
  raw_text TEXT NOT NULL,
  intent_summary TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'planning', 'clarification_required', 'ready', 'running',
    'paused', 'blocked', 'completed', 'failed', 'cancelled'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('survival', 'safety', 'high', 'normal', 'low')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  plan_version INTEGER NOT NULL DEFAULT 0,
  clarification_question TEXT,
  pause_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objectives (
  objective_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'mine', 'collect', 'craft', 'build', 'explore', 'guard', 'transfer', 'repair', 'inspect'
  )),
  resource_id TEXT,
  target_quantity INTEGER CHECK (target_quantity IS NULL OR (target_quantity BETWEEN 1 AND 1000000)),
  verified_quantity INTEGER NOT NULL DEFAULT 0 CHECK (verified_quantity >= 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  region_label TEXT,
  description TEXT NOT NULL,
  parallelism TEXT NOT NULL CHECK (parallelism IN ('single', 'partitionable', 'spatial', 'role_based', 'serial')),
  worker_count_hint INTEGER NOT NULL DEFAULT 1 CHECK (worker_count_hint BETWEEN 1 AND 20),
  verification_policy TEXT NOT NULL CHECK (verification_policy IN (
    'newly_collected', 'held_stock', 'deposited_stock', 'crafted_output',
    'block_state', 'region_visited', 'role_duration', 'operator_review'
  )),
  constraints_json TEXT NOT NULL,
  allocation_epoch INTEGER NOT NULL DEFAULT 1 CHECK (allocation_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'ready', 'assigned', 'running', 'verifying', 'completed', 'blocked', 'failed', 'cancelled'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (task_id, local_id),
  CHECK (target_quantity IS NULL OR verified_quantity + reserved_quantity <= target_quantity)
);

CREATE TABLE IF NOT EXISTS objective_dependencies (
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  depends_on_objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL DEFAULT 'finish_to_start' CHECK (edge_type IN ('finish_to_start', 'start_with')),
  PRIMARY KEY (objective_id, depends_on_objective_id),
  CHECK (objective_id <> depends_on_objective_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id),
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  allocation_epoch INTEGER NOT NULL CHECK (allocation_epoch >= 1),
  lease_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'offered', 'accepted', 'running', 'reporting', 'verifying', 'completed', 'failed', 'revoked', 'expired'
  )),
  action_type TEXT NOT NULL,
  item_key TEXT,
  quota_quantity INTEGER CHECK (quota_quantity IS NULL OR quota_quantity >= 1),
  credited_quantity INTEGER NOT NULL DEFAULT 0 CHECK (credited_quantity >= 0),
  baseline_quantity INTEGER,
  baseline_snapshot_json TEXT,
  scope_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  lease_ttl_ms INTEGER NOT NULL DEFAULT 30000 CHECK (lease_ttl_ms BETWEEN 3000 AND 120000),
  failure_code TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (quota_quantity IS NULL OR credited_quantity <= quota_quantity)
);

CREATE TABLE IF NOT EXISTS command_outbox (
  command_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  command_sequence INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  acked_at TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (worker_id, command_sequence)
);

CREATE TABLE IF NOT EXISTS worker_inbound_messages (
  message_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  worker_sequence INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (worker_id, worker_sequence)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  transaction_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  transfer_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  item_key TEXT,
  delta_quantity INTEGER NOT NULL,
  policy TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  transfer_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  sender_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  receiver_bot_id TEXT REFERENCES bots(bot_id),
  item_key TEXT NOT NULL,
  sent_quantity INTEGER NOT NULL CHECK (sent_quantity >= 1),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  state TEXT NOT NULL CHECK (state IN ('in_flight', 'completed', 'timed_out_disputed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_decisions (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  allocation_epoch INTEGER NOT NULL,
  selected_bot_ids_json TEXT NOT NULL,
  quotas_json TEXT NOT NULL,
  single_bot_p90_sec REAL,
  selected_subset_p90_sec REAL,
  marginal_gain REAL,
  decision_reason TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_rate_samples (
  sample_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  action_key TEXT NOT NULL,
  tool_class TEXT,
  bot_id TEXT NOT NULL,
  units_completed REAL NOT NULL CHECK (units_completed >= 0),
  duration_sec REAL NOT NULL CHECK (duration_sec > 0),
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_knowledge (
  knowledge_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'resource_location', 'structure', 'storage_location', 'route',
    'explored_area', 'hazard', 'mining_location', 'base_location',
    'strategy', 'worker_capability'
  )),
  dimension TEXT NOT NULL DEFAULT 'minecraft:overworld',
  subject_key TEXT NOT NULL,
  x INTEGER,
  y INTEGER,
  z INTEGER,
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  verification_state TEXT NOT NULL DEFAULT 'observed' CHECK (verification_state IN ('observed', 'verified', 'disputed', 'invalidated')),
  reported_by_bot_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_locks (
  storage_key TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  holder_bot_id TEXT NOT NULL,
  assignment_id TEXT,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_state_created ON tasks(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_objectives_task_state ON objectives(task_id, state);
CREATE INDEX IF NOT EXISTS idx_assignments_obj_state ON assignments(objective_id, state);
CREATE INDEX IF NOT EXISTS idx_assignments_bot_active ON assignments(bot_id, state);
CREATE INDEX IF NOT EXISTS idx_assignments_expires ON assignments(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_commands_worker_seq ON command_outbox(worker_id, acked_at, command_sequence);
CREATE INDEX IF NOT EXISTS idx_rate_lookup ON action_rate_samples(server_id, dimension, action_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger_transactions(task_id);
CREATE INDEX IF NOT EXISTS idx_ledger_objective ON ledger_transactions(objective_id);
CREATE INDEX IF NOT EXISTS idx_ledger_assignment ON ledger_transactions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_inbound_received ON worker_inbound_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_transfers_state_expires ON transfers(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_cat_exp ON world_knowledge(category, expires_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_dim_subj ON world_knowledge(dimension, subject_key);
CREATE INDEX IF NOT EXISTS idx_storage_locks_exp ON storage_locks(expires_at);
`;

/**
 * Authoritative Single-Writer SQLite State Manager (`StateStore` / `StateManager`).
 * Encapsulates `node:sqlite` (`DatabaseSync`) with Galaxy A06 eMMC WAL tuning,
 * nested-safe `SAVEPOINT` transactions, verified atomic backups, and bounded table pruning.
 */
class StateStore {
  /**
   * @param {object} options
   * @param {string} [options.sqlitePath=':memory:']
   * @param {import('../monitoring/ResourceMonitor').ResourceMonitor} [options.monitor=null]
   * @param {object} [options.logger=null]
   */
  constructor(options = {}) {
    this._sqlitePath = options.sqlitePath || ':memory:';
    this._monitor = options.monitor || null;
    this._logger = options.logger || null;
    this._db = null;
    this._txDepth = 0;
    this._stmtCache = new Map();
  }

  get isOpen() {
    return this._db !== null;
  }

  open() {
    if (this._db) return this;
    try {
      if (this._sqlitePath !== ':memory:') {
        const dir = path.dirname(this._sqlitePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      this._db = new sqlite.DatabaseSync(this._sqlitePath);

      // Reconciled Galaxy A06 eMMC 5.1 WAL & memory-cap pragmas (HIGH-04)
      this._db.exec('PRAGMA foreign_keys = ON;');
      if (this._sqlitePath !== ':memory:') {
        this._db.exec('PRAGMA journal_mode = WAL;');
      }
      this._db.exec('PRAGMA synchronous = NORMAL;');
      this._db.exec('PRAGMA busy_timeout = 3000;');
      this._db.exec('PRAGMA wal_autocheckpoint = 500;');
      this._db.exec('PRAGMA journal_size_limit = 8388608;');
      this._db.exec('PRAGMA temp_store = MEMORY;');
      this._db.exec('PRAGMA cache_size = -4096;');

      this.migrate();
      this._logger?.info('StateStore opened and migrated', { sqlitePath: this._sqlitePath });
      return this;
    } catch (err) {
      if (isDomainError(err)) throw err;
      throw new DomainError(
        'PERSISTENCE_ERROR',
        `Failed to open SQLite StateStore at ${this._sqlitePath}: ${err.message}`,
        { cause: err }
      );
    }
  }

  close() {
    if (!this._db) return;
    try {
      this._stmtCache.clear();
      this._db.close();
      this._db = null;
    } catch (err) {
      this._db = null;
      throw new DomainError('PERSISTENCE_ERROR', `Failed to close StateStore: ${err.message}`, {
        cause: err
      });
    }
  }

  _requireDb() {
    if (!this._db) {
      throw new DomainError('PERSISTENCE_ERROR', 'StateStore is not open');
    }
    return this._db;
  }

  prepare(sql) {
    const db = this._requireDb();
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (this._stmtCache.size < 256) {
        this._stmtCache.set(sql, stmt);
      }
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params) || null;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  migrate() {
    const db = this._requireDb();
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);'
    );
    const current = this.get('SELECT MAX(version) AS v FROM schema_migrations');
    const currentVersion = current && typeof current.v === 'number' ? current.v : 0;

    if (currentVersion < 1) {
      this.transaction(() => {
        db.exec(MIGRATION_V1_SQL);
        this.run(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          1,
          new Date().toISOString()
        );
      });
    }
  }

  /**
   * Execute `fn` atomically inside `BEGIN IMMEDIATE` (or nested `SAVEPOINT`).
   * Never execute network I/O inside `fn` — synchronous DB operations only.
   */
  transaction(fn) {
    const db = this._requireDb();
    const startNs = process.hrtime.bigint();
    const depth = this._txDepth;
    const spName = `sp_${depth}`;
    this._txDepth += 1;

    try {
      if (depth === 0) {
        db.exec('BEGIN IMMEDIATE;');
      } else {
        db.exec(`SAVEPOINT ${spName};`);
      }

      const result = fn(this);

      if (result && typeof result.then === 'function') {
        throw new DomainError(
          'INTERNAL_ERROR',
          'StateStore.transaction callback must be synchronous (no async network I/O inside SQLite lock)'
        );
      }

      if (depth === 0) {
        db.exec('COMMIT;');
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        this._monitor?.recordDbLatency(elapsedMs);
      } else {
        db.exec(`RELEASE SAVEPOINT ${spName};`);
      }
      return result;
    } catch (err) {
      try {
        if (depth === 0) {
          db.exec('ROLLBACK;');
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT ${spName}; RELEASE SAVEPOINT ${spName};`);
        }
      } catch {
        // Ignore rollback secondary error
      }
      if (isDomainError(err)) throw err;
      throw new DomainError('PERSISTENCE_ERROR', `SQLite transaction failed: ${err.message}`, {
        cause: err
      });
    } finally {
      this._txDepth = Math.max(0, this._txDepth - 1);
    }
  }

  /**
   * Perform an online SQLite backup and verify integrity of the destination file.
   */
  async backup(destPath) {
    const db = this._requireDb();
    if (!destPath || destPath === ':memory:') {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'backup destPath must be a filesystem path');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
    await sqlite.backup(db, destPath);
    try {
      fs.chmodSync(destPath, 0o600);
    } catch {
      // Best-effort chmod on non-POSIX filesystems
    }
    const check = this.verifyBackup(destPath);
    if (!check.valid) {
      throw new DomainError('PERSISTENCE_ERROR', `Backup integrity check failed: ${check.reason}`);
    }
    return { destPath, verified: true, backedUpAt: new Date().toISOString() };
  }

  verifyBackup(backupPath) {
    let copyDb = null;
    try {
      copyDb = new sqlite.DatabaseSync(backupPath, { readOnly: true });
      const row = copyDb.prepare('PRAGMA integrity_check;').get();
      const ok = row && (row.integrity_check === 'ok' || Object.values(row)[0] === 'ok');
      const mig = copyDb.prepare('SELECT MAX(version) AS v FROM schema_migrations;').get();
      return {
        valid: Boolean(ok && mig && mig.v >= 1),
        schemaVersion: mig ? mig.v : 0,
        reason: ok ? null : 'integrity_check_failed'
      };
    } catch (err) {
      return { valid: false, schemaVersion: 0, reason: err.message };
    } finally {
      try {
        copyDb?.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Bounded maintenance job pruning acked outbox, stale dedup rows and WAL size (HIGH-04).
   */
  pruneMaintenance({
    dedupRetentionIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    ackedOutboxRetentionIso = new Date(Date.now() - 3600 * 1000).toISOString()
  } = {}) {
    const db = this._requireDb();
    const nowIso = new Date().toISOString();
    const counts = this.transaction(() => {
      const r1 = this.run(
        'DELETE FROM worker_inbound_messages WHERE received_at < ?',
        dedupRetentionIso
      );
      const r2 = this.run(
        'DELETE FROM command_outbox WHERE acked_at IS NOT NULL AND acked_at < ?',
        ackedOutboxRetentionIso
      );
      const r3 = this.run(
        'DELETE FROM sessions WHERE revoked = 1 OR idle_expires_at <= ? OR absolute_expires_at <= ?',
        nowIso,
        nowIso
      );
      const r4 = this.run(
        'DELETE FROM world_knowledge WHERE expires_at <= ? OR verification_state = ?',
        nowIso,
        'invalidated'
      );
      const r5 = this.run('DELETE FROM storage_locks WHERE expires_at <= ?', nowIso);
      return {
        prunedInboundMessages: Number(r1.changes || 0),
        prunedOutboxCommands: Number(r2.changes || 0),
        prunedSessions: Number(r3.changes || 0),
        prunedWorldKnowledge: Number(r4.changes || 0),
        prunedStorageLocks: Number(r5.changes || 0)
      };
    });
    if (this._sqlitePath !== ':memory:') {
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE);');
      } catch {
        // Non-fatal if reader active
      }
    }
    return counts;
  }

  getSetting(settingKey, defaultValue = null) {
    if (!this._db) return defaultValue;
    const row = this.get(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      String(settingKey)
    );
    return row ? row.setting_value : defaultValue;
  }

  setSetting(settingKey, settingValue, updatedAt = new Date().toISOString()) {
    this.run(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`,
      String(settingKey),
      String(settingValue),
      updatedAt
    );
  }

  recordAudit({ auditId, occurredAt, actorType, actorId, action, targetId = null, outcome, details = {} }) {
    const id = auditId || require('node:crypto').randomUUID();
    const ts = occurredAt || new Date().toISOString();
    this.run(
      `INSERT INTO audit_events (audit_id, occurred_at, actor_type, actor_id, action, target_id, outcome, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ts,
      String(actorType || 'system'),
      String(actorId || 'system'),
      String(action),
      targetId ? String(targetId) : null,
      String(outcome || 'ok'),
      JSON.stringify(details || {})
    );
  }

  health() {
    if (!this._db) {
      return { status: 'closed', sqlitePath: this._sqlitePath };
    }
    try {
      const row = this.get('SELECT MAX(version) AS v FROM schema_migrations');
      return {
        status: 'healthy',
        sqlitePath: this._sqlitePath,
        schemaVersion: row ? row.v : 0
      };
    } catch (err) {
      return { status: 'error', sqlitePath: this._sqlitePath, error: err.message };
    }
  }
}

module.exports = {
  StateStore,
  StateManager: StateStore
};
