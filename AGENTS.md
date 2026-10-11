# MatchER: notes for coding agents

MatchER turns a folder of photos into a game: an analysis screen that shows what it recognizes, then a journey of
stacking, themed groups, tournaments (group stage, knockouts, an 8-photo bracket) and a reveal. Everything runs
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

## Testing

    .venv/bin/python -m pytest -q                  # ~140 unit tests, about a minute; no network needed
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
- `matcher/tags.py`: tags (many per photo: what, who, how it looks, when), the user's edits on top, which tags get
  circles, k-means-clustered group suggestions, names.
- `matcher/themes.py`: the ~57 theme concepts (SigLIP prompts + catchy names), auto-grouping, group-stage maths.
- `matcher/draw.py`: themed groups ("the Draw"): create/move/merge, Quick sort and Find more, the group stage, the
  tag board, and the shared undo history (`remember()`/`undo()`: every edit is one undo step).
- `matcher/store.py`: SQLite schema; migrations are `ALTER TABLE` guarded by column checks (new tables: just add them
  to `SCHEMA`).
- `matcher/game.py`: XP, levels, achievements, stage-clear bonuses. `matcher/ranker.py`: the Bayesian ranker.
- `matcher/static/app.js`: the whole front end. Views are `view*` functions routed by `#hash` (`VIEWS`). `PhotoSea`
  is the photo-sea physics; `VennSea` extends it with tag gravity, fuzzy circles and lasso bubbles; `World` is the one
  sea behind/around every screen (screens are obstacles; focused photos fly out and back; any photo can be grabbed).
- `matcher/static/app.css`: shared screen frame (`.screen`: head strip, body, rail, action bar), then per-feature
  blocks appended in order.

## Design rules (the owner's; keep them)

- **One game, one flow.** The stages in order: Stacks → Groups → Crown → Group stage → Knockouts → Finals → Reveal
  (the Sweep is a side quest). Every stage's finish points to the next one.
- **The same layout everywhere:** a one-line head strip (title, stat chips, `?` help), the one thing to look at in the
  middle, an optional side rail, the action bar at the bottom with the forward action bottom-right. Nothing that
  matters jumps around between states.
- **Keys:** Enter = forward (same as → in minigames), Esc leaves a minigame, Z undoes, ← tosses or rejects, group
  keys 1–9, 0 = 10th, Alt+digit = 11–20, arrows walk lists, Shift+arrows reorder, E renames.
- **The sea is the world:** every photo visible at all times, flowing around each screen. Photos you work on bubble
  out to the centre (bigger, gently wobbling) and shrink back to their spot afterwards. Nothing you reach for may
  move away from the pointer; the hovered photo grows a little, a held one a little more.
- **Show the machine working:** the analysis is a show, not a progress bar.
- **No dead controls:** hide what can't be used rather than greying it; never put inputs inside buttons; text never
  spills out of its box; the same name never appears twice on one screen.
- **Bold and bright:** the owner likes the vivid colour wash; don't tone visuals down without asking.
- **Gamify it:** rewards, streaks, stage clears, rivalries (groups are teams), brackets and rosters.
- Every feature is an editable page plus a minigame that eases it.

## Conventions

- Match the surrounding code: its naming, its density, its comment style (comments say *why*, in plain sentences).
- Copy uses the app's words: *takes* (not frames), *stack*, *group*, *leaderboard*, *set aside*, *same shot*.
- Server responses that change groups/tags go through `_draw_reply(...)` (adds `undo` and `game`); new edits get an
  undo step via `draw.remember(...)` and a test that undoes them.
- New features get unit tests in `tests/` (see `tests/test_draw.py` for the client fixture and helpers).
