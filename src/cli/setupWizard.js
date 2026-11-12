'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const {
  isPrivateLanIp,
  parseMinecraftEndpoint,
  buildDeterministicBotRoster
} = require('../config/loadConfig');
const { loadDotEnvFile, writeDotEnvFile, detectLocalLanIp } = require('../config/envFile');

/**
 * Line-buffered prompt session supporting both interactive TTYs (with line editing)
 * and piped / scripted non-TTY streams without dropping pre-buffered lines on EOF.
 */
function createPromptSession(input, output) {
  const isTty = Boolean(input && input.isTTY);
  const rl = readline.createInterface({
    input,
    output: isTty ? output : undefined,
    terminal: isTty,
    crlfDelay: Infinity
  });

  const lineQueue = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(String(line));
    } else {
      lineQueue.push(String(line));
    }
  });

  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve('');
    }
  });

  return {
    async question(promptText) {
      output.write(promptText);
      let ans;
      if (lineQueue.length > 0) {
        ans = lineQueue.shift();
        if (!isTty) output.write(`${ans}\n`);
      } else if (closed) {
        ans = '';
        if (!isTty) output.write('\n');
      } else {
        ans = await new Promise((resolve) => waiters.push(resolve));
        if (!isTty) output.write(`${ans}\n`);
      }
      return ans;
    },
    close() {
      rl.close();
    }
  };
}

function isYes(input, defaultBool = true) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return defaultBool;
  if (['y', 'yes', 'true', '1', 'cracked', 'on'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'online', 'off'].includes(s)) return false;
  return defaultBool;
}

function clampInt(input, min, max, fallback) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return fallback;
  const n = Math.trunc(Number(trimmed));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pickChoice(input, map, fallback) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return map[s] || fallback;
}

/**
 * Normalize a user-entered Master URL (e.g. `192.168.1.168` -> `http://192.168.1.168:8443`).
 */
function normalizeMasterUrl(input, fallback = 'http://192.168.1.168:8443') {
  let s = String(input ?? '').trim();
  if (!s) return fallback;
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:') {
      u.port = '8443';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/**
 * Prompt only for missing Worker enrollment fields (`SWARM_MASTER_URL` if Crostini NAT,
 * and `SWARM_BOOTSTRAP_TOKEN` when not yet enrolled) instead of failing with UNAUTHENTICATED.
 */
async function promptMissingWorkerEnrollment({
  envFilePath = path.resolve(process.cwd(), '.env'),
  input = process.stdin,
  output = process.stdout,
  currentEnv = {}
} = {}) {
  const session = createPromptSession(input, output);
  const ask = async (label, defaultVal) => {
    const suffix = defaultVal !== undefined && defaultVal !== '' ? ` [${defaultVal}]` : '';
    const raw = await session.question(`${label}${suffix}: `);
    const trimmed = raw.trim();
    return trimmed === '' && defaultVal !== undefined ? String(defaultVal) : trimmed;
  };

  try {
    output.write(
      [
        '',
        '------------------------------------------------------------',
        '  First-Time Worker Enrollment Needed',
        '  Start Master on your Phone first ("npm start" -> role 1),',
        '  then paste the "Worker Token" shown in your Phone banner.',
        '------------------------------------------------------------',
        ''
      ].join('\n')
    );

    const prevUrl = currentEnv.SWARM_MASTER_URL || '';
    const suggestedUrl =
      prevUrl && !prevUrl.includes('100.115.92.')
        ? prevUrl
        : 'http://192.168.1.168:8443';
    const rawUrl = await ask('Phone Master IP or URL', suggestedUrl);
    const masterUrl = normalizeMasterUrl(rawUrl, suggestedUrl);

    let bootToken = '';
    while (!bootToken) {
      bootToken = await ask('Paste Worker Token from your Phone Master', '');
      if (!bootToken) {
        output.write('  (A Worker Token is required the first time this Debian Worker connects. Press Ctrl+C to cancel.)\n');
      }
    }

    const existing = loadDotEnvFile(envFilePath).values;
    const merged = {
      ...existing,
      ...currentEnv,
      SWARM_MASTER_URL: masterUrl,
      SWARM_BOOTSTRAP_TOKEN: bootToken
    };
    writeDotEnvFile(envFilePath, merged);
    output.write(`Updated ${envFilePath} with Master URL (${masterUrl}) and Worker Token.\n\n`);
    return { masterUrl, bootstrapToken: bootToken, envVars: merged };
  } finally {
    session.close();
  }
}

/**
 * Print a compact summary of an existing `.env` configuration before launching.
 */
function formatSavedConfigBanner(values = {}) {
  const role =
    values.SWARM_LOCAL_STANDALONE === 'true'
      ? 'standalone (Master + Real Minecraft Bots on this machine)'
      : values.SWARM_LOCAL_SIM === 'true'
        ? 'local_sim (Master + Simulated Bots)'
        : values.SWARM_ROLE || 'master';
  const server = `${values.SWARM_MC_HOST || 'thebasement-wUr4.aternos.me'}:${values.SWARM_MC_PORT || '25565'}`;
  const cracked = (values.SWARM_ENV_PROFILE || 'private_offline_test') === 'private_offline_test' ? 'yes (cracked/offline)' : 'no (Microsoft online)';
  const bots = values.SWARM_ENABLED_BOTS || values.SWARM_WORKER_BOT_COUNT || '2';
  const prefix = values.SWARM_BOT_NAME_PREFIX || 'Nexus';
  const ai = values.SWARM_AI_ENABLED === 'true'
    ? `enabled (${values.SWARM_OLLAMA_URL || 'remote'} / ${values.SWARM_OLLAMA_MODEL || 'qwen2.5:3b'})`
    : 'built-in offline planner (£0)';
  const endpoint = (values.SWARM_ROLE || 'master') === 'worker'
    ? `Master -> ${values.SWARM_MASTER_URL || 'http://192.168.1.168:8443'}`
    : `Control Centre -> http://${values.SWARM_BIND_HOST || '127.0.0.1'}:${values.SWARM_PORT || '8443'}`;

  return [
    '',
    '============================================================',
    '  NEXUS-20 — Saved Configuration (.env)',
    '============================================================',
    `  role          : ${role}`,
    `  server        : ${server}`,
    `  cracked       : ${cracked}`,
    `  initial_bots  : ${bots} (${prefix}_01 .. ${prefix}_${String(Number(bots) || 2).padStart(2, '0')})`,
    `  mode/profile  : ${values.SWARM_OPERATING_MODE || 'HYBRID'} / ${values.SWARM_PERFORMANCE_PROFILE || 'BALANCED'}`,
    `  ai            : ${ai}`,
    `  network       : ${endpoint}`,
    '============================================================'
  ].join('\n');
}

/**
 * Ask a single quick prompt when `.env` already exists:
 * Press Enter to start immediately, or type `e` / `setup` to walk through options one-by-one.
 */
async function promptQuickStartOrEdit({ input = process.stdin, output = process.stdout, savedValues = {} } = {}) {
  output.write(`${formatSavedConfigBanner(savedValues)}\n`);
  const session = createPromptSession(input, output);
  try {
    const ans = (
      await session.question('Press [Enter] to start now, or type [e] to edit config one-by-one: ')
    )
      .trim()
      .toLowerCase();
    return ['e', 'edit', 's', 'setup', 'config', 'c'].includes(ans) ? 'edit' : 'start';
  } finally {
    session.close();
  }
}

/**
 * Interactive One-by-One NEXUS-20 Configuration Wizard (`node index.js setup` or first `npm start`).
 *
 * Prompts step-by-step for:
 *   1. role          (master / worker / local_sim)
 *   2. server        (Minecraft server address, e.g. thebasement-wUr4.aternos.me)
 *   3. server_port   (Minecraft port, default 25565 with Aternos auto-SRV)
 *   4. cracked       (Cracked / offline server? yes/no -> locks auth mode)
 *   5. initial_bots  (How many bots to run initially, 1..20)
 *   6. bot_prefix    (Sticky username prefix -> Nexus_01, Nexus_02 so bots NEVER lose items!)
 *   7. mode          (HYBRID / SYNCHRONIZED / DISTRIBUTED)
 *   8. performance   (ULTRA_LOW / LOW / BALANCED / PERFORMANCE / MAXIMUM_THROUGHPUT)
 *   9. ai            (Enable remote Ollama AI? yes/no + URL + model)
 *  10. network/auth  (Phone LAN IP & port for Master, or Master URL & Bootstrap Token for Worker)
 *  11. chat          (Optional in-game !swarm chat control)
 */
async function runSetupWizard({
  envFilePath = path.resolve(process.cwd(), '.env'),
  input = process.stdin,
  output = process.stdout,
  detectedLanIp = null,
  autoInstallDeps = true
} = {}) {
  const existing = loadDotEnvFile(envFilePath).values;
  const lanIp = detectedLanIp || detectLocalLanIp('192.168.1.168');

  const session = createPromptSession(input, output);
  const ask = async (label, defaultVal) => {
    const suffix = defaultVal !== undefined && defaultVal !== '' ? ` [${defaultVal}]` : '';
    const raw = await session.question(`${label}${suffix}: `);
    const trimmed = raw.trim();
    return trimmed === '' && defaultVal !== undefined ? String(defaultVal) : trimmed;
  };

  try {
    output.write(
      [
        '',
        '============================================================',
        '  NEXUS-20 — Step-by-Step Interactive Setup',
        '  (Press Enter on any step to accept the [default] value)',
        '============================================================',
        ''
      ].join('\n')
    );

    // 1. ROLE
    const prevRoleDefault =
      existing.SWARM_LOCAL_STANDALONE === 'true'
        ? 'standalone'
        : existing.SWARM_LOCAL_SIM === 'true'
          ? 'local_sim'
          : existing.SWARM_ROLE === 'worker'
            ? 'worker'
            : 'master';
    output.write('Step 1 — Device Role:\n');
    output.write('  1) master     — Phone / Termux Control Centre & Web Dashboard (0 local bots)\n');
    output.write('  2) worker     — Debian / PC Worker connecting real bots to your Phone Master\n');
    output.write('  3) local_sim  — All-in-one Master + Simulated Bots (test without Minecraft)\n');
    output.write('  4) standalone — All-in-one Master + Real Minecraft Bots on this machine\n');
    const roleRaw = await ask(
      '1. role (1=master, 2=worker, 3=local_sim, 4=standalone)',
      prevRoleDefault
    );
    const roleChoice = pickChoice(
      roleRaw,
      {
        '1': 'master',
        master: 'master',
        m: 'master',
        '2': 'worker',
        worker: 'worker',
        w: 'worker',
        '3': 'local_sim',
        local_sim: 'local_sim',
        sim: 'local_sim',
        '4': 'standalone',
        standalone: 'standalone',
        all: 'standalone'
      },
      prevRoleDefault
    );
    const actualRole = roleChoice === 'worker' ? 'worker' : 'master';
    const isLocalSim = roleChoice === 'local_sim';
    const isLocalStandalone = roleChoice === 'standalone';

    // 2. SERVER
    const defaultHost = existing.SWARM_MC_HOST || 'thebasement-wUr4.aternos.me';
    const serverRaw = await ask('\n2. server (Minecraft server address)', defaultHost);
    const parsedMc = parseMinecraftEndpoint(serverRaw, undefined, Number(existing.SWARM_MC_PORT || 25565));

    // 3. SERVER PORT
    const portRaw = await ask(
      '3. server_port (Minecraft port — keep 25565 for Aternos auto-SRV)',
      String(parsedMc.port)
    );
    const mcPort = clampInt(portRaw, 1, 65535, 25565);

    // 4. CRACKED / OFFLINE MODE
    const prevCracked =
      (existing.SWARM_ENV_PROFILE || 'private_offline_test') === 'private_offline_test'
        ? 'yes'
        : 'no';
    const crackedRaw = await ask(
      '4. cracked (Is the Minecraft server cracked / offline-mode? yes/no)',
      prevCracked
    );
    const isCracked = isYes(crackedRaw, prevCracked === 'yes');
    const envProfile = isCracked ? 'private_offline_test' : 'authorised_online';

    // 5. INITIAL BOTS
    const prevBots = Number(existing.SWARM_ENABLED_BOTS || existing.SWARM_WORKER_BOT_COUNT || 2);
    const botsRaw = await ask('5. initial_bots (How many bots to run initially, 1..20)', String(prevBots));
    const initialBots = clampInt(botsRaw, 1, 20, 2);

    // 6. STICKY BOT USERNAME PREFIX
    const prevPrefix = existing.SWARM_BOT_NAME_PREFIX || 'Nexus';
    const prefixRaw = await ask(
      '6. bot_prefix (Sticky username prefix so bots NEVER lose their items)',
      prevPrefix
    );
    const rosterPreview = buildDeterministicBotRoster({
      prefix: prefixRaw,
      count: initialBots,
      startIndex: 1
    });
    const safePrefix = rosterPreview[0].username.split('_')[0] || 'Nexus';
    output.write(
      `   -> Sticky usernames locked: ${rosterPreview.map((b) => b.username).join(', ')}\n`
    );

    // 7. SWARM OPERATING MODE
    const prevMode = existing.SWARM_OPERATING_MODE || 'HYBRID';
    const modeRaw = await ask(
      '\n7. mode (1=HYBRID, 2=SYNCHRONIZED, 3=DISTRIBUTED)',
      prevMode
    );
    const operatingMode = pickChoice(
      modeRaw,
      {
        '1': 'HYBRID',
        hybrid: 'HYBRID',
        '2': 'SYNCHRONIZED',
        synchronized: 'SYNCHRONIZED',
        sync: 'SYNCHRONIZED',
        '3': 'DISTRIBUTED',
        distributed: 'DISTRIBUTED',
        dist: 'DISTRIBUTED'
      },
      prevMode
    );

    // 8. PERFORMANCE PROFILE
    const prevPerf = existing.SWARM_PERFORMANCE_PROFILE || 'BALANCED';
    const perfRaw = await ask(
      '8. performance (1=ULTRA_LOW, 2=LOW, 3=BALANCED, 4=PERFORMANCE, 5=MAXIMUM_THROUGHPUT)',
      prevPerf
    );
    const performanceProfile = pickChoice(
      perfRaw,
      {
        '1': 'ULTRA_LOW',
        ultra_low: 'ULTRA_LOW',
        '2': 'LOW',
        low: 'LOW',
        '3': 'BALANCED',
        balanced: 'BALANCED',
        '4': 'PERFORMANCE',
        performance: 'PERFORMANCE',
        '5': 'MAXIMUM_THROUGHPUT',
        maximum_throughput: 'MAXIMUM_THROUGHPUT',
        max: 'MAXIMUM_THROUGHPUT'
      },
      prevPerf
    );

    // 9. AI BRAIN (Zero-AI / Gemini / ChatGPT / Claude / Groq / OpenRouter / DeepSeek / Grok / Ollama)
    const prevProvider = existing.SWARM_AI_PROVIDER || (existing.SWARM_AI_ENABLED === 'true' ? 'ollama' : 'no');
    const aiRaw = (
      await ask(
        '\n9. ai (no = 1,370+ No-AI commands, or: gemini / chatgpt / claude / groq / openrouter / deepseek / grok / ollama)',
        prevProvider
      )
    )
      .trim()
      .toLowerCase();

    const cloudAliases = {
      chatgpt: 'openai',
      openai: 'openai',
      gemini: 'gemini',
      claude: 'anthropic',
      anthropic: 'anthropic',
      groq: 'groq',
      openrouter: 'openrouter',
      deepseek: 'deepseek',
      grok: 'xai',
      xai: 'xai',
      mistral: 'mistral',
      together: 'together',
      cerebras: 'cerebras',
      cohere: 'cohere',
      perplexity: 'perplexity'
    };

    let aiEnabled = false;
    let aiProvider = 'none';
    let aiApiKey = existing.SWARM_AI_API_KEY || '';
    let aiModel = existing.SWARM_AI_MODEL || '';
    let ollamaUrl = existing.SWARM_OLLAMA_URL || '';
    let ollamaModel = existing.SWARM_OLLAMA_MODEL || 'qwen2.5:3b';

    if (cloudAliases[aiRaw]) {
      aiEnabled = true;
      aiProvider = cloudAliases[aiRaw];
      aiApiKey = await ask(`   9a. api_key (${aiProvider.toUpperCase()} API Key)`, aiApiKey);
      const defaultCloudModel =
        aiProvider === 'gemini'
          ? 'gemini-2.5-flash'
          : aiProvider === 'openai'
            ? 'gpt-4o-mini'
            : aiProvider === 'anthropic'
              ? 'claude-sonnet-4-20250514'
              : aiProvider === 'groq'
                ? 'llama-3.3-70b-versatile'
                : aiProvider === 'openrouter'
                  ? 'meta-llama/llama-3.3-70b-instruct:free'
                  : aiProvider === 'deepseek'
                    ? 'deepseek-chat'
                    : 'grok-3-mini';
      aiModel = await ask('   9b. ai_model (Model ID)', aiModel || defaultCloudModel);
    } else if (aiRaw === 'ollama' || isYes(aiRaw, false)) {
      aiEnabled = true;
      aiProvider = 'ollama';
      ollamaUrl = await ask(
        '   9a. ollama_url (Remote PC Ollama URL, e.g. http://192.168.1.50:11434)',
        ollamaUrl || 'http://192.168.1.50:11434'
      );
      ollamaModel = await ask('   9b. ollama_model (Ollama model name)', ollamaModel);
    }

    const baseDir = path.dirname(path.resolve(envFilePath));
    const isCwdEnv = baseDir === process.cwd();
    const defaultDbPath = isCwdEnv ? './data/swarm.db' : path.join(baseDir, 'data', 'swarm.db');
    const defaultBackupDir = isCwdEnv ? './data/backups' : path.join(baseDir, 'data', 'backups');

    const envOut = {
      ...(actualRole === 'master' && !isLocalStandalone
        ? { NODE_OPTIONS: '--max-old-space-size=256' }
        : {}),
      SWARM_ROLE: actualRole,
      SWARM_LOCAL_SIM: isLocalSim ? 'true' : 'false',
      SWARM_LOCAL_STANDALONE: isLocalStandalone ? 'true' : 'false',
      SWARM_ENV_PROFILE: envProfile,
      SWARM_OPERATING_MODE: operatingMode,
      SWARM_PERFORMANCE_PROFILE: performanceProfile,
      SWARM_MC_HOST: parsedMc.host,
      SWARM_MC_PORT: String(mcPort),
      SWARM_MC_SERVER_ID: parsedMc.host.split('.')[0] || 'survival-main',
      SWARM_ENABLED_BOTS: String(initialBots),
      SWARM_WORKER_BOT_COUNT: String(initialBots),
      SWARM_BOT_NAME_PREFIX: safePrefix,
      SWARM_AI_ENABLED: aiEnabled ? 'true' : 'false',
      SWARM_AI_PROVIDER: aiProvider,
      ...(aiEnabled && aiProvider === 'ollama' && ollamaUrl
        ? { SWARM_OLLAMA_URL: ollamaUrl, SWARM_OLLAMA_MODEL: ollamaModel }
        : {}),
      ...(aiEnabled && aiProvider !== 'ollama' && aiApiKey
        ? { SWARM_AI_API_KEY: aiApiKey, SWARM_AI_MODEL: aiModel }
        : {}),
      SWARM_DB_PATH: existing.SWARM_DB_PATH || defaultDbPath,
      SWARM_BACKUP_DIR: existing.SWARM_BACKUP_DIR || defaultBackupDir,
      SWARM_CLI_TOKEN: existing.SWARM_CLI_TOKEN || crypto.randomBytes(32).toString('hex')
    };

    // 10. ROLE-SPECIFIC NETWORK & AUTH OPTIONS
    if (actualRole === 'master') {
      const defaultBind = existing.SWARM_BIND_HOST || lanIp;
      const bindIp = await ask(
        `\n10. bind_ip (Control Centre IP — ${lanIp} for Wi-Fi LAN, or 127.0.0.1 for phone-only)`,
        defaultBind
      );
      const httpPort = clampInt(
        await ask('11. port (Control Centre HTTP port)', existing.SWARM_PORT || '8443'),
        1,
        65535,
        8443
      );

      envOut.SWARM_BIND_HOST = bindIp;
      envOut.SWARM_PORT = String(httpPort);
      envOut.SWARM_HTTP_ENABLED = 'true';
      if (isPrivateLanIp(bindIp)) {
        envOut.SWARM_ALLOW_PRIVATE_LAN_HTTP = 'true';
        envOut.SWARM_TLS_ENABLED = 'false';
      } else if (bindIp === '127.0.0.1' || bindIp === 'localhost' || bindIp === '::1') {
        envOut.SWARM_TLS_ENABLED = 'false';
      }

      const adminUser = await ask(
        '12. admin_user (Optional initial Web UI admin username, or Enter to set in browser)',
        existing.SWARM_ADMIN_USERNAME || ''
      );
      if (adminUser && adminUser.length >= 3) {
        let adminPass = await ask(
          '    admin_password (Min 10 characters)',
          existing.SWARM_ADMIN_PASSWORD || ''
        );
        while (adminPass && adminPass.length < 10) {
          output.write('    Password must be at least 10 characters.\n');
          adminPass = await ask('    admin_password (Min 10 characters)', '');
        }
        if (adminPass && adminPass.length >= 10) {
          envOut.SWARM_ADMIN_USERNAME = adminUser;
          envOut.SWARM_ADMIN_PASSWORD = adminPass;
        }
      }

      const prevChat = existing.SWARM_CHAT_ENABLED === 'true' ? 'yes' : 'no';
      const chatRaw = await ask(
        '13. ingame_chat (Allow !swarm commands in Minecraft chat? yes/no)',
        prevChat
      );
      const chatEnabled = isYes(chatRaw, prevChat === 'yes');
      envOut.SWARM_CHAT_ENABLED = chatEnabled ? 'true' : 'false';
      if (chatEnabled) {
        if (isCracked) {
          envOut.SWARM_ALLOW_INSECURE_OFFLINE_CHAT = 'true';
        }
        const uuids = await ask(
          '    chat_allowed_uuids (Comma-separated player UUIDs allowed to run !swarm)',
          existing.SWARM_CHAT_ALLOWED_UUIDS || ''
        );
        if (uuids) envOut.SWARM_CHAT_ALLOWED_UUIDS = uuids;
      }
      envOut.SWARM_MASTER_URL = `http://${bindIp}:${httpPort}`;

      if (isLocalStandalone) {
        const staggerMs = clampInt(
          await ask(
            '14. spawn_stagger_ms (Delay in ms between bots joining Aternos)',
            existing.SWARM_SPAWN_STAGGER_MS || '4000'
          ),
          0,
          60_000,
          4000
        );
        envOut.SWARM_SPAWN_STAGGER_MS = String(staggerMs);
        if (autoInstallDeps) {
          let hasMineflayer = false;
          try {
            require.resolve('mineflayer');
            hasMineflayer = true;
          } catch {
            hasMineflayer = false;
          }
          if (!hasMineflayer) {
            const instRaw = await ask(
              '\nMineflayer is not installed yet. Install mineflayer + mineflayer-pathfinder now? (yes/no)',
              'yes'
            );
            if (isYes(instRaw, true)) {
              output.write('Installing mineflayer + mineflayer-pathfinder...\n');
              execFileSync('npm', ['install', '--no-save', 'mineflayer', 'mineflayer-pathfinder'], {
                cwd: path.dirname(envFilePath),
                stdio: 'inherit'
              });
            }
          }
        }
      }
    } else {
      // Worker PC / Debian setup: never default to ChromeOS Crostini's own 100.115.92.x VM NAT IP
      const nonCrostiniLanIp = lanIp && !lanIp.startsWith('100.115.92.') ? lanIp : '192.168.1.168';
      const defaultMasterUrl =
        existing.SWARM_MASTER_URL && !existing.SWARM_MASTER_URL.includes('100.115.92.')
          ? existing.SWARM_MASTER_URL
          : `http://${nonCrostiniLanIp}:8443`;
      const rawMasterUrl = await ask(
        '\n10. master_url (Phone Master IP or URL, e.g. http://192.168.1.168:8443)',
        defaultMasterUrl
      );
      const masterUrl = normalizeMasterUrl(rawMasterUrl, defaultMasterUrl);
      const workerId = await ask(
        '11. worker_id (Unique ID for this Worker PC)',
        existing.SWARM_WORKER_ID || 'worker-1'
      );
      const statePath = existing.SWARM_WORKER_STATE_PATH || `./data/${workerId}-state.json`;
      const absStatePath = path.resolve(path.dirname(envFilePath), statePath);
      const hasSavedState = fs.existsSync(absStatePath);
      const tokenPrompt = hasSavedState
        ? `12. bootstrap_token (Already enrolled in ${statePath} — press Enter to reuse, or paste new token)`
        : '12. bootstrap_token (Paste "Worker Token" from your Phone Master terminal)';
      const bootToken = await ask(tokenPrompt, existing.SWARM_BOOTSTRAP_TOKEN || '');
      const staggerMs = clampInt(
        await ask('13. spawn_stagger_ms (Delay in ms between bots joining Aternos)', existing.SWARM_SPAWN_STAGGER_MS || '4000'),
        0,
        60_000,
        4000
      );
      const simRaw = await ask(
        '14. simulation (Dry-run simulation mode without connecting to Minecraft? yes/no)',
        existing.SWARM_WORKER_SIMULATION === 'true' ? 'yes' : 'no'
      );
      const simMode = isYes(simRaw, false);

      envOut.SWARM_MASTER_URL = masterUrl;
      envOut.SWARM_WORKER_ID = workerId;
      envOut.SWARM_WORKER_STATE_PATH = statePath;
      envOut.SWARM_SPAWN_STAGGER_MS = String(staggerMs);
      envOut.SWARM_WORKER_SIMULATION = simMode ? 'true' : 'false';
      if (bootToken) {
        envOut.SWARM_BOOTSTRAP_TOKEN = bootToken;
      }

      if (!simMode && autoInstallDeps) {
        let hasMineflayer = false;
        try {
          require.resolve('mineflayer');
          hasMineflayer = true;
        } catch {
          hasMineflayer = false;
        }
        if (!hasMineflayer) {
          const instRaw = await ask(
            '\nMineflayer is not installed on this Worker yet. Install mineflayer + mineflayer-pathfinder now? (yes/no)',
            'yes'
          );
          if (isYes(instRaw, true)) {
            output.write('Installing mineflayer + mineflayer-pathfinder on Worker...\n');
            execFileSync('npm', ['install', '--no-save', 'mineflayer', 'mineflayer-pathfinder'], {
              cwd: path.dirname(envFilePath),
              stdio: 'inherit'
            });
          }
        }
      }
    }

    const savedPath = writeDotEnvFile(envFilePath, envOut);
    output.write(`\nSaved configuration to ${savedPath} (permissions: 0600).\n`);
    output.write(`${formatSavedConfigBanner(envOut)}\n\n`);

    return {
      savedPath,
      envVars: envOut,
      localSim: isLocalSim
    };
  } finally {
    session.close();
  }
}

module.exports = {
  runSetupWizard,
  promptQuickStartOrEdit,
  promptMissingWorkerEnrollment,
  normalizeMasterUrl,
  formatSavedConfigBanner
};
