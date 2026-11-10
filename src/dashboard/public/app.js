'use strict';

(function () {
  const state = {
    csrfToken: sessionStorage.getItem('nexus_csrf') || null,
    actor: null,
    bootstrapRequired: false,
    sseClientId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    sse: null,
    pollTimer: null
  };

  const el = (id) => document.getElementById(id);

  function showToast(msg, isError) {
    const t = el('toast-banner');
    t.textContent = msg;
    t.style.borderColor = isError ? '#ef4444' : '#38bdf8';
    t.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.add('hidden'), 4500);
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
      wBody.appendChild(tr);
    }
    if ((st.workers || []).length === 0) {
      const tr = document.createElement('tr');
      const td = tdText('No WorkerHosts enrolled yet. Mint a Bootstrap Token above to enroll a worker.');
      td.colSpan = 5;
      td.className = 'muted';
      tr.appendChild(td);
      wBody.appendChild(tr);
    }

    // Bots
    const bBody = el('bots-tbody');
    clearChildren(bBody);
    for (const b of st.bots || []) {
      const tr = document.createElement('tr');
      tr.appendChild(tdText(b.botId + ' (' + b.username + ')'));
      tr.appendChild(tdText(b.workerId));
      tr.appendChild(tdText(b.connectionState));
      const snap = b.snapshot || {};
      const posStr = snap.position ? (snap.position.x + ',' + snap.position.y + ',' + snap.position.z) : '—';
      tr.appendChild(tdText(posStr + ' | H:' + (snap.healthBand || '?') + ' F:' + (snap.foodBand || '?')));

      const ctrlTd = document.createElement('td');
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
      reBtn.style.marginLeft = '4px';
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
      ctrlTd.appendChild(stopBtn);
      ctrlTd.appendChild(reBtn);
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
      tr.appendChild(tdText(t.priority));
      tr.appendChild(tdText(t.state));

      const actTd = document.createElement('td');
      const inspectBtn = document.createElement('button');
      inspectBtn.className = 'btn small';
      inspectBtn.textContent = 'Inspect';
      inspectBtn.onclick = async () => {
        const detail = await api('/api/v1/tasks/' + encodeURIComponent(t.taskId));
        el('task-detail-box').textContent = JSON.stringify(detail, null, 2);
      };
      actTd.appendChild(inspectBtn);

      if (t.state === 'ready' || t.state === 'running') {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'btn small ghost';
        pauseBtn.textContent = 'Pause';
        pauseBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/pause', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        actTd.appendChild(pauseBtn);
      } else if (t.state === 'paused') {
        const resBtn = document.createElement('button');
        resBtn.className = 'btn small primary';
        resBtn.textContent = 'Resume';
        resBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/resume', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        actTd.appendChild(resBtn);
      }

      if (!['completed', 'cancelled', 'failed'].includes(t.state)) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn small danger';
        cancelBtn.style.marginLeft = '4px';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = async () => {
          await api('/api/v1/tasks/' + encodeURIComponent(t.taskId) + '/cancel', { method: 'POST', body: {} });
          refreshStatusAndTasks();
        };
        actTd.appendChild(cancelBtn);
      }

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

  async function refreshAll() {
    await Promise.all([refreshStatusAndTasks(), refreshKnowledge(), refreshLogs()]);
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
      showToast('Task dispatched: ' + created.state);
      refreshStatusAndTasks();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el('mint-token-btn').addEventListener('click', async () => {
    try {
      const out = await api('/api/v1/workers/bootstrap-token', { method: 'POST', body: {} });
      const box = el('bootstrap-token-output');
      box.textContent = 'Single-use Worker Bootstrap Token (expires ' + out.expiresAt + '): ' + out.bootstrapToken;
      box.classList.remove('hidden');
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
        enterShell(sess.actor);
      } else {
        renderAuthScreen(sess.bootstrapRequired);
      }
    } catch {
      renderAuthScreen(false);
    }
  })();
})();
