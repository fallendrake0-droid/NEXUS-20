'use strict';

/**
 * NEXUS-20 Autonomous Survival & Elite PvP/Mob Combat Engine.
 *
 * Capabilities:
 * - Auto-Feed / Auto-Eat (saturation-ranked food + emergency Golden Apple combat healing)
 * - Auto-Equip Best Armor + Offhand (Totem of Undying / Shield) with full NBT enchantment scoring
 * - Enchantment-Aware Mining Tool Selection (Efficiency, Fortune, Unbreaking, Mending)
 * - Multi-Style 1.21+ PvP & Mob Combat:
 *   * Mace Smash (`mace` + `wind_charge` vertical launch + falling smash crits + Density/Breach/Wind Burst)
 *   * Spear & Trident Reach (`*spear*`, `trident`, `*halberd*`, `*lance*` optimal 3.4m reach jabs)
 *   * Axe Shield-Break (detects blocking player shields -> instant axe disable -> sword swap)
 *   * Sword Jump-Crits + W-Tap Sprint Reset + Circle Strafe + 1.9+ Exact Attack Cooldown Timing
 *   * Ranged Bow / Crossbow Ballistic Aim when target > 7.5 blocks
 * - Live Player Operations (`follow`, `protect`, `attack_player`, `drop_loot`, `surround`, `hunt_mobs`)
 */

const HOSTILE_MOBS = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
  'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom', 'blaze',
  'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'ghast', 'warden',
  'breeze', 'silverfish', 'endermite', 'guardian', 'elder_guardian', 'shulker'
]);

const FOOD_MOBS = new Set(['cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit']);

const FOOD_SCORES = Object.freeze({
  golden_carrot: 30,
  cooked_beef: 29,
  cooked_porkchop: 29,
  cooked_mutton: 25,
  cooked_salmon: 25,
  baked_potato: 21,
  bread: 20,
  cooked_chicken: 19,
  cooked_rabbit: 18,
  mushroom_stew: 18,
  beetroot_soup: 18,
  pumpkin_pie: 17,
  cooked_cod: 16,
  apple: 12,
  carrot: 11,
  melon_slice: 8,
  sweet_berries: 7,
  glow_berries: 7,
  dried_kelp: 5,
  cookie: 5,
  potato: 4,
  beef: 6,
  porkchop: 6,
  mutton: 5,
  chicken: 4
});

const ARMOR_TIER_BASE = Object.freeze({
  netherite: 40,
  diamond: 32,
  iron: 22,
  turtle: 20,
  chainmail: 18,
  golden: 15,
  leather: 10
});

const TOOL_TIER_BASE = Object.freeze({
  netherite: 50,
  diamond: 40,
  iron: 30,
  stone: 20,
  golden: 18,
  wooden: 10
});

const ARMOR_SLOTS = Object.freeze([
  { suffix: '_helmet', altNames: ['turtle_helmet'], dest: 'head', slotIndex: 5 },
  { suffix: '_chestplate', altNames: [], dest: 'torso', slotIndex: 6 },
  { suffix: '_leggings', altNames: [], dest: 'legs', slotIndex: 7 },
  { suffix: '_boots', altNames: [], dest: 'feet', slotIndex: 8 }
]);

/**
 * Extract normalized enchantment map `{ protection: 4, sharpness: 5, density: 5, ... }`
 * across Mineflayer 1.18 - 1.21.4 item representations.
 */
function extractItemEnchantments(item) {
  const map = {};
  if (!item || typeof item !== 'object') return map;

  if (Array.isArray(item.enchants)) {
    for (const e of item.enchants) {
      if (e && e.name) {
        const clean = String(e.name).replace(/^minecraft:/, '').toLowerCase();
        map[clean] = Math.max(map[clean] || 0, Number(e.lvl || e.level || 1));
      }
    }
  }

  const nbtList =
    item.nbt?.value?.Enchantments?.value?.value ||
    item.nbt?.value?.StoredEnchantments?.value?.value ||
    null;
  if (Array.isArray(nbtList)) {
    for (const entry of nbtList) {
      const rawId = entry?.id?.value || entry?.id;
      const lvl = entry?.lvl?.value ?? entry?.lvl ?? 1;
      if (rawId) {
        const clean = String(rawId).replace(/^minecraft:/, '').toLowerCase();
        map[clean] = Math.max(map[clean] || 0, Number(lvl) || 1);
      }
    }
  }

  return map;
}

function isBroken(item) {
  if (!item) return true;
  if (typeof item.maxDurability === 'number' && item.maxDurability > 0) {
    return (item.durabilityUsed || 0) >= item.maxDurability - 1;
  }
  return false;
}

function scoreArmorItem(item) {
  if (!item || isBroken(item)) return -1;
  const name = String(item.name || '');
  let base = 8;
  for (const [tier, val] of Object.entries(ARMOR_TIER_BASE)) {
    if (name.startsWith(`${tier}_`) || (tier === 'turtle' && name === 'turtle_helmet')) {
      base = val;
      break;
    }
  }
  const ench = extractItemEnchantments(item);
  if (ench.binding_curse) return -500;
  let bonus = 0;
  bonus += (ench.protection || 0) * 4.5;
  bonus += (ench.blast_protection || 0) * 2.5;
  bonus += (ench.projectile_protection || 0) * 2.5;
  bonus += (ench.fire_protection || 0) * 2.0;
  bonus += (ench.feather_falling || 0) * 3.0;
  bonus += (ench.depth_strider || 0) * 2.0;
  bonus += (ench.swift_sneak || 0) * 1.5;
  bonus += (ench.thorns || 0) * 1.5;
  bonus += (ench.unbreaking || 0) * 2.0;
  bonus += (ench.mending || 0) * 3.5;
  bonus += (ench.respiration || 0) * 1.5;
  bonus += (ench.aqua_affinity || 0) * 1.5;
  return base + bonus;
}

function isSpearLike(name) {
  return (
    name === 'trident' ||
    name === 'spear' ||
    name.endsWith('_spear') ||
    name.endsWith('_halberd') ||
    name.endsWith('_lance') ||
    name.endsWith('_pike')
  );
}

function scoreWeaponItem(item, context = {}) {
  if (!item || isBroken(item)) return -1;
  const name = String(item.name || '');
  const ench = extractItemEnchantments(item);
  let tierScore = 12;
  for (const [tier, val] of Object.entries(TOOL_TIER_BASE)) {
    if (name.startsWith(`${tier}_`)) {
      tierScore = val;
      break;
    }
  }

  // 1. 1.21 Heavy Mace (`mace`)
  if (name === 'mace') {
    let score = 46;
    score += (ench.density || 0) * 5.5;
    score += (ench.breach || 0) * 6.5;
    score += (ench.wind_burst || 0) * 7.5;
    score += (ench.fire_aspect || 0) * 2.5;
    score += (ench.smite || 0) * 1.5;
    score += (ench.unbreaking || 0) * 1.5;
    score += (ench.mending || 0) * 2.5;
    if (context.isFallingSmash || context.preferredStyle === 'mace') {
      score += 45; // Massive Smash Attack priority when falling!
    } else if (context.onGroundCooldown) {
      score -= 14; // Swap to fast sword/spear between smashes
    }
    return score;
  }

  // 2. Spear / Trident / Polearms
  if (isSpearLike(name)) {
    let score = name === 'trident' ? 38 : tierScore + 3;
    score += (ench.impaling || 0) * 3.5;
    score += (ench.sharpness || 0) * 2.5;
    score += (ench.loyalty || 0) * 3.0;
    score += (ench.riptide || 0) * 2.5;
    score += (ench.channeling || 0) * 2.0;
    score += (ench.fire_aspect || 0) * 2.5;
    score += (ench.lunge || 0) * 3.0;
    if (context.preferredStyle === 'spear' || (context.distance >= 3.0 && context.distance <= 4.3)) {
      score += 22; // Reach advantage window
    }
    return score;
  }

  // 3. Axe (Shield-Breaker + High Single-Hit Alpha)
  if (name.endsWith('_axe')) {
    let score = tierScore - 2;
    score += (ench.sharpness || 0) * 2.5;
    score += (ench.smite || 0) * 1.5;
    score += (ench.efficiency || 0) * 0.5;
    if (context.targetBlocking || context.preferredStyle === 'axe') {
      score += 60; // Instant top priority to disable raised enemy shields!
    }
    return score;
  }

  // 4. Sword (Primary Fast DPS + Crits + Sweeping)
  if (name.endsWith('_sword')) {
    let score = tierScore + 4;
    score += (ench.sharpness || 0) * 3.0;
    score += (ench.fire_aspect || 0) * 3.5;
    score += (ench.sweeping_edge || 0) * 2.0;
    score += (ench.knockback || 0) * 1.0;
    score += (ench.looting || 0) * 1.5;
    score += (ench.smite || 0) * 1.5;
    score += (ench.unbreaking || 0) * 1.5;
    score += (ench.mending || 0) * 2.0;
    if (context.preferredStyle === 'sword') score += 20;
    return score;
  }

  return -1;
}

function scoreMiningToolItem(item, blockName = '') {
  if (!item || isBroken(item)) return -1;
  const name = String(item.name || '');
  const b = String(blockName || '');
  const needSuffix =
    b.includes('leaves') || b.includes('wool') || b.includes('cobweb')
      ? 'shears'
      : b.includes('log') || b.includes('stem') || b.includes('planks') || b.includes('wood') || b.includes('chest')
        ? '_axe'
        : b.includes('dirt') || b.includes('grass') || b.includes('sand') || b.includes('gravel') || b.includes('clay') || b.includes('mud') || b.includes('soul_') || b.includes('snow')
          ? '_shovel'
          : b.includes('hay') || b.includes('sculk') || b.includes('sponge') || b.includes('wart_block')
            ? '_hoe'
            : '_pickaxe';

  if (needSuffix === 'shears') {
    return name === 'shears' ? 50 : -1;
  }
  if (!name.endsWith(needSuffix)) return -1;

  let base = 10;
  for (const [tier, val] of Object.entries(TOOL_TIER_BASE)) {
    if (name.startsWith(`${tier}_`)) {
      base = val;
      break;
    }
  }
  const ench = extractItemEnchantments(item);
  let bonus = (ench.efficiency || 0) * 4.0 + (ench.unbreaking || 0) * 1.5 + (ench.mending || 0) * 2.5;
  if (b.includes('glass') || b.includes('ice') || b === 'ender_chest') {
    bonus += (ench.silk_touch || 0) * 15;
  } else {
    bonus += (ench.fortune || 0) * 4.0;
  }
  return base + bonus;
}

function getWeaponCooldownMs(itemName = '') {
  const n = String(itemName || '');
  if (n === 'mace') return 1620;
  if (n.endsWith('_axe')) return 1000;
  if (isSpearLike(n)) return 910;
  if (n.endsWith('_sword')) return 625;
  return 650;
}

function isEntityBlockingWithShield(entity) {
  if (!entity) return false;
  const metaFlags = entity.metadata && typeof entity.metadata[8] === 'number' ? entity.metadata[8] : 0;
  if ((metaFlags & 1) === 1) {
    const eq = Array.isArray(entity.equipment) ? entity.equipment : [];
    const hasShield = eq.some((it) => it && it.name === 'shield');
    if (hasShield || entity.type === 'player') return true;
  }
  return false;
}

/**
 * Per-bot autonomous survival + PvP/player tactical controller.
 */
class CombatAndSurvivalEngine {
  constructor(options = {}) {
    this.botId = options.botId;
    this.username = options.username;
    this.autoEatEnabled = options.autoEat !== false;
    this.autoArmorEnabled = options.autoArmor !== false;
    this.selfDefenseEnabled = options.selfDefense !== false;
    this.preferredWeaponStyle = options.preferredWeaponStyle || 'auto'; // 'auto' | 'mace' | 'spear' | 'sword' | 'axe' | 'bow'
    this.allies = new Set(options.allies || []);
    this.kosPlayers = new Set(options.kosPlayers || []);

    // Active tactical directive (`idle` | `follow` | `protect` | `attack_player` | `hunt_mobs` | `surround` | `drop_loot`)
    this.tacticalState = {
      mode: 'idle',
      targetPlayer: null,
      targetPosition: null,
      itemFilter: null,
      slotIndex: 0,
      slotTotal: 1,
      updatedAt: null
    };

    this._lastSwingMs = 0;
    this._lastWindChargeMs = 0;
    this._lastArmorCheckMs = 0;
    this._lastEatMs = 0;
    this._strafeDir = 1;
    this._eatingNow = false;
    this._foodHuntBusy = false;
    this._foodHuntTarget = null;
    this._foodHuntFailedUntil = new Map();
  }

  setTacticalOrder(order = {}) {
    const mode = String(order.mode || 'idle').trim().toLowerCase();
    if (Array.isArray(order.allies)) {
      this.allies = new Set(order.allies.map((s) => String(s).toLowerCase()));
    }
    if (Array.isArray(order.kosPlayers)) {
      this.kosPlayers = new Set(order.kosPlayers.map((s) => String(s).toLowerCase()));
    }
    if (order.preferredWeaponStyle) {
      this.preferredWeaponStyle = String(order.preferredWeaponStyle).toLowerCase();
    }
    if (typeof order.autoEat === 'boolean') this.autoEatEnabled = order.autoEat;
    if (typeof order.autoArmor === 'boolean') this.autoArmorEnabled = order.autoArmor;

    if (mode !== 'goto') {
      this._gotoGoalKey = null;
      this._gotoStartedAt = 0;
    }

    if (mode === 'stop' || mode === 'idle') {
      this.tacticalState = {
        mode: 'idle',
        targetPlayer: null,
        targetPosition: null,
        itemFilter: null,
        slotIndex: 0,
        slotTotal: 1,
        updatedAt: new Date().toISOString()
      };
      return this.tacticalState;
    }

    const targetPosition = order.targetPosition &&
      [order.targetPosition.x, order.targetPosition.y, order.targetPosition.z].every((v) => Number.isFinite(Number(v)))
      ? { x: Number(order.targetPosition.x), y: Number(order.targetPosition.y), z: Number(order.targetPosition.z) }
      : null;
    this.tacticalState = {
      mode,
      targetPlayer: order.targetPlayer ? String(order.targetPlayer).trim() : null,
      targetPosition: mode === 'goto' ? targetPosition : null,
      itemFilter: order.itemFilter ? String(order.itemFilter).replace(/^minecraft:/, '').trim() : null,
      slotIndex: Number(order.slotIndex || 0),
      slotTotal: Math.max(1, Number(order.slotTotal || 1)),
      updatedAt: new Date().toISOString()
    };
    return this.tacticalState;
  }

  isAlly(username, swarmBotNames = null) {
    if (!username) return false;
    const low = String(username).toLowerCase();
    if (low === String(this.username || '').toLowerCase()) return true;
    if (this.allies.has(low)) return true;
    if (swarmBotNames && swarmBotNames.has(low)) return true;
    if (/^nexus_\d+$/i.test(username)) return true;
    return false;
  }

  /**
   * Auto-equip highest enchantment-scored armor across all 4 slots + off-hand Totem/Shield.
   */
  async autoEquipBestGear(bot, inCombat = false) {
    if (!this.autoArmorEnabled || !bot || !bot.inventory) return { equippedCount: 0 };
    const now = Date.now();
    if (!inCombat && now - this._lastArmorCheckMs < 2500) return { equippedCount: 0 };
    this._lastArmorCheckMs = now;

    const allItems = bot.inventory.items() || [];
    const slots = bot.inventory.slots || [];
    let equippedCount = 0;

    for (const slotDef of ARMOR_SLOTS) {
      const currentEquipped = slots[slotDef.slotIndex] || null;
      let bestScore = scoreArmorItem(currentEquipped);
      let bestCandidate = null;

      for (const item of allItems) {
        if (
          item.name.endsWith(slotDef.suffix) ||
          slotDef.altNames.includes(item.name)
        ) {
          const s = scoreArmorItem(item);
          if (s > bestScore + 0.1) {
            bestScore = s;
            bestCandidate = item;
          }
        }
      }

      if (bestCandidate) {
        try {
          await bot.equip(bestCandidate, slotDef.dest);
          equippedCount += 1;
        } catch {
          // Ignore transient inventory window conflict
        }
      }
    }

    // Offhand priority: Totem of Undying (always #1 in PvP or low HP) -> Shield
    const offhandSlot = slots[45] || null;
    const totem = allItems.find((i) => i.name === 'totem_of_undying');
    const shield = allItems.find((i) => i.name === 'shield' && !isBroken(i));
    if (totem && (!offhandSlot || offhandSlot.name !== 'totem_of_undying')) {
      try {
        await bot.equip(totem, 'off-hand');
        equippedCount += 1;
      } catch {
        // ignore
      }
    } else if (!totem && shield && (!offhandSlot || (offhandSlot.name !== 'shield' && offhandSlot.name !== 'totem_of_undying'))) {
      try {
        await bot.equip(shield, 'off-hand');
        equippedCount += 1;
      } catch {
        // ignore
      }
    }

    return { equippedCount };
  }

  /**
   * Auto-feed optimal saturation food or emergency combat Golden Apple.
   */
  async autoFeedIfNeeded(bot, inCombat = false) {
    if (!this.autoEatEnabled || !bot || !bot.inventory || this._eatingNow) return false;
    const health = bot.health ?? 20;
    const food = bot.food ?? 20;
    const now = Date.now();
    if (now - this._lastEatMs < 1800) return false;

    const needEmergencyHeal = health <= 11;
    const needRegularFood = food < 16 || (health < 18 && food < 20);
    if (!needEmergencyHeal && !needRegularFood) return false;

    const items = bot.inventory.items() || [];
    let chosen = null;

    if (needEmergencyHeal) {
      chosen =
        items.find((i) => i.name === 'enchanted_golden_apple') ||
        items.find((i) => i.name === 'golden_apple') ||
        null;
    }

    if (!chosen && food < 20) {
      let bestFoodScore = -1;
      for (const it of items) {
        const sc = FOOD_SCORES[it.name] || (food <= 4 && it.name === 'rotten_flesh' ? 2 : -1);
        if (sc > bestFoodScore) {
          bestFoodScore = sc;
          chosen = it;
        }
      }
      if (!chosen && needEmergencyHeal) {
        chosen = items.find((i) => i.name === 'golden_apple' || i.name === 'enchanted_golden_apple') || null;
      }
    }

    if (!chosen) return false;

    this._eatingNow = true;
    this._lastEatMs = now;
    const prevHeld = bot.heldItem;
    try {
      if (inCombat && typeof bot.deactivateItem === 'function') {
        bot.deactivateItem(); // Lower shield briefly to eat
      }
      await bot.equip(chosen, 'hand');
      await bot.consume();
      if (prevHeld && prevHeld.name !== chosen.name) {
        const restore = (bot.inventory.items() || []).find((i) => i.name === prevHeld.name);
        if (restore) await bot.equip(restore, 'hand').catch(() => {});
      }
      return true;
    } catch {
      return false;
    } finally {
      this._eatingNow = false;
    }
  }

  /**
   * Equip the best enchanted weapon dynamically for the exact combat frame:
   * - Falling / Aerial -> `mace` (Smash Attack!)
   * - Enemy Shield Raised -> `*_axe` (Shield Break!)
   * - Reach Window 3.0..4.3m -> `*spear*` / `trident`
   * - Close Melee -> Enchanted `*_sword`
   */
  async equipOptimalCombatWeapon(bot, targetEntity, distance) {
    if (!bot || !bot.inventory) return null;
    const items = bot.inventory.items() || [];
    const velY = bot.entity?.velocity?.y ?? 0;
    const heightAdv =
      bot.entity && targetEntity?.position
        ? bot.entity.position.y - targetEntity.position.y
        : 0;
    const isFallingSmash = velY < -0.10 || heightAdv >= 1.4;
    const targetBlocking = isEntityBlockingWithShield(targetEntity);

    let bestItem = null;
    let bestScore = -1;
    for (const it of items) {
      const s = scoreWeaponItem(it, {
        isFallingSmash,
        targetBlocking,
        distance,
        preferredStyle: this.preferredWeaponStyle,
        onGroundCooldown: !isFallingSmash
      });
      if (s > bestScore) {
        bestScore = s;
        bestItem = it;
      }
    }

    if (bestItem && (!bot.heldItem || bot.heldItem.type !== bestItem.type || bot.heldItem.slot !== bestItem.slot)) {
      try {
        await bot.equip(bestItem, 'hand');
      } catch {
        // ignore
      }
    }
    return bestItem || bot.heldItem || null;
  }

  /**
   * Execute one high-skill PvP / Mob combat engagement step against `target`.
   */
  async engageTarget(bot, target, moveNearFn) {
    if (!bot || !bot.entity || !target || !target.position) return { acted: false };
    const dist = bot.entity.position.distanceTo(target.position);
    const items = bot.inventory?.items?.() || [];
    const now = Date.now();

    // 1. Emergency Golden Apple / Auto-Armor / Totem check
    await this.autoEquipBestGear(bot, true);
    if ((bot.health ?? 20) <= 10) {
      await this.autoFeedIfNeeded(bot, true);
    }

    // 2. Long-Range Bow / Crossbow Pressure (> 7.5 blocks)
    const bow = items.find((i) => (i.name === 'bow' || i.name === 'crossbow') && !isBroken(i));
    const hasArrows = items.some((i) => i.name.includes('arrow'));
    if (dist > 7.5 && dist < 26 && bow && hasArrows && now - this._lastSwingMs > 1250) {
      try {
        await bot.equip(bow, 'hand');
        const aimY = target.position.y + (target.height || 1.62) * 0.85 + dist * 0.04;
        await bot.lookAt({ x: target.position.x, y: aimY, z: target.position.z }, true);
        bot.activateItem();
        await new Promise((r) => setTimeout(r, bow.name === 'crossbow' ? 450 : 750));
        bot.deactivateItem();
        this._lastSwingMs = Date.now();
        return { acted: true, style: bow.name, distance: dist };
      } catch {
        // Fall through to gap-close
      }
    }

    // 3. Wind-Charge + Mace Aerial Smash Combo when carrying both `mace` and `wind_charge`!
    const hasMace = items.some((i) => i.name === 'mace' && !isBroken(i));
    const windCharge = items.find((i) => i.name === 'wind_charge');
    if (hasMace && windCharge && dist <= 5.5 && bot.entity.onGround && now - this._lastWindChargeMs > 4500) {
      try {
        this._lastWindChargeMs = now;
        await bot.equip(windCharge, 'hand');
        await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.12, true); // Look straight at feet
        bot.setControlState('jump', true);
        bot.activateItem();
        await new Promise((r) => setTimeout(r, 120));
        bot.setControlState('jump', false);
      } catch {
        // Ignore wind_charge error
      }
    }

    // 4. Close distance or maintain Spear reach spacing
    const desiredRange = this.preferredWeaponStyle === 'spear' ? 3.2 : 2.6;
    if (dist > 3.6 && typeof moveNearFn === 'function') {
      await moveNearFn(target.position, desiredRange, 1200);
    }

    // 5. Select optimal enchanted weapon (Mace on fall, Axe vs shield, Spear at reach, Sword DPS)
    const activeWeapon = await this.equipOptimalCombatWeapon(bot, target, dist);
    const cooldownMs = getWeaponCooldownMs(activeWeapon?.name);

    // Aim at upper chest / head
    const eyeTarget = {
      x: target.position.x,
      y: target.position.y + (target.height || 1.6) * 0.82,
      z: target.position.z
    };
    await bot.lookAt(eyeTarget, true).catch(() => {});

    // Circle-strafe + Jump-Crit preparation when weapon is nearly ready
    if (dist <= 4.4) {
      if (Math.random() < 0.18) this._strafeDir *= -1;
      bot.setControlState(this._strafeDir > 0 ? 'left' : 'right', true);
      bot.setControlState(this._strafeDir > 0 ? 'right' : 'left', false);
      bot.setControlState('sprint', true);
      if (bot.entity.onGround && now - this._lastSwingMs >= cooldownMs - 180) {
        bot.setControlState('jump', true); // Jump so swing lands on downward fall (1.5x Critical / Mace Smash!)
      } else {
        bot.setControlState('jump', false);
      }
    }

    // 6. Execute 100%-charged Critical / Smash / Shield-Break strike!
    if (dist <= 4.1 && now - this._lastSwingMs >= cooldownMs) {
      if (typeof bot.deactivateItem === 'function') bot.deactivateItem(); // Drop shield to swing
      bot.attack(target);
      this._lastSwingMs = Date.now();
      // W-Tap sprint reset for maximum knockback
      bot.setControlState('sprint', false);
      setTimeout(() => {
        try {
          if (bot && bot.entity) bot.setControlState('sprint', true);
        } catch {
          // ignore
        }
      }, 65);

      // Raise offhand shield between swings if equipped
      const offhand = bot.inventory?.slots?.[45];
      if (offhand && offhand.name === 'shield') {
        setTimeout(() => {
          try {
            if (bot && bot.entity) bot.activateItem(true);
          } catch {
            // ignore
          }
        }, 90);
      }
      return { acted: true, style: activeWeapon?.name || 'hand', distance: dist };
    }

    return { acted: true, style: 'positioning', distance: dist };
  }

  /**
   * Find a player entity by username on a live Mineflayer bot.
   */
  findPlayerEntity(bot, playerName) {
    if (!bot || !playerName) return null;
    const targetLower = String(playerName).toLowerCase();
    if (bot.players) {
      for (const [uname, pInfo] of Object.entries(bot.players)) {
        if (uname.toLowerCase() === targetLower && pInfo && pInfo.entity) {
          return pInfo.entity;
        }
      }
    }
    if (bot.entities) {
      for (const ent of Object.values(bot.entities)) {
        if (ent && ent.type === 'player' && String(ent.username || '').toLowerCase() === targetLower) {
          return ent;
        }
      }
    }
    return null;
  }

  /**
   * Find nearest hostile mob (or attacker) within `maxRange` blocks.
   */
  findNearestHostileThreat(bot, centerPos, maxRange = 12) {
    if (!bot || !bot.entities || !centerPos) return null;
    let nearest = null;
    let nearestDist = maxRange;

    for (const ent of Object.values(bot.entities)) {
      if (!ent || !ent.position || ent === bot.entity) continue;
      const eName = String(ent.name || ent.mobType || '').toLowerCase();
      const isKosPlayer =
        ent.type === 'player' &&
        ent.username &&
        !this.isAlly(ent.username) &&
        this.kosPlayers.has(String(ent.username).toLowerCase());
      const isHostileMob = HOSTILE_MOBS.has(eName) || ent.kind === 'Hostile mobs';

      if (!isHostileMob && !isKosPlayer) continue;
      const d = centerPos.distanceTo(ent.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = ent;
      }
    }
    return nearest;
  }

  findNearestFoodMob(bot, centerPos, maxRange = 32, excludedIds = null) {
    if (!bot?.entities || !centerPos) return null;
    let nearest = null;
    let nearestDistance = maxRange;
    for (const ent of Object.values(bot.entities)) {
      if (!ent?.position || ent === bot.entity || ent.isBaby === true || excludedIds?.has(String(ent.id))) continue;
      const name = String(ent.name || ent.mobType || '').replace(/^minecraft:/, '').toLowerCase();
      if (!FOOD_MOBS.has(name)) continue;
      const distance = centerPos.distanceTo(ent.position);
      if (distance < nearestDistance) {
        nearest = ent;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  foodItemCount(bot) {
    return (bot?.inventory?.items?.() || []).reduce((total, item) => {
      const name = String(item.name || '').replace(/^minecraft:/, '').toLowerCase();
      return total + ((FOOD_SCORES[name] || 0) > 0 ? Math.max(0, Number(item.count) || 0) : 0);
    }, 0);
  }

  shouldHuntForFood(bot) {
    return Boolean(bot && (bot.food ?? 20) < 16 && this.foodItemCount(bot) === 0);
  }

  async huntForFoodIfNeeded(bot, moveNearFn, { force = false } = {}) {
    if ((!force && !this.shouldHuntForFood(bot)) || !bot.entity) {
      this._foodHuntTarget = null;
      return { acted: false, reason: 'food_not_needed' };
    }
    if (this._foodHuntBusy) return { acted: false, reason: 'food_hunt_busy' };
    if (typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() <= 0) {
      return { acted: false, reason: 'inventory_full' };
    }

    // Hardcore-safe: don't initiate a food hunt while badly hurt or with a nearby threat.
    if (Number(bot.health) > 0 && Number(bot.health) <= 8) {
      return { acted: false, reason: 'health_too_low_to_hunt' };
    }
    const nearbyThreat = this.findNearestHostileThreat(bot, bot.entity.position, 8);
    if (nearbyThreat) return { acted: false, reason: 'hostile_threat_nearby' };

    const now = Date.now();
    for (const [id, expiresAt] of this._foodHuntFailedUntil) {
      if (expiresAt <= now) this._foodHuntFailedUntil.delete(id);
    }
    if (this._foodHuntTarget && now - this._foodHuntTarget.startedAt > 15_000) {
      this._foodHuntFailedUntil.set(this._foodHuntTarget.mobId, now + 30_000);
      this._foodHuntTarget = null;
    }
    if (!this._foodHuntTarget) {
      const target = this.findNearestFoodMob(bot, bot.entity.position, 32, new Set(this._foodHuntFailedUntil.keys()));
      if (!target) return { acted: false, reason: 'no_edible_animal_in_range' };
      this._foodHuntTarget = {
        target,
        mobId: String(target.id ?? `${target.name}:${target.position.x},${target.position.y},${target.position.z}`),
        name: String(target.name || target.mobType || 'animal'),
        foodBefore: this.foodItemCount(bot),
        position: target.position,
        startedAt: now
      };
    }

    const hunt = this._foodHuntTarget;
    const present = () => {
      if (hunt.target.isValid === false || (hunt.target.health != null && Number(hunt.target.health) <= 0)) return false;
      return hunt.target.id == null || !bot.entities || Boolean(bot.entities[hunt.target.id]);
    };
    this._foodHuntBusy = true;
    try {
      if (present()) {
        hunt.position = hunt.target.position || hunt.position;
        const strike = await this.engageTarget(bot, hunt.target, moveNearFn);
        if (present()) return { acted: Boolean(strike?.acted), targetMob: hunt.name, phase: 'engage' };
      }
      if (hunt.position && typeof moveNearFn === 'function') {
        try { await moveNearFn(hunt.position, 1.25, 2500); } catch { /* allow pickup retry on the next tick */ }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const foodCollected = Math.max(0, this.foodItemCount(bot) - hunt.foodBefore);
      this._foodHuntTarget = null;
      if (foodCollected <= 0) this._foodHuntFailedUntil.set(hunt.mobId, Date.now() + 30_000);
      const ate = foodCollected > 0 ? await this.autoFeedIfNeeded(bot, false) : false;
      return { acted: foodCollected > 0, targetMob: hunt.name, foodCollected, ate, phase: 'collect' };
    } finally {
      this._foodHuntBusy = false;
    }
  }

  /**
   * Run periodic autonomous survival + active player/PvP tactical tick.
   */
  async tick(bot, moveNearFn, setNavigationGoalFn) {
    if (!bot || !bot.entity) return { mode: this.tacticalState.mode, acted: false };

    await this.autoEquipBestGear(bot, this.tacticalState.mode === 'attack_player');
    await this.autoFeedIfNeeded(bot, this.tacticalState.mode === 'attack_player');

    const mode = this.tacticalState.mode;

    if (mode === 'goto') {
      const target = this.tacticalState.targetPosition;
      if (!target) {
        this.setTacticalOrder({ mode: 'idle' });
        return { mode, acted: false, reason: 'invalid_target_position' };
      }
      const distance = bot.entity.position.distanceTo(target);
      if (distance <= 1.5) {
        if (typeof setNavigationGoalFn === 'function') setNavigationGoalFn(null);
        this.setTacticalOrder({ mode: 'idle' });
        return { mode, acted: true, arrived: true, distance };
      }
      if (this._gotoStartedAt && Date.now() - this._gotoStartedAt > 120_000) {
        if (typeof setNavigationGoalFn === 'function') setNavigationGoalFn(null);
        this.setTacticalOrder({ mode: 'idle' });
        return { mode, acted: false, reason: 'navigation_timeout', distance };
      }
      const goalKey = `${target.x},${target.y},${target.z}`;
      if (this._gotoGoalKey !== goalKey) {
        if (typeof setNavigationGoalFn !== 'function' || !setNavigationGoalFn(target, 1.25)) {
          this.setTacticalOrder({ mode: 'idle' });
          return { mode, acted: false, reason: 'navigation_unavailable', distance };
        }
        this._gotoGoalKey = goalKey;
        this._gotoStartedAt = Date.now();
      }
      return { mode, acted: true, distance, targetPosition: target };
    }

    if (mode === 'hunt_food') {
      if (this.foodItemCount(bot) > 0) {
        this.setTacticalOrder({ mode: 'idle' });
        return { mode: 'hunt_food', acted: false, reason: 'food_available' };
      }
      return this.huntForFoodIfNeeded(bot, moveNearFn, { force: true });
    }

    if (mode === 'idle' && this.shouldHuntForFood(bot)) {
      return this.huntForFoodIfNeeded(bot, moveNearFn);
    }

    if (mode === 'attack_player' && this.tacticalState.targetPlayer) {
      const targetEnt = this.findPlayerEntity(bot, this.tacticalState.targetPlayer);
      if (targetEnt) {
        return this.engageTarget(bot, targetEnt, moveNearFn);
      }
      return { mode, acted: false, reason: 'target_out_of_render_range' };
    }

    if (mode === 'follow' && this.tacticalState.targetPlayer) {
      const targetEnt = this.findPlayerEntity(bot, this.tacticalState.targetPlayer);
      if (targetEnt && targetEnt.position) {
        const dist = bot.entity.position.distanceTo(targetEnt.position);
        if (dist > 3.2 && typeof moveNearFn === 'function') {
          await moveNearFn(targetEnt.position, 2.5, 2500);
        } else {
          await bot.lookAt(targetEnt.position.offset(0, 1.6, 0), true).catch(() => {});
        }
        return { mode, acted: true, distance: dist };
      }
      return { mode, acted: false, reason: 'player_not_visible' };
    }

    if (mode === 'protect' && this.tacticalState.targetPlayer) {
      const vip = this.findPlayerEntity(bot, this.tacticalState.targetPlayer);
      const anchorPos = vip?.position || bot.entity.position;
      const threat = this.findNearestHostileThreat(bot, anchorPos, 14);
      if (threat) {
        return this.engageTarget(bot, threat, moveNearFn);
      }
      if (vip?.position && bot.entity.position.distanceTo(vip.position) > 3.8 && typeof moveNearFn === 'function') {
        await moveNearFn(vip.position, 2.8, 2500);
      }
      return { mode, acted: true };
    }

    if (mode === 'surround' && this.tacticalState.targetPlayer) {
      const vip = this.findPlayerEntity(bot, this.tacticalState.targetPlayer);
      if (vip?.position && typeof moveNearFn === 'function') {
        const angle = (2 * Math.PI * (this.tacticalState.slotIndex % this.tacticalState.slotTotal)) / this.tacticalState.slotTotal;
        const ringPos = {
          x: vip.position.x + Math.cos(angle) * 2.8,
          y: vip.position.y,
          z: vip.position.z + Math.sin(angle) * 2.8
        };
        await moveNearFn(ringPos, 1.2, 2500);
        const threat = this.findNearestHostileThreat(bot, vip.position, 8);
        if (threat) return this.engageTarget(bot, threat, moveNearFn);
        return { mode, acted: true };
      }
      return { mode, acted: false };
    }

    if (mode === 'drop_loot' && this.tacticalState.targetPlayer) {
      const vip = this.findPlayerEntity(bot, this.tacticalState.targetPlayer);
      if (vip?.position) {
        if (bot.entity.position.distanceTo(vip.position) > 2.8 && typeof moveNearFn === 'function') {
          await moveNearFn(vip.position, 2.2, 5000);
        }
        await bot.lookAt(vip.position.offset(0, 1.3, 0), true).catch(() => {});
        const filter = this.tacticalState.itemFilter;
        const equippedSlots = new Set([5, 6, 7, 8, 45]);
        const items = (bot.inventory?.items?.() || []).filter((it) => {
          if (equippedSlots.has(it.slot)) return false;
          if (filter && filter !== 'all') return it.name === filter || it.name.includes(filter);
          return true;
        });
        let dropped = 0;
        for (const it of items.slice(0, 12)) {
          try {
            await bot.tossStack(it);
            dropped += it.count;
          } catch {
            // ignore
          }
        }
        this.setTacticalOrder({ mode: 'idle' });
        return { mode: 'drop_loot', acted: true, dropped };
      }
      return { mode: 'drop_loot', acted: false, reason: 'player_not_visible' };
    }

    if (mode === 'hunt_mobs') {
      if (Number(bot.health) > 0 && Number(bot.health) <= 8) {
        return { mode, acted: false, reason: 'health_too_low_to_hunt' };
      }
      const mob = this.findNearestHostileThreat(bot, bot.entity.position, 24);
      if (mob) return this.engageTarget(bot, mob, moveNearFn);
      return { mode, acted: false };
    }

    // Idle self-defense against immediate hostile mobs within 5 blocks
    if (this.selfDefenseEnabled) {
      const closeThreat = this.findNearestHostileThreat(bot, bot.entity.position, 4.8);
      if (closeThreat) {
        return this.engageTarget(bot, closeThreat, moveNearFn);
      }
    }

    if (typeof bot.clearControlStates === 'function' && mode === 'idle') {
      bot.setControlState('left', false);
      bot.setControlState('right', false);
      bot.setControlState('jump', false);
    }

    return { mode: 'idle', acted: false };
  }
}

module.exports = {
  CombatAndSurvivalEngine,
  HOSTILE_MOBS,
  FOOD_MOBS,
  FOOD_SCORES,
  extractItemEnchantments,
  scoreArmorItem,
  scoreWeaponItem,
  scoreMiningToolItem,
  getWeaponCooldownMs
};
