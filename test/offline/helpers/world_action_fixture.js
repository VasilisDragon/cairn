import {
  createWorldActionAuthorization,
  deriveServerWorldIdentity,
  observeServerWorldIdentity,
  WORLD_ACTION_MODE,
} from '../../../src/state/world_action_authorization.js';

export const FIXTURE_WORLD_PACKET = Object.freeze({
  worldState: Object.freeze({ hashedSeed: Object.freeze([0x13572468, -0x24681357]) }),
});
export const FIXTURE_WORLD_IDENTITY = deriveServerWorldIdentity(FIXTURE_WORLD_PACKET);

export function disposableWorldActionFixture() {
  return createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    sessionIdentity: 'offline-fixture-session',
    freshWorldIdentity: FIXTURE_WORLD_IDENTITY,
    createdFreshWorld: true,
    singlePlayer: true,
  });
}

export function addDisposableWorldFixtureBotState(bot, username = 'MCBot') {
  bot.username = username;
  bot.players = { [username]: { username } };
  const observed = observeServerWorldIdentity(bot, {}, FIXTURE_WORLD_PACKET, 'offline-fixture-login');
  if (!observed.ok) throw new Error(`offline world identity fixture failed: ${observed.reason}`);
  return bot;
}
