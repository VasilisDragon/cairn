import log from '../logger.js';

export function installUserControlCommands(bot, opts = {}) {
  const logger = opts.logger || log.bot;
  const authorizedUsers = normalizeAuthorizedUsers(opts.authorizedUsers);
  logger.warn('user-command.disabled', {
    reason: 'chat identity is not an authenticated operator channel',
    authorizedUserCount: authorizedUsers.size,
  });
  return {
    installed: false,
    listener: null,
    authorizedUserCount: authorizedUsers.size,
    reason: 'chat identity is not an authenticated operator channel',
  };
}

export function normalizeAuthorizedUsers(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return new Set(values
    .map((value) => normalizeUsername(value))
    .filter(Boolean));
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export default {
  installUserControlCommands,
  normalizeAuthorizedUsers,
};
