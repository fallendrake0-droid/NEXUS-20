'use strict';

const crypto = require('node:crypto');
const { DomainError } = require('../errors/DomainError');

const SCRYPT_PARAMS = Object.freeze({
  // N=4096, r=8, p=4 preserves full N*p=16,384 CPU work factor while bounding
  // per-thread native scratch allocation to 4 MiB (<= 16 MiB across 4 libuv threads on glibc).
  N: 4096,
  r: 8,
  p: 4,
  maxmem: 16 * 1024 * 1024
});
const KEYLEN = 64;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Operator Authentication, Session, CSRF, RBAC & Rate-Limiting Service (`SECURITY_PLAN.md`, NEXUS-20 Part 15).
 *
 * Key Guarantees:
 * - Concurrency-1 `crypto.scrypt` KDF queue (`maxQueue = 4`); excess requests immediately throw
 *   `429 RATE_LIMITED` so login floods can never spike Galaxy A06 / container RSS (> 24 MiB).
 * - Only SHA-256 hashes of session IDs and CSRF tokens are stored in SQLite (`sessions`).
 * - Constant-time comparisons (`crypto.timingSafeEqual`) for passwords, CSRF tokens, and CLI tokens.
 * - Zero hardcoded passwords: initial admin is created from env vars or one-time bootstrap when DB has 0 principals.
 */
class AuthService {
  /**
   * @param {object} options
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {object} [options.config]
   * @param {number} [options.maxKdfQueue=4]
   * @param {number} [options.idleTimeoutMs=1800000] 30 minutes
   * @param {number} [options.absoluteTimeoutMs=43200000] 12 hours
   * @param {object} [options.logger]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    if (!options.stateStore) {
      throw new TypeError('AuthService requires stateStore');
    }
    this._store = options.stateStore;
    this._config = options.config || {};
    this._maxKdfQueue = Math.max(0, Math.trunc(options.maxKdfQueue ?? 4));
    this._idleTimeoutMs = Math.max(60_000, Math.trunc(options.idleTimeoutMs ?? 30 * 60 * 1000));
    this._absoluteTimeoutMs = Math.max(
      this._idleTimeoutMs,
      Math.trunc(options.absoluteTimeoutMs ?? 12 * 60 * 60 * 1000)
    );
    this._logger = options.logger || null;
    this._now = options.now || Date.now;

    this._kdfActive = 0;
    /** @type {Array<() => void>} */
    this._kdfQueue = [];

    // Precomputed dummy scrypt hash to prevent username enumeration timing leaks
    this._dummySaltHex = crypto.randomBytes(16).toString('hex');
    this._dummyKeyHex = crypto.randomBytes(KEYLEN).toString('hex');

    /** @type {Map<string, { count: number, resetAtMs: number }>} */
    this._rateBuckets = new Map();
    this._maxRateBuckets = 1024;
  }

  get kdfQueueDepth() {
    return this._kdfQueue.length;
  }

  get kdfActiveCount() {
    return this._kdfActive;
  }

  hasAnyPrincipal() {
    const row = this._store.get('SELECT COUNT(*) AS cnt FROM principals WHERE disabled = 0');
    return Number(row?.cnt || 0) > 0;
  }

  listPrincipals() {
    return this._store
      .all(
        `SELECT principal_id, username, role, disabled, created_at, updated_at
         FROM principals ORDER BY created_at ASC`
      )
      .map((r) => ({
        principalId: r.principal_id,
        username: r.username,
        role: r.role,
        disabled: Boolean(r.disabled),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
  }

  /**
   * Optional startup bootstrap from `SWARM_ADMIN_USERNAME` + `SWARM_ADMIN_PASSWORD` env vars.
   */
  async ensureEnvAdminBootstrap() {
    const username = this._config.security?.adminUsername;
    const password = this._config.security?.adminPassword;
    if (!username || !password) return false;
    if (this.hasAnyPrincipal()) return false;
    await this.bootstrapInitialAdmin({ username, password });
    return true;
  }

  /**
   * One-time initial admin creation when `principals` table is empty.
   */
  async bootstrapInitialAdmin({ username, password }) {
    if (this.hasAnyPrincipal()) {
      throw new DomainError(
        'CONFLICT',
        'Initial administrator has already been configured; sign in as admin to add users'
      );
    }
    return this.createPrincipal({
      username,
      password,
      role: 'admin',
      createdBy: 'bootstrap'
    });
  }

  /**
   * Create an operator/viewer/admin account with `scrypt` hashed password.
   */
  async createPrincipal({ username, password, role = 'operator', createdBy = 'admin' }) {
    const cleanUser = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,48}$/.test(cleanUser)) {
      throw new DomainError(
        'SCHEMA_VALIDATION_FAILED',
        'username must be 3..48 characters ([a-zA-Z0-9_.-])'
      );
    }
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
      throw new DomainError(
        'SCHEMA_VALIDATION_FAILED',
        'password must be between 10 and 256 characters'
      );
    }
    if (!['viewer', 'operator', 'admin'].includes(role)) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'role must be viewer, operator or admin');
    }

    const existing = this._store.get('SELECT principal_id FROM principals WHERE username = ?', cleanUser);
    if (existing) {
      throw new DomainError('CONFLICT', `Principal "${cleanUser}" already exists`);
    }

    const saltHex = crypto.randomBytes(16).toString('hex');
    const derivedHex = await this._deriveScryptQueued(password, saltHex);
    const passwordHash = `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${saltHex}$${derivedHex}`;

    const principalId = crypto.randomUUID();
    const nowIso = new Date(this._now()).toISOString();

    this._store.transaction(() => {
      this._store.run(
        `INSERT INTO principals (
          principal_id, username, password_hash, role, disabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
        principalId,
        cleanUser,
        passwordHash,
        role,
        nowIso,
        nowIso
      );
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: 'admin',
        actorId: String(createdBy),
        action: 'auth.principal_created',
        targetId: principalId,
        outcome: 'ok',
        details: { username: cleanUser, role }
      });
    });

    return { principalId, username: cleanUser, role, createdAt: nowIso };
  }

  /**
   * Authenticate username + password and mint session + CSRF tokens.
   */
  async login({ username, password, clientIp = 'unknown' }) {
    this.checkRateLimit(`login:${clientIp}`, 15, 60_000);

    const cleanUser = String(username || '').trim();
    const rawPass = typeof password === 'string' ? password : '';
    if (!cleanUser || !rawPass || rawPass.length > 256) {
      throw new DomainError('UNAUTHENTICATED', 'Invalid username or password');
    }

    const row = this._store.get(
      'SELECT * FROM principals WHERE username = ?',
      cleanUser
    );

    let valid = false;
    if (!row || row.disabled === 1) {
      // Run dummy derivation inside the bounded concurrency-1 queue to prevent timing enumeration
      await this._deriveScryptQueued(rawPass, this._dummySaltHex);
      valid = false;
    } else {
      valid = await this._verifyPasswordHash(rawPass, row.password_hash);
    }

    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();

    if (!valid || !row) {
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: 'human',
        actorId: cleanUser,
        action: 'auth.login_failed',
        outcome: 'denied',
        details: { clientIp }
      });
      throw new DomainError('UNAUTHENTICATED', 'Invalid username or password');
    }

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const sessionHash = sha256Hex(sessionToken);
    const csrfHash = sha256Hex(csrfToken);
    const idleExpiresAt = new Date(nowMs + this._idleTimeoutMs).toISOString();
    const absoluteExpiresAt = new Date(nowMs + this._absoluteTimeoutMs).toISOString();

    this._store.transaction(() => {
      this._store.run(
        `INSERT INTO sessions (
          session_id_hash, principal_id, csrf_token_hash,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        sessionHash,
        row.principal_id,
        csrfHash,
        nowIso,
        nowIso,
        idleExpiresAt,
        absoluteExpiresAt
      );
      this._store.recordAudit({
        occurredAt: nowIso,
        actorType: 'human',
        actorId: row.principal_id,
        action: 'auth.login_succeeded',
        outcome: 'ok',
        details: { username: row.username, role: row.role, clientIp }
      });
    });

    return {
      sessionToken,
      csrfToken,
      idleExpiresAt,
      absoluteExpiresAt,
      actor: {
        principalId: row.principal_id,
        username: row.username,
        actorType: 'human',
        role: row.role,
        serverId: null
      }
    };
  }

  logout(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return false;
    const sessionHash = sha256Hex(sessionToken);
    const res = this._store.run(
      'UPDATE sessions SET revoked = 1 WHERE session_id_hash = ? AND revoked = 0',
      sessionHash
    );
    return Number(res.changes || 0) > 0;
  }

  /**
   * Verify either a `Bearer <SWARM_CLI_TOKEN>` header or a browser session cookie (+ CSRF on mutating verbs).
   */
  authenticateRequest({ bearerToken = null, sessionToken = null, csrfToken = null, requireCsrf = false } = {}) {
    // 1. Optional CLI bearer operator token
    const configuredCliToken = this._config.security?.cliOperatorToken;
    if (bearerToken && configuredCliToken && configuredCliToken.length >= 16) {
      const hashProvided = sha256Hex(bearerToken);
      const hashExpected = sha256Hex(configuredCliToken);
      if (timingSafeHexEqual(hashProvided, hashExpected)) {
        return {
          principalId: 'cli-operator',
          username: 'cli-operator',
          actorType: 'cli',
          role: 'admin',
          serverId: null,
          authMechanism: 'cli_bearer'
        };
      }
      throw new DomainError('UNAUTHENTICATED', 'Invalid bearer token');
    }

    // 2. Session cookie authentication
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new DomainError('UNAUTHENTICATED', 'Authentication required');
    }

    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();
    const sessionHash = sha256Hex(sessionToken);

    const row = this._store.get(
      `SELECT s.*, p.username, p.role, p.disabled
       FROM sessions s
       JOIN principals p ON p.principal_id = s.principal_id
       WHERE s.session_id_hash = ?`,
      sessionHash
    );

    if (
      !row ||
      row.revoked === 1 ||
      row.disabled === 1 ||
      Date.parse(row.idle_expires_at) <= nowMs ||
      Date.parse(row.absolute_expires_at) <= nowMs
    ) {
      throw new DomainError('UNAUTHENTICATED', 'Session expired or invalid');
    }

    if (requireCsrf) {
      if (!csrfToken || typeof csrfToken !== 'string') {
        throw new DomainError('FORBIDDEN', 'Missing X-CSRF-Token header for state-changing request');
      }
      const providedCsrfHash = sha256Hex(csrfToken);
      if (!timingSafeHexEqual(providedCsrfHash, row.csrf_token_hash)) {
        throw new DomainError('FORBIDDEN', 'Invalid X-CSRF-Token header');
      }
    }

    // Slide idle expiry window
    const nextIdleIso = new Date(
      Math.min(Date.parse(row.absolute_expires_at), nowMs + this._idleTimeoutMs)
    ).toISOString();
    this._store.run(
      'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE session_id_hash = ?',
      nowIso,
      nextIdleIso,
      sessionHash
    );

    return {
      principalId: row.principal_id,
      username: row.username,
      actorType: 'human',
      role: row.role,
      serverId: null,
      authMechanism: 'session_cookie'
    };
  }

  /**
   * Sliding-window rate limiter with bounded bucket count.
   */
  checkRateLimit(bucketKey, maxRequests = 30, windowMs = 60_000) {
    const nowMs = this._now();
    const key = String(bucketKey);
    let entry = this._rateBuckets.get(key);

    if (!entry || entry.resetAtMs <= nowMs) {
      if (!entry && this._rateBuckets.size >= this._maxRateBuckets) {
        // Evict expired or oldest bucket
        for (const [k, v] of this._rateBuckets.entries()) {
          if (v.resetAtMs <= nowMs) {
            this._rateBuckets.delete(k);
            break;
          }
        }
        if (this._rateBuckets.size >= this._maxRateBuckets) {
          const oldestKey = this._rateBuckets.keys().next().value;
          if (oldestKey !== undefined) this._rateBuckets.delete(oldestKey);
        }
      }
      entry = { count: 1, resetAtMs: nowMs + windowMs };
      this._rateBuckets.set(key, entry);
      return;
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      throw new DomainError('RATE_LIMITED', 'Too many requests; please slow down', {
        details: { retryAfterMs: Math.max(100, entry.resetAtMs - nowMs) }
      });
    }
  }

  async _verifyPasswordHash(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltHex = parts[4];
    const expectedHex = parts[5];
    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
      return false;
    }
    const derivedHex = await this._deriveScryptQueued(password, saltHex, {
      N,
      r,
      p,
      maxmem: 32 * 1024 * 1024
    });
    return timingSafeHexEqual(derivedHex, expectedHex);
  }

  _deriveScryptQueued(password, saltHex, params = SCRYPT_PARAMS) {
    if (this._kdfActive >= 1 && this._kdfQueue.length >= this._maxKdfQueue) {
      return Promise.reject(
        new DomainError(
          'RATE_LIMITED',
          'Authentication KDF queue full; retry shortly'
        )
      );
    }

    return new Promise((resolve, reject) => {
      const execute = () => {
        this._kdfActive += 1;
        crypto.scrypt(
          Buffer.from(String(password), 'utf8'),
          Buffer.from(String(saltHex), 'hex'),
          KEYLEN,
          params,
          (err, derivedKey) => {
            this._kdfActive -= 1;
            const next = this._kdfQueue.shift();
            if (next) next();
            if (err) {
              reject(new DomainError('INTERNAL_ERROR', 'Password derivation failed', { cause: err }));
              return;
            }
            resolve(derivedKey.toString('hex'));
          }
        );
      };

      if (this._kdfActive < 1) {
        execute();
      } else {
        this._kdfQueue.push(execute);
      }
    });
  }
}

module.exports = { AuthService };
