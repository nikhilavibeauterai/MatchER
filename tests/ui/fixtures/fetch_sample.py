"""The gallery test library: the app's own sample set (~45 public-domain Wikimedia Commons photos, sorted into kinds).
Usage: python tests/ui/fixtures/fetch_sample.py <folder>"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from matcher.sample import SampleFetcher  # noqa: E402

f = SampleFetcher(Path(sys.argv[1]))
f.start()
t0 = time.time()
while f.status["state"] == "running" and time.time() - t0 < 900:
    time.sleep(3)
print(f.status, round(time.time() - t0), "s")
sys.exit(0 if f.status["state"] == "done" else 1)
