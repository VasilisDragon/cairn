import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateDryHostileFixtureBaseline,
  summarizeHostiles,
} from '../live_hostile_fixture_status.js';

test('hostile fixture baseline accepts stable dry normal state with no hostiles', () => {
  assert.deepEqual(
    evaluateDryHostileFixtureBaseline({
      water: null,
      onGround: true,
      health: 20,
      state: 'NORMAL',
      hostiles: [],
    }),
    { safe: true, reason: 'stable dry ground', stop: false },
  );
});

test('hostile fixture baseline rejects nearby hostiles before manual fixture wait', () => {
  assert.deepEqual(
    evaluateDryHostileFixtureBaseline({
      water: null,
      onGround: true,
      health: 20,
      state: 'FLEEING',
      hostiles: [{ name: 'creeper', distance: 19.14 }],
    }),
    { safe: false, reason: 'nearby hostiles present before fixture wait: creeper@19.14', stop: true },
  );
});

test('hostile fixture baseline rejects non-normal reactive state even without visible hostiles', () => {
  assert.deepEqual(
    evaluateDryHostileFixtureBaseline({
      water: null,
      onGround: true,
      health: 20,
      state: 'FLEEING',
      hostiles: [],
    }),
    { safe: false, reason: 'reactive state FLEEING before fixture wait', stop: false },
  );
});

test('hostile fixture baseline can explicitly allow pre-controller staging', () => {
  assert.deepEqual(
    evaluateDryHostileFixtureBaseline({
      water: null,
      onGround: true,
      health: 20,
      state: 'NOT_STARTED',
      hostiles: [],
      allowedStates: ['NORMAL', 'NOT_STARTED'],
    }),
    { safe: true, reason: 'stable dry ground', stop: false },
  );
});

test('hostile fixture baseline keeps critical health as the highest-priority reason', () => {
  assert.deepEqual(
    evaluateDryHostileFixtureBaseline({
      water: { submerged: true },
      onGround: false,
      health: 4,
      state: 'WATER_ESCAPE',
      hostiles: [{ name: 'zombie', distance: 5 }],
    }),
    { safe: false, reason: 'health reached critical threshold: 4', stop: true },
  );
});

test('hostile summaries are stable and compact', () => {
  assert.equal(
    summarizeHostiles([
      { name: 'zombie', distance: 5 },
      { name: 'spider', distance: 12.5 },
    ]),
    'zombie@5, spider@12.5',
  );
  assert.equal(summarizeHostiles([]), 'none');
});
