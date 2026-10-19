"""Fetch the pinned public-domain photography collection used in documentation screenshots.

Run through tests/ui/setup.sh --showcase. --discover rebuilds the manifest from the Highsmith archive;
normal downloads use only its recorded URLs and verify every checksum. No photographs live in the repo.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import hashlib
from http.client import IncompleteRead
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).with_name("showcase.json")
COLLECTION = "https://www.loc.gov/collections/carol-m-highsmith/"
RIGHTS = "https://www.loc.gov/rr/print/res/482_high.html"
HEADERS = {"User-Agent": "MatchER documentation (public-domain Highsmith photo fixture; github.com/nikhilavibeauterai/MatchER)"}
TOPICS = {
    "mountains": ["mountain"], "lakes": ["lake"], "coast": ["coast", "beach"],
    "desert": ["desert", "canyon"], "forest": ["forest"], "autumn": ["autumn", "fall foliage"],
    "wildlife": ["wildlife", "bison"], "birds": ["bird", "pelican"], "flowers": ["flowers"],
    "country": ["farm", "barn"], "roads": ["road", "highway"], "towns": ["main street"],
    "cities": ["skyline"], "night": ["night", "sunset"], "markets": ["market"],
    "people": ["festival", "cowboy"], "trains": ["train"], "harbors": ["harbor", "marina"],
    "bridges": ["bridge"], "food": ["food", "restaurant"],
}
# Prefer photographs of places and life, rather than reproductions of independently copyrighted artworks.
ART = re.compile(r"\b(mural|sculpture|statue|painting|artwork|art work|graffiti|mosaic|billboard|poster)\b", re.I)


class Fetcher:
    def __init__(self, cache=None):
        self.previous = {}
        self.cache = cache
        self.lock = threading.Lock()

    def get(self, url):
        host = urllib.parse.urlsplit(url).hostname
        cached = self.cache / (hashlib.sha256(url.encode()).hexdigest() + ".json") if self.cache and host == "www.loc.gov" else None
        if cached and cached.exists():
            return cached.read_bytes()
        interval = 3.2 if host == "www.loc.gov" else .5
        # Stay below the Library's separate JSON (20/minute) and image (150/minute) limits.
        for attempt in range(3):
            with self.lock:
                time.sleep(max(0, interval - (time.monotonic() - self.previous.get(host, 0))))
                self.previous[host] = time.monotonic()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
                    data = response.read()
                if cached:
                    cached.parent.mkdir(parents=True, exist_ok=True)
                    cached.write_bytes(data)
                return data
            except urllib.error.HTTPError as error:
                if error.code in (403, 429):
                    raise RuntimeError("The Library is limiting requests; stop and retry later.") from error
                if error.code < 500 or attempt == 2:
                    raise
            except (TimeoutError, urllib.error.URLError, IncompleteRead):
                if attempt == 2:
                    raise
            time.sleep(3 * (attempt + 1))
        raise RuntimeError("Download failed")


def candidate(item, topic):
    title, date = item.get("title", ""), item.get("date", "")
    if not re.fullmatch(r"20\d\d-\d\d-\d\d", date) or date < "2010-01-01" or ART.search(title):
        return None
    images = [url.split("#")[0] for url in item.get("image_url", [])
              if url.startswith("https://tile.loc.gov/image-services/iiif/service:pnp:highsm:")]
    if not images:
        return None
    image = images[0].split("/full/")[0] + "/full/!1280,1280/0/default.jpg"
    source = item.get("url", "").replace("http://", "https://")
    match = re.fullmatch(r"https://www\.loc\.gov/item/(\d+)/", source)
    if not match:
        return None
    label = item.get("item", {}).get("created_published_date", date)
    year = re.match(r"(\d{4})\b", label)
    if year:
        date = year[1] + "-01-01"  # The catalogue's photo date can differ from its search-index year.
    return {"file": f"{topic}/{match[1]}.jpg", "title": title, "source": source, "image": image, "date": date,
            "catalogue_date": label, "date_precision": "year" if date.endswith("-01-01") else "day"}


def discover(fetcher):
    photos, sources, images = [], set(), set()
    for topic, terms in TOPICS.items():
        chosen = []
        for term in terms:
            for page in (1, 2):
                query = urllib.parse.urlencode({"fo": "json", "c": 40, "sp": page, "q": term, "at": "results"})
                items = json.loads(fetcher.get(f"{COLLECTION}?{query}")).get("results", [])
                # Mix states and dates deterministically instead of taking a run of identical catalogue captions.
                items.sort(key=lambda item: hashlib.sha256(item.get("id", "").encode()).hexdigest())
                for item in items:
                    photo = candidate(item, topic)
                    if not photo or photo["source"] in sources or photo["image"] in images:
                        continue
                    sources.add(photo["source"]); images.add(photo["image"])
                    chosen.append(photo)
                    if len(chosen) == 16:
                        break
                if len(chosen) == 16:
                    break
            if len(chosen) == 16:
                break
        if len(chosen) != 16:
            raise ValueError(f"{topic}: found only {len(chosen)} suitable photographs; refine the search terms.")
        photos.extend(chosen)
        print(f"Selected {topic}: {len(chosen)} photographs", flush=True)
    return {"collection": COLLECTION, "photographer": "Carol M. Highsmith", "license": "Public domain",
            "rights": RIGHTS, "photos": photos}


def download(dest, manifest, fetcher, record=False):
    dest.mkdir(parents=True, exist_ok=True)
    def one(photo):
        path = dest / photo["file"]
        expected = photo.get("sha256")
        data = path.read_bytes() if path.exists() else fetcher.get(photo["image"])
        digest = hashlib.sha256(data).hexdigest()
        if not data.startswith(b"\xff\xd8"):
            raise ValueError(f"{photo['file']}: the image server did not return a JPEG")
        if not record and digest != expected:
            raise ValueError(f"{photo['file']}: checksum mismatch; existing files are never overwritten")
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        # The image service strips EXIF. The catalogue's year uses January 1 as a reproducible file-date
        # placeholder; it does not supply an exact capture day. The manifest retains that distinction.
        stamp = dt.datetime.fromisoformat(photo["date"]).replace(tzinfo=dt.timezone.utc).timestamp()
        os.utime(path, (stamp, stamp))
        return digest
    digests = set()
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(one, photo): photo for photo in manifest["photos"]}
        try:
            for index, future in enumerate(as_completed(pending), 1):
                photo, digest = pending[future], future.result()
                if digest in digests:
                    raise ValueError(f"{photo['file']}: duplicate image content")
                digests.add(digest)
                if record:
                    photo["sha256"] = digest
                if index % 16 == 0:
                    print(f"Verified {index}/{len(manifest['photos'])} photographs", flush=True)
        except BaseException:
            for future in pending:
                future.cancel()
            raise
    credits = [f"{p['file']}\t{p['title']}\t{p['source']}" for p in manifest["photos"]]
    (dest / "ATTRIBUTION.txt").write_text(
        f"Photography by Carol M. Highsmith, Library of Congress, Prints & Photographs Division.\n"
        f"Public domain: {manifest['rights']}\n1280px reproductions; catalogue years use January 1 file-date placeholders.\n"
        "Each file is a distinct photograph, not an edited copy or a simulated burst.\n\nfile\ttitle\tsource\n" + "\n".join(credits) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--discover", action="store_true", help="Rebuild the pinned manifest from the public catalogue")
    args = parser.parse_args()
    fetcher = Fetcher(args.folder.parent / ".showcase-catalogue")
    manifest = discover(fetcher) if args.discover else json.loads(MANIFEST.read_text(encoding="utf-8"))
    download(args.folder, manifest, fetcher, record=args.discover)
    if args.discover:
        MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Ready: {len(manifest['photos'])} distinct photographs in {args.folder}", flush=True)


if __name__ == "__main__":
    main()
