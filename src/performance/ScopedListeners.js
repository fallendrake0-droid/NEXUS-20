'use strict';

/**
 * Disposable EventEmitter listener scope & listener-ceiling guard.
 *
 * Optimisation #6 ("Excessive event listeners") + MODULE_INTERFACES.md §10:
 * - Prevents action retries, cancelled assignments, reconnects and SSE subscriptions
 *   from leaking listeners on long-lived Mineflayer Bot / EventBus / Socket emitters.
 * - Contains listener errors so an unhandled callback error cannot crash WorkerHost.
 * - Exposes exact listener counts across tracked emitters for ResourceMonitor audits.
 */
class ScopedListeners {
  /**
   * @param {object} [options]
   * @param {number} [options.maxListenersPerEvent=20]
   * @param {(err: Error, eventName: string) => void} [options.onError]
   */
  constructor(options = {}) {
    this._maxListenersPerEvent = options.maxListenersPerEvent || 20;
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    /** @type {Array<{ emitter: import('events').EventEmitter, event: string, wrapped: Function }>} */
    this._registrations = [];
    this._disposed = false;
  }

  get activeCount() {
    return this._registrations.length;
  }

  /**
   * Attach an error-contained listener tracked by this scope.
   * @param {import('events').EventEmitter} emitter
   * @param {string} event
   * @param {Function} listener
   */
  on(emitter, event, listener) {
    this._assertActive();
    const existing = typeof emitter.listenerCount === 'function' ? emitter.listenerCount(event) : 0;
    if (existing >= this._maxListenersPerEvent) {
      const err = new Error(
        `Listener cap (${this._maxListenersPerEvent}) reached for event "${event}"`
      );
      err.code = 'LISTENER_CAP_EXCEEDED';
      throw err;
    }

    const wrapped = (...args) => {
      try {
        const out = listener(...args);
        if (out && typeof out.catch === 'function') {
          out.catch((err) => this._handleError(err, event));
        }
      } catch (err) {
        this._handleError(err, event);
      }
    };

    emitter.on(event, wrapped);
    const record = { emitter, event, wrapped };
    this._registrations.push(record);
    return () => this._removeRecord(record);
  }

  /**
   * Attach a one-time listener that removes its scope record immediately on fire OR dispose().
   * @param {import('events').EventEmitter} emitter
   * @param {string} event
   * @param {Function} listener
   */
  once(emitter, event, listener) {
    this._assertActive();
    const existing = typeof emitter.listenerCount === 'function' ? emitter.listenerCount(event) : 0;
    if (existing >= this._maxListenersPerEvent) {
      const err = new Error(
        `Listener cap (${this._maxListenersPerEvent}) reached for event "${event}"`
      );
      err.code = 'LISTENER_CAP_EXCEEDED';
      throw err;
    }

    let record = null;
    const wrapped = (...args) => {
      if (record) {
        const idx = this._registrations.indexOf(record);
        if (idx !== -1) this._registrations.splice(idx, 1);
      }
      try {
        const out = listener(...args);
        if (out && typeof out.catch === 'function') {
          out.catch((err) => this._handleError(err, event));
        }
      } catch (err) {
        this._handleError(err, event);
      }
    };

    emitter.once(event, wrapped);
    record = { emitter, event, wrapped };
    this._registrations.push(record);
    return () => this._removeRecord(record);
  }

  _removeRecord(record) {
    const idx = this._registrations.indexOf(record);
    if (idx === -1) return false;
    this._registrations.splice(idx, 1);
    if (typeof record.emitter.removeListener === 'function') {
      record.emitter.removeListener(record.event, record.wrapped);
    } else if (typeof record.emitter.off === 'function') {
      record.emitter.off(record.event, record.wrapped);
    }
    return true;
  }

  /**
   * Detach every listener registered in this scope. Idempotent.
   */
  dispose() {
    while (this._registrations.length > 0) {
      const rec = this._registrations.pop();
      if (typeof rec.emitter.removeListener === 'function') {
        rec.emitter.removeListener(rec.event, rec.wrapped);
      } else if (typeof rec.emitter.off === 'function') {
        rec.emitter.off(rec.event, rec.wrapped);
      }
    }
    this._disposed = true;
  }

  _assertActive() {
    if (this._disposed) {
      throw new Error('ScopedListeners instance has already been disposed');
    }
  }

  _handleError(err, event) {
    if (this._onError) {
      try {
        this._onError(err, event);
      } catch {
        // Swallow secondary reporter errors
      }
    }
  }
}

/**
 * Count total listeners across an EventEmitter without allocating closures.
 * @param {import('events').EventEmitter} emitter
 */
function countEmitterListeners(emitter) {
  if (!emitter || typeof emitter.eventNames !== 'function') {
    return { events: 0, listeners: 0 };
  }
  const names = emitter.eventNames();
  let listeners = 0;
  for (let i = 0; i < names.length; i += 1) {
    listeners += emitter.listenerCount(names[i]);
  }
  return { events: names.length, listeners };
}

module.exports = { ScopedListeners, countEmitterListeners };
