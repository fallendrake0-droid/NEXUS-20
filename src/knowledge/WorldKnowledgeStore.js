'use strict';

const crypto = require('node:crypto');
const { DomainError } = require('../errors/DomainError');

const VALID_CATEGORIES = new Set([
  'resource_location',
  'structure',
  'storage_location',
  'route',
  'explored_area',
  'hazard',
  'mining_location',
  'base_location',
  'strategy',
  'worker_capability'
]);

const DEFAULT_CATEGORY_TTL_MS = Object.freeze({
  resource_location: 20 * 60 * 1000,
  mining_location: 45 * 60 * 1000,
  hazard: 30 * 60 * 1000,
  explored_area: 2 * 60 * 60 * 1000,
  route: 2 * 60 * 60 * 1000,
  storage_location: 24 * 60 * 60 * 1000,
  structure: 24 * 60 * 60 * 1000,
  base_location: 24 * 60 * 60 * 1000,
  strategy: 12 * 60 * 60 * 1000,
  worker_capability: 30 * 60 * 1000
});

/**
 * Shared World Knowledge & Storage Coordination Store (`ADR-005`, NEXUS-20 Part 11).
 *
 * Invariants:
 * - Every entry has a mandatory `expires_at` timestamp; stale entries are never treated as facts.
 * - Total stored rows are strictly bounded (`maxEntries`, default 2,000) via deterministic eviction.
 * - Independent confirmation by a second bot upgrades `verification_state` from `observed` -> `verified`.
 * - Storage chest locks enforce TTL-bounded mutual exclusion so two bots never conflict on one chest.
 */
class WorldKnowledgeStore {
  /**
   * @param {object} options
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {number} [options.maxEntries=2000]
   * @param {number} [options.mergeRadiusBlocks=8]
   * @param {object} [options.logger]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    if (!options.stateStore) {
      throw new TypeError('WorldKnowledgeStore requires stateStore');
    }
    this._store = options.stateStore;
    this._maxEntries = Math.max(32, Math.trunc(options.maxEntries ?? 2000));
    this._mergeRadius = Math.max(1, Math.trunc(options.mergeRadiusBlocks ?? 8));
    this._logger = options.logger || null;
    this._now = options.now || Date.now;
  }

  /**
   * Record or merge a world observation from a bot or operator.
   */
  recordObservation(entry = {}) {
    const category = String(entry.category || '').trim();
    if (!VALID_CATEGORIES.has(category)) {
      throw new DomainError(
        'SCHEMA_VALIDATION_FAILED',
        `Unsupported world knowledge category: ${category}`
      );
    }

    const subjectKey = String(entry.subjectKey || '').trim().slice(0, 96);
    if (!subjectKey) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'World knowledge subjectKey is required');
    }

    const dimension = String(entry.dimension || 'minecraft:overworld').trim().slice(0, 64);
    const hasPos =
      entry.position &&
      Number.isFinite(entry.position.x) &&
      Number.isFinite(entry.position.y) &&
      Number.isFinite(entry.position.z);
    const x = hasPos ? Math.round(entry.position.x) : Number.isFinite(entry.x) ? Math.round(entry.x) : null;
    const y = hasPos ? Math.round(entry.position.y) : Number.isFinite(entry.y) ? Math.round(entry.y) : null;
    const z = hasPos ? Math.round(entry.position.z) : Number.isFinite(entry.z) ? Math.round(entry.z) : null;

    const confidence = Math.max(0.05, Math.min(1.0, Number(entry.confidence ?? 0.8)));
    const ttlMs = Math.max(
      5_000,
      Math.min(
        7 * 24 * 3600 * 1000,
        Math.trunc(entry.ttlMs ?? DEFAULT_CATEGORY_TTL_MS[category] ?? 1800_000)
      )
    );
    const reportedByBotId = entry.reportedByBotId ? String(entry.reportedByBotId).slice(0, 64) : null;
    const safeData =
      entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {};
    const dataJson = JSON.stringify(safeData).slice(0, 2048);

    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();

    return this._store.transaction(() => {
      // Check for nearby existing active entry to merge/confirm rather than duplicating
      let existing = null;
      if (x !== null && y !== null && z !== null) {
        const candidates = this._store.all(
          `SELECT * FROM world_knowledge
           WHERE category = ? AND dimension = ? AND subject_key = ?
             AND verification_state != 'invalidated' AND expires_at > ?
             AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ?
           LIMIT 5`,
          category,
          dimension,
          subjectKey,
          nowIso,
          x - this._mergeRadius,
          x + this._mergeRadius,
          y - this._mergeRadius,
          y + this._mergeRadius,
          z - this._mergeRadius,
          z + this._mergeRadius
        );
        existing = candidates[0] || null;
      } else {
        existing = this._store.get(
          `SELECT * FROM world_knowledge
           WHERE category = ? AND dimension = ? AND subject_key = ? AND x IS NULL
             AND verification_state != 'invalidated' AND expires_at > ?
           LIMIT 1`,
          category,
          dimension,
          subjectKey,
          nowIso
        );
      }

      if (existing) {
        const confirmedBySecondBot =
          Boolean(reportedByBotId) &&
          Boolean(existing.reported_by_bot_id) &&
          reportedByBotId !== existing.reported_by_bot_id;
        const nextVerification =
          confirmedBySecondBot || existing.verification_state === 'verified' || entry.verified === true
            ? 'verified'
            : 'observed';
        const nextConfidence = Math.min(
          1.0,
          Math.max(Number(existing.confidence), confidence) + (confirmedBySecondBot ? 0.12 : 0.03)
        );
        const verifiedAt = nextVerification === 'verified' ? nowIso : existing.verified_at;

        this._store.run(
          `UPDATE world_knowledge
           SET x = COALESCE(?, x),
               y = COALESCE(?, y),
               z = COALESCE(?, z),
               confidence = ?,
               verification_state = ?,
               data_json = ?,
               observed_at = ?,
               verified_at = ?,
               expires_at = ?
           WHERE knowledge_id = ?`,
          x,
          y,
          z,
          Number(nextConfidence.toFixed(3)),
          nextVerification,
          dataJson,
          nowIso,
          verifiedAt,
          expiresAt,
          existing.knowledge_id
        );

        return this._formatRow(
          this._store.get('SELECT * FROM world_knowledge WHERE knowledge_id = ?', existing.knowledge_id)
        );
      }

      // Enforce hard row cap before inserting (`ADR-005`)
      this._enforceCapacityCap(nowIso);

      const knowledgeId = entry.knowledgeId || crypto.randomUUID();
      const verificationState = entry.verified === true ? 'verified' : 'observed';
      const verifiedAt = verificationState === 'verified' ? nowIso : null;

      this._store.run(
        `INSERT INTO world_knowledge (
          knowledge_id, category, dimension, subject_key, x, y, z,
          confidence, verification_state, reported_by_bot_id, data_json,
          observed_at, verified_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        knowledgeId,
        category,
        dimension,
        subjectKey,
        x,
        y,
        z,
        Number(confidence.toFixed(3)),
        verificationState,
        reportedByBotId,
        dataJson,
        nowIso,
        verifiedAt,
        expiresAt
      );

      return this._formatRow(
        this._store.get('SELECT * FROM world_knowledge WHERE knowledge_id = ?', knowledgeId)
      );
    });
  }

  /**
   * Mark a previously recorded entry as depleted/invalidated or disputed when a bot inspects it.
   */
  invalidateObservation(knowledgeId, { disputedOnly = false, reason = 'depleted' } = {}) {
    const nowIso = new Date(this._now()).toISOString();
    const row = this._store.get(
      'SELECT * FROM world_knowledge WHERE knowledge_id = ?',
      String(knowledgeId)
    );
    if (!row) return null;

    if (disputedOnly) {
      const reduced = Math.max(0.1, Number(row.confidence) * 0.5);
      this._store.run(
        `UPDATE world_knowledge
         SET verification_state = 'disputed',
             confidence = ?,
             observed_at = ?
         WHERE knowledge_id = ?`,
        Number(reduced.toFixed(3)),
        nowIso,
        row.knowledge_id
      );
    } else {
      this._store.run(
        `UPDATE world_knowledge
         SET verification_state = 'invalidated',
             confidence = 0.0,
             expires_at = ?,
             data_json = ?
         WHERE knowledge_id = ?`,
        nowIso,
        JSON.stringify({ invalidatedReason: String(reason).slice(0, 120) }),
        row.knowledge_id
      );
    }
    return this._formatRow(
      this._store.get('SELECT * FROM world_knowledge WHERE knowledge_id = ?', row.knowledge_id)
    );
  }

  /**
   * Query active (unexpired, non-invalidated) shared world knowledge.
   */
  query(filters = {}) {
    const nowIso = new Date(this._now()).toISOString();
    const clauses = [`expires_at > ?`, `verification_state != 'invalidated'`];
    const params = [nowIso];

    if (filters.category) {
      clauses.push('category = ?');
      params.push(String(filters.category));
    }
    if (filters.dimension) {
      clauses.push('dimension = ?');
      params.push(String(filters.dimension));
    }
    if (filters.subjectKey) {
      clauses.push('subject_key = ?');
      params.push(String(filters.subjectKey));
    }
    if (typeof filters.minConfidence === 'number') {
      clauses.push('confidence >= ?');
      params.push(filters.minConfidence);
    }

    const near = filters.near;
    const maxRadius = Number.isFinite(filters.maxRadius) ? Math.max(1, filters.maxRadius) : null;
    if (near && Number.isFinite(near.x) && Number.isFinite(near.z) && maxRadius !== null) {
      clauses.push('x BETWEEN ? AND ?');
      clauses.push('z BETWEEN ? AND ?');
      params.push(
        Math.round(near.x - maxRadius),
        Math.round(near.x + maxRadius),
        Math.round(near.z - maxRadius),
        Math.round(near.z + maxRadius)
      );
    }

    const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 50)));
    params.push(limit);

    const rows = this._store.all(
      `SELECT * FROM world_knowledge
       WHERE ${clauses.join(' AND ')}
       ORDER BY confidence DESC, observed_at DESC
       LIMIT ?`,
      ...params
    );

    const mapped = rows.map((r) => this._formatRow(r));
    if (near && Number.isFinite(near.x) && Number.isFinite(near.z)) {
      mapped.sort((a, b) => {
        const da = a.position ? Math.hypot(a.position.x - near.x, a.position.z - near.z) : Infinity;
        const db = b.position ? Math.hypot(b.position.x - near.x, b.position.z - near.z) : Infinity;
        return da - db || b.confidence - a.confidence;
      });
    }
    return mapped;
  }

  /**
   * Acquire a TTL-bounded mutex lock on a chest/storage coordinate so two bots never conflict.
   */
  acquireStorageLock({
    dimension = 'minecraft:overworld',
    x,
    y,
    z,
    botId,
    assignmentId = null,
    ttlMs = 15_000
  }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !botId) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'Storage lock requires x, y, z and botId');
    }
    const rx = Math.round(x);
    const ry = Math.round(y);
    const rz = Math.round(z);
    const dim = String(dimension);
    const storageKey = `${dim}:${rx}:${ry}:${rz}`;
    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();
    const safeTtl = Math.max(2_000, Math.min(120_000, Math.trunc(ttlMs)));
    const expiresAt = new Date(nowMs + safeTtl).toISOString();

    return this._store.transaction(() => {
      this._store.run('DELETE FROM storage_locks WHERE expires_at <= ?', nowIso);
      const current = this._store.get(
        'SELECT * FROM storage_locks WHERE storage_key = ?',
        storageKey
      );
      if (current && current.holder_bot_id !== String(botId)) {
        return {
          acquired: false,
          storageKey,
          holderBotId: current.holder_bot_id,
          expiresAt: current.expires_at
        };
      }

      this._store.run(
        `INSERT INTO storage_locks (
          storage_key, dimension, x, y, z, holder_bot_id, assignment_id, acquired_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET
          assignment_id = excluded.assignment_id,
          expires_at = excluded.expires_at`,
        storageKey,
        dim,
        rx,
        ry,
        rz,
        String(botId),
        assignmentId ? String(assignmentId) : null,
        nowIso,
        expiresAt
      );

      return {
        acquired: true,
        storageKey,
        holderBotId: String(botId),
        expiresAt
      };
    });
  }

  releaseStorageLock({ dimension = 'minecraft:overworld', x, y, z, botId }) {
    const storageKey = `${dimension}:${Math.round(x)}:${Math.round(y)}:${Math.round(z)}`;
    const res = this._store.run(
      'DELETE FROM storage_locks WHERE storage_key = ? AND holder_bot_id = ?',
      storageKey,
      String(botId)
    );
    return Number(res.changes || 0) > 0;
  }

  listStorageLocks() {
    const nowIso = new Date(this._now()).toISOString();
    return this._store
      .all('SELECT * FROM storage_locks WHERE expires_at > ? ORDER BY acquired_at ASC', nowIso)
      .map((r) => ({
        storageKey: r.storage_key,
        dimension: r.dimension,
        position: { x: r.x, y: r.y, z: r.z },
        holderBotId: r.holder_bot_id,
        assignmentId: r.assignment_id,
        acquiredAt: r.acquired_at,
        expiresAt: r.expires_at
      }));
  }

  /**
   * Compact summary for AI Brain context (`Coordinator.buildSwarmWorldContext()`) and Dashboard.
   */
  getCompactSummary(maxPerCategory = 4) {
    const nowIso = new Date(this._now()).toISOString();
    const totalRow = this._store.get(
      `SELECT COUNT(*) AS cnt FROM world_knowledge
       WHERE expires_at > ? AND verification_state != 'invalidated'`,
      nowIso
    );

    const pick = (cat) =>
      this.query({ category: cat, minConfidence: 0.4, limit: maxPerCategory }).map((e) => ({
        subject: e.subjectKey,
        dim: e.dimension,
        pos: e.position,
        confidence: e.confidence,
        verified: e.verificationState === 'verified'
      }));

    return {
      totalValidEntries: Number(totalRow?.cnt || 0),
      resources: pick('resource_location'),
      storage: pick('storage_location'),
      hazards: pick('hazard'),
      bases: pick('base_location'),
      structures: pick('structure'),
      activeStorageLocks: this.listStorageLocks().length
    };
  }

  _enforceCapacityCap(nowIso) {
    this._store.run(
      `DELETE FROM world_knowledge WHERE expires_at <= ? OR verification_state = 'invalidated'`,
      nowIso
    );
    const countRow = this._store.get('SELECT COUNT(*) AS cnt FROM world_knowledge');
    const total = Number(countRow?.cnt || 0);
    if (total < this._maxEntries) return;

    const overflow = total - this._maxEntries + 1;
    this._store.run(
      `DELETE FROM world_knowledge
       WHERE knowledge_id IN (
         SELECT knowledge_id FROM world_knowledge
         ORDER BY confidence ASC, expires_at ASC
         LIMIT ?
       )`,
      overflow
    );
  }

  _formatRow(row) {
    if (!row) return null;
    let data = {};
    try {
      data = JSON.parse(row.data_json || '{}');
    } catch {
      data = {};
    }
    return {
      knowledgeId: row.knowledge_id,
      category: row.category,
      dimension: row.dimension,
      subjectKey: row.subject_key,
      position:
        row.x !== null && row.y !== null && row.z !== null
          ? { x: row.x, y: row.y, z: row.z }
          : null,
      confidence: Number(row.confidence),
      verificationState: row.verification_state,
      reportedByBotId: row.reported_by_bot_id,
      data,
      observedAt: row.observed_at,
      verifiedAt: row.verified_at,
      expiresAt: row.expires_at
    };
  }
}

module.exports = { WorldKnowledgeStore, VALID_CATEGORIES, DEFAULT_CATEGORY_TTL_MS };
