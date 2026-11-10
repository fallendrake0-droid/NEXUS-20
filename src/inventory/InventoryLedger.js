'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DomainError } = require('../errors/DomainError');

/**
 * Authoritative Inventory & World Evidence Verifier (`MODULE_INTERFACES.md` §3.6 & `TASK_ALLOCATION.md` §8).
 * Workers never increment `verifiedQuantity` directly; all credit requires verified deltas.
 */
class InventoryLedger extends EventEmitter {
  /**
   * @param {{ stateStore: import('../persistence/StateStore').StateStore, logger?: object }} options
   */
  constructor(options = {}) {
    super();
    if (!options.stateStore) {
      throw new TypeError('InventoryLedger requires stateStore');
    }
    this._store = options.stateStore;
    this._logger = options.logger || null;
  }

  /**
   * Normalize item descriptor or string into canonical `namespace:item[|variant]` key.
   */
  canonicalItemKey(itemDescriptor) {
    if (!itemDescriptor) return null;
    if (typeof itemDescriptor === 'string') {
      const cleaned = itemDescriptor.trim().toLowerCase();
      if (!cleaned) return null;
      return cleaned.includes(':') ? cleaned : `minecraft:${cleaned}`;
    }
    if (typeof itemDescriptor === 'object') {
      const rawName = String(itemDescriptor.itemKey || itemDescriptor.name || '').trim().toLowerCase();
      if (!rawName) return null;
      const base = rawName.includes(':') ? rawName : `minecraft:${rawName}`;
      if (itemDescriptor.variant) {
        return `${base}|${String(itemDescriptor.variant).trim().toLowerCase()}`;
      }
      return base;
    }
    return null;
  }

  /**
   * Compute signed item deltas between two InventorySnapshots.
   */
  diff(beforeSnapshot, afterSnapshot) {
    const beforeCounts = beforeSnapshot?.itemCounts || {};
    const afterCounts = afterSnapshot?.itemCounts || {};
    const keys = new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)]);
    const deltas = [];

    for (const rawKey of keys) {
      const itemKey = this.canonicalItemKey(rawKey);
      if (!itemKey) continue;
      const before = Math.max(0, Math.trunc(beforeCounts[rawKey] || 0));
      const after = Math.max(0, Math.trunc(afterCounts[rawKey] || 0));
      const netDelta = after - before;
      if (netDelta !== 0 || before > 0 || after > 0) {
        deltas.push({ itemKey, before, after, netDelta });
      }
    }
    deltas.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    return deltas;
  }

  /**
   * Deterministically verify an EvidenceItem against baseline, snapshots and objective policy.
   */
  verifyEvidence({
    objective,
    assignment,
    baselineSnapshot,
    beforeSnapshot,
    afterSnapshot,
    evidenceItem,
    priorCredited = 0,
    allowExistingStock = false
  }) {
    if (!objective || !assignment || !evidenceItem) {
      return {
        valid: false,
        creditableDelta: 0,
        rejectionCode: 'MISSING_VERIFICATION_CONTEXT',
        disputed: true,
        canonicalItemKey: null
      };
    }

    const policy = objective.verification_policy || objective.verificationPolicy || 'newly_collected';
    const targetKey = this.canonicalItemKey(objective.resource_id || objective.resourceId);
    const evKey = this.canonicalItemKey(evidenceItem.itemKey);
    const details = evidenceItem.details || {};
    const claimed = Math.max(0, Math.trunc(evidenceItem.claimedDelta || 0));

    // Non-item world/spatial/role policies
    if (policy === 'block_state') {
      const verifiedBlocks = Math.max(0, Math.trunc(details.verifiedBlocks ?? claimed));
      if (evidenceItem.kind !== 'block_state' || verifiedBlocks < 1) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'BLOCK_STATE_UNVERIFIED',
          disputed: true,
          canonicalItemKey: null
        };
      }
      return {
        valid: true,
        creditableDelta: verifiedBlocks,
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: null
      };
    }

    if (policy === 'region_visited') {
      const coverage = typeof details.coverageRatio === 'number' ? details.coverageRatio : 0;
      if (evidenceItem.kind !== 'region_visited' || coverage < 0.85) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'INSUFFICIENT_SECTOR_COVERAGE',
          disputed: false,
          canonicalItemKey: null
        };
      }
      return {
        valid: true,
        creditableDelta: Math.max(1, claimed || 1),
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: null
      };
    }

    if (policy === 'role_duration') {
      const patrolSec = typeof details.patrolSeconds === 'number' ? details.patrolSeconds : 0;
      if (evidenceItem.kind !== 'role_duration' || patrolSec <= 0) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'ROLE_DURATION_UNVERIFIED',
          disputed: false,
          canonicalItemKey: null
        };
      }
      return {
        valid: true,
        creditableDelta: Math.max(1, Math.round(patrolSec)),
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: null
      };
    }

    // Item-based policies: enforce exact resource match
    if (targetKey && evKey !== targetKey) {
      return {
        valid: false,
        creditableDelta: 0,
        rejectionCode: 'RESOURCE_MISMATCH',
        disputed: true,
        canonicalItemKey: evKey
      };
    }

    const effectiveBaseline = baselineSnapshot || beforeSnapshot;
    if (!effectiveBaseline || !afterSnapshot) {
      return {
        valid: false,
        creditableDelta: 0,
        rejectionCode: 'MISSING_BASELINE_OR_AFTER_SNAPSHOT',
        disputed: true,
        canonicalItemKey: targetKey
      };
    }

    const readCount = (snap, key) => {
      if (!snap || !snap.itemCounts || !key) return 0;
      if (typeof snap.itemCounts[key] === 'number') return Math.trunc(snap.itemCounts[key]);
      const bare = key.replace(/^minecraft:/, '');
      if (typeof snap.itemCounts[bare] === 'number') return Math.trunc(snap.itemCounts[bare]);
      return 0;
    };

    const baseCount = readCount(effectiveBaseline, targetKey);
    const afterCount = readCount(afterSnapshot, targetKey);

    if (policy === 'crafted_output') {
      const consumed = details.consumedInputs;
      const hasConsumedInputs =
        consumed &&
        typeof consumed === 'object' &&
        Object.keys(consumed).length > 0 &&
        Object.values(consumed).every((v) => Number.isSafeInteger(v) && v >= 1);
      if (evidenceItem.kind !== 'craft_delta' || !hasConsumedInputs) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'CRAFT_INPUT_CONSUMPTION_MISSING',
          disputed: true,
          canonicalItemKey: targetKey
        };
      }
      const cumulativeCrafted = Math.max(0, afterCount - baseCount);
      const incremental = Math.max(0, cumulativeCrafted - priorCredited);
      if (incremental <= 0) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'ZERO_CRAFT_DELTA',
          disputed: claimed > 0,
          canonicalItemKey: targetKey
        };
      }
      return {
        valid: true,
        creditableDelta: Math.min(claimed || incremental, incremental),
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: targetKey
      };
    }

    if (policy === 'deposited_stock') {
      const cBefore = details.containerBeforeCount;
      const cAfter = details.containerAfterCount;
      if (
        evidenceItem.kind !== 'container_delta' ||
        !details.containerPos ||
        !Number.isSafeInteger(cBefore) ||
        !Number.isSafeInteger(cAfter) ||
        cAfter <= cBefore
      ) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'CONTAINER_DELTA_INVALID',
          disputed: true,
          canonicalItemKey: targetKey
        };
      }
      const containerGain = cAfter - cBefore;
      const botDrop = Math.max(0, readCount(beforeSnapshot, targetKey) - afterCount);
      const verifiedDeposit = Math.min(containerGain, botDrop);
      if (verifiedDeposit <= 0) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: 'DEPOSIT_NOT_MATCHED_BY_INVENTORY_DECREASE',
          disputed: true,
          canonicalItemKey: targetKey
        };
      }
      return {
        valid: true,
        creditableDelta: Math.min(claimed || verifiedDeposit, verifiedDeposit),
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: targetKey
      };
    }

    if (policy === 'held_stock') {
      const heldTotal = Math.max(0, afterCount);
      const netIncremental = heldTotal - priorCredited;
      if (netIncremental <= 0) {
        return {
          valid: false,
          creditableDelta: 0,
          rejectionCode: netIncremental < 0 ? 'HELD_STOCK_DECREASED' : 'ZERO_HELD_DELTA',
          disputed: netIncremental < 0,
          canonicalItemKey: targetKey
        };
      }
      return {
        valid: true,
        creditableDelta: Math.min(claimed || netIncremental, netIncremental),
        rejectionCode: null,
        disputed: false,
        canonicalItemKey: targetKey
      };
    }

    // Default: `newly_collected` (TASK_ALLOCATION.md §8.4)
    const effectiveBase = allowExistingStock ? 0 : baseCount;
    if (!allowExistingStock && afterCount < baseCount + priorCredited) {
      return {
        valid: false,
        creditableDelta: 0,
        rejectionCode: 'UNEXPECTED_INVENTORY_LOSS',
        disputed: true,
        canonicalItemKey: targetKey
      };
    }

    const netAcquired = Math.max(0, afterCount - effectiveBase);
    const incremental = Math.max(0, netAcquired - priorCredited);
    if (incremental <= 0) {
      return {
        valid: false,
        creditableDelta: 0,
        rejectionCode: baseCount > 0 && !allowExistingStock ? 'PRE_EXISTING_STOCK_NOT_CREDITED' : 'ZERO_NET_DELTA',
        disputed: claimed > 0,
        canonicalItemKey: targetKey
      };
    }

    return {
      valid: true,
      creditableDelta: Math.min(claimed > 0 ? claimed : incremental, incremental),
      rejectionCode: null,
      disputed: false,
      canonicalItemKey: targetKey
    };
  }

  /**
   * Commit a verified credit inside an active `StateStore.transaction(...)`, clamping
   * strictly to both assignment quota and objective target (`verified + reserved <= target`).
   */
  recordVerifiedCredit({
    evidenceId,
    taskId,
    objectiveId,
    assignmentId,
    botId,
    itemKey = null,
    creditableDelta,
    policy,
    verifiedAt = new Date().toISOString()
  }) {
    const existing = this._store.get(
      'SELECT transaction_id, delta_quantity FROM ledger_transactions WHERE evidence_id = ?',
      evidenceId
    );
    if (existing) {
      const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', objectiveId);
      return {
        transactionId: existing.transaction_id,
        evidenceId,
        objectiveId,
        assignmentId,
        creditedDelta: 0,
        duplicate: true,
        newVerifiedQuantity: obj ? obj.verified_quantity : 0,
        remainingQuantity:
          obj && obj.target_quantity !== null
            ? Math.max(0, obj.target_quantity - obj.verified_quantity - obj.reserved_quantity)
            : null,
        objectiveCompleted: obj ? obj.state === 'completed' : false
      };
    }

    const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', objectiveId);
    const asg = this._store.get('SELECT * FROM assignments WHERE assignment_id = ?', assignmentId);
    if (!obj || !asg) {
      throw new DomainError('NOT_FOUND', 'Objective or assignment not found during ledger credit');
    }

    let clamped = Math.max(0, Math.trunc(creditableDelta));
    if (asg.quota_quantity !== null) {
      const remQuota = Math.max(0, asg.quota_quantity - asg.credited_quantity);
      clamped = Math.min(clamped, remQuota);
    }
    if (obj.target_quantity !== null) {
      const remObj = Math.max(0, obj.target_quantity - obj.verified_quantity);
      clamped = Math.min(clamped, remObj);
    }

    const transactionId = crypto.randomUUID();
    this._store.run(
      `INSERT INTO ledger_transactions (
        transaction_id, evidence_id, transfer_id, task_id, objective_id, assignment_id, bot_id, item_key, delta_quantity, policy, verified_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      transactionId,
      evidenceId,
      taskId,
      objectiveId,
      assignmentId,
      botId,
      itemKey,
      clamped,
      policy,
      verifiedAt
    );

    const newCredited = asg.credited_quantity + clamped;
    const newVerified = obj.verified_quantity + clamped;
    // As `verified_quantity` increases by `clamped` from an active reserved assignment,
    // `reserved_quantity` shrinks by `clamped` so `verified + reserved` stays constant (`<= target`)!
    const newReserved =
      asg.quota_quantity !== null ? Math.max(0, obj.reserved_quantity - clamped) : obj.reserved_quantity;

    this._store.run(
      'UPDATE assignments SET credited_quantity = ? WHERE assignment_id = ?',
      newCredited,
      assignmentId
    );

    const objectiveCompleted =
      obj.target_quantity !== null ? newVerified >= obj.target_quantity : clamped > 0;

    this._store.run(
      `UPDATE objectives
       SET verified_quantity = ?, reserved_quantity = ?, state = ?, version = version + 1
       WHERE objective_id = ?`,
      newVerified,
      objectiveCompleted ? 0 : newReserved,
      objectiveCompleted ? 'completed' : obj.state,
      objectiveId
    );

    const remainingQuantity =
      obj.target_quantity !== null
        ? Math.max(0, obj.target_quantity - newVerified - (objectiveCompleted ? 0 : newReserved))
        : null;

    this.emit('inventory.verified', {
      transactionId,
      evidenceId,
      objectiveId,
      assignmentId,
      botId,
      creditedDelta: clamped,
      newVerifiedQuantity: newVerified
    });

    return {
      transactionId,
      evidenceId,
      objectiveId,
      assignmentId,
      creditedDelta: clamped,
      duplicate: false,
      newVerifiedQuantity: newVerified,
      remainingQuantity,
      objectiveCompleted
    };
  }

  /**
   * Bounded two-sided bot-to-bot item handoff (`transferId` — HIGH-02 fix).
   * Prevents both double-counting and permanent deadlocks when dropped items despawn.
   */
  recordVerifiedTransfer({
    transferId,
    objectiveId,
    senderBotId,
    receiverBotId = null,
    itemKey,
    sentQuantity = null,
    receivedQuantity = null,
    ttlMs = 60_000,
    nowIso = new Date().toISOString()
  }) {
    const canonical = this.canonicalItemKey(itemKey);
    return this._store.transaction(() => {
      const existing = this._store.get('SELECT * FROM transfers WHERE transfer_id = ?', transferId);
      if (!existing) {
        if (!Number.isSafeInteger(sentQuantity) || sentQuantity < 1) {
          throw new DomainError('SCHEMA_VALIDATION_FAILED', 'Initial transfer requires sentQuantity >= 1');
        }
        const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
        const recQty = Number.isSafeInteger(receivedQuantity) ? Math.min(sentQuantity, receivedQuantity) : 0;
        const state = recQty >= sentQuantity ? 'completed' : 'in_flight';
        this._store.run(
          `INSERT INTO transfers (
            transfer_id, objective_id, sender_bot_id, receiver_bot_id, item_key, sent_quantity, received_quantity, state, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          transferId,
          objectiveId,
          senderBotId,
          receiverBotId,
          canonical,
          sentQuantity,
          recQty,
          state,
          nowIso,
          expiresAt
        );
        return { transferId, state, sentQuantity, receivedQuantity: recQty };
      }

      const nextReceived =
        Number.isSafeInteger(receivedQuantity)
          ? Math.min(existing.sent_quantity, Math.max(existing.received_quantity, receivedQuantity))
          : existing.received_quantity;
      const nextState = nextReceived >= existing.sent_quantity ? 'completed' : existing.state;

      this._store.run(
        `UPDATE transfers
         SET receiver_bot_id = COALESCE(?, receiver_bot_id), received_quantity = ?, state = ?
         WHERE transfer_id = ?`,
        receiverBotId,
        nextReceived,
        nextState,
        transferId
      );
      return {
        transferId,
        state: nextState,
        sentQuantity: existing.sent_quantity,
        receivedQuantity: nextReceived
      };
    });
  }

  /**
   * Reconcile expired half-completed transfers (`HIGH-02` despawn/burn recovery).
   */
  expireStaleTransfers(nowIso = new Date().toISOString()) {
    return this._store.transaction(() => {
      const stale = this._store.all(
        `SELECT * FROM transfers WHERE state = 'in_flight' AND expires_at <= ?`,
        nowIso
      );
      const expired = [];
      for (const row of stale) {
        const lostQuantity = Math.max(0, row.sent_quantity - row.received_quantity);
        this._store.run(
          `UPDATE transfers SET state = 'timed_out_disputed' WHERE transfer_id = ?`,
          row.transfer_id
        );
        this._store.recordAudit({
          occurredAt: nowIso,
          actorType: 'system',
          actorId: 'InventoryLedger',
          action: 'transfer.timed_out_disputed',
          targetId: row.transfer_id,
          outcome: 'disputed',
          details: { objectiveId: row.objective_id, lostQuantity, itemKey: row.item_key }
        });
        expired.push({ transferId: row.transfer_id, objectiveId: row.objective_id, lostQuantity });
      }
      if (expired.length > 0) {
        this.emit('inventory.disputed', { count: expired.length, expired });
      }
      return expired;
    });
  }

  getObjectiveBalance(objectiveId) {
    const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', objectiveId);
    if (!obj) {
      throw new DomainError('NOT_FOUND', `Objective ${objectiveId} not found`);
    }
    return {
      target: obj.target_quantity,
      verified: obj.verified_quantity,
      reserved: obj.reserved_quantity,
      remaining:
        obj.target_quantity !== null
          ? Math.max(0, obj.target_quantity - obj.verified_quantity - obj.reserved_quantity)
          : null
    };
  }
}

module.exports = { InventoryLedger };
