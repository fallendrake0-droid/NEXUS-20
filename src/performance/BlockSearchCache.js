'use strict';

const { BoundedCache } = require('./BoundedCache');

const SECTOR_SHIFT = 4; // 16x16x16 sub-chunk sector alignment

function sectorKey(dimension, targetKey, sx, sy, sz) {
  return `${dimension}|${targetKey}|${sx},${sy},${sz}`;
}

/**
 * Progressive-radius, zero-Vec3-allocation block search with event-driven sector caching.
 *
 * Optimisation #9 ("Unnecessary block searches"):
 * - Naive `bot.findBlocks({ maxDistance: 64 })` scans up to (129)^2 x 33 = 549,153+
 *   positions (~2.2s synchronous stall on prismarine-world when allocating Vec3 per voxel!).
 * - BlockSearchCache:
 *   1) Queries an O(1) 16x16x16 spatial sector BoundedCache first, invalidated incrementally
 *      by `onBlockUpdate()` so repeated mining steps hit cached block coordinates in <0.05ms.
 *   2) Scans outward in progressive integer shells (`8 -> 16 -> maxRadius`), stopping as soon
 *      as `count` matches are found without touching outer shells or allocating Vec3 objects.
 *   3) Caches negative ("not present nearby") verdicts with a short cooldown so bots do not
 *      repeatedly re-scan empty terrain every loop iteration.
 *   4) Respects `WorkloadGovernor` radius reductions (`32 -> 16 -> 8`) and disables
 *      non-survival scanning when pressure is critical.
 */
class BlockSearchCache {
  /**
   * @param {object} [options]
   * @param {number} [options.defaultMaxRadius=32]
   * @param {number} [options.verticalHalfSpan=12]
   * @param {number} [options.positiveTtlMs=30000]
   * @param {number} [options.negativeTtlMs=8000]
   * @param {number} [options.maxCacheEntries=512]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    this._defaultMaxRadius = options.defaultMaxRadius || 32;
    this._verticalHalfSpan = options.verticalHalfSpan || 12;
    this._positiveTtlMs = options.positiveTtlMs || 30_000;
    this._negativeTtlMs = options.negativeTtlMs || 8_000;
    this._now = options.now || Date.now;

    this._sectorCache = new BoundedCache({
      name: 'block-search-sectors',
      maxEntries: options.maxCacheEntries || 512,
      maxBytes: 384 * 1024,
      defaultTtlMs: this._positiveTtlMs,
      now: this._now
    });

    this._governorMaxRadius = this._defaultMaxRadius;
    this._allowNonEssentialScanning = true;

    this._queries = 0;
    this._cacheHits = 0;
    this._negativeHits = 0;
    this._throttledSkips = 0;
    this._voxelsVisited = 0;
    this._invalidations = 0;
  }

  /**
   * Apply dynamic radius & nonessential-scan caps from WorkloadGovernor.
   * @param {{ maxBlockSearchRadius?: number, allowNonEssentialScanning?: boolean }} directives
   */
  applyGovernorDirectives(directives = {}) {
    if (typeof directives.maxBlockSearchRadius === 'number' && directives.maxBlockSearchRadius >= 4) {
      this._governorMaxRadius = Math.trunc(directives.maxBlockSearchRadius);
    }
    if (typeof directives.allowNonEssentialScanning === 'boolean') {
      this._allowNonEssentialScanning = directives.allowNonEssentialScanning;
    }
  }

  /**
   * Find up to `count` matching block positions around `origin`.
   *
   * @param {object} params
   * @param {string} [params.dimension='minecraft:overworld']
   * @param {{ x: number, y: number, z: number }} params.origin
   * @param {string|number} params.targetId Canonical block ID / state key
   * @param {(x: number, y: number, z: number) => boolean} params.matchesAt Primitive integer predicate (no Vec3 allocation!)
   * @param {number} [params.count=4]
   * @param {number} [params.maxRadius]
   * @param {boolean} [params.essentialSurvival=false] Survival scans bypass governor pause
   */
  findBlocks(params) {
    const {
      dimension = 'minecraft:overworld',
      origin,
      targetId,
      matchesAt,
      count = 4,
      maxRadius = this._defaultMaxRadius,
      essentialSurvival = false
    } = params;

    this._queries += 1;

    if (!essentialSurvival && !this._allowNonEssentialScanning) {
      this._throttledSkips += 1;
      return { positions: [], throttled: true, voxelsVisited: 0, fromCache: false };
    }

    const ox = Math.floor(origin.x);
    const oy = Math.floor(origin.y);
    const oz = Math.floor(origin.z);
    const sx = ox >> SECTOR_SHIFT;
    const sy = oy >> SECTOR_SHIFT;
    const sz = oz >> SECTOR_SHIFT;
    const key = sectorKey(dimension, targetId, sx, sy, sz);

    const cached = this._sectorCache.get(key);
    if (cached !== undefined) {
      if (cached.length === 0) {
        this._negativeHits += 1;
        return { positions: [], throttled: false, voxelsVisited: 0, fromCache: true };
      }
      // Re-verify cached hits cheaply (at most `count` checks instead of 500,000!)
      const valid = [];
      let verifyChecks = 0;
      for (let i = 0; i < cached.length && valid.length < count; i += 1) {
        const p = cached[i];
        verifyChecks += 1;
        if (matchesAt(p.x, p.y, p.z)) {
          valid.push(p);
        }
      }
      this._voxelsVisited += verifyChecks;
      if (valid.length > 0) {
        this._cacheHits += 1;
        return { positions: valid, throttled: false, voxelsVisited: verifyChecks, fromCache: true };
      }
      this._sectorCache.delete(key);
    }

    const effectiveMaxR = essentialSurvival
      ? Math.min(maxRadius, 16)
      : Math.min(maxRadius, this._governorMaxRadius);

    const radii = [];
    for (const r of [8, 16, 32, 48, 64]) {
      if (r < effectiveMaxR) radii.push(r);
    }
    radii.push(effectiveMaxR);

    const found = [];
    let visited = 0;
    let prevR = -1;

    outer: for (let s = 0; s < radii.length; s += 1) {
      const r = radii[s];
      const yCap = Math.min(r, this._verticalHalfSpan);
      const prevYCap = prevR >= 0 ? Math.min(prevR, this._verticalHalfSpan) : -1;

      for (let dy = -yCap; dy <= yCap; dy += 1) {
        const y = oy + dy;
        const inPrevY = prevR >= 0 && Math.abs(dy) <= prevYCap;

        for (let dx = -r; dx <= r; dx += 1) {
          const x = ox + dx;
          const inPrevX = inPrevY && Math.abs(dx) <= prevR;

          for (let dz = -r; dz <= r; dz += 1) {
            if (inPrevX && Math.abs(dz) <= prevR) {
              // Skip inner box already scanned in smaller progressive shell!
              dz = prevR;
              continue;
            }
            const z = oz + dz;
            visited += 1;
            if (matchesAt(x, y, z)) {
              found.push({ x, y, z });
              if (found.length >= count) {
                break outer;
              }
            }
          }
        }
      }
      prevR = r;
    }

    this._voxelsVisited += visited;

    // Sort found blocks nearest-first by Manhattan/Euclidean squared distance
    found.sort((a, b) => {
      const da = (a.x - ox) ** 2 + (a.y - oy) ** 2 + (a.z - oz) ** 2;
      const db = (b.x - ox) ** 2 + (b.y - oy) ** 2 + (b.z - oz) ** 2;
      return da - db;
    });

    this._sectorCache.set(
      key,
      found,
      found.length > 0 ? this._positiveTtlMs : this._negativeTtlMs
    );

    return {
      positions: found,
      throttled: false,
      voxelsVisited: visited,
      fromCache: false
    };
  }

  /**
   * Event-driven sector cache update on Mineflayer `blockUpdate`.
   * Invalidates matching sector entries so mined blocks aren't returned stale and
   * newly exposed ores clear negative caches.
   */
  onBlockUpdate(dimension, pos, oldBlockId = null, newBlockId = null) {
    if (!pos) return 0;
    const sx = Math.floor(pos.x) >> SECTOR_SHIFT;
    const sy = Math.floor(pos.y) >> SECTOR_SHIFT;
    const sz = Math.floor(pos.z) >> SECTOR_SHIFT;
    const sectorReach = Math.max(1, Math.ceil(Math.max(this._defaultMaxRadius, this._governorMaxRadius) / 16));
    const ySectorReach = Math.max(1, Math.ceil(this._verticalHalfSpan / 16));
    let removed = 0;

    const targetIds = [];
    if (oldBlockId !== null && oldBlockId !== undefined) targetIds.push(String(oldBlockId));
    if (newBlockId !== null && newBlockId !== undefined) targetIds.push(String(newBlockId));

    const prefix = `${dimension}|`;
    for (const key of Array.from(this._sectorCache._store.keys())) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split('|');
      if (parts.length < 3) continue;
      const cachedTarget = parts[1];
      if (targetIds.length > 0 && !targetIds.includes(cachedTarget)) continue;

      const coords = parts[2].split(',');
      const kx = Number(coords[0]);
      const ky = Number(coords[1]);
      const kz = Number(coords[2]);
      if (
        Math.abs(kx - sx) <= sectorReach &&
        Math.abs(ky - sy) <= ySectorReach &&
        Math.abs(kz - sz) <= sectorReach
      ) {
        if (this._sectorCache.delete(key)) {
          removed += 1;
        }
      }
    }
    this._invalidations += removed;
    return removed;
  }

  clear() {
    this._sectorCache.clear();
  }

  stats() {
    return {
      queries: this._queries,
      cacheHits: this._cacheHits,
      negativeHits: this._negativeHits,
      throttledSkips: this._throttledSkips,
      voxelsVisited: this._voxelsVisited,
      avgVoxelsPerQuery:
        this._queries > 0 ? Math.round(this._voxelsVisited / this._queries) : 0,
      invalidations: this._invalidations,
      governorMaxRadius: this._governorMaxRadius,
      allowNonEssentialScanning: this._allowNonEssentialScanning,
      cache: this._sectorCache.stats()
    };
  }
}

module.exports = { BlockSearchCache };
