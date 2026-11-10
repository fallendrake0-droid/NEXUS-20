'use strict';

const { RingBuffer } = require('./RingBuffer');

const ALLOWED_VERBS = new Set(['help', 'status', 'task', 'pause', 'resume', 'cancel']);

/**
 * Zero-retention Minecraft chat ingress filter & bounded command receipt ring.
 *
 * Optimisation #11 ("Chat history retention") + SECURITY_PLAN.md §7:
 * - Drops ordinary public server chatter, bot-originated messages and non-allowlisted
 *   player UUIDs in O(1) BEFORE allocating parsed objects, storing strings or sending
 *   HTTP traffic from WorkerHost to the Galaxy A06 Master Controller.
 * - Enforces strict message length bounds, allowlisted command verbs and per-sender
 *   rate limits.
 * - Retains only a compact RingBuffer (default 50 receipts) of authorised command
 *   metadata — NEVER unbounded chat logs!
 */
class ChatHistoryGuard {
  /**
   * @param {object} options
   * @param {string} [options.prefix='!swarm']
   * @param {Iterable<string>} [options.allowedPlayerUuids=[]]
   * @param {Iterable<string>} [options.botUuids=[]]
   * @param {Iterable<string>} [options.botUsernames=[]]
   * @param {number} [options.maxMessageLength=256]
   * @param {number} [options.rateLimitWindowMs=10000]
   * @param {number} [options.maxCommandsPerWindow=5]
   * @param {number} [options.receiptRingCapacity=50]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    this._prefix = String(options.prefix || '!swarm').trim();
    this._allowedUuids = new Set(options.allowedPlayerUuids || []);
    this._botUuids = new Set(options.botUuids || []);
    this._botUsernames = new Set(options.botUsernames || []);
    this._maxMessageLength = options.maxMessageLength || 256;
    this._rateLimitWindowMs = options.rateLimitWindowMs || 10_000;
    this._maxCommandsPerWindow = options.maxCommandsPerWindow || 5;
    this._receipts = new RingBuffer(options.receiptRingCapacity || 50);
    this._now = options.now || Date.now;

    /** @type {Map<string, { windowStart: number, count: number }>} */
    this._senderBuckets = new Map();

    this._totalSeen = 0;
    this._droppedBotEcho = 0;
    this._droppedNonPrefixed = 0;
    this._droppedUnauthorized = 0;
    this._droppedOversize = 0;
    this._droppedRateLimited = 0;
    this._droppedInvalidVerb = 0;
    this._acceptedCommands = 0;
  }

  /**
   * Evaluate an incoming chat line. Returns `{ accepted: true, intent }` ONLY for
   * authorised, prefixed, rate-permitted control commands; returns `{ accepted: false, reason }`
   * immediately without retaining message strings for everything else.
   *
   * @param {object} msg
   * @param {string} msg.senderUuid
   * @param {string} [msg.senderName]
   * @param {string} msg.text
   * @param {string} [msg.serverId='default']
   */
  inspectChat(msg) {
    this._totalSeen += 1;
    if (!msg || typeof msg.text !== 'string') {
      return { accepted: false, reason: 'EMPTY_MESSAGE' };
    }

    // 1. Cheap bot-echo check first
    if (
      (msg.senderUuid && this._botUuids.has(msg.senderUuid)) ||
      (msg.senderName && this._botUsernames.has(msg.senderName))
    ) {
      this._droppedBotEcho += 1;
      return { accepted: false, reason: 'BOT_ORIGINATED' };
    }

    // 2. O(1) prefix + word-boundary check BEFORE trimming/splitting/allocating substrings!
    const raw = msg.text;
    if (
      !raw.startsWith(this._prefix) ||
      (raw.length > this._prefix.length && !/\s/.test(raw[this._prefix.length]))
    ) {
      this._droppedNonPrefixed += 1;
      return { accepted: false, reason: 'NOT_PREFIXED' };
    }

    // 3. Length cap
    if (raw.length > this._maxMessageLength) {
      this._droppedOversize += 1;
      return { accepted: false, reason: 'MESSAGE_TOO_LONG' };
    }

    // 4. Strict player UUID allowlist (SECURITY_PLAN.md §7)
    if (!msg.senderUuid || !this._allowedUuids.has(msg.senderUuid)) {
      this._droppedUnauthorized += 1;
      return { accepted: false, reason: 'UNAUTHORIZED_PLAYER' };
    }

    // 5. Per-sender sliding window rate limit
    const now = this._now();
    let bucket = this._senderBuckets.get(msg.senderUuid);
    if (!bucket || now - bucket.windowStart >= this._rateLimitWindowMs) {
      if (this._senderBuckets.size > 128 && !bucket) {
        const oldest = this._senderBuckets.keys().next().value;
        this._senderBuckets.delete(oldest);
      }
      bucket = { windowStart: now, count: 0 };
      this._senderBuckets.set(msg.senderUuid, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this._maxCommandsPerWindow) {
      this._droppedRateLimited += 1;
      return { accepted: false, reason: 'RATE_LIMITED' };
    }

    // 6. Parse strict verb grammar
    const remainder = raw.slice(this._prefix.length).trim();
    if (!remainder) {
      this._droppedInvalidVerb += 1;
      return { accepted: false, reason: 'EMPTY_COMMAND' };
    }
    const firstSpace = remainder.indexOf(' ');
    const verb = (firstSpace === -1 ? remainder : remainder.slice(0, firstSpace)).toLowerCase();
    const argumentText = firstSpace === -1 ? '' : remainder.slice(firstSpace + 1).trim();

    if (!ALLOWED_VERBS.has(verb)) {
      this._droppedInvalidVerb += 1;
      return { accepted: false, reason: 'UNSUPPORTED_VERB' };
    }

    const intent = {
      serverId: String(msg.serverId || 'default').slice(0, 64),
      senderUuid: msg.senderUuid,
      verb,
      argumentText: argumentText.slice(0, 200),
      receivedAt: new Date(now).toISOString()
    };

    // Store compact receipt (no full chat history!)
    this._receipts.push({
      ts: now,
      senderUuid: msg.senderUuid,
      verb,
      argLen: intent.argumentText.length
    });
    this._acceptedCommands += 1;

    return { accepted: true, intent };
  }

  recentReceipts(limit = 20) {
    return this._receipts.toArray(limit);
  }

  clear() {
    this._receipts.clear();
    this._senderBuckets.clear();
  }

  stats() {
    return {
      totalSeen: this._totalSeen,
      acceptedCommands: this._acceptedCommands,
      droppedTotal: this._totalSeen - this._acceptedCommands,
      droppedBotEcho: this._droppedBotEcho,
      droppedNonPrefixed: this._droppedNonPrefixed,
      droppedUnauthorized: this._droppedUnauthorized,
      droppedOversize: this._droppedOversize,
      droppedRateLimited: this._droppedRateLimited,
      droppedInvalidVerb: this._droppedInvalidVerb,
      retainedReceipts: this._receipts.size,
      receiptCapacity: this._receipts.capacity
    };
  }
}

module.exports = { ChatHistoryGuard, ALLOWED_VERBS };
