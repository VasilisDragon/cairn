import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const HUMANIZER_FILE = normalizeRel('src/behavior_shaping/humanizer.js');
const ACTION_CALL_RE = /\b(?:bot|this\.bot)\.(lookAt|placeBlock|activateBlock|equip|activateItem|deactivateItem|consume|setControlState|dig)\s*\(|\b(?:bot|this\.bot)\.collectBlock\.collect\s*\(|\b(?:bot|this\.bot)\.pvp\.attack\s*\(/g;
const HUMANIZER_CONTEXT_RE = /\bhumanizer\b/;
const CONTEXT_RADIUS_LINES = 8;

test('runtime Mineflayer action calls stay paired with the humanization boundary', () => {
  const findings = [];
  for (const file of walkJs(SRC_DIR)) {
    const rel = normalizeRel(path.relative(ROOT, file));
    if (rel === HUMANIZER_FILE) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isCommentOnly(line)) continue;
      ACTION_CALL_RE.lastIndex = 0;
      if (!ACTION_CALL_RE.test(line)) continue;
      if (hasHumanizerContext(lines, index)) continue;
      findings.push(`${rel}:${index + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(findings, []);
});

function hasHumanizerContext(lines, index) {
  const start = Math.max(0, index - CONTEXT_RADIUS_LINES);
  const end = Math.min(lines.length - 1, index + 2);
  for (let i = start; i <= end; i += 1) {
    if (HUMANIZER_CONTEXT_RE.test(lines[i])) return true;
  }
  return false;
}

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function isCommentOnly(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function normalizeRel(file) {
  return file.replaceAll('\\', '/');
}
