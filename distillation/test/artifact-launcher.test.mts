import { expect, test } from './expect.mts';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const launcher = fileURLToPath(new URL('../scripts/context-with-artifacts.mjs', import.meta.url));

test('progress and publication use the configured store, not the platform default', () => {
  const home = mkdtempSync(join(tmpdir(), 'acb-launch-binding-'));
  try {
    const install = join(home, '.agent-context-broker');
    const tool = join(home, 'tool');
    mkdirSync(install, { recursive: true });
    mkdirSync(join(tool, 'scripts'), { recursive: true });
    const runtime = join(home, 'active-home');
    const queryConfig = join(home, 'query.json');
    writeFileSync(join(install, 'artifact-query.json'), JSON.stringify({ queryConfig }));
    writeFileSync(queryConfig, JSON.stringify({ brokerRuntimeHome: runtime, brokerToolRoot: tool }));
    writeFileSync(join(tool, 'scripts/agent-context.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    for (const command of ['progress', 'publish', 'route']) {
      const r = spawnSync(process.execPath, [launcher, command, '--provider', 'claude-code'], { env });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.toString())).toEqual([command, '--provider', 'claude-code', '--runtime-home', runtime]);
    }
    const bad = spawnSync(process.execPath, [launcher, 'progress', '--runtime-home', join(home, 'wrong')], { env });
    expect(bad.status).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('launcher recognizes equals-form isolation without configuration', () => {
  const result = spawnSync(process.execPath, [launcher, 'query', '--profile=strict-isolation', '--execute']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ sourceArtifacts: [], coverage: { state: 'not-read' }, artifactAudit: { persisted: false } });
});
test('launcher rejects unknown flags even when isolation was requested', () => {
  const result = spawnSync(process.execPath, [launcher, 'query', '--strict-isolation', '--unknown-flag']);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout.toString()).code).toBe('artifact-query-failed');
});
