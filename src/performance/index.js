'use strict';

const { RingBuffer } = require('./RingBuffer');
const { BoundedCache, estimateValueBytes } = require('./BoundedCache');
const { BoundedByteQueue } = require('./BoundedByteQueue');
const { TimerRegistry } = require('./TimerRegistry');
const { ScopedListeners, countEmitterListeners } = require('./ScopedListeners');
const {
  toCompactBotSnapshot,
  fingerprintSnapshot,
  encodeJsonBuffer,
  bandFromRatio
} = require('./CompactSnapshotCodec');
const { SseCoalescer } = require('./SseCoalescer');
const { BoundedLogger, sanitizeValue } = require('./BoundedLogger');
const { PathfindingGuard, quantizeCoord } = require('./PathfindingGuard');
const { BlockSearchCache } = require('./BlockSearchCache');
const { ChatHistoryGuard, ALLOWED_VERBS } = require('./ChatHistoryGuard');
const {
  AiEfficiencyController,
  validateTaskPlanV1,
  buildDeterministicPlan,
  validateOllamaEndpointPolicy,
  buildCompactAiInput,
  TASK_PLAN_V1_SCHEMA
} = require('./AiEfficiencyController');
const { ResourceMonitor, readSystemMemory, inspectRuntimeHandles } = require('../monitoring/ResourceMonitor');
const { WorkloadGovernor } = require('../monitoring/WorkloadGovernor');
const { EventBus } = require('../events/EventBus');

module.exports = {
  RingBuffer,
  BoundedCache,
  estimateValueBytes,
  BoundedByteQueue,
  TimerRegistry,
  ScopedListeners,
  countEmitterListeners,
  toCompactBotSnapshot,
  fingerprintSnapshot,
  encodeJsonBuffer,
  bandFromRatio,
  SseCoalescer,
  BoundedLogger,
  sanitizeValue,
  PathfindingGuard,
  quantizeCoord,
  BlockSearchCache,
  ChatHistoryGuard,
  ALLOWED_VERBS,
  AiEfficiencyController,
  validateTaskPlanV1,
  buildDeterministicPlan,
  validateOllamaEndpointPolicy,
  buildCompactAiInput,
  TASK_PLAN_V1_SCHEMA,
  ResourceMonitor,
  readSystemMemory,
  inspectRuntimeHandles,
  WorkloadGovernor,
  EventBus
};
