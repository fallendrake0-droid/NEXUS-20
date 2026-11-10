'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DomainError } = require('../errors/DomainError');

const LEGAL_TASK_TRANSITIONS = Object.freeze({
  queued: new Set(['planning', 'paused', 'cancelled']),
  planning: new Set(['ready', 'clarification_required', 'paused', 'failed', 'cancelled']),
  clarification_required: new Set(['planning', 'cancelled']),
  ready: new Set(['running', 'paused', 'blocked', 'completed', 'cancelled']),
  running: new Set(['paused', 'blocked', 'completed', 'failed', 'cancelled']),
  paused: new Set(['queued', 'planning', 'ready', 'running', 'cancelled']),
  blocked: new Set(['planning', 'ready', 'paused', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
});

const LEGAL_OBJECTIVE_TRANSITIONS = Object.freeze({
  pending: new Set(['ready', 'blocked', 'cancelled']),
  ready: new Set(['assigned', 'running', 'blocked', 'completed', 'cancelled']),
  assigned: new Set(['running', 'ready', 'blocked', 'completed', 'failed', 'cancelled']),
  running: new Set(['verifying', 'assigned', 'ready', 'blocked', 'completed', 'failed', 'cancelled']),
  verifying: new Set(['completed', 'running', 'ready', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['ready', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
});

function assertTaskTransition(fromState, toState) {
  if (fromState === toState) return;
  const allowed = LEGAL_TASK_TRANSITIONS[fromState];
  if (!allowed || !allowed.has(toState)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Task state cannot transition from ${fromState} to ${toState}`
    );
  }
}

function assertObjectiveTransition(fromState, toState) {
  if (fromState === toState) return;
  const allowed = LEGAL_OBJECTIVE_TRANSITIONS[fromState];
  if (!allowed || !allowed.has(toState)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Objective state cannot transition from ${fromState} to ${toState}`
    );
  }
}

/**
 * Authoritative Task, Objective DAG & Lease State Machine (`MODULE_INTERFACES.md` §3.4).
 *
 * All mutations execute inside `StateStore.transaction(...)`.
 * Enforces:
 * - Single aggregate target (`verified + reserved <= target`).
 * - Acyclic `finish_to_start` and concurrent `start_with` DAG dependencies (`HIGH-03c`).
 * - Monotonic `worker_sequence` & `message_id` idempotency (`G-08`).
 * - `allocation_epoch` fencing before releasing unverified lease reservations (`G-08`, `G-15`).
 */
class TaskManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../persistence/StateStore').StateStore} options.stateStore
   * @param {import('../inventory/InventoryLedger').InventoryLedger} options.inventoryLedger
   * @param {import('../protocol/SchemaValidator').SchemaValidator} options.schemaValidator
   * @param {object} [options.logger]
   * @param {() => number} [options.now=Date.now]
   */
  constructor(options = {}) {
    super();
    if (!options.stateStore || !options.inventoryLedger || !options.schemaValidator) {
      throw new TypeError('TaskManager requires stateStore, inventoryLedger and schemaValidator');
    }
    this._store = options.stateStore;
    this._ledger = options.inventoryLedger;
    this._validator = options.schemaValidator;
    this._logger = options.logger || null;
    this._now = options.now || Date.now;
  }

  _nowIso() {
    return new Date(this._now()).toISOString();
  }

  _enqueueWorkerCommand(workerId, commandType, payload, ttlMs = 30_000) {
    const worker = this._store.get('SELECT last_command_seq FROM workers WHERE worker_id = ?', workerId);
    if (!worker) {
      throw new DomainError('NOT_FOUND', `Worker ${workerId} not found when enqueueing command`);
    }
    const nextSeq = worker.last_command_seq + 1;
    const nowMs = this._now();
    const issuedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const commandId = crypto.randomUUID();

    const envelope = {
      schemaVersion: 1,
      commandId,
      sequence: nextSeq,
      workerId,
      issuedAt,
      expiresAt,
      commandType,
      payload
    };

    this._store.run('UPDATE workers SET last_command_seq = ? WHERE worker_id = ?', nextSeq, workerId);
    this._store.run(
      `INSERT INTO command_outbox (command_id, worker_id, command_sequence, command_type, payload_json, acked_at, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      commandId,
      workerId,
      nextSeq,
      commandType,
      JSON.stringify(envelope),
      issuedAt,
      expiresAt
    );
    return envelope;
  }

  _formatObjectiveRow(row, depRows = []) {
    const remaining =
      row.target_quantity !== null
        ? Math.max(0, row.target_quantity - row.verified_quantity - row.reserved_quantity)
        : null;
    return {
      objectiveId: row.objective_id,
      taskId: row.task_id,
      localId: row.local_id,
      kind: row.kind,
      resourceId: row.resource_id,
      targetQuantity: row.target_quantity,
      verifiedQuantity: row.verified_quantity,
      reservedQuantity: row.reserved_quantity,
      remainingQuantity: remaining,
      regionLabel: row.region_label,
      description: row.description,
      dependencies: depRows.map((d) =>
        d.edge_type === 'start_with'
          ? { objectiveId: d.depends_on_objective_id, edgeType: 'start_with' }
          : d.depends_on_objective_id
      ),
      parallelism: row.parallelism,
      workerCountHint: row.worker_count_hint,
      verificationPolicy: row.verification_policy,
      constraints: JSON.parse(row.constraints_json || '{}'),
      allocationEpoch: row.allocation_epoch,
      state: row.state,
      version: row.version
    };
  }

  _formatTaskSummary(row) {
    const counts = this._store.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS done
       FROM objectives WHERE task_id = ?`,
      row.task_id
    );
    return {
      taskId: row.task_id,
      state: row.state,
      intentSummary: row.intent_summary || row.raw_text,
      priority: row.priority,
      riskLevel: row.risk_level,
      pauseReason: row.pause_reason || null,
      clarificationQuestion: row.clarification_question || null,
      objectiveCount: Number(counts?.total || 0),
      completedObjectiveCount: Number(counts?.done || 0),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Create or idempotently return a task (`MODULE_INTERFACES.md` §3.4).
   */
  createTask({
    taskId = crypto.randomUUID(),
    idempotencyKey = null,
    actorId,
    source = 'cli',
    rawText,
    priority = 'normal',
    initialState = 'queued',
    pauseReason = null
  }) {
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', 'rawText must be a non-empty string');
    }
    if (!['dashboard', 'cli', 'chat'].includes(source)) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', `Invalid source interface: ${source}`);
    }
    if (!['survival', 'safety', 'high', 'normal', 'low'].includes(priority)) {
      throw new DomainError('SCHEMA_VALIDATION_FAILED', `Invalid task priority: ${priority}`);
    }
    if (!['queued', 'planning', 'paused'].includes(initialState)) {
      throw new DomainError('INVALID_STATE_TRANSITION', `Invalid initialState: ${initialState}`);
    }

    const nowIso = this._nowIso();

    return this._store.transaction(() => {
      if (idempotencyKey) {
        const dup = this._store.get(
          'SELECT task_id FROM tasks WHERE idempotency_key = ?',
          String(idempotencyKey)
        );
        if (dup) {
          return this.getTask(dup.task_id);
        }
      }

      this._store.run(
        `INSERT INTO tasks (
          task_id, idempotency_key, actor_id, source_interface, raw_text, intent_summary,
          state, priority, risk_level, plan_version, clarification_question, pause_reason,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'low', 0, NULL, ?, 1, ?, ?)`,
        taskId,
        idempotencyKey ? String(idempotencyKey) : null,
        String(actorId || 'unknown'),
        source,
        rawText.trim().slice(0, 1000),
        initialState,
        priority,
        pauseReason,
        nowIso,
        nowIso
      );

      return this.getTask(taskId);
    });
  }

  /**
   * Validate and atomically attach a `TaskPlanV1` (or clarification request) to a task.
   */
  attachPlan({ taskId, plan, expectedVersion = null }) {
    const check = this._validator.validatePlanSemantics(plan);
    if (!check.valid) {
      throw new DomainError(
        'SEMANTIC_VALIDATION_FAILED',
        `Invalid TaskPlanV1: ${check.errors.join('; ')}`,
        { details: { errors: check.errors } }
      );
    }

    const nowIso = this._nowIso();

    return this._store.transaction(() => {
      const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
      if (!task) {
        throw new DomainError('NOT_FOUND', `Task ${taskId} not found`);
      }
      if (expectedVersion !== null && task.version !== expectedVersion) {
        throw new DomainError(
          'CONFLICT',
          `Task ${taskId} version mismatch (expected ${expectedVersion}, got ${task.version})`
        );
      }

      if (task.state === 'queued' || task.state === 'clarification_required' || task.state === 'blocked') {
        assertTaskTransition(task.state, 'planning');
      } else if (task.state !== 'planning') {
        assertTaskTransition(task.state, 'ready');
      }

      const nextPlanVersion = task.plan_version + 1;

      if (plan.clarificationRequired === true) {
        this._store.run(
          `UPDATE tasks
           SET intent_summary = ?, state = 'clarification_required', risk_level = ?,
               plan_version = ?, clarification_question = ?, version = version + 1, updated_at = ?
           WHERE task_id = ?`,
          plan.intentSummary,
          plan.riskLevel,
          nextPlanVersion,
          plan.clarificationQuestion,
          nowIso,
          taskId
        );
        return this.getTask(taskId);
      }

      // Map localIds to stable global objectiveIds (preserving any already-completed objectives on replan)
      const existingObjs = this._store.all('SELECT * FROM objectives WHERE task_id = ?', taskId);
      const existingByLocal = new Map(existingObjs.map((o) => [o.local_id, o]));
      const localToGlobalId = new Map();

      for (const obj of plan.objectives) {
        const prev = existingByLocal.get(obj.localId);
        const globalId = prev ? prev.objective_id : `${taskId}:${obj.localId}`;
        localToGlobalId.set(obj.localId, globalId);
      }

      for (const obj of plan.objectives) {
        const globalId = localToGlobalId.get(obj.localId);
        const prev = existingByLocal.get(obj.localId);
        if (prev && prev.state === 'completed') {
          continue;
        }
        const canonicalRes = obj.target.resourceId
          ? this._ledger.canonicalItemKey(obj.target.resourceId)
          : null;

        if (!prev) {
          this._store.run(
            `INSERT INTO objectives (
              objective_id, task_id, local_id, kind, resource_id, target_quantity,
              verified_quantity, reserved_quantity, region_label, description,
              parallelism, worker_count_hint, verification_policy, constraints_json,
              allocation_epoch, state, version
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 1, 'pending', 1)`,
            globalId,
            taskId,
            obj.localId,
            obj.kind,
            canonicalRes,
            obj.target.quantity,
            obj.target.regionLabel,
            obj.target.description,
            obj.parallelism,
            obj.workerCountHint,
            obj.verification,
            JSON.stringify(obj.constraints)
          );
        } else {
          this._store.run(
            `UPDATE objectives
             SET kind = ?, resource_id = ?, target_quantity = ?, region_label = ?,
                 description = ?, parallelism = ?, worker_count_hint = ?,
                 verification_policy = ?, constraints_json = ?, version = version + 1
             WHERE objective_id = ?`,
            obj.kind,
            canonicalRes,
            obj.target.quantity,
            obj.target.regionLabel,
            obj.target.description,
            obj.parallelism,
            obj.workerCountHint,
            obj.verification,
            JSON.stringify(obj.constraints),
            globalId
          );
        }

        // Replace dependencies for non-completed objective
        this._store.run('DELETE FROM objective_dependencies WHERE objective_id = ?', globalId);
        for (const rawDep of obj.dependencies) {
          const depLocal = typeof rawDep === 'string' ? rawDep : rawDep.localId;
          const edgeType =
            typeof rawDep === 'object' && rawDep.edgeType === 'start_with'
              ? 'start_with'
              : 'finish_to_start';
          const depGlobal = localToGlobalId.get(depLocal);
          this._store.run(
            `INSERT INTO objective_dependencies (objective_id, depends_on_objective_id, edge_type)
             VALUES (?, ?, ?)`,
            globalId,
            depGlobal,
            edgeType
          );
        }
      }

      // Unlock root objectives & `start_with` companions whose prerequisites are ready/completed
      this._unlockReadyObjectivesInTx(taskId);

      this._store.run(
        `UPDATE tasks
         SET intent_summary = ?, state = 'ready', risk_level = ?, plan_version = ?,
             clarification_question = NULL, pause_reason = NULL, version = version + 1, updated_at = ?
         WHERE task_id = ?`,
        plan.intentSummary,
        plan.riskLevel,
        nextPlanVersion,
        nowIso,
        taskId
      );

      return this.getTask(taskId);
    });
  }

  /**
   * Unlock `pending` objectives whose `finish_to_start` dependencies are `completed`
   * AND whose `start_with` dependencies are at least `ready | assigned | running | completed`.
   */
  _unlockReadyObjectivesInTx(taskId) {
    const unlocked = [];
    let progress = true;
    while (progress) {
      progress = false;
      const allObjs = this._store.all('SELECT * FROM objectives WHERE task_id = ?', taskId);
      const stateById = new Map(allObjs.map((o) => [o.objective_id, o.state]));

      for (const obj of allObjs) {
        if (obj.state !== 'pending') continue;
        const deps = this._store.all(
          'SELECT * FROM objective_dependencies WHERE objective_id = ?',
          obj.objective_id
        );
        let ready = true;
        for (const d of deps) {
          const targetState = stateById.get(d.depends_on_objective_id);
          if (d.edge_type === 'finish_to_start') {
            if (targetState !== 'completed') {
              ready = false;
              break;
            }
          } else if (d.edge_type === 'start_with') {
            if (!['ready', 'assigned', 'running', 'verifying', 'completed'].includes(targetState)) {
              ready = false;
              break;
            }
          }
        }
        if (ready) {
          assertObjectiveTransition(obj.state, 'ready');
          this._store.run(
            `UPDATE objectives SET state = 'ready', version = version + 1 WHERE objective_id = ?`,
            obj.objective_id
          );
          stateById.set(obj.objective_id, 'ready');
          unlocked.push(obj.objective_id);
          progress = true;
        }
      }
    }
    return unlocked;
  }

  readyObjectives(taskId) {
    const rows = this._store.all(
      `SELECT * FROM objectives
       WHERE task_id = ? AND state IN ('ready', 'assigned', 'running')
       ORDER BY local_id ASC`,
      taskId
    );
    const result = [];
    for (const r of rows) {
      if (r.target_quantity !== null) {
        const rem = r.target_quantity - r.verified_quantity - r.reserved_quantity;
        if (rem <= 0) continue;
      } else if (r.state !== 'ready') {
        continue;
      }
      const deps = this._store.all(
        'SELECT * FROM objective_dependencies WHERE objective_id = ?',
        r.objective_id
      );
      result.push(this._formatObjectiveRow(r, deps));
    }
    return result;
  }

  /**
   * Commit non-overlapping assignment leases and enqueue worker outbox commands atomically.
   */
  commitAssignments({
    objectiveId,
    allocationEpoch = null,
    quotas,
    expectedVersion = null,
    leaseDurationMs = 30_000,
    checkpointIntervalMs = 5_000
  }) {
    if (!Array.isArray(quotas) || quotas.length === 0) {
      return [];
    }

    const nowMs = this._now();
    const issuedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + leaseDurationMs).toISOString();

    return this._store.transaction(() => {
      const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', objectiveId);
      if (!obj) {
        throw new DomainError('NOT_FOUND', `Objective ${objectiveId} not found`);
      }
      if (expectedVersion !== null && obj.version !== expectedVersion) {
        throw new DomainError('CONFLICT', `Objective ${objectiveId} version conflict`);
      }
      if (allocationEpoch !== null && obj.allocation_epoch !== allocationEpoch) {
        throw new DomainError('STALE_ALLOCATION_EPOCH', 'Objective allocationEpoch changed');
      }
      if (!['ready', 'assigned', 'running'].includes(obj.state)) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `Cannot commit assignments when objective is ${obj.state}`
        );
      }

      let quotaSum = 0;
      const seenBots = new Set();
      for (const q of quotas) {
        if (!q || !q.botId || !q.workerId) {
          throw new DomainError('SCHEMA_VALIDATION_FAILED', 'Quota requires botId and workerId');
        }
        if (seenBots.has(q.botId)) {
          throw new DomainError('CONFLICT', `Duplicate bot ${q.botId} in assignment batch`);
        }
        seenBots.add(q.botId);

        const busy = this._store.get(
          `SELECT assignment_id FROM assignments
           WHERE bot_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
          q.botId
        );
        if (busy) {
          throw new DomainError('CONFLICT', `Bot ${q.botId} already holds an active assignment`);
        }

        if (obj.target_quantity !== null) {
          if (!Number.isSafeInteger(q.quantity) || q.quantity < 1) {
            throw new DomainError('SCHEMA_VALIDATION_FAILED', 'Quantity objective requires integer quota >= 1');
          }
          quotaSum += q.quantity;
        }
      }

      if (obj.target_quantity !== null) {
        const remaining = obj.target_quantity - obj.verified_quantity - obj.reserved_quantity;
        if (quotaSum > remaining) {
          throw new DomainError(
            'CONFLICT',
            `Quota sum (${quotaSum}) exceeds objective remaining quantity (${remaining})`
          );
        }
      }

      const constraints = JSON.parse(obj.constraints_json || '{}');
      const created = [];

      for (const q of quotas) {
        const assignmentId = crypto.randomUUID();
        const leaseId = crypto.randomUUID();
        const assignmentDto = {
          schemaVersion: 1,
          assignmentId,
          leaseId,
          allocationEpoch: obj.allocation_epoch,
          taskId: obj.task_id,
          objectiveId: obj.objective_id,
          workerId: q.workerId,
          botId: q.botId,
          actionType: obj.kind,
          resourceId: obj.resource_id,
          quotaQuantity: obj.target_quantity !== null ? q.quantity : null,
          partitionId: q.partitionId || null,
          regionBounds: q.regionBounds || null,
          verificationPolicy: obj.verification_policy,
          safetyPolicy: {
            minHealth: 8,
            minFood: 6,
            avoidLava: true,
            maxFallBlocks: 3,
            allowPvp: false
          },
          leaseTtlMs: leaseDurationMs,
          issuedAt,
          expiresAt,
          checkpointIntervalMs
        };

        const validCheck = this._validator.validate('BotAssignmentV1', assignmentDto);
        if (!validCheck.valid) {
          throw new DomainError(
            'SCHEMA_VALIDATION_FAILED',
            `Invalid BotAssignmentV1: ${validCheck.errors.join('; ')}`
          );
        }

        this._store.run(
          `INSERT INTO assignments (
            assignment_id, task_id, objective_id, worker_id, bot_id, allocation_epoch, lease_id,
            state, action_type, item_key, quota_quantity, credited_quantity, baseline_quantity,
            baseline_snapshot_json, scope_json, constraints_json, lease_ttl_ms, issued_at, expires_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
          assignmentId,
          obj.task_id,
          obj.objective_id,
          q.workerId,
          q.botId,
          obj.allocation_epoch,
          leaseId,
          obj.kind,
          obj.resource_id,
          assignmentDto.quotaQuantity,
          JSON.stringify({ partitionId: q.partitionId || null, regionBounds: q.regionBounds || null, role: q.role || null }),
          JSON.stringify(constraints),
          leaseDurationMs,
          issuedAt,
          expiresAt
        );

        this._enqueueWorkerCommand(q.workerId, 'assign', assignmentDto, leaseDurationMs);
        created.push({ ...assignmentDto, state: 'offered', creditedQuantity: 0 });
      }

      const nextObjState = obj.state === 'ready' ? 'assigned' : obj.state;
      this._store.run(
        `UPDATE objectives
         SET reserved_quantity = reserved_quantity + ?, state = ?, version = version + 1
         WHERE objective_id = ?`,
        quotaSum,
        nextObjState,
        obj.objective_id
      );

      this._store.run(
        `UPDATE tasks
         SET state = CASE WHEN state = 'ready' THEN 'running' ELSE state END,
             version = version + 1,
             updated_at = ?
         WHERE task_id = ?`,
        issuedAt,
        obj.task_id
      );

      return created;
    });
  }

  /**
   * Record worker assignment acknowledgement & baseline inventory snapshot.
   */
  acknowledgeAssignment({
    workerId,
    commandId = null,
    assignmentId,
    leaseId,
    allocationEpoch,
    decision,
    rejectionCode = null,
    baselineSnapshot = null
  }) {
    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();

    return this._store.transaction(() => {
      const asg = this._store.get('SELECT * FROM assignments WHERE assignment_id = ?', assignmentId);
      if (!asg || asg.worker_id !== workerId || asg.lease_id !== leaseId) {
        throw new DomainError('NOT_FOUND', `Assignment ${assignmentId} not found for worker ${workerId}`);
      }
      const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', asg.objective_id);
      if (!obj || obj.allocation_epoch !== allocationEpoch || Date.parse(asg.expires_at) <= nowMs) {
        return { status: 'stale_rejected', rejectionCode: 'STALE_ALLOCATION_EPOCH' };
      }

      if (commandId) {
        this._store.run(
          'UPDATE command_outbox SET acked_at = COALESCE(acked_at, ?) WHERE command_id = ? AND worker_id = ?',
          nowIso,
          commandId,
          workerId
        );
      }

      if (asg.state === 'running' || asg.state === 'accepted') {
        return { status: 'duplicate', rejectionCode: null };
      }
      if (asg.state !== 'offered') {
        return { status: 'stale_rejected', rejectionCode: 'INVALID_ASSIGNMENT_STATE' };
      }

      if (decision === 'rejected') {
        const release =
          asg.quota_quantity !== null ? Math.max(0, asg.quota_quantity - asg.credited_quantity) : 0;
        this._store.run(
          `UPDATE assignments SET state = 'failed', completed_at = ? WHERE assignment_id = ?`,
          nowIso,
          assignmentId
        );
        this._store.run(
          `UPDATE objectives
           SET reserved_quantity = MAX(0, reserved_quantity - ?),
               state = CASE WHEN state = 'assigned' THEN 'ready' ELSE state END,
               version = version + 1
           WHERE objective_id = ?`,
          release,
          obj.objective_id
        );
        return { status: 'recorded', decision: 'rejected', rejectionCode };
      }

      const targetKey = obj.resource_id;
      const baseQty =
        targetKey && baselineSnapshot?.itemCounts
          ? Math.trunc(baselineSnapshot.itemCounts[targetKey] || 0)
          : 0;

      this._store.run(
        `UPDATE assignments
         SET state = 'running', baseline_quantity = ?, baseline_snapshot_json = ?
         WHERE assignment_id = ?`,
        baseQty,
        baselineSnapshot ? JSON.stringify(baselineSnapshot) : null,
        assignmentId
      );
      this._store.run(
        `UPDATE objectives
         SET state = CASE WHEN state = 'assigned' THEN 'running' ELSE state END,
             version = version + 1
         WHERE objective_id = ?`,
        obj.objective_id
      );

      return { status: 'recorded', decision: 'accepted' };
    });
  }

  /**
   * Apply a sequenced `DomainEventEnvelopeV1` from an authenticated worker with
   * full deduplication, epoch fencing, ledger verification, and DAG progression.
   */
  applyWorkerEvent(workerId, eventEnvelope, authWorker = null) {
    const valid = this._validator.validateWorkerEvent(eventEnvelope, authWorker);
    if (!valid.valid) {
      throw new DomainError(
        'SCHEMA_VALIDATION_FAILED',
        `Invalid worker event: ${valid.errors.join('; ')}`,
        { details: { errors: valid.errors } }
      );
    }

    const nowMs = this._now();
    const nowIso = new Date(nowMs).toISOString();

    return this._store.transaction(() => {
      // 1. Idempotency check by messageId or (worker_id, worker_sequence)
      const dupMsg = this._store.get(
        `SELECT response_json FROM worker_inbound_messages
         WHERE message_id = ? OR (worker_id = ? AND worker_sequence = ?)`,
        eventEnvelope.messageId,
        workerId,
        eventEnvelope.workerSequence
      );
      if (dupMsg) {
        const cached = JSON.parse(dupMsg.response_json);
        return { ...cached, status: 'duplicate' };
      }

      const worker = this._store.get('SELECT * FROM workers WHERE worker_id = ?', workerId);
      if (!worker || worker.status === 'disabled') {
        throw new DomainError('UNAUTHENTICATED', `Worker ${workerId} is not active`);
      }
      if (eventEnvelope.workerSequence <= worker.last_event_seq) {
        return {
          messageId: eventEnvelope.messageId,
          workerSequence: eventEnvelope.workerSequence,
          status: 'duplicate',
          rejectionCode: null,
          creditedDelta: 0
        };
      }

      const recordInbound = (ackObj) => {
        this._store.run(
          'UPDATE workers SET last_event_seq = ? WHERE worker_id = ?',
          eventEnvelope.workerSequence,
          workerId
        );
        this._store.run(
          `INSERT INTO worker_inbound_messages (message_id, worker_id, worker_sequence, response_json, received_at)
           VALUES (?, ?, ?, ?, ?)`,
          eventEnvelope.messageId,
          workerId,
          eventEnvelope.workerSequence,
          JSON.stringify(ackObj),
          nowIso
        );
        return ackObj;
      };

      const { eventType, payload } = eventEnvelope;

      if (eventType === 'assignment_progress' || eventType === 'assignment_completed') {
        return recordInbound(this._handleCompletionOrProgressInTx(workerId, eventEnvelope, payload, nowMs, nowIso));
      }

      if (eventType === 'assignment_failed') {
        return recordInbound(this._handleAssignmentFailedInTx(workerId, eventEnvelope, payload, nowMs, nowIso));
      }

      // Lifecycle / survival_override / chat_intent telemetry events
      return recordInbound({
        messageId: eventEnvelope.messageId,
        workerSequence: eventEnvelope.workerSequence,
        status: 'accepted',
        rejectionCode: null,
        creditedDelta: 0
      });
    });
  }

  _handleCompletionOrProgressInTx(workerId, envelope, report, nowMs, nowIso) {
    const asg = this._store.get('SELECT * FROM assignments WHERE assignment_id = ?', report.assignmentId);
    if (!asg || asg.worker_id !== workerId || asg.lease_id !== report.leaseId) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: 'ASSIGNMENT_NOT_FOUND',
        creditedDelta: 0
      };
    }

    const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', asg.objective_id);
    if (!obj || report.allocationEpoch !== obj.allocation_epoch) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: 'STALE_ALLOCATION_EPOCH',
        creditedDelta: 0
      };
    }

    if (
      ['expired', 'revoked', 'failed', 'completed'].includes(asg.state) ||
      Date.parse(asg.expires_at) <= nowMs
    ) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: 'LEASE_EXPIRED',
        creditedDelta: 0
      };
    }

    const baselineSnap = asg.baseline_snapshot_json
      ? JSON.parse(asg.baseline_snapshot_json)
      : report.beforeSnapshot;
    const constraints = JSON.parse(obj.constraints_json || '{}');
    let totalCreditedThisReport = 0;
    let runningPriorCredited = asg.credited_quantity;
    let firstRejectionCode = null;

    for (const evItem of report.evidence) {
      const ver = this._ledger.verifyEvidence({
        objective: obj,
        assignment: asg,
        baselineSnapshot: baselineSnap,
        beforeSnapshot: report.beforeSnapshot,
        afterSnapshot: report.afterSnapshot,
        evidenceItem: evItem,
        priorCredited: runningPriorCredited,
        allowExistingStock: Boolean(constraints.allowExistingStock)
      });

      if (!ver.valid || ver.creditableDelta <= 0) {
        if (!firstRejectionCode) firstRejectionCode = ver.rejectionCode || 'UNVERIFIED_EVIDENCE';
        if (ver.disputed) {
          this._store.recordAudit({
            occurredAt: nowIso,
            actorType: 'worker',
            actorId: workerId,
            action: 'evidence.disputed',
            targetId: report.assignmentId,
            outcome: 'rejected',
            details: { rejectionCode: ver.rejectionCode, evidenceId: evItem.evidenceId }
          });
        }
        continue;
      }

      const receipt = this._ledger.recordVerifiedCredit({
        evidenceId: evItem.evidenceId,
        taskId: obj.task_id,
        objectiveId: obj.objective_id,
        assignmentId: asg.assignment_id,
        botId: asg.bot_id,
        itemKey: ver.canonicalItemKey,
        creditableDelta: ver.creditableDelta,
        policy: obj.verification_policy,
        verifiedAt: nowIso
      });
      totalCreditedThisReport += receipt.creditedDelta;
      runningPriorCredited += receipt.creditedDelta;
    }

    // Refresh assignment & objective after credits
    const freshAsg = this._store.get('SELECT * FROM assignments WHERE assignment_id = ?', asg.assignment_id);
    const freshObj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', obj.objective_id);

    if (envelope.eventType === 'assignment_completed') {
      const unusedQuota =
        freshAsg.quota_quantity !== null
          ? Math.max(0, freshAsg.quota_quantity - freshAsg.credited_quantity)
          : 0;
      const reachedFullQuota =
        freshAsg.quota_quantity === null
          ? totalCreditedThisReport > 0
          : freshAsg.credited_quantity >= freshAsg.quota_quantity;

      this._store.run(
        `UPDATE assignments SET state = ?, completed_at = ? WHERE assignment_id = ?`,
        reachedFullQuota || report.outcome === 'partial' ? 'completed' : 'completed',
        nowIso,
        freshAsg.assignment_id
      );

      if (unusedQuota > 0 && freshObj.state !== 'completed') {
        this._store.run(
          `UPDATE objectives
           SET reserved_quantity = MAX(0, reserved_quantity - ?),
               state = CASE WHEN reserved_quantity - ? <= 0 THEN 'ready' ELSE state END,
               version = version + 1
           WHERE objective_id = ?`,
          unusedQuota,
          unusedQuota,
          freshObj.objective_id
        );
      }
    }

    this._finalizeObjectiveAndTaskProgressInTx(obj.task_id, nowIso);

    if (totalCreditedThisReport === 0 && firstRejectionCode) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: firstRejectionCode,
        creditedDelta: 0
      };
    }

    return {
      messageId: envelope.messageId,
      workerSequence: envelope.workerSequence,
      status: 'accepted',
      rejectionCode: null,
      creditedDelta: totalCreditedThisReport
    };
  }

  _handleAssignmentFailedInTx(workerId, envelope, failReport, nowMs, nowIso) {
    let partialCredited = 0;
    if (failReport.partialReport) {
      const partialRes = this._handleCompletionOrProgressInTx(
        workerId,
        { ...envelope, eventType: 'assignment_progress' },
        failReport.partialReport,
        nowMs,
        nowIso
      );
      partialCredited = partialRes.creditedDelta || 0;
    }

    const asg = this._store.get(
      'SELECT * FROM assignments WHERE assignment_id = ?',
      failReport.assignmentId
    );
    if (!asg || asg.worker_id !== workerId || asg.lease_id !== failReport.leaseId) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: 'ASSIGNMENT_NOT_FOUND',
        creditedDelta: partialCredited
      };
    }

    const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', asg.objective_id);
    if (!obj || failReport.allocationEpoch !== obj.allocation_epoch) {
      return {
        messageId: envelope.messageId,
        workerSequence: envelope.workerSequence,
        status: 'rejected',
        rejectionCode: 'STALE_ALLOCATION_EPOCH',
        creditedDelta: partialCredited
      };
    }

    if (!['completed', 'failed', 'revoked', 'expired'].includes(asg.state)) {
      const uncredited =
        asg.quota_quantity !== null ? Math.max(0, asg.quota_quantity - asg.credited_quantity) : 0;
      this._store.run(
        `UPDATE assignments SET state = 'failed', failure_code = ?, completed_at = ? WHERE assignment_id = ?`,
        failReport.failureCode,
        nowIso,
        asg.assignment_id
      );

      if (obj.state !== 'completed') {
        const remainingActive = this._store.get(
          `SELECT COUNT(*) AS cnt FROM assignments
           WHERE objective_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
          obj.objective_id
        );
        const nextObjState =
          Number(remainingActive?.cnt || 0) > 0
            ? obj.state
            : failReport.retryable === false &&
                ['RESOURCE_NOT_FOUND', 'PATH_BLOCKED', 'BOT_KICKED_OR_BANNED'].includes(failReport.failureCode)
              ? 'blocked'
              : 'ready';

        this._store.run(
          `UPDATE objectives
           SET reserved_quantity = MAX(0, reserved_quantity - ?),
               state = ?,
               version = version + 1
           WHERE objective_id = ?`,
          uncredited,
          nextObjState,
          obj.objective_id
        );
      }
    }

    this._finalizeObjectiveAndTaskProgressInTx(obj.task_id, nowIso);

    return {
      messageId: envelope.messageId,
      workerSequence: envelope.workerSequence,
      status: 'accepted',
      rejectionCode: null,
      creditedDelta: partialCredited,
      failureCode: failReport.failureCode
    };
  }

  /**
   * Auto-complete `start_with` `role_duration` companions (e.g. `guard` while `build` completes),
   * unlock newly ready downstream DAG objectives, and update parent `Task.state`.
   */
  _finalizeObjectiveAndTaskProgressInTx(taskId, nowIso) {
    // 1. Check `start_with` role_duration companions whose target objective(s) are all completed
    const roleCompanions = this._store.all(
      `SELECT * FROM objectives
       WHERE task_id = ? AND verification_policy = 'role_duration'
         AND state IN ('ready', 'assigned', 'running', 'verifying')`,
      taskId
    );
    for (const comp of roleCompanions) {
      const startDeps = this._store.all(
        `SELECT d.depends_on_objective_id, o.state AS target_state
         FROM objective_dependencies d
         JOIN objectives o ON o.objective_id = d.depends_on_objective_id
         WHERE d.objective_id = ? AND d.edge_type = 'start_with'`,
        comp.objective_id
      );
      if (startDeps.length > 0 && startDeps.every((d) => d.target_state === 'completed')) {
        this._store.run(
          `UPDATE assignments
           SET state = 'completed', completed_at = ?
           WHERE objective_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
          nowIso,
          comp.objective_id
        );
        this._store.run(
          `UPDATE objectives
           SET state = 'completed', reserved_quantity = 0, verified_quantity = MAX(1, verified_quantity), version = version + 1
           WHERE objective_id = ?`,
          comp.objective_id
        );
      }
    }

    // 2. Unlock downstream DAG nodes
    this._unlockReadyObjectivesInTx(taskId);

    // 3. Recompute parent Task state
    const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
    if (!task || ['completed', 'failed', 'cancelled', 'paused'].includes(task.state)) return;

    const objs = this._store.all('SELECT state FROM objectives WHERE task_id = ?', taskId);
    if (objs.length === 0) return;

    if (objs.every((o) => o.state === 'completed')) {
      this._store.run(
        `UPDATE tasks SET state = 'completed', version = version + 1, updated_at = ? WHERE task_id = ?`,
        nowIso,
        taskId
      );
    } else if (objs.some((o) => o.state === 'blocked') && !objs.some((o) => ['assigned', 'running', 'verifying'].includes(o.state))) {
      this._store.run(
        `UPDATE tasks SET state = 'blocked', version = version + 1, updated_at = ? WHERE task_id = ?`,
        nowIso,
        taskId
      );
    }
  }

  /**
   * Fence expired leases (`allocation_epoch + 1`) BEFORE releasing unverified quota (`G-08`, `G-15`).
   */
  expireLeases(nowIso = this._nowIso()) {
    const expired = [];
    this._store.transaction(() => {
      const rows = this._store.all(
        `SELECT * FROM assignments
         WHERE state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')
           AND expires_at <= ?`,
        nowIso
      );
      if (rows.length === 0) return;

      const objectivesToFence = new Set(rows.map((r) => r.objective_id));
      for (const objId of objectivesToFence) {
        this._store.run(
          `UPDATE objectives
           SET allocation_epoch = allocation_epoch + 1, version = version + 1
           WHERE objective_id = ? AND state NOT IN ('completed', 'cancelled', 'failed')`,
          objId
        );
      }

      for (const asg of rows) {
        const uncredited =
          asg.quota_quantity !== null ? Math.max(0, asg.quota_quantity - asg.credited_quantity) : 0;
        this._store.run(
          `UPDATE assignments SET state = 'expired', completed_at = ? WHERE assignment_id = ?`,
          nowIso,
          asg.assignment_id
        );

        const obj = this._store.get('SELECT * FROM objectives WHERE objective_id = ?', asg.objective_id);
        if (obj && obj.state !== 'completed') {
          const stillActive = this._store.get(
            `SELECT COUNT(*) AS cnt FROM assignments
             WHERE objective_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
            asg.objective_id
          );
          const nextState =
            Number(stillActive?.cnt || 0) > 0
              ? obj.state
              : ['assigned', 'running', 'verifying'].includes(obj.state)
                ? 'ready'
                : obj.state;

          this._store.run(
            `UPDATE objectives
             SET reserved_quantity = MAX(0, reserved_quantity - ?),
                 state = ?,
                 version = version + 1
             WHERE objective_id = ?`,
            uncredited,
            nextState,
            asg.objective_id
          );
        }

        this._enqueueWorkerCommand(asg.worker_id, 'fence_epoch', {
          assignmentId: asg.assignment_id,
          leaseId: asg.lease_id,
          newAllocationEpoch: obj ? obj.allocation_epoch : asg.allocation_epoch + 1
        });

        expired.push({
          assignmentId: asg.assignment_id,
          leaseId: asg.lease_id,
          taskId: asg.task_id,
          objectiveId: asg.objective_id,
          workerId: asg.worker_id,
          botId: asg.bot_id,
          releasedQuantity: uncredited,
          newAllocationEpoch: obj ? obj.allocation_epoch : asg.allocation_epoch + 1
        });
      }
    });

    for (const item of expired) {
      this.emit('lease.fenced', item);
    }
    return expired;
  }

  /**
   * Reconcile a reconnecting worker's active leases and return authoritative `lastAckedWorkerSequence` (`HIGH-05`).
   */
  reconcileWorker(workerId, snapshotPayload = {}) {
    const nowMs = this._now();
    const activeReported = Array.isArray(snapshotPayload.activeLeases)
      ? snapshotPayload.activeLeases
      : [];

    return this._store.transaction(() => {
      const worker = this._store.get('SELECT * FROM workers WHERE worker_id = ?', workerId);
      if (!worker || worker.status === 'disabled') {
        throw new DomainError('UNAUTHENTICATED', `Worker ${workerId} is unknown or disabled`);
      }

      const actions = [];
      for (const item of activeReported) {
        const asg = this._store.get(
          'SELECT * FROM assignments WHERE assignment_id = ? AND worker_id = ?',
          String(item.assignmentId || ''),
          workerId
        );
        const obj = asg
          ? this._store.get('SELECT allocation_epoch, state FROM objectives WHERE objective_id = ?', asg.objective_id)
          : null;

        const stillValid =
          asg &&
          obj &&
          asg.lease_id === item.leaseId &&
          obj.allocation_epoch === item.allocationEpoch &&
          ['offered', 'accepted', 'running', 'reporting', 'verifying'].includes(asg.state) &&
          Date.parse(asg.expires_at) > nowMs &&
          obj.state !== 'completed';

        actions.push({
          assignmentId: String(item.assignmentId || ''),
          directive: stillValid ? 'continue' : 'stop_and_fence',
          currentAllocationEpoch: obj ? obj.allocation_epoch : null
        });
      }

      return {
        schemaVersion: 1,
        workerId,
        lastAckedWorkerSequence: worker.last_event_seq,
        reconcileActions: actions
      };
    });
  }

  pauseTask(taskId, reason = 'operator_paused') {
    const nowIso = this._nowIso();
    return this._store.transaction(() => {
      const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
      if (!task) throw new DomainError('NOT_FOUND', `Task ${taskId} not found`);
      assertTaskTransition(task.state, 'paused');

      const activeAsgs = this._store.all(
        `SELECT * FROM assignments
         WHERE task_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        taskId
      );
      for (const asg of activeAsgs) {
        this._enqueueWorkerCommand(asg.worker_id, 'pause', {
          assignmentId: asg.assignment_id,
          leaseId: asg.lease_id,
          botId: asg.bot_id,
          reason
        });
      }

      this._store.run(
        `UPDATE tasks SET state = 'paused', pause_reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?`,
        String(reason),
        nowIso,
        taskId
      );
      return this._formatTaskSummary(this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId));
    });
  }

  resumeTask(taskId) {
    const nowIso = this._nowIso();
    return this._store.transaction(() => {
      const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
      if (!task) throw new DomainError('NOT_FOUND', `Task ${taskId} not found`);
      const nextState = task.plan_version === 0 ? 'queued' : 'ready';
      assertTaskTransition(task.state, nextState);

      this._store.run(
        `UPDATE tasks SET state = ?, pause_reason = NULL, version = version + 1, updated_at = ? WHERE task_id = ?`,
        nextState,
        nowIso,
        taskId
      );
      return this._formatTaskSummary(this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId));
    });
  }

  cancelTask(taskId, reason = 'operator_cancelled') {
    const nowIso = this._nowIso();
    return this._store.transaction(() => {
      const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
      if (!task) throw new DomainError('NOT_FOUND', `Task ${taskId} not found`);
      assertTaskTransition(task.state, 'cancelled');

      const activeAsgs = this._store.all(
        `SELECT * FROM assignments
         WHERE task_id = ? AND state IN ('offered', 'accepted', 'running', 'reporting', 'verifying')`,
        taskId
      );
      for (const asg of activeAsgs) {
        this._store.run(
          `UPDATE assignments SET state = 'revoked', completed_at = ? WHERE assignment_id = ?`,
          nowIso,
          asg.assignment_id
        );
        this._enqueueWorkerCommand(asg.worker_id, 'cancel', {
          assignmentId: asg.assignment_id,
          leaseId: asg.lease_id,
          botId: asg.bot_id,
          reason
        });
      }

      this._store.run(
        `UPDATE objectives
         SET state = CASE WHEN state = 'completed' THEN 'completed' ELSE 'cancelled' END,
             reserved_quantity = 0,
             allocation_epoch = allocation_epoch + 1,
             version = version + 1
         WHERE task_id = ?`,
        taskId
      );
      this._store.run(
        `UPDATE tasks SET state = 'cancelled', pause_reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?`,
        String(reason),
        nowIso,
        taskId
      );
      return this._formatTaskSummary(this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId));
    });
  }

  getTask(taskId) {
    const task = this._store.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
    if (!task) {
      throw new DomainError('NOT_FOUND', `Task ${taskId} not found`);
    }
    const objRows = this._store.all(
      'SELECT * FROM objectives WHERE task_id = ? ORDER BY local_id ASC',
      taskId
    );
    const objectives = objRows.map((o) => {
      const deps = this._store.all(
        'SELECT * FROM objective_dependencies WHERE objective_id = ?',
        o.objective_id
      );
      return this._formatObjectiveRow(o, deps);
    });

    const asgRows = this._store.all(
      `SELECT * FROM assignments WHERE task_id = ? ORDER BY issued_at ASC`,
      taskId
    );
    const activeAssignments = asgRows.map((a) => ({
      assignmentId: a.assignment_id,
      leaseId: a.lease_id,
      allocationEpoch: a.allocation_epoch,
      taskId: a.task_id,
      objectiveId: a.objective_id,
      workerId: a.worker_id,
      botId: a.bot_id,
      state: a.state,
      actionType: a.action_type,
      resourceId: a.item_key,
      quotaQuantity: a.quota_quantity,
      creditedQuantity: a.credited_quantity,
      leaseTtlMs: a.lease_ttl_ms,
      issuedAt: a.issued_at,
      expiresAt: a.expires_at
    }));

    return {
      ...this._formatTaskSummary(task),
      rawText: task.raw_text,
      planVersion: task.plan_version,
      objectives,
      activeAssignments
    };
  }

  listTasks({ state = null, limit = 20, cursor = null } = {}) {
    const cappedLimit = Math.min(100, Math.max(1, Math.trunc(limit || 20)));
    const params = [];
    const clauses = [];
    if (state) {
      clauses.push('state = ?');
      params.push(String(state));
    }
    if (cursor) {
      clauses.push('created_at < ?');
      params.push(String(cursor));
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this._store.all(
      `SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      cappedLimit + 1
    );

    const hasMore = rows.length > cappedLimit;
    const slice = hasMore ? rows.slice(0, cappedLimit) : rows;
    return {
      items: slice.map((r) => this._formatTaskSummary(r)),
      nextCursor: hasMore ? slice[slice.length - 1].created_at : null
    };
  }
}

module.exports = {
  TaskManager,
  LEGAL_TASK_TRANSITIONS,
  LEGAL_OBJECTIVE_TRANSITIONS
};
