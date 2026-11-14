'use strict';

const os = require('node:os');
const path = require('node:path');
const { DomainError } = require('../errors/DomainError');
const { validateOllamaEndpointPolicy } = require('../performance/AiEfficiencyController');
const { sanitizeValue } = require('../performance/BoundedLogger');

const ALLOWED_TOP_KEYS = new Set([
  'role',
  'envProfile',
  'operatingMode',
  'performanceProfile',
  'http',
  'tls',
  'capacity',
  'ai',
  'storage',
  'logging',
  'chat',
  'security',
  'worker'
]);

const VALID_OPERATING_MODES = new Set(['SYNCHRONIZED', 'DISTRIBUTED', 'HYBRID']);
const VALID_PERFORMANCE_PROFILES = new Set([
  'ULTRA_LOW',
  'LOW',
  'BALANCED',
  'PERFORMANCE',
  'MAXIMUM_THROUGHPUT'
]);

const FORBIDDEN_ANDROID_FUSE_PREFIXES = ['/sdcard', '/storage/emulated/', '/mnt/sdcard'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MC_USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function isPrivateLanIp(host) {
  if (typeof host !== 'string') return false;
  const parts = host.trim().split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / WireGuard CGNAT
  return false;
}

function parseMinecraftEndpoint(rawHostInput, explicitPortInput, fallbackPort = 25565) {
  let cleaned = String(rawHostInput || '127.0.0.1')
    .trim()
    .replace(/^(?:https?|minecraft):\/\//i, '')
    .replace(/\/+$/, '');
  let inlinePort = null;
  const colonIdx = cleaned.lastIndexOf(':');
  if (colonIdx > 0 && !cleaned.includes(']')) {
    const maybePort = Number(cleaned.slice(colonIdx + 1));
    if (Number.isSafeInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
      inlinePort = maybePort;
      cleaned = cleaned.slice(0, colonIdx);
    }
  }
  const hasExplicitPort =
    explicitPortInput !== undefined && explicitPortInput !== null && String(explicitPortInput).trim() !== '';
  const port = hasExplicitPort
    ? parseIntOr(explicitPortInput, fallbackPort)
    : inlinePort ?? fallbackPort;
  return { host: cleaned, port };
}

function sanitizeBotPrefix(rawPrefix) {
  const cleaned = String(rawPrefix || 'Nexus')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 12);
  return cleaned.length >= 2 ? cleaned : 'Nexus';
}

/**
 * Generate a deterministic, fixed-username bot roster (`bot-01 -> Nexus_01`, etc.)
 * so bots ALWAYS reconnect with the exact same Minecraft username and never lose server inventory.
 */
function buildDeterministicBotRoster({ prefix = 'Nexus', count = 2, startIndex = 1 } = {}) {
  const safePrefix = sanitizeBotPrefix(prefix);
  const safeCount = Math.max(1, Math.min(20, Math.trunc(Number(count) || 2)));
  const safeStart = Math.max(1, Math.min(20, Math.trunc(Number(startIndex) || 1)));
  const roster = [];
  for (let i = 0; i < safeCount; i += 1) {
    const slotNum = safeStart + i;
    const pad = String(slotNum).padStart(2, '0');
    roster.push({
      botId: `bot-${pad}`,
      username: `${safePrefix}_${pad}`.slice(0, 16)
    });
  }
  return roster;
}

function parseBool(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (val === undefined || val === null || val === '') return fallback;
  const norm = String(val).trim().toLowerCase();
  if (norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'false' || norm === '0' || norm === 'no') return false;
  return `__INVALID_BOOL__:${String(val)}`;
}

function parseIntOr(val, fallback) {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  if (val === undefined || val === null || val === '') return fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function buildRawConfig(env = {}, fileConfig = {}) {
  if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) {
    throw new DomainError('SCHEMA_VALIDATION_FAILED', 'fileConfig must be a plain object');
  }
  for (const k of Object.keys(fileConfig)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', `Unknown configuration section: ${k}`);
    }
  }

  const host = String(env.SWARM_BIND_HOST ?? fileConfig.http?.host ?? '127.0.0.1').trim();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const allowPrivateLanHttp = parseBool(
    env.SWARM_ALLOW_PRIVATE_LAN_HTTP ?? fileConfig.http?.allowPrivateLanHttp,
    false
  );
  const defaultTlsEnabled =
    !isLoopback && !(allowPrivateLanHttp === true && isPrivateLanIp(host));
  const mcEndpoint = parseMinecraftEndpoint(
    env.SWARM_MC_HOST ?? fileConfig.worker?.minecraftHost ?? '127.0.0.1',
    env.SWARM_MC_PORT ?? fileConfig.worker?.minecraftPort,
    25565
  );
  const botNamePrefix = sanitizeBotPrefix(
    env.SWARM_BOT_NAME_PREFIX ?? fileConfig.worker?.botNamePrefix ?? 'Nexus'
  );
  const botCount = parseIntOr(
    env.SWARM_WORKER_BOT_COUNT ?? fileConfig.worker?.botCount,
    2
  );
  const botStartIndex = parseIntOr(
    env.SWARM_WORKER_BOT_START_INDEX ?? fileConfig.worker?.botStartIndex,
    1
  );

  return {
    role: String(env.SWARM_ROLE ?? fileConfig.role ?? 'master').trim(),
    envProfile: String(
      env.SWARM_ENV_PROFILE ?? fileConfig.envProfile ?? 'authorised_online'
    ).trim(),
    operatingMode: String(
      env.SWARM_OPERATING_MODE ?? fileConfig.operatingMode ?? 'HYBRID'
    )
      .trim()
      .toUpperCase(),
    performanceProfile: String(
      env.SWARM_PERFORMANCE_PROFILE ?? fileConfig.performanceProfile ?? 'BALANCED'
    )
      .trim()
      .toUpperCase(),
    http: {
      host,
      port: parseIntOr(env.SWARM_PORT ?? env.PORT ?? fileConfig.http?.port, 8443),
      enabled: parseBool(env.SWARM_HTTP_ENABLED ?? fileConfig.http?.enabled, false),
      trustEdgeTlsProxy: parseBool(
        env.SWARM_TRUST_EDGE_TLS_PROXY ?? fileConfig.http?.trustEdgeTlsProxy,
        false
      ),
      allowPrivateLanHttp
    },
    tls: {
      enabled: parseBool(env.SWARM_TLS_ENABLED ?? fileConfig.tls?.enabled, defaultTlsEnabled),
      certPath: env.SWARM_TLS_CERT_PATH ?? fileConfig.tls?.certPath ?? null,
      keyPath: env.SWARM_TLS_KEY_PATH ?? fileConfig.tls?.keyPath ?? null,
      caCertPath: env.SWARM_TLS_CA_PATH ?? fileConfig.tls?.caCertPath ?? null
    },
    capacity: {
      maxArchitecturalBots: parseIntOr(
        env.SWARM_MAX_ARCHITECTURAL_BOTS ?? fileConfig.capacity?.maxArchitecturalBots,
        20
      ),
      globalMaxBots: parseIntOr(
        env.SWARM_GLOBAL_MAX_BOTS ?? fileConfig.capacity?.globalMaxBots,
        20
      ),
      initialEnabledBots: parseIntOr(
        env.SWARM_ENABLED_BOTS ?? fileConfig.capacity?.initialEnabledBots,
        2
      ),
      phoneLocalBotSlots: parseIntOr(
        env.SWARM_PHONE_LOCAL_BOT_SLOTS ?? fileConfig.capacity?.phoneLocalBotSlots,
        0
      ),
      defaultLeaseDurationMs: parseIntOr(
        env.SWARM_LEASE_DURATION_MS ?? fileConfig.capacity?.defaultLeaseDurationMs,
        30_000
      ),
      heartbeatIntervalMs: parseIntOr(
        env.SWARM_HEARTBEAT_INTERVAL_MS ?? fileConfig.capacity?.heartbeatIntervalMs,
        5_000
      ),
      minAssignmentHoldMs: parseIntOr(
        env.SWARM_MIN_ASSIGNMENT_HOLD_MS ?? fileConfig.capacity?.minAssignmentHoldMs,
        8_000
      )
    },
    ai: {
      enabled: parseBool(env.SWARM_AI_ENABLED ?? fileConfig.ai?.enabled, true),
      provider: String(env.SWARM_AI_PROVIDER ?? fileConfig.ai?.provider ?? 'ollama')
        .trim()
        .toLowerCase(),
      apiKey: env.SWARM_AI_API_KEY ?? fileConfig.ai?.apiKey ?? null,
      providerBaseUrl: env.SWARM_AI_BASE_URL ?? fileConfig.ai?.providerBaseUrl ?? null,
      ollamaBaseUrl: env.SWARM_OLLAMA_URL ?? fileConfig.ai?.ollamaBaseUrl ?? null,
      model: String(
        env.SWARM_AI_MODEL ?? env.SWARM_OLLAMA_MODEL ?? fileConfig.ai?.model ?? 'unresolved'
      ).trim(),
      maxConcurrent: parseIntOr(env.SWARM_AI_MAX_CONCURRENT ?? fileConfig.ai?.maxConcurrent, 1),
      maxQueue: parseIntOr(env.SWARM_AI_MAX_QUEUE ?? fileConfig.ai?.maxQueue, 3),
      connectTimeoutMs: parseIntOr(
        env.SWARM_AI_CONNECT_TIMEOUT_MS ?? fileConfig.ai?.connectTimeoutMs,
        2_500
      ),
      timeoutMs: parseIntOr(env.SWARM_AI_TIMEOUT_MS ?? fileConfig.ai?.timeoutMs, 8_000),
      coldLoadTimeoutMs: parseIntOr(
        env.SWARM_AI_COLD_TIMEOUT_MS ?? fileConfig.ai?.coldLoadTimeoutMs,
        20_000
      )
    },
    storage: {
      sqlitePath: String(
        env.SWARM_DB_PATH ?? fileConfig.storage?.sqlitePath ?? './data/swarm.db'
      ).trim(),
      backupDir: String(
        env.SWARM_BACKUP_DIR ?? fileConfig.storage?.backupDir ?? './data/backups'
      ).trim()
    },
    logging: {
      level: String(env.SWARM_LOG_LEVEL ?? fileConfig.logging?.level ?? 'info').trim(),
      filePath: env.SWARM_LOG_PATH ?? fileConfig.logging?.filePath ?? null,
      maxFileBytes: parseIntOr(
        env.SWARM_LOG_MAX_BYTES ?? fileConfig.logging?.maxFileBytes,
        5 * 1024 * 1024
      ),
      maxFiles: parseIntOr(env.SWARM_LOG_MAX_FILES ?? fileConfig.logging?.maxFiles, 3),
      ringSize: parseIntOr(env.SWARM_LOG_RING_SIZE ?? fileConfig.logging?.ringSize, 200)
    },
    chat: {
      enabled: parseBool(env.SWARM_CHAT_ENABLED ?? fileConfig.chat?.enabled, false),
      allowInsecureOfflineChat: parseBool(
        env.SWARM_ALLOW_INSECURE_OFFLINE_CHAT ?? fileConfig.chat?.allowInsecureOfflineChat,
        false
      ),
      commandPrefix: String(
        env.SWARM_CHAT_PREFIX ?? fileConfig.chat?.commandPrefix ?? '!swarm'
      ).trim(),
      allowedPlayerUuids: Array.isArray(fileConfig.chat?.allowedPlayerUuids)
        ? [...fileConfig.chat.allowedPlayerUuids]
        : env.SWARM_CHAT_ALLOWED_UUIDS
          ? String(env.SWARM_CHAT_ALLOWED_UUIDS)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : []
    },
    security: {
      cliOperatorToken: env.SWARM_CLI_TOKEN ?? fileConfig.security?.cliOperatorToken ?? null,
      adminUsername: env.SWARM_ADMIN_USERNAME ?? fileConfig.security?.adminUsername ?? null,
      adminPassword: env.SWARM_ADMIN_PASSWORD ?? fileConfig.security?.adminPassword ?? null,
      bootstrapTokenTtlMs: parseIntOr(
        env.SWARM_BOOTSTRAP_TTL_MS ?? fileConfig.security?.bootstrapTokenTtlMs,
        10 * 60 * 1000
      )
    },
    worker: {
      masterUrl: String(
        env.SWARM_MASTER_URL ?? fileConfig.worker?.masterUrl ?? `http://${host}:8443`
      ).trim(),
      workerId: String(env.SWARM_WORKER_ID ?? fileConfig.worker?.workerId ?? 'worker-1').trim(),
      hostname: String(
        env.SWARM_WORKER_HOSTNAME ?? fileConfig.worker?.hostname ?? os.hostname() ?? 'worker-host'
      ).trim(),
      bootstrapToken: env.SWARM_BOOTSTRAP_TOKEN ?? fileConfig.worker?.bootstrapToken ?? null,
      workerToken: env.SWARM_WORKER_TOKEN ?? fileConfig.worker?.workerToken ?? null,
      statePath: env.SWARM_WORKER_STATE_PATH ?? fileConfig.worker?.statePath ?? null,
      maxBotSlots: parseIntOr(
        env.SWARM_WORKER_MAX_SLOTS ?? fileConfig.worker?.maxBotSlots,
        5
      ),
      spawnStaggerMs: parseIntOr(
        env.SWARM_SPAWN_STAGGER_MS ?? fileConfig.worker?.spawnStaggerMs,
        4_500
      ),
      commandPollIntervalMs: parseIntOr(
        env.SWARM_WORKER_POLL_MS ?? fileConfig.worker?.commandPollIntervalMs,
        1_000
      ),
      minecraftHost: mcEndpoint.host,
      minecraftPort: mcEndpoint.port,
      minecraftVersion:
        String(env.SWARM_MC_VERSION ?? fileConfig.worker?.minecraftVersion ?? '26.2').trim() ||
        '26.2',
      serverId: String(
        env.SWARM_MC_SERVER_ID ?? fileConfig.worker?.serverId ?? 'survival-main'
      ).trim(),
      authMode: String(
        env.SWARM_MC_AUTH_MODE ??
          fileConfig.worker?.authMode ??
          (String(env.SWARM_ENV_PROFILE ?? fileConfig.envProfile ?? 'authorised_online').trim() ===
          'private_offline_test'
            ? 'private_offline_test'
            : 'online_microsoft')
      ).trim(),
      simulationMode: parseBool(
        env.SWARM_WORKER_SIMULATION ?? fileConfig.worker?.simulationMode,
        false
      ),
      botNamePrefix,
      botCount,
      botStartIndex,
      forceRenameBots: parseBool(
        env.SWARM_FORCE_RENAME_BOTS ?? fileConfig.worker?.forceRenameBots,
        false
      ),
      bots: Array.isArray(fileConfig.worker?.bots)
        ? fileConfig.worker.bots.map((b) => ({ ...b }))
        : env.SWARM_WORKER_BOTS
          ? String(env.SWARM_WORKER_BOTS)
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
              .map((entry, idx) => {
                if (entry.includes(':')) {
                  const [idPart, namePart] = entry.split(':').map((s) => s.trim());
                  return {
                    botId: idPart,
                    username: (namePart || idPart.replace(/[^a-zA-Z0-9_]/g, '_')).slice(0, 16)
                  };
                }
                const cleanName = entry.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16);
                return {
                  botId: entry.startsWith('bot-')
                    ? entry
                    : `bot-${String(botStartIndex + idx).padStart(2, '0')}`,
                  username: cleanName.length >= 3 ? cleanName : `${botNamePrefix}_${String(idx + 1).padStart(2, '0')}`
                };
              })
          : []
    }
  };
}

/**
 * Validate normalized configuration without mutating state (MODULE_INTERFACES.md §3.2).
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[], errorCode: string | null }}
 */
function validateConfig(config) {
  const errors = [];
  let errorCode = null;

  const markCode = (code) => {
    if (!errorCode) errorCode = code;
  };

  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      errors: ['Configuration must be an object'],
      errorCode: 'SCHEMA_VALIDATION_FAILED'
    };
  }

  if (!['master', 'worker'].includes(config.role)) {
    errors.push('role must be "master" or "worker"');
  }
  if (!['private_offline_test', 'authorised_online'].includes(config.envProfile)) {
    errors.push('envProfile must be "private_offline_test" or "authorised_online"');
  }
  if (!VALID_OPERATING_MODES.has(config.operatingMode)) {
    errors.push('operatingMode must be SYNCHRONIZED, DISTRIBUTED or HYBRID');
  }
  if (!VALID_PERFORMANCE_PROFILES.has(config.performanceProfile)) {
    errors.push(
      'performanceProfile must be ULTRA_LOW, LOW, BALANCED, PERFORMANCE or MAXIMUM_THROUGHPUT'
    );
  }

  // HTTP & TLS boundaries (MASTER_SPEC.md §7, SECURITY_PLAN.md §4, ADR-007)
  const host = config.http?.host;
  const port = config.http?.port;
  if (!host || typeof host !== 'string') {
    errors.push('http.host must be a non-empty string');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    errors.push('http.port must be an integer in 0..65535');
  }
  if (typeof config.http?.enabled !== 'boolean') {
    errors.push('http.enabled must be a valid boolean');
  }
  if (typeof config.http?.trustEdgeTlsProxy !== 'boolean') {
    errors.push('http.trustEdgeTlsProxy must be a valid boolean');
  }
  if (
    config.http?.allowPrivateLanHttp !== undefined &&
    typeof config.http.allowPrivateLanHttp !== 'boolean'
  ) {
    errors.push('http.allowPrivateLanHttp must be a valid boolean');
  }
  if (typeof config.tls?.enabled !== 'boolean') {
    errors.push('tls.enabled must be a valid boolean');
  }
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const isPermittedPrivateLan =
    config.http?.allowPrivateLanHttp === true && isPrivateLanIp(host);
  if (
    !isLoopback &&
    !isPermittedPrivateLan &&
    config.tls?.enabled !== true &&
    config.http?.trustEdgeTlsProxy !== true
  ) {
    errors.push(
      'Non-loopback http.host requires tls.enabled === true (or allowPrivateLanHttp === true on RFC1918 LAN IPs, or trustEdgeTlsProxy === true)'
    );
  }
  if (config.tls?.enabled === true) {
    if (!config.tls.certPath || !config.tls.keyPath) {
      errors.push('tls.certPath and tls.keyPath are required when tls.enabled === true');
    }
  }

  // Capacity & extensible bot ceiling (G-02 + ADR-002: default 20, extensible via maxArchitecturalBots)
  const cap = config.capacity || {};
  const archMax = Number.isSafeInteger(cap.maxArchitecturalBots) ? cap.maxArchitecturalBots : 20;
  if (!Number.isSafeInteger(cap.maxArchitecturalBots) || cap.maxArchitecturalBots < 1 || cap.maxArchitecturalBots > 500) {
    errors.push('capacity.maxArchitecturalBots must be an integer in 1..500');
  }
  if (!Number.isSafeInteger(cap.globalMaxBots) || cap.globalMaxBots < 1) {
    errors.push('capacity.globalMaxBots must be an integer >= 1');
  } else if (cap.globalMaxBots > archMax) {
    markCode('GLOBAL_BOT_CAP_EXCEEDED');
    errors.push(`capacity.globalMaxBots must not exceed ${archMax} (ADR-002)`);
  }
  if (
    !Number.isSafeInteger(cap.minAssignmentHoldMs) ||
    cap.minAssignmentHoldMs < 0 ||
    cap.minAssignmentHoldMs > 120_000
  ) {
    errors.push('capacity.minAssignmentHoldMs must be in 0..120000');
  }
  if (
    !Number.isSafeInteger(cap.initialEnabledBots) ||
    cap.initialEnabledBots < 1 ||
    (Number.isSafeInteger(cap.globalMaxBots) && cap.initialEnabledBots > cap.globalMaxBots)
  ) {
    errors.push('capacity.initialEnabledBots must be in 1..globalMaxBots');
  }
  if (!Number.isSafeInteger(cap.phoneLocalBotSlots) || cap.phoneLocalBotSlots < 0) {
    errors.push('capacity.phoneLocalBotSlots must be >= 0');
  } else if (config.role === 'master' && cap.phoneLocalBotSlots > 0) {
    errors.push('capacity.phoneLocalBotSlots must be 0 on the Master Controller');
  }
  if (
    !Number.isSafeInteger(cap.heartbeatIntervalMs) ||
    cap.heartbeatIntervalMs < 500 ||
    cap.heartbeatIntervalMs > 30_000
  ) {
    errors.push('capacity.heartbeatIntervalMs must be in 500..30000');
  }
  if (
    !Number.isSafeInteger(cap.defaultLeaseDurationMs) ||
    cap.defaultLeaseDurationMs < 3000 ||
    cap.defaultLeaseDurationMs > 120_000
  ) {
    errors.push('capacity.defaultLeaseDurationMs must be in 3000..120000');
  } else if (
    Number.isSafeInteger(cap.heartbeatIntervalMs) &&
    cap.defaultLeaseDurationMs < 3 * cap.heartbeatIntervalMs
  ) {
    errors.push('capacity.defaultLeaseDurationMs must be >= 3 * capacity.heartbeatIntervalMs');
  }

  // AI policy validation (no phone-local LLM, no paid cloud endpoints - G-09)
  const ai = config.ai || {};
  if (typeof ai.enabled !== 'boolean') {
    errors.push('ai.enabled must be a valid boolean');
  }
  if (!['ollama', 'none'].includes(ai.provider)) {
    markCode('AI_PAID_PROVIDER_FORBIDDEN');
    errors.push('ai.provider must be "ollama" (remote self-hosted inference) or "none" (deterministic mode); cloud AI providers are prohibited');
  }
  if (ai.ollamaBaseUrl !== null && ai.ollamaBaseUrl !== '') {
    try {
      validateOllamaEndpointPolicy(ai.ollamaBaseUrl, {
        enforceRemoteOnController: config.role === 'master'
      });
    } catch (err) {
      markCode(err.code || 'AI_POLICY_VIOLATION');
      errors.push(err.message);
    }
  }
  if (!Number.isSafeInteger(ai.maxConcurrent) || ai.maxConcurrent < 1 || ai.maxConcurrent > 2) {
    errors.push('ai.maxConcurrent must be 1 or 2');
  }
  if (!Number.isSafeInteger(ai.maxQueue) || ai.maxQueue < 0 || ai.maxQueue > 10) {
    errors.push('ai.maxQueue must be in 0..10');
  }
  if (!Number.isSafeInteger(ai.connectTimeoutMs) || ai.connectTimeoutMs < 100 || ai.connectTimeoutMs > 60_000) {
    errors.push('ai.connectTimeoutMs must be in 100..60000');
  }
  if (!Number.isSafeInteger(ai.timeoutMs) || ai.timeoutMs < 100 || ai.timeoutMs > 60_000) {
    errors.push('ai.timeoutMs must be in 100..60000');
  }
  if (!Number.isSafeInteger(ai.coldLoadTimeoutMs) || ai.coldLoadTimeoutMs < 200 || ai.coldLoadTimeoutMs > 120_000) {
    errors.push('ai.coldLoadTimeoutMs must be in 200..120000');
  }
  if (
    Number.isSafeInteger(ai.connectTimeoutMs) &&
    Number.isSafeInteger(ai.timeoutMs) &&
    ai.connectTimeoutMs > ai.timeoutMs
  ) {
    errors.push('ai.connectTimeoutMs must be <= ai.timeoutMs');
  }
  if (
    Number.isSafeInteger(ai.timeoutMs) &&
    Number.isSafeInteger(ai.coldLoadTimeoutMs) &&
    ai.timeoutMs > ai.coldLoadTimeoutMs
  ) {
    errors.push('ai.timeoutMs must be <= ai.coldLoadTimeoutMs');
  }

  // SQLite storage path validation (never on Android FUSE /sdcard - PERFORMANCE_PLAN.md §1)
  const dbPath = String(config.storage?.sqlitePath || '');
  if (!dbPath) {
    errors.push('storage.sqlitePath must be non-empty');
  } else if (dbPath !== ':memory:') {
    const normalizedDb = path.posix.normalize(dbPath.replace(/\\/g, '/'));
    for (const badPrefix of FORBIDDEN_ANDROID_FUSE_PREFIXES) {
      if (normalizedDb === badPrefix || normalizedDb.startsWith(badPrefix)) {
        errors.push(
          `storage.sqlitePath (${dbPath}) must reside on native POSIX storage ($HOME), never Android FUSE ${badPrefix}`
        );
      }
    }
  }

  // Logging validation
  if (!['debug', 'info', 'warn', 'error'].includes(config.logging?.level)) {
    errors.push('logging.level must be debug, info, warn or error');
  }

  // Offline-mode chat spoofing lock (HIGH-06 reconciliation)
  if (typeof config.chat?.enabled !== 'boolean') {
    errors.push('chat.enabled must be a valid boolean');
  }
  if (typeof config.chat?.allowInsecureOfflineChat !== 'boolean') {
    errors.push('chat.allowInsecureOfflineChat must be a valid boolean');
  }
  if (
    config.envProfile === 'private_offline_test' &&
    config.chat?.enabled === true &&
    !(config.chat?.allowInsecureOfflineChat === true && isLoopback)
  ) {
    markCode('CHAT_DISABLED_IN_OFFLINE_MODE');
    errors.push(
      'chat.enabled cannot be true in private_offline_test mode unless bound to loopback with allowInsecureOfflineChat=true (HIGH-06)'
    );
  }
  if (
    typeof config.chat?.commandPrefix !== 'string' ||
    config.chat.commandPrefix.length < 1 ||
    config.chat.commandPrefix.length > 16
  ) {
    errors.push('chat.commandPrefix must be 1..16 characters');
  }

  // Worker configuration validation (when present or role === 'worker')
  if (config.worker) {
    const w = config.worker;
    if (typeof w.simulationMode !== 'boolean') {
      errors.push('worker.simulationMode must be a valid boolean');
    }
    try {
      const parsedMaster = new URL(String(w.masterUrl || ''));
      if (parsedMaster.protocol !== 'http:' && parsedMaster.protocol !== 'https:') {
        errors.push('worker.masterUrl must use http: or https:');
      }
    } catch {
      errors.push('worker.masterUrl must be a valid URL');
    }
    if (!w.workerId || typeof w.workerId !== 'string' || w.workerId.length > 64) {
      errors.push('worker.workerId must be 1..64 characters');
    }
    if (!Number.isSafeInteger(w.maxBotSlots) || w.maxBotSlots < 1 || w.maxBotSlots > archMax) {
      errors.push(`worker.maxBotSlots must be an integer in 1..${archMax}`);
    }
    if (!Number.isSafeInteger(w.spawnStaggerMs) || w.spawnStaggerMs < 0 || w.spawnStaggerMs > 60_000) {
      errors.push('worker.spawnStaggerMs must be in 0..60000');
    }
    if (
      !Number.isSafeInteger(w.commandPollIntervalMs) ||
      w.commandPollIntervalMs < 100 ||
      w.commandPollIntervalMs > 30_000
    ) {
      errors.push('worker.commandPollIntervalMs must be in 100..30000');
    }
    if (!Number.isSafeInteger(w.minecraftPort) || w.minecraftPort < 1 || w.minecraftPort > 65535) {
      errors.push('worker.minecraftPort must be in 1..65535');
    }
    if (!['online_microsoft', 'private_offline_test'].includes(w.authMode)) {
      errors.push('worker.authMode must be online_microsoft or private_offline_test');
    }
    if (config.envProfile === 'authorised_online' && w.authMode === 'private_offline_test') {
      errors.push('worker.authMode cannot be private_offline_test when envProfile is authorised_online');
    }
    if (typeof w.forceRenameBots !== 'boolean') {
      errors.push('worker.forceRenameBots must be a valid boolean');
    }
    if (!Number.isSafeInteger(w.botCount) || w.botCount < 1 || w.botCount > archMax) {
      errors.push(`worker.botCount must be an integer in 1..${archMax}`);
    }
    if (!Number.isSafeInteger(w.botStartIndex) || w.botStartIndex < 1 || w.botStartIndex > archMax) {
      errors.push(`worker.botStartIndex must be an integer in 1..${archMax}`);
    }
    if (Array.isArray(w.bots)) {
      for (const b of w.bots) {
        if (!b.username || !MC_USERNAME_RE.test(String(b.username))) {
          errors.push(
            `worker bot username "${b.username}" must be 3..16 characters [A-Za-z0-9_]`
          );
        }
      }
    }
  }

  if (errors.length > 0 && !errorCode) {
    errorCode = 'SCHEMA_VALIDATION_FAILED';
  }
  return {
    valid: errors.length === 0,
    errors,
    errorCode
  };
}

/**
 * Parse, validate and deeply freeze application configuration at startup.
 */
function loadConfig(env = process.env, fileConfig = {}) {
  let actualEnv = env;
  let actualFileConfig = fileConfig;
  if (
    env &&
    typeof env === 'object' &&
    (Object.prototype.hasOwnProperty.call(env, 'env') ||
      Object.prototype.hasOwnProperty.call(env, 'fileConfig')) &&
    !Object.keys(env).some((k) => k.startsWith('SWARM_') || k === 'PORT')
  ) {
    actualEnv = env.env || process.env;
    actualFileConfig = env.fileConfig || fileConfig;
  }
  const raw = buildRawConfig(actualEnv, actualFileConfig);
  const check = validateConfig(raw);
  if (!check.valid) {
    throw new DomainError(
      check.errorCode || 'SCHEMA_VALIDATION_FAILED',
      `Invalid configuration: ${check.errors.join('; ')}`,
      { details: { errors: check.errors } }
    );
  }
  return deepFreeze(raw);
}

/**
 * Redact sensitive fields for safe logging / diagnostics output.
 */
function redactConfig(config) {
  return sanitizeValue(config);
}

module.exports = {
  loadConfig,
  validateConfig,
  redactConfig,
  isPrivateLanIp,
  parseMinecraftEndpoint,
  buildDeterministicBotRoster,
  VALID_OPERATING_MODES,
  VALID_PERFORMANCE_PROFILES
};
