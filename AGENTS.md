# MatchER: notes for coding agents

MatchER turns a folder of photos into a game: an analysis screen that shows what it recognizes, then a journey of
filtering, stacking, themed groups, tournaments (group stage, knockouts, an 8-photo bracket) and a reveal. Everything runs
locally: a Flask server (`matcher/`) and a single-page front end (`matcher/static/`). The README is the user-facing
manual and a good tour of every feature.

## Hard rules (privacy and safety)

- **Never open, read, copy, list or upload the owner's photos or anything derived from them.** That means everything
  under `data/` (per-library databases, previews, thumbnails, face crops, exports) and `~/Pictures/`. Test only on the
  public-domain libraries that `tests/ui/setup.sh` fetches.
- **Never write test votes or edits into a real library database.** Test servers run on a throwaway data dir via
  `MATCHER_DATA=<tmp dir>` (the scripts in `tests/ui/` already do this). Unit tests build their own libraries.
- **Never kill or signal the owner's running MatchER.** It runs as plain `python -m matcher` (no `--port`). Only stop
  servers you started, by their own PID (`$!`). Never use `pkill -f`/`pgrep -f` patterns: they can match your own shell.
- `models/` holds downloaded, checksum-verified model files; `original chats/` holds private planning transcripts
  (background only). Don't edit either; don't commit them.
- The app is locked behind a per-install key: a server prints `MatchER is running: http://127.0.0.1:PORT/?k=…`, and a
  browser must open that link first (it sets the cookie).

## Running

    ./matcher.sh                                   # the app (creates .venv on first run), opens the browser
    .venv/bin/python -m matcher --port 8811 --no-browser   # a server (add MATCHER_DATA=<tmp> for a scratch one)
    ./matcher.sh --debug                           # developer mode: the sea tuning panel on every screen (or ?debug=1 once)

## Testing

    .venv/bin/python -m pytest -q                  # unit tests and scale checks; no network needed
    tests/ui/setup.sh                              # once: npm deps, headless Chromium, test photo libraries (network)
    tests/ui/run_all.sh                            # every browser suite, then a pass/fail summary
    tests/ui/run.sh <suite>                        # one suite; result JSON + screenshots under $MATCHER_UI_TMP

The browser suites start a server on a localhost port and drive it with Playwright, so they need the sandbox to
allow local networking (setup also needs internet). If yours doesn't, say so and ask the owner to run them.
A UI change isn't done until the relevant suites pass; look at the screenshots in `$MATCHER_UI_TMP/shots/` too. Keep
the suites in step with deliberate UI changes (see `tests/ui/README.md` for what each covers).

## Map of the code

- `matcher/server.py`: `Session` (one per open library: ranker, cards, votes, undo, finals) and every `/api/*` route.
- `matcher/analyze.py`: the analysis pipeline (read, understand, identity, details), its progress dict and the
  event `feed` the analysis screen reads (`/api/analysis/feed`).
- `matcher/library.py`: `refresh()` derives everything from the analysis (identity, throw-outs, flags, stacks,
  scenes, tags). Bump `DERIVED_VERSION` when it starts producing something new (old libraries refresh on open).
- `matcher/filtering.py`: editable admission rules, read-only previews, per-take recovery, completion and undo.
- `matcher/filter_fit.py`: continuous admission scores and contextual Love/Hate similarity from saved evidence.
- `matcher/filter_review.py`: bounded, diverse review rounds from saved evidence and independent shot families.
- `matcher/tournament.py`: contender/stack/group bases, retiring edited brackets and safe undo restoration.
- `matcher/tags.py`: tags (many per photo: what, who, how it looks, when), the user's edits on top, tag metadata,
  k-means-clustered group suggestions, names.
- `matcher/themes.py`: the ~57 theme concepts (SigLIP prompts + catchy names), auto-grouping, group-stage maths.
- `matcher/draw.py`: themed groups ("the Draw"): create/move/merge, Quick sort and Find more, the group stage, the
  tag board, and the shared undo history (`remember()`/`undo()`: every edit is one undo step).
- `matcher/store.py`: SQLite schema; migrations are `ALTER TABLE` guarded by column checks (new tables: just add them
  to `SCHEMA`).
- `matcher/game.py`: XP, levels, achievements, stage-clear bonuses. `matcher/ranker.py`: the Bayesian ranker.
- `matcher/static/app.js`: views, game flow and `World`, the shared sea behind every screen. Views are `view*`
  functions routed by `#hash` (`VIEWS`). UI is ethereal; focused photos fly out and back.
- `matcher/static/photo-sea.js`: photo interaction, stack presentation, tag focus and bounded DOM/atlas rendering.
- `matcher/static/sea-gl.js`: the GPU sprite layer: every small print as an instanced quad from the atlas sheets (one
  draw call per sheet, the camera a uniform), the same polaroid as drawCard; photo-sea.js keeps its 2D canvas as the
  fallback (`gpu` knob off, or no WebGL2).
- `matcher/static/sea-worker.js`: equal-weight tag boids, obstacle avoidance, focus anchors and sampled clustering.
- `matcher/static/sea-contours.js`: occupied-area lasso boundaries, including disconnected parts and empty holes.
- `matcher/static/filter-stage.js` and `filter-stage.css`: Filter's draft rules, outcome sea and take-review game.
- `matcher/static/game-flow.css`: campaign dock, side activities and shared game controls.
- `matcher/static/experience.css`: bounded reward HUD, duel feedback and group-qualification preview.
- `matcher/static/app.css`: shared screen frame (`.screen`: head strip, body, rail, action bar), then per-feature
  blocks appended in order.

## Design rules (the owner's; keep them)

- **One game, one flow.** The stages in order: Filter → Stacks → Crown → Groups → Group stage → Knockouts → Finals → Reveal.
  Every stage's finish points to the next one; Sweep and recovery belong alongside Filter.
- **Filtering is an editable stage.** Technical quality and content criteria use a preview before Apply. Every
  set-aside take remains accessible, manual decisions survive threshold changes, and applying changes is undoable.
- **The same HUD everywhere:** top-centred stage icons with singular title below and previous/next arrows,
  menu top-left, save/XP top-right, Help bottom-right. The track carries the Map before Filter and the Leaderboard
  after Reveal as waypoints (`TRACK`), not journey stages. Home is open sea; the HUD title and the Esc menu's first
  entry lead back to it; activities and cups are in Esc. Dropping a print inside a group's lasso files it there,
  on the map as in the editor. Digit keys count from the numpad too.
  Help starts on only before the first manual preference and persists per save. Key hints and explanations obey
  that toggle. Undo/Redo surface only after a history action, with thumbnails, then fade away. No full-width bars.
- **Keys:** arrows make the visible, context-specific choices; WASD does the same. Space defers without deciding,
  awarding a win or eliminating a contender; the unresolved take or match returns later. Z undoes, X tosses the
  current take (or the explicitly hovered/focused photo in a pair), C toggles auto-crop, F toggles enhancement.
  Never guess which side X should toss. On the Stacks page X sets the open or selected stack aside with every
  take. C walks the crop modes: best (the crop that uses the most of the window among focus subject, fill height and
  fill width; on a tie focus subject wins), focus subject (zoomed in on the likely subject: the main face, else the
  salient region the analysis kept, so a dog, a car or a person from behind count too), fill height, fill width,
  off. The modes reach every picture, stack tiles and fans included (`frameTileImage` through `object-view-box`). On the Leaderboard F,
  C and R are that shot's own enhance, crop mode and quarter turn (saved, undoable, baked into Save my best);
  everywhere else F and C are the global preview toggles. Enter = forward. Esc dismisses a selection or overlay first, backs out
  of nested menus, then pauses/resumes. Native typing and focused controls keep their own keys; held keys must
  not repeat decisions. Editors retain group keys 1–9, 0 = 10th, Alt+digit = 11–20, arrow navigation,
  Shift+arrows to reorder and E to rename.
- **Filter through play:** the visible D-pad has ← Toss, → Keep, ↑ Love, ↓ Hate, Space Skip in the centre.
  Keep/Toss affects only the current take. Love also keeps its source; Hate also tosses its source. Throwing a
  print across the line in the sea decides it too (right keeps, left tosses). Teaching
  changes related takes in a preview until Enter confirms it. Individual exceptions survive threshold changes. One Undo reverses
  the source decision and teaching together. Learn the context of contrasting examples from multiple saved
  measurements. Newer confident teaching may preview reversals of older opposite manual calls in its specific
  context; later individual calls are protected again. Preserve that order through Apply, Undo and Redo. Use
  evidence rather than manufacturing a global rule from an apparent contradiction. Filter is continuous, without
  rounds. Enter always applies the visible preview and advances to Stacks, including when a choice button has
  focus. Keep the forward action visible and disable it only while processing or without eligible takes.
  Pointer release on the threshold returns focus to play; keyboard-focused range controls keep native arrows.
- **The sea is the world:** every photo visible at the default view, flowing around each screen. Its geography
  persists across stages and is the macro order: muted/low-saturation photos to the left, colourful ones to the
  right, dark photos below, bright photos above. These are soft homes, not grid cells. The micro order is local
  boid mechanics: equal-weight tag affinity and saved groups nudge neighbours together, nearby prints repel to
  leave a buffer, and distant ones stop influencing each other. The sea is calm: prints settle at their homes and
  then rest; nothing moves unless you move it, a focus gathers it or its data changes (no wander, no jitter, no
  shoving). A change wakes only what it concerns: a print in your hand floats over the others, its neighbours
  make room when you let go, and a shove fades within a few prints. The sea is a camera: drag open water to pan,
  wheel or pinch to zoom about the pointer (deep enough to read one print; zoomed in, drags pan and prints show
  their full previews), double-click open water to see everything again; a comparison or a page shows the whole
  sea at rest. On the map a click on a print glides the camera in until its card fills four fifths of the height,
  a double-click grabs it; a drag on an over-zoomed print (three quarters of the height or more) pans like the
  water, and a double-click on one brings the whole sea back. A print filling four fifths of the screen's height
  shows the original file; every other size stops at the preview, and nothing ever asks for more than a few
  originals at once. Physics runs only for prints on screen; the rest hold still until they come into view. Zoomed
  in until one print fills the view, nothing moves or wobbles and the chrome hides until you zoom back out.
  Rendering is bounded by what is on screen, not by the library: every small print is a GPU sprite from the atlas
  (a thumbnail at any size, no dots), a card comes up live (its own element and picture) only when it is big enough
  on screen to need one (`liveMin`) or you are working with it, a few dozen per pass once the camera rests, and at
  rest nothing is drawn or animated at all. Zooming and panning may never fetch, decode or tessellate per frame.
- **Every photo is the same polaroid.** One 3:4 portrait paper card (sides 5.5% of its width, a 17% chin, a
  dark window with the picture contained inside) everywhere a photo appears: sea prints at every zoom, atlas
  sprites, focused and held prints, tiles, thumbnails, Filter's spotlight, Stacks, Groups, duels, Finals, the
  podium and flights between them. A landscape and a portrait compare as equals; a stack is a pile of the same
  cards; captions (stack counts, seeds) sit on the chin. Faces and avatars are the only round images. The card's
  rounding, paper and window are proportional to the card, so zoom never changes the look, and the window behind a
  contained picture is paper. `static/cards.js` is the one place that touches every card after the fact (wrappers
  for bare images in rows, the seeded wobble offsets); the idle wobble is one global rule on the card itself, laid
  over the physics, with each card's delay, speed and force offset from the tunable bases by randoms seeded from
  its photo id. New knobs go in `sea-tuning.js` so the developer panel exposes them.
  Filter temporarily replaces colour X with admission fit: out left, in right of its draggable vertical line.
  Brightness Y persists, and colour homes return on leaving. UI has no collision with photos: only sea photos
  repel each other. World runs behind the whole viewport, including controls. Photos you work on bubble
  out to steady focus anchors (bigger, gently wobbling) and shrink back afterwards. Nothing you reach for may
  move away from the pointer; the hovered photo grows a little, a held one a little more.
- **Show the machine working:** learning, tuning and filtering should be legible through movement and visual
  feedback. Use a compact floating save/menu HUD and stage medallions, with secondary tools in Esc. Keep chrome in stable places and explanations in Help or menus; analysis is a show, not a progress bar.
- **No dead controls:** hide unavailable secondary actions. Keep the forward action visible and grey only when
  progression is genuinely blocked. Never put inputs inside buttons; text never
  spills out of its box; the same name never appears twice on one screen.
- **Bold and bright:** the owner likes the vivid colour wash; don't tone visuals down without asking.
- **Gamify it:** rewards, streaks, stage clears, rivalries (groups are teams), brackets and rosters.
- **The Leaderboard is the finishing stage.** One still card at a time, as big as the stage allows, sliding in and
  out (no scaling, no flights); everything the sorter knows on a square, movable sticky note that grows to fit; the
  file, group and date handwritten on the chin; a ruled sheet beside it with the enhance knobs, the four crop modes
  and the turns, per shot, baked into `touched up/` beside the untouched originals. The toolbelt (`static/toolbelt.js`:
  pen, marker, your own sticky notes, eraser) sits on every screen but the welcome and the saves and draws on any
  photo's card (panes, sea prints, tiles, takes in a fan, wrapped pictures: every host in `Toolbelt.HOSTS`); what it
  draws is kept with the shot, shown wherever the shot appears, never exported.
- **Camera raw files are photos** (`RAW_EXTS` in config.py): decoded through LibRaw, dated through exifread.
- Every feature is an editable page plus a minigame that eases it.

## Conventions

- Match the surrounding code: its naming, its density, its comment style (comments say *why*, in plain sentences).
- Copy uses the app's words: *takes* (not frames), *stack*, *group*, *leaderboard*, *set aside*, *same shot*.
- Server responses that change groups/tags go through `_draw_reply(...)` (adds `undo` and `game`); new edits get an
  undo step via `draw.remember(...)` and a test that undoes them.
- New features get unit tests in `tests/` (see `tests/test_draw.py` for the client fixture and helpers).
