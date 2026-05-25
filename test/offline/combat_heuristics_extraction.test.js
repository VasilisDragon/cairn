import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('carpet-pvp heuristic extraction stays prose-only and gitignored', () => {
  const doc = fs.readFileSync(new URL('../../docs/combat-heuristics-extracted.md', import.meta.url), 'utf8');
  const gitignore = fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');

  assert.match(doc, /prose-only/);
  assert.match(doc, /vendor\/decompiled\//);
  assert.match(doc, /no runtime dependency/);
  assert.match(doc, /No source code was copied/);
  assert.match(doc, /No packet-level swap/);
  assert.match(doc, /reach extension/);
  assert.match(doc, /anti-cheat bypass/);
  assert.match(doc, /private-server-only/);
  assert.match(gitignore, /^vendor\/decompiled\/$/m);
});
