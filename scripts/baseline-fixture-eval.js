#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BASELINE_FIXTURE_PATHS } from './baseline-runner.js';

const ROOT = process.cwd();
const JSON_REPORT_NAME = 'baseline-fixture-eval.json';
const MD_REPORT_NAME = 'baseline-fixture-eval.md';

export function evaluateBaselineFixtureSet(fixtureRoot, repositoryRoot = ROOT) {
  const realRepository = fs.realpathSync(repositoryRoot);
  const realFixtureRoot = requirePlainDirectory(fixtureRoot, 'fixture root');
  if (pathInside(realRepository, realFixtureRoot)) {
    throw new Error('fixture root must be outside the checkout');
  }
  requireExactFixtureInventory(realFixtureRoot);

  const loaded = new Map(BASELINE_FIXTURE_PATHS.map((relativePath) => [
    relativePath,
    readFixture(realFixtureRoot, relativePath),
  ]));
  const validators = new Map([
    [BASELINE_FIXTURE_PATHS[0], validateAdvisorCorpus],
  ]);
  const semantics = new Map(BASELINE_FIXTURE_PATHS.map((relativePath) => {
    const validate = validators.get(relativePath);
    if (typeof validate !== 'function') {
      throw new Error('pinned fixture is missing a semantic validator');
    }
    return [relativePath, validate(loaded.get(relativePath).value)];
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    noApiCall: true,
    status: 'staged_fixture_set_validated',
    inputBoundary: {
      fixtureRoot: realFixtureRoot,
      checkoutReportsReadable: false,
      sourceReportRead: false,
    },
    fixtures: BASELINE_FIXTURE_PATHS.map((relativePath) => {
      const entry = loaded.get(relativePath);
      const semantic = semantics.get(relativePath);
      return {
        path: relativePath,
        sha256: entry.sha256,
        semanticSha256: semantic.semanticSha256,
        recordCount: semantic.recordCount,
        materiallyConsumed: true,
      };
    }),
    linkage: {
      sourceReportRead: false,
      stagedFixtureCount: BASELINE_FIXTURE_PATHS.length,
      materiallyConsumedCount: semantics.size,
      exactFixtureCoverage: semantics.size === BASELINE_FIXTURE_PATHS.length,
    },
  };
}

export function renderBaselineFixtureEvaluation(report) {
  const lines = [
    '# Baseline Fixture Evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `No API call: ${report.noApiCall === true ? 'yes' : 'unknown'}`,
    `Checkout reports readable: ${report.inputBoundary.checkoutReportsReadable === true ? 'yes' : 'no'}`,
    `Promotion source report read: ${report.inputBoundary.sourceReportRead === true ? 'yes' : 'no'}`,
    '',
    '## Materially Consumed Fixtures',
    '',
    '| Fixture | SHA-256 | Semantic SHA-256 | Records |',
    '| --- | --- | --- | ---: |',
  ];
  for (const fixture of report.fixtures) {
    lines.push(`| ${fixture.path} | \`${fixture.sha256}\` | \`${fixture.semanticSha256}\` | ${fixture.recordCount} |`);
  }
  lines.push(
    '',
    '## Fixture Coverage',
    '',
    `- staged fixtures: ${report.linkage.stagedFixtureCount}`,
    `- materially consumed fixtures: ${report.linkage.materiallyConsumedCount}`,
    `- exact fixture coverage: ${report.linkage.exactFixtureCoverage ? 'yes' : 'no'}`,
    '- checkout source report followed: no',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function validateAdvisorCorpus(value) {
  requireObject(value, 'advisor corpus');
  if (value.schemaVersion !== 1 || !Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    throw new Error('advisor corpus schema is invalid');
  }
  const ids = new Set();
  for (const fixture of value.fixtures) {
    requireObject(fixture, 'advisor fixture');
    requireUniqueString(fixture.id, ids, 'advisor fixture id');
    requireNonEmptyString(fixture.category, 'advisor fixture category');
    requireNonEmptyString(fixture.goal, 'advisor fixture goal');
    requireObject(fixture.snapshot, 'advisor fixture snapshot');
    requireObject(fixture.response, 'advisor fixture expected plan');
    requireObject(fixture.expected, 'advisor fixture expectation');
  }
  return {
    recordCount: value.fixtures.length,
    semanticSha256: semanticHash({
      schemaVersion: value.schemaVersion,
      fixtures: value.fixtures,
    }),
  };
}

function readFixture(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staged fixture is not a regular file');
  const realPath = fs.realpathSync(absolutePath);
  if (!pathInside(root, realPath)) throw new Error('staged fixture resolves outside the fixture root');
  const bytes = fs.readFileSync(realPath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('staged fixture is not valid JSON');
  }
  return { value, sha256: sha256(bytes) };
}

function requireExactFixtureInventory(root) {
  const actual = listPlainFiles(root)
    .map((filePath) => slashPath(path.relative(root, filePath)))
    .sort();
  const expected = [...BASELINE_FIXTURE_PATHS].sort();
  if (actual.length !== expected.length
    || actual.some((relativePath, index) => relativePath !== expected[index])) {
    throw new Error('fixture root does not contain exactly the pinned fixture set');
  }
}

function listPlainFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('fixture root contains a reparse link');
      if (stat.isDirectory()) stack.push(target);
      else if (stat.isFile()) files.push(target);
      else throw new Error('fixture root contains a non-regular entry');
    }
  }
  return files;
}

function requirePlainDirectory(directoryPath, label) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  return fs.realpathSync(directoryPath);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is invalid`);
}

function requireUniqueString(value, seen, label) {
  requireNonEmptyString(value, label);
  if (seen.has(value)) throw new Error(`${label} is duplicated`);
  seen.add(value);
}

function semanticHash(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slashPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : '';
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseArgs(argv) {
  const out = { fixtureRoot: null, reportRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture-root') out.fixtureRoot = requireArgValue(argv, ++index);
    else if (arg === '--report-root') out.reportRoot = requireArgValue(argv, ++index);
    else throw new Error('unknown argument');
  }
  if (!out.fixtureRoot || !out.reportRoot) throw new Error('explicit fixture and report roots are required');
  return out;
}

function requireArgValue(argv, index) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error('missing argument value');
  return path.resolve(value);
}

function main() {
  try {
    if (process.env.MCBOT_BASELINE !== '1') throw new Error('baseline marker is required');
    const args = parseArgs(process.argv.slice(2));
    const fixtureRoot = requirePlainDirectory(args.fixtureRoot, 'fixture root');
    const reportRoot = requirePlainDirectory(args.reportRoot, 'report root');
    const realRepository = fs.realpathSync(ROOT);
    if (pathInside(realRepository, fixtureRoot) || pathInside(realRepository, reportRoot)) {
      throw new Error('fixture and report roots must be outside the checkout');
    }
    if (pathInside(fixtureRoot, reportRoot) || pathInside(reportRoot, fixtureRoot)) {
      throw new Error('fixture and report roots must be separate');
    }
    if (fs.readdirSync(reportRoot).length !== 0) {
      throw new Error('report root must be initially empty');
    }
    const report = evaluateBaselineFixtureSet(fixtureRoot, realRepository);
    report.inputBoundary.reportRoot = reportRoot;
    fs.writeFileSync(path.join(reportRoot, JSON_REPORT_NAME), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(path.join(reportRoot, MD_REPORT_NAME), renderBaselineFixtureEvaluation(report), { flag: 'wx' });
    process.stdout.write(`baseline-fixture-eval: wrote ${JSON_REPORT_NAME} and ${MD_REPORT_NAME}\n`);
  } catch {
    process.stderr.write('baseline-fixture-eval: validation failed\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
