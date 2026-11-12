'use strict';

const zlib = require('node:zlib');

/**
 * Zero-dependency 64x64 RGBA Minecraft Skin Generator (`PNG` encoder + UI preview matrices).
 *
 * Exclusively equips the entire NEXUS-20 swarm with the signature
 * Black & Crimson Armored Shadow Knight skin (`knight_crimson`, matching `image-2.png`):
 * - Obsidian-black plate helmet with crimson crest, T-visor slit, glowing red eyes & winged ear-horns
 * - Ribbed 3-band crimson & black pauldrons + crimson armored gauntlets
 * - Dark steel breastplate with glowing 2x2 crimson core, pectoral studs & bronze-crimson war belt
 * - Crimson inner tasset stripes, knee chevrons & crimson sabaton greaves
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // Filter type 0 (None)
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

function hexToRgba(hex, alpha = 255) {
  const clean = String(hex).replace(/^#/, '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255, alpha];
}

const ACCENT_PALETTES = Object.freeze({
  crimson: {
    label: 'Crimson Red',
    bright: '#ff2424',
    main: '#e1121a',
    mid: '#b00c14',
    dark: '#6e080e',
    ember: '#ff5226',
    belt: '#4a1d12'
  }
});

const SKIN_CATALOG = Object.freeze([
  {
    skinId: 'knight_crimson',
    name: 'Crimson Shadow Knight',
    archetype: 'knight',
    palette: 'crimson',
    roleHint: 'knight',
    badge: 'SWARM UNIFORM',
    description: 'Obsidian-black & crimson armored knight with T-visor, glowing red eyes, winged helm horns, ribbed pauldrons, crimson chest core & sabaton boots.'
  }
]);

function createCanvas64() {
  const rgba = Buffer.alloc(64 * 64 * 4, 0);
  const setPx = (x, y, colorHex, alpha = 255) => {
    if (x < 0 || x >= 64 || y < 0 || y >= 64) return;
    const [r, g, b, a] = Array.isArray(colorHex) ? colorHex : hexToRgba(colorHex, alpha);
    const idx = (y * 64 + x) * 4;
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = a;
  };
  const fillRect = (x0, y0, w, h, fnOrColor) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const c = typeof fnOrColor === 'function' ? fnOrColor(dx, dy) : fnOrColor;
        if (c) setPx(x0 + dx, y0 + dy, c);
      }
    }
  };
  const getMatrix = (x0, y0, w, h, overlayX0 = null, overlayY0 = null) => {
    const rows = [];
    for (let dy = 0; dy < h; dy += 1) {
      const row = [];
      for (let dx = 0; dx < w; dx += 1) {
        let idx = ((y0 + dy) * 64 + (x0 + dx)) * 4;
        if (overlayX0 !== null && overlayY0 !== null) {
          const oIdx = ((overlayY0 + dy) * 64 + (overlayX0 + dx)) * 4;
          if (rgba[oIdx + 3] > 128) idx = oIdx;
        }
        const r = rgba[idx].toString(16).padStart(2, '0');
        const g = rgba[idx + 1].toString(16).padStart(2, '0');
        const b = rgba[idx + 2].toString(16).padStart(2, '0');
        row.push(`#${r}${g}${b}`);
      }
      rows.push(row);
    }
    return rows;
  };
  return { rgba, setPx, fillRect, getMatrix };
}

function darkWeave(dx, dy, baseShades = ['#131519', '#1b1e24', '#242830', '#0c0e12']) {
  const idx = ((dx * 3 + dy * 5 + (dx ^ dy)) & 3);
  return baseShades[idx];
}

/**
 * Paint the Black & Crimson Armored Knight (`image-2.png` exact pixel styling).
 */
function paintKnightSkin(pal) {
  const c = createCanvas64();
  const steel = (dx, dy) => darkWeave(dx, dy, ['#131519', '#1b1e24', '#242830', '#0c0e12']);
  const pitch = '#060709';

  // --- HEAD BASE (8x8x8) ---
  c.fillRect(8, 0, 8, 8, (dx, dy) => (dx === 3 || dx === 4 ? pal.main : steel(dx, dy))); // Top crest
  c.fillRect(16, 0, 8, 8, pitch); // Chin underside
  c.fillRect(0, 8, 8, 8, steel); // Right side
  c.fillRect(16, 8, 8, 8, steel); // Left side
  c.fillRect(24, 8, 8, 8, (dx, dy) => (dx === 3 || dx === 4 ? pal.mid : steel(dx, dy))); // Back spine

  // Head Front (8, 8, 8, 8): Armored Knight Helmet + T-Visor + Glowing Eyes (`image-2.png`)
  c.fillRect(8, 8, 8, 8, steel);
  // Forehead center crest (x=3..4, y=0..2)
  c.fillRect(8 + 3, 8 + 0, 2, 3, (dx, dy) => (dy === 0 ? pal.bright : pal.main));
  // Horizontal crimson brow bar (x=1..6, y=3)
  c.fillRect(8 + 1, 8 + 3, 6, 1, (dx) => (dx === 2 || dx === 3 ? pal.bright : pal.main));
  // Black T-visor slit (eye slit y=4, nasal vertical slot x=3..4 y=4..7)
  c.fillRect(8 + 1, 8 + 4, 6, 1, pitch);
  c.fillRect(8 + 3, 8 + 4, 2, 4, pitch);
  // Glowing visor eyes (x=1..2 & x=5..6 at y=5) + crimson cheek vents (x=2 & x=5 at y=6..7)
  c.setPx(8 + 1, 8 + 5, pal.bright);
  c.setPx(8 + 2, 8 + 5, pal.main);
  c.setPx(8 + 5, 8 + 5, pal.main);
  c.setPx(8 + 6, 8 + 5, pal.bright);
  c.fillRect(8 + 2, 8 + 6, 1, 2, pal.mid);
  c.fillRect(8 + 5, 8 + 6, 1, 2, pal.mid);

  // --- HAT LAYER: Winged Side Horns & Raised Crest ---
  c.fillRect(40, 0, 8, 8, (dx, dy) => ((dx === 3 || dx === 4) && dy >= 1 && dy <= 6 ? pal.main : null));
  c.fillRect(40 + 3, 8 + 0, 2, 3, pal.main);
  c.fillRect(40 + 1, 8 + 3, 6, 1, pal.main);
  // Winged crimson ear-fins on Right (32,8) & Left (48,8) hat faces (`image-2.png`)
  for (const hx of [32, 48]) {
    c.setPx(hx + 2, 8 + 1, pal.bright);
    c.fillRect(hx + 2, 8 + 2, 3, 2, pal.main);
    c.fillRect(hx + 3, 8 + 4, 3, 2, pal.mid);
    c.setPx(hx + 4, 8 + 0, pal.bright);
  }

  // --- TORSO & BREASTPLATE (8x12x4) ---
  c.fillRect(20, 16, 8, 4, steel);
  c.fillRect(28, 16, 8, 4, pitch);
  c.fillRect(16, 20, 4, 12, steel);
  c.fillRect(28, 20, 4, 12, steel);
  c.fillRect(32, 20, 8, 12, (dx, dy) => {
    if ((dx === 3 || dx === 4) && dy >= 1 && dy <= 8) return dy % 2 === 0 ? pal.main : pal.dark;
    if (dy >= 10) return pal.mid;
    return steel(dx, dy);
  });

  // Front Breastplate (20, 20, 8, 12) (`image-2.png`)
  c.fillRect(20, 20, 8, 12, (dx, dy) => {
    if ((dx === 0 || dx === 7) && dy <= 2) return pal.mid; // Crimson shoulder harness straps
    if (dy >= 6 && dy <= 9 && dx >= 2 && dx <= 5) return '#272c35'; // Sculpted chest plate
    return steel(dx, dy);
  });
  // Glowing 2x2 Chest Core Gem (x=3..4, y=2..3)
  c.setPx(20 + 3, 20 + 2, pal.bright);
  c.setPx(20 + 4, 20 + 2, pal.main);
  c.setPx(20 + 3, 20 + 3, pal.main);
  c.setPx(20 + 4, 20 + 3, pal.mid);
  // Symmetrical crimson chest studs (y=5 & side studs y=6)
  c.setPx(20 + 2, 20 + 5, pal.bright);
  c.setPx(20 + 5, 20 + 5, pal.bright);
  c.setPx(20 + 0, 20 + 6, pal.main);
  c.setPx(20 + 7, 20 + 6, pal.main);
  // Armored crimson-and-bronze war belt (y=10..11)
  c.fillRect(20, 20 + 10, 8, 1, (dx) => (dx === 3 || dx === 4 ? pal.bright : pal.belt));
  c.fillRect(20, 20 + 11, 8, 1, (dx) => (dx % 2 === 1 ? pal.main : pal.dark));

  // Jacket overlay highlights for 3D depth
  c.fillRect(20 + 3, 36 + 2, 2, 2, pal.main);
  c.fillRect(20, 36 + 10, 8, 2, (dx, dy) => (dy === 0 && (dx === 3 || dx === 4) ? pal.bright : null));

  // --- ARMS: Ribbed Crimson/Black Pauldrons + Crimson Gauntlets (`image-2.png`) ---
  const paintArm = (baseX, baseY, sleeveX, sleeveY) => {
    c.fillRect(baseX + 4, baseY - 4, 4, 4, steel); // Dark steel shoulder cap
    c.fillRect(baseX + 8, baseY - 4, 4, 4, pal.dark); // Fist bottom
    c.fillRect(baseX, baseY, 16, 12, (dx, dy) => {
      if (dy === 0) return steel(dx, dy);
      if (dy === 1 || dy === 3 || dy === 5) return dx % 4 === 1 || dx % 4 === 2 ? pal.bright : pal.main;
      if (dy === 2 || dy === 4 || dy === 6) return pitch;
      if (dy === 7) return steel(dx, dy);
      if (dy === 8) return pal.mid;
      if (dy >= 9 && dy <= 10) return dx % 4 === 0 ? pal.dark : pal.bright;
      return pitch;
    });
    // Raised pauldron ribs & gauntlet cuff on 3D sleeve layer
    c.fillRect(sleeveX, sleeveY + 1, 16, 5, (dx, dy) => (dy % 2 === 0 ? pal.main : null));
    c.fillRect(sleeveX, sleeveY + 8, 16, 3, (dx, dy) => (dy === 0 ? pal.bright : null));
  };
  paintArm(40, 20, 40, 36); // Right Arm
  paintArm(32, 52, 48, 52); // Left Arm

  // --- LEGS: Tasset Stripes + Knee Guards + Sabaton Boots (`image-2.png`) ---
  const paintLeg = (baseX, baseY, isLeft) => {
    c.fillRect(baseX + 4, baseY - 4, 4, 4, pitch);
    c.fillRect(baseX + 8, baseY - 4, 4, 4, pal.dark);
    c.fillRect(baseX, baseY, 16, 12, (dx, dy) => {
      const localX = dx % 4;
      const isFront = dx >= 4 && dx < 8;
      const innerEdge = isLeft ? localX === 0 : localX === 3;
      if (isFront && innerEdge && dy <= 5) return pal.main; // Vertical crimson tasset
      if (dy === 5 || dy === 7) return isFront && (localX === 1 || localX === 2) ? pal.bright : pal.mid;
      if (dy === 9) return pal.main; // Boot upper band
      if (dy === 10) return pitch;
      if (dy === 11) return isFront && (localX === 1 || localX === 2) ? pal.bright : steel(dx, dy);
      return steel(dx, dy);
    });
  };
  paintLeg(0, 20, false); // Right Leg
  paintLeg(16, 52, true); // Left Leg

  return c;
}

class SkinManager {
  constructor() {
    this._pngCache = new Map();
    this._previewCache = new Map();
    this._botAssignments = new Map();
    this._mode = 'all_crimson_knights';
  }

  listSkins() {
    return SKIN_CATALOG.map((item) => ({
      ...item,
      paletteColors: ACCENT_PALETTES[item.palette],
      pngUrl: `/skins/${item.skinId}.png`,
      preview: this.getPreviewData(item.skinId)
    }));
  }

  isValidSkinId(skinId) {
    return SKIN_CATALOG.some((s) => s.skinId === skinId);
  }

  getSkinMeta(skinId) {
    return SKIN_CATALOG.find((s) => s.skinId === skinId) || SKIN_CATALOG[0];
  }

  _buildCanvas(skinId) {
    const meta = this.getSkinMeta(skinId);
    const pal = ACCENT_PALETTES[meta.palette] || ACCENT_PALETTES.crimson;
    return paintKnightSkin(pal);
  }

  getPngBuffer(skinId = 'knight_crimson') {
    const meta = this.getSkinMeta(skinId);
    if (!this._pngCache.has(meta.skinId)) {
      const c = this._buildCanvas(meta.skinId);
      this._pngCache.set(meta.skinId, encodeRgbaPng(64, 64, c.rgba));
    }
    return this._pngCache.get(meta.skinId);
  }

  /**
   * Extract composite front-view pixel matrices (head 8x8, body 8x12, arms 4x12, legs 4x12)
   * so the Control Centre renders crisp full-body pixel previews on `<canvas>` with zero inline styles.
   */
  getPreviewData(skinId = 'knight_crimson') {
    const meta = this.getSkinMeta(skinId);
    if (!this._previewCache.has(meta.skinId)) {
      const c = this._buildCanvas(meta.skinId);
      this._previewCache.set(meta.skinId, {
        head: c.getMatrix(8, 8, 8, 8, 40, 8),
        body: c.getMatrix(20, 20, 8, 12, 20, 36),
        rightArm: c.getMatrix(44, 20, 4, 12, 44, 36),
        leftArm: c.getMatrix(36, 52, 4, 12, 52, 52),
        rightLeg: c.getMatrix(4, 20, 4, 12, 4, 36),
        leftLeg: c.getMatrix(20, 52, 4, 12, 4, 52)
      });
    }
    return this._previewCache.get(meta.skinId);
  }

  /**
   * Every bot in the swarm (`Nexus_01`..`Nexus_20`) wears the Crimson Shadow Knight skin (`knight_crimson`).
   */
  resolveBotSkin(_botId) {
    const meta = SKIN_CATALOG[0];
    return {
      ...meta,
      pngUrl: `/skins/${meta.skinId}.png`,
      isLeader: false
    };
  }

  assignBotSkin(botId, skinId = 'knight_crimson') {
    if (!this.isValidSkinId(skinId)) {
      throw new Error(`Unknown skinId: ${skinId}`);
    }
    this._botAssignments.set(String(botId), 'knight_crimson');
    return this.resolveBotSkin(botId);
  }

  applySwarmPreset(_presetName, botIds = []) {
    this._mode = 'all_crimson_knights';
    this._botAssignments.clear();
    for (const id of botIds) {
      this._botAssignments.set(String(id), 'knight_crimson');
    }
    return { mode: this._mode, overrides: Object.fromEntries(this._botAssignments) };
  }
}

module.exports = {
  SkinManager,
  SKIN_CATALOG,
  ACCENT_PALETTES,
  encodeRgbaPng
};
