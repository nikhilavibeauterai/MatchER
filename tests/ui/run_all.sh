#!/usr/bin/env bash
# tests/ui/run_all.sh [suite…]: every browser suite (or the ones named), one after another, then a summary: a suite
# passes when it exits 0 and reports no problems (page errors, console errors) in its result.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${MATCHER_UI_TMP:-${TMPDIR:-/tmp}/matcher-ui}"
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(flow2_e2e gallery_e2e sea2_peek arrows_peek inputs_peek naming_e2e qs_peek venn_peek world_peek board_peek
  grab_peek ko_peek analysis_peek me_e2e toggles_peek an_mid)
fail=0
for t in "${suites[@]}"; do "$HERE/run.sh" "$t" || true; done
for t in "${suites[@]}"; do
  if python3 - "$TMP/${t}_result.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("  FAILED:", open(sys.argv[1]).read()[:300].replace("\n", " ")); sys.exit(1)
bad = [p for p in d.get("problems", []) if "403" not in p and "NETWORK_CHANGED" not in p]  # (403: the deliberate locked-door check)
if bad: print("  problems:", bad); sys.exit(1)
PY
  then echo "ok    $t"; else echo "FAIL  $t (see $TMP/${t}_result.json)"; fail=1; fi
done
exit $fail
