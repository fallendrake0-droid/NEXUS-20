'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DomainError } = require('../errors/DomainError');
const { toCompactBotSnapshot } = require('../performance/CompactSnapshotCodec');

const DEFAULT_SUPPORTED_ACTIONS = Object.freeze([
  'mine',
  'collect',
  'craft',
  'build',
  'explore',
  'guard',
  'transfer',
  'repair',
  'inspect'
]);

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string' || hexA.length !== hexB.length) {
    return false;
  }
  const bufA = Buffer.from(hexA, 'hex');
  const bufB = Buffer.from(hexB, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authoritative Distributed Worker & Bot Registry (`BotRegistry` / `WorkerRegistry`).
 *
 * Enforces:
 * - Hard global ceiling of `<= 20` enabled bot identities across all workers (`G-02`).
 * - Single-use TTL bootstrap tokens (`SHA-256` verifier only in SQLite).
 * - Constant-time `crypto.timingSafeEqual` worker bearer token verification (`G-11`).
 * - Legitimate auth mode guard (`private_offline_test` rejected when `envProfile === 'authorised_online'`).
 * - Heartbeat liveness transitions (`alive -> degraded -> unreachable`) & capability derivation.
 */
class BotRegistry extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {object} options.config
   * @param {object} [options.logger]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    super();
    if (!options.stateStore) {
      throw new TypeError('BotRegistry requires stateStore');
    }
    this._store = options.stateStore;
    this._config = options.config || {
      envProfile: 'authorised_online',
      capacity: {
        globalMaxBots: 20,
        initialEnabledBots: 2,
        heartbeatIntervalMs: 5_000,
        defaultLeaseDurationMs: 30_000
      },
      security: { bootstrapTokenTtlMs: 10 * 60 * 1000 }
    };
    this._logger = options.logger || null;
    this._now = options.now || Date.now;
    this._enabledBotsCap = Math.min(
      this._config.capacity?.globalMaxBots ?? 20,
      this._config.capacity?.initialEnabledBots ?? 2
    );
  }

  get enabledBotsCap() {
    return this._enabledBotsCap;
  }

  setEnabledBotsCap(newCap) {
    const globalMax = this._config.capacity?.globalMaxBots ?? 20;
    if (!Number.isSafeInteger(newCap) || newCap < 1 || newCap > globalMax) {
      throw new DomainError(
        'GLOBAL_BOT_CAP_EXCEEDED',
        `enabledBotsCap must be an integer in 1..${globalMax}`
      );
    }
    this._enabledBotsCap = newCap;
  }

  /**
   * Mint a single-use short-lived bootstrap token (`SHA-256` stored; raw returned once).
   */
  createBootstrapToken({ createdBy = 'admin', ttlMs } = {}) {
    const effectiveTtl = Math.min(
      3_600_000,
      Math.max(5_000, Math.trunc(ttlMs ?? this._config.security?.bootstrapTokenTtlMs ?? 600_000))
    );
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    const nowMs = this._now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + effectiveTtl).toISOString();

    this._store.transaction(() => {
      this._store.run(
        `INSERT INTO worker_bootstrap_tokens (token_hash, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        tokenHash,
        String(createdBy),
        createdAt,
        expiresAt
      );
      this._store.recordAudit({
        occurredAt: createdAt,
        actorType: 'admin',
        actorId: String(createdBy),
        action: 'worker.bootstrap_created',
        outcome: 'ok',
        details: { expiresAt }
      });
    });

    return { bootstrapToken: rawToken, expiresAt };
  }

  /**
   * Consume a bootstrap token and register an authorised `WorkerHost` + its configured bots.
   */
  register({ bootstrapToken, workerInfo }) {
    if (!bootstrapToken || typeof bootstrapToken !== 'string') {
      throw new DomainError('UNAUTHENTICATED', 'Missing bootstrapToken');
    }
    if (!workerInfo || typeof workerInfo !== 'object') {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'workerInfo must be an object');
    }

    const workerId = String(workerInfo.workerId || '').trim();
    const hostname = String(workerInfo.hostname || '').trim();
    const maxBotSlots = Math.trunc(workerInfo.maxBotSlots ?? 0);
    const configuredBots = Array.isArray(workerInfo.configuredBots) ? workerInfo.configuredBots : [];

    if (!workerId || workerId.length > 64 || !hostname) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'workerId and hostname are required');
    }
    if (!Number.isSafeInteger(maxBotSlots) || maxBotSlots < 0 || maxBotSlots > 20) {
      throw new DomainError('GLOBAL_BOT_CAP_EXCEEDED', 'maxBotSlots must be between 0 and 20');
    }
    if (configuredBots.length > maxBotSlots) {
      throw new DomainError(
        'CAPACITY_EXCEEDED',
        `configuredBots (${configuredBots.length}) exceeds worker maxBotSlots (${maxBotSlots})`
      );
    }

    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();
    const tokenHash = sha256Hex(bootstrapToken);
    const globalMax = this._config.capacity?.globalMaxBots ?? 20;

    return this._store.transaction(() => {
      const bootRow = this._store.get(
        'SELECT * FROM worker_bootstrap_tokens WHERE token_hash = ?',
        tokenHash
      );
      if (!bootRow || bootRow.consumed_at !== null || Date.parse(bootRow.expires_at) <= nowMs) {
        this._store.recordAudit({
          occurredAt: nowIso,
          actorType: 'worker',
          actorId: workerId,
          action: 'worker.bootstrap_rejected',
          outcome: 'denied',
          details: { reason: !bootRow ? 'not_found' : bootRow.consumed_at ? 'replayed' : 'expired' }
        });
        throw new DomainError('UNAUTHENTICATED', 'Invalid, expired, or already-consumed bootstrapToken');
      }

      // Enforce legitimate auth profile rule (MASTER_SPEC.md §2 rule 8)
      for (const b of configuredBots) {
        if (!b || !b.botId || !b.username || !b.serverId) {
          throw new DomainError('SCHEMA_VALIDATION_FAILED', 'Each bot requires botId, username and serverId');
        }
        const authMode = b.authMode || 'online_microsoft';
        if (authMode !== 'online_microsoft' && authMode !== 'private_offline_test') {
          throw new DomainError('SCHEMA_VALIDATION_FAILED', `Invalid bot authMode: ${authMode}`);
        }
        if (this._config.envProfile === 'authorised_online' && authMode === 'private_offline_test') {
          throw new DomainError(
            'FORBIDDEN',
            `Offline bot ${b.botId} is forbidden when envProfile is authorised_online`
          );
        }
      }

      // Check global 20-bot identity ceiling across all non-disabled workers (excluding bots already owned by this workerId on re-enrollment)
      const countRow = this._store.get(
        `SELECT COUNT(*) AS cnt
         FROM bots b
         JOIN workers w ON w.worker_id = b.worker_id
         WHERE b.enabled = 1 AND w.status <> 'disabled' AND b.worker_id <> ?`,
        workerId
      );
      const existingOtherBots = Number(countRow?.cnt || 0);
      if (existingOtherBots + configuredBots.length > globalMax) {
        throw new DomainError(
          'GLOBAL_BOT_CAP_EXCEEDED',
          `Registering ${configuredBots.length} bots would exceed global ceiling of ${globalMax} (currently ${existingOtherBots})`
        );
      }

      // Mark bootstrap token consumed
      this._store.run(
        `UPDATE worker_bootstrap_tokens
         SET consumed_at = ?, consumed_by_worker_id = ?
         WHERE token_hash = ?`,
        nowIso,
        workerId,
        tokenHash
      );

      const rawWorkerToken = crypto.randomBytes(32).toString('base64url');
      const verifierHash = sha256Hex(rawWorkerToken);

      const existingWorker = this._store.get('SELECT * FROM workers WHERE worker_id = ?', workerId);
      if (existingWorker) {
        this._store.run(
          `UPDATE workers
           SET token_verifier_hash = ?, hostname = ?, status = 'alive', max_bot_slots = ?,
               last_heartbeat_at = ?, revoked_at = NULL
           WHERE worker_id = ?`,
          verifierHash,
          hostname,
          maxBotSlots,
          nowIso,
          workerId
        );
      } else {
        this._store.run(
          `INSERT INTO workers (
            worker_id, token_verifier_hash, hostname, status, max_bot_slots,
            last_heartbeat_at, last_command_seq, last_event_seq, registered_at, revoked_at
          ) VALUES (?, ?, ?, 'alive', ?, ?, 0, 0, ?, NULL)`,
          workerId,
          verifierHash,
          hostname,
          maxBotSlots,
          nowIso,
          nowIso
        );
      }

      const acceptedBotIds = [];
      for (const b of configuredBots) {
        const botId = String(b.botId).trim();
        const existingBot = this._store.get('SELECT * FROM bots WHERE bot_id = ?', botId);
        if (existingBot && existingBot.worker_id !== workerId) {
          throw new DomainError(
            'CONFLICT',
            `Bot identity ${botId} is already bound to another worker (${existingBot.worker_id})`
          );
        }
        const authMode = b.authMode || 'online_microsoft';
        if (existingBot) {
          this._store.run(
            `UPDATE bots
             SET username = ?, server_id = ?, auth_mode = ?, enabled = 1, updated_at = ?
             WHERE bot_id = ?`,
            String(b.username),
            String(b.serverId),
            authMode,
            nowIso,
            botId
          );
        } else {
          this._store.run(
            `INSERT INTO bots (
              bot_id, worker_id, username, server_id, auth_mode, enabled, connection_state, compact_snapshot_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'disconnected', NULL, ?)`,
            botId,
            workerId,
            String(b.username),
            String(b.serverId),
            authMode,
            nowIso
          );
        }
        acceptedBotIds.push(botId);
      }

      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: 'worker',
        actorId: workerId,
        action: 'worker.registered',
        targetId: workerId,
        outcome: 'ok',
        details: { hostname, maxBotSlots, acceptedBotIds }
      });

      this.emit('worker.registered', { workerId, hostname, acceptedBotIds });

      return {
        schemaVersion: 1,
        workerId,
        workerToken: rawWorkerToken,
        heartbeatIntervalMs: this._config.capacity?.heartbeatIntervalMs ?? 5_000,
        leaseDurationMs: this._config.capacity?.defaultLeaseDurationMs ?? 30_000,
        maxEventBatchSize: 100,
        acceptedBotIds
      };
    });
  }

  /**
   * Constant-time worker credential verification (`SECURITY_PLAN.md` §3).
   */
  verifyWorkerToken(workerId, rawToken) {
    if (!workerId || !rawToken) {
      throw new DomainError('UNAUTHENTICATED', 'Missing worker credentials');
    }
    const row = this._store.get('SELECT * FROM workers WHERE worker_id = ?', String(workerId));
    if (!row || row.status === 'disabled' || row.revoked_at !== null) {
      throw new DomainError('UNAUTHENTICATED', 'Worker is unknown or revoked');
    }
    const candidateHash = sha256Hex(rawToken);
    if (!timingSafeHexEqual(row.token_verifier_hash, candidateHash)) {
      throw new DomainError('UNAUTHENTICATED', 'Invalid worker token');
    }

    const botRows = this._store.all(
      'SELECT bot_id FROM bots WHERE worker_id = ? AND enabled = 1',
      row.worker_id
    );
    return {
      workerId: row.worker_id,
      hostname: row.hostname,
      status: row.status,
      maxBotSlots: row.max_bot_slots,
      lastEventSeq: row.last_event_seq,
      allowedBotIds: botRows.map((b) => b.bot_id)
    };
  }

  /**
   * Process authenticated worker heartbeat, sanitize bot snapshots, and renew active leases.
   */
  heartbeat(workerId, payload = {}, options = {}) {
    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseDurationMs = this._config.capacity?.defaultLeaseDurationMs ?? 30_000;
    const pinnedItemKeys = options.pinnedItemKeys || [];

    return this._store.transaction(() => {
      const worker = this._store.get('SELECT * FROM workers WHERE worker_id = ?', workerId);
      if (!worker || worker.status === 'disabled' || worker.revoked_at !== null) {
        throw new DomainError('UNAUTHENTICATED', 'Worker is revoked or disabled');
      }

      const allowedRows = this._store.all(
        'SELECT bot_id FROM bots WHERE worker_id = ? AND enabled = 1',
        workerId
      );
      const allowedSet = new Set(allowedRows.map((r) => r.bot_id));

      const botSnapshots = Array.isArray(payload.botSnapshots) ? payload.botSnapshots : [];
      for (const rawSnap of botSnapshots) {
        const botId = String(rawSnap?.botId || '');
        if (!allowedSet.has(botId)) {
          throw new DomainError(
            'FORBIDDEN',
            `Worker ${workerId} attempted to report snapshot for unowned bot ${botId}`
          );
        }
        const compact = toCompactBotSnapshot(rawSnap, { pinnedItemKeys });
        const connState =
          compact.status === 'disconnected'
            ? 'disconnected'
            : compact.status === 'degraded'
              ? 'degraded'
              : 'ready';
        this._store.run(
          `UPDATE bots
           SET connection_state = ?, compact_snapshot_json = ?, updated_at = ?
           WHERE bot_id = ?`,
          connState,
          JSON.stringify(compact),
          nowIso,
          botId
        );
      }

      this._store.run(
        `UPDATE workers SET status = 'alive', last_heartbeat_at = ? WHERE worker_id = ?`,
        nowIso,
        workerId
      );

      // Renew unexpired active leases for this worker; report expired leases for immediate fencing (MED-02 & HIGH-05)
      const activeLeases = this._store.all(
        `SELECT assignment_id, lease_id, bot_id, state, expires_at
         FROM assignments
         WHERE worker_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        workerId
      );

      const renewedLeases = [];
      const expiredLeaseIds = [];
      const newExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();

      for (const l of activeLeases) {
        if (Date.parse(l.expires_at) <= nowMs) {
          expiredLeaseIds.push(l.lease_id);
        } else {
          this._store.run(
            'UPDATE assignments SET expires_at = ?, lease_ttl_ms = ? WHERE assignment_id = ?',
            newExpiresIso,
            leaseDurationMs,
            l.assignment_id
          );
          renewedLeases.push({ leaseId: l.lease_id, leaseTtlMs: leaseDurationMs });
        }
      }

      const urgentStops = this._store.all(
        `SELECT payload_json FROM command_outbox
         WHERE worker_id = ? AND acked_at IS NULL AND command_type = 'safe_stop'`,
        workerId
      );
      const urgentStopBotIds = urgentStops
        .map((r) => {
          try {
            return JSON.parse(r.payload_json)?.botId || null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      return {
        schemaVersion: 1,
        serverTime: nowIso,
        lastAckedWorkerSequence: worker.last_event_seq,
        renewedLeaseIds: renewedLeases.map((r) => r.leaseId),
        renewedLeases,
        expiredLeaseIds,
        urgentStopBotIds
      };
    });
  }

  /**
   * Immediately revoke a worker's token and mark it `disabled` (`SECURITY_PLAN.md` §4.3).
   */
  revoke(workerId, reason = 'operator_revoked') {
    const nowIso = new Date(this._now()).toISOString();
    return this._store.transaction(() => {
      const worker = this._store.get('SELECT * FROM workers WHERE worker_id = ?', workerId);
      if (!worker) {
        throw new DomainError('NOT_FOUND', `Worker ${workerId} not found`);
      }
      this._store.run(
        `UPDATE workers SET status = 'disabled', revoked_at = ? WHERE worker_id = ?`,
        nowIso,
        workerId
      );
      this._store.run(
        `UPDATE bots SET connection_state = 'disconnected', updated_at = ? WHERE worker_id = ?`,
        nowIso,
        workerId
      );

      // Fence all active objectives & assignments held by this worker
      const affectedObjectives = this._store.all(
        `SELECT DISTINCT objective_id FROM assignments
         WHERE worker_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        workerId
      );
      for (const row of affectedObjectives) {
        this._store.run(
          'UPDATE objectives SET allocation_epoch = allocation_epoch + 1, version = version + 1 WHERE objective_id = ?',
          row.objective_id
        );
      }

      const activeAssignments = this._store.all(
        `SELECT * FROM assignments
         WHERE worker_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        workerId
      );
      for (const asg of activeAssignments) {
        const uncredited =
          asg.quota_quantity !== null
            ? Math.max(0, asg.quota_quantity - asg.credited_quantity)
            : 0;
        this._store.run(
          `UPDATE assignments SET state = 'revoked', completed_at = ? WHERE assignment_id = ?`,
          nowIso,
          asg.assignment_id
        );
        if (uncredited > 0) {
          this._store.run(
            `UPDATE objectives
             SET reserved_quantity = MAX(0, reserved_quantity - ?),
                 state = CASE WHEN state IN ('assigned', 'running') THEN 'ready' ELSE state END
             WHERE objective_id = ?`,
            uncredited,
            asg.objective_id
          );
        }
      }

      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: 'admin',
        actorId: 'BotRegistry',
        action: 'worker.revoked',
        targetId: workerId,
        outcome: 'ok',
        details: { reason, revokedAssignments: activeAssignments.length }
      });

      this.emit('worker.revoked', { workerId, reason, revokedAssignments: activeAssignments.length });
      return { workerId, status: 'disabled', revokedAssignments: activeAssignments.length };
    });
  }

  /**
   * Sweep worker heartbeat timestamps (`alive -> degraded -> unreachable`, `MASTER_SPEC.md` §5.4).
   */
  sweepLiveness(nowIso = new Date(this._now()).toISOString()) {
    const nowMs = Date.parse(nowIso);
    const hbMs = this._config.capacity?.heartbeatIntervalMs ?? 5_000;
    const degradedCutoffMs = nowMs - Math.floor(hbMs * 1.5);
    const unreachableCutoffMs = nowMs - hbMs * 3;

    const transitions = [];
    this._store.transaction(() => {
      const workers = this._store.all(
        `SELECT * FROM workers WHERE status IN ('alive', 'degraded')`
      );
      for (const w of workers) {
        const lastMs = w.last_heartbeat_at ? Date.parse(w.last_heartbeat_at) : 0;
        let nextStatus = w.status;
        if (lastMs <= unreachableCutoffMs) {
          nextStatus = 'unreachable';
        } else if (lastMs <= degradedCutoffMs && w.status === 'alive') {
          nextStatus = 'degraded';
        }
        if (nextStatus !== w.status) {
          this._store.run(
            'UPDATE workers SET status = ? WHERE worker_id = ?',
            nextStatus,
            w.worker_id
          );
          if (nextStatus === 'unreachable') {
            this._store.run(
              `UPDATE bots SET connection_state = 'disconnected', updated_at = ? WHERE worker_id = ?`,
              nowIso,
              w.worker_id
            );
          }
          transitions.push({ workerId: w.worker_id, from: w.status, to: nextStatus });
        }
      }
    });

    for (const t of transitions) {
      this.emit(`worker.${t.to}`, t);
    }
    return transitions;
  }

  /**
   * Derive normalized `BotCapabilities` for scheduling (`MODULE_INTERFACES.md` §1).
   */
  eligibleBots(filter = {}) {
    const nowMs = this._now();
    const maxTelemetryAgeMs = filter.maxTelemetryAgeMs ?? 15_000;

    const rows = this._store.all(
      `SELECT b.*, w.status AS worker_status
       FROM bots b
       JOIN workers w ON w.worker_id = b.worker_id
       WHERE b.enabled = 1 AND w.status IN ('alive', 'degraded')
       ORDER BY b.bot_id ASC`
    );

    const activeAssignmentRows = this._store.all(
      `SELECT bot_id FROM assignments
       WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`
    );
    const busySet = new Set(activeAssignmentRows.map((r) => r.bot_id));

    const results = [];
    for (const row of rows) {
      if (filter.serverId && row.server_id !== filter.serverId) continue;
      let snap = null;
      if (row.compact_snapshot_json) {
        try {
          snap = JSON.parse(row.compact_snapshot_json);
        } catch {
          snap = null;
        }
      }
      const updatedMs = row.updated_at ? Date.parse(row.updated_at) : 0;
      const telemetryAgeMs = Math.max(0, nowMs - updatedMs);
      const connected =
        row.worker_status === 'alive' &&
        row.connection_state === 'ready' &&
        snap !== null &&
        snap.status !== 'disconnected';

      const cap = {
        botId: row.bot_id,
        workerId: row.worker_id,
        serverId: row.server_id,
        username: row.username,
        connected,
        spawned: connected,
        busy: busySet.has(row.bot_id),
        dimension: snap?.dimension || 'unknown',
        position: snap?.position || null,
        healthBand: snap?.healthBand || 'unknown',
        foodBand: snap?.foodBand || 'unknown',
        freeSlotEstimate: typeof snap?.freeSlots === 'number' ? snap.freeSlots : 36,
        hasCraftingTable: Boolean(snap?.hasCraftingTable),
        toolClasses: snap?.bestToolsByClass || {},
        itemCounts: snap?.itemCounts || {},
        supportedActions: [...DEFAULT_SUPPORTED_ACTIONS],
        telemetryAgeMs
      };

      if (filter.onlyReady === true) {
        if (
          !cap.connected ||
          cap.busy ||
          cap.telemetryAgeMs > maxTelemetryAgeMs ||
          cap.healthBand === 'critical' ||
          cap.foodBand === 'critical'
        ) {
          continue;
        }
      }
      results.push(cap);
    }
    return results;
  }

  listWorkers() {
    return this._store.all(
      `SELECT worker_id AS workerId, hostname, status, max_bot_slots AS maxBotSlots,
              last_heartbeat_at AS lastHeartbeatAt, last_command_seq AS lastCommandSeq,
              last_event_seq AS lastEventSeq, registered_at AS registeredAt
       FROM workers
       ORDER BY worker_id ASC`
    );
  }

  listBots() {
    const rows = this._store.all(
      `SELECT bot_id AS botId, worker_id AS workerId, username, server_id AS serverId,
              auth_mode AS authMode, enabled, connection_state AS connectionState,
              compact_snapshot_json AS snapshotJson, updated_at AS updatedAt
       FROM bots
       ORDER BY bot_id ASC`
    );
    return rows.map((r) => ({
      botId: r.botId,
      workerId: r.workerId,
      username: r.username,
      serverId: r.serverId,
      authMode: r.authMode,
      enabled: Boolean(r.enabled),
      connectionState: r.connectionState,
      snapshot: r.snapshotJson ? JSON.parse(r.snapshotJson) : null,
      updatedAt: r.updatedAt
    }));
  }
}

module.exports = {
  BotRegistry,
  WorkerRegistry: BotRegistry,
  sha256Hex
};
