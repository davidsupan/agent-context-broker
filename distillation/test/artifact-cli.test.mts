import { expect, test } from './expect.mts';
import { artifactQueryCli } from '../src/artifact-cli.mts';

test('isolated CLI query does not need configuration and does not write', async () => {
  for (const provider of ['codex', 'claude-code']) {
    expect(await artifactQueryCli(['query', '--provider', provider, '--strict-isolation', '--execute'], 'missing-private-config'))
      .toMatchObject({ sourceArtifacts: [], artifactAudit: { persisted: false }, coverage: { state: 'not-read' } });
  }
});
test('unknown flags and non-query commands cannot silently change routing', async () => {
  await expect(artifactQueryCli(['query', '--query-terms', 'x'], 'missing')).rejects.toThrow();
  await expect(artifactQueryCli(['publish'], 'missing')).rejects.toThrow('artifact-query-command-required');
});
