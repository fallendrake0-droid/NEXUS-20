'use strict';

/**
 * Fixed-capacity O(1) circular buffer.
 * Pre-allocates backing storage once and overwrites the oldest slot when full,
 * avoiding O(n) Array.prototype.shift() re-indexing and unbounded retention.
 */
class RingBuffer {
  /**
   * @param {number} capacity Positive integer maximum number of retained items.
   */
  constructor(capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('RingBuffer capacity must be a positive safe integer');
    }
    this._capacity = capacity;
    this._slots = new Array(capacity);
    this._head = 0;
    this._size = 0;
    this._totalPushed = 0;
    this._overwritten = 0;
  }

  get capacity() {
    return this._capacity;
  }

  get size() {
    return this._size;
  }

  get totalPushed() {
    return this._totalPushed;
  }

  get overwritten() {
    return this._overwritten;
  }

  /**
   * Append an item in O(1) time. Overwrites oldest item if at capacity.
   * @param {*} item
   * @returns {{ overwritten: boolean }}
   */
  push(item) {
    this._totalPushed += 1;
    if (this._size < this._capacity) {
      const writeIdx = (this._head + this._size) % this._capacity;
      this._slots[writeIdx] = item;
      this._size += 1;
      return { overwritten: false };
    }
    this._slots[this._head] = item;
    this._head = (this._head + 1) % this._capacity;
    this._overwritten += 1;
    return { overwritten: true };
  }

  /**
   * Remove and return the oldest item in O(1), clearing its slot reference for GC.
   */
  shift() {
    if (this._size === 0) return undefined;
    const item = this._slots[this._head];
    this._slots[this._head] = undefined;
    this._head = (this._head + 1) % this._capacity;
    this._size -= 1;
    return item;
  }

  /**
   * Return the newest item without mutating the buffer.
   */
   latest() {
    if (this._size === 0) return undefined;
    const idx = (this._head + this._size - 1) % this._capacity;
    return this._slots[idx];
  }

  /**
   * Return the item at logical index [0..size-1] from oldest to newest.
   * @param {number} index
   */
  at(index) {
    if (index < 0 || index >= this._size) return undefined;
    return this._slots[(this._head + index) % this._capacity];
  }

  /**
   * Iterate items from oldest to newest without allocating an intermediate array.
   * @param {(item: *, index: number) => void} fn
   */
  forEach(fn) {
    for (let i = 0; i < this._size; i += 1) {
      fn(this._slots[(this._head + i) % this._capacity], i);
    }
  }

  /**
   * Materialize up to `limit` newest items (default: all) in chronological order.
   * @param {number} [limit]
   */
  toArray(limit = this._size) {
    const count = Math.max(0, Math.min(this._size, Math.trunc(limit)));
    const startOffset = this._size - count;
    const result = new Array(count);
    for (let i = 0; i < count; i += 1) {
      result[i] = this._slots[(this._head + startOffset + i) % this._capacity];
    }
    return result;
  }

  /**
   * Release all retained object references immediately for GC.
   */
  clear() {
    for (let i = 0; i < this._capacity; i += 1) {
      this._slots[i] = undefined;
    }
    this._head = 0;
    this._size = 0;
  }

  stats() {
    return {
      capacity: this._capacity,
      size: this._size,
      totalPushed: this._totalPushed,
      overwritten: this._overwritten
    };
  }
}

module.exports = { RingBuffer };
