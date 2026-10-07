import { homedir } from 'node:os';
import { join } from 'node:path';

// Disposable proposal only. No production imports, activation, auth copying or receipts.
export const CODEX_PROPOSAL_PIN = {
  version: '0.154.0',
  sha256: 'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde',
  executable: join(homedir(), 'AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe').replace(/\\/g, '/'),
} as const;

export const CODE_MODE_NOTICE = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

export const PROPOSAL_SOURCES = {
  configuration: 'https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/config_toml.rs',
  skillInstructions: 'https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/config/mod.rs#L3695',
  startupWarning: 'https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/code_mode/mod.rs#L93',
} as const;

/** Does not suppress errors or grant capability. Keeps independent observations separate. */
export function classifyProposalEvidence(stdout: string, wire: {
  requests: Array<{ toolCount?: unknown }>;
  toolResults: Array<{ callIdMatches?: unknown; unsupportedTool?: unknown; executionMarkerPresent?: unknown }>;
}) {
  if (Buffer.byteLength(stdout) > 65536) throw new Error('proposal-output-limit');
  const lines = stdout.trim().split('\n');
  if (lines.length > 256) throw new Error('proposal-event-limit');
  let noticeCount = 0, otherErrorCount = 0;
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.type === 'item.completed' && e.item?.type === 'error' && e.item.message === CODE_MODE_NOTICE) noticeCount++;
    else if (e.type === 'error' || e.type === 'turn.failed' || e.item?.type === 'error') otherErrorCount++;
  }
  return {
    startupNoticeCount: noticeCount,
    otherErrorCount,
    zeroAdvertisedTools: wire.requests.length === 2 && wire.requests.every(r => r.toolCount === 0),
    executionChallengeRejected: wire.toolResults.length === 1 && wire.toolResults.every(r =>
      r.callIdMatches === true && r.unsupportedTool === true && r.executionMarkerPresent === false),
    // The existing stdout attestation gate is deliberately unchanged.
    productionAuthorized: false as const,
    liveAuthVerified: false as const,
  };
}
