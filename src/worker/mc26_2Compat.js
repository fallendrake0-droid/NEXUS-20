'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

/**
 * NEXUS-20 Minecraft 26.2 (`protocol 776`) & 1.21.2+ Connection Stabilizer (`src/worker/mc26_2Compat.js`).
 *
 * Solves two critical upstream Mineflayer / PrismarineJS gaps on Minecraft 26.2 servers:
 *
 * 1. Full Native `26.2` (`protocol 776`) Protocol & Registry Hydration:
 *    - `minecraft-data@3.119.0`, `minecraft-protocol@1.68.0`, and `mineflayer@4.39.0` ship up to `26.1`
 *      (`protocol 775`), omitting `data.pc['26.2']` (`protocol 776`).
 *    - Loads `src/worker/data/pc_26_2.br` (official PrismarineJS 26.2 protocol, blocks, items, entities,
 *      attributes, recipes, loginPacket, windows) into every resolved `minecraft-data` instance BEFORE
 *      `mineflayer` initializes `latestSupportedVersion` / `latestSupportedProtocolVersion`.
 *
 * 2. Eliminates the Join-Leave-Join-Leave Loop (`tick_end` + 26.2 Packet Mappers):
 *    - Minecraft 1.21.2+ / 26.1 / 26.2 servers (`ServerGamePacketListenerImpl`) set
 *      `receivedPositionThisTick = true` on each `position` / `position_look` packet and ONLY clear it
 *      when the client sends `tick_end` (`handleClientTickEnd`).
 *    - Published `mineflayer@4.39.0` never sends `tick_end`, so ~1 second after joining, the second
 *      position packet triggers `multiplayer.disconnect.invalid_player_movement` -> infinite join/leave loop!
 *    - `installBotProtocolStabilizer(bot)` injects `tick_end` between consecutive position-bearing packets
 *      (PrismarineJS/mineflayer#4201) AND at the end of every client physics tick (#4137), while also
 *      normalizing `26.2` `attack`, `use_entity`, `arm_animation`, `block_place`, `use_item`,
 *      `client_command`, `entity_action`, `settings`, and `chunk_batch_received` packets.
 */

const BUNDLE_PATH = path.join(__dirname, 'data', 'pc_26_2.br');
const POSITION_BEARING_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);

let cachedBundle = null;
let compatBootstrapped = false;

function load26_2Bundle() {
  if (!cachedBundle) {
    const compressed = fs.readFileSync(BUNDLE_PATH);
    const jsonBuf = zlib.brotliDecompressSync(compressed);
    cachedBundle = JSON.parse(jsonBuf.toString('utf8'));
  }
  return cachedBundle;
}

function collectModuleRequires() {
  const reqs = [require];
  const roots = [process.cwd()];
  const seenDirs = new Set();

  for (const rootDir of roots) {
    try {
      const r = createRequire(path.join(rootDir, 'package.json'));
      reqs.push(r);
      for (const pkg of [
        'mineflayer',
        'minecraft-protocol',
        'prismarine-registry',
        'prismarine-chunk',
        'prismarine-item',
        'prismarine-entity',
        'prismarine-block',
        'prismarine-windows',
        'mineflayer-pathfinder'
      ]) {
        try {
          const pkgJson = r.resolve(`${pkg}/package.json`);
          const dir = path.dirname(pkgJson);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            reqs.push(createRequire(pkgJson));
          }
        } catch {
          // optional / not installed here
        }
      }
    } catch {
      // ignore
    }
  }
  return reqs;
}

function patchSingleMinecraftData(reqFn, bundle) {
  let mcDataPkgPath;
  try {
    mcDataPkgPath = reqFn.resolve('minecraft-data/package.json');
  } catch {
    return false;
  }
  const mcReq = createRequire(mcDataPkgPath);
  const mcData = mcReq('./index.js');
  const rawData = mcReq('./data.js');

  if (!rawData || !rawData.pc) return false;
  const fallbackBase =
    rawData.pc['26.1'] ||
    rawData.pc['1.21.11'] ||
    rawData.pc['1.21.9'] ||
    rawData.pc['1.21.8'] ||
    rawData.pc['1.21.4'] ||
    {};

  const f = bundle.files;
  rawData.pc['26.2'] = {
    attributes: f['attributes.json'],
    blockCollisionShapes: f['blockCollisionShapes.json'],
    blocks: f['blocks.json'],
    blockLoot: f['blockLoot.json'],
    biomes: f['biomes.json'],
    commands: f['commands.json'],
    effects: fallbackBase.effects,
    enchantments: fallbackBase.enchantments,
    entities: f['entities.json'],
    entityLoot: f['entityLoot.json'],
    foods: f['foods.json'],
    instruments: fallbackBase.instruments,
    items: f['items.json'],
    language: f['language.json'],
    loginPacket: f['loginPacket.json'],
    mapIcons: fallbackBase.mapIcons,
    materials: f['materials.json'],
    particles: f['particles.json'],
    protocol: f['protocol.json'],
    recipes: f['recipes.json'],
    sounds: f['sounds.json'],
    tints: f['tints.json'],
    version: f['version.json'],
    windows: bundle.windows1203 || fallbackBase.windows,
    proto: fallbackBase.proto
  };

  // Ensure version lookup indexes contain `26.2` (protocol 776)
  const vEntry = bundle.versionEntry;
  if (Array.isArray(mcData.supportedVersions?.pc) && !mcData.supportedVersions.pc.includes('26.2')) {
    mcData.supportedVersions.pc.push('26.2');
  }
  if (Array.isArray(mcData.versions?.pc) && !mcData.versions.pc.some((v) => v.minecraftVersion === '26.2')) {
    mcData.versions.pc.unshift(vEntry);
  }
  if (mcData.versionsByMinecraftVersion?.pc && !mcData.versionsByMinecraftVersion.pc['26.2']) {
    mcData.versionsByMinecraftVersion.pc['26.2'] = vEntry;
  }
  if (mcData.postNettyVersionsByProtocolVersion?.pc) {
    const list776 = mcData.postNettyVersionsByProtocolVersion.pc[776] || [];
    if (!list776.some((v) => v.minecraftVersion === '26.2')) {
      mcData.postNettyVersionsByProtocolVersion.pc[776] = [vEntry, ...list776];
    }
  }

  return Boolean(mcData('26.2'));
}

function patchMinecraftProtocol(reqFn) {
  let nmpPkgPath;
  try {
    nmpPkgPath = reqFn.resolve('minecraft-protocol/package.json');
  } catch {
    return false;
  }
  const nmpReq = createRequire(nmpPkgPath);
  try {
    const verMod = nmpReq('./src/version.js');
    if (Array.isArray(verMod.supportedVersions) && !verMod.supportedVersions.includes('26.2')) {
      verMod.supportedVersions.push('26.2');
    }
    verMod.defaultVersion = '26.2';
  } catch {
    // ignore
  }

  // Patch circular-buffer `computeChatChecksum` bug in `minecraft-protocol <= 1.68.0` (PR #1550)
  try {
    const checksums = nmpReq('./src/datatypes/checksums.js');
    if (checksums && !checksums._nexus262Patched) {
      checksums.computeChatChecksum = function computeChatChecksumSafe(lastSeenMessages) {
        if (!lastSeenMessages || lastSeenMessages.length === 0) return 1;
        const ordered = [];
        if (
          typeof lastSeenMessages.offset === 'number' &&
          typeof lastSeenMessages.capacity === 'number' &&
          lastSeenMessages.capacity > 0
        ) {
          for (let i = 0; i < lastSeenMessages.capacity; i += 1) {
            const msg = lastSeenMessages[(lastSeenMessages.offset + i) % lastSeenMessages.capacity];
            if (msg && msg.signature) ordered.push(msg);
          }
        } else {
          for (const msg of lastSeenMessages) {
            if (msg && msg.signature) ordered.push(msg);
          }
        }
        if (ordered.length === 0) return 1;
        let checksum = 1;
        for (const msg of ordered) {
          let sigHash = 1;
          for (let i = 0; i < msg.signature.length; i += 1) {
            sigHash = (31 * sigHash + msg.signature[i]) & 0xffffffff;
          }
          checksum = (31 * checksum + sigHash) & 0xffffffff;
        }
        const result = checksum & 0xff;
        return result === 0 ? 1 : result;
      };
      checksums._nexus262Patched = true;
    }
  } catch {
    // ignore
  }

  // Patch `Client.prototype.write` for 26.2 `settings.particleStatus` & server `login.success.sessionId` (PR #1550)
  try {
    const Client = nmpReq('./src/client.js');
    if (Client?.prototype?.write && !Client.prototype.write._nexus262Patched) {
      const origClientWrite = Client.prototype.write;
      const patchedClientWrite = function nexusPatchedClientWrite(name, params) {
        if (name === 'settings' && params && typeof params === 'object' && params.particleStatus === undefined) {
          params = { ...params, particleStatus: 'all' };
        } else if (
          this.isServer &&
          this.state === 'login' &&
          name === 'success' &&
          params &&
          typeof params === 'object' &&
          params.sessionId === undefined
        ) {
          params = { ...params, sessionId: crypto.randomUUID() };
        }
        return origClientWrite.call(this, name, params);
      };
      patchedClientWrite._nexus262Patched = true;
      Client.prototype.write = patchedClientWrite;
    }
  } catch {
    // ignore
  }

  // Patch inline `registryEntryHolder` 0-varint bug in `minecraft-protocol <= 1.68.0` (PR #1550)
  try {
    const compPath = nmpReq.resolve('./src/datatypes/compiler-minecraft.js');
    const src = fs.readFileSync(compPath, 'utf8');
    if (src.includes('offset += 1\n  offset = ${compiler.callType(`${otherwiseName}`')) {
      const fixed = src.replace(
        'offset += 1\n  offset = ${compiler.callType(`${otherwiseName}`',
        "offset = ${compiler.callType(0, 'varint')}\n  offset = ${compiler.callType(`${otherwiseName}`"
      );
      try {
        fs.writeFileSync(compPath, fixed, 'utf8');
        delete require.cache[compPath];
      } catch {
        // read-only fs fallback: safe to continue
      }
    }
  } catch {
    // ignore
  }
  return true;
}

function patchMineflayerVersions(reqFn) {
  let mfPkgPath;
  try {
    mfPkgPath = reqFn.resolve('mineflayer/package.json');
  } catch {
    return false;
  }
  const mfReq = createRequire(mfPkgPath);
  try {
    const mfVer = mfReq('./lib/version.js');
    if (Array.isArray(mfVer.testedVersions)) {
      if (!mfVer.testedVersions.includes('26.1')) {
        mfVer.testedVersions.push('26.1');
      }
      if (!mfVer.testedVersions.includes('26.2')) {
        mfVer.testedVersions.push('26.2');
      }
      mfVer.latestSupportedVersion = '26.2';
    }
  } catch {
    // ignore
  }
  return true;
}

function patchPrismarineSubpackages(reqFn) {
  // 1. `prismarine-chunk`: map `pc` majorVersion `'26.2'` -> `./pc/1.18/chunk` (in-memory wrapper, 0 disk writes required)
  try {
    const chunkPkg = reqFn.resolve('prismarine-chunk/package.json');
    const chunkReq = createRequire(chunkPkg);
    const chunkIdxPath = chunkReq.resolve('./src/index.js');
    const origLoader = chunkReq('./src/index.js');
    if (origLoader && !origLoader._nexus262Patched) {
      const pc118Chunk = chunkReq('./src/pc/1.18/chunk');
      const wrappedLoader = function nexusChunkLoader(registryOrVersion) {
        const registry =
          typeof registryOrVersion === 'string'
            ? chunkReq('prismarine-registry')(registryOrVersion)
            : registryOrVersion;
        if (
          registry?.version?.type === 'pc' &&
          String(registry.version.majorVersion).startsWith('26.') &&
          registry.version.majorVersion !== '26.1'
        ) {
          return pc118Chunk(registry);
        }
        return origLoader(registryOrVersion);
      };
      Object.assign(wrappedLoader, origLoader, { _nexus262Patched: true });
      if (require.cache[chunkIdxPath]) {
        require.cache[chunkIdxPath].exports = wrappedLoader;
      }
    }
  } catch {
    // ignore
  }

  // 2. `prismarine-physics`: add `'26.2'` to every physics feature enabled in `'26.1'`
  try {
    const physPkg = reqFn.resolve('prismarine-physics/package.json');
    const physReq = createRequire(physPkg);
    const features = physReq('./lib/features.json');
    if (Array.isArray(features)) {
      for (const feat of features) {
        if (Array.isArray(feat.versions) && feat.versions.includes('26.1') && !feat.versions.includes('26.2')) {
          feat.versions.push('26.2');
        }
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Must be called BEFORE `require('mineflayer')` so `mineflayer/lib/loader.js`
 * computes `latestSupportedProtocolVersion = 776` (`26.2`).
 */
function ensureMinecraft26_2Bootstrap() {
  if (compatBootstrapped) return true;
  const bundle = load26_2Bundle();
  const reqs = collectModuleRequires();
  const patchedMcDataPaths = new Set();

  for (const r of reqs) {
    try {
      const p = r.resolve('minecraft-data/package.json');
      if (!patchedMcDataPaths.has(p)) {
        patchedMcDataPaths.add(p);
        patchSingleMinecraftData(r, bundle);
      }
    } catch {
      // ignore
    }
    patchMinecraftProtocol(r);
    patchPrismarineSubpackages(r);
    patchMineflayerVersions(r);
  }

  compatBootstrapped = patchedMcDataPaths.size > 0;
  return compatBootstrapped;
}

function getFieldSchema(protoTypes, packetTypeName, fieldName) {
  const def = protoTypes?.[packetTypeName];
  if (!Array.isArray(def) || def[0] !== 'container' || !Array.isArray(def[1])) return null;
  const entry = def[1].find((f) => f && f.name === fieldName);
  return entry ? entry.type : null;
}

function isMapperType(fieldType) {
  return Array.isArray(fieldType) && fieldType[0] === 'mapper' && fieldType[1]?.mappings;
}

function normalizeHandValue(val, expectsMapper) {
  if (expectsMapper) {
    if (val === 0 || val === '0' || val === 'right' || val === 'main_hand' || val === undefined) {
      return 'main_hand';
    }
    if (val === 1 || val === '1' || val === 'left' || val === 'off_hand') {
      return 'off_hand';
    }
    return val;
  }
  if (val === 'main_hand' || val === 'right' || val === undefined) return 0;
  if (val === 'off_hand' || val === 'left') return 1;
  return Number(val) || 0;
}

/**
 * Attach runtime `tick_end` + `26.2` packet normalizer onto a live Mineflayer `bot` instance.
 */
function installBotProtocolStabilizer(bot) {
  if (!bot || !bot._client || bot._nexus262Stabilized) return;
  bot._nexus262Stabilized = true;

  const client = bot._client;
  const rawWrite = client.write.bind(client);

  let positionSentSinceTickEnd = false;
  let tickEndSentThisPhysicsStep = false;
  let sequenceCounter = 0;
  let playProtoTypes = null;
  let needsTickEnd = false;
  let fallbackTickTimer = null;

  if (typeof bot._nextSequence !== 'function') {
    bot._nextSequence = () => {
      sequenceCounter += 1;
      return sequenceCounter;
    };
  }

  const refreshVersionCapabilities = () => {
    try {
      const ver = bot.version || client.version || '26.2';
      let mcData = null;
      try {
        // eslint-disable-next-line global-require, import/no-unresolved
        mcData = require('minecraft-data')(ver);
      } catch {
        mcData = bot.registry || null;
      }
      playProtoTypes =
        (client.state === 'play' ? client.serializer?.proto?.types : null) ||
        mcData?.protocol?.play?.toServer?.types ||
        (ver === '26.2' ? load26_2Bundle()?.files?.['protocol.json']?.play?.toServer?.types : null) ||
        null;
      needsTickEnd = Boolean(
        (typeof bot.supportFeature === 'function' && bot.supportFeature('sendsClientTickEndPacket')) ||
          (typeof mcData?.supportFeature === 'function' && mcData.supportFeature('sendsClientTickEndPacket')) ||
          playProtoTypes?.packet_tick_end
      );
    } catch {
      // ignore
    }
  };

  const writeSafeTickEnd = () => {
    if (!needsTickEnd || client.state !== 'play') return;
    positionSentSinceTickEnd = false;
    tickEndSentThisPhysicsStep = true;
    try {
      rawWrite('tick_end', {});
    } catch {
      // ignore if socket closing
    }
  };

  client.write = function stabilizedWrite(name, params) {
    if (!playProtoTypes && client.state === 'play') {
      refreshVersionCapabilities();
    }

    let pktName = name;
    let pktParams = params && typeof params === 'object' ? { ...params } : params;

    // 1. Configuration & Play `settings` packet (`particleStatus` required on 1.21.2+ / 26.x)
    if (pktName === 'settings' && pktParams && pktParams.particleStatus === undefined) {
      pktParams.particleStatus = 'all';
    }

    // 2. Sanitize empty chunk batch `NaN` (`PrismarineJS/mineflayer#4203`)
    if (pktName === 'chunk_batch_received' && pktParams) {
      if (!Number.isFinite(pktParams.chunksPerTick) || pktParams.chunksPerTick <= 0) {
        pktParams.chunksPerTick = 3.5;
      }
    }

    if (client.state === 'play') {
      // 3. `tick_end` guard (`PrismarineJS/mineflayer#4201`):
      //    NEVER allow two position-bearing packets in the same server tick without `tick_end` between them!
      if (pktName === 'tick_end') {
        positionSentSinceTickEnd = false;
        tickEndSentThisPhysicsStep = true;
        return rawWrite(pktName, pktParams || {});
      }

      if (POSITION_BEARING_PACKETS.has(pktName)) {
        if (needsTickEnd && positionSentSinceTickEnd) {
          writeSafeTickEnd();
        }
        const out = rawWrite(pktName, pktParams);
        if (needsTickEnd) {
          positionSentSinceTickEnd = true;
        }
        return out;
      }

      // 4. `26.2` `use_entity` -> `attack` split & `hand` / `location` normalization (`PR #4192`)
      if (pktName === 'use_entity' && pktParams) {
        const hasAttackPacket = Boolean(
          (typeof bot.supportFeature === 'function' && bot.supportFeature('attackUsesOwnPacket')) ||
            playProtoTypes?.packet_attack
        );
        if (pktParams.mouse === 1 && hasAttackPacket) {
          return rawWrite('attack', { entityId: pktParams.target });
        }
        if (playProtoTypes?.packet_use_entity) {
          const handSchema = getFieldSchema(playProtoTypes, 'packet_use_entity', 'hand');
          if (handSchema) {
            pktParams.hand = normalizeHandValue(pktParams.hand, isMapperType(handSchema));
          }
          const locSchema = getFieldSchema(playProtoTypes, 'packet_use_entity', 'location');
          if (locSchema && !pktParams.location) {
            pktParams.location = {
              x: Number(pktParams.x) || 0,
              y: Number(pktParams.y) || 0,
              z: Number(pktParams.z) || 0
            };
          }
        }
      }

      // 5. Normalize `hand` mapper vs varint on `arm_animation`, `block_place`, `use_item`
      if (
        (pktName === 'arm_animation' || pktName === 'block_place' || pktName === 'use_item') &&
        pktParams &&
        playProtoTypes
      ) {
        const handSchema = getFieldSchema(playProtoTypes, `packet_${pktName}`, 'hand');
        if (handSchema) {
          pktParams.hand = normalizeHandValue(pktParams.hand, isMapperType(handSchema));
        }
      }

      // 6. Normalize `client_command` respawn mapper (`{ action: 0 }` / `{ actionId: 0 }` -> `'perform_respawn'`)
      if (pktName === 'client_command' && pktParams && playProtoTypes?.packet_client_command) {
        const actionSchema = getFieldSchema(playProtoTypes, 'packet_client_command', 'actionId');
        if (isMapperType(actionSchema)) {
          const rawVal = pktParams.actionId ?? pktParams.action ?? 0;
          if (typeof rawVal === 'number') {
            pktParams = {
              actionId: actionSchema[1].mappings[String(rawVal)] || 'perform_respawn'
            };
          }
        }
      }

      // 7. Normalize `entity_action` mapper (`2` -> `'stop_sleeping'`, `'start_elytra_flying'` -> `'start_fall_flying'`)
      if (pktName === 'entity_action' && pktParams && playProtoTypes?.packet_entity_action) {
        const actSchema = getFieldSchema(playProtoTypes, 'packet_entity_action', 'actionId');
        if (isMapperType(actSchema)) {
          const validValues = new Set(Object.values(actSchema[1].mappings));
          let act = pktParams.actionId;
          if (typeof act === 'number') {
            act = act === 2 ? 'stop_sleeping' : actSchema[1].mappings[String(act)] || act;
          }
          if (act === 'start_elytra_flying' && !validValues.has('start_elytra_flying') && validValues.has('start_fall_flying')) {
            act = 'start_fall_flying';
          }
          if (act === 'leave_bed' && !validValues.has('leave_bed') && validValues.has('stop_sleeping')) {
            act = 'stop_sleeping';
          }
          if (act === 'stop_sleeping' && !validValues.has('stop_sleeping') && validValues.has('leave_bed')) {
            act = 'leave_bed';
          }
          pktParams.actionId = act;
        }
      }
    }

    return rawWrite(pktName, pktParams);
  };

  // End every physics tick in `play` state with `tick_end` (`PrismarineJS/mineflayer#4137`),
  // plus a 50ms fallback while chunks are still streaming in (before physics starts simulating!)
  bot.on('physicsTick', () => {
    tickEndSentThisPhysicsStep = false;
    setImmediate(() => {
      if (!tickEndSentThisPhysicsStep && needsTickEnd && client.state === 'play') {
        writeSafeTickEnd();
      }
    });
  });

  const clearFallbackTimer = () => {
    if (fallbackTickTimer) {
      clearInterval(fallbackTickTimer);
      fallbackTickTimer = null;
    }
  };

  client.on('login', () => {
    positionSentSinceTickEnd = false;
    refreshVersionCapabilities();
    clearFallbackTimer();
    fallbackTickTimer = setInterval(() => {
      if (needsTickEnd && client.state === 'play') {
        if (positionSentSinceTickEnd || !tickEndSentThisPhysicsStep) {
          writeSafeTickEnd();
        }
        tickEndSentThisPhysicsStep = false;
      }
    }, 50);
    fallbackTickTimer.unref?.();
  });

  client.on('respawn', () => {
    positionSentSinceTickEnd = false;
  });

  client.on('start_configuration', () => {
    positionSentSinceTickEnd = false;
  });

  // Auto-accept required resource packs during configuration phase using raw UUID strings (`PR #4192`)
  const autoAcceptPack = (data) => {
    if (client.state === 'configuration' && data) {
      try {
        if (data.uuid) {
          rawWrite('resource_pack_receive', { uuid: String(data.uuid), result: 3 });
          rawWrite('resource_pack_receive', { uuid: String(data.uuid), result: 0 });
        } else {
          rawWrite('resource_pack_receive', { result: 3 });
          rawWrite('resource_pack_receive', { result: 0 });
        }
      } catch {
        // ignore
      }
    }
  };
  client.on('add_resource_pack', autoAcceptPack);
  client.on('resource_pack_send', autoAcceptPack);

  client.on('end', () => {
    positionSentSinceTickEnd = false;
    clearFallbackTimer();
  });
}

module.exports = {
  DEFAULT_MINECRAFT_VERSION: '26.2',
  ensureMinecraft26_2Bootstrap,
  installBotProtocolStabilizer,
  load26_2Bundle
};
