// Tiny structured logger. JSON to stdout when not a TTY, pretty when TTY.
// Required event fields: t, lvl, loop, evt, plus event-specific fields.

import config from './config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const PRETTY = config.logging.pretty && process.stdout.isTTY;
const MIN_LEVEL = LEVELS[config.logging.level] ?? LEVELS.info;

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const LEVEL_COLOR = {
  trace: COLOR.dim,
  debug: COLOR.dim,
  info: COLOR.green,
  warn: COLOR.yellow,
  error: COLOR.red,
  fatal: COLOR.red + COLOR.bold,
};

const LOOP_COLOR = {
  reactive: COLOR.red,
  executor: COLOR.cyan,
  advisor: COLOR.magenta,
  bot: COLOR.blue,
  startup: COLOR.dim,
  test: COLOR.yellow,
};

function fmtPretty(rec) {
  const lvlC = LEVEL_COLOR[rec.lvl] || '';
  const loopC = LOOP_COLOR[rec.loop] || COLOR.dim;
  const { t, lvl, loop, evt, msg, ...rest } = rec;
  const time = t.slice(11, 23);
  let line = `${COLOR.dim}${time}${COLOR.reset} ${lvlC}${lvl.toUpperCase().padEnd(5)}${COLOR.reset} ${loopC}[${loop}]${COLOR.reset} ${COLOR.bold}${evt}${COLOR.reset}`;
  if (msg) line += ` ${msg}`;
  const keys = Object.keys(rest);
  if (keys.length) {
    line += ` ${COLOR.dim}${JSON.stringify(rest)}${COLOR.reset}`;
  }
  return line;
}

function emit(loop, lvl, evt, fields) {
  if ((LEVELS[lvl] ?? 0) < MIN_LEVEL) return;
  const rec = {
    t: new Date().toISOString(),
    lvl,
    loop,
    evt,
    ...fields,
  };
  if (PRETTY) {
    const stream = LEVELS[lvl] >= LEVELS.error ? process.stderr : process.stdout;
    stream.write(fmtPretty(rec) + '\n');
  } else {
    const stream = LEVELS[lvl] >= LEVELS.error ? process.stderr : process.stdout;
    stream.write(JSON.stringify(rec) + '\n');
  }
}

export function loopLogger(loop) {
  return {
    trace: (evt, fields = {}) => emit(loop, 'trace', evt, fields),
    debug: (evt, fields = {}) => emit(loop, 'debug', evt, fields),
    info: (evt, fields = {}) => emit(loop, 'info', evt, fields),
    warn: (evt, fields = {}) => emit(loop, 'warn', evt, fields),
    error: (evt, fields = {}) => emit(loop, 'error', evt, fields),
    fatal: (evt, fields = {}) => emit(loop, 'fatal', evt, fields),
  };
}

export const log = {
  startup: loopLogger('startup'),
  bot: loopLogger('bot'),
  reactive: loopLogger('reactive'),
  executor: loopLogger('executor'),
  advisor: loopLogger('advisor'),
  test: loopLogger('test'),
};

export default log;
