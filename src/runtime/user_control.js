import log from '../logger.js';

const DEFAULT_LOGOUT_COMMAND = '!logout';

export function installUserControlCommands(bot, opts = {}) {
  const logger = opts.logger || log.bot;
  const logoutCommand = normalizeCommand(opts.logoutCommand || DEFAULT_LOGOUT_COMMAND);
  const authorizedUsers = normalizeAuthorizedUsers(opts.authorizedUsers);
  const shutdown = typeof opts.shutdown === 'function' ? opts.shutdown : null;

  const listener = (username, message) => {
    const command = normalizeCommand(message);
    if (command !== logoutCommand) return;

    const normalizedUser = normalizeUsername(username);
    if (!authorizedUsers.has(normalizedUser)) {
      logger.warn('user-command.logout-rejected', {
        username,
        reason: authorizedUsers.size > 0 ? 'unauthorized-user' : 'no-authorized-users-configured',
      });
      return;
    }

    logger.warn('user-command.logout-accepted', { username, command: logoutCommand });
    if (!shutdown) {
      logger.error('user-command.logout-failed', { username, reason: 'shutdown unavailable' });
      return;
    }
    shutdown(`chat:${logoutCommand}:${username}`);
  };

  try {
    bot.on('chat', listener);
  } catch (err) {
    logger.error('user-command.listener-error', { event: 'chat', err: errorMessage(err) });
    return { installed: false, listener: null, authorizedUserCount: authorizedUsers.size };
  }

  logger.info('user-command.installed', {
    logoutCommand,
    authorizedUserCount: authorizedUsers.size,
  });
  return { installed: true, listener, authorizedUserCount: authorizedUsers.size };
}

export function normalizeAuthorizedUsers(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return new Set(values
    .map((value) => normalizeUsername(value))
    .filter(Boolean));
}

function normalizeCommand(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function errorMessage(err) {
  return err?.message || String(err);
}

export default {
  installUserControlCommands,
  normalizeAuthorizedUsers,
};
