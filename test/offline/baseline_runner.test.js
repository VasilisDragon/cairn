import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateBaselineFixtureSet } from '../../scripts/baseline-fixture-eval.js';
import { sanitizeBaselineEvaluatorEnvironment } from '../../scripts/baseline-evaluator-environment.js';
import {
  acquireOrJoinResourceLockSync,
  getProcessStartIdentity,
  RESOURCE_LOCK_ENV,
  RESOURCE_LOCK_PROTOCOL,
} from '../../scripts/resource-lock.js';
import {
  BASELINE_FIXTURE_PATHS,
  BASELINE_FLOORS,
  applyLowImpactProcessPriority,
  artifactInventory,
  assertBaselineStepIsolation,
  assertDisposableCleanupSafe,
  assertIsolatedWorkspaceState,
  buildBaselineCommandPlan,
  captureBaselineChildProcessIdentity,
  captureReportState,
  collectGradleReproducibilityInputs,
  cleanupDisposableWorkspace,
  createBaselineChildEnvironment,
  collectToolVersions,
  findArmedBaselineEnvironment,
  jarContainsPluginYaml,
  parseBaselineArgs,
  parseCheckedJavaScriptCount,
  parseJavaMajor,
  parseNodeTestSummary,
  prepareExternalOutputRoot,
  readGitStatus,
  resolveGradleInvocation,
  resolveLowImpactGradleInvocation,
  resolveTrustedNpmInvocation,
  rootOfflineMetricsPass,
  runLowImpactToolProbe,
  runRegisteredGitCommand,
  runBaseline,
  serializeBaselineSummary,
  stageBaselineFixtures,
  summarizeJUnitXml,
  terminateBaselineProcessTree,
  validateMandatoryEvidenceRecords,
  validateBaselineChildProcessIdentity,
  verifyUserBuildConfiguration,
  verifyFixtureManifest,
  verifyStagedFixtureSet,
} from '../../scripts/baseline-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'baseline-network-guard.cjs');
const RESOURCE_LOCK_BOOTSTRAP = path.join(ROOT, 'scripts', 'resource-lock-bootstrap.js');

test('baseline CLI requires one external output root argument', () => {
  assert.deepEqual(parseBaselineArgs(['--output-root', 'D:\\evidence']), { outputRoot: 'D:\\evidence' });
  assert.deepEqual(parseBaselineArgs(['--output-root=/tmp/evidence']), { outputRoot: '/tmp/evidence' });
  assert.throws(() => parseBaselineArgs([]), /--output-root/);
  assert.throws(() => parseBaselineArgs(['--other']), /unknown baseline argument/);
});

test('baseline output root rejects lexical, symlinked, and missing protected worktree paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-output-root-'));
  const protectedRoot = path.join(root, 'protected-worktree');
  const validOutput = path.join(root, 'external-output');
  const missingProtected = path.join(root, 'not-created', 'registered-worktree');
  const linkOutput = path.join(root, 'linked-output');
  fs.mkdirSync(protectedRoot);
  try {
    assert.throws(
      () => prepareExternalOutputRoot([protectedRoot], path.join(protectedRoot, 'evidence')),
      /outside every registered worktree/,
    );
    assert.throws(
      () => prepareExternalOutputRoot([missingProtected], path.join(missingProtected, 'evidence')),
      /outside every registered worktree/,
    );
    fs.symlinkSync(protectedRoot, linkOutput, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => prepareExternalOutputRoot([protectedRoot], linkOutput),
      /resolves inside a protected Git location/,
    );
    assert.equal(prepareExternalOutputRoot([protectedRoot], validOutput), fs.realpathSync(validOutput));
  } finally {
    if (fs.lstatSync(linkOutput, { throwIfNoEntry: false })) fs.unlinkSync(linkOutput);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('baseline preflight lifecycle records exact invocation and fails before isolation on dirty source', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-lifecycle-repo-'));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-lifecycle-output-'));
  try {
    for (const project of ['fabric-client', 'test-harness-plugin']) {
      const wrapper = path.join(repository, project, 'gradle', 'wrapper');
      fs.mkdirSync(wrapper, { recursive: true });
      fs.writeFileSync(path.join(wrapper, 'gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n', 'utf8');
    }
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'clean\n', 'utf8');
    runGit(repository, ['init', '-q']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'dirty\n', 'utf8');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => [
      'COMSPEC', 'HOME', 'JAVA_HOME', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    ].includes(name.toUpperCase())));
    const invocation = { entrypoint: 'unit-lifecycle', argv: ['node', 'scripts/run-baseline.js', '--output-root', outputRoot] };
    const lifecycleEvents = [];
    const resourceLock = createFakeResourceLock(lifecycleEvents);
    const registeredGitCalls = [];
    let priorityCalls = 0;
    assert.equal(await runBaseline({ outputRoot, invocation }, {
      cwd: repository,
      env,
      setPriority: () => {
        priorityCalls += 1;
        lifecycleEvents.push('priority');
      },
      assertNoLocalMinecraftServer: ({ env: observedEnv }) => {
        assert.equal(observedEnv, env);
        assert.equal(observedEnv[RESOURCE_LOCK_ENV.path], undefined);
        lifecycleEvents.push('local-server-policy');
        return { policy: 'no-local-listeners', state: 'clear' };
      },
      acquireResourceLock: resourceLock.acquire,
      resourceLockWaitMs: 1_234,
      registeredGitPlatform: 'win32',
      runRegisteredGitProbe: (request) => {
        registeredGitCalls.push(request);
        return spawnSync(request.executable, request.args, {
          cwd: request.workingDirectory,
          encoding: 'utf8',
          timeout: 5_000,
          killSignal: 'SIGKILL',
        });
      },
    }), 1);
    const runs = fs.readdirSync(outputRoot);
    assert.equal(runs.length, 1);
    const summaryText = fs.readFileSync(path.join(outputRoot, runs[0], 'baseline-summary.json'), 'utf8');
    const summary = JSON.parse(summaryText);
    assert.equal(summary.outcome, 'failed');
    assert.equal(summary.failure.stage, 'preflight');
    assert.equal(summary.invocation.entrypoint, 'unit-lifecycle');
    assert.deepEqual(summary.invocation.argv, invocation.argv);
    assert.equal(summary.steps.length, 0);
    assert.equal(summary.tools.notCollected, 'pending clean and unarmed preflight');
    assert.equal(summary.isolation.resourceControls.applied, true);
    assert.equal(summary.isolation.resourceControls.localMinecraftServerPolicy, 'no-local-listeners');
    assert.equal(summary.isolation.resourceControls.localMinecraftServerState, 'clear');
    assert.deepEqual(summary.isolation.network, {
      networkSealed: false,
      hermetic: false,
      nodeGuardOnly: true,
      reason: 'no_os_egress_boundary',
      ciFirewallAssertionRequired: true,
      ciFirewallAssertionIncluded: false,
    });
    assert.deepEqual(summary.isolation.resourceLock, {
      acquired: true,
      inherited: false,
      protocol: RESOURCE_LOCK_PROTOCOL,
      repositoryId: 'unit-repository-id',
      lockPath: resourceLock.lockPath,
      ownerPid: 42_424,
      acquiredAt: '2026-08-29T12:00:00.000Z',
      waitLimitMs: 1_234,
      released: true,
      releaseResult: true,
      releasedAt: summary.isolation.resourceLock.releasedAt,
    });
    assert.match(summary.isolation.resourceLock.releasedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(priorityCalls, 1);
    assert.equal(registeredGitCalls.length >= 3, true);
    assert.equal(registeredGitCalls.every((call) => call.kind === 'native'
      && call.args.includes('core.fsmonitor=false')
      && call.args.some((arg) => arg.startsWith('core.hooksPath='))), true);
    assert.deepEqual(lifecycleEvents, [
      'priority',
      'local-server-policy',
      'resource-lock-acquire',
      'resource-lock-release',
    ]);
    assert.equal(path.resolve(resourceLock.acquireOptions.repositoryRoot), fs.realpathSync(repository));
    assert.equal(resourceLock.acquireOptions.env, env);
    assert.equal(resourceLock.acquireOptions.purpose, 'baseline-suite');
    assert.equal(resourceLock.acquireOptions.waitMs, 1_234);
    assert.deepEqual(resourceLock.acquireOptions.details, {
      schedulingPriority: 'idle',
      processorAffinity: null,
      serialized: true,
      testConcurrency: 1,
      gradleWorkers: 1,
    });
    assert.equal(resourceLock.releaseCalls, 1);
    for (const name of Object.values(RESOURCE_LOCK_ENV)) assert.equal(env[name], undefined);
    assert.equal(summaryText.includes('_stdout'), false);
    assert.equal(summaryText.includes('_stderr'), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('baseline rejects armed input before resource/tool probes and envelopes later preflight failures', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-preflight-repo-'));
  writeRequiredGradleReproducibilityInputs(repository);
  const armedOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-preflight-armed-'));
  const resourceOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-preflight-resource-'));
  const localServerOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-preflight-local-server-'));
  try {
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'clean\n', 'utf8');
    runGit(repository, ['init', '-q']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => [
      'COMSPEC', 'HOME', 'JAVA_HOME', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    ].includes(name.toUpperCase())));

    let priorityCalls = 0;
    let localServerCalls = 0;
    const armedResourceLock = createFakeResourceLock();
    assert.equal(await runBaseline({ outputRoot: armedOutput }, {
      cwd: repository,
      env: { ...baseEnv, MCBOT_LIVE_TESTS: '1' },
      setPriority: () => { priorityCalls += 1; },
      assertNoLocalMinecraftServer: () => {
        localServerCalls += 1;
        return { policy: 'no-local-listeners', state: 'clear' };
      },
      acquireResourceLock: armedResourceLock.acquire,
    }), 1);
    const armedSummary = JSON.parse(fs.readFileSync(path.join(
      armedOutput,
      fs.readdirSync(armedOutput)[0],
      'baseline-summary.json',
    ), 'utf8'));
    assert.equal(armedSummary.failure.stage, 'preflight');
    assert.equal(armedSummary.tools.notCollected, 'armed environment rejected before tool probes');
    assert.equal(priorityCalls, 0);
    assert.equal(localServerCalls, 0);
    assert.equal(armedResourceLock.acquireOptions, null);

    const priorityResourceLock = createFakeResourceLock();
    assert.equal(await runBaseline({ outputRoot: resourceOutput }, {
      cwd: repository,
      env: baseEnv,
      setPriority: () => { throw new Error('priority unavailable'); },
      assertNoLocalMinecraftServer: () => {
        localServerCalls += 1;
        return { policy: 'no-local-listeners', state: 'clear' };
      },
      acquireResourceLock: priorityResourceLock.acquire,
    }), 1);
    const resourceSummary = JSON.parse(fs.readFileSync(path.join(
      resourceOutput,
      fs.readdirSync(resourceOutput)[0],
      'baseline-summary.json',
    ), 'utf8'));
    assert.equal(resourceSummary.failure.stage, 'resource-controls');
    assert.equal(resourceSummary.outcome, 'failed');
    assert.equal(resourceSummary.steps.length, 0);
    assert.equal(localServerCalls, 0);
    assert.equal(priorityResourceLock.acquireOptions, null);

    const localServerEvents = [];
    const localServerResourceLock = createFakeResourceLock(localServerEvents);
    assert.equal(await runBaseline({ outputRoot: localServerOutput }, {
      cwd: repository,
      env: baseEnv,
      setPriority: () => { localServerEvents.push('priority'); },
      assertNoLocalMinecraftServer: () => {
        localServerEvents.push('local-server-policy');
        throw new Error('uncontrolled Paper server detected');
      },
      acquireResourceLock: localServerResourceLock.acquire,
    }), 1);
    const localServerSummary = JSON.parse(fs.readFileSync(path.join(
      localServerOutput,
      fs.readdirSync(localServerOutput)[0],
      'baseline-summary.json',
    ), 'utf8'));
    assert.equal(localServerSummary.failure.stage, 'resource-controls');
    assert.match(localServerSummary.failure.message, /safe local Minecraft server policy/);
    assert.equal(localServerSummary.isolation.resourceControls.applied, true);
    assert.equal(localServerSummary.isolation.resourceControls.localMinecraftServerPolicy, 'rejected');
    assert.equal(localServerSummary.isolation.resourceControls.localMinecraftServerState, 'unverified_or_occupied');
    assert.deepEqual(localServerEvents, ['priority', 'local-server-policy']);
    assert.equal(localServerResourceLock.acquireOptions, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(armedOutput, { recursive: true, force: true });
    fs.rmSync(resourceOutput, { recursive: true, force: true });
    fs.rmSync(localServerOutput, { recursive: true, force: true });
  }
});

test('baseline preflight reports armed environment names without retaining values', () => {
  const secret = 'this-value-must-never-be-reported';
  const names = findArmedBaselineEnvironment({
    PATH: 'safe',
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_BASE_URL: 'https://provider.invalid',
    GITHUB_TOKEN: secret,
    JAVA_OPTS: '-Dcaller.injected=true',
    JDK_JAVA_OPTIONS: '-Dcaller.injected=true',
    AWS_SECRET_ACCESS_KEY: secret,
    AZURE_OPENAI_ENDPOINT: 'https://provider.invalid',
    GENERIC_API_URL: 'https://provider.invalid',
    MCBOT_LIVE_TESTS: '1',
    MCBOT_FABRIC_STRATEGY_SMOKE: '1',
    MCBOT_RCON_PASSWORD: secret,
    MCBOT_SCENARIO_GATE: 'armed',
    MCBOT_PLUGIN_SCENARIO_ID: 'fixture-a',
    MCBOT_USERNAME: 'fixture-bot',
    NODE_OPTIONS: '--inspect',
    Node_Options: '--trace-warnings',
    OPENAI_API_KEY: '',
    PROVIDER_API_KEY: secret,
    RCON_HOST: '127.0.0.1',
    RCON_PORT: '25575',
    npm_execpath: 'C:\\attacker\\npm-cli.js',
    NPM_CONFIG_REGISTRY: 'https://cache.invalid',
  });
  assert.deepEqual(names, [
    'AWS_SECRET_ACCESS_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'GENERIC_API_URL',
    'GITHUB_TOKEN',
    'JAVA_OPTS',
    'JDK_JAVA_OPTIONS',
    'MCBOT_FABRIC_STRATEGY_SMOKE',
    'MCBOT_LIVE_TESTS',
    'MCBOT_PLUGIN_SCENARIO_ID',
    'MCBOT_RCON_PASSWORD',
    'MCBOT_SCENARIO_GATE',
    'MCBOT_USERNAME',
    'NODE_OPTIONS',
    'Node_Options',
    'PROVIDER_API_KEY',
    'RCON_HOST',
    'RCON_PORT',
  ]);
  assert.equal(JSON.stringify(names).includes(secret), false);
});

test('baseline child environment propagates only the active lock identity and installs both Node guards', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot baseline child workspace-'));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-child-run-'));
  const incompleteRunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-child-incomplete-'));
  const scripts = path.join(workspace, 'scripts');
  const networkGuard = path.join(scripts, 'baseline-network-guard.cjs');
  const resourceLockBootstrap = path.join(scripts, 'resource-lock-bootstrap.js');
  try {
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(networkGuard, '// test fixture\n', 'utf8');
    fs.writeFileSync(resourceLockBootstrap, '// test fixture\n', 'utf8');
    const lockEnvironment = fakeResourceLockEnvironment();
    const sourceEnv = {
      PATH: process.env.PATH || '',
      NODE_OPTIONS: '--inspect=0.0.0.0:9229',
      JAVA_TOOL_OPTIONS: '-Dcaller.java-tool=true',
      _JAVA_OPTIONS: '-Dcaller.legacy-java=true',
      JDK_JAVA_OPTIONS: '-Dcaller.jdk=true',
      JAVA_OPTS: '-Dcaller.java-opts=true',
      GRADLE_OPTS: '-Dcaller.gradle=true',
      MCBOT_LIVE_TESTS: '1',
      MCBOT_RESOURCE_LOCK_OWNER_PID_EXTRA: 'attacker-controlled',
      ...lockEnvironment,
    };
    const child = createBaselineChildEnvironment(sourceEnv, workspace, runRoot);
    for (const [name, value] of Object.entries(lockEnvironment)) assert.equal(child[name], value);
    const bootstrapImportSpecifier = pathToFileURL(resourceLockBootstrap).href;
    assert.equal(child.NODE_OPTIONS, [
      `--require=${JSON.stringify(networkGuard)}`,
      `--import=${JSON.stringify(bootstrapImportSpecifier)}`,
      '--v8-pool-size=1',
    ].join(' '));
    assert.match(bootstrapImportSpecifier, /^file:/);
    assert.equal(bootstrapImportSpecifier.includes('%20'), true);
    if (process.platform === 'win32') assert.match(bootstrapImportSpecifier, /^file:\/\/\/[A-Za-z]:\//i);
    assert.equal(child.NODE_OPTIONS.includes(`--import=${JSON.stringify(resourceLockBootstrap)}`), false);
    assert.equal(child.NODE_OPTIONS.includes('--inspect'), false);
    for (const name of [
      'JAVA_TOOL_OPTIONS',
      '_JAVA_OPTIONS',
      'JDK_JAVA_OPTIONS',
      'JAVA_OPTS',
      'GRADLE_OPTS',
    ]) assert.equal(child[name], undefined);
    assert.equal(child.MCBOT_LIVE_TESTS, undefined);
    assert.equal(child.MCBOT_RESOURCE_LOCK_OWNER_PID_EXTRA, undefined);
    assert.equal(child.MCBOT_BASELINE, '1');

    const incomplete = { ...sourceEnv };
    delete incomplete[RESOURCE_LOCK_ENV.ownerPid];
    assert.throws(
      () => createBaselineChildEnvironment(incomplete, workspace, incompleteRunRoot),
      new RegExp(`resource-lock environment is incomplete \\(${RESOURCE_LOCK_ENV.ownerPid}\\)`),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(incompleteRunRoot, { recursive: true, force: true });
  }
});

test('nested baseline evaluator environments retain only the exact resource-lock join quartet', () => {
  const lockEnvironment = fakeResourceLockEnvironment();
  const nodeOptions = `--import=${JSON.stringify(pathToFileURL(RESOURCE_LOCK_BOOTSTRAP).href)} --v8-pool-size=1`;
  const sanitized = sanitizeBaselineEvaluatorEnvironment({
    PATH: process.env.PATH || '',
    NODE_OPTIONS: nodeOptions,
    UV_THREADPOOL_SIZE: '2',
    MCBOT_BASELINE: 'attacker-selected',
    MCBOT_RESOURCE_LOCK_OWNER_PID_EXTRA: 'lookalike-must-not-survive',
    MCBOT_ADVISOR_TOKEN: 'mcbot-secret-must-not-survive',
    DEEPSEEK_API_KEY: 'provider-secret-must-not-survive',
    AZURE_OPENAI_ENDPOINT: 'https://provider.invalid',
    GENERIC_API_URL: 'https://provider.invalid',
    PROVIDER_ENDPOINT: 'https://provider.invalid',
    RCON_HOST: '127.0.0.1',
    SOME_API_TOKEN: 'generic-secret-must-not-survive',
    ...lockEnvironment,
  });

  assert.equal(sanitized.NODE_OPTIONS, nodeOptions);
  assert.equal(sanitized.UV_THREADPOOL_SIZE, '2');
  for (const [name, value] of Object.entries(lockEnvironment)) assert.equal(sanitized[name], value);
  assert.deepEqual(
    Object.keys(sanitized).filter((name) => /^MCBOT_/i.test(name)).sort(),
    Object.values(RESOURCE_LOCK_ENV).sort(),
  );
  for (const name of [
    'MCBOT_BASELINE',
    'MCBOT_RESOURCE_LOCK_OWNER_PID_EXTRA',
    'MCBOT_ADVISOR_TOKEN',
    'DEEPSEEK_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'GENERIC_API_URL',
    'PROVIDER_ENDPOINT',
    'RCON_HOST',
    'SOME_API_TOKEN',
  ]) assert.equal(sanitized[name], undefined);

  const incomplete = { ...lockEnvironment };
  delete incomplete[RESOURCE_LOCK_ENV.ownerPid];
  assert.throws(
    () => sanitizeBaselineEvaluatorEnvironment(incomplete),
    /inherited MCBot resource-lock environment is incomplete/,
  );
  const standalone = sanitizeBaselineEvaluatorEnvironment({
    PATH: 'standalone-path',
    MCBOT_LIVE_TESTS: '1',
    AZURE_OPENAI_ENDPOINT: 'https://provider.invalid',
  });
  assert.deepEqual(standalone, { PATH: 'standalone-path' });

  const deterministicSource = fs.readFileSync(path.join(ROOT, 'scripts', 'deterministic-eval.js'), 'utf8');
  assert.match(deterministicSource, /sanitizeBaselineEvaluatorEnvironment\(process\.env\)/);
  const offlineRunnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'run-offline-tests.js'), 'utf8');
  assert.match(offlineRunnerSource, /pathToFileURL\(RESOURCE_LOCK_BOOTSTRAP\)\.href/);
  assert.match(offlineRunnerSource, /'--import',\s*\r?\n\s*RESOURCE_LOCK_BOOTSTRAP_URL/);
  const scriptsRoot = path.join(ROOT, 'scripts');
  const independentScrubbers = fs.readdirSync(scriptsRoot, { recursive: true })
    .map((name) => String(name))
    .filter((name) => /\.(?:c?js|mjs)$/.test(name))
    .filter((name) => {
      const source = fs.readFileSync(path.join(scriptsRoot, name), 'utf8');
      return /\^MCBOT_/.test(source) && /delete\s+\w+\[name\]/.test(source);
    })
    .map((name) => name.replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(independentScrubbers, ['baseline-evaluator-environment.js']);
});

test('baseline rejects user Gradle init and property injection points', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-gradle-home-'));
  try {
    assert.equal(verifyUserBuildConfiguration({ GRADLE_USER_HOME: home }).gradlePropertiesPresent, false);
    fs.writeFileSync(path.join(home, 'gradle.properties'), 'org.gradle.daemon=false\n', 'utf8');
    assert.throws(
      () => verifyUserBuildConfiguration({ GRADLE_USER_HOME: home }),
      /user Gradle properties are not permitted/,
    );
    fs.unlinkSync(path.join(home, 'gradle.properties'));
    fs.mkdirSync(path.join(home, 'init.d'));
    fs.writeFileSync(path.join(home, 'init.d', 'inject.gradle'), 'throw new Error("must not run")\n', 'utf8');
    assert.throws(
      () => verifyUserBuildConfiguration({ GRADLE_USER_HOME: home }),
      /user Gradle init scripts are not permitted/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('baseline version and count parsers accept the supported tool output shapes', () => {
  assert.equal(parseJavaMajor('openjdk version "21.0.11" 2026-04-21'), 21);
  assert.equal(parseJavaMajor('javac 21.0.8'), 21);
  assert.equal(parseJavaMajor('jar 21.0.8'), 21);
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor('not java output'), null);
  assert.equal(parseCheckedJavaScriptCount('check-js: ok (355 files checked)'), 355);
  assert.deepEqual(parseNodeTestSummary([
    '# tests 3', '# pass 3', '# fail 0', '# skipped 0', '# cancelled 0', '# todo 0', '# suites 1',
    '# tests 2', '# pass 1', '# fail 1', '# skipped 1', '# cancelled 1', '# todo 1', '# suites 1',
  ].join('\n')), {
    tests: 5,
    passed: 4,
    failed: 1,
    skipped: 1,
    cancelled: 1,
    todo: 1,
    suites: 2,
  });
});

test('root offline completion requires the file and test floors plus a complete pass', () => {
  const complete = {
    files: BASELINE_FLOORS.rootOfflineFiles,
    tests: BASELINE_FLOORS.rootOfflineTests,
    passed: BASELINE_FLOORS.rootOfflineTests,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  };
  assert.equal(rootOfflineMetricsPass(complete), true);
  assert.equal(rootOfflineMetricsPass({ ...complete, tests: complete.tests - 1, passed: complete.tests - 1 }), false);
  assert.equal(rootOfflineMetricsPass({ ...complete, passed: complete.passed - 1 }), false);
  assert.equal(rootOfflineMetricsPass({ ...complete, skipped: 1 }), false);
});

test('baseline command plan is sorted, offline-only, and includes every required layer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-plan-'));
  try {
    const brain = path.join(root, 'fabric-client', 'brain');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(path.join(root, 'test-harness-plugin'), { recursive: true });
    const lowImpactGradleLauncher = path.join(root, 'scripts', 'run-gradle-low-impact.ps1');
    fs.mkdirSync(path.dirname(lowImpactGradleLauncher), { recursive: true });
    fs.writeFileSync(lowImpactGradleLauncher, '# test fixture\n', 'utf8');
    for (const name of ['z.test.mjs', 'a.test.mjs', 'z.smoke.mjs', 'a.smoke.mjs']) {
      fs.writeFileSync(path.join(brain, name), '', 'utf8');
    }
    const plan = buildBaselineCommandPlan(root, {
      nodeExecutable: 'node-test',
      platform: 'linux',
      fixtureRoot: path.join(root, 'external-fixtures'),
      reportRoot: path.join(root, 'external-reports'),
      pwshExecutable: 'pwsh-test',
      env: { npm_execpath: '/attacker/npm-cli.js' },
      npmInvocation: {
        executable: 'node-test',
        prefixArgs: ['/trusted/node-installation/npm-cli.js'],
      },
    });
    assert.deepEqual(plan.map((step) => step.name), [
      'dependency-install',
      'check',
      'root-offline',
      'pathfinder-guard',
      'deterministic-eval',
      'response-capture-final',
      'fabric-brain-tests',
      'fabric-brain-smoke:a.smoke.mjs',
      'fabric-brain-smoke:z.smoke.mjs',
      'fabric-junit',
      'paper-test-build',
    ]);
    assert.deepEqual(plan[6].files, [
      path.join('fabric-client', 'brain', 'a.test.mjs'),
      path.join('fabric-client', 'brain', 'z.test.mjs'),
    ]);
    assert.deepEqual(plan[6].args, ['scripts/run-fabric-brain-tests.js']);
    assert.equal(plan.some((step) => step.name.includes('live:phase2')), false);
    assert.equal(plan[4].args.includes('--baseline'), true);
    assert.deepEqual(plan[4].args.slice(-4), [
      '--fixture-root',
      path.join(root, 'external-fixtures'),
      '--report-root',
      path.join(root, 'external-reports'),
    ]);
    assert.deepEqual(plan[5].args.slice(-4), [
      '--baseline-fixture-root',
      path.join(root, 'external-fixtures'),
      '--report-root',
      path.join(root, 'external-reports'),
    ]);
    assert.equal(plan[0].args[0], '/trusted/node-installation/npm-cli.js');
    assert.equal(plan[0].args.includes('/attacker/npm-cli.js'), false);
    assert.equal(plan[0].args.includes('--offline'), true);
    assert.equal(plan.at(-2).args.includes('--offline'), true);
    assert.equal(plan.at(-1).args.includes('--offline'), true);
    for (const [index, gradleStep] of plan.slice(-2).entries()) {
      assert.equal(
        gradleStep.args.filter((arg) => arg === '--dependency-verification=strict').length,
        1,
      );
      assert.equal(gradleStep.executable, 'pwsh-test');
      assert.equal(gradleStep.shell, false);
      assert.equal(gradleStep.cwdRelative, undefined);
      assert.equal(gradleStep.args.includes('--max-workers=1'), false);
      assert.equal(gradleStep.args.includes('--no-daemon'), false);
      assert.equal(gradleStep.args.includes('--parallel'), false);
      assert.deepEqual(gradleStep.args.slice(0, 9), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        lowImpactGradleLauncher,
        '-Project',
        index === 0 ? 'fabric-client' : 'test-harness-plugin',
      ]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm resolution accepts only the npm CLI declared by the Node installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-node-installation-'));
  try {
    const nodeExecutable = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    const npmRoot = path.join(root, 'node_modules', 'npm');
    const npmCli = path.join(npmRoot, 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(nodeExecutable, 'fixture node binary', 'utf8');
    fs.writeFileSync(npmCli, 'fixture npm cli', 'utf8');
    fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({
      name: 'npm',
      bin: { npm: 'bin/npm-cli.js' },
    }), 'utf8');

    const resolved = resolveTrustedNpmInvocation({ nodeExecutable, platform: 'win32' });
    assert.equal(resolved.executable, fs.realpathSync(nodeExecutable));
    assert.deepEqual(resolved.prefixArgs, [fs.realpathSync(npmCli)]);
    assert.equal(resolved.source, 'validated-node-installation');
    assert.match(resolved.cliSha256, /^[a-f0-9]{64}$/);

    fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({
      name: 'not-npm',
      bin: { npm: 'bin/npm-cli.js' },
    }), 'utf8');
    assert.throws(
      () => resolveTrustedNpmInvocation({ nodeExecutable, platform: 'win32' }),
      /validated npm CLI/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('baseline lowers its process priority before launching heavy descendants', () => {
  const calls = [];
  const result = applyLowImpactProcessPriority((pid, priority) => calls.push({ pid, priority }));
  assert.deepEqual(calls, [{ pid: 0, priority: os.constants.priority.PRIORITY_LOW }]);
  assert.equal(result.applied, true);
  assert.equal(result.class, 'idle');
  assert.equal(result.processorAffinity, null);
  assert.equal(result.gradleMaxWorkers, 1);
  assert.equal(result.advertisedProcessors, 2);
  assert.equal(result.javaGarbageCollector, 'serial');
  assert.equal(result.nodeThreadPoolSize, 2);
  assert.equal(result.forkJoinParallelism, 1);
  assert.throws(
    () => applyLowImpactProcessPriority(() => { throw new Error('denied'); }),
    /unable to lower baseline process priority/,
  );
});

test('baseline tool probes are registered, runtime-capped, bounded, and fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-tool-probe-'));
  const probeScript = path.join(root, 'run-tool-probe-low-impact.ps1');
  try {
    fs.writeFileSync(probeScript, '# deterministic fixture\n', 'utf8');
    const calls = [];
    const nodeResult = runLowImpactToolProbe({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', '--version'],
      env: { ...fakeResourceLockEnvironment(), PATH: process.env.PATH || '' },
      kind: 'node',
      label: 'npm version',
      platform: 'win32',
      probeScript,
      pwshExecutable: 'pwsh-fixture',
      repositoryRoot: root,
      spawnSyncImpl: (...args) => {
        calls.push(args);
        return { status: 0, stdout: '10.9.0\n', stderr: '' };
      },
    });
    assert.equal(nodeResult.status, 0);
    assert.equal(calls.length, 1);
    const [host, hostArgs, hostOptions] = calls[0];
    assert.equal(host, 'pwsh-fixture');
    assert.deepEqual(hostArgs.slice(0, 7), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probeScript,
    ]);
    assert.equal(hostArgs[hostArgs.indexOf('-Kind') + 1], 'node');
    assert.equal(hostArgs[hostArgs.indexOf('-WorkingDirectory') + 1], root);
    assert.equal(hostArgs[hostArgs.indexOf('-TimeoutMilliseconds') + 1], '10000');
    assert.equal(hostArgs[hostArgs.indexOf('-MaxCaptureBytes') + 1], String(8 * 1024 * 1024));
    const encodedArgs = hostArgs[hostArgs.indexOf('-ArgumentsBase64') + 1];
    assert.deepEqual(JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8')), [
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', '--version',
    ]);
    assert.equal(hostOptions.env.NODE_OPTIONS, '--v8-pool-size=1');
    assert.equal(hostOptions.env.UV_THREADPOOL_SIZE, '2');
    assert.equal(hostOptions.timeout, 30_000);
    assert.equal(hostOptions.killSignal, 'SIGKILL');

    const jdkCalls = [];
    runLowImpactToolProbe({
      executable: 'C:\\jdk\\bin\\java.exe',
      args: ['-version'],
      env: { ...fakeResourceLockEnvironment(), PATH: process.env.PATH || '' },
      kind: 'jdk',
      label: 'java version',
      platform: 'win32',
      probeScript,
      repositoryRoot: root,
      spawnSyncImpl: (...args) => {
        jdkCalls.push(args);
        return { status: 0, stdout: '', stderr: 'openjdk version "21"\n' };
      },
    });
    assert.equal(jdkCalls[0][1][jdkCalls[0][1].indexOf('-Kind') + 1], 'jdk');
    assert.equal(jdkCalls[0][2].env.JAVA_TOOL_OPTIONS, undefined);
    assert.throws(
      () => runLowImpactToolProbe({
        executable: process.execPath,
        args: ['--version'],
        env: { ...fakeResourceLockEnvironment(), NODE_OPTIONS: '--inspect' },
        kind: 'node',
        platform: 'win32',
        probeScript,
        repositoryRoot: root,
      }),
      /refuses caller-supplied runtime options/,
    );
    assert.throws(
      () => runLowImpactToolProbe({
        executable: 'git',
        args: ['--version'],
        env: fakeResourceLockEnvironment(),
        kind: 'native',
        label: 'git version',
        platform: 'win32',
        probeScript,
        repositoryRoot: root,
        spawnSyncImpl: () => ({
          status: null,
          signal: 'SIGKILL',
          error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
        }),
      }),
      /bounded low-impact git version probe timed out/,
    );

    const versionCalls = [];
    const versions = collectToolVersions(ROOT, { JAVA_HOME: 'C:\\jdk' }, {
      executable: process.execPath,
      prefixArgs: ['C:\\node\\npm-cli.js'],
      source: 'unit-fixture',
      cliSha256: 'a'.repeat(64),
    }, {
      runProbe: (request) => {
        versionCalls.push(request);
        const outputs = {
          'git version': 'git version 2.50.0\n',
          'npm version': '10.9.0\n',
          'java version': 'Picked up JAVA_TOOL_OPTIONS: capped\nopenjdk version "21.0.8"\n',
          'jar version': 'jar 21.0.8\n',
          'javac version': 'javac 21.0.8\n',
        };
        return { status: 0, stdout: outputs[request.label] || '', stderr: '' };
      },
    });
    assert.deepEqual(versionCalls.map(({ label, kind }) => [label, kind]), [
      ['git version', 'native'],
      ['npm version', 'node'],
      ['java version', 'jdk'],
      ['jar version', 'jdk'],
      ['javac version', 'jdk'],
    ]);
    assert.equal(versions.java.major, 21);
    assert.equal(versions.jar.major, 21);
    assert.equal(versions.javac.major, 21);

    const jarCalls = [];
    assert.equal(jarContainsPluginYaml('C:\\jdk\\bin\\jar.exe', 'C:\\out\\plugin.jar', {
      repositoryRoot: root,
      runProbe: (request) => {
        jarCalls.push(request);
        return { status: 0, stdout: 'META-INF/MANIFEST.MF\nplugin.yml\n', stderr: '' };
      },
    }), true);
    assert.equal(jarCalls[0].kind, 'jdk');
    assert.deepEqual(jarCalls[0].args, ['tf', 'C:\\out\\plugin.jar']);

    const hooksDirectory = path.join(root, 'empty-git-hooks');
    fs.mkdirSync(hooksDirectory);
    const gitCalls = [];
    const gitResult = runRegisteredGitCommand(root, ['diff', '--name-only', '-z'], {
      repositoryRoot: root,
      hooksDirectory,
      env: { ...fakeResourceLockEnvironment(), PATH: process.env.PATH || '' },
      platform: 'win32',
      timeoutMs: 1_000,
      runProbe: (request) => {
        gitCalls.push(request);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(gitResult.status, 0);
    assert.equal(gitCalls.length, 1);
    assert.equal(gitCalls[0].kind, 'native');
    assert.equal(gitCalls[0].platform, 'win32');
    assert.equal(gitCalls[0].workingDirectory, root);
    assert.equal(gitCalls[0].timeoutMs, 1_000);
    assert.equal(gitCalls[0].wrapperTimeoutMs, 16_000);
    assert.deepEqual(gitCalls[0].args.slice(0, 2), ['--no-pager', '--no-optional-locks']);
    assert.equal(gitCalls[0].args.includes(`core.hooksPath=${fs.realpathSync(hooksDirectory)}`), true);
    assert.equal(gitCalls[0].args.includes('core.fsmonitor=false'), true);
    assert.equal(gitCalls[0].args.includes('maintenance.auto=false'), true);
    assert.equal(gitCalls[0].args.includes('gc.auto=0'), true);
    assert.deepEqual(gitCalls[0].args.slice(-5), [
      'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z',
    ]);
    assert.throws(
      () => runRegisteredGitCommand(root, ['status', '--porcelain=v1'], {
        repositoryRoot: root,
        hooksDirectory,
        env: fakeResourceLockEnvironment(),
        platform: 'linux',
        runProbe: () => assert.fail('unsupported registered Git must fail before launch'),
      }),
      /requires Windows Job process-tree containment/,
    );

    const helperSource = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tool-probe-low-impact.ps1'), 'utf8');
    const relaySource = fs.readFileSync(path.join(ROOT, 'scripts', 'bounded-tool-probe-relay.ps1'), 'utf8');
    assert.match(helperSource, /Start-McbotRegisteredWorkloadProcess/);
    assert.match(helperSource, /New-Item -ItemType File -Path \$readyPath/);
    assert.ok(helperSource.indexOf('Start-McbotRegisteredWorkloadProcess') < helperSource.indexOf('New-Item -ItemType File -Path $readyPath'));
    assert.match(helperSource, /\.WaitForExit\(\$TimeoutMilliseconds\)/);
    assert.match(helperSource, /-CaptureOutput/);
    assert.match(helperSource, /StandardOutputTask\.Wait\(2000\)/);
    assert.match(helperSource, /StandardErrorTask\.Wait\(2000\)/);
    assert.match(helperSource, /-XX:\+UseSerialGC -XX:ActiveProcessorCount=2 -XX:CICompilerCount=2/);
    assert.match(helperSource, /NODE_OPTIONS -cne '--v8-pool-size=1'/);
    assert.match(helperSource, /-WorkingDirectory \$resolvedWorkingDirectory/);
    assert.match(relaySource, /timed out waiting for its containment gate/);
    assert.match(relaySource, /PriorityClass -ne \[Diagnostics\.ProcessPriorityClass\]::Idle/);
    assert.match(relaySource, /RedirectStandardOutput = \$true/);
    assert.match(relaySource, /RedirectStandardError = \$true/);
    assert.match(relaySource, /StandardOutput\.BaseStream/);
    assert.match(relaySource, /StandardError\.BaseStream/);
    assert.equal((relaySource.match(/\.ReadAsync\(/g) || []).length, 4);
    assert.match(relaySource, /stdoutCapture\.Length \+ \$stderrCapture\.Length \+ \$readCount/);
    assert.match(relaySource, /rejected output above \$MaxCaptureBytes bytes/);
    assert.match(relaySource, /UTF8Encoding\]::new\(\$false, \$true\)/);
    assert.match(relaySource, /GetCharCount\(\$capturedStdout\)/);
    assert.match(relaySource, /MCBOT_TOOL_PROBE_STDOUT_V1:/);
    assert.ok(relaySource.indexOf('MCBOT_TOOL_PROBE_STDOUT_V1:') < relaySource.indexOf('$toolProcess.Start()'));
    assert.match(helperSource, /StartsWith\(\$stdoutFramePrefix, \[StringComparison\]::Ordinal\)/);
    assert.match(helperSource, /Substring\(\$stdoutFramePrefix\.Length\)/);
    assert.match(helperSource, /GetBytes\(\$capturedStdout\)/);
    assert.match(helperSource, /\$capturedStdoutBytes\.Length \+ \$capturedStderrBytes\.Length/);
    assert.match(helperSource, /OpenStandardOutput\(\)/);
    assert.match(relaySource, /\$toolStart\.ArgumentList\.Add/);
    assert.ok(relaySource.indexOf('PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle') < relaySource.indexOf('$toolProcess.Start()'));
    assert.doesNotMatch(relaySource, /\.ReadToEnd(?:Async)?\s*\(|\|\s*ForEach-Object|&\s+\$toolPath/);
    const runnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'baseline-runner.js'), 'utf8');
    assert.match(runnerSource, /maxBuffer:\s*MAX_TOOL_PROBE_CAPTURE_BYTES/);
    assert.equal((runnerSource.match(/repositoryRoot: summary\.repository\.root/g) || []).length, 2);
    assert.match(runnerSource, /function runGitCommand/);
    assert.match(runnerSource, /export function runRegisteredGitCommand/);
    assert.match(runnerSource, /core\.hooksPath=/);
    assert.match(runnerSource, /core\.fsmonitor=false/);
    assert.match(runnerSource, /maintenance\.auto=false/);
    assert.match(runnerSource, /runGitCommand\([\s\S]*GIT_WORKTREE_TIMEOUT_MS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows registered tool probe preserves both streams and rejects output above its shared cap', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, () => {
  const probeEnv = { ...process.env };
  const refusedRuntimeOptions = new Set([
    'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS',
  ]);
  for (const name of Object.keys(probeEnv)) {
    if (refusedRuntimeOptions.has(name.toUpperCase())) delete probeEnv[name];
  }

  const policyCommand = [
    '$self = [Diagnostics.Process]::GetCurrentProcess()',
    '$self.Refresh()',
    "$record = [ordered]@{ priorityClass = [string]$self.PriorityClass; processorAffinity = ('0x{0:x}' -f $self.ProcessorAffinity.ToInt64()) }",
    '[Console]::Out.Write(($record | ConvertTo-Json -Compress))',
    "[Console]::Error.Write('registered-stderr')",
  ].join('; ');
  const preserved = runLowImpactToolProbe({
    executable: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', policyCommand],
    env: probeEnv,
    kind: 'native',
    label: 'runtime stream preservation',
    repositoryRoot: ROOT,
    timeoutMs: 5_000,
    wrapperTimeoutMs: 15_000,
  });
  assert.equal(preserved.status, 0, preserved.stderr || preserved.stdout);
  const policy = JSON.parse(preserved.stdout);
  const affinity = BigInt(policy.processorAffinity);
  assert.equal(policy.priorityClass, 'Idle');
  assert.ok(affinity > 0n && (affinity & (affinity - 1n)) === 0n);
  assert.equal(preserved.stderr, 'registered-stderr');

  const exactBoundary = runLowImpactToolProbe({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('\\uFEFF' + 'é'.repeat(16382) + 'a'); process.stderr.write('界'.repeat(10922) + 'ab');"],
    env: probeEnv,
    kind: 'node',
    label: 'runtime exact shared capture boundary',
    repositoryRoot: ROOT,
    timeoutMs: 5_000,
    wrapperTimeoutMs: 15_000,
    captureLimitBytes: 64 * 1024,
  });
  assert.equal(exactBoundary.status, 0, exactBoundary.stderr || exactBoundary.stdout);
  assert.equal(Buffer.byteLength(exactBoundary.stdout, 'utf8'), 32 * 1024);
  assert.equal(Buffer.byteLength(exactBoundary.stderr, 'utf8'), 32 * 1024);
  assert.equal(exactBoundary.stdout, `\uFEFF${'é'.repeat(16382)}a`);
  assert.equal(exactBoundary.stderr, `${'界'.repeat(10922)}ab`);

  const rejected = runLowImpactToolProbe({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('LEAK_SENTINEL_ALPHA'.padEnd(512, 'A')); process.stderr.write('LEAK_SENTINEL_BETA'.padEnd(513, 'B'));"],
    env: probeEnv,
    kind: 'node',
    label: 'runtime shared capture cap',
    repositoryRoot: ROOT,
    timeoutMs: 5_000,
    wrapperTimeoutMs: 15_000,
    captureLimitBytes: 1024,
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /rejected output above 1024 bytes/);
  assert.doesNotMatch(rejected.stderr, /LEAK_SENTINEL/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-tool-probe-timeout-'));
  const sleeperPath = path.join(temp, 'sleeper.ps1');
  const receiptPath = path.join(temp, 'process.json');
  fs.writeFileSync(sleeperPath, String.raw`param([Parameter(Mandatory = $true)][string]$ReceiptPath)
$self = [Diagnostics.Process]::GetCurrentProcess()
$record = [ordered]@{
  pid = [int]$self.Id
  startTimeUtcTicks = [string]$self.StartTime.ToUniversalTime().Ticks
}
[IO.File]::WriteAllText($ReceiptPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[Threading.Thread]::Sleep(20000)
`, 'utf8');
  const lockPath = probeEnv[RESOURCE_LOCK_ENV.path];
  assert.ok(lockPath && fs.statSync(lockPath).isDirectory());
  const receiptSnapshot = () => Object.fromEntries((
    lockPath && fs.existsSync(lockPath)
      ? fs.readdirSync(lockPath).filter((name) => /^workload-child-.*\.json$/.test(name)).sort()
      : []
  ).map((name) => [name, fs.readFileSync(path.join(lockPath, name), 'utf8')]));
  const receiptsBefore = receiptSnapshot();
  try {
    const timedOut = runLowImpactToolProbe({
      executable: 'pwsh',
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', sleeperPath, '-ReceiptPath', receiptPath,
      ],
      env: probeEnv,
      kind: 'native',
      label: 'runtime timeout cleanup',
      repositoryRoot: ROOT,
      timeoutMs: 1_200,
      wrapperTimeoutMs: 12_000,
    });
    assert.notEqual(timedOut.status, 0);
    assert.match(timedOut.stderr, /timed out after 1200 milliseconds/);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const exactIdentity = `windows-start-ticks:${receipt.startTimeUtcTicks}`;
    const observed = getProcessStartIdentity(receipt.pid);
    assert.notEqual(observed.state, 'unknown');
    assert.ok(observed.state === 'absent' || (observed.state === 'running' && observed.identity !== exactIdentity));
    assert.deepEqual(receiptSnapshot(), receiptsBefore);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('baseline tree cleanup revalidates exact child start identity before every termination request', () => {
  const child = { pid: 42_424 };
  const captured = captureBaselineChildProcessIdentity(child, {
    platform: 'win32',
    parentPid: 10_101,
    inspectProcess: () => ({
      state: 'running',
      identity: 'windows-start-ticks:638605728000000000',
      parentPid: 10_101,
    }),
  });
  assert.deepEqual(captured, {
    state: 'captured',
    pid: 42_424,
    processStartIdentity: 'windows-start-ticks:638605728000000000',
    parentPid: 10_101,
  });
  assert.equal(Object.isFrozen(captured), true);

  const killCalls = [];
  const terminatorPath = 'C:\\repo\\scripts\\terminate-baseline-process-tree.ps1';
  const matched = terminateBaselineProcessTree(child, captured, true, {
    platform: 'win32',
    terminatorPath,
    inspectProcess: () => ({
      state: 'running',
      identity: captured.processStartIdentity,
      parentPid: captured.parentPid,
    }),
    spawnSyncImpl: (...args) => {
      killCalls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(matched, {
    attempted: true,
    force: true,
    state: 'requested',
    reason: 'validated_tree_termination_requested',
  });
  assert.deepEqual(killCalls, [[
    'pwsh',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', terminatorPath,
      '-ProcessId', '42424',
      '-StartTimeUtcTicks', '638605728000000000',
      '-ParentProcessId', '10101',
      '-WaitMilliseconds', '5000',
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    },
  ]]);

  for (const [observation, reason] of [
    [{ state: 'running', identity: 'windows-start-ticks:638605728000000001', parentPid: 10_101 }, 'child_pid_reused'],
    [{ state: 'running', identity: captured.processStartIdentity, parentPid: 20_202 }, 'child_parent_identity_changed'],
    [{ state: 'unknown' }, 'child_start_identity_unverifiable'],
  ]) {
    const refused = terminateBaselineProcessTree(child, captured, false, {
      platform: 'win32',
      terminatorPath,
      inspectProcess: () => observation,
      spawnSyncImpl: (...args) => {
        killCalls.push(args);
        return { status: 0 };
      },
    });
    assert.equal(refused.attempted, false);
    assert.equal(refused.state, 'refused');
    assert.equal(refused.reason, reason);
  }
  const exitedBeforeClose = terminateBaselineProcessTree(child, captured, true, {
    platform: 'win32',
    terminatorPath,
    inspectProcess: () => ({ state: 'absent' }),
    spawnSyncImpl: (...args) => {
      killCalls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(exitedBeforeClose, {
    attempted: false,
    force: true,
    safeToTerminate: false,
    state: 'already_exited',
    reason: 'captured_child_is_absent',
  });
  assert.equal(killCalls.length, 1);

  const helperRefusal = terminateBaselineProcessTree(child, captured, true, {
    platform: 'win32',
    terminatorPath,
    inspectProcess: () => ({
      state: 'running',
      identity: captured.processStartIdentity,
      parentPid: captured.parentPid,
    }),
    spawnSyncImpl: (...args) => {
      killCalls.push(args);
      return { status: 11 };
    },
  });
  assert.equal(helperRefusal.attempted, false);
  assert.equal(helperRefusal.state, 'refused');
  assert.equal(helperRefusal.reason, 'validated_child_identity_changed_in_terminator');

  const changedChild = validateBaselineChildProcessIdentity({ pid: 42_425 }, captured, {
    platform: 'win32',
    inspectProcess: () => {
      throw new Error('must refuse before inspection');
    },
  });
  assert.deepEqual(changedChild, {
    safeToTerminate: false,
    state: 'refused',
    reason: 'captured_child_identity_missing_or_changed',
  });
  const wrongParentAtCapture = captureBaselineChildProcessIdentity(child, {
    platform: 'win32',
    parentPid: 10_101,
    inspectProcess: () => ({
      state: 'running',
      identity: 'windows-start-ticks:638605728000000000',
      parentPid: 20_202,
    }),
  });
  assert.equal(wrongParentAtCapture.state, 'unverifiable');
  assert.equal(wrongParentAtCapture.reason, 'child_parent_identity_mismatch');

  const runnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'baseline-runner.js'), 'utf8');
  const terminatorSource = fs.readFileSync(path.join(ROOT, 'scripts', 'terminate-baseline-process-tree.ps1'), 'utf8');
  assert.doesNotMatch(runnerSource, /taskkill\.exe/i);
  assert.match(runnerSource, /terminated baseline child did not close within the bounded cleanup window/);
  assert.match(
    terminatorSource,
    /\$targetHandle = \$target\.Handle[\s\S]*\$target\.StartTime[\s\S]*\$target\.Kill\(\$true\)[\s\S]*\$target\.WaitForExit\(\$WaitMilliseconds\)/,
  );
});

test('Gradle invocation chooses gradlew.bat only on Windows', () => {
  const windows = resolveGradleInvocation('C:\\repo\\fabric-client', 'win32');
  const linux = resolveGradleInvocation('/repo/fabric-client', 'linux');
  assert.match(windows.executable, /(?:cmd\.exe|cmd)$/i);
  assert.equal(windows.prefixArgs.at(-1), 'gradlew.bat');
  assert.equal(windows.shell, false);
  assert.equal(linux.executable, 'bash');
  assert.match(linux.prefixArgs[0], /gradlew$/);
});

test('low-impact Gradle invocation delegates only approved projects to the PowerShell resource wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-low-impact-gradle-'));
  const script = path.join(root, 'scripts', 'run-gradle-low-impact.ps1');
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '# test fixture\n', 'utf8');
    assert.deepEqual(resolveLowImpactGradleInvocation(root, 'fabric-client', {
      pwshExecutable: 'pwsh-fixture',
    }), {
      executable: 'pwsh-fixture',
      prefixArgs: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Project',
        'fabric-client',
      ],
      shell: false,
    });
    assert.throws(
      () => resolveLowImpactGradleInvocation(root, 'unapproved-project'),
      /unsupported low-impact Gradle project/,
    );
    fs.unlinkSync(script);
    assert.throws(
      () => resolveLowImpactGradleInvocation(root, 'test-harness-plugin'),
      /low-impact Gradle launcher is missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows Gradle wrapper invocation works from a project path containing spaces', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot baseline wrapper '));
  try {
    fs.writeFileSync(path.join(root, 'gradlew.bat'), [
      '@echo off',
      'if "%1"=="marker" exit /b 0',
      'exit /b 2',
      '',
    ].join('\r\n'), 'utf8');
    const invocation = resolveGradleInvocation(root, 'win32');
    const result = spawnSync(invocation.executable, [...invocation.prefixArgs, 'marker'], {
      cwd: root,
      encoding: 'utf8',
      shell: invocation.shell,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git status failures cannot be mistaken for a clean worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-not-git-'));
  try {
    assert.throws(() => readGitStatus(root), /git status failed|not a git repository/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture manifest verifies sanitized JSON and fails closed on drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-fixtures-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-fixtures-external-'));
  const linkedDirectory = path.join(root, 'data', 'linked');
  try {
    const fixtureRelative = 'data/fixture.json';
    const fixture = path.join(root, fixtureRelative);
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, '{"safe":true}\n', 'utf8');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: fixtureRelative, sha256: digest, sanitized: true }],
    }), 'utf8');
    assert.equal(verifyFixtureManifest(root, 'manifest.json').files[0].sha256, digest);
    fs.writeFileSync(fixture, '{"safe":false}\n', 'utf8');
    assert.throws(() => verifyFixtureManifest(root, 'manifest.json'), /digest mismatch/);

    fs.writeFileSync(fixture, '{"apiKey":"must-not-pass"}\n', 'utf8');
    const unsafeDigest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: fixtureRelative, sha256: unsafeDigest, sanitized: true }],
    }), 'utf8');
    assert.throws(() => verifyFixtureManifest(root, 'manifest.json'), /credential-shaped field/);

    const secretLeaf = 'sk-private-fixture-token-value';
    fs.writeFileSync(fixture, `${JSON.stringify({ benignNote: secretLeaf })}\n`, 'utf8');
    const secretLeafDigest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: fixtureRelative, sha256: secretLeafDigest, sanitized: true }],
    }), 'utf8');
    assert.throws(
      () => verifyFixtureManifest(root, 'manifest.json'),
      (error) => /forbidden secret or provider payload/.test(error.message)
        && !error.message.includes(secretLeaf),
    );

    const providerLeaf = '{"choices":[{"message":{"content":"private completion"}}]}';
    fs.writeFileSync(fixture, `${JSON.stringify({ benignNote: providerLeaf })}\n`, 'utf8');
    const providerLeafDigest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: fixtureRelative, sha256: providerLeafDigest, sanitized: true }],
    }), 'utf8');
    assert.throws(
      () => verifyFixtureManifest(root, 'manifest.json'),
      (error) => /forbidden secret or provider payload/.test(error.message)
        && !error.message.includes(providerLeaf),
    );

    fs.writeFileSync(fixture, '{"safe":true}\n', 'utf8');
    const safeDigest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'data/../data/fixture.json', sha256: safeDigest, sanitized: true }],
    }), 'utf8');
    assert.throws(() => verifyFixtureManifest(root, 'manifest.json'), /path is not canonical/);

    const externalFixture = path.join(external, 'fixture.json');
    fs.writeFileSync(externalFixture, '{"safe":true}\n', 'utf8');
    fs.symlinkSync(external, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'data/linked/fixture.json', sha256: safeDigest, sanitized: true }],
    }), 'utf8');
    assert.throws(() => verifyFixtureManifest(root, 'manifest.json'), /reparse link|redirected filesystem path|outside the repository/);
    fs.unlinkSync(linkedDirectory);
  } finally {
    if (fs.lstatSync(linkedDirectory, { throwIfNoEntry: false })) fs.unlinkSync(linkedDirectory);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('checked-in baseline fixture manifest is intact and meets discovery floors', () => {
  const verified = verifyFixtureManifest(ROOT);
  assert.equal(verified.files.length, BASELINE_FIXTURE_PATHS.length);
  assert.ok(fs.readdirSync(path.join(ROOT, 'test', 'offline')).filter((name) => name.endsWith('.test.js')).length >= BASELINE_FLOORS.rootOfflineFiles);
  assert.equal(fs.readdirSync(path.join(ROOT, 'fabric-client', 'brain')).filter((name) => name.endsWith('.test.mjs')).length, 9);
  assert.equal(fs.readdirSync(path.join(ROOT, 'fabric-client', 'brain')).filter((name) => name.endsWith('.smoke.mjs')).length, 2);
});

test('baseline stages exactly the pinned fixtures and detects copied or source drift before evaluation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-stage-source-'));
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-stage-copy-'));
  const stagedRoot = path.join(stageParent, 'fixtures');
  try {
    const records = [];
    for (const [index, relativePath] of BASELINE_FIXTURE_PATHS.entries()) {
      const fixturePath = path.join(root, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, `${JSON.stringify({ fixture: index, safe: true })}\n`, 'utf8');
      records.push({
        path: relativePath,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),
        sanitized: true,
      });
    }
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'baseline-fixtures.json'), JSON.stringify({
      schemaVersion: 1,
      files: records,
    }), 'utf8');

    const staged = stageBaselineFixtures(root, stagedRoot);
    assert.equal(staged.fileCount, BASELINE_FIXTURE_PATHS.length);
    assert.deepEqual(staged.files.map((entry) => entry.path).sort(), [...BASELINE_FIXTURE_PATHS].sort());
    assert.equal(staged.files.every((entry) => entry.sourceSha256 === entry.copiedSha256), true);

    const copiedPath = path.join(stagedRoot, ...BASELINE_FIXTURE_PATHS[0].split('/'));
    fs.writeFileSync(copiedPath, '{"safe":false}\n', 'utf8');
    assert.throws(() => verifyStagedFixtureSet(stagedRoot, staged), /staged fixture digest mismatch/);
    fs.writeFileSync(copiedPath, fs.readFileSync(path.join(root, ...BASELINE_FIXTURE_PATHS[0].split('/'))));
    fs.unlinkSync(copiedPath);
    assert.throws(() => verifyStagedFixtureSet(stagedRoot, staged), /required public fixture set/);

    const sourcePath = path.join(root, ...BASELINE_FIXTURE_PATHS[0].split('/'));
    fs.writeFileSync(sourcePath, '{"safe":false}\n', 'utf8');
    assert.throws(
      () => stageBaselineFixtures(root, path.join(stageParent, 'altered-source')),
      /fixture digest mismatch/,
    );
    fs.unlinkSync(sourcePath);
    assert.throws(
      () => stageBaselineFixtures(root, path.join(stageParent, 'missing-source')),
      /does not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
});

test('baseline fixture evaluator materially consumes every staged public fixture', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-fixture-consumption-'));
  const fixtureRoot = path.join(outputRoot, 'fixtures');
  const reportRoot = path.join(outputRoot, 'reports');
  try {
    stageBaselineFixtures(ROOT, fixtureRoot);
    fs.mkdirSync(reportRoot);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'baseline-fixture-eval.js'),
      '--fixture-root',
      fixtureRoot,
      '--report-root',
      reportRoot,
    ], {
      cwd: ROOT,
      env: baselineTestEnvironment(),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(path.join(reportRoot, 'baseline-fixture-eval.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.deepEqual(report.fixtures.map((entry) => entry.path), BASELINE_FIXTURE_PATHS);
    assert.equal(report.fixtures.every((entry) => (
      entry.materiallyConsumed === true
      && /^[a-f0-9]{64}$/.test(entry.sha256)
      && /^[a-f0-9]{64}$/.test(entry.semanticSha256)
      && entry.recordCount > 0
    )), true);
    assert.equal(report.linkage.exactFixtureCoverage, true);
    assert.equal(report.linkage.stagedFixtureCount, BASELINE_FIXTURE_PATHS.length);
    assert.equal(report.linkage.materiallyConsumedCount, BASELINE_FIXTURE_PATHS.length);
    assert.equal(report.inputBoundary.checkoutReportsReadable, false);
    assert.equal(report.inputBoundary.sourceReportRead, false);

    const baselineSemanticHashes = report.fixtures.map((entry) => entry.semanticSha256);
    const validMutations = [{
      path: BASELINE_FIXTURE_PATHS[0],
      apply(value) {
        value.fixtures[0].goal = `${value.fixtures[0].goal} safely`;
      },
    }];
    for (const [index, mutation] of validMutations.entries()) {
      const alteredFixtureRoot = path.join(outputRoot, `semantic-fixtures-${index}`);
      fs.cpSync(fixtureRoot, alteredFixtureRoot, { recursive: true });
      const fixturePath = path.join(alteredFixtureRoot, ...mutation.path.split('/'));
      const value = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      mutation.apply(value);
      fs.writeFileSync(fixturePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      const altered = evaluateBaselineFixtureSet(alteredFixtureRoot, ROOT);
      assert.notEqual(altered.fixtures[index].semanticSha256, baselineSemanticHashes[index]);
      assert.equal(altered.fixtures[index].materiallyConsumed, true);
    }

    const mutations = [{
      path: BASELINE_FIXTURE_PATHS[0],
      apply(value, marker) {
        value.fixtures[0].id = marker;
        value.fixtures[1].id = marker;
      },
    }];
    for (const [index, mutation] of mutations.entries()) {
      const alteredFixtureRoot = path.join(outputRoot, `altered-fixtures-${index}`);
      const alteredReportRoot = path.join(outputRoot, `altered-reports-${index}`);
      fs.cpSync(fixtureRoot, alteredFixtureRoot, { recursive: true });
      fs.mkdirSync(alteredReportRoot);
      const fixturePath = path.join(alteredFixtureRoot, ...mutation.path.split('/'));
      const value = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const marker = `invalid-fixture-marker-${index}`;
      mutation.apply(value, marker);
      fs.writeFileSync(fixturePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      const altered = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'baseline-fixture-eval.js'),
        '--fixture-root',
        alteredFixtureRoot,
        '--report-root',
        alteredReportRoot,
      ], {
        cwd: ROOT,
        env: baselineTestEnvironment(),
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.notEqual(altered.status, 0);
      assert.doesNotMatch(`${altered.stdout}\n${altered.stderr}`, new RegExp(marker));
      assert.deepEqual(fs.readdirSync(alteredReportRoot), []);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('baseline deterministic evaluation ignores stale checkout reports and chains only fresh external reports', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-eval-boundary-'));
  const fixtureRoot = path.join(outputRoot, 'fixtures');
  const reportRoot = path.join(outputRoot, 'generated-reports');
  try {
    stageBaselineFixtures(ROOT, fixtureRoot);
    fs.mkdirSync(reportRoot);
    const checkoutReportsBefore = [...captureReportState(ROOT).entries()];
    const checkoutBoundary = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'deterministic-eval.js'),
      '--baseline',
      '--fixture-root',
      fixtureRoot,
      '--report-root',
      path.join(ROOT, 'reports'),
    ], {
      cwd: ROOT,
      env: baselineTestEnvironment(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.notEqual(checkoutBoundary.status, 0);
    assert.match(`${checkoutBoundary.stdout}\n${checkoutBoundary.stderr}`, /must be outside the checkout/);
    assert.deepEqual([...captureReportState(ROOT).entries()], checkoutReportsBefore);

    const inheritedLockEntryCount = Object.values(RESOURCE_LOCK_ENV)
      .filter((name) => process.env[name] !== undefined).length;
    assert.equal(inheritedLockEntryCount === 0 || inheritedLockEntryCount === 4, true);
    let ownedNestedJoinLease = null;
    if (inheritedLockEntryCount === 0) {
      ownedNestedJoinLease = acquireOrJoinResourceLockSync({
        repositoryRoot: ROOT,
        purpose: 'baseline-nested-eval-test',
        env: process.env,
        waitMs: 0,
        automaticCleanup: false,
      });
    }
    let result;
    try {
      const expectedLockEnvironment = Object.fromEntries(
        Object.values(RESOURCE_LOCK_ENV).map((name) => [name, process.env[name]]),
      );
      const productionEnvironment = createBaselineChildEnvironment({
        ...process.env,
        MCBOT_BASELINE_REPORT_ROOT: 'caller-value-must-not-survive',
        MCBOT_RESOURCE_LOCK_OWNER_PID_EXTRA: 'lookalike-must-not-survive',
        MCBOT_ADVISOR_TOKEN: 'mcbot-secret-must-not-survive',
        DEEPSEEK_API_KEY: 'provider-secret-must-not-survive',
        AZURE_OPENAI_ENDPOINT: 'https://provider.invalid',
        GENERIC_API_URL: 'https://provider.invalid',
      }, ROOT, path.join(outputRoot, 'production-child-environment'));
      for (const [name, value] of Object.entries(expectedLockEnvironment)) {
        assert.equal(productionEnvironment[name], value);
      }
      assert.deepEqual(
        Object.keys(productionEnvironment).filter((name) => /^MCBOT_/i.test(name)).sort(),
        [...Object.values(RESOURCE_LOCK_ENV), 'MCBOT_BASELINE'].sort(),
      );
      assert.equal(
        productionEnvironment.NODE_OPTIONS.includes(
          `--import=${JSON.stringify(pathToFileURL(RESOURCE_LOCK_BOOTSTRAP).href)}`,
        ),
        true,
      );
      for (const name of ['DEEPSEEK_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'GENERIC_API_URL']) {
        assert.equal(productionEnvironment[name], undefined);
      }
      result = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'deterministic-eval.js'),
        '--baseline',
        '--fixture-root',
        fixtureRoot,
        '--report-root',
        reportRoot,
      ], {
        cwd: ROOT,
        env: productionEnvironment,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } finally {
      if (ownedNestedJoinLease) ownedNestedJoinLease.releaseSync();
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const generated = fs.readdirSync(reportRoot).sort();
    assert.deepEqual(generated, [
      'advisor-dry-run.json',
      'advisor-dry-run.md',
      'advisor-first-call-replay.json',
      'advisor-first-call-replay.md',
      'advisor-first-call.json',
      'advisor-first-call.md',
      'baseline-fixture-eval.json',
      'baseline-fixture-eval.md',
      'capability-matrix.json',
      'capability-matrix.md',
      'deterministic-eval.json',
      'deterministic-eval.md',
      'phase-shift-readiness.json',
      'phase-shift-readiness.md',
    ]);
    const report = JSON.parse(fs.readFileSync(path.join(reportRoot, 'deterministic-eval.json'), 'utf8'));
    assert.equal(report.mode, 'guarded_offline_baseline');
    assert.deepEqual(report.networkIsolation, {
      networkSealed: false,
      hermetic: false,
      nodeGuardOnly: true,
      reason: 'no_os_egress_boundary',
      ciFirewallAssertionRequired: true,
      ciFirewallAssertionIncluded: false,
    });
    assert.equal(report.inputBoundary.checkoutReportsReadable, false);
    assert.equal(report.inputBoundary.generatedReportRootInitiallyEmpty, true);
    assert.equal(report.inputBoundary.freshProducerCount, 5);
    assert.equal(report.inputBoundary.fixtureSemanticValidationPassed, true);
    assert.deepEqual(report.inputBoundary.materiallyConsumedFixturePaths, BASELINE_FIXTURE_PATHS);
    assert.deepEqual(report.commands.map((entry) => entry.name), [
      'baseline:fixture-eval',
      'advisor:dry-run',
      'advisor:first-call',
      'advisor:replay',
      'capability:matrix',
    ]);
    const guard = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'advisor-response-capture-guard.js'),
      '--baseline-fixture-root',
      fixtureRoot,
      '--report-root',
      reportRoot,
    ], {
      cwd: ROOT,
      env: baselineTestEnvironment(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(guard.status, 0, guard.stderr || guard.stdout);
    const guardReport = JSON.parse(fs.readFileSync(
      path.join(reportRoot, 'advisor-response-capture-guard.json'),
      'utf8',
    ));
    assert.equal(guardReport.ok, true);
    assert.equal(guardReport.reports.every((entry) => path.dirname(entry.path) === '.'), true);
    assert.equal(guardReport.reports.some((entry) => entry.path === 'baseline-fixture-eval.json'), true);
    assert.equal(guardReport.reports.some((entry) => entry.path === 'baseline-fixture-eval.md'), true);
    assert.deepEqual([...captureReportState(ROOT).entries()], checkoutReportsBefore);

    const privateSentinel = 'private-stale-report-content-must-not-be-echoed';
    fs.writeFileSync(path.join(reportRoot, 'stale-sentinel.json'), JSON.stringify({ value: privateSentinel }), 'utf8');
    const stale = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'deterministic-eval.js'),
      '--baseline',
      '--fixture-root',
      fixtureRoot,
      '--report-root',
      reportRoot,
    ], {
      cwd: ROOT,
      env: baselineTestEnvironment(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.notEqual(stale.status, 0);
    assert.match(`${stale.stdout}\n${stale.stderr}`, /generated-report root must be initially empty/);
    assert.doesNotMatch(`${stale.stdout}\n${stale.stderr}`, new RegExp(privateSentinel));
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('public JDK probe and Fabric build enforce JDK 21 without machine paths', () => {
  const probePath = path.join(ROOT, 'scripts', 'jdk21-probe.ps1');
  const probe = fs.readFileSync(probePath, 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'fabric-client', 'settings.gradle.kts'), 'utf8');
  assert.match(probe, /\[string\]\$JavaExecutable/);
  assert.match(probe, /UseSerialGC/);
  assert.match(probe, /PriorityClass -ne \[Diagnostics\.ProcessPriorityClass\]::Idle/);
  assert.match(probe, /ProcessorAffinity/);
  assert.match(settings, /JavaVersion\.current\(\) != JavaVersion\.VERSION_21/);
  assert.doesNotMatch(`${probe}\n${settings}`, /[A-Z]:\\(?:Users|Program Files|Minecraft|jdk)/i);
  const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', [
    '$tokens=$null; $errors=$null;',
    "[void][System.Management.Automation.Language.Parser]::ParseFile('scripts/jdk21-probe.ps1',[ref]$tokens,[ref]$errors);",
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }',
  ].join(' ')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

test('isolated integrity accepts generated reports but rejects source and fixture drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-integrity-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'fixture.json'), '{"safe":true}\n', 'utf8');
    const fixtureDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'data', 'fixture.json')))
      .digest('hex');
    fs.writeFileSync(path.join(root, 'config', 'baseline-fixtures.json'), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'data/fixture.json', sha256: fixtureDigest, sanitized: true }],
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'source.js'), 'export const stable = true;\n', 'utf8');
    runGit(root, ['init', '-q']);
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    const head = runGit(root, ['rev-parse', 'HEAD']).trim();
    assert.deepEqual(assertIsolatedWorkspaceState(root, head).unexpectedPaths, []);

    fs.writeFileSync(path.join(root, 'reports', 'fresh.json'), '{}\n', 'utf8');
    assert.equal(assertIsolatedWorkspaceState(root, head).allowedGeneratedReportChanges, 1);
    fs.writeFileSync(path.join(root, 'source.js'), 'export const stable = false;\n', 'utf8');
    assert.throws(() => assertIsolatedWorkspaceState(root, head), /unexpected isolated changes/);

    fs.writeFileSync(path.join(root, 'source.js'), 'export const stable = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'data', 'fixture.json'), '{"safe":false}\n', 'utf8');
    assert.throws(() => assertIsolatedWorkspaceState(root, head), /digest mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('step isolation permits only fresh producer reports and rejects non-producer report mutations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-report-transitions-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'fixture.json'), '{"safe":true}\n', 'utf8');
    const fixtureDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'data', 'fixture.json')))
      .digest('hex');
    fs.writeFileSync(path.join(root, 'config', 'baseline-fixtures.json'), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'data/fixture.json', sha256: fixtureDigest, sanitized: true }],
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'reports', 'existing.json'), '{"stable":true}\n', 'utf8');
    runGit(root, ['init', '-q']);
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    const head = runGit(root, ['rev-parse', 'HEAD']).trim();
    const initial = captureReportState(root);

    fs.writeFileSync(path.join(root, 'reports', 'existing.json'), '{"stable":false}\n', 'utf8');
    assert.throws(() => assertBaselineStepIsolation(root, head, initial, 'root-offline'), /unexpected report mutations/);
    fs.writeFileSync(path.join(root, 'reports', 'existing.json'), '{"stable":true}\n', 'utf8');

    const beforeProducer = captureReportState(root);
    for (const file of [
      'baseline-fixture-eval.json',
      'baseline-fixture-eval.md',
      'deterministic-eval.json',
      'deterministic-eval.md',
      'phase-shift-readiness.json',
      'phase-shift-readiness.md',
      'advisor-dry-run.json',
      'advisor-dry-run.md',
      'advisor-first-call.json',
      'advisor-first-call.md',
      'advisor-first-call-replay.json',
      'advisor-first-call-replay.md',
      'capability-matrix.json',
      'capability-matrix.md',
    ]) {
      fs.writeFileSync(path.join(root, 'reports', file), `${file}\n`, 'utf8');
    }
    const rogueReport = path.join(root, 'reports', 'unexpected-deterministic-output.json');
    fs.writeFileSync(rogueReport, '{}\n', 'utf8');
    assert.throws(
      () => assertBaselineStepIsolation(root, head, beforeProducer, 'deterministic-eval'),
      /unexpected report mutations: reports\/unexpected-deterministic-output\.json/,
    );
    fs.unlinkSync(rogueReport);
    const produced = assertBaselineStepIsolation(root, head, beforeProducer, 'deterministic-eval');
    assert.equal(produced.summary.reportChanges.length >= 4, true);
    assert.throws(
      () => assertBaselineStepIsolation(root, head, produced.reportState, 'response-capture-final'),
      /required fresh reports missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external report isolation rejects checkout-report writes and chains only fresh generated reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-external-report-worktree-'));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-external-report-output-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'fixture.json'), '{"safe":true}\n', 'utf8');
    const fixtureDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'data', 'fixture.json')))
      .digest('hex');
    fs.writeFileSync(path.join(root, 'config', 'baseline-fixtures.json'), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'data/fixture.json', sha256: fixtureDigest, sanitized: true }],
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'reports', 'stale.json'), '{"mustNotInfluence":true}\n', 'utf8');
    runGit(root, ['init', '-q']);
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    const head = runGit(root, ['rev-parse', 'HEAD']).trim();
    const initial = captureReportState(root, reportRoot);
    assert.equal(initial.size, 0);

    fs.writeFileSync(path.join(root, 'reports', 'stale.json'), '{"mustNotInfluence":false}\n', 'utf8');
    assert.throws(
      () => assertBaselineStepIsolation(root, head, initial, 'root-offline', reportRoot),
      /mutated checkout reports/,
    );
    fs.writeFileSync(path.join(root, 'reports', 'stale.json'), '{"mustNotInfluence":true}\n', 'utf8');

    for (const file of [
      'baseline-fixture-eval.json',
      'baseline-fixture-eval.md',
      'deterministic-eval.json',
      'deterministic-eval.md',
      'phase-shift-readiness.json',
      'phase-shift-readiness.md',
      'advisor-dry-run.json',
      'advisor-dry-run.md',
      'advisor-first-call.json',
      'advisor-first-call.md',
      'advisor-first-call-replay.json',
      'advisor-first-call-replay.md',
      'capability-matrix.json',
      'capability-matrix.md',
    ]) {
      fs.writeFileSync(path.join(reportRoot, file), `${file}\n`, 'utf8');
    }
    const produced = assertBaselineStepIsolation(root, head, initial, 'deterministic-eval', reportRoot);
    assert.equal(produced.summary.reportChanges.includes('reports/deterministic-eval.json'), true);
    assert.equal(produced.reportState.has('reports/stale.json'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test('mandatory evidence rejects stale or uncopied successful-producer artifacts', () => {
  const valid = { producerOk: true, fresh: true, copied: true };
  assert.deepEqual(validateMandatoryEvidenceRecords([valid], 1), { expected: 1, recorded: 1, invalid: 0 });
  assert.throws(
    () => validateMandatoryEvidenceRecords([{ ...valid, fresh: false }], 1),
    /mandatory fresh evidence gate failed/,
  );
  assert.throws(
    () => validateMandatoryEvidenceRecords([{ ...valid, copied: false }], 1),
    /mandatory fresh evidence gate failed/,
  );
});

test('JUnit XML summary counts only top-level Gradle suite records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-junit-'));
  try {
    fs.writeFileSync(path.join(root, 'TEST-a.xml'), '<testsuite tests="4" failures="1" errors="0" skipped="2"><testcase/></testsuite>');
    fs.writeFileSync(path.join(root, 'TEST-b.xml'), '<testsuite errors="1" skipped="0" failures="0" tests="3"></testsuite>');
    fs.writeFileSync(path.join(root, 'ignored.txt'), '<testsuite tests="99"/>');
    assert.deepEqual(summarizeJUnitXml(root), { files: 2, tests: 7, failures: 1, errors: 1, skipped: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact inventory is stable, relative, and excludes its own summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-artifacts-'));
  try {
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'b.log'), 'b', 'utf8');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(root, 'baseline-summary.json'), '{}', 'utf8');
    const inventory = artifactInventory(root);
    assert.deepEqual(inventory.map((entry) => entry.path), ['a.txt', 'logs/b.log']);
    assert.equal(inventory.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gradle reproducibility inputs record all required hashes and fail closed when one is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-gradle-inputs-'));
  const relativePaths = [
    'fabric-client/gradle.lockfile',
    'fabric-client/gradle/verification-metadata.xml',
    'fabric-client/gradle/wrapper/gradle-wrapper.jar',
    'test-harness-plugin/gradle.lockfile',
    'test-harness-plugin/gradle/verification-metadata.xml',
    'test-harness-plugin/gradle/wrapper/gradle-wrapper.jar',
  ];
  try {
    for (const [index, relativePath] of relativePaths.entries()) {
      const filePath = path.join(root, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `input-${index}\n`, 'utf8');
    }

    const inputs = collectGradleReproducibilityInputs(root);
    const records = [
      inputs.fabric.lockfile,
      inputs.fabric.verificationMetadata,
      inputs.fabric.wrapperJar,
      inputs.paper.lockfile,
      inputs.paper.verificationMetadata,
      inputs.paper.wrapperJar,
    ];
    assert.deepEqual(records.map((record) => record.path), relativePaths);
    for (const record of records) {
      const filePath = path.join(root, ...record.path.split('/'));
      assert.equal(record.bytes, fs.statSync(filePath).size);
      assert.equal(
        record.sha256,
        crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
      );
    }

    fs.unlinkSync(path.join(root, 'fabric-client', 'gradle.lockfile'));
    assert.throws(
      () => collectGradleReproducibilityInputs(root),
      (error) => error?.stage === 'preflight' && /fabric-client\/gradle\.lockfile.*does not exist/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CI cache warmups enforce strict Gradle dependency verification', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'baseline.yml'), 'utf8');
  const warmupCommands = workflow
    .split(/\r?\n/)
    .filter((line) => line.includes('gradlew.bat') && line.includes('testClasses'));
  assert.equal(warmupCommands.length, 2);
  assert.equal(
    warmupCommands.every((line) => line.includes('--dependency-verification=strict')),
    true,
  );
});

test('Fabric verification trusts only Loom local remaps while external artifacts stay strict', () => {
  const metadata = fs.readFileSync(
    path.join(ROOT, 'fabric-client', 'gradle', 'verification-metadata.xml'),
    'utf8',
  );
  const trustEntries = [...metadata.matchAll(/<trust\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(trustEntries.length, 1);
  assert.match(trustEntries[0], /group="remapped[.]net[.]fabricmc[.]fabric-api"/);
  assert.match(trustEntries[0], /reason="[^"]*Fabric Loom[^"]*checksum-verified[^"]*"/);
  assert.doesNotMatch(trustEntries[0], /\bregex=/);
  assert.match(metadata, /<verify-metadata>true<\/verify-metadata>/);
  assert.match(metadata, /<sha256 value="[a-f0-9]{64}"/);
});

test('CI strips checkout and runner credentials before repository-controlled commands', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'baseline.yml'), 'utf8');
  const checkoutBlock = workflow.split(/(?=      - name: )/)
    .find((block) => block.includes('- name: Check out repository'));
  assert.ok(checkoutBlock);
  assert.match(checkoutBlock, /persist-credentials:\s*false/);

  for (const stepName of [
    'Prepare npm dependency cache',
    'Prepare Fabric dependency cache',
    'Prepare Paper dependency cache',
    'Run guarded offline baseline',
  ]) {
    const block = workflow.split(/(?=      - name: )/)
      .find((entry) => entry.includes(`- name: ${stepName}`));
    assert.ok(block, `missing workflow step: ${stepName}`);
    for (const variable of [
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'GITHUB_TOKEN',
    ]) {
      assert.match(block, new RegExp(`\\n\\s+${variable}:\\s*''(?:\\r?\\n|$)`));
    }
  }
});

test('serialized summaries never contain private metric-capture output', () => {
  const secret = 'private-process-output';
  const serialized = serializeBaselineSummary({
    steps: [{ name: 'example', _stdout: secret, _stderr: secret, logs: { stdout: 'logs/example.log' } }],
  });
  assert.equal(serialized.includes('_stdout'), false);
  assert.equal(serialized.includes('_stderr'), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(JSON.parse(serialized).steps[0].logs.stdout, 'logs/example.log');
});

test('disposable cleanup refuses an external dependency junction without touching its target', () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-cleanup-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-external-deps-'));
  const workspace = path.join(runRoot, 'worktree');
  const marker = path.join(external, 'must-survive.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(marker, 'preserved\n', 'utf8');
  try {
    fs.symlinkSync(external, path.join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertDisposableCleanupSafe(runRoot, workspace),
      /reparse link escapes the disposable worktree/,
    );
    assert.throws(
      () => cleanupDisposableWorkspace({
        repositoryRoot: ROOT,
        runRoot,
        workspaceRoot: workspace,
        worktreeAdded: false,
      }),
      /reparse link escapes the disposable worktree/,
    );
    assert.equal(fs.readFileSync(marker, 'utf8'), 'preserved\n');
    assert.equal(fs.existsSync(workspace), true);
  } finally {
    const dependencyLink = path.join(workspace, 'node_modules');
    if (fs.lstatSync(dependencyLink, { throwIfNoEntry: false })) fs.unlinkSync(dependencyLink);
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('disposable cleanup rejects a dangling worktree-root reparse point', () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-dangling-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-dangling-target-'));
  const workspace = path.join(runRoot, 'worktree');
  try {
    fs.symlinkSync(external, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(external, { recursive: true, force: true });
    assert.equal(fs.existsSync(workspace), false);
    assert.ok(fs.lstatSync(workspace));
    assert.throws(() => assertDisposableCleanupSafe(runRoot, workspace), /worktree root is a reparse link/);
    assert.ok(fs.lstatSync(workspace));
  } finally {
    if (fs.lstatSync(workspace, { throwIfNoEntry: false })) fs.unlinkSync(workspace);
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('disposable cleanup removes an exact stale Git worktree registration before reporting success', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-stale-registration-'));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-baseline-stale-run-'));
  const workspace = path.join(runRoot, 'worktree');
  try {
    fs.writeFileSync(path.join(repository, 'file.txt'), 'tracked\n', 'utf8');
    runGit(repository, ['init', '-q']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', 'commit', '-qm', 'fixture']);
    runGit(repository, ['worktree', 'add', '--detach', workspace, 'HEAD']);
    fs.rmSync(workspace, { recursive: true, force: true });
    assert.match(runGit(repository, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegExp(workspace.replaceAll('\\', '/')), 'i'));

    const result = cleanupDisposableWorkspace({
      repositoryRoot: repository,
      runRoot,
      workspaceRoot: workspace,
      worktreeAdded: true,
    });
    assert.equal(result.removed, true);
    assert.doesNotMatch(runGit(repository, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegExp(workspace.replaceAll('\\', '/')), 'i'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('network guard pins localhost and blocks external, deceptive, and custom-resolver sockets', async () => {
  const guardEnv = {
    ...process.env,
    NODE_OPTIONS: `--require=${JSON.stringify(GUARD)}`,
  };
  const localCode = [
    "const http = require('node:http');",
    "const net = require('node:net');",
    "const server = http.createServer((_req, res) => res.end('ok'));",
    "server.listen(0, '127.0.0.1', async () => {",
    "  const port = server.address().port;",
    "  await new Promise((resolve, reject) => {",
    "    const socket = net.connect({ host: 'localhost', port }, () => socket.end(resolve));",
    "    socket.once('error', reject);",
    "  });",
    "  const body = await (await fetch('http://127.0.0.1:' + port)).text();",
    "  server.close(() => process.exit(body === 'ok' ? 0 : 2));",
    "});",
  ].join('\n');
  const local = spawnSync(process.execPath, ['-e', localCode], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(local.status, 0, local.stderr);

  const external = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "try { new net.Socket().connect({ host: '192.0.2.1', port: 80 }); process.exit(2); }",
    "catch (error) { process.exit(/network guard blocked/.test(error.message) ? 0 : 3); }",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(external.status, 0, external.stderr);

  const externalFetch = spawnSync(process.execPath, ['-e', [
    "try { fetch('http://192.0.2.1/'); process.exit(2); }",
    "catch (error) { process.exit(/network guard blocked/.test(error.message) ? 0 : 3); }",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(externalFetch.status, 0, externalFetch.stderr);

  const deceptiveHostname = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "try { net.connect({ host: '127.attacker.example', port: 80 }); process.exit(2); }",
    "catch (error) { process.exit(/network guard blocked/.test(error.message) ? 0 : 3); }",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(deceptiveHostname.status, 0, deceptiveHostname.stderr);

  const customLookup = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    'let resolverCalled = false;',
    "const lookup = (_hostname, _options, callback) => { resolverCalled = true; callback(null, '192.0.2.1', 4); };",
    "try { net.connect({ host: 'localhost', port: 80, family: 4, lookup }); process.exit(2); }",
    "catch (error) { process.exit(!resolverCalled && /caller-supplied lookup/.test(error.message) ? 0 : 3); }",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(customLookup.status, 0, customLookup.stderr);

  const deceptiveLocalhost = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    'let resolverCalled = false;',
    "const lookup = (_hostname, _options, callback) => { resolverCalled = true; callback(null, '192.0.2.1', 4); };",
    "try { net.connect({ host: 'localhost.', port: 80, lookup }); process.exit(2); }",
    "catch (error) { process.exit(!resolverCalled && /network guard blocked/.test(error.message) ? 0 : 3); }",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(deceptiveLocalhost.status, 0, deceptiveLocalhost.stderr);

  const mappedLoopback = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    'try {',
    "  const socket = net.connect({ host: '::ffff:127.0.0.1', port: 1 });",
    '  socket.destroy();',
    '  process.exit(0);',
    '} catch (error) {',
    '  process.exit(/network guard blocked/.test(error.message) ? 2 : 3);',
    '}',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(mappedLoopback.status, 0, mappedLoopback.stderr);

  const dnsEscape = spawnSync(process.execPath, ['-e', [
    "const dns = require('node:dns');",
    'const blocked = (fn) => {',
    '  try { fn(); return false; } catch (error) { return /network guard blocked/.test(error.message); }',
    '};',
    '(async () => {',
    "  const lookupBlocked = blocked(() => dns.lookup('arbitrary-alias.example', () => {}));",
    "  const resolveBlocked = blocked(() => dns.resolve('localhost', () => {}));",
    "  const reverseBlocked = blocked(() => dns.reverse('192.0.2.1', () => {}));",
    "  const lookupServiceBlocked = blocked(() => dns.lookupService('192.0.2.1', 80, () => {}));",
    "  const setServersBlocked = blocked(() => dns.setServers(['192.0.2.1']));",
    "  const resolveAfterSetBlocked = blocked(() => dns.resolve4('external.example', () => {}));",
    '  const resolver = new dns.Resolver();',
    "  const resolverBlocked = blocked(() => resolver.resolve4('external.example', () => {}));",
    "  const resolverSetServersBlocked = blocked(() => resolver.setServers(['192.0.2.1']));",
    '  const deleteResolverMethodBlocked = delete dns.Resolver.prototype.resolve4 === false',
    "    && blocked(() => resolver.resolve4('external.example', () => {}));",
    '  const resolverBaseSetServers = Object.getPrototypeOf(dns.Resolver.prototype).setServers;',
    '  const resolverBaseBlocked = typeof resolverBaseSetServers !== \'function\'',
    "    || blocked(() => resolverBaseSetServers.call(resolver, ['192.0.2.1']));",
    '  let promiseResolveBlocked = false;',
    '  let promiseReverseBlocked = false;',
    '  let promiseLookupServiceBlocked = false;',
    '  let promiseResolverBlocked = false;',
    '  let promiseResolverSetServersBlocked = false;',
    "  try { await dns.promises.resolve('localhost'); }",
    '  catch (error) { promiseResolveBlocked = /network guard blocked/.test(error.message); }',
    "  try { await dns.promises.reverse('192.0.2.1'); }",
    '  catch (error) { promiseReverseBlocked = /network guard blocked/.test(error.message); }',
    "  try { await dns.promises.lookupService('192.0.2.1', 80); }",
    '  catch (error) { promiseLookupServiceBlocked = /network guard blocked/.test(error.message); }',
    '  const promiseResolver = new dns.promises.Resolver();',
    "  try { await promiseResolver.resolve4('external.example'); }",
    '  catch (error) { promiseResolverBlocked = /network guard blocked/.test(error.message); }',
    "  try { await promiseResolver.setServers(['192.0.2.1']); }",
    '  catch (error) { promiseResolverSetServersBlocked = /network guard blocked/.test(error.message); }',
    '  process.exit(lookupBlocked && resolveBlocked && reverseBlocked && lookupServiceBlocked',
    '    && setServersBlocked && resolveAfterSetBlocked && resolverBlocked && resolverSetServersBlocked',
    '    && deleteResolverMethodBlocked && resolverBaseBlocked',
    '    && promiseResolveBlocked && promiseReverseBlocked && promiseLookupServiceBlocked',
    '    && promiseResolverBlocked && promiseResolverSetServersBlocked ? 0 : 2);',
    '})().catch(() => process.exit(3));',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(dnsEscape.status, 0, dnsEscape.stderr);

  const namedPipe = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "if (process.platform !== 'win32') process.exit(0);",
    "const remote = String.raw`\\\\remote-host\\pipe\\mcbot-baseline`;",
    'const blocked = (value) => {',
    '  try { net.connect(value); return false; }',
    '  catch (error) { return /remote or ambiguous IPC path/.test(error.message); }',
    '};',
    'process.exit(blocked(remote) && blocked({ path: remote }) ? 0 : 3);',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(namedPipe.status, 0, namedPipe.stderr);

  const localNamedPipe = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "if (process.platform !== 'win32') process.exit(0);",
    "const local = String.raw`\\\\.\\pipe\\mcbot-baseline-definitely-absent`;",
    'const socket = net.connect(local);',
    "socket.once('error', (error) => process.exit(/network guard blocked/.test(error.message) ? 2 : 0));",
    'setTimeout(() => { socket.destroy(); process.exit(3); }, 2000).unref();',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(localNamedPipe.status, 0, localNamedPipe.stderr);

  const ipcAccessorSnapshot = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "if (process.platform !== 'win32') process.exit(0);",
    "const local = String.raw`\\\\.\\pipe\\mcbot-baseline-accessor-absent`;",
    "const remote = String.raw`\\\\remote-host\\pipe\\mcbot-baseline`;",
    'let pipeReads = 0;',
    'const pipeOptions = {};',
    "Object.defineProperty(pipeOptions, 'path', { enumerable: true, get: () => (++pipeReads === 1 ? local : remote) });",
    'const pipe = net.connect(pipeOptions);',
    "pipe.once('error', (error) => {",
    '  if (/network guard blocked/.test(error.message) || pipeReads !== 1) process.exit(2);',
    '  let fallbackReads = 0;',
    "  const fallback = { host: 'localhost', port: 1 };",
    "  Object.defineProperty(fallback, 'path', { enumerable: true, get: () => (++fallbackReads === 1 ? undefined : remote) });",
    '  const tcp = net.connect(fallback);',
    "  tcp.once('error', (tcpError) => process.exit(!/network guard blocked/.test(tcpError.message) && fallbackReads === 1 ? 0 : 3));",
    '});',
    'setTimeout(() => { pipe.destroy(); process.exit(4); }, 3000).unref();',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(ipcAccessorSnapshot.status, 0, ipcAccessorSnapshot.stderr);

  const tlsDestinationOverrides = spawnSync(process.execPath, ['-e', [
    "const tls = require('node:tls');",
    "if (process.platform !== 'win32') process.exit(0);",
    "const local = String.raw`\\\\.\\pipe\\mcbot-baseline-local`;",
    "const remote = String.raw`\\\\remote-host\\pipe\\mcbot-baseline`;",
    'const blocked = (fn) => {',
    '  try { fn(); return false; } catch (error) { return /network guard blocked/.test(error.message); }',
    '};',
    'process.exit(blocked(() => tls.connect(443, { path: remote }))',
    "  && blocked(() => tls.connect(443, { servername: 'localhost' }, { path: remote }))",
    '  && blocked(() => tls.connect(local, { path: remote }))',
    '  && blocked(() => tls.connect({ path: local }, { path: remote }))',
    "  && blocked(() => tls.connect({ host: 'localhost', port: 443 }, { host: '192.0.2.1' }))",
    "  && blocked(() => tls.connect({ host: 'localhost', port: 443, socket: {} })) ? 0 : 3);",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(tlsDestinationOverrides.status, 0, tlsDestinationOverrides.stderr);

  const directDatagram = spawnSync(process.execPath, ['-e', [
    "const dgram = require('node:dgram');",
    'const blocked = (fn) => {',
    '  try { fn(); return false; } catch (error) { return /network guard blocked/.test(error.message); }',
    '};',
    "process.exit(blocked(() => dgram._createSocketHandle())",
    "  && blocked(() => new dgram.Socket('udp4'))",
    "  && blocked(() => new dgram.Socket.prototype.constructor('udp4')) ? 0 : 3);",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(directDatagram.status, 0, directDatagram.stderr);

  const mutablePrimordials = spawnSync(process.execPath, ['-e', [
    "const net = require('node:net');",
    "const tls = require('node:tls');",
    'const nativeTest = RegExp.prototype.test;',
    'const nativeApply = Reflect.apply;',
    'const blocked = (fn) => {',
    '  try { fn(); return false; }',
    "  catch (error) { return nativeApply(nativeTest, /network guard blocked/, [String(error.message)]); }",
    '};',
    'net.BlockList.prototype.check = () => true;',
    'net.isIP = () => 4;',
    'String.prototype.startsWith = () => false;',
    'RegExp.prototype.test = () => true;',
    'Array.prototype.findIndex = () => -1;',
    'Array.prototype.map = () => [];',
    'Array.prototype.filter = () => [];',
    'Array.prototype.some = () => false;',
    'Array.prototype.slice = () => [];',
    'Array.prototype[Symbol.iterator] = function* emptyIterator() {};',
    "const local = String.raw`\\\\.\\pipe\\mcbot-local`;",
    "const remote = String.raw`\\\\remote-host\\pipe\\mcbot-baseline`;",
    "const externalIpBlocked = blocked(() => net.connect({ host: '192.0.2.1', port: 80 }));",
    "const tlsSocketBlocked = blocked(() => tls.connect({ host: 'localhost', port: 443, socket: {} }));",
    "let numericAccessorBlocked = process.platform !== 'win32';",
    'let escapedSocket = null;',
    "if (process.platform === 'win32') {",
    '  let inheritedIndexReads = 0;',
    "  Object.defineProperty(Array.prototype, '0', { configurable: true,",
    '    get() { inheritedIndexReads += 1; return inheritedIndexReads === 1 ? local : remote; },',
    '    set() { this.length = 1; },',
    '  });',
    '  try { escapedSocket = net.connect({ path: remote }); }',
    '  catch (error) {',
    "    delete Array.prototype['0'];",
    '    numericAccessorBlocked = inheritedIndexReads === 0',
    '      && nativeApply(nativeTest, /network guard blocked/, [String(error.message)]);',
    '  }',
    "  delete Array.prototype['0'];",
    '}',
    'if (escapedSocket) escapedSocket.destroy();',
    'const tlsOverrideBlocked = blocked(() => tls.connect(local, { path: remote }));',
    "const uncBlocked = process.platform !== 'win32' || blocked(() => net.connect({ path: remote }));",
    'process.exit(externalIpBlocked && tlsSocketBlocked && numericAccessorBlocked',
    '  && tlsOverrideBlocked && uncBlocked ? 0 : 3);',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(mutablePrimordials.status, 0, mutablePrimordials.stderr);

  const fetchObjectSpoof = spawnSync(process.execPath, ['-e', [
    '(async () => {',
    "  const spoof = { url: 'http://127.0.0.1/', toString: () => 'http://192.0.2.1/' };",
    '  try { await fetch(spoof); process.exit(2); }',
    "  catch (error) { process.exit(/network guard blocked/.test(error.message) ? 0 : 3); }",
    '})().catch(() => process.exit(4));',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(fetchObjectSpoof.status, 0, fetchObjectSpoof.stderr);

  const fetchPrototypeTamper = spawnSync(process.execPath, ['-e', [
    '(async () => {',
    "  Object.defineProperty(Request.prototype, 'url', { configurable: true, get: () => 'http://127.0.0.1/' });",
    "  Object.defineProperty(Request.prototype, 'redirect', { configurable: true, get: () => 'manual' });",
    "  Object.defineProperty(URL.prototype, 'protocol', { configurable: true, get: () => 'http:' });",
    "  Object.defineProperty(URL.prototype, 'hostname', { configurable: true, get: () => '127.0.0.1' });",
    '  globalThis.URL = class SpoofedURL { get protocol() { return \'http:\'; } get hostname() { return \'127.0.0.1\'; } };',
    "  try { await fetch('http://192.0.2.1/'); process.exit(2); }",
    "  catch (error) { process.exit(/network guard blocked/.test(error.message) ? 0 : 3); }",
    '})().catch(() => process.exit(4));',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(fetchPrototypeTamper.status, 0, fetchPrototypeTamper.stderr);

  const fetchDispatcher = spawnSync(process.execPath, ['-e', [
    "const http = require('node:http');",
    'let customCalled = false;',
    "const custom = { dispatch() { customCalled = true; throw new Error('custom dispatcher called'); } };",
    "const dispatcherSymbol = Symbol.for('undici.globalDispatcher.1');",
    'const guardedDispatcher = globalThis[dispatcherSymbol];',
    'let directBlocked = false;',
    'try { guardedDispatcher.dispatch({ origin: \'http://192.0.2.1\', method: \'GET\', path: \'/\' }, {}); }',
    "catch (error) { directBlocked = /network guard blocked/.test(error.message); }",
    'try { globalThis[dispatcherSymbol] = custom; } catch {}',
    "const server = http.createServer((_request, response) => response.end('ok'));",
    "server.listen(0, '127.0.0.1', async () => {",
    '  try {',
    "    const response = await fetch('http://127.0.0.1:' + server.address().port + '/', { dispatcher: custom });",
    '    const body = await response.text();',
    '    const safe = directBlocked && !customCalled && globalThis[dispatcherSymbol] === guardedDispatcher',
    "      && Object.isFrozen(guardedDispatcher) && body === 'ok';",
    '    server.close(() => process.exit(safe ? 0 : 2));',
    '  } catch { server.close(() => process.exit(3)); }',
    '});',
    'setTimeout(() => server.close(() => process.exit(4)), 3000).unref();',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(fetchDispatcher.status, 0, fetchDispatcher.stderr);

  const fetchRedirect = spawnSync(process.execPath, ['-e', [
    "const http = require('node:http');",
    "const server = http.createServer((_request, response) => { response.writeHead(302, { location: 'http://192.0.2.1/' }); response.end(); });",
    "server.listen(0, '127.0.0.1', async () => {",
    '  try {',
    "    const response = await fetch('http://127.0.0.1:' + server.address().port + '/redirect');",
    '    server.close(() => process.exit(response.status === 302 && !response.redirected ? 0 : 2));',
    '  } catch { server.close(() => process.exit(3)); }',
    '});',
    'setTimeout(() => server.close(() => process.exit(4)), 3000).unref();',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(fetchRedirect.status, 0, fetchRedirect.stderr);

  const fetchRedirectGetterTamper = spawnSync(process.execPath, ['-e', [
    "const http = require('node:http');",
    "Object.defineProperty(Request.prototype, 'redirect', { configurable: true, get: () => 'manual' });",
    "const server = http.createServer((_request, response) => { response.writeHead(302, { location: 'http://192.0.2.1/' }); response.end(); });",
    "server.listen(0, '127.0.0.1', async () => {",
    '  try {',
    "    const response = await fetch('http://127.0.0.1:' + server.address().port + '/redirect');",
    '    server.close(() => process.exit(response.status === 302 && !response.redirected ? 0 : 2));',
    '  } catch { server.close(() => process.exit(3)); }',
    '});',
    'setTimeout(() => server.close(() => process.exit(4)), 3000).unref();',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(fetchRedirectGetterTamper.status, 0, fetchRedirectGetterTamper.stderr);

  const urlTransports = spawnSync(process.execPath, ['-e', [
    'const blocked = (name, url) => {',
    '  const Transport = globalThis[name];',
    '  if (typeof Transport !== \'function\') return name === \'EventSource\';',
    '  const denied = (Constructor) => {',
    '    try { new Constructor(url); return false; }',
    '    catch (error) { return /network guard blocked/.test(error.message); }',
    '  };',
    '  return denied(Transport) && denied(Transport.prototype.constructor);',
    '};',
    "process.exit(blocked('WebSocket', 'ws://192.0.2.1/socket')",
    "  && blocked('EventSource', 'http://192.0.2.1/events') ? 0 : 2);",
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(urlTransports.status, 0, urlTransports.stderr);

  const esmNamedExports = spawnSync(process.execPath, ['--input-type=module', '-e', [
    "import { connect as netConnect } from 'node:net';",
    "import { connect as tlsConnect } from 'node:tls';",
    "import { lookup as dnsLookup, resolve as dnsResolve, reverse as dnsReverse, lookupService as dnsLookupService, setServers as dnsSetServers, Resolver as DnsResolver, promises as dnsPromises } from 'node:dns';",
    "import { createSocket as createDatagramSocket, Socket as DatagramSocket } from 'node:dgram';",
    'const blocked = (fn) => {',
    '  try { fn(); return false; } catch (error) { return /network guard blocked/.test(error.message); }',
    '};',
    "const netBlocked = blocked(() => netConnect({ host: '192.0.2.1', port: 80 }));",
    "const tlsBlocked = blocked(() => tlsConnect({ host: '192.0.2.1', port: 443 }));",
    "const lookupBlocked = blocked(() => dnsLookup('external.example', () => {}));",
    "const resolveBlocked = blocked(() => dnsResolve('localhost', () => {}));",
    "const reverseBlocked = blocked(() => dnsReverse('192.0.2.1', () => {}));",
    "const lookupServiceBlocked = blocked(() => dnsLookupService('192.0.2.1', 80, () => {}));",
    "const setServersBlocked = blocked(() => dnsSetServers(['192.0.2.1']));",
    "const resolveAfterSetBlocked = blocked(() => dnsResolve('external.example', () => {}));",
    'const resolver = new DnsResolver();',
    "const resolverBlocked = blocked(() => resolver.resolve4('external.example', () => {}));",
    "const resolverSetServersBlocked = blocked(() => resolver.setServers(['192.0.2.1']));",
    "const datagramBlocked = blocked(() => createDatagramSocket('udp4'));",
    "const directDatagramBlocked = blocked(() => new DatagramSocket('udp4'))",
    "  && blocked(() => new DatagramSocket.prototype.constructor('udp4'));",
    'let promiseResolveBlocked = false;',
    'let promiseReverseBlocked = false;',
    'let promiseResolverBlocked = false;',
    'let promiseResolverSetServersBlocked = false;',
    "try { await dnsPromises.resolve('localhost'); }",
    'catch (error) { promiseResolveBlocked = /network guard blocked/.test(error.message); }',
    "try { await dnsPromises.reverse('192.0.2.1'); }",
    'catch (error) { promiseReverseBlocked = /network guard blocked/.test(error.message); }',
    'const promiseResolver = new dnsPromises.Resolver();',
    "try { await promiseResolver.resolve4('external.example'); }",
    'catch (error) { promiseResolverBlocked = /network guard blocked/.test(error.message); }',
    "try { await promiseResolver.setServers(['192.0.2.1']); }",
    'catch (error) { promiseResolverSetServersBlocked = /network guard blocked/.test(error.message); }',
    'process.exit(netBlocked && tlsBlocked && lookupBlocked && resolveBlocked',
    '  && reverseBlocked && lookupServiceBlocked && setServersBlocked && resolveAfterSetBlocked',
    '  && resolverBlocked && resolverSetServersBlocked && datagramBlocked && directDatagramBlocked',
    '  && promiseResolveBlocked && promiseReverseBlocked && promiseResolverBlocked',
    '  && promiseResolverSetServersBlocked ? 0 : 2);',
  ].join('\n')], { env: guardEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(esmNamedExports.status, 0, esmNamedExports.stderr);
});

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout || '';
}

function writeRequiredGradleReproducibilityInputs(repository) {
  for (const relativePath of [
    'fabric-client/gradle.lockfile',
    'fabric-client/gradle/verification-metadata.xml',
    'fabric-client/gradle/wrapper/gradle-wrapper.jar',
    'test-harness-plugin/gradle.lockfile',
    'test-harness-plugin/gradle/verification-metadata.xml',
    'test-harness-plugin/gradle/wrapper/gradle-wrapper.jar',
  ]) {
    const filePath = path.join(repository, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `fixture:${relativePath}\n`, 'utf8');
  }
}

function fakeResourceLockEnvironment() {
  return {
    [RESOURCE_LOCK_ENV.path]: path.join(os.tmpdir(), 'mcbot-unit-resource-lock'),
    [RESOURCE_LOCK_ENV.ownerId]: 'unit-owner-id',
    [RESOURCE_LOCK_ENV.repositoryId]: 'unit-repository-id',
    [RESOURCE_LOCK_ENV.ownerPid]: '42424',
  };
}

function createFakeResourceLock(events = []) {
  const lockEnvironment = fakeResourceLockEnvironment();
  const controller = {
    acquireOptions: null,
    lockPath: lockEnvironment[RESOURCE_LOCK_ENV.path],
    releaseCalls: 0,
    acquire(options) {
      assert.equal(controller.acquireOptions, null, 'resource lock may be acquired only once');
      controller.acquireOptions = options;
      events.push('resource-lock-acquire');
      const previous = Object.fromEntries(Object.values(RESOURCE_LOCK_ENV).map((name) => [name, options.env[name]]));
      Object.assign(options.env, lockEnvironment);
      let released = false;
      return {
        inherited: false,
        location: {
          repositoryId: lockEnvironment[RESOURCE_LOCK_ENV.repositoryId],
          lockPath: lockEnvironment[RESOURCE_LOCK_ENV.path],
        },
        metadata: {
          protocol: RESOURCE_LOCK_PROTOCOL,
          owner: { pid: Number(lockEnvironment[RESOURCE_LOCK_ENV.ownerPid]) },
          acquiredAt: '2026-08-29T12:00:00.000Z',
        },
        environment: { ...lockEnvironment },
        releaseSync() {
          if (released) return false;
          released = true;
          controller.releaseCalls += 1;
          events.push('resource-lock-release');
          for (const [name, value] of Object.entries(previous)) {
            if (options.env[name] !== lockEnvironment[name]) continue;
            if (value === undefined) delete options.env[name];
            else options.env[name] = value;
          }
          return true;
        },
      };
    },
  };
  return controller;
}

function baselineTestEnvironment(sourceEnvironment = process.env) {
  const env = sanitizeBaselineEvaluatorEnvironment(sourceEnvironment);
  env.MCBOT_BASELINE = '1';
  return env;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
