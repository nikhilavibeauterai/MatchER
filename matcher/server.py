"""Local web app: pick a folder → automatic analysis → duels → shortlist → export."""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from flask import Flask, abort, jsonify, redirect, request, send_file, send_from_directory
from PIL import Image

from . import export as exporter
from . import game, library
from .draw import Draw
from .sample import SampleFetcher
from .analyze import Analyzer, TooManyPhotos, list_photos
from .config import DATA_DIR, DEFAULT_SETTINGS, PHOTO_EXTS
from .ranker import W_BAR, W_FRAME, W_TOSS, Obs, Ranker
from .store import Store, unblob

STATIC = Path(__file__).parent / "static"
DONE_QUALITY = 0.90      # ~450 duels in simulation; past this, more duels mostly reshuffle near-ties
MINI_MAX = 8             # a stack's mini-tournament uses at most this many of its frames
MIN_CUP = 12             # gallery mode: a category needs this many shots for a cup of its own
SWEEP_MAX = 30           # cards in one sweep
SWEEP_JUNK = 0.08        # a shot in the running is a sweep card if it's in this bottom share and visibly flawed
JUNK_FLAGS = {"blurry", "dark", "eyes_closed", "one_eye", "text", "not_prominent", "filter"}
CUPS = {"all": ("Grand Cup", "🏆"), "people": ("People's Cup", "🧑‍🤝‍🧑"), "nature": ("Landscape Cup", "🏔️"),
        "places": ("City Cup", "🏙️"), "animals": ("Critter Cup", "🐾"), "food": ("Foodie Cup", "🍜"),
        "things": ("Odds & Ends Cup", "🎲")}
ROUNDS = {"qf": "Quarterfinal", "sf": "Semifinal", "bronze": "Bronze match", "final": "The Final"}
SAVES_MAX = 30           # folders remembered on the save screen


def leaderboard_size(n: int, most: int) -> int:
    """A top N that actually picks: a quarter of the shots (a top 40 of 50 wouldn't), half of a tiny folder."""
    return min(most, max(1, n // 4)) if n >= 32 else max(1, min(8, n // 2))


def _slug(path: Path) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", path.name).strip("-") or "photos"
    return f"{name[:40]}-{hashlib.sha1(str(path).encode()).hexdigest()[:8]}"


class Session:
    """One photo library: its database, background analysis and tournament state."""

    def __init__(self, source: Path, data_dir: Path):
        self.source = source
        self.workdir = data_dir / _slug(source)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.store = Store(self.workdir / "matcher.db")
        if self.store.get_meta("source") is None:
            self.store.set_meta("source", str(source))
            self.store.set_meta("created", time.time())
        self.analyzer = Analyzer(self.store, source, self.workdir)
        self.analyzer.on_finished = self._invalidate
        self.lock = threading.RLock()
        self.ranker: Ranker | None = None
        self.version = None
        self.cards: OrderedDict[str, dict] = OrderedDict()
        self.followups: list[tuple[int, int]] = []  # duels waiting on a stack's mini-tournament (photo ids)
        self.minis: dict[int, dict] = {}             # stacks mid-tournament: frames, champion, next challenger
        self.priority: int | None = None             # a stack you asked to crown right now (Groups page)
        self.view: dict[int, dict] = {}
        self.distinct: dict[int, list[int]] = {}
        self._conf_cache: tuple[int, float] | None = None
        self._refresh_state = threading.Lock()
        self._refresh_running = False
        self._refresh_dirty = False
        self._refresh_full = False
        self.warming = False
        self.groups_cache: dict = {}
        self.draw = Draw(self)

    # ------------------------------------------------------------------ state
    @property
    def settings(self) -> dict:
        return {**DEFAULT_SETTINGS, **(self.store.get_meta("settings", {}) or {})}

    @property
    def mode(self) -> str:
        return "gallery" if self.settings.get("mode") == "gallery" else "me"

    @property
    def cup(self) -> str:
        """The cup being played: a photo category in gallery mode, or everything."""
        cup = self.store.get_meta("cup", "all") if self.mode == "gallery" else "all"
        return cup if cup in CUPS else "all"

    def analyzed(self) -> bool:
        return self.store.get_meta("analyzed_at") is not None and (self.workdir / "features.npz").exists()

    def _invalidate(self) -> None:
        with self.lock:
            self.version = None

    def refresh_async(self, full: bool = True) -> None:
        """Refresh in the background (full=False: only the stacking changed, so just regroup). Requests that
        arrive mid-refresh coalesce into one more pass, so the last refresh always sees the latest choices."""
        with self._refresh_state:
            self._refresh_dirty = True
            self._refresh_full = self._refresh_full or full
            if self._refresh_running:
                return
            self._refresh_running = True

        def work():
            while True:
                with self._refresh_state:
                    if not self._refresh_dirty:
                        self._refresh_running = False
                        return
                    self._refresh_dirty, full, self._refresh_full = False, self._refresh_full, False
                try:
                    (library.refresh if full else library.regroup)(self.store)
                finally:
                    self._invalidate()

        threading.Thread(target=work, daemon=True).start()

    def ensure_ranker(self, wait: bool = False) -> Ranker | None:
        """The current ranker. If a newer state is on disk but a background refresh holds the files, keep
        playing on this one instead of waiting (it swaps in on a later request); wait=True for your own edits."""
        with self.lock:
            if (self.ranker is not None and self.store.get_meta("state_version") == self.version
                    and self.store.get_meta("derived_version") == library.DERIVED_VERSION):
                return self.ranker
            if not self.store.refresh_lock.acquire(blocking=wait or self.ranker is None):
                return self.ranker
            try:
                return self._load_ranker()
            finally:
                self.store.refresh_lock.release()

    def _load_ranker(self) -> Ranker | None:
        if self.analyzed() and self.store.get_meta("derived_version") != library.DERIVED_VERSION:
            library.refresh(self.store)  # a library from an older version: crop boxes etc. are new
        ver = self.store.get_meta("state_version")
        if self.ranker is not None and ver == self.version:
            return self.ranker
        if not self.analyzed():
            return None
        old, old_gids = self.ranker, getattr(self, "gids", [])
        z = np.load(self.workdir / "features.npz", allow_pickle=False)
        self.gids = z["gids"].tolist()
        self.reps = z["reps"].tolist()
        self.gidx = {g: i for i, g in enumerate(self.gids)}
        active = z["active"] if "active" in z.files else np.ones(len(self.gids), bool)
        self.cats = [str(c) for c in z["cats"]] if "cats" in z.files else [""] * len(self.gids)
        self.n_hand = int(z["n_hand"]) if "n_hand" in z.files else len(library.HAND)
        self.base_active = active.copy()
        cup = self.cup
        if cup != "all":  # a cup plays its own category; the votes and the taste model are shared
            in_cup = active & (np.array(self.cats) == cup)
            if in_cup.any():
                active = in_cup
            else:
                self.store.set_meta("cup", "all")
                cup = "all"
        s = self.settings
        k = leaderboard_size(int(active.sum()), s["finalists"])
        self.ranker = Ranker(z["X"], z["w0"], z["sd"], z["scenes"], k=k, cap=s["per_scene"], active=active)
        self._conf_cache = None
        if old is not None and old._warm_w.shape == self.ranker._warm_w.shape:
            # Start the fit where the last one ended (shots matched by id): a merge or a toss moves it a little.
            self.ranker._warm_w, self.ranker._warm_t = old._warm_w, old._warm_t
            self.ranker._warm = {self.gidx[old_gids[i]]: b for i, b in old._warm.items()
                                 if i < len(old_gids) and old_gids[i] in self.gidx}
        self.names = [str(n) for n in z["names"]]
        self.photo_group = {r["id"]: r["group_id"] for r in self.store.q("SELECT id, group_id FROM photos")}
        self.groups = {r["id"]: {"rep": r["rep"], "members": json.loads(r["members"]), "scene": r["scene"],
                                 "checked": bool(r["frame_checked"])}
                       for r in self.store.q("SELECT * FROM groups")}
        tossed = {r["id"] for r in self.store.q("SELECT id FROM photos WHERE override='toss'")}
        if tossed:  # tossed since this snapshot was written: still out
            for i, gid in enumerate(self.gids):
                if self.base_active[i] and (self.reps[i] in tossed or tossed & set((self.groups.get(gid) or {}).get("members", ()))):
                    self.ranker.active[i] = self.base_active[i] = False
            self.ranker.n_active = int(self.ranker.active.sum())
        self.fx = dict(zip(z["fx_ids"].tolist(), z["fx"].astype(np.float64))) if "fx_ids" in z.files else {}
        rows = {r["id"]: r for r in self.store.q(
            "SELECT id, width, height, subject, phash, sha256 FROM photos WHERE group_id IS NOT NULL")}
        self.view = {pid: {"dims": list(library.preview_size(r["width"] or 1, r["height"] or 1)),
                           "box": json.loads(r["subject"]) if r["subject"] else None} for pid, r in rows.items()}
        self.distinct = {}
        for gid, g in self.groups.items():  # frames you could actually tell apart (not byte/pixel twins)
            kept: list[tuple[int, str, int | None]] = []
            for m in g["members"]:
                r = rows.get(m)
                if r is None:
                    continue
                h = int(r["phash"], 16) if r["phash"] else None
                if not any(r["sha256"] == sha or (h is not None and kh is not None and (h ^ kh).bit_count() <= 2)
                           for _, sha, kh in kept):
                    kept.append((m, r["sha256"], h))
            self.distinct[gid] = [m for m, _, _ in kept]
        for row in self.store.q("SELECT id, group_id FROM photos WHERE rep_pref=1 AND group_id IS NOT NULL"):
            self._set_rep(row["group_id"], row["id"])
        self.version = ver
        self._fit()
        return self.ranker

    def _set_rep(self, gid: int, pid: int) -> None:
        """Make `pid` the frame that represents shot `gid` from now on."""
        g = self.groups.get(gid)
        if g is None or pid not in g["members"]:
            return
        g["rep"], g["checked"] = pid, True
        i = self.gidx.get(gid)
        if i is not None:
            self.reps[i] = pid

    def _item(self, photo_id: int | None) -> int | None:
        if photo_id is None:
            return None
        return self.gidx.get(self.photo_group.get(photo_id))

    def _observations(self):
        obs, compared, recent = [], set(), []
        for v in self.store.votes():
            a, b = self._item(v["a"]), self._item(v["b"])
            k = v["kind"]
            if k == "duel" and a is not None and b is not None and a != b:
                w = self._item(v["winner"])
                if w in (a, b):
                    obs.append(Obs("duel", w, b if w == a else a))
            elif k in ("great", "meh"):
                for it in (a, b):
                    if it is not None:
                        obs.append(Obs("above" if k == "great" else "below", it, w=W_BAR))
            elif (k == "toss" or (k == "sweep" and '"change": "toss"' in (v["extra"] or ""))) and a is not None:
                obs.append(Obs("below", a, w=W_TOSS))
            elif k == "fduel" and v["winner"] is not None and '"skip": true' not in (v["extra"] or ""):
                lose = v["b"] if v["winner"] == v["a"] else v["a"]
                fw, fl = self.fx.get(v["winner"]), self.fx.get(lose)
                if fw is not None and fl is not None:
                    obs.append(Obs("pair", -1, w=W_FRAME, vec=fw - fl))
            if a is not None and b is not None and k in ("duel", "great", "meh", "skip"):
                compared.add((min(a, b), max(a, b)))
            if k in ("duel", "great", "meh", "skip"):
                recent += [x for x in (a, b) if x is not None]
        return obs, compared, recent[-40:]

    def _fit(self):
        obs, self.compared, self.recent = self._observations()
        self.n_votes = len(self.store.votes())
        self.ranker.fit(obs)

    def _explore(self) -> float:
        """Share of duels that bring in a photo you haven't seen: half for a library of ~1,000 shots, less
        as it grows (simulated at 3,000 shots: 20% beat 50%)."""
        return float(np.clip(0.5 * np.sqrt(1000 / max(1, self.ranker.n_active)), 0.2, 0.5))

    # ------------------------------------------------------------------ cards
    def _card(self, kind: str, **data) -> dict:
        cid = secrets.token_urlsafe(8)
        card = {"id": cid, "type": kind, **data}
        self.cards[cid] = card
        while len(self.cards) > 64:
            self.cards.popitem(last=False)
        return card

    def next_cards(self, n: int = 1, pending: list[str] = (), stage: str | None = None) -> list[dict]:
        """Next cards for the screen. A stack (burst) that hasn't had its best frame chosen asks
        "which one to keep?" before its first duel; the duel itself waits until that's answered.
        stage="stacks": only stacks' mini-tournaments, the ones likeliest to matter first. stage="groups": matches
        inside the Draw's groups, one group at a time. stage="knockouts": duels between the shots that went through
        (plus strong runners-up, and shots in no group)."""
        r = self.ensure_ranker()
        if r is None:
            return []
        busy = []  # shots on cards already headed to the screen: never put them on another card
        for cid in pending:
            c = self.cards.get(cid)
            if c and c["type"] == "duel":
                busy += [c["ia"], c["ib"]]
            elif c and c["type"] in ("frame", "mini") and self.gidx.get(c["gid"]) is not None:
                busy.append(self.gidx[c["gid"]])
        out = []
        if stage == "stacks":
            for i in self.stacks_left():
                if len(out) >= n:
                    break
                if i not in busy and (card := self._mini(i)) is not None:
                    busy.append(i)
                    out.append(self._public(card))
            return out
        if stage == "groups":
            for _ in range(n):
                card = self._followup(busy)
                if card is None:
                    got = self.draw.group_pair(set(busy))
                    if got is None:
                        break
                    card = self._pair_card(got[0], got[1])
                if card["type"] == "duel":
                    card["group"] = self.draw.group_of(card["ia"], card["ib"])
                busy += [card["ia"], card["ib"]] if card["type"] == "duel" else [card["item"]]
                out.append(self._public(card))
            return out
        outside = self.draw.outside_knockouts() if stage == "knockouts" else set()
        for _ in range(n):
            card = None
            if self.priority is not None:
                gid, self.priority = self.priority, None
                if self.gidx.get(gid) is not None and self.gidx[gid] not in busy:
                    card = self._mini(self.gidx[gid], restart=True)
            if card is None:
                card = self._followup(busy)
            if card is None:
                pair = r.next_pair(self.recent, self.compared, explore=self._explore(), exclude=set(busy) | outside)
                if pair is None:
                    break
                card = self._pair_card(*pair)
            busy += [card["ia"], card["ib"]] if card["type"] == "duel" else [card["item"]]
            out.append(self._public(card))
        return out

    def _pair_card(self, ia: int, ib: int) -> dict:
        """A duel between two shots, unless one of them still needs its best frame: then that question comes first
        and the duel waits as a follow-up."""
        unpicked = [i for i in (ia, ib) if self._needs_frame(i)]
        card = self._mini(unpicked[0], pair=(ia, ib)) if unpicked else None
        if card is not None:
            self.followups = (self.followups + [(self.reps[ia], self.reps[ib])])[-6:]
            return card
        return self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib])

    def stacks_left(self) -> list[int]:
        """Stacks in this cup still waiting for their best frame (round one of the journey), likeliest to make the
        top first."""
        r = self.ranker
        if r is None or r.post is None:
            return []
        left = [int(i) for i in np.flatnonzero(r.active) if self._needs_frame(int(i))]
        return sorted(left, key=lambda i: -r.post.p_in[i])

    def twins_left(self) -> int:
        """Pairs of shots that look like the same shot but aren't stacked, still to check (the Stacks stage)."""
        key = (self.store.get_meta("state_version"), len(self.store.get_meta("stack_dismissed", []) or []))
        if getattr(self, "_twins", (None,))[0] != key:
            self._twins = (key, len(library.suggest_merges(self.store)))
        return self._twins[1]

    def crown_rest(self) -> int:
        """Keep the frame each remaining stack shows now (the sharpest, best-lit guess) as its pick. Undoable."""
        with self.lock:
            stacks = [self.groups[self.gids[i]] for i in self.stacks_left()]
            if not stacks:
                return 0
            members = [m for g in stacks for m in g["members"]]
            self.draw.remember("best guesses", self.draw.snapshot(members))
            with self.store.tx() as c:
                c.executemany("UPDATE photos SET rep_pref=1 WHERE id=?", [(g["rep"],) for g in stacks])
            library.regroup(self.store)
            self.version = None
            self.ensure_ranker(wait=True)
            return len(stacks)

    def forget_unshown_frames(self, keep: list[str] = ()) -> None:
        """The browser threw its queue away (reload, undo): frame questions in it will be asked again."""
        for cid in [k for k, c in self.cards.items() if c["type"] in ("frame", "mini") and k not in keep]:
            del self.cards[cid]  # a stack mid-tournament resumes at the same round next time it comes up

    def _followup(self, busy: list[int]) -> dict | None:
        """A duel that was held back for a frame question, once nothing about it is still on its way."""
        r = self.ranker
        for k, (pa, pb) in enumerate(self.followups):
            ia, ib = self._item(pa), self._item(pb)
            if ia is None or ib is None or ia == ib or not (r.active[ia] and r.active[ib]):
                self.followups.pop(k)
                return self._followup(busy)
            if ia in busy or ib in busy:
                continue
            unpicked = [i for i in (ia, ib) if self._needs_frame(i)]
            if unpicked:
                card = self._mini(unpicked[0], pair=(ia, ib))
                if card is not None:
                    return card
            self.followups.pop(k)
            return self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib])
        return None

    def _needs_frame(self, i: int) -> bool:
        g = self.groups.get(self.gids[i])
        if not g or g["checked"] or len(self.distinct.get(self.gids[i], ())) < 2:
            return False
        return not any(c["type"] in ("frame", "mini") and c["gid"] == self.gids[i] for c in self.cards.values())

    # ------------------------------------------------------------------ mini-tournaments
    def _mini(self, i: int, pair: tuple[int, int] | None = None, restart: bool = False) -> dict | None:
        """King of the hill among a stack's frames: the current pick defends against each challenger."""
        gid = self.gids[i]
        g = self.groups.get(gid)
        if not g:
            return None
        if restart or gid not in self.minis:
            frames = sorted(self.distinct.get(gid, []), key=lambda m: m != g["rep"])[:MINI_MAX]
            if len(frames) < 2:
                return None
            prev = self.store.one(f"SELECT id FROM photos WHERE rep_pref=1 AND id IN ({','.join('?' * len(g['members']))})",
                                  g["members"])
            self.minis[gid] = {"frames": frames, "next": 1, "champ": frames[0], "beaten": [],
                               "prev": prev["id"] if prev else None, "held": None}
        if pair and not self.minis[gid]["held"]:
            self.minis[gid]["held"] = [self.reps[pair[0]], self.reps[pair[1]]]
        return self._mini_card(gid)

    def _mini_card(self, gid: int) -> dict:
        m = self.minis[gid]
        champ, challenger = m["champ"], m["frames"][m["next"]]
        a, b = (champ, challenger) if self.ranker.rng.random() < 0.5 else (challenger, champ)
        return self._card("mini", gid=gid, item=self.gidx[gid], a=a, b=b, champ=champ, round=m["next"],
                          total=len(m["frames"]) - 1, frames=list(m["frames"]), beaten=list(m["beaten"]))

    def _mini_vote(self, card: dict, outcome: str, ms: int | None, pending: list[str], stage: str | None = None,
                   lr: str | None = None) -> dict:
        gid = card["gid"]
        m = self.minis.get(gid)
        if m is None or m["champ"] != card["champ"] or m["frames"][m["next"]] not in (card["a"], card["b"]):
            abort(409, "That round is out of date; reloading.")
        champ, challenger = m["champ"], m["frames"][m["next"]]
        winner = card["a"] if outcome == "a" else card["b"] if outcome == "b" else champ  # can't tell: title holds
        self.store.add_vote("fduel", card["a"], card["b"], winner, ms,
                            extra={"gid": gid, "frames": m["frames"], "step": m["next"], "champ": champ,
                                   "beaten": m["beaten"], "held": m["held"], "prev": m["prev"], **({"lr": lr} if lr else {}),
                                   **({"skip": True} if outcome not in ("a", "b") else {})})
        m["beaten"] = m["beaten"] + [challenger if winner == champ else champ]
        m["champ"], m["next"] = winner, m["next"] + 1
        result = {"mini": {"winner": winner, "defended": winner == champ}}
        if m["next"] < len(m["frames"]):
            return {**result, "cards": [self._public(self._mini_card(gid))], "progress": self.progress()}
        # Last challenger done: crown the champion, then play the duel this stack was holding up.
        del self.minis[gid]
        g = self.groups.get(gid)
        stack = g["members"] if g else m["frames"]
        before = g["rep"] if g else m["frames"][0]
        with self.store.tx() as c:
            c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
            c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (winner,))
        self.store.add_vote("frame", before, None, winner, None,
                            extra={"frames": m["frames"], "stack": stack, "prev": m["prev"], "held": m["held"], "mini": True})
        self._set_rep(gid, winner)
        swap = None
        if winner != before:
            swap = {"from": before, "to": winner, "photo": self.photo_view(winner)}
            for other in self.cards.values():
                if other["type"] == "duel":
                    other["a"] = winner if other["a"] == before else other["a"]
                    other["b"] = winner if other["b"] == before else other["b"]
            self.refresh_async(full=False)
        return {**result, "cards": self.next_cards(1, pending, stage), "progress": self.progress(), "swap": swap,
                "crowned": {"photo": winner, "frames": m["frames"]}}

    def _mini_restore(self, extra: dict) -> dict | None:
        """Put a stack's tournament back to the round recorded in a mini vote (for undo)."""
        gid = self.photo_group.get(extra["frames"][0], extra["gid"])
        if gid not in self.groups or gid not in self.gidx:
            return None
        self.minis[gid] = {"frames": extra["frames"], "next": extra["step"], "champ": extra["champ"],
                           "beaten": extra.get("beaten") or [], "prev": extra.get("prev"), "held": extra.get("held")}
        held = extra.get("held")
        if held:
            pair = (held[0], held[1])
            self.followups = [pair] + [f for f in self.followups if f != pair]
        return self._mini_card(gid)

    def crown_now(self, pid: int) -> bool:
        gid = self.photo_group.get(pid)
        if gid not in self.groups or len(self.distinct.get(gid, ())) < 2:
            return False
        self.priority = gid
        return True

    def _frame_card(self, i: int, pair: tuple[int, int] | None = None, frames: list[int] | None = None) -> dict:
        gid = self.gids[i]
        g = self.groups[gid]
        if frames is None:
            frames = sorted(self.distinct[gid], key=lambda m: m != g["rep"])[:6]  # current first, then by quality
        held = [self.reps[pair[0]], self.reps[pair[1]]] if pair else None    # the duel waiting on this answer
        return self._card("frame", gid=gid, item=int(i), members=frames, current=g["rep"], held=held)

    def photo_view(self, pid: int) -> dict:
        """What the browser needs to frame a photo: preview size, auto-crop box, frames in its stack."""
        v = self.view.get(pid)
        if v is None:
            row = self.store.one("SELECT width, height, subject FROM photos WHERE id=?", (pid,))
            if row is None:
                return {"dims": [1, 1], "box": None, "frames": 1}
            v = {"dims": list(library.preview_size(row["width"] or 1, row["height"] or 1)),
                 "box": json.loads(row["subject"]) if row["subject"] else None}
        g = self.groups.get(self.photo_group.get(pid))
        return {**v, "frames": len(self.distinct.get(self.photo_group.get(pid), ())) if g else 1}

    def _public(self, card: dict) -> dict:
        if card["type"] == "mini":
            return {"id": card["id"], "type": "mini", "a": card["a"], "b": card["b"], "champ": card["champ"],
                    "round": card["round"], "total": card["total"], "frames": card["frames"], "beaten": card["beaten"],
                    "photos": {m: self.photo_view(m) for m in card["frames"]}}
        if card["type"] in ("duel", "final"):
            out = {"id": card["id"], "type": card["type"], "a": card["a"], "b": card["b"],
                   "photos": {card["a"]: self.photo_view(card["a"]), card["b"]: self.photo_view(card["b"])}}
            if card["type"] == "final":
                out.update(round=card["round"], label=ROUNDS[card["round"]], match=card["match"], cup=card["cup"])
            if card.get("group") is not None and (tab := self.draw.table(card["group"])):
                out["group"] = {k: tab[k] for k in ("id", "letter", "name", "emoji", "adv", "played", "budget")}
            else:  # the knockouts and the finals: each photo wears its group's colours
                out["teams"] = {p: t for p in (card["a"], card["b"]) if (t := self.draw.team_of(p))}
            return out
        return {"id": card["id"], "type": "frame", "members": card["members"], "current": card["current"],
                "photos": {m: self.photo_view(m) for m in card["members"]}}

    def vote(self, cid: str, outcome: str, ms: int | None, choice: int | None, pending: list[str],
             lr: str | None = None, stage: str | None = None) -> dict:
        with self.lock:
            card = self.cards.pop(cid, None)
            if card is None:
                abort(409, "That card expired; reloading.")
            if card["type"] == "mini":
                return self._mini_vote(card, outcome, ms, pending, stage, lr)
            if card["type"] == "final":
                return self._final_vote(card, outcome, ms)
            if card["type"] == "frame":
                gid = card["gid"]
                pick = choice if choice in card["members"] else card["current"]
                stack = (self.groups.get(gid) or {}).get("members") or card["members"]
                with self.store.tx() as c:
                    prev = c.execute(f"SELECT id FROM photos WHERE rep_pref=1 AND id IN ({','.join('?' * len(stack))})",
                                     stack).fetchone()
                    c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
                    c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (pick,))
                self.store.add_vote("frame", card["current"], None, pick, ms,
                                    extra={"frames": card["members"], "stack": stack,
                                           "prev": prev["id"] if prev else None, "held": card.get("held")})
                self._set_rep(gid, pick)
                swap = None
                if pick != card["current"]:
                    swap = {"from": card["current"], "to": pick, "photo": self.photo_view(pick)}
                    for other in self.cards.values():  # any queued pair showing the old frame shows the new one
                        if other["type"] == "duel":
                            other["a"] = pick if other["a"] == card["current"] else other["a"]
                            other["b"] = pick if other["b"] == card["current"] else other["b"]
                    self.refresh_async(full=False)  # features of the new frame; regrouping
                return {"cards": self.next_cards(1, pending, stage), "progress": self.progress(), "swap": swap}
            else:
                a, b = card["a"], card["b"]
                group = card.get("group")
                settled_before = group is not None and self.draw.stage()["groups"].get(group, {}).get("settled")
                extra = {k: v for k, v in (("lr", lr), ("group", group)) if v is not None} or None
                items = [self._item(a), self._item(b)]
                was = self._ranks(items)
                rematch = None not in items and (min(items), max(items)) in self.compared
                if outcome == "a":
                    self.store.add_vote("duel", a, b, a, ms, extra=extra)
                elif outcome == "b":
                    self.store.add_vote("duel", a, b, b, ms, extra=extra)
                elif outcome in ("great", "meh", "skip"):
                    self.store.add_vote(outcome, a, b, None, ms, extra=extra)
                elif outcome in ("toss_a", "toss_b"):
                    self._toss(a if outcome == "toss_a" else b, b if outcome == "toss_a" else a, ms, card=[a, b])
                else:
                    abort(400, "Unknown outcome.")
                if outcome not in ("toss_a", "toss_b"):
                    self._fit()
                self.ensure_ranker()
                now = self._ranks([self._item(a), self._item(b)])
                ranks = [{"photo": self.reps[i], "rank": rk, "was": was.get(i, rk)} for i, rk in now.items()]
                story = None
                if outcome in ("a", "b") and None not in items:
                    wi, li = (items[0], items[1]) if outcome == "a" else (items[1], items[0])
                    if wi in was and li in was and was[wi] - was[li] >= 5:
                        story = "upset"
                    elif rematch:
                        story = "rematch"
                res = {"cards": self.next_cards(1, pending, stage), "progress": self.progress(), "ranks": ranks, "story": story}
                if group is not None and (tab := self.draw.table(group)):
                    res["group"] = {**tab, "just_settled": bool(tab["settled"] and not settled_before)}
                return res
            return {"cards": self.next_cards(1, pending, stage), "progress": self.progress()}

    def _ranks(self, items: list[int | None]) -> dict[int, int]:
        """Leaderboard position (1 = top) of these items in this cup."""
        r = self.ranker
        if r is None or r.post is None:
            return {}
        mu = r.post.mu
        return {int(i): int(1 + np.sum(r.active & (mu > mu[i]))) for i in items if i is not None and r.active[i]}

    def _toss(self, pid: int, other: int | None, ms: int | None, card: list[int] | None = None) -> tuple[int, list[int]]:
        """Out of the running now; the regrouping that makes it a teaching example runs in the background.
        Returns the vote and the photos it set aside (every take of the stack)."""
        g = self.photo_group.get(pid)
        members = self.groups.get(g, {}).get("members", [pid])
        with self.store.tx() as c:
            c.execute(f"UPDATE photos SET override='toss' WHERE id IN ({','.join('?' * len(members))})", members)
        vote = self.store.add_vote("toss", pid, other, None, ms, extra={"members": members, "card": card})
        i = self._item(pid)
        if i is not None:
            self.ranker.active[i] = self.base_active[i] = False
            self.ranker.n_active = int(self.ranker.active.sum())
        self._fit()
        self.refresh_async()
        return vote, list(members)

    def undo(self, stage: str | None = None) -> dict:
        """Take back the last decision exactly (model, tosses, frame choices) and show it to you again."""
        with self.lock:
            v = self.store.one("SELECT * FROM votes WHERE undone=0 AND kind != 'draw' ORDER BY id DESC LIMIT 1")
            if v is None:
                self.forget_unshown_frames()
                return {"cards": self.next_cards(2, stage=stage), "progress": self.progress(), "undone": None}
            extra = json.loads(v["extra"]) if v["extra"] else {}
            if v["kind"] == "fduel" or (v["kind"] == "frame" and extra.get("mini")):
                return self._undo_mini(v, extra, stage)
            if v["kind"] == "duel" and extra.get("final"):
                with self.store.tx() as c:
                    c.execute("UPDATE votes SET undone=1 WHERE id=?", (v["id"],))
                now = self.finals_state(extra["final"]) or {}
                if now.get("id") == extra.get("bracket"):  # a bracket you've since replayed stays replayed
                    self.store.set_meta(f"finals:{extra['final']}", extra["before"])
                    self.store.set_meta("champions", extra.get("champs_before") or {})
                self._fit()
                return {**self.finals_view(extra["final"]), "cards": [], "progress": self.progress(), "undone": "final"}
            if v["kind"] == "sweep":
                with self.store.tx() as c:
                    c.execute("UPDATE votes SET undone=1 WHERE id=?", (v["id"],))
                    c.executemany("UPDATE photos SET override=? WHERE id=?",
                                  [(o, int(m)) for m, o in (extra.get("prev") or {}).items()])
                if extra.get("change"):
                    library.refresh(self.store)
                    self.version = None
                self.ensure_ranker()
                self._fit()
                return {"cards": self.next_cards(2, stage=stage), "progress": self.progress(), "undone": "sweep", "photo": v["a"]}
            with self.store.tx() as c:
                c.execute("UPDATE votes SET undone=1 WHERE id=?", (v["id"],))
                if v["kind"] == "toss":
                    members = extra.get("members") or [v["a"]]
                    c.execute(f"UPDATE photos SET override=NULL WHERE override='toss' AND id IN "
                              f"({','.join('?' * len(members))})", members)
                elif v["kind"] == "frame":
                    stack = extra.get("stack") or [v["winner"]]
                    c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
                    if extra.get("prev"):
                        c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (extra["prev"],))
            if v["kind"] in ("toss", "frame"):
                (library.refresh if v["kind"] == "toss" else library.regroup)(self.store)
                self.version = None
            r = self.ensure_ranker()
            self._fit()
            self.forget_unshown_frames()
            cards = []
            if r is not None and v["kind"] in ("duel", "great", "meh", "skip", "toss"):
                left, right = (extra.get("card") or [v["a"], v["b"]]) if v["kind"] == "toss" else (v["a"], v["b"])
                ia, ib = self._item(left), self._item(right)
                if ia is not None and ib is not None and ia != ib and r.active[ia] and r.active[ib]:
                    group = self.draw.group_of(ia, ib) if stage == "groups" else None
                    cards.append(self._public(self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib], group=group)))
            elif r is not None and v["kind"] == "frame":
                i = self._item(v["winner"])
                if i is not None and self.gids[i] in self.groups:
                    frames = [m for m in (extra.get("frames") or []) if m in self.groups[self.gids[i]]["members"]]
                    held = extra.get("held")
                    pair = (self._item(held[0]), self._item(held[1])) if held else None
                    if pair and None not in pair and pair[0] != pair[1]:
                        self.followups = [(held[0], held[1])] + [f for f in self.followups if f != (held[0], held[1])]
                    cards.append(self._public(self._frame_card(i, pair=pair if pair and None not in pair else None,
                                                               frames=frames or None)))
            cards += self.next_cards(2 - len(cards), [c["id"] for c in cards], stage)
            return {"cards": cards, "progress": self.progress(), "undone": v["kind"]}

    def _undo_mini(self, v, extra: dict, stage: str | None = None) -> dict:
        """Undo one mini-tournament round. Undoing a crowning also takes back the round that decided it."""
        rnd = v
        with self.store.tx() as c:
            c.execute("UPDATE votes SET undone=1 WHERE id=?", (v["id"],))
            if v["kind"] == "frame":
                stack = extra.get("stack") or [v["winner"]]
                c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
                if extra.get("prev"):
                    c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (extra["prev"],))
                rnd = c.execute("SELECT * FROM votes WHERE undone=0 AND kind='fduel' AND id < ? ORDER BY id DESC LIMIT 1",
                                (v["id"],)).fetchone()
                if rnd is not None:
                    c.execute("UPDATE votes SET undone=1 WHERE id=?", (rnd["id"],))
        if v["kind"] == "frame":
            library.regroup(self.store)
            self.version = None
        self.ensure_ranker()
        self._fit()
        self.forget_unshown_frames()
        cards = []
        if rnd is not None:
            card = self._mini_restore(json.loads(rnd["extra"]))
            if card is not None:
                cards.append(self._public(card))
        cards += self.next_cards(2 - len(cards), [c["id"] for c in cards], stage)
        return {"cards": cards, "progress": self.progress(), "undone": "mini"}

    # ------------------------------------------------------------------ views
    def progress(self) -> dict:
        r = self.ranker
        if r is None or r.post is None:
            return {}
        if self._conf_cache is None or self._conf_cache[0] != self.n_votes:
            self._conf_cache = (self.n_votes, r.quality())
        _, quality = self._conf_cache
        first = self.store.one("SELECT MIN(ts) AS t FROM votes WHERE undone=0")
        active_ms = self.store.one("SELECT SUM(MIN(ms, 15000)) AS s FROM votes WHERE undone=0 AND ms IS NOT NULL")
        merged = self.store.one("SELECT COUNT(DISTINCT stack_key) AS n FROM photos WHERE stack_key LIKE 'm:%'")["n"]
        exported = int(any((self.workdir / "exports").glob("*-2*")))
        earned = self.store.get_meta("achievements", []) or []
        dj = self.draw.journey()
        drawn = {"all": dj["draw"]["done"], "groups_done": dj["groups"]["settled"], "stage_done": dj["groups"]["done"]}
        play = game.stats([dict(v) for v in self.store.q("SELECT kind, ms, undone, ts, extra FROM votes ORDER BY id")],
                          quality, merged, exported, mode=self.mode, earned=earned, drawn=drawn)
        if set(play["unlocked"]) - set(earned):  # once earned, always earned
            self.store.set_meta("achievements", sorted(set(play["unlocked"]) | set(earned)))
        duels = self.store.one("SELECT COUNT(*) AS n FROM votes WHERE undone=0 AND kind IN ('duel', 'great', 'meh', 'skip')")["n"]
        return {"votes": duels, "quality": round(quality, 3), "game": play,
                "done": bool(r.done() or quality >= DONE_QUALITY),
                "shots": int(r.n_active), "k": r.k, "seen": int(((r.post.n_obs > 0) & r.active).sum()),
                "minutes": round((active_ms["s"] or 0) / 60000, 1), "started": first["t"] if first else None}

    def shortlist(self) -> dict:
        r = self.ensure_ranker()
        if r is None:
            return {"items": [], "bubble": [], "added": []}
        mu, p = r.post.mu, r.post.p_in
        top = r.select(mu)
        settled = [i for i in (self._item(pid) for pid in self.finals_order()) if i is not None and r.active[i]]
        if settled:  # the finals have the last word on the top of the board
            top = (settled + [i for i in top if i not in settled])[:max(r.k, len(settled))]
        chosen = set(top)
        bubble = [int(i) for i in np.argsort(-mu) if r.active[i] and i not in chosen][:24]
        info = {row["id"]: row for row in self.store.q(
            "SELECT id, rel, taken, flags, prior, pick FROM photos WHERE id IN (%s)" % ",".join("?" * len(self.reps)),
            self.reps)} if self.reps else {}

        def item(i, rank=None):
            pid = self.reps[i]
            row = info.get(pid)
            g = self.groups.get(self.gids[i], {})
            return {"photo": pid, "rank": rank, "p_in": round(float(p[i]), 3), "appeal": round(float(mu[i]), 3),
                    "duels": int(r.post.n_obs[i]), "frames": len(g.get("members", [pid])), "scene": int(r.scenes[i]),
                    "flags": json.loads(row["flags"]) if row and row["flags"] else [], "rel": row["rel"] if row else "",
                    "taken": row["taken"] if row else None, "added": bool(row and row["pick"]),
                    "box": self.view.get(pid, {}).get("box")}

        added = [item(self.gidx[self.photo_group[r_["id"]]]) for r_ in self.store.q("SELECT id FROM photos WHERE pick=1")
                 if self.photo_group.get(r_["id"]) in self.gidx and self.gidx[self.photo_group[r_["id"]]] not in chosen]
        hand = self.n_hand
        spread = r.X[r.active, :hand].std(0) if r.n_active else np.zeros(hand)
        taste = [{"feature": name, "effect": round(float(w * sd), 3), "prior": round(float(w0 * sd), 3)}
                 for name, w, w0, sd in zip(self.names[:hand], r.post.w[:hand], r.w0[:hand], spread) if sd > 1e-6]
        if self.mode == "gallery" and r.n_active:
            people = float(np.mean(np.array(self.cats)[r.active] == "people"))
            if people < 0.2:  # face cues aren't much of a story in a cup that's mostly landscapes
                taste = [t for t in taste if t["feature"] not in ("smile", "eyes_closed", "people")]
        return {"items": [item(i, n + 1) for n, i in enumerate(top)], "bubble": [item(i) for i in bubble], "settled": len(settled),
                "added": added, "progress": self.progress(), "taste": taste}

    def export(self, kind: str = "review") -> dict:
        sl = self.shortlist()
        if kind == "bestof":
            rows = [{"rel": it["rel"], "rank": it["rank"]} for it in sl["items"]]
            rows += [{"rel": it["rel"], "rank": None} for it in sl["added"]]
            name = "best-" + (self.cup if self.mode == "gallery" else "profile")
            return exporter.bestof(self.source, self.workdir / "exports", rows, name)
        rows = []
        for it in sl["items"]:
            rows.append({"photo_id": it["photo"], "rel": it["rel"], "rank": it["rank"], "kind": "ranked",
                         "p_in": it["p_in"], "appeal": it["appeal"], "duels": it["duels"], "flags": it["flags"],
                         "taken": it["taken"]})
        for it in sl["added"]:
            rows.append({"photo_id": it["photo"], "rel": it["rel"], "rank": "", "kind": "added", "p_in": it["p_in"],
                         "appeal": it["appeal"], "duels": it["duels"], "flags": it["flags"], "taken": it["taken"]})
        return exporter.build(self.source, self.workdir / "exports", rows)


    # ------------------------------------------------------------------ the game: cups, sweep, finals, reveal
    def cups(self) -> list[dict]:
        r = self.ranker
        if r is None or r.post is None:
            return []
        champs = self.store.get_meta("champions", {}) or {}
        mu = r.post.mu
        used = set(champs.values())

        def cover(mask: np.ndarray) -> int | None:  # its best shot that isn't already another cup's cover
            idx = np.flatnonzero(mask)
            for i in idx[np.argsort(-mu[idx])]:
                if (pid := int(self.reps[int(i)])) not in used:
                    used.add(pid)
                    return pid
            return int(self.reps[int(idx[np.argmax(mu[idx])])]) if len(idx) else None

        def cup(key: str, name: str, icon: str, mask: np.ndarray) -> dict:
            return {"key": key, "name": name, "icon": icon, "shots": int(mask.sum()), "champion": champs.get(key),
                    "cover": champs.get(key) or cover(mask), "finals": self._finals_summary(key)}
        if self.mode != "gallery":
            return [cup("all", "Profile Cup", "💘", self.base_active)]
        cats = np.array(self.cats)
        out = [cup(key, name, icon, self.base_active & (cats == key)) for key, (name, icon) in CUPS.items()
               if key != "all" and (self.base_active & (cats == key)).sum() >= MIN_CUP]
        return [cup("all", *CUPS["all"], self.base_active)] + out

    def set_cup(self, key: str) -> None:
        with self.lock:
            if key not in {c["key"] for c in self.cups()}:
                abort(400, "No such cup here.")
            self.store.set_meta("cup", key)
            self.cards.clear()
            self.minis.clear()
            self.followups, self.priority, self.version = [], None, None
            self.ensure_ranker()

    def sweep_cards(self) -> list[dict]:
        """Quick keep-or-toss calls where the sorter was least sure: set-aside photos that look like they might be
        fine (highest prior first) and shots in the running that look most like junk (lowest prior first)."""
        r = self.ranker
        if r is None:
            return []
        seen = {v["a"] for v in self.store.q("SELECT a FROM votes WHERE kind='sweep' AND undone=0")}
        cat = "" if self.cup == "all" else " AND category=?"
        args = [] if self.cup == "all" else [self.cup]
        cut = [row for row in self.store.q(
            "SELECT id, rel, cut, prior FROM photos WHERE cut IS NOT NULL AND override IS NULL AND cut NOT IN "
            "('unreadable', 'tiny', 'tossed', 'old', 'excluded_person')" + cat + " ORDER BY prior DESC LIMIT 200", args)
            if row["id"] not in seen and not library.SCREENSHOT_NAME.search(row["rel"].rsplit("/", 1)[-1])]
        reps = [self.reps[i] for i in np.flatnonzero(r.active)]
        info: dict[int, tuple[float, list]] = {}
        for k in range(0, len(reps), 500):
            chunk = reps[k:k + 500]
            info.update((row["id"], (row["prior"] or 0.0, json.loads(row["flags"] or "[]"))) for row in self.store.q(
                f"SELECT id, prior, flags FROM photos WHERE id IN ({','.join('?' * len(chunk))})", chunk))
        priors = np.array([info.get(pid, (0.0, []))[0] for pid in reps]) if reps else np.zeros(1)
        floor, mid = np.quantile(priors, SWEEP_JUNK), np.quantile(priors, 0.4)
        # set aside, but scoring like the middle of the pack: maybe the rule misfired
        cut = [row for row in cut if row["prior"] is not None and row["prior"] >= mid][:SWEEP_MAX // 2]
        # in the running, but in the bottom few percent and with a visible problem: likely junk
        low = sorted((pid for pid in reps if pid not in seen and info[pid][0] <= floor
                      and set(info[pid][1]) & JUNK_FLAGS), key=lambda pid: info[pid][0])[:SWEEP_MAX - len(cut)]
        out = []
        for k in range(max(len(cut), len(low))):
            if k < len(cut):
                out.append({"photo": cut[k]["id"], "kind": "cut", "reason": cut[k]["cut"], "flags": []})
            if k < len(low):
                out.append({"photo": low[k], "kind": "kept", "reason": None,
                            "flags": [f for f in info[low[k]][1] if f in JUNK_FLAGS]})
        for c in out:
            c["view"] = self.photo_view(c["photo"])
        return out

    def sweep(self, pid: int, keep: bool) -> dict:
        with self.lock:
            row = self.store.one("SELECT id, cut, override FROM photos WHERE id=?", (pid,))
            if row is None:
                abort(404, "Unknown photo.")
            g = self.photo_group.get(pid)
            members = (self.groups.get(g) or {}).get("members", [pid]) if row["cut"] is None else [pid]
            prev = {str(r_["id"]): r_["override"] for r_ in self.store.q(
                f"SELECT id, override FROM photos WHERE id IN ({','.join('?' * len(members))})", members)}
            change = "keep" if keep and row["cut"] is not None else "toss" if not keep and row["cut"] is None else None
            if change:
                with self.store.tx() as c:
                    c.execute(f"UPDATE photos SET override=? WHERE id IN ({','.join('?' * len(members))})",
                              [change, *members])
            self.store.add_vote("sweep", pid, None, None, None, extra={"keep": keep, "prev": prev, "change": change})
            if change == "toss" and (i := self._item(pid)) is not None:
                self.ranker.active[i] = self.base_active[i] = False
                self.ranker.n_active = int(self.ranker.active.sum())
                self._fit()
            if change:
                self.refresh_async()
            return {"ok": True, "change": change, "progress": self.progress()}

    def finals_state(self, cup: str | None = None) -> dict | None:
        return self.store.get_meta(f"finals:{cup or self.cup}")

    def _finals_summary(self, cup: str) -> str:
        st = self.finals_state(cup)
        return "none" if not st else "done" if st.get("champion") else "playing"

    def finals_start(self) -> dict:
        """Seed the leaderboard's top 8 (or 4) into a bracket: quarterfinals, semifinals, a bronze match, the final."""
        with self.lock:
            r = self.ensure_ranker()
            if r is None or r.post is None:
                abort(409, "Still analyzing.")
            seeds = self._finals_seeds(r)
            size = len(seeds)
            if not size:
                abort(400, "A cup needs at least 4 shots for a final.")
            pairs = [(0, 7), (3, 4), (1, 6), (2, 5)] if size == 8 else [(0, 3), (1, 2)]
            first = "qf" if size == 8 else "sf"
            matches = [{"round": first, "a": seeds[x], "b": seeds[y], "winner": None} for x, y in pairs]
            if size == 8:
                matches += [{"round": "sf", "a": None, "b": None, "winner": None} for _ in range(2)]
            matches += [{"round": "bronze", "a": None, "b": None, "winner": None},
                        {"round": "final", "a": None, "b": None, "winner": None}]
            self.store.set_meta(f"finals:{self.cup}", {"cup": self.cup, "size": size, "seeds": seeds, "matches": matches,
                                                       "champion": None, "started": time.time(),
                                                       "id": secrets.token_hex(4)})
            return self.finals_view()

    def _finals_seeds(self, r) -> list[int]:
        """Who goes into the bracket if it's seeded now: the leaderboard's top 8 (or 4), best first."""
        top = [int(i) for i in r.select(r.post.mu)]
        top += [int(i) for i in np.argsort(-r.post.mu) if r.active[i] and int(i) not in top]
        size = 8 if len(top) >= 8 else 4 if len(top) >= 4 else 0
        return [self.reps[i] for i in top[:size]]

    def finals_view(self, cup: str | None = None) -> dict:
        cup = cup or self.cup
        st = self.finals_state(cup)
        n = int(self.ranker.n_active) if self.ranker is not None else 0
        if not st:
            r = self.ranker
            preview = self._finals_seeds(r) if r is not None and r.post is not None and cup == self.cup else []
            return {"finals": None, "card": None, "eligible": n >= 4, "rounds": ROUNDS, "preview": preview}
        nxt = next((k for k, m in enumerate(st["matches"]) if m["a"] and m["b"] and not m["winner"]), None)
        card = None
        if nxt is not None:
            m = st["matches"][nxt]
            card = self._public(self._card("final", match=nxt, a=m["a"], b=m["b"], round=m["round"], cup=cup))
        return {"finals": st, "card": card, "eligible": True, "rounds": ROUNDS,
                "photos": {pid: self.photo_view(pid) for pid in st["seeds"]}}

    def _final_vote(self, card: dict, outcome: str, ms: int | None) -> dict:
        st = self.finals_state(card["cup"])
        m = st["matches"][card["match"]] if st else None
        if m is None or m["winner"] or (m["a"], m["b"]) != (card["a"], card["b"]):
            abort(409, "That match is out of date; reloading.")
        if outcome not in ("a", "b"):
            abort(400, "The finals need a winner: pick one.")
        w = card["a"] if outcome == "a" else card["b"]
        lose = card["b"] if w == card["a"] else card["a"]
        before = json.loads(json.dumps(st))
        champs = self.store.get_meta("champions", {}) or {}
        m["winner"] = w
        ms_, k = st["matches"], card["match"]
        sf0 = 4 if st["size"] == 8 else 0
        if m["round"] == "qf":
            ms_[sf0 + k // 2]["a" if k % 2 == 0 else "b"] = w
        elif m["round"] == "sf":
            slot = "a" if k == sf0 else "b"
            ms_[-1][slot], ms_[-2][slot] = w, lose
        elif m["round"] == "bronze":
            st["bronze"] = w
        else:
            st["champion"], st["runner_up"] = w, lose
        self.store.add_vote("duel", card["a"], card["b"], w, ms,
                            extra={"final": st["cup"], "round": m["round"], "match": k, "before": before,
                                   "champs_before": champs, "bracket": st.get("id")})
        self.store.set_meta(f"finals:{st['cup']}", st)
        if st.get("champion"):
            self.store.set_meta("champions", {**champs, st["cup"]: st["champion"]})
        self._fit()
        return {**self.finals_view(st["cup"]), "progress": self.progress(),
                "result": {"winner": w, "loser": lose, "round": m["round"]}}

    def finals_reset(self) -> dict:
        with self.lock:
            self.store.set_meta(f"finals:{self.cup}", None)
            champs = self.store.get_meta("champions", {}) or {}
            if champs.pop(self.cup, None) is not None:
                self.store.set_meta("champions", champs)
            return self.finals_view()

    def finals_order(self) -> list[int]:
        """This cup's finalists in the order the bracket settled (champion, runner-up, bronze, fourth, then
        the quarterfinal losers by appeal), once a champion is crowned; [] before that."""
        st = self.finals_state()
        if not st or not st.get("champion"):
            return []
        bronze = st["matches"][-2]
        fourth = bronze["b"] if bronze.get("winner") == bronze["a"] else bronze["a"]
        order = [st["champion"], st.get("runner_up"), st.get("bronze"), fourth]
        rest = [p for p in st["seeds"] if p not in order]
        mu = self.ranker.post.mu if self.ranker is not None and self.ranker.post is not None else None
        if mu is not None:
            rest.sort(key=lambda pid: -mu[self._item(pid)] if self._item(pid) is not None else 0)
        return [p for p in order + rest if p]

    def _sweep_stage(self) -> dict:
        left = len(self.sweep_cards())
        return {"left": left, "done": left == 0 or self.store.get_meta(f"sweep_done:{self.cup}") is not None}

    def journey(self) -> dict:
        with self.lock:
            r = self.ensure_ranker()
            if r is None:
                abort(409, "Still analyzing.")
            p = self.progress()
            fin = self.finals_state()
            q = p.get("quality", 0.0)
            done = bool(fin and fin.get("champion"))
            return {"mode": self.mode, "cup": self.cup, "cups": self.cups(), "progress": p,
                    "order": ["stacks", "draw", "crown", "groups", "duels", "finals", "reveal"], "side": ["sweep"],
                    "top": [{"photo": self.reps[i], "box": self.view.get(self.reps[i], {}).get("box")}
                            for i in r.select(r.post.mu)[:12]] if r.post is not None else [],
                    "summary": self.store.get_meta("summary"), "labels": library.CUT_LABELS,
                    "stages": {
                        "sweep": self._sweep_stage(),
                        "stacks": {"twins": self.twins_left(),
                                   "stacks": sum(1 for i in np.flatnonzero(r.active) if len(self.groups.get(self.gids[i], {}).get("members", ())) > 1)},
                        "crown": {"left": len(self.stacks_left()),
                                  "total": sum(1 for i in np.flatnonzero(r.active) if len(self.distinct.get(self.gids[i], ())) > 1)},
                        **self.draw.journey(),
                        "duels": {"quality": q, "votes": p.get("votes", 0), "done": p.get("done", False), "k": r.k},
                        "finals": {"state": "done" if done else "playing" if fin else "ready" if q >= 0.8 else "early",
                                   "champion": fin.get("champion") if fin else None, "eligible": int(r.n_active) >= 4},
                        "reveal": {"ready": done or q >= 0.8},
                    }}

    def reveal(self) -> dict:
        with self.lock:
            sl = self.shortlist()
            fin = self.finals_state()
            won = bool(fin and fin.get("champion"))
            podium = [fin["champion"], fin.get("runner_up"), fin.get("bronze")] if won else [it["photo"] for it in sl["items"][:3]]
            podium = [pid for pid in podium if pid]
            cup = next((c for c in self.cups() if c["key"] == self.cup), None)
            return {"podium": podium, "from_finals": won, "top": sl["items"], "taste": sl["taste"], "cups": self.cups(),
                    "progress": sl["progress"], "mode": self.mode, "cup": cup, "summary": self.store.get_meta("summary"),
                    "photos": {pid: self.photo_view(pid) for pid in podium}}


class App:
    def __init__(self, data_dir: Path = DATA_DIR):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.data_dir.chmod(0o700)  # face data and previews: yours only
        except OSError:
            pass
        self.lock = threading.RLock()
        self.session: Session | None = None
        self.sample = SampleFetcher(self.data_dir / "sample-photos")
        state = self._state()
        cur = state.get("current")
        if cur and Path(cur).is_dir():
            self.open(Path(cur), start=False)

    def _state(self) -> dict:
        try:
            return json.loads((self.data_dir / "state.json").read_text())
        except (OSError, ValueError):
            return {}

    def _save_state(self, st: dict) -> None:
        tmp = self.data_dir / "state.json.tmp"
        tmp.write_text(json.dumps(st, indent=1))
        tmp.replace(self.data_dir / "state.json")

    def open(self, source: Path, start: bool = True) -> Session:
        with self.lock:
            source = source.expanduser().resolve()
            if self.session and self.session.source == source:
                s = self.session
            else:
                if self.session:
                    self.session.analyzer.cancel.set()
                s = self.session = Session(source, self.data_dir)
            st = self._state()
            recent = [r for r in st.get("recent", []) if r.get("path") != str(source)]
            recent.insert(0, {"path": str(source), "opened": time.time()})
            self._save_state({"current": str(source), "recent": recent[:SAVES_MAX]})
            if start or (not s.analyzed() and not s.analyzer.running()):
                s.analyzer.start()
            return s

    def close(self) -> None:
        with self.lock:
            if self.session:
                self.session.analyzer.cancel.set()
            self.session = None
            st = self._state()
            st["current"] = None
            self._save_state(st)

    def forget(self, source: Path) -> None:
        source = source.expanduser().resolve()
        with self.lock:
            if self.session and self.session.source == source:
                self.close()
            work = (self.data_dir / _slug(source)).resolve()
            if work.parent != self.data_dir.resolve():
                abort(400, "That isn't a MatchER library.")
            if work.exists():
                shutil.rmtree(work)
            st = self._state()
            st["recent"] = [r for r in st.get("recent", []) if r.get("path") != str(source)]
            if st.get("current") == str(source):
                st["current"] = None
            self._save_state(st)


# ---------------------------------------------------------------------------- saves
def save_card(data_dir: Path, path: str, opened: float | None = None) -> dict:
    """One folder as a save slot: its class (mode), level, cover, stats and when it was last played, read from its
    database without opening it as a library."""
    src = Path(path)
    slug = _slug(src)
    card = {"path": path, "slug": slug, "name": src.name or path, "opened": opened, "exists": src.is_dir(), "fresh": True}
    db = data_dir / slug / "matcher.db"
    if not db.is_file():
        return card
    try:
        con = sqlite3.connect(db, timeout=5)
        con.row_factory = sqlite3.Row
        try:
            meta = {r["key"]: json.loads(r["value"]) for r in con.execute(
                "SELECT key, value FROM meta WHERE key IN ('settings', 'summary', 'champions', 'achievements', 'analyzed_at')")}
            votes = [dict(r) for r in con.execute("SELECT kind, ms, undone, ts, extra FROM votes ORDER BY id")]
            champs = meta.get("champions") or {}
            cover = champs.get("all") or next(iter(champs.values()), None)
            if cover is None:
                row = con.execute("SELECT g.rep FROM groups g JOIN photos p ON p.id = g.rep ORDER BY p.prior DESC LIMIT 1").fetchone()
                cover = row[0] if row else None
            try:
                groups = con.execute("SELECT COUNT(*) FROM themes").fetchone()[0]
            except sqlite3.Error:  # a save from before the Draw
                groups = 0
        finally:
            con.close()
    except sqlite3.Error:
        return card
    mode = "gallery" if (meta.get("settings") or {}).get("mode") == "gallery" else "me"
    play = game.stats(votes, mode=mode, earned=meta.get("achievements") or [])
    summary = meta.get("summary") or {}
    return {**card, "fresh": False, "mode": mode, "analyzed": bool(meta.get("analyzed_at")), "cover": cover,
            "level": play["level"], "level_name": play["level_name"], "xp": play["xp"], "level_floor": play["level_floor"],
            "level_next": play["level_next"], "calls": play["judged"], "champions": play["champions"],
            "trophies": len(play["unlocked"]), "photos": summary.get("photos"), "shots": summary.get("shots"),
            "groups": groups, "played": max([v["ts"] for v in votes if v["ts"]] + [opened or 0]) or None}


# ---------------------------------------------------------------------------- folder picking

def native_pick(start: str) -> str | None:
    """KDE or GTK folder dialog on the user's desktop. Returns None if cancelled/unavailable."""
    for cmd in (["kdialog", "--title", "Pick your photo folder", "--getexistingdirectory", start],
                ["zenity", "--file-selection", "--directory", "--title=Pick your photo folder", f"--filename={start}/"]):
        if shutil.which(cmd[0]):
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
            return None
    raise FileNotFoundError("no native dialog available")


def count_photos_shallow(path: Path, limit: int = 100000) -> int:
    n = 0
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.is_file() and os.path.splitext(e.name)[1].lower() in PHOTO_EXTS and not e.name.startswith("."):
                    n += 1
                    if n >= limit:
                        break
    except OSError:
        pass
    return n


def suggestions() -> list[dict]:
    home = Path.home()
    out = [{"label": "Home", "path": str(home)}]
    for name in ("Pictures", "Downloads", "Desktop", "DCIM"):
        p = home / name
        if p.is_dir():
            out.append({"label": name, "path": str(p)})
    uid = os.getuid()
    for mount in sorted(Path(f"/run/user/{uid}").glob("*/storage/emulated/0")):  # KDE Connect phone mounts
        out.append({"label": "Phone (KDE Connect)", "path": str(mount)})
    return out


# ---------------------------------------------------------------------------- flask app

LOCKED_PAGE = """<!doctype html><meta charset="utf-8"><title>MatchER</title>
<body style="background:#0d0e10;color:#f4f1ec;font:16px system-ui;display:grid;place-items:center;height:90vh">
<div style="max-width:30em;text-align:center"><h1>MatchER is locked</h1><p>Open the link MatchER printed when it
started (or run <code>./matcher.sh</code> again; it opens the right link for you).</p></div>"""
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


def create_app(data_dir: Path = DATA_DIR, secret: str | None = None, allowed_hosts: set[str] | None = None,
               cookie: str = "matcher_k") -> Flask:
    """secret: when set, every request needs the cookie that the one-time link (/?k=<secret>) hands out, so other
    programs and accounts on this machine (or your network, with --lan) can't use the app."""
    flask_app = Flask(__name__, static_folder=None)
    app = App(data_dir)
    flask_app.config["MATCHER"] = app

    @flask_app.before_request
    def guard():
        host = (request.host or "").lower()
        if allowed_hosts is not None and host not in allowed_hosts:
            abort(403, "Unexpected Host header.")
        site = request.headers.get("Sec-Fetch-Site")
        if site in ("cross-site", "same-site") and not (request.path == "/" and request.headers.get("Sec-Fetch-Mode") == "navigate"):
            abort(403, "Cross-site request refused.")
        if secret is not None:
            key = request.args.get("k")
            if request.path == "/" and key is not None:  # the link: trade it for a cookie, then a clean URL
                if not hmac.compare_digest(key, secret):
                    return LOCKED_PAGE, 403
                resp = redirect("/", 303)
                resp.set_cookie(cookie, secret, httponly=True, samesite="Strict", max_age=30 * 86400, path="/")
                return resp
            if not hmac.compare_digest(request.cookies.get(cookie, ""), secret):
                if request.path == "/":
                    return LOCKED_PAGE, 403
                abort(403, "Open the link MatchER printed when it started.")
        if request.method == "POST" and request.headers.get("X-MatchER") != "1":
            abort(403, "Missing app header.")

    @flask_app.after_request
    def headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        return resp

    @flask_app.errorhandler(400)
    @flask_app.errorhandler(403)
    @flask_app.errorhandler(404)
    @flask_app.errorhandler(409)
    def err(e):
        return jsonify(error=getattr(e, "description", str(e))), getattr(e, "code", 500)

    @flask_app.errorhandler(ValueError)
    def bad_value(e):  # a malformed number in a request, an empty export…: the request's fault, not a crash
        return jsonify(error=str(e) or "Bad request."), 400

    def sess() -> Session:
        s = app.session
        if s is None:
            abort(409, "No photo folder chosen yet.")
        return s

    def body() -> dict:
        return request.get_json(silent=True) or {}

    # -------- pages and static files
    @flask_app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html", max_age=0)

    @flask_app.get("/static/<path:name>")
    def static_file(name):
        return send_from_directory(STATIC, name, max_age=0)

    # -------- onboarding
    @flask_app.get("/api/state")
    def state():
        s = app.session
        st = app._state()
        out = {"library": None, "recent": [r for r in st.get("recent", []) if Path(r["path"]).is_dir()]}
        if s:
            out["library"] = {
                "source": str(s.source), "analyzing": s.analyzer.running(), "analyzed": s.analyzed(),
                "progress": {k: v.copy() if isinstance(v, (list, dict)) else v for k, v in list(s.analyzer.progress.items())},
                "summary": s.store.get_meta("summary"), "settings": s.settings,
                "labels": library.CUT_LABELS, "mode": s.mode, "cup": s.cup,
                "votes": s.store.one("SELECT COUNT(*) AS n FROM votes WHERE undone=0")["n"],
                "save": save_card(app.data_dir, str(s.source)),
            }
        return jsonify(out)

    dialog = threading.Lock()

    @flask_app.post("/api/pick-native")
    def pick_native():
        start = Path(body().get("start") or Path.home() / "Pictures").expanduser()
        if not dialog.acquire(blocking=False):
            abort(409, "A folder dialog is already open.")
        try:
            path = native_pick(str(start.resolve()) if start.is_absolute() and start.is_dir() else str(Path.home()))
        except FileNotFoundError:
            return jsonify(available=False)
        finally:
            dialog.release()
        return jsonify(available=True, path=path)

    @flask_app.get("/api/browse")
    def browse():
        raw = request.args.get("path") or str(Path.home())
        p = Path(raw).expanduser()
        if not p.is_dir():
            abort(404, "Not a folder.")
        p = p.resolve()
        dirs = []
        try:
            entries = sorted(os.scandir(p), key=lambda e: e.name.lower())
        except OSError:
            abort(403, "Can't read that folder.")
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir():
                    dirs.append({"name": e.name, "path": str(Path(e.path)), "photos": count_photos_shallow(Path(e.path), 9999)})
            except OSError:
                continue
        return jsonify(path=str(p), parent=str(p.parent) if p.parent != p else None, dirs=dirs,
                       photos=count_photos_shallow(p), suggestions=suggestions())

    @flask_app.post("/api/library")
    def open_library():
        mode = body().get("mode")
        raw = (body().get("path") or "").strip()
        p = Path(raw).expanduser()
        if not raw or not p.is_dir():
            abort(400, "That folder doesn't exist.")
        try:
            n = len(list_photos(p.resolve()))
        except TooManyPhotos as e:
            abort(400, str(e))
        if n == 0:
            abort(400, "No photos in that folder (or its subfolders).")
        s = app.open(p)
        if mode in ("me", "gallery") and mode != s.mode:  # picked on the welcome screen
            s.store.set_meta("settings", {**s.settings, "mode": mode})
            s.store.set_meta("cup", "all")
            if s.analyzed() and not s.analyzer.running():
                s.refresh_async()
        return state()

    @flask_app.get("/api/saves")
    def saves():
        st = app._state()
        cur = app.session.source if app.session else None
        out = []
        for r in st.get("recent", []):
            card = save_card(app.data_dir, r["path"], r.get("opened"))
            card["current"] = cur is not None and str(cur) == r["path"]
            out.append(card)
        return jsonify(saves=out)

    @flask_app.get("/img/save/<slug>/<int:pid>.jpg")
    def save_cover(slug, pid):
        """A save's cover, for the save screen (only for folders on it)."""
        known = {_slug(Path(r["path"])) for r in app._state().get("recent", [])}
        if slug not in known:
            abort(404)
        path = app.data_dir / slug / "previews" / f"{pid}.jpg"
        if not path.is_file():
            abort(404)
        resp = send_file(path, mimetype="image/jpeg", conditional=True, max_age=3600)
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    @flask_app.post("/api/library/close")
    def close_library():
        app.close()
        return state()

    @flask_app.get("/api/sample")
    def sample_status():
        return jsonify(app.sample.status)

    @flask_app.post("/api/sample")
    def sample_start():
        """Download the public-domain sample library (only when you click "try it with sample photos")."""
        return jsonify(app.sample.start())

    @flask_app.post("/api/library/forget")
    def forget_library():
        """Delete everything MatchER keeps about a folder (database, face data, previews, exports). Your photos
        themselves are never touched."""
        raw = (body().get("path") or "").strip()
        if not raw:
            abort(400, "Which folder?")
        app.forget(Path(raw))
        return state()

    @flask_app.post("/api/rescan")
    def rescan():
        s = sess()
        s.analyzer.start()
        return state()

    @flask_app.post("/api/settings")
    def settings():
        s = sess()
        cur = s.settings
        b = body()
        for key, lo, hi in (("finalists", 10, 100), ("per_scene", 1, 10), ("max_age_years", 0, 30)):
            if key in b:
                cur[key] = int(min(hi, max(lo, int(b[key]))))
        refresh = "max_age_years" in b and b["max_age_years"] != s.settings.get("max_age_years")
        if b.get("match") in library.MATCH_T and b["match"] != cur.get("match"):
            cur["match"] = b["match"]
            refresh = True
        if b.get("mode") in ("me", "gallery") and b["mode"] != cur.get("mode"):
            cur["mode"] = b["mode"]
            s.store.set_meta("cup", "all")
            refresh = True
        s.store.set_meta("settings", cur)
        if refresh:
            s.refresh_async()
        with s.lock:
            s.version = None
        return jsonify(settings=cur)

    # -------- tournament
    @flask_app.get("/api/next")
    def next_cards():
        s = sess()
        with s.lock:
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            n = max(1, min(3, int(request.args.get("n", 2))))
            s.forget_unshown_frames()
            if request.args.get("stack"):
                s.crown_now(int(request.args["stack"]))
            stage = request.args.get("stage") or None
            if stage not in ("stacks", "groups", "knockouts", "open"):
                stage = s.draw.default_stage()  # the journey's: the group stage until it's settled, then the knockouts
            stage = None if stage == "open" else stage
            left = len(s.stacks_left()) if stage == "stacks" else None  # counted before one is dealt out
            return jsonify(cards=s.next_cards(n, stage=stage), progress=s.progress(), left=left, stage=stage,
                           draw=s.draw.journey()["groups"])

    @flask_app.post("/api/stacks/auto")
    def stacks_auto():
        s = sess()
        _need(s)
        return jsonify(crowned=s.crown_rest(), progress=s.progress())

    @flask_app.get("/api/game")
    def game_view():
        s = sess()
        with s.lock:
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            p = s.progress()
            return jsonify(stats=p.get("game"), achievements=game.catalog(p.get("game", {}).get("unlocked", [])),
                           levels=[{"xp": x, "name": n} for x, n in zip(game.LEVEL_XP, game.LEVEL_NAMES[s.mode])])

    @flask_app.post("/api/vote")
    def vote():
        s = sess()
        b = body()
        ms = b.get("ms")
        lr = b.get("lr")
        return jsonify(s.vote(str(b.get("card", "")), str(b.get("outcome", "")),
                              int(ms) if isinstance(ms, (int, float)) else None,
                              b.get("choice") if isinstance(b.get("choice"), int) else None,
                              [str(c) for c in b.get("pending", [])][:4],
                              lr=str(lr)[:32] if lr else None,
                              stage=b.get("stage") if b.get("stage") in ("stacks", "groups", "knockouts") else None))

    @flask_app.get("/api/journey")
    def journey():
        return jsonify(sess().journey())

    @flask_app.post("/api/cup")
    def set_cup():
        s = sess()
        s.set_cup(str(body().get("cup", "all")))
        return jsonify(s.journey())

    @flask_app.get("/api/sweep")
    def sweep_cards():
        s = sess()
        with s.lock:
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            return jsonify(cards=s.sweep_cards(), labels=library.CUT_LABELS, progress=s.progress())

    @flask_app.post("/api/sweep/done")
    def sweep_done():
        s = sess()
        s.store.set_meta(f"sweep_done:{s.cup}", time.time())
        return jsonify(ok=True)

    @flask_app.post("/api/sweep")
    def sweep_decide():
        b = body()
        return jsonify(sess().sweep(int(b.get("photo", 0)), bool(b.get("keep"))))

    @flask_app.get("/api/finals")
    def finals():
        s = sess()
        with s.lock:
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            return jsonify({**s.finals_view(), "progress": s.progress()})

    @flask_app.post("/api/finals/start")
    def finals_start():
        return jsonify(sess().finals_start())

    @flask_app.post("/api/finals/reset")
    def finals_reset():
        return jsonify(sess().finals_reset())

    @flask_app.get("/api/analysis/feed")
    def analysis_feed():
        """What the analysis found since you last asked: ?read=&cats=&seen= are how many of each you have already."""
        s = sess()
        f = getattr(getattr(s, "analyzer", None), "feed", None) or {}
        out = {}
        for k in ("read", "cats", "seen"):
            lst = f.get(k, [])
            since = max(0, int(request.args.get(k, 0) or 0))
            out[k] = lst[since:since + 2500]
            out[f"{k}_n"] = len(lst)
        return jsonify(out)

    @flask_app.get("/api/seats")
    def seats():
        """The race for the finals: the eight seats as the leaderboard stands now, and the next four."""
        s = sess()
        with s.lock:
            _need(s)
            r = s.ranker
            seeds = s._finals_seeds(r) if r is not None and r.post is not None else []
            order = [s.reps[int(i)] for i in np.argsort(-r.post.mu) if r.active[i]] if seeds else []
            seat = lambda p: {"photo": p, "team": s.draw.team_of(p)}  # noqa: E731
            return jsonify({"seats": [seat(p) for p in seeds], "bubble": [seat(p) for p in order if p not in seeds][:4]})

    @flask_app.get("/api/tournament")
    def tournament():
        """The tournament board: every group's roster and standings, the race for the finals' eight seats (and who's
        on the bubble), and the bracket."""
        s = sess()
        with s.lock:
            _need(s)
            r = s.ranker
            seeds = s._finals_seeds(r) if r is not None and r.post is not None else []
            order = [s.reps[int(i)] for i in np.argsort(-r.post.mu) if r.active[i]] if seeds else []
            bubble = [p for p in order if p not in seeds][:4]
            seat = lambda p: {"photo": p, "team": s.draw.team_of(p)}  # noqa: E731
            return jsonify({"groups": s.draw.tables(), "seats": [seat(p) for p in seeds], "bubble": [seat(p) for p in bubble],
                            **s.finals_view(), "progress": s.progress()})

    @flask_app.get("/api/reveal")
    def reveal():
        s = sess()
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")
        return jsonify(s.reveal())

    @flask_app.post("/api/undo")
    def undo():
        stage = body().get("stage")
        return jsonify(sess().undo(stage if stage in ("stacks", "groups", "knockouts") else None))

    @flask_app.get("/api/shortlist")
    def shortlist():
        s = sess()
        with s.lock:
            return jsonify(s.shortlist())

    @flask_app.post("/api/pick")
    def pick():
        s = sess()
        b = body()
        pid, on = int(b.get("photo", 0)), bool(b.get("on", True))
        with s.store.tx() as c:
            c.execute("UPDATE photos SET pick=? WHERE id=?", (1 if on else 0, pid))
        return jsonify(ok=True)

    @flask_app.post("/api/frame")
    def set_frame():
        """Swap which frame of a burst represents it (from the shortlist)."""
        s = sess()
        pid = int(body().get("photo", 0))
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")
        g = s.photo_group.get(pid)
        if g is None or g not in s.groups:
            abort(404, "Unknown photo.")
        members = s.groups[g]["members"]
        _remember(s, "keep", _snapshot(s, members))
        with s.store.tx() as c:
            c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(members))})", members)
            c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (pid,))
        library.regroup(s.store)
        with s.lock:
            s.version = None
            s.ensure_ranker()
        return jsonify(ok=True)

    @flask_app.get("/api/group/<int:pid>")
    def group(pid):
        s = sess()
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")
        g = s.photo_group.get(pid)
        return jsonify(members=s.groups.get(g, {}).get("members", [pid]))

    @flask_app.post("/api/export")
    def do_export():
        s = sess()
        kind = "bestof" if body().get("kind") == "bestof" else "review"
        with s.lock:
            return jsonify(s.export(kind))

    @flask_app.post("/api/open")
    def open_folder():
        s = sess()
        target = Path(body().get("path", "")).resolve()
        exports = (s.workdir / "exports").resolve()
        if target.parent != exports or not target.is_dir():
            abort(403, "Only export folders can be opened.")
        subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return jsonify(ok=True)

    # -------- review cuts / people
    @flask_app.get("/api/cuts")
    def cuts():
        s = sess()
        rows = s.store.q("SELECT id, rel, cut, override, flags, me_sim FROM photos "
                         "WHERE status IN ('analyzed','error') AND (cut IS NOT NULL OR override='keep') ORDER BY cut, id")
        out = []
        for r in rows:
            fl = json.loads(r["flags"] or "[]")
            reason = r["cut"] or next((f.split(":", 1)[1] for f in fl if f.startswith("rescued:")), "rescued")
            out.append({"id": r["id"], "reason": reason, "rescued": r["override"] == "keep", "rel": r["rel"]})
        return jsonify(photos=out, labels=library.CUT_LABELS)

    @flask_app.post("/api/rescue")
    def rescue():
        """on=true brings photos back into the tournament, on=false sets them aside again.
        Automatic set-asides flip an override; tossed photos are un-tossed (and the toss stops teaching
        the model) or re-tossed."""
        s = sess()
        b = body()
        ids = [int(i) for i in b.get("ids", [])][:5000]
        on = bool(b.get("on", True))
        tossed_view = b.get("reason") == "tossed"
        changed = 0
        with s.store.tx() as c:
            tosses = None
            for pid in ids:
                row = c.execute("SELECT override FROM photos WHERE id=?", (pid,)).fetchone()
                if row is None:
                    continue
                ov = row["override"]
                if on and ov == "toss":
                    c.execute("UPDATE photos SET override=NULL WHERE id=?", (pid,))
                    if tosses is None:
                        tosses = [(v["id"], (json.loads(v["extra"]).get("members") if v["extra"] else None) or [v["a"]])
                                  for v in c.execute("SELECT id, a, extra FROM votes WHERE kind='toss' AND undone=0")]
                    for vid, members in tosses:
                        if pid in members:
                            c.execute("UPDATE votes SET undone=1 WHERE id=?", (vid,))
                elif on and ov is None:
                    c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
                elif not on and ov == "keep":
                    c.execute("UPDATE photos SET override=NULL WHERE id=?", (pid,))
                elif not on and ov is None and tossed_view:
                    c.execute("UPDATE photos SET override='toss' WHERE id=?", (pid,))
                    c.execute("INSERT INTO votes(ts, kind, a, extra) VALUES(?, 'toss', ?, ?)",
                              (time.time(), pid, json.dumps({"members": [pid]})))
                else:
                    continue
                changed += 1
        if changed:
            s.refresh_async()
        return jsonify(ok=True, changed=changed)

    @flask_app.get("/api/people")
    def people():
        s = sess()
        me = s.store.q("SELECT f.id, f.emb FROM faces f JOIN photos p ON p.me_face = f.id")
        rng = np.random.default_rng(0)
        me_ids = [r["id"] for r in me]
        sample = sorted(rng.choice(me_ids, min(12, len(me_ids)), replace=False).tolist()) if me_ids else []
        cen = s.store.get_meta("me_centroid")
        borderline = []
        if cen and me:
            sims = np.frombuffer(b"".join(r["emb"] for r in me), np.float32).reshape(len(me), -1) @ np.asarray(cen, np.float32)
            borderline = [me_ids[i] for i in np.argsort(sims)[:12]]
        n_me = s.store.one("SELECT COUNT(*) AS n FROM photos WHERE me_face IS NOT NULL")["n"]
        excluded = s.store.get_meta("excluded_keys", []) or []
        ppl = [{"key": r["id"], "n_photos": r["n_photos"], "faces": json.loads(r["faces"]),
                "excluded": r["id"] in excluded} for r in s.store.q("SELECT * FROM people ORDER BY n_photos DESC")]
        log = s.store.get_meta("people_log", []) or []
        return jsonify(me={"faces": sample, "borderline": borderline, "n_photos": n_me}, people=ppl[:24],
                       match=s.settings.get("match", "normal"), last=log[-1]["action"] if log else None)

    def _people_change(s: Session, action: str, key: int, cen, undo: bool = False) -> None:
        """Apply one People correction (or take it back). Everything is a list in meta, so each change is one
        append or one removal."""
        def edit(meta: str, value, add: bool):
            vals = s.store.get_meta(meta, []) or []
            if add:
                vals.append(value)
            elif value in vals:
                vals.remove(value)
            s.store.set_meta(meta, vals)
        if action in ("exclude", "include"):
            add = (action == "exclude") != undo
            edit("excluded_people", cen, add)
            edit("excluded_keys", key, add)
        elif action == "me":
            edit("me_anchors", cen, not undo)
        elif action == "not_me":
            edit("not_me_anchors", cen, not undo)

    @flask_app.post("/api/people/undo")
    def people_undo():
        s = sess()
        log = s.store.get_meta("people_log", []) or []
        if not log:
            abort(400, "Nothing to undo.")
        last = log.pop()
        _people_change(s, last["action"], last["key"], last["cen"], undo=True)
        s.store.set_meta("people_log", log)
        s.refresh_async()
        return jsonify(ok=True, undone=last["action"])

    @flask_app.post("/api/people/<int:key>")
    def person_action(key):
        s = sess()
        action = body().get("action")
        if action not in ("exclude", "include", "me", "not_me"):
            abort(400, "Unknown action.")
        if action == "not_me":
            cen = s.store.get_meta("me_centroid")
            if not cen:
                abort(409, "It hasn't worked out who you are yet.")
        elif action == "include":
            keys = s.store.get_meta("excluded_keys", []) or []
            if key not in keys:
                abort(404, "That person isn't excluded.")
            cen = (s.store.get_meta("excluded_people", []) or [])[keys.index(key)]
        else:
            cen = (s.store.get_meta("people_centroids", {}) or {}).get(str(key))
            if cen is None:
                abort(404, "That person isn't in the current grouping; reload.")
        _people_change(s, action, key, cen)
        s.store.set_meta("people_log", ((s.store.get_meta("people_log", []) or []) + [
            {"action": action, "key": key, "cen": cen}])[-50:])
        s.refresh_async()
        return jsonify(ok=True)

    # -------- groups: the stacking, exposed and editable (the Draw's group boards use these)
    def _snapshot(s: Session, pids) -> list:
        return s.draw.snapshot(pids)

    def _remember(s: Session, label: str, snap: list, **parts) -> None:
        s.draw.remember(label, snap, **parts)

    def _need(s: Session) -> None:
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")

    def _regroup(s: Session) -> None:
        library.regroup(s.store)
        with s.lock:
            s.version = None
            s.ensure_ranker(wait=True)

    def _ordered_shots(s: Session, view: str, order: str, theme: int | None = None) -> list[dict]:
        """Every shot (or stack) in display order, kept until the stacking changes: the page fetches it in pieces.
        theme: only one of the Draw's groups (-1: the shots in none yet)."""
        key = (s.store.get_meta("state_version"), s.version, view, order, theme, s.draw.ver)
        hit = s.groups_cache.get("key") == key
        if hit:
            return s.groups_cache["shots"]
        rows = {r["id"]: dict(r) for r in s.store.q(
            "SELECT id, taken, taken_ts, stack_key, rep_pref FROM photos WHERE group_id IS NOT NULL")}
        shots = []
        tm, pool = s.draw.theme_of(), s.draw.pool_mask()
        for gid, g in s.groups.items():
            members = g["members"]
            if view == "stacks" and len(members) < 2:
                continue
            if theme is not None and ((i := s.gidx.get(gid)) is None or not pool[i] or tm[i] != theme):
                continue
            keys = {rows.get(m, {}).get("stack_key") or "" for m in members}
            rep = rows.get(g["rep"], {})
            shots.append({"gid": gid, "rep": g["rep"], "members": members,
                          "manual": any(k.startswith("m:") for k in keys),
                          "solo": len(members) == 1 and any(k.startswith("solo:") for k in keys),
                          "kept": any(rows.get(m, {}).get("rep_pref") for m in members),
                          "taken": rep.get("taken"), "ts": rep.get("taken_ts"),
                          "box": s.view.get(g["rep"], {}).get("box")})
        shots.sort(key=lambda x: (x["ts"] is None, x["ts"] or 0, x["gid"]))
        if order == "look":
            shots = _lookalike(s, shots)
        s.groups_cache = {"key": key, "shots": shots}
        return shots

    def _lookalike(s: Session, shots: list[dict]) -> list[dict]:
        """Look-alike shots side by side, each tagged with its family (see library.lookalike_order)."""
        reps = [x["rep"] for x in shots]
        emb = {}
        for k in range(0, len(reps), 500):
            chunk = reps[k:k + 500]
            emb.update((r["id"], unblob(r["emb"])) for r in s.store.q(
                f"SELECT id, emb FROM photos WHERE emb IS NOT NULL AND id IN ({','.join('?' * len(chunk))})", chunk))
        have = [x for x in shots if x["rep"] in emb]
        order, fam = library.lookalike_order(np.stack([emb[x["rep"]] for x in have])) if have else ([], [])
        label: dict[int, int] = {}
        for o in order:
            have[o]["family"] = label.setdefault(fam[o], len(label))
        rest = [x for x in shots if x["rep"] not in emb]
        for x in rest:
            x["family"] = None
        return [have[o] for o in order] + rest

    def _shot_of(s: Session, pid: int) -> dict | None:
        return s.groups.get(s.photo_group.get(pid))

    @flask_app.get("/api/groups")
    def groups_view():
        s = sess()
        with s.lock:
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            if not s.warming:  # get merges ready to be quick from the first one
                s.warming = True
                threading.Thread(target=library.warm, args=(s.store,), daemon=True).start()
            view = request.args.get("view", "stacks")
            counts = {"stacks": sum(1 for g in s.groups.values() if len(g["members"]) > 1), "shots": len(s.groups)}
            if view == "suggest":
                sug = library.suggest_merges(s.store)
                counts["suggest"] = len(sug)
                for x in sug:
                    x["box_a"], x["box_b"] = s.view.get(x["a"], {}).get("box"), s.view.get(x["b"], {}).get("box")
                return jsonify(suggestions=sug, counts=counts)
            order = "look" if request.args.get("order", "look") == "look" else "time"
            theme = request.args.get("theme")
            shots = _ordered_shots(s, view, order, int(theme) if theme not in (None, "") else None)
            # Pages of about `per` items that never split a look-alike family; the page asks for them one by one.
            per = max(1, min(500, int(request.args.get("per", 120 if view == "all" else 24))))
            bounds, start = [], 0
            for k in range(1, len(shots) + 1):
                if k == len(shots) or (k - start >= per and shots[k].get("family") != shots[k - 1].get("family")) \
                        or k - start >= 2 * per:
                    bounds.append((start, k))
                    start = k
            page = max(0, int(request.args.get("page", 0)))
            part = shots[slice(*bounds[page])] if page < len(bounds) else []
            counts["suggest"] = None
            return jsonify(shots=part, counts=counts, page=page, pages=len(bounds), total=len(shots),
                           undo=s.draw.last_step(),
                           boxes={m: s.view.get(m, {}).get("box") for x in part for m in x["members"]})

    @flask_app.post("/api/groups/undo")
    @flask_app.post("/api/draw/undo")
    def groups_undo():
        """Take back your last change on the Draw or to the stacking (merge, split, move, keep, a call, a group…)."""
        s = sess()
        with s.lock:
            _need(s)
            r = s.draw.undo()
        if r["stacks"]:
            _regroup(s)
        return jsonify(ok=True, undone=r["undone"], next=r["next"])

    @flask_app.post("/api/groups/merge")
    def groups_merge():
        """Stack the shots containing these photos into one. Yours from now on: nothing else joins it,
        and it plays a mini-tournament to crown its best frame."""
        s = sess()
        s.ensure_ranker()
        members: set[int] = set()
        for pid in [int(x) for x in body().get("photos", [])][:500]:
            g = _shot_of(s, pid)
            members |= set(g["members"]) if g else {pid}
        if len(members) < 2:
            abort(400, "Pick at least two shots to merge.")
        snap = _snapshot(s, members)
        key = "m:" + secrets.token_hex(6)
        target = s.store.one("SELECT theme_id FROM photos WHERE id=?", (int(body().get("photos", [0])[-1]),))
        old = [[r["id"], r["theme_id"]] for r in s.store.q(
            f"SELECT id, theme_id FROM photos WHERE id IN ({','.join('?' * len(members))})", list(members))]
        with s.store.tx() as c:
            c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(members))})",
                      [key, *members])
            if target is not None and target["theme_id"] is not None:  # it joins the group of the shot it was dropped on
                c.execute(f"UPDATE photos SET theme_id=? WHERE id IN ({','.join('?' * len(members))})",
                          [target["theme_id"], *members])
        _remember(s, "merge", snap, themes=old, vote=s.draw._xp("twin", min(members)))  # (stacking earns XP)
        s.draw.changed()
        _regroup(s)
        return jsonify(ok=True, size=len(members))

    @flask_app.post("/api/groups/split")
    def groups_split():
        """Take one photo out of its stack. The rest stays stacked exactly as you saw it."""
        s = sess()
        s.ensure_ranker()
        pid = int(body().get("photo", 0))
        g = _shot_of(s, pid)
        if not g or len(g["members"]) < 2:
            abort(400, "That photo isn't in a stack.")
        rest = [m for m in g["members"] if m != pid]
        _remember(s, "split", _snapshot(s, g["members"]))
        with s.store.tx() as c:
            c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{pid}", pid))
            if len(rest) > 1:
                c.execute(f"UPDATE photos SET stack_key=? WHERE id IN ({','.join('?' * len(rest))})",
                          ["m:" + secrets.token_hex(6), *rest])
            else:
                c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{rest[0]}", rest[0]))
        _regroup(s)
        return jsonify(ok=True)

    @flask_app.post("/api/groups/move")
    def groups_move():
        """Drag one frame onto another shot: it leaves its stack (the rest stays as you saw it) and joins that shot."""
        s = sess()
        s.ensure_ranker()
        b = body()
        pid, target = int(b.get("photo", 0)), int(b.get("target", 0))
        src, dst = _shot_of(s, pid), _shot_of(s, target)
        if not dst:
            abort(400, "Drop it on a shot.")
        if src is dst:
            return jsonify(ok=True, size=len(dst["members"]))
        rest = [m for m in (src["members"] if src else []) if m != pid]
        joined = sorted(set(dst["members"]) | {pid})
        _remember(s, "move", _snapshot(s, set(rest) | set(joined)))
        with s.store.tx() as c:
            if len(rest) > 1:
                c.execute(f"UPDATE photos SET stack_key=? WHERE id IN ({','.join('?' * len(rest))})",
                          ["m:" + secrets.token_hex(6), *rest])
            elif rest:
                c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{rest[0]}", rest[0]))
            c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(joined))})",
                      ["m:" + secrets.token_hex(6), *joined])
        _regroup(s)
        return jsonify(ok=True, size=len(joined))

    @flask_app.post("/api/groups/unstack")
    def groups_unstack():
        """Split a whole stack into separate shots."""
        s = sess()
        s.ensure_ranker()
        g = _shot_of(s, int(body().get("photo", 0)))
        if not g or len(g["members"]) < 2:
            abort(400, "That isn't a stack.")
        _remember(s, "unstack", _snapshot(s, g["members"]))
        with s.store.tx() as c:
            c.executemany("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", [(f"solo:{m}", m) for m in g["members"]])
        _regroup(s)
        return jsonify(ok=True, size=len(g["members"]))

    @flask_app.post("/api/groups/reset")
    def groups_reset():
        """Hand shots back to the automatic stacking rules (a stack you made, or a photo you split out)."""
        s = sess()
        s.ensure_ranker()
        pids = [int(x) for x in body().get("photos", [])][:500]
        members: set[int] = set()
        for pid in pids:
            g = _shot_of(s, pid)
            members |= set(g["members"]) if g else {pid}
        if not members:
            abort(400, "Nothing to reset.")
        _remember(s, "reset", _snapshot(s, members))
        with s.store.tx() as c:
            c.execute(f"UPDATE photos SET stack_key=NULL WHERE id IN ({','.join('?' * len(members))})", list(members))
        _regroup(s)
        return jsonify(ok=True)

    @flask_app.post("/api/groups/dismiss")
    def groups_dismiss():
        """A suggestion that isn't the same moment: don't suggest it again."""
        s = sess()
        b = body()
        pair = sorted((int(b.get("a", 0)), int(b.get("b", 0))))
        seen = s.store.get_meta("stack_dismissed", []) or []
        if pair not in seen:
            s.store.set_meta("stack_dismissed", seen + [pair])
            s.draw.remember("not twins", dismissed=[pair], vote=s.draw._xp("out", pair[0]))
        return jsonify(ok=True, game=s.progress().get("game"))

    # -------- the Draw: themed groups for the group stage
    def _draw_reply(s: Session, out: dict | None = None) -> dict:
        p = s.progress()
        return {**(out or {}), "game": p.get("game"), "undo": s.draw.last_step()}

    @flask_app.get("/api/draw")
    def draw_state():
        s = sess()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.state()))

    @flask_app.get("/api/draw/deck")
    def draw_deck():
        s = sess()
        with s.lock:
            _need(s)
            nobulk = {int(x) for x in request.args.get("nobulk", "").split(",")[:200] if x.strip().isdigit()}
            return jsonify(s.draw.deck(int(request.args.get("theme", 0)), max(1, min(20, int(request.args.get("n", 10)))), nobulk))

    @flask_app.post("/api/draw/start")
    def draw_start():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.start(int(b.get("photo", 0)), b.get("name"), b.get("emoji"),
                                                                  b.get("concept"))}))

    @flask_app.post("/api/draw/new")
    def draw_new():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.create([int(x) for x in b.get("photos", [])][:500])}))

    @flask_app.get("/api/draw/board")
    def draw_board():
        """The Groups page in one go: every group with its first shots (look-alikes side by side), and the unsorted pile."""
        s = sess()
        with s.lock:
            _need(s)
            per = max(4, min(2000, int(request.args.get("per", 24))))
            shots = _ordered_shots(s, "all", "look" if len(s.groups) <= 3000 else "time")  # look-alikes side by side
            tm, pool = s.draw.theme_of(), s.draw.pool_mask()
            by: dict[int, list] = {}
            for x in shots:
                i = s.gidx.get(x["gid"])
                if i is not None and pool[i]:
                    by.setdefault(int(tm[i]), []).append(x)
            st = s.draw.state()
            bins = {b["id"]: b for b in s.draw.bins()}
            full = {int(x) for x in request.args.get("full", "").split(",") if x.strip().lstrip("-").isdigit()}
            uper = max(4, min(5000, int(request.args.get("uper", per))))  # the unsorted pile can have its own cap

            def cap(t):  # (sections you opened in full come whole)
                return by.get(t, []) if t in full else by.get(t, [])[:uper if t == -1 else per]
            groups = [{**g, "shots": cap(g["id"]), "count": len(by.get(g["id"], []))} for g in st["groups"]]
            part = [x for g in groups for x in g["shots"]] + cap(-1)
            out = {**st, "groups": groups, "bins": list(bins.values()),
                   "unsorted": {"shots": cap(-1), "count": len(by.get(-1, []))},
                   "boxes": {m: s.view.get(m, {}).get("box") for x in part for m in x["members"]}}
            if request.args.get("tags"):  # the tag sea: tags, circles, each shot's tags, suggested groups
                out["tagging"] = s.draw.tagging()
            return jsonify(_draw_reply(s, out))

    @flask_app.post("/api/tags/set")
    def tags_set():
        """Where you dropped a photo on the tag sea: the circles it's now in, and the ones it's now out of."""
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.set_tags([int(x) for x in b.get("photos", [])][:2000],
                                                          [str(t) for t in b.get("on", [])], [str(t) for t in b.get("off", [])])))

    @flask_app.post("/api/tags/meta")
    def tags_meta():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.tag_meta(str(b.get("key", "")), b.get("label"), b.get("emoji"),
                                                          b.get("hidden"), b.get("pinned"))))

    @flask_app.post("/api/tags/new")
    def tags_new():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.tag_new(str(b.get("label", "")), b.get("emoji"),
                                                         [int(x) for x in b.get("photos", [])][:2000])))

    @flask_app.post("/api/tags/group")
    def tags_group():
        """Make a suggested group: the intersection's shots that aren't in a group yet."""
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.tag_group([int(x) for x in b.get("photos", [])][:5000],
                                                                     b.get("name"), b.get("emoji"))}))

    @flask_app.post("/api/draw/order")
    def draw_order():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.reorder([int(x) for x in b.get("order", [])][:2000])))

    @flask_app.post("/api/draw/rename")
    def draw_rename():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            roll, emoji = b.get("roll"), b.get("emoji")
            return jsonify(_draw_reply(s, {"theme": s.draw.rename(int(b.get("theme", 0)), b.get("name"),
                                                                   int(roll) if roll is not None else None,
                                                                   str(emoji) if emoji is not None else None)}))

    @flask_app.post("/api/draw/hint")
    def draw_hint():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.set_hint(int(b.get("theme", 0)), b.get("hint"))}))

    @flask_app.post("/api/draw/call")
    def draw_call():
        s, b = sess(), body()
        ms = b.get("ms")
        with s.lock:
            _need(s)
            r = s.draw.call(int(b.get("theme", 0)), int(b.get("photo", 0)), str(b.get("call", "")),
                            int(b["twin"]) if b.get("twin") else None, int(ms) if isinstance(ms, (int, float)) else None)
        if r["stacks"]:
            _regroup(s)
        with s.lock:
            return jsonify(_draw_reply(s, r))

    @flask_app.post("/api/draw/bulk")
    def draw_bulk():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.bulk(int(b.get("theme", 0)), [int(x) for x in b.get("add", [])][:50],
                                                      [int(x) for x in b.get("reject", [])][:50])))

    @flask_app.post("/api/draw/seal")
    def draw_seal():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.seal(int(b.get("theme", 0)), bool(b.get("sealed", True)))}))

    @flask_app.post("/api/draw/auto")
    def draw_auto():
        s = sess()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.auto()))

    @flask_app.get("/api/draw/stragglers")
    def draw_stragglers():
        s = sess()
        with s.lock:
            _need(s)
            return jsonify(cards=s.draw.stragglers(), bins=s.draw.bins(), left=int(len(s.draw.unsorted())))

    @flask_app.post("/api/draw/toss")
    def draw_toss():
        """Quick sort's ←: out of the running, set aside as tossed (Z puts it back)."""
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.toss(int(b.get("photo", 0)))))

    @flask_app.post("/api/draw/place")
    def draw_place():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            t = b.get("theme")
            return jsonify(_draw_reply(s, s.draw.place(int(b.get("photo", 0)), int(t) if t is not None else None,
                                                       bool(b.get("wild")))))

    @flask_app.post("/api/draw/move")
    def draw_move():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            t = b.get("theme")
            return jsonify(_draw_reply(s, s.draw.move([int(x) for x in b.get("photos", [])][:500],
                                                      int(t) if t is not None else None)))

    @flask_app.post("/api/draw/merge")
    def draw_merge():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.merge_groups(int(b.get("from", 0)), int(b.get("into", 0)))}))

    @flask_app.post("/api/draw/dissolve")
    def draw_dissolve():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.dissolve(int(b.get("theme", 0)))))

    @flask_app.get("/api/draw/table/<int:tid>")
    def draw_table(tid):
        s = sess()
        with s.lock:
            _need(s)
            return jsonify(table=s.draw.table(tid))

    # -------- images
    def _img(sub: str, pid: int):
        s = sess()
        path = s.workdir / sub / f"{pid}.jpg"
        if not path.is_file():
            abort(404)
        resp = send_file(path, mimetype="image/jpeg", conditional=True, max_age=3600)
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    @flask_app.get("/img/p/<int:pid>.jpg")
    def preview(pid):
        return _img("previews", pid)

    @flask_app.get("/img/t/<int:pid>.jpg")
    def thumb(pid):
        return _img("thumbs", pid)

    @flask_app.get("/img/f/<int:fid>.jpg")
    def face(fid):
        s = sess()
        f = s.store.one("SELECT photo_id, x, y, w, h FROM faces WHERE id=?", (fid,))
        if f is None:
            abort(404)
        path = s.workdir / "previews" / f"{f['photo_id']}.jpg"
        if not path.is_file():
            abort(404)
        with Image.open(path) as im:
            W, H = im.size
            cx, cy = (f["x"] + f["w"] / 2) * W, (f["y"] + f["h"] / 2) * H
            half = max(f["w"] * W, f["h"] * H) * 0.8
            crop = im.crop((int(cx - half), int(cy - half), int(cx + half), int(cy + half))).convert("RGB")
            crop.thumbnail((160, 160))
            buf = io.BytesIO()
            crop.save(buf, "JPEG", quality=85)
        buf.seek(0)
        resp = send_file(buf, mimetype="image/jpeg", max_age=3600)
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    return flask_app
