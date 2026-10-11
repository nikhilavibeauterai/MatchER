"""A 'photos of me' test set: public-domain photos of one public figure (US government works), plus strangers,
scenery, a screenshot-named file and a synthetic burst."""
import json, sys, time, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image, ImageEnhance
OUT = Path(sys.argv[1])
UA = {"User-Agent": "MatchER-local-test/0.2 (test fixture)"}
def get(url):
    for a in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception:
            time.sleep(4 * (a + 1))
    raise RuntimeError(url)
def fetch(term, folder, want, licence_ok):
    got, off = 0, 0
    while got < want and off < 200:
        q = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrlimit": 25, "gsroffset": off,
             "gsrsearch": f"filetype:bitmap {term}", "prop": "imageinfo", "iiprop": "url|mime|extmetadata", "iiurlwidth": 1600,
             "iiextmetadatafilter": "LicenseShortName"}
        pages = json.loads(get("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(q))).get("query", {}).get("pages", {})
        off += 25
        time.sleep(1)
        for p in pages.values():
            info = (p.get("imageinfo") or [{}])[0]
            lic = info.get("extmetadata", {}).get("LicenseShortName", {}).get("value", "").lower()
            if info.get("mime") != "image/jpeg" or not info.get("thumburl") or not licence_ok(lic):
                continue
            (OUT / folder).mkdir(parents=True, exist_ok=True)
            try:
                data = get(info["thumburl"])
            except RuntimeError:
                continue
            (OUT / folder / f"{folder}_{got:02d}.jpg").write_bytes(data)
            got += 1
            time.sleep(1)
            if got >= want:
                break
    print(folder, got, flush=True)
free = lambda l: l.startswith(("public domain", "cc0", "pd"))
fetch("Barack Obama Pete Souza", "me", 30, free)
fetch("portrait woman smiling", "other", 6, free)
fetch("mountain landscape", "scenery", 3, free)
src = sorted((OUT / "me").glob("*.jpg"))[0]
im = Image.open(src).convert("RGB"); w, h = im.size
(OUT / "burst").mkdir(exist_ok=True)
for k in range(4):
    c = im.crop((int(w * .01 * k), int(h * .01 * k), w - int(w * .01 * (3 - k)), h - int(h * .01 * (3 - k))))
    ex = Image.Exif(); ex.get_ifd(0x8769)[36867] = f"2025:05:01 12:00:{10 + 2 * k:02d}"; ex[271] = "TestCam"
    ImageEnhance.Brightness(c).enhance(.96 + .03 * k).save(OUT / "burst" / f"burst_{k}.jpg", "JPEG", quality=92, exif=ex)
Image.new("RGB", (1080, 2340), (240, 240, 245)).save(OUT / "Screenshot_20260101-101010_Chat.jpg", "JPEG")
print("done")
