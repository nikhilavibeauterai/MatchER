"""Build matcher/static/emoji.json: every single-code-point emoji with its Unicode name and some everyday words, for
the emoji picker's search (offline: names come from Python's unicodedata, the words from the list below and from the
Draw's theme concepts). Run: python scripts/make_emoji.py"""
import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from matcher.themes import CONCEPTS  # noqa: E402

BLOCKS = [(0x1F300, 0x1F5FF), (0x1F600, 0x1F64F), (0x1F680, 0x1F6FF), (0x1F900, 0x1F9FF), (0x1FA70, 0x1FAFF),
          (0x2600, 0x27BF), (0x2B50, 0x2B55), (0x1F004, 0x1F004), (0x1F0CF, 0x1F0CF), (0x1F18E, 0x1F18E),
          (0x1F191, 0x1F19A), (0x2190, 0x21FF), (0x231A, 0x23FF), (0x2934, 0x2935), (0x3030, 0x3030), (0x303D, 0x303D)]
VS16 = "\ufe0f"   # variation selector 16: emoji presentation
SKIP = ("SKIN TONE", "TAG ", "VARIATION", "COMBINING", "REGIONAL INDICATOR")
# everyday words people search with that the Unicode names don't contain
WORDS = {
    "💻": "laptop computer tech work", "🖥️": "computer desktop screen monitor", "📱": "phone smartphone mobile",
    "⌨️": "keyboard typing", "🖱️": "mouse", "🎮": "gaming games controller", "📷": "camera photo", "📸": "camera photo flash",
    "🚗": "car drive", "🚙": "car suv jeep", "🏎️": "race car fast", "🏍️": "motorbike motorcycle", "🚲": "bike cycling",
    "✈️": "plane flight travel airplane", "🚆": "train", "🚢": "ship boat cruise", "⛵": "boat sailing", "🛣️": "road highway trip",
    "🐶": "dog puppy pet", "🐕": "dog pet", "🐱": "cat kitten pet", "🐈": "cat pet", "🐦": "bird", "🐴": "horse", "🦁": "lion",
    "🍕": "pizza food", "🍔": "burger food", "🍝": "pasta food dinner", "🍣": "sushi food", "🍰": "cake dessert", "🍦": "ice cream",
    "☕": "coffee cafe", "🍺": "beer drink", "🍷": "wine drink", "🍹": "cocktail drink", "🥂": "cheers toast champagne",
    "🎉": "party celebrate", "🎂": "birthday cake", "🎁": "gift present", "🎄": "christmas tree holiday", "🎃": "halloween pumpkin",
    "❤️": "love heart red", "💕": "love hearts", "😍": "love eyes", "🔥": "fire hot lit", "✨": "sparkle magic shiny", "⭐": "star",
    "🌟": "star glow", "🌈": "rainbow pride", "☀️": "sun sunny", "🌙": "moon night", "⛈️": "storm", "❄️": "snow cold winter",
    "🏖️": "beach holiday", "🏝️": "island tropical", "🌊": "wave ocean sea surf", "🏔️": "mountain snow peak", "⛰️": "mountain hike",
    "🌲": "tree forest pine", "🌳": "tree park", "🌸": "flower blossom spring", "🌻": "sunflower flower summer", "🍂": "autumn fall leaves",
    "🏙️": "city skyline", "🌃": "night city", "🏠": "home house", "🏡": "home house garden", "🏢": "office building work",
    "💪": "gym strong workout muscle", "🏋️": "gym weights workout", "🏃": "run running", "⚽": "football soccer", "🏀": "basketball",
    "🎸": "guitar music concert", "🎤": "mic singing karaoke", "🎧": "headphones music", "🎨": "art painting", "📚": "books study",
    "🎓": "graduation school", "💼": "work job business", "💍": "ring wedding engagement", "👰": "wedding bride", "🤵": "suit wedding groom",
    "😎": "cool sunglasses", "🕶️": "sunglasses shades", "🧢": "cap hat", "👗": "dress fashion outfit", "👟": "sneakers shoes",
    "🤳": "selfie", "🪞": "mirror selfie", "😄": "happy smile laugh", "😂": "laugh lol funny", "🥳": "party celebrate",
    "😴": "sleep tired", "🛏️": "bed sleep", "👶": "baby", "👨‍👩‍👧": "family", "👯": "friends party dancing", "🫶": "love heart hands",
    "🏆": "trophy win winner champion", "🥇": "gold medal first winner", "👑": "crown king queen royal", "💎": "diamond gem",
    "💰": "money cash", "📝": "notes writing document", "📄": "document paper", "🗂️": "folder files group", "🃏": "joker wild card",
    "🎲": "dice game random", "🧩": "puzzle", "🔍": "search find", "🔎": "search find", "📍": "pin location place", "🗺️": "map travel",
    "⛺": "tent camping", "🏕️": "camping outdoors", "🔦": "torch flashlight", "🌅": "sunrise sunset dawn", "🌄": "sunrise mountains",
    "🎞️": "film movie black and white", "🎬": "movie film cinema", "📺": "tv television", "🎵": "music note", "🍳": "cooking breakfast egg",
    "🥗": "salad healthy food", "🍩": "donut doughnut", "🍪": "cookie", "🍫": "chocolate", "🍓": "strawberry fruit", "🍎": "apple fruit",
}


def main():
    words: dict[str, set[str]] = {}
    for key, emoji, _, _ in CONCEPTS:
        words.setdefault(emoji, set()).update(key.replace("_", " ").split())
    for e, w in WORDS.items():
        words.setdefault(e, set()).update(w.split())
    out, seen = [], set()
    for lo, hi in BLOCKS:
        for cp in range(lo, hi + 1):
            name = unicodedata.name(chr(cp), "")
            if not name or any(s in name for s in SKIP):
                continue
            ch = chr(cp)
            if unicodedata.category(ch) != "So":
                continue
            ch += VS16  # ask for the colour glyph (harmless where it's the default anyway)
            seen.add(ch)
            extra = words.get(ch, set()) | words.get(ch.rstrip(VS16), set())
            out.append([ch, " ".join([name.lower()] + sorted(extra - set(name.lower().split()))), 1 if extra else 0])
    for e, w in words.items():  # sequences (families, ZWJ) the blocks don't cover
        if e not in seen and e.rstrip(VS16) not in seen and e + VS16 not in seen:
            out.append([e, " ".join(sorted(w)), 1])
    path = Path(__file__).resolve().parent.parent / "matcher" / "static" / "emoji.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(out)} emoji, {path.stat().st_size // 1024} KB → {path}")


if __name__ == "__main__":
    main()
