export type ParsedEvent = {
  role: 'user' | 'assistant' | null;
  texts: Array<{ pointer: string; text: string }>;
};

type RecordValue = Record<string, unknown>;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const codexTop = new Set(['session_meta', 'turn_context', 'compacted', 'world_state', 'token_usage_record']);
const codexResponse = new Set(['reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'web_search_call', 'tool_search_call', 'tool_search_output', 'compaction']);
const codexEvents = new Set(['task_started', 'token_count', 'task_complete', 'turn_aborted',
  'thread_settings_applied', 'thread_goal_updated']);
const codexItems = new Set(['FileChange', 'WebSearch', 'ContextCompaction', 'Plan', 'Reasoning',
  'McpToolCall', 'CommandExecution', 'Extension', 'DynamicToolCall', 'CollabAgentToolCall']);
const claudeOther = new Set(['custom-title', 'agent-name', 'agent-color', 'mode', 'atis-latch', 'pr-link', 'file-history-snapshot',
  'queue-operation', 'attachment', 'system', 'last-prompt', 'file-history-delta']);
const hidden = new Set(['analysis', 'internal', 'reasoning', 'thinking', 'hidden']);
const visible = new Set(['commentary', 'final', 'final_answer']);

function reject(code: string): never { throw new Error(code); }
function empty(): ParsedEvent { return { role: null, texts: [] }; }
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function whitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}
function nativeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return reject('invalid-json'); }
}
function unicode(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject('invalid-unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) reject('invalid-unicode');
  }
}

function strictJson(raw: Uint8Array): unknown {
  if (raw.byteLength > MAX_BYTES) reject('oversize-line');
  let text: string;
  try {
    // Preserve a BOM so the native JSON grammar rejects it, matching Python.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch { return reject('invalid-unicode'); }

  // Native JSON.parse handles grammar, but cannot detect duplicate keys. Scan
  // strings and container scopes first, bounding depth before graph allocation.
  const scopes: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i >= text.length) reject('invalid-json');
      const value = nativeJson(text.slice(start, i + 1));
      if (typeof value !== 'string') reject('invalid-json');
      unicode(value);
      let next = i + 1;
      while (whitespace(text[next])) next++;
      if (text[next] === ':') {
        const keys = scopes.at(-1);
        if (!keys) reject('invalid-json');
        if (keys.has(value)) reject('duplicate-json-key');
        keys.add(value);
      }
    } else if (char === '{' || char === '[') {
      if (scopes.length >= MAX_DEPTH) reject('json-depth-limit');
      scopes.push(char === '{' ? new Set() : null);
    } else if (char === '}' || char === ']') {
      if (!scopes.length || (char === '}') !== (scopes.at(-1) !== null)) reject('invalid-json');
      scopes.pop();
    } else if (char === 'N' || char === 'I') {
      if (text.startsWith('NaN', i) || text.startsWith('Infinity', i)) reject('nonfinite-json-number');
    }
  }
  if (scopes.length) reject('invalid-json');
  const result = nativeJson(text);
  // Visit ignored fields too: tool/metadata bodies are not exempt from strict JSON.
  const stack: unknown[] = [result];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) reject('nonfinite-json-number');
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (record(value)) {
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return result;
}

function excluded(role: 'user' | 'assistant', containers: RecordValue[]): boolean {
  let context = false;
  let internal = false;
  let unknownVisibility = false;
  for (const container of containers) {
    // Explicit provenance only; do not guess from a human's text or quoted tags.
    for (const flag of ['isSidechain', 'isMeta', 'isCompactSummary']) {
      const value = container[flag];
      if (value !== undefined && typeof value !== 'boolean') reject('invalid-context-flag');
      context ||= value === true;
    }
    if (role !== 'assistant') continue;
    for (const field of ['channel', 'phase']) {
      const value = container[field];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && hidden.has(value.toLowerCase())) internal = true;
      else if (typeof value !== 'string' || !visible.has(value.toLowerCase())) unknownVisibility = true;
    }
  }
  if (context || internal) return true;
  if (unknownVisibility) reject('unknown-assistant-visibility');
  return false;
}

function blocks(role: 'user' | 'assistant', content: unknown, pointer: string,
  textType: string, otherTypes: string[], allowString = false): ParsedEvent {
  if (allowString && typeof content === 'string') return { role, texts: [{ pointer, text: content }] };
  if (!Array.isArray(content)) reject('invalid-content-shape');
  const texts: ParsedEvent['texts'] = [];
  for (const [index, block] of content.entries()) {
    if (!record(block) || typeof block.type !== 'string') reject('invalid-block-shape');
    if (block.type === textType) {
      if (typeof block.text !== 'string') reject('invalid-text-shape');
      texts.push({ pointer: `${pointer}/${index}/text`, text: block.text });
    } else if (!otherTypes.includes(block.type)) reject('unsupported-block-type');
  }
  return texts.length ? { role, texts } : empty();
}

/** Parse one bounded provider event; error messages never contain source content. */
export function parseEvent(raw: Uint8Array, provider: 'codex' | 'claude-code'): ParsedEvent {
  if (provider !== 'codex' && provider !== 'claude-code') reject('unsupported-provider');
  const obj = strictJson(raw);
  if (!record(obj) || typeof obj.type !== 'string') reject('invalid-record-shape');
  if (provider === 'claude-code') {
    if (claudeOther.has(obj.type)) return empty();
    if (obj.type !== 'user' && obj.type !== 'assistant') reject('unsupported-record-type');
    const message = obj.message;
    if (!record(message) || message.role !== obj.type) reject('invalid-message-role-or-shape');
    if (excluded(obj.type, [obj, message])) return empty();
    return blocks(obj.type, message.content, '/message/content', 'text',
      ['thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'document'], true);
  }
  if (codexTop.has(obj.type)) return empty();
  const payload = obj.payload;
  if ((obj.type !== 'response_item' && obj.type !== 'event_msg') || !record(payload)) {
    reject('unsupported-record-or-payload');
  }
  const sub = payload.type;
  if (obj.type === 'response_item') {
    if (typeof sub === 'string' && codexResponse.has(sub)) return empty();
    if (sub !== 'message') reject('unsupported-response-type');
    const role = payload.role;
    if (role === 'system' || role === 'developer') return empty();
    if (role !== 'user' && role !== 'assistant') reject('unsupported-message-role');
    if (excluded(role, [obj, payload])) return empty();
    return blocks(role, payload.content, '/payload/content', role === 'user' ? 'input_text' : 'output_text',
      ['input_image', 'input_audio', 'image', 'audio']);
  }
  if (typeof sub === 'string' && codexEvents.has(sub)) return empty();
  if (sub === 'user_message' || sub === 'agent_message') {
    const role = sub === 'user_message' ? 'user' : 'assistant';
    if (excluded(role, [obj, payload])) return empty();
    if (typeof payload.message !== 'string') reject('invalid-event-message');
    return { role, texts: [{ pointer: '/payload/message', text: payload.message }] };
  }
  const item = payload.item;
  if (sub !== 'item_completed' || !record(item)) reject('unsupported-event-shape');
  if (typeof item.type === 'string' && codexItems.has(item.type)) return empty();
  if (item.type !== 'UserMessage' && item.type !== 'AgentMessage') reject('unsupported-item-type');
  const role = item.type === 'UserMessage' ? 'user' : 'assistant';
  if (excluded(role, [obj, payload, item])) return empty();
  return blocks(role, item.content, '/payload/item/content', role === 'user' ? 'text' : 'Text',
    ['local_image', 'image']);
}
