#!/usr/bin/env bash
# MatchER launcher: builds its own virtualenv on first run, then starts the app in your browser.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
venv="$here/.venv"
stamp="$venv/.requirements.sha256"
want="$(sha256sum "$here/requirements.lock" | cut -d' ' -f1)"

if [[ ! -x "$venv/bin/python" ]]; then
  echo "First run: creating a virtualenv in $venv"
  python3 -m venv "$venv"
fi
if [[ "$(cat "$stamp" 2>/dev/null || true)" != "$want" ]]; then
  echo "Installing dependencies (one time, ~700 MB)…"
  # exact versions, each file checked against its published SHA-256 (requirements.lock)
  "$venv/bin/python" -m pip install --quiet --require-hashes -r "$here/requirements.lock"
  echo "$want" > "$stamp"
fi
export PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}"
exec "$venv/bin/python" -m matcher "$@"
