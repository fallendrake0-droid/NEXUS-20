'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { BoundedByteQueue } = require('../performance/BoundedByteQueue');
const { DomainError } = require('../errors/DomainError');

/**
 * Zero-dependency HTTP/HTTPS Worker-to-Master RPC client (`ARCHITECTURE.md` §3, `SECURITY_PLAN.md` §3–4).
 *
 * Key Guarantees:
 * - Authenticates via `X-Worker-Id` + `Authorization: Bearer <workerToken>`.
 * - Maintains monotonic `workerSequence` synced with Master's `lastAckedWorkerSequence` (`HIGH-05`).
 * - Buffers outbound worker events in a `BoundedByteQueue` (`maxItems=256`, `maxBytes=512 KiB`)
 *   during transient network drops so verified completions are never silently lost nor leak RAM.
 * - Supports custom TLS CA (`caCertPath`) and hard per-request socket timeouts.
 */
class MasterClient {
  /**
   * @param {object} options
   * @param {string} options.masterUrl
   * @param {string} options.workerId
   * @param {string|null} [options.workerToken=null]
   * @param {string|null} [options.caCertPath=null]
   * @param {number} [options.timeoutMs=8000]
   * @param {number} [options.maxBufferedEvents=256]
   * @param {number} [options.maxBufferedBytes=524288]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    if (!options.masterUrl) {
      throw new TypeError('MasterClient requires masterUrl');
    }
    if (!options.workerId) {
      throw new TypeError('MasterClient requires workerId');
    }

    this._baseUrl = new URL(String(options.masterUrl));
    this._workerId = String(options.workerId).trim();
    this._workerToken = options.workerToken || null;
    this._timeoutMs = Math.max(500, Math.trunc(options.timeoutMs ?? 8_000));
    this._logger = options.logger || null;
    this._caCert = options.caCertPath && fs.existsSync(options.caCertPath)
      ? fs.readFileSync(options.caCertPath)
      : null;

    const isHttps = this._baseUrl.protocol === 'https:';
    this._agent = isHttps
      ? new https.Agent({
          keepAlive: true,
          maxSockets: 4,
          ...(this._caCert ? { ca: this._caCert } : {})
        })
      : new http.Agent({ keepAlive: true, maxSockets: 4 });

    this._workerSequence = 0;
    this._consecutiveFailures = 0;
    this._droppedOverflowEvents = 0;

    this._outbox = new BoundedByteQueue({
      maxItems: options.maxBufferedEvents ?? 256,
      maxBytes: options.maxBufferedBytes ?? 512 * 1024,
      overflowPolicy: 'drop_oldest',
      onDrop: () => {
        this._droppedOverflowEvents += 1;
      }
    });
  }

  get workerId() {
    return this._workerId;
  }

  get hasCredentials() {
    return Boolean(this._workerToken);
  }

  get workerSequence() {
    return this._workerSequence;
  }

  get bufferedEventCount() {
    return this._outbox.length;
  }

  setCredentials(workerToken, lastAckedWorkerSequence = null) {
    this._workerToken = workerToken || null;
    if (Number.isSafeInteger(lastAckedWorkerSequence) && lastAckedWorkerSequence >= 0) {
      this._workerSequence = Math.max(this._workerSequence, lastAckedWorkerSequence);
    }
  }

  syncSequence(lastAckedWorkerSequence) {
    if (Number.isSafeInteger(lastAckedWorkerSequence) && lastAckedWorkerSequence > this._workerSequence) {
      this._workerSequence = lastAckedWorkerSequence;
    }
  }

  /**
   * Compute bounded exponential backoff with ±20% random jitter (`250ms -> 15000ms`).
   */
  nextBackoffMs() {
    if (this._consecutiveFailures <= 0) return 0;
    const exp = Math.min(15_000, 250 * 2 ** Math.min(6, this._consecutiveFailures - 1));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(exp * jitter);
  }

  /**
   * Enroll with single-use `bootstrapToken` (`POST /worker/v1/register`).
   */
  async register({ bootstrapToken, workerInfo }) {
    const res = await this._request('POST', '/worker/v1/register', {
      bootstrapToken,
      workerInfo
    }, { authenticated: false });

    this._workerToken = res.workerToken;
    this._workerSequence = Number.isSafeInteger(res.lastAckedWorkerSequence)
      ? res.lastAckedWorkerSequence
      : 0;
    return res;
  }

  /**
   * Send periodic worker heartbeat + compact bot snapshots + world observations (`POST /worker/v1/heartbeat`).
   */
  async heartbeat({
    botSnapshots = [],
    worldObservations = [],
    observedPlayers = [],
    botTacticalStates = {}
  } = {}) {
    const ack = await this._request('POST', '/worker/v1/heartbeat', {
      botSnapshots,
      worldObservations,
      observedPlayers,
      botTacticalStates
    });
    this.syncSequence(ack.lastAckedWorkerSequence);
    return ack;
  }

  /**
   * Poll pending worker commands (`GET /worker/v1/commands`).
   */
  async pollCommands(limit = 25) {
    const res = await this._request('GET', `/worker/v1/commands?limit=${Math.trunc(limit)}`);
    return Array.isArray(res.commands) ? res.commands : [];
  }

  /**
   * Acknowledge a command or assignment offer (`POST /worker/v1/commands/:id/ack`).
   */
  async ackCommand(commandId, ackBody = {}) {
    return this._request(
      'POST',
      `/worker/v1/commands/${encodeURIComponent(commandId)}/ack`,
      ackBody
    );
  }

  /**
   * Reconcile active leases after reconnect (`POST /worker/v1/reconcile`).
   */
  async reconcile(activeLeases = []) {
    const res = await this._request('POST', '/worker/v1/reconcile', { activeLeases });
    this.syncSequence(res.lastAckedWorkerSequence);
    return res;
  }

  /**
   * Enqueue a `DomainEventEnvelopeV1` into the bounded outbound queue with monotonic `workerSequence`.
   */
  enqueueEvent(eventType, payload, createdAt = new Date().toISOString()) {
    this._workerSequence += 1;
    const envelope = {
      schemaVersion: 1,
      messageId: crypto.randomUUID(),
      workerId: this._workerId,
      workerSequence: this._workerSequence,
      createdAt,
      eventType,
      payload
    };
    const approxBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    this._outbox.enqueue(envelope, approxBytes);
    return envelope;
  }

  /**
   * Flush up to `maxBatchSize` queued events to `POST /worker/v1/events`.
   * Re-queues batch on transient network error so zero verified reports are dropped!
   */
  async flushEvents(maxBatchSize = 50) {
    if (this._outbox.length === 0) {
      return { sent: 0, results: [] };
    }
    const cap = Math.min(100, Math.max(1, Math.trunc(maxBatchSize)));
    const batch = [];
    while (batch.length < cap && this._outbox.length > 0) {
      const item = this._outbox.dequeue();
      if (item) batch.push(item);
    }
    if (batch.length === 0) {
      return { sent: 0, results: [] };
    }

    try {
      const res = await this._request('POST', '/worker/v1/events', { events: batch });
      return { sent: batch.length, results: Array.isArray(res.results) ? res.results : [] };
    } catch (err) {
      // Re-enqueue unsent events on transient network failure (preserving order as closely as possible)
      for (const item of batch) {
        const approxBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
        this._outbox.enqueue(item, approxBytes);
      }
      throw err;
    }
  }

  async _request(method, reqPath, bodyObj = undefined, { authenticated = true, _retriedReuse = false } = {}) {
    if (authenticated && !this._workerToken) {
      throw new DomainError('UNAUTHENTICATED', 'MasterClient has no workerToken');
    }

    const isHttps = this._baseUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const targetUrl = new URL(reqPath, this._baseUrl);
    const bodyBuf = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;

    const headers = {
      Accept: 'application/json'
    };
    if (authenticated) {
      headers['X-Worker-Id'] = this._workerId;
      headers.Authorization = `Bearer ${this._workerToken}`;
    }
    if (bodyBuf !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = bodyBuf.byteLength;
    }

    return new Promise((resolve, reject) => {
      const reqOpts = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers,
        agent: this._agent,
        ...(isHttps && this._caCert ? { ca: this._caCert } : {})
      };

      let settled = false;
      const finishErr = (err, reqRef) => {
        if (settled) return;
        settled = true;
        if (
          !_retriedReuse &&
          reqRef?.reusedSocket &&
          (err?.code === 'ECONNRESET' || err?.message === 'socket hang up')
        ) {
          this._request(method, reqPath, bodyObj, { authenticated, _retriedReuse: true }).then(
            resolve,
            reject
          );
          return;
        }
        this._consecutiveFailures += 1;
        reject(err);
      };

      const req = transport.request(reqOpts, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.byteLength;
          if (total <= 2 * 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            this._consecutiveFailures = 0;
            resolve(parsed);
            return;
          }
          this._consecutiveFailures += 1;
          const code = parsed?.error?.code || 'UPSTREAM_ERROR';
          const msg = parsed?.error?.message || `Master HTTP ${res.statusCode} on ${method} ${reqPath}`;
          const domainErr = new DomainError(code, msg, { details: { httpStatus: res.statusCode } });
          reject(domainErr);
        });
      });

      const timer = setTimeout(() => {
        req.destroy(new Error(`MasterClient timeout (${this._timeoutMs}ms) on ${method} ${reqPath}`));
      }, this._timeoutMs);

      req.on('close', () => clearTimeout(timer));
      req.on('error', (err) => {
        clearTimeout(timer);
        finishErr(err, req);
      });

      if (bodyBuf !== null) {
        req.write(bodyBuf);
      }
      req.end();
    });
  }

  destroy() {
    this._agent.destroy();
  }

  stats() {
    return {
      workerId: this._workerId,
      hasCredentials: this.hasCredentials,
      workerSequence: this._workerSequence,
      consecutiveFailures: this._consecutiveFailures,
      bufferedEventCount: this._outbox.length,
      bufferedBytes: this._outbox.byteSize,
      droppedOverflowEvents: this._droppedOverflowEvents
    };
  }
}

module.exports = { MasterClient };
