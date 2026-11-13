'use strict';

/**
 * NEXUS-20 Schematic & Architectural Blueprint Engine.
 *
 * Provides:
 * 1. Built-in survival, defense, logistics, farming, Nether & PvP blueprints
 * 2. Custom JSON / Layer-Palette schematic parser & validator (`parseCustomSchematic`)
 * 3. Bottom-up (`y` ascending), anti-self-trap (`distance-from-center` descending) build ordering
 * 4. Smart block-material fallback mapping when exact decorative blocks are unavailable
 */

const FALLBACK_BUILDING_MATERIALS = Object.freeze([
  'cobblestone',
  'cobbled_deepslate',
  'stone_bricks',
  'stone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'deepslate_bricks',
  'blackstone',
  'dirt',
  'netherrack'
]);

function hollowBox({ width, depth, height, wallBlock, floorBlock, roofBlock, doorFront = true, torches = true }) {
  const blocks = [];
  const xMin = -Math.floor(width / 2);
  const xMax = xMin + width - 1;
  const zMin = -Math.floor(depth / 2);
  const zMax = zMin + depth - 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      for (let z = zMin; z <= zMax; z += 1) {
        const isEdge = x === xMin || x === xMax || z === zMin || z === zMax;
        if (y === 0 && floorBlock) {
          blocks.push({ x, y, z, block: floorBlock });
        } else if (y === height - 1 && roofBlock) {
          blocks.push({ x, y, z, block: roofBlock });
        } else if (y > 0 && y < height - 1 && isEdge) {
          if (doorFront && z === zMin && x === 0 && (y === 1 || y === 2)) {
            continue; // Doorway opening
          }
          blocks.push({ x, y, z, block: wallBlock });
        }
      }
    }
  }
  if (torches) {
    blocks.push({ x: xMin + 1, y: 2, z: zMin + 1, block: 'torch', optional: true });
    blocks.push({ x: xMax - 1, y: 2, z: zMax - 1, block: 'torch', optional: true });
  }
  return blocks;
}

function buildBuiltinSchematics() {
  const map = new Map();
  const add = (id, meta, generator) => {
    const rawBlocks = generator();
    const sorted = sortBlocksForSafePlacement(rawBlocks);
    map.set(id, {
      schematicId: id,
      name: meta.name,
      category: meta.category,
      primaryMaterial: meta.primaryMaterial,
      dimensions: meta.dimensions,
      description: meta.description,
      blockCount: sorted.length,
      blocks: sorted
    });
  };

  add(
    'starter_shelter',
    {
      name: 'Starter Survival Shelter (5x5x4)',
      category: 'survival',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '5x5x4',
      description: 'Weatherproof 5x5 cobblestone & plank shelter with doorway and interior torch mounts.'
    },
    () => hollowBox({ width: 5, depth: 5, height: 4, wallBlock: 'cobblestone', floorBlock: 'oak_planks', roofBlock: 'oak_planks' })
  );

  add(
    'watchtower',
    {
      name: 'Fortified Archer Watchtower (5x5x10)',
      category: 'defense',
      primaryMaterial: 'minecraft:stone_bricks',
      dimensions: '5x5x10',
      description: 'Tall stone-brick watchtower with crenellated battlements for ranged bow/crossbow defense.'
    },
    () => {
      const blocks = hollowBox({ width: 5, depth: 5, height: 9, wallBlock: 'stone_bricks', floorBlock: 'cobblestone', roofBlock: 'stone_bricks' });
      for (let x = -2; x <= 2; x += 2) {
        blocks.push({ x, y: 9, z: -2, block: 'stone_bricks' });
        blocks.push({ x, y: 9, z: 2, block: 'stone_bricks' });
      }
      for (let z = -2; z <= 2; z += 2) {
        blocks.push({ x: -2, y: 9, z, block: 'stone_bricks' });
        blocks.push({ x: 2, y: 9, z, block: 'stone_bricks' });
      }
      return blocks;
    }
  );

  add(
    'fortress_wall',
    {
      name: 'Fortress Curtain Wall Segment (11x3x5)',
      category: 'defense',
      primaryMaterial: 'minecraft:stone_bricks',
      dimensions: '11x3x5',
      description: 'Double-thick stone-brick defensive curtain wall with parapet walkway.'
    },
    () => {
      const b = [];
      for (let x = -5; x <= 5; x += 1) {
        for (let y = 0; y < 4; y += 1) {
          b.push({ x, y, z: -1, block: 'stone_bricks' });
          b.push({ x, y, z: 1, block: 'stone_bricks' });
          if (y === 3) b.push({ x, y, z: 0, block: 'cobblestone' });
        }
        if (x % 2 === 0) b.push({ x, y: 4, z: -1, block: 'stone_bricks' });
      }
      return b;
    }
  );

  add(
    'storage_bunker',
    {
      name: 'Swarm Vault & Chest Bunker (7x7x5)',
      category: 'logistics',
      primaryMaterial: 'minecraft:cobbled_deepslate',
      dimensions: '7x7x5',
      description: 'Reinforced deepslate storage depot with organized chest bays.'
    },
    () => {
      const b = hollowBox({ width: 7, depth: 7, height: 5, wallBlock: 'cobbled_deepslate', floorBlock: 'stone_bricks', roofBlock: 'cobbled_deepslate' });
      b.push({ x: -2, y: 1, z: 2, block: 'chest', optional: true });
      b.push({ x: 0, y: 1, z: 2, block: 'chest', optional: true });
      b.push({ x: 2, y: 1, z: 2, block: 'chest', optional: true });
      b.push({ x: -2, y: 1, z: 0, block: 'crafting_table', optional: true });
      b.push({ x: 2, y: 1, z: 0, block: 'furnace', optional: true });
      return b;
    }
  );

  add(
    'obsidian_bunker',
    {
      name: 'Blast-Proof Obsidian War Bunker (5x5x5)',
      category: 'pvp',
      primaryMaterial: 'minecraft:obsidian',
      dimensions: '5x5x5',
      description: 'TNT-resistant obsidian stronghold for crystal/mace PvP defense.'
    },
    () => hollowBox({ width: 5, depth: 5, height: 5, wallBlock: 'obsidian', floorBlock: 'obsidian', roofBlock: 'obsidian' })
  );

  add(
    'crop_farm_9x9',
    {
      name: 'Irrigated 9x9 Crop Farm Terrace',
      category: 'farming',
      primaryMaterial: 'minecraft:dirt',
      dimensions: '11x11x2',
      description: 'Raised 9x9 dirt plot framed in cobblestone with a central open irrigation spot; add water manually.'
    },
    () => {
      const b = [];
      for (let x = -5; x <= 5; x += 1) {
        for (let z = -5; z <= 5; z += 1) {
          const border = Math.abs(x) === 5 || Math.abs(z) === 5;
          if (border) {
            b.push({ x, y: 0, z, block: 'cobblestone' });
          } else if (x !== 0 || z !== 0) {
            b.push({ x, y: 0, z, block: 'dirt' });
          }
        }
      }
      return b;
    }
  );

  add(
    'bridge_16',
    {
      name: 'Tactical Guarded Causeway Bridge (16x3)',
      category: 'infrastructure',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '3x16x2',
      description: '16-block span bridge with side safety railings across ravines, rivers, or lava.'
    },
    () => {
      const b = [];
      for (let z = 0; z < 16; z += 1) {
        b.push({ x: -1, y: 0, z, block: 'cobblestone' });
        b.push({ x: 0, y: 0, z, block: 'cobblestone' });
        b.push({ x: 1, y: 0, z, block: 'cobblestone' });
        b.push({ x: -1, y: 1, z, block: 'cobblestone' });
        b.push({ x: 1, y: 1, z, block: 'cobblestone' });
      }
      return b;
    }
  );

  add(
    'nether_portal_frame',
    {
      name: 'Nether Portal Obsidian Frame (4x5)',
      category: 'nether',
      primaryMaterial: 'minecraft:obsidian',
      dimensions: '4x1x5',
      description: 'Full 14-obsidian Nether portal frame ready for flint_and_steel ignition.'
    },
    () => {
      const b = [];
      for (let x = -1; x <= 2; x += 1) {
        b.push({ x, y: 0, z: 0, block: 'obsidian' });
        b.push({ x, y: 4, z: 0, block: 'obsidian' });
      }
      for (let y = 1; y <= 3; y += 1) {
        b.push({ x: -1, y, z: 0, block: 'obsidian' });
        b.push({ x: 2, y, z: 0, block: 'obsidian' });
      }
      return b;
    }
  );

  add(
    'enchanting_room',
    {
      name: 'Level-30 Arcane Enchanting Library (5x5)',
      category: 'progression',
      primaryMaterial: 'minecraft:bookshelf',
      dimensions: '5x5x3',
      description: '15-bookshelf U-ring around central enchanting pedestal for max-tier enchants.'
    },
    () => {
      const b = [];
      for (let x = -2; x <= 2; x += 1) {
        for (let z = -2; z <= 2; z += 1) {
          b.push({ x, y: 0, z, block: 'oak_planks' });
          const ring = Math.abs(x) === 2 || Math.abs(z) === 2;
          const doorway = z === -2 && Math.abs(x) <= 1;
          if (ring && !doorway) {
            b.push({ x, y: 1, z, block: 'bookshelf' });
            if ((x + z) % 2 === 0) b.push({ x, y: 2, z, block: 'bookshelf' });
          }
        }
      }
      b.push({ x: 0, y: 1, z: 0, block: 'enchanting_table', optional: true });
      return b;
    }
  );

  add(
    'smeltery_array',
    {
      name: 'Industrial 8-Furnace Smeltery Hall',
      category: 'progression',
      primaryMaterial: 'minecraft:furnace',
      dimensions: '7x5x4',
      description: 'Stone-brick foundry housing 8 furnaces in parallel for mass ore refining.'
    },
    () => {
      const b = hollowBox({ width: 7, depth: 5, height: 4, wallBlock: 'stone_bricks', floorBlock: 'cobblestone', roofBlock: 'stone_bricks' });
      for (let x = -2; x <= 1; x += 1) {
        b.push({ x, y: 1, z: 1, block: 'furnace' });
        b.push({ x, y: 2, z: 1, block: 'furnace' });
      }
      return b;
    }
  );

  add(
    'castle_keep',
    {
      name: 'Citadel Command Keep (9x9x7)',
      category: 'defense',
      primaryMaterial: 'minecraft:stone_bricks',
      dimensions: '9x9x7',
      description: 'Grand 9x9 stone-brick citadel keep with corner turrets and battlements.'
    },
    () => {
      const b = hollowBox({ width: 9, depth: 9, height: 6, wallBlock: 'stone_bricks', floorBlock: 'stone_bricks', roofBlock: 'cobblestone' });
      for (let x = -4; x <= 4; x += 2) {
        b.push({ x, y: 6, z: -4, block: 'stone_bricks' });
        b.push({ x, y: 6, z: 4, block: 'stone_bricks' });
      }
      for (let z = -4; z <= 4; z += 2) {
        b.push({ x: -4, y: 6, z, block: 'stone_bricks' });
        b.push({ x: 4, y: 6, z, block: 'stone_bricks' });
      }
      return b;
    }
  );

  add(
    'pvp_arena',
    {
      name: 'Gladiator PvP Duel Ring (11x11x3)',
      category: 'pvp',
      primaryMaterial: 'minecraft:stone_bricks',
      dimensions: '11x11x3',
      description: 'Flat 11x11 combat arena with perimeter walls & mace jump pillars.'
    },
    () => {
      const b = [];
      for (let x = -5; x <= 5; x += 1) {
        for (let z = -5; z <= 5; z += 1) {
          b.push({ x, y: 0, z, block: 'stone_bricks' });
          if (Math.abs(x) === 5 || Math.abs(z) === 5) {
            b.push({ x, y: 1, z, block: 'stone_bricks' });
            b.push({ x, y: 2, z, block: 'stone_bricks' });
          }
        }
      }
      // 4 Mace Jump Launch Pillars inside the arena!
      for (const [px, pz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
        b.push({ x: px, y: 1, z: pz, block: 'obsidian', optional: true });
        b.push({ x: px, y: 2, z: pz, block: 'obsidian', optional: true });
        b.push({ x: px, y: 3, z: pz, block: 'obsidian', optional: true });
      }
      return b;
    }
  );

  add(
    'mob_grinder_platform',
    {
      name: 'Dark-Room Mob Spawner Canopy (9x9x5)',
      category: 'farming',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '9x9x5',
      description: 'Enclosed light-sealed cobblestone mob chamber for XP & drop farming.'
    },
    () => hollowBox({ width: 9, depth: 9, height: 5, wallBlock: 'cobblestone', floorBlock: 'cobblestone', roofBlock: 'cobblestone', doorFront: false, torches: false })
  );

  add(
    'skybase_platform',
    {
      name: 'Elevated Skybase Staging Deck (9x9)',
      category: 'pvp',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '9x9x2',
      description: 'High-ground 9x9 safety deck with anti-knockback lip for Mace & Bow dominance.'
    },
    () => {
      const b = [];
      for (let x = -4; x <= 4; x += 1) {
        for (let z = -4; z <= 4; z += 1) {
          b.push({ x, y: 0, z, block: 'cobblestone' });
          if (Math.abs(x) === 4 || Math.abs(z) === 4) {
            b.push({ x, y: 1, z, block: 'cobblestone' });
          }
        }
      }
      return b;
    }
  );

  add(
    'perimeter_trench',
    {
      name: 'Base Perimeter Barricade Ring (13x13)',
      category: 'defense',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '13x13x2',
      description: '2-high anti-mob perimeter wall around a 13x13 base zone.'
    },
    () => {
      const b = [];
      for (let i = -6; i <= 6; i += 1) {
        for (let y = 0; y < 2; y += 1) {
          if (Math.abs(i) > 1) b.push({ x: i, y, z: -6, block: 'cobblestone' });
          b.push({ x: i, y, z: 6, block: 'cobblestone' });
          b.push({ x: -6, y, z: i, block: 'cobblestone' });
          b.push({ x: 6, y, z: i, block: 'cobblestone' });
        }
      }
      return b;
    }
  );

  add(
    'animal_pen',
    {
      name: 'Passive Animal Pen (7x7)',
      category: 'farming',
      primaryMaterial: 'minecraft:oak_fence',
      dimensions: '7x7x2',
      description: 'A fenced, open-top pen for keeping livestock near the base; the south side stays open as an entry.'
    },
    () => {
      const blocks = [];
      for (let x = -3; x <= 3; x += 1) {
        for (let z = -3; z <= 3; z += 1) {
          if (Math.abs(x) === 3 || Math.abs(z) === 3) {
            if (z === 3 && x === 0) continue;
            blocks.push({ x, y: 0, z, block: 'oak_fence' });
            blocks.push({ x, y: 1, z, block: 'oak_fence' });
          }
        }
      }
      blocks.push({ x: 0, y: 0, z: 3, block: 'oak_fence_gate', optional: true });
      return blocks;
    }
  );

  add(
    'torch_waystation',
    {
      name: 'Lit Mining Waystation (7x7)',
      category: 'survival',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '7x7x2',
      description: 'Compact cobblestone rest pad with supported torch posts to mark a safe return point.'
    },
    () => {
      const blocks = [];
      for (let x = -3; x <= 3; x += 1) {
        for (let z = -3; z <= 3; z += 1) blocks.push({ x, y: 0, z, block: 'cobblestone' });
      }
      for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
        blocks.push({ x, y: 1, z, block: 'cobblestone' });
        blocks.push({ x, y: 2, z, block: 'torch', optional: true });
      }
      return blocks;
    }
  );

  add(
    'staircase_mine',
    {
      name: 'Reinforced Minehead Entrance & Steps',
      category: 'infrastructure',
      primaryMaterial: 'minecraft:cobblestone',
      dimensions: '5x7x4',
      description: 'Protected mine entrance arch and descending stair collar.'
    },
    () => hollowBox({ width: 5, depth: 7, height: 4, wallBlock: 'cobblestone', floorBlock: 'cobblestone', roofBlock: 'cobblestone' })
  );

  return map;
}

function sortBlocksForSafePlacement(blocks) {
  return [...blocks].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    const distA = Math.abs(a.x) + Math.abs(a.z);
    const distB = Math.abs(b.x) + Math.abs(b.z);
    return distB - distA; // Outer walls first, center last so bot can step out cleanly
  });
}

const BUILTIN_SCHEMATICS = buildBuiltinSchematics();

class SchematicRegistry {
  constructor() {
    this._custom = new Map();
  }

  listSchematics() {
    const list = [];
    for (const s of BUILTIN_SCHEMATICS.values()) {
      list.push({
        schematicId: s.schematicId,
        name: s.name,
        category: s.category,
        primaryMaterial: s.primaryMaterial,
        dimensions: s.dimensions,
        description: s.description,
        blockCount: s.blockCount,
        builtin: true
      });
    }
    for (const s of this._custom.values()) {
      list.push({
        schematicId: s.schematicId,
        name: s.name,
        category: s.category,
        primaryMaterial: s.primaryMaterial,
        dimensions: s.dimensions,
        description: s.description,
        blockCount: s.blockCount,
        builtin: false
      });
    }
    return list;
  }

  getSchematic(schematicId) {
    const clean = String(schematicId || '')
      .trim()
      .toLowerCase()
      .replace(/^minecraft:/, '')
      .replace(/^schematic[_:/-]/, '');
    return this._custom.get(clean) || BUILTIN_SCHEMATICS.get(clean) || null;
  }

  /**
   * Register a user-provided custom JSON or ASCII-layer schematic at runtime.
   * Supports:
   * - `{ schematicId?, name, blocks: [{ x, y, z, block }] }`
   * - `{ schematicId?, name, palette: { "#": "stone_bricks" }, layers: [ ["###", "#.#", "###"] ] }`
   */
  registerCustomSchematic(spec = {}) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('Schematic payload must be a JSON object');
    }
    const rawName = String(spec.name || spec.schematicId || 'custom_structure').trim().slice(0, 64);
    const id = String(spec.schematicId || rawName)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'custom_structure';

    const parsedBlocks = [];
    if (Array.isArray(spec.blocks)) {
      for (const b of spec.blocks.slice(0, 4096)) {
        if (!b || typeof b !== 'object') continue;
        const x = Math.trunc(Number(b.x) || 0);
        const y = Math.trunc(Number(b.y) || 0);
        const z = Math.trunc(Number(b.z) || 0);
        const block = String(b.block || b.id || 'cobblestone').replace(/^minecraft:/, '').trim();
        if (!block || block === 'air') continue;
        parsedBlocks.push({ x, y, z, block });
      }
    } else if (Array.isArray(spec.layers) && spec.palette && typeof spec.palette === 'object') {
      spec.layers.slice(0, 32).forEach((layerRows, y) => {
        if (!Array.isArray(layerRows)) return;
        layerRows.slice(0, 32).forEach((rowStr, z) => {
          const chars = String(rowStr || '').split('');
          chars.slice(0, 32).forEach((ch, x) => {
            if (ch === ' ' || ch === '.') return;
            const mapped = spec.palette[ch];
            if (mapped && mapped !== 'air') {
              parsedBlocks.push({
                x: x - Math.floor(chars.length / 2),
                y,
                z: z - Math.floor(layerRows.length / 2),
                block: String(mapped).replace(/^minecraft:/, '')
              });
            }
          });
        });
      });
    }

    if (parsedBlocks.length === 0) {
      throw new Error('Custom schematic must contain at least 1 non-air block');
    }

    const sorted = sortBlocksForSafePlacement(parsedBlocks);
    const xs = sorted.map((b) => b.x);
    const ys = sorted.map((b) => b.y);
    const zs = sorted.map((b) => b.z);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const d = Math.max(...zs) - Math.min(...zs) + 1;

    const entry = {
      schematicId: id,
      name: rawName,
      category: 'custom',
      primaryMaterial: `minecraft:${sorted[0].block}`,
      dimensions: `${w}x${d}x${h}`,
      description: String(spec.description || `Custom operator schematic (${sorted.length} blocks)`).slice(0, 180),
      blockCount: sorted.length,
      blocks: sorted
    };
    this._custom.set(id, entry);
    return entry;
  }
}

module.exports = {
  SchematicRegistry,
  BUILTIN_SCHEMATICS,
  FALLBACK_BUILDING_MATERIALS,
  sortBlocksForSafePlacement
};
