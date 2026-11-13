'use strict';

const crypto = require('node:crypto');
const { BUILTIN_SCHEMATICS } = require('../schematics/SchematicBuilder');

/**
 * NEXUS-20 Zero-AI Command & Progression Engine (curated Deterministic Commands, £0 / 0 LLM Calls).
 *
 * Covers:
 * - Natural-language offline command parsing ("collect 64 logs", "collect stone",
 *   "get stone tools", "mine iron, gold, diamonds", "smelt 32 iron", "build watchtower", etc.)
 * - Multi-step DAG progression kits (Wooden -> Stone -> Iron -> Diamond -> Netherite -> Mace/Spear PvP)
 * - curated structured one-click command presets across 14 survival, combat, crafting & building categories
 */

const RESOURCE_SYNONYMS = Object.freeze({
  // Logs & Wood
  log: 'minecraft:oak_log',
  logs: 'minecraft:oak_log',
  wood: 'minecraft:oak_log',
  tree: 'minecraft:oak_log',
  trees: 'minecraft:oak_log',
  timber: 'minecraft:oak_log',
  oak: 'minecraft:oak_log',
  'oak log': 'minecraft:oak_log',
  'oak logs': 'minecraft:oak_log',
  'spruce log': 'minecraft:spruce_log',
  'spruce logs': 'minecraft:spruce_log',
  'birch log': 'minecraft:birch_log',
  'birch logs': 'minecraft:birch_log',
  'jungle log': 'minecraft:jungle_log',
  'jungle logs': 'minecraft:jungle_log',
  'acacia log': 'minecraft:acacia_log',
  'acacia logs': 'minecraft:acacia_log',
  'dark oak log': 'minecraft:dark_oak_log',
  'dark oak logs': 'minecraft:dark_oak_log',
  'mangrove log': 'minecraft:mangrove_log',
  'mangrove logs': 'minecraft:mangrove_log',
  'cherry log': 'minecraft:cherry_log',
  'cherry logs': 'minecraft:cherry_log',
  'pale oak log': 'minecraft:pale_oak_log',
  'crimson stem': 'minecraft:crimson_stem',
  'warped stem': 'minecraft:warped_stem',
  plank: 'minecraft:oak_planks',
  planks: 'minecraft:oak_planks',
  'wood planks': 'minecraft:oak_planks',
  'wooden planks': 'minecraft:oak_planks',
  stick: 'minecraft:stick',
  sticks: 'minecraft:stick',

  // Stone & Earth
  stone: 'minecraft:cobblestone',
  cobble: 'minecraft:cobblestone',
  cobblestone: 'minecraft:cobblestone',
  'smooth stone': 'minecraft:smooth_stone',
  'clean stone': 'minecraft:stone',
  deepslate: 'minecraft:cobbled_deepslate',
  'cobbled deepslate': 'minecraft:cobbled_deepslate',
  granite: 'minecraft:granite',
  diorite: 'minecraft:diorite',
  andesite: 'minecraft:andesite',
  tuff: 'minecraft:tuff',
  calcite: 'minecraft:calcite',
  basalt: 'minecraft:basalt',
  blackstone: 'minecraft:blackstone',
  netherrack: 'minecraft:netherrack',
  'soul sand': 'minecraft:soul_sand',
  'soul soil': 'minecraft:soul_soil',
  'end stone': 'minecraft:end_stone',
  obsidian: 'minecraft:obsidian',
  'crying obsidian': 'minecraft:crying_obsidian',
  dirt: 'minecraft:dirt',
  sand: 'minecraft:sand',
  'red sand': 'minecraft:red_sand',
  gravel: 'minecraft:gravel',
  flint: 'minecraft:flint',
  clay: 'minecraft:clay_ball',
  mud: 'minecraft:mud',
  ice: 'minecraft:ice',
  'packed ice': 'minecraft:packed_ice',
  'blue ice': 'minecraft:blue_ice',
  snow: 'minecraft:snowball',
  glass: 'minecraft:glass',

  // Ores, Raw Metals, Ingots & Gems
  coal: 'minecraft:coal',
  charcoal: 'minecraft:charcoal',
  iron: 'minecraft:raw_iron',
  'raw iron': 'minecraft:raw_iron',
  'iron ore': 'minecraft:raw_iron',
  'iron ingot': 'minecraft:iron_ingot',
  'iron ingots': 'minecraft:iron_ingot',
  gold: 'minecraft:raw_gold',
  'raw gold': 'minecraft:raw_gold',
  'gold ore': 'minecraft:raw_gold',
  'gold ingot': 'minecraft:gold_ingot',
  'gold ingots': 'minecraft:gold_ingot',
  copper: 'minecraft:raw_copper',
  'raw copper': 'minecraft:raw_copper',
  'copper ore': 'minecraft:raw_copper',
  'copper ingot': 'minecraft:copper_ingot',
  'copper ingots': 'minecraft:copper_ingot',
  diamond: 'minecraft:diamond',
  diamonds: 'minecraft:diamond',
  'diamond ore': 'minecraft:diamond',
  emerald: 'minecraft:emerald',
  emeralds: 'minecraft:emerald',
  lapis: 'minecraft:lapis_lazuli',
  'lapis lazuli': 'minecraft:lapis_lazuli',
  redstone: 'minecraft:redstone',
  'redstone dust': 'minecraft:redstone',
  quartz: 'minecraft:quartz',
  'nether quartz': 'minecraft:quartz',
  amethyst: 'minecraft:amethyst_shard',
  'amethyst shards': 'minecraft:amethyst_shard',
  'ancient debris': 'minecraft:ancient_debris',
  debris: 'minecraft:ancient_debris',
  netherite: 'minecraft:netherite_ingot',
  'netherite scrap': 'minecraft:netherite_scrap',
  'netherite ingot': 'minecraft:netherite_ingot',
  glowstone: 'minecraft:glowstone_dust',

  // Weapons & Tools (including 1.21 Mace & Spears!)
  mace: 'minecraft:mace',
  'heavy core': 'minecraft:heavy_core',
  'breeze rod': 'minecraft:breeze_rod',
  'wind charge': 'minecraft:wind_charge',
  'wind charges': 'minecraft:wind_charge',
  spear: 'minecraft:iron_spear',
  'wooden spear': 'minecraft:wooden_spear',
  'stone spear': 'minecraft:stone_spear',
  'iron spear': 'minecraft:iron_spear',
  'golden spear': 'minecraft:golden_spear',
  'diamond spear': 'minecraft:diamond_spear',
  'netherite spear': 'minecraft:netherite_spear',
  trident: 'minecraft:trident',
  shield: 'minecraft:shield',
  bow: 'minecraft:bow',
  crossbow: 'minecraft:crossbow',
  arrow: 'minecraft:arrow',
  arrows: 'minecraft:arrow',
  totem: 'minecraft:totem_of_undying',

  // Workstations & Utility
  workbench: 'minecraft:crafting_table',
  'crafting table': 'minecraft:crafting_table',
  furnace: 'minecraft:furnace',
  'blast furnace': 'minecraft:blast_furnace',
  smoker: 'minecraft:smoker',
  chest: 'minecraft:chest',
  chests: 'minecraft:chest',
  barrel: 'minecraft:barrel',
  'ender chest': 'minecraft:ender_chest',
  anvil: 'minecraft:anvil',
  'enchanting table': 'minecraft:enchanting_table',
  'smithing table': 'minecraft:smithing_table',
  bookshelf: 'minecraft:bookshelf',
  bookshelves: 'minecraft:bookshelf',
  torch: 'minecraft:torch',
  torches: 'minecraft:torch',
  lantern: 'minecraft:lantern',
  lanterns: 'minecraft:lantern',
  bed: 'minecraft:white_bed',
  bucket: 'minecraft:bucket',

  // Food & Crops
  wheat: 'minecraft:wheat',
  bread: 'minecraft:bread',
  carrot: 'minecraft:carrot',
  carrots: 'minecraft:carrot',
  'golden carrot': 'minecraft:golden_carrot',
  'golden carrots': 'minecraft:golden_carrot',
  potato: 'minecraft:potato',
  potatoes: 'minecraft:potato',
  'baked potato': 'minecraft:baked_potato',
  'baked potatoes': 'minecraft:baked_potato',
  apple: 'minecraft:apple',
  apples: 'minecraft:apple',
  'golden apple': 'minecraft:golden_apple',
  'golden apples': 'minecraft:golden_apple',
  gapple: 'minecraft:golden_apple',
  gapples: 'minecraft:golden_apple',
  steak: 'minecraft:cooked_beef',
  beef: 'minecraft:cooked_beef',
  'cooked beef': 'minecraft:cooked_beef',
  porkchop: 'minecraft:cooked_porkchop',
  'cooked porkchop': 'minecraft:cooked_porkchop',
  chicken: 'minecraft:cooked_chicken',
  mutton: 'minecraft:cooked_mutton',
  salmon: 'minecraft:cooked_salmon',
  sugar: 'minecraft:sugar',
  'sugar cane': 'minecraft:sugar_cane',
  sugarcane: 'minecraft:sugar_cane',
  bamboo: 'minecraft:bamboo',
  pumpkin: 'minecraft:pumpkin',
  pumpkins: 'minecraft:pumpkin',
  melon: 'minecraft:melon_slice',
  melons: 'minecraft:melon_slice',
  berries: 'minecraft:sweet_berries',
  food: 'minecraft:bread'
});

const DEFAULT_SMART_QUANTITIES = Object.freeze({
  'minecraft:oak_log': 32,
  'minecraft:spruce_log': 32,
  'minecraft:birch_log': 32,
  'minecraft:cobblestone': 64,
  'minecraft:stone': 64,
  'minecraft:cobbled_deepslate': 64,
  'minecraft:dirt': 64,
  'minecraft:sand': 64,
  'minecraft:gravel': 32,
  'minecraft:coal': 32,
  'minecraft:raw_iron': 32,
  'minecraft:raw_gold': 16,
  'minecraft:raw_copper': 32,
  'minecraft:diamond': 8,
  'minecraft:emerald': 8,
  'minecraft:redstone': 32,
  'minecraft:lapis_lazuli': 24,
  'minecraft:quartz': 32,
  'minecraft:ancient_debris': 4,
  'minecraft:obsidian': 14
});

function resolveSmartResourceId(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  let s = rawName
    .trim()
    .toLowerCase()
    .replace(/^(?:a|an|some|the|all)\s+/i, '')
    .replace(/\s+/g, ' ');
  if (!s) return null;

  if (RESOURCE_SYNONYMS[s]) return RESOURCE_SYNONYMS[s];

  // Strip regular trailing plural 's' / 'es' if not already known
  if (s.endsWith('s') && !s.endsWith('glass') && !s.endsWith('grass') && !s.endsWith('debris') && !s.endsWith('planks') && !s.endsWith('bricks') && !s.endsWith('boots') && !s.endsWith('leggings') && !s.endsWith('shears') && !s.endsWith('bars') && !s.endsWith('stairs')) {
    const singular = s.replace(/ies$/, 'y').replace(/s$/, '');
    if (RESOURCE_SYNONYMS[singular]) return RESOURCE_SYNONYMS[singular];
    s = singular;
  }

  const underscored = s.replace(/\s+/g, '_');
  if (underscored.includes(':')) {
    return /^[a-z0-9_]+:[a-z0-9_./-]+$/.test(underscored) ? underscored : null;
  }
  return /^[a-z0-9_./-]+$/.test(underscored) ? `minecraft:${underscored}` : null;
}

function defaultConstraints(overrides = {}) {
  return {
    maxRisk: 'low',
    avoidHazards: ['lava', 'void'],
    allowExistingStock: false,
    maxTravelBlocks: 256,
    ...overrides
  };
}

function makeObjective(localId, kind, resourceId, quantity, opts = {}) {
  const deps = (opts.deps || []).map((d) =>
    typeof d === 'string' ? { localId: d, edgeType: 'finish_to_start' } : d
  );
  return {
    localId,
    kind,
    target: {
      resourceId,
      quantity,
      regionLabel: opts.regionLabel ?? null,
      description: opts.description || `${kind} ${quantity ?? ''} ${resourceId ?? opts.regionLabel ?? ''}`.trim()
    },
    dependencies: deps,
    parallelism: opts.parallelism || (kind === 'craft' ? 'single' : 'partitionable'),
    workerCountHint: opts.workerCountHint ?? (kind === 'craft' ? 1 : Math.min(8, Math.max(1, Math.ceil((quantity || 1) / 32)))),
    constraints: defaultConstraints(opts.constraints),
    verification:
      opts.verification ||
      (kind === 'craft'
        ? 'crafted_output'
        : kind === 'explore'
          ? 'region_visited'
          : kind === 'guard'
            ? 'role_duration'
            : kind === 'build' || kind === 'repair' || kind === 'inspect'
              ? 'block_state'
              : kind === 'transfer'
                ? 'deposited_stock'
                : 'newly_collected')
  };
}

/**
 * Multi-step Zero-AI Progression Kits (each <= 16 DAG objectives, topologically valid).
 */
const PROGRESSION_KITS = Object.freeze({
  wooden_tools: {
    title: 'Get Wooden Tools Set',
    aliases: ['get wooden tools', 'make wooden tools', 'craft wooden tools', 'wood tools', 'wooden toolset', 'wooden kit'],
    buildObjectives: () => [
      makeObjective('log_1', 'collect', 'minecraft:oak_log', 6),
      makeObjective('planks_2', 'craft', 'minecraft:oak_planks', 24, { deps: ['log_1'] }),
      makeObjective('sticks_3', 'craft', 'minecraft:stick', 12, { deps: ['planks_2'] }),
      makeObjective('table_4', 'craft', 'minecraft:crafting_table', 1, { deps: ['planks_2'] }),
      makeObjective('wpick_5', 'craft', 'minecraft:wooden_pickaxe', 1, { deps: ['sticks_3', 'table_4'] }),
      makeObjective('waxe_6', 'craft', 'minecraft:wooden_axe', 1, { deps: ['wpick_5'] }),
      makeObjective('wsword_7', 'craft', 'minecraft:wooden_sword', 1, { deps: ['waxe_6'] }),
      makeObjective('wshovel_8', 'craft', 'minecraft:wooden_shovel', 1, { deps: ['wsword_7'] })
    ]
  },
  stone_tools: {
    title: 'Get Stone Tools & Furnace Progression',
    aliases: ['get stone tools', 'make stone tools', 'craft stone tools', 'stone tools', 'stone toolset', 'stone age', 'stone kit', 'upgrade to stone'],
    buildObjectives: () => [
      makeObjective('log_1', 'collect', 'minecraft:oak_log', 8),
      makeObjective('planks_2', 'craft', 'minecraft:oak_planks', 32, { deps: ['log_1'] }),
      makeObjective('sticks_3', 'craft', 'minecraft:stick', 16, { deps: ['planks_2'] }),
      makeObjective('table_4', 'craft', 'minecraft:crafting_table', 1, { deps: ['planks_2'] }),
      makeObjective('wpick_5', 'craft', 'minecraft:wooden_pickaxe', 1, { deps: ['sticks_3', 'table_4'] }),
      makeObjective('cobble_6', 'mine', 'minecraft:cobblestone', 24, { deps: ['wpick_5'] }),
      makeObjective('spick_7', 'craft', 'minecraft:stone_pickaxe', 1, { deps: ['cobble_6'] }),
      makeObjective('saxe_8', 'craft', 'minecraft:stone_axe', 1, { deps: ['spick_7'] }),
      makeObjective('ssword_9', 'craft', 'minecraft:stone_sword', 1, { deps: ['saxe_8'] }),
      makeObjective('sshovel_10', 'craft', 'minecraft:stone_shovel', 1, { deps: ['ssword_9'] }),
      makeObjective('furnace_11', 'craft', 'minecraft:furnace', 1, { deps: ['sshovel_10'] })
    ]
  },
  iron_tools: {
    title: 'Get Iron Tools & Shield Progression',
    aliases: ['get iron tools', 'make iron tools', 'craft iron tools', 'iron tools', 'iron toolset', 'iron gear', 'upgrade to iron'],
    buildObjectives: () => [
      makeObjective('coal_1', 'mine', 'minecraft:coal', 12),
      makeObjective('raw_iron_2', 'mine', 'minecraft:raw_iron', 16),
      makeObjective('ingot_3', 'craft', 'minecraft:iron_ingot', 16, { deps: ['coal_1', 'raw_iron_2'] }),
      makeObjective('ipick_4', 'craft', 'minecraft:iron_pickaxe', 1, { deps: ['ingot_3'] }),
      makeObjective('isword_5', 'craft', 'minecraft:iron_sword', 1, { deps: ['ipick_4'] }),
      makeObjective('iaxe_6', 'craft', 'minecraft:iron_axe', 1, { deps: ['isword_5'] }),
      makeObjective('ishovel_7', 'craft', 'minecraft:iron_shovel', 1, { deps: ['iaxe_6'] }),
      makeObjective('shield_8', 'craft', 'minecraft:shield', 1, { deps: ['ishovel_7'] }),
      makeObjective('bucket_9', 'craft', 'minecraft:bucket', 1, { deps: ['shield_8'] })
    ]
  },
  iron_armor: {
    title: 'Get Full Iron Armor Suit (24 Ingots)',
    aliases: ['get iron armor', 'make iron armor', 'craft iron armor', 'full iron armor', 'iron suit', 'iron armour'],
    buildObjectives: () => [
      makeObjective('coal_1', 'mine', 'minecraft:coal', 12),
      makeObjective('raw_iron_2', 'mine', 'minecraft:raw_iron', 24),
      makeObjective('ingot_3', 'craft', 'minecraft:iron_ingot', 24, { deps: ['coal_1', 'raw_iron_2'] }),
      makeObjective('ihelm_4', 'craft', 'minecraft:iron_helmet', 1, { deps: ['ingot_3'] }),
      makeObjective('ichest_5', 'craft', 'minecraft:iron_chestplate', 1, { deps: ['ihelm_4'] }),
      makeObjective('ilegs_6', 'craft', 'minecraft:iron_leggings', 1, { deps: ['ichest_5'] }),
      makeObjective('iboots_7', 'craft', 'minecraft:iron_boots', 1, { deps: ['ilegs_6'] })
    ]
  },
  full_iron_kit: {
    title: 'Get Complete Iron Knight Kit (Armor + Weapons + Tools)',
    aliases: ['get full iron kit', 'full iron', 'iron knight kit', 'get iron kit', 'complete iron kit'],
    buildObjectives: () => [
      makeObjective('log_1', 'collect', 'minecraft:oak_log', 8),
      makeObjective('coal_2', 'mine', 'minecraft:coal', 16),
      makeObjective('iron_3', 'mine', 'minecraft:raw_iron', 36),
      makeObjective('planks_4', 'craft', 'minecraft:oak_planks', 24, { deps: ['log_1'] }),
      makeObjective('sticks_5', 'craft', 'minecraft:stick', 12, { deps: ['planks_4'] }),
      makeObjective('ingot_6', 'craft', 'minecraft:iron_ingot', 36, { deps: ['coal_2', 'iron_3'] }),
      makeObjective('helm_7', 'craft', 'minecraft:iron_helmet', 1, { deps: ['ingot_6'] }),
      makeObjective('chest_8', 'craft', 'minecraft:iron_chestplate', 1, { deps: ['helm_7'] }),
      makeObjective('legs_9', 'craft', 'minecraft:iron_leggings', 1, { deps: ['chest_8'] }),
      makeObjective('boots_10', 'craft', 'minecraft:iron_boots', 1, { deps: ['legs_9'] }),
      makeObjective('sword_11', 'craft', 'minecraft:iron_sword', 1, { deps: ['boots_10', 'sticks_5'] }),
      makeObjective('pick_12', 'craft', 'minecraft:iron_pickaxe', 1, { deps: ['sword_11'] }),
      makeObjective('axe_13', 'craft', 'minecraft:iron_axe', 1, { deps: ['pick_12'] }),
      makeObjective('shield_14', 'craft', 'minecraft:shield', 1, { deps: ['axe_13', 'planks_4'] })
    ]
  },
  diamond_tools: {
    title: 'Get Diamond Tools & Sword Set',
    aliases: ['get diamond tools', 'make diamond tools', 'craft diamond tools', 'diamond tools', 'diamond gear', 'upgrade to diamond'],
    buildObjectives: () => [
      makeObjective('diam_1', 'mine', 'minecraft:diamond', 11, { constraints: { maxRisk: 'medium' } }),
      makeObjective('dpick_2', 'craft', 'minecraft:diamond_pickaxe', 1, { deps: ['diam_1'] }),
      makeObjective('dsword_3', 'craft', 'minecraft:diamond_sword', 1, { deps: ['dpick_2'] }),
      makeObjective('daxe_4', 'craft', 'minecraft:diamond_axe', 1, { deps: ['dsword_3'] }),
      makeObjective('dshovel_5', 'craft', 'minecraft:diamond_shovel', 1, { deps: ['daxe_4'] })
    ]
  },
  diamond_armor: {
    title: 'Get Full Diamond Armor Suit (24 Diamonds)',
    aliases: ['get diamond armor', 'make diamond armor', 'craft diamond armor', 'full diamond armor', 'diamond suit', 'full diamond'],
    buildObjectives: () => [
      makeObjective('diam_1', 'mine', 'minecraft:diamond', 24, { constraints: { maxRisk: 'medium' } }),
      makeObjective('dhelm_2', 'craft', 'minecraft:diamond_helmet', 1, { deps: ['diam_1'] }),
      makeObjective('dchest_3', 'craft', 'minecraft:diamond_chestplate', 1, { deps: ['dhelm_2'] }),
      makeObjective('dlegs_4', 'craft', 'minecraft:diamond_leggings', 1, { deps: ['dchest_3'] }),
      makeObjective('dboots_5', 'craft', 'minecraft:diamond_boots', 1, { deps: ['dlegs_4'] })
    ]
  },
  netherite_kit: {
    title: 'Mine Ancient Debris & Forge Netherite Ingots',
    aliases: ['get netherite', 'get netherite tools', 'get netherite kit', 'mine netherite', 'forge netherite'],
    buildObjectives: () => [
      makeObjective('debris_1', 'mine', 'minecraft:ancient_debris', 16, { constraints: { maxRisk: 'medium' } }),
      makeObjective('gold_2', 'mine', 'minecraft:raw_gold', 16, { constraints: { maxRisk: 'medium' } }),
      makeObjective('scrap_3', 'craft', 'minecraft:netherite_scrap', 16, { deps: ['debris_1'] }),
      makeObjective('gingot_4', 'craft', 'minecraft:gold_ingot', 16, { deps: ['gold_2'] }),
      makeObjective('ningot_5', 'craft', 'minecraft:netherite_ingot', 4, { deps: ['scrap_3', 'gingot_4'] })
    ]
  },
  mace_pvp_kit: {
    title: 'Forge 1.21 Mace Smash PvP Loadout',
    aliases: ['get mace kit', 'mace pvp kit', 'craft mace loadout', 'get mace'],
    buildObjectives: () => [
      makeObjective('mace_1', 'craft', 'minecraft:mace', 1),
      makeObjective('wind_2', 'craft', 'minecraft:wind_charge', 16, { deps: ['mace_1'] }),
      makeObjective('shield_3', 'craft', 'minecraft:shield', 1, { deps: ['wind_2'] }),
      makeObjective('gapple_4', 'craft', 'minecraft:golden_apple', 4, { deps: ['shield_3'] })
    ]
  },
  spear_pvp_kit: {
    title: 'Forge Spear & Shield Phalanx Loadout',
    aliases: ['get spear kit', 'spear pvp kit', 'craft spear loadout', 'get spear'],
    buildObjectives: () => [
      makeObjective('spear_1', 'craft', 'minecraft:diamond_spear', 1),
      makeObjective('axe_2', 'craft', 'minecraft:diamond_axe', 1, { deps: ['spear_1'] }),
      makeObjective('shield_3', 'craft', 'minecraft:shield', 1, { deps: ['axe_2'] })
    ]
  },
  starter_base_kit: {
    title: 'Bootstrap Starter Base (Logs + Stone Tools + Shelter + Guard)',
    aliases: ['starter kit', 'bootstrap base', 'start survival', 'day 1 kit', 'day one kit'],
    buildObjectives: () => [
      makeObjective('log_1', 'collect', 'minecraft:oak_log', 16),
      makeObjective('cobble_2', 'mine', 'minecraft:cobblestone', 64),
      makeObjective('planks_3', 'craft', 'minecraft:oak_planks', 32, { deps: ['log_1'] }),
      makeObjective('table_4', 'craft', 'minecraft:crafting_table', 1, { deps: ['planks_3'] }),
      makeObjective('furnace_5', 'craft', 'minecraft:furnace', 1, { deps: ['cobble_2', 'table_4'] }),
      makeObjective('shelter_6', 'build', null, 1, {
        regionLabel: 'schematic:starter_shelter',
        description: 'Build Starter Survival Shelter',
        deps: ['cobble_2', 'planks_3']
      }),
      makeObjective('guard_7', 'guard', null, null, {
        regionLabel: 'starter_shelter_perimeter',
        description: 'Guard base perimeter during construction',
        deps: [{ localId: 'shelter_6', edgeType: 'start_with' }],
        parallelism: 'role_based',
        workerCountHint: 1
      })
    ]
  }
});

/**
 * Generate a deduplicated deterministic Zero-AI command catalog.
 */
function buildMasterCommandCatalog() {
  const catalog = [];
  let seq = 1;
  const add = (category, label, commandText, tags = []) => {
    catalog.push({
      id: `cmd_${String(seq++).padStart(4, '0')}`,
      category,
      label,
      commandText,
      tags
    });
  };

  // 1. Progression & PvP Kits (11 multi-step DAGs + variations)
  for (const [key, kit] of Object.entries(PROGRESSION_KITS)) {
    add('progression', kit.title, kit.aliases[0], ['dag', 'zero-ai', key]);
  }

  // 2. Forestry & Wood (11 wood types x 6 quantities + planks + sticks + stripped = 110+ commands)
  const woods = [
    'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
    'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped'
  ];
  const woodQtys = [8, 16, 32, 64, 128, 256];
  for (const w of woods) {
    const suffix = w === 'crimson' || w === 'warped' ? 'stem' : 'log';
    for (const q of woodQtys) {
      add('wood', `Collect ${q} ${w.replace('_', ' ')} ${suffix}`, `collect ${q} minecraft:${w}_${suffix}`, [w, 'wood', suffix]);
    }
    for (const q of [16, 32, 64, 128]) {
      add('wood', `Craft ${q} ${w.replace('_', ' ')} planks`, `craft ${q} minecraft:${w}_planks`, [w, 'planks', 'craft']);
    }
  }
  for (const q of [8, 16, 32, 64, 128]) {
    add('wood', `Craft ${q} sticks`, `craft ${q} minecraft:stick`, ['sticks', 'craft']);
  }

  // 3. Mining Ores & Precious Gems (13 ores x 7 quantities + combo sweeps = 115+ commands)
  add('mining', 'Mine Iron, Gold & Diamonds (Combo Sweep)', 'mine iron, gold, diamonds', ['combo', 'ores', 'popular']);
  add('mining', 'Mine Coal & Iron (Smelter Run)', 'mine 32 coal and 32 raw_iron', ['combo', 'iron', 'coal']);
  add('mining', 'Mine Diamonds & Obsidian (Enchant Run)', 'mine 12 diamond and 14 obsidian', ['combo', 'diamond', 'obsidian']);
  const ores = [
    ['raw_iron', 'Raw Iron'],
    ['raw_gold', 'Raw Gold'],
    ['raw_copper', 'Raw Copper'],
    ['coal', 'Coal'],
    ['diamond', 'Diamonds'],
    ['emerald', 'Emeralds'],
    ['redstone', 'Redstone Dust'],
    ['lapis_lazuli', 'Lapis Lazuli'],
    ['quartz', 'Nether Quartz'],
    ['ancient_debris', 'Ancient Debris'],
    ['amethyst_shard', 'Amethyst Shards'],
    ['glowstone_dust', 'Glowstone Dust']
  ];
  for (const [id, title] of ores) {
    for (const q of [4, 8, 16, 32, 64, 128, 256]) {
      add('mining', `Mine ${q} ${title}`, `mine ${q} minecraft:${id}`, [id, 'ore', 'mine']);
      add('mining', `Mine ${q} ${title} + 1 Guard`, `mine ${q} minecraft:${id} while one bot guards`, [id, 'guard', 'mine']);
    }
  }

  // 4. Quarry, Stone & Terraforming (24 blocks x 6 quantities = 144 commands)
  add('quarry', 'Collect Stone (64 Cobblestone)', 'collect stone', ['stone', 'cobblestone', 'popular']);
  const stones = [
    'cobblestone', 'stone', 'cobbled_deepslate', 'granite', 'diorite', 'andesite',
    'tuff', 'calcite', 'obsidian', 'crying_obsidian', 'basalt', 'blackstone',
    'netherrack', 'soul_sand', 'soul_soil', 'end_stone', 'dirt', 'sand',
    'red_sand', 'gravel', 'flint', 'clay_ball', 'mud', 'packed_ice'
  ];
  for (const st of stones) {
    for (const q of [16, 32, 64, 128, 256, 512]) {
      add('quarry', `Gather ${q} ${st.replace(/_/g, ' ')}`, `collect ${q} minecraft:${st}`, [st, 'quarry']);
    }
  }

  // 5. Tools, Weapons, Mace & Spears Crafting (6 tiers x 7 weapon/tool types + specials = 120+ commands)
  const toolTiers = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
  const toolKinds = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'spear'];
  for (const tier of toolTiers) {
    for (const kind of toolKinds) {
      for (const q of [1, 2, 4]) {
        add('weapons_tools', `Craft ${q}x ${tier} ${kind}`, `craft ${q} minecraft:${tier}_${kind}`, [tier, kind, 'weapon', 'tool']);
      }
    }
  }
  const combatSpecials = [
    ['mace', '1.21 Heavy Mace'],
    ['shield', 'Shield'],
    ['bow', 'Bow'],
    ['crossbow', 'Crossbow'],
    ['flint_and_steel', 'Flint and Steel'],
    ['shears', 'Shears'],
    ['fishing_rod', 'Fishing Rod'],
    ['spyglass', 'Spyglass'],
    ['brush', 'Brush'],
    ['bucket', 'Iron Bucket']
  ];
  for (const [id, name] of combatSpecials) {
    for (const q of [1, 2, 4]) {
      add('weapons_tools', `Craft ${q}x ${name}`, `craft ${q} minecraft:${id}`, [id, 'combat', 'utility']);
    }
  }
  for (const q of [16, 32, 64, 128]) {
    add('weapons_tools', `Craft ${q} Arrows`, `craft ${q} minecraft:arrow`, ['arrow', 'ranged']);
    add('weapons_tools', `Craft ${q} Spectral Arrows`, `craft ${q} minecraft:spectral_arrow`, ['spectral_arrow', 'ranged']);
    add('weapons_tools', `Craft ${q} Wind Charges`, `craft ${q} minecraft:wind_charge`, ['wind_charge', 'mace', 'pvp']);
  }

  // 6. Armor Forging (5 tiers x 4 pieces x 3 counts = 64 commands)
  for (const tier of ['leather', 'iron', 'golden', 'diamond', 'netherite']) {
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      for (const q of [1, 2, 4]) {
        add('armor', `Craft ${q}x ${tier} ${piece}`, `craft ${q} minecraft:${tier}_${piece}`, [tier, piece, 'armor']);
      }
    }
  }
  add('armor', 'Craft Turtle Shell Helmet', 'craft 1 minecraft:turtle_helmet', ['turtle', 'armor']);
  add('armor', 'Craft Wolf Armor', 'craft 1 minecraft:wolf_armor', ['wolf', 'armor']);

  // 7. Smelting & Furnace Refining (16 recipes x 5 quantities = 80 commands)
  const smelts = [
    ['iron_ingot', 'Smelt Iron Ingots'],
    ['gold_ingot', 'Smelt Gold Ingots'],
    ['copper_ingot', 'Smelt Copper Ingots'],
    ['netherite_scrap', 'Smelt Netherite Scrap'],
    ['glass', 'Smelt Glass'],
    ['stone', 'Smelt Clean Stone'],
    ['smooth_stone', 'Smelt Smooth Stone'],
    ['charcoal', 'Burn Charcoal'],
    ['brick', 'Fire Clay Bricks'],
    ['nether_brick', 'Smelt Nether Bricks'],
    ['cooked_beef', 'Cook Steak (Beef)'],
    ['cooked_porkchop', 'Cook Porkchops'],
    ['cooked_chicken', 'Cook Chicken'],
    ['cooked_mutton', 'Cook Mutton'],
    ['cooked_salmon', 'Cook Salmon'],
    ['baked_potato', 'Bake Potatoes']
  ];
  for (const [id, title] of smelts) {
    for (const q of [8, 16, 32, 64, 128]) {
      add('smelting', `${title} (${q})`, `craft ${q} minecraft:${id}`, [id, 'smelt', 'furnace']);
    }
  }

  // 8. Workstations, Beds (16 colors), Storage & Lighting (160+ commands)
  const stations = [
    'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel',
    'ender_chest', 'anvil', 'smithing_table', 'grindstone', 'stonecutter',
    'loom', 'cartography_table', 'fletching_table', 'brewing_stand',
    'enchanting_table', 'bookshelf', 'lectern', 'cauldron', 'composter',
    'crafter', 'beacon', 'jukebox', 'Lodestone'.toLowerCase(), 'respawn_anchor'
  ];
  for (const st of stations) {
    for (const q of [1, 2, 4, 8]) {
      add('workstations', `Craft ${q}x ${st.replace(/_/g, ' ')}`, `craft ${q} minecraft:${st}`, [st, 'station']);
    }
  }
  const dyeColors = [
    'white', 'light_gray', 'gray', 'black', 'brown', 'red', 'orange', 'yellow',
    'lime', 'green', 'cyan', 'light_blue', 'blue', 'purple', 'magenta', 'pink'
  ];
  for (const col of dyeColors) {
    add('workstations', `Craft ${col.replace('_', ' ')} bed`, `craft 1 minecraft:${col}_bed`, [col, 'bed']);
    add('workstations', `Craft 16 ${col.replace('_', ' ')} wool`, `craft 16 minecraft:${col}_wool`, [col, 'wool']);
    add('workstations', `Craft 64 ${col.replace('_', ' ')} concrete_powder`, `craft 64 minecraft:${col}_concrete_powder`, [col, 'concrete']);
    add('workstations', `Craft 32 ${col.replace('_', ' ')} stained_glass`, `craft 32 minecraft:${col}_stained_glass`, [col, 'glass']);
  }
  for (const light of ['torch', 'soul_torch', 'lantern', 'soul_lantern', 'ladder', 'scaffolding']) {
    for (const q of [16, 32, 64]) {
      add('workstations', `Craft ${q} ${light.replace('_', ' ')}`, `craft ${q} minecraft:${light}`, [light, 'lighting']);
    }
  }

  // 9. Building Blocks, Architecture & Redstone Engineering (240+ commands)
  const buildBlocks = [
    'stone_bricks', 'mossy_stone_bricks', 'deepslate_bricks', 'deepslate_tiles',
    'polished_blackstone_bricks', 'bricks', 'mud_bricks', 'sandstone', 'quartz_block',
    'purpur_block', 'prismarine_bricks', 'copper_bulb', 'chiseled_tuff_bricks',
    'cobblestone_slab', 'stone_brick_slab', 'oak_slab', 'spruce_slab',
    'cobblestone_stairs', 'stone_brick_stairs', 'oak_stairs', 'spruce_stairs',
    'cobblestone_wall', 'stone_brick_wall', 'oak_fence', 'oak_fence_gate',
    'oak_door', 'spruce_door', 'iron_door', 'oak_trapdoor', 'iron_trapdoor',
    'glass_pane', 'iron_bars'
  ];
  for (const bb of buildBlocks) {
    for (const q of [16, 32, 64, 128]) {
      add('building_blocks', `Craft ${q} ${bb.replace(/_/g, ' ')}`, `craft ${q} minecraft:${bb}`, [bb, 'architecture']);
    }
  }
  const redstoneItems = [
    'piston', 'sticky_piston', 'observer', 'repeater', 'comparator', 'hopper',
    'dropper', 'dispenser', 'redstone_torch', 'redstone_lamp', 'redstone_block',
    'target', 'lever', 'stone_button', 'daylight_detector', 'rail', 'powered_rail',
    'detector_rail', 'activator_rail', 'minecart', 'chest_minecart', 'hopper_minecart', 'tnt'
  ];
  for (const rs of redstoneItems) {
    for (const q of [1, 4, 16, 32]) {
      add('redstone', `Craft ${q} ${rs.replace(/_/g, ' ')}`, `craft ${q} minecraft:${rs}`, [rs, 'redstone']);
    }
  }

  // 10. Food, Farming & Crops (110+ commands)
  const crops = [
    'wheat', 'carrot', 'potato', 'beetroot', 'melon_slice', 'pumpkin',
    'sugar_cane', 'bamboo', 'sweet_berries', 'glow_berries', 'cocoa_beans',
    'kelp', 'brown_mushroom', 'red_mushroom', 'nether_wart', 'chorus_fruit'
  ];
  for (const crop of crops) {
    for (const q of [16, 32, 64, 128]) {
      add('farming', `Harvest ${q} ${crop.replace(/_/g, ' ')}`, `collect ${q} minecraft:${crop}`, [crop, 'farm']);
    }
  }
  const craftedFoods = [
    ['bread', 'Bread'],
    ['golden_apple', 'Golden Apple'],
    ['golden_carrot', 'Golden Carrot'],
    ['pumpkin_pie', 'Pumpkin Pie'],
    ['cake', 'Cake'],
    ['cookie', 'Cookies'],
    ['mushroom_stew', 'Mushroom Stew'],
    ['hay_block', 'Hay Bales'],
    ['bone_meal', 'Bone Meal']
  ];
  for (const [id, name] of craftedFoods) {
    for (const q of [4, 16, 32, 64]) {
      add('farming', `Craft ${q} ${name}`, `craft ${q} minecraft:${id}`, [id, 'food']);
    }
  }

  // 11. Schematics & Base Construction (All built-in Blueprints + Guarded Variants)
  for (const sch of BUILTIN_SCHEMATICS.values()) {
    add('schematics', `Build Schematic: ${sch.name}`, `build schematic ${sch.schematicId}`, ['schematic', sch.schematicId, sch.category]);
    add('schematics', `Build ${sch.name} + Guard`, `build schematic ${sch.schematicId} while one bot guards`, ['schematic', 'guard', sch.schematicId]);
  }

  // 12. Scouting, Exploration, Guarding, Logistics & Repair (90+ commands)
  const sectors = [
    'spawn_basin', 'north_ridge', 'south_valley', 'east_forest', 'west_plains',
    'deep_cave_alpha', 'ravine_sector', 'village_outskirts', 'nether_wastes',
    'crimson_forest', 'bastion_perimeter', 'fortress_bridge', 'trial_chamber_vault',
    'stronghold_ring', 'mountain_peaks', 'ocean_coastline'
  ];
  for (const sec of sectors) {
    add('recon_guard', `Explore ${sec.replace(/_/g, ' ')}`, `explore ${sec}`, ['explore', sec]);
    add('recon_guard', `Guard ${sec.replace(/_/g, ' ')}`, `guard ${sec}`, ['guard', sec]);
  }
  const deposits = [
    'cobblestone', 'oak_log', 'coal', 'raw_iron', 'iron_ingot', 'raw_gold',
    'gold_ingot', 'diamond', 'emerald', 'redstone', 'lapis_lazuli', 'ancient_debris',
    'bread', 'cooked_beef', 'rotten_flesh', 'bone', 'gunpowder', 'ender_pearl'
  ];
  for (const item of deposits) {
    for (const q of [16, 64]) {
      add('logistics', `Deposit ${q} ${item.replace(/_/g, ' ')} to Chest`, `deposit ${q} minecraft:${item}`, ['deposit', 'chest', item]);
    }
  }

  // A command library should expose different jobs, not hundreds of quantity-only copies.
  // Keep one useful quantity per action/resource and retain genuinely different roles,
  // combinations, schematics, and progression kits.
  const curated = new Map();
  const quantityScore = (text) => {
    const quantities = String(text).match(/\b\d+\b/g) || [];
    return quantities.reduce((score, raw) => score + Math.abs(Number(raw) - 32), 0);
  };
  for (const item of catalog) {
    const normalized = item.commandText.toLowerCase().trim();
    const familyKey = normalized.replace(/\b\d+\b/g, '#');
    const previous = curated.get(familyKey);
    if (!previous || quantityScore(normalized) < quantityScore(previous.commandText)) {
      curated.set(familyKey, item);
    }
  }

  const unique = Array.from(curated.values());
  const addUseful = (category, label, commandText, tags = []) => {
    const key = commandText.toLowerCase().trim().replace(/\b\d+\b/g, '#');
    if (curated.has(key)) return;
    const item = { category, label, commandText, tags };
    curated.set(key, item);
    unique.push(item);
  };
  // Survival actions are intentionally distinct from ordinary material quantity presets.
  addUseful('survival', 'Hunt nearby animals for food', 'food', ['survival', 'food', 'animals']);
  addUseful('combat', 'Clear nearby hostile mobs', 'hunt', ['combat', 'defense', 'hostiles']);
  addUseful('survival', 'Chop nearby trees for starter timber', 'tree 16', ['survival', 'wood', 'starter']);
  addUseful('survival', 'Build a compact starter shelter', 'build starter_shelter', ['survival', 'shelter', 'base']);
  addUseful('farming', 'Prepare a crop plot with irrigation space', 'build crop_farm_9x9', ['food', 'farm', 'base']);
  addUseful('defense', 'Build a safe perimeter wall', 'build perimeter_trench', ['defense', 'base', 'mobs']);
  addUseful('exploration', 'Scout the spawn area for resources', 'explore spawn_basin', ['scout', 'resources']);
  addUseful('defense', 'Guard the base perimeter', 'guard base_perimeter', ['guard', 'base', 'survival']);

  return Object.freeze(unique.map((item, index) => Object.freeze({
    id: `cmd_${String(index + 1).padStart(4, '0')}`,
    category: item.category,
    label: item.label,
    commandText: item.commandText,
    tags: item.tags
  })));
}

const MASTER_ZERO_AI_CATALOG = buildMasterCommandCatalog();

function listZeroAiCommands({ category = null, search = null, limit = 120, offset = 0 } = {}) {
  let items = MASTER_ZERO_AI_CATALOG;
  if (category && category !== 'all') {
    items = items.filter((c) => c.category === category);
  }
  if (search && String(search).trim()) {
    const tokens = String(search)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    items = items.filter((c) => {
      const hay = `${c.label} ${c.commandText} ${c.category} ${c.tags.join(' ')}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 120)));
  return {
    totalCatalogCommands: MASTER_ZERO_AI_CATALOG.length,
    matchedCount: items.length,
    offset: safeOffset,
    limit: safeLimit,
    categories: getCategorySummary(),
    commands: items.slice(safeOffset, safeOffset + safeLimit)
  };
}

let cachedCategorySummary = null;
function getCategorySummary() {
  if (cachedCategorySummary) return cachedCategorySummary;
  const counts = {};
  for (const c of MASTER_ZERO_AI_CATALOG) {
    counts[c.category] = (counts[c.category] || 0) + 1;
  }
  cachedCategorySummary = Object.entries(counts).map(([category, count]) => ({
    category,
    count
  }));
  return cachedCategorySummary;
}

/**
 * Extended Deterministic Zero-AI Natural Language Parser.
 * Resolves curated presets & freeform survival/mining/crafting/smelting/building/guard/logistics intents
 * into validated `TaskPlanV1` objects with 0 LLM calls.
 */
function parseExtendedZeroAiIntent(userText, requestId) {
  const reqId = requestId || crypto.randomUUID();
  const raw = typeof userText === 'string' ? userText.trim() : '';
  const norm = raw
    .toLowerCase()
    .replace(/^(?:\/|!swarm\s+)/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();
  if (!norm) return null;

  // Preserve complex conditional / strategy prompts for remote AI brain
  if (
    norm.includes(' if ') ||
    norm.startsWith('please run ') ||
    norm.startsWith('prepare ') ||
    norm.startsWith('organize ') ||
    norm.startsWith('coordinate ')
  ) {
    return null;
  }

  // 1. Multi-step Progression Kits ("get stone tools", "/kit full_iron_kit", etc.)
  const explicitKitMatch = /^kit\s+([a-z0-9_ -]+)$/i.exec(norm);
  const kitLookup = explicitKitMatch ? explicitKitMatch[1].trim().replace(/\s+/g, '_') : null;
  for (const [kitId, kit] of Object.entries(PROGRESSION_KITS)) {
    if (kitId === norm || kitId === kitLookup || kit.aliases.includes(norm) || (kitLookup && kit.aliases.includes(kitLookup.replace(/_/g, ' ')))) {
      return {
        schemaVersion: 1,
        requestId: reqId,
        intentSummary: kit.title,
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: kit.buildObjectives(),
        riskLevel: 'low',
        notes: [`zero_ai_progression_kit:${kitId}`]
      };
    }
  }

  // 2. Schematic Build Commands ("build schematic watchtower", "build watchtower", "build castle keep while one bot guards")
  const hasGuardSuffix = /\s+while\s+(?:one|a|1)\s+bot\s+guards$/i.test(norm);
  const withoutGuardSuffix = hasGuardSuffix
    ? norm.replace(/\s+while\s+(?:one|a|1)\s+bot\s+guards$/i, '').trim()
    : norm;
  const treeCommand = /^(?:tree|chop tree|chop trees)(?:\s+(\d+))?$/.exec(withoutGuardSuffix);
  const coreBuildText = treeCommand
    ? `collect ${treeCommand[1] || 16} oak logs`
    : withoutGuardSuffix;

  const schematicMatch = /^(?:build|construct|place)\s+(?:schematic\s+)?([a-z0-9_ -]{3,48})$/i.exec(coreBuildText);
  if (schematicMatch) {
    const slug = schematicMatch[1]
      .trim()
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/\s+/g, '_');
    const aliasMap = {
      watchtower: 'watchtower',
      tower: 'watchtower',
      fortress_wall: 'fortress_wall',
      wall: 'fortress_wall',
      storage_bunker: 'storage_bunker',
      bunker: 'storage_bunker',
      obsidian_bunker: 'obsidian_bunker',
      crop_farm: 'crop_farm_9x9',
      crop_farm_9x9: 'crop_farm_9x9',
      farm: 'crop_farm_9x9',
      bridge: 'bridge_16',
      bridge_16: 'bridge_16',
      nether_portal: 'nether_portal_frame',
      nether_portal_frame: 'nether_portal_frame',
      portal: 'nether_portal_frame',
      enchanting_room: 'enchanting_room',
      smeltery: 'smeltery_array',
      smeltery_array: 'smeltery_array',
      castle: 'castle_keep',
      castle_keep: 'castle_keep',
      pvp_arena: 'pvp_arena',
      arena: 'pvp_arena',
      mob_grinder: 'mob_grinder_platform',
      mob_grinder_platform: 'mob_grinder_platform',
      skybase: 'skybase_platform',
      skybase_platform: 'skybase_platform',
      perimeter_trench: 'perimeter_trench',
      staircase_mine: 'staircase_mine',
      starter_shelter: 'starter_shelter'
    };
    const schId = BUILTIN_SCHEMATICS.has(slug) ? slug : aliasMap[slug];
    if (schId) {
      const sch = BUILTIN_SCHEMATICS.get(schId);
      const objectives = [
        makeObjective('obj_build_1', 'build', null, 1, {
          regionLabel: `schematic:${schId}`,
          description: `Build ${sch.name} (${sch.blockCount} blocks)`,
          parallelism: 'single',
          workerCountHint: 1
        })
      ];
      if (hasGuardSuffix) {
        objectives.push(
          makeObjective('obj_guard_1', 'guard', null, null, {
            regionLabel: `${schId}_perimeter`,
            description: `Guard ${sch.name} construction team`,
            deps: [{ localId: 'obj_build_1', edgeType: 'start_with' }],
            parallelism: 'role_based',
            workerCountHint: 1
          })
        );
      }
      return {
        schemaVersion: 1,
        requestId: reqId,
        intentSummary: raw.slice(0, 500),
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives,
        riskLevel: 'low',
        notes: [`zero_ai_schematic:${schId}`]
      };
    }
  }

  // 3. Smelt / Cook / Bake / Forge / Craft ("smelt 32 iron", "/smelt iron_ingot 32", "craft diamond_pickaxe 1")
  const craftOrSmelt = /^(craft|make|forge|smelt|cook|bake|burn)\s+(?:(a|an|\d+)\s+)?([a-z0-9_: ]{2,48}?)(?:\s+(\d+))?$/i.exec(norm);
  if (craftOrSmelt) {
    const verb = craftOrSmelt[1].toLowerCase();
    const qtyRaw = craftOrSmelt[2] || craftOrSmelt[4];
    let itemPhrase = craftOrSmelt[3].trim();
    if ((verb === 'smelt' || verb === 'forge') && (itemPhrase === 'iron' || itemPhrase === 'raw iron')) {
      itemPhrase = 'iron ingot';
    } else if ((verb === 'smelt' || verb === 'forge') && (itemPhrase === 'gold' || itemPhrase === 'raw gold')) {
      itemPhrase = 'gold ingot';
    } else if ((verb === 'smelt' || verb === 'forge') && (itemPhrase === 'copper' || itemPhrase === 'raw copper')) {
      itemPhrase = 'copper ingot';
    } else if (verb === 'cook' && itemPhrase === 'beef') {
      itemPhrase = 'cooked beef';
    }
    const resourceId = resolveSmartResourceId(itemPhrase);
    const qty = !qtyRaw || qtyRaw === 'a' || qtyRaw === 'an' ? (verb === 'smelt' || verb === 'cook' ? 16 : 1) : Number(qtyRaw);
    if (resourceId && Number.isSafeInteger(qty) && qty >= 1 && qty <= 10_000) {
      return {
        schemaVersion: 1,
        requestId: reqId,
        intentSummary: `${verb} ${qty} ${resourceId}`,
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [makeObjective('obj_craft_1', 'craft', resourceId, qty)],
        riskLevel: 'low',
        notes: ['zero_ai_craft_or_smelt']
      };
    }
  }

  // 4. Guard / Explore / Inspect / Repair / Deposit
  const sectorVerb = /^(guard|patrol|defend|explore|scout|scan)\s+([a-z0-9_ -]{2,48})$/i.exec(norm);
  if (sectorVerb) {
    const v = sectorVerb[1].toLowerCase();
    const kind =
      v === 'guard' || v === 'patrol' || v === 'defend'
        ? 'guard'
        : 'explore';
    const label = sectorVerb[2]
      .trim()
      .replace(/^(?:the|around|area)\s+/i, '')
      .replace(/\s+/g, '_')
      .slice(0, 64) || 'base_perimeter';
    return {
      schemaVersion: 1,
      requestId: reqId,
      intentSummary: `${kind} ${label}`,
      clarificationRequired: false,
      clarificationQuestion: null,
      objectives: [
        makeObjective(`obj_${kind}_1`, kind, null, kind === 'guard' || kind === 'explore' ? null : 1, {
          regionLabel: label,
          parallelism: kind === 'explore' ? 'spatial' : kind === 'guard' ? 'role_based' : 'single',
          workerCountHint: kind === 'explore' ? 2 : 1
        })
      ],
      riskLevel: 'low',
      notes: [`zero_ai_${kind}`]
    };
  }

  const depositMatch = /^(?:deposit|store|transfer|stash)\s+(?:(\d+)\s+)?([a-z0-9_: ]{2,48}?)(?:\s+(\d+))?(?:\s+(?:in|into|to)\s+(?:chest|storage|vault))?$/i.exec(norm);
  if (depositMatch) {
    const resourceId = resolveSmartResourceId(depositMatch[2]);
    const qtyStr = depositMatch[1] || depositMatch[3];
    const qty = qtyStr ? Number(qtyStr) : 64;
    if (resourceId && Number.isSafeInteger(qty) && qty >= 1 && qty <= 100_000) {
      return {
        schemaVersion: 1,
        requestId: reqId,
        intentSummary: `Deposit ${qty} ${resourceId}`,
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [makeObjective('obj_transfer_1', 'transfer', resourceId, qty, { parallelism: 'single', workerCountHint: 1 })],
        riskLevel: 'low',
        notes: ['zero_ai_transfer']
      };
    }
  }

  // 5. Flexible Multi-Item Gather / Mine / Chop / Harvest — WITH OR WITHOUT NUMBERS!
  //    Examples:
  //    - "collect 64 logs"
  //    - "collect stone"
  //    - "mine iron ,gold,diamonds"
  //    - "chop 32 oak logs and 32 birch logs"
  const gatherMatch = /^(mine|collect|gather|chop|harvest|dig|farm|get)\s+(.+)$/i.exec(coreBuildText);
  if (gatherMatch && !coreBuildText.includes(' after ')) {
    const leadVerb = gatherMatch[1].toLowerCase();
    const defaultKind = leadVerb === 'mine' || leadVerb === 'dig' ? 'mine' : 'collect';
    const parts = gatherMatch[2]
      .split(/\s*(?:,|\band\b|\+|&)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);

    if (parts.length >= 1 && parts.length <= 12) {
      const merged = new Map();
      let ok = true;

      for (const part of parts) {
        const m = /^(?:(mine|collect|gather|chop|harvest|dig|farm|get)\s+)?(?:(\d+)\s+)?([a-z0-9_: ]{2,48}?)(?:\s+(\d+))?$/i.exec(part);
        if (!m) {
          ok = false;
          break;
        }
        const subVerb = m[1] ? m[1].toLowerCase() : leadVerb;
        const kind = subVerb === 'mine' || subVerb === 'dig' ? 'mine' : defaultKind;
        const resourceId = resolveSmartResourceId(m[3]);
        if (!resourceId) {
          ok = false;
          break;
        }
        const qtyToken = m[2] || m[4];
        const qty = qtyToken ? Number(qtyToken) : (DEFAULT_SMART_QUANTITIES[resourceId] || 32);
        if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000) {
          ok = false;
          break;
        }
        const key = `${kind}|${resourceId}`;
        const prev = merged.get(key);
        if (prev) {
          prev.qty = Math.min(1_000_000, prev.qty + qty);
        } else {
          merged.set(key, { kind, resourceId, qty });
        }
      }

      if (ok && merged.size > 0 && merged.size <= 15) {
        const objectives = Array.from(merged.values()).map((entry, idx) =>
          makeObjective(`obj_${entry.kind}_${idx + 1}`, entry.kind, entry.resourceId, entry.qty, {
            description: `Aggregate target: ${entry.kind} ${entry.qty} ${entry.resourceId}`,
            workerCountHint: entry.qty < 16 ? 1 : Math.min(19, Math.ceil(entry.qty / 40))
          })
        );
        if (hasGuardSuffix) {
          objectives.push(
            makeObjective('obj_guard_1', 'guard', null, null, {
              regionLabel: 'mining_perimeter',
              description: 'Guard gathering team perimeter',
              deps: [{ localId: objectives[0].localId, edgeType: 'start_with' }],
              parallelism: 'role_based',
              workerCountHint: 1
            })
          );
        }
        return {
          schemaVersion: 1,
          requestId: reqId,
          intentSummary: raw.slice(0, 500),
          clarificationRequired: false,
          clarificationQuestion: null,
          objectives,
          riskLevel: 'low',
          notes: ['zero_ai_multi_resource']
        };
      }
    }
  }

  return null;
}

module.exports = {
  MASTER_ZERO_AI_CATALOG,
  PROGRESSION_KITS,
  RESOURCE_SYNONYMS,
  resolveSmartResourceId,
  listZeroAiCommands,
  getCategorySummary,
  parseExtendedZeroAiIntent
};
