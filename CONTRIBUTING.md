# Contributing

MatchER is a local photo game: Filter → Stacks → Crown → Groups → Group stage → Knockouts → Finals → Reveal.
Small fixes, clearer onboarding, accessibility improvements and reproducible Windows/Linux reports are welcome.
Discuss large workflow changes in an issue first so the game keeps one coherent flow.

Start with [installation](docs/install.md) and [building](docs/building.md). The Python code is in `matcher/`;
the plain JavaScript/CSS front end is in `matcher/static/`; the desktop wrapper is in `desktop/`.

```sh
python -m pytest -q
node tests/sea_checks.cjs
node tests/toolbelt_checks.cjs
node tests/duel_checks.cjs
cd desktop
npm test
```

Install the separate build/test dependencies from `packaging/requirements.lock`. For visual changes, run the
relevant [browser suites](tests/ui/README.md), inspect their screenshots and update deliberate layout expectations.
Use the bundled public-domain sample or the libraries fetched by `tests/ui/setup.sh`. Set `MATCHER_DATA` to a
throwaway directory; never test decisions against personal saves or attach private photos, previews or databases
to a report. Stop only servers you started.

For performance work, run `python -m tests.benchmark_performance` for synthetic 3,600/20,000-photo API timings
and CPU profiles, and `tests/ui/run.sh performance` for browser profiles of large group expansion and scrolling.
Both print JSON; the browser suite also records layouts, long tasks, live cards, requests and screenshots.
Run timings with other tests stopped for a useful comparison. The [recorded performance pass](docs/performance.json)
includes the fixtures, baseline revision and limits of the measurements. Keep the same photos, colours, edits
and interactions when reducing work; the colour-worker suite compares its pixels with the canvas fallback.

Use the app's words: **take**, **stack**, **group**, **leaderboard**, **set aside**. Keep all photo cards in the
shared polaroid frame. Edits need an undo step and a test that restores the previous state. Match surrounding
code and explain why a change is needed in the pull request, with relevant validation.
