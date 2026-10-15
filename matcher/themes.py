"""The Draw: every shot goes into a themed group; each group plays a group stage, and its winners the knockouts.

Likeness and group suggestions are relative to the library. Recognizing a tag needs separate positive evidence:
being the least unlikely label, or unusual among this folder's photos, does not establish that it is present."""
from __future__ import annotations

from datetime import datetime

import numpy as np

from . import library

# key, emoji, SigLIP prompts, catchy names (the first that isn't taken wins; the dice walk the rest)
CONCEPTS: list[tuple[str, str, list[str], list[str]]] = [
    ("beach", "🏖️", ["a photo at the beach", "sand and the ocean", "people at the seaside"],
     ["Beach Bum Era", "Salt & Sand", "Shore Thing", "Tide's Out"]),
    ("sunset", "🌅", ["a sunset", "golden hour light", "a sunrise over the horizon"],
     ["Golden Hour Gang", "Chasing Sunsets", "Magic Hour", "Afterglow"]),
    ("mountains", "🏔️", ["mountains", "a mountain hike", "a snowy mountain peak"],
     ["Peak Performance", "Summit Squad", "High Altitude", "Mountain Mode"]),
    ("forest", "🌲", ["a forest", "trees in the woods", "a trail through the woods"],
     ["Into the Woods", "Tree Hugger Club", "Forest Bathing", "Leaf Peepers"]),
    ("water", "💧", ["a lake", "a river", "a waterfall"], ["Go With the Flow", "Lake Effect", "Waterworks"]),
    ("snow", "❄️", ["snow", "a snowy winter scene", "skiing or snowboarding"], ["Snow Day", "Winter Mode", "Frost Bites"]),
    ("flowers", "🌸", ["flowers", "a garden in bloom", "plants and leaves up close"],
     ["Flower Power", "In Full Bloom", "Garden Variety"]),
    ("sky", "☁️", ["clouds in the sky", "the night sky full of stars", "the moon"],
     ["Head in the Clouds", "Sky's the Limit", "Look Up"]),
    ("desert", "🏜️", ["a desert", "sand dunes", "a canyon"], ["Desert Dreams", "Dune Days", "Canyon Calling"]),
    ("macro", "🦋", ["a close-up macro photo of something small", "an insect", "a butterfly"],
     ["Tiny Worlds", "Up Close", "Macro Mode"]),
    ("rain", "🌧️", ["rain", "a rainy day with puddles", "an umbrella in the rain"],
     ["Rainy Days", "Puddle Jumpers", "Under the Weather"]),
    ("city", "🏙️", ["a city street", "a city skyline", "downtown buildings"],
     ["Concrete Jungle", "Big City Energy", "Street Smarts"]),
    ("night_city", "🌃", ["city lights at night", "a street at night with neon signs"],
     ["Neon Nights", "After Dark", "City After Hours"]),
    ("architecture", "🏛️", ["a historic building", "a church or cathedral", "a monument", "interesting architecture"],
     ["Built Different", "Monumental", "Old Stones"]),
    ("street", "🚶", ["people walking on a busy street", "a market", "a street scene"],
     ["Street Life", "Out and About", "Sidewalk Stories"]),
    ("harbor", "⚓", ["a harbor with boats", "a bridge over water", "a boat"], ["Harbor Lights", "Dockside", "All Aboard"]),
    ("travel", "✈️", ["a famous tourist landmark", "an airport", "the view from an airplane window"],
     ["Passport Stamps", "Wanderlust", "Out of Office"]),
    ("road", "🛣️", ["a road trip", "a long road through the countryside", "the view through a car windshield"],
     ["Open Road", "Miles & Miles", "Scenic Route"]),
    ("cars", "🏎️", ["a car", "a motorcycle", "a sports car"], ["Fast & Curious", "Wheel Deal", "Horsepower"]),
    ("interior", "🛋️", ["the inside of a room", "a cozy living room", "an interior design"],
     ["Home Sweet Home", "Cozy Corner", "Indoor Kids"]),
    ("dogs", "🐶", ["a dog", "a puppy", "a person with a dog"], ["Good Boy Gallery", "Pup Culture", "Who's a Good Boy"]),
    ("cats", "🐱", ["a cat", "a kitten"], ["Cat Tax", "Purrfect", "Feline Fine"]),
    ("birds", "🐦", ["a bird", "birds flying"], ["Bird Brain", "Tweet Spot", "Wingin' It"]),
    ("wildlife", "🦒", ["a wild animal", "animals at a zoo", "farm animals"], ["Wild Things", "Animal Planet", "Safari Mode"]),
    ("food", "🍝", ["a plate of food", "a meal at a restaurant", "home cooking"],
     ["Foodie Finds", "Plate Expectations", "Eat Your Heart Out"]),
    ("dessert", "🍰", ["a dessert", "a cake", "ice cream"], ["Sweet Tooth", "Just Desserts", "Sugar Rush"]),
    ("coffee", "☕", ["a cup of coffee", "a cafe"], ["Bean There", "Espresso Yourself", "Café Society"]),
    ("drinks", "🍹", ["cocktails", "a glass of beer", "wine glasses", "drinks at a bar"],
     ["Cheers!", "Happy Hour", "Pour Decisions"]),
    ("kitchen", "🍳", ["cooking in a kitchen", "ingredients on a kitchen counter"],
     ["Chef's Kiss", "Kitchen Chronicles", "Home Cooked"]),
    ("party", "🎉", ["a party", "people celebrating", "a birthday party with a cake"],
     ["Party Animals", "Good Times", "Main Event"]),
    ("concert", "🎸", ["a concert", "live music on stage", "a festival crowd"], ["Front Row", "Encore!", "Festival Season"]),
    ("night_out", "🪩", ["a photo in a dark bar at night", "a nightclub", "a night out with flash photography"],
     ["Night Shift", "Lights Out", "After Hours"]),
    ("friends", "👯", ["a group of friends", "friends posing together", "people hugging"],
     ["The Squad", "Group Chat", "Crew Love"]),
    ("family", "👨‍👩‍👧", ["a family photo", "children playing", "a baby"], ["Family Album", "Little Ones", "Kin Folk"]),
    ("formal", "🤵", ["a person in a suit", "a formal event", "a wedding"], ["Black Tie", "Dressed to Impress", "Suit Up"]),
    ("style", "🕶️", ["a fashionable outfit", "a person posing in stylish clothes", "a full body photo of an outfit"],
     ["Fit Check", "Drip Report", "Style Files"]),
    ("sunglasses", "😎", ["a person wearing sunglasses"], ["Shades On", "Too Cool", "Sun's Out"]),
    ("hat", "🧢", ["a person wearing a hat", "a person wearing a cap"], ["Hat Trick", "Hats Off", "Cap Collection"]),
    ("glasses", "🤓", ["a person wearing glasses"], ["Specs Appeal", "Four Eyes Club", "Clear Vision"]),
    ("selfie", "🤳", ["a selfie taken at arm's length", "a close-up selfie"],
     ["Main Character", "Arm's Length", "Selfie Society"]),
    ("mirror", "🪞", ["a mirror selfie"], ["Mirror Mirror", "Reflection Session", "Mirror Check"]),
    ("car_selfie", "🚙", ["a selfie taken inside a car"], ["Passenger Princess", "Driver's Seat", "Parked & Posing"]),
    ("bed", "🛏️", ["a selfie lying in bed", "a bedroom"], ["Bedhead", "Lazy Sunday", "Pillow Talk"]),
    ("gym", "💪", ["a gym", "working out", "a fitness selfie"], ["Gym Rat Chronicles", "Gains Gallery", "Pump Cover"]),
    ("sports", "⚽", ["playing a sport", "a sports game", "a stadium"], ["Game Day", "Team Spirit", "Sports Center"]),
    ("outdoorsy", "🏕️", ["hiking", "camping with a tent", "a campfire"], ["Campfire Stories", "Trail Mix", "Great Outdoors"]),
    ("pool", "🏊", ["swimming", "a swimming pool", "people in swimsuits"], ["Pool Party", "Making Waves", "Deep End"]),
    ("sunny", "🌞", ["a person outdoors in bright sunshine"], ["Sun-Kissed", "Vitamin D", "Daylight Savings"]),
    ("smile", "😄", ["a person smiling broadly", "a person laughing"], ["Say Cheese", "All Smiles", "Good Vibes Only"]),
    ("serious", "🖤", ["a serious expression", "a moody portrait"], ["Blue Steel", "Brooding Hours", "Moody Mode"]),
    ("portrait", "📸", ["a professional portrait photo", "a headshot"], ["Headshot Heaven", "Portrait Mode", "Face Value"]),
    ("art", "🎨", ["a painting", "an art gallery", "street art and graffiti"], ["Art Attack", "Gallery Walk", "Wall Candy"]),
    ("text", "📝", ["a screenshot", "a document", "a sign with writing"], ["Fine Print", "Paper Trail", "Read Me"]),
    ("tech", "💻", ["a computer", "gadgets and electronics"], ["Tech Stack", "Gadget Garage", "Plugged In"]),
    ("work", "💼", ["an office", "a desk with a laptop", "a meeting"], ["Office Hours", "Nine to Five", "Desk Job"]),
    ("bw", "🎞️", ["a black and white photo"], ["Monochrome", "Film Noir", "Grayscale Gang"]),
    ("holidays", "🎄", ["a christmas tree", "holiday decorations", "halloween costumes"],
     ["Holiday Spirit", "'Tis the Season", "Festive Feels"]),
]
WILD = ("wild", "🃏", ["Wildcards", "Odd Socks", "Misfits", "Free Agents", "The Underdogs"])
THEME_CAP = 40      # the auto-draw closes a group at this many shots (yours can grow as big as you like)
BULK_MIN = 4        # this many sure things in a row come as one card

_T: tuple = (None, None, None)


def _prompts() -> tuple[np.ndarray, np.ndarray]:
    """Every concept prompt's SigLIP text embedding, and where each concept's prompts start (kept per embedding
    function, so tests that swap it get their own)."""
    global _T
    if _T[0] is not library._prompt_embeddings:
        prompts = [p for _, _, ps, _ in CONCEPTS for p in ps]
        starts = np.cumsum([0] + [len(ps) for _, _, ps, _ in CONCEPTS])[:-1]
        _T = (library._prompt_embeddings, library._prompt_embeddings(prompts), starts)
    return _T[1], _T[2]


def concept_scores(E: np.ndarray) -> np.ndarray:
    """(shots, concepts): each shot's best match to each concept's prompts."""
    T, starts = _prompts()
    if not len(E):
        return np.zeros((0, len(CONCEPTS)), np.float32)
    return np.maximum.reduceat(E @ T.T, starts, axis=1)


def evidence_mask(scores: np.ndarray, reference: np.ndarray | None = None) -> np.ndarray:
    """Conservative evidence for these quantized SigLIP towers, not a calibrated probability.

    Public fixtures put clear matches around .05–.10 cosine. A fixed floor stops tiny numerical outliers;
    contrast rejects uniformly vague scores; the best-match margin rejects weaker competing explanations.
    Independently strong evidence can still keep several subjects in the same photo. No library percentile
    or quota can turn an absent subject into a tag.
    """
    scores = np.asarray(scores)
    ref = scores if reference is None else np.asarray(reference)
    ref = np.where(np.isfinite(ref), ref, 0.0)
    baseline = np.median(ref, axis=1, keepdims=True)
    best = np.max(ref, axis=1, keepdims=True)
    return (np.isfinite(scores) & (scores >= .05) & (scores >= baseline + .035)
            & ((scores >= best - .02) | (scores >= .08)))


def space(E: np.ndarray, fit: np.ndarray | None = None) -> tuple[np.ndarray, "Namer"]:
    """Where the Draw measures likeness: each shot's image embedding alongside its profile over the theme concepts
    (z-scored over the `fit` shots: the ones in the running), equally weighted. On a mixed test gallery this put 94%
    of shots with their own kind, against 84% on looks alone. Rows of shots without an embedding are zero."""
    namer = Namer(E, fit)
    Z = (namer.C - namer.mu) / namer.sd
    has = np.abs(E).sum(1) > 0
    Z = np.where(has[:, None], Z, 0)
    Z /= np.maximum(np.linalg.norm(Z, axis=1, keepdims=True), 1e-9)
    F = np.hstack([E, Z]).astype(np.float32)
    F /= np.maximum(np.linalg.norm(F, axis=1, keepdims=True), 1e-9)
    return F, namer


class Namer:
    """Names for groups of one library's shots: the concept that sets them apart most, z-scored against the whole
    library (so a folder of selfies doesn't call every group "Main Character")."""

    def __init__(self, E: np.ndarray, fit: np.ndarray | None = None):
        self.C = concept_scores(E)
        ref = self.C if fit is None or not fit.any() else self.C[fit]
        self.mu = ref.mean(0) if len(ref) else np.zeros(len(CONCEPTS))
        self.sd = (ref.std(0) if len(ref) else np.zeros(len(CONCEPTS))) + 1e-6

    def z(self, idx) -> np.ndarray:
        return (self.C[list(idx)].mean(0) - self.mu) / self.sd

    def concept_z(self, key: str) -> np.ndarray | None:
        """Every shot's z-score on one concept (None for an unknown or wildcard one)."""
        k = next((n for n, c in enumerate(CONCEPTS) if c[0] == key), None)
        return None if k is None else (self.C[:, k] - self.mu[k]) / self.sd[k]

    def options(self, idx, taken: set[str]) -> list[dict]:
        """Names for these shots, best first, skipping names already in use."""
        idx = list(idx)
        if not idx:
            return wild_name(taken)
        supported = evidence_mask(self.C[idx]).mean(0) >= .6
        out = []
        for k in [j for j in np.argsort(-self.z(idx)) if supported[j]][:4]:
            key, emoji, _, names = CONCEPTS[int(k)]
            out += [{"name": n, "emoji": emoji, "concept": key} for n in names if n.lower() not in taken]
        return out or wild_name(taken)

    def name(self, idx, taken: set[str], roll: int = 0) -> dict:
        opts = self.options(idx, taken)
        return opts[roll % len(opts)]


def wild_name(taken: set[str]) -> list[dict]:
    key, emoji, names = WILD
    free = [n for n in names if n.lower() not in taken] or [f"{names[0]} {len(taken) + 1}"]
    return [{"name": n, "emoji": emoji, "concept": key} for n in free]


SEASONS = {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring", 6: "Summer", 7: "Summer",
           8: "Summer", 9: "Autumn", 10: "Autumn", 11: "Autumn"}


def tagline(ts: list) -> str:
    """When a group's photos were taken, if they agree: a day, a month, a season, a year or a span of years."""
    t = sorted(x for x in ts if x)
    if not t or len(t) < 0.6 * len(ts):
        return ""
    lo = datetime.fromtimestamp(t[int(0.1 * (len(t) - 1))])
    hi = datetime.fromtimestamp(t[int(round(0.9 * (len(t) - 1)))])
    days = (hi - lo).days
    if days <= 2:
        return f"{lo.day} {lo:%b %Y}"
    if days <= 45 and (lo.year, lo.month) == (hi.year, hi.month):
        return f"{lo:%B %Y}"
    if days <= 100:
        mid = datetime.fromtimestamp(t[len(t) // 2])
        return f"{SEASONS[mid.month]} {mid.year}"
    return str(lo.year) if lo.year == hi.year else f"{lo.year}–{hi.year}"


def lines(E: np.ndarray, pool: np.ndarray, rng: np.random.Generator | None = None) -> tuple[float, float]:
    """(alike, sure): the 90th and 99th percentile of similarity between two random shots of this pool. Above
    `alike` a shot plausibly belongs with another; above `sure` it's close to a look-alike."""
    rng = rng or np.random.default_rng(0)
    if len(pool) < 3:
        return 0.6, 0.85
    a = rng.choice(pool, 4000)
    b = rng.choice(pool, 4000)
    keep = a != b
    s = np.einsum("ij,ij->i", E[a[keep]], E[b[keep]])
    return float(np.percentile(s, 90)), float(np.percentile(s, 99))


def _topmean(P: np.ndarray, Q: np.ndarray, k: int = 3) -> np.ndarray:
    """For each row of P, its mean similarity to its k most similar rows of Q."""
    if not len(Q):
        return np.zeros(len(P), np.float32)
    S = P @ Q.T
    k = min(k, S.shape[1])
    return np.partition(S, S.shape[1] - k, axis=1)[:, -k:].mean(1)


def best_group(F: np.ndarray, items, groups: list) -> tuple[np.ndarray, np.ndarray]:
    """For each item, the group (index into `groups`, lists of rows of F) holding its most similar shot, and that
    similarity. Blockwise, so thousands of items against thousands of groups stay quick."""
    items = np.asarray(items, np.int64)
    if not len(items) or not groups:
        return np.full(len(items), -1), np.full(len(items), -np.inf)
    cols = np.concatenate([np.asarray(g, np.int64) for g in groups])
    starts = np.cumsum([0] + [len(g) for g in groups])[:-1]
    best = np.empty(len(items), np.int64)
    fit = np.empty(len(items), np.float32)
    for b0 in range(0, len(items), 512):
        per = np.maximum.reduceat(F[items[b0:b0 + 512]] @ F[cols].T, starts, axis=1)
        best[b0:b0 + 512] = per.argmax(1)
        fit[b0:b0 + 512] = per.max(1)
    return best, fit


def _z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-9)


def rank(E: np.ndarray, members, rejects, pool: np.ndarray, concept_z: np.ndarray | None = None,
         words: np.ndarray | None = None, weight: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Pool shots ordered by how well they fit a group: close to its members (to its closest few, so a group can
    have more than one look), away from the shots you said don't belong, nudged by the group's theme. `words`: each
    shot's match to what you said to look for (image-text similarity); it counts `weight` times as much as looks,
    both z-scored over the pool. Returns (order, looks score in that order)."""
    if not len(pool):
        return pool, np.zeros(0, np.float32)
    P = E[pool]
    sm = _topmean(P, E[list(members)]) if len(members) else np.zeros(len(pool), np.float32)
    score = sm.copy()
    if len(rejects):
        score -= 0.5 * np.maximum(0, _topmean(P, E[list(rejects)]) - sm)
    if concept_z is not None:
        score += 0.02 * np.clip(concept_z[pool], -2, 3)
    key = score if words is None or len(pool) < 2 else _z(score) + weight * _z(words[pool])
    order = np.argsort(-key, kind="stable")
    return pool[order], score[order]


def stock_name(name: str) -> bool:
    """One of the names the Draw hands out (not words of yours worth searching for)."""
    n = name.strip().lower()
    return any(n == x.lower() for _, _, _, names in CONCEPTS for x in names) or \
        any(n.startswith(x.lower()) for x in WILD[2])


def _silhouette(S: np.ndarray, labels: np.ndarray) -> float:
    """Mean silhouette (cosine distance) of a grouping; ungrouped shots (-1) count as 0."""
    keys = [k for k in np.unique(labels) if k >= 0]
    if len(keys) < 2:
        return 0.0
    onehot = (labels[:, None] == np.array(keys)[None, :]).astype(np.float32)
    size = onehot.sum(0)
    mean_d = (1.0 - S) @ onehot / size                     # each shot's mean distance to each group
    own = np.array([keys.index(k) if k >= 0 else -1 for k in labels])
    out = np.zeros(len(labels))
    for i in np.flatnonzero(own >= 0):
        n = size[own[i]]
        if n < 2:
            continue
        a = mean_d[i, own[i]] * n / (n - 1)                # its own group, without itself
        b = np.min(np.delete(mean_d[i], own[i]))
        out[i] = (b - a) / max(a, b, 1e-9)
    return float(out.mean())


def _families(F: np.ndarray) -> list[list[int]]:
    """Average-linkage families of 3+ (see library.lookalike_order), at whichever of a few similarity lines
    (percentiles of this pool's pairs) groups it best by silhouette; ties go to the stricter line. On a mixed
    test gallery that picked the 85th percentile (91% of grouped shots with their own kind)."""
    S = F @ F.T
    pairs = S[np.triu_indices(len(F), 1)]
    best, top = [], -1.0
    for tau in np.percentile(pairs, [75, 80, 85, 90, 95]):
        order, fam = library.lookalike_order(F, float(tau))
        groups: dict[int, list[int]] = {}
        for o in order:
            groups.setdefault(fam[o], []).append(int(o))
        found = [g for g in groups.values() if len(g) >= 3]
        labels = np.full(len(F), -1)
        for k, g in enumerate(found):
            labels[g] = k
        score = _silhouette(S, labels)
        if score >= top - 1e-9:
            best, top = found, score
    return best


def auto_draw(F: np.ndarray, pool: np.ndarray, cap: int = THEME_CAP) -> tuple[list[list[int]], list[int]]:
    """Group the pool for you: average-linkage families (see _families), big ones cut into even runs of at most `cap`.
    Shots in no family join the group they fit best if they fit it well enough; the rest come back as wildcards.
    Pass the pool in time order: past 2,500 shots, families are found within consecutive stretches."""
    if len(pool) > library.LOOKALIKE_MAX:
        groups: list[list[int]] = []
        wild: list[int] = []
        for c0 in range(0, len(pool), library.LOOKALIKE_MAX):
            g, w = auto_draw(F, pool[c0:c0 + library.LOOKALIKE_MAX], cap)
            groups += g
            wild += w
        return groups, wild
    if len(pool) < 3:
        return [], [int(i) for i in pool]
    alike, _ = lines(F, pool)
    groups: list[list[int]] = []
    for f in _families(F[pool]):
        size = -(-len(f) // -(-len(f) // cap))
        groups += [f[k:k + size] for k in range(0, len(f), size)]
    placed = {i for g in groups for i in g}
    rest = [i for i in range(len(pool)) if i not in placed]
    wild = []
    best, fit = best_group(F, pool[rest], [pool[g] for g in groups])
    for i, g, f in zip(rest, best, fit):
        if g >= 0 and f >= alike and len(groups[g]) < cap + cap // 4:  # a straggler joins the group it fits best
            groups[g].append(i)
        else:
            wild.append(i)
    return [[int(pool[i]) for i in g] for g in groups], [int(pool[i]) for i in wild]


def advancers(sizes: dict, k: int) -> dict:
    """How many shots each group sends to the knockouts: about 2× the leaderboard in all, shared out by group size,
    at least one each. Small fields keep enough contenders for a four-shot final."""
    total = sum(sizes.values())
    pool = min(total, max(8, 2 * k))
    places = {t: n if n <= 1 else int(min(max(1, round(pool * n / max(1, total))), max(1, n // 2)))
              for t, n in sizes.items()}
    while sum(places.values()) < min(4, total):
        # A tiny group may send more than half; otherwise six good photos could qualify only three.
        t = max((t for t, n in sizes.items() if places[t] < n), key=lambda t: sizes[t] / (places[t] + 1))
        places[t] += 1
    return places


def group_odds(mu: np.ndarray, var: np.ndarray, a: int, rng: np.random.Generator, samples: int = 256) -> np.ndarray:
    """Each member's chance of finishing in its group's top `a` (Monte Carlo over the posterior)."""
    n = len(mu)
    if a >= n:
        return np.ones(n)
    th = mu + np.sqrt(np.maximum(var, 1e-9)) * rng.standard_normal((samples, n))
    kth = -np.partition(-th, a - 1, axis=1)[:, a - 1:a]
    return (th >= kth).mean(0)


def letter(k: int) -> str:
    """Group A, B, … Z, AA, AB…"""
    s = ""
    k += 1
    while k:
        k, r = divmod(k - 1, 26)
        s = chr(65 + r) + s
    return s
