'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAutocompleteDictionary,
  getBrigadierCompletions,
  resolveUnifiedCommandExecution
} = require('../../src/commands/CommandCompleter');
const { CombatAndSurvivalEngine } = require('../../src/combat/CombatAndSurvivalEngine');

test('goto coordinates parse as a bounded tactical order and autocomplete the optional bot', () => {
  const action = resolveUnifiedCommandExecution('goto -120.5 72 345 bot-02');
  assert.equal(action.type, 'player_action');
  assert.deepEqual(action.payload, {
    mode: 'goto',
    targetPosition: { x: -120.5, y: 72, z: 345 },
    botId: 'bot-02',
    preemptTask: true
  });
  assert.deepEqual(resolveUnifiedCommandExecution('go 10 64 -20'), {
    type: 'player_action',
    payload: {
      mode: 'goto',
      targetPosition: { x: 10, y: 64, z: -20 },
      botId: '*',
      preemptTask: true
    }
  });
  assert.equal(resolveUnifiedCommandExecution('goto 1 9999 3').type, 'invalid_command');
  assert.equal(resolveUnifiedCommandExecution('goto NaN 64 3').type, 'invalid_command');

  const dict = buildAutocompleteDictionary({ bots: ['bot-01'] });
  assert.ok(dict.rootCommands.some((command) => command.name === 'goto'));
  assert.deepEqual(
    getBrigadierCompletions('goto 10 64 20 ', dict).suggestions.map((entry) => entry.token),
    ['*', 'bot-01']
  );
});

test('navigation tactical mode sets a path goal, then clears the order on arrival', async () => {
  const engine = new CombatAndSurvivalEngine();
  let current = { x: 0, y: 64, z: 0 };
  const position = {
    get x() { return current.x; },
    get y() { return current.y; },
    get z() { return current.z; },
    distanceTo(other) { return Math.hypot(current.x - other.x, current.y - other.y, current.z - other.z); }
  };
  const bot = {
    entity: { position },
    inventory: { items: () => [] },
    health: 20,
    food: 20
  };
  const goals = [];
  const setGoal = (target, range) => { goals.push(target ? { ...target, range } : null); return true; };

  engine.setTacticalOrder({ mode: 'goto', targetPosition: { x: 12, y: 64, z: -4 } });
  const navigating = await engine.tick(bot, async () => false, setGoal);
  assert.equal(navigating.mode, 'goto');
  assert.deepEqual(goals[0], { x: 12, y: 64, z: -4, range: 1.25 });

  current = { x: 11, y: 64, z: -4 };
  const arrived = await engine.tick(bot, async () => false, setGoal);
  assert.equal(arrived.arrived, true);
  assert.equal(engine.tacticalState.mode, 'idle');
  assert.equal(goals.at(-1), null);
});
