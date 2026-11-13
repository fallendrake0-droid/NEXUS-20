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

test('tree commands become deterministic log-gathering objectives', () => {
  for (const [command, quantity] of [['tree', 16], ['tree 24', 24], ['chop trees 32', 32]]) {
    const plan = parseExtendedZeroAiIntent(command);
    assert.ok(plan, `${command} should parse`);
    assert.equal(plan.objectives[0].kind, 'collect');
    assert.equal(plan.objectives[0].target.resourceId, 'minecraft:oak_log');
    assert.equal(plan.objectives[0].target.quantity, quantity);
  }
});

test('explicit food hunts back off at dangerously low health and end once food is secured', async () => {
  const engine = new CombatAndSurvivalEngine();
  const pos = { x: 0, y: 64, z: 0, distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); } };
  const hurtBot = { entity: { position: pos }, entities: {}, health: 7, inventory: { items: () => [] } };
  const result = await engine.huntForFoodIfNeeded(hurtBot, async () => {}, { force: true });
  assert.equal(result.reason, 'health_too_low_to_hunt');

  engine.setTacticalOrder({ mode: 'hunt_mobs' });
  const weakMobHunter = { ...hurtBot, food: 20, inventory: { items: () => [] } };
  const mobResult = await engine.tick(weakMobHunter, async () => {});
  assert.equal(mobResult.reason, 'health_too_low_to_hunt');

  engine.setTacticalOrder({ mode: 'hunt_food' });
  const fedBot = {
    entity: { position: pos }, entities: {}, health: 20, food: 20,
    inventory: { items: () => [{ name: 'beef', count: 2 }] }
  };
  const finished = await engine.tick(fedBot, async () => {});
  assert.equal(finished.reason, 'food_available');
  assert.equal(engine.tacticalState.mode, 'idle');
});
