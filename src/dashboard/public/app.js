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
    noaiLimit: 96,
    skinsById: {},
    providersCache: [],
    aiFormInitialized: false
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
    el('auth-screen').classList.add('hidden');
    el('app-shell').classList.remove('hidden');
    el('actor-badge').textContent = actor.username + ' (' + actor.role + ')';
    connectSse();
    refreshAll();
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

  function renderStatus(st) {
    if (st.envProfile) state.envProfile = st.envProfile;
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
    const items = res.items || [];
    if (items.length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No tasks submitted yet.');
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

  async function refreshZeroAiDeck() {
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
      el('noai-total-badge').textContent = String(deck.totalCatalogCommands || 1370);
      el('noai-matched-count').textContent = String(deck.matchedCount || 0);
      const pageNum = Math.floor((deck.offset || 0) / state.noaiLimit) + 1;
      const totalPages = Math.max(1, Math.ceil((deck.matchedCount || 1) / state.noaiLimit));
      el('noai-page-label').textContent = 'Page ' + pageNum + ' / ' + totalPages;

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
    } catch {
      // ignore
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
    if (statusLine && activeMeta) {
      statusLine.textContent =
        'Active Brain: ' +
        (activeMeta.label || activeMeta.name) +
        ' | Model: ' +
        (activeMeta.model || 'n/a') +
        ' | Key: ' +
        (activeMeta.hasApiKey ? activeMeta.maskedApiKey : activeMeta.requiresApiKey ? 'Not set (falls back to 1,370+ Zero-AI)' : 'Not required');
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

  async function refreshAll() {
    await Promise.all([
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

  el('mint-token-btn').addEventListener('click', async () => {
    try {
      const out = await api('/api/v1/workers/bootstrap-token', { method: 'POST', body: {} });
      const box = el('bootstrap-token-output');
      clearChildren(box);
      const title = document.createElement('div');
      title.textContent = 'Single-use Worker Bootstrap Token (expires ' + out.expiresAt + '): ' + out.bootstrapToken;
      const cmd = document.createElement('code');
      cmd.className = 'cmd-snippet';
      cmd.textContent =
        'SWARM_ROLE=worker SWARM_ENV_PROFILE=' +
        (state.envProfile || 'private_offline_test') +
        ' SWARM_MASTER_URL=' +
        window.location.origin +
        ' SWARM_BOOTSTRAP_TOKEN=' +
        out.bootstrapToken +
        ' SWARM_WORKER_ID=worker-1 SWARM_WORKER_STATE_PATH=./data/worker-1-state.json SWARM_MC_HOST=thebasement-wUr4.aternos.me SWARM_SPAWN_STAGGER_MS=4000 SWARM_BOT_NAME_PREFIX=Nexus SWARM_WORKER_BOT_COUNT=2 npm run start:worker';
      box.appendChild(title);
      box.appendChild(cmd);
      box.classList.remove('hidden');
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
