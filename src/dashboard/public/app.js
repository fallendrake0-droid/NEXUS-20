'use strict';

(function () {
  const state = {
    csrfToken: sessionStorage.getItem('nexus_csrf') || null,
    actor: null,
    bootstrapRequired: false,
    envProfile: 'private_offline_test',
    sseClientId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    sse: null,
    pollTimer: null,
    noaiCategory: 'all',
    noaiSearch: '',
    noaiOffset: 0,
    noaiLimit: 24,
    noaiRequestSeq: 0,
    skinsById: {},
    providersCache: [],
    aiFormInitialized: false,
    autocompleteDict: null,
    cmdHistory: [],
    cmdHistoryIndex: -1,
    lastStatus: null,
    aiChatHistory: [],
    aiPendingClarificationTaskId: null,
    aiChatSending: false,
    botMotionById: new Map(),
    gotoEtaByBot: new Map(),
    botUiTimer: null
  };

  const el = (id) => document.getElementById(id);

  function showToast(msg, isError) {
    const t = el('toast-banner');
    t.textContent = msg;
    t.classList.toggle('toast-error', Boolean(isError));
    t.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.add('hidden'), 4500);
  }

  function paintMatrixOnCanvas(ctx, matrix, offsetX, offsetY, scale) {
    if (!Array.isArray(matrix)) return;
    for (let y = 0; y < matrix.length; y += 1) {
      const row = matrix[y];
      for (let x = 0; x < row.length; x += 1) {
        if (!row[x]) continue;
        ctx.fillStyle = row[x];
        ctx.fillRect((offsetX + x) * scale, (offsetY + y) * scale, scale, scale);
      }
    }
  }

  function createSkinFullCanvas(preview, scale) {
    const s = scale || 4;
    const canvas = document.createElement('canvas');
    canvas.width = 20 * s;
    canvas.height = 36 * s;
    canvas.className = 'skin-canvas';
    const ctx = canvas.getContext('2d');
    if (preview && ctx) {
      paintMatrixOnCanvas(ctx, preview.head, 6, 2, s);
      paintMatrixOnCanvas(ctx, preview.rightArm, 2, 10, s);
      paintMatrixOnCanvas(ctx, preview.body, 6, 10, s);
      paintMatrixOnCanvas(ctx, preview.leftArm, 14, 10, s);
      paintMatrixOnCanvas(ctx, preview.rightLeg, 6, 22, s);
      paintMatrixOnCanvas(ctx, preview.leftLeg, 10, 22, s);
    }
    return canvas;
  }

  function createSkinHeadCanvas(preview, scale) {
    const s = scale || 3;
    const canvas = document.createElement('canvas');
    canvas.width = 8 * s;
    canvas.height = 8 * s;
    canvas.className = 'bot-head-canvas';
    const ctx = canvas.getContext('2d');
    if (preview && preview.head && ctx) {
      paintMatrixOnCanvas(ctx, preview.head, 0, 0, s);
    }
    return canvas;
  }

  async function api(path, options) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (method !== 'GET' && method !== 'HEAD' && state.csrfToken) {
      headers['X-CSRF-Token'] = state.csrfToken;
    }

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function renderAuthScreen(bootstrapRequired) {
    state.bootstrapRequired = Boolean(bootstrapRequired);
    el('app-shell').classList.add('hidden');
    el('auth-screen').classList.remove('hidden');
    el('auth-error').classList.add('hidden');
    if (state.bootstrapRequired) {
      el('auth-title').textContent = 'Initial Administrator Setup';
      el('auth-subtitle').textContent = 'Create the first NEXUS-20 administrator account (scrypt hashed in SQLite).';
      el('auth-submit').textContent = 'Create Admin & Enter Control Centre';
    } else {
      el('auth-title').textContent = 'Operator Sign In';
      el('auth-subtitle').textContent = 'Authenticate to access the NEXUS-20 Central Brain.';
      el('auth-submit').textContent = 'Sign In';
    }
  }

  function enterShell(actor) {
    state.actor = actor;
    restoreAiChatHistory();
    el('ai-control-submit').textContent = state.aiPendingClarificationTaskId ? 'Answer clarification' : 'Send instruction';
    el('auth-screen').classList.add('hidden');
    el('app-shell').classList.remove('hidden');
    el('actor-badge').textContent = actor.username + ' (' + actor.role + ')';
    connectSse();
    refreshAll();
    clearInterval(state.botUiTimer);
    state.botUiTimer = setInterval(updateBotCountdownLabels, 1000);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, 5000);
  }

  function connectSse() {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    const url = '/api/v1/events?clientId=' + encodeURIComponent(state.sseClientId) + '&hidden=' + (document.hidden ? 'true' : 'false');
    const es = new EventSource(url, { withCredentials: true });
    state.sse = es;

    es.addEventListener('connected', () => {
      el('sse-dot').classList.add('online');
    });

    const triggerRefresh = () => {
      if (!document.hidden) refreshStatusAndTasks();
    };
    es.addEventListener('summary', (ev) => {
      if (document.hidden) return;
      try {
        const envelope = JSON.parse(ev.data || '{}');
        const events = Array.isArray(envelope.events) ? envelope.events : [];
        let needsStatus = false;
        let needsKnowledge = false;
        for (const item of events) {
          const t = String(item.eventType || '');
          if (t === 'knowledge.updated') {
            needsKnowledge = true;
          } else {
            needsStatus = true;
          }
        }
        if (needsStatus) refreshStatusAndTasks();
        if (needsKnowledge) refreshKnowledge();
      } catch {
        refreshStatusAndTasks();
      }
    });
    es.addEventListener('reload_required', () => {
      connectSse();
      if (!document.hidden) refreshAll();
    });
    es.addEventListener('task.created', triggerRefresh);
    es.addEventListener('task.updated', triggerRefresh);
    es.addEventListener('task.cancelled', triggerRefresh);
    es.addEventListener('swarm.mode_changed', triggerRefresh);
    es.addEventListener('swarm.profile_changed', triggerRefresh);
    es.addEventListener('bot.safe_stop', triggerRefresh);
    es.addEventListener('knowledge.updated', () => {
      if (!document.hidden) refreshKnowledge();
    });
    es.onerror = () => {
      el('sse-dot').classList.remove('online');
    };
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function tdText(text) {
    const td = document.createElement('td');
    td.textContent = text === null || text === undefined ? '—' : String(text);
    return td;
  }

  function nextWorkerId(workers) {
    const ids = new Set((workers || []).map((worker) => String(worker.workerId)));
    let index = 1;
    while (ids.has('worker-' + index)) index += 1;
    return 'worker-' + index;
  }

  function occupiedBotNumbers(bots) {
    return new Set((bots || [])
      .map((bot) => String(bot.botId || '').match(/(?:^|[-_])(\d+)$/))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .filter((number) => Number.isSafeInteger(number) && number >= 1 && number <= 20));
  }

  function nextBotStartIndex(bots, count) {
    const occupied = occupiedBotNumbers(bots);
    const botCount = Math.max(1, Number(count) || 1);
    for (let start = 1; start + botCount - 1 <= 20; start += 1) {
      if (Array.from({ length: botCount }, (_, i) => start + i).every((n) => !occupied.has(n))) return start;
    }
    return '';
  }

  function drawSurroundings(st) {
    const canvas = el('surroundings-canvas');
    const caption = el('surroundings-caption');
    if (!canvas || !caption) return;
    const width = Math.max(320, Math.floor(canvas.clientWidth || 720));
    const height = 320;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1118';
    ctx.fillRect(0, 0, width, height);

    const bots = (st.bots || []).map((b) => ({
      id: b.botId,
      position: b.snapshot && b.snapshot.position,
      state: b.connectionState
    })).filter((b) => b.position && Number.isFinite(b.position.x) && Number.isFinite(b.position.z));
    const knowledge = st.worldKnowledge || {};
    const groups = [
      { key: 'resources', color: '#f4c95d', name: 'resources' },
      { key: 'hazards', color: '#ff6b6b', name: 'hazards' },
      { key: 'bases', color: '#5ee0aa', name: 'bases' },
      { key: 'structures', color: '#56b4e9', name: 'structures' },
      { key: 'storage', color: '#c39bff', name: 'storage' }
    ];
    const observations = groups.flatMap((group) => (knowledge[group.key] || [])
      .filter((entry) => entry.pos && Number.isFinite(entry.pos.x) && Number.isFinite(entry.pos.z))
      .map((entry) => ({ ...entry, color: group.color, kind: group.name })));
    const points = [...bots.map((b) => b.position), ...observations.map((o) => o.pos)];
    const center = points.length
      ? { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, z: points.reduce((sum, p) => sum + p.z, 0) / points.length }
      : { x: 0, z: 0 };
    const radius = 64;
    const scale = Math.min((width - 72) / (radius * 2), (height - 50) / (radius * 2));
    const originX = width / 2;
    const originY = height / 2;
    const screen = (p) => ({ x: originX + (p.x - center.x) * scale, y: originY + (p.z - center.z) * scale });

    ctx.strokeStyle = 'rgba(148, 163, 184, .14)';
    ctx.lineWidth = 1;
    for (let block = -radius; block <= radius; block += 16) {
      const px = originX + block * scale;
      const py = originY + block * scale;
      ctx.beginPath(); ctx.moveTo(px, 20); ctx.lineTo(px, height - 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(36, py); ctx.lineTo(width - 36, py); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(226, 232, 240, .5)';
    ctx.beginPath(); ctx.moveTo(originX, 20); ctx.lineTo(originX, height - 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(36, originY); ctx.lineTo(width - 36, originY); ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('X ' + Math.round(center.x), 8, 16);
    ctx.fillText('Z ' + Math.round(center.z), 8, height - 8);

    for (const item of observations) {
      const p = screen(item.pos);
      ctx.fillStyle = item.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    for (const bot of bots) {
      const p = screen(bot.position);
      ctx.fillStyle = bot.state === 'ready' ? '#fff' : '#94a3b8';
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e2e8f0'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(bot.id, p.x + 9, p.y - 8);
    }
    const dimension = bots.length && st.bots.find((b) => b.botId === bots[0].id)?.snapshot?.dimension;
    caption.textContent = bots.length + ' positioned bot' + (bots.length === 1 ? '' : 's') + ' · ' + observations.length +
      ' current known observation' + (observations.length === 1 ? '' : 's') + ' · centered near swarm' +
      (dimension ? ' · ' + dimension : '') + '. Map shows reports only; unseen terrain is not guessed.';
  }

  function hasFiniteCoordinate(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function positionKey(position) {
    if (!position || ![position.x, position.y, position.z].every(hasFiniteCoordinate)) return null;
    return [Number(position.x), Number(position.y), Number(position.z)].join(',');
  }

  function sampleBotMovement(st) {
    const changedBotIds = new Set();
    const seen = new Set();
    const nowMs = Date.now();
    for (const bot of st.bots || []) {
      const botId = String(bot.botId || '');
      if (!botId) continue;
      seen.add(botId);
      const position = bot.snapshot?.position;
      const key = positionKey(position);
      if (!key) continue;
      const revision = String(bot.updatedAt || bot.snapshot?.capturedAt || key);
      const revisionTimeMs = Date.parse(revision);
      const previous = state.botMotionById.get(botId);
      if (previous && previous.revision === revision) continue;
      if (previous && Number.isFinite(revisionTimeMs) && Number.isFinite(previous.revisionTimeMs) && revisionTimeMs < previous.revisionTimeMs) continue;
      const next = previous || { revision: '', revisionTimeMs: null, position: null, receivedAtMs: null, latestTelemetryAtMs: null, lastMovedAtMs: null, speedSamples: [] };
      const receivedAtMs = nowMs;
      if (previous && previous.position && previous.receivedAtMs) {
        const distance = window.NexusBotMetrics.distance3D(previous.position, position);
        const elapsedSec = (receivedAtMs - previous.receivedAtMs) / 1000;
        if (Number.isFinite(distance) && distance > 0.1) {
          next.lastMovedAtMs = receivedAtMs;
          changedBotIds.add(botId);
          if (elapsedSec >= 0.5 && elapsedSec <= 30) {
            const speed = distance / elapsedSec;
            if (speed >= 0.15 && speed <= 10) {
              next.speedSamples.push({ speed, atMs: receivedAtMs });
              next.speedSamples = next.speedSamples.filter((sample) => receivedAtMs - sample.atMs <= 30_000).slice(-5);
            }
          }
        }
      } else {
        next.lastMovedAtMs = receivedAtMs;
      }
      next.revision = revision;
      if (Number.isFinite(revisionTimeMs)) next.revisionTimeMs = revisionTimeMs;
      next.position = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
      next.receivedAtMs = receivedAtMs;
      next.latestTelemetryAtMs = receivedAtMs;
      state.botMotionById.set(botId, next);
    }
    for (const botId of state.botMotionById.keys()) {
      if (!seen.has(botId)) {
        state.botMotionById.delete(botId);
        state.gotoEtaByBot.delete(botId);
      }
    }
    return changedBotIds;
  }

  function refreshGotoEtaEstimates(st, changedBotIds) {
    const nowMs = Date.now();
    const activeGotoIds = new Set();
    for (const bot of st.bots || []) {
      const botId = String(bot.botId || '');
      const tactical = bot.tacticalState || {};
      if (tactical.mode !== 'goto' || !tactical.targetPosition || !bot.snapshot?.position) {
        if (state.gotoEtaByBot.has(botId)) state.gotoEtaByBot.delete(botId);
        continue;
      }
      activeGotoIds.add(botId);
      const target = tactical.targetPosition;
      const targetKey = positionKey(target);
      const distance = window.NexusBotMetrics.distance3D(bot.snapshot.position, target);
      const motion = state.botMotionById.get(botId);
      const estimate = window.NexusBotMetrics.deriveGotoEta({
        distance,
        speedSamples: motion?.speedSamples || [],
        nowMs,
        latestTelemetryAtMs: motion?.latestTelemetryAtMs,
        lastMovedAtMs: motion?.lastMovedAtMs
      });
      const previous = state.gotoEtaByBot.get(botId);
      const changedTarget = !previous || previous.targetKey !== targetKey;
      const freshPosition = changedBotIds.has(botId);
      let etaAtMs = changedTarget ? null : previous.etaAtMs;
      if (estimate.status === 'estimated' && (changedTarget || freshPosition || !Number.isFinite(etaAtMs))) {
        etaAtMs = nowMs + estimate.seconds * 1000;
      } else if (estimate.status !== 'estimated') {
        etaAtMs = null;
      }
      state.gotoEtaByBot.set(botId, { targetKey, target: { x: Number(target.x), y: Number(target.y), z: Number(target.z) }, distance, estimate, etaAtMs, measuredAtMs: nowMs });
    }
    for (const botId of state.gotoEtaByBot.keys()) {
      if (!activeGotoIds.has(botId)) state.gotoEtaByBot.delete(botId);
    }
  }

  function formatTelemetryAge(updatedAt) {
    const timestamp = Date.parse(updatedAt || '');
    if (!Number.isFinite(timestamp)) return 'Age unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return 'Updated ' + seconds + 's ago';
    if (seconds < 3600) return 'Updated ' + Math.floor(seconds / 60) + 'm ago';
    return 'Updated ' + Math.floor(seconds / 3600) + 'h ago';
  }

  function formatBotCoordinate(value) {
    return hasFiniteCoordinate(value) ? Number(value).toFixed(1).replace(/\.0$/, '') : 'unknown';
  }

  function appendBotMetric(parent, label, value, detail = '') {
    const metric = document.createElement('div');
    metric.className = 'bot-detail-metric';
    const title = document.createElement('span');
    title.className = 'bot-detail-label';
    title.textContent = label;
    const main = document.createElement('strong');
    main.textContent = value;
    metric.append(title, main);
    if (detail) {
      const secondary = document.createElement('small');
      secondary.textContent = detail;
      metric.appendChild(secondary);
    }
    parent.appendChild(metric);
    return metric;
  }

  function gotoCountdownText(botId) {
    const eta = state.gotoEtaByBot.get(botId);
    if (!eta) return 'No active /goto order';
    const nowMs = Date.now();
    const recalculated = window.NexusBotMetrics.deriveGotoEta({
      distance: eta.distance,
      speedSamples: state.botMotionById.get(botId)?.speedSamples || [],
      nowMs,
      latestTelemetryAtMs: state.botMotionById.get(botId)?.latestTelemetryAtMs,
      lastMovedAtMs: state.botMotionById.get(botId)?.lastMovedAtMs
    });
    if (recalculated.status === 'near_target') return 'Within 1.5 blocks · waiting for worker arrival confirmation';
    if (recalculated.status === 'stale') return 'ETA paused · bot telemetry is stale';
    if (recalculated.status === 'stationary') return 'ETA unavailable · no recent movement observed';
    if (recalculated.status === 'sampling') return 'Measuring movement · ETA not available yet';
    if (recalculated.status !== 'estimated' || !Number.isFinite(eta.etaAtMs)) return 'ETA unavailable';
    const remaining = Math.max(0, Math.ceil((eta.etaAtMs - nowMs) / 1000));
    return 'Estimated arrival in ' + window.NexusBotMetrics.formatCountdown(remaining);
  }

  function updateBotCountdownLabels() {
    const labels = document.querySelectorAll('[data-goto-countdown-bot]');
    for (const label of labels) label.textContent = gotoCountdownText(label.dataset.gotoCountdownBot);
  }

  function renderBotDetailCards(st) {
    const grid = el('bot-detail-grid');
    if (!grid) return;
    clearChildren(grid);
    const bots = st.bots || [];
    if (bots.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No registered bots yet. Bot details appear here when workers report real telemetry.';
      grid.appendChild(empty);
      return;
    }
    const assignments = new Map((st.activeAssignments || []).map((assignment) => [String(assignment.botId), assignment]));
    for (const bot of bots) {
      const botId = String(bot.botId || 'unknown');
      const snap = bot.snapshot || {};
      const card = document.createElement('article');
      card.className = 'bot-detail-card';
      const header = document.createElement('div');
      header.className = 'bot-detail-card-heading';
      const title = document.createElement('h3');
      title.textContent = bot.username ? bot.username + ' · ' + botId : botId;
      const status = document.createElement('span');
      status.className = 'bot-state-badge ' + String(bot.connectionState || 'unknown').toLowerCase();
      status.textContent = String(bot.connectionState || 'unknown') + (bot.enabled ? '' : ' · disabled');
      header.append(title, status);
      card.appendChild(header);

      const vitals = document.createElement('div');
      vitals.className = 'bot-vitals-grid';
      for (const vital of [
        { name: 'Health', value: snap.health, band: snap.healthBand, unit: 'HP' },
        { name: 'Hunger', value: snap.food, band: snap.foodBand, unit: '/ 20' }
      ]) {
        const wrap = document.createElement('div');
        wrap.className = 'bot-vital';
        const label = document.createElement('div');
        label.className = 'bot-detail-label';
        label.textContent = vital.name;
        const value = document.createElement('strong');
        value.textContent = Number.isFinite(vital.value) ? Number(vital.value).toFixed(1) + ' ' + vital.unit : 'Unknown';
        wrap.append(label, value);
        if (Number.isFinite(vital.value)) {
          const bar = document.createElement('progress');
          bar.max = 20;
          bar.value = Math.max(0, Math.min(20, vital.value));
          bar.setAttribute('aria-label', vital.name + ' ' + value.textContent);
          wrap.appendChild(bar);
        }
        const band = document.createElement('small');
        band.textContent = 'Condition: ' + String(vital.band || 'unknown');
        wrap.appendChild(band);
        vitals.appendChild(wrap);
      }
      card.appendChild(vitals);

      const metrics = document.createElement('div');
      metrics.className = 'bot-detail-metrics';
      const position = snap.position;
      appendBotMetric(metrics, 'Position', position
        ? formatBotCoordinate(position.x) + ', ' + formatBotCoordinate(position.y) + ', ' + formatBotCoordinate(position.z)
        : 'Unknown', String(snap.dimension || 'Dimension unknown'));
      appendBotMetric(metrics, 'Worker / server', String(bot.workerId || 'unknown'), String(bot.serverId || 'server unknown'));
      appendBotMetric(metrics, 'Current action', assignments.get(botId)
        ? String(assignments.get(botId).actionType || 'working') + (assignments.get(botId).resourceId ? ' · ' + assignments.get(botId).resourceId : '')
        : (bot.tacticalState?.mode && bot.tacticalState.mode !== 'idle' ? String(bot.tacticalState.mode) : 'Idle'),
      assignments.has(botId) ? 'Verified progress ' + String(assignments.get(botId).creditedQuantity ?? 0) +
        (assignments.get(botId).quotaQuantity !== null ? ' / ' + assignments.get(botId).quotaQuantity : '') : 'No active task lease');
      const tool = snap.activeTool;
      appendBotMetric(metrics, 'Held tool', tool ? String(tool.name || tool.itemKey || 'unknown') : 'None reported',
        tool ? 'Durability: ' + String(tool.durabilityBand || (Number.isFinite(tool.remainingDurability) ? tool.remainingDurability + ' remaining' : 'unknown')) : '');
      appendBotMetric(metrics, 'Inventory space', Number.isFinite(snap.freeSlots) ? snap.freeSlots + ' free slots' : 'Unknown',
        Number.isFinite(snap.occupiedSlots) ? snap.occupiedSlots + ' occupied slots' : '');
      appendBotMetric(metrics, 'Telemetry', formatTelemetryAge(bot.updatedAt), 'Connection: ' + String(bot.connectionState || 'unknown'));
      card.appendChild(metrics);

      const items = Object.entries(snap.itemCounts || {})
        .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 8);
      const inventory = document.createElement('div');
      inventory.className = 'bot-inventory-summary';
      const inventoryHeading = document.createElement('strong');
      inventoryHeading.textContent = 'Inventory snapshot';
      const inventoryText = document.createElement('p');
      inventoryText.textContent = items.length ? items.map(([name, count]) => String(name).replace(/^minecraft:/, '') + ' × ' + count).join(' · ') : 'No item counts reported';
      inventory.append(inventoryHeading, inventoryText);
      card.appendChild(inventory);

      if (bot.tacticalState?.mode === 'goto' && bot.tacticalState.targetPosition) {
        const target = bot.tacticalState.targetPosition;
        const navigation = document.createElement('div');
        navigation.className = 'bot-goto-countdown';
        const label = document.createElement('strong');
        label.textContent = ' /goto → ' + [target.x, target.y, target.z].map(formatBotCoordinate).join(', ');
        const countdown = document.createElement('span');
        countdown.dataset.gotoCountdownBot = botId;
        countdown.textContent = gotoCountdownText(botId);
        navigation.append(label, countdown);
        card.appendChild(navigation);
      }
      grid.appendChild(card);
    }
  }

  function renderStatus(st) {
    state.lastStatus = st;
    const changedBotIds = sampleBotMovement(st);
    refreshGotoEtaEstimates(st, changedBotIds);
    renderBotDetailCards(st);
    if (st.envProfile) state.envProfile = st.envProfile;
    const masterUrlInput = el('add-worker-master-url');
    if (masterUrlInput && !masterUrlInput.value) masterUrlInput.value = window.location.origin;
    const workerInput = el('add-worker-id');
    const knownWorkers = new Set((st.workers || []).map((worker) => String(worker.workerId)));
    if (!workerInput.value || knownWorkers.has(workerInput.value.trim())) workerInput.value = nextWorkerId(st.workers);
    const startInput = el('add-worker-start-index');
    const count = Number(el('add-worker-count').value) || 1;
    const occupied = occupiedBotNumbers(st.bots);
    const start = Number(startInput.value);
    const overlaps = Number.isInteger(start) && Array.from({ length: count }, (_, i) => start + i).some((n) => occupied.has(n));
    if (!startInput.value || overlaps) startInput.value = nextBotStartIndex(st.bots, count);
    el('kpi-mode').textContent = st.operatingMode || 'HYBRID';
    el('kpi-governor').textContent = 'Governor: ' + st.governorState + ' (' + st.performanceProfile + ')';
    el('mode-select').value = st.operatingMode || 'HYBRID';
    el('profile-select').value = st.performanceProfile || 'BALANCED';
    el('bot-cap-input').value = st.enabledBotsCap;
    el('bot-cap-input').max = st.globalMaxBots || 20;

    const sw = st.swarmState || {};
    el('kpi-bots').textContent = (sw.onlineBotCount || 0) + ' / ' + (sw.busyBotCount || 0) + ' / ' + st.enabledBotsCap;
    el('kpi-workers').textContent = 'Workers registered: ' + (st.workers ? st.workers.length : 0);
    el('kpi-tasks').textContent = (sw.availableTaskCount || 0) + ' / ' + (sw.blockedTaskCount || 0);
    el('kpi-objectives').textContent = 'Completed objectives: ' + (sw.completedObjectiveCount || 0);

    const rssBytes = st.resources && st.resources.memory ? st.resources.memory.rssBytes : 0;
    const lagP95 = st.resources && st.resources.eventLoopDelayMs ? st.resources.eventLoopDelayMs.p95 : 0;
    el('kpi-rss').textContent = (rssBytes / (1024 * 1024)).toFixed(1) + ' MiB';
    el('kpi-lag').textContent = 'Loop p95: ' + Number(lagP95 || 0).toFixed(1) + ' ms';

    drawSurroundings(st);

    // Active assignments
    const asgBody = el('active-assignments-tbody');
    clearChildren(asgBody);
    const activeAsgs = st.activeAssignments || [];
    if (activeAsgs.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No active bot leases running.');
      td.colSpan = 6;
      td.className = 'muted';
      tr.appendChild(td);
      asgBody.appendChild(tr);
    } else {
      for (const a of activeAsgs) {
        const tr = document.createElement('tr');
        tr.appendChild(tdText(a.botId));
        tr.appendChild(tdText(a.actionType + (a.resourceId ? ' (' + a.resourceId + ')' : '')));
        tr.appendChild(tdText(a.quotaQuantity !== null ? (a.creditedQuantity + ' / ' + a.quotaQuantity) : 'role/spatial'));
        tr.appendChild(tdText(a.partitionId || a.role || 'single'));
        tr.appendChild(tdText('e' + a.allocationEpoch));
        tr.appendChild(tdText(a.state));
        asgBody.appendChild(tr);
      }
    }

    // Recent scheduler decisions
    const decBody = el('decisions-tbody');
    clearChildren(decBody);
    const decs = st.recentDecisions || [];
    if (decs.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No scheduler decisions recorded yet.');
      td.colSpan = 5;
      td.className = 'muted';
      tr.appendChild(td);
      decBody.appendChild(tr);
    } else {
      for (const d of decs) {
        const tr = document.createElement('tr');
        tr.appendChild(tdText(d.reason));
        tr.appendChild(tdText((d.selectedBotIds || []).join(', ')));
        tr.appendChild(tdText(d.singleBotP90Sec ? d.singleBotP90Sec.toFixed(1) + 's' : '—'));
        tr.appendChild(tdText(d.selectedSubsetP90Sec ? d.selectedSubsetP90Sec.toFixed(1) + 's' : '—'));
        tr.appendChild(tdText(((d.marginalGain || 0) * 100).toFixed(0) + '%'));
        decBody.appendChild(tr);
      }
    }

    // Safe-mode recovery button visibility
    const exitSafeBtn = el('exit-safemode-btn');
    if (exitSafeBtn) {
      if (st.safeMode) exitSafeBtn.classList.remove('hidden');
      else exitSafeBtn.classList.add('hidden');
    }

    // Workers
    const wBody = el('workers-tbody');
    clearChildren(wBody);
    for (const w of st.workers || []) {
      const tr = document.createElement('tr');
      tr.appendChild(tdText(w.workerId));
      tr.appendChild(tdText(w.hostname));
      tr.appendChild(tdText(w.status));
      tr.appendChild(tdText(w.maxBotSlots));
      tr.appendChild(tdText(w.lastHeartbeatAt || 'never'));

      const wCtrlTd = document.createElement('td');
      if (w.status !== 'disabled') {
        const revBtn = document.createElement('button');
        revBtn.className = 'btn danger small';
        revBtn.textContent = 'Revoke';
        revBtn.onclick = async () => {
          try {
            await api('/api/v1/workers/' + encodeURIComponent(w.workerId) + '/revoke', {
              method: 'POST',
              body: { reason: 'dashboard_revoked' }
            });
            showToast('Revoked worker ' + w.workerId);
            refreshStatusAndTasks();
          } catch (err) {
            showToast(err.message, true);
          }
        };
        wCtrlTd.appendChild(revBtn);
      } else {
        wCtrlTd.textContent = 'revoked';
        wCtrlTd.className = 'muted';
      }
      tr.appendChild(wCtrlTd);
      wBody.appendChild(tr);
    }
    if ((st.workers || []).length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No WorkerHosts enrolled yet. Mint a Bootstrap Token above to enroll a worker.');
      td.colSpan = 6;
      td.className = 'muted';
      tr.appendChild(td);
      wBody.appendChild(tr);
    }

    // Bots
    const bBody = el('bots-tbody');
    clearChildren(bBody);
    const pvpBotSel = el('pvp-bot-select');
    const prevPvpBot = pvpBotSel ? pvpBotSel.value : '*';
    if (pvpBotSel) {
      clearChildren(pvpBotSel);
      const allOpt = document.createElement('option');
      allOpt.value = '*';
      allOpt.textContent = 'Entire Swarm (All Bots)';
      pvpBotSel.appendChild(allOpt);
    }

    for (const b of st.bots || []) {
      if (pvpBotSel) {
        const opt = document.createElement('option');
        opt.value = b.botId;
        opt.textContent = b.username + ' (' + b.botId + ')';
        if (b.botId === prevPvpBot) opt.selected = true;
        pvpBotSel.appendChild(opt);
      }

      const tr = document.createElement('tr');
      const botTd = document.createElement('td');
      const skinId = (b.skin && b.skin.skinId) || 'knight_crimson';
      const skinObj = state.skinsById[skinId];
      if (skinObj && skinObj.preview) {
        botTd.appendChild(createSkinHeadCanvas(skinObj.preview, 3));
      }
      const nameSpan = document.createElement('span');
      const tacLabel =
        b.tacticalState && b.tacticalState.mode && b.tacticalState.mode !== 'idle'
          ? ' [' + b.tacticalState.mode + (b.tacticalState.targetPlayer ? ':' + b.tacticalState.targetPlayer : '') + ']'
          : '';
      nameSpan.textContent = b.botId + ' (' + b.username + ')' + tacLabel;
      botTd.appendChild(nameSpan);
      tr.appendChild(botTd);

      tr.appendChild(tdText(b.workerId));
      tr.appendChild(tdText(b.connectionState));
      const snap = b.snapshot || {};
      const posStr = snap.position ? (snap.position.x + ',' + snap.position.y + ',' + snap.position.z) : '—';
      tr.appendChild(tdText(posStr + ' | H:' + (snap.healthBand || '?') + ' F:' + (snap.foodBand || '?')));

      const ctrlTd = document.createElement('td');
      const grp = document.createElement('div');
      grp.className = 'action-group';
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn danger small';
      stopBtn.textContent = 'Safe Stop';
      stopBtn.onclick = async () => {
        try {
          await api('/api/v1/bots/' + encodeURIComponent(b.botId) + '/safe-stop', { method: 'POST', body: {} });
          showToast('Safe stop enqueued for ' + b.botId);
          refreshStatusAndTasks();
        } catch (err) {
          showToast(err.message, true);
        }
      };

      const reBtn = document.createElement('button');
      reBtn.className = 'btn small';
      reBtn.textContent = 'Reassign';
      reBtn.onclick = async () => {
        try {
          await api('/api/v1/bots/' + encodeURIComponent(b.botId) + '/reassign', { method: 'POST', body: { force: false } });
          showToast('Reassigned ' + b.botId);
          refreshStatusAndTasks();
        } catch (err) {
          showToast(err.message, true);
        }
      };
      grp.appendChild(stopBtn);
      grp.appendChild(reBtn);
      ctrlTd.appendChild(grp);
      tr.appendChild(ctrlTd);
      bBody.appendChild(tr);
    }
    if ((st.bots || []).length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('0 bots registered (real state — no fake bots shown).');
      td.colSpan = 5;
      td.className = 'muted';
      tr.appendChild(td);
      bBody.appendChild(tr);
    }

    // Resources
    const rBody = el('resources-tbody');
    clearChildren(rBody);
    const avail = (sw.availableResources || {});
    const req = (sw.requiredResources || {});
    const allResKeys = Array.from(new Set(Object.keys(avail).concat(Object.keys(req)))).sort();
    if (allResKeys.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No held or required resources currently tracked.');
      td.colSpan = 3;
      td.className = 'muted';
      tr.appendChild(td);
      rBody.appendChild(tr);
    } else {
      for (const key of allResKeys) {
        const tr = document.createElement('tr');
        tr.appendChild(tdText(key));
        tr.appendChild(tdText(avail[key] || 0));
        tr.appendChild(tdText(req[key] || 0));
        rBody.appendChild(tr);
      }
    }

    // Storage locks
    const lBody = el('storage-locks-tbody');
    clearChildren(lBody);
    const locks = st.storageLocks || [];
    if (locks.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No active chest mutex locks.');
      td.colSpan = 3;
      td.className = 'muted';
      tr.appendChild(td);
      lBody.appendChild(tr);
    } else {
      for (const l of locks) {
        const tr = document.createElement('tr');
        tr.appendChild(tdText(l.storageKey));
        tr.appendChild(tdText(l.holderBotId));
        tr.appendChild(tdText(l.expiresAt));
        lBody.appendChild(tr);
      }
    }

    // AI Brain & Perf boxes
    el('ai-brain-box').textContent = JSON.stringify(st.aiBrain || {}, null, 2);
    renderAiProviderControls(st.aiBrain);
    renderPlayersTable(st.players || []);
    el('perf-box').textContent = JSON.stringify(
      {
        governorState: st.governorState,
        performanceProfile: st.performanceProfile,
        directives: st.governorDirectives,
        persistence: st.persistence
      },
      null,
      2
    );

    // Audit events
    const aBody = el('audit-tbody');
    clearChildren(aBody);
    for (const ev of st.recentAudit || []) {
      const tr = document.createElement('tr');
      tr.appendChild(tdText(ev.occurredAt));
      tr.appendChild(tdText(ev.actorType + ':' + ev.actorId));
      tr.appendChild(tdText(ev.action));
      tr.appendChild(tdText(ev.outcome));
      aBody.appendChild(tr);
    }
  }

  async function refreshTasks() {
    const res = await api('/api/v1/tasks?limit=30');
    const tbody = el('tasks-tbody');
    clearChildren(tbody);
    const items = (res.items || []).filter((task) => task.state !== 'cancelled');
    if (items.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText(res.items?.length ? 'No visible tasks. Cancelled tasks are hidden.' : 'No tasks submitted yet.');
      td.colSpan = 4;
      td.className = 'muted';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const t of items) {
      const tr = document.createElement('tr');
      tr.appendChild(tdText(t.intentSummary || t.taskId));

      // Inline live priority selector for non-terminal tasks
      const prioTd = document.createElement('td');
      if (!['completed', 'cancelled', 'failed'].includes(t.state)) {
        const prioSel = document.createElement('select');
        for (const p of ['low', 'normal', 'high', 'safety', 'survival']) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === t.priority) opt.selected = true;
          prioSel.appendChild(opt);
        }
        prioSel.onchange = async () => {
          try {
            await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/priority', {
              method: 'POST',
              body: { priority: prioSel.value }
            });
            showToast('Updated priority to ' + prioSel.value);
            refreshStatusAndTasks();
          } catch (err) {
            showToast(err.message, true);
            refreshStatusAndTasks();
          }
        };
        prioTd.appendChild(prioSel);
      } else {
        prioTd.textContent = t.priority;
      }
      tr.appendChild(prioTd);

      tr.appendChild(tdText(t.state));

      const actTd = document.createElement('td');
      const grp = document.createElement('div');
      grp.className = 'action-group';

      const inspectBtn = document.createElement('button');
      inspectBtn.className = 'btn small';
      inspectBtn.textContent = 'Inspect';
      inspectBtn.onclick = async () => {
        const detail = await api('/api/v1/tasks/' + encodeURIComponent(t.taskId));
        el('task-detail-box').textContent = JSON.stringify(detail, null, 2);
      };
      grp.appendChild(inspectBtn);

      if (t.state === 'clarification_required') {
        const clarBtn = document.createElement('button');
        clarBtn.className = 'btn small primary';
        clarBtn.textContent = 'Clarify';
        clarBtn.onclick = () => {
          el('clarify-task-id').value = t.taskId;
          el('clarify-prompt-text').textContent =
            'Clarify task (' + (t.clarificationQuestion || 'Specify exact resource and quantity') + '):';
          el('clarify-banner').classList.remove('hidden');
          el('clarify-input').focus();
        };
        grp.appendChild(clarBtn);
      } else if (t.state === 'ready' || t.state === 'running') {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'btn small ghost';
        pauseBtn.textContent = 'Pause';
        pauseBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/pause', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        grp.appendChild(pauseBtn);
      } else if (t.state === 'paused') {
        const resBtn = document.createElement('button');
        resBtn.className = 'btn small primary';
        resBtn.textContent = 'Resume';
        resBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/resume', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        grp.appendChild(resBtn);
      }

      if (!['completed', 'cancelled', 'failed'].includes(t.state)) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn small danger';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/cancel', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        grp.appendChild(cancelBtn);
      }

      actTd.appendChild(grp);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    }
  }

  async function refreshKnowledge() {
    const res = await api('/api/v1/knowledge?limit=50');
    const tbody = el('knowledge-tbody');
    clearChildren(tbody);
    const items = res.items || [];
    if (items.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No active world knowledge entries recorded.');
      td.colSpan = 6;
      td.className = 'muted';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const k of items) {
      const tr = document.createElement('tr');
      tr.appendChild(tdText(k.category));
      tr.appendChild(tdText(k.subjectKey));
      tr.appendChild(tdText(k.position ? (k.position.x + ', ' + k.position.y + ', ' + k.position.z) : 'global'));
      tr.appendChild(tdText((k.confidence * 100).toFixed(0) + '%'));
      tr.appendChild(tdText(k.verificationState));
      tr.appendChild(tdText(k.expiresAt));
      tbody.appendChild(tr);
    }
  }

  async function refreshLogs() {
    try {
      const logs = await api('/api/v1/logs?limit=40');
      let cfg = null;
      if (state.actor && state.actor.role === 'admin') {
        cfg = await api('/api/v1/config').catch(() => null);
      }
      el('logs-box').textContent = JSON.stringify({ recentLogs: logs.entries, redactedConfig: cfg ? cfg.config : 'admin_only' }, null, 2);
    } catch {
      // ignore
    }
  }

  async function refreshStatusAndTasks() {
    try {
      const [st] = await Promise.all([api('/api/v1/status'), refreshTasks()]);
      renderStatus(st);
    } catch (err) {
      if (err.status === 401) {
        renderAuthScreen(false);
      }
    }
  }

  function applyQuantityOverride(rawCmdText) {
    const qtySel = el('noai-qty-override');
    if (!qtySel || qtySel.value === 'default') return rawCmdText;
    const n = Number(qtySel.value);
    if (!Number.isFinite(n) || n < 1) return rawCmdText;
    if (/^(mine|collect|craft|deposit)\s+\d+\s+/i.test(rawCmdText)) {
      return rawCmdText.replace(/^(mine|collect|craft|deposit)\s+\d+\s+/i, '$1 ' + n + ' ');
    }
    return rawCmdText;
  }

  async function dispatchNoAiCommandText(rawCmdText) {
    const text = applyQuantityOverride(String(rawCmdText || '').trim());
    if (!text) return;
    const prio = el('noai-priority') ? el('noai-priority').value : 'normal';
    try {
      const created = await api('/api/v1/tasks', {
        method: 'POST',
        body: { text, priority: prio }
      });
      showToast('Instant No-AI Dispatched: ' + (created.intentSummary || text) + ' [' + created.state + ']');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function aiChatStorageKey() {
    return 'nexus_ai_chat_' + String(state.actor?.principalId || 'operator');
  }

  function persistAiChatHistory() {
    state.aiChatHistory = state.aiChatHistory.slice(-40);
    try {
      sessionStorage.setItem(aiChatStorageKey(), JSON.stringify({
        messages: state.aiChatHistory,
        pendingClarificationTaskId: state.aiPendingClarificationTaskId
      }));
    } catch {
      // The live in-memory chat still works when browser storage is disabled.
    }
  }

  function restoreAiChatHistory() {
    state.aiChatHistory = [];
    state.aiPendingClarificationTaskId = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(aiChatStorageKey()) || '{}');
      if (Array.isArray(saved.messages)) {
        state.aiChatHistory = saved.messages.slice(-40).filter((message) =>
          message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
        ).map((message) => ({
          id: String(message.id || Date.now() + Math.random()),
          role: message.role,
          text: message.text.slice(0, 1200),
          status: String(message.status || 'complete')
        }));
      }
      state.aiPendingClarificationTaskId = typeof saved.pendingClarificationTaskId === 'string'
        ? saved.pendingClarificationTaskId
        : null;
    } catch {
      state.aiChatHistory = [];
      state.aiPendingClarificationTaskId = null;
    }
    renderAiChatHistory();
  }

  function renderAiChatHistory() {
    const log = el('ai-chat-messages');
    if (!log) return;
    clearChildren(log);
    if (state.aiChatHistory.length === 0) {
      const welcome = document.createElement('div');
      welcome.className = 'ai-chat-welcome';
      welcome.textContent = 'Tell the AI what you want the bots to accomplish. It can ask follow-up questions; task progress and verified completion are tracked separately.';
      log.appendChild(welcome);
      return;
    }
    for (const message of state.aiChatHistory) {
      const row = document.createElement('div');
      row.className = 'ai-chat-row ' + message.role + (message.status === 'pending' ? ' pending' : '');
      row.dataset.messageId = message.id;
      const label = document.createElement('span');
      label.className = 'ai-chat-speaker';
      label.textContent = message.role === 'user' ? 'YOU' : 'NEXUS AI';
      const bubble = document.createElement('p');
      bubble.className = 'ai-chat-bubble';
      bubble.textContent = message.text;
      row.append(label, bubble);
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
  }

  function addAiChatMessage(role, text, status = 'complete') {
    const id = window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random();
    state.aiChatHistory.push({ id, role, text: String(text).slice(0, 1200), status });
    persistAiChatHistory();
    renderAiChatHistory();
    return id;
  }

  function updateAiChatMessage(id, text, status = 'complete') {
    const message = state.aiChatHistory.find((entry) => entry.id === id);
    if (!message) return;
    message.text = String(text).slice(0, 1200);
    message.status = status;
    persistAiChatHistory();
    renderAiChatHistory();
  }

  function recentAiChatContext() {
    // Last two entries are this turn's user message and its pending assistant bubble.
    return state.aiChatHistory.slice(0, -2).slice(-8)
      .map((message) => (message.role === 'user' ? 'User: ' : 'Assistant: ') + message.text)
      .join('\n').slice(-1200);
  }

  function summarizeAiTask(task) {
    const name = task.intentSummary || task.rawText || 'requested task';
    if (task.state === 'clarification_required') {
      state.aiPendingClarificationTaskId = task.taskId;
      persistAiChatHistory();
      return 'I need one detail before I can make a safe plan: ' + (task.clarificationQuestion || 'Please clarify the request.') + '\nReply here to continue this same task; no work has been dispatched yet.';
    }
    state.aiPendingClarificationTaskId = null;
    persistAiChatHistory();
    if (task.state === 'failed') {
      return 'I could not create a valid task plan for “' + name + '”. Nothing is being reported as complete. Check the Tasks tab for details.';
    }
    if (task.state === 'paused') {
      return 'Plan queued for “' + name + '” (task ' + task.taskId + '); the workload governor has paused execution for now. It is not complete.';
    }
    return 'Task planned: “' + name + '” (task ' + task.taskId + ', state: ' + task.state + '). This is not a completion claim—worker evidence and verified progress are shown in Tasks.';
  }

  async function dispatchAiControlRequest(rawText) {
    const text = String(rawText || '').trim();
    if (!text || state.aiChatSending) return;
    addAiChatMessage('user', text);
    el('ai-control-input').value = '';
    const replyId = addAiChatMessage('assistant', 'Checking the active planner and building a validated task plan…', 'pending');
    state.aiChatSending = true;
    el('ai-control-submit').disabled = true;
    el('ai-chat-clear').disabled = true;
    el('ai-control-submit').textContent = 'Planning…';
    const isClarification = Boolean(state.aiPendingClarificationTaskId);
    const conversationContext = recentAiChatContext();
    try {
      let created;
      if (isClarification) {
        const taskId = state.aiPendingClarificationTaskId;
        created = await api('/api/v1/tasks/' + encodeURIComponent(taskId) + '/clarify', {
          method: 'POST',
          body: { answerText: text, forceAI: true, conversationContext }
        });
      } else {
        const status = state.lastStatus || await api('/api/v1/status');
        const activeProvider = (status.aiBrain?.providers || []).find((provider) => provider.active);
        if (!activeProvider || !activeProvider.available) {
          throw new Error('No AI provider is ready. Configure and activate Ollama in System & AI first.');
        }
        created = await api('/api/v1/tasks', {
          method: 'POST',
          body: {
            text,
            priority: 'normal',
            forceAI: true,
            ...(conversationContext ? { conversationContext } : {})
          }
        });
      }
      updateAiChatMessage(replyId, summarizeAiTask(created));
      refreshStatusAndTasks();
    } catch (err) {
      updateAiChatMessage(replyId, 'I could not safely submit that instruction: ' + err.message + '\nNo success is assumed. You can correct the request, configure the provider, or retry.');
    } finally {
      state.aiChatSending = false;
      el('ai-control-submit').disabled = false;
      el('ai-chat-clear').disabled = false;
      el('ai-control-submit').textContent = state.aiPendingClarificationTaskId ? 'Answer clarification' : 'Send instruction';
    }
  }

  async function refreshZeroAiDeck() {
    const requestSeq = ++state.noaiRequestSeq;
    try {
      const q =
        '/api/v1/commands?category=' +
        encodeURIComponent(state.noaiCategory || 'all') +
        '&search=' +
        encodeURIComponent(state.noaiSearch || '') +
        '&limit=' +
        state.noaiLimit +
        '&offset=' +
        state.noaiOffset;
      const deck = await api(q);
      if (requestSeq !== state.noaiRequestSeq) return;
      el('noai-total-badge').textContent = String(deck.totalCatalogCommands || 0);
      el('noai-matched-count').textContent = String(deck.matchedCount || 0);
      const activeCategory = state.noaiCategory === 'all' ? 'all categories' : state.noaiCategory.replace(/_/g, ' ');
      el('noai-active-filter').textContent = activeCategory;
      el('noai-category-summary').textContent = activeCategory;
      const pageNum = Math.floor((deck.offset || 0) / state.noaiLimit) + 1;
      const totalPages = Math.max(1, Math.ceil((deck.matchedCount || 0) / state.noaiLimit));
      el('noai-page-label').textContent = 'Page ' + pageNum + ' / ' + totalPages;
      el('noai-prev-btn').disabled = pageNum <= 1;
      el('noai-next-btn').disabled = pageNum >= totalPages || (deck.matchedCount || 0) === 0;

      // Category chips
      const catBar = el('noai-category-bar');
      clearChildren(catBar);
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'btn ghost small cat-chip' + (state.noaiCategory === 'all' ? ' active' : '');
      allBtn.textContent = 'All (' + deck.totalCatalogCommands + ')';
      allBtn.onclick = () => {
        state.noaiCategory = 'all';
        state.noaiOffset = 0;
        refreshZeroAiDeck();
      };
      catBar.appendChild(allBtn);

      for (const cat of deck.categories || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost small cat-chip' + (state.noaiCategory === cat.category ? ' active' : '');
        b.textContent = cat.category.replace(/_/g, ' ') + ' (' + cat.count + ')';
        b.onclick = () => {
          state.noaiCategory = cat.category;
          state.noaiOffset = 0;
          refreshZeroAiDeck();
        };
        catBar.appendChild(b);
      }

      // Command cards
      const grid = el('noai-grid');
      clearChildren(grid);
      for (const item of deck.commands || []) {
        const card = document.createElement('div');
        card.className = 'command-card';
        const top = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'command-card-title';
        title.textContent = item.label;
        const code = document.createElement('div');
        code.className = 'command-card-code';
        code.textContent = item.commandText;
        top.appendChild(title);
        top.appendChild(code);

        const foot = document.createElement('div');
        foot.className = 'command-card-footer';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = item.category.replace(/_/g, ' ');
        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'btn primary small';
        runBtn.textContent = 'Run (0 AI)';
        runBtn.onclick = () => dispatchNoAiCommandText(item.commandText);
        foot.appendChild(badge);
        foot.appendChild(runBtn);

        card.appendChild(top);
        card.appendChild(foot);
        grid.appendChild(card);
      }
      el('noai-empty-state').classList.toggle('hidden', (deck.commands || []).length > 0);
    } catch {
      // Keep the last rendered results if a transient search request fails.
    }
  }

  async function sendPlayerTacticalOrder(payload) {
    try {
      const res = await api('/api/v1/players/action', {
        method: 'POST',
        body: payload
      });
      showToast('Swarm Tactical Order: ' + res.mode + (res.targetPlayer ? ' -> ' + res.targetPlayer : ''));
      renderPlayersTable(res.players || []);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderPlayersTable(players) {
    const tbody = el('players-tbody');
    if (!tbody) return;
    clearChildren(tbody);
    const nonBots = (players || []).filter((p) => !p.isSwarmBot);
    if (nonBots.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No non-swarm players detected yet. Type any player name on the left to queue Follow / Protect / Kill / Drop-Loot.');
      td.colSpan = 5;
      td.className = 'muted';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const p of nonBots) {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'btn ghost small';
      nameBtn.textContent = p.username;
      nameBtn.onclick = () => {
        el('pvp-target-player').value = p.username;
      };
      nameTd.appendChild(nameBtn);
      tr.appendChild(nameTd);

      const relTd = document.createElement('td');
      const relBadge = document.createElement('span');
      relBadge.className =
        'badge ' + (p.relation === 'ally' ? 'badge-ally' : p.relation === 'kos' ? 'badge-kos' : '');
      relBadge.textContent = (p.relation || 'neutral').toUpperCase();
      relTd.appendChild(relBadge);
      tr.appendChild(relTd);

      const posStr = p.position ? (p.position.x + ',' + p.position.y + ',' + p.position.z) : 'out of view';
      const distStr = p.distance !== null && p.distance !== undefined ? ' (' + p.distance + 'm)' : '';
      tr.appendChild(tdText(posStr + distStr));
      tr.appendChild(tdText('HP:' + (p.health ?? '?') + ' | ' + (p.ping ?? '?') + 'ms'));

      const actTd = document.createElement('td');
      const grp = document.createElement('div');
      grp.className = 'action-group';
      const quickActs = [
        ['Follow', 'follow', 'btn small'],
        ['Protect', 'protect', 'btn accent-gold small'],
        ['Kill PvP', 'attack_player', 'btn danger small'],
        ['Drop Loot', 'drop_loot', 'btn small'],
        ['Ally', 'idle', 'btn ghost small', 'ally'],
        ['KOS', 'attack_player', 'btn danger small', 'kos']
      ];
      for (const [lbl, mode, cls, rel] of quickActs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = lbl;
        b.onclick = () => {
          el('pvp-target-player').value = p.username;
          sendPlayerTacticalOrder({
            mode,
            targetPlayer: p.username,
            botId: el('pvp-bot-select') ? el('pvp-bot-select').value : '*',
            preferredWeaponStyle: el('pvp-weapon-style') ? el('pvp-weapon-style').value : 'auto',
            itemFilter: el('pvp-loot-filter') ? el('pvp-loot-filter').value : null,
            relation: rel || null,
            preemptTask: true
          });
        };
        grp.appendChild(b);
      }
      actTd.appendChild(grp);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    }
  }

  function renderAiProviderControls(aiBrain) {
    if (!aiBrain || !Array.isArray(aiBrain.providers)) return;
    state.providersCache = aiBrain.providers;
    const sel = el('ai-provider-select');
    const statusLine = el('ai-provider-status');
    if (!sel) return;

    const currentFocus = document.activeElement === sel;
    if (!currentFocus) {
      const prevSelected = state.aiFormInitialized ? sel.value : aiBrain.activeProvider;
      clearChildren(sel);
      for (const p of aiBrain.providers) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = (p.label || p.name) + (p.active ? ' [ACTIVE]' : '');
        if (p.name === prevSelected) opt.selected = true;
        sel.appendChild(opt);
      }
      if (!state.aiFormInitialized) {
        state.aiFormInitialized = true;
        syncAiProviderFields(aiBrain.activeProvider);
      }
    }

    const activeMeta = aiBrain.providers.find((p) => p.name === aiBrain.activeProvider);
    const aiControlStatus = el('ai-control-status');
    if (aiControlStatus) {
      aiControlStatus.textContent = activeMeta?.available
        ? activeMeta.name === 'ollama'
          ? 'Ready: private Ollama is configured; AI planning requests are sent from the Master to your Ollama device.'
          : activeMeta.name === 'none'
            ? 'Ready: deterministic Zero-AI mode is active; supported tasks work without an LLM.'
            : 'Ready: ' + (activeMeta.label || activeMeta.name) + ' · provider charges may apply.'
        : 'AI not ready. Configure and activate Ollama under System & AI to use plain-language control.';
      aiControlStatus.classList.toggle('ai-control-ready', Boolean(activeMeta?.available));
    }
    if (statusLine && activeMeta) {
      statusLine.textContent =
        'Active Brain: ' +
        (activeMeta.label || activeMeta.name) +
        ' | Model: ' +
        (activeMeta.model || 'n/a') +
        ' | Key: ' +
        (activeMeta.hasApiKey ? activeMeta.maskedApiKey : activeMeta.requiresApiKey ? 'Not set (supported tasks use deterministic fallback)' : 'Not required');
    }
  }

  function syncAiProviderFields(providerName) {
    const p = state.providersCache.find((x) => x.name === providerName);
    if (!p) return;
    const modelIn = el('ai-model-input');
    const baseIn = el('ai-baseurl-input');
    const dl = el('ai-model-suggestions');
    if (modelIn) modelIn.value = p.model || '';
    if (baseIn) baseIn.value = p.baseUrl || '';
    if (dl) {
      clearChildren(dl);
      for (const m of p.suggestedModels || []) {
        const o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      }
    }
  }

  async function refreshSkinsAndSchematics() {
    try {
      const [skinsRes, schRes] = await Promise.all([
        api('/api/v1/skins'),
        api('/api/v1/schematics')
      ]);

      // Cache skins for head avatars
      const gallery = el('skin-gallery-grid');
      clearChildren(gallery);
      for (const sk of skinsRes.skins || []) {
        state.skinsById[sk.skinId] = sk;
        const card = document.createElement('div');
        card.className = 'skin-card skin-card-knight';

        const badge = document.createElement('span');
        badge.className = 'badge badge-knight';
        badge.textContent = sk.badge;
        card.appendChild(badge);

        card.appendChild(createSkinFullCanvas(sk.preview, 5));

        const title = document.createElement('div');
        title.className = 'command-card-title';
        title.textContent = sk.name;
        card.appendChild(title);

        const desc = document.createElement('div');
        desc.className = 'muted compact-sub';
        desc.textContent = sk.description;
        card.appendChild(desc);

        const actions = document.createElement('div');
        actions.className = 'action-group';
        const dlLink = document.createElement('a');
        dlLink.href = sk.pngUrl;
        dlLink.download = sk.skinId + '.png';
        dlLink.className = 'btn ghost small';
        dlLink.textContent = 'Download PNG';

        const applyAllBtn = document.createElement('button');
        applyAllBtn.type = 'button';
        applyAllBtn.className = 'btn small accent-red';
        applyAllBtn.textContent = 'Apply to All Bots';
        applyAllBtn.onclick = async () => {
          await api('/api/v1/skins/assign', { method: 'POST', body: { botId: '*', skinId: 'knight_crimson' } });
          showToast('Synced Crimson Shadow Knight skin across entire swarm');
          refreshSkinsAndSchematics();
          refreshStatusAndTasks();
        };

        actions.appendChild(dlLink);
        actions.appendChild(applyAllBtn);
        card.appendChild(actions);
        gallery.appendChild(card);
      }

      // Active Bot Skin Roster
      const bsBody = el('bot-skins-tbody');
      clearChildren(bsBody);
      const botSkins = skinsRes.botSkins || [];
      if (botSkins.length === 0) {
        const tr = document.createElement('tr');
        const td = tdText('Enroll a WorkerHost to see active Crimson Shadow Knight bots.');
        td.colSpan = 5;
        td.className = 'muted';
        tr.appendChild(td);
        bsBody.appendChild(tr);
      } else {
        for (const bs of botSkins) {
          const tr = document.createElement('tr');
          const avTd = document.createElement('td');
          const fullMeta = state.skinsById[bs.skin.skinId];
          if (fullMeta && fullMeta.preview) {
            avTd.appendChild(createSkinHeadCanvas(fullMeta.preview, 4));
          }
          tr.appendChild(avTd);
          tr.appendChild(tdText(bs.username + ' (' + bs.botId + ')'));

          const rankTd = document.createElement('td');
          const rb = document.createElement('span');
          rb.className = 'badge badge-knight';
          rb.textContent = 'CRIMSON KNIGHT';
          rankTd.appendChild(rb);
          tr.appendChild(rankTd);

          tr.appendChild(tdText(bs.skin.name));

          const syncTd = document.createElement('td');
          const syncBtn = document.createElement('button');
          syncBtn.type = 'button';
          syncBtn.className = 'btn small ghost';
          syncBtn.textContent = 'Re-Sync Skin';
          syncBtn.onclick = async () => {
            await api('/api/v1/skins/assign', {
              method: 'POST',
              body: { botId: bs.botId, skinId: 'knight_crimson' }
            });
            showToast('Re-synced Crimson Shadow Knight skin -> ' + bs.username);
            refreshSkinsAndSchematics();
            refreshStatusAndTasks();
          };
          syncTd.appendChild(syncBtn);
          tr.appendChild(syncTd);
          bsBody.appendChild(tr);
        }
      }

      // Schematics grid
      const schGrid = el('schematics-grid');
      clearChildren(schGrid);
      for (const sch of schRes.schematics || []) {
        const card = document.createElement('div');
        card.className = 'command-card';
        const top = document.createElement('div');
        const t = document.createElement('div');
        t.className = 'command-card-title';
        t.textContent = sch.name + ' [' + sch.dimensions + ']';
        const d = document.createElement('div');
        d.className = 'command-card-code';
        d.textContent = sch.description + ' (' + sch.blockCount + ' blocks)';
        top.appendChild(t);
        top.appendChild(d);

        const foot = document.createElement('div');
        foot.className = 'command-card-footer';
        const bdg = document.createElement('span');
        bdg.className = 'badge';
        bdg.textContent = sch.category;
        const buildBtn = document.createElement('button');
        buildBtn.type = 'button';
        buildBtn.className = 'btn accent-red small';
        buildBtn.textContent = 'Build Blueprint';
        buildBtn.onclick = async () => {
          try {
            await api('/api/v1/schematics/build', {
              method: 'POST',
              body: { schematicId: sch.schematicId }
            });
            showToast('Building Schematic: ' + sch.name);
            refreshStatusAndTasks();
          } catch (err) {
            showToast(err.message, true);
          }
        };
        foot.appendChild(bdg);
        foot.appendChild(buildBtn);
        card.appendChild(top);
        card.appendChild(foot);
        schGrid.appendChild(card);
      }
    } catch {
      // ignore
    }
  }

  async function refreshAutocompleteDictionary() {
    try {
      const res = await api('/api/v1/commands/autocomplete?dictionary=1');
      if (res && res.dictionary) {
        state.autocompleteDict = res.dictionary;
      }
    } catch {
      // ignore
    }
  }

  async function refreshAll() {
    await Promise.all([
      refreshAutocompleteDictionary(),
      refreshSkinsAndSchematics(),
      refreshStatusAndTasks(),
      refreshZeroAiDeck(),
      refreshKnowledge(),
      refreshLogs()
    ]);
  }

  // Event listeners
  el('auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    el('auth-error').classList.add('hidden');
    const username = el('auth-username').value.trim();
    const password = el('auth-password').value;
    const endpoint = state.bootstrapRequired ? '/api/v1/auth/setup' : '/api/v1/auth/login';
    try {
      const out = await api(endpoint, { method: 'POST', body: { username, password } });
      state.csrfToken = out.csrfToken;
      sessionStorage.setItem('nexus_csrf', out.csrfToken);
      el('auth-password').value = '';
      enterShell(out.actor);
    } catch (err) {
      el('auth-error').textContent = err.message;
      el('auth-error').classList.remove('hidden');
    }
  });

  el('logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST', body: {} });
    } catch {
      // ignore
    }
    state.csrfToken = null;
    sessionStorage.removeItem('nexus_csrf');
    if (state.sse) state.sse.close();
    clearInterval(state.pollTimer);
    clearInterval(state.botUiTimer);
    state.botUiTimer = null;
    state.botMotionById.clear();
    state.gotoEtaByBot.clear();
    renderAuthScreen(false);
  });

  el('mode-select').addEventListener('change', async (ev) => {
    try {
      await api('/api/v1/swarm/mode', { method: 'POST', body: { mode: ev.target.value } });
      showToast('Swarm mode switched to ' + ev.target.value);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('profile-select').addEventListener('change', async (ev) => {
    try {
      await api('/api/v1/swarm/profile', { method: 'POST', body: { profile: ev.target.value } });
      showToast('Performance profile switched to ' + ev.target.value);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('bot-cap-btn').addEventListener('click', async () => {
    try {
      const cap = Number(el('bot-cap-input').value);
      await api('/api/v1/swarm/bot-cap', { method: 'POST', body: { enabledBotsCap: cap } });
      showToast('Enabled bot cap updated to ' + cap);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('ai-control-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    dispatchAiControlRequest(el('ai-control-input').value);
  });
  el('ai-control-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      el('ai-control-form').requestSubmit();
    }
  });
  el('ai-control-config').addEventListener('click', () => {
    const systemTab = document.querySelector('.tab[data-tab="system"]');
    if (systemTab) systemTab.click();
  });
  el('ai-chat-clear').addEventListener('click', () => {
    state.aiChatHistory = [];
    state.aiPendingClarificationTaskId = null;
    persistAiChatHistory();
    renderAiChatHistory();
    el('ai-control-submit').textContent = 'Send instruction';
    el('ai-control-input').focus();
  });

  el('emergency-stop-btn').addEventListener('click', async () => {
    try {
      const out = await api('/api/v1/swarm/emergency-stop', { method: 'POST', body: {} });
      showToast('Emergency stop sent across ' + out.stoppedBots + ' bots');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('intent-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = el('intent-text').value.trim();
    const priority = el('intent-priority').value;
    if (!text) return;
    try {
      const created = await api('/api/v1/tasks', { method: 'POST', body: { text, priority } });
      el('intent-text').value = '';
      el('task-detail-box').textContent = JSON.stringify(created, null, 2);
      if (created.state === 'clarification_required') {
        el('clarify-task-id').value = created.taskId;
        el('clarify-prompt-text').textContent =
          'Clarify task (' + (created.clarificationQuestion || 'Specify exact resource and quantity') + '):';
        el('clarify-banner').classList.remove('hidden');
      }
      showToast('Task dispatched: ' + created.state);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      el('intent-text').value = chip.dataset.intent || '';
      el('intent-text').focus();
    });
  });

  el('clarify-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const taskId = el('clarify-task-id').value;
    const text = el('clarify-input').value.trim();
    if (!taskId || !text) return;
    try {
      const updated = await api('/api/v1/tasks/' + encodeURIComponent(taskId) + '/clarify', {
        method: 'POST',
        body: { text }
      });
      el('clarify-input').value = '';
      el('clarify-banner').classList.add('hidden');
      el('task-detail-box').textContent = JSON.stringify(updated, null, 2);
      showToast('Clarification applied: ' + updated.state);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  el('add-worker-count').addEventListener('input', () => {
    const status = state.lastStatus;
    if (!status) return;
    const count = Number(el('add-worker-count').value) || 1;
    const input = el('add-worker-start-index');
    const start = Number(input.value);
    const occupied = occupiedBotNumbers(status.bots);
    if (!Number.isInteger(start) || Array.from({ length: count }, (_, i) => start + i).some((n) => occupied.has(n))) {
      input.value = nextBotStartIndex(status.bots, count);
    }
  });

  el('add-worker-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const status = state.lastStatus || {};
      const workerId = el('add-worker-id').value.trim();
      const rawMasterUrl = el('add-worker-master-url').value.trim();
      let parsedMasterUrl;
      try { parsedMasterUrl = new URL(rawMasterUrl); }
      catch { throw new Error('Enter the Master URL that the Linux Worker can reach, such as http://192.168.1.20:3000.'); }
      if (!['http:', 'https:'].includes(parsedMasterUrl.protocol) || parsedMasterUrl.username || parsedMasterUrl.password || ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(parsedMasterUrl.hostname.toLowerCase())) {
        throw new Error('The worker cannot use localhost or 0.0.0.0. Enter the phone’s reachable LAN/VPN IP or DNS name.');
      }
      const masterUrl = parsedMasterUrl.origin;
      const count = Number(el('add-worker-count').value);
      const start = Number(el('add-worker-start-index').value);
      const prefix = el('add-worker-prefix').value.trim();
      const host = el('add-worker-mc-host').value.trim();
      const port = Number(el('add-worker-mc-port').value);
      const workerIds = new Set((status.workers || []).map((worker) => String(worker.workerId)));
      const occupied = occupiedBotNumbers(status.bots);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workerId) || workerIds.has(workerId)) throw new Error('Choose a unique Worker ID using letters, numbers, dot, underscore or hyphen.');
      if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(start) || start < 1 || start + count - 1 > 20) throw new Error('Choose a bot count and number range that fit within bot-01 to bot-20.');
      if (Array.from({ length: count }, (_, i) => start + i).some((n) => occupied.has(n))) throw new Error('That bot number range is already used. Choose the suggested free range.');
      if (!/^[A-Za-z0-9_]{2,12}$/.test(prefix)) throw new Error('Minecraft name prefix must be 2–12 letters, numbers or underscores.');
      if (!host || /\s/.test(host) || host.length > 255) throw new Error('Enter a Minecraft server hostname without spaces.');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Server port must be from 1 to 65535.');
      const existingCount = (status.bots || []).length;
      if (existingCount + count > Number(status.enabledBotsCap || 0)) throw new Error('Increase Bot Cap to at least ' + (existingCount + count) + ' before adding these bots.');
      if (existingCount + count > Number(status.globalMaxBots || 20)) throw new Error('This would exceed the Master global bot limit.');

      const minted = await api('/api/v1/workers/bootstrap-token', { method: 'POST', body: {} });
      const vars = [
        ['SWARM_ROLE', 'worker'], ['SWARM_ENV_PROFILE', state.envProfile || 'private_offline_test'],
        ['SWARM_MASTER_URL', masterUrl], ['SWARM_BOOTSTRAP_TOKEN', minted.bootstrapToken],
        ['SWARM_WORKER_ID', workerId], ['SWARM_WORKER_STATE_PATH', './data/' + workerId + '-state.json'],
        ['SWARM_MC_HOST', host], ['SWARM_MC_PORT', port], ['SWARM_SPAWN_STAGGER_MS', 4000],
        ['SWARM_BOT_NAME_PREFIX', prefix], ['SWARM_WORKER_BOT_COUNT', count], ['SWARM_WORKER_BOT_START_INDEX', start]
      ];
      const command = vars.map(([key, value]) => key + '=' + shellQuote(value)).join(' ') + ' npm run start:worker';
      const box = el('bootstrap-token-output');
      clearChildren(box);
      const token = document.createElement('p');
      token.textContent = 'Single-use bootstrap token (expires ' + minted.expiresAt + '): ' + minted.bootstrapToken;
      const note = document.createElement('p');
      note.textContent = 'Run this command from the project folder on a Node.js machine that can reach the Master and Minecraft server. Keep the token private.';
      const code = document.createElement('code');
      code.className = 'worker-launch-command';
      code.textContent = command;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn small';
      copy.textContent = 'Copy launch command';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(command); showToast('Launch command copied'); }
        catch { showToast('Clipboard unavailable; select and copy the command manually.', true); }
      });
      box.append(token, note, code, copy);
      box.classList.remove('hidden');
      showToast('Worker enrollment command generated.');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('backup-db-btn').addEventListener('click', async () => {
    try {
      const out = await api('/api/v1/system/backup', { method: 'POST', body: {} });
      const box = el('backup-output');
      box.textContent = 'Verified WAL Backup saved (' + out.bytes + ' bytes): ' + out.backupPath;
      box.classList.remove('hidden');
      showToast('Verified SQLite backup completed');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('exit-safemode-btn').addEventListener('click', async () => {
    try {
      await api('/api/v1/system/exit-safe-mode', { method: 'POST', body: {} });
      showToast('Exited read-only safe mode');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('knowledge-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const category = el('know-category').value;
    const subjectKey = el('know-subject').value.trim();
    const x = el('know-x').value !== '' ? Number(el('know-x').value) : null;
    const y = el('know-y').value !== '' ? Number(el('know-y').value) : null;
    const z = el('know-z').value !== '' ? Number(el('know-z').value) : null;
    try {
      await api('/api/v1/knowledge', {
        method: 'POST',
        body: {
          category,
          subjectKey,
          position: x !== null && y !== null && z !== null ? { x, y, z } : null
        }
      });
      el('know-subject').value = '';
      showToast('World knowledge saved');
      refreshKnowledge();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('create-user-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const username = el('new-user-name').value.trim();
      const password = el('new-user-pass').value;
      const role = el('new-user-role').value;
      await api('/api/v1/auth/principals', { method: 'POST', body: { username, password, role } });
      el('new-user-name').value = '';
      el('new-user-pass').value = '';
      showToast('Created principal ' + username + ' (' + role + ')');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('refresh-logs-btn').addEventListener('click', refreshLogs);

  // Zero-AI Deck Listeners
  document.querySelectorAll('.quick-noai-btn').forEach((btn) => {
    btn.addEventListener('click', () => dispatchNoAiCommandText(btn.dataset.cmd));
  });

  let searchTimer = null;
  el('noai-clear-search').addEventListener('click', () => {
    clearTimeout(searchTimer);
    el('noai-search-input').value = '';
    state.noaiSearch = '';
    state.noaiOffset = 0;
    refreshZeroAiDeck();
    el('noai-search-input').focus();
  });
  el('noai-search-input').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.noaiSearch = ev.target.value.trim();
      state.noaiOffset = 0;
      refreshZeroAiDeck();
    }, 180);
  });

  el('noai-freeform-btn').addEventListener('click', () => {
    const val = el('noai-freeform-input').value.trim();
    if (val) {
      dispatchNoAiCommandText(val);
      el('noai-freeform-input').value = '';
    }
  });
  el('noai-freeform-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      el('noai-freeform-btn').click();
    }
  });

  el('noai-prev-btn').addEventListener('click', () => {
    state.noaiOffset = Math.max(0, state.noaiOffset - state.noaiLimit);
    refreshZeroAiDeck();
  });
  el('noai-next-btn').addEventListener('click', () => {
    state.noaiOffset += state.noaiLimit;
    refreshZeroAiDeck();
  });

  // Players & Elite PvP Listeners
  document.querySelectorAll('.pvp-order-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const targetPlayer = el('pvp-target-player').value.trim();
      if (['follow', 'protect', 'attack_player', 'surround', 'drop_loot'].includes(mode) && !targetPlayer) {
        showToast('Enter or select a target player name first!', true);
        return;
      }
      sendPlayerTacticalOrder({
        mode,
        targetPlayer: targetPlayer || null,
        botId: el('pvp-bot-select').value,
        preferredWeaponStyle: el('pvp-weapon-style').value,
        itemFilter: el('pvp-loot-filter').value.trim() || null,
        autoEat: el('pvp-autoeat').checked,
        autoArmor: el('pvp-autoarmor').checked,
        preemptTask: el('pvp-preempt').checked
      });
    });
  });

  el('refresh-players-btn').addEventListener('click', async () => {
    try {
      const out = await api('/api/v1/players');
      renderPlayersTable(out.players || []);
      showToast('Refreshed server player roster');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Skin Presets & Custom Schematics
  document.querySelectorAll('.skin-preset-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/v1/skins/assign', {
          method: 'POST',
          body: { preset: btn.dataset.preset }
        });
        showToast('Applied Swarm Skin Formation: ' + btn.dataset.preset);
        refreshSkinsAndSchematics();
        refreshStatusAndTasks();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  async function saveCustomSchematic(andBuild) {
    const name = el('custom-sch-name').value.trim() || 'custom_structure';
    let parsed;
    try {
      parsed = JSON.parse(el('custom-sch-json').value);
    } catch (e) {
      showToast('Invalid Schematic JSON: ' + e.message, true);
      return;
    }
    parsed.name = name;
    try {
      const created = await api('/api/v1/schematics/custom', { method: 'POST', body: parsed });
      showToast('Registered Schematic: ' + created.schematic.name + ' (' + created.schematic.blockCount + ' blocks)');
      await refreshSkinsAndSchematics();
      if (andBuild) {
        await api('/api/v1/schematics/build', {
          method: 'POST',
          body: { schematicId: created.schematic.schematicId }
        });
        showToast('Dispatched Bot to Build ' + created.schematic.name);
        refreshStatusAndTasks();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  el('custom-schematic-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveCustomSchematic(false);
  });
  el('build-custom-sch-btn').addEventListener('click', () => saveCustomSchematic(true));

  // Multi-Provider AI Switcher
  el('ai-provider-select').addEventListener('change', (ev) => {
    syncAiProviderFields(ev.target.value);
  });
  el('ai-provider-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const provider = el('ai-provider-select').value;
      const model = el('ai-model-input').value.trim();
      const apiKey = el('ai-apikey-input').value.trim();
      const baseUrl = el('ai-baseurl-input').value.trim();
      const out = await api('/api/v1/ai/config', {
        method: 'POST',
        body: {
          provider,
          model: model || undefined,
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined
        }
      });
      el('ai-apikey-input').value = '';
      showToast('Switched Active AI Brain -> ' + out.activeProvider + ' (' + (out.updated?.model || 'default') + ')');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      el('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // =========================================================================
  // Minecraft Brigadier-Style Command Autocomplete (`Tab` / `Shift+Tab` / `/`)
  // =========================================================================
  const FALLBACK_AUTOCOMPLETE_DICT = {
    rootCommands: [
      { name: 'mine', syntax: 'mine <ore_or_block> [count]', category: 'mining', description: 'Mine ores or stone across swarm', hasArgs: true },
      { name: 'goto', syntax: 'goto <x> <y> <z> [bot]', category: 'navigation', description: 'Navigate to absolute Minecraft coordinates', hasArgs: true },
      { name: 'go', syntax: 'go <x> <y> <z> [bot]', category: 'navigation', description: 'Alias for goto', hasArgs: true },
      { name: 'tree', syntax: 'tree [count]', category: 'gathering', description: 'Chop nearby trees for logs', hasArgs: true },
      { name: 'food', syntax: 'food [bot]', category: 'survival', description: 'Hunt edible animals safely', hasArgs: true },
      { name: 'collect', syntax: 'collect <resource> [count]', category: 'gathering', description: 'Gather logs, crops or drops', hasArgs: true },
      { name: 'craft', syntax: 'craft <item> [count]', category: 'crafting', description: 'Auto-craft tools, mace, spears & armor', hasArgs: true },
      { name: 'smelt', syntax: 'smelt <item> [count]', category: 'smelting', description: 'Smelt ores or cook food in furnace', hasArgs: true },
      { name: 'kit', syntax: 'kit <progression_kit>', category: 'progression', description: 'Run full DAG kit (stone_tools, full_iron_kit, mace_pvp_kit...)', hasArgs: true },
      { name: 'build', syntax: 'build <schematic> [bot]', category: 'schematics', description: 'Construct 3D schematic blueprint', hasArgs: true },
      { name: 'kill', syntax: 'kill <player> [weapon] [bot]', category: 'pvp', description: 'Elite PvP attack on player', hasArgs: true },
      { name: 'follow', syntax: 'follow <player> [bot]', category: 'players', description: 'Escort & follow player', hasArgs: true },
      { name: 'protect', syntax: 'protect <player> [bot]', category: 'players', description: 'Bodyguard player & kill threats', hasArgs: true },
      { name: 'surround', syntax: 'surround <player> [bot]', category: 'players', description: '360 knight shield ring around player', hasArgs: true },
      { name: 'drop', syntax: 'drop <player> [item|all] [bot]', category: 'players', description: 'Walk to player and drop loot', hasArgs: true },
      { name: 'mobs', syntax: 'mobs [bot]', category: 'combat', description: 'Hunt nearby hostile mobs', hasArgs: true },
      { name: 'hunt', syntax: 'hunt [bot]', category: 'combat', description: 'Hunt nearby hostile mobs', hasArgs: true },
      { name: 'ally', syntax: 'ally <player>', category: 'players', description: 'Mark player as trusted ally', hasArgs: true },
      { name: 'kos', syntax: 'kos <player>', category: 'pvp', description: 'Mark player Kill-On-Sight', hasArgs: true },
      { name: 'explore', syntax: 'explore <sector>', category: 'exploration', description: 'Scout & map sectors in parallel', hasArgs: true },
      { name: 'guard', syntax: 'guard <perimeter>', category: 'defense', description: 'Patrol & defend perimeter', hasArgs: true },
      { name: 'deposit', syntax: 'deposit <item> [count]', category: 'logistics', description: 'Deposit items into storage chest', hasArgs: true },
      { name: 'skin', syntax: 'skin sync [bot]', category: 'skins', description: 'Sync Crimson Shadow Knight skin', hasArgs: true },
      { name: 'mode', syntax: 'mode <HYBRID|SYNCHRONIZED|DISTRIBUTED>', category: 'swarm', description: 'Switch swarm operating mode', hasArgs: true },
      { name: 'profile', syntax: 'profile <BALANCED|PERFORMANCE|MAXIMUM_THROUGHPUT|LOW|ULTRA_LOW>', category: 'swarm', description: 'Switch performance profile', hasArgs: true },
      { name: 'botcap', syntax: 'botcap <1..20>', category: 'swarm', description: 'Set active swarm bot cap', hasArgs: true },
      { name: 'stop', syntax: 'stop', category: 'swarm', description: 'Emergency stop & ceasefire all bots', hasArgs: false }
    ],
    mineTargets: ['diamond', 'raw_iron', 'cobblestone', 'coal', 'raw_gold', 'ancient_debris', 'obsidian', 'redstone', 'emerald', 'raw_copper', 'lapis_lazuli', 'quartz'],
    collectTargets: ['oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'cobblestone', 'sand', 'gravel', 'flint', 'wheat', 'carrot', 'potato', 'leather', 'blaze_rod', 'ender_pearl'],
    craftTargets: ['diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_spear', 'mace', 'wind_charge', 'shield', 'iron_pickaxe', 'iron_sword', 'golden_apple', 'crafting_table', 'furnace', 'chest', 'oak_planks', 'stick'],
    smeltTargets: ['iron_ingot', 'gold_ingot', 'copper_ingot', 'netherite_scrap', 'cooked_beef', 'cooked_porkchop', 'glass', 'smooth_stone', 'charcoal'],
    allItems: ['diamond', 'iron_ingot', 'gold_ingot', 'oak_log', 'cobblestone', 'obsidian', 'golden_apple', 'mace', 'shield'],
    kits: [
      { id: 'stone_tools', title: 'Get Stone Tools & Furnace' },
      { id: 'full_iron_kit', title: 'Get Complete Iron Knight Kit' },
      { id: 'iron_tools', title: 'Get Iron Tools & Shield' },
      { id: 'iron_armor', title: 'Get Full Iron Armor' },
      { id: 'diamond_tools', title: 'Get Diamond Tools & Sword' },
      { id: 'diamond_armor', title: 'Get Full Diamond Armor' },
      { id: 'netherite_kit', title: 'Mine Ancient Debris & Forge Netherite' },
      { id: 'mace_pvp_kit', title: '1.21 Mace Smash PvP Loadout' },
      { id: 'spear_pvp_kit', title: 'Spear & Shield Phalanx Loadout' },
      { id: 'starter_base_kit', title: 'Day-1 Starter Base + Shelter' },
      { id: 'wooden_tools', title: 'Get Wooden Tools Set' }
    ],
    schematics: [
      { id: 'watchtower', name: 'Watchtower', blocks: 88 },
      { id: 'castle_keep', name: 'Castle Keep', blocks: 240 },
      { id: 'obsidian_bunker', name: 'Obsidian Bunker', blocks: 125 },
      { id: 'starter_shelter', name: 'Starter Shelter', blocks: 64 },
      { id: 'pvp_arena', name: 'PvP Arena', blocks: 196 },
      { id: 'crop_farm_9x9', name: '9x9 Crop Farm', blocks: 81 },
      { id: 'smeltery_array', name: 'Smeltery Array', blocks: 48 },
      { id: 'nether_portal_frame', name: 'Nether Portal Frame', blocks: 14 }
    ],
    exploreSectors: ['spawn_basin', 'north_ridge', 'south_valley', 'east_forest', 'west_canyon', 'deep_caves'],
    weaponStyles: [
      { id: 'auto', desc: 'Auto Mastery (Mace + Axe + Spear + Sword + Bow)' },
      { id: 'mace', desc: '1.21 Mace + Wind Charge Aerial Smash' },
      { id: 'spear', desc: 'Spear / Trident 3.4m Phalanx Reach' },
      { id: 'axe', desc: 'Heavy Axe Shield-Breaker' },
      { id: 'sword', desc: 'Enchanted Sword Jump-Crits' },
      { id: 'bow', desc: 'Ranged Bow Sniper' }
    ],
    stackCounts: ['64', '32', '16', '128', '256', '8', '4', '1'],
    craftCounts: ['1', '2', '4', '8', '16', '32', '64'],
    modes: ['HYBRID', 'SYNCHRONIZED', 'DISTRIBUTED'],
    profiles: ['BALANCED', 'PERFORMANCE', 'MAXIMUM_THROUGHPUT', 'LOW', 'ULTRA_LOW'],
    players: [],
    bots: []
  };

  function rankMatches(candidates, partial, limit) {
    const q = String(partial || '').toLowerCase();
    if (!q) return candidates.slice(0, limit);
    const starts = [];
    const contains = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      const low = c.token.toLowerCase();
      if (low.startsWith(q)) starts.push(c);
      else if (low.includes(q)) contains.push(c);
    }
    return starts.concat(contains).slice(0, limit);
  }

  function computeBrigadierSuggestions(rawInput, maxItems) {
    const dict = state.autocompleteDict || FALLBACK_AUTOCOMPLETE_DICT;
    const limit = maxItems || 12;
    const input = typeof rawInput === 'string' ? rawInput : '';
    const leadMatch = /^(\s*(?:\/|!swarm\s+)?)/.exec(input);
    const leadingPrefix = leadMatch ? leadMatch[1] : '';
    const body = input.slice(leadingPrefix.length);
    const endsWithSpace = body.length > 0 && /\s$/.test(body);
    const trimmed = body.trim();
    const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
    const hasTrailingSpace = endsWithSpace && parts.length > 0;

    const argIndex = parts.length === 0 ? 0 : (hasTrailingSpace ? parts.length : parts.length - 1);
    const activeToken = hasTrailingSpace ? '' : (parts[argIndex] || '');
    const priorTokens = parts.slice(0, argIndex);
    const prefixBeforeToken = priorTokens.length === 0 ? leadingPrefix : (leadingPrefix + priorTokens.join(' ') + ' ');

    function entry(token, desc, cat, hasNextArg) {
      const applyVal = prefixBeforeToken + token + (hasNextArg ? ' ' : '');
      const cycleVal = prefixBeforeToken + token;
      let ghost = '';
      if (activeToken && token.toLowerCase().startsWith(activeToken.toLowerCase())) {
        ghost = token.slice(activeToken.length);
      } else if (!activeToken) {
        ghost = token;
      }
      return {
        token,
        applyValue: applyVal,
        cycleValue: cycleVal,
        ghostSuffix: ghost,
        description: desc || '',
        category: cat || 'cmd',
        hasNextArg: Boolean(hasNextArg)
      };
    }

    if (argIndex === 0) {
      const roots = (dict.rootCommands || []).map((c) =>
        entry(c.name, c.syntax + ' — ' + c.description, c.category, c.hasArgs)
      );
      return {
        syntaxHint: '<command> <args...>  (Press Tab to auto-fill next word)',
        activeToken,
        suggestions: rankMatches(roots, activeToken, limit)
      };
    }

    const verb = (priorTokens[0] || '').toLowerCase();
    const rootMeta = (dict.rootCommands || []).find((c) => c.name === verb);
    const syntaxHint = rootMeta ? rootMeta.syntax : (verb + ' ...');

    const botPool = [entry('*', 'Entire Swarm (All Bots)', 'bots', false)].concat(
      (dict.bots || []).map((b) => entry(b, 'Target swarm bot', 'bots', false))
    );
    const playerPool = (dict.players && dict.players.length > 0 ? dict.players : ['Steve', 'Alex']);
    let pool = [];

    if (verb === 'mine' || verb === 'dig') {
      if (argIndex === 1) {
        pool = (dict.mineTargets || []).map((t) => entry(t, 'Mine ' + t, 'mining', true));
      } else if (argIndex === 2) {
        pool = /^\d+$/.test(priorTokens[1])
          ? (dict.mineTargets || []).map((t) => entry(t, 'Mine ' + priorTokens[1] + ' ' + t, 'mining', false))
          : (dict.stackCounts || []).map((n) => entry(n, 'Quantity: ' + n, 'count', false));
      }
    } else if (verb === 'goto' || verb === 'go') {
      if (argIndex === 4) pool = botPool;
    } else if (verb === 'tree') {
      if (argIndex === 1) pool = ['8', '16', '32', '64'].map((n) => entry(n, 'Chop ' + n + ' logs', 'count', false));
    } else if (verb === 'food' || verb === 'mobs' || verb === 'hunt' || verb === 'hunt_mobs') {
      if (argIndex === 1) pool = botPool;
    } else if (verb === 'collect' || verb === 'gather' || verb === 'chop' || verb === 'harvest') {
      if (argIndex === 1) {
        pool = (dict.collectTargets || []).map((t) => entry(t, 'Collect ' + t, 'gathering', true));
      } else if (argIndex === 2) {
        pool = /^\d+$/.test(priorTokens[1])
          ? (dict.collectTargets || []).map((t) => entry(t, 'Collect ' + priorTokens[1] + ' ' + t, 'gathering', false))
          : (dict.stackCounts || []).map((n) => entry(n, 'Quantity: ' + n, 'count', false));
      }
    } else if (verb === 'craft' || verb === 'make' || verb === 'forge') {
      if (argIndex === 1) {
        pool = (dict.craftTargets || []).map((t) => entry(t, 'Craft ' + t, 'crafting', true));
      } else if (argIndex === 2) {
        pool = /^\d+$/.test(priorTokens[1])
          ? (dict.craftTargets || []).map((t) => entry(t, 'Craft ' + priorTokens[1] + ' ' + t, 'crafting', false))
          : (dict.craftCounts || []).map((n) => entry(n, 'Quantity: ' + n, 'count', false));
      }
    } else if (verb === 'smelt' || verb === 'cook' || verb === 'bake') {
      if (argIndex === 1) {
        pool = (dict.smeltTargets || []).map((t) => entry(t, 'Smelt ' + t, 'smelting', true));
      } else if (argIndex === 2) {
        pool = /^\d+$/.test(priorTokens[1])
          ? (dict.smeltTargets || []).map((t) => entry(t, 'Smelt ' + priorTokens[1] + ' ' + t, 'smelting', false))
          : ['16', '32', '64', '8', '128'].map((n) => entry(n, 'Quantity: ' + n, 'count', false));
      }
    } else if (verb === 'kit' || verb === 'get') {
      if (argIndex === 1) {
        pool = (dict.kits || []).map((k) => entry(k.id, k.title, 'progression', false));
      }
    } else if (verb === 'build' || verb === 'construct') {
      if (argIndex === 1) {
        pool = (dict.schematics || []).map((s) =>
          entry(s.id, s.name + ' (' + (s.blocks || 0) + ' blocks)', 'schematics', true)
        );
      } else if (argIndex === 2) {
        pool = botPool;
      }
    } else if (verb === 'kill' || verb === 'attack') {
      if (argIndex === 1) {
        pool = playerPool.map((p) => entry(p, 'PvP attack ' + p, 'pvp', true));
      } else if (argIndex === 2) {
        pool = (dict.weaponStyles || []).map((w) => entry(w.id, w.desc, 'pvp', true));
      } else if (argIndex === 3) {
        pool = botPool;
      }
    } else if (verb === 'follow' || verb === 'protect' || verb === 'surround') {
      if (argIndex === 1) {
        pool = playerPool.map((p) => entry(p, verb + ' ' + p, 'players', true));
      } else if (argIndex === 2) {
        pool = botPool;
      }
    } else if (verb === 'ally' || verb === 'kos') {
      if (argIndex === 1) {
        pool = playerPool.map((p) => entry(p, 'Mark ' + p + ' as ' + verb.toUpperCase(), 'players', false));
      }
    } else if (verb === 'drop') {
      if (argIndex === 1) {
        pool = playerPool.map((p) => entry(p, 'Drop loot to ' + p, 'players', true));
      } else if (argIndex === 2) {
        pool = [entry('all', 'Drop all non-equipped loot', 'logistics', true)].concat(
          (dict.allItems || []).slice(0, 24).map((it) => entry(it, 'Drop ' + it, 'logistics', true))
        );
      } else if (argIndex === 3) {
        pool = botPool;
      }
    } else if (verb === 'hunt' || verb === 'hunt_mobs') {
      if (argIndex === 1) pool = botPool;
    } else if (verb === 'explore' || verb === 'scout') {
      if (argIndex === 1) {
        pool = (dict.exploreSectors || []).map((s) => entry(s, 'Explore ' + s, 'exploration', false));
      }
    } else if (verb === 'guard' || verb === 'patrol' || verb === 'defend') {
      if (argIndex === 1) {
        pool = ['base_perimeter', 'spawn_basin', 'mining_perimeter'].concat(playerPool).map((s) =>
          entry(s, 'Guard ' + s, 'defense', false)
        );
      }
    } else if (verb === 'deposit' || verb === 'store') {
      if (argIndex === 1) {
        pool = (dict.allItems || []).slice(0, 30).map((it) => entry(it, 'Deposit ' + it, 'logistics', true));
      } else if (argIndex === 2) {
        pool = (dict.stackCounts || []).map((n) => entry(n, 'Quantity: ' + n, 'count', false));
      }
    } else if (verb === 'skin') {
      if (argIndex === 1) {
        pool = [
          entry('sync', 'Sync Crimson Shadow Knight skin across swarm', 'skins', true),
          entry('knight_crimson', 'Apply 64x64 Crimson Shadow Knight skin', 'skins', true)
        ];
      } else if (argIndex === 2) {
        pool = botPool;
      }
    } else if (verb === 'mode') {
      if (argIndex === 1) pool = (dict.modes || []).map((m) => entry(m, 'Mode: ' + m, 'swarm', false));
    } else if (verb === 'profile') {
      if (argIndex === 1) pool = (dict.profiles || []).map((p) => entry(p, 'Profile: ' + p, 'swarm', false));
    } else if (verb === 'botcap') {
      if (argIndex === 1) {
        pool = ['2', '4', '6', '8', '10', '12', '16', '20'].map((n) => entry(n, 'Bot cap: ' + n, 'swarm', false));
      }
    }

    return {
      syntaxHint,
      activeToken,
      suggestions: rankMatches(pool, activeToken, limit)
    };
  }

  async function executeUnifiedCommand(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return;
    if (state.cmdHistory[0] !== raw) {
      state.cmdHistory.unshift(raw);
      if (state.cmdHistory.length > 50) state.cmdHistory.pop();
    }
    state.cmdHistoryIndex = -1;

    const clean = raw.replace(/^(?:\/|!swarm\s+)/i, '').trim();
    const parts = clean.split(/\s+/);
    const verb = (parts[0] || '').toLowerCase();

    try {
      if (verb === 'stop' || verb === 'ceasefire' || verb === 'emergency_stop') {
        const out = await api('/api/v1/swarm/emergency-stop', { method: 'POST', body: {} });
        await api('/api/v1/players/action', { method: 'POST', body: { mode: 'idle', botId: '*' } }).catch(() => {});
        showToast('Emergency Stop & Ceasefire executed (' + (out.stoppedBots || 0) + ' bots)');
        refreshStatusAndTasks();
        return;
      }
      if (verb === 'mode' && parts[1]) {
        const modeVal = parts[1].toUpperCase();
        await api('/api/v1/swarm/mode', { method: 'POST', body: { mode: modeVal } });
        showToast('Swarm mode -> ' + modeVal);
        refreshStatusAndTasks();
        return;
      }
      if (verb === 'profile' && parts[1]) {
        const profVal = parts[1].toUpperCase();
        await api('/api/v1/swarm/profile', { method: 'POST', body: { profile: profVal } });
        showToast('Performance profile -> ' + profVal);
        refreshStatusAndTasks();
        return;
      }
      if (verb === 'botcap' && parts[1]) {
        const cap = Number(parts[1]);
        await api('/api/v1/swarm/bot-cap', { method: 'POST', body: { enabledBotsCap: cap } });
        showToast('Enabled bot cap -> ' + cap);
        refreshStatusAndTasks();
        return;
      }
      if (verb === 'skin') {
        await api('/api/v1/skins/assign', {
          method: 'POST',
          body: {
            preset: 'all_crimson_knights',
            botId: parts[2] && parts[2] !== '*' ? parts[2] : null
          }
        });
        showToast('Synced Crimson Shadow Knight skin across swarm');
        refreshSkinsAndSchematics();
        return;
      }
      if ((verb === 'kill' || verb === 'attack') && parts[1]) {
        await sendPlayerTacticalOrder({
          mode: 'attack_player',
          targetPlayer: parts[1],
          preferredWeaponStyle: (parts[2] || 'auto').toLowerCase(),
          botId: parts[3] || '*',
          preemptTask: true
        });
        return;
      }
      if ((verb === 'follow' || verb === 'protect' || verb === 'surround') && parts[1]) {
        await sendPlayerTacticalOrder({
          mode: verb,
          targetPlayer: parts[1],
          botId: parts[2] || '*',
          preemptTask: true
        });
        return;
      }
      if (verb === 'drop' && parts[1]) {
        await sendPlayerTacticalOrder({
          mode: 'drop_loot',
          targetPlayer: parts[1],
          itemFilter: parts[2] || 'all',
          botId: parts[3] || '*',
          preemptTask: true
        });
        return;
      }
      if (verb === 'goto' || verb === 'go') {
        const coordinatePattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
        const coords = parts.slice(1, 4).map(Number);
        const valid = parts.length >= 4 && parts.length <= 5 &&
          parts.slice(1, 4).every((value) => coordinatePattern.test(value)) &&
          coords.every(Number.isFinite) && Math.abs(coords[0]) <= 29999984 &&
          coords[1] >= -2048 && coords[1] <= 2048 && Math.abs(coords[2]) <= 29999984;
        if (!valid) throw new Error('Usage: goto <x> <y> <z> [bot] (x/z ±29,999,984; y -2048..2048)');
        await sendPlayerTacticalOrder({
          mode: 'goto',
          targetPosition: { x: coords[0], y: coords[1], z: coords[2] },
          botId: parts[4] || '*',
          preemptTask: true
        });
        return;
      }
      if (verb === 'food' || verb === 'mobs' || verb === 'hunt' || verb === 'hunt_mobs') {
        await sendPlayerTacticalOrder({
          mode: verb === 'food' ? 'hunt_food' : 'hunt_mobs',
          botId: parts[1] || '*',
          preemptTask: true
        });
        return;
      }
      if (verb === 'tree') {
        const qty = /^\d+$/.test(parts[1] || '') ? Number(parts[1]) : 16;
        if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100000) throw new Error('Tree log target must be between 1 and 100000');
        const created = await api('/api/v1/tasks', {
          method: 'POST',
          body: { text: 'collect ' + qty + ' oak logs', priority: 'normal' }
        });
        showToast('Tree chopping dispatched: ' + (created.intentSummary || (qty + ' oak logs')) + ' [' + created.state + ']');
        refreshStatusAndTasks();
        return;
      }
      if ((verb === 'ally' || verb === 'kos') && parts[1]) {
        await sendPlayerTacticalOrder({
          mode: verb === 'kos' ? 'attack_player' : 'idle',
          targetPlayer: parts[1],
          relation: verb,
          botId: '*',
          preemptTask: verb === 'kos'
        });
        return;
      }
      if ((verb === 'build' || verb === 'construct') && parts[1] && parts.length <= 3) {
        const dict = state.autocompleteDict || FALLBACK_AUTOCOMPLETE_DICT;
        const schId = parts[1].toLowerCase();
        const foundSch = (dict.schematics || []).find((s) => s.id === schId);
        if (foundSch) {
          await api('/api/v1/schematics/build', {
            method: 'POST',
            body: {
              schematicId: schId,
              botId: parts[2] && parts[2] !== '*' ? parts[2] : null
            }
          });
          showToast('Dispatched Schematic Build: ' + foundSch.name);
          refreshStatusAndTasks();
          return;
        }
      }

      // Default: dispatch to Zero-AI curated Engine / Central Task Brain
      const created = await api('/api/v1/tasks', {
        method: 'POST',
        body: { text: clean, priority: 'normal' }
      });
      showToast('Command Dispatched: ' + (created.intentSummary || clean) + ' [' + created.state + ']');
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function attachBrigadierAutocomplete(inputEl, opts) {
    if (!inputEl) return null;
    const options = opts || {};
    let popupEl = options.popupEl || null;
    if (!popupEl) {
      const wrap = document.createElement('div');
      wrap.className = 'mc-inline-wrap';
      inputEl.parentNode.insertBefore(wrap, inputEl);
      wrap.appendChild(inputEl);
      popupEl = document.createElement('div');
      popupEl.className = 'mc-suggest-popup hidden';
      popupEl.setAttribute('role', 'listbox');
      wrap.appendChild(popupEl);
    }

    const ghostTypedEl = options.ghostTypedEl || null;
    const ghostRestEl = options.ghostRestEl || null;

    let currentSuggestions = [];
    let currentSyntaxHint = '';
    let selectedIndex = 0;
    let isPopupOpen = false;
    let tabCycleSnapshot = null;
    let suggestionRequestId = 0;
    let suggestionRequestTimer = null;

    function updateGhost() {
      if (!ghostTypedEl || !ghostRestEl) return;
      const val = inputEl.value;
      ghostTypedEl.textContent = val;
      if (!val && !isPopupOpen) {
        ghostRestEl.textContent = '';
        return;
      }
      const sel = currentSuggestions[selectedIndex];
      if (!sel) {
        ghostRestEl.textContent = '';
        return;
      }
      if (val && sel.applyValue.toLowerCase().startsWith(val.toLowerCase())) {
        ghostRestEl.textContent = sel.applyValue.slice(val.length);
      } else if (!val) {
        ghostRestEl.textContent = sel.applyValue;
      } else {
        ghostRestEl.textContent = '';
      }
    }

    function closePopup() {
      suggestionRequestId += 1;
      clearTimeout(suggestionRequestTimer);
      isPopupOpen = false;
      tabCycleSnapshot = null;
      popupEl.classList.add('hidden');
      updateGhost();
    }

    function renderPopup() {
      clearChildren(popupEl);
      if (!isPopupOpen || currentSuggestions.length === 0) {
        popupEl.classList.add('hidden');
        updateGhost();
        return;
      }
      popupEl.classList.remove('hidden');

      const hdr = document.createElement('div');
      hdr.className = 'mc-suggest-header';
      const syn = document.createElement('span');
      syn.textContent = currentSyntaxHint;
      const keys = document.createElement('span');
      keys.className = 'mc-suggest-hint-keys';
      keys.textContent = 'Tab: Auto-fill  •  ↑/↓: Select  •  Enter: Run';
      hdr.appendChild(syn);
      hdr.appendChild(keys);
      popupEl.appendChild(hdr);

      currentSuggestions.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'mc-suggest-item' + (idx === selectedIndex ? ' is-selected' : '');
        row.setAttribute('role', 'option');

        const left = document.createElement('div');
        left.className = 'mc-suggest-meta';
        const tok = document.createElement('span');
        tok.className = 'mc-suggest-token';
        tok.textContent = item.token;
        const cat = document.createElement('span');
        cat.className = 'badge';
        cat.textContent = item.category;
        left.appendChild(tok);
        left.appendChild(cat);

        const desc = document.createElement('span');
        desc.className = 'mc-suggest-desc';
        desc.textContent = item.description;

        row.appendChild(left);
        row.appendChild(desc);

        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          inputEl.value = item.applyValue;
          tabCycleSnapshot = null;
          recomputeAndOpen();
          inputEl.focus();
        });

        popupEl.appendChild(row);
      });

      updateGhost();
    }

    function recomputeAndOpen() {
      let res;
      if (options.playerOnly) {
        const q = inputEl.value.trim().toLowerCase();
        const livePlayers = state.autocompleteDict?.players;
        const players = Array.isArray(livePlayers) && livePlayers.length > 0
          ? livePlayers
          : ['Steve', 'Alex'];
        res = {
          syntaxHint: 'Online players',
          suggestions: players
            .filter((name) => !q || name.toLowerCase().startsWith(q))
            .slice(0, 10)
            .map((name) => ({
              token: name,
              applyValue: name,
              cycleValue: name,
              description: 'Online Minecraft player',
              category: 'players',
              hasNextArg: false
            }))
        };
      } else {
        res = computeBrigadierSuggestions(inputEl.value, 10);
      }
      currentSuggestions = res.suggestions || [];
      currentSyntaxHint = res.syntaxHint || '';
      selectedIndex = 0;
      isPopupOpen = currentSuggestions.length > 0;
      renderPopup();

      // Freeform Zero-AI / AI Brain phrases are indexed on the Master (curated
      // catalog entries). Query the same completion API when the fast local
      // Brigadier tree has no match, and ignore stale responses while typing.
      const requestId = ++suggestionRequestId;
      clearTimeout(suggestionRequestTimer);
      const query = inputEl.value.trim();
      if (!options.playerOnly && currentSuggestions.length === 0 && query.length > 1) {
        suggestionRequestTimer = setTimeout(() => {
          suggestionRequestTimer = null;
          api('/api/v1/commands/autocomplete?q=' + encodeURIComponent(query) + '&limit=10')
            .then((remote) => {
              if (requestId !== suggestionRequestId || inputEl.value.trim() !== query) return;
              currentSuggestions = Array.isArray(remote.suggestions) ? remote.suggestions : [];
              currentSyntaxHint = remote.syntaxHint || currentSyntaxHint;
              selectedIndex = 0;
              isPopupOpen = currentSuggestions.length > 0;
              renderPopup();
            })
            .catch(() => {});
        }, 100);
      }
    }

    function applyTabCompletion(reverse) {
      if (!isPopupOpen || currentSuggestions.length === 0) {
        recomputeAndOpen();
      }
      if (currentSuggestions.length === 0) return;

      // Single unambiguous match (or user navigated with arrows): insert with trailing space & advance immediately!
      if (currentSuggestions.length === 1) {
        const only = currentSuggestions[0];
        if (inputEl.value !== only.applyValue) {
          inputEl.value = only.applyValue;
          tabCycleSnapshot = null;
          recomputeAndOpen();
          return;
        }
      }

      // Multi-match Brigadier Tab cycling:
      // 1st Tab inserts highlighted suggestion; subsequent Tabs cycle through sibling matches;
      // pressing Space or typing locks it and advances to the next argument!
      if (!tabCycleSnapshot) {
        const chosen = currentSuggestions[selectedIndex] || currentSuggestions[0];
        // If user already moved selection with Up/Down, commit & advance directly
        if (selectedIndex > 0) {
          inputEl.value = chosen.applyValue;
          tabCycleSnapshot = null;
          recomputeAndOpen();
          return;
        }
        tabCycleSnapshot = {
          list: currentSuggestions.slice(),
          index: 0
        };
        inputEl.value = chosen.cycleValue;
        renderPopup();
        return;
      }

      const len = tabCycleSnapshot.list.length;
      tabCycleSnapshot.index = (tabCycleSnapshot.index + (reverse ? -1 : 1) + len) % len;
      selectedIndex = tabCycleSnapshot.index;
      currentSuggestions = tabCycleSnapshot.list;
      inputEl.value = currentSuggestions[selectedIndex].cycleValue;
      renderPopup();
    }

    inputEl.addEventListener('input', () => {
      tabCycleSnapshot = null;
      recomputeAndOpen();
    });

    inputEl.addEventListener('focus', () => {
      if (inputEl.value.trim().length > 0 || options.openOnFocus) {
        recomputeAndOpen();
      } else {
        updateGhost();
      }
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(closePopup, 140);
    });

    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        applyTabCompletion(ev.shiftKey);
        return;
      }
      if (ev.key === 'ArrowDown') {
        if (isPopupOpen && currentSuggestions.length > 0) {
          ev.preventDefault();
          tabCycleSnapshot = null;
          selectedIndex = (selectedIndex + 1) % currentSuggestions.length;
          renderPopup();
        } else if (options.enableHistory && state.cmdHistory.length > 0 && state.cmdHistoryIndex > 0) {
          ev.preventDefault();
          state.cmdHistoryIndex -= 1;
          inputEl.value = state.cmdHistory[state.cmdHistoryIndex] || '';
          updateGhost();
        }
        return;
      }
      if (ev.key === 'ArrowUp') {
        if (isPopupOpen && currentSuggestions.length > 0) {
          ev.preventDefault();
          tabCycleSnapshot = null;
          selectedIndex = (selectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
          renderPopup();
        } else if (options.enableHistory && state.cmdHistory.length > 0) {
          ev.preventDefault();
          state.cmdHistoryIndex = Math.min(state.cmdHistory.length - 1, state.cmdHistoryIndex + 1);
          inputEl.value = state.cmdHistory[state.cmdHistoryIndex] || '';
          updateGhost();
        }
        return;
      }
      if (ev.key === 'ArrowRight' && inputEl.selectionStart === inputEl.value.length && currentSuggestions[selectedIndex]) {
        const sel = currentSuggestions[selectedIndex];
        if (inputEl.value && sel.applyValue.toLowerCase().startsWith(inputEl.value.toLowerCase()) && sel.applyValue !== inputEl.value) {
          ev.preventDefault();
          inputEl.value = sel.applyValue;
          tabCycleSnapshot = null;
          recomputeAndOpen();
        }
        return;
      }
      if (ev.key === 'Escape') {
        closePopup();
      }
    });

    return {
      triggerTab: () => {
        inputEl.focus();
        applyTabCompletion(false);
      },
      closePopup,
      updateGhost
    };
  }

  const globalAutocomplete = attachBrigadierAutocomplete(el('mc-cmd-input'), {
    popupEl: el('mc-cmd-popup'),
    ghostTypedEl: el('mc-ghost-typed'),
    ghostRestEl: el('mc-ghost-rest'),
    openOnFocus: true,
    enableHistory: true
  });

  attachBrigadierAutocomplete(el('noai-freeform-input'), { openOnFocus: false });
  attachBrigadierAutocomplete(el('intent-text'), { openOnFocus: false });
  attachBrigadierAutocomplete(el('pvp-target-player'), { openOnFocus: false, playerOnly: true });

  if (el('mc-cmd-tab-btn') && globalAutocomplete) {
    el('mc-cmd-tab-btn').addEventListener('click', () => {
      globalAutocomplete.triggerTab();
    });
  }

  if (el('mc-command-form')) {
    el('mc-command-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = el('mc-cmd-input');
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      if (globalAutocomplete) globalAutocomplete.closePopup();
      await executeUnifiedCommand(val);
    });
  }

  // Page Visibility API integration for SSE background throttling
  document.addEventListener('visibilitychange', () => {
    if (state.actor && state.csrfToken) {
      api('/api/v1/events/visibility', {
        method: 'POST',
        body: { clientId: state.sseClientId, hidden: document.hidden }
      }).catch(() => {});
      if (!document.hidden) refreshAll();
    }
  });

  // Boot check
  (async function init() {
    try {
      const sess = await api('/api/v1/auth/session');
      if (sess.authenticated && sess.actor) {
        if (sess.csrfToken) {
          state.csrfToken = sess.csrfToken;
          sessionStorage.setItem('nexus_csrf', sess.csrfToken);
        }
        enterShell(sess.actor);
      } else {
        renderAuthScreen(sess.bootstrapRequired);
      }
    } catch {
      renderAuthScreen(false);
    }
  })();
})();
