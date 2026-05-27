import test from 'node:test';
import assert from 'node:assert/strict';

import { validateItemChainPlanProgress } from '../../src/advisor/item_goal.js';

test('item-chain validation requires composer optionalCrafts for diamond pickaxe from empty inventory', () => {
  const result = validateItemChainPlanProgress(
    'make a diamond pickaxe',
    [{ skill: 'craft', params: { item: 'diamond_pickaxe', count: 1 } }],
    { snapshot: { inventory: [] }, goal: 'make a diamond pickaxe' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
  assert.match(result.reason, /requires mine_with_progression/);
  assert.match(result.reason, /optionalCrafts including diamond_pickaxe/);
});

test('item-chain validation accepts diamond composer carrying the final craft', () => {
  const result = validateItemChainPlanProgress(
    'make a diamond pickaxe',
    [{
      skill: 'mine_with_progression',
      params: { ores: ['diamond_ore'], count: 3, optionalCrafts: ['diamond_pickaxe'] },
    }],
    { snapshot: { inventory: [] }, goal: 'make a diamond pickaxe' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.progressIndex, 0);
});

test('item-chain validation allows direct craft when known ingredients are already present', () => {
  const result = validateItemChainPlanProgress(
    'make a diamond pickaxe',
    [{ skill: 'craft', params: { item: 'diamond_pickaxe', count: 1 } }],
    {
      snapshot: { inventory: [{ name: 'diamond', count: 3 }, { name: 'stick', count: 2 }] },
      goal: 'make a diamond pickaxe',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.progressIndex, 0);
});
