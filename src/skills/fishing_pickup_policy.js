export function compareFishingStandCandidates(a, b, opts = {}) {
  const preferredDistance = finiteNumber(opts.preferredDistance, 3.25);
  const aKey = fishingStandSortKey(a, preferredDistance);
  const bKey = fishingStandSortKey(b, preferredDistance);
  for (let i = 0; i < aKey.length; i += 1) {
    if (aKey[i] !== bKey[i]) return aKey[i] - bKey[i];
  }
  return 0;
}

export function chooseFishingPickupAction(opts = {}) {
  const dryPickupDistance = finiteNumber(opts.dryPickupDistance, Number.POSITIVE_INFINITY);
  const dryPickupReach = finiteNumber(opts.dryPickupReach, 2.25);
  const dryInterceptReach = finiteNumber(opts.dryInterceptReach, dryPickupReach);
  const dryPickupAttempts = finiteNumber(opts.dryPickupAttempts, 0);
  const maxDryPickupAttempts = finiteNumber(opts.maxDryPickupAttempts, 3);
  const waterTarget = opts.waterTarget === true;
  const directDryPickupAttempted = opts.directDryPickupAttempted === true;
  const waterPickupFallback = opts.waterPickupFallback === true;

  if (!waterTarget && !directDryPickupAttempted) return 'direct-dry';
  if (dryPickupDistance <= dryPickupReach && dryPickupAttempts < maxDryPickupAttempts) {
    return 'dry-stand';
  }
  if (waterTarget && dryPickupDistance <= dryInterceptReach && dryPickupAttempts < maxDryPickupAttempts) {
    return 'dry-intercept';
  }
  if (waterTarget && waterPickupFallback) return 'water-fallback';
  return 'wait-for-dry-pickup';
}

function fishingStandSortKey(candidate, preferredDistance) {
  const verticalDistance = finiteNumber(candidate?.verticalDistance, Number.POSITIVE_INFINITY);
  const dryLandingScore = finiteNumber(candidate?.dryLandingScore, 0);
  const catchLandingScore = finiteNumber(candidate?.catchLandingScore, dryLandingScore);
  const horizontalDistance = finiteNumber(candidate?.horizontalDistance, Number.POSITIVE_INFINITY);
  const preferredPenalty = Math.abs(horizontalDistance - preferredDistance);
  const distanceToBot = finiteNumber(candidate?.distanceToBot, Number.POSITIVE_INFINITY);
  return [
    verticalDistance,
    -catchLandingScore,
    -dryLandingScore,
    preferredPenalty,
    distanceToBot,
    horizontalDistance,
  ];
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
