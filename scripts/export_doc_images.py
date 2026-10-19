"""Copy reviewed browser captures into the docs as smaller, pixel-identical lossless WebP files."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops

NAMES = ("map", "filter", "groups", "groups-sea", "stacks", "stack-fan", "crown", "leaderboard", "notes", "axes", "phone")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shots", type=Path)
    args = parser.parse_args()
    report = json.loads((args.shots.parent / 'docs_screenshots_result.json').read_text())
    captures = {capture['name']: capture for capture in report['captures']}
    if report['photos'] != 320 or report['uniqueSources'] != 320 or report['problems'] or any(
            name not in captures or captures[name]['photos'] != 320 or captures[name]['broken'] for name in NAMES):
        raise ValueError('Export only a complete, passing run of the 320-photo documentation suite')
    dest = Path(__file__).resolve().parents[1] / "docs" / "images"
    for name in NAMES:
        source, output = args.shots / f"docs-{name}.png", dest / f"{name}.webp"
        with Image.open(source) as image:
            image = image.convert("RGB")
            image.save(output, "WEBP", lossless=True, method=6)
            with Image.open(output) as saved:
                if ImageChops.difference(image, saved.convert("RGB")).getbbox():
                    raise ValueError(f"{name}: compression changed the captured pixels")
        print(f"{name}: {source.stat().st_size:,} → {output.stat().st_size:,} bytes (lossless)")


if __name__ == "__main__":
    main()
