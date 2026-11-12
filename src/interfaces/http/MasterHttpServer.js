'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { DomainError, toErrorEnvelope } = require('../../errors/DomainError');
const { redactConfig } = require('../../config/loadConfig');
const { authorizeRole } = require('../../coordinator/Coordinator');

const DASHBOARD_PUBLIC_DIR = path.join(__dirname, '..', '..', 'dashboard', 'public');

const STATIC_ASSETS = Object.freeze({
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'application/javascript; charset=utf-8' }
});

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function extractBearer(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = /^Bearer\s+([^\s]+)$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}

/**
 * Zero-Dependency Master HTTP/HTTPS + SSE Gateway (`ADR-001`, `ADR-007`, NEXUS-20 Part 15 & Part 16).
 *
 * Serves:
 * - Static Vanilla HTML/CSS/JS NEXUS-20 Control Centre (`/`, `/style.css`, `/app.js`)
 * - Authenticated Operator & Dashboard REST + SSE API (`/api/v1/*`)
 * - Authenticated Distributed Worker Gateway (`/worker/v1/*`)
 */
class MasterHttpServer {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../coordinator/Coordinator').Coordinator} options.coordinator
   * @param {import('../security/AuthService').AuthService} options.authService
   * @param {import('../workers/BotRegistry').BotRegistry} options.botRegistry
   * @param {import('../tasks/TaskManager').TaskManager} options.taskManager
   * @param {import('../performance/SseCoalescer').SseCoalescer} options.sseCoalescer
   * @param {import('../monitoring/ResourceMonitor').ResourceMonitor} options.monitor
   * @param {object} options.logger
   * @param {() => Promise<object>} options.healthProbe
   */
  constructor(options = {}) {
    this._config = options.config;
    this._coordinator = options.coordinator;
    this._auth = options.authService;
    this._registry = options.botRegistry;
    this._tasks = options.taskManager;
    this._sse = options.sseCoalescer;
    this._monitor = options.monitor;
    this._logger = options.logger;
    this._healthProbe = options.healthProbe;

    this._server = null;
    this._sockets = new Set();
    this._boundPort = null;
    this._staticCache = new Map();
  }

  get listening() {
    return Boolean(this._server && this._server.listening);
  }

  get port() {
    return this._boundPort;
  }

  async start() {
    if (this._server && this._server.listening) {
      return { host: this._config.http.host, port: this._boundPort };
    }

    await this._auth.ensureEnvAdminBootstrap();
    this._sse.start();

    const handler = (req, res) => {
      this._handleRequest(req, res).catch((err) => {
        const reqId = req._nexusRequestId || crypto.randomUUID();
        this._sendError(res, err, reqId);
      });
    };

    if (this._config.tls?.enabled) {
      const tlsOpts = {
        cert: fs.readFileSync(this._config.tls.certPath),
        key: fs.readFileSync(this._config.tls.keyPath),
        ...(this._config.tls.caCertPath ? { ca: fs.readFileSync(this._config.tls.caCertPath) } : {})
      };
      this._server = https.createServer(tlsOpts, handler);
    } else {
      this._server = http.createServer(handler);
    }

    this._server.keepAliveTimeout = 30_000;
    this._server.headersTimeout = 35_000;
    this._server.requestTimeout = 30_000;

    this._server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.once('close', () => this._sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this._server.once('error', onError);
      this._server.listen(this._config.http.port, this._config.http.host, () => {
        this._server.removeListener('error', onError);
        const addr = this._server.address();
        this._boundPort = typeof addr === 'object' && addr ? addr.port : this._config.http.port;
        resolve();
      });
    });

    this._logger?.info('MasterHttpServer listening', {
      host: this._config.http.host,
      port: this._boundPort,
      tls: Boolean(this._config.tls?.enabled)
    });

    return { host: this._config.http.host, port: this._boundPort };
  }

  async stop() {
    this._sse.stop();
    if (!this._server) return;
    const srv = this._server;
    this._server = null;
    this._boundPort = null;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const s of this._sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        resolve();
      }, 2_000);
      timer.unref?.();

      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
      for (const s of this._sockets) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
    });
  }

  _applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (this._config.http?.trustEdgeTlsProxy) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
      );
    } else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
      );
    }
  }

  _buildSessionCookie(sessionToken, maxAgeSec) {
    const encoded = encodeURIComponent(sessionToken);
    if (this._config.http?.trustEdgeTlsProxy) {
      return `nexus_session=${encoded}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`;
    }
    const secureFlag = this._config.tls?.enabled ? '; Secure' : '';
    return `nexus_session=${encoded}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${secureFlag}`;
  }

  _clearSessionCookie() {
    if (this._config.http?.trustEdgeTlsProxy) {
      return 'nexus_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned';
    }
    const secureFlag = this._config.tls?.enabled ? '; Secure' : '';
    return `nexus_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secureFlag}`;
  }

  async _readJsonBody(req, maxBytes = 65_536) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        if (aborted) return;
        total += chunk.byteLength;
        if (total > maxBytes) {
          aborted = true;
          req._nexusOversizeClose = true;
          req.pause();
          reject(
            new DomainError(
              'PAYLOAD_TOO_LARGE',
              `Request body exceeded ${maxBytes} byte limit`
            )
          );
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        this._monitor?.recordNetworkBytes({ rxBytes: total });
        if (total === 0) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(new DomainError('SCHEMA_VALIDATION_FAILED', 'JSON body must be an object'));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new DomainError('SCHEMA_VALIDATION_FAILED', 'Malformed JSON request body'));
        }
      });

      req.on('error', (err) => {
        if (!aborted) {
          aborted = true;
          reject(new DomainError('SCHEMA_VALIDATION_FAILED', err.message || 'Stream error'));
        }
      });
    });
  }

  _sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this._monitor?.recordNetworkBytes({ txBytes: body.byteLength, requestEnded: true });
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', body.byteLength);
    res.end(body);
  }

  _sendError(res, err, requestId) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    const envelope = toErrorEnvelope(err, requestId);
    if (envelope.httpStatus === 413) {
      res.setHeader('Connection', 'close');
    }
    this._sendJson(res, envelope.httpStatus, envelope.body);
  }

  _serveStatic(res, assetDef) {
    const filePath = path.join(DASHBOARD_PUBLIC_DIR, assetDef.file);
    let buf = this._staticCache.get(filePath);
    if (!buf) {
      if (!fs.existsSync(filePath)) {
        throw new DomainError('NOT_FOUND', 'Dashboard asset not found');
      }
      buf = fs.readFileSync(filePath);
      this._staticCache.set(filePath, buf);
    }
    this._monitor?.recordNetworkBytes({ txBytes: buf.byteLength, requestEnded: true });
    res.statusCode = 200;
    res.setHeader('Content-Type', assetDef.contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', buf.byteLength);
    res.end(buf);
  }

  _authenticateOperator(req, method) {
    const cookies = parseCookies(req.headers.cookie);
    const bearer = extractBearer(req.headers.authorization);
    const csrfToken = req.headers['x-csrf-token'] ? String(req.headers['x-csrf-token']) : null;
    const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    return this._auth.authenticateRequest({
      bearerToken: bearer,
      sessionToken: cookies.nexus_session || null,
      csrfToken,
      requireCsrf: mutating && !bearer
    });
  }

  _authenticateWorker(req) {
    const workerId = req.headers['x-worker-id'] ? String(req.headers['x-worker-id']).trim() : '';
    const bearer = extractBearer(req.headers.authorization);
    if (!workerId || !bearer) {
      throw new DomainError('UNAUTHENTICATED', 'Missing X-Worker-Id or Worker Bearer token');
    }
    return this._registry.verifyWorkerToken(workerId, bearer);
  }

  async _handleRequest(req, res) {
    const requestId = crypto.randomUUID();
    req._nexusRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    this._applySecurityHeaders(res);
    this._monitor?.recordNetworkBytes({ requestStarted: true });

    const method = String(req.method || 'GET').toUpperCase();
    const parsedUrl = new URL(req.url || '/', 'http://nexus.local');
    const pathname = parsedUrl.pathname;
    const clientIp = String(
      (this._config.http?.trustEdgeTlsProxy && req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : null) ||
        req.socket?.remoteAddress ||
        'unknown'
    );

    // 1. Static Dashboard assets
    if (method === 'GET' && STATIC_ASSETS[pathname]) {
      this._serveStatic(res, STATIC_ASSETS[pathname]);
      return;
    }

    // 2. Public health & auth bootstrap routes
    if (method === 'GET' && (pathname === '/api/v1/health' || pathname === '/healthz')) {
      const h = await this._healthProbe();
      this._sendJson(res, h.status === 'unhealthy' ? 503 : 200, {
        ...h,
        bootstrapRequired: !this._auth.hasAnyPrincipal()
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/auth/session') {
      const bootstrapRequired = !this._auth.hasAnyPrincipal();
      const cookies = parseCookies(req.headers.cookie);
      try {
        const actor = this._authenticateOperator(req, 'GET');
        const csrfToken = cookies.nexus_session
          ? this._auth.deriveCsrfToken(cookies.nexus_session)
          : null;
        this._sendJson(res, 200, {
          authenticated: true,
          bootstrapRequired,
          csrfToken,
          actor
        });
      } catch {
        this._sendJson(res, 200, {
          authenticated: false,
          bootstrapRequired,
          csrfToken: null,
          actor: null
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/setup') {
      this._auth.checkRateLimit(`setup:${clientIp}`, 10, 60_000);
      const body = await this._readJsonBody(req, 16_384);
      await this._auth.bootstrapInitialAdmin({
        username: body.username,
        password: body.password
      });
      const loginRes = await this._auth.login({
        username: body.username,
        password: body.password,
        clientIp
      });
      res.setHeader('Set-Cookie', this._buildSessionCookie(loginRes.sessionToken, 12 * 3600));
      this._sendJson(res, 201, {
        authenticated: true,
        csrfToken: loginRes.csrfToken,
        actor: loginRes.actor
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/login') {
      const body = await this._readJsonBody(req, 16_384);
      const loginRes = await this._auth.login({
        username: body.username,
        password: body.password,
        clientIp
      });
      res.setHeader('Set-Cookie', this._buildSessionCookie(loginRes.sessionToken, 12 * 3600));
      this._sendJson(res, 200, {
        authenticated: true,
        csrfToken: loginRes.csrfToken,
        actor: loginRes.actor
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/logout') {
      const cookies = parseCookies(req.headers.cookie);
      let principalId = null;
      try {
        const actor = this._authenticateOperator(req, 'POST');
        principalId = actor.principalId;
      } catch (err) {
        if (err && err.code === 'FORBIDDEN') {
          throw err;
        }
        // Session already expired/unknown: still clear cookie cleanly
      }
      if (cookies.nexus_session) {
        this._auth.logout(cookies.nexus_session);
      }
      res.setHeader('Set-Cookie', this._clearSessionCookie());
      this._sendJson(res, 200, { ok: true, principalId });
      return;
    }

    // 2.5 Public 64x64 Minecraft Skin PNGs (`/skins/:skinId.png` for browser downloads & SkinsRestorer)
    const skinPngMatch = /^\/skins\/([a-z0-9_-]{3,40})\.png$/i.exec(pathname);
    if ((method === 'GET' || method === 'HEAD') && skinPngMatch && this._coordinator?.skinManager) {
      const skinId = skinPngMatch[1].toLowerCase();
      if (!this._coordinator.skinManager.isValidSkinId(skinId)) {
        throw new DomainError('NOT_FOUND', `Skin not found: ${skinId}`);
      }
      const pngBuf = this._coordinator.skinManager.getPngBuffer(skinId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', pngBuf.byteLength);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(method === 'HEAD' ? undefined : pngBuf);
      return;
    }

    // 3. Distributed Worker Gateway (`/worker/v1/*`)
    if (pathname.startsWith('/worker/v1/')) {
      await this._handleWorkerRoutes(req, res, method, pathname, parsedUrl, clientIp);
      return;
    }

    // 4. Authenticated Operator & Dashboard API (`/api/v1/*`)
    if (pathname.startsWith('/api/v1/')) {
      await this._handleOperatorRoutes(req, res, method, pathname, parsedUrl, clientIp);
      return;
    }

    throw new DomainError('NOT_FOUND', `Route not found: ${method} ${pathname}`);
  }

  async _handleWorkerRoutes(req, res, method, pathname, parsedUrl, clientIp) {
    if (method === 'POST' && pathname === '/worker/v1/register') {
      this._auth.checkRateLimit(`worker_reg:${clientIp}`, 20, 60_000);
      const body = await this._readJsonBody(req, 65_536);
      const result = this._registry.register({
        bootstrapToken: body.bootstrapToken,
        workerInfo: body.workerInfo
      });
      this._sendJson(res, 201, result);
      return;
    }

    const authWorker = this._authenticateWorker(req);

    if (method === 'POST' && pathname === '/worker/v1/heartbeat') {
      const body = await this._readJsonBody(req, 131_072);
      const ack = await this._coordinator.handleWorkerHeartbeat(authWorker, body);
      this._sendJson(res, 200, ack);
      return;
    }

    if (method === 'GET' && pathname === '/worker/v1/commands') {
      const limit = Number(parsedUrl.searchParams.get('limit') || 25);
      const commands = this._tasks.pollWorkerCommands(authWorker.workerId, limit);
      this._sendJson(res, 200, { workerId: authWorker.workerId, commands });
      return;
    }

    const cmdAckMatch = /^\/worker\/v1\/commands\/([^/]+)\/ack$/.exec(pathname);
    if (method === 'POST' && cmdAckMatch) {
      const commandId = decodeURIComponent(cmdAckMatch[1]);
      const body = await this._readJsonBody(req, 65_536);
      if (body.assignmentId && body.leaseId) {
        const resAck = this._tasks.acknowledgeAssignment({
          workerId: authWorker.workerId,
          commandId,
          assignmentId: body.assignmentId,
          leaseId: body.leaseId,
          allocationEpoch: body.allocationEpoch,
          decision: body.decision || 'accepted',
          rejectionCode: body.rejectionCode || null,
          baselineSnapshot: body.baselineSnapshot || null
        });
        this._sendJson(res, 200, resAck);
        return;
      }
      const acked = this._tasks.ackWorkerCommand(authWorker.workerId, commandId);
      this._sendJson(res, 200, { commandId, acked });
      return;
    }

    if (method === 'POST' && pathname === '/worker/v1/events') {
      const body = await this._readJsonBody(req, 131_072);
      const events = Array.isArray(body.events) ? body.events : [];
      const results = await this._coordinator.handleWorkerEventBatch(authWorker, events);
      this._sendJson(res, 200, { results });
      return;
    }

    if (method === 'POST' && pathname === '/worker/v1/reconcile') {
      const body = await this._readJsonBody(req, 65_536);
      const reconciled = this._tasks.reconcileWorker(authWorker.workerId, body);
      const canonicalBots = this._registry.getWorkerBots(authWorker.workerId);
      this._sendJson(res, 200, { ...reconciled, canonicalBots });
      return;
    }

    throw new DomainError('NOT_FOUND', `Worker route not found: ${method} ${pathname}`);
  }

  async _handleOperatorRoutes(req, res, method, pathname, parsedUrl, clientIp) {
    const actor = this._authenticateOperator(req, method);

    // SSE stream (`/api/v1/events`)
    if (method === 'GET' && pathname === '/api/v1/events') {
      authorizeRole(actor, 'viewer');
      const clientId = parsedUrl.searchParams.get('clientId') || crypto.randomUUID();
      const hidden = parsedUrl.searchParams.get('hidden') === 'true';

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const reg = this._sse.addClient(clientId, res, { hidden });
      if (!reg.accepted) {
        this._sendError(
          res,
          new DomainError('CAPACITY_EXCEEDED', 'Maximum concurrent SSE clients reached'),
          req._nexusRequestId
        );
        return;
      }

      const hello = JSON.stringify({ clientId, connectedAt: new Date().toISOString() });
      res.write(`event: connected\ndata: ${hello}\n\n`);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/events/visibility') {
      authorizeRole(actor, 'viewer');
      const body = await this._readJsonBody(req, 4096);
      const updated = this._sse.setClientVisibility(String(body.clientId || ''), Boolean(body.hidden));
      this._sendJson(res, 200, { updated });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/status') {
      const status = await this._coordinator.getSystemStatus({ actor });
      this._sendJson(res, 200, status);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/logs') {
      authorizeRole(actor, 'viewer');
      const limit = Math.min(200, Math.max(1, Number(parsedUrl.searchParams.get('limit') || 80)));
      const entries =
        typeof this._logger?.recentEntries === 'function'
          ? this._logger.recentEntries(limit)
          : [];
      this._sendJson(res, 200, { entries });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/config') {
      authorizeRole(actor, 'admin');
      this._sendJson(res, 200, { config: redactConfig(this._config) });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/auth/principals') {
      authorizeRole(actor, 'admin');
      this._sendJson(res, 200, { principals: this._auth.listPrincipals() });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/principals') {
      authorizeRole(actor, 'admin');
      const body = await this._readJsonBody(req, 16_384);
      const created = await this._auth.createPrincipal({
        username: body.username,
        password: body.password,
        role: body.role || 'operator',
        createdBy: actor.principalId
      });
      this._sendJson(res, 201, created);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/tasks') {
      const state = parsedUrl.searchParams.get('state') || null;
      const limit = Number(parsedUrl.searchParams.get('limit') || 30);
      const cursor = parsedUrl.searchParams.get('cursor') || null;
      const list = await this._coordinator.listTasks({ actor, state, limit, cursor });
      this._sendJson(res, 200, list);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/tasks') {
      this._auth.checkRateLimit(`tasks:${clientIp}`, 120, 60_000);
      const body = await this._readJsonBody(req, 65_536);
      const created = await this._coordinator.submitIntent({
        actor,
        source: 'dashboard',
        idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
        text: body.text,
        priority: body.priority || 'normal'
      });
      this._sendJson(res, 201, created);
      return;
    }

    const taskDetailMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && taskDetailMatch) {
      const taskId = decodeURIComponent(taskDetailMatch[1]);
      const detail = await this._coordinator.getTask({ actor, taskId });
      this._sendJson(res, 200, detail);
      return;
    }

    const taskActionMatch = /^\/api\/v1\/tasks\/([^/]+)\/(clarify|pause|resume|cancel|priority)$/.exec(
      pathname
    );
    if (method === 'POST' && taskActionMatch) {
      const taskId = decodeURIComponent(taskActionMatch[1]);
      const action = taskActionMatch[2];
      const body = await this._readJsonBody(req, 16_384);

      if (action === 'clarify') {
        const resTask = await this._coordinator.clarifyTask({
          actor,
          taskId,
          answerText: body.answerText
        });
        this._sendJson(res, 200, resTask);
        return;
      }
      if (action === 'pause') {
        const resTask = await this._coordinator.pauseTask({
          actor,
          taskId,
          reason: body.reason || 'operator_paused'
        });
        this._sendJson(res, 200, resTask);
        return;
      }
      if (action === 'resume') {
        const resTask = await this._coordinator.resumeTask({ actor, taskId });
        this._sendJson(res, 200, resTask);
        return;
      }
      if (action === 'cancel') {
        const resTask = await this._coordinator.cancelTask({
          actor,
          taskId,
          reason: body.reason || 'operator_cancelled'
        });
        this._sendJson(res, 200, resTask);
        return;
      }
      if (action === 'priority') {
        const resTask = await this._coordinator.updateTaskPriority({
          actor,
          taskId,
          priority: body.priority
        });
        this._sendJson(res, 200, resTask);
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/v1/swarm/mode') {
      const body = await this._readJsonBody(req, 4096);
      const resMode = await this._coordinator.setOperatingMode({ actor, mode: body.mode });
      this._sendJson(res, 200, resMode);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/swarm/profile') {
      const body = await this._readJsonBody(req, 4096);
      const resProf = await this._coordinator.setPerformanceProfile({
        actor,
        profile: body.profile
      });
      this._sendJson(res, 200, resProf);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/swarm/bot-cap') {
      const body = await this._readJsonBody(req, 4096);
      const resCap = await this._coordinator.setEnabledBotsCap({
        actor,
        enabledBotsCap: body.enabledBotsCap
      });
      this._sendJson(res, 200, resCap);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/swarm/emergency-stop') {
      const resStop = await this._coordinator.emergencyStopAll({ actor });
      this._sendJson(res, 200, resStop);
      return;
    }

    const botActionMatch = /^\/api\/v1\/bots\/([^/]+)\/(safe-stop|reassign)$/.exec(pathname);
    if (method === 'POST' && botActionMatch) {
      const botId = decodeURIComponent(botActionMatch[1]);
      const action = botActionMatch[2];
      const body = await this._readJsonBody(req, 4096);
      if (action === 'safe-stop') {
        const out = await this._coordinator.safeStopBot({ actor, botId });
        this._sendJson(res, 200, out);
        return;
      }
      if (action === 'reassign') {
        const out = await this._coordinator.reassignBot({
          actor,
          botId,
          force: Boolean(body.force)
        });
        this._sendJson(res, 200, out);
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/v1/workers/bootstrap-token') {
      authorizeRole(actor, 'admin');
      const body = await this._readJsonBody(req, 4096);
      const minted = this._registry.createBootstrapToken({
        createdBy: actor.principalId,
        ttlMs: body.ttlMs
      });
      this._sendJson(res, 201, minted);
      return;
    }

    const workerRevokeMatch = /^\/api\/v1\/workers\/([^/]+)\/revoke$/.exec(pathname);
    if (method === 'POST' && workerRevokeMatch) {
      authorizeRole(actor, 'admin');
      const workerId = decodeURIComponent(workerRevokeMatch[1]);
      const body = await this._readJsonBody(req, 4096);
      const revoked = this._registry.revoke(workerId, body.reason || 'operator_revoked');
      if (!this._coordinator.safeMode) {
        await this._coordinator.scheduleReadyObjectives(null);
      }
      this._sendJson(res, 200, revoked);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/knowledge') {
      const category = parsedUrl.searchParams.get('category') || undefined;
      const subjectKey = parsedUrl.searchParams.get('subjectKey') || undefined;
      const dimension = parsedUrl.searchParams.get('dimension') || undefined;
      const limit = Number(parsedUrl.searchParams.get('limit') || 50);
      const items = await this._coordinator.queryWorldKnowledge({
        actor,
        filters: { category, subjectKey, dimension, limit }
      });
      this._sendJson(res, 200, { items });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/knowledge') {
      const body = await this._readJsonBody(req, 16_384);
      const entry = await this._coordinator.recordWorldKnowledge({
        actor,
        observation: body
      });
      this._sendJson(res, 201, entry);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/system/backup') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.resolve(this._config.storage?.backupDir || './data/backups');
      const destPath = path.join(backupDir, `swarm-backup-${stamp}.db`);
      const backupRes = await this._coordinator.createBackup({ actor, destPath });
      this._sendJson(res, 201, backupRes);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/system/exit-safe-mode') {
      const resSafe = await this._coordinator.exitSafeMode({ actor });
      this._sendJson(res, 200, resSafe);
      return;
    }

    // Zero-AI 1,370+ Command Catalog (`/api/v1/commands`)
    if (method === 'GET' && pathname === '/api/v1/commands') {
      const category = parsedUrl.searchParams.get('category') || null;
      const search = parsedUrl.searchParams.get('search') || null;
      const limit = Number(parsedUrl.searchParams.get('limit') || 120);
      const offset = Number(parsedUrl.searchParams.get('offset') || 0);
      const deck = await this._coordinator.listZeroAiDeck({
        actor,
        category,
        search,
        limit,
        offset
      });
      this._sendJson(res, 200, deck);
      return;
    }

    // Crimson Shadow Knight Skin (`/api/v1/skins`)
    if (method === 'GET' && pathname === '/api/v1/skins') {
      const skins = await this._coordinator.listSkins({ actor });
      this._sendJson(res, 200, skins);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/skins/assign') {
      const body = await this._readJsonBody(req, 16_384);
      const proto = this._config.tls?.enabled ? 'https' : 'http';
      const hostHdr = req.headers.host || `${this._config.http.host}:${this._boundPort}`;
      const assigned = await this._coordinator.assignSkin({
        actor,
        botId: body.botId || null,
        skinId: body.skinId || null,
        preset: body.preset || null,
        publicBaseUrl: body.publicBaseUrl || `${proto}://${hostHdr}`
      });
      this._sendJson(res, 200, assigned);
      return;
    }

    // Live Server Players & PvP / Escort / Drop-Loot Operations (`/api/v1/players`)
    if (method === 'GET' && pathname === '/api/v1/players') {
      const playersRes = await this._coordinator.listServerPlayers({ actor });
      this._sendJson(res, 200, playersRes);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/players/action') {
      const body = await this._readJsonBody(req, 16_384);
      const actRes = await this._coordinator.dispatchPlayerTacticalAction({
        actor,
        mode: body.mode,
        targetPlayer: body.targetPlayer || null,
        botId: body.botId || '*',
        preferredWeaponStyle: body.preferredWeaponStyle || 'auto',
        itemFilter: body.itemFilter || null,
        relation: body.relation || null,
        autoEat: body.autoEat,
        autoArmor: body.autoArmor,
        preemptTask: Boolean(body.preemptTask)
      });
      this._sendJson(res, 200, actRes);
      return;
    }

    // Schematics & Blueprint Builder (`/api/v1/schematics`)
    if (method === 'GET' && pathname === '/api/v1/schematics') {
      const schRes = await this._coordinator.listSchematics({ actor });
      this._sendJson(res, 200, schRes);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/schematics/custom') {
      const body = await this._readJsonBody(req, 65_536);
      const createdSch = await this._coordinator.registerCustomSchematic({ actor, spec: body });
      this._sendJson(res, 201, createdSch);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/schematics/build') {
      const body = await this._readJsonBody(req, 16_384);
      const built = await this._coordinator.buildSchematicNow({
        actor,
        schematicId: body.schematicId,
        botId: body.botId || null
      });
      this._sendJson(res, 200, built);
      return;
    }

    // Multi-Provider AI Brain Switcher (`/api/v1/ai/config` — Gemini, ChatGPT, Claude, Groq, OpenRouter, etc.)
    if (method === 'POST' && pathname === '/api/v1/ai/config') {
      const body = await this._readJsonBody(req, 16_384);
      const aiRes = await this._coordinator.updateAiProviderConfig({
        actor,
        provider: body.provider,
        apiKey: body.apiKey,
        model: body.model,
        baseUrl: body.baseUrl
      });
      this._sendJson(res, 200, aiRes);
      return;
    }

    throw new DomainError('NOT_FOUND', `API route not found: ${method} ${pathname}`);
  }
}

module.exports = { MasterHttpServer };
