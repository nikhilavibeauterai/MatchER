#!/usr/bin/env bash
# One-time setup for the browser suites (needs the network): the Playwright library, its headless Chromium, and the
# test photo libraries (public-domain photos only; never your own). Everything lands in $MATCHER_UI_TMP
# (default: $TMPDIR/matcher-ui or /tmp/matcher-ui), outside the repo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
TMP="${MATCHER_UI_TMP:-${TMPDIR:-/tmp}/matcher-ui}"
mkdir -p "$TMP/work"
if [ "${1:-}" = "--showcase" ]; then
  shift
  "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_showcase.py" "$TMP/work/Highsmith road trip" "$@"
  exit
fi
sample_only=false
if [ "${1:-}" = "--sample-only" ]; then sample_only=true; shift; fi
if [ "$#" -gt 0 ]; then echo "Usage: tests/ui/setup.sh [--showcase | --sample-only]" >&2; exit 2; fi
cd "$HERE"
npm ci --no-audit --no-fund
# (the system browser, Vivaldi, crashes under headless Playwright here: use Playwright's own headless shell)
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$TMP/pw-browsers}" npx playwright-core install chromium-headless-shell
if [ "$sample_only" = true ]; then
  [ -f "$TMP/work/sample-photos/ATTRIBUTION.txt" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_sample.py" "$TMP/work/sample-photos" --offline
  echo "Ready: release browser checks use the bundled public sample."
  exit
fi
[ -f "$TMP/work/sample-photos/ATTRIBUTION.txt" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_sample.py" "$TMP/work/sample-photos"
[ -f "$TMP/work/demo-photos/ATTRIBUTION.txt" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_sample.py" "$TMP/work/demo-photos" --offline
[ -d "$TMP/work/me-photos/me" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_me.py" "$TMP/work/me-photos"
echo "Ready: run tests/ui/run_all.sh (or tests/ui/run.sh <suite>)."
