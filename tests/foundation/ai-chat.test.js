'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Coordinator } = require('../../src/coordinator/Coordinator');
const { buildCompactAiInput } = require('../../src/performance/AiEfficiencyController');

const ADMIN = { principalId: 'admin-chat-test', actorType: 'human', role: 'admin', serverId: null };

test('AI chat clarification replans the original task with the answer and bounded conversation context', async () => {
  const original = {
    taskId: 'task-chat-1',
    state: 'clarification_required',
    rawText: 'Build a safe shelter near our base.'
  };
  const ready = { taskId: original.taskId, state: 'ready', intentSummary: 'Build a starter shelter' };
  let lookupCount = 0;
  let planParams = null;
  const coordinator = Object.create(Coordinator.prototype);
  coordinator._safeMode = false;
  coordinator._tasks = {
    getTask() { lookupCount += 1; return lookupCount === 1 ? original : ready; },
    attachPlan({ plan }) { assert.deepEqual(plan, { schemaVersion: 1 }); return { state: 'ready' }; }
  };
  coordinator._ai = {
    listProviders() { return [{ active: true, available: true }]; },
    async createPlan(params) { planParams = params; return { plan: { schemaVersion: 1 } }; }
  };
  coordinator.buildSwarmWorldContext = () => ({ maxBots: 2 });
  coordinator.scheduleReadyObjectives = async () => {};
  coordinator._publishPostCommit = () => {};

  const result = await coordinator.clarifyTask({
    actor: ADMIN,
    taskId: original.taskId,
    answerText: 'Use cobblestone and make it one room.',
    forceAI: true,
    conversationContext: 'User: I want the bots to establish a safe base. Assistant: What material should the shelter use?'
  });

  assert.equal(result.state, 'ready');
  assert.equal(planParams.userText, 'Use cobblestone and make it one room.');
  assert.equal(planParams.forceAI, true);
  assert.match(planParams.compactContext.conversationContext, /Build a safe shelter near our base/);
  assert.match(planParams.compactContext.conversationContext, /What material should the shelter use/);
});

test('compact planner context preserves the latest instruction and bounds chat history', () => {
  const compact = buildCompactAiInput({
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    userText: 'Build the shelter we discussed from cobblestone',
    compactContext: { conversationContext: 'previous turn '.repeat(300), candidates: [] },
    maxInputBytes: 700
  });
  assert.ok(compact.byteLength <= 700);
  assert.equal(compact.dto.userObjective, 'Build the shelter we discussed from cobblestone');
  assert.ok(compact.dto.conversationContext.length <= 1200);
});
