#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ALLOWED = path.normalize('src/control/pathfinder.js');
const SCAN_DIRS = ['src', 'test', 'scripts'];
const WRITE_RE = /\b(?:bot|this\.bot)\.pathfinder\.(setGoal|setMovements|stop)\s*\(/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.normalize(path.relative(ROOT, file));
    if (rel === ALLOWED) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      WRITE_RE.lastIndex = 0;
      if (WRITE_RE.test(lines[i])) {
        findings.push({
          file: rel.replaceAll(path.sep, '/'),
          line: i + 1,
          text: trimmed,
        });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write('Forbidden direct pathfinder writes found outside src/control/pathfinder.js:\n');
  for (const f of findings) {
    process.stderr.write(`- ${f.file}:${f.line}: ${f.text}\n`);
  }
  process.exit(1);
}

process.stdout.write('pathfinder-write-grep: ok (writes confined to src/control/pathfinder.js)\n');
