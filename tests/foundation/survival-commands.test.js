'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAutocompleteDictionary,
  getBrigadierCompletions,
  resolveUnifiedCommandExecution
} = require('../../src/commands/CommandCompleter');
const { parseExtendedZeroAiIntent } = require('../../src/commands/ZeroAiCommandDeck');
const { CombatAndSurvivalEngine } = require('../../src/combat/CombatAndSurvivalEngine');
const { isMatureCropBlock } = require('../../src/worker/BotRunner');
const { buildDeterministicPlan, validateTaskPlanV1 } = require('../../src/performance/AiEfficiencyController');

test('survival commands are discoverable and route to safe actions', () => {
  const dict = buildAutocompleteDictionary();
  for (const command of ['food', 'hunt', 'tree']) {
    assert.ok(dict.rootCommands.some((entry) => entry.name === command), `${command} is in command catalog`);
  }
  assert.ok(getBrigadierCompletions('food ', dict).suggestions.length > 0);
  assert.equal(resolveUnifiedCommandExecution('food').payload.mode, 'hunt_food');
  assert.equal(resolveUnifiedCommandExecution('hunt bot-01').payload.mode, 'hunt_mobs');
  assert.equal(resolveUnifiedCommandExecution('mobs bot-01').payload.mode, 'hunt_mobs', 'legacy mobs alias remains accepted but is not duplicated in suggestions');
  assert.ok(!dict.rootCommands.some((entry) => entry.name === 'mobs'));
  assert.deepEqual(resolveUnifiedCommandExecution('tree 24'), { type: 'task_intent', text: 'collect oak_log 24' });
});

test('gather commands preserve requested quantities and resolve generic ores, animal food, and crops', () => {
  for (const [text, resourceId, quantity] of [
    ['gather logs', 'minecraft:oak_log', 32],
    ['gather 47 logs', 'minecraft:oak_log', 47],
    ['gather stone', 'minecraft:cobblestone', 64],
    ['gather 23 stone', 'minecraft:cobblestone', 23],
    ['gather 16 food', 'minecraft:beef', 16],
    ['gather food', 'minecraft:beef', 32],
    ['harvest 19 crops', 'minecraft:wheat', 19],
    ['harvest food', 'minecraft:wheat', 32],
    ['harvest 9 carrots', 'minecraft:carrot', 9],
    ['food 12', 'minecraft:beef', 12]
  ]) {
    const plan = parseExtendedZeroAiIntent(text);
    assert.ok(plan, `${text} parses`);
    assert.equal(plan.objectives[0].target.resourceId, resourceId, text);
    assert.equal(plan.objectives[0].target.quantity, quantity, text);
    const routedPlan = buildDeterministicPlan(null, text);
    assert.equal(routedPlan.matched, true, `${text} uses deterministic fast path`);
    assert.equal(validateTaskPlanV1(routedPlan.plan).valid, true, `${text} produces a valid task plan`);
  }

  const orePlan = parseExtendedZeroAiIntent('gather 11 ores');
  assert.ok(orePlan, 'generic ores parse');
  assert.equal(orePlan.objectives.reduce((sum, objective) => sum + objective.target.quantity, 0), 11);
  assert.ok(orePlan.objectives.every((objective) => objective.kind === 'mine'));
  assert.equal(validateTaskPlanV1(orePlan).valid, true, 'generic ore fan-out is a valid conserved plan');
  assert.deepEqual(resolveUnifiedCommandExecution('gather food').type, 'task_intent');
  assert.deepEqual(resolveUnifiedCommandExecution('food 16').payload, {
    mode: 'hunt_food', targetCount: 16, botId: '*', preemptTask: true
  });
});

test('crop harvesting skips immature crops and permits ripe crops', () => {
  assert.equal(isMatureCropBlock({ name: 'wheat', getProperties: () => ({ age: 6 }) }), false);
  assert.equal(isMatureCropBlock({ name: 'wheat', getProperties: () => ({ age: 7 }) }), true);
  assert.equal(isMatureCropBlock({ name: 'beetroots', getProperties: () => ({ age: 3 }) }), true);
  assert.equal(isMatureCropBlock({ name: 'oak_log' }), true);
});

test('tree commands become deterministic log-gathering objectives', () => {
  for (const [command, quantity] of [['tree', 16], ['tree 24', 24], ['chop trees 32', 32]]) {
    const plan = parseExtendedZeroAiIntent(command);
    assert.ok(plan, `${command} should parse`);
    assert.equal(plan.objectives[0].kind, 'collect');
    assert.equal(plan.objectives[0].target.resourceId, 'minecraft:oak_log');
    assert.equal(plan.objectives[0].target.quantity, quantity);
  }
});

test('explicit food hunts back off when hurt and collect until the requested amount is reached', async () => {
  const engine = new CombatAndSurvivalEngine();
  const pos = { x: 0, y: 64, z: 0, distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); } };
  const hurtBot = { entity: { position: pos }, entities: {}, health: 7, inventory: { items: () => [] } };
  const result = await engine.huntForFoodIfNeeded(hurtBot, async () => {}, { force: true });
  assert.equal(result.reason, 'health_too_low_to_hunt');

  engine.setTacticalOrder({ mode: 'hunt_mobs' });
  const weakMobHunter = { ...hurtBot, food: 20, inventory: { items: () => [] } };
  const mobResult = await engine.tick(weakMobHunter, async () => {});
  assert.equal(mobResult.reason, 'health_too_low_to_hunt');

  engine.autoEquipBestGear = async () => {};
  engine.autoFeedIfNeeded = async () => false;
  let gained = 0;
  engine.huntForFoodIfNeeded = async () => ({ acted: true, foodCollected: 2, targetMob: 'cow' });
  engine.setTacticalOrder({ mode: 'hunt_food', targetCount: 3 });
  const fedBot = { entity: { position: pos }, entities: {}, health: 20, food: 20, inventory: { items: () => [] } };
  const first = await engine.tick(fedBot, async () => {});
  gained = first.foodCollected;
  assert.equal(gained, 2);
  assert.equal(engine.tacticalState.mode, 'hunt_food');
  const finished = await engine.tick(fedBot, async () => {});
  assert.equal(finished.reason, 'food_target_reached');
  assert.equal(finished.foodCollected, 4);
  assert.equal(engine.tacticalState.mode, 'idle');
});
