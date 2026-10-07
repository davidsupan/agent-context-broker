#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/agent-context.mjs" ]; then
  ENTRYPOINT="$SCRIPT_DIR/agent-context.mjs"
else
  ENTRYPOINT="$SCRIPT_DIR/../tool/scripts/agent-context.mjs"
fi
# Node is the primary runtime; AGENT_CONTEXT_BROKER_RUNTIME=bun keeps a Bun installation on Bun.
RUNTIME=${AGENT_CONTEXT_BROKER_RUNTIME:-}
if [ -z "$RUNTIME" ]; then
  if command -v node >/dev/null 2>&1; then RUNTIME=node; else RUNTIME=bun; fi
fi
exec "$RUNTIME" "$ENTRYPOINT" "$@"
