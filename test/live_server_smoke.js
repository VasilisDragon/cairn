import {
  liveSnapshot,
  runLiveScenario,
  waitForLiveChunks,
} from './live_helpers.js';

const ID = 'live_server_smoke';

runLiveScenario(ID, async ({ bot, finish }) => {
  await waitForLiveChunks(bot, ID);
  const snapshot = liveSnapshot(bot);
  if (!snapshot.position || snapshot.health == null || snapshot.food == null || !snapshot.position.dimension) {
    throw new Error('snapshot is missing position, health, food, or dimension');
  }
  finish(0, `${ID}.done`, { snapshot });
});
