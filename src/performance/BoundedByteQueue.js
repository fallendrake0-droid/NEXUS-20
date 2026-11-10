'use strict';

const { estimateValueBytes } = require('./BoundedCache');

/**
 * Dual-bounded (count + serialized byte budget) FIFO queue with explicit backpressure.
 *
 * Used for:
 * - Worker outbound local event queues (overflow triggers safe pause + durable checkpoint,
 *   NEVER silent drop or unbounded buffering — PERFORMANCE_PLAN.md §6).
 * - Per-client SSE queues (overflow disconnects slow client with reload_required flag).
 */
class BoundedByteQueue {
  /**
   * @param {object} options
   * @param {string} [options.name='queue']
   * @param {number} options.maxItems Maximum queued items (>= 1)
   * @param {number} options.maxBytes Maximum queued bytes (>= 64)
   * @param {'reject'|'pause_and_checkpoint'|'disconnect_reload'} [options.overflowPolicy='reject']
   * @param {(context: object) => void} [options.onOverflow]
   */
  constructor(options = {}) {
    const {
      name = 'queue',
      maxItems,
      maxBytes,
      overflowPolicy = 'reject',
      onOverflow = null
    } = options;

    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new RangeError('BoundedByteQueue maxItems must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) {
      throw new RangeError('BoundedByteQueue maxBytes must be an integer >= 64');
    }

    this.name = String(name);
    this._maxItems = maxItems;
    this._maxBytes = maxBytes;
    this._overflowPolicy = overflowPolicy;
    this._onOverflow = typeof onOverflow === 'function' ? onOverflow : null;

    // Head-indexed queue avoids O(n) shift cost; compacts lazily when head passes half array
    this._items = [];
    this._sizes = [];
    this._head = 0;
    this._byteSize = 0;

    this._enqueuedTotal = 0;
    this._dequeuedTotal = 0;
    this._overflowCount = 0;
    this._highWaterItems = 0;
    this._highWaterBytes = 0;
  }

  get length() {
    return this._items.length - this._head;
  }

  get byteSize() {
    return this._byteSize;
  }

  /**
   * Enqueue an item (optionally passing precomputed byte length to avoid re-measuring).
   * Never silently discards items: returns { ok: false, reason, policy } on overflow.
   *
   * @param {*} item
   * @param {number} [precomputedBytes]
   */
  enqueue(item, precomputedBytes) {
    const itemBytes =
      Number.isSafeInteger(precomputedBytes) && precomputedBytes >= 0
        ? precomputedBytes
        : estimateValueBytes(item);

    const currentLen = this.length;
    if (
      itemBytes > this._maxBytes ||
      currentLen >= this._maxItems ||
      this._byteSize + itemBytes > this._maxBytes
    ) {
      this._overflowCount += 1;
      const reason =
        itemBytes > this._maxBytes
          ? 'ITEM_EXCEEDS_MAX_BYTES'
          : currentLen >= this._maxItems
            ? 'MAX_ITEMS_REACHED'
            : 'MAX_BYTES_REACHED';

      const context = {
        queue: this.name,
        reason,
        policy: this._overflowPolicy,
        length: currentLen,
        byteSize: this._byteSize,
        attemptedBytes: itemBytes
      };
      if (this._onOverflow) {
        this._onOverflow(context);
      }
      return { ok: false, reason, policy: this._overflowPolicy };
    }

    this._items.push(item);
    this._sizes.push(itemBytes);
    this._byteSize += itemBytes;
    this._enqueuedTotal += 1;

    const newLen = this.length;
    if (newLen > this._highWaterItems) this._highWaterItems = newLen;
    if (this._byteSize > this._highWaterBytes) this._highWaterBytes = this._byteSize;

    return { ok: true, length: newLen, byteSize: this._byteSize };
  }

  /**
   * Dequeue a single item in amortized O(1) time.
   */
  dequeue() {
    if (this.length === 0) return undefined;
    const item = this._items[this._head];
    const bytes = this._sizes[this._head];
    this._items[this._head] = undefined;
    this._sizes[this._head] = 0;
    this._head += 1;
    this._byteSize = Math.max(0, this._byteSize - bytes);
    this._dequeuedTotal += 1;
    this._compactIfNeeded();
    return item;
  }

  /**
   * Dequeue a bounded batch (e.g. up to 100 events per worker batch — PERFORMANCE_PLAN.md §2).
   * @param {number} maxBatchItems
   * @param {number} [maxBatchBytes=Infinity]
   */
  dequeueBatch(maxBatchItems, maxBatchBytes = Infinity) {
    const cap = Math.max(1, Math.trunc(maxBatchItems));
    const batch = [];
    let batchBytes = 0;
    while (this.length > 0 && batch.length < cap) {
      const nextBytes = this._sizes[this._head];
      if (batch.length > 0 && batchBytes + nextBytes > maxBatchBytes) {
        break;
      }
      batchBytes += nextBytes;
      batch.push(this.dequeue());
    }
    return batch;
  }

  peek() {
    return this.length === 0 ? undefined : this._items[this._head];
  }

  clear() {
    this._items = [];
    this._sizes = [];
    this._head = 0;
    this._byteSize = 0;
  }

  _compactIfNeeded() {
    if (this._head > 64 && this._head * 2 >= this._items.length) {
      this._items = this._items.slice(this._head);
      this._sizes = this._sizes.slice(this._head);
      this._head = 0;
    } else if (this._head > 0 && this._head === this._items.length) {
      this._items.length = 0;
      this._sizes.length = 0;
      this._head = 0;
    }
  }

  stats() {
    return {
      name: this.name,
      length: this.length,
      maxItems: this._maxItems,
      byteSize: this._byteSize,
      maxBytes: this._maxBytes,
      enqueuedTotal: this._enqueuedTotal,
      dequeuedTotal: this._dequeuedTotal,
      overflowCount: this._overflowCount,
      highWaterItems: this._highWaterItems,
      highWaterBytes: this._highWaterBytes,
      overflowPolicy: this._overflowPolicy
    };
  }
}

module.exports = { BoundedByteQueue };
