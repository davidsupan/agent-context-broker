// Explicitly approved on 2026-09-22; never an execution-tool rejection receipt.
export const CODEX_STARTUP_NOTICE_POLICY = {
  version: '0.154.0',
  executableSha256: 'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde',
  code: 'code-mode-host-disabled',
  message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
} as const;

export type CodexParserBinding = { version: string; executableSha256: string };

export function permitsCodexStartupNotice(binding?: CodexParserBinding) {
  return binding?.version === CODEX_STARTUP_NOTICE_POLICY.version &&
    binding.executableSha256 === CODEX_STARTUP_NOTICE_POLICY.executableSha256;
}
