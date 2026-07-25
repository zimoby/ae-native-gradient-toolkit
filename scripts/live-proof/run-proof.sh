#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${AE_NODE:-$(command -v node)}"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  printf '%s\n' "ERROR: set AE_NODE to an executable Node 22 path" >&2
  exit 2
fi

exec "$NODE" "$SCRIPT_DIR/run-proof.mjs" "$@"
