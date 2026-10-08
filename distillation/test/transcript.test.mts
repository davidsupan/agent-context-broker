import { expect, test } from './expect.mts';
import { parseEvent } from '../src/transcript.mts';

const encode = (text: string) => new TextEncoder().encode(text);
const raw = (obj: unknown) => encode(JSON.stringify(obj));
const empty = { role: null, texts: [] };

test('Claude agent display metadata is not dialogue or executable input', () => {
  for (const type of ['agent-name', 'agent-color']) {
    expect(parseEvent(raw({ type, message: { role: 'assistant', content: 'DO NOT IMPORT' } }), 'claude-code')).toEqual(empty);
  }
});
const codex = (role = 'user', text = 'fixture') => ({ type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const claude = (role = 'user', content: unknown = 'fixture') => ({ type: role, message: { role, content } });
const parse = (obj: unknown, provider: 'codex' | 'claude-code' = 'codex') => parseEvent(raw(obj), provider);
function error(text: string, code: string) {
  expect(() => parseEvent(encode(text), 'codex')).toThrow(new Error(code));
}

test('Codex response, event and completed-item dialogue retain exact pointers', () => {
  for (const role of ['user', 'assistant'] as const) {
    const text = 'fixture \u017e \ud83d\ude00';
    expect(parse(codex(role, text))).toEqual({ role, texts: [{ pointer: '/payload/content/0/text', text }] });
    expect(parse({ type: 'event_msg', payload: {
      type: role === 'user' ? 'user_message' : 'agent_message', message: text,
    } })).toEqual({ role, texts: [{ pointer: '/payload/message', text }] });
    expect(parse({ type: 'event_msg', payload: { type: 'item_completed', item: {
      type: role === 'user' ? 'UserMessage' : 'AgentMessage',
      content: [{ type: role === 'user' ? 'text' : 'Text', text }],
    } } })).toEqual({ role, texts: [{ pointer: '/payload/item/content/0/text', text }] });
  }
});

test('Claude accepts string and text blocks without descending into tools', () => {
  for (const role of ['user', 'assistant'] as const) {
    expect(parse(claude(role, ''), 'claude-code')).toEqual({ role, texts: [{ pointer: '/message/content', text: '' }] });
    expect(parse(claude(role, [
      { type: 'tool_result', content: [{ type: 'text', text: 'HIDDEN' }] },
      { type: 'text', text: 'visible' },
      ...['thinking', 'redacted_thinking', 'tool_use', 'image', 'document'].map(type => ({ type, text: 'HIDDEN' })),
      { type: 'text', text: 'visible' },
    ]), 'claude-code')).toEqual({ role, texts: [
      { pointer: '/message/content/1/text', text: 'visible' },
      { pointer: '/message/content/7/text', text: 'visible' },
    ] });
    expect(parse(claude(role, [{ type: 'tool_result', content: 'HIDDEN' }]), 'claude-code')).toEqual(empty);
  }
});

test('all reference metadata and tool forms produce no role or text', () => {
  for (const type of ['session_meta', 'turn_context', 'compacted', 'world_state', 'token_usage_record']) {
    expect(parse({ type, text: 'HIDDEN' })).toEqual(empty);
  }
  for (const type of ['reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
    'custom_tool_call_output', 'web_search_call', 'tool_search_call', 'tool_search_output', 'compaction']) {
    expect(parse({ type: 'response_item', payload: { type, text: 'HIDDEN' } })).toEqual(empty);
  }
  for (const type of ['task_started', 'token_count', 'task_complete', 'turn_aborted',
    'thread_settings_applied', 'thread_goal_updated']) {
    expect(parse({ type: 'event_msg', payload: { type, message: 'HIDDEN' } })).toEqual(empty);
  }
  for (const type of ['FileChange', 'WebSearch', 'ContextCompaction', 'Plan', 'Reasoning',
    'McpToolCall', 'CommandExecution', 'Extension', 'DynamicToolCall', 'CollabAgentToolCall']) {
    expect(parse({ type: 'event_msg', payload: { type: 'item_completed', item: { type, text: 'HIDDEN' } } })).toEqual(empty);
  }
  for (const type of ['custom-title', 'mode', 'atis-latch', 'pr-link', 'file-history-snapshot',
    'queue-operation', 'attachment', 'system', 'last-prompt', 'file-history-delta']) {
    expect(parse({ type, text: 'HIDDEN' }, 'claude-code')).toEqual(empty);
  }
  for (const role of ['system', 'developer']) expect(parse(codex(role, 'HIDDEN'))).toEqual(empty);
});

test('media and empty arrays are not dialogue; mixed blocks preserve original indices', () => {
  const event = codex();
  event.payload.content = ['input_image', 'input_audio', 'image', 'audio'].map(type => ({ type, text: 'HIDDEN' }));
  expect(parse(event)).toEqual(empty);
  event.payload.content.push({ type: 'input_text', text: '' });
  expect(parse(event)).toEqual({ role: 'user', texts: [{ pointer: '/payload/content/4/text', text: '' }] });
  event.payload.content = [];
  expect(parse(event)).toEqual(empty);
});

test('hidden visibility at every envelope level wins over unknown visibility', () => {
  for (const field of ['channel', 'phase']) {
    for (const value of ['analysis', 'INTERNAL', 'reasoning', 'thinking', 'hidden']) {
      for (const location of ['top', 'payload', 'item']) {
        const item: Record<string, unknown> = { type: 'AgentMessage', content: [{ type: 'Text', text: 'HIDDEN' }] };
        const payload: Record<string, unknown> = { type: 'item_completed', item };
        const obj: Record<string, unknown> = { type: 'event_msg', payload, channel: 'unknown' };
        (location === 'top' ? obj : location === 'payload' ? payload : item)[field] = value;
        expect(parse(obj)).toEqual(empty);
      }
      expect(parse({ ...claude('assistant'), [field]: value }, 'claude-code')).toEqual(empty);
      expect(parse({ type: 'assistant', message: { role: 'assistant', content: 'HIDDEN', [field]: value } }, 'claude-code')).toEqual(empty);
      expect(parse({ type: 'event_msg', payload: { type: 'agent_message', message: 'HIDDEN', [field]: value } })).toEqual(empty);
      expect(parse({ ...codex('assistant'), [field]: value })).toEqual(empty);
    }
  }
  for (const phase of ['commentary', 'FINAL', 'final_answer', null]) {
    expect(parse({ ...codex('assistant'), phase }).role).toBe('assistant');
  }
  for (const channel of ['future', 2, {}, false]) {
    expect(() => parse({ ...codex('assistant'), channel })).toThrow('unknown-assistant-visibility');
  }
});

test('explicit sidechain, harness metadata and compaction flags exclude dialogue', () => {
  for (const flag of ['isSidechain', 'isMeta', 'isCompactSummary']) {
    for (const role of ['user', 'assistant'] as const) {
      expect(parse({ ...claude(role), [flag]: true }, 'claude-code')).toEqual(empty);
      expect(parse({ ...codex(role), [flag]: true })).toEqual(empty);
      const event = codex(role);
      expect(parse({ ...event, payload: { ...event.payload, [flag]: true } })).toEqual(empty);
      expect(parse({ ...claude(role), [flag]: false }, 'claude-code').role).toBe(role);
    }
    expect(() => parse({ ...codex(), [flag]: 'true' })).toThrow('invalid-context-flag');
  }
  expect(parse(codex('user', '<system-reminder>quoted human text</system-reminder>')).role).toBe('user');
});

test('unsupported or malformed typed events fail closed with safe codes', () => {
  const cases: Array<[unknown, string]> = [
    [[], 'invalid-record-shape'], [null, 'invalid-record-shape'], [{ type: 1 }, 'invalid-record-shape'],
    [{ type: 'PRIVATE_UNKNOWN_TYPE' }, 'unsupported-record-or-payload'],
    [{ type: 'response_item', payload: [] }, 'unsupported-record-or-payload'],
    [{ type: 'response_item', payload: {} }, 'unsupported-response-type'],
    [codex('tool'), 'unsupported-message-role'],
    [{ type: 'event_msg', payload: { type: 'user_message', message: {} } }, 'invalid-event-message'],
    [{ type: 'event_msg', payload: {} }, 'unsupported-event-shape'],
    [{ type: 'event_msg', payload: { type: 'item_completed', item: {} } }, 'unsupported-item-type'],
  ];
  for (const [obj, code] of cases) expect(() => parse(obj)).toThrow(new Error(code));
  for (const [content, code] of [
    ['not-array', 'invalid-content-shape'], [[null], 'invalid-block-shape'],
    [[{ type: 'input_text', text: 1 }], 'invalid-text-shape'],
    [[{ type: 'input_text', text: 'visible' }, { type: 'unknown', text: 'PRIVATE' }], 'unsupported-block-type'],
    [[{ type: 'output_text', text: 'wrong-role' }], 'unsupported-block-type'],
  ] as const) {
    const event = codex();
    expect(() => parse({ ...event, payload: { ...event.payload, content } })).toThrow(new Error(code));
  }
  expect(() => parse({ type: 'future' }, 'claude-code')).toThrow('unsupported-record-type');
  expect(() => parse({ type: 'assistant', message: { role: 'user', content: 'PRIVATE' } }, 'claude-code'))
    .toThrow('invalid-message-role-or-shape');
  expect(() => parseEvent(raw(codex()), 'other' as 'codex')).toThrow('unsupported-provider');
});

test('strict JSON rejects duplicates including escaped keys and ignored fields', () => {
  for (const text of [
    '{"type":"session_meta","type":"compacted"}',
    '{"type":"session_meta","ignored":{"a":1,"\\u0061":2}}',
    '{"type":"session_meta","ignored":{"__proto__":1,"__proto__":2}}',
  ]) error(text, 'duplicate-json-key');
  expect(parseEvent(encode('{"type":"session_meta","a":{"x":1},"b":{"x":2},"__proto__":{"type":"user"}}'), 'codex')).toEqual(empty);
});

test('strict JSON rejects malformed grammar without echoing source', () => {
  for (const text of ['', '\n', '{PRIVATE}', '\ufeff{}', '{} {}', '{"a":1,}', '{"a":01}',
    '{"a":+1}', '{"a":.1}', '{"a":1.}', '{"a":1e}', '{"a":undefined}',
    '{"a":"\\x00"}', '{"a":"line\nbreak"}', '{"a":"unterminated}', '{]', '[}', '{}]']) {
    error(text, 'invalid-json');
  }
});

test('strict JSON rejects nonfinite values even inside ignored metadata', () => {
  for (const number of ['NaN', 'Infinity', '-Infinity', '1e999', '-1e999', '9'.repeat(400)]) {
    error(`{"type":"session_meta","ignored":[${number}]}`, 'nonfinite-json-number');
  }
  expect(parse({ type: 'session_meta', ignored: [1e308, -0, 1.25] })).toEqual(empty);
});

test('strict UTF-8 and escaped Unicode validation applies to keys and ignored values', () => {
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
    expect(() => parseEvent(new Uint8Array(bytes), 'codex')).toThrow('invalid-unicode');
  }
  for (const value of ['\\ud800', '\\udfff', '\\ud800x', '\\ud800\\ud800']) {
    error(`{"type":"session_meta","ignored":"${value}"}`, 'invalid-unicode');
    error(`{"type":"session_meta","${value}":0}`, 'invalid-unicode');
  }
  expect(parseEvent(encode('{"type":"session_meta","ignored":"\\ud83d\\ude00"}'), 'codex')).toEqual(empty);
});

test('depth is limited before parsing; quotes, escapes and braces in strings do not affect it', () => {
  const nested = (count: number) => `{"type":"session_meta","ignored":${'['.repeat(count)}0${']'.repeat(count)}}`;
  expect(parseEvent(encode(nested(63)), 'codex')).toEqual(empty);
  error(nested(64), 'json-depth-limit');
  expect(parse(codex('user', '{["\\'.repeat(100)))).toEqual({ role: 'user',
    texts: [{ pointer: '/payload/content/0/text', text: '{["\\'.repeat(100) }] });
});

test('byte cap and Uint8Array offsets are respected; CRLF is accepted', () => {
  const base = JSON.stringify({ type: 'session_meta' });
  expect(parseEvent(encode(base + ' '.repeat(4 * 1024 * 1024 - base.length)), 'codex')).toEqual(empty);
  expect(() => parseEvent(new Uint8Array(4 * 1024 * 1024 + 1), 'codex')).toThrow('oversize-line');
  const bytes = encode('x' + base + '\r\n' + 'y');
  expect(parseEvent(bytes.subarray(1, bytes.length - 1), 'codex')).toEqual(empty);
});
