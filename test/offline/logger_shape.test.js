import test from 'node:test';
import assert from 'node:assert/strict';

import log from '../../src/logger.js';

test('logger emits structured records with required base fields', () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };

  try {
    log.test.info('shape.sample', { field: 'value' });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(writes.length, 1);
  const record = JSON.parse(writes[0]);
  assert.equal(typeof record.t, 'string');
  assert.equal(record.lvl, 'info');
  assert.equal(record.loop, 'test');
  assert.equal(record.evt, 'shape.sample');
  assert.equal(record.field, 'value');
});
