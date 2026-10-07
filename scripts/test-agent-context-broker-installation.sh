#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME=${AGENT_CONTEXT_BROKER_RUNTIME:-}
if [ -z "$RUNTIME" ]; then
  if command -v node >/dev/null 2>&1; then RUNTIME=node; else RUNTIME=bun; fi
fi
exec "$RUNTIME" "$SCRIPT_DIR/test-agent-context-broker-installation.mjs" "$@"
