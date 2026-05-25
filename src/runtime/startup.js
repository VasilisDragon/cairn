import log from '../logger.js';

export function installMainSpawnHandler(bot, handler, logger = log.startup) {
  const wrapped = async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      logger.fatal('main.spawn-handler-error', { err: errorMessage(err), stack: err?.stack });
    }
  };

  try {
    bot.once('spawn', wrapped);
    return { installed: true, handler: wrapped };
  } catch (err) {
    logger.error('main.spawn-listener-error', { err: errorMessage(err) });
    return { installed: false, handler: null };
  }
}

export function installProcessHandler(processTarget, eventName, handler, logger = log.startup) {
  try {
    processTarget.on(eventName, handler);
    return true;
  } catch (err) {
    logger.error('process.listener-error', { event: eventName, err: errorMessage(err) });
    return false;
  }
}

function errorMessage(err) {
  return err?.message || String(err);
}
