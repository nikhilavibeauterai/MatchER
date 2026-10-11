"""A sample library for trying MatchER without your own photos: public-domain and CC0 pictures from Wikimedia
Commons, fetched on request (nothing is downloaded unless you ask), with an attribution file alongside."""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageEnhance

API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "MatchER/0.2 (local photo-sorting game; sample library download)"}
PLAN = {  # folder: (search terms, how many)
    "nature": (["mountain lake", "beach sunset", "forest path", "waterfall", "desert dunes"], 9),
    "places": (["city street night", "old town square", "bridge river city", "cathedral interior"], 8),
    "animals": (["dog portrait", "cat sitting", "bird on branch", "horse meadow"], 8),
    "food": (["breakfast plate", "fruit bowl", "coffee cup", "bread bakery"], 7),
    "people": (["portrait smiling", "street musician", "people market"], 6),
    "things": (["vintage car", "bicycle", "old camera"], 5),
}
FREE = ("public domain", "cc0", "pd")


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:  # rate limits and blips: back off and retry
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


class SampleFetcher:
    def __init__(self, dest: Path):
        self.dest = Path(dest)
        self.lock = threading.Lock()
        self.status = {"state": "done" if (self.dest / "ATTRIBUTION.txt").exists() else "idle",
                       "done": 0, "total": sum(n for _, n in PLAN.values()) + 4, "path": str(self.dest), "error": None}

    def start(self) -> dict:
        with self.lock:
            if self.status["state"] not in ("running", "done"):
                self.status.update(state="running", done=0, error=None)
                threading.Thread(target=self._run, daemon=True).start()
            return dict(self.status)

    def _run(self) -> None:
        try:
            credits = []
            for folder, (terms, want) in PLAN.items():
                got = 0
                for term in terms:
                    if got >= want:
                        break
                    q = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
                         "gsrlimit": 20, "gsrsearch": f"filetype:bitmap {term}", "prop": "imageinfo",
                         "iiprop": "url|mime|extmetadata", "iiurlwidth": 1600,
                         "iiextmetadatafilter": "LicenseShortName|Artist|ObjectName"}
                    pages = json.loads(_get(f"{API}?{urllib.parse.urlencode(q)}")).get("query", {}).get("pages", {})
                    time.sleep(1)
                    for page in pages.values():
                        info = (page.get("imageinfo") or [{}])[0]
                        meta = info.get("extmetadata", {})
                        lic = meta.get("LicenseShortName", {}).get("value", "").strip().lower()
                        if info.get("mime") != "image/jpeg" or not info.get("thumburl") or not lic.startswith(FREE):
                            continue
                        name = f"{folder}/{folder}_{got + 1:02d}.jpg"
                        out = self.dest / name
                        out.parent.mkdir(parents=True, exist_ok=True)
                        out.write_bytes(_get(info["thumburl"]))
                        credits.append(f"{name}\t{page['title']}\t{lic}\t{info.get('descriptionurl', '')}")
                        got += 1
                        self.status["done"] += 1
                        time.sleep(1)
                        if got >= want:
                            break
            self._burst()
            (self.dest / "ATTRIBUTION.txt").write_text(
                "Sample photos from Wikimedia Commons, public domain or CC0 at download time.\n"
                "file\tCommons title\tlicence\tsource\n" + "\n".join(credits) + "\n")
            self.status["state"] = "done"
        except Exception as e:  # offline, Commons down: say so and let the person try again
            self.status.update(state="error", error=f"Couldn't download the sample photos ({e}).")

    def _burst(self) -> None:
        """Four nudged copies of one landscape, a few seconds apart, so the sample has a stack to crown."""
        src = next(iter(sorted((self.dest / "nature").glob("*.jpg"))), None)
        if src is None:
            return
        im = Image.open(src).convert("RGB")
        w, h = im.size
        (self.dest / "burst").mkdir(exist_ok=True)
        for k in range(4):
            crop = im.crop((int(w * 0.01 * k), int(h * 0.01 * k), w - int(w * 0.01 * (3 - k)), h - int(h * 0.01 * (3 - k))))
            ex = Image.Exif()
            ex.get_ifd(0x8769)[36867] = f"2025:07:14 18:20:{10 + 2 * k:02d}"
            ImageEnhance.Brightness(crop).enhance(0.96 + 0.03 * k).save(
                self.dest / "burst" / f"burst_{k + 1}.jpg", "JPEG", quality=92, exif=ex)
            self.status["done"] += 1
