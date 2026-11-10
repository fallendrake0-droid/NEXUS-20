'use strict';

const { BoundedByteQueue } = require('./BoundedByteQueue');

/**
 * Event-driven coalescing Server-Sent Events (SSE) publisher with single-pass serialization.
 *
 * Optimisations #10, #12 & #14 (PERFORMANCE_PLAN.md §6 & §8):
 * - Coalesces rapid telemetry/bot/task updates by `(eventType, entityKey)` so 20 bots
 *   updating 20 times/sec do NOT trigger 400 SSE broadcasts/sec per browser tab.
 * - Serializes each flushed SSE frame ONCE to a shared UTF-8 Buffer and writes that
 *   same Buffer to all connected clients (eliminating N x JSON.stringify overhead).
 * - Caps concurrent SSE clients and bounds each slow client's backlog to 100 events
 *   (and maxBytes); on overflow, notifies client to reload a compact snapshot and closes.
 * - Supports client background-tab throttling (`visibility = 'hidden'`) and adaptive
 *   interval lengthening from WorkloadGovernor.
 */
class SseCoalescer {
  /**
   * @param {object} [options]
   * @param {number} [options.flushIntervalMs=1000] Coalesce window (1 Hz default)
   * @param {number} [options.hiddenClientSkipFactor=3] Send every Nth summary to hidden tabs
   * @param {number} [options.maxClients=16] Bounded SSE client limit
   * @param {number} [options.maxClientQueueEvents=100] Per-client queue cap (PERFORMANCE_PLAN.md §6)
   * @param {number} [options.maxClientQueueBytes=131072] 128 KiB per-client buffer cap
   * @param {import('./TimerRegistry').TimerRegistry} [options.timerRegistry]
   * @param {(metrics: object) => void} [options.onFlushMetrics]
   */
  constructor(options = {}) {
    this._flushIntervalMs = options.flushIntervalMs || 1000;
    this._hiddenClientSkipFactor = options.hiddenClientSkipFactor || 3;
    this._maxClients = options.maxClients || 16;
    this._maxClientQueueEvents = options.maxClientQueueEvents || 100;
    this._maxClientQueueBytes = options.maxClientQueueBytes || 131_072;
    this._timerRegistry = options.timerRegistry || null;
    this._onFlushMetrics = typeof options.onFlushMetrics === 'function' ? options.onFlushMetrics : null;

    /** @type {Map<string, { id: string, res: object, queue: BoundedByteQueue, hidden: boolean, backpressured: boolean, cleanup: Function }>} */
    this._clients = new Map();
    /** @type {Map<string, { eventType: string, data: object }>} */
    this._pendingByKey = new Map();

    this._timerHandle = null;
    this._unregisterTimer = null;
    this._flushTick = 0;
    this._eventIdSeq = 0;

    // Telemetry counters
    this._rawEventsIngested = 0;
    this._coalescedEventsDropped = 0;
    this._flushesCount = 0;
    this._framesSerialized = 0;
    this._totalSerializedBytes = 0;
    this._totalNetworkBytesWritten = 0;
    this._overflowDisconnects = 0;
    this._rejectedClients = 0;
  }

  get clientCount() {
    return this._clients.size;
  }

  get flushIntervalMs() {
    return this._flushIntervalMs;
  }

  start() {
    this._scheduleTimer();
  }

  stop() {
    this._clearTimer();
    for (const clientId of Array.from(this._clients.keys())) {
      this.removeClient(clientId, 'shutdown');
    }
    this._pendingByKey.clear();
  }

  dispose() {
    this.stop();
  }

  /**
   * Dynamically adjust flush cadence and max client cap from WorkloadGovernor.
   * @param {{ flushIntervalMs?: number, maxClients?: number }} policy
   */
  applyGovernorPolicy(policy = {}) {
    let timerChanged = false;
    if (
      typeof policy.flushIntervalMs === 'number' &&
      policy.flushIntervalMs >= 100 &&
      policy.flushIntervalMs !== this._flushIntervalMs
    ) {
      this._flushIntervalMs = Math.trunc(policy.flushIntervalMs);
      timerChanged = true;
    }
    if (typeof policy.maxClients === 'number' && policy.maxClients >= 0) {
      this._maxClients = Math.trunc(policy.maxClients);
      // Shed oldest non-essential SSE streams when critical pressure lowers maxClients
      while (this._clients.size > this._maxClients) {
        const oldestClientId = this._clients.keys().next().value;
        if (oldestClientId === undefined) break;
        this._disconnectForReload(oldestClientId, 'governor_pressure');
      }
    }
    if (timerChanged && (this._timerHandle || this._unregisterTimer)) {
      this._clearTimer();
      this._scheduleTimer();
    }
  }

  /**
   * Subscribe an HTTP ServerResponse (or Express `res`) stream.
   * @param {string} clientId
   * @param {object} res HTTP response-compatible writable with write(), end(), on()
   * @param {{ hidden?: boolean }} [meta]
   */
  addClient(clientId, res, meta = {}) {
    const id = String(clientId);
    if (this._clients.has(id)) {
      this.removeClient(id, 'replaced');
    }
    if (this._clients.size >= this._maxClients) {
      this._rejectedClients += 1;
      return { accepted: false, reason: 'MAX_SSE_CLIENTS_REACHED' };
    }

    let overflowed = false;
    const queue = new BoundedByteQueue({
      name: `sse:${id}`,
      maxItems: this._maxClientQueueEvents,
      maxBytes: this._maxClientQueueBytes,
      overflowPolicy: 'disconnect_reload',
      onOverflow: () => {
        overflowed = true;
      }
    });

    const onDrain = () => {
      const client = this._clients.get(id);
      if (!client) return;
      client.backpressured = false;
      this._drainClientQueue(client);
    };
    const onClose = () => {
      this.removeClient(id, 'closed');
    };

    if (typeof res.on === 'function') {
      res.on('drain', onDrain);
      res.on('close', onClose);
      res.on('error', onClose);
    }

    const cleanup = () => {
      if (typeof res.removeListener === 'function') {
        res.removeListener('drain', onDrain);
        res.removeListener('close', onClose);
        res.removeListener('error', onClose);
      }
    };

    this._clients.set(id, {
      id,
      res,
      queue,
      hidden: Boolean(meta.hidden),
      backpressured: false,
      isOverflowed: () => overflowed,
      cleanup
    });

    return { accepted: true, clientCount: this._clients.size };
  }

  /**
   * Update client visibility hint (PERFORMANCE_PLAN.md §8: reduce rendering when tab backgrounded).
   */
  setClientVisibility(clientId, hidden) {
    const client = this._clients.get(String(clientId));
    if (!client) return false;
    client.hidden = Boolean(hidden);
    return true;
  }

  removeClient(clientId, _reason = 'removed') {
    const id = String(clientId);
    const client = this._clients.get(id);
    if (!client) return false;
    this._clients.delete(id);
    client.queue.clear();
    client.cleanup();
    try {
      if (typeof client.res.end === 'function' && !client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Ignore socket close races
    }
    return true;
  }

  /**
   * Enqueue an event for coalesced broadcast. Latest state per `(eventType, coalesceKey)` wins.
   * If zero clients are connected, drops optional UI telemetry immediately with ZERO JSON work!
   *
   * @param {string} eventType e.g. 'telemetry.summary', 'bot.status', 'task.progress'
   * @param {string} coalesceKey e.g. botId, taskId, or 'global'
   * @param {object} data Plain JSON-serializable summary DTO
   */
  publish(eventType, coalesceKey, data) {
    this._rawEventsIngested += 1;
    if (this._clients.size === 0) {
      // Zero connected browsers -> zero retained buffers & zero JSON serialization
      this._coalescedEventsDropped += 1;
      return;
    }
    const compositeKey = `${eventType}:${coalesceKey}`;
    if (this._pendingByKey.has(compositeKey)) {
      this._coalescedEventsDropped += 1;
    }
    this._pendingByKey.set(compositeKey, { eventType, data });
  }

  /**
   * Flush all pending coalesced events in one compact batch frame serialized ONCE.
   */
  flushNow() {
    this._flushTick += 1;
    if (this._pendingByKey.size === 0 || this._clients.size === 0) {
      this._pendingByKey.clear();
      return { flushedEvents: 0, serializedBytes: 0, clientsWritten: 0 };
    }

    const items = [];
    let hasCriticalOrTaskEvent = false;
    for (const entry of this._pendingByKey.values()) {
      items.push(entry);
      if (!entry.eventType.startsWith('telemetry.')) {
        hasCriticalOrTaskEvent = true;
      }
    }
    this._pendingByKey.clear();

    this._eventIdSeq += 1;
    const envelope = {
      schemaVersion: 1,
      batchId: this._eventIdSeq,
      count: items.length,
      events: items
    };

    // Single JSON serialization into one shared UTF-8 Buffer for ALL clients
    const frameBuffer = Buffer.from(
      `id: ${this._eventIdSeq}\nevent: summary\ndata: ${JSON.stringify(envelope)}\n\n`,
      'utf8'
    );

    this._flushesCount += 1;
    this._framesSerialized += 1;
    this._totalSerializedBytes += frameBuffer.byteLength;

    let clientsWritten = 0;
    for (const [clientId, client] of Array.from(this._clients.entries())) {
      if (
        client.hidden &&
        !hasCriticalOrTaskEvent &&
        this._flushTick % this._hiddenClientSkipFactor !== 0
      ) {
        continue;
      }

      if (this._writeFrameToClient(clientId, client, frameBuffer)) {
        clientsWritten += 1;
      }
    }

    if (this._onFlushMetrics) {
      this._onFlushMetrics({
        clients: this._clients.size,
        rawEvents: items.length,
        coalescedFlushes: 1,
        serializedBytes: frameBuffer.byteLength,
        droppedOverflow: this._overflowDisconnects
      });
    }

    return {
      flushedEvents: items.length,
      serializedBytes: frameBuffer.byteLength,
      clientsWritten
    };
  }

  _writeFrameToClient(clientId, client, frameBuffer) {
    if (client.backpressured || client.queue.length > 0) {
      const enq = client.queue.enqueue(frameBuffer, frameBuffer.byteLength);
      if (!enq.ok) {
        this._disconnectForReload(clientId, enq.reason);
        return false;
      }
      return true;
    }

    try {
      const ok = client.res.write(frameBuffer);
      this._totalNetworkBytesWritten += frameBuffer.byteLength;
      if (ok === false) {
        client.backpressured = true;
      }
      return true;
    } catch {
      this.removeClient(clientId, 'write_error');
      return false;
    }
  }

  _drainClientQueue(client) {
    while (client.queue.length > 0 && !client.backpressured) {
      const buf = client.queue.dequeue();
      if (!buf) break;
      try {
        const ok = client.res.write(buf);
        this._totalNetworkBytesWritten += buf.byteLength;
        if (ok === false) {
          client.backpressured = true;
          break;
        }
      } catch {
        this.removeClient(client.id, 'drain_error');
        return;
      }
    }
  }

  _disconnectForReload(clientId, reason) {
    const client = this._clients.get(clientId);
    if (!client) return;
    this._overflowDisconnects += 1;
    try {
      const notice = Buffer.from(
        `retry: 2000\nevent: reload_required\ndata: {"reason":${JSON.stringify(reason)}}\n\n`,
        'utf8'
      );
      client.res.write(notice);
    } catch {
      // Ignore write error on saturated socket
    }
    this.removeClient(clientId, reason);
  }

  _scheduleTimer() {
    if (this._timerRegistry) {
      this._unregisterTimer = this._timerRegistry.registerInterval(
        'sse-coalescer-flush',
        this._flushIntervalMs,
        () => this.flushNow()
      );
    } else {
      this._timerHandle = setInterval(() => this.flushNow(), this._flushIntervalMs);
      if (typeof this._timerHandle.unref === 'function') {
        this._timerHandle.unref();
      }
    }
  }

  _clearTimer() {
    if (this._unregisterTimer) {
      this._unregisterTimer();
      this._unregisterTimer = null;
    }
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
  }

  stats() {
    let queuedEventsTotal = 0;
    let queuedBytesTotal = 0;
    for (const c of this._clients.values()) {
      queuedEventsTotal += c.queue.length;
      queuedBytesTotal += c.queue.byteSize;
    }
    return {
      activeClients: this._clients.size,
      maxClients: this._maxClients,
      flushIntervalMs: this._flushIntervalMs,
      pendingCoalescedKeys: this._pendingByKey.size,
      rawEventsIngested: this._rawEventsIngested,
      coalescedEventsDropped: this._coalescedEventsDropped,
      flushesCount: this._flushesCount,
      framesSerialized: this._framesSerialized,
      totalSerializedBytes: this._totalSerializedBytes,
      totalNetworkBytesWritten: this._totalNetworkBytesWritten,
      queuedEventsTotal,
      queuedBytesTotal,
      overflowDisconnects: this._overflowDisconnects,
      rejectedClients: this._rejectedClients
    };
  }
}

module.exports = { SseCoalescer };
