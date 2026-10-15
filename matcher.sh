#!/usr/bin/env bash
# Source checkout launcher; desktop releases include their own Python runtime.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for candidate in python3.13 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" "$here/launch.py" "$@"
  fi
done
echo "Install Python 3.13, or use a desktop release: https://github.com/nikhilavibeauterai/MatchER/releases" >&2
exit 1
