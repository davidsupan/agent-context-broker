#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUNTIME=${AGENT_CONTEXT_BROKER_RUNTIME:-}
if [ -z "$RUNTIME" ]; then
  if command -v node >/dev/null 2>&1; then RUNTIME=node; else RUNTIME=bun; fi
fi
export AGENT_CONTEXT_BROKER_RUNTIME="$RUNTIME"
CASE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/acb-shell-install.XXXXXX")
trap 'rm -rf -- "$CASE_ROOT"' EXIT HUP INT TERM

INSTALL_ROOT="$CASE_ROOT/install"
CODEX_HOME="$CASE_ROOT/codex"
CLAUDE_HOME="$CASE_ROOT/claude"
RUNTIME_HOME="$CASE_ROOT/runtime"
mkdir -p "$CODEX_HOME" "$CLAUDE_HOME"
printf '%s\n' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing-handler"}]}]}}' > "$CODEX_HOME/hooks.json"

PLAN=$(
  "$SCRIPT_DIR/install-agent-context-broker.sh" \
    --provider both \
    --package-root "$PACKAGE_ROOT" \
    --install-root "$INSTALL_ROOT" \
    --codex-home "$CODEX_HOME" \
    --claude-home "$CLAUDE_HOME" \
    --runtime-home "$RUNTIME_HOME"
)

DIGESTS=$(printf '%s' "$PLAN" | "$RUNTIME" -e '
  const plan = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (plan.writesEnabled !== false) throw new Error("Install plan unexpectedly enables writes.");
  process.stdout.write(`${plan.manifestDigest}\t${plan.planDigest}`);
')
MANIFEST_DIGEST=${DIGESTS%%	*}
PLAN_DIGEST=${DIGESTS#*	}

"$SCRIPT_DIR/install-agent-context-broker.sh" \
  --provider both \
  --package-root "$PACKAGE_ROOT" \
  --install-root "$INSTALL_ROOT" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --runtime-home "$RUNTIME_HOME" \
  --expected-manifest-digest "$MANIFEST_DIGEST" \
  --expected-plan-digest "$PLAN_DIGEST" \
  --execute >/dev/null

"$SCRIPT_DIR/test-agent-context-broker-installation.sh" \
  --runtime-home "$RUNTIME_HOME" | "$RUNTIME" -e '
    const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!result.healthy) throw new Error("Installed broker is not healthy.");
    if (result.runtime?.name !== process.env.AGENT_CONTEXT_BROKER_RUNTIME) throw new Error("Installed runtime is not the selected one.");
  '

if grep -Eiq 'powershell|pwsh' "$CODEX_HOME/hooks.json" "$CLAUDE_HOME/settings.json"; then
  echo 'Installed hook configuration contains a PowerShell dependency.' >&2
  exit 1
fi
if ! grep -q 'existing-handler' "$CODEX_HOME/hooks.json"; then
  echo 'Existing Codex hook handler was not preserved.' >&2
  exit 1
fi

REMOVE_PLAN=$(
  "$SCRIPT_DIR/uninstall-agent-context-broker.sh" \
    --package-root "$PACKAGE_ROOT" \
    --install-root "$INSTALL_ROOT" \
    --codex-home "$CODEX_HOME" \
    --claude-home "$CLAUDE_HOME" \
    --runtime-home "$RUNTIME_HOME"
)
REMOVE_DIGEST=$(printf '%s' "$REMOVE_PLAN" | "$RUNTIME" -e '
  const plan = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (plan.writesEnabled !== false) throw new Error("Remove plan unexpectedly enables writes.");
  process.stdout.write(plan.planDigest);
')

"$SCRIPT_DIR/uninstall-agent-context-broker.sh" \
  --package-root "$PACKAGE_ROOT" \
  --install-root "$INSTALL_ROOT" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --runtime-home "$RUNTIME_HOME" \
  --expected-plan-digest "$REMOVE_DIGEST" \
  --execute >/dev/null

if [ -e "$RUNTIME_HOME/install-state.json" ]; then
  echo 'Installation state remains after removal.' >&2
  exit 1
fi
if ! grep -q 'existing-handler' "$CODEX_HOME/hooks.json"; then
  echo 'Existing Codex hook handler was removed.' >&2
  exit 1
fi

echo 'Agent Context Broker POSIX shell installation round-trip passed.'
