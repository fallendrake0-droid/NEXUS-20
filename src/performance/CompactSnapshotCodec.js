'use strict';

const crypto = require('node:crypto');

function bandFromRatio(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || max <= 0) return 'unknown';
  const r = value / max;
  if (r <= 0.25) return 'critical';
  if (r <= 0.55) return 'low';
  return 'normal';
}

/**
 * Sanitize and compress raw bot/Mineflayer state into a small detached plain DTO.
 *
 * Optimisations #1, #3, #4 & #12:
 * - Breaks all object references to Mineflayer `Bot`, `World`, `ChunkColumn`,
 *   `Entity`, `Item`, `Block`, `Vec3` and packet `Buffer` instances so caches,
 *   event queues and closures NEVER retain multi-megabyte world graphs in V8 heap.
 * - Aggregates 36–46 inventory slots (plus NBT) into compact canonical `{ itemKey: count }`
 *   maps (capped to maxDistinctItems), eliminating duplicate state across worker & master.
 * - Computes a lightweight digest so unchanged snapshots are skipped before JSON/HTTP I/O.
 */
function toCompactBotSnapshot(rawBot, options = {}) {
  const maxDistinctItems = options.maxDistinctItems || 64;
  if (!rawBot || typeof rawBot !== 'object') {
    throw new TypeError('rawBot must be an object');
  }

  const posSource =
    rawBot.position ||
    (rawBot.entity && rawBot.entity.position) ||
    null;

  const position =
    posSource &&
    typeof posSource.x === 'number' &&
    typeof posSource.y === 'number' &&
    typeof posSource.z === 'number'
      ? {
          x: Math.round(posSource.x),
          y: Math.round(posSource.y),
          z: Math.round(posSource.z)
        }
      : null;

  const health = typeof rawBot.health === 'number' ? Math.round(rawBot.health * 10) / 10 : null;
  const food = typeof rawBot.food === 'number' ? Math.round(rawBot.food * 10) / 10 : null;

  // Aggregate inventory items into canonical counts without retaining Item/NBT objects
  const counts = Object.create(null);
  let rawItems = null;
  if (Array.isArray(rawBot.inventoryItems)) {
    rawItems = rawBot.inventoryItems;
  } else if (rawBot.inventory && typeof rawBot.inventory.items === 'function') {
    rawItems = rawBot.inventory.items();
  } else if (rawBot.inventory && Array.isArray(rawBot.inventory.slots)) {
    rawItems = rawBot.inventory.slots;
  }

  let occupiedSlots = 0;
  if (Array.isArray(rawItems)) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const it = rawItems[i];
      if (!it || typeof it.count !== 'number' || it.count <= 0) continue;
      occupiedSlots += 1;
      const name = String(it.name || it.type || 'unknown').slice(0, 96);
      const ns = name.includes(':') ? name : `minecraft:${name}`;
      counts[ns] = (counts[ns] || 0) + Math.trunc(it.count);
    }
  } else if (rawBot.itemCounts && typeof rawBot.itemCounts === 'object') {
    const keys = Object.keys(rawBot.itemCounts);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = rawBot.itemCounts[k];
      if (typeof v === 'number' && v > 0) {
        const ns = k.includes(':') ? k.slice(0, 96) : `minecraft:${k.slice(0, 86)}`;
        counts[ns] = Math.trunc(v);
      }
    }
  }

  const sortedKeys = Object.keys(counts).sort().slice(0, maxDistinctItems);
  const itemCounts = {};
  for (let i = 0; i < sortedKeys.length; i += 1) {
    itemCounts[sortedKeys[i]] = counts[sortedKeys[i]];
  }

  const held = rawBot.heldItem || null;
  let activeTool = null;
  if (held && held.name) {
    const maxDurability = typeof held.maxDurability === 'number' ? held.maxDurability : null;
    const durUsed = typeof held.durabilityUsed === 'number' ? held.durabilityUsed : 0;
    const remaining = maxDurability !== null ? Math.max(0, maxDurability - durUsed) : null;
    activeTool = {
      name: String(held.name).slice(0, 64),
      durabilityBand:
        remaining !== null && maxDurability ? bandFromRatio(remaining, maxDurability) : 'unknown'
    };
  }

  return {
    botId: String(rawBot.botId || rawBot.id || 'unknown').slice(0, 64),
    status: String(rawBot.status || (rawBot.connected === false ? 'disconnected' : 'ready')).slice(0, 24),
    dimension: String(
      rawBot.dimension ||
        (rawBot.game && rawBot.game.dimension) ||
        'minecraft:overworld'
    ).slice(0, 64),
    position,
    health,
    food,
    healthBand: health !== null ? bandFromRatio(health, 20) : 'unknown',
    foodBand: food !== null ? bandFromRatio(food, 20) : 'unknown',
    occupiedSlots,
    activeTool,
    itemCounts
  };
}

/**
 * Compute a deterministic digest over semantic state fields (ignoring volatile timestamps)
 * so WorkerHost and DashboardServer skip redundant serializations & network sends.
 * @param {object} snapshot
 */
function fingerprintSnapshot(snapshot) {
  const h = crypto.createHash('sha1');
  h.update(
    JSON.stringify({
      b: snapshot.botId,
      s: snapshot.status,
      d: snapshot.dimension,
      p: snapshot.position,
      hb: snapshot.healthBand,
      fb: snapshot.foodBand,
      t: snapshot.activeTool,
      i: snapshot.itemCounts
    })
  );
  return h.digest('hex').slice(0, 16);
}

/**
 * Serialize a payload once to a UTF-8 Buffer so N recipients share 1 serialization.
 * @param {object} payload
 * @returns {Buffer}
 */
function encodeJsonBuffer(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

module.exports = {
  toCompactBotSnapshot,
  fingerprintSnapshot,
  encodeJsonBuffer,
  bandFromRatio
};
