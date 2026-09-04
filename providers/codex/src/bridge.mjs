import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const providerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolRoot = process.env.AGENT_CONTEXT_BROKER_TOOL_ROOT ??
  resolve(providerRoot, '..', '..');
const runtimeHome = process.env.AGENT_CONTEXT_BROKER_HOME ?? join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'AgentContextBroker'
);
const { createLifecycleConsumer } = await import(
  pathToFileURL(join(toolRoot, 'src', 'lifecycle-consumer.mjs')).href
);

function allowedTranscriptRoots() {
  const roots = [];
  if (process.env.CODEX_HOME) roots.push(process.env.CODEX_HOME);
  if (process.env.AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS) {
    roots.push(...process.env.AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS.split(delimiter).filter(Boolean));
  }
  roots.push(join(homedir(), '.codex'));
  return roots;
}

const consumer = createLifecycleConsumer({
  provider: 'codex',
  adapterModule: 'codex-inventory-v2.mjs',
  adapterRoot: toolRoot,
  runtimeRoot: process.env.AGENT_CONTEXT_BROKER_CODEX_V2_RUNTIME ??
    join(runtimeHome, 'runtime', 'codex-lifecycle'),
  eventRuntimeRoot: process.env.AGENT_CONTEXT_BROKER_EVENT_RUNTIME ??
    join(runtimeHome, 'runtime', 'events'),
  reviewLedgersRoot: process.env.AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT ??
    join(runtimeHome, 'runtime', 'reviews'),
  defaultProjectKey: process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT ?? null,
  strictIsolation: () => process.env.AGENT_CONTEXT_BROKER_STRICT_ISOLATION === '1',
  supportedEvents: ['SessionStart', 'UserPromptSubmit', 'Stop'],
  advisoryEvents: ['SessionStart', 'UserPromptSubmit'],
  lifecycleForEvent: (eventName) => eventName === 'Stop' ? 'session_end' : null,
  allowedTranscriptRoots
});

export const { handleHookEvent, recordFailOpen, runtimeDefaults } = consumer;
