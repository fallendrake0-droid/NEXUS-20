'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RingBuffer } = require('./RingBuffer');

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|credential|apikey|api_key|microsoft|sessionid|privatekey|bootstrap)/i;

const BEARER_VALUE_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') {
    const clipped = value.length > 512 ? `${value.slice(0, 512)}...[truncated]` : value;
    return clipped.replace(BEARER_VALUE_PATTERN, '$1[REDACTED]');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Binary:${value.byteLength}B]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code || undefined,
      message: sanitizeValue(value.message || '', depth + 1)
    };
  }
  if (depth >= 4) {
    return '[MaxDepth]';
  }
  if (Array.isArray(value)) {
    const cap = Math.min(value.length, 25);
    const out = new Array(cap);
    for (let i = 0; i < cap; i += 1) {
      out[i] = sanitizeValue(value[i], depth + 1);
    }
    return out;
  }
  if (t === 'object') {
    const out = {};
    const keys = Object.keys(value);
    const cap = Math.min(keys.length, 32);
    for (let i = 0; i < cap; i += 1) {
      const k = keys[i];
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(value[k], depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Bounded, secret-redacting, rate-limited rotating structured logger.
 *
 * Optimisation #15 (PERFORMANCE_PLAN.md §7 + SECURITY_PLAN.md §10):
 * - Skips formatting completely when below configured minimum level (`info` default).
 * - Redacts credentials/tokens/cookies BEFORE serialization.
 * - Rate-limits repetitive error storms within a rolling window and emits suppressed counts.
 * - Caps in-memory recent log ring (default 200 entries) and rotates disk log files at
 *   5 MiB x 3 files so logs never exhaust RAM or Termux flash storage.
 */
class BoundedLogger {
  /**
   * @param {object} [options]
   * @param {'debug'|'info'|'warn'|'error'} [options.level='info']
   * @param {number} [options.ringCapacity=200]
   * @param {string|null} [options.filePath=null] Optional rotating log file path
   * @param {number} [options.maxFileBytes=5242880] 5 MiB per PERFORMANCE_PLAN.md §7
   * @param {number} [options.maxFiles=3] Keep at most 3 rotated files
   * @param {number} [options.rateLimitWindowMs=10000]
   * @param {number} [options.maxRepeatsPerWindow=5]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    const levelName = String(options.level || 'info').toLowerCase();
    this._minLevel = LEVELS[levelName] || LEVELS.info;
    this._levelName = LEVELS[levelName] ? levelName : 'info';
    this._ring = new RingBuffer(options.ringCapacity || 200);
    this._filePath = options.filePath || null;
    this._maxFileBytes = options.maxFileBytes || 5 * 1024 * 1024;
    this._maxFiles = options.maxFiles || 3;
    this._rateLimitWindowMs = options.rateLimitWindowMs || 10_000;
    this._maxRepeatsPerWindow = options.maxRepeatsPerWindow || 5;
    this._now = options.now || Date.now;

    /** @type {Map<string, { windowStart: number, count: number, suppressed: number }>} */
    this._dedupMap = new Map();
    this._currentFileBytes = 0;
    this._writtenLines = 0;
    this._suppressedTotal = 0;
    this._rotations = 0;

    if (this._filePath) {
      const dir = path.dirname(this._filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this._filePath)) {
        this._currentFileBytes = fs.statSync(this._filePath).size;
      }
    }
  }

  setLevel(levelName) {
    const normalized = String(levelName).toLowerCase();
    if (!LEVELS[normalized]) {
      throw new RangeError(`Unsupported log level: ${levelName}`);
    }
    this._minLevel = LEVELS[normalized];
    this._levelName = normalized;
  }

  debug(event, fields) {
    return this._write('debug', event, fields);
  }

  info(event, fields) {
    return this._write('info', event, fields);
  }

  warn(event, fields) {
    return this._write('warn', event, fields);
  }

  error(event, fields) {
    return this._write('error', event, fields);
  }

  _write(level, event, fields) {
    const numeric = LEVELS[level];
    if (!numeric || numeric < this._minLevel) {
      return false;
    }

    const nowMs = this._now();
    const dedupKey = `${level}:${event}`;
    let suppressedBeforeEmit = 0;

    // Rate-limit repetitive warn/error storms
    if (numeric >= LEVELS.warn) {
      if (this._dedupMap.size > 256) {
        // Bound dedup table itself
        const firstKey = this._dedupMap.keys().next().value;
        this._dedupMap.delete(firstKey);
      }
      let bucket = this._dedupMap.get(dedupKey);
      if (!bucket || nowMs - bucket.windowStart >= this._rateLimitWindowMs) {
        suppressedBeforeEmit = bucket ? bucket.suppressed : 0;
        bucket = { windowStart: nowMs, count: 0, suppressed: 0 };
        this._dedupMap.set(dedupKey, bucket);
      }
      bucket.count += 1;
      if (bucket.count > this._maxRepeatsPerWindow) {
        bucket.suppressed += 1;
        this._suppressedTotal += 1;
        return false;
      }
    }

    const safeFields = fields ? sanitizeValue(fields, 0) : undefined;
    const record = {
      ts: new Date(nowMs).toISOString(),
      level,
      event: String(event).slice(0, 120),
      ...(suppressedBeforeEmit > 0 ? { suppressedPreviousWindow: suppressedBeforeEmit } : {}),
      ...(safeFields && typeof safeFields === 'object' ? { data: safeFields } : {})
    };

    const line = `${JSON.stringify(record)}\n`;
    this._ring.push(line);
    this._writtenLines += 1;

    if (this._filePath) {
      this._appendRotated(line);
    }
    return true;
  }

  _appendRotated(line) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this._currentFileBytes + lineBytes > this._maxFileBytes) {
        this._rotateFiles();
      }
      fs.appendFileSync(this._filePath, line, 'utf8');
      this._currentFileBytes += lineBytes;
    } catch {
      // Never crash coordinator/worker on disk full or transient Termux FS error
    }
  }

  _rotateFiles() {
    this._rotations += 1;
    // Shift .(maxFiles-1) -> delete, .(i-1) -> .i, base -> .1
    for (let i = this._maxFiles - 1; i >= 1; i -= 1) {
      const src = i === 1 ? this._filePath : `${this._filePath}.${i - 1}`;
      const dst = `${this._filePath}.${i}`;
      if (fs.existsSync(src)) {
        if (i === this._maxFiles - 1 && fs.existsSync(dst)) {
          fs.unlinkSync(dst);
        }
        fs.renameSync(src, dst);
      }
    }
    // Remove excess if maxFiles === 1
    if (this._maxFiles <= 1 && fs.existsSync(this._filePath)) {
      fs.unlinkSync(this._filePath);
    }
    this._currentFileBytes = 0;
  }

  recentLines(limit = 50) {
    return this._ring.toArray(limit);
  }

  clearMemoryRing() {
    this._ring.clear();
  }

  stats() {
    return {
      level: this._levelName,
      ringSize: this._ring.size,
      ringCapacity: this._ring.capacity,
      writtenLines: this._writtenLines,
      suppressedTotal: this._suppressedTotal,
      currentFileBytes: this._currentFileBytes,
      maxFileBytes: this._maxFileBytes,
      maxFiles: this._maxFiles,
      rotations: this._rotations
    };
  }
}

module.exports = { BoundedLogger, sanitizeValue };
