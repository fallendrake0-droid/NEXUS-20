'use strict';

const { validateTaskPlanV1 } = require('../performance/AiEfficiencyController');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID_RE = /^[a-z0-9_]+:[a-z0-9_./-]+$/;
const DIMENSIONS = new Set([
  'minecraft:overworld',
  'minecraft:the_nether',
  'minecraft:the_end',
  'unknown'
]);
const ACTION_TYPES = new Set([
  'mine',
  'collect',
  'craft',
  'build',
  'explore',
  'guard',
  'transfer',
  'repair',
  'inspect',
  'safe_stop'
]);
const VERIFICATION_POLICIES = new Set([
  'newly_collected',
  'held_stock',
  'deposited_stock',
  'crafted_output',
  'block_state',
  'region_visited',
  'role_duration',
  'operator_review'
]);
const EVIDENCE_KINDS = new Set([
  'inventory_delta',
  'container_delta',
  'craft_delta',
  'transfer_delta',
  'block_state',
  'region_visited',
  'role_duration'
]);
const FAILURE_CODES = new Set([
  'PATH_BLOCKED',
  'RESOURCE_NOT_FOUND',
  'TOOL_BROKEN_OR_MISSING',
  'INVENTORY_FULL',
  'HEALTH_CRITICAL',
  'BOT_DIED',
  'BOT_DISCONNECTED',
  'BOT_KICKED_OR_BANNED',
  'LEASE_EXPIRED_LOCALLY',
  'OPERATOR_CANCELLED',
  'ACTION_TIMEOUT',
  'INTERNAL_EXECUTOR_ERROR'
]);
const COMMAND_TYPES = new Set([
  'assign',
  'cancel',
  'pause',
  'resume',
  'safe_stop',
  'request_snapshot',
  'fence_epoch'
]);
const EVENT_TYPES = new Set([
  'assignment_progress',
  'assignment_completed',
  'assignment_failed',
  'bot_lifecycle',
  'survival_override',
  'chat_intent'
]);

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function checkAllowedKeys(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      errors.push(`${prefix} unknown property: ${k}`);
    }
  }
}

function isIsoDateString(v) {
  if (typeof v !== 'string' || v.length < 10 || v.length > 64) return false;
  return Number.isFinite(Date.parse(v));
}

function validateInventorySnapshot(snap, prefix, errors) {
  if (!isPlainObject(snap)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  checkAllowedKeys(snap, new Set(['botId', 'capturedAt', 'itemCounts', 'heldTool']), prefix, errors);
  if (typeof snap.botId !== 'string' || snap.botId.length < 1 || snap.botId.length > 64) {
    errors.push(`${prefix}.botId invalid`);
  }
  if (!isIsoDateString(snap.capturedAt)) {
    errors.push(`${prefix}.capturedAt must be ISO date-time`);
  }
  if (snap.heldTool !== undefined && snap.heldTool !== null) {
    if (!isPlainObject(snap.heldTool)) {
      errors.push(`${prefix}.heldTool must be null or object`);
    } else {
      checkAllowedKeys(snap.heldTool, new Set(['itemKey', 'remainingDurability']), `${prefix}.heldTool`, errors);
      if (typeof snap.heldTool.itemKey !== 'string' || !RESOURCE_ID_RE.test(snap.heldTool.itemKey)) {
        errors.push(`${prefix}.heldTool.itemKey invalid`);
      }
      if (
        snap.heldTool.remainingDurability !== undefined &&
        snap.heldTool.remainingDurability !== null &&
        (!Number.isSafeInteger(snap.heldTool.remainingDurability) || snap.heldTool.remainingDurability < 0)
      ) {
        errors.push(`${prefix}.heldTool.remainingDurability must be null or integer >= 0`);
      }
    }
  }
  if (!isPlainObject(snap.itemCounts)) {
    errors.push(`${prefix}.itemCounts must be an object`);
  } else {
    const keys = Object.keys(snap.itemCounts);
    if (keys.length > 64) errors.push(`${prefix}.itemCounts exceeds 64 keys`);
    for (const k of keys) {
      const v = snap.itemCounts[k];
      if (!Number.isSafeInteger(v) || v < 0 || v > 100_000) {
        errors.push(`${prefix}.itemCounts[${k}] must be integer 0..100000`);
      }
    }
  }
}

function validateBotAssignmentV1(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ['BotAssignmentV1 must be an object'] };

  const allowed = new Set([
    'schemaVersion',
    'assignmentId',
    'leaseId',
    'allocationEpoch',
    'taskId',
    'objectiveId',
    'workerId',
    'botId',
    'actionType',
    'resourceId',
    'quotaQuantity',
    'partitionId',
    'regionBounds',
    'verificationPolicy',
    'safetyPolicy',
    'leaseTtlMs',
    'issuedAt',
    'expiresAt',
    'checkpointIntervalMs'
  ]);
  checkAllowedKeys(value, allowed, 'BotAssignmentV1', errors);

  if (value.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!UUID_RE.test(String(value.assignmentId || ''))) errors.push('assignmentId must be UUID');
  if (!UUID_RE.test(String(value.leaseId || ''))) errors.push('leaseId must be UUID');
  if (!UUID_RE.test(String(value.taskId || ''))) errors.push('taskId must be UUID');
  if (!Number.isSafeInteger(value.allocationEpoch) || value.allocationEpoch < 1) {
    errors.push('allocationEpoch must be integer >= 1');
  }
  if (typeof value.objectiveId !== 'string' || value.objectiveId.length < 1 || value.objectiveId.length > 64) {
    errors.push('objectiveId invalid');
  }
  if (typeof value.workerId !== 'string' || value.workerId.length < 1 || value.workerId.length > 64) {
    errors.push('workerId invalid');
  }
  if (typeof value.botId !== 'string' || value.botId.length < 1 || value.botId.length > 48) {
    errors.push('botId invalid');
  }
  if (!ACTION_TYPES.has(value.actionType)) errors.push(`Unsupported actionType: ${value.actionType}`);
  if (value.resourceId !== null && !RESOURCE_ID_RE.test(String(value.resourceId))) {
    errors.push('resourceId must be null or namespace:id');
  }
  if (
    value.quotaQuantity !== null &&
    (!Number.isSafeInteger(value.quotaQuantity) || value.quotaQuantity < 1 || value.quotaQuantity > 1_000_000)
  ) {
    errors.push('quotaQuantity must be null or integer 1..1000000');
  }
  if (!VERIFICATION_POLICIES.has(value.verificationPolicy)) {
    errors.push(`Unsupported verificationPolicy: ${value.verificationPolicy}`);
  }
  if (!isPlainObject(value.safetyPolicy)) {
    errors.push('safetyPolicy must be an object');
  } else {
    checkAllowedKeys(
      value.safetyPolicy,
      new Set(['minHealth', 'minFood', 'avoidLava', 'maxFallBlocks', 'allowPvp']),
      'safetyPolicy',
      errors
    );
    if (value.safetyPolicy.allowPvp !== false) {
      errors.push('safetyPolicy.allowPvp must strictly equal false');
    }
  }
  if (!Number.isSafeInteger(value.leaseTtlMs) || value.leaseTtlMs < 3000 || value.leaseTtlMs > 120_000) {
    errors.push('leaseTtlMs must be integer 3000..120000');
  }
  if (!isIsoDateString(value.issuedAt)) errors.push('issuedAt must be ISO date-time');
  if (!isIsoDateString(value.expiresAt)) errors.push('expiresAt must be ISO date-time');
  if (
    !Number.isSafeInteger(value.checkpointIntervalMs) ||
    value.checkpointIntervalMs < 1000 ||
    value.checkpointIntervalMs > 30_000
  ) {
    errors.push('checkpointIntervalMs must be integer 1000..30000');
  }

  return { valid: errors.length === 0, errors };
}

function validateTaskCompletionReportV1(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['TaskCompletionReportV1 must be an object'] };
  }
  const allowed = new Set([
    'schemaVersion',
    'reportId',
    'assignmentId',
    'leaseId',
    'allocationEpoch',
    'taskId',
    'objectiveId',
    'workerId',
    'botId',
    'outcome',
    'durationMs',
    'beforeSnapshot',
    'afterSnapshot',
    'evidence',
    'reportedAt'
  ]);
  checkAllowedKeys(value, allowed, 'TaskCompletionReportV1', errors);

  if (value.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!UUID_RE.test(String(value.reportId || ''))) errors.push('reportId must be UUID');
  if (!UUID_RE.test(String(value.assignmentId || ''))) errors.push('assignmentId must be UUID');
  if (!UUID_RE.test(String(value.leaseId || ''))) errors.push('leaseId must be UUID');
  if (!UUID_RE.test(String(value.taskId || ''))) errors.push('taskId must be UUID');
  if (!Number.isSafeInteger(value.allocationEpoch) || value.allocationEpoch < 1) {
    errors.push('allocationEpoch must be integer >= 1');
  }
  if (value.outcome !== 'completed' && value.outcome !== 'partial') {
    errors.push('outcome must be completed or partial');
  }
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0) {
    errors.push('durationMs must be integer >= 0');
  }
  validateInventorySnapshot(value.beforeSnapshot, 'beforeSnapshot', errors);
  validateInventorySnapshot(value.afterSnapshot, 'afterSnapshot', errors);

  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 16) {
    errors.push('evidence must contain 1..16 items');
  } else {
    for (let i = 0; i < value.evidence.length; i += 1) {
      const ev = value.evidence[i];
      if (!isPlainObject(ev)) {
        errors.push(`evidence[${i}] must be an object`);
        continue;
      }
      checkAllowedKeys(
        ev,
        new Set(['evidenceId', 'kind', 'itemKey', 'claimedDelta', 'details']),
        `evidence[${i}]`,
        errors
      );
      if (!UUID_RE.test(String(ev.evidenceId || ''))) {
        errors.push(`evidence[${i}].evidenceId must be UUID`);
      }
      if (!EVIDENCE_KINDS.has(ev.kind)) {
        errors.push(`evidence[${i}].kind unsupported: ${ev.kind}`);
      }
      if (ev.itemKey !== null && !RESOURCE_ID_RE.test(String(ev.itemKey))) {
        errors.push(`evidence[${i}].itemKey invalid`);
      }
      if (!Number.isSafeInteger(ev.claimedDelta) || ev.claimedDelta < 0 || ev.claimedDelta > 100_000) {
        errors.push(`evidence[${i}].claimedDelta invalid`);
      }
      if (!isPlainObject(ev.details)) {
        errors.push(`evidence[${i}].details must be an object`);
      }
    }
  }
  if (!isIsoDateString(value.reportedAt)) errors.push('reportedAt must be ISO date-time');

  return { valid: errors.length === 0, errors };
}

function validateFailureReportV1(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ['FailureReportV1 must be an object'] };
  const allowed = new Set([
    'schemaVersion',
    'reportId',
    'assignmentId',
    'leaseId',
    'allocationEpoch',
    'taskId',
    'objectiveId',
    'workerId',
    'botId',
    'failureCode',
    'retryable',
    'safeState',
    'summary',
    'partialReport',
    'reportedAt'
  ]);
  checkAllowedKeys(value, allowed, 'FailureReportV1', errors);

  if (value.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!UUID_RE.test(String(value.reportId || ''))) errors.push('reportId must be UUID');
  if (!UUID_RE.test(String(value.assignmentId || ''))) errors.push('assignmentId must be UUID');
  if (!UUID_RE.test(String(value.leaseId || ''))) errors.push('leaseId must be UUID');
  if (!UUID_RE.test(String(value.taskId || ''))) errors.push('taskId must be UUID');
  if (!Number.isSafeInteger(value.allocationEpoch) || value.allocationEpoch < 1) {
    errors.push('allocationEpoch must be integer >= 1');
  }
  if (!FAILURE_CODES.has(value.failureCode)) {
    errors.push(`Unsupported failureCode: ${value.failureCode}`);
  }
  if (typeof value.retryable !== 'boolean') errors.push('retryable must be boolean');
  if (!['idle_safe', 'eating_shelter', 'stopped', 'disconnected'].includes(value.safeState)) {
    errors.push('safeState invalid');
  }
  if (typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.length > 240) {
    errors.push('summary must be 1..240 chars');
  }
  if (value.partialReport !== null) {
    const sub = validateTaskCompletionReportV1(value.partialReport);
    if (!sub.valid) {
      for (const e of sub.errors) errors.push(`partialReport.${e}`);
    }
  }
  if (!isIsoDateString(value.reportedAt)) errors.push('reportedAt must be ISO date-time');

  return { valid: errors.length === 0, errors };
}

function validateCommandEnvelopeV1(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ['CommandEnvelopeV1 must be an object'] };
  checkAllowedKeys(
    value,
    new Set([
      'schemaVersion',
      'commandId',
      'sequence',
      'workerId',
      'issuedAt',
      'expiresAt',
      'commandType',
      'payload'
    ]),
    'CommandEnvelopeV1',
    errors
  );
  if (value.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!UUID_RE.test(String(value.commandId || ''))) errors.push('commandId must be UUID');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) errors.push('sequence must be >= 1');
  if (typeof value.workerId !== 'string' || !value.workerId) errors.push('workerId required');
  if (!COMMAND_TYPES.has(value.commandType)) errors.push(`Unsupported commandType: ${value.commandType}`);
  if (!isIsoDateString(value.issuedAt)) errors.push('issuedAt invalid');
  if (!isIsoDateString(value.expiresAt)) errors.push('expiresAt invalid');
  if (!isPlainObject(value.payload)) errors.push('payload must be an object');
  return { valid: errors.length === 0, errors };
}

function validateDomainEventEnvelopeV1(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['DomainEventEnvelopeV1 must be an object'] };
  }
  checkAllowedKeys(
    value,
    new Set(['schemaVersion', 'messageId', 'workerId', 'workerSequence', 'createdAt', 'eventType', 'payload']),
    'DomainEventEnvelopeV1',
    errors
  );
  if (value.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!UUID_RE.test(String(value.messageId || ''))) errors.push('messageId must be UUID');
  if (typeof value.workerId !== 'string' || !value.workerId) errors.push('workerId required');
  if (!Number.isSafeInteger(value.workerSequence) || value.workerSequence < 1) {
    errors.push('workerSequence must be integer >= 1');
  }
  if (!isIsoDateString(value.createdAt)) errors.push('createdAt invalid');
  if (!EVENT_TYPES.has(value.eventType)) errors.push(`Unsupported eventType: ${value.eventType}`);
  if (!isPlainObject(value.payload)) errors.push('payload must be an object');
  return { valid: errors.length === 0, errors };
}

class SchemaValidator {
  /**
   * @param {{ allowedResources?: Set<string> | null }} [options]
   */
  constructor(options = {}) {
    this._allowedResources = options.allowedResources || null;
  }

  validate(schemaId, value) {
    if (isPlainObject(value) && value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      return {
        valid: false,
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        errors: [`Unsupported schemaVersion: ${value.schemaVersion}`]
      };
    }

    switch (schemaId) {
      case 'TaskPlanV1':
        return validateTaskPlanV1(value, { allowedResources: this._allowedResources });
      case 'BotAssignmentV1':
        return validateBotAssignmentV1(value);
      case 'TaskCompletionReportV1':
        return validateTaskCompletionReportV1(value);
      case 'FailureReportV1':
        return validateFailureReportV1(value);
      case 'CommandEnvelopeV1':
        return validateCommandEnvelopeV1(value);
      case 'DomainEventEnvelopeV1':
        return validateDomainEventEnvelopeV1(value);
      default:
        return { valid: false, errors: [`Unknown schemaId: ${schemaId}`] };
    }
  }

  validatePlanSemantics(plan, registryContext = {}) {
    return validateTaskPlanV1(plan, {
      allowedResources: registryContext.allowedResources || this._allowedResources
    });
  }

  validateAssignment(assignment, botCapabilities = null) {
    const base = validateBotAssignmentV1(assignment);
    if (!base.valid || !botCapabilities) return base;
    const errors = [...base.errors];
    if (botCapabilities.botId && botCapabilities.botId !== assignment.botId) {
      errors.push('Assignment botId does not match candidate capabilities');
    }
    if (
      Array.isArray(botCapabilities.supportedActions) &&
      assignment.actionType !== 'safe_stop' &&
      !botCapabilities.supportedActions.includes(assignment.actionType)
    ) {
      errors.push(`Bot ${assignment.botId} does not support action ${assignment.actionType}`);
    }
    return { valid: errors.length === 0, errors };
  }

  validateWorkerEvent(envelope, authWorker = null) {
    const base = validateDomainEventEnvelopeV1(envelope);
    if (!base.valid) return base;
    const errors = [];
    if (authWorker && authWorker.workerId !== envelope.workerId) {
      errors.push(`Worker ${authWorker.workerId} cannot emit events for ${envelope.workerId}`);
    }
    if (
      authWorker &&
      Array.isArray(authWorker.allowedBotIds) &&
      envelope.payload?.botId &&
      !authWorker.allowedBotIds.includes(envelope.payload.botId)
    ) {
      errors.push(`Bot ${envelope.payload.botId} is not owned by worker ${authWorker.workerId}`);
    }
    if (envelope.eventType === 'assignment_completed' || envelope.eventType === 'assignment_progress') {
      const sub = validateTaskCompletionReportV1(envelope.payload);
      if (!sub.valid) errors.push(...sub.errors);
    } else if (envelope.eventType === 'assignment_failed') {
      const sub = validateFailureReportV1(envelope.payload);
      if (!sub.valid) errors.push(...sub.errors);
    }
    return { valid: errors.length === 0, errors };
  }
}

module.exports = {
  SchemaValidator,
  DIMENSIONS,
  ACTION_TYPES,
  VERIFICATION_POLICIES
};
