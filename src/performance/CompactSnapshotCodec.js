'use strict';

const crypto = require('node:crypto');

const TOOL_TIERS = Object.freeze({
  wooden: 1,
  golden: 1,
  stone: 2,
  copper: 2,
  iron: 3,
  diamond: 4,
  netherite: 5
});

const TOOL_CLASSES = Object.freeze(['pickaxe', 'axe', 'shovel', 'sword', 'hoe', 'shears']);

function bandFromRatio(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || max <= 0) return 'unknown';
  const r = value / max;
  if (r <= 0.25) return 'critical';
  if (r <= 0.55) return 'low';
  return 'normal';
}

function normalizeDimension(rawDim) {
  const s = String(rawDim || '').trim().toLowerCase();
  if (!s) return 'minecraft:overworld';
  if (s === 'overworld' || s === 'minecraft:overworld') return 'minecraft:overworld';
  if (s === 'the_nether' || s === 'nether' || s === 'minecraft:the_nether') return 'minecraft:the_nether';
  if (s === 'the_end' || s === 'end' || s === 'minecraft:the_end') return 'minecraft:the_end';
  if (s === 'unknown') return 'unknown';
  return s.includes(':') ? s.slice(0, 64) : `minecraft:${s.slice(0, 54)}`;
}

function classifyToolItem(rawName, remainingDurability, maxDurability) {
  const bare = String(rawName || '')
    .toLowerCase()
    .replace(/^minecraft:/, '');
  if (bare === 'shears') {
    return {
      toolClass: 'shears',
      itemKey: 'minecraft:shears',
      tier: 'iron',
      tierRank: 3,
      remainingDurability,
      durabilityBand:
        remainingDurability !== null && maxDurability
          ? bandFromRatio(remainingDurability, maxDurability)
          : 'unknown'
    };
  }
  for (let i = 0; i < TOOL_CLASSES.length; i += 1) {
    const cls = TOOL_CLASSES[i];
    if (cls !== 'shears' && bare.endsWith(`_${cls}`)) {
      const prefix = bare.slice(0, bare.length - cls.length - 1);
      const tierRank = TOOL_TIERS[prefix] || 1;
      return {
        toolClass: cls,
        itemKey: `minecraft:${bare}`,
        tier: TOOL_TIERS[prefix] ? prefix : 'unknown',
        tierRank,
        remainingDurability,
        durabilityBand:
          remainingDurability !== null && maxDurability
            ? bandFromRatio(remainingDurability, maxDurability)
            : 'unknown'
      };
    }
  }
  return null;
}

/**
 * Sanitize and compress raw bot/Mineflayer state into a small detached plain DTO.
 *
 * Reconciles HIGH-01 & HIGH-02:
 * - Normalizes `dimension` to `minecraft:overworld | minecraft:the_nether | minecraft:the_end | unknown`.
 * - Extracts `bestToolsByClass` across ALL inventory slots + `heldItem` so bots holding torches/food
 *   are never misclassified as `MISSING_TOOL`.
 * - Preserves `options.pinnedItemKeys` ahead of `maxDistinctItems` truncation so lexically late
 *   items (`minecraft:wooden_pickaxe`) are never dropped during `diff()`.
 */
function toCompactBotSnapshot(rawBot, options = {}) {
  const maxDistinctItems = options.maxDistinctItems || 64;
  const pinnedSet = new Set(
    Array.isArray(options.pinnedItemKeys)
      ? options.pinnedItemKeys.map((k) => (String(k).includes(':') ? String(k) : `minecraft:${k}`))
      : []
  );

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

  const counts = Object.create(null);
  const bestToolsByClass = {};

  const considerTool = (it) => {
    if (!it || !it.name) return;
    const maxDur = typeof it.maxDurability === 'number' ? it.maxDurability : null;
    const durUsed = typeof it.durabilityUsed === 'number' ? it.durabilityUsed : 0;
    const rem =
      typeof it.remainingDurability === 'number'
        ? it.remainingDurability
        : maxDur !== null
          ? Math.max(0, maxDur - durUsed)
          : null;
    if (rem !== null && rem <= 0) return;
    const parsed = classifyToolItem(it.name, rem, maxDur);
    if (!parsed) return;
    const prev = bestToolsByClass[parsed.toolClass];
    if (
      !prev ||
      parsed.tierRank > prev.tierRank ||
      (parsed.tierRank === prev.tierRank &&
        (parsed.remainingDurability ?? 9999) > (prev.remainingDurability ?? 0))
    ) {
      bestToolsByClass[parsed.toolClass] = parsed;
    }
  };

  let rawItems = null;
  if (Array.isArray(rawBot.inventoryItems)) {
    rawItems = rawBot.inventoryItems;
  } else if (rawBot.inventory && typeof rawBot.inventory.items === 'function') {
    rawItems = rawBot.inventory.items();
  } else if (rawBot.inventory && Array.isArray(rawBot.inventory.slots)) {
    rawItems = rawBot.inventory.slots;
  }

  let occupiedSlots = typeof rawBot.occupiedSlots === 'number' ? Math.trunc(rawBot.occupiedSlots) : 0;
  if (Array.isArray(rawItems)) {
    occupiedSlots = 0;
    for (let i = 0; i < rawItems.length; i += 1) {
      const it = rawItems[i];
      if (!it || typeof it.count !== 'number' || it.count <= 0) continue;
      occupiedSlots += 1;
      const name = String(it.name || it.type || 'unknown').slice(0, 96);
      const ns = name.includes(':') ? name : `minecraft:${name}`;
      counts[ns] = (counts[ns] || 0) + Math.trunc(it.count);
      considerTool(it);
    }
  } else if (rawBot.itemCounts && typeof rawBot.itemCounts === 'object') {
    const keys = Object.keys(rawBot.itemCounts);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = rawBot.itemCounts[k];
      if (typeof v === 'number' && v > 0) {
        const ns = k.includes(':') ? k.slice(0, 96) : `minecraft:${k.slice(0, 86)}`;
        counts[ns] = Math.trunc(v);
        considerTool({ name: ns });
      }
    }
  }

  if (rawBot.bestToolsByClass && typeof rawBot.bestToolsByClass === 'object') {
    for (const [cls, info] of Object.entries(rawBot.bestToolsByClass)) {
      if (info && typeof info === 'object') bestToolsByClass[cls] = { ...info };
    }
  }

  const held = rawBot.heldItem || null;
  let activeTool = null;
  if (held && held.name) {
    considerTool(held);
    const maxDurability = typeof held.maxDurability === 'number' ? held.maxDurability : null;
    const durUsed = typeof held.durabilityUsed === 'number' ? held.durabilityUsed : 0;
    const remaining =
      typeof held.remainingDurability === 'number'
        ? held.remainingDurability
        : maxDurability !== null
          ? Math.max(0, maxDurability - durUsed)
          : null;
    if (remaining === null || remaining > 0) {
      activeTool = {
        name: String(held.name).slice(0, 64),
        durabilityBand:
          remaining !== null && maxDurability ? bandFromRatio(remaining, maxDurability) : 'unknown'
      };
    }
  }

  const allKeys = Object.keys(counts).sort();
  const selectedKeys = [];
  for (let i = 0; i < allKeys.length; i += 1) {
    if (pinnedSet.has(allKeys[i])) selectedKeys.push(allKeys[i]);
  }
  for (let i = 0; i < allKeys.length && selectedKeys.length < maxDistinctItems; i += 1) {
    if (!pinnedSet.has(allKeys[i])) selectedKeys.push(allKeys[i]);
  }
  selectedKeys.sort();

  const itemCounts = {};
  for (let i = 0; i < selectedKeys.length; i += 1) {
    itemCounts[selectedKeys[i]] = counts[selectedKeys[i]];
  }

  const totalMainSlots = 36;
  const freeSlots =
    typeof rawBot.freeSlots === 'number'
      ? Math.max(0, Math.trunc(rawBot.freeSlots))
      : Math.max(0, totalMainSlots - Math.min(totalMainSlots, occupiedSlots));

  return {
    botId: String(rawBot.botId || rawBot.id || 'unknown').slice(0, 64),
    status: String(rawBot.status || (rawBot.connected === false ? 'disconnected' : 'ready')).slice(0, 24),
    dimension: normalizeDimension(
      rawBot.dimension || (rawBot.game && rawBot.game.dimension) || 'minecraft:overworld'
    ),
    position,
    health,
    food,
    healthBand: health !== null ? bandFromRatio(health, 20) : 'unknown',
    foodBand: food !== null ? bandFromRatio(food, 20) : 'unknown',
    occupiedSlots,
    freeSlots,
    hasCraftingTable: (counts['minecraft:crafting_table'] || 0) > 0,
    activeTool,
    bestToolsByClass,
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
      bt: snapshot.bestToolsByClass,
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
  bandFromRatio,
  normalizeDimension,
  classifyToolItem
};
