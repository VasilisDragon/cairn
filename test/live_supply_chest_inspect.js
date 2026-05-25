import {
  closeLoggedChest,
  openAuthorizedSupplyChest,
  runLiveScenario,
  waitForLiveChunks,
} from './live_helpers.js';

const ID = 'live_supply_chest_inspect';

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.inspect`,
  };

  await waitForLiveChunks(bot, ID);
  const { container } = await openAuthorizedSupplyChest(bot, ctx, ID);
  const contents = container.containerItems();
  await closeLoggedChest(container, ID);
  finish(0, `${ID}.done`, {
    contents: contents
      .map((item) => ({ slot: item.slot, name: item.name, count: item.count }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.slot - b.slot),
  });
});
