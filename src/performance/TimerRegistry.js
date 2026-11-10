'use strict';

/**
 * Consolidated timer scheduler and leak-safe one-shot timeout tracker.
 *
 * Optimisation #7 ("Too many timers"):
 * Instead of creating independent setInterval() handles per bot, worker, cache,
 * SSE client and lease checker (which wakes the V8/libuv event loop constantly on
 * Android/Termux and drains CPU/battery), periodic tasks sharing an interval bucket
 * share ONE native setInterval handle and are guaranteed clean teardown on stop().
 */
class TimerRegistry {
  /**
   * @param {object} [options]
   * @param {boolean} [options.unrefByDefault=true]
   * @param {(err: Error, taskName: string) => void} [options.onError]
   */
  constructor(options = {}) {
    this._unrefByDefault = options.unrefByDefault !== false;
    this._onError = typeof options.onError === 'function' ? options.onError : null;

    /** @type {Map<number, { handle: NodeJS.Timeout, tasks: Map<string, { name: string, fn: Function }> }>} */
    this._buckets = new Map();
    /** @type {Map<string, { intervalMs: number }>} */
    this._periodicIndex = new Map();
    /** @type {Map<symbol, { name: string, handle: NodeJS.Timeout }>} */
    this._timeouts = new Map();
    this._disposed = false;
  }

  /**
   * Register a periodic callback sharing the native interval bucket for `intervalMs`.
   * @param {string} name Unique logical timer name
   * @param {number} intervalMs Interval in milliseconds (>= 50)
   * @param {() => void} fn Synchronous or error-handled callback
   * @param {{ unref?: boolean }} [opts]
   */
  registerInterval(name, intervalMs, fn, opts = {}) {
    if (this._disposed) {
      throw new Error('TimerRegistry is disposed');
    }
    const id = String(name);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 20) {
      throw new RangeError('TimerRegistry intervalMs must be an integer >= 20');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('TimerRegistry callback must be a function');
    }

    if (this._periodicIndex.has(id)) {
      this.unregisterInterval(id);
    }

    let bucket = this._buckets.get(intervalMs);
    if (!bucket) {
      const tasks = new Map();
      const handle = setInterval(() => {
        for (const [taskName, entry] of tasks.entries()) {
          try {
            const maybePromise = entry.fn();
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch((err) => this._reportError(err, taskName));
            }
          } catch (err) {
            this._reportError(err, taskName);
          }
        }
      }, intervalMs);

      const shouldUnref = opts.unref !== undefined ? opts.unref : this._unrefByDefault;
      if (shouldUnref && typeof handle.unref === 'function') {
        handle.unref();
      }
      bucket = { handle, tasks };
      this._buckets.set(intervalMs, bucket);
    }

    bucket.tasks.set(id, { name: id, fn });
    this._periodicIndex.set(id, { intervalMs });
    return () => this.unregisterInterval(id);
  }

  /**
   * Unregister a periodic callback; clears the underlying native interval when its bucket empties.
   * @param {string} name
   */
  unregisterInterval(name) {
    const id = String(name);
    const meta = this._periodicIndex.get(id);
    if (!meta) return false;
    this._periodicIndex.delete(id);

    const bucket = this._buckets.get(meta.intervalMs);
    if (bucket) {
      bucket.tasks.delete(id);
      if (bucket.tasks.size === 0) {
        clearInterval(bucket.handle);
        this._buckets.delete(meta.intervalMs);
      }
    }
    return true;
  }

  /**
   * Schedule a tracked one-shot timeout that auto-removes itself on fire or cancel.
   * @param {string} name
   * @param {number} delayMs
   * @param {() => void} fn
   * @param {{ unref?: boolean }} [opts]
   */
  setTimeout(name, delayMs, fn, opts = {}) {
    if (this._disposed) {
      throw new Error('TimerRegistry is disposed');
    }
    const token = Symbol(name);
    const handle = setTimeout(() => {
      this._timeouts.delete(token);
      try {
        const res = fn();
        if (res && typeof res.catch === 'function') {
          res.catch((err) => this._reportError(err, name));
        }
      } catch (err) {
        this._reportError(err, name);
      }
    }, Math.max(1, Math.trunc(delayMs)));

    const shouldUnref = opts.unref !== undefined ? opts.unref : this._unrefByDefault;
    if (shouldUnref && typeof handle.unref === 'function') {
      handle.unref();
    }

    this._timeouts.set(token, { name: String(name), handle });
    return () => this.clearTimeout(token);
  }

  clearTimeout(token) {
    const entry = this._timeouts.get(token);
    if (!entry) return false;
    clearTimeout(entry.handle);
    this._timeouts.delete(token);
    return true;
  }

  /**
   * Stop and release every interval and timeout immediately.
   */
  clearAll() {
    for (const bucket of this._buckets.values()) {
      clearInterval(bucket.handle);
      bucket.tasks.clear();
    }
    this._buckets.clear();
    this._periodicIndex.clear();

    for (const entry of this._timeouts.values()) {
      clearTimeout(entry.handle);
    }
    this._timeouts.clear();
  }

  dispose() {
    this.clearAll();
    this._disposed = true;
  }

  _reportError(err, taskName) {
    if (this._onError) {
      try {
        this._onError(err, taskName);
      } catch {
        // Never allow error handler failure to crash the shared interval loop
      }
    }
  }

  stats() {
    return {
      nativeIntervalHandles: this._buckets.size,
      logicalPeriodicTasks: this._periodicIndex.size,
      activeOneShotTimeouts: this._timeouts.size,
      totalNativeHandles: this._buckets.size + this._timeouts.size
    };
  }
}

module.exports = { TimerRegistry };
