import { expect, test } from './expect.mts';
import { parseProviderOutput } from '../src/provider.mts';
import { CODEX_STARTUP_NOTICE_POLICY as policy } from '../src/codex-startup-policy.mts';

const notice = () => ({ type: 'item.completed', item: { id: 'startup', type: 'error', message: policy.message } });
const events = (): any[] => [
  { type: 'thread.started', thread_id: 'synthetic' }, notice(),
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: '{"synthetic":true}' } },
  { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } },
];
const encode = (items: unknown[]) => items.map(value => JSON.stringify(value)).join('\n');

test('only the approved binary accepts and records the exact startup notice', () => {
  const parsed = parseProviderOutput('codex', encode(events()), 0, policy);
  expect(parsed.output).toEqual({ synthetic: true });
  expect(parsed.startupNotices).toEqual(['code-mode-host-disabled']);
  for (const binding of [undefined, { ...policy, version: '0.154.1' }, { ...policy, executableSha256: 'a'.repeat(64) }]) {
    expect(() => parseProviderOutput('codex', encode(events()), 0, binding)).toThrow();
  }
});

test('malformed, misplaced, repeated and unrelated errors remain blocking', () => {
  const cases: any[][] = [];
  let e = events(); [e[0], e[1]] = [e[1], e[0]]; cases.push(e);
  e = events(); [e[1], e[2]] = [e[2], e[1]]; cases.push(e);
  e = events(); e.splice(2, 0, notice()); cases.push(e);
  e = events(); e[1].item.message += ' '; cases.push(e);
  e = events(); e[1].item.extra = true; cases.push(e);
  e = events(); e[3].item.id = 'startup'; cases.push(e);
  e = events(); e[3] = { type: 'turn.failed', error: { message: 'synthetic failure' } }; cases.push(e);
  e = events(); e[3].item = { id: 'tool', type: 'command_execution', command: 'synthetic' }; cases.push(e);
  e = events(); e.splice(3, 1); cases.push(e);
  for (const items of cases) {
    expect(() => parseProviderOutput('codex', encode(items), 0, policy)).toThrow();
  }
  expect(() => parseProviderOutput('codex', encode(events()), 1, policy)).toThrow();
});
