'use strict';

const { BUILTIN_SCHEMATICS } = require('../schematics/SchematicBuilder');
const {
  MASTER_ZERO_AI_CATALOG,
  PROGRESSION_KITS,
  RESOURCE_SYNONYMS
} = require('./ZeroAiCommandDeck');

/**
 * NEXUS-20 Minecraft Brigadier-Style Command Tree & Tab-Autocomplete Engine (`src/commands/CommandCompleter.js`).
 *
 * Provides instant Minecraft-style token-by-token `Tab` suggestions for:
 *  - Web Control Centre Command Bars (Global command bar, Zero-AI bar, Intent Brain bar, PvP player bar)
 *  - Interactive Termux / Linux CLI Console (`readline` `completer`)
 *  - HTTP Endpoint (`GET /api/v1/commands/autocomplete`)
 */

const ROOT_COMMANDS = Object.freeze([
  {
    name: 'mine',
    syntax: 'mine <ore_or_block> [count]',
    category: 'mining',
    description: 'Mine ores or stone across the swarm (e.g. mine diamond 64)',
    hasArgs: true
  },
  {
    name: 'goto',
    syntax: 'goto <x> <y> <z> [bot]',
    category: 'navigation',
    description: 'Navigate a bot or the swarm to absolute Minecraft coordinates',
    hasArgs: true
  },
  {
    name: 'go',
    syntax: 'go <x> <y> <z> [bot]',
    category: 'navigation',
    description: 'Alias for goto',
    hasArgs: true
  },
  {
    name: 'tree',
    syntax: 'tree [count]',
    category: 'gathering',
    description: 'Safely chop nearby trees for logs (e.g. tree 16; also: chop trees 16)',
    hasArgs: true
  },
  {
    name: 'food',
    syntax: 'food [count] [bot]',
    category: 'survival',
    description: 'Hunt nearby edible animals for the requested food count per bot; backs off when hurt or threatened',
    hasArgs: true
  },
  {
    name: 'gather',
    syntax: 'gather [count] <logs|stone|ores|food|resource>',
    category: 'gathering',
    description: 'Gather an exact quantity of logs, stone or ores; gather food hunts animals',
    hasArgs: true
  },
  {
    name: 'harvest',
    syntax: 'harvest [count] <crops|wheat|carrots|potatoes|beetroots>',
    category: 'gathering',
    description: 'Harvest ripe crops; generic crops/food means wheat',
    hasArgs: true
  },
  {
    name: 'collect',
    syntax: 'collect <resource> [count]',
    category: 'gathering',
    description: 'Gather logs, blocks, crops or drops (e.g. collect oak_log 64)',
    hasArgs: true
  },
  {
    name: 'craft',
    syntax: 'craft <item> [count]',
    category: 'crafting',
    description: 'Auto-craft tools, weapons, mace, spears & armor (e.g. craft diamond_pickaxe 1)',
    hasArgs: true
  },
  {
    name: 'smelt',
    syntax: 'smelt <item> [count]',
    category: 'smelting',
    description: 'Smelt ores or cook food in nearby furnace (e.g. smelt iron_ingot 32)',
    hasArgs: true
  },
  {
    name: 'kit',
    syntax: 'kit <progression_kit>',
    category: 'progression',
    description: 'Run full multi-step progression DAG (stone_tools, full_iron_kit, mace_pvp_kit...)',
    hasArgs: true
  },
  {
    name: 'build',
    syntax: 'build <schematic> [bot]',
    category: 'schematics',
    description: 'Construct any 3D schematic blueprint bottom-up (watchtower, castle_keep...)',
    hasArgs: true
  },
  {
    name: 'kill',
    syntax: 'kill <player> [weapon] [bot]',
    category: 'pvp',
    description: 'Elite PvP attack on player (auto, mace, spear, axe, sword, bow)',
    hasArgs: true
  },
  {
    name: 'follow',
    syntax: 'follow <player> [bot]',
    category: 'players',
    description: 'Escort & follow target player on the server',
    hasArgs: true
  },
  {
    name: 'protect',
    syntax: 'protect <player> [bot]',
    category: 'players',
    description: 'Bodyguard player & eliminate nearby hostile threats',
    hasArgs: true
  },
  {
    name: 'surround',
    syntax: 'surround <player> [bot]',
    category: 'players',
    description: 'Form 360° defensive knight shield ring around player',
    hasArgs: true
  },
  {
    name: 'drop',
    syntax: 'drop <player> [item|all] [bot]',
    category: 'players',
    description: 'Walk to player and toss inventory loot',
    hasArgs: true
  },
  {
    name: 'hunt',
    syntax: 'hunt [bot]',
    category: 'pvp',
    description: 'Hunt & clear nearby hostile mobs autonomously',
    hasArgs: true
  },
  {
    name: 'ally',
    syntax: 'ally <player>',
    category: 'players',
    description: 'Mark player as trusted swarm ally (never targeted)',
    hasArgs: true
  },
  {
    name: 'kos',
    syntax: 'kos <player>',
    category: 'pvp',
    description: 'Mark player Kill-On-Sight for all bots',
    hasArgs: true
  },
  {
    name: 'explore',
    syntax: 'explore <sector>',
    category: 'exploration',
    description: 'Scout & map sectors in parallel across bots',
    hasArgs: true
  },
  {
    name: 'guard',
    syntax: 'guard <perimeter>',
    category: 'defense',
    description: 'Patrol & defend base or mining perimeter',
    hasArgs: true
  },
  {
    name: 'deposit',
    syntax: 'deposit <item> [count]',
    category: 'logistics',
    description: 'Deposit collected resources into storage chests',
    hasArgs: true
  },
  {
    name: 'skin',
    syntax: 'skin sync [bot]',
    category: 'skins',
    description: 'Sync Crimson Shadow Knight skin across all bots',
    hasArgs: true
  },
  {
    name: 'mode',
    syntax: 'mode <HYBRID|SYNCHRONIZED|DISTRIBUTED>',
    category: 'swarm',
    description: 'Switch swarm coordination operating mode',
    hasArgs: true
  },
  {
    name: 'profile',
    syntax: 'profile <BALANCED|PERFORMANCE|MAXIMUM_THROUGHPUT|LOW|ULTRA_LOW>',
    category: 'swarm',
    description: 'Switch performance governor profile',
    hasArgs: true
  },
  {
    name: 'botcap',
    syntax: 'botcap <1..20>',
    category: 'swarm',
    description: 'Set active swarm bot cap (1..20)',
    hasArgs: true
  },
  {
    name: 'stop',
    syntax: 'stop',
    category: 'swarm',
    description: 'Emergency stop & ceasefire across all bots immediately',
    hasArgs: false
  }
]);

const MINE_TARGETS = Object.freeze([
  'diamond',
  'raw_iron',
  'cobblestone',
  'coal',
  'raw_gold',
  'ancient_debris',
  'obsidian',
  'redstone',
  'emerald',
  'raw_copper',
  'lapis_lazuli',
  'quartz',
  'cobbled_deepslate',
  'stone',
  'amethyst_shard',
  'glowstone_dust',
  'netherrack',
  'blackstone',
  'basalt',
  'end_stone',
  'iron, gold, diamonds'
]);

const COLLECT_TARGETS = Object.freeze([
  'oak_log',
  'spruce_log',
  'birch_log',
  'dark_oak_log',
  'cherry_log',
  'mangrove_log',
  'jungle_log',
  'acacia_log',
  'cobblestone',
  'sand',
  'gravel',
  'flint',
  'dirt',
  'clay_ball',
  'wheat',
  'carrot',
  'potato',
  'sugar_cane',
  'leather',
  'feather',
  'blaze_rod',
  'ender_pearl',
  'gunpowder',
  'bone',
  'string'
]);

const CRAFT_TARGETS = Object.freeze([
  'diamond_pickaxe',
  'diamond_sword',
  'diamond_axe',
  'diamond_spear',
  'mace',
  'wind_charge',
  'shield',
  'iron_pickaxe',
  'iron_sword',
  'iron_axe',
  'iron_helmet',
  'iron_chestplate',
  'iron_leggings',
  'iron_boots',
  'diamond_helmet',
  'diamond_chestplate',
  'diamond_leggings',
  'diamond_boots',
  'netherite_ingot',
  'golden_apple',
  'crafting_table',
  'furnace',
  'chest',
  'oak_planks',
  'stick',
  'torch',
  'bow',
  'crossbow',
  'arrow',
  'bucket',
  'enchanting_table',
  'anvil',
  'white_bed',
  'stone_pickaxe',
  'wooden_pickaxe'
]);

const SMELT_TARGETS = Object.freeze([
  'iron_ingot',
  'gold_ingot',
  'copper_ingot',
  'netherite_scrap',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'baked_potato',
  'glass',
  'smooth_stone',
  'stone',
  'charcoal',
  'brick',
  'nether_brick'
]);

const EXPLORE_SECTORS = Object.freeze([
  'spawn_basin',
  'north_ridge',
  'south_valley',
  'east_forest',
  'west_canyon',
  'deep_caves',
  'nether_fortress_sector',
  'stronghold_ring',
  'ancient_city_depths',
  'trial_chambers_zone'
]);

const WEAPON_STYLES = Object.freeze([
  { id: 'auto', desc: 'Auto Mastery (Mace Smash + Axe Shield-Break + Spear + Sword + Bow)' },
  { id: 'mace', desc: '1.21 Heavy Mace + Wind Charge Aerial Smash' },
  { id: 'spear', desc: 'Spear / Trident 3.4m Phalanx Reach' },
  { id: 'axe', desc: 'Heavy Axe Shield-Breaker' },
  { id: 'sword', desc: 'Enchanted Sword Jump-Crits + W-Tap' },
  { id: 'bow', desc: 'Ranged Bow / Crossbow Sniper' }
]);

const STACK_COUNTS = Object.freeze(['64', '32', '16', '128', '256', '8', '4', '1']);
const CRAFT_COUNTS = Object.freeze(['1', '2', '4', '8', '16', '32', '64']);
const MODES = Object.freeze(['HYBRID', 'SYNCHRONIZED', 'DISTRIBUTED']);
const PROFILES = Object.freeze([
  'BALANCED',
  'PERFORMANCE',
  'MAXIMUM_THROUGHPUT',
  'LOW',
  'ULTRA_LOW'
]);

function buildAutocompleteDictionary(context = {}) {
  const builtinSchematics = Array.from(BUILTIN_SCHEMATICS.values()).map((s) => ({
    id: s.schematicId,
    name: s.name,
    blocks: s.blockCount
  }));
  const extraSchematics = Array.isArray(context.schematics) ? context.schematics : [];
  const schematicMap = new Map();
  for (const s of [...builtinSchematics, ...extraSchematics]) {
    const id = s.id || s.schematicId;
    if (id && !schematicMap.has(id)) {
      schematicMap.set(id, {
        id,
        name: s.name || id,
        blocks: s.blocks || s.blockCount || 0
      });
    }
  }

  const kits = Object.entries(PROGRESSION_KITS).map(([id, kit]) => ({
    id,
    title: kit.title,
    aliases: kit.aliases
  }));

  const extraSynonyms = Object.values(RESOURCE_SYNONYMS)
    .map((v) => String(v).replace(/^minecraft:/, ''))
    .filter((v, idx, arr) => arr.indexOf(v) === idx);

  const allItems = Array.from(
    new Set([...MINE_TARGETS, ...COLLECT_TARGETS, ...CRAFT_TARGETS, ...SMELT_TARGETS, ...extraSynonyms])
  ).filter((s) => !s.includes(','));

  const players = Array.isArray(context.players)
    ? context.players.map((p) => (typeof p === 'string' ? p : p?.username)).filter(Boolean)
    : [];

  const bots = Array.isArray(context.bots)
    ? context.bots.map((b) => (typeof b === 'string' ? b : b?.botId || b?.username)).filter(Boolean)
    : [];

  return {
    rootCommands: ROOT_COMMANDS,
    mineTargets: MINE_TARGETS,
    collectTargets: COLLECT_TARGETS,
    craftTargets: CRAFT_TARGETS,
    smeltTargets: SMELT_TARGETS,
    allItems,
    kits,
    schematics: Array.from(schematicMap.values()),
    exploreSectors: EXPLORE_SECTORS,
    weaponStyles: WEAPON_STYLES,
    stackCounts: STACK_COUNTS,
    craftCounts: CRAFT_COUNTS,
    modes: MODES,
    profiles: PROFILES,
    players,
    bots
  };
}

function rankPrefixAndSubstring(candidates, partialToken, maxItems) {
  const q = String(partialToken || '').toLowerCase();
  if (!q) return candidates.slice(0, maxItems);
  const starts = [];
  const contains = [];
  for (const c of candidates) {
    const low = c.token.toLowerCase();
    if (low.startsWith(q)) starts.push(c);
    else if (low.includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, maxItems);
}

/**
 * Compute Minecraft Brigadier-style completions for any partial or multi-token command.
 */
function getBrigadierCompletions(rawInput, contextOrDict = {}, maxSuggestions = 14) {
  const dict = contextOrDict.rootCommands ? contextOrDict : buildAutocompleteDictionary(contextOrDict);
  const input = typeof rawInput === 'string' ? rawInput : '';

  const prefixMatch = /^(\s*(?:\/|!swarm\s+)?)/.exec(input);
  const leadingPrefix = prefixMatch ? prefixMatch[1] : '';
  const body = input.slice(leadingPrefix.length);

  const endsWithSpace = body.length > 0 && /\s$/.test(body);
  const trimmedBody = body.trim();
  const rawParts = trimmedBody.length > 0 ? trimmedBody.split(/\s+/) : [];
  const hasTrailingSpace = endsWithSpace && rawParts.length > 0;

  // Argument index currently being edited (0 = root verb, 1 = first arg, 2 = second arg, ...)
  const argIndex = rawParts.length === 0 ? 0 : hasTrailingSpace ? rawParts.length : rawParts.length - 1;
  const activeToken = hasTrailingSpace ? '' : (rawParts[argIndex] || '');
  const priorTokens = rawParts.slice(0, argIndex);

  const prefixBeforeToken =
    priorTokens.length === 0
      ? leadingPrefix
      : `${leadingPrefix}${priorTokens.join(' ')} `;

  const makeEntry = (token, description, category, hasNextArg = false) => {
    const fullLine = `${prefixBeforeToken}${token}${hasNextArg ? ' ' : ''}`;
    const ghostSuffix =
      activeToken && token.toLowerCase().startsWith(activeToken.toLowerCase())
        ? token.slice(activeToken.length)
        : !activeToken
          ? token
          : '';
    return {
      token,
      applyValue: fullLine,
      cycleValue: `${prefixBeforeToken}${token}`,
      ghostSuffix,
      description: description || '',
      category: category || 'cmd',
      hasNextArg: Boolean(hasNextArg)
    };
  };

  // Root verb completion (argIndex === 0)
  if (argIndex === 0) {
    const rootCandidates = dict.rootCommands.map((cmd) =>
      makeEntry(cmd.name, `${cmd.syntax} — ${cmd.description}`, cmd.category, cmd.hasArgs)
    );
    const ranked = rankPrefixAndSubstring(rootCandidates, activeToken, maxSuggestions);
    if (ranked.length > 0 || !body.trim()) {
      return {
        prefixBeforeToken,
        activeToken,
        argIndex,
        syntaxHint: '<command> <args...>  (Press Tab to auto-fill)',
        suggestions: ranked
      };
    }

    // Let single-word natural-language searches reach the curated Zero-AI catalog
    // too (e.g. `wooden` -> `get wooden tools`), not only multi-token phrases.
    const searchText = body.trim().toLowerCase();
    const phraseMatches = MASTER_ZERO_AI_CATALOG
      .filter((item) =>
        item.commandText.toLowerCase().includes(searchText) || item.label.toLowerCase().includes(searchText)
      )
      .slice(0, maxSuggestions)
      .map((item) => ({
        token: item.commandText,
        applyValue: `${leadingPrefix}${item.commandText}`,
        cycleValue: `${leadingPrefix}${item.commandText}`,
        ghostSuffix: item.commandText.toLowerCase().startsWith(searchText)
          ? item.commandText.slice(searchText.length)
          : '',
        description: item.label,
        category: item.category,
        hasNextArg: false
      }));
    return {
      prefixBeforeToken: leadingPrefix,
      activeToken: body.trim(),
      argIndex,
      syntaxHint: '<zero-ai command>',
      suggestions: phraseMatches
    };
  }

  const verb = (priorTokens[0] || '').toLowerCase();
  const rootMeta = dict.rootCommands.find((c) => c.name === verb);
  const syntaxHint = rootMeta ? rootMeta.syntax : `${verb} ...`;

  const botChoices = [
    makeEntry('*', 'Entire Swarm (All Bots)', 'bots', false),
    ...(dict.bots || []).map((b) => makeEntry(b, 'Target specific swarm bot', 'bots', false))
  ];

  const playerNames =
    dict.players && dict.players.length > 0 ? dict.players : ['Steve', 'Alex'];

  let pool = [];

  if (verb === 'mine' || verb === 'dig') {
    if (argIndex === 1) {
      pool = dict.mineTargets.map((t) => makeEntry(t, `Mine ${t}`, 'mining', true));
    } else if (argIndex === 2) {
      if (/^\d+$/.test(priorTokens[1])) {
        pool = dict.mineTargets.map((t) => makeEntry(t, `Mine ${priorTokens[1]} ${t}`, 'mining', false));
      } else {
        pool = dict.stackCounts.map((n) => makeEntry(n, `Target quantity: ${n}`, 'count', false));
      }
    }
  } else if (verb === 'goto' || verb === 'go') {
    if (argIndex === 4) pool = botChoices;
  } else if (verb === 'tree') {
    if (argIndex === 1) pool = dict.stackCounts.map((n) => makeEntry(n, `Chop ${n} logs`, 'count', false));
  } else if (verb === 'food') {
    if (argIndex === 1) {
      pool = [
        ...dict.stackCounts.map((n) => makeEntry(n, `Hunt for ${n} food items per bot`, 'count', true)),
        ...botChoices
      ];
    } else if (argIndex === 2 && /^\d+$/.test(priorTokens[1])) {
      pool = botChoices;
    }
  } else if (verb === 'mobs' || verb === 'hunt' || verb === 'hunt_mobs') {
    if (argIndex === 1) pool = botChoices;
  } else if (verb === 'collect' || verb === 'gather' || verb === 'chop' || verb === 'harvest') {
    if (argIndex === 1) {
      pool = dict.collectTargets.map((t) => makeEntry(t, `Collect ${t}`, 'gathering', true));
    } else if (argIndex === 2) {
      if (/^\d+$/.test(priorTokens[1])) {
        pool = dict.collectTargets.map((t) => makeEntry(t, `Collect ${priorTokens[1]} ${t}`, 'gathering', false));
      } else {
        pool = dict.stackCounts.map((n) => makeEntry(n, `Target quantity: ${n}`, 'count', false));
      }
    }
  } else if (verb === 'craft' || verb === 'make' || verb === 'forge') {
    if (argIndex === 1) {
      pool = dict.craftTargets.map((t) => makeEntry(t, `Craft ${t}`, 'crafting', true));
    } else if (argIndex === 2) {
      if (/^\d+$/.test(priorTokens[1])) {
        pool = dict.craftTargets.map((t) => makeEntry(t, `Craft ${priorTokens[1]} ${t}`, 'crafting', false));
      } else {
        pool = dict.craftCounts.map((n) => makeEntry(n, `Craft quantity: ${n}`, 'count', false));
      }
    }
  } else if (verb === 'smelt' || verb === 'cook' || verb === 'bake') {
    if (argIndex === 1) {
      pool = dict.smeltTargets.map((t) => makeEntry(t, `Smelt ${t} in furnace`, 'smelting', true));
    } else if (argIndex === 2) {
      if (/^\d+$/.test(priorTokens[1])) {
        pool = dict.smeltTargets.map((t) => makeEntry(t, `Smelt ${priorTokens[1]} ${t}`, 'smelting', false));
      } else {
        pool = ['16', '32', '64', '8', '128'].map((n) => makeEntry(n, `Smelt quantity: ${n}`, 'count', false));
      }
    }
  } else if (verb === 'kit' || verb === 'get') {
    if (argIndex === 1) {
      pool = dict.kits.map((k) => makeEntry(k.id, k.title, 'progression', false));
      if (verb === 'get') {
        for (const alias of [
          'stone tools',
          'iron tools',
          'full iron kit',
          'diamond tools',
          'diamond armor',
          'mace kit',
          'spear kit',
          'netherite'
        ]) {
          pool.push(makeEntry(alias, `Progression kit: ${alias}`, 'progression', false));
        }
      }
    }
  } else if (verb === 'build' || verb === 'construct') {
    if (argIndex === 1) {
      pool = dict.schematics.map((s) =>
        makeEntry(s.id, `${s.name} (${s.blocks} blocks)`, 'schematics', true)
      );
    } else if (argIndex === 2) {
      pool = botChoices;
    }
  } else if (verb === 'kill' || verb === 'attack') {
    if (argIndex === 1) {
      pool = playerNames.map((p) => makeEntry(p, `PvP attack ${p}`, 'pvp', true));
    } else if (argIndex === 2) {
      pool = dict.weaponStyles.map((w) => makeEntry(w.id, w.desc, 'pvp', true));
    } else if (argIndex === 3) {
      pool = botChoices;
    }
  } else if (verb === 'follow' || verb === 'protect' || verb === 'surround') {
    if (argIndex === 1) {
      pool = playerNames.map((p) => makeEntry(p, `${verb} ${p}`, 'players', true));
    } else if (argIndex === 2) {
      pool = botChoices;
    }
  } else if (verb === 'ally' || verb === 'kos') {
    if (argIndex === 1) {
      pool = playerNames.map((p) => makeEntry(p, `Set ${p} standing -> ${verb.toUpperCase()}`, 'players', false));
    }
  } else if (verb === 'drop') {
    if (argIndex === 1) {
      pool = playerNames.map((p) => makeEntry(p, `Drop loot to ${p}`, 'players', true));
    } else if (argIndex === 2) {
      pool = [
        makeEntry('all', 'Drop all non-equipped inventory items', 'logistics', true),
        ...dict.allItems.slice(0, 30).map((it) => makeEntry(it, `Drop only ${it}`, 'logistics', true))
      ];
    } else if (argIndex === 3) {
      pool = botChoices;
    }
  } else if (verb === 'hunt' || verb === 'hunt_mobs' || verb === 'mobs' || verb === 'food') {
    if (argIndex === 1) {
      pool = botChoices;
    }
  } else if (verb === 'explore' || verb === 'scout') {
    if (argIndex === 1) {
      pool = dict.exploreSectors.map((s) => makeEntry(s, `Scout sector ${s}`, 'exploration', false));
    }
  } else if (verb === 'guard' || verb === 'patrol' || verb === 'defend') {
    if (argIndex === 1) {
      pool = [
        'base_perimeter',
        'spawn_basin',
        'mining_perimeter',
        'storage_vault',
        ...playerNames
      ].map((s) => makeEntry(s, `Guard ${s}`, 'defense', false));
    }
  } else if (verb === 'deposit' || verb === 'store') {
    if (argIndex === 1) {
      pool = dict.allItems.slice(0, 40).map((it) => makeEntry(it, `Deposit ${it} into chest`, 'logistics', true));
    } else if (argIndex === 2) {
      pool = dict.stackCounts.map((n) => makeEntry(n, `Deposit quantity: ${n}`, 'count', false));
    }
  } else if (verb === 'skin') {
    if (argIndex === 1) {
      pool = [
        makeEntry('sync', 'Sync Crimson Shadow Knight skin across swarm', 'skins', true),
        makeEntry('knight_crimson', 'Equip 64x64 Crimson Shadow Knight skin', 'skins', true)
      ];
    } else if (argIndex === 2) {
      pool = botChoices;
    }
  } else if (verb === 'mode') {
    if (argIndex === 1) {
      pool = dict.modes.map((m) => makeEntry(m, `Switch operating mode to ${m}`, 'swarm', false));
    }
  } else if (verb === 'profile') {
    if (argIndex === 1) {
      pool = dict.profiles.map((p) => makeEntry(p, `Switch performance profile to ${p}`, 'swarm', false));
    }
  } else if (verb === 'botcap') {
    if (argIndex === 1) {
      pool = ['2', '4', '6', '8', '10', '12', '16', '20'].map((n) =>
        makeEntry(n, `Enable up to ${n} active bots`, 'swarm', false)
      );
    }
  }

  // Fallback to curated Zero-AI catalog phrase search if user typed a freeform phrase
  if (pool.length === 0) {
    const fullLower = body.trim().toLowerCase();
    const phraseMatches = [];
    for (const item of MASTER_ZERO_AI_CATALOG) {
      if (item.commandText.toLowerCase().includes(fullLower) || item.label.toLowerCase().includes(fullLower)) {
        phraseMatches.push({
          token: item.commandText,
          applyValue: `${leadingPrefix}${item.commandText}`,
          cycleValue: `${leadingPrefix}${item.commandText}`,
          ghostSuffix: item.commandText.toLowerCase().startsWith(fullLower)
            ? item.commandText.slice(fullLower.length)
            : '',
          description: item.label,
          category: item.category,
          hasNextArg: false
        });
        if (phraseMatches.length >= maxSuggestions) break;
      }
    }
    return {
      prefixBeforeToken: leadingPrefix,
      activeToken: body.trim(),
      argIndex: 0,
      syntaxHint,
      suggestions: phraseMatches
    };
  }

  return {
    prefixBeforeToken,
    activeToken,
    argIndex,
    syntaxHint,
    suggestions: rankPrefixAndSubstring(pool, activeToken, maxSuggestions)
  };
}

/**
 * Parse a unified slash/natural command into its exact Control Centre action descriptor.
 */
function resolveUnifiedCommandExecution(rawText, knownSchematicIds = null) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/^(?:\/|!swarm\s+)/i, '').trim();
  const parts = clean.split(/\s+/);
  const verb = (parts[0] || '').toLowerCase();

  if (verb === 'stop' || verb === 'ceasefire' || verb === 'emergency_stop') {
    return { type: 'emergency_stop' };
  }
  if (verb === 'mode' && parts[1]) {
    return { type: 'swarm_mode', mode: parts[1].toUpperCase() };
  }
  if (verb === 'profile' && parts[1]) {
    return { type: 'swarm_profile', profile: parts[1].toUpperCase() };
  }
  if (verb === 'botcap' && parts[1]) {
    const cap = Number(parts[1]);
    if (Number.isInteger(cap) && cap >= 1 && cap <= 20) {
      return { type: 'bot_cap', enabledBotsCap: cap };
    }
  }
  if (verb === 'skin') {
    return {
      type: 'skin_sync',
      preset: 'all_crimson_knights',
      botId: parts[2] && parts[2] !== '*' ? parts[2] : null
    };
  }
  if ((verb === 'kill' || verb === 'attack') && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: 'attack_player',
        targetPlayer: parts[1],
        preferredWeaponStyle: (parts[2] || 'auto').toLowerCase(),
        botId: parts[3] || '*',
        preemptTask: true
      }
    };
  }
  if (verb === 'follow' && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: 'follow',
        targetPlayer: parts[1],
        botId: parts[2] || '*',
        preemptTask: true
      }
    };
  }
  if (verb === 'protect' && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: 'protect',
        targetPlayer: parts[1],
        botId: parts[2] || '*',
        preemptTask: true
      }
    };
  }
  if (verb === 'surround' && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: 'surround',
        targetPlayer: parts[1],
        botId: parts[2] || '*',
        preemptTask: true
      }
    };
  }
  if (verb === 'drop' && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: 'drop_loot',
        targetPlayer: parts[1],
        itemFilter: parts[2] || 'all',
        botId: parts[3] || '*',
        preemptTask: true
      }
    };
  }
  if (verb === 'goto' || verb === 'go') {
    const coordinatePattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    const coords = parts.slice(1, 4).map((value) => Number(value));
    const valid = parts.length >= 4 && parts.length <= 5 &&
      parts.slice(1, 4).every((value) => coordinatePattern.test(value)) &&
      coords.every(Number.isFinite) && Math.abs(coords[0]) <= 29_999_984 &&
      coords[1] >= -2048 && coords[1] <= 2048 && Math.abs(coords[2]) <= 29_999_984;
    if (!valid) {
      return { type: 'invalid_command', message: 'Usage: goto <x> <y> <z> [bot] (x/z ±29,999,984; y -2048..2048)' };
    }
    return {
      type: 'player_action',
      payload: {
        mode: 'goto',
        targetPosition: { x: coords[0], y: coords[1], z: coords[2] },
        botId: parts[4] || '*',
        preemptTask: true
      }
    };
  }
  const foodGatherMatch = /^hunt\s+(?:(\d+)\s+)?(?:animal\s+)?food(?:\s+(?:from animals|by hunting))?$/i.exec(clean);
  if (foodGatherMatch) {
    const targetCount = foodGatherMatch[1] ? Number(foodGatherMatch[1]) : 8;
    if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 10_000) {
      return { type: 'invalid_command', message: 'Food target count must be an integer from 1 to 10000 per bot.' };
    }
    return { type: 'player_action', payload: { mode: 'hunt_food', targetCount, botId: '*', preemptTask: true } };
  }
  if (verb === 'food') {
    const targetCount = /^\d+$/.test(parts[1] || '') ? Number(parts[1]) : 8;
    const botId = parts[1] && !/^\d+$/.test(parts[1]) ? parts[1] : parts[2] || '*';
    if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 10_000) {
      return { type: 'invalid_command', message: 'Food target count must be an integer from 1 to 10000 per bot.' };
    }
    return { type: 'player_action', payload: { mode: 'hunt_food', targetCount, botId, preemptTask: true } };
  }
  if (verb === 'tree') {
    const qty = /^\d+$/.test(parts[1] || '') ? parts[1] : '16';
    return { type: 'task_intent', text: `collect oak_log ${qty}` };
  }
  if (verb === 'hunt' || verb === 'hunt_mobs' || verb === 'mobs') {
    return {
      type: 'player_action',
      payload: {
        mode: 'hunt_mobs',
        botId: parts[1] || '*',
        preemptTask: true
      }
    };
  }
  if ((verb === 'ally' || verb === 'kos') && parts[1]) {
    return {
      type: 'player_action',
      payload: {
        mode: verb === 'kos' ? 'attack_player' : 'idle',
        targetPlayer: parts[1],
        relation: verb,
        botId: '*',
        preemptTask: verb === 'kos'
      }
    };
  }
  if ((verb === 'build' || verb === 'construct') && parts[1] && parts.length <= 3) {
    const candidateId = parts[1].toLowerCase();
    const isKnownSch =
      BUILTIN_SCHEMATICS.has(candidateId) ||
      (knownSchematicIds instanceof Set && knownSchematicIds.has(candidateId)) ||
      (Array.isArray(knownSchematicIds) && knownSchematicIds.includes(candidateId));
    if (isKnownSch) {
      return {
        type: 'build_schematic',
        schematicId: candidateId,
        botId: parts[2] && parts[2] !== '*' ? parts[2] : null
      };
    }
  }

  return {
    type: 'task_intent',
    text: clean
  };
}

/**
 * Create a Node `readline` `completer(line)` function for Termux & Linux terminals.
 */
function createReadlineCompleter(getContextFn) {
  let cycleState = null;
  return function brigadierReadlineCompleter(line) {
    const currentLine = String(line || '');
    const ctx = typeof getContextFn === 'function' ? getContextFn() : {};

    // Node readline normally prints multiple candidates instead of advancing through
    // them. Preserve the original partial line and return exactly one candidate per
    // Tab, so repeated Tab presses cycle like the Web Control Centre. Typing or
    // accepting a delimiter changes the line and naturally resets the cycle.
    if (cycleState && currentLine === cycleState.lastApplied) {
      const nextIndex = (cycleState.index + 1) % cycleState.suggestions.length;
      const selected = cycleState.suggestions[nextIndex];
      cycleState = { ...cycleState, index: nextIndex, lastApplied: selected.cycleValue };
      return [[selected.cycleValue], currentLine];
    }

    cycleState = null;
    const res = getBrigadierCompletions(currentLine, ctx, 24);
    const suggestions = res.suggestions || [];
    if (suggestions.length === 0) return [[], currentLine];

    if (suggestions.length === 1) {
      return [[suggestions[0].applyValue], currentLine];
    }

    const selected = suggestions[0];
    cycleState = {
      suggestions,
      index: 0,
      lastApplied: selected.cycleValue
    };
    return [[selected.cycleValue], currentLine];
  };
}

module.exports = {
  ROOT_COMMANDS,
  buildAutocompleteDictionary,
  getBrigadierCompletions,
  resolveUnifiedCommandExecution,
  createReadlineCompleter
};
