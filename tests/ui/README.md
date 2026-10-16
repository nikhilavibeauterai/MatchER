# Browser suites

Playwright (`playwright-core`) scripts that drive MatchER end to end in a headless browser, each against a throwaway
server on its own data dir. They only ever use the public-domain test libraries fetched by `setup.sh`.

    tests/ui/setup.sh            # once, needs the network: npm deps, headless Chromium, test libraries
    tests/ui/run_all.sh          # every suite, then a pass/fail summary
    tests/ui/run.sh venn_peek    # one suite; its JSON result: $MATCHER_UI_TMP/venn_peek_result.json

Everything they create (data dirs, server logs, results, screenshots in `shots/`) lives in `$MATCHER_UI_TMP`
(default `/tmp/matcher-ui`). A suite fails if it exits non-zero or its result lists `problems` (page or console errors).

| suite | covers |
|---|---|
| experience_flow | visible forward actions from first launch through Filter, Stacks, Crown, Groups, group stage, Knockouts (or straight to a bracket the advancers already fill, with the rail marking the skip), Finals, Reveal and a real export on public fixtures; qualification preview/commit/undo; desktop and phone screenshots at every stage |
| game_flow | Home activities launch Tag lab editor/check, recovery, trophies and timed open duels; Esc pause/resume preserves cards, focus and Lightning time, nested dialogs stay paused, local vote timing excludes pauses; Filter review returns in place; fixed phone menu/forward actions; phone Groups rail has one scrollport and visible, reachable 44px controls |
| game_keys | real WASD decisions, native editing and held-key isolation, pause protection, X toss/undo, C crop and F enhancement; Twin/Tag skips make no edits; Finals deferral makes no winner, and tossing then undoing restores its field; desktop/phone screenshots |
| filter_stage | four directional choices with no tuning panel; compatible saved quality/subject drafts preview before Next confirms them; pass/fail badges, native keys, stale previews, delayed confirmation, every-take pagination, individual rescue/undo and unreadable takes; phone screenshots |
| filter_teaching | an old running teaching engine requires restart before any directional call; real Arrow/WASD teaching decides the focused take and stays on it; continuous review past six takes, fixed D-pad geometry, pause-menu tools, outcome focus, preview persistence/retraction, Next/undo, deferred requests, queued Undo during saving/startup; a committed lesson with a failed 503/409 preview requires Refresh, retries no vote, shows its real cohort effect and drains queued Undo once |
| filter_bias | first-example cohort fit using edited public-fixture tags; atomic same-take teaching/decision undo, normalized sea scores, native threshold keys, real divider dragging and pointer focus release, local draft undo, Next confirmation/undo, manual Keep/Toss protection, Enter advancing without another vote and geometry cleanup on leaving Filter |
| filter_layout | usable photo size and reachable directional decisions at desktop, phone, 320×568 and short landscape sizes; wide monospace labels fit; focused prints and controls stay above the sea; no page overflow |
| filter_crossing | actual photo bodies cross to both sides of the threshold while the focused photo and controls remain visible; full-viewport sea and zero UI collision obstacles |
| filter_throw | throwing a print across Filter's line decides it (left tosses, right keeps) with one decision call each and an undo step; a drop on the side it already has decides nothing |
| filter_sample_learning | bundled public-domain variants learn together on the first real Love/Hate key; older opposite calls move in preview, Apply/Undo restores them, later individual calls stay protected; no invisible former stack takes; sampled Keep/Toss flights land on the correct side |
| filter_mixed_learning | all 13 bundled sample takes receive individual calls, then conflicting Love/Hate across actual portrait variants; keys and buttons revise copy previews, every ambient copy physically crosses to the expected side, unrelated takes stay unchanged, and saved draft teaching survives reload |
| photo_path | exact original file paths from a non-cover stack take, viewer, sea inspection and Filter; Unicode/spaces, clipboard fallback and canceled lookups; desktop/phone controls |
| flow2_e2e | the whole journey in order: analysis, map, Filter, Stacks + Twin check, Groups (named list roster; persistent selection checks, keyboard toggles and phone visibility; split/undo retains the expanded remainder and scroll anchor), Quick sort, Crown, group stage and Knockouts; top HUD current/completed states, matching next stage and phone layout |
| crown_sync | earlier splits/manual Keep followed by explicit Crown and reload; final-stage counts and undo; current group, chosen cover and kept take in Stacks, Groups List and the actual World sea; duplicate-only stacks hide Crown; adding a take reopens Crown with the previous winner defending |
| crown_layout | bundled sample tag focus releases on entering Crown; compact progress, one shared title and Help-off Left/Skip/Right controls; actual moving-frame hit tests keep ambient photos beneath both playable prints; role badges follow portrait and letterboxed landscape edges; click, skip, Undo, continuing winner side, desktop/phone and persisted Help after reload |
| gallery_e2e | gallery mode: cups, sweep, keys, lightning, the champion crowned on the Finals page (one podium, one way on, focused), reveal, leaderboard, share-card text bounds; stack edits reopen Finals; phone Finals leave open sea space without photos overlapping the header or arena |
| me_e2e | "photos of me" mode, the People page, set aside |
| sea2_peek / venn_peek | the tag sea on the Groups page: physics, physical dragging / explicit group bins, keys, suggestions, tag tray; named roster focus/release without edits, focus with a selection, move/undo and wrapped phone names |
| arrows_peek / qs_peek | Quick sort and Find more: arrow keys, ★ guess, toss/undo, counts; Space/Skip defers without edits, survives hint reloads, returns later, preserves native keys, and handles batch endings and the final take |
| inputs_peek / naming_e2e | text inputs never overflow; renaming, emoji search, group keys (0, Alt+n) |
| world_peek / grab_peek / ko_peek | the sea behind every screen: reused photo nodes, live flight endpoints for portrait/landscape takes across viewport and dock changes (every flight is the same 3:4 polaroid card), inspection/route cancellation, chosen knockout matches, elimination and undo |
| board_peek | the tournament board |
| toolbelt_peek | the toolbelt changes what the mouse does on every card: a pen stroke on a stack tile and a marker stroke on a zoomed-in map print are saved with the shot and drawn where it appears, without opening the stack or panning the camera; C frames the stack tiles by the crop mode (object-view-box) and off leaves them their own look |
| toolbelt_play | real Open arena, Crown and Finals choices stay untouched while drawing; local eraser cuts, dots, notes, cancelled strokes, touch input, undo/redo and undo during a pending save; returning to Hand restores voting; history previews stay free of editing overlays |
| leaderboard_peek | the leaderboard: one big, still card at a time that slides in and out without flights; a square, draggable sticky note that grows to fit; the file on the chin; the sheet (enhance knobs with a live filter, the crop modes, turns) and F/C/R; Z; the global toolbelt (pen, marker, your note, eraser) on its card |
| analysis_peek / an_mid / details_peek | the analysis screen, step by step (the grab, tags pulling photos together, no teleporting) |
| toggles_peek | Enhance and auto-crop from the menu |
| sea_slots_peek / tour | synthetic 2k/20k feeds with real miniature previews and bounded DOM; screenshots of every screen (desktop and phone) |
| tags_e2e | tag editor, full roster, rename, merge, delete, finite tag check and undo; shared 3:4 polaroids, paper margins and contained photos in the roster, tag pop-ups and correction game on desktop and phone; drawing/undo on roster cards and hit tests above the sea |
| sea_spacing | all analysis discoveries retained as usable sea controls; real overlapping photo stacks and fans; ambient photos clear stack controls; separate photos and fitted occupied contours; usable phone tag shelf |
| sea_boids | irregular roaming flocks, saved-group cohesion across unlike tags with contact spacing and occupied lassos, intersect/union focus on steady wobbling anchors, combined stack tags, physical release; connected source shores survive stationary hover and an actual spotlight flight/return; 10k moving real atlas thumbnails with measured colour/brightness coordinates, twelve tags per photo and twenty saved groups, main/worker timing and actual position-update intervals; the mechanics run on the pinned tuning from tests/sea_checks.cjs, the 10,000-print scale check on the shipped defaults |
| sea_geography | public-analysis visual descriptors persist through Filter, Stacks, Groups and Home into worker bodies; controlled colour/brightness quadrants with real public thumbnails, pointer pinning, steady focus and physical release, smooth descriptor updates without replacing the photo |
| sea_zoom | deep zoom on the map: zooming at the edge keeps the point under the pointer, one print filling the view stills the sea and hides the chrome, a drag on it pans, it shows the original file, every print is drawn at zoom 1 |
| sea_gl | the GPU sprite layer on a 6,000-print sea (headless Chromium with `--enable-unsafe-swiftshader`): every print drawn with no live cards at zoom 1, idle frames cheap, a fast wheel zoom to the corner print quick and anchored, only the one print filling the view asks for the original file, a click's zoom then a drag pans, zooming back out returns every print to the GPU |
| sea_pixels | real Canvas comparisons for tiny atlas cells, overlapping opacity, edge clipping, promoted/lifted exclusions, mutable preview pages, large-thumbnail fallback, DPR 1/2, bounded size caches and cleanup; controlled pixels, no library required |
| duel_sides | Crown deferrals preserve the first defender through reload without inventing a winner, and skipped challengers return before a crown; continuing winners keep either side through new challengers and undo; displayed choices map to real canonical votes in open duels, groups, knockouts and Finals without changing bracket slots |
| crop_bounds | tight subject crops and stacked prints stay inside each pane during hover/wobble (the picture sits in its card's window, which clips the zoom; the opaque paper hides under-prints) across open duels, groups, knockouts, Crown and Finals on desktop/phone; pixel comparison rejects under-print bleed while retaining paper edges; cropped flights land with matching geometry and masks; phone standings leave usable photos and controls |
| an_clean | full-width analysis with a short live status; concise scene/detail findings without raw scores or scrollbars, on desktop and phone; uncertain scenes create no empty tags or recognition claim; stable bottom tag row; intersection focus, deliberate selection, release and keyboard activation |
| analysis_sea | 1,879-photo analysis replay at 2048×1152 using public fixture pixels; frequent overlapping-tag discoveries, bounded worker clustering, balanced roaming around the real spotlight, obstacle clearance, no regular grid or transient floating labels; phone title and tiny-photo detail |
| twin_check | whole public-fixture takes even with auto-crop enabled; steady bounded comparison panels with balanced sea margins at 2048px and phone widths; real merge/undo and no stack-helper popup |
| stacks_layout | last-column family expands across the row on desktop and phone; reachable fan controls, no horizontal page scrolling or empty twins rail; keep/undo retain expansion and the loaded scroll window using public fixture pixels |
| stacks_scale | 720 stacks and 3,600 public-fixture pictures; native overview merges within and between families, changing covers, every take retained, Undo, stable untouched cards, bounded DOM/image work and only visible photo flights; reports drop-to-update and observer timing |
| sample_e2e | bundled offline demo, all 13 public-domain photos, correct organizing spotlight and its real stack takes, readable caption and a playable small Finals bracket |
| lifecycle_peek | delayed votes, tables, stage finishes and minigame replies across navigation; no Sweep calls on unseen takes; Escape opens the menu before leaving Open arena, Enter exports from the leaderboard, one bounded phone reward; cancelled drags, take-picker clicks, rescue-tab changes, full local storage and settings failures |
| map_layout | one transparent top-centred eight-stage HUD at 2048px, desktop, 390px and 320px; previous/next links, readable stage titles, accessible current names and keyboard focus; a full-viewport sea with no UI collisions or stale hidden-tag highlight; an open map with menu activities/cups and real Undo/Redo history thumbnails; per-save help stays off after interrupted or acknowledged writes and reloads |
| map_stack | real map drag-and-drop for singles and whole stacks, a steady highlighted target, one merge per release, destination group inheritance, Z/Shift+Z, cancellation, open-water placement, lasso filing, atlas targets and stacking at a closer camera zoom |

`tests/test_scale.py` complements the browser checks with synthetic 5k/20k time and memory budgets for stacking,
tag clustering and board/world paging, a whole-library tag edit and undo, and a shortlist above SQLite's variable limit.
`tests/test_analysis_pool.py` crosses the 3,200-task worker retirement boundary with 3,299 synthetic results and
real spawned workers, and checks bounded scheduling, cancellation and resuming partially saved analysis.
`tests/test_filter_review.py` checks varied, stable review samples and bounded work at 10,000 takes.
`tests/test_filter_learning.py` checks optional reasons, ambiguous evidence, read-only scheduling and reversible
teaching; `tests/test_filter_rewards.py` checks equal, bounded rewards and undo.
`tests/test_filter_scale.py` checks bounded single-photo reads at 10k, preview validation across request threads,
same/external connection mutations, age expiry, and one derived rebuild on Filter undo.
`tests/test_request_lifecycle.py` checks bounded database connections across transient/concurrent threads and
quickly reopening canceled analysis; `tests/test_tournament_consistency.py` checks dependent Finals retirement,
qualifier changes and match deferral without invented winners or votes.

`sea_map` reproduces a 1,879-photo / 755-shot map with heavily shared tags learned after arrival. It checks that
photos occupy the open centre, settle and stay put, and retain every take.
`dev_panel` checks debug mode on the bundled sample: the panel on every screen, a knob reaching the worker and
surviving a reload, Export's JSON, Reset and collapse, and `?debug=0` forgetting it.
`sea_camera` checks the calm, explorable sea on public fixtures: a settled field that stays put, colour running
left to right and brightness bottom to top, wheel zoom about the pointer, panning by dragging open water, the
double-click reset, a dragged print leaving far prints alone, and comparisons showing the whole sea at rest.
