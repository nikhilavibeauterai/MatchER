#!/usr/bin/env bash
# tests/ui/run_all.sh [suite…]: every browser suite (or the ones named), one after another, then a summary: a suite
# passes when it exits 0 and reports no problems (page errors, console errors) in its result.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${MATCHER_UI_TMP:-${TMPDIR:-/tmp}/matcher-ui}"
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(sea_camera sea_zoom sea_gl map_stack toolbelt_peek toolbelt_play dev_panel experience_flow filter_stage filter_teaching filter_bias filter_layout filter_crossing filter_throw filter_sample_learning filter_mixed_learning photo_path game_flow game_keys flow2_e2e crown_sync crown_layout duel_sides crop_bounds gallery_e2e sea2_peek arrows_peek inputs_peek naming_e2e qs_peek venn_peek world_peek board_peek leaderboard_peek
  grab_peek ko_peek analysis_peek me_e2e toggles_peek an_mid details_peek sea_slots_peek tour tags_e2e sea_spacing sea_boids sea_geography sea_pixels an_clean sample_e2e map_layout lifecycle_peek sea_map analysis_sea twin_check stacks_layout)
fail=0
declare -A codes
for t in "${suites[@]}"; do "$HERE/run.sh" "$t"; codes[$t]=$?; done
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
  then
    if [ "${codes[$t]}" -eq 0 ]; then echo "ok    $t"; else echo "FAIL  $t (exit ${codes[$t]})"; fail=1; fi
  else echo "FAIL  $t (see $TMP/${t}_result.json)"; fail=1; fi
done
exit $fail
