#!/usr/bin/env bash
# One-time setup for the browser suites (needs the network): the Playwright library, its headless Chromium, and the
# two test photo libraries (public-domain photos only; never your own). Everything lands in $MATCHER_UI_TMP
# (default: $TMPDIR/matcher-ui or /tmp/matcher-ui), outside the repo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
TMP="${MATCHER_UI_TMP:-${TMPDIR:-/tmp}/matcher-ui}"
mkdir -p "$TMP/work"
cd "$HERE"
npm ci --no-audit --no-fund
# (the system browser, Vivaldi, crashes under headless Playwright here: use Playwright's own headless shell)
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$TMP/pw-browsers}" npx playwright-core install chromium-headless-shell
[ -f "$TMP/work/sample-photos/ATTRIBUTION.txt" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_sample.py" "$TMP/work/sample-photos"
[ -d "$TMP/work/me-photos/me" ] || "$ROOT/.venv/bin/python" "$HERE/fixtures/fetch_me.py" "$TMP/work/me-photos"
echo "Ready: run tests/ui/run_all.sh (or tests/ui/run.sh <suite>)."
