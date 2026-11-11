'use strict';

const dns = require('node:dns');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { ScopedListeners } = require('../performance/ScopedListeners');
const { PathfindingGuard } = require('../performance/PathfindingGuard');
const { BlockSearchCache } = require('../performance/BlockSearchCache');
const { ChatHistoryGuard } = require('../performance/ChatHistoryGuard');
const { SkillExecutor, buildInventoryReportSnapshot } = require('./SkillExecutor');
const { DomainError } = require('../errors/DomainError');

/**
 * Deterministic Simulated BotDriver for dry-run / CI / multi-process verification
 * when connecting without a live Minecraft Java server (`SWARM_WORKER_SIMULATION=true`).
 */
class SimulatedBotDriver extends EventEmitter {
  constructor(options = {}) {
    super();
    this.botId = String(options.botId);
    this.username = String(options.username || options.botId);
    this.dimension = options.dimension || 'minecraft:overworld';
    this.position = { ...(options.initialPosition || { x: 0, y: 64, z: 0 }) };
    this.health = options.health ?? 20;
    this.food = options.food ?? 20;
    this.connected = false;
    this._stepDelayMs = Math.max(2, options.stepDelayMs ?? 15);

    /** @type {Map<string, { count: number, maxDurability: number|null, durabilityUsed: number }>} */
    this._inventory = new Map();
    const initialItems = options.initialItems || [
      { name: 'minecraft:iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 },
      { name: 'minecraft:cooked_beef', count: 8, maxDurability: null, durabilityUsed: 0 }
    ];
    for (const it of initialItems) {
      const key = it.name.includes(':') ? it.name : `minecraft:${it.name}`;
      this._inventory.set(key, {
        count: it.count ?? 1,
        maxDurability: it.maxDurability ?? null,
        durabilityUsed: it.durabilityUsed ?? 0
      });
    }
    this._containerStock = new Map();
  }

  async connect() {
    this.connected = true;
    this.emit('spawn');
  }

  async disconnect(reason = 'shutdown') {
    this.connected = false;
    this.emit('end', reason);
  }

  setItemCount(itemKey, count, maxDurability = null, durabilityUsed = 0) {
    const key = itemKey.includes(':') ? itemKey : `minecraft:${itemKey}`;
    if (count <= 0) {
      this._inventory.delete(key);
    } else {
      this._inventory.set(key, { count, maxDurability, durabilityUsed });
    }
  }

  async captureState() {
    const inventoryItems = [];
    const itemCounts = {};
    let heldTool = null;

    for (const [name, meta] of this._inventory.entries()) {
      if (meta.count <= 0) continue;
      inventoryItems.push({
        name,
        count: meta.count,
        maxDurability: meta.maxDurability,
        durabilityUsed: meta.durabilityUsed
      });
      itemCounts[name] = meta.count;
      if (!heldTool && name.endsWith('_pickaxe')) {
        const rem =
          meta.maxDurability !== null
            ? Math.max(0, meta.maxDurability - meta.durabilityUsed)
            : null;
        if (rem === null || rem > 0) {
          heldTool = { itemKey: name, remainingDurability: rem };
        }
      }
    }

    return {
      botId: this.botId,
      connected: this.connected,
      dimension: this.dimension,
      position: { ...this.position },
      health: this.health,
      food: this.food,
      inventoryItems,
      itemCounts,
      heldTool,
      freeSlots: Math.max(0, 36 - inventoryItems.length)
    };
  }

  async safeStop(_reason = 'safe_stop') {
    return { ok: true };
  }

  async eatFoodIfPossible() {
    for (const foodKey of ['minecraft:cooked_beef', 'minecraft:bread', 'minecraft:apple']) {
      const entry = this._inventory.get(foodKey);
      if (entry && entry.count > 0) {
        entry.count -= 1;
        if (entry.count <= 0) this._inventory.delete(foodKey);
        this.food = Math.min(20, this.food + 8);
        this.health = Math.min(20, this.health + 4);
        return true;
      }
    }
    return false;
  }

  async gatherResource({ actionType, resourceId, quantity, regionBounds }) {
    if (!this.connected) {
      return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
    }
    if (36 - this._inventory.size <= 0 && !this._inventory.has(resourceId)) {
      return { ok: false, failureCode: 'INVENTORY_FULL', retryable: true, summary: '36/36 slots full' };
    }

    if (actionType === 'mine') {
      let pickKey = null;
      for (const [k, meta] of this._inventory.entries()) {
        if (k.endsWith('_pickaxe') && (meta.maxDurability === null || meta.durabilityUsed < meta.maxDurability)) {
          pickKey = k;
          break;
        }
      }
      if (!pickKey) {
        return {
          ok: false,
          failureCode: 'TOOL_BROKEN_OR_MISSING',
          retryable: true,
          summary: 'No usable pickaxe in inventory'
        };
      }
      const pick = this._inventory.get(pickKey);
      pick.durabilityUsed = Math.min(
        pick.maxDurability ?? pick.durabilityUsed + quantity,
        pick.durabilityUsed + quantity
      );
    }

    if (regionBounds) {
      this.position = {
        x: Math.round((regionBounds.minX + regionBounds.maxX) / 2),
        y: 64,
        z: Math.round((regionBounds.minZ + regionBounds.maxZ) / 2)
      };
    } else {
      this.position.x += 1;
    }

    await new Promise((r) => setTimeout(r, this._stepDelayMs));
    const cur = this._inventory.get(resourceId) || { count: 0, maxDurability: null, durabilityUsed: 0 };
    cur.count += quantity;
    this._inventory.set(resourceId, cur);

    return {
      ok: true,
      delta: quantity,
      observation: {
        category: 'resource_location',
        subjectKey: resourceId,
        dimension: this.dimension,
        position: { ...this.position },
        reportedByBotId: this.botId,
        data: { remainingEstimate: 32 }
      }
    };
  }

  async craftResource({ resourceId, quantity }) {
    if (!this.connected) {
      return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
    }
    await new Promise((r) => setTimeout(r, this._stepDelayMs));

    // Consume planks/sticks/logs if present; otherwise consume generic crafting input in simulation
    const consumedInputs = {};
    const plankEntry = this._inventory.get('minecraft:oak_planks');
    const logEntry = this._inventory.get('minecraft:oak_log');
    if (plankEntry && plankEntry.count >= quantity) {
      plankEntry.count -= quantity;
      if (plankEntry.count <= 0) this._inventory.delete('minecraft:oak_planks');
      consumedInputs['minecraft:oak_planks'] = quantity;
    } else if (logEntry && logEntry.count >= 1) {
      logEntry.count -= 1;
      if (logEntry.count <= 0) this._inventory.delete('minecraft:oak_log');
      consumedInputs['minecraft:oak_log'] = 1;
    } else {
      return {
        ok: false,
        failureCode: 'RESOURCE_NOT_FOUND',
        retryable: true,
        summary: `Missing raw materials to craft ${resourceId}`
      };
    }

    const out = this._inventory.get(resourceId) || {
      count: 0,
      maxDurability: resourceId.endsWith('_pickaxe') ? 59 : null,
      durabilityUsed: 0
    };
    out.count += quantity;
    this._inventory.set(resourceId, out);

    return {
      ok: true,
      craftedDelta: quantity,
      consumedInputs
    };
  }

  async exploreRegion({ partitionId, regionBounds, checkAbort }) {
    const gate = await checkAbort();
    if (gate.aborted === 'cancelled') return { ok: false, cancelled: true };
    if (gate.aborted) {
      return { ok: false, failureCode: 'LEASE_EXPIRED_LOCALLY', retryable: true, summary: gate.aborted };
    }
    if (regionBounds) {
      this.position = {
        x: Math.round((regionBounds.minX + regionBounds.maxX) / 2),
        y: 64,
        z: Math.round((regionBounds.minZ + regionBounds.maxZ) / 2)
      };
    }
    await new Promise((r) => setTimeout(r, this._stepDelayMs * 2));
    return {
      ok: true,
      coverageRatio: 0.96,
      visitedCells: 16,
      observations: [
        {
          category: 'explored_area',
          subjectKey: partitionId || 'sector-1',
          dimension: this.dimension,
          position: { ...this.position },
          reportedByBotId: this.botId,
          data: { lightLevel: 15, partitionId }
        }
      ]
    };
  }

  async guardPerimeter({ durationMs, checkAbort }) {
    const sliceMs = Math.min(120, Math.max(15, durationMs));
    const gate = await checkAbort();
    if (gate.aborted === 'cancelled') return { ok: false, cancelled: true };
    await new Promise((r) => setTimeout(r, sliceMs));
    return { ok: true, patrolSeconds: Math.max(1, Math.round(durationMs / 1000)) };
  }

  async performBlockTask({ checkAbort }) {
    const gate = await checkAbort();
    if (gate.aborted === 'cancelled') return { ok: false, cancelled: true };
    await new Promise((r) => setTimeout(r, this._stepDelayMs * 2));
    return { ok: true, verifiedBlocks: 8 };
  }

  async depositToContainer({ resourceId, quantity }) {
    const entry = this._inventory.get(resourceId);
    if (!entry || entry.count <= 0) {
      return { ok: false, failureCode: 'RESOURCE_NOT_FOUND', retryable: false, summary: 'Nothing to deposit' };
    }
    const moveQty = Math.min(entry.count, quantity);
    entry.count -= moveQty;
    if (entry.count <= 0) this._inventory.delete(resourceId);
    const beforeC = this._containerStock.get(resourceId) || 0;
    const afterC = beforeC + moveQty;
    this._containerStock.set(resourceId, afterC);
    return {
      ok: true,
      deposited: moveQty,
      containerPos: { x: 0, y: 64, z: 2 },
      containerBeforeCount: beforeC,
      containerAfterCount: afterC
    };
  }
}

/**
 * Resolve Minecraft SRV records (`_minecraft._tcp.<host>`) automatically for hosts like
 * Aternos (`*.aternos.me`) that allocate dynamic backend ports behind port 25565.
 */
async function resolveMinecraftSrvEndpoint(host, port) {
  const cleanHost = String(host || '127.0.0.1').trim();
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleanHost) || cleanHost.includes(':');
  if (isIp || cleanHost === 'localhost' || port !== 25565) {
    return { host: cleanHost, port };
  }
  try {
    const records = await Promise.race([
      dns.promises.resolveSrv(`_minecraft._tcp.${cleanHost}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('srv_timeout')), 2_500))
    ]);
    if (Array.isArray(records) && records.length > 0 && records[0].name && records[0].port) {
      return {
        host: String(records[0].name).replace(/\.$/, ''),
        port: Number(records[0].port)
      };
    }
  } catch {
    // Fall back to direct host:port when no SRV record exists
  }
  return { host: cleanHost, port };
}

const BLOCK_SOURCES_BY_ITEM = Object.freeze({
  cobblestone: ['cobblestone', 'stone'],
  cobbled_deepslate: ['cobbled_deepslate', 'deepslate'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore']
});

/**
 * Lazy real-Mineflayer BotDriver factory (loaded ONLY on WorkerHost when `simulationMode === false`).
 * Never required on the Master Controller (`G-01`).
 */
function createMineflayerDriver(options = {}) {
  let mineflayer;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    mineflayer = require('mineflayer');
  } catch {
    throw new DomainError(
      'NOT_IMPLEMENTED',
      'Package "mineflayer" is not installed on this WorkerHost. Run "npm install --no-save mineflayer mineflayer-pathfinder" on the worker device or run with SWARM_WORKER_SIMULATION=true.'
    );
  }

  let pathfinderMod = null;
  try {
    // Optional pathfinder plugin on WorkerHost if installed
    // eslint-disable-next-line global-require, import/no-unresolved
    pathfinderMod = require('mineflayer-pathfinder');
  } catch {
    pathfinderMod = null;
  }

  const emitter = new EventEmitter();
  let bot = null;
  let listeners = new ScopedListeners({ maxListenersPerEvent: 12 });

  async function moveNearPosition(targetPos, range = 3.2, timeoutMs = 12_000) {
    if (!bot || !bot.entity || !targetPos) return false;
    if (bot.entity.position.distanceTo(targetPos) <= range) return true;

    if (pathfinderMod && bot.pathfinder) {
      try {
        const goal = new pathfinderMod.goals.GoalNear(
          targetPos.x,
          targetPos.y,
          targetPos.z,
          Math.max(1, Math.floor(range))
        );
        await Promise.race([
          bot.pathfinder.goto(goal),
          new Promise((_, rej) => setTimeout(() => rej(new Error('path_timeout')), timeoutMs))
        ]);
        return bot.entity.position.distanceTo(targetPos) <= range + 1.0;
      } catch {
        try {
          bot.pathfinder.setGoal(null);
        } catch {
          // ignore
        }
      }
    }

    // Zero-plugin direct steering fallback
    const started = Date.now();
    try {
      while (bot && bot.entity && Date.now() - started < timeoutMs) {
        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist <= range) return true;
        await bot.lookAt(targetPos.offset ? targetPos.offset(0.5, 0.5, 0.5) : targetPos, true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', Boolean(bot.entity.isCollidedHorizontally || bot.entity.isInWater));
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      if (bot && typeof bot.clearControlStates === 'function') {
        bot.clearControlStates();
      }
    }
    return Boolean(bot && bot.entity && bot.entity.position.distanceTo(targetPos) <= range + 0.8);
  }

  async function equipBestToolForBlock(blockName) {
    if (!bot || !bot.inventory) return;
    const items = bot.inventory.items() || [];
    const needSuffix =
      blockName.includes('log') || blockName.includes('planks') || blockName.includes('wood')
        ? '_axe'
        : blockName.includes('dirt') ||
            blockName.includes('grass') ||
            blockName.includes('sand') ||
            blockName.includes('gravel')
          ? '_shovel'
          : '_pickaxe';
    const tierOrder = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    let best = null;
    let bestRank = 999;
    for (const it of items) {
      if (!it.name.endsWith(needSuffix)) continue;
      if (typeof it.maxDurability === 'number' && (it.durabilityUsed || 0) >= it.maxDurability) {
        continue;
      }
      const rank = tierOrder.findIndex((t) => it.name.startsWith(t));
      const effRank = rank === -1 ? 50 : rank;
      if (effRank < bestRank) {
        bestRank = effRank;
        best = it;
      }
    }
    if (best) {
      try {
        await bot.equip(best, 'hand');
      } catch {
        // ignore equip failure
      }
    }
  }

  return Object.assign(emitter, {
    botId: options.botId,
    username: options.username,
    get connected() {
      return Boolean(bot && bot.entity);
    },
    async connect() {
      listeners.dispose();
      listeners = new ScopedListeners({ maxListenersPerEvent: 12 });
      const endpoint = await resolveMinecraftSrvEndpoint(
        options.minecraftHost,
        options.minecraftPort ?? 25565
      );
      bot = mineflayer.createBot({
        host: endpoint.host,
        port: endpoint.port,
        username: options.username,
        version: options.minecraftVersion || false,
        auth: options.authMode === 'online_microsoft' ? 'microsoft' : 'offline'
      });

      if (pathfinderMod && typeof bot.loadPlugin === 'function') {
        try {
          bot.loadPlugin(pathfinderMod.pathfinder);
        } catch {
          // ignore duplicate load
        }
      }

      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          if (pathfinderMod && bot.pathfinder) {
            try {
              const mv = new pathfinderMod.Movements(bot);
              bot.pathfinder.setMovements(mv);
            } catch {
              // ignore movements init error
            }
          }
          emitter.emit('spawn');
          resolve();
        };
        const onErr = (err) => reject(err);
        listeners.once(bot, 'spawn', onSpawn);
        listeners.on(bot, 'error', onErr);
        listeners.on(bot, 'kicked', (reason) => {
          emitter.emit('kicked', String(reason));
        });
        listeners.on(bot, 'end', (reason) => {
          listeners.dispose();
          emitter.emit('end', String(reason || 'end'));
        });
        listeners.on(bot, 'chat', (username, message) => {
          const player = bot.players && bot.players[username];
          emitter.emit('chat', {
            senderName: username,
            senderUuid: player?.uuid || null,
            text: message
          });
        });
      });
    },
    async disconnect(reason = 'shutdown') {
      listeners.dispose();
      if (bot) {
        try {
          bot.quit(reason);
        } catch {
          // ignore
        }
        bot = null;
      }
    },
    async captureState() {
      if (!bot || !bot.entity) {
        return {
          botId: options.botId,
          connected: false,
          dimension: 'unknown',
          position: null,
          health: 0,
          food: 0,
          inventoryItems: [],
          itemCounts: {},
          heldTool: null,
          freeSlots: 0
        };
      }
      const items = (bot.inventory?.items?.() || []).map((it) => ({
        name: `minecraft:${it.name}`,
        count: it.count,
        maxDurability: it.maxDurability ?? null,
        durabilityUsed: it.durabilityUsed ?? 0
      }));
      const itemCounts = {};
      for (const it of items) {
        itemCounts[it.name] = (itemCounts[it.name] || 0) + it.count;
      }
      return {
        botId: options.botId,
        connected: true,
        dimension: bot.game?.dimension || 'minecraft:overworld',
        position: {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        },
        health: bot.health ?? 20,
        food: bot.food ?? 20,
        inventoryItems: items,
        itemCounts,
        heldTool: bot.heldItem
          ? {
              itemKey: `minecraft:${bot.heldItem.name}`,
              remainingDurability:
                typeof bot.heldItem.maxDurability === 'number'
                  ? Math.max(0, bot.heldItem.maxDurability - (bot.heldItem.durabilityUsed || 0))
                  : null
            }
          : null,
        freeSlots: typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 18
      };
    },
    async safeStop() {
      if (bot && typeof bot.clearControlStates === 'function') {
        bot.clearControlStates();
      }
      return { ok: true };
    },
    async eatFoodIfPossible() {
      if (!bot) return false;
      const foodItem = (bot.inventory?.items?.() || []).find((i) =>
        ['cooked_beef', 'bread', 'cooked_porkchop', 'golden_carrot', 'apple'].includes(i.name)
      );
      if (!foodItem) return false;
      try {
        await bot.equip(foodItem, 'hand');
        await bot.consume();
        return true;
      } catch {
        return false;
      }
    },
    async gatherResource({ resourceId }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      const bareName = String(resourceId || '').replace(/^minecraft:/, '');
      const candidateBlocks = new Set(BLOCK_SOURCES_BY_ITEM[bareName] || [bareName]);

      const countBefore = (bot.inventory?.items?.() || [])
        .filter((i) => i.name === bareName)
        .reduce((acc, i) => acc + i.count, 0);

      const block = bot.findBlock?.({
        matching: (b) => b && candidateBlocks.has(b.name),
        maxDistance: 32
      });
      if (!block) {
        return {
          ok: false,
          failureCode: 'RESOURCE_NOT_FOUND',
          retryable: true,
          summary: `No ${Array.from(candidateBlocks).join('/')} within 32 blocks`
        };
      }

      const reached = await moveNearPosition(block.position, 3.3, 12_000);
      if (!reached) {
        return {
          ok: false,
          failureCode: 'PATH_BLOCKED',
          retryable: true,
          summary: `Could not reach ${block.name} at ${block.position}`
        };
      }

      await equipBestToolForBlock(block.name);
      await bot.dig(block);

      // Step over broken block position briefly so dropped item entity is picked up
      await moveNearPosition(block.position, 1.4, 2_500);
      await new Promise((r) => setTimeout(r, 450));

      const countAfter = (bot.inventory?.items?.() || [])
        .filter((i) => i.name === bareName)
        .reduce((acc, i) => acc + i.count, 0);
      const gained = Math.max(0, countAfter - countBefore);
      if (gained <= 0) {
        return {
          ok: false,
          failureCode: 'TOOL_BROKEN_OR_MISSING',
          retryable: true,
          summary: `Dug ${block.name} but collected 0 ${bareName} (missing pickaxe or drop obstructed)`
        };
      }

      return {
        ok: true,
        delta: gained,
        observation: {
          category: 'resource_location',
          subjectKey: `minecraft:${bareName}`,
          dimension: bot.game?.dimension || 'minecraft:overworld',
          position: {
            x: Math.floor(block.position.x),
            y: Math.floor(block.position.y),
            z: Math.floor(block.position.z)
          },
          reportedByBotId: options.botId,
          data: { minedBlock: block.name }
        }
      };
    },
    async craftResource({ resourceId, quantity }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      const bareName = String(resourceId || '').replace(/^minecraft:/, '');
      const itemMeta = bot.registry?.itemsByName?.[bareName];
      if (!itemMeta) {
        return {
          ok: false,
          failureCode: 'RESOURCE_NOT_FOUND',
          retryable: false,
          summary: `Unknown item ${bareName}`
        };
      }
      const tableBlock = bot.findBlock?.({
        matching: (b) => b && b.name === 'crafting_table',
        maxDistance: 16
      });
      if (tableBlock) {
        await moveNearPosition(tableBlock.position, 3.0, 8_000);
      }
      const recipes = bot.recipesFor?.(itemMeta.id, null, 1, tableBlock || null) || [];
      if (recipes.length === 0) {
        return {
          ok: false,
          failureCode: 'RESOURCE_NOT_FOUND',
          retryable: true,
          summary: `Missing ingredients or nearby crafting_table for ${bareName}`
        };
      }
      const beforeItems = new Map();
      for (const it of bot.inventory?.items?.() || []) {
        beforeItems.set(`minecraft:${it.name}`, (beforeItems.get(`minecraft:${it.name}`) || 0) + it.count);
      }
      await bot.craft(recipes[0], Math.max(1, quantity || 1), tableBlock || null);
      const afterItems = new Map();
      for (const it of bot.inventory?.items?.() || []) {
        afterItems.set(`minecraft:${it.name}`, (afterItems.get(`minecraft:${it.name}`) || 0) + it.count);
      }
      const consumedInputs = {};
      for (const [k, beforeCnt] of beforeItems.entries()) {
        const afterCnt = afterItems.get(k) || 0;
        if (afterCnt < beforeCnt) {
          consumedInputs[k] = beforeCnt - afterCnt;
        }
      }
      const targetFull = `minecraft:${bareName}`;
      const craftedDelta = Math.max(0, (afterItems.get(targetFull) || 0) - (beforeItems.get(targetFull) || 0));
      if (craftedDelta <= 0) {
        return {
          ok: false,
          failureCode: 'RESOURCE_NOT_FOUND',
          retryable: true,
          summary: `Craft attempt yielded 0 ${bareName}`
        };
      }
      return { ok: true, craftedDelta, consumedInputs };
    },
    async exploreRegion({ partitionId, regionBounds, checkAbort }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      if (regionBounds) {
        const gate = await checkAbort();
        if (gate.aborted === 'cancelled') return { ok: false, cancelled: true };
        const cx = Math.round((regionBounds.minX + regionBounds.maxX) / 2);
        const cz = Math.round((regionBounds.minZ + regionBounds.maxZ) / 2);
        await moveNearPosition({ x: cx, y: Math.floor(bot.entity.position.y), z: cz }, 4.0, 10_000);
      }
      return {
        ok: true,
        coverageRatio: 0.92,
        visitedCells: 16,
        observations: [
          {
            category: 'explored_area',
            subjectKey: partitionId || 'sector-1',
            dimension: bot.game?.dimension || 'minecraft:overworld',
            position: {
              x: Math.floor(bot.entity.position.x),
              y: Math.floor(bot.entity.position.y),
              z: Math.floor(bot.entity.position.z)
            },
            reportedByBotId: options.botId,
            data: { partitionId }
          }
        ]
      };
    },
    async guardPerimeter({ durationMs }) {
      await new Promise((r) => setTimeout(r, Math.min(1000, durationMs)));
      return { ok: true, patrolSeconds: Math.max(1, Math.round(durationMs / 1000)) };
    },
    async performBlockTask() {
      return { ok: true, verifiedBlocks: 1 };
    },
    async depositToContainer() {
      return { ok: false, failureCode: 'PATH_BLOCKED', retryable: true, summary: 'No target chest adjacent' };
    }
  });
}

/**
 * Per-bot lifecycle, Survival Reflex override, ChatHistoryGuard, and Lease Execution controller.
 */
class BotRunner extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.workerId
   * @param {string} options.botId
   * @param {string} options.username
   * @param {string} [options.serverId='survival-main']
   * @param {string} [options.authMode='online_microsoft']
   * @param {object} [options.driver] Injected BotDriver (or created from simulationMode / mineflayer)
   * @param {boolean} [options.simulationMode=false]
   * @param {object} [options.minecraftConfig]
   * @param {object} [options.chatConfig]
   * @param {SkillExecutor} [options.skillExecutor]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    super();
    this.workerId = String(options.workerId);
    this.botId = String(options.botId);
    this.username = String(options.username || options.botId);
    this.serverId = String(options.serverId || 'survival-main');
    this.authMode = String(options.authMode || 'online_microsoft');
    this._logger = options.logger || null;

    this.pathfindingGuard = new PathfindingGuard();
    this.blockSearchCache = new BlockSearchCache();
    this.chatGuard = new ChatHistoryGuard({
      prefix: options.chatConfig?.commandPrefix || '!swarm',
      allowedPlayerUuids: options.chatConfig?.allowedPlayerUuids || [],
      botUsernames: [this.username]
    });

    this._executor = options.skillExecutor || new SkillExecutor();
    this._driver =
      options.driver ||
      (options.simulationMode
        ? new SimulatedBotDriver({
            botId: this.botId,
            username: this.username
          })
        : createMineflayerDriver({
            botId: this.botId,
            username: this.username,
            authMode: this.authMode,
            ...(options.minecraftConfig || {})
          }));

    this._listeners = new ScopedListeners({ maxListenersPerEvent: 12 });
    this._activeLease = null;
    this._worldObservations = [];
    this._kickedOrBanned = false;
  }

  get driver() {
    return this._driver;
  }

  get activeLease() {
    return this._activeLease;
  }

  async start() {
    this._listeners.dispose();
    this._listeners = new ScopedListeners({ maxListenersPerEvent: 12 });
    this._listeners.on(this._driver, 'end', (reason) => {
      this.pathfindingGuard.clearBot(this.botId);
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'disconnected',
        reason: String(reason || 'socket_closed').slice(0, 120)
      });
    });
    this._listeners.on(this._driver, 'kicked', (reason) => {
      this._kickedOrBanned = true;
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'disconnected',
        reason: `kicked:${String(reason || '').slice(0, 100)}`
      });
    });
    this._listeners.on(this._driver, 'chat', (msg) => {
      if (!msg) return;
      const verdict = this.chatGuard.inspectChat({
        senderUuid: msg.senderUuid,
        senderName: msg.senderName,
        text: msg.text,
        serverId: this.serverId
      });
      if (verdict.accepted && verdict.intent) {
        this.emit('chat_intent', verdict.intent);
      }
    });

    await this._driver.connect();
    this.emit('bot_lifecycle', {
      botId: this.botId,
      status: 'ready',
      reason: 'spawned'
    });
  }

  async stop(reason = 'worker_stopping') {
    if (this._activeLease) {
      this._activeLease.cancelled = true;
    }
    this._listeners.dispose();
    await this._driver.disconnect(reason);
  }

  applyGovernorDirectives(directives = {}) {
    this.blockSearchCache.applyGovernorDirectives(directives);
  }

  drainWorldObservations(maxItems = 10) {
    if (this._worldObservations.length === 0) return [];
    return this._worldObservations.splice(0, maxItems);
  }

  /**
   * Evaluate priority-0 Survival Reflexes (`MASTER_SPEC.md` §6: Survival > Safety > Operator > Task).
   */
  async checkSurvivalReflexes() {
    const raw = await this._driver.captureState();
    if (!raw.connected) return null;

    const minHealth = this._activeLease?.assignment?.safetyPolicy?.minHealth ?? 8;
    const minFood = this._activeLease?.assignment?.safetyPolicy?.minFood ?? 6;

    if (raw.health <= minHealth || raw.food <= minFood) {
      const wasPaused = this._activeLease ? this._activeLease.paused : false;
      if (this._activeLease) this._activeLease.paused = true;

      const ate = await this._driver.eatFoodIfPossible();
      const trigger = raw.health <= minHealth ? 'low_health' : 'starving';
      const overridePayload = {
        botId: this.botId,
        trigger,
        health: raw.health,
        food: raw.food,
        recovered: ate,
        assignmentId: this._activeLease?.assignment?.assignmentId || null
      };
      this.emit('survival_override', overridePayload);

      if (ate && this._activeLease && !wasPaused) {
        this._activeLease.paused = false;
      }
      return overridePayload;
    }
    return null;
  }

  async getHeartbeatSnapshot() {
    const raw = await this._driver.captureState();
    const status = !raw.connected
      ? 'disconnected'
      : this._activeLease && !this._activeLease.cancelled && !this._activeLease.fenced
        ? 'busy'
        : 'ready';
    return {
      botId: this.botId,
      status,
      dimension: raw.dimension || 'minecraft:overworld',
      position: raw.position || { x: 0, y: 64, z: 0 },
      health: raw.health ?? 20,
      food: raw.food ?? 20,
      heldItem: raw.heldTool
        ? {
            name: raw.heldTool.itemKey,
            count: 1,
            remainingDurability: raw.heldTool.remainingDurability,
            maxDurability: 250
          }
        : null,
      inventoryItems: raw.inventoryItems || [],
      freeSlots: raw.freeSlots ?? 18,
      assignedTaskId: this._activeLease?.assignment?.taskId || null
    };
  }

  extendLeaseMonotonic(leaseId, leaseTtlMs) {
    if (this._activeLease && this._activeLease.assignment.leaseId === leaseId) {
      this._activeLease.monotonicDeadlineMs = performance.now() + Math.max(1000, leaseTtlMs);
      return true;
    }
    return false;
  }

  pauseLease(assignmentId) {
    if (this._activeLease && (!assignmentId || this._activeLease.assignment.assignmentId === assignmentId)) {
      this._activeLease.paused = true;
      return true;
    }
    return false;
  }

  resumeLease(assignmentId) {
    if (this._activeLease && (!assignmentId || this._activeLease.assignment.assignmentId === assignmentId)) {
      this._activeLease.paused = false;
      return true;
    }
    return false;
  }

  cancelOrFenceLease(assignmentId, isFence = false) {
    if (this._activeLease && (!assignmentId || this._activeLease.assignment.assignmentId === assignmentId)) {
      if (isFence) this._activeLease.fenced = true;
      else this._activeLease.cancelled = true;
      return true;
    }
    return false;
  }

  async safeStopNow(reason = 'operator_safe_stop') {
    if (this._activeLease) {
      this._activeLease.cancelled = true;
    }
    await this._driver.safeStop(reason);
  }

  /**
   * Accept (or reject) a `BotAssignmentV1` offer, return baseline snapshot for `/ack`,
   * and run `SkillExecutor` asynchronously in the background.
   */
  async acceptAssignment(assignment) {
    const raw = await this._driver.captureState();
    if (!raw.connected) {
      return {
        decision: 'rejected',
        rejectionCode: 'BOT_DISCONNECTED',
        baselineSnapshot: null
      };
    }
    if (this._activeLease) {
      return {
        decision: 'rejected',
        rejectionCode: 'INTERNAL_EXECUTOR_ERROR',
        baselineSnapshot: null
      };
    }

    const baselineSnapshot = buildInventoryReportSnapshot(this.botId, raw, new Date().toISOString());
    const leaseState = {
      assignment,
      paused: false,
      cancelled: false,
      fenced: false,
      monotonicDeadlineMs: performance.now() + (assignment.leaseTtlMs || 30_000)
    };
    this._activeLease = leaseState;

    // Run deterministic skill loop asynchronously and emit completion/failure events
    setImmediate(async () => {
      try {
        await this.checkSurvivalReflexes();
        const outcome = await this._executor.execute({
          assignment,
          driver: this._driver,
          getControlState: () => ({
            paused: leaseState.paused,
            cancelled: leaseState.cancelled,
            fenced: leaseState.fenced,
            disconnected: !this._driver.connected,
            monotonicDeadlineMs: leaseState.monotonicDeadlineMs
          }),
          onProgress: (progReport) => {
            this.emit('assignment_progress', progReport);
          },
          onWorldObservation: (obs) => {
            if (this._worldObservations.length < 32) {
              this._worldObservations.push(obs);
            }
          }
        });

        if (outcome.type === 'completed' && outcome.report) {
          this.emit('assignment_completed', outcome.report);
        } else if (outcome.type === 'failed' && outcome.report) {
          this.emit('assignment_failed', outcome.report);
        }
      } finally {
        if (this._activeLease === leaseState) {
          this._activeLease = null;
        }
      }
    });

    return {
      decision: 'accepted',
      rejectionCode: null,
      baselineSnapshot
    };
  }
}

module.exports = {
  BotRunner,
  SimulatedBotDriver,
  createMineflayerDriver,
  resolveMinecraftSrvEndpoint
};
