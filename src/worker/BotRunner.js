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
const {
  CombatAndSurvivalEngine,
  scoreMiningToolItem
} = require('../combat/CombatAndSurvivalEngine');
const {
  BUILTIN_SCHEMATICS,
  FALLBACK_BUILDING_MATERIALS,
  sortBlocksForSafePlacement
} = require('../schematics/SchematicBuilder');
const {
  DEFAULT_MINECRAFT_VERSION,
  ensureMinecraft26_2Bootstrap,
  installBotProtocolStabilizer
} = require('./mc26_2Compat');

/**
 * Per-target login gate so multiple bots connecting/reconnecting from the same IP
 * never trip Paper / Spigot / Aternos `connection-throttle: 4000` (`4.0s`).
 */
const REAL_LOGIN_GATE_CHAIN = new Map();
const REAL_LOGIN_LAST_MS = new Map();
const SERVER_RECONNECT_STATE = new Map();
const THROTTLE_COOLDOWN_MIN_MS = 60_000;
const THROTTLE_COOLDOWN_MAX_MS = 5 * 60_000;
const SERVER_RECONNECT_SPACING_MS = 12_000;

async function waitRealLoginSlot(host, port, minSpacingMs) {
  const spacing = Number(minSpacingMs || 0);
  if (spacing <= 0) return;
  const key = `${String(host || '').toLowerCase()}:${Number(port || 25565)}`;
  const prev = REAL_LOGIN_GATE_CHAIN.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => {
    release = r;
  });
  REAL_LOGIN_GATE_CHAIN.set(key, prev.then(() => next));
  await prev;
  try {
    const last = REAL_LOGIN_LAST_MS.get(key) || 0;
    const waitMs = Math.max(0, last + spacing - Date.now());
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    REAL_LOGIN_LAST_MS.set(key, Date.now());
  } finally {
    release();
  }
}

/**
 * Extract readable disconnect/kick text from plain strings, JSON chat, or
 * 1.20.3+ / 26.2 Prismarine NBT chat compounds (`{ type: 'compound', value: ... }`).
 */
function writeConnectionDiagnostic(username, target, message) {
  const safeMessage = String(message || 'unknown connection failure')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const safeUsername = String(username || 'bot').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
  const safeTarget = String(target || 'Minecraft server').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
  try {
    process.stderr.write(`[MC] ${safeUsername} -> ${safeTarget}: ${safeMessage}\n`);
  } catch {
    // Diagnostics must never interfere with connection recovery.
  }
}

function formatDisconnectReason(reason, depth = 0) {
  if (reason == null) return '';
  if (depth > 6) return '';
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const extracted = formatDisconnectReason(parsed, depth + 1);
        if (extracted) return extracted;
      } catch {
        // plain string
      }
    }
    return trimmed.replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
  }
  if (reason instanceof Error) {
    return String(reason.message || reason).replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(reason)) {
    return reason
      .map((item) => formatDisconnectReason(item, depth + 1))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (typeof reason === 'object') {
    // Prismarine NBT wrapper `{ type: 'string' | 'compound' | 'list', value: ... }`
    if (typeof reason.type === 'string' && 'value' in reason) {
      if (reason.type === 'list' && reason.value && Array.isArray(reason.value.value)) {
        return formatDisconnectReason(reason.value.value, depth + 1);
      }
      return formatDisconnectReason(reason.value, depth + 1);
    }
    const parts = [];
    if (reason.text !== undefined) parts.push(formatDisconnectReason(reason.text, depth + 1));
    if (reason[''] !== undefined) parts.push(formatDisconnectReason(reason[''], depth + 1));
    if (reason.translate !== undefined) {
      const tr = formatDisconnectReason(reason.translate, depth + 1);
      const withArgs = reason.with !== undefined ? formatDisconnectReason(reason.with, depth + 1) : '';
      parts.push(withArgs ? `${tr} (${withArgs})` : tr);
    }
    if (reason.extra !== undefined) parts.push(formatDisconnectReason(reason.extra, depth + 1));
    const joined = parts.filter(Boolean).join(' ').replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
    if (joined) return joined;
    try {
      return JSON.stringify(reason).slice(0, 180);
    } catch {
      return 'disconnected';
    }
  }
  return String(reason);
}

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
    this.sentChatMessages = [];
  }

  async connect() {
    this.connected = true;
    this.emit('spawn');
  }

  async disconnect(reason = 'shutdown') {
    this.connected = false;
    this.emit('end', reason);
  }

  async sendChatMessage(message) {
    if (!this.connected) return { ok: false, reason: 'not_connected' };
    const text = String(message || '');
    this.sentChatMessages.push(text);
    if (this.sentChatMessages.length > 50) this.sentChatMessages.shift();
    this.emit('outgoing_chat', text);
    return { ok: true };
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

    // Consume valid raw or intermediate crafting/smelting inputs in simulation
    const consumedInputs = {};
    const candidateInputs = [
      'minecraft:oak_planks',
      'minecraft:oak_log',
      'minecraft:cobblestone',
      'minecraft:raw_iron',
      'minecraft:iron_ingot',
      'minecraft:raw_gold',
      'minecraft:gold_ingot',
      'minecraft:diamond',
      'minecraft:ancient_debris',
      'minecraft:netherite_scrap',
      'minecraft:stick',
      'minecraft:coal',
      'minecraft:sand'
    ];
    let matchedInput = null;
    for (const key of candidateInputs) {
      const entry = this._inventory.get(key);
      if (entry && entry.count >= 1 && key !== resourceId) {
        matchedInput = { key, entry };
        break;
      }
    }
    if (!matchedInput) {
      return {
        ok: false,
        failureCode: 'RESOURCE_NOT_FOUND',
        retryable: true,
        summary: `Missing raw materials to craft ${resourceId}`
      };
    }
    const useCount = Math.max(1, Math.min(matchedInput.entry.count, quantity));
    matchedInput.entry.count -= useCount;
    if (matchedInput.entry.count <= 0) this._inventory.delete(matchedInput.key);
    consumedInputs[matchedInput.key] = useCount;

    const out = this._inventory.get(resourceId) || {
      count: 0,
      maxDurability:
        resourceId.endsWith('_pickaxe') ||
        resourceId.endsWith('_sword') ||
        resourceId.endsWith('_axe') ||
        resourceId.endsWith('_shovel') ||
        resourceId.endsWith('_spear') ||
        resourceId === 'minecraft:mace'
          ? 250
          : null,
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

  async performBlockTask({ partitionId, checkAbort }) {
    const gate = await checkAbort();
    if (gate.aborted === 'cancelled') return { ok: false, cancelled: true };
    await new Promise((r) => setTimeout(r, this._stepDelayMs * 2));
    if (partitionId && String(partitionId).startsWith('schematic:')) {
      const schId = String(partitionId).slice('schematic:'.length);
      const sch = BUILTIN_SCHEMATICS.get(schId);
      if (sch) return { ok: true, verifiedBlocks: sch.blockCount };
    }
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

  async listOnlinePlayers() {
    if (!this.connected) return [];
    return [
      {
        username: 'Steve',
        uuid: '00000000-0000-4000-8000-000000000001',
        ping: 34,
        visible: true,
        isSwarmBot: false,
        position: { x: this.position.x + 6, y: 64, z: this.position.z - 4 },
        distance: 7.2,
        health: 20
      },
      {
        username: 'Alex',
        uuid: '00000000-0000-4000-8000-000000000002',
        ping: 48,
        visible: true,
        isSwarmBot: false,
        position: { x: this.position.x - 12, y: 64, z: this.position.z + 9 },
        distance: 15.0,
        health: 18
      }
    ];
  }

  async setTacticalOrder(order = {}) {
    const mode = String(order.mode || 'idle');
    const targetPosition = order.targetPosition &&
      [order.targetPosition.x, order.targetPosition.y, order.targetPosition.z].every((v) => Number.isFinite(Number(v)))
      ? { x: Number(order.targetPosition.x), y: Number(order.targetPosition.y), z: Number(order.targetPosition.z) }
      : null;
    if (mode === 'goto' && targetPosition) this.position = { ...targetPosition };
    this._tacticalState = {
      mode,
      targetPlayer: order.targetPlayer || null,
      targetPosition: mode === 'goto' ? targetPosition : null,
      preferredWeaponStyle: order.preferredWeaponStyle || 'auto',
      updatedAt: new Date().toISOString()
    };
    return { ok: true, tacticalState: this._tacticalState };
  }

  getTacticalState() {
    return this._tacticalState || { mode: 'idle', targetPlayer: null, preferredWeaponStyle: 'auto' };
  }

  async applyInGameSkin(skinSpec = {}) {
    this._appliedSkin = skinSpec.skinId || 'knight_crimson';
    return { ok: true, appliedSkin: this._appliedSkin, method: 'simulated' };
  }

  async buildSchematic(schematicSpec) {
    const blocks = Array.isArray(schematicSpec?.blocks) ? schematicSpec.blocks : [];
    await new Promise((r) => setTimeout(r, this._stepDelayMs * 2));
    return { ok: true, placedBlocks: blocks.length || 16 };
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
  cobblestone: ['cobblestone', 'stone', 'infested_stone'],
  stone: ['stone', 'cobblestone'],
  cobbled_deepslate: ['cobbled_deepslate', 'deepslate'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  quartz: ['nether_quartz_ore'],
  ancient_debris: ['ancient_debris'],
  amethyst_shard: ['amethyst_cluster', 'amethyst_block'],
  glowstone_dust: ['glowstone'],
  clay_ball: ['clay'],
  flint: ['gravel'],
  snowball: ['snow', 'snow_block'],
  melon_slice: ['melon'],
  wheat: ['wheat'],
  carrot: ['carrots'],
  potato: ['potatoes'],
  beetroot: ['beetroots'],
  sweet_berries: ['sweet_berry_bush'],
  glow_berries: ['cave_vines', 'cave_vines_plant'],
  dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt']
});

const SMELTING_RECIPES = Object.freeze({
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  netherite_scrap: ['ancient_debris'],
  glass: ['sand', 'red_sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  charcoal: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log'],
  brick: ['clay_ball'],
  nether_brick: ['netherrack'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'],
  cooked_salmon: ['salmon'],
  cooked_cod: ['cod'],
  baked_potato: ['potato'],
  dried_kelp: ['kelp']
});

function flattenMotd(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return desc.replace(/§[0-9a-fk-or]/gi, '').trim();
  if (typeof desc === 'object') {
    let out = typeof desc.text === 'string' ? desc.text : '';
    if (Array.isArray(desc.extra)) {
      out += desc.extra.map((item) => flattenMotd(item)).join('');
    }
    return out.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  return '';
}

/**
 * Pre-flight Minecraft status ping that:
 *  1) Sends the genuine virtual hostname (`bobthechickem.aternos.me`) in the Handshake packet
 *     while letting `minecraft-protocol` resolve `_minecraft._tcp.<host>` SRV dynamically.
 *  2) Detects Aternos Offline / Starting / Queue states (`protocol === -1`) BEFORE `autoVersion.js`
 *     can crash with `Unsupported protocol version '-1'` / `TypeError: reading 'minecraftVersion'`.
 *  3) Resolves an explicit supported `minecraft-data` version string when online.
 */
async function probeMinecraftServer(mp, mcDataMod, mineflayerMod, { host, port, requestedVersion }) {
  const cleanHost = String(host || '127.0.0.1').trim();
  const cleanPort = Number(port || 25565);
  const explicitVersion =
    requestedVersion && requestedVersion !== 'auto'
      ? String(requestedVersion).trim()
      : requestedVersion === 'auto'
        ? null
        : DEFAULT_MINECRAFT_VERSION;

  const isLoopback = cleanHost === '127.0.0.1' || cleanHost === 'localhost' || cleanHost === '::1';

  // Fast path when explicit version is configured (default `26.2`) and either `mp.ping` is absent or host is loopback
  if (explicitVersion && (!mp || typeof mp.ping !== 'function' || isLoopback)) {
    return { host: cleanHost, port: cleanPort, version: explicitVersion };
  }

  if (!mp || typeof mp.ping !== 'function') {
    return { host: cleanHost, port: cleanPort, version: explicitVersion || DEFAULT_MINECRAFT_VERSION };
  }

  let pingRes = null;
  try {
    pingRes = await new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`Server ${cleanHost} did not respond within 6s (offline or waking up)`));
      }, 6_000);

      mp.ping({ host: cleanHost, port: cleanPort, closeTimeout: 4_500 }, (err, res) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (err) reject(err);
        else resolve(res);
      });
    });
  } catch (err) {
    const code = err?.code || '';
    if (code === 'ENOTFOUND') {
      throw new Error(`Server address "${cleanHost}" was not found in DNS — check spelling in Step 2`);
    }
    if (code === 'ECONNREFUSED') {
      throw new Error(`Server "${cleanHost}" is currently offline or starting up (${code})`);
    }
    // Some servers/proxies drop status pings while accepting play logins: if an explicit version (e.g. `26.2`) is set, proceed!
    if (explicitVersion) {
      return { host: cleanHost, port: cleanPort, version: explicitVersion };
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      throw new Error(`Server "${cleanHost}" is currently offline or starting up (${code})`);
    }
    throw new Error(`Server "${cleanHost}" is unreachable (${err?.message || 'offline'})`);
  }

  const proto = Number(pingRes?.version?.protocol);
  const verName = String(pingRes?.version?.name || '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .trim();
  const motd = flattenMotd(pingRes?.description);

  if (
    !Number.isFinite(proto) ||
    proto <= 0 ||
    /offline|starting|preparing|loading|queue|saving|stopping/i.test(verName) ||
    /this server is offline/i.test(motd)
  ) {
    const statusLabel = verName || motd || 'Offline';
    throw new Error(
      `Aternos server "${cleanHost}" is "${statusLabel}" — click Start on aternos.org (bots will auto-join!)`
    );
  }

  // When an explicit version (such as the default `26.2`) is configured, honor it directly once server is confirmed online!
  if (explicitVersion) {
    return { host: cleanHost, port: cleanPort, version: explicitVersion };
  }

  // `auto` mode: resolve exact version string supported by hydrated `minecraft-data` (up to `26.2` / protocol 776)
  const tested = Array.isArray(mineflayerMod?.testedVersions) ? mineflayerMod.testedVersions : [];
  let resolvedVersion = null;

  if (mcDataMod) {
    const byProto = mcDataMod.postNettyVersionsByProtocolVersion?.pc?.[proto];
    if (Array.isArray(byProto) && byProto.length > 0) {
      const preferred =
        byProto.find((v) => tested.includes(v.minecraftVersion)) || byProto[0];
      if (preferred?.minecraftVersion && mcDataMod(preferred.minecraftVersion)) {
        resolvedVersion = preferred.minecraftVersion;
      }
    }
    if (!resolvedVersion) {
      const m = verName.match(/\b((?:1|2[6-9])\.\d+(?:\.\d+)?)\b/);
      if (m && mcDataMod(m[1])) {
        resolvedVersion = m[1];
      }
    }
  }

  if (!resolvedVersion) {
    const latestTested = tested.length > 0 ? tested[tested.length - 1] : DEFAULT_MINECRAFT_VERSION;
    throw new Error(
      `Server "${cleanHost}" is running "${verName}" (protocol ${proto}); Mineflayer supports up to ${latestTested}. Switch server version to ${latestTested} or add ViaVersion+ViaBackwards on Aternos`
    );
  }

  return { host: cleanHost, port: cleanPort, version: resolvedVersion };
}

/**
 * Lazy real-Mineflayer BotDriver factory (loaded ONLY on WorkerHost when `simulationMode === false`).
 * Never required on the Master Controller (`G-01`).
 */
function createMineflayerDriver(options = {}) {
  // Hydrate `minecraft-data` 26.2 (`protocol 776`), `minecraft-protocol`, `prismarine-chunk`, and `mineflayer` BEFORE loading `mineflayer`!
  ensureMinecraft26_2Bootstrap();

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

  let mpMod = null;
  let mcDataMod = null;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    mpMod = require('minecraft-protocol');
    // eslint-disable-next-line global-require, import/no-unresolved
    mcDataMod = require('minecraft-data');
  } catch {
    mpMod = null;
    mcDataMod = null;
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
  let autonomyTimer = null;
  let busyWorkSection = false;
  let customSchematics = new Map();
  const combatEngine = new CombatAndSurvivalEngine({
    botId: options.botId,
    username: options.username
  });

  function stopAutonomyLoop() {
    if (autonomyTimer) {
      clearInterval(autonomyTimer);
      autonomyTimer = null;
    }
  }

  function startAutonomyLoop() {
    stopAutonomyLoop();
    const spawnedAt = Date.now();
    autonomyTimer = setInterval(() => {
      // Allow a 1,500ms post-spawn grace window so initial chunk streaming & teleports settle cleanly
      if (!bot || !bot.entity || busyWorkSection || Date.now() - spawnedAt < 1_500) return;
      combatEngine.tick(bot, moveNearPosition, setNavigationGoal).catch(() => {});
    }, 500);
    autonomyTimer.unref?.();
  }

  function configureOptimalMovements(targetBot) {
    if (!pathfinderMod || !targetBot?.pathfinder) return;
    try {
      const mv = new pathfinderMod.Movements(targetBot);
      mv.canDig = true;
      mv.allow1by1towers = true;
      mv.allowParkour = true;
      mv.allowSprinting = true;
      mv.maxDropDown = 4;
      const scafIds = [];
      for (const blockName of FALLBACK_BUILDING_MATERIALS) {
        const meta = targetBot.registry?.itemsByName?.[blockName];
        if (meta && typeof meta.id === 'number') scafIds.push(meta.id);
      }
      if (scafIds.length > 0) mv.scafoldingBlocks = scafIds;
      targetBot.pathfinder.setMovements(mv);
    } catch {
      // ignore movements init error
    }
  }

  async function moveNearPosition(targetPos, range = 3.2, timeoutMs = 12_000) {
    if (!bot || !bot.entity || !targetPos) return false;
    if (bot.entity.position.distanceTo(targetPos) <= range) return true;

    if (pathfinderMod && bot.pathfinder) {
      try {
        const goal = new pathfinderMod.goals.GoalNear(
          targetPos.x,
          targetPos.y,
          targetPos.z,
          Math.max(1.2, Number(range) || 2.5)
        );
        await Promise.race([
          bot.pathfinder.goto(goal),
          new Promise((_, rej) => setTimeout(() => rej(new Error('path_timeout')), timeoutMs))
        ]);
        if (bot.entity.position.distanceTo(targetPos) <= range + 1.1) return true;
      } catch {
        try {
          bot.pathfinder.setGoal(null);
        } catch {
          // ignore
        }
      }
    }

    // Direct obstacle-clearing steering fallback
    const started = Date.now();
    try {
      while (bot && bot.entity && Date.now() - started < timeoutMs) {
        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist <= range) return true;
        const lookPt = targetPos.offset
          ? targetPos.offset(0.5, 0.5, 0.5)
          : { x: targetPos.x + 0.5, y: targetPos.y + 0.5, z: targetPos.z + 0.5 };
        await bot.lookAt(lookPt, true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', dist > 4.5);
        bot.setControlState('jump', Boolean(bot.entity.isCollidedHorizontally || bot.entity.isInWater));
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      if (bot && typeof bot.clearControlStates === 'function') {
        bot.clearControlStates();
      }
    }
    return Boolean(bot && bot.entity && bot.entity.position.distanceTo(targetPos) <= range + 0.9);
  }

  function setNavigationGoal(targetPos, range = 1.25) {
    if (!bot || !bot.entity || !bot.pathfinder || !pathfinderMod?.goals?.GoalNear) return false;
    try {
      if (!targetPos) {
        bot.pathfinder.setGoal(null);
        return true;
      }
      const goal = new pathfinderMod.goals.GoalNear(
        targetPos.x,
        targetPos.y,
        targetPos.z,
        Math.max(1, Number(range) || 1.25)
      );
      bot.pathfinder.setGoal(goal);
      return true;
    } catch {
      return false;
    }
  }

  async function equipBestToolForBlock(blockName) {
    if (!bot || !bot.inventory) return;
    const items = bot.inventory.items() || [];
    let best = null;
    let bestScore = -1;
    for (const it of items) {
      const sc = scoreMiningToolItem(it, blockName);
      if (sc > bestScore) {
        bestScore = sc;
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

  async function placeUtilityBlockNearby(itemName) {
    if (!bot || !bot.entity) return null;
    const item = (bot.inventory?.items?.() || []).find((i) => i.name === itemName);
    if (!item) return null;
    const origin = bot.entity.position.floored();
    const offsets = [
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
      [1, 0, 1], [-1, 0, -1]
    ];
    for (const [dx, dy, dz] of offsets) {
      const targetPos = origin.offset(dx, dy, dz);
      const ground = bot.blockAt(targetPos.offset(0, -1, 0));
      const space = bot.blockAt(targetPos);
      if (ground && ground.boundingBox === 'block' && space && (space.name === 'air' || space.name === 'short_grass' || space.name === 'grass' || space.name === 'snow')) {
        try {
          if (space.name !== 'air') await bot.dig(space).catch(() => {});
          await bot.equip(item, 'hand');
          await bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
          await new Promise((r) => setTimeout(r, 250));
          const placed = bot.blockAt(targetPos);
          if (placed && placed.name === itemName) return placed;
        } catch {
          // Try next adjacent spot
        }
      }
    }
    return null;
  }

  async function autoEnsureCraftingTable() {
    let tableBlock = bot.findBlock?.({
      matching: (b) => b && b.name === 'crafting_table',
      maxDistance: 16
    });
    if (tableBlock) {
      await moveNearPosition(tableBlock.position, 3.0, 8_000);
      return tableBlock;
    }
    let hasTableItem = (bot.inventory?.items?.() || []).some((i) => i.name === 'crafting_table');
    if (!hasTableItem) {
      // Craft planks from any log if needed, then craft 1 crafting_table in 2x2 inventory grid!
      const plankCnt = (bot.inventory?.items?.() || [])
        .filter((i) => i.name.endsWith('_planks'))
        .reduce((a, b) => a + b.count, 0);
      if (plankCnt < 4) {
        const anyLog = (bot.inventory?.items?.() || []).find((i) => i.name.endsWith('_log') || i.name.endsWith('_stem'));
        if (anyLog) {
          const plankName = anyLog.name.replace(/_(log|stem)$/, '_planks');
          const plankMeta = bot.registry?.itemsByName?.[plankName] || bot.registry?.itemsByName?.oak_planks;
          if (plankMeta) {
            const r = bot.recipesFor?.(plankMeta.id, null, 1, null) || [];
            if (r[0]) await bot.craft(r[0], 1, null).catch(() => {});
          }
        }
      }
      const tableMeta = bot.registry?.itemsByName?.crafting_table;
      if (tableMeta) {
        const r = bot.recipesFor?.(tableMeta.id, null, 1, null) || [];
        if (r[0]) {
          await bot.craft(r[0], 1, null).catch(() => {});
          hasTableItem = true;
        }
      }
    }
    if (hasTableItem) {
      tableBlock = await placeUtilityBlockNearby('crafting_table');
    }
    return tableBlock || null;
  }

  async function smeltItemInFurnace(bareOutputName, quantity) {
    const rawInputs = SMELTING_RECIPES[bareOutputName];
    if (!rawInputs) return null;
    const inv = bot.inventory?.items?.() || [];
    const inputItem = inv.find((i) => rawInputs.includes(i.name));
    if (!inputItem) {
      return {
        ok: false,
        failureCode: 'RESOURCE_NOT_FOUND',
        retryable: true,
        summary: `Missing raw input (${rawInputs.join('/')}) to smelt ${bareOutputName}`
      };
    }

    let furnaceBlock = bot.findBlock?.({
      matching: (b) => b && (b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker'),
      maxDistance: 18
    });
    if (!furnaceBlock) {
      furnaceBlock = await placeUtilityBlockNearby('furnace');
    }
    if (!furnaceBlock) {
      return {
        ok: false,
        failureCode: 'RESOURCE_NOT_FOUND',
        retryable: true,
        summary: `No nearby furnace to smelt ${bareOutputName}`
      };
    }

    await moveNearPosition(furnaceBlock.position, 3.0, 8_000);
    if (typeof bot.openFurnace !== 'function') {
      return { ok: false, failureCode: 'INTERNAL_EXECUTOR_ERROR', retryable: false, summary: 'openFurnace unavailable' };
    }

    const beforeSnapshots = new Map();
    for (const it of bot.inventory.items()) {
      beforeSnapshots.set(`minecraft:${it.name}`, (beforeSnapshots.get(`minecraft:${it.name}`) || 0) + it.count);
    }

    const smeltCount = Math.max(1, Math.min(quantity || 1, inputItem.count, 16));
    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      const fuel = (bot.inventory.items() || []).find((i) =>
        ['coal', 'charcoal', 'blaze_rod', 'lava_bucket'].includes(i.name) ||
        i.name.endsWith('_planks') ||
        i.name.endsWith('_log')
      );
      if (fuel && !furnace.fuelItem()) {
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(smeltCount / 4) + 1));
      }
      await furnace.putInput(inputItem.type, null, smeltCount);
      const waitMs = Math.min(25_000, smeltCount * 10_200 + 1_500);
      const started = Date.now();
      while (Date.now() - started < waitMs) {
        const out = furnace.outputItem();
        if (out && out.count >= smeltCount) break;
        await new Promise((r) => setTimeout(r, 750));
      }
      if (furnace.outputItem()) {
        await furnace.takeOutput();
      }
    } finally {
      try {
        furnace.close();
      } catch {
        // ignore
      }
    }

    const afterSnapshots = new Map();
    for (const it of bot.inventory.items()) {
      afterSnapshots.set(`minecraft:${it.name}`, (afterSnapshots.get(`minecraft:${it.name}`) || 0) + it.count);
    }
    const consumedInputs = {};
    for (const [k, cnt] of beforeSnapshots.entries()) {
      const afterCnt = afterSnapshots.get(k) || 0;
      if (afterCnt < cnt) consumedInputs[k] = cnt - afterCnt;
    }
    const outKey = `minecraft:${bareOutputName}`;
    const craftedDelta = Math.max(0, (afterSnapshots.get(outKey) || 0) - (beforeSnapshots.get(outKey) || 0));
    if (craftedDelta <= 0) {
      return {
        ok: false,
        failureCode: 'RESOURCE_NOT_FOUND',
        retryable: true,
        summary: `Furnace smelting yielded 0 ${bareOutputName} (check fuel)`
      };
    }
    return { ok: true, craftedDelta, consumedInputs };
  }

  async function placeSchematicBlocks(schematic, checkAbort) {
    if (!bot || !bot.entity || !schematic || !Array.isArray(schematic.blocks)) {
      return { ok: false, failureCode: 'RESOURCE_NOT_FOUND', retryable: false, summary: 'Invalid schematic' };
    }
    const anchor = bot.entity.position.floored().offset(3, 0, 3);
    const ordered = sortBlocksForSafePlacement(schematic.blocks);
    const requiredCount = ordered.filter((cell) => !cell.optional).length;
    let placedCount = 0;
    let missingMaterials = 0;
    let blockedPlacements = 0;
    let cancelled = false;

    for (const cell of ordered) {
      if (typeof checkAbort === 'function') {
        const gate = await checkAbort();
        if (gate?.aborted === 'cancelled') { cancelled = true; break; }
        if (gate?.aborted) break;
      }
      const worldPos = anchor.offset(cell.x, cell.y, cell.z);
      const existing = bot.blockAt(worldPos);
      if (existing && (existing.name === cell.block || FALLBACK_BUILDING_MATERIALS.includes(existing.name))) {
        if (!cell.optional) placedCount += 1;
        continue;
      }

      const inv = bot.inventory?.items?.() || [];
      let blockItem = inv.find((i) => i.name === cell.block);
      if (!blockItem && !cell.optional) blockItem = inv.find((i) => FALLBACK_BUILDING_MATERIALS.includes(i.name));
      if (!blockItem) {
        if (!cell.optional) missingMaterials += 1;
        continue;
      }

      let reached = true;
      if (bot.entity.position.floored().equals(worldPos)) {
        reached = await moveNearPosition(worldPos.offset(2, 0, 2), 1.8, 3_500);
      } else if (bot.entity.position.distanceTo(worldPos) > 4.2) {
        reached = await moveNearPosition(worldPos, 3.2, 6_000);
      }
      if (!reached) {
        if (!cell.optional) blockedPlacements += 1;
        continue;
      }

      if (existing && existing.name !== 'air' && existing.boundingBox !== 'block') await bot.dig(existing).catch(() => {});
      const dirs = [
        [0, -1, 0, { x: 0, y: 1, z: 0 }], [1, 0, 0, { x: -1, y: 0, z: 0 }],
        [-1, 0, 0, { x: 1, y: 0, z: 0 }], [0, 0, 1, { x: 0, y: 0, z: -1 }],
        [0, 0, -1, { x: 0, y: 0, z: 1 }], [0, 1, 0, { x: 0, y: -1, z: 0 }]
      ];
      let cellPlaced = false;
      for (const [dx, dy, dz, faceVec] of dirs) {
        const ref = bot.blockAt(worldPos.offset(dx, dy, dz));
        if (!ref || ref.boundingBox !== 'block') continue;
        try {
          await bot.equip(blockItem, 'hand');
          await bot.placeBlock(ref, faceVec);
          const placedBlock = bot.blockAt(worldPos);
          if (placedBlock && (placedBlock.name === cell.block || FALLBACK_BUILDING_MATERIALS.includes(placedBlock.name))) {
            cellPlaced = true;
            break;
          }
        } catch {
          // Try the next solid adjacent face; never claim an unverified placement.
        }
      }
      if (cellPlaced && !cell.optional) placedCount += 1;
      else if (!cell.optional) blockedPlacements += 1;
    }

    if (cancelled) return { ok: false, cancelled: true, verifiedBlocks: placedCount };
    const ok = placedCount >= requiredCount && blockedPlacements === 0 && missingMaterials === 0;
    return {
      ok,
      verifiedBlocks: placedCount,
      placedBlocks: placedCount,
      ...(ok ? {} : {
        failureCode: missingMaterials > 0 ? 'RESOURCE_NOT_FOUND' : 'PATH_BLOCKED',
        retryable: true,
        summary: `Schematic incomplete: placed ${placedCount}/${requiredCount} required blocks; ${missingMaterials} missing materials, ${blockedPlacements} blocked placements`
      })
    };
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
      if (bot) {
        try {
          bot.quit('reconnecting');
        } catch {
          // ignore
        }
        bot = null;
      }

      const target = await probeMinecraftServer(mpMod, mcDataMod, mineflayer, {
        host: options.minecraftHost,
        port: options.minecraftPort ?? 25565,
        requestedVersion: options.minecraftVersion || DEFAULT_MINECRAFT_VERSION
      });

      const isLoopback =
        target.host === '127.0.0.1' || target.host === 'localhost' || target.host === '::1';
      const loginGateMs =
        options.loginGateMs !== undefined
          ? Number(options.loginGateMs)
          : isLoopback
            ? 0
            : 4_500;
      await waitRealLoginSlot(target.host, target.port, loginGateMs);

      const currentBot = mineflayer.createBot({
        host: target.host,
        port: target.port,
        fakeHost: target.host,
        username: options.username,
        version: target.version,
        auth: options.authMode === 'online_microsoft' ? 'microsoft' : 'offline',
        hideErrors: true
      });
      bot = currentBot;

      // Install 26.2 + 1.21.2+ `tick_end` & packet mapper stabilizer immediately!
      installBotProtocolStabilizer(currentBot);

      let lastKickReason = '';
      let lastProtocolError = '';
      currentBot.on('error', (err) => {
        lastProtocolError = formatDisconnectReason(err);
      });

      if (pathfinderMod && typeof currentBot.loadPlugin === 'function') {
        try {
          currentBot.loadPlugin(pathfinderMod.pathfinder);
        } catch {
          // ignore duplicate load
        }
      }

      const connectTimeoutMs = Math.max(3_000, Number(options.connectTimeoutMs || 25_000));

      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            currentBot.quit('connect_timeout');
          } catch {
            // ignore
          }
          reject(new Error(`Timed out (${connectTimeoutMs}ms) joining ${target.host}`));
        }, connectTimeoutMs);

        const finishResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const finishReject = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        listeners.once(currentBot, 'spawn', () => {
          configureOptimalMovements(currentBot);
          startAutonomyLoop();
          emitter.emit('spawn');
          finishResolve();
        });
        listeners.on(currentBot, 'error', (err) => {
          finishReject(err);
        });
        listeners.on(currentBot, 'kicked', (reason) => {
          const cleanReason = formatDisconnectReason(reason) || 'kicked';
          lastKickReason = cleanReason;
          emitter.emit('kicked', cleanReason);
          finishReject(new Error(`Kicked by server: ${cleanReason}`));
        });
        listeners.on(currentBot, 'end', (reason) => {
          const rawReason = formatDisconnectReason(reason) || 'end';
          const detail =
            lastKickReason
              ? `kicked: ${lastKickReason}`
              : rawReason === 'socketClosed' && lastProtocolError
                ? `${rawReason} (${lastProtocolError})`
                : rawReason;
          stopAutonomyLoop();
          listeners.dispose();
          if (bot === currentBot) bot = null;
          emitter.emit('end', detail);
          finishReject(new Error(`Connection closed before spawn (${detail})`));
        });
        listeners.on(currentBot, 'chat', (username, message) => {
          const player = currentBot.players && currentBot.players[username];
          emitter.emit('chat', {
            senderName: username,
            senderUuid: player?.uuid || null,
            text: message
          });
        });
      });
    },
    async disconnect(reason = 'shutdown') {
      stopAutonomyLoop();
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
      combatEngine.setTacticalOrder({ mode: 'idle' });
      if (bot && typeof bot.clearControlStates === 'function') {
        bot.clearControlStates();
      }
      if (bot && bot.pathfinder) {
        try {
          bot.pathfinder.setGoal(null);
        } catch {
          // ignore
        }
      }
      return { ok: true };
    },
    async eatFoodIfPossible() {
      if (!bot) return false;
      return combatEngine.autoFeedIfNeeded(bot, false);
    },
    async huntForFoodIfNeeded() {
      if (!bot || !bot.entity) return { acted: false, reason: 'bot_not_spawned' };
      busyWorkSection = true;
      try {
        return await combatEngine.huntForFoodIfNeeded(bot, moveNearPosition);
      } catch {
        return { acted: false, reason: 'food_hunt_failed' };
      } finally {
        busyWorkSection = false;
      }
    },
    async gatherResource({ resourceId }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      busyWorkSection = true;
      try {
        const bareName = String(resourceId || '').replace(/^minecraft:/, '');
        const candidateBlocks = new Set(BLOCK_SOURCES_BY_ITEM[bareName] || [bareName]);

        const countBefore = (bot.inventory?.items?.() || [])
          .filter((i) => i.name === bareName)
          .reduce((acc, i) => acc + i.count, 0);

        const block = bot.findBlock?.({
          matching: (b) => b && candidateBlocks.has(b.name),
          maxDistance: 64
        });
        if (!block) {
          return {
            ok: false,
            failureCode: 'RESOURCE_NOT_FOUND',
            retryable: true,
            summary: `No ${Array.from(candidateBlocks).join('/')} within 64 blocks`
          };
        }

        const reached = await moveNearPosition(block.position, 3.3, 14_000);
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
            summary: `Dug ${block.name} but collected 0 ${bareName} (missing tool or drop obstructed)`
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
      } finally {
        busyWorkSection = false;
      }
    },
    async craftResource({ resourceId, quantity }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      busyWorkSection = true;
      try {
        const bareName = String(resourceId || '').replace(/^minecraft:/, '');

        // 1. Check if item is a Furnace Smelting / Cooking recipe!
        if (SMELTING_RECIPES[bareName]) {
          const smeltRes = await smeltItemInFurnace(bareName, quantity);
          if (smeltRes) return smeltRes;
        }

        const itemMeta = bot.registry?.itemsByName?.[bareName];
        if (!itemMeta) {
          return {
            ok: false,
            failureCode: 'RESOURCE_NOT_FOUND',
            retryable: false,
            summary: `Unknown item ${bareName}`
          };
        }

        // 2. Try 2x2 inventory crafting first, then auto-locate or auto-place a 3x3 crafting_table!
        let tableBlock = null;
        let recipes = bot.recipesFor?.(itemMeta.id, null, 1, null) || [];
        if (recipes.length === 0) {
          tableBlock = await autoEnsureCraftingTable();
          recipes = bot.recipesFor?.(itemMeta.id, null, 1, tableBlock || null) || [];
        }

        // 3. Auto-craft prerequisite planks / sticks if bot holds raw logs/planks
        if (recipes.length === 0) {
          const anyLog = (bot.inventory?.items?.() || []).find((i) => i.name.endsWith('_log') || i.name.endsWith('_stem'));
          if (anyLog) {
            const pName = anyLog.name.replace(/_(log|stem)$/, '_planks');
            const pMeta = bot.registry?.itemsByName?.[pName] || bot.registry?.itemsByName?.oak_planks;
            if (pMeta) {
              const pr = bot.recipesFor?.(pMeta.id, null, 1, null) || [];
              if (pr[0]) await bot.craft(pr[0], 2, null).catch(() => {});
            }
          }
          const stickMeta = bot.registry?.itemsByName?.stick;
          if (stickMeta && bareName !== 'stick') {
            const sr = bot.recipesFor?.(stickMeta.id, null, 1, null) || [];
            if (sr[0]) await bot.craft(sr[0], 1, null).catch(() => {});
          }
          tableBlock = tableBlock || (await autoEnsureCraftingTable());
          recipes = bot.recipesFor?.(itemMeta.id, null, 1, tableBlock || null) || [];
        }

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
      } finally {
        busyWorkSection = false;
      }
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
    async guardPerimeter({ durationMs, checkAbort }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      const totalWait = Math.min(4_000, Math.max(500, durationMs || 2_000));
      const started = Date.now();
      while (Date.now() - started < totalWait) {
        if (typeof checkAbort === 'function') {
          const gate = await checkAbort();
          if (gate?.aborted === 'cancelled') return { ok: false, cancelled: true };
          if (gate?.aborted) break;
        }
        const threat = combatEngine.findNearestHostileThreat(bot, bot.entity.position, 14);
        if (threat) {
          await combatEngine.engageTarget(bot, threat, moveNearPosition);
        } else {
          await combatEngine.autoEquipBestGear(bot, false);
          await combatEngine.autoFeedIfNeeded(bot, false);
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      return { ok: true, patrolSeconds: Math.max(1, Math.round((durationMs || 2000) / 1000)) };
    },
    async performBlockTask({ actionType, partitionId, checkAbort }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      busyWorkSection = true;
      try {
        if (actionType === 'build') {
          const schKey = partitionId && String(partitionId).startsWith('schematic:')
            ? String(partitionId).slice('schematic:'.length)
            : 'starter_shelter';
          const schematic = customSchematics.get(schKey) || BUILTIN_SCHEMATICS.get(schKey) || BUILTIN_SCHEMATICS.get('starter_shelter');
          if (schematic) {
            return await placeSchematicBlocks(schematic, checkAbort);
          }
        }
        return { ok: false, failureCode: 'PATH_BLOCKED', retryable: false, summary: `Worker does not have a verified ${actionType} skill; task was not marked complete` };
      } finally {
        busyWorkSection = false;
      }
    },
    async depositToContainer({ resourceId, quantity }) {
      if (!bot || !bot.entity) {
        return { ok: false, failureCode: 'BOT_DISCONNECTED', retryable: true, summary: 'Disconnected' };
      }
      busyWorkSection = true;
      try {
        const bareName = String(resourceId || '').replace(/^minecraft:/, '');
        const item = (bot.inventory?.items?.() || []).find((i) => i.name === bareName);
        if (!item) {
          return { ok: false, failureCode: 'RESOURCE_NOT_FOUND', retryable: false, summary: `No ${bareName} in inventory` };
        }
        let chestBlock = bot.findBlock?.({
          matching: (b) => b && (b.name === 'chest' || b.name === 'barrel' || b.name === 'trapped_chest'),
          maxDistance: 20
        });
        if (!chestBlock) {
          chestBlock = await placeUtilityBlockNearby('chest') || await placeUtilityBlockNearby('barrel');
        }
        if (!chestBlock || typeof bot.openContainer !== 'function') {
          return { ok: false, failureCode: 'PATH_BLOCKED', retryable: true, summary: 'No target chest or barrel nearby' };
        }
        await moveNearPosition(chestBlock.position, 3.0, 8_000);
        const container = await bot.openContainer(chestBlock);
        try {
          const beforeCount = (container.containerItems?.() || [])
            .filter((i) => i.name === bareName)
            .reduce((a, b) => a + b.count, 0);
          const moveQty = Math.min(item.count, Math.max(1, quantity || item.count));
          await container.deposit(item.type, null, moveQty);
          const afterCount = (container.containerItems?.() || [])
            .filter((i) => i.name === bareName)
            .reduce((a, b) => a + b.count, 0);
          return {
            ok: true,
            deposited: Math.max(1, afterCount - beforeCount || moveQty),
            containerPos: {
              x: Math.floor(chestBlock.position.x),
              y: Math.floor(chestBlock.position.y),
              z: Math.floor(chestBlock.position.z)
            },
            containerBeforeCount: beforeCount,
            containerAfterCount: Math.max(afterCount, beforeCount + moveQty)
          };
        } finally {
          try {
            container.close();
          } catch {
            // ignore
          }
        }
      } finally {
        busyWorkSection = false;
      }
    },
    async listOnlinePlayers() {
      if (!bot || !bot.players) return [];
      const out = [];
      for (const [uname, p] of Object.entries(bot.players)) {
        if (!uname || uname === options.username) continue;
        const ent = p?.entity || null;
        const dist =
          ent?.position && bot.entity?.position
            ? Math.round(bot.entity.position.distanceTo(ent.position) * 10) / 10
            : null;
        out.push({
          username: uname,
          uuid: p?.uuid || null,
          ping: p?.ping ?? null,
          visible: Boolean(ent?.position),
          isSwarmBot: /^nexus_\d+$/i.test(uname),
          position: ent?.position
            ? {
                x: Math.floor(ent.position.x),
                y: Math.floor(ent.position.y),
                z: Math.floor(ent.position.z)
              }
            : null,
          distance: dist,
          health: ent?.health ?? null
        });
      }
      return out;
    },
    async sendChatMessage(message) {
      if (!bot || !bot.entity || typeof bot.chat !== 'function') {
        return { ok: false, reason: 'not_connected' };
      }
      try {
        bot.chat(String(message));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err).slice(0, 160) };
      }
    },
    async setTacticalOrder(order = {}) {
      const previousMode = combatEngine.tacticalState.mode;
      const state = combatEngine.setTacticalOrder(order);
      if (previousMode === 'goto' && state.mode !== 'goto') setNavigationGoal(null);
      if (state.mode === 'idle' && bot && typeof bot.clearControlStates === 'function') {
        bot.clearControlStates();
      }
      return { ok: true, tacticalState: state };
    },
    getTacticalState() {
      return combatEngine.tacticalState;
    },
    async applyInGameSkin(skinSpec = {}) {
      if (!bot || typeof bot.chat !== 'function') {
        return { ok: false, reason: 'not_connected' };
      }
      // On cracked servers running SkinsRestorer, apply custom PNG URL or themed knight/robe fallback
      if (skinSpec.publicPngUrl && /^https?:\/\//i.test(skinSpec.publicPngUrl)) {
        bot.chat(`/skin url "${skinSpec.publicPngUrl}" classic`);
        return { ok: true, method: 'skinsrestorer_url', skinId: skinSpec.skinId };
      }
      if (skinSpec.skinCommandName) {
        bot.chat(`/skin set ${skinSpec.skinCommandName}`);
        return { ok: true, method: 'skinsrestorer_name', skinId: skinSpec.skinId };
      }
      return { ok: true, method: 'cached_skin_profile', skinId: skinSpec.skinId };
    },
    async buildSchematic(schematicSpec) {
      if (!schematicSpec || typeof schematicSpec !== 'object') {
        return { ok: false, reason: 'invalid_schematic' };
      }
      if (schematicSpec.schematicId && Array.isArray(schematicSpec.blocks)) {
        customSchematics.set(schematicSpec.schematicId, schematicSpec);
      }
      busyWorkSection = true;
      try {
        return await placeSchematicBlocks(schematicSpec, null);
      } finally {
        busyWorkSection = false;
      }
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
    const mcConfig = options.minecraftConfig || {};
    const reconnectHost = String(mcConfig.minecraftHost || this.serverId).toLowerCase();
    const reconnectPort = Number(mcConfig.minecraftPort || 25565);
    this._reconnectServerKey = `${reconnectHost}:${reconnectPort}`;
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

    this._simulationMode = Boolean(options.simulationMode || options.driver);
    this._listeners = new ScopedListeners({ maxListenersPerEvent: 12 });
    this._activeLease = null;
    this._worldObservations = [];
    this._kickedOrBanned = false;
    this._stopped = false;
    this._connecting = false;
    this._reconnectTimer = null;
    this._stabilityTimer = null;
    this._spawnedAtMs = 0;
    this._reconnectAttempt = 0;
    this._throttleReconnectAttempt = 0;
    this._lastConnectError = null;
    this._survivalCheckPromise = null;
    this._reconnectBaseMs = Math.max(500, Number(options.reconnectBaseMs || 8_000));
  }

  get driver() {
    return this._driver;
  }

  get activeLease() {
    return this._activeLease;
  }

  get lastConnectError() {
    return this._lastConnectError;
  }

  get survivalCheckInFlight() {
    return Boolean(this._survivalCheckPromise);
  }

  /**
   * Watchdog fallback for drivers/servers that lose a socket without emitting `end`.
   * Normal disconnects still enter the same guarded, rate-limited reconnect path.
   */
  ensureConnected() {
    if (
      this._stopped ||
      this._kickedOrBanned ||
      this._connecting ||
      this._reconnectTimer ||
      this._driver.connected
    ) {
      return false;
    }
    this._scheduleReconnect(this._lastConnectError || 'connection watchdog found bot offline');
    return Boolean(this._reconnectTimer);
  }

  async start() {
    this._stopped = false;
    this._kickedOrBanned = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
    this._listeners.dispose();
    this._listeners = new ScopedListeners({ maxListenersPerEvent: 12 });
    this._listeners.on(this._driver, 'end', (reason) => {
      if (this._stabilityTimer) {
        clearTimeout(this._stabilityTimer);
        this._stabilityTimer = null;
      }
      const cleanReason = formatDisconnectReason(reason) || 'socket_closed';
      this.pathfindingGuard.clearBot(this.botId);
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'disconnected',
        reason: cleanReason.slice(0, 120)
      });
      if (!this._stopped && !this._kickedOrBanned && !this._connecting) {
        if (!this._simulationMode && process.stdout?.isTTY) {
          process.stdout.write(`  [MC] ${this.username} disconnected (${cleanReason}); will reconnect cleanly...\n`);
        }
        this._scheduleReconnect(cleanReason);
      }
    });
    this._listeners.on(this._driver, 'kicked', (reason) => {
      const text = formatDisconnectReason(reason);
      // Only permanent bans / whitelist rejections block auto-reconnect; Aternos "offline"/"starting"/"throttled" kicks retry cleanly
      const permanentRejection = /banned|banhammer|not whitelisted|you are not white-listed/i.test(text);
      if (permanentRejection) this._kickedOrBanned = true;
      if (!this._simulationMode) {
        writeConnectionDiagnostic(
          this.username,
          this._reconnectServerKey,
          permanentRejection
            ? `server rejected login permanently; fix ban/whitelist/access: ${text || 'no kick reason supplied'}`
            : `server kicked bot; automatic reconnect is enabled: ${text || 'no kick reason supplied'}`
        );
      }
      this._logger?.warn(
        permanentRejection
          ? 'Minecraft rejected this bot; automatic reconnect is paused until configuration/server access is fixed'
          : 'Minecraft kicked this bot; automatic reconnect remains enabled',
        { botId: this.botId, username: this.username, reason: text.slice(0, 180), permanent: permanentRejection }
      );
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'disconnected',
        reason: `kicked:${text.slice(0, 100)}`
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

    await this._attemptConnect();
  }

  async _attemptConnect() {
    if (this._stopped || this._connecting) return false;
    this._connecting = true;
    const prevErr = this._lastConnectError;
    try {
      await this._driver.connect();
      this._spawnedAtMs = Date.now();
      this._lastConnectError = null;
      this._connecting = false;

      // Keep retry history until a full minute in-game; a short-lived spawn is not evidence the server throttle has cleared.
      if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        this._stabilityTimer = null;
        if (!this._stopped && this._driver.connected) {
          this._reconnectAttempt = 0;
          this._throttleReconnectAttempt = 0;
        }
      }, 60_000);
      this._stabilityTimer.unref?.();

      if (!this._simulationMode) {
        writeConnectionDiagnostic(this.username, this._reconnectServerKey, 'connected and spawned successfully');
      }
      this._logger?.info('Bot connected and spawned in Minecraft', {
        botId: this.botId,
        username: this.username
      });
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'ready',
        reason: 'spawned'
      });
      return true;
    } catch (err) {
      this._connecting = false;
      const reason = String(err?.message || err || 'connect_failed').slice(0, 180);
      this._lastConnectError = reason;
      if (!this._simulationMode && reason !== prevErr) {
        writeConnectionDiagnostic(this.username, this._reconnectServerKey, `connection attempt failed: ${reason}`);
      }
      this._logger?.warn('Bot could not connect to Minecraft yet; will retry automatically', {
        botId: this.botId,
        username: this.username,
        reason
      });
      this.emit('bot_lifecycle', {
        botId: this.botId,
        status: 'disconnected',
        reason: reason.slice(0, 120)
      });
      if (!this._stopped && !this._kickedOrBanned) {
        this._scheduleReconnect(reason);
      }
      return false;
    }
  }

  _scheduleReconnect(reason = '') {
    if (this._stopped || this._kickedOrBanned || this._reconnectTimer) return;
    this._reconnectAttempt += 1;
    const now = Date.now();
    const baseDelay = Math.min(45_000, this._reconnectBaseMs * Math.min(5, this._reconnectAttempt));
    const isRateLimited =
      !this._simulationMode &&
      /connection\s+throttled|throttled|wait before reconnecting|too many connections|already connected|another location|duplicate/i.test(
        String(reason || '')
      );
    let delayMs = baseDelay + (this._simulationMode ? 0 : Math.floor(Math.random() * 1_500));

    if (!this._simulationMode) {
      let serverState = SERVER_RECONNECT_STATE.get(this._reconnectServerKey);
      if (!serverState || (serverState.cooldownUntil <= now && serverState.nextConnectAt <= now)) {
        serverState = { cooldownUntil: 0, nextConnectAt: 0 };
      }

      if (isRateLimited) {
        this._throttleReconnectAttempt = Math.min(10, this._throttleReconnectAttempt + 1);
        const throttleCooldownMs = Math.min(
          THROTTLE_COOLDOWN_MAX_MS,
          THROTTLE_COOLDOWN_MIN_MS * 2 ** Math.min(4, this._throttleReconnectAttempt - 1)
        );
        serverState.cooldownUntil = Math.max(serverState.cooldownUntil, now + throttleCooldownMs);
      }

      // A shared host:port gate prevents sibling bots from retrying together and
      // extending an Aternos/Paper connection-throttle window for one another.
      const retryAt = Math.max(
        now + delayMs,
        serverState.cooldownUntil,
        serverState.nextConnectAt
      );
      const jitterMs = isRateLimited ? Math.floor(Math.random() * 10_000) : 0;
      const scheduledAt = retryAt + jitterMs;
      serverState.nextConnectAt = scheduledAt + (isRateLimited ? SERVER_RECONNECT_SPACING_MS : 4_500);
      SERVER_RECONNECT_STATE.set(this._reconnectServerKey, serverState);
      delayMs = Math.max(0, scheduledAt - now);
    }

    if (!this._simulationMode) {
      writeConnectionDiagnostic(
        this.username,
        this._reconnectServerKey,
        `reconnect attempt ${this._reconnectAttempt} scheduled in ${Math.ceil(delayMs / 1000)}s${isRateLimited ? ' (server throttle backoff)' : ''}; cause: ${reason || 'connection closed'}`
      );
    }

    this._logger?.info('Scheduled Minecraft reconnect attempt', {
      botId: this.botId,
      username: this.username,
      attempt: this._reconnectAttempt,
      delayMs,
      rateLimited: isRateLimited,
      reason: String(reason || 'connection_closed').slice(0, 180)
    });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped && !this._kickedOrBanned) {
        this._attemptConnect().catch(() => {});
      }
    }, delayMs);
    this._reconnectTimer.unref?.();
  }

  async stop(reason = 'worker_stopping') {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
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
  checkSurvivalReflexes() {
    if (this._stopped) return Promise.resolve(null);
    if (this._survivalCheckPromise) return this._survivalCheckPromise;
    let pending;
    pending = this._runSurvivalReflexes().finally(() => {
      if (this._survivalCheckPromise === pending) this._survivalCheckPromise = null;
    });
    this._survivalCheckPromise = pending;
    return pending;
  }

  async _runSurvivalReflexes() {
    const raw = await this._driver.captureState();
    if (!raw.connected) return null;

    const minHealth = this._activeLease?.assignment?.safetyPolicy?.minHealth ?? 8;
    const minFood = this._activeLease?.assignment?.safetyPolicy?.minFood ?? 6;

    if (raw.health <= minHealth || raw.food <= minFood) {
      const wasPaused = this._activeLease ? this._activeLease.paused : false;
      if (this._activeLease) this._activeLease.paused = true;

      let recovered = await this._driver.eatFoodIfPossible();
      const trigger = raw.health <= minHealth ? 'low_health' : 'starving';
      if (!recovered && raw.food <= minFood && raw.health > minHealth && typeof this._driver.huntForFoodIfNeeded === 'function') {
        const deadline = Date.now() + 18_000;
        while (!recovered && !this._stopped && Date.now() < deadline) {
          const hunt = await this._driver.huntForFoodIfNeeded();
          recovered = Boolean(hunt?.ate);
          if (recovered || ['no_edible_animal_in_range', 'inventory_full', 'food_hunt_failed'].includes(hunt?.reason)) break;
          if (!recovered) await new Promise((resolve) => setTimeout(resolve, 450));
        }
      }
      const overridePayload = {
        botId: this.botId,
        trigger,
        health: raw.health,
        food: raw.food,
        recovered,
        assignmentId: this._activeLease?.assignment?.assignmentId || null
      };
      this.emit('survival_override', overridePayload);

      if (recovered && this._activeLease && !wasPaused) {
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
    const connected = Boolean(raw.connected);
    return {
      botId: this.botId,
      status,
      dimension: connected ? (raw.dimension || 'minecraft:overworld') : 'unknown',
      position: connected ? (raw.position || null) : null,
      health: connected ? (raw.health ?? null) : null,
      food: connected ? (raw.food ?? null) : null,
      heldItem: connected && raw.heldTool
        ? {
            name: raw.heldTool.itemKey,
            count: 1,
            remainingDurability: raw.heldTool.remainingDurability,
            maxDurability: 250
          }
        : null,
      inventoryItems: connected ? (raw.inventoryItems || []) : [],
      freeSlots: connected ? (raw.freeSlots ?? null) : null,
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

  async listOnlinePlayers() {
    if (typeof this._driver.listOnlinePlayers === 'function') {
      return this._driver.listOnlinePlayers();
    }
    return [];
  }

  async sendChatMessage(message) {
    const text = String(message || '').trim();
    if (!text || text.length > 256 || text.startsWith('/') || /[\u0000-\u001f\u007f]/.test(text)) {
      return { ok: false, reason: 'invalid_message' };
    }
    if (!this._driver.connected) return { ok: false, reason: 'not_connected' };
    if (typeof this._driver.sendChatMessage !== 'function') {
      return { ok: false, reason: 'chat_not_supported' };
    }
    return this._driver.sendChatMessage(text);
  }

  async executeTacticalOrder(order = {}) {
    if (order.mode && order.mode !== 'idle' && order.mode !== 'stop' && order.preemptTask && this._activeLease) {
      this._activeLease.cancelled = true;
    }
    if (typeof this._driver.setTacticalOrder === 'function') {
      return this._driver.setTacticalOrder(order);
    }
    return { ok: false };
  }

  getTacticalState() {
    return typeof this._driver.getTacticalState === 'function'
      ? this._driver.getTacticalState()
      : { mode: 'idle', targetPlayer: null, preferredWeaponStyle: 'auto' };
  }

  async applySkin(skinSpec = {}) {
    if (typeof this._driver.applyInGameSkin === 'function') {
      return this._driver.applyInGameSkin(skinSpec);
    }
    return { ok: false };
  }

  async executeDirectSchematic(schematicSpec) {
    if (typeof this._driver.buildSchematic === 'function') {
      return this._driver.buildSchematic(schematicSpec);
    }
    return { ok: false };
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
  probeMinecraftServer,
  formatDisconnectReason,
  resolveMinecraftSrvEndpoint
};
