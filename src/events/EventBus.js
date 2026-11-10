'use strict';

const { EventEmitter } = require('node:events');
const { RingBuffer } = require('../performance/RingBuffer');
const { countEmitterListeners } = require('../performance/ScopedListeners');

/**
 * Bounded internal domain EventBus (MODULE_INTERFACES.md §2 + PERFORMANCE_PLAN.md §6).
 *
 * - Caps retained recent UI/domain event ring (default 1,000 compact events per PERFORMANCE_PLAN.md §6).
 * - Enforces explicit per-event listener cap to surface listener leaks immediately.
 * - Isolates subscriber errors so one broken observer never aborts durable TaskManager commits.
 */
class EventBus extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.recentEventLimit=1000] PERFORMANCE_PLAN.md §6: 1,000 compact events
   * @param {number} [options.maxListenersPerEvent=24]
   * @param {(err: Error, eventType: string) => void} [options.onSubscriberError]
   */
  constructor(options = {}) {
    super();
    const maxListeners = options.maxListenersPerEvent || 24;
    this.setMaxListeners(maxListeners);
    this._maxListenersPerEvent = maxListeners;
    this._recentEvents = new RingBuffer(options.recentEventLimit || 1000);
    this._onSubscriberError =
      typeof options.onSubscriberError === 'function' ? options.onSubscriberError : null;
    this._publishedCount = 0;
  }

  /**
   * Publish a compact domain event envelope safely.
   * @param {string} eventType
   * @param {object} envelope
   */
  publish(eventType, envelope) {
    this._publishedCount += 1;
    this._recentEvents.push({
      eventType,
      messageId: envelope?.messageId || null,
      occurredAt: envelope?.occurredAt || new Date().toISOString(),
      taskId: envelope?.taskId || envelope?.payload?.taskId || null,
      botId: envelope?.botId || null
    });

    const listeners = this.rawListeners(eventType);
    for (let i = 0; i < listeners.length; i += 1) {
      try {
        const res = listeners[i].call(this, envelope);
        if (res && typeof res.catch === 'function') {
          res.catch((err) => this._reportError(err, eventType));
        }
      } catch (err) {
        this._reportError(err, eventType);
      }
    }
  }

  recentEvents(limit = 100) {
    return this._recentEvents.toArray(limit);
  }

  trimForMemoryPressure() {
    this._recentEvents.clear();
  }

  _reportError(err, eventType) {
    if (this._onSubscriberError) {
      try {
        this._onSubscriberError(err, eventType);
      } catch {
        // Ignore secondary failure
      }
    }
  }

  stats() {
    const counts = countEmitterListeners(this);
    return {
      publishedCount: this._publishedCount,
      recentRingSize: this._recentEvents.size,
      recentRingCapacity: this._recentEvents.capacity,
      activeEvents: counts.events,
      activeListeners: counts.listeners,
      maxListenersPerEvent: this._maxListenersPerEvent
    };
  }
}

module.exports = { EventBus };
