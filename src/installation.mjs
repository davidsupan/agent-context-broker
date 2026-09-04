import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRuntimeHome } from './platform-paths.mjs';

export const MINIMUM_BUN_VERSION = '1.4.0';

const PAYLOAD_DIRECTORIES = Object.freeze([
  'adapters',
  'examples',
  'fixtures',
  'profiles',
  'providers',
  'schemas',
  'src',
  'test'
]);

const PAYLOAD_FILES = Object.freeze([
  'package.json',
  'scripts/agent-context-broker.sh',
  'scripts/agent-context.mjs',
  'scripts/agent-context.sh',
  'scripts/check-package.mjs',
  'scripts/install-agent-context-broker.sh',
  'scripts/manage-agent-context-broker-installation.mjs',
  'scripts/test-agent-context-broker-installation.mjs',
  'scripts/test-agent-context-broker-installation.sh',
  'scripts/test-shell-installation.sh',
  'scripts/uninstall-agent-context-broker.sh'
]);

const PROVIDER_CONFIG = Object.freeze({
  codex: Object.freeze({
    targetName: 'codex-hooks',
    homeName: '.codex',
    configName: 'hooks.json',
    cliPath: ['providers', 'codex', 'src', 'cli.mjs'],
    events: Object.freeze([
      Object.freeze({
        name: 'SessionStart',
        matcher: 'startup|resume|clear|compact',
        timeout: 15,
        statusMessage: 'Checking reconciled context',
        additionalContextLimit: 500
      }),
      Object.freeze({
        name: 'UserPromptSubmit',
        timeout: 15,
        statusMessage: 'Refreshing reconciled context',
        additionalContextLimit: 500
      }),
      Object.freeze({
        name: 'Stop',
        timeout: 10,
        statusMessage: 'Recording context progress'
      })
    ])
  }),
  claude: Object.freeze({
    targetName: 'claude-settings',
    homeName: '.claude',
    configName: 'settings.json',
    cliPath: ['providers', 'claude-code', 'src', 'cli.mjs'],
    events: Object.freeze([
      Object.freeze({
        name: 'SessionStart',
        matcher: 'startup|resume|clear|compact|fork',
        timeout: 15,
        statusMessage: 'Checking reconciled context'
      }),
      Object.freeze({
        name: 'UserPromptSubmit',
        timeout: 15,
        statusMessage: 'Refreshing reconciled context'
      }),
      Object.freeze({
        name: 'SessionEnd',
        timeout: 10,
        statusMessage: 'Recording context progress'
      })
    ])
  })
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version ?? ''));
  if (!match) throw new Error(`Invalid Bun version: ${version ?? '<missing>'}`);
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  const actualParts = normalizedVersionParts(actual);
  const minimumParts = normalizedVersionParts(minimum);
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

export function assertSupportedBun(version = globalThis.Bun?.version) {
  const major = version ? normalizedVersionParts(version)[0] : null;
  if (!version || major !== 1 || !versionAtLeast(version, MINIMUM_BUN_VERSION)) {
    throw new Error(`Agent Context Broker requires Bun ${MINIMUM_BUN_VERSION} or newer, below 2.0.0.`);
  }
  return version;
}

function stableJson(value, { compact = false } = {}) {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function pathKind(path) {
  if (!existsSync(path)) return 'absent';
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  throw new Error(`Unsupported file-system object: ${path}`);
}

function assertSafeInputPath(path, name) {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path.`);
  if (/[\0\r\n]/u.test(path)) throw new Error(`${name} must not contain control characters.`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${name} must not be a symbolic link: ${path}`);
  }
}

function walkFiles(root) {
  if (pathKind(root) !== 'directory') throw new Error(`Directory is missing: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported file-system object: ${path}`);
    }
  };
  visit(root);
  return files.sort(compareText);
}

export function directoryManifest(path) {
  const root = resolve(path);
  return walkFiles(root).map((file) => ({
    path: relative(root, file).split(sep).join('/'),
    sha256: sha256File(file)
  }));
}

export function directoryDigest(path) {
  return sha256Bytes(stableJson(directoryManifest(path), { compact: true }));
}

export function payloadManifest(packageRoot) {
  const root = resolve(packageRoot);
  const paths = [];
  for (const directory of PAYLOAD_DIRECTORIES) {
    const directoryPath = join(root, directory);
    if (pathKind(directoryPath) !== 'directory') {
      throw new Error(`Payload directory is missing: ${directory}`);
    }
    for (const file of walkFiles(directoryPath)) {
      paths.push(relative(root, file).split(sep).join('/'));
    }
  }
  for (const path of PAYLOAD_FILES) {
    if (pathKind(join(root, path)) !== 'file') throw new Error(`Payload file is missing: ${path}`);
    paths.push(path);
  }
  return [...new Set(paths)].sort(compareText).map((path) => ({
    path,
    sha256: sha256File(join(root, path))
  }));
}

function copyDirectoryExact(source, destination) {
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  for (const sourcePath of walkFiles(source)) {
    const targetPath = join(destination, relative(source, sourcePath));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, lstatSync(sourcePath).mode & 0o777);
  }
}

function copyPayloadExact(source, destination, manifest) {
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of manifest) {
    const sourcePath = join(source, entry.path);
    const targetPath = join(destination, entry.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, lstatSync(sourcePath).mode & 0o777);
  }
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split(sep).at(-1)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJsonDocument(path) {
  if (!existsSync(path)) return { hooks: {} };
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (!document || Array.isArray(document) || typeof document !== 'object') {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  if (document.hooks === undefined) document.hooks = {};
  if (!document.hooks || Array.isArray(document.hooks) || typeof document.hooks !== 'object') {
    throw new Error(`Expected hooks to be a JSON object: ${path}`);
  }
  return document;
}

export function addLifecycleHandler(document, eventName, command, options) {
  const groups = Array.isArray(document.hooks[eventName]) ? document.hooks[eventName] : [];
  const matches = groups.flatMap((group) => Array.isArray(group.hooks) ? group.hooks : [])
    .filter((handler) => handler?.command === command);
  if (matches.length > 1) throw new Error(`Duplicate Agent Context Broker handlers found for ${eventName}.`);
  if (matches.length === 1) {
    throw new Error(`An Agent Context Broker handler already exists for ${eventName} without installation state.`);
  }

  const handler = {
    type: 'command',
    command,
    timeout: options.timeout,
    statusMessage: options.statusMessage
  };
  if (options.additionalContextLimit !== undefined) {
    handler.additionalContextLimit = options.additionalContextLimit;
  }

  const compatibleGroups = groups.filter((group) => options.matcher
    ? Object.hasOwn(group, 'matcher') && String(group.matcher) === options.matcher
    : !Object.hasOwn(group, 'matcher') || !String(group.matcher ?? '').trim());
  if (compatibleGroups.length > 1) {
    throw new Error(`Multiple compatible hook groups found for ${eventName}.`);
  }
  if (compatibleGroups.length === 1) {
    compatibleGroups[0].hooks = [...(compatibleGroups[0].hooks ?? []), handler];
  } else {
    groups.push(options.matcher
      ? { matcher: options.matcher, hooks: [handler] }
      : { hooks: [handler] });
  }
  document.hooks[eventName] = groups;
}

export function removeLifecycleHandler(document, eventName, command) {
  const groups = Array.isArray(document.hooks[eventName]) ? document.hooks[eventName] : [];
  let removed = 0;
  const remainingGroups = [];
  for (const group of groups) {
    const hooks = (Array.isArray(group.hooks) ? group.hooks : []).filter((handler) => {
      if (handler?.command !== command) return true;
      removed += 1;
      return false;
    });
    if (hooks.length > 0) remainingGroups.push({ ...group, hooks });
  }
  if (remainingGroups.length > 0) document.hooks[eventName] = remainingGroups;
  else delete document.hooks[eventName];
  return removed;
}

function commandQuote(value, platform) {
  if (platform === 'win32') {
    if (/["\r\n]/u.test(value)) throw new Error('Windows hook command paths must not contain quotes or line breaks.');
    return `"${value}"`;
  }
  if (/[\0\r\n]/u.test(value)) throw new Error('POSIX hook command paths must not contain control characters.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildLifecycleCommand({ bunPath, cliPath, runtimeHome, platform = process.platform }) {
  return [bunPath, cliPath, '--runtime-home', runtimeHome]
    .map((value) => commandQuote(value, platform))
    .join(' ');
}

function targetState(target) {
  const kind = pathKind(target.path);
  const present = target.kind === 'directory' ? kind === 'directory' : kind === 'file';
  if (kind !== 'absent' && !present) {
    throw new Error(`Target has the wrong file-system kind: ${target.path}`);
  }
  return {
    state: present ? 'present' : 'absent',
    sha256: !present ? null : target.kind === 'directory'
      ? directoryDigest(target.path)
      : sha256File(target.path)
  };
}

function sameState(left, right) {
  return left.state === right.state && left.sha256 === right.sha256;
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[-:.]/gu, '');
}

function openActivationLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Another installation operation is active: ${path}`);
    throw error;
  }
}

function closeActivationLock(handle, path) {
  closeSync(handle);
  rmSync(path, { force: true });
}

function backupTarget(target, backupRoot) {
  const state = targetState(target);
  if (state.state === 'absent') return state;
  if (target.kind === 'directory') {
    copyDirectoryExact(target.path, join(backupRoot, target.name));
  } else {
    mkdirSync(backupRoot, { recursive: true });
    copyFileSync(target.path, join(backupRoot, `${target.name}.file`));
  }
  return state;
}

function restoreTarget(record, backupRoot) {
  if (record.baseState === 'absent' || record.state === 'absent') {
    rmSync(record.path, { force: true, recursive: record.kind === 'directory' });
  } else if (record.kind === 'directory') {
    copyDirectoryExact(join(backupRoot, record.name), record.path);
  } else {
    writeAtomic(record.path, readFileSync(join(backupRoot, `${record.name}.file`)));
  }
}

function selectedProviders(provider) {
  const normalized = String(provider ?? 'both').toLowerCase();
  if (!['both', 'codex', 'claude'].includes(normalized)) {
    throw new Error(`Unsupported provider selection: ${provider}`);
  }
  return normalized === 'both' ? ['codex', 'claude'] : [normalized];
}

function canonicalPath(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isWithin(parent, child, platform) {
  const normalizedParent = canonicalPath(parent);
  const normalizedChild = canonicalPath(child);
  const left = platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent;
  const right = platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild;
  return right === left || right.startsWith(`${left}${sep}`);
}

function normalizeOptions(input = {}) {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const options = {
    action: input.action ?? 'install',
    provider: input.provider ?? 'both',
    packageRoot: resolve(input.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..')),
    installRoot: resolve(input.installRoot ?? join(home, '.agent-context-broker')),
    codexHome: resolve(input.codexHome ?? join(home, '.codex')),
    claudeHome: resolve(input.claudeHome ?? join(home, '.claude')),
    runtimeHome: resolve(input.runtimeHome ?? defaultRuntimeHome({ home, platform, env: input.env })),
    bunPath: realpathSync(resolve(input.bunPath ?? process.execPath)),
    expectedManifestDigest: input.expectedManifestDigest,
    expectedPlanDigest: input.expectedPlanDigest,
    execute: input.execute === true,
    platform
  };
  for (const [name, path] of Object.entries({
    PackageRoot: options.packageRoot,
    InstallRoot: options.installRoot,
    CodexHome: options.codexHome,
    ClaudeHome: options.claudeHome,
    RuntimeHome: options.runtimeHome,
    BunPath: options.bunPath
  })) assertSafeInputPath(path, name);
  if (!['install', 'remove', 'rollback'].includes(options.action)) {
    throw new Error(`Unsupported installation action: ${options.action}`);
  }
  return options;
}

function installTargets(options, manifest) {
  const toolPath = join(options.installRoot, 'tool');
  if (isWithin(options.packageRoot, toolPath, options.platform) ||
      isWithin(toolPath, options.packageRoot, options.platform)) {
    throw new Error('PackageRoot and the managed tool destination must not overlap.');
  }
  return [
    {
      name: 'tool',
      kind: 'directory',
      path: toolPath,
      source: options.packageRoot,
      payloadManifest: manifest
    },
    {
      name: 'shared-launcher',
      kind: 'file',
      path: join(options.installRoot, 'scripts', 'agent-context.sh'),
      source: join(options.packageRoot, 'scripts', 'agent-context.sh')
    },
  ];
}

function configTargets(options) {
  const homes = { codex: options.codexHome, claude: options.claudeHome };
  return selectedProviders(options.provider).map((provider) => {
    const definition = PROVIDER_CONFIG[provider];
    const path = join(homes[provider], definition.configName);
    const cliPath = join(options.installRoot, 'tool', ...definition.cliPath);
    const command = buildLifecycleCommand({
      bunPath: options.bunPath,
      cliPath,
      runtimeHome: options.runtimeHome,
      platform: options.platform
    });
    const document = readJsonDocument(path);
    for (const event of definition.events) {
      addLifecycleHandler(document, event.name, command, event);
    }
    return {
      name: definition.targetName,
      kind: 'config',
      path,
      command,
      events: definition.events.map((event) => event.name),
      proposedText: stableJson(document)
    };
  });
}

function planDigest(plan) {
  return sha256Bytes(stableJson(plan, { compact: true }));
}

function assertExpectedDigest(name, expected, actual) {
  if (!expected) throw new Error(`${name} is required with --execute. Run the same command without --execute first.`);
  if (expected !== actual) throw new Error(`${name} mismatch. Re-run the plan and review the changed inputs.`);
}

function writeTarget(target, manifest) {
  if (target.kind === 'directory') copyPayloadExact(target.source, target.path, manifest);
  else if (target.kind === 'file') writeAtomic(target.path, readFileSync(target.source));
  else writeAtomic(target.path, Buffer.from(target.proposedText, 'utf8'));
}

function countConfigHandlers(target) {
  if (!existsSync(target.path)) return new Map(target.events.map((event) => [event, 0]));
  const document = readJsonDocument(target.path);
  return new Map(target.events.map((event) => {
    const groups = Array.isArray(document.hooks[event]) ? document.hooks[event] : [];
    const count = groups.flatMap((group) => Array.isArray(group.hooks) ? group.hooks : [])
      .filter((handler) => handler?.command === target.command).length;
    return [event, count];
  }));
}

function removeConfigTarget(target) {
  const current = targetState(target);
  if (current.state === 'absent') return;
  if (target.baseState === 'absent' && current.sha256 === target.proposedSha256) {
    unlinkSync(target.path);
    return;
  }
  const document = readJsonDocument(target.path);
  let removed = 0;
  for (const event of target.events) removed += removeLifecycleHandler(document, event, target.command);
  if (removed === 0) throw new Error(`Removal blocked because installed handlers are missing: ${target.name}`);
  writeAtomic(target.path, Buffer.from(stableJson(document), 'utf8'));
}

function install(options) {
  const statePath = join(options.runtimeHome, 'install-state.json');
  if (existsSync(statePath)) {
    throw new Error('An installation is already recorded. Remove or roll it back before installing again.');
  }
  const manifest = payloadManifest(options.packageRoot);
  const manifestDigest = sha256Bytes(stableJson(manifest, { compact: true }));
  const version = JSON.parse(readFileSync(join(options.packageRoot, 'package.json'), 'utf8')).version;
  const targets = [...installTargets(options, manifest), ...configTargets(options)];
  const targetPlan = targets.map((target) => {
    const current = targetState(target);
    const proposedSha256 = target.kind === 'directory'
      ? manifestDigest
      : target.kind === 'file'
        ? sha256File(target.source)
        : sha256Bytes(target.proposedText);
    return {
      name: target.name,
      kind: target.kind,
      path: target.path,
      baseState: current.state,
      baseSha256: current.sha256,
      proposedSha256
    };
  });
  const plan = {
    action: 'Install',
    version,
    provider: String(options.provider).toLowerCase(),
    bunVersion: assertSupportedBun(),
    bunPath: options.bunPath,
    manifestDigest,
    targets: targetPlan
  };
  const digest = planDigest(plan);
  if (!options.execute) {
    return {
      ...plan,
      writesEnabled: false,
      planDigest: digest,
      execution: {
        expectedManifestDigest: manifestDigest,
        expectedPlanDigest: digest
      }
    };
  }

  assertExpectedDigest('ExpectedManifestDigest', options.expectedManifestDigest, manifestDigest);
  assertExpectedDigest('ExpectedPlanDigest', options.expectedPlanDigest, digest);
  const backupRoot = join(options.runtimeHome, 'backups', timestamp());
  const activationLock = join(options.runtimeHome, 'runtime', 'activation', 'activation.lock');
  const lock = openActivationLock(activationLock);
  const written = [];
  const records = [];
  try {
    for (const target of targets) {
      const planned = targetPlan.find((entry) => entry.name === target.name);
      if (!sameState(targetState(target), {
        state: planned.baseState,
        sha256: planned.baseSha256
      })) throw new Error(`Installation target state changed after planning: ${target.name}`);
    }
    for (const target of targets) {
      const base = backupTarget(target, backupRoot);
      const planned = targetPlan.find((entry) => entry.name === target.name);
      records.push({
        name: target.name,
        kind: target.kind,
        path: target.path,
        baseState: base.state,
        baseSha256: base.sha256,
        proposedSha256: planned.proposedSha256,
        command: target.kind === 'config' ? target.command : null,
        events: target.kind === 'config' ? target.events : []
      });
    }
    for (const target of targets) {
      written.push(target);
      writeTarget(target, manifest);
      const expected = records.find((entry) => entry.name === target.name).proposedSha256;
      if (targetState(target).sha256 !== expected) {
        throw new Error(`Post-write verification failed: ${target.name}`);
      }
    }
    const state = {
      schemaVersion: 2,
      package: 'agent-context-broker',
      version,
      provider: String(options.provider).toLowerCase(),
      runtime: { name: 'bun', version: globalThis.Bun.version, path: options.bunPath },
      installedAt: new Date().toISOString(),
      installRoot: options.installRoot,
      runtimeHome: options.runtimeHome,
      manifestDigest,
      planDigest: digest,
      backupDirectory: backupRoot,
      targets: records
    };
    writeAtomic(statePath, Buffer.from(stableJson(state), 'utf8'));
    return state;
  } catch (error) {
    for (const target of [...written].reverse()) {
      const planned = targetPlan.find((entry) => entry.name === target.name);
      restoreTarget({ ...planned, path: target.path }, backupRoot);
    }
    throw error;
  } finally {
    closeActivationLock(lock, activationLock);
  }
}

function removeOrRollback(options) {
  const statePath = join(options.runtimeHome, 'install-state.json');
  if (!existsSync(statePath)) throw new Error(`No installation state was found at ${statePath}.`);
  const stateDigest = sha256File(statePath);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const stateTargets = state.targets ?? [];
  const targetPlan = stateTargets.map((target) => {
    const current = targetState(target);
    return {
      name: target.name,
      kind: target.kind,
      path: target.path,
      currentState: current.state,
      currentSha256: current.sha256,
      installedSha256: target.proposedSha256,
      baseState: target.baseState
    };
  });
  const action = options.action === 'rollback' ? 'Rollback' : 'Remove';
  const plan = {
    action,
    version: state.version,
    provider: state.provider,
    stateDigest,
    targets: targetPlan
  };
  const digest = planDigest(plan);
  if (!options.execute) {
    return {
      ...plan,
      writesEnabled: false,
      planDigest: digest,
      execution: { expectedPlanDigest: digest }
    };
  }
  assertExpectedDigest('ExpectedPlanDigest', options.expectedPlanDigest, digest);

  if (options.action === 'rollback') {
    for (const target of stateTargets) {
      const current = targetState(target);
      if (current.state !== 'present' || current.sha256 !== target.proposedSha256) {
        throw new Error(`Rollback blocked because the installed target changed: ${target.name}`);
      }
    }
  } else {
    for (const target of stateTargets.filter((entry) => entry.kind !== 'config')) {
      const current = targetState(target);
      if (current.state === 'present' && current.sha256 !== target.proposedSha256) {
        throw new Error(`Removal blocked because the installed target changed: ${target.name}`);
      }
    }
    for (const target of stateTargets.filter((entry) => entry.kind === 'config')) {
      const current = targetState(target);
      if (current.state === 'absent') continue;
      if (target.baseState === 'absent' && current.sha256 === target.proposedSha256) continue;
      for (const [event, count] of countConfigHandlers(target)) {
        if (count !== 1) {
          throw new Error(`Removal blocked because the installed handler changed: ${target.name}/${event}`);
        }
      }
    }
  }

  const activationLock = join(options.runtimeHome, 'runtime', 'activation', 'activation.lock');
  const lock = openActivationLock(activationLock);
  const operationBackupRoot = join(
    options.runtimeHome,
    'operation-backups',
    `${timestamp()}-${options.action}`
  );
  const currentRecords = [];
  try {
    for (const planned of targetPlan) {
      const target = stateTargets.find((entry) => entry.name === planned.name);
      const current = targetState(target);
      if (current.state !== planned.currentState || current.sha256 !== planned.currentSha256) {
        throw new Error(`Installation target state changed after planning: ${target.name}`);
      }
    }
    for (const target of stateTargets) {
      const current = backupTarget(target, operationBackupRoot);
      currentRecords.push({
        name: target.name,
        kind: target.kind,
        path: target.path,
        state: current.state
      });
    }
    for (const target of [...stateTargets].reverse()) {
      if (target.kind === 'config' && options.action === 'remove') removeConfigTarget(target);
      else restoreTarget(target, state.backupDirectory);
    }
    unlinkSync(statePath);
  } catch (error) {
    for (const target of [...currentRecords].reverse()) restoreTarget(target, operationBackupRoot);
    throw error;
  } finally {
    closeActivationLock(lock, activationLock);
  }
  return {
    action,
    writesEnabled: true,
    version: state.version,
    provider: state.provider,
    stateRemoved: true
  };
}

export function manageInstallation(input = {}) {
  const options = normalizeOptions(input);
  assertSupportedBun();
  return options.action === 'install' ? install(options) : removeOrRollback(options);
}

export function verifyInstallation(input = {}) {
  const options = normalizeOptions({ ...input, action: 'remove' });
  const statePath = join(options.runtimeHome, 'install-state.json');
  if (!existsSync(statePath)) throw new Error(`No installation state was found at ${statePath}.`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const targets = state.targets.map((target) => {
    const current = targetState(target);
    const matches = current.state === 'present' && (target.kind === 'config'
      ? [...countConfigHandlers(target).values()].every((count) => count === 1)
      : current.sha256 === target.proposedSha256);
    return {
      name: target.name,
      present: current.state === 'present',
      expectedSha256: target.proposedSha256,
      actualSha256: current.sha256,
      matches
    };
  });
  return {
    schemaVersion: 2,
    package: 'agent-context-broker',
    version: state.version,
    installedAt: state.installedAt,
    runtime: state.runtime,
    runtimeHome: options.runtimeHome,
    healthy: targets.every((target) => target.matches),
    targets
  };
}
