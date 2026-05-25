import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseFishingPickupAction,
  compareFishingStandCandidates,
} from '../../src/skills/fishing_pickup_policy.js';

test('fishing pickup policy refuses water entry unless fallback is explicit', () => {
  assert.equal(chooseFishingPickupAction({
    waterTarget: true,
    dryPickupDistance: 5,
    dryPickupReach: 2.25,
    waterPickupFallback: false,
  }), 'wait-for-dry-pickup');

  assert.equal(chooseFishingPickupAction({
    waterTarget: true,
    dryPickupDistance: 5,
    dryPickupReach: 2.25,
    waterPickupFallback: true,
  }), 'water-fallback');
});

test('fishing pickup policy retries reachable dry-shore positions before direct pickup', () => {
  assert.equal(chooseFishingPickupAction({
    waterTarget: true,
    dryPickupDistance: 1.8,
    dryPickupReach: 2.25,
    dryPickupAttempts: 0,
    maxDryPickupAttempts: 3,
    waterPickupFallback: false,
  }), 'dry-stand');

  assert.equal(chooseFishingPickupAction({
    waterTarget: false,
    directDryPickupAttempted: false,
    dryPickupDistance: 9,
    dryPickupReach: 2.25,
    waterPickupFallback: false,
  }), 'direct-dry');
});

test('fishing pickup policy goes directly to dry-land drops instead of resetting to the stand', () => {
  assert.equal(chooseFishingPickupAction({
    waterTarget: false,
    directDryPickupAttempted: false,
    dryPickupDistance: 0.4,
    dryPickupReach: 2.25,
    dryPickupAttempts: 0,
    maxDryPickupAttempts: 3,
    waterPickupFallback: false,
  }), 'direct-dry');
});

test('fishing pickup policy uses dry intercepts for drifting water drops before water fallback', () => {
  assert.equal(chooseFishingPickupAction({
    waterTarget: true,
    dryPickupDistance: 3.5,
    dryPickupReach: 2.25,
    dryInterceptReach: 4.5,
    dryPickupAttempts: 0,
    maxDryPickupAttempts: 3,
    waterPickupFallback: false,
  }), 'dry-intercept');

  assert.equal(chooseFishingPickupAction({
    waterTarget: true,
    dryPickupDistance: 5,
    dryPickupReach: 2.25,
    dryInterceptReach: 4.5,
    dryPickupAttempts: 0,
    maxDryPickupAttempts: 3,
    waterPickupFallback: false,
  }), 'wait-for-dry-pickup');
});

test('fishing stand policy prefers dry landing room over the closest shore edge', () => {
  const edge = {
    verticalDistance: 0,
    horizontalDistance: 2,
    dryLandingScore: 2,
    distanceToBot: 1,
  };
  const inland = {
    verticalDistance: 0,
    horizontalDistance: 3,
    dryLandingScore: 9,
    distanceToBot: 4,
  };

  assert.equal(compareFishingStandCandidates(inland, edge, { preferredDistance: 3.25 }) < 0, true);
});

test('fishing stand policy prefers catch landing runway over dry area alone', () => {
  const broadEdge = {
    verticalDistance: 0,
    horizontalDistance: 3.25,
    dryLandingScore: 8,
    catchLandingScore: 8,
    distanceToBot: 1,
  };
  const runway = {
    verticalDistance: 0,
    horizontalDistance: 3.25,
    dryLandingScore: 6,
    catchLandingScore: 18,
    distanceToBot: 3,
  };

  assert.equal(compareFishingStandCandidates(runway, broadEdge, { preferredDistance: 3.25 }) < 0, true);
});
