"""The game layer: XP, levels, streaks and achievements, all derived from the vote history
(so nothing extra is stored, undo takes XP back, and earlier sessions count)."""
from __future__ import annotations

import json
from collections import Counter
from datetime import date, datetime, timedelta

LEVEL_XP = [0, 150, 400, 750, 1200, 1800, 2600, 3600, 5000, 6800, 9000, 11800, 15000, 19000, 24000]
LEVEL_NAMES = {
    "me": ["Swipe Rookie", "Selfie Scout", "Angle Hunter", "Light Chaser", "Frame Whisperer", "Profile Architect",
           "Vibe Curator", "Casting Director", "Talent Agent", "Matchmaker", "Heartthrob Producer",
           "Cupid's Apprentice", "Cupid's Right Hand", "Love Algorithm", "Legend of the Feed"],
    "gallery": ["Snapshot Rookie", "Shutter Scout", "Angle Hunter", "Light Chaser", "Frame Whisperer",
                "Composition Nerd", "Golden Hour Regular", "Gallery Curator", "Editor's Eye", "Exhibition Judge",
                "Master Curator", "Museum Director", "Lens Legend", "Visionary", "Legend of the Gallery"],
}
LEVELS = list(zip(LEVEL_XP, LEVEL_NAMES["me"]))
QUICK_MS = 2500    # a call this fast earns bonus XP
STREAK_MS = 4000   # gut calls within this keep a streak alive
DAILY_GOAL = 30    # calls a day
XP = {"duel": 10, "great": 10, "meh": 10, "fduel": 8, "toss": 6, "skip": 2, "frame": 20, "sweep": 3}
LIGHTNING_XP = 3   # on top, for each of the first LIGHTNING_CAP calls in a lightning round
LIGHTNING_CAP = 30  # past this, a round earns ordinary XP: speed shouldn't beat judgement
FINAL_XP = 10      # on top, for each finals match
STAGE_XP = {"filter": 60, "drawn": 80, "group": 25, "stage": 150, "champion": 250, "crown": 100, "knockouts": 150}  # stage-clear bonuses
DRAW_XP = {"in": 2, "out": 2, "twin": 5, "start": 5, "seal": 20, "bulk": 2}  # the Draw (bulk: per photo, up to 12)
GROUP_XP = 3       # on top, for each group-stage match
JUDGED = ("duel", "great", "meh", "fduel")

ACHIEVEMENTS = [
    ("first", "🎬", "First impression", "Make your first call", lambda s: s["judged"] >= 1),
    ("warm", "🔥", "Warming up", "100 calls", lambda s: s["judged"] >= 100),
    ("zone", "🎯", "In the zone", "300 calls", lambda s: s["judged"] >= 300),
    ("marathon", "🏃", "Marathoner", "600 calls", lambda s: s["judged"] >= 600),
    ("unstoppable", "🚀", "Unstoppable", "1,200 calls", lambda s: s["judged"] >= 1200),
    ("gut", "⚡", "Gut instinct", "15 quick calls in a row", lambda s: s["best_streak"] >= 15),
    ("lightning", "🌩️", "On fire", "25 quick calls in a row", lambda s: s["best_streak"] >= 25),
    ("flow", "🌊", "Flow state", "50 quick calls in a row", lambda s: s["best_streak"] >= 50),
    ("crown1", "👑", "Royal decree", "Crown a stack's best take", lambda s: s["crowned"] >= 1),
    ("crown10", "🏰", "Kingmaker", "Crown 10 stacks", lambda s: s["crowned"] >= 10),
    ("crown25", "🎖️", "Dynasty", "Crown 25 stacks", lambda s: s["crowned"] >= 25),
    ("ruthless", "🗑️", "Ruthless editor", "Toss 25 photos", lambda s: s["toss"] >= 25),
    ("standards", "🧐", "High standards", "Call 'both meh' 20 times", lambda s: s["meh"] >= 20),
    ("spoiled", "😍", "Spoiled for choice", "Call 'both great' 20 times", lambda s: s["great"] >= 20),
    ("second", "↩️", "Second thoughts", "Undo a call", lambda s: s["undone"] >= 1),
    # (a library small enough to be "done" before any duel doesn't hand these out for free)
    ("shape", "📐", "Taking shape", "Leaderboard at 80% of its best", lambda s: s["judged"] >= 10 and s["quality"] >= 0.8),
    ("locked", "🔒", "Locked in", "Leaderboard at 90% of its best", lambda s: s["judged"] >= 10 and s["quality"] >= 0.9),
    ("stacker", "🧩", "Stack master", "Stack photos yourself (Twin check, or drop one photo on another)", lambda s: s["merged"] >= 1),
    ("ship", "📦", "Shipped", "Export your best photos", lambda s: s["exported"] >= 1),
    ("draw1", "🗂️", "Grouped", "Make your first themed group", lambda s: s["made"] >= 1),
    ("draw10", "🧭", "Cartographer", "Make 10 themed groups yourself", lambda s: s["made"] >= 10),
    ("twins", "👯", "Twin spotter", "Stack 5 twins while grouping", lambda s: s["twins"] >= 5),
    ("drawn", "🌍", "Full house", "Every shot in a themed group", lambda s: s["drawn_all"]),
    ("group1", "⚽", "Group decided", "Settle a group in the group stage", lambda s: s["groups_done"] >= 1),
    ("ko", "🎟️", "Knockout time", "Settle the whole group stage", lambda s: s["stage_done"]),
    ("swept", "🧹", "Clean sweep", "Make 20 keep-or-toss calls in sweeps", lambda s: s["sweep"] >= 20),
    ("filter_round", "🎛️", "Finding your standards", "Review 12 different shots in Filter", lambda s: s["filter_reviewed"] >= 12),
    ("filter_all", "👁️", "Every take considered", "Make a Filter call on every take", lambda s: s["filter_total"] > 0 and s["filter_considered"] >= s["filter_total"]),
    ("bolt", "⚡", "Bolt", "20 calls in one lightning round", lambda s: s["lightning_best"] >= 20),
    ("thunder", "🌪️", "Thunderstruck", "40 calls in one lightning round", lambda s: s["lightning_best"] >= 40),
    ("champion", "🏆", "Champion", "Crown a champion in the finals", lambda s: s["champions"] >= 1),
    ("cinderella", "👠", "Cinderella", "A seed 5–8 wins the Final", lambda s: s["cinderella"]),
    ("wire", "🥇", "Wire to wire", "The top seed wins the Final", lambda s: s["wire"]),
    ("flawless", "💎", "Flawless take", "Win every Crown round across at least three takes", lambda s: s["flawless"]),
    ("giant", "🗡️", "Giant-killer", "Win ten upsets", lambda s: s["upsets"] >= 10),
    ("comeback", "🧹", "Comeback kid", "Rescue a photo in the Sweep that makes the top eight", lambda s: s["comeback"]),
    ("shelf", "🥇", "Trophy shelf", "Crown champions in 3 cups", lambda s: s["champions"] >= 3),
    ("goal", "✅", "Daily goal", f"{DAILY_GOAL} calls in one day", lambda s: s["best_day"] >= DAILY_GOAL),
    ("days3", "📅", "On a roll", "Play 3 days in a row", lambda s: s["best_days"] >= 3),
    ("days7", "🗓️", "Habit formed", "Play 7 days in a row", lambda s: s["best_days"] >= 7),
]


def level_for(xp: int, mode: str = "me") -> tuple[int, str, int, int | None]:
    """(level number from 1, name, XP where it started, XP where the next one starts)."""
    idx = max(i for i, floor in enumerate(LEVEL_XP) if xp >= floor)
    nxt = LEVEL_XP[idx + 1] if idx + 1 < len(LEVEL_XP) else None
    return idx + 1, LEVEL_NAMES.get(mode, LEVEL_NAMES["me"])[idx], LEVEL_XP[idx], nxt


def _runs(days: set[date], today: date) -> tuple[int, int]:
    """(current run of consecutive days, still alive if it ended yesterday; longest run)."""
    best = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        best, prev = max(best, run), d
    alive = prev is not None and today - prev <= timedelta(days=1)
    return (run if alive else 0), best


class History:
    """Append-only game counters; undo rebuilds them once instead of every read replaying history."""
    def __init__(self):
        s = {k: 0 for k in ("judged", "toss", "meh", "great", "skip", "crowned", "undone", "sweep", "made", "twins", "upsets", "cinderella", "wire", "flawless", "overrules")}
        xp = streak = best = group_votes = 0
        per_day: Counter = Counter()
        per_round: Counter = Counter()
        champions: set = set()
        self.values = (s, xp, streak, best, group_votes, per_day, per_round, champions)
        self.duels = 0
        self.active_ms = 0
        self.first = None
        self.rescued = set()

    def extend(self, votes):
        s, xp, streak, best, group_votes, per_day, per_round, champions = self.values
        for v in votes:
            if v["undone"]:
                s["undone"] += 1
                continue
            kind, ms = v["kind"], v["ms"]
            extra = v.get("extra") or {}
            if isinstance(extra, str):
                extra = json.loads(extra)
            self.duels += kind in ("duel", "great", "meh", "skip")
            self.active_ms += min(ms, 15000) if ms is not None else 0
            if v.get("ts"):
                self.first = min(self.first or v["ts"], v["ts"])
            if kind == "sweep":
                if extra.get("change") == "keep":
                    self.rescued.add(v["a"])
                elif extra.get("change") == "toss":
                    self.rescued.discard(v["a"])
            s["upsets"] += extra.get("story") in ("upset", "giant-killer")
            s["flawless"] += bool(extra.get("flawless"))
            s["overrules"] += bool(extra.get("overruled"))
            if extra.get("final") and extra.get("round") == "final":
                s["cinderella"] += (extra.get("seed") or 0) >= 5
                s["wire"] += extra.get("seed") == 1
            xp += XP.get(kind, 0)
            if kind == "draw":
                call = extra.get("call")
                xp += DRAW_XP.get(call, 0) * (min(12, extra.get("n") or 1) if call == "bulk" else 1)
                s["made"] += call == "start"
                s["twins"] += call == "twin"
                if call in ("in", "out", "twin") and v.get("ts"):
                    per_day[datetime.fromtimestamp(v["ts"]).date()] += 1
                continue
            if kind in JUDGED:
                s["judged"] += 1
                quick = ms is not None and ms <= QUICK_MS
                xp += 5 if quick else 0
                streak = streak + 1 if ms is not None and ms <= STREAK_MS else 0
                best = max(best, streak)
                if v.get("ts"):
                    per_day[datetime.fromtimestamp(v["ts"]).date()] += 1
                if extra.get("lr"):
                    per_round[extra["lr"]] += 1
                    xp += LIGHTNING_XP if per_round[extra["lr"]] <= LIGHTNING_CAP else 0
                if extra.get("group"):
                    xp += GROUP_XP
                    group_votes += 1
                if extra.get("final"):
                    xp += FINAL_XP
                    if extra.get("round") == "final":
                        champions.add(extra["final"])
            if kind == "toss":
                s["toss"] += 1
            elif kind in ("meh", "great", "skip", "sweep"):
                s[kind] += 1
            elif kind == "frame":
                s["crowned"] += 1
        self.values = (s, xp, streak, best, group_votes, per_day, per_round, champions)


def stats(votes: list | History, quality: float = 0.0, merged: int = 0, exported: int = 0, today: date | None = None,
          mode: str = "me", earned: list[str] | tuple = (), drawn: dict | None = None) -> dict:
    """votes: dicts with kind, ms, undone (and ts, extra if known), in the order they were cast. `earned`:
    achievements unlocked before (they stay unlocked, even if an undo or a stricter rule would now say no).
    `drawn`: where the Draw and the group stage stand (all: every shot drawn; groups_done; stage_done)."""
    history = votes if isinstance(votes, History) else History()
    if not isinstance(votes, History):
        history.extend(votes)
    s, xp, streak, best, group_votes, per_day, per_round, champions = history.values
    s = s.copy()
    today = today or date.today()
    days, best_days = _runs(set(per_day), today)
    drawn = drawn or {}
    s.update(drawn_all=bool(drawn.get("all")), groups_done=int(drawn.get("groups_done") or 0),
             stage_done=bool(drawn.get("stage_done")), filter_reviewed=max(0, int(drawn.get("filter_reviewed") or 0)),
             filter_total=max(0, int(drawn.get("filter_total") or 0)), filter_considered=max(0, int(drawn.get("filter_considered") or 0)))
    # a stage cleared pays out: every shot in a group, each group decided, the group stage done, each champion
    xp += STAGE_XP["drawn"] * s["drawn_all"]
    xp += STAGE_XP["filter"] * bool(drawn.get("filter_done"))
    # Reward learning the player's standards equally for Keep and Set aside; repeats cannot farm points.
    xp += min(24, s["filter_reviewed"]) * 2
    if group_votes:  # (a group with nothing to play is decided without a match: no bonus for that)
        xp += STAGE_XP["group"] * min(s["groups_done"], group_votes) + STAGE_XP["stage"] * s["stage_done"]
    xp += STAGE_XP["champion"] * len(champions)
    xp += STAGE_XP["crown"] * bool(s["crowned"] and drawn.get("crown_done"))
    xp += STAGE_XP["knockouts"] * bool(s["judged"] and drawn.get("knockout_done"))
    s["comeback"] = bool(drawn.get("comeback"))
    s.update(quality=quality, merged=merged, exported=exported, best_streak=best, champions=len(champions),
             lightning_best=max(per_round.values(), default=0), best_day=max(per_day.values(), default=0),
             best_days=best_days)
    level, name, floor, nxt = level_for(xp, mode)
    return {"xp": xp, "level": level, "level_name": name, "level_floor": floor, "level_next": nxt,
            "streak": streak, "best_streak": best, "crowned": s["crowned"], "judged": s["judged"],
            "today": per_day.get(today, 0), "daily_goal": DAILY_GOAL, "days": days, "best_days": best_days,
            "lightning_best": s["lightning_best"], "champions": s["champions"], "sweep": s["sweep"],
            "made": s["made"], "overrules": s.get("overrules", 0),
            "filter_reviewed": s["filter_reviewed"],
            "filter_considered": s["filter_considered"], "filter_total": s["filter_total"],
            "stage_xp": {"filter": STAGE_XP["filter"] if drawn.get("filter_done") else 0,
                         "groups": STAGE_XP["stage"] if s["stage_done"] and group_votes else 0,
                         "draw": STAGE_XP["drawn"] if s["drawn_all"] else 0,
                         "crown": STAGE_XP["crown"] if s["crowned"] and drawn.get("crown_done") else 0,
                         "knockouts": STAGE_XP["knockouts"] if s["judged"] and drawn.get("knockout_done") else 0,
                         "finals": STAGE_XP["champion"] if champions else 0},
            "unlocked": [a[0] for a in ACHIEVEMENTS if a[4](s) or a[0] in earned]}


def catalog(unlocked: list[str]) -> list[dict]:
    got = set(unlocked)
    return [{"id": i, "icon": icon, "title": t, "desc": d, "unlocked": i in got, "stage": "Crown" if i.startswith("crown") or i == "flawless" else
             "Finals" if i in {"champion", "shelf", "cinderella", "wire"} else "Groups" if i in {"draw1", "draw10", "drawn", "group1", "ko", "twins"} else
             "Filter" if i in {"filter_round", "filter_all"} else "Sweep" if i in {"swept", "comeback"} else "Duels"} for i, icon, t, d, _ in ACHIEVEMENTS]
