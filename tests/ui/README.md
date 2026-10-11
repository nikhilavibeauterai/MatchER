# Browser suites

Playwright (`playwright-core`) scripts that drive MatchER end to end in a headless browser, each against a throwaway
server on its own data dir. They only ever use the public-domain test libraries fetched by `setup.sh`.

    tests/ui/setup.sh            # once, needs the network: npm deps, headless Chromium, the two test libraries
    tests/ui/run_all.sh          # every suite, then a pass/fail summary
    tests/ui/run.sh venn_peek    # one suite; its JSON result: $MATCHER_UI_TMP/venn_peek_result.json

Everything they create (data dirs, server logs, results, screenshots in `shots/`) lives in `$MATCHER_UI_TMP`
(default `/tmp/matcher-ui`). A suite fails if it exits non-zero or its result lists `problems` (page or console errors).

| suite | covers |
|---|---|
| flow2_e2e | the whole journey in order: analysis, map, Stacks + Twin check, Groups (list view), Quick sort, crown, group stage |
| gallery_e2e | gallery mode: cups, sweep, keys, lightning, ceremony, reveal, leaderboard, finals on a phone |
| me_e2e | "photos of me" mode, the People page, set aside |
| sea2_peek / venn_peek | the tag sea on the Groups page: physics, drag to tags / onto a group, keys, suggestions, tag tray |
| arrows_peek / qs_peek | Quick sort and Find more: arrow keys, ★ guess, toss on ←, counts |
| inputs_peek / naming_e2e | text inputs never overflow; renaming, emoji search, group keys (0, Alt+n) |
| world_peek / grab_peek / ko_peek | the sea behind every screen: photos flying in and out of a duel, grabbing a photo, knockouts |
| board_peek | the tournament board |
| analysis_peek / an_mid / details_peek | the analysis screen, step by step (the grab, tags pulling photos together, no teleporting) |
| toggles_peek | auto-filter and auto-crop from the menu |
| sea_slots_peek / tour | photo-sea stability; screenshots of every screen (desktop and phone) |
