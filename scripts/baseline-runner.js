import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import {
  acquireOrJoinResourceLockSync,
  applyLowImpactNodeScheduling,
  getProcessStartIdentity,
  RESOURCE_LOCK_ENV,
} from './resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';

export const BASELINE_FLOORS = Object.freeze({
  checkedJavaScriptFiles: 283,
  rootOfflineFiles: 118,
  // Cairn intentionally omits the private operational harness and its tests.
  // These floors pin the complete public port so later removals fail closed.
  rootOfflineTests: 1344,
  fabricBrainTests: 440,
  fabricJUnitTests: 1811,
  paperJUnitTests: 16,
  paperPluginJars: 1,
});

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_METRIC_CAPTURE_BYTES = 64 * 1024 * 1024;
const STEP_TIMEOUT_MS = 60 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 10 * 1000;
const TOOL_PROBE_WRAPPER_TIMEOUT_MS = 30 * 1000;
const GIT_QUERY_TIMEOUT_MS = 30 * 1000;
const GIT_WORKTREE_TIMEOUT_MS = 60 * 1000;
const GIT_WRAPPER_GRACE_MS = 15 * 1000;
// The relay's shared 8 MiB limit leaves bounded headroom for the registered
// PowerShell wrapper's diagnostics under Node's per-stream 16 MiB maxBuffer.
const MAX_TOOL_PROBE_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_PROBE_RELAY_CAPTURE_BYTES = 8 * 1024 * 1024;
const CANONICAL_NODE_PROBE_OPTIONS = '--v8-pool-size=1';
const CANONICAL_JAVA_TOOL_OPTIONS = '-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -XX:CICompilerCount=2 -Djava.util.concurrent.ForkJoinPool.common.parallelism=1';
const FIXTURE_MANIFEST = path.join('config', 'baseline-fixtures.json');
const LOW_IMPACT_TOOL_PROBE = path.join('scripts', 'run-tool-probe-low-impact.ps1');
export const BASELINE_FIXTURE_PATHS = Object.freeze([
  'data/advisor-dry-run/recorded-core.json',
]);
const NETWORK_GUARD = path.join('scripts', 'baseline-network-guard.cjs');
const DETERMINISTIC_REPORT_OUTPUTS = Object.freeze([
  'reports/deterministic-eval.json',
  'reports/deterministic-eval.md',
  'reports/phase-shift-readiness.json',
  'reports/phase-shift-readiness.md',
]);
const DETERMINISTIC_REPORT_MUTATION_ALLOWLIST = Object.freeze([
  ...DETERMINISTIC_REPORT_OUTPUTS,
  'reports/baseline-fixture-eval.json',
  'reports/baseline-fixture-eval.md',
  'reports/advisor-dry-run.json',
  'reports/advisor-dry-run.md',
  'reports/advisor-first-call.json',
  'reports/advisor-first-call.md',
  'reports/advisor-first-call-replay.json',
  'reports/advisor-first-call-replay.md',
  'reports/capability-matrix.json',
  'reports/capability-matrix.md',
]);
const CAPTURE_GUARD_REPORT_OUTPUTS = Object.freeze([
  'reports/advisor-response-capture-guard.json',
  'reports/advisor-response-capture-guard.md',
]);
const EVIDENCE_TARGETS = Object.freeze([
  { source: 'reports/baseline-fixture-eval.json', destination: 'deterministic/baseline-fixture-eval.json', producer: 'deterministic-eval' },
  { source: 'reports/baseline-fixture-eval.md', destination: 'deterministic/baseline-fixture-eval.md', producer: 'deterministic-eval' },
  { source: 'reports/deterministic-eval.json', destination: 'deterministic/deterministic-eval.json', producer: 'deterministic-eval' },
  { source: 'reports/deterministic-eval.md', destination: 'deterministic/deterministic-eval.md', producer: 'deterministic-eval' },
  { source: 'reports/phase-shift-readiness.json', destination: 'deterministic/phase-shift-readiness.json', producer: 'deterministic-eval' },
  { source: 'reports/phase-shift-readiness.md', destination: 'deterministic/phase-shift-readiness.md', producer: 'deterministic-eval' },
  { source: 'reports/advisor-response-capture-guard.json', destination: 'deterministic/advisor-response-capture-guard.json', producer: 'response-capture-final' },
  { source: 'reports/advisor-response-capture-guard.md', destination: 'deterministic/advisor-response-capture-guard.md', producer: 'response-capture-final' },
  { source: 'fabric-client/build/test-results/test', destination: 'junit/fabric', producer: 'fabric-junit' },
  { source: 'test-harness-plugin/build/test-results/test', destination: 'junit/paper', producer: 'paper-test-build' },
]);

const REPRODUCIBILITY_ENV = new Set([
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'JAVA_OPTS',
  'GRADLE_OPTS',
]);

const PROVIDER_OR_LIVE_ENV = [
  // No caller-supplied MCBOT switch is reproducible. The runner adds its one
  // internal MCBOT_BASELINE marker only after this inventory has passed.
  /^MCBOT_/i,
  /^(?:DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|COHERE|GROQ|MISTRAL|OLLAMA|OPENROUTER|PERPLEXITY|TOGETHER|RCON)_/i,
  /^(?:AZURE_OPENAI|AWS_BEDROCK|GOOGLE_GENERATIVE_AI|VERTEX_AI)_/i,
  /(?:^|_)(?:API(?:_KEY|_TOKEN|_URL|_BASE|_BASE_URL|_ENDPOINT)?|RCON(?:_HOST|_PORT|_PASSWORD)?|PROVIDER(?:_URL|_ENDPOINT)?|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CLIENT_SECRET|CONNECTION_STRING)$/i,
  /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS)$/i,
];

export function parseBaselineArgs(argv) {
  let outputRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-root') {
      outputRoot = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--output-root=')) {
      outputRoot = arg.slice('--output-root='.length);
    } else {
      throw new Error(`unknown baseline argument: ${arg}`);
    }
  }
  if (!outputRoot) {
    throw new Error('usage: npm run test:baseline -- --output-root <external-directory>');
  }
  return { outputRoot };
}

export function isSensitiveBaselineEnvironmentName(name) {
  const normalized = String(name || '').toUpperCase();
  return REPRODUCIBILITY_ENV.has(normalized)
    || PROVIDER_OR_LIVE_ENV.some((pattern) => pattern.test(name));
}

export function findArmedBaselineEnvironment(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => isSensitiveBaselineEnvironmentName(name)
      && typeof value === 'string'
      && value.trim() !== '')
    .map(([name]) => name)
    .sort();
}

export function parseJavaMajor(output) {
  const text = String(output || '');
  const match = text.match(/(?:java|openjdk|javac|jar)(?:\s+version)?\s+"?(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const first = Number(match[1]);
  return first === 1 ? Number(match[2]) : first;
}

export function parseNodeTestSummary(output) {
  const result = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, suites: 0 };
  const keys = {
    tests: /^# tests (\d+)$/gm,
    passed: /^# pass (\d+)$/gm,
    failed: /^# fail (\d+)$/gm,
    skipped: /^# skipped (\d+)$/gm,
    cancelled: /^# cancelled (\d+)$/gm,
    todo: /^# todo (\d+)$/gm,
    suites: /^# suites (\d+)$/gm,
  };
  for (const [key, expression] of Object.entries(keys)) {
    for (const match of String(output || '').matchAll(expression)) result[key] += Number(match[1]);
  }
  return result;
}

export function parseCheckedJavaScriptCount(output) {
  const match = String(output || '').match(/check-js: ok \((\d+) files checked\)/);
  return match ? Number(match[1]) : null;
}

export function rootOfflineMetricsPass(metrics, floors = BASELINE_FLOORS) {
  return Number(metrics?.files) >= floors.rootOfflineFiles
    && Number(metrics?.tests) >= floors.rootOfflineTests
    && Number(metrics?.passed) === Number(metrics?.tests)
    && Number(metrics?.failed) === 0
    && Number(metrics?.skipped) === 0
    && Number(metrics?.cancelled) === 0
    && Number(metrics?.todo) === 0;
}

export function resolveGradleInvocation(projectRoot, platform = process.platform) {
  const windows = platform === 'win32';
  const wrapper = path.join(projectRoot, windows ? 'gradlew.bat' : 'gradlew');
  return windows
    ? {
      executable: process.env.ComSpec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', 'gradlew.bat'],
      shell: false,
      wrapper,
    }
    : { executable: 'bash', prefixArgs: [wrapper], shell: false, wrapper };
}

export function resolveLowImpactGradleInvocation(workspaceRoot, project, options = {}) {
  if (!['fabric-client', 'test-harness-plugin'].includes(project)) {
    throw new Error(`unsupported low-impact Gradle project: ${project}`);
  }
  const script = path.join(workspaceRoot, 'scripts', 'run-gradle-low-impact.ps1');
  if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`low-impact Gradle launcher is missing: ${script}`);
  }
  return {
    executable: options.pwshExecutable || 'pwsh',
    prefixArgs: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Project',
      project,
    ],
    shell: false,
  };
}

export function buildBaselineCommandPlan(workspaceRoot, options = {}) {
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const platform = options.platform || process.platform;
  if (typeof options.fixtureRoot !== 'string' || !options.fixtureRoot
    || typeof options.reportRoot !== 'string' || !options.reportRoot) {
    throw new Error('baseline command plan requires staged fixture and generated-report roots');
  }
  const fixtureRoot = path.resolve(options.fixtureRoot);
  const reportRoot = path.resolve(options.reportRoot);
  const npm = options.npmInvocation || resolveTrustedNpmInvocation({ nodeExecutable, platform });
  const brainRoot = path.join(workspaceRoot, 'fabric-client', 'brain');
  const brainTests = fs.readdirSync(brainRoot)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('fabric-client', 'brain', name));
  const brainSmokes = fs.readdirSync(brainRoot)
    .filter((name) => name.endsWith('.smoke.mjs'))
    .sort()
    .map((name) => path.join('fabric-client', 'brain', name));
  const fabricGradle = resolveLowImpactGradleInvocation(workspaceRoot, 'fabric-client', options);
  const paperGradle = resolveLowImpactGradleInvocation(workspaceRoot, 'test-harness-plugin', options);

  return [
    command('dependency-install', npm.executable, [
      ...npm.prefixArgs,
      'ci',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ]),
    command('check', nodeExecutable, ['scripts/check-js.js']),
    command('root-offline', nodeExecutable, ['scripts/run-offline-tests.js']),
    command('pathfinder-guard', nodeExecutable, ['scripts/check-pathfinder-writes.js']),
    command('deterministic-eval', nodeExecutable, [
      'scripts/deterministic-eval.js',
      '--baseline',
      '--fixture-root',
      fixtureRoot,
      '--report-root',
      reportRoot,
    ]),
    command('response-capture-final', nodeExecutable, [
      'scripts/advisor-response-capture-guard.js',
      '--baseline-fixture-root',
      fixtureRoot,
      '--report-root',
      reportRoot,
    ]),
    command('fabric-brain-tests', nodeExecutable, [
      'scripts/run-fabric-brain-tests.js',
    ], { files: brainTests }),
    ...brainSmokes.map((file) => command(`fabric-brain-smoke:${path.basename(file)}`, nodeExecutable, [file], {
      expectedSkip: true,
      files: [file],
    })),
    command('fabric-junit', fabricGradle.executable, [
      ...fabricGradle.prefixArgs,
      '--offline',
      '--dependency-verification=strict',
      '--console=plain',
      'clean',
      'test',
    ], { shell: fabricGradle.shell }),
    command('paper-test-build', paperGradle.executable, [
      ...paperGradle.prefixArgs,
      '--offline',
      '--dependency-verification=strict',
      '--console=plain',
      'clean',
      'test',
      'build',
    ], { shell: paperGradle.shell }),
  ];
}

export function verifyFixtureManifest(repositoryRoot, manifestRelativePath = FIXTURE_MANIFEST) {
  const manifestPath = confinedRegularFile(
    repositoryRoot,
    path.join(repositoryRoot, manifestRelativePath),
    'baseline fixture manifest',
  );
  const manifestBytes = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('baseline fixture manifest is not valid JSON');
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('baseline fixture manifest must contain a non-empty schemaVersion 1 file list');
  }
  const seen = new Set();
  const files = manifest.files.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw new Error('baseline fixture manifest contains an invalid path or SHA-256');
    }
    if (entry.sanitized !== true) throw new Error(`fixture is not marked sanitized: ${entry.path}`);
    const slashPath = entry.path.replaceAll('\\', '/');
    const normalizedPath = path.posix.normalize(slashPath);
    if (slashPath !== normalizedPath || slashPath.startsWith('/') || slashPath.includes('\0')) {
      throw new Error(`fixture manifest path is not canonical: ${slashPath}`);
    }
    const pathKey = process.platform === 'win32' ? slashPath.toLowerCase() : slashPath;
    if (seen.has(pathKey)) throw new Error(`duplicate fixture manifest path: ${slashPath}`);
    seen.add(pathKey);
    if (!slashPath.startsWith('data/') || /(?:^|\/)(?:\.env|keys?|secrets?|credentials?|tokens?)(?:\.|\/|$)/i.test(slashPath)) {
      throw new Error(`fixture path is not public-safe: ${slashPath}`);
    }
    const filePath = confinedRegularFile(
      repositoryRoot,
      path.join(repositoryRoot, ...slashPath.split('/')),
      `fixture ${slashPath}`,
    );
    const fixtureBytes = fs.readFileSync(filePath);
    let parsed;
    try {
      parsed = JSON.parse(fixtureBytes.toString('utf8'));
    } catch {
      throw new Error(`fixture is not valid JSON: ${slashPath}`);
    }
    assertSanitizedFixtureValue(parsed, slashPath);
    const actual = sha256Buffer(fixtureBytes);
    if (actual !== entry.sha256) {
      throw new Error(`fixture digest mismatch: ${slashPath}`);
    }
    return { path: slashPath, sha256: actual, sanitized: true };
  });
  return {
    path: manifestRelativePath.replaceAll('\\', '/'),
    sha256: sha256Buffer(manifestBytes),
    files,
  };
}

export function stageBaselineFixtures(repositoryRoot, fixtureRoot, manifestRelativePath = FIXTURE_MANIFEST) {
  const verified = verifyFixtureManifest(repositoryRoot, manifestRelativePath);
  const actualPaths = verified.files.map((entry) => entry.path).sort();
  const requiredPaths = [...BASELINE_FIXTURE_PATHS].sort();
  if (actualPaths.length !== requiredPaths.length
    || actualPaths.some((entry, index) => entry !== requiredPaths[index])) {
    throw new Error('baseline fixture manifest must name exactly the required public fixture set');
  }

  const stagedRoot = path.resolve(fixtureRoot);
  if (lstatIfPresent(stagedRoot)) {
    throw new Error('baseline fixture staging root must not already exist');
  }
  fs.mkdirSync(stagedRoot);
  for (const entry of verified.files) {
    const source = confinedRegularFile(
      repositoryRoot,
      path.join(repositoryRoot, ...entry.path.split('/')),
      `fixture ${entry.path}`,
    );
    const destination = safeInside(stagedRoot, path.join(stagedRoot, ...entry.path.split('/')));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
  return verifyStagedFixtureSet(stagedRoot, verified);
}

export function verifyStagedFixtureSet(fixtureRoot, verifiedManifest) {
  const stagedRoot = path.resolve(fixtureRoot);
  const rootStat = lstatIfPresent(stagedRoot);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('baseline fixture staging root is not a regular directory');
  }
  const expectedFiles = Array.isArray(verifiedManifest?.files) ? verifiedManifest.files : [];
  const expectedPaths = expectedFiles.map((entry) => entry.path).sort();
  const requiredPaths = [...BASELINE_FIXTURE_PATHS].sort();
  if (expectedPaths.length !== requiredPaths.length
    || expectedPaths.some((entry, index) => entry !== requiredPaths[index])) {
    throw new Error('baseline fixture staging metadata is not the required public fixture set');
  }

  const stagedFiles = walkFixtureFiles(stagedRoot);
  const stagedPaths = stagedFiles.map((file) => slash(path.relative(stagedRoot, file))).sort();
  if (stagedPaths.length !== requiredPaths.length
    || stagedPaths.some((entry, index) => entry !== requiredPaths[index])) {
    throw new Error('baseline fixture staging root does not contain exactly the required public fixture set');
  }

  const byPath = new Map(expectedFiles.map((entry) => [entry.path, entry]));
  const files = stagedPaths.map((relativePath) => {
    const entry = byPath.get(relativePath);
    const copiedPath = confinedRegularFile(
      stagedRoot,
      path.join(stagedRoot, ...relativePath.split('/')),
      `staged fixture ${relativePath}`,
    );
    const copiedSha256 = sha256File(copiedPath);
    const sourceSha256 = entry.sha256 || entry.sourceSha256;
    if (copiedSha256 !== sourceSha256) {
      throw new Error(`staged fixture digest mismatch: ${relativePath}`);
    }
    return {
      path: relativePath,
      sanitized: true,
      sourceSha256,
      copiedSha256,
    };
  });

  return {
    path: verifiedManifest.path,
    sha256: verifiedManifest.sha256,
    staged: true,
    stagedRoot,
    fileCount: files.length,
    files,
  };
}

export function summarizeJUnitXml(resultsDirectory) {
  const summary = { files: 0, tests: 0, failures: 0, errors: 0, skipped: 0 };
  if (!fs.existsSync(resultsDirectory)) return summary;
  for (const filePath of walkFiles(resultsDirectory).filter((file) => file.endsWith('.xml'))) {
    const xml = fs.readFileSync(filePath, 'utf8');
    const suite = xml.match(/<testsuite\b([^>]*)>/i);
    if (!suite) continue;
    summary.files += 1;
    for (const key of ['tests', 'failures', 'errors', 'skipped']) {
      const value = suite[1].match(new RegExp(`\\b${key}="(\\d+)"`, 'i'));
      summary[key] += value ? Number(value[1]) : 0;
    }
  }
  return summary;
}

export function jarContainsPluginYaml(jarExecutable, jarPath, options = {}) {
  const runProbe = options.runProbe || runLowImpactToolProbe;
  const result = runProbe({
    executable: jarExecutable,
    args: ['tf', jarPath],
    env: options.env || process.env,
    kind: 'jdk',
    label: 'jar plugin descriptor',
    repositoryRoot: options.repositoryRoot || process.cwd(),
    ...options.probeOptions,
  });
  if (result.status !== 0) return false;
  const entries = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  return entries.filter((entry) => entry === 'plugin.yml').length === 1;
}

export function artifactInventory(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) return [];
  return walkFiles(rootDirectory, { skipDirectoryNames: new Set(['worktree']) })
    .filter((file) => path.basename(file) !== 'baseline-summary.json')
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      path: slash(path.relative(rootDirectory, file)),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    }));
}

export function collectGradleReproducibilityInputs(repositoryRoot) {
  const projects = [
    ['fabric', 'fabric-client'],
    ['paper', 'test-harness-plugin'],
  ];
  const inputs = [
    ['lockfile', 'gradle.lockfile'],
    ['verificationMetadata', path.join('gradle', 'verification-metadata.xml')],
    ['wrapperJar', path.join('gradle', 'wrapper', 'gradle-wrapper.jar')],
  ];
  const result = {};

  for (const [projectKey, projectDirectory] of projects) {
    result[projectKey] = {};
    for (const [inputKey, projectRelativePath] of inputs) {
      const relativePath = path.join(projectDirectory, projectRelativePath);
      let filePath;
      try {
        filePath = confinedRegularFile(
          repositoryRoot,
          path.join(repositoryRoot, relativePath),
          `Gradle reproducibility input ${slash(relativePath)}`,
        );
      } catch (error) {
        throw stageError('preflight', error.message);
      }
      const stat = fs.statSync(filePath);
      result[projectKey][inputKey] = {
        path: slash(relativePath),
        bytes: stat.size,
        sha256: sha256File(filePath),
      };
    }
  }

  return result;
}

export async function runBaseline(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const cwd = dependencies.cwd || process.cwd();
  const startedAt = new Date();
  // This inspection is deliberately the first preflight operation. In
  // particular, do not run a caller-selected npm/JDK/provider executable just
  // to explain why an already-armed environment is unsafe.
  const armedEnvironment = findArmedBaselineEnvironment(env);

  // Only Git identity/location queries are permitted before the source has
  // proven clean. They are needed to keep even a failure summary outside every
  // registered worktree and the shared object database.
  const repositoryRoot = gitText(cwd, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('baseline must be run from a Git worktree');
  const protectedRoots = registeredWorktreeRoots(repositoryRoot);
  const commonGitDirectory = requireGitText(repositoryRoot, ['rev-parse', '--git-common-dir'], 'unable to resolve common Git directory');
  protectedRoots.push(path.resolve(repositoryRoot, commonGitDirectory));
  const outputRoot = prepareExternalOutputRoot(protectedRoots, options.outputRoot);
  const head = requireGitText(repositoryRoot, ['rev-parse', 'HEAD'], 'unable to resolve baseline HEAD');
  const runId = `baseline-${compactTimestamp(new Date())}-${head.slice(0, 12)}-${process.pid}`;
  const runRoot = path.join(outputRoot, runId);
  fs.mkdirSync(runRoot);
  fs.mkdirSync(path.join(runRoot, 'logs'));
  fs.mkdirSync(path.join(runRoot, 'artifacts'));
  const summaryPath = path.join(runRoot, 'baseline-summary.json');
  const summary = {
    schemaVersion: 1,
    suite: 'mcbot-baseline',
    outcome: 'running',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    invocation: {
      entrypoint: options.invocation?.entrypoint || 'direct',
      argv: (options.invocation?.argv || [process.execPath, ...process.argv.slice(1)]).map((arg) => String(arg)),
      cwd: repositoryRoot,
      outputRoot,
      runRoot,
    },
    repository: {
      root: repositoryRoot,
      branch: gitText(repositoryRoot, ['branch', '--show-current']) || null,
      head,
      dirty: null,
      packageLockSha256: hashIfFile(path.join(repositoryRoot, 'package-lock.json')),
      gradleInputs: null,
      fixtures: null,
    },
    // Establish the machine-readable envelope before resource controls, npm
    // resolution, or tool probes so all later preflight failures are durable.
    tools: { notCollected: 'pending clean and unarmed preflight' },
    isolation: {
      mode: 'detached-git-worktree',
      workspaceRemoved: false,
      retainedWorkspace: null,
      dependencies: 'disposable npm ci --ignore-scripts --offline install in the detached worktree',
      nodeExternalNetworkGuard: true,
      gradleOffline: true,
      externalProxyBlackhole: true,
      network: {
        networkSealed: false,
        hermetic: false,
        nodeGuardOnly: true,
        reason: 'no_os_egress_boundary',
        ciFirewallAssertionRequired: true,
        ciFirewallAssertionIncluded: false,
      },
      fixtureMode: 'exclusive manifest-pinned public fixture copy',
      reportMode: 'initially empty external producer-consumer root',
      resourceControls: { applied: false, reason: 'pending clean and unarmed preflight' },
      resourceLock: { acquired: false, reason: 'pending clean and unarmed preflight' },
    },
    floors: { ...BASELINE_FLOORS },
    counts: {},
    steps: [],
    evidence: [],
    artifacts: [],
    failure: null,
  };
  writeJsonAtomic(summaryPath, summary);

  const workspaceRoot = path.join(runRoot, 'worktree');
  const fixtureRoot = path.join(runRoot, 'fixtures');
  const reportRoot = path.join(runRoot, 'generated-reports');
  let worktreeAttempted = false;
  let worktreeAdded = false;
  let initialEvidenceState = new Map();
  let expectedReportState = new Map();
  let sourceStatusAtStart = null;
  let evidenceError = null;
  let cleanupError = null;
  let isolationFailed = false;
  let npmInvocation = null;
  let resourceLease = null;
  let registeredGitOptions = null;
  try {
    if (armedEnvironment.length > 0) {
      summary.tools = { notCollected: 'armed environment rejected before tool probes' };
      throw stageError('preflight', `refusing armed environment names: ${armedEnvironment.join(', ')}`);
    }

    summary.isolation.resourceControls = applyLowImpactProcessPriority(
      dependencies.setPriority
        ? {
          setPriority: dependencies.setPriority,
          getPriority: dependencies.getPriority || (() => os.constants.priority.PRIORITY_LOW),
          platform: dependencies.platform || process.platform,
        }
        : {},
    );
    try {
      const assertNoLocalMinecraftServer = dependencies.assertNoLocalMinecraftServer
        || assertNoUncontrolledLocalMinecraftServerSync;
      const localServerPolicy = assertNoLocalMinecraftServer({ env });
      summary.isolation.resourceControls = {
        ...summary.isolation.resourceControls,
        localMinecraftServerPolicy: localServerPolicy?.policy || null,
        localMinecraftServerState: localServerPolicy?.state || null,
      };
    } catch (error) {
      summary.isolation.resourceControls = {
        ...summary.isolation.resourceControls,
        localMinecraftServerPolicy: 'rejected',
        localMinecraftServerState: 'unverified_or_occupied',
      };
      throw stageError(
        'resource-controls',
        `unable to establish safe local Minecraft server policy: ${error?.message || error}`,
      );
    }
    try {
      const acquireResourceLock = dependencies.acquireResourceLock || acquireOrJoinResourceLockSync;
      const resourceLockWaitMs = dependencies.resourceLockWaitMs ?? STEP_TIMEOUT_MS;
      resourceLease = acquireResourceLock({
        repositoryRoot,
        env,
        purpose: 'baseline-suite',
        waitMs: resourceLockWaitMs,
        details: {
          schedulingPriority: summary.isolation.resourceControls.class,
          processorAffinity: summary.isolation.resourceControls.processorAffinity,
          serialized: true,
          testConcurrency: 1,
          gradleWorkers: 1,
        },
      });
      summary.isolation.resourceLock = {
        acquired: true,
        inherited: resourceLease.inherited === true,
        protocol: resourceLease.metadata?.protocol || null,
        repositoryId: resourceLease.location?.repositoryId || null,
        lockPath: resourceLease.location?.lockPath || null,
        ownerPid: resourceLease.metadata?.owner?.pid || null,
        acquiredAt: resourceLease.metadata?.acquiredAt || null,
        waitLimitMs: resourceLockWaitMs,
        released: false,
      };
      const emptyGitHooks = path.join(runRoot, 'runner-config', 'empty-git-hooks');
      fs.mkdirSync(emptyGitHooks, { recursive: true });
      registeredGitOptions = Object.freeze({
        registered: true,
        repositoryRoot,
        hooksDirectory: emptyGitHooks,
        env: sanitizedToolEnvironment(env),
        platform: dependencies.runRegisteredGitProbe
          ? (dependencies.registeredGitPlatform || process.platform)
          : process.platform,
        runProbe: dependencies.runRegisteredGitProbe,
      });
    } catch (error) {
      summary.isolation.resourceLock = {
        acquired: false,
        reason: sanitizeFailure(error?.message || error),
      };
      throw stageError('resource-lock', `unable to acquire exclusive baseline resource lock: ${error?.message || error}`);
    }

    const status = readGitStatus(repositoryRoot, registeredGitOptions);
    sourceStatusAtStart = status;
    summary.repository.dirty = {
      clean: !status,
      entryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
      statusSha256: sha256Text(status || ''),
    };
    if (status) throw stageError('preflight', 'source worktree is not clean');

    summary.repository.gradleInputs = collectGradleReproducibilityInputs(repositoryRoot);
    npmInvocation = resolveTrustedNpmInvocation({
      nodeExecutable: process.execPath,
      platform: process.platform,
    });
    summary.tools = collectToolVersions(repositoryRoot, sanitizedToolEnvironment(env), npmInvocation);
    requireNode22();
    requireJava21(summary.tools);
    summary.isolation.userBuildConfiguration = verifyUserBuildConfiguration(env);
    const verifiedFixtures = verifyFixtureManifest(repositoryRoot);
    summary.repository.fixtures = {
      ...verifiedFixtures,
      staged: false,
      stagedRoot: null,
      fileCount: verifiedFixtures.files.length,
      files: verifiedFixtures.files.map((entry) => ({
        path: entry.path,
        sanitized: true,
        sourceSha256: entry.sha256,
        copiedSha256: null,
      })),
    };
    if (!fs.existsSync(path.join(repositoryRoot, 'package-lock.json'))) {
      throw stageError('preflight', 'package-lock.json is required for the disposable dependency install');
    }

    worktreeAttempted = true;
    runRequired(
      'isolation',
      'git',
      ['worktree', 'add', '--detach', workspaceRoot, head],
      repositoryRoot,
      registeredGitOptions,
    );
    worktreeAdded = true;
    const isolatedHead = requireGitText(
      workspaceRoot,
      ['rev-parse', 'HEAD'],
      'unable to resolve isolated HEAD',
      registeredGitOptions,
    );
    if (isolatedHead !== head) throw stageError('isolation', 'isolated worktree HEAD mismatch');
    verifyFixtureManifest(workspaceRoot);
    summary.repository.fixtures = stageBaselineFixtures(workspaceRoot, fixtureRoot);
    fs.mkdirSync(reportRoot);
    if (directoryHasEntries(reportRoot)) {
      throw stageError('isolation', 'generated-report root was not empty at creation');
    }
    initialEvidenceState = captureEvidenceState(workspaceRoot, reportRoot);
    expectedReportState = captureReportState(workspaceRoot, reportRoot);

    const childEnv = createBaselineChildEnvironment(env, workspaceRoot, runRoot);
    const commandPlan = buildBaselineCommandPlan(workspaceRoot, {
      env: childEnv,
      npmInvocation,
      fixtureRoot,
      reportRoot,
    });
    for (let index = 0; index < commandPlan.length; index += 1) {
      const spec = commandPlan[index];
      verifyStagedFixtureSet(fixtureRoot, summary.repository.fixtures);
      process.stdout.write(`baseline: running ${spec.name}\n`);
      const step = await executeStep(spec, workspaceRoot, childEnv, runRoot, index);
      try {
        validateStep(step, spec, workspaceRoot, fixtureRoot, reportRoot, summary, registeredGitOptions);
      } catch (error) {
        step.ok = false;
        step.failure = `validation failed; see step logs (${sanitizeFailure(error.message)})`;
      } finally {
        delete step._stdout;
        delete step._stderr;
      }
      try {
        verifyStagedFixtureSet(fixtureRoot, summary.repository.fixtures);
        const isolation = assertBaselineStepIsolation(
          workspaceRoot,
          head,
          expectedReportState,
          spec.name,
          reportRoot,
          registeredGitOptions,
        );
        expectedReportState = isolation.reportState;
        summary.isolation.final = isolation.summary;
        step.reportChanges = isolation.summary.reportChanges;
      } catch (error) {
        isolationFailed = true;
        step.ok = false;
        step.integrityFailure = sanitizeFailure(error.message);
        step.failure ||= 'isolated worktree integrity check failed';
      }
      summary.steps.push(step);
      writeJsonAtomic(summaryPath, summary);
      if (!step.ok) throw stageError(spec.name, step.failure || `exit code ${step.exitCode}`);
    }

    assertSourceUnchanged(repositoryRoot, head, sourceStatusAtStart, registeredGitOptions);
    summary.outcome = 'passed';
  } catch (error) {
    summary.outcome = 'failed';
    summary.failure = {
      stage: error?.stage || 'baseline',
      message: sanitizeFailure(error?.message || error),
    };
  } finally {
    if (worktreeAdded) {
      try {
        verifyStagedFixtureSet(fixtureRoot, summary.repository.fixtures);
        const isolation = assertBaselineStepIsolation(
          workspaceRoot,
          head,
          expectedReportState,
          'final',
          reportRoot,
          registeredGitOptions,
        );
        summary.isolation.final = isolation.summary;
      } catch (error) {
        isolationFailed = true;
        summary.outcome = 'failed';
        summary.failure ||= { stage: 'isolated-integrity', message: sanitizeFailure(error.message) };
        if (summary.failure.stage !== 'isolated-integrity') {
          summary.failure.isolatedIntegrity = sanitizeFailure(error.message);
        }
      }
      try {
        collectEvidenceArtifacts(workspaceRoot, reportRoot, runRoot, summary, initialEvidenceState, summary.tools.jar.executable);
      } catch (error) {
        evidenceError = `evidence collection failed: ${sanitizeFailure(error.message)}`;
      }
    }
    if ((evidenceError || isolationFailed) && worktreeAdded) {
      summary.isolation.retainedWorkspace = workspaceRoot;
    } else if (worktreeAttempted) {
      try {
        const cleanup = cleanupDisposableWorkspace({
          repositoryRoot,
          runRoot,
          workspaceRoot,
          worktreeAdded,
          gitOptions: registeredGitOptions,
        });
        summary.isolation.workspaceRemoved = cleanup.removed;
        summary.isolation.cleanupSafety = cleanup.safety;
      } catch (error) {
        cleanupError = `detached-worktree cleanup failed: ${sanitizeFailure(error.message)}`;
        if (lstatIfPresent(workspaceRoot)) summary.isolation.retainedWorkspace = workspaceRoot;
      }
    }
    if (cleanupError) {
      summary.outcome = 'failed';
      summary.failure ||= { stage: 'cleanup', message: cleanupError };
      if (summary.failure.stage !== 'cleanup') summary.failure.cleanup = cleanupError;
    }
    if (evidenceError) {
      summary.outcome = 'failed';
      summary.failure ||= { stage: 'evidence', message: evidenceError };
      if (summary.failure.stage !== 'evidence') summary.failure.evidence = evidenceError;
    }
    try {
      const finish = sourceSnapshot(repositoryRoot, registeredGitOptions);
      summary.repository.finish = finish;
      if (sourceStatusAtStart !== null) {
        assertSourceUnchanged(repositoryRoot, head, sourceStatusAtStart, registeredGitOptions);
      }
    } catch (error) {
      summary.outcome = 'failed';
      summary.failure ||= { stage: error.stage || 'source-integrity', message: sanitizeFailure(error.message) };
      if (summary.failure.stage !== 'source-integrity') {
        summary.failure.sourceIntegrity = sanitizeFailure(error.message);
      }
    }
    summary.artifacts = artifactInventory(runRoot);
    if (resourceLease) {
      try {
        const released = resourceLease.releaseSync();
        summary.isolation.resourceLock = {
          ...summary.isolation.resourceLock,
          released: true,
          releaseResult: released,
          releasedAt: new Date().toISOString(),
        };
      } catch (error) {
        summary.outcome = 'failed';
        const releaseError = `exclusive resource-lock release failed: ${sanitizeFailure(error.message)}`;
        summary.failure ||= { stage: 'resource-lock-release', message: releaseError };
        if (summary.failure.stage !== 'resource-lock-release') summary.failure.resourceLockRelease = releaseError;
      }
    }
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt.getTime();
    writeJsonAtomic(summaryPath, summary);
  }

  process.stdout.write(`baseline: ${summary.outcome}; summary ${summaryPath}\n`);
  return summary.outcome === 'passed' ? 0 : 1;
}

export function applyLowImpactProcessPriority(options = {}) {
  try {
    const scheduling = applyLowImpactNodeScheduling(
      typeof options === 'function'
        ? {
          setPriority: options,
          getPriority: () => os.constants.priority.PRIORITY_LOW,
          platform: process.platform,
        }
        : options,
    );
    return {
      applied: true,
      class: String(scheduling.schedulingPriority || '').toLowerCase(),
      numericPriority: scheduling.numericPriority,
      processorAffinity: scheduling.processorAffinity,
      processStartIdentity: scheduling.processStartIdentity,
      verifierPid: scheduling.verifierPid || null,
      gradleMaxWorkers: 1,
      advertisedProcessors: 2,
      javaGarbageCollector: 'serial',
      nodeThreadPoolSize: 2,
      forkJoinParallelism: 1,
    };
  } catch (error) {
    throw stageError('resource-controls', `unable to lower baseline process priority: ${error?.message || error}`);
  }
}

function command(name, executable, args, extra = {}) {
  return { name, executable, args, shell: false, ...extra };
}

function isUsableProcessStartIdentity(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function inspectProcessIdentity(inspectProcess, pid, platform) {
  try {
    return inspectProcess(pid, platform);
  } catch {
    return { state: 'unknown' };
  }
}

export function captureBaselineChildProcessIdentity(child, options = {}) {
  const pid = Number(child?.pid);
  const expectedParentPid = Number(options.parentPid ?? process.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 0) {
    return Object.freeze({ state: 'unverifiable', reason: 'invalid_child_or_parent_pid' });
  }
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const platform = options.platform || process.platform;
  const observed = inspectProcessIdentity(inspectProcess, pid, platform);
  if (observed?.state !== 'running' || !isUsableProcessStartIdentity(observed.identity)) {
    return Object.freeze({
      state: observed?.state === 'absent' ? 'absent' : 'unverifiable',
      reason: observed?.state === 'absent' ? 'child_exited_before_identity_capture' : 'child_start_identity_unverifiable',
      pid,
      expectedParentPid,
    });
  }
  if (Number(observed.parentPid) !== expectedParentPid) {
    return Object.freeze({
      state: 'unverifiable',
      reason: 'child_parent_identity_mismatch',
      pid,
      expectedParentPid,
    });
  }
  return Object.freeze({
    state: 'captured',
    pid,
    processStartIdentity: observed.identity,
    parentPid: expectedParentPid,
  });
}

export function validateBaselineChildProcessIdentity(child, captured, options = {}) {
  const pid = Number(child?.pid);
  if (captured?.state !== 'captured'
      || !Number.isSafeInteger(captured.pid) || captured.pid <= 0
      || !isUsableProcessStartIdentity(captured.processStartIdentity)
      || !Number.isSafeInteger(captured.parentPid) || captured.parentPid <= 0
      || pid !== captured.pid) {
    return { safeToTerminate: false, state: 'refused', reason: 'captured_child_identity_missing_or_changed' };
  }
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const platform = options.platform || process.platform;
  const observed = inspectProcessIdentity(inspectProcess, pid, platform);
  if (observed?.state === 'absent') {
    return { safeToTerminate: false, state: 'already_exited', reason: 'captured_child_is_absent' };
  }
  if (observed?.state !== 'running' || !isUsableProcessStartIdentity(observed.identity)) {
    return { safeToTerminate: false, state: 'refused', reason: 'child_start_identity_unverifiable' };
  }
  if (observed.identity !== captured.processStartIdentity) {
    return { safeToTerminate: false, state: 'refused', reason: 'child_pid_reused' };
  }
  if (Number(observed.parentPid) !== captured.parentPid) {
    return { safeToTerminate: false, state: 'refused', reason: 'child_parent_identity_changed' };
  }
  return { safeToTerminate: true, state: 'validated', reason: 'pid_start_and_parent_match' };
}

export function terminateBaselineProcessTree(child, captured, force, options = {}) {
  const validation = validateBaselineChildProcessIdentity(child, captured, options);
  if (!validation.safeToTerminate) {
    return { attempted: false, force: force === true, ...validation };
  }

  const pid = captured.pid;
  const platform = options.platform || process.platform;
  try {
    if (platform === 'win32') {
      const ticks = /^windows-start-ticks:(\d+)$/.exec(captured.processStartIdentity)?.[1] || null;
      const terminatorPath = options.terminatorPath;
      if (!ticks || typeof terminatorPath !== 'string' || !terminatorPath) {
        return { attempted: false, force: force === true, state: 'refused', reason: 'windows_identity_terminator_unavailable' };
      }
      const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
      const result = spawnSyncImpl(options.pwshExecutable || 'pwsh', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        terminatorPath,
        '-ProcessId',
        String(pid),
        '-StartTimeUtcTicks',
        ticks,
        '-ParentProcessId',
        String(captured.parentPid),
        '-WaitMilliseconds',
        '5000',
      ], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      if (result?.status === 10) {
        return { attempted: true, force: force === true, state: 'already_exited', reason: 'validated_child_exited_before_termination' };
      }
      if (result?.status === 11 || result?.status === 12) {
        return { attempted: false, force: force === true, state: 'refused', reason: 'validated_child_identity_changed_in_terminator' };
      }
      if (result?.error || result?.status !== 0) {
        return {
          attempted: true,
          force: force === true,
          state: 'request_failed',
          reason: 'validated_windows_tree_termination_failed',
          exitCode: Number.isInteger(result?.status) ? result.status : null,
        };
      }
    } else {
      const killProcessGroup = options.killProcessGroup || process.kill;
      killProcessGroup(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return { attempted: true, force: force === true, state: 'requested', reason: 'validated_tree_termination_requested' };
  } catch {
    return { attempted: true, force: force === true, state: 'request_failed', reason: 'tree_termination_threw' };
  }
}

async function executeStep(spec, workspaceRoot, env, runRoot, index) {
  const started = new Date();
  const commandCwd = spec.cwdRelative
    ? safeInside(workspaceRoot, path.join(workspaceRoot, spec.cwdRelative))
    : workspaceRoot;
  const logBase = `${String(index + 1).padStart(2, '0')}-${safeFileName(spec.name)}`;
  const stdoutPath = path.join(runRoot, 'logs', `${logBase}.stdout.log`);
  const stderrPath = path.join(runRoot, 'logs', `${logBase}.stderr.log`);
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'wx' });
  let logStreamError = null;
  const rememberLogError = (error) => {
    logStreamError ||= error;
  };
  stdoutStream.on('error', rememberLogError);
  stderrStream.on('error', rememberLogError);
  const stdoutChunks = [];
  const stderrChunks = [];
  let capturedBytes = 0;
  let captureOverflow = false;

  const capture = (chunks, chunk) => {
    if (capturedBytes + chunk.length <= MAX_METRIC_CAPTURE_BYTES) {
      chunks.push(chunk);
      capturedBytes += chunk.length;
    } else {
      captureOverflow = true;
    }
  };

  return new Promise((resolve) => {
    let childError = null;
    let interruptedBy = null;
    let timedOut = false;
    let hardKillTimer = null;
    let settlementTimer = null;
    let timeout = null;
    let settled = false;
    const child = spawn(spec.executable, spec.args, {
      cwd: commandCwd,
      env,
      windowsHide: true,
      shell: spec.shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childProcessIdentity = captureBaselineChildProcessIdentity(child);
    child.stdout?.on('data', (chunk) => {
      stdoutStream.write(chunk);
      capture(stdoutChunks, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderrStream.write(chunk);
      capture(stderrChunks, chunk);
    });
    child.once('error', (error) => {
      childError = error;
    });

    const onSigint = () => terminate('SIGINT');
    const onSigterm = () => terminate('SIGTERM');
    const settle = async (exitCode, signal, detachPipes = false) => {
      if (settled) return;
      settled = true;
      const finishedAt = new Date();
      if (timeout) clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (detachPipes) {
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      stdoutStream.end();
      stderrStream.end();
      const streamResults = await Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
      const streamFailure = streamResults.find((result) => result.status === 'rejected');
      if (streamFailure && !childError) childError = streamFailure.reason;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        name: spec.name,
        argv: [spec.executable, ...spec.args],
        cwd: commandCwd,
        shell: spec.shell === true,
        startedAt: started.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - started.getTime(),
        exitCode,
        signal: interruptedBy || signal || null,
        timedOut,
        captureOverflow,
        ok: exitCode === 0 && !childError && !interruptedBy && !captureOverflow,
        expectedSkip: spec.expectedSkip === true,
        metrics: {},
        logs: {
          stdout: slash(path.relative(runRoot, stdoutPath)),
          stderr: slash(path.relative(runRoot, stderrPath)),
        },
        failure: childError ? sanitizeFailure(childError.message) : null,
        _stdout: stdout,
        _stderr: stderr,
      });
    };

    function terminate(reason) {
      if (interruptedBy) return;
      interruptedBy = reason;
      const windows = process.platform === 'win32';
      const terminationOptions = {
        terminatorPath: path.join(workspaceRoot, 'scripts', 'terminate-baseline-process-tree.ps1'),
      };
      const initialTermination = terminateBaselineProcessTree(
        child,
        childProcessIdentity,
        windows,
        terminationOptions,
      );
      if (initialTermination.state === 'refused' || initialTermination.state === 'request_failed') {
        childError ||= new Error(`safe process-tree termination failed: ${initialTermination.reason}`);
      }
      if (!windows && initialTermination.state === 'requested') {
        hardKillTimer = setTimeout(() => {
          const forcedTermination = terminateBaselineProcessTree(child, childProcessIdentity, true, terminationOptions);
          if (forcedTermination.state === 'refused' || forcedTermination.state === 'request_failed') {
            childError ||= new Error(`safe forced process-tree termination failed: ${forcedTermination.reason}`);
          }
        }, 5000);
        hardKillTimer.unref?.();
      }
      settlementTimer = setTimeout(() => {
        childError ||= new Error('terminated baseline child did not close within the bounded cleanup window');
        void settle(null, null, true);
      }, 10_000);
      settlementTimer.unref?.();
    }
    const terminateForLogError = (error) => {
      childError ||= error;
      terminate('LOG_ERROR');
    };
    stdoutStream.on('error', terminateForLogError);
    stderrStream.on('error', terminateForLogError);
    if (logStreamError) terminateForLogError(logStreamError);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    timeout = setTimeout(() => {
      timedOut = true;
      terminate('TIMEOUT');
    }, STEP_TIMEOUT_MS);
    timeout.unref?.();

    child.once('close', (exitCode, signal) => { void settle(exitCode, signal); });
  });
}

function validateStep(step, spec, workspaceRoot, fixtureRoot, reportRoot, summary, gitOptions = {}) {
  const output = `${step._stdout}\n${step._stderr}`;
  if (step.name === 'check') {
    const count = parseCheckedJavaScriptCount(output);
    step.metrics.checkedFiles = count;
    if (count === null || count < BASELINE_FLOORS.checkedJavaScriptFiles) {
      step.ok = false;
      step.failure = `checked JavaScript floor not met: ${count ?? 'unreported'}`;
    }
    summary.counts.checkedJavaScriptFiles = count;
  } else if (step.name === 'root-offline') {
    const files = spec.files?.length || fs.readdirSync(path.join(workspaceRoot, 'test', 'offline'))
      .filter((name) => name.endsWith('.test.js')).length;
    const node = parseNodeTestSummary(output);
    step.metrics = { files, ...node };
    if (!rootOfflineMetricsPass(step.metrics)) {
      step.ok = false;
      step.failure = `root offline floor/completion check failed: files=${files}, tests=${node.tests}, passed=${node.passed}, failed=${node.failed}, skipped=${node.skipped}, cancelled=${node.cancelled}, todo=${node.todo}`;
    }
    summary.counts.rootOffline = step.metrics;
  } else if (step.name === 'deterministic-eval') {
    const reportPath = path.join(reportRoot, 'deterministic-eval.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    const fixtureReportPath = path.join(reportRoot, 'baseline-fixture-eval.json');
    const fixtureReport = fs.existsSync(fixtureReportPath)
      ? JSON.parse(fs.readFileSync(fixtureReportPath, 'utf8'))
      : null;
    const head = requireGitText(
      workspaceRoot,
      ['rev-parse', 'HEAD'],
      'unable to validate deterministic evidence HEAD',
      gitOptions,
    );
    const generatedAt = Date.parse(report?.generatedAt || '');
    const generatedWithinStep = Number.isFinite(generatedAt)
      && generatedAt >= Date.parse(step.startedAt) - 1000
      && generatedAt <= Date.parse(step.finishedAt) + 1000;
    const reportHead = typeof report?.head === 'string' ? report.head : '';
    const headMatches = reportHead.length >= 7 && head.startsWith(reportHead);
    const inputBoundaryValid = report?.inputBoundary?.checkoutReportsReadable === false
      && report?.inputBoundary?.generatedReportRootInitiallyEmpty === true
      && Number(report?.inputBoundary?.freshProducerCount) === 5
      && report?.inputBoundary?.fixtureSemanticValidationPassed === true
      && samePath(report?.inputBoundary?.fixtureRoot || '', fixtureRoot)
      && samePath(report?.inputBoundary?.reportRoot || '', reportRoot)
      && JSON.stringify(report?.inputBoundary?.fixturePaths || []) === JSON.stringify(BASELINE_FIXTURE_PATHS)
      && JSON.stringify(report?.inputBoundary?.materiallyConsumedFixturePaths || [])
        === JSON.stringify(BASELINE_FIXTURE_PATHS);
    const stagedFixtureHashes = new Map((summary.repository?.fixtures?.files || [])
      .map((entry) => [entry.path, entry.copiedSha256]));
    const fixtureReportValid = fixtureReport?.ok === true
      && fixtureReport?.status === 'staged_fixture_set_validated'
      && fixtureReport?.inputBoundary?.checkoutReportsReadable === false
      && fixtureReport?.inputBoundary?.sourceReportRead === false
      && samePath(fixtureReport?.inputBoundary?.fixtureRoot || '', fixtureRoot)
      && samePath(fixtureReport?.inputBoundary?.reportRoot || '', reportRoot)
      && fixtureReport?.linkage?.exactFixtureCoverage === true
      && Array.isArray(fixtureReport?.fixtures)
      && JSON.stringify(fixtureReport.fixtures.map((entry) => entry?.path))
        === JSON.stringify(BASELINE_FIXTURE_PATHS)
      && fixtureReport.fixtures.every((entry) => entry?.materiallyConsumed === true
        && /^[a-f0-9]{64}$/.test(entry?.sha256 || '')
        && entry.sha256 === stagedFixtureHashes.get(entry.path)
        && /^[a-f0-9]{64}$/.test(entry?.semanticSha256 || '')
        && Number(entry?.recordCount) > 0);
    step.metrics = {
      reportPresent: Boolean(report),
      mode: report?.mode || null,
      ok: report?.ok === true,
      generatedAt: report?.generatedAt || null,
      generatedWithinStep,
      headMatches,
      inputBoundaryValid,
      fixtureReportValid,
    };
    const networkClassificationValid = report?.networkIsolation?.networkSealed === false
      && report?.networkIsolation?.hermetic === false
      && report?.networkIsolation?.nodeGuardOnly === true
      && report?.networkIsolation?.reason === 'no_os_egress_boundary'
      && report?.networkIsolation?.ciFirewallAssertionRequired === true
      && report?.networkIsolation?.ciFirewallAssertionIncluded === false;
    step.metrics.networkClassificationValid = networkClassificationValid;
    if (!report || report.mode !== 'guarded_offline_baseline' || report.ok !== true
      || !generatedWithinStep || !headMatches || !inputBoundaryValid || !fixtureReportValid
      || !networkClassificationValid) {
      step.ok = false;
      step.failure = 'deterministic evaluation did not produce fresh, passing guarded-offline evidence for this HEAD';
    }
    summary.counts.deterministicEvaluation = step.metrics;
  } else if (step.name === 'response-capture-final') {
    const reportPath = path.join(reportRoot, 'advisor-response-capture-guard.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    step.metrics = {
      reportPresent: Boolean(report),
      ok: report?.ok === true,
      status: report?.status || null,
      providerPayloadCount: Array.isArray(report?.reports)
        ? report.reports.reduce((total, entry) => total + Number(entry.providerPayloadCount || 0), 0)
        : null,
    };
    if (!report || report.ok !== true || report.status !== 'private_capture_guard_passed') {
      step.ok = false;
      step.failure = 'fresh response-capture guard did not produce a passing report';
    }
    summary.counts.responseCaptureGuard = step.metrics;
  } else if (step.name === 'fabric-brain-tests') {
    const node = parseNodeTestSummary(output);
    step.metrics = { files: spec.files.length, ...node };
    if (node.tests < BASELINE_FLOORS.fabricBrainTests || node.failed !== 0
      || node.skipped !== 0 || node.cancelled !== 0 || node.todo !== 0) {
      step.ok = false;
      step.failure = `Fabric brain floor/completion check failed: tests=${node.tests}, failed=${node.failed}, skipped=${node.skipped}, cancelled=${node.cancelled}, todo=${node.todo}`;
    }
    summary.counts.fabricBrain = step.metrics;
  } else if (spec.expectedSkip) {
    const skipped = /smoke skipped/i.test(output);
    step.metrics = { skipped };
    if (!skipped) {
      step.ok = false;
      step.failure = 'provider smoke did not emit its expected opt-in skip';
    }
    summary.counts.expectedProviderSmokeSkips = (summary.counts.expectedProviderSmokeSkips || 0) + (skipped ? 1 : 0);
  } else if (step.name === 'fabric-junit') {
    const junit = summarizeJUnitXml(path.join(workspaceRoot, 'fabric-client', 'build', 'test-results', 'test'));
    step.metrics = junit;
    if (junit.tests < BASELINE_FLOORS.fabricJUnitTests || junit.failures !== 0 || junit.errors !== 0 || junit.skipped !== 0) {
      step.ok = false;
      step.failure = `Fabric JUnit floor/skip check failed: tests=${junit.tests}, failures=${junit.failures}, errors=${junit.errors}, skipped=${junit.skipped}`;
    }
    summary.counts.fabricJUnit = junit;
  } else if (step.name === 'paper-test-build') {
    const junit = summarizeJUnitXml(path.join(workspaceRoot, 'test-harness-plugin', 'build', 'test-results', 'test'));
    const libs = path.join(workspaceRoot, 'test-harness-plugin', 'build', 'libs');
    const jars = fs.existsSync(libs)
      ? fs.readdirSync(libs).filter((name) => name.endsWith('.jar')).sort()
      : [];
    const pluginYaml = jars.length === 1
      && jarContainsPluginYaml(summary.tools.jar.executable, path.join(libs, jars[0]), {
        repositoryRoot: summary.repository.root,
      });
    step.metrics = { ...junit, jars: jars.length, pluginYaml };
    if (junit.tests < BASELINE_FLOORS.paperJUnitTests || junit.failures !== 0 || junit.errors !== 0
      || junit.skipped !== 0 || jars.length !== BASELINE_FLOORS.paperPluginJars || !pluginYaml) {
      step.ok = false;
      step.failure = `Paper gate failed: tests=${junit.tests}, failures=${junit.failures}, errors=${junit.errors}, skipped=${junit.skipped}, jars=${jars.length}, plugin.yml=${pluginYaml}`;
    }
    summary.counts.paper = step.metrics;
  }
  if (!step.ok && !step.failure) {
    step.failure = `command exited with code ${step.exitCode ?? 'unavailable'}; see step logs`;
  }
  delete step._stdout;
  delete step._stderr;
}

function collectEvidenceArtifacts(workspaceRoot, reportRoot, runRoot, summary, initialState, jarExecutable) {
  const stepByName = new Map(summary.steps.map((step) => [step.name, step]));
  for (const target of EVIDENCE_TARGETS) {
    const producer = stepByName.get(target.producer);
    const source = evidenceSourcePath(workspaceRoot, reportRoot, target.source);
    const before = initialState.get(target.source) || { exists: false };
    const after = describePath(source);
    const producerFresh = target.source.startsWith('reports/')
      ? producer?.reportChanges?.includes(target.source) === true
      : (!before.exists || before.sha256 !== after.sha256 || before.mtimeMs !== after.mtimeMs);
    const fresh = after.exists && producerFresh;
    const record = {
      source: target.source,
      producer: target.producer,
      producerOk: producer?.ok === true,
      attempted: Boolean(producer),
      fresh,
      copied: false,
      destination: null,
      sha256: after.sha256 || null,
    };
    if (producer && fresh) {
      const destination = path.join(runRoot, 'artifacts', target.destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
      record.copied = true;
      record.destination = slash(path.relative(runRoot, destination));
    }
    summary.evidence.push(record);
  }
  const libs = path.join(workspaceRoot, 'test-harness-plugin', 'build', 'libs');
  const paperStep = stepByName.get('paper-test-build');
  if (paperStep && fs.existsSync(libs)) {
    const jars = fs.readdirSync(libs).filter((name) => name.endsWith('.jar')).sort();
    if (jars.length === 1 && jarContainsPluginYaml(jarExecutable, path.join(libs, jars[0]), {
      repositoryRoot: summary.repository.root,
    })) {
      const destination = path.join(runRoot, 'artifacts', jars[0]);
      fs.copyFileSync(path.join(libs, jars[0]), destination);
      summary.evidence.push({
        source: slash(path.relative(workspaceRoot, path.join(libs, jars[0]))),
        producer: 'paper-test-build',
        producerOk: paperStep.ok === true,
        attempted: true,
        fresh: true,
        copied: true,
        destination: slash(path.relative(runRoot, destination)),
        sha256: sha256File(destination),
      });
    }
  }
  if (summary.outcome === 'passed') {
    validateMandatoryEvidenceRecords(summary.evidence);
  }
}

export function validateMandatoryEvidenceRecords(evidence, expectedCount = EVIDENCE_TARGETS.length + 1) {
  const records = Array.isArray(evidence) ? evidence : [];
  const missing = records.filter((record) => !record.producerOk || !record.fresh || !record.copied);
  if (records.length !== expectedCount || missing.length > 0) {
    throw new Error(`mandatory fresh evidence gate failed: expected=${expectedCount}, recorded=${records.length}, invalid=${missing.length}`);
  }
  return { expected: expectedCount, recorded: records.length, invalid: 0 };
}

function captureEvidenceState(workspaceRoot, reportRoot) {
  return new Map(EVIDENCE_TARGETS.map((target) => [
    target.source,
    describePath(evidenceSourcePath(workspaceRoot, reportRoot, target.source)),
  ]));
}

function evidenceSourcePath(workspaceRoot, reportRoot, source) {
  if (source.startsWith('reports/')) {
    return path.join(reportRoot, ...source.slice('reports/'.length).split('/'));
  }
  return path.join(workspaceRoot, source);
}

function describePath(targetPath) {
  if (!fs.existsSync(targetPath)) return { exists: false, sha256: null, mtimeMs: null };
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return { exists: true, type: 'file', sha256: sha256File(targetPath), mtimeMs: stat.mtimeMs };
  }
  if (stat.isDirectory()) {
    const digest = crypto.createHash('sha256');
    for (const file of walkFiles(targetPath).sort((left, right) => left.localeCompare(right))) {
      digest.update(slash(path.relative(targetPath, file)));
      digest.update('\0');
      digest.update(sha256File(file));
      digest.update('\0');
    }
    return { exists: true, type: 'directory', sha256: digest.digest('hex'), mtimeMs: stat.mtimeMs };
  }
  return { exists: false, sha256: null, mtimeMs: null };
}

export function collectToolVersions(repositoryRoot, env, npmInvocation, options = {}) {
  const probeOptions = { repositoryRoot, runProbe: options.runProbe };
  const git = toolVersion('git', 'git', ['--version'], env, { ...probeOptions, kind: 'native' });
  const npm = collectNpmVersion(env, npmInvocation, probeOptions);
  const javaExecutable = resolveJavaExecutable(env);
  const java = toolVersion('java', javaExecutable, ['-version'], env, { ...probeOptions, kind: 'jdk' });
  const jarExecutable = resolveJdkTool(env, 'jar');
  const jar = toolVersion('jar', jarExecutable, ['--version'], env, { ...probeOptions, kind: 'jdk' });
  const javacExecutable = resolveJdkTool(env, 'javac');
  const javac = toolVersion('javac', javacExecutable, ['-version'], env, { ...probeOptions, kind: 'jdk' });
  return {
    node: { version: process.version, executable: process.execPath },
    npm,
    git,
    java: { ...java, major: parseJavaMajor(java.version) },
    javac: { ...javac, major: parseJavaMajor(javac.version) },
    jar: { ...jar, major: parseJavaMajor(jar.version) },
    fabricGradleWrapper: readGradleWrapperVersion(path.join(repositoryRoot, 'fabric-client')),
    paperGradleWrapper: readGradleWrapperVersion(path.join(repositoryRoot, 'test-harness-plugin')),
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
  };
}

function sanitizedToolEnvironment(sourceEnv) {
  const selected = selectAllowedEnvironment(sourceEnv);
  for (const name of Object.values(RESOURCE_LOCK_ENV)) {
    const value = sourceEnv[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw stageError('resource-lock', `resource-lock environment is incomplete (${name})`);
    }
    selected[name] = value;
  }
  return selected;
}

function findNonemptyEnvironmentValue(env, names) {
  const expected = new Set(names.map((name) => name.toUpperCase()));
  return Object.entries(env || {}).find(([name, value]) => (
    expected.has(name.toUpperCase()) && typeof value === 'string' && value.trim() !== ''
  ));
}

export function runLowImpactToolProbe({
  executable,
  args = [],
  env = {},
  kind = 'native',
  label = 'tool',
  repositoryRoot = process.cwd(),
  workingDirectory = repositoryRoot,
  platform = process.platform,
  probeScript = path.join(repositoryRoot, LOW_IMPACT_TOOL_PROBE),
  pwshExecutable = 'pwsh',
  spawnSyncImpl = spawnSync,
  timeoutMs = TOOL_PROBE_TIMEOUT_MS,
  wrapperTimeoutMs = TOOL_PROBE_WRAPPER_TIMEOUT_MS,
  captureLimitBytes = MAX_TOOL_PROBE_RELAY_CAPTURE_BYTES,
} = {}) {
  if (!['native', 'node', 'jdk'].includes(kind)) {
    throw new TypeError(`unsupported low-impact probe kind: ${kind}`);
  }
  if (typeof executable !== 'string' || !executable || /[\u0000-\u001f\u007f]/.test(executable)) {
    throw new TypeError('low-impact probe executable is invalid');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /\u0000/.test(arg))) {
    throw new TypeError('low-impact probe arguments must be NUL-free strings');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
      || !Number.isSafeInteger(wrapperTimeoutMs) || wrapperTimeoutMs <= timeoutMs || wrapperTimeoutMs > 120_000) {
    throw new TypeError('low-impact probe timeouts are invalid');
  }
  if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes < 1024
      || captureLimitBytes > MAX_TOOL_PROBE_RELAY_CAPTURE_BYTES) {
    throw new TypeError('low-impact probe capture limit is invalid');
  }

  const launchEnv = { ...env };
  const inheritedNodeOptions = findNonemptyEnvironmentValue(launchEnv, ['NODE_OPTIONS']);
  const inheritedJavaOptions = findNonemptyEnvironmentValue(launchEnv, [
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS',
  ]);
  if (inheritedNodeOptions || inheritedJavaOptions) {
    throw new Error(`low-impact ${label} probe refuses caller-supplied runtime options`);
  }
  if (kind === 'node') {
    launchEnv.NODE_OPTIONS = CANONICAL_NODE_PROBE_OPTIONS;
    launchEnv.UV_THREADPOOL_SIZE = '2';
  }

  let result;
  if (platform === 'win32') {
    if (!fs.statSync(probeScript, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`registered low-impact tool probe is missing: ${probeScript}`);
    }
    const argumentsBase64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    result = spawnSyncImpl(pwshExecutable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      probeScript,
      '-RepositoryRoot',
      path.resolve(repositoryRoot),
      '-WorkingDirectory',
      path.resolve(workingDirectory),
      '-Kind',
      kind,
      '-Executable',
      executable,
      '-ArgumentsBase64',
      argumentsBase64,
      '-TimeoutMilliseconds',
      String(timeoutMs),
      '-MaxCaptureBytes',
      String(captureLimitBytes),
    ], {
      cwd: path.resolve(repositoryRoot),
      env: launchEnv,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_TOOL_PROBE_CAPTURE_BYTES,
      timeout: wrapperTimeoutMs,
      killSignal: 'SIGKILL',
    });
  } else {
    if (kind === 'jdk') launchEnv.JAVA_TOOL_OPTIONS = CANONICAL_JAVA_TOOL_OPTIONS;
    result = spawnSyncImpl(executable, args, {
      cwd: path.resolve(workingDirectory),
      env: launchEnv,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_TOOL_PROBE_CAPTURE_BYTES,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  }

  if (result?.error || result?.status === null || result?.status === undefined) {
    const timedOut = result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGKILL';
    const reason = timedOut ? 'timed out' : 'could not be completed';
    throw new Error(`bounded low-impact ${label} probe ${reason}`);
  }
  return result;
}

function hardenedRegisteredGitArguments(args, hooksDirectory) {
  if (!Array.isArray(args) || args.length === 0 || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('registered Git arguments must be a non-empty string array');
  }
  const allowedCommands = new Set([
    'branch', 'diff', 'ls-files', 'rev-parse', 'status', 'worktree',
  ]);
  if (!allowedCommands.has(args[0])) {
    throw new Error(`registered Git command is not allowlisted: ${args[0]}`);
  }
  const resolvedHooks = fs.realpathSync(path.resolve(hooksDirectory));
  if (!fs.statSync(resolvedHooks).isDirectory() || fs.readdirSync(resolvedHooks).length !== 0) {
    throw new Error('registered Git requires an existing empty hooks directory');
  }
  const commandArgs = args[0] === 'diff'
    ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)]
    : [...args];
  return [
    '--no-pager',
    '--no-optional-locks',
    '-c', `core.hooksPath=${resolvedHooks}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0',
    ...commandArgs,
  ];
}

export function runRegisteredGitCommand(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_QUERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('registered Git timeout is invalid');
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    throw new Error('registered Git requires Windows Job process-tree containment');
  }
  const runProbe = options.runProbe || runLowImpactToolProbe;
  return runProbe({
    executable: 'git',
    args: hardenedRegisteredGitArguments(args, options.hooksDirectory),
    env: options.env || sanitizedToolEnvironment(process.env),
    kind: 'native',
    label: `git ${args[0]}`,
    repositoryRoot: options.repositoryRoot || cwd,
    workingDirectory: cwd,
    platform,
    timeoutMs,
    wrapperTimeoutMs: timeoutMs + GIT_WRAPPER_GRACE_MS,
  });
}

function runGitCommand(cwd, args, options = {}, timeoutMs = GIT_QUERY_TIMEOUT_MS) {
  if (options.registered === true) {
    return runRegisteredGitCommand(cwd, args, { ...options, timeoutMs });
  }
  return spawnSync('git', args, {
    cwd,
    encoding: options.encoding || 'utf8',
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

function toolVersion(label, executable, args, env, options = {}) {
  const runProbe = options.runProbe || runLowImpactToolProbe;
  const result = runProbe({
    executable,
    args,
    env,
    kind: options.kind || 'native',
    label: `${label} version`,
    repositoryRoot: options.repositoryRoot || process.cwd(),
  });
  if (result.status !== 0) {
    throw stageError('preflight', `${label} version probe failed with exit code ${result.status}`);
  }
  return {
    executable,
    exitCode: result.status,
    version: firstVersionLine(`${result.stdout || ''}\n${result.stderr || ''}`),
  };
}

function collectNpmVersion(env, npmInvocation, options = {}) {
  return {
    ...toolVersion('npm', npmInvocation.executable, [...npmInvocation.prefixArgs, '--version'], env, {
      kind: 'node',
      ...options,
    }),
    source: npmInvocation.source,
    cliSha256: npmInvocation.cliSha256,
  };
}

function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw stageError('preflight', `Node.js 22 or newer is required; found ${process.version}`);
  }
}

function requireJava21(tools) {
  if (tools.java.exitCode !== 0 || tools.java.major !== 21) {
    throw stageError('preflight', `JDK 21 is required; java major=${tools.java.major ?? 'unavailable'}`);
  }
  if (tools.javac.exitCode !== 0 || tools.javac.major !== 21) {
    throw stageError('preflight', `JDK 21 is required; javac major=${tools.javac.major ?? 'unavailable'}`);
  }
  if (tools.jar.exitCode !== 0 || tools.jar.major !== 21
    || (!fs.existsSync(tools.jar.executable) && path.isAbsolute(tools.jar.executable))) {
    throw stageError('preflight', 'JDK 21 jar tool is unavailable');
  }
}

function assertSanitizedFixtureValue(value, location) {
  if (typeof value === 'string') {
    if (containsForbiddenFixtureString(value)) {
      throw new Error('fixture contains a forbidden secret or provider payload string');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitizedFixtureValue(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isProviderPayloadObject(value)) {
    throw new Error('fixture contains a forbidden provider response payload');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:api.?key|secret|password|authorization|access.?token|refresh.?token)/i.test(key)
      && entry !== null && String(entry).trim() !== '') {
      throw new Error('fixture contains a non-empty credential-shaped field');
    }
    assertSanitizedFixtureValue(entry, `${location}.${key}`);
  }
}

function containsForbiddenFixtureString(value) {
  const variants = [String(value)];
  let current = variants[0];
  for (let depth = 0; depth < 4; depth += 1) {
    const decoded = current.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (decoded === current) break;
    variants.push(decoded);
    current = decoded;
  }
  return variants.some((text) => {
    const secret = /\b(?:sk-[A-Za-z0-9_-]{6,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})\b/.test(text)
      || /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i.test(text)
      || /\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i.test(text);
    if (secret) return true;

    const choices = /"choices"\s*:\s*\[/.test(text);
    const choiceContent = /"(?:message|delta)"\s*:\s*\{[\s\S]{0,32768}?"(?:content|reasoning_content)"\s*:/.test(text)
      || /"(?:text|content|reasoning_content)"\s*:\s*"[^"\r\n]/.test(text);
    const outputText = /"output_text"\s*:\s*"[^"\r\n]/.test(text)
      || /"type"\s*:\s*"output_text"[\s\S]{0,32768}?"text"\s*:/.test(text);
    const usage = /"usage"\s*:\s*\{/.test(text)
      && /"(?:prompt_tokens|completion_tokens|total_tokens)"\s*:/.test(text);
    return (choices && choiceContent) || outputText || (usage && (choices || choiceContent));
  });
}

function isProviderPayloadObject(value) {
  if (Array.isArray(value.choices) && value.choices.some((choice) => (
    typeof choice?.text === 'string'
    || typeof choice?.reasoning_content === 'string'
    || typeof choice?.message?.content === 'string'
    || typeof choice?.message?.reasoning_content === 'string'
    || typeof choice?.delta?.content === 'string'
    || typeof choice?.delta?.reasoning_content === 'string'
  ))) return true;
  if (typeof value.output_text === 'string' && value.output_text.trim()) return true;
  if (Array.isArray(value.output) && value.output.some((entry) => (
    Array.isArray(entry?.content) && entry.content.some((part) => (
      part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()
    ))
  ))) return true;
  return false;
}

export function createBaselineChildEnvironment(sourceEnv, workspaceRoot, runRoot) {
  const env = selectAllowedEnvironment(sourceEnv);
  const guardPath = path.join(workspaceRoot, NETWORK_GUARD);
  const resourceLockBootstrap = path.join(workspaceRoot, 'scripts', 'resource-lock-bootstrap.js');
  const runnerConfigRoot = path.join(runRoot, 'runner-config');
  const emptyNpmUserConfig = path.join(runnerConfigRoot, 'empty-user.npmrc');
  const emptyNpmGlobalConfig = path.join(runnerConfigRoot, 'empty-global.npmrc');
  fs.mkdirSync(runnerConfigRoot, { recursive: true });
  fs.writeFileSync(emptyNpmUserConfig, '', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(emptyNpmGlobalConfig, '', { encoding: 'utf8', flag: 'wx' });
  if (!fs.statSync(resourceLockBootstrap, { throwIfNoEntry: false })?.isFile()) {
    throw stageError('isolation', 'resource-lock Node bootstrap is missing from the disposable worktree');
  }
  for (const name of Object.values(RESOURCE_LOCK_ENV)) {
    const value = sourceEnv[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw stageError('resource-lock', `resource-lock environment is incomplete (${name})`);
    }
    env[name] = value;
  }
  env.NODE_OPTIONS = `--require=${JSON.stringify(guardPath)} --import=${JSON.stringify(pathToFileURL(resourceLockBootstrap).href)} --v8-pool-size=1`;
  env.UV_THREADPOOL_SIZE = '2';
  env.CI = 'true';
  env.NO_COLOR = '1';
  env.TZ = 'UTC';
  env.MCBOT_BASELINE = '1';
  env.HTTP_PROXY = 'http://127.0.0.1:9';
  env.HTTPS_PROXY = 'http://127.0.0.1:9';
  env.ALL_PROXY = 'http://127.0.0.1:9';
  env.NO_PROXY = 'localhost,127.0.0.1,::1';
  env.NPM_CONFIG_USERCONFIG = emptyNpmUserConfig;
  env.NPM_CONFIG_GLOBALCONFIG = emptyNpmGlobalConfig;
  env.NPM_CONFIG_OFFLINE = 'true';
  env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  env.NPM_CONFIG_AUDIT = 'false';
  env.NPM_CONFIG_FUND = 'false';
  return env;
}

export function verifyUserBuildConfiguration(sourceEnv) {
  const userHome = sourceEnv.GRADLE_USER_HOME
    || (sourceEnv.USERPROFILE ? path.join(sourceEnv.USERPROFILE, '.gradle') : null)
    || (sourceEnv.HOME ? path.join(sourceEnv.HOME, '.gradle') : null);
  if (!userHome) throw stageError('preflight', 'unable to resolve the Gradle user home for configuration isolation');
  const gradleUserHome = path.resolve(userHome);
  const properties = path.join(gradleUserHome, 'gradle.properties');
  if (lstatIfPresent(properties)) {
    throw stageError('preflight', 'user Gradle properties are not permitted during the reproducible baseline');
  }
  const initDirectory = path.join(gradleUserHome, 'init.d');
  if (lstatIfPresent(initDirectory) && directoryHasEntries(initDirectory)) {
    throw stageError('preflight', 'user Gradle init scripts are not permitted during the reproducible baseline');
  }
  return {
    npmUserConfig: 'disabled by runner-owned empty config',
    npmGlobalConfig: 'disabled by runner-owned empty config',
    gradleUserHome,
    gradlePropertiesPresent: false,
    gradleInitScriptsPresent: false,
  };
}

function selectAllowedEnvironment(sourceEnv) {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'GRADLE_USER_HOME', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'JAVA_HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
    'NPM_CONFIG_CACHE', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'RUNNER_ARCH', 'RUNNER_OS',
    'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'USERPROFILE', 'WINDIR',
    'XDG_CACHE_HOME',
  ]);
  const selected = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (allowed.has(name.toUpperCase()) && typeof value === 'string') selected[name] = value;
  }
  return selected;
}

function firstVersionLine(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS):/i.test(line)) || null;
}

export function resolveTrustedNpmInvocation({
  nodeExecutable = process.execPath,
  platform = process.platform,
} = {}) {
  let realNode;
  try {
    realNode = fs.realpathSync(path.resolve(nodeExecutable));
  } catch {
    throw stageError('preflight', 'unable to resolve the running Node.js executable');
  }
  if (!fs.statSync(realNode).isFile()) {
    throw stageError('preflight', 'the running Node.js executable is not a regular file');
  }

  const nodeDirectory = path.dirname(realNode);
  const installationRoot = platform === 'win32'
    ? nodeDirectory
    : path.dirname(nodeDirectory);
  const candidates = platform === 'win32'
    ? [path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [
      path.join(installationRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(installationRoot, 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];

  for (const candidate of candidates) {
    const candidateStat = lstatIfPresent(candidate);
    if (!candidateStat) continue;
    let realCli;
    try {
      realCli = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!fs.statSync(realCli).isFile() || !isPathInside(installationRoot, realCli)) continue;

    const packagePath = path.resolve(path.dirname(realCli), '..', 'package.json');
    if (!isPathInside(installationRoot, packagePath) || !fs.existsSync(packagePath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch {
      continue;
    }
    const declaredBin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.npm;
    if (manifest?.name !== 'npm' || typeof declaredBin !== 'string') continue;
    let declaredCli;
    try {
      declaredCli = fs.realpathSync(path.resolve(path.dirname(packagePath), declaredBin));
    } catch {
      continue;
    }
    if (!samePath(declaredCli, realCli)) continue;

    return {
      executable: realNode,
      prefixArgs: [realCli],
      source: 'validated-node-installation',
      cliSha256: sha256File(realCli),
    };
  }

  throw stageError('preflight', 'unable to locate a validated npm CLI under the running Node.js installation');
}

function assertSourceUnchanged(repositoryRoot, expectedHead, expectedStatus, gitOptions = {}) {
  const snapshot = sourceSnapshot(repositoryRoot, gitOptions);
  if (snapshot.head !== expectedHead || snapshot.statusSha256 !== sha256Text(expectedStatus || '')) {
    throw stageError('source-integrity', 'source worktree changed during the baseline; no files were restored automatically');
  }
  return snapshot;
}

function sourceSnapshot(repositoryRoot, gitOptions = {}) {
  const head = requireGitText(
    repositoryRoot,
    ['rev-parse', 'HEAD'],
    'source HEAD became unreadable',
    gitOptions,
  );
  const status = readGitStatus(repositoryRoot, gitOptions);
  return {
    head,
    dirty: Boolean(status),
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
    statusSha256: sha256Text(status || ''),
  };
}

export function assertIsolatedWorkspaceState(workspaceRoot, expectedHead, gitOptions = {}) {
  const head = requireGitText(
    workspaceRoot,
    ['rev-parse', 'HEAD'],
    'isolated HEAD became unreadable',
    gitOptions,
  );
  const changedPaths = changedGitPaths(workspaceRoot, gitOptions);
  const unexpectedPaths = changedPaths.filter((file) => !slash(file).startsWith('reports/'));
  verifyFixtureManifest(workspaceRoot);
  if (head !== expectedHead || unexpectedPaths.length > 0) {
    throw stageError('isolated-integrity', `unexpected isolated changes: ${unexpectedPaths.join(', ') || 'HEAD changed'}`);
  }
  const status = readGitStatus(workspaceRoot, gitOptions);
  return {
    head,
    dirty: Boolean(status),
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
    statusSha256: sha256Text(status || ''),
    allowedGeneratedReportChanges: changedPaths.filter((file) => slash(file).startsWith('reports/')).length,
    unexpectedPaths: [],
    fixturesVerified: true,
  };
}

export function captureReportState(workspaceRoot, reportRoot = path.join(workspaceRoot, 'reports')) {
  const reportsRoot = path.resolve(reportRoot);
  const state = new Map();
  if (!fs.existsSync(reportsRoot)) return state;
  for (const filePath of walkFiles(reportsRoot).sort((left, right) => left.localeCompare(right))) {
    const stat = fs.statSync(filePath);
    state.set(`reports/${slash(path.relative(reportsRoot, filePath))}`, {
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sha256File(filePath),
    });
  }
  return state;
}

export function assertBaselineStepIsolation(
  workspaceRoot,
  expectedHead,
  beforeReportState,
  stepName,
  reportRoot = path.join(workspaceRoot, 'reports'),
  gitOptions = {},
) {
  const workspace = assertIsolatedWorkspaceState(workspaceRoot, expectedHead, gitOptions);
  const reportsAreExternal = !samePath(reportRoot, path.join(workspaceRoot, 'reports'));
  if (reportsAreExternal && workspace.allowedGeneratedReportChanges > 0) {
    throw stageError('isolated-integrity', 'baseline evaluator mutated checkout reports');
  }
  const afterReportState = captureReportState(workspaceRoot, reportRoot);
  const reportChanges = changedStatePaths(beforeReportState, afterReportState, true);
  const reportContentChanges = changedStatePaths(beforeReportState, afterReportState, false);
  let allowed = new Set();
  let required = [];
  if (stepName === 'deterministic-eval') {
    allowed = new Set(DETERMINISTIC_REPORT_MUTATION_ALLOWLIST);
    required = DETERMINISTIC_REPORT_MUTATION_ALLOWLIST;
  } else if (stepName === 'response-capture-final') {
    allowed = new Set(CAPTURE_GUARD_REPORT_OUTPUTS);
    required = CAPTURE_GUARD_REPORT_OUTPUTS;
  }
  const unexpected = reportContentChanges.filter((file) => !allowed.has(file));
  const missingRequired = required.filter((file) => !reportChanges.includes(file));
  if (unexpected.length > 0 || missingRequired.length > 0) {
    throw stageError('isolated-integrity', [
      unexpected.length > 0 ? `unexpected report mutations: ${unexpected.join(', ')}` : '',
      missingRequired.length > 0 ? `required fresh reports missing: ${missingRequired.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
  return {
    reportState: afterReportState,
    summary: {
      ...workspace,
      step: stepName,
      reportChanges,
      reportContentChanges,
    },
  };
}

export function assertDisposableCleanupSafe(runRoot, workspaceRoot) {
  const candidate = safeInside(runRoot, workspaceRoot);
  const rootStat = lstatIfPresent(candidate);
  if (!rootStat) return { checkedEntries: 0, containedLinks: 0 };
  if (rootStat.isSymbolicLink()) {
    throw new Error('refusing cleanup because the disposable worktree root is a reparse link');
  }
  const realWorkspace = fs.realpathSync(candidate);
  const realRunRoot = fs.realpathSync(runRoot);
  if (!isPathInside(realRunRoot, realWorkspace)) {
    throw new Error('refusing cleanup because the disposable worktree resolves outside its run root');
  }

  let checkedEntries = 0;
  let containedLinks = 0;
  const stack = [candidate];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = fs.lstatSync(entryPath);
      checkedEntries += 1;
      if (entryStat.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(entryPath);
        } catch {
          throw new Error(`refusing cleanup because a reparse link is unresolved: ${slash(path.relative(candidate, entryPath))}`);
        }
        if (!isPathInside(realWorkspace, target)) {
          throw new Error(`refusing cleanup because a reparse link escapes the disposable worktree: ${slash(path.relative(candidate, entryPath))}`);
        }
        containedLinks += 1;
      } else if (entryStat.isDirectory()) {
        const realDirectory = fs.realpathSync(entryPath);
        if (!isPathInside(realWorkspace, realDirectory)) {
          throw new Error(`refusing cleanup because a directory resolves outside the disposable worktree: ${slash(path.relative(candidate, entryPath))}`);
        }
        stack.push(entryPath);
      }
    }
  }
  return { checkedEntries, containedLinks };
}

export function cleanupDisposableWorkspace({
  repositoryRoot,
  runRoot,
  workspaceRoot,
  worktreeAdded,
  gitOptions = {},
}) {
  const safety = assertDisposableCleanupSafe(runRoot, workspaceRoot);
  const wasRegistered = isRegisteredWorktree(repositoryRoot, workspaceRoot, gitOptions);
  const rootWasPresent = Boolean(lstatIfPresent(workspaceRoot));
  if (!rootWasPresent && !wasRegistered) return { removed: true, safety };

  // A dependency junction here once let forced worktree cleanup empty its external
  // target. Dependencies must be installed locally, and this guard runs before any
  // recursive or Git-forced removal so an old or unexpected junction is retained.
  const removal = runGitCommand(
    repositoryRoot,
    ['worktree', 'remove', '--force', workspaceRoot],
    gitOptions,
    GIT_WORKTREE_TIMEOUT_MS,
  );
  const rootStillPresent = Boolean(lstatIfPresent(workspaceRoot));
  const stillRegistered = isRegisteredWorktree(repositoryRoot, workspaceRoot, gitOptions);
  if (!rootStillPresent && !stillRegistered) return { removed: true, safety };
  if (worktreeAdded) {
    throw new Error(removal.stderr || removal.error?.message || 'Git refused to remove the disposable worktree');
  }

  if (!rootStillPresent) {
    throw new Error('Git worktree administration still registers the absent disposable path');
  }
  const partialPath = safeInside(runRoot, workspaceRoot);
  fs.rmSync(partialPath, { recursive: true, force: true });
  if (lstatIfPresent(partialPath) || isRegisteredWorktree(repositoryRoot, workspaceRoot, gitOptions)) {
    throw new Error('partial disposable worktree cleanup did not remove both path and registration');
  }
  return { removed: true, safety };
}

export function prepareExternalOutputRoot(protectedRoots, requestedPath) {
  const outputRoot = path.resolve(requestedPath);
  if (process.platform === 'win32' && /[&|<>^%!\r\n]/.test(outputRoot)) {
    throw new Error('baseline output root contains characters unsafe for the Windows Gradle wrapper');
  }
  const realProtectedRoots = [...new Set(protectedRoots.map(canonicalizePossiblyMissingPath))];
  for (const protectedRoot of realProtectedRoots) {
    const lexicalRelative = path.relative(protectedRoot, outputRoot);
    if (!lexicalRelative || (!lexicalRelative.startsWith('..') && !path.isAbsolute(lexicalRelative))) {
      throw new Error('baseline output root must be outside every registered worktree and the common Git directory');
    }
  }
  const projectedOutput = canonicalizePossiblyMissingPath(outputRoot);
  for (const protectedRoot of realProtectedRoots) {
    const projectedRelative = path.relative(protectedRoot, projectedOutput);
    if (!projectedRelative || (!projectedRelative.startsWith('..') && !path.isAbsolute(projectedRelative))) {
      throw new Error('baseline output root resolves inside a protected Git location');
    }
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const realOutput = fs.realpathSync(outputRoot);
  for (const protectedRoot of realProtectedRoots) {
    const relative = path.relative(protectedRoot, realOutput);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('baseline output root must be outside protected Git locations');
    }
  }
  return realOutput;
}

function canonicalizePossiblyMissingPath(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  let existingAncestor = resolvedTarget;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  return path.resolve(realAncestor, path.relative(existingAncestor, resolvedTarget));
}

function registeredWorktreeRoots(repositoryRoot, gitOptions = {}) {
  const text = requireGitText(
    repositoryRoot,
    ['worktree', 'list', '--porcelain'],
    'unable to enumerate Git worktrees',
    gitOptions,
  );
  return text.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function isRegisteredWorktree(repositoryRoot, candidate, gitOptions = {}) {
  return registeredWorktreeRoots(repositoryRoot, gitOptions).some((root) => samePath(root, candidate));
}

function readGradleWrapperVersion(projectRoot) {
  const file = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/gradle-([0-9][0-9.]*)-(?:bin|all)\.zip/);
  return { version: match?.[1] || null, propertiesSha256: sha256File(file) };
}

function resolveJavaExecutable(env) {
  if (env.JAVA_HOME) return path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return 'java';
}

function resolveJdkTool(env, tool) {
  if (env.JAVA_HOME) return path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool);
  return tool;
}

function gitText(cwd, args, gitOptions = {}) {
  const result = runGitCommand(cwd, args, gitOptions, GIT_QUERY_TIMEOUT_MS);
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

export function readGitStatus(cwd, gitOptions = {}) {
  const result = runGitCommand(
    cwd,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    gitOptions,
    GIT_QUERY_TIMEOUT_MS,
  );
  if (result.status !== 0) {
    throw stageError('source-integrity', result.stderr || result.error?.message || 'git status failed');
  }
  return String(result.stdout || '').trim();
}

function changedGitPaths(cwd, gitOptions = {}) {
  const commands = [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const files = new Set();
  for (const args of commands) {
    const result = runGitCommand(cwd, args, { ...gitOptions, encoding: 'buffer' }, GIT_QUERY_TIMEOUT_MS);
    if (result.status !== 0) {
      throw stageError('isolated-integrity', result.stderr?.toString('utf8') || result.error?.message || 'Git change scan failed');
    }
    for (const file of result.stdout.toString('utf8').split('\0').filter(Boolean)) files.add(file);
  }
  return [...files].sort();
}

function requireGitText(cwd, args, message, gitOptions = {}) {
  const value = gitText(cwd, args, gitOptions);
  if (!value) throw stageError('preflight', message);
  return value;
}

function runRequired(stage, executable, args, cwd, gitOptions = {}) {
  const timeoutMs = executable === 'git' && args[0] === 'worktree'
    ? GIT_WORKTREE_TIMEOUT_MS
    : GIT_QUERY_TIMEOUT_MS;
  const result = executable === 'git'
    ? runGitCommand(cwd, args, gitOptions, timeoutMs)
    : spawnSync(executable, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  if (result.status !== 0) {
    throw stageError(stage, result.stderr || result.error?.message || `${executable} failed`);
  }
}

function requireDirectory(directoryPath, message) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    throw stageError('preflight', message);
  }
}

function stageError(stage, message) {
  const error = new Error(sanitizeFailure(message));
  error.stage = stage;
  return error;
}

function sanitizeFailure(value) {
  return String(value || 'unknown error')
    // Preserve safe diagnostic paths such as reports/unexpected-output.json.
    // Redact credential-shaped prefixes, long hexadecimal secrets, and long
    // uninterrupted base64-like values without treating path punctuation as
    // secret material.
    .replace(/\b(?:sk|token|secret|password|key)[_-][A-Za-z0-9_+=.-]{16,}\b/gi, '[redacted]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_+=]{48,}\b/g, '[redacted]')
    .slice(0, 4000);
}

function safeInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes baseline root: ${candidate}`);
  }
  return resolved;
}

function confinedRegularFile(root, candidate, label) {
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = safeInside(lexicalRoot, candidate);
  const realRoot = fs.realpathSync(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  const segments = relative.split(path.sep).filter(Boolean);
  let lexicalCursor = lexicalRoot;
  let expectedRealCursor = realRoot;

  for (const segment of segments) {
    lexicalCursor = path.join(lexicalCursor, segment);
    expectedRealCursor = path.join(expectedRealCursor, segment);
    const stat = lstatIfPresent(lexicalCursor);
    if (!stat) throw new Error(`${label} does not exist`);
    if (stat.isSymbolicLink()) throw new Error(`${label} traverses a reparse link`);
    const realCursor = fs.realpathSync(lexicalCursor);
    if (!samePath(realCursor, expectedRealCursor)) {
      throw new Error(`${label} traverses a redirected filesystem path`);
    }
  }

  const finalStat = fs.lstatSync(lexicalCandidate);
  const realCandidate = fs.realpathSync(lexicalCandidate);
  if (!finalStat.isFile() || finalStat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (!isPathInside(realRoot, realCandidate)) throw new Error(`${label} resolves outside the repository`);
  return realCandidate;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function lstatIfPresent(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function directoryHasEntries(directoryPath) {
  const root = fs.lstatSync(directoryPath);
  if (!root.isDirectory() || root.isSymbolicLink()) return true;
  const stack = [directoryPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || stat.isFile()) return true;
      if (stat.isDirectory()) stack.push(target);
      else return true;
    }
  }
  return false;
}

function changedStatePaths(before, after, includeMtime) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => {
    const left = before.get(file);
    const right = after.get(file);
    return !left || !right
      || left.bytes !== right.bytes
      || (includeMtime && left.mtimeMs !== right.mtimeMs)
      || left.sha256 !== right.sha256;
  }).sort();
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function hashIfFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? sha256File(filePath) : null;
}

function walkFiles(root, options = {}) {
  const files = [];
  const stack = [root];
  const skipDirectoryNames = options.skipDirectoryNames || new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && !skipDirectoryNames.has(entry.name)) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

function walkFixtureFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('baseline fixture staging root contains a reparse link');
      }
      if (stat.isDirectory()) stack.push(fullPath);
      else if (stat.isFile()) files.push(fullPath);
      else throw new Error('baseline fixture staging root contains a non-regular entry');
    }
  }
  return files;
}

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, serializeBaselineSummary(value), 'utf8');
  fs.renameSync(temp, filePath);
}

export function serializeBaselineSummary(value) {
  return `${JSON.stringify(value, (key, entry) => (
    key === '_stdout' || key === '_stderr' ? undefined : entry
  ), 2)}\n`;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function slash(value) {
  return value.replaceAll(path.sep, '/');
}

export default {
  BASELINE_FIXTURE_PATHS,
  BASELINE_FLOORS,
  applyLowImpactProcessPriority,
  artifactInventory,
  assertDisposableCleanupSafe,
  assertBaselineStepIsolation,
  buildBaselineCommandPlan,
  captureBaselineChildProcessIdentity,
  captureReportState,
  collectGradleReproducibilityInputs,
  cleanupDisposableWorkspace,
  findArmedBaselineEnvironment,
  jarContainsPluginYaml,
  parseBaselineArgs,
  parseCheckedJavaScriptCount,
  parseJavaMajor,
  parseNodeTestSummary,
  prepareExternalOutputRoot,
  resolveGradleInvocation,
  resolveTrustedNpmInvocation,
  rootOfflineMetricsPass,
  runRegisteredGitCommand,
  runBaseline,
  serializeBaselineSummary,
  stageBaselineFixtures,
  summarizeJUnitXml,
  terminateBaselineProcessTree,
  validateBaselineChildProcessIdentity,
  validateMandatoryEvidenceRecords,
  verifyUserBuildConfiguration,
  verifyFixtureManifest,
  verifyStagedFixtureSet,
};
