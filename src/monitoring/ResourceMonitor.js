'use strict';

const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { RingBuffer } = require('../performance/RingBuffer');
const { countEmitterListeners } = require('../performance/ScopedListeners');

/**
 * Read Linux / Android `/proc/meminfo` MemTotal & MemAvailable.
 * Note: On Linux/Android, `os.freemem()` reads `MemFree` (ignoring reclaimable page cache)
 * and underestimates truly available memory, while SELinux on some Android builds may
 * restrict `/proc` access. Returns `'unavailable'` when unreadable — NEVER `0` (AGENTS.md).
 */
function readSystemMemory() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    let memTotalKb = null;
    let memAvailableKb = null;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('MemTotal:')) {
        const m = /(\d+)/.exec(line);
        if (m) memTotalKb = Number(m[1]);
      } else if (line.startsWith('MemAvailable:')) {
        const m = /(\d+)/.exec(line);
        if (m) memAvailableKb = Number(m[1]);
      }
      if (memTotalKb !== null && memAvailableKb !== null) break;
    }
    if (memTotalKb !== null && memAvailableKb !== null) {
      return {
        totalBytes: memTotalKb * 1024,
        availableBytes: memAvailableKb * 1024,
        source: '/proc/meminfo'
      };
    }
  } catch {
    // Fall through to os module probe
  }

  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0) {
      return {
        totalBytes: total,
        availableBytes: 'unavailable',
        rawFreeBytes: free,
        source: 'node:os_memfree'
      };
    }
  } catch {
    // Platform unavailable
  }

  return {
    totalBytes: 'unavailable',
    availableBytes: 'unavailable',
    source: 'unavailable'
  };
}

function inspectRuntimeHandles() {
  if (typeof process.getActiveResourcesInfo === 'function') {
    try {
      const resources = process.getActiveResourcesInfo();
      let timers = 0;
      for (let i = 0; i < resources.length; i += 1) {
        if (resources[i] === 'Timeout' || resources[i] === 'Immediate') {
          timers += 1;
        }
      }
      return {
        activeHandles: resources.length,
        activeTimers: timers
      };
    } catch {
      // Fall through
    }
  }
  if (typeof process._getActiveHandles === 'function') {
    try {
      const handles = process._getActiveHandles();
      let timers = 0;
      for (let i = 0; i < handles.length; i += 1) {
        const h = handles[i];
        const name = h && h.constructor ? h.constructor.name : '';
        if (name === 'Timer' || name === 'Timeout') {
          timers += 1;
        }
      }
      return {
        activeHandles: handles.length,
        activeTimers: timers
      };
    } catch {
      return { activeHandles: 'unavailable', activeTimers: 'unavailable' };
    }
  }
  return { activeHandles: 'unavailable', activeTimers: 'unavailable' };
}

function computePercentiles(values) {
  if (!values || values.length === 0) {
    return { p50: null, p95: null, p99: null, max: null, min: null };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  };
  return {
    min: sorted[0],
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]
  };
}

/**
 * Low-overhead process & subsystem telemetry monitor (MODULE_INTERFACES.md §17 & PERFORMANCE_PLAN.md §3).
 */
class ResourceMonitor {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleIntervalMs=5000] Initial target: 5 seconds (PERFORMANCE_PLAN.md §3)
   * @param {number} [options.windowSize=60] Rolling window capacity (60 samples = 5 min at 5s)
   * @param {number} [options.fullHeapEveryNSamples=1] Set >1 to use cheaper process.memoryUsage.rss() between heap snapshots
   * @param {object} [options.thresholds]
   * @param {number} [options.thresholds.warningRssBytes=230686720] Candidate 220 MiB master RSS warning (calibrate on A06 per U-12)
   * @param {number} [options.thresholds.criticalRssBytes=314572800] Candidate 300 MiB master RSS critical (calibrate on A06 per U-12)
   * @param {number} [options.thresholds.warningEventLoopLagMs=60]
   * @param {number} [options.thresholds.criticalEventLoopLagMs=180]
   * @param {number} [options.thresholds.warningCpuPercent=75]
   * @param {number} [options.thresholds.criticalCpuPercent=92]
   * @param {number} [options.thresholds.warningSystemAvailableBytes=419430400] 400 MiB OS MemAvailable
   * @param {number} [options.thresholds.criticalSystemAvailableBytes=230686720] 220 MiB OS MemAvailable
   * @param {import('../performance/TimerRegistry').TimerRegistry} [options.timerRegistry]
   * @param {(sample: object) => void} [options.onSample]
   */
  constructor(options = {}) {
    this._sampleIntervalMs = options.sampleIntervalMs || 5000;
    this._window = new RingBuffer(options.windowSize || 60);
    this._fullHeapEveryNSamples = Math.max(1, Math.trunc(options.fullHeapEveryNSamples || 1));
    this._timerRegistry = options.timerRegistry || null;
    this._onSample = typeof options.onSample === 'function' ? options.onSample : null;

    const t = options.thresholds || {};
    this._thresholds = {
      warningRssBytes: t.warningRssBytes ?? 175 * 1024 * 1024,
      criticalRssBytes: t.criticalRssBytes ?? 215 * 1024 * 1024,
      warningEventLoopLagMs: t.warningEventLoopLagMs ?? 60,
      criticalEventLoopLagMs: t.criticalEventLoopLagMs ?? 180,
      warningCpuPercent: t.warningCpuPercent ?? 75,
      criticalCpuPercent: t.criticalCpuPercent ?? 92,
      warningSystemAvailableBytes: t.warningSystemAvailableBytes ?? 550 * 1024 * 1024,
      criticalSystemAvailableBytes: t.criticalSystemAvailableBytes ?? 350 * 1024 * 1024
    };

    const heapStats = typeof v8.getHeapStatistics === 'function' ? v8.getHeapStatistics() : null;
    this._v8HeapLimitBytes =
      heapStats && typeof heapStats.heap_size_limit === 'number'
        ? heapStats.heap_size_limit
        : 256 * 1024 * 1024;

    this._cpuCount =
      typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : (os.cpus() || []).length || 1;

    this._startedAtMs = Date.now();
    this._lastSampleWallNs = process.hrtime.bigint();
    this._lastCpuUsage = typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;
    this._lastFullMem = process.memoryUsage();
    this._sampleCounter = 0;

    this._eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    this._manualLagMaxMs = 0;
    this._dbLatencies = new RingBuffer(128);

    // Pluggable probes for Coordinator, Queues, Caches, Emitters, Network, AI & Dashboard
    /** @type {Map<string, () => number | object>} */
    this._queueProbes = new Map();
    /** @type {Map<string, { stats: () => object }>} */
    this._caches = new Map();
    /** @type {Map<string, import('events').EventEmitter>} */
    this._emitters = new Map();

    this._network = {
      rxBytes: 0,
      txBytes: 0,
      httpRequestsTotal: 0,
      activeHttpRequests: 0,
      lastSampleRxBytes: 0,
      lastSampleTxBytes: 0,
      lastSampleMs: Date.now()
    };

    this._ai = {
      requestsTotal: 0,
      llmCallsExecuted: 0,
      deduplicatedTotal: 0,
      cacheHitsTotal: 0,
      deterministicFastPathTotal: 0,
      fallbackTotal: 0,
      timeoutsTotal: 0,
      rejectedQueueTotal: 0,
      validationFailuresTotal: 0,
      requestTimestamps: new RingBuffer(512)
    };

    this._dashboard = {
      activeClients: 0,
      rawEventsIngested: 0,
      coalescedFlushes: 0,
      serializedBytesTotal: 0,
      droppedOverflow: 0,
      lastSerializedBytes: 0,
      lastSampleMs: Date.now()
    };

    this._timerHandle = null;
    this._unregisterTimer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._eldHistogram.enable();
    this._lastSampleWallNs = process.hrtime.bigint();
    this._lastCpuUsage = typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;

    if (this._timerRegistry) {
      this._unregisterTimer = this._timerRegistry.registerInterval(
        'resource-monitor-sample',
        this._sampleIntervalMs,
        () => this.sampleNow()
      );
    } else {
      this._timerHandle = setInterval(() => this.sampleNow(), this._sampleIntervalMs);
      if (typeof this._timerHandle.unref === 'function') {
        this._timerHandle.unref();
      }
    }
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._unregisterTimer) {
      this._unregisterTimer();
      this._unregisterTimer = null;
    }
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
    this._eldHistogram.disable();
  }

  recordEventLoopLag(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
      if (ms > this._manualLagMaxMs) {
        this._manualLagMaxMs = ms;
      }
    }
  }

  recordDbLatency(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
      this._dbLatencies.push(ms);
    }
  }

  recordNetworkBytes({ rxBytes = 0, txBytes = 0, requestStarted = false, requestEnded = false } = {}) {
    if (rxBytes > 0) this._network.rxBytes += rxBytes;
    if (txBytes > 0) this._network.txBytes += txBytes;
    if (requestStarted) {
      this._network.httpRequestsTotal += 1;
      this._network.activeHttpRequests += 1;
    }
    if (requestEnded) {
      this._network.activeHttpRequests = Math.max(0, this._network.activeHttpRequests - 1);
    }
  }

  recordAiEvent(kind, nowMs = Date.now()) {
    this._ai.requestsTotal += 1;
    if (kind === 'llmCall') {
      this._ai.llmCallsExecuted += 1;
      this._ai.requestTimestamps.push(nowMs);
    } else if (kind === 'deduplicated') {
      this._ai.deduplicatedTotal += 1;
    } else if (kind === 'cacheHit') {
      this._ai.cacheHitsTotal += 1;
    } else if (kind === 'deterministicFastPath') {
      this._ai.deterministicFastPathTotal += 1;
    } else if (kind === 'fallback') {
      this._ai.fallbackTotal += 1;
    } else if (kind === 'timeout') {
      this._ai.timeoutsTotal += 1;
    } else if (kind === 'rejectedQueue') {
      this._ai.rejectedQueueTotal += 1;
    } else if (kind === 'validationFailed') {
      this._ai.validationFailuresTotal += 1;
    }
  }

  recordDashboardUpdate({
    clients,
    rawEvents = 0,
    coalescedFlushes = 0,
    serializedBytes = 0,
    droppedOverflow = 0
  } = {}) {
    if (typeof clients === 'number') this._dashboard.activeClients = clients;
    this._dashboard.rawEventsIngested += rawEvents;
    this._dashboard.coalescedFlushes += coalescedFlushes;
    this._dashboard.serializedBytesTotal += serializedBytes;
    this._dashboard.droppedOverflow = Math.max(this._dashboard.droppedOverflow, droppedOverflow);
  }

  registerQueueProbe(name, probeFn) {
    this._queueProbes.set(String(name), probeFn);
  }

  unregisterQueueProbe(name) {
    this._queueProbes.delete(String(name));
  }

  registerCache(name, cacheInstance) {
    this._caches.set(String(name), cacheInstance);
  }

  unregisterCache(name) {
    this._caches.delete(String(name));
  }

  registerEmitter(name, emitter) {
    this._emitters.set(String(name), emitter);
  }

  unregisterEmitter(name) {
    this._emitters.delete(String(name));
  }

  /**
   * Collect one complete resource & runtime telemetry sample.
   * @param {{ forceFullMemory?: boolean }} [options]
   */
  sampleNow(options = {}) {
    this._sampleCounter += 1;
    const nowMs = Date.now();
    const nowNs = process.hrtime.bigint();
    const elapsedUs = Number(nowNs - this._lastSampleWallNs) / 1000;
    this._lastSampleWallNs = nowNs;

    // 1. Memory (use rss-only fast path when configured, full memoryUsage otherwise)
    let mem;
    const doFull =
      options.forceFullMemory === true ||
      this._sampleCounter % this._fullHeapEveryNSamples === 0 ||
      typeof process.memoryUsage.rss !== 'function';

    if (doFull) {
      mem = process.memoryUsage();
      this._lastFullMem = mem;
    } else {
      const rss = process.memoryUsage.rss();
      mem = {
        rss,
        heapTotal: this._lastFullMem.heapTotal,
        heapUsed: this._lastFullMem.heapUsed,
        external: this._lastFullMem.external,
        arrayBuffers: this._lastFullMem.arrayBuffers
      };
    }

    const sysMem = readSystemMemory();

    // 2. CPU delta
    let cpu = {
      userMicros: 'unavailable',
      systemMicros: 'unavailable',
      percentSingleCore: 'unavailable',
      percentNormalized: 'unavailable'
    };
    if (typeof process.cpuUsage === 'function') {
      const delta = process.cpuUsage(this._lastCpuUsage || undefined);
      this._lastCpuUsage = process.cpuUsage();
      const totalCpuUs = delta.user + delta.system;
      const pctSingle = elapsedUs > 100 ? +((totalCpuUs / elapsedUs) * 100).toFixed(2) : 0;
      const pctNorm =
        elapsedUs > 100 ? +((totalCpuUs / (elapsedUs * this._cpuCount)) * 100).toFixed(2) : 0;
      cpu = {
        userMicros: delta.user,
        systemMicros: delta.system,
        percentSingleCore: pctSingle,
        percentNormalized: pctNorm
      };
    }

    // 3. Event-loop delay
    let eldP50 = 0;
    let eldP95 = 0;
    let eldP99 = 0;
    let eldMax = 0;
    let eldMean = 0;
    if (this._eldHistogram.count > 0) {
      eldP50 = +(this._eldHistogram.percentile(50) / 1e6).toFixed(2);
      eldP95 = +(this._eldHistogram.percentile(95) / 1e6).toFixed(2);
      eldP99 = +(this._eldHistogram.percentile(99) / 1e6).toFixed(2);
      eldMax = +(this._eldHistogram.max / 1e6).toFixed(2);
      eldMean = +(this._eldHistogram.mean / 1e6).toFixed(2);
      this._eldHistogram.reset();
    }
    const effectiveMaxLag = Math.max(eldMax, this._manualLagMaxMs);
    const effectiveP95Lag = Math.max(eldP95, this._manualLagMaxMs);
    this._manualLagMaxMs = 0;

    // 4. Network traffic rate
    const netElapsedSec = Math.max(0.001, (nowMs - this._network.lastSampleMs) / 1000);
    const rxDelta = this._network.rxBytes - this._network.lastSampleRxBytes;
    const txDelta = this._network.txBytes - this._network.lastSampleTxBytes;
    this._network.lastSampleRxBytes = this._network.rxBytes;
    this._network.lastSampleTxBytes = this._network.txBytes;
    this._network.lastSampleMs = nowMs;

    // 5. Queues
    const queues = {};
    for (const [name, fn] of this._queueProbes.entries()) {
      try {
        queues[name] = fn();
      } catch {
        queues[name] = 'unavailable';
      }
    }

    // 6. Active timers & runtime handles
    const runtimeHandles = inspectRuntimeHandles();
    const timerStats = this._timerRegistry ? this._timerRegistry.stats() : null;

    // 7. Event listener counts
    let totalEvents = 0;
    let totalListeners = 0;
    const emitterBreakdown = {};
    for (const [name, emitter] of this._emitters.entries()) {
      const counts = countEmitterListeners(emitter);
      totalEvents += counts.events;
      totalListeners += counts.listeners;
      emitterBreakdown[name] = counts.listeners;
    }

    // 8. Cache sizes
    let totalCacheEntries = 0;
    let totalCacheBytes = 0;
    let totalCacheHits = 0;
    let totalCacheMisses = 0;
    let totalCacheEvictions = 0;
    const cacheBreakdown = {};
    for (const [name, cache] of this._caches.entries()) {
      if (cache && typeof cache.stats === 'function') {
        const st = cache.stats();
        totalCacheEntries += st.size || 0;
        totalCacheBytes += st.byteSize || 0;
        totalCacheHits += st.hits || 0;
        totalCacheMisses += st.misses || 0;
        totalCacheEvictions += st.evictions || 0;
        cacheBreakdown[name] = { size: st.size || 0, byteSize: st.byteSize || 0 };
      }
    }

    // 9. AI request frequency (rolling last 60 seconds)
    let llmCallsLast60s = 0;
    const cutoff60s = nowMs - 60_000;
    this._ai.requestTimestamps.forEach((ts) => {
      if (ts >= cutoff60s) llmCallsLast60s += 1;
    });

    // 10. Dashboard update overhead
    const dashElapsedSec = Math.max(0.001, (nowMs - this._dashboard.lastSampleMs) / 1000);
    const dashBytesDelta = this._dashboard.serializedBytesTotal - this._dashboard.lastSerializedBytes;
    this._dashboard.lastSerializedBytes = this._dashboard.serializedBytesTotal;
    this._dashboard.lastSampleMs = nowMs;

    // 11. DB latency summary
    const dbStats = computePercentiles(this._dbLatencies.toArray());

    const sample = {
      sampledAt: new Date(nowMs).toISOString(),
      sampledAtMs: nowMs,
      uptimeSec: +process.uptime().toFixed(2),
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        v8HeapLimitBytes: this._v8HeapLimitBytes,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
        systemTotalBytes: sysMem.totalBytes,
        systemAvailableBytes: sysMem.availableBytes,
        systemMemorySource: sysMem.source
      },
      cpu,
      eventLoopDelayMs: {
        p50: eldP50,
        p95: effectiveP95Lag,
        p99: eldP99,
        max: effectiveMaxLag,
        mean: eldMean
      },
      network: {
        rxBytesTotal: this._network.rxBytes,
        txBytesTotal: this._network.txBytes,
        rxBytesPerSec: Math.round(rxDelta / netElapsedSec),
        txBytesPerSec: Math.round(txDelta / netElapsedSec),
        httpRequestsTotal: this._network.httpRequestsTotal,
        activeHttpRequests: this._network.activeHttpRequests
      },
      queues,
      timers: {
        runtimeActiveTimers: runtimeHandles.activeTimers,
        runtimeActiveHandles: runtimeHandles.activeHandles,
        registryNativeHandles: timerStats ? timerStats.totalNativeHandles : null,
        registryLogicalTasks: timerStats ? timerStats.logicalPeriodicTasks : null
      },
      listeners: {
        trackedEmitters: this._emitters.size,
        totalEvents,
        totalListeners,
        byEmitter: emitterBreakdown
      },
      caches: {
        trackedCaches: this._caches.size,
        totalEntries: totalCacheEntries,
        totalBytes: totalCacheBytes,
        hits: totalCacheHits,
        misses: totalCacheMisses,
        evictions: totalCacheEvictions,
        byCache: cacheBreakdown
      },
      ai: {
        requestsTotal: this._ai.requestsTotal,
        llmCallsExecuted: this._ai.llmCallsExecuted,
        llmCallsPerMin: llmCallsLast60s,
        deduplicatedTotal: this._ai.deduplicatedTotal,
        cacheHitsTotal: this._ai.cacheHitsTotal,
        deterministicFastPathTotal: this._ai.deterministicFastPathTotal,
        fallbackTotal: this._ai.fallbackTotal,
        timeoutsTotal: this._ai.timeoutsTotal,
        rejectedQueueTotal: this._ai.rejectedQueueTotal,
        validationFailuresTotal: this._ai.validationFailuresTotal
      },
      dashboard: {
        activeClients: this._dashboard.activeClients,
        rawEventsIngested: this._dashboard.rawEventsIngested,
        coalescedFlushes: this._dashboard.coalescedFlushes,
        serializedBytesTotal: this._dashboard.serializedBytesTotal,
        serializedBytesPerSec: Math.round(dashBytesDelta / dashElapsedSec),
        droppedOverflow: this._dashboard.droppedOverflow
      },
      dbLatencyMs: dbStats
    };

    sample.pressure = this._evaluatePressureForSample(sample);
    this._window.push(sample);

    if (this._onSample) {
      this._onSample(sample);
    }

    return sample;
  }

  /**
   * Return rolling window samples + aggregated p50/p95/p99/max summary (PERFORMANCE_PLAN.md §3).
   */
  getWindow() {
    const samples = this._window.toArray();
    const rssArr = [];
    const heapArr = [];
    const cpuArr = [];
    const lagP95Arr = [];

    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      rssArr.push(s.memory.rssBytes);
      heapArr.push(s.memory.heapUsedBytes);
      if (typeof s.cpu.percentNormalized === 'number') {
        cpuArr.push(s.cpu.percentNormalized);
      }
      lagP95Arr.push(s.eventLoopDelayMs.p95);
    }

    return {
      sampleCount: samples.length,
      capacity: this._window.capacity,
      latest: this._window.latest() || null,
      aggregates: {
        rssBytes: computePercentiles(rssArr),
        heapUsedBytes: computePercentiles(heapArr),
        cpuPercentNormalized: cpuArr.length > 0 ? computePercentiles(cpuArr) : 'unavailable',
        eventLoopLagP95Ms: computePercentiles(lagP95Arr)
      },
      samples
    };
  }

  /**
   * MODULE_INTERFACES.md §17 contract: returns 'normal' | 'warning' | 'critical'.
   */
  pressureState() {
    const latest = this._window.latest() || this.sampleNow();
    return latest.pressure;
  }

  _evaluatePressureForSample(sample) {
    const th = this._thresholds;
    const rss = sample.memory.rssBytes;
    const sysAvail = sample.memory.systemAvailableBytes;
    const lag = sample.eventLoopDelayMs.p95;
    const cpuNorm =
      typeof sample.cpu.percentNormalized === 'number' ? sample.cpu.percentNormalized : null;

    if (
      rss >= th.criticalRssBytes ||
      lag >= th.criticalEventLoopLagMs ||
      (cpuNorm !== null && cpuNorm >= th.criticalCpuPercent) ||
      (typeof sysAvail === 'number' && sysAvail <= th.criticalSystemAvailableBytes)
    ) {
      return 'critical';
    }

    if (
      rss >= th.warningRssBytes ||
      lag >= th.warningEventLoopLagMs ||
      (cpuNorm !== null && cpuNorm >= th.warningCpuPercent) ||
      (typeof sysAvail === 'number' && sysAvail <= th.warningSystemAvailableBytes)
    ) {
      return 'warning';
    }

    return 'normal';
  }
}

module.exports = {
  ResourceMonitor,
  readSystemMemory,
  inspectRuntimeHandles,
  computePercentiles
};
