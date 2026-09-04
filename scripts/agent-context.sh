#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/agent-context.mjs" ]; then
  ENTRYPOINT="$SCRIPT_DIR/agent-context.mjs"
else
  ENTRYPOINT="$SCRIPT_DIR/../tool/scripts/agent-context.mjs"
fi
exec bun "$ENTRYPOINT" "$@"
