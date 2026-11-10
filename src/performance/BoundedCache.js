'use strict';

/**
 * Estimate serialized memory cost cheaply without allocating large strings when possible.
 * @param {*} value
 * @returns {number}
 */
function estimateValueBytes(value) {
  if (value === null || value === undefined) return 8;
  const t = typeof value;
  if (t === 'string') return Buffer.byteLength(value, 'utf8') + 24;
  if (t === 'number' || t === 'boolean') return 16;
  if (Buffer.isBuffer(value)) return value.byteLength + 24;
  if (value instanceof Uint8Array) return value.byteLength + 24;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') + 48;
  } catch {
    return 256;
  }
}

/**
 * Bounded O(1) LRU + TTL + byte-budget cache (PERFORMANCE_PLAN.md §6).
 *
 * Invariant: Authoritative task/ledger state MUST NEVER reside solely in BoundedCache.
 * All entries must be reconstructible from StateStore or worker snapshots.
 */
class BoundedCache {
  /**
   * @param {object} options
   * @param {string} [options.name='cache']
   * @param {number} options.maxEntries Maximum entry count (>= 1)
   * @param {number} [options.maxBytes=2097152] Maximum estimated bytes across keys + values
   * @param {number} [options.defaultTtlMs=60000] Default TTL in ms (> 0)
   * @param {() => number} [options.now=Date.now] Clock function for deterministic testing
   * @param {(value: *) => number} [options.sizeEstimator=estimateValueBytes]
   */
  constructor(options = {}) {
    const {
      name = 'cache',
      maxEntries,
      maxBytes = 2 * 1024 * 1024,
      defaultTtlMs = 60_000,
      now = Date.now,
      sizeEstimator = estimateValueBytes
    } = options;

    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('BoundedCache maxEntries must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) {
      throw new RangeError('BoundedCache maxBytes must be an integer >= 64');
    }
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new RangeError('BoundedCache defaultTtlMs must be a positive number');
    }

    this.name = String(name);
    this._maxEntries = maxEntries;
    this._maxBytes = maxBytes;
    this._defaultTtlMs = defaultTtlMs;
    this._now = now;
    this._sizeEstimator = sizeEstimator;

    /** @type {Map<string, { value: *, expiresAt: number, bytes: number }>} */
    this._store = new Map();
    this._byteSize = 0;

    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
    this._expiredEvictions = 0;
    this._rejectedOversize = 0;
  }

  get size() {
    return this._store.size;
  }

  get byteSize() {
    return this._byteSize;
  }

  /**
   * Look up a key; refreshes LRU order on hit and lazily evicts if expired.
   * @param {string} key
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) {
      this._misses += 1;
      return undefined;
    }
    const now = this._now();
    if (now >= entry.expiresAt) {
      this._deleteInternal(key, entry);
      this._expiredEvictions += 1;
      this._misses += 1;
      return undefined;
    }
    // Promote to most-recently-used via Map re-insertion
    this._store.delete(key);
    this._store.set(key, entry);
    this._hits += 1;
    return entry.value;
  }

  /**
   * Check existence without refreshing LRU order, still respecting TTL.
   * @param {string} key
   */
  has(key) {
    const entry = this._store.get(key);
    if (!entry) return false;
    if (this._now() >= entry.expiresAt) {
      this._deleteInternal(key, entry);
      this._expiredEvictions += 1;
      return false;
    }
    return true;
  }

  /**
   * Insert or update an entry within count and byte caps.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs]
   * @returns {boolean} false if single item exceeds maxBytes
   */
  set(key, value, ttlMs = this._defaultTtlMs) {
    const strKey = String(key);
    const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._defaultTtlMs;
    const bytes = Buffer.byteLength(strKey, 'utf8') + this._sizeEstimator(value);

    if (bytes > this._maxBytes) {
      this._rejectedOversize += 1;
      return false;
    }

    const existing = this._store.get(strKey);
    if (existing) {
      this._deleteInternal(strKey, existing);
    }

    const now = this._now();
    if (this._store.size >= this._maxEntries || this._byteSize + bytes > this._maxBytes) {
      this.pruneExpired(now);
    }

    while (
      this._store.size > 0 &&
      (this._store.size >= this._maxEntries || this._byteSize + bytes > this._maxBytes)
    ) {
      const oldestKey = this._store.keys().next().value;
      const oldestEntry = this._store.get(oldestKey);
      this._deleteInternal(oldestKey, oldestEntry);
      this._evictions += 1;
    }

    this._store.set(strKey, {
      value,
      expiresAt: now + effectiveTtl,
      bytes
    });
    this._byteSize += bytes;
    return true;
  }

  /**
   * Remove a single key.
   * @param {string} key
   */
  delete(key) {
    const entry = this._store.get(key);
    if (!entry) return false;
    this._deleteInternal(key, entry);
    return true;
  }

  /**
   * Sweep expired entries in bounded steps.
   * @param {number} [now]
   * @param {number} [maxScan=256]
   * @returns {number} Number of expired entries removed
   */
  pruneExpired(now = this._now(), maxScan = 256) {
    let removed = 0;
    let scanned = 0;
    for (const [key, entry] of this._store.entries()) {
      if (scanned >= maxScan) break;
      scanned += 1;
      if (now >= entry.expiresAt) {
        this._deleteInternal(key, entry);
        this._expiredEvictions += 1;
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Aggressively trim cache under memory pressure (WorkloadGovernor constrained/critical).
   * @param {number} targetFraction Fraction [0..1] of current limits to retain.
   */
  shrinkToFraction(targetFraction = 0.5) {
    const frac = Math.max(0, Math.min(1, targetFraction));
    const maxItems = Math.floor(this._maxEntries * frac);
    const maxBytes = Math.floor(this._maxBytes * frac);
    this.pruneExpired(this._now(), this._store.size);
    let evicted = 0;
    while (this._store.size > maxItems || this._byteSize > maxBytes) {
      const oldestKey = this._store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = this._store.get(oldestKey);
      this._deleteInternal(oldestKey, oldestEntry);
      this._evictions += 1;
      evicted += 1;
    }
    return evicted;
  }

  clear() {
    this._store.clear();
    this._byteSize = 0;
  }

  _deleteInternal(key, entry) {
    this._store.delete(key);
    this._byteSize = Math.max(0, this._byteSize - entry.bytes);
  }

  stats() {
    const totalLookups = this._hits + this._misses;
    return {
      name: this.name,
      size: this._store.size,
      maxEntries: this._maxEntries,
      byteSize: this._byteSize,
      maxBytes: this._maxBytes,
      hits: this._hits,
      misses: this._misses,
      hitRate: totalLookups > 0 ? +(this._hits / totalLookups).toFixed(4) : null,
      evictions: this._evictions,
      expiredEvictions: this._expiredEvictions,
      rejectedOversize: this._rejectedOversize
    };
  }
}

module.exports = { BoundedCache, estimateValueBytes };
