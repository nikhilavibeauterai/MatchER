#!/usr/bin/env bash
# tests/ui/run.sh <suite> [library]: one browser suite (tests/ui/suites/<suite>.js) against a throwaway MatchER on
# its own data dir and port. Never touches your real data or your running MatchER (it only stops the server it
# started). The suite's JSON result lands in $MATCHER_UI_TMP/<suite>_result.json, screenshots in $MATCHER_UI_TMP/shots.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
TMP="${MATCHER_UI_TMP:-${TMPDIR:-/tmp}/matcher-ui}"
t="$1"; lib="${2:-}"
if [ -z "$lib" ]; then  # the "photos of me" suites play on the me-photos library, the rest on the gallery samples
  case "$t" in me_e2e|analysis_peek|toggles_peek|an_mid|details_peek) lib="$TMP/work/me-photos" ;; *) lib="$TMP/work/sample-photos" ;; esac
fi
mkdir -p "$TMP/shots"; rm -rf "$TMP/data-$t"; mkdir -p "$TMP/data-$t"
cd "$ROOT"
MATCHER_DATA="$TMP/data-$t" .venv/bin/python -m matcher --port 8811 --no-browser > "$TMP/server-$t.log" 2>&1 &
pid=$!
link=""
for _ in $(seq 1 150); do  # the server prints its keyed link (MatchER is locked behind a per-install key)
  link=$(grep -o 'http://127.0.0.1:[0-9]*/?k=[A-Za-z0-9_-]*' "$TMP/server-$t.log" | head -1)
  [ -n "$link" ] && curl -s -o /dev/null "${link%%/?k=*}/" && break
  sleep 0.2
done
base="${link%%/?k=*}"
start=$(date +%s)
(cd "$HERE" && PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$TMP/pw-browsers}" BASE="$base" LINK="$link" LIB="$lib" OUT="$TMP/shots" \
  timeout 1200 node "suites/${t}.js" > "$TMP/${t}_result.json" 2>&1)
code=$?
echo "$t exit=$code $(( $(date +%s) - start ))s on $base"
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
exit $code
