# Screenshot collection

The README shows MatchER running on **320 distinct travel photographs**, rather than the small offline sampler.
Photography: **Carol M. Highsmith, Library of Congress, Prints & Photographs Division**.
The Library records her photographs as [public domain](https://www.loc.gov/rr/print/res/482_high.html).
Browse the [Highsmith archive](https://www.loc.gov/collections/carol-m-highsmith/).

The [pinned source manifest](../../tests/ui/fixtures/showcase.json) records the title, catalogue page, date precision,
download URL and SHA-256 for every photograph. Images are 1280px reproductions from the Library's image service;
their catalogue years use January 1 as reproducible file-date placeholders, rather than known capture days.
Each image is a separate photograph. The collection
contains mountains, lakes, coasts, desert, forest, autumn, wildlife, birds, flowers, farms, roads, towns,
cityscapes, night scenes, markets, people, trains, harbors, bridges and food.

The screenshots are actual browser captures of local analysis and normal app interactions. The save includes
kept photos, hand-made stacks of related views, automatic groups, and a favourite with a title and a note.
The [capture selections](../../tests/ui/fixtures/showcase-scenes.json) record the real photos in each stack.
Help is off, fill-height framing is on (the featured garden stays whole), and the sea is zoomed slightly
so the prints remain readable in the README.
No photo count is simulated.
The app's bundled offline sample is separate and remains available without downloading this collection.

## Reproduce the captures

From a source checkout with the app's Python environment available:

```sh
export MATCHER_UI_TMP=/tmp/matcher-docs
export MATCHER_MODELS="$MATCHER_UI_TMP/models"
tests/ui/setup.sh
tests/ui/setup.sh --showcase
tests/ui/run.sh docs_screenshots
```

The showcase download is about 54 MB. The test setup downloads only the recorded public photographs, checks
their hashes, and writes their credits to `ATTRIBUTION.txt`. Its downloader respects the Library's separate
catalogue and image request limits.
Analysis and all demonstration choices stay in a disposable save under `$MATCHER_UI_TMP`.

Review `shots/docs-*.png` there. Then export the reviewed captures into this directory:

```sh
.venv/bin/python scripts/export_doc_images.py "$MATCHER_UI_TMP/shots"
```

The exporter uses lossless WebP and verifies that the saved pixels match each browser capture.
To adjust framing without analyzing the collection again, run
`MATCHER_UI_REUSE=1 tests/ui/run.sh docs_screenshots`; this option applies only to the documentation suite.
Normal test suites always start with fresh saves.
