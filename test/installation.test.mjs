import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  buildLifecycleCommand,
  manageInstallation,
  verifyInstallation
} from '../src/installation.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const roots = [];

function testRoot(name, { create = true } = {}) {
  const path = join(tmpdir(), `acb-install-${name}-${randomUUID()}`);
  if (create) mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

function options(root, provider = 'both') {
  return {
    action: 'install',
    provider,
    packageRoot,
    installRoot: join(root, 'install'),
    codexHome: join(root, 'codex'),
    claudeHome: join(root, 'claude'),
    runtimeHome: join(root, 'runtime'),
    bunPath: process.execPath
  };
}

function executeInstall(input) {
  const plan = manageInstallation(input);
  const state = manageInstallation({
    ...input,
    expectedManifestDigest: plan.manifestDigest,
    expectedPlanDigest: plan.planDigest,
    execute: true
  });
  return { plan, state };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Bun installation manager', () => {
  test('plans without writing and binds execution to manifest and target state', () => {
    const root = testRoot('plan', { create: false });
    const plan = manageInstallation(options(root));

    assert.equal(plan.action, 'Install');
    assert.equal(plan.writesEnabled, false);
    assert.match(plan.bunVersion, /^1\.4\./u);
    assert.equal(plan.execution.expectedManifestDigest, plan.manifestDigest);
    assert.equal(plan.execution.expectedPlanDigest, plan.planDigest);
    assert.equal(existsSync(root), false);
  });

  test('rejects activation without both exact digests', () => {
    const root = testRoot('digest');
    const input = options(root, 'codex');
    const plan = manageInstallation(input);

    assert.throws(() => manageInstallation({
      ...input,
      expectedManifestDigest: plan.manifestDigest,
      expectedPlanDigest: '0'.repeat(64),
      execute: true
    }), /ExpectedPlanDigest mismatch/u);
    assert.equal(existsSync(join(root, 'install')), false);
    assert.equal(existsSync(join(root, 'runtime', 'install-state.json')), false);
  });

  test('installs direct Bun hooks, verifies them, and preserves existing handlers', () => {
    const root = testRoot('install');
    const input = options(root);
    mkdirSync(input.codexHome, { recursive: true });
    writeFileSync(join(input.codexHome, 'hooks.json'), `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-handler' }] }] },
      owner: 'test'
    })}\n`, 'utf8');

    const { state } = executeInstall(input);
    const verification = verifyInstallation({ runtimeHome: input.runtimeHome });
    const codex = JSON.parse(readFileSync(join(input.codexHome, 'hooks.json'), 'utf8'));
    const commands = codex.hooks.SessionStart.flatMap((group) => group.hooks)
      .map((hook) => hook.command);

    assert.equal(state.runtime.name, 'bun');
    assert.match(state.runtime.version, /^1\.4\./u);
    assert.equal(verification.healthy, true);
    assert.ok(commands.includes('existing-handler'));
    assert.ok(commands.some((command) => command.includes('bun') && command.includes('cli.mjs')));
    assert.equal(commands.some((command) => /pwsh|powershell/iu.test(command)), false);

    const cli = join(input.installRoot, 'tool', 'providers', 'codex', 'src', 'cli.mjs');
    const hook = spawnSync(process.execPath, [cli, '--runtime-home', input.runtimeHome], {
      encoding: 'utf8',
      input: '{}\n'
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).continue, true);

    const activationLock = join(input.runtimeHome, 'runtime', 'activation', 'activation.lock');
    mkdirSync(dirname(activationLock), { recursive: true });
    writeFileSync(activationLock, 'owned\n', 'utf8');
    const lockedHook = spawnSync(process.execPath, [cli, '--runtime-home', input.runtimeHome], {
      encoding: 'utf8',
      input: '{}\n'
    });
    assert.equal(lockedHook.status, 0, lockedHook.stderr);
    assert.deepEqual(JSON.parse(lockedHook.stdout), { continue: true });
  });

  test('remove deletes only managed hooks and keeps later unrelated changes', () => {
    const root = testRoot('remove');
    const input = options(root, 'codex');
    mkdirSync(input.codexHome, { recursive: true });
    writeFileSync(join(input.codexHome, 'hooks.json'), `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-handler' }] }] },
      owner: 'before'
    })}\n`, 'utf8');
    executeInstall(input);

    const configPath = join(input.codexHome, 'hooks.json');
    const changed = JSON.parse(readFileSync(configPath, 'utf8'));
    changed.owner = 'after';
    changed.hooks.Stop[0].hooks.push({ type: 'command', command: 'later-handler' });
    writeFileSync(configPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');

    const removeInput = { ...input, action: 'remove' };
    const plan = manageInstallation(removeInput);
    const result = manageInstallation({
      ...removeInput,
      expectedPlanDigest: plan.planDigest,
      execute: true
    });
    const remaining = JSON.parse(readFileSync(configPath, 'utf8'));
    const remainingCommands = Object.values(remaining.hooks)
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command);

    assert.equal(result.stateRemoved, true);
    assert.equal(remaining.owner, 'after');
    assert.deepEqual(remainingCommands.sort(), ['existing-handler', 'later-handler']);
    assert.equal(existsSync(input.installRoot), true);
    assert.equal(existsSync(join(input.installRoot, 'tool')), false);
    assert.equal(existsSync(join(input.runtimeHome, 'install-state.json')), false);
  });

  test('rollback restores byte-exact pre-install state', () => {
    const root = testRoot('rollback');
    const input = options(root, 'codex');
    const configPath = join(input.codexHome, 'hooks.json');
    const original = Buffer.from('{"hooks":{},"marker":"original"}\n', 'utf8');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);
    executeInstall(input);

    const rollbackInput = { ...input, action: 'rollback' };
    const plan = manageInstallation(rollbackInput);
    manageInstallation({ ...rollbackInput, expectedPlanDigest: plan.planDigest, execute: true });

    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(existsSync(join(input.installRoot, 'tool')), false);
    assert.equal(existsSync(join(input.runtimeHome, 'install-state.json')), false);
  });

  test('remove tolerates a provider configuration deleted after installation', () => {
    const root = testRoot('remove-missing-config');
    const input = options(root, 'claude');
    executeInstall(input);
    rmSync(join(input.claudeHome, 'settings.json'));

    const removeInput = { ...input, action: 'remove' };
    const plan = manageInstallation(removeInput);
    const result = manageInstallation({
      ...removeInput,
      expectedPlanDigest: plan.planDigest,
      execute: true
    });

    assert.equal(result.stateRemoved, true);
    assert.equal(existsSync(join(input.installRoot, 'tool')), false);
    assert.equal(existsSync(join(input.runtimeHome, 'install-state.json')), false);
  });

  test('rollback fails closed after managed target drift', () => {
    const root = testRoot('rollback-drift');
    const input = options(root, 'codex');
    executeInstall(input);
    writeFileSync(join(input.installRoot, 'tool', 'README.drift'), 'changed\n', 'utf8');

    const rollbackInput = { ...input, action: 'rollback' };
    const plan = manageInstallation(rollbackInput);
    assert.throws(() => manageInstallation({
      ...rollbackInput,
      expectedPlanDigest: plan.planDigest,
      execute: true
    }), /Rollback blocked because the installed target changed: tool/u);
    assert.equal(existsSync(join(input.runtimeHome, 'install-state.json')), true);
  });

  test('activation lock prevents concurrent installation writes', () => {
    const root = testRoot('lock');
    const input = options(root, 'codex');
    const plan = manageInstallation(input);
    const lock = join(input.runtimeHome, 'runtime', 'activation', 'activation.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'owned\n', 'utf8');

    assert.throws(() => manageInstallation({
      ...input,
      expectedManifestDigest: plan.manifestDigest,
      expectedPlanDigest: plan.planDigest,
      execute: true
    }), /Another installation operation is active/u);
    assert.equal(existsSync(join(input.installRoot, 'tool')), false);
  });

  test('detects an unmanaged identical lifecycle command', () => {
    const root = testRoot('collision');
    const input = options(root, 'codex');
    const command = buildLifecycleCommand({
      bunPath: input.bunPath,
      cliPath: join(input.installRoot, 'tool', 'providers', 'codex', 'src', 'cli.mjs'),
      runtimeHome: input.runtimeHome,
      platform: process.platform
    });
    mkdirSync(input.codexHome, { recursive: true });
    writeFileSync(join(input.codexHome, 'hooks.json'), `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] }
    })}\n`, 'utf8');

    assert.throws(() => manageInstallation(input), /already exists.*without installation state/u);
  });

  test('quotes macOS paths without shell interpolation', () => {
    const command = buildLifecycleCommand({
      bunPath: "/Users/example/O'Brien Tools/bun",
      cliPath: '/Users/example/Agent Context Broker/cli.mjs',
      runtimeHome: '/Users/example/Library/Application Support/AgentContextBroker',
      platform: 'darwin'
    });

    assert.equal(
      command,
      "'/Users/example/O'\\''Brien Tools/bun' '/Users/example/Agent Context Broker/cli.mjs' '--runtime-home' '/Users/example/Library/Application Support/AgentContextBroker'"
    );
  });
});
