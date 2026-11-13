'use strict';

const { BoundedCache } = require('./BoundedCache');

function quantizeCoord(pos, gridSize = 1) {
  return {
    x: Math.floor(pos.x / gridSize) * gridSize,
    y: Math.floor(pos.y / gridSize) * gridSize,
    z: Math.floor(pos.z / gridSize) * gridSize
  };
}

function goalKey(dimension, fromCell, toCell, range) {
  return `${dimension}|${fromCell.x},${fromCell.y},${fromCell.z}->${toCell.x},${toCell.y},${toCell.z}|r=${range}`;
}

/**
 * Deduplicates, throttles and bounds Mineflayer A* pathfinding computations.
 *
 * Optimisation #8 ("Repeated pathfinding") + PERFORMANCE_PLAN.md §10:
 * - Prevents recomputing identical A* paths on every movement tick or sub-block jitter.
 * - Coalesces concurrent requests for the same bot + quantized goal onto the in-flight run.
 * - Memoizes recent path solutions and NO_PATH verdicts in a BoundedCache invalidated
 *   incrementally when `onBlockUpdate()` observes terrain changes along/near the corridor.
 * - Enforces a strict CPU/wall timeout (`maxComputeMs`) and stuck-retry cap.
 */
class PathfindingGuard {
  /**
   * @param {object} [options]
   * @param {number} [options.minReplanIntervalMs=750]
   * @param {number} [options.cacheTtlMs=15000]
   * @param {number} [options.negativeCacheTtlMs=5000]
   * @param {number} [options.maxCacheEntries=256]
   * @param {number} [options.maxComputeMs=1500]
   * @param {number} [options.maxStuckRetries=3]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    this._minReplanIntervalMs = options.minReplanIntervalMs ?? 750;
    this._cacheTtlMs = options.cacheTtlMs ?? 15_000;
    this._negativeCacheTtlMs = options.negativeCacheTtlMs ?? 5_000;
    this._maxComputeMs = options.maxComputeMs ?? 1_500;
    this._maxStuckRetries = options.maxStuckRetries ?? 3;
    this._now = options.now || Date.now;

    this._routeCache = new BoundedCache({
      name: 'pathfinding-routes',
      maxEntries: options.maxCacheEntries || 256,
      maxBytes: 256 * 1024,
      defaultTtlMs: this._cacheTtlMs,
      now: this._now
    });

    /** @type {Map<string, { targetKey: string, startedAt: number, promise: Promise<any>, retries: number }>} */
    this._activeByBot = new Map();
    /** @type {Map<string, { targetKey: string, computedAt: number }>} */
    this._lastComputeByBot = new Map();

    this._requestedCalls = 0;
    this._executedComputations = 0;
    this._dedupedInFlight = 0;
    this._cooldownSkipped = 0;
    this._cacheHits = 0;
    this._invalidations = 0;
    this._timeouts = 0;
  }

  /**
   * Compute or reuse a bounded path for `botId`.
   *
   * @param {object} params
   * @param {string} params.botId
   * @param {string} [params.dimension='minecraft:overworld']
   * @param {{ x: number, y: number, z: number }} params.from
   * @param {{ x: number, y: number, z: number }} params.to
   * @param {number} [params.range=1]
   * @param {boolean} [params.forceReplan=false]
   * @param {(ctx: { maxComputeMs: number, signal: AbortSignal }) => Promise<object>} params.computeFn
   */
  async computePath(params) {
    const {
      botId,
      dimension = 'minecraft:overworld',
      from,
      to,
      range = 1,
      forceReplan = false,
      computeFn
    } = params;

    this._requestedCalls += 1;
    const fromCell = quantizeCoord(from, 1);
    const toCell = quantizeCoord(to, 1);
    const targetOnlyKey = `${dimension}|${toCell.x},${toCell.y},${toCell.z}|r=${range}`;
    const fullKey = goalKey(dimension, fromCell, toCell, range);

    // 1. Reuse active in-flight computation for the same bot & quantized goal
    const active = this._activeByBot.get(botId);
    if (active && active.targetKey === targetOnlyKey && !forceReplan) {
      this._dedupedInFlight += 1;
      return active.promise;
    }

    // 2. Check route cache before burning A* CPU
    if (!forceReplan) {
      const cached = this._routeCache.get(fullKey);
      if (cached !== undefined) {
        this._cacheHits += 1;
        return { ...cached, fromCache: true };
      }

      // 3. Enforce per-bot replan cooldown for identical goal target
      const last = this._lastComputeByBot.get(botId);
      const now = this._now();
      if (
        last &&
        last.targetKey === targetOnlyKey &&
        now - last.computedAt < this._minReplanIntervalMs
      ) {
        const lastNear = this._routeCache.get(last.fullKey);
        if (lastNear !== undefined) {
          this._cooldownSkipped += 1;
          return { ...lastNear, fromCooldownReuse: true };
        }
      }
    }

    const lastForRetries = this._lastComputeByBot.get(botId);
    const prevRetries =
      active && active.targetKey === targetOnlyKey
        ? active.retries
        : lastForRetries && lastForRetries.targetKey === targetOnlyKey
          ? lastForRetries.retries || 0
          : 0;
    if (prevRetries >= this._maxStuckRetries) {
      return {
        status: 'NO_PATH',
        failureCode: 'NO_PATH',
        reason: 'MAX_STUCK_RETRIES_EXCEEDED',
        nodes: []
      };
    }

    // 4. Execute bounded A* search with hard timeout
    this._executedComputations += 1;
    const abortController = new AbortController();
    let timer = null;

    const runPromise = (async () => {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            const err = new Error(`Pathfinding exceeded ${this._maxComputeMs}ms budget`);
            err.code = 'PATH_TIMEOUT';
            reject(err);
          }, this._maxComputeMs);
        });

        const rawResult = await Promise.race([
          Promise.resolve(
            computeFn({
              maxComputeMs: this._maxComputeMs,
              signal: abortController.signal,
              from: fromCell,
              to: toCell,
              range
            })
          ),
          timeoutPromise
        ]);

        const normalized = {
          status: rawResult && rawResult.status ? rawResult.status : 'success',
          cost: typeof rawResult?.cost === 'number' ? rawResult.cost : 0,
          // Retain only compact integer waypoints, never full PathNode parent chains
          nodes: Array.isArray(rawResult?.nodes)
            ? rawResult.nodes.slice(0, 256).map((n) => ({
                x: Math.round(n.x),
                y: Math.round(n.y),
                z: Math.round(n.z)
              }))
            : [],
          bounds: computeBoundingBox(fromCell, toCell)
        };

        const ttl =
          normalized.status === 'success' ? this._cacheTtlMs : this._negativeCacheTtlMs;
        this._routeCache.set(fullKey, normalized, ttl);
        const nextRetries =
          normalized.status !== 'success'
            ? prevRetries + 1
            : forceReplan
              ? prevRetries + 1
              : 0;
        this._lastComputeByBot.set(botId, {
          targetKey: targetOnlyKey,
          fullKey,
          computedAt: this._now(),
          retries: nextRetries
        });
        return normalized;
      } catch (err) {
        if (err && err.code === 'PATH_TIMEOUT') {
          this._timeouts += 1;
          this._lastComputeByBot.set(botId, {
            targetKey: targetOnlyKey,
            fullKey,
            computedAt: this._now(),
            retries: prevRetries + 1
          });
          return {
            status: 'timeout',
            failureCode: 'PATH_TIMEOUT',
            nodes: []
          };
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        const cur = this._activeByBot.get(botId);
        if (cur && cur.promise === runPromise) {
          this._activeByBot.delete(botId);
        }
      }
    })();

    this._activeByBot.set(botId, {
      targetKey: targetOnlyKey,
      startedAt: this._now(),
      promise: runPromise,
      retries: prevRetries + (forceReplan ? 1 : 0)
    });

    return runPromise;
  }

  /**
   * Event-driven cache invalidation on Mineflayer `blockUpdate` near cached corridors.
   * @param {string} dimension
   * @param {{ x: number, y: number, z: number }} pos
   */
  onBlockUpdate(dimension, pos) {
    if (!pos) return 0;
    let removed = 0;
    const prefix = `${dimension}|`;
    // BoundedCache maxEntries <= 256, so corridor bbox check is <0.05ms
    for (const [key, entry] of this._routeCache._store.entries()) {
      if (!key.startsWith(prefix)) continue;
      const b = entry.value && entry.value.bounds;
      if (
        b &&
        pos.x >= b.minX - 2 &&
        pos.x <= b.maxX + 2 &&
        pos.y >= b.minY - 2 &&
        pos.y <= b.maxY + 2 &&
        pos.z >= b.minZ - 2 &&
        pos.z <= b.maxZ + 2
      ) {
        this._routeCache.delete(key);
        this._invalidations += 1;
        removed += 1;
      }
    }
    return removed;
  }

  clearBot(botId) {
    this._activeByBot.delete(botId);
    this._lastComputeByBot.delete(botId);
  }

  clearAll() {
    this._activeByBot.clear();
    this._lastComputeByBot.clear();
    this._routeCache.clear();
  }

  stats() {
    return {
      requestedCalls: this._requestedCalls,
      executedComputations: this._executedComputations,
      avoidedComputations: this._requestedCalls - this._executedComputations,
      dedupedInFlight: this._dedupedInFlight,
      cooldownSkipped: this._cooldownSkipped,
      cacheHits: this._cacheHits,
      invalidations: this._invalidations,
      timeouts: this._timeouts,
      cache: this._routeCache.stats()
    };
  }
}

function computeBoundingBox(a, b) {
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
    minZ: Math.min(a.z, b.z),
    maxZ: Math.max(a.z, b.z)
  };
}

module.exports = { PathfindingGuard, quantizeCoord };
