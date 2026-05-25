export function evaluateDryHostileFixtureBaseline({
  water = null,
  onGround = null,
  health = null,
  state = 'NORMAL',
  hostiles = [],
  allowedStates = ['NORMAL'],
} = {}) {
  const hostileSummary = summarizeHostiles(hostiles);
  let reason = 'stable dry ground';
  let stop = false;
  if (health != null && health <= 4) {
    reason = `health reached critical threshold: ${health}`;
    stop = true;
  } else if (hostiles.length > 0) {
    reason = `nearby hostiles present before fixture wait: ${hostileSummary}`;
    stop = true;
  } else if (water) {
    reason = 'bot is still in or threatened by water';
  } else if (!allowedStates.includes(state)) {
    reason = `reactive state ${state} before fixture wait`;
  } else if (onGround !== true) {
    reason = 'bot is not on stable ground';
  }

  return {
    safe: reason === 'stable dry ground',
    reason,
    stop,
  };
}

export function summarizeHostiles(hostiles = []) {
  if (hostiles.length === 0) return 'none';
  return hostiles.map((entity) => `${entity.name}@${entity.distance}`).join(', ');
}
