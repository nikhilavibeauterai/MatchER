"""Local web app: pick a folder → automatic analysis → duels → shortlist → export."""
from __future__ import annotations

import hashlib
import hmac
from urllib.parse import quote
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from functools import wraps
from collections import Counter, OrderedDict
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath

import numpy as np
from flask import Flask, abort, g, jsonify, redirect, request, send_file, send_from_directory
from PIL import Image

from . import export as exporter
from . import touchup
from . import auto_look, edit_history, filtering, finishing, game, imageio, library, sea_axes, tags, tournament, visual
from .draw import Draw
from .search import PhotoSearch
from .sample import SampleFetcher
from .analyze import Analyzer, TooManyPhotos, list_photos
from .config import DATA_DIR, DEFAULT_SETTINGS, PHOTO_EXTS
from .ranker import W_BAR, W_FRAME, W_TOSS, Obs, Ranker
from .store import ClosedStoreError, Store, unblob
from .platforms import desktop_env, mounted_folders, open_directory

STATIC = Path(__file__).parent / "static"
DONE_QUALITY = 0.90      # ~450 duels in simulation; past this, more duels mostly reshuffle near-ties
MINI_MAX = 8             # usual sample size; a merge always makes room for its former distinct winners
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
        self.stack_lock = threading.RLock()  # membership edits publish their rebuild and Crown seeds together
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
        self._refresh_done = threading.Event()
        self._refresh_done.set()
        self._refresh_thread = None
        self._refresh_error = None
        self._subjects_thread = None
        self._looks_thread = None
        self.closed = False
        self._game_history = None
        self._game_revision = -1
        self._game_last = 0
        self._game_rewrite = -1
        self._game_cache = None
        self._mini_saved = self.store.get_meta("mini_state", {}) or {}
        self._minis_dirty = False
        self.followups = [tuple(p) for p in self._mini_saved.get("followups", [])]
        self.groups_cache: dict = {}
        self.stack_orders: dict = {}  # member slots survive cover changes, merges and their undo during this session
        self.draw = Draw(self)
        self.search = PhotoSearch(self.store)

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

    def _fill_subjects(self) -> None:
        """A library analysed before salient regions were kept gets them in the background, from its thumbnails;
        each photo without a face frame takes its subject frame as soon as it is measured."""
        if self._subjects_thread is not None or not self.store.one("SELECT 1 FROM photos WHERE status='analyzed' AND salient IS NULL LIMIT 1"):
            return

        def on_box(pid, box):
            entry = self.view.get(pid)
            if entry is not None and entry.get("box") is None:
                entry["box"] = box

        def run():
            try:
                library.fill_salient(self.store, self.workdir, cancel=lambda: self.closed, on_box=on_box)
            except Exception as e:  # a closed save, a missing thumbnail folder: the next open tries again
                self._subjects_error = e

        self._subjects_thread = threading.Thread(target=run, name="subjects", daemon=True)
        self._subjects_thread.start()

    def _fill_looks(self) -> None:
        if self._looks_thread is not None:
            return
        self._looks_after = 0
        def run():
            try:
                auto_look.fill_missing(self.store, self.workdir, cancel=lambda: self.closed,
                                       on_photo=lambda pid: setattr(self, "_looks_after", pid))
            except (ClosedStoreError, OSError):
                pass  # closing a library cancels its cache upgrade
        self._looks_thread = threading.Thread(target=run, name="auto-looks", daemon=True)
        self._looks_thread.start()

    def refresh_async(self, full: bool = True) -> None:
        """Refresh in the background (full=False: only the stacking changed, so just regroup). Requests that
        arrive mid-refresh coalesce into one more pass, so the last refresh always sees the latest choices."""
        def work():
            while True:
                with self._refresh_state:
                    if not self._refresh_dirty:
                        self._refresh_running = False
                        self._refresh_done.set()
                        return
                    self._refresh_dirty, full, self._refresh_full = False, self._refresh_full, False
                try:
                    (library.refresh if full else library.regroup)(self.store)
                    self._refresh_error = None
                except Exception as e:
                    self._refresh_error = str(e)
                finally:
                    self._invalidate()

        with self._refresh_state:
            if self.closed:
                return
            self._refresh_dirty = True
            self._refresh_full = self._refresh_full or full
            if self._refresh_running:
                return
            self._refresh_running = True
            self._refresh_done.clear()
            # Shutdown must see the worker before it can close the store underneath it.
            self._refresh_thread = threading.Thread(target=work, name="regroup", daemon=True)
            self._refresh_thread.start()

    def wait_refresh(self) -> None:
        self._refresh_done.wait()
        if self._refresh_error:
            raise ValueError(self._refresh_error)

    def shutdown(self) -> None:
        """Stop our workers before closing connections or removing their outputs."""
        with self._refresh_state:
            self.closed = True
        with self.analyzer._start_lock:
            self.analyzer.closed = True
            self.analyzer.cancel.set()
        for worker in (self.analyzer.thread, self._refresh_thread, self._subjects_thread, self._looks_thread):
            if worker and worker is not threading.current_thread():
                worker.join()
        with self.lock:
            library.release(self.store)
            if hasattr(self.analyzer, "_sig"):
                del self.analyzer._sig
            self.store.close()

    def _save_minis(self) -> None:
        self.store.set_meta("mini_state", {"minis": list(self.minis.values()), "followups": self.followups})
        self._minis_dirty = False

    def _mini_matches(self, gid: int, mini: dict) -> bool:
        """A round belongs to this exact stack and manual pick, not merely a surviving subset of its takes."""
        group = self.groups.get(gid)
        frames = mini.get("frames", [])
        if (not group or not 1 <= mini.get("next", 0) < len(frames) or mini.get("champ") not in frames
                or not set(frames) <= set(self.distinct.get(gid, ()))):
            return False
        basis = self.draw.snapshot(group["members"])
        if "basis" in mini:
            return mini["basis"] == basis
        # Old saves did not retain unsampled takes. Resume only when the complete membership is provable.
        return (set(frames) == set(group["members"])
                and mini.get("prev") == next((pid for pid, _, pref in basis if pref), None))

    @staticmethod
    def _distinct_takes(members, rows, preferred=()) -> list[int]:
        """Pixel twins get one place; retain the chosen file when one of them already earned it."""
        order = list(dict.fromkeys([pid for pid in preferred if pid in members] + list(members)))
        kept = []
        for pid in order:
            row = rows.get(pid)
            if row is None:
                continue
            h = int(row["phash"], 16) if row["phash"] else None
            if not any(row["sha256"] == sha or (h is not None and kh is not None and (h ^ kh).bit_count() <= 2)
                       for _, sha, kh in kept):
                kept.append((pid, row["sha256"], h))
        return [pid for pid, _, _ in kept]

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
        self._fill_subjects()
        self._fill_looks()
        self.distinct = {}
        saved = self._mini_saved.get("minis", []) + list(self.minis.values())
        seeds = {}
        for m in saved:
            for pid in m.get("seeds", []):
                seeds.setdefault(self.photo_group.get(pid), []).append(pid)
        for gid, g in self.groups.items():  # frames you could actually tell apart (not byte/pixel twins)
            self.distinct[gid] = self._distinct_takes(g["members"], rows, seeds.get(gid, []) if not g["checked"] else ())
        for row in self.store.q("SELECT id, group_id FROM photos WHERE rep_pref=1 AND group_id IS NOT NULL"):
            self._set_rep(row["group_id"], row["id"])
        self.version = ver
        self._mini_saved = {}
        self.minis = {}
        for m in saved:
            gid = self.photo_group.get((m.get("frames") or [None])[0])
            i = self.gidx.get(gid)
            if i is not None and self.base_active[i] and self._mini_matches(gid, m):
                m.setdefault("basis", self.draw.snapshot(self.groups[gid]["members"]))
                self.minis[gid] = m
        self._minis_dirty |= len(self.minis) != len(saved)
        for cid, card in list(self.cards.items()):
            if card["type"] in ("frame", "mini"):
                i = self.gidx.get(card["gid"])
                if (i is None or not self.ranker.active[i] or card["type"] == "mini" and card["gid"] not in self.minis):
                    del self.cards[cid]
                else:
                    card["item"] = i
        self._fit()
        return self.ranker

    def _set_rep(self, gid: int, pid: int) -> None:
        """Make `pid` the frame that represents shot `gid` from now on."""
        g = self.groups.get(gid)
        if g is None or pid not in g["members"]:
            return
        changed = g["rep"] != pid or not g["checked"]
        g["rep"], g["checked"] = pid, True
        i = self.gidx.get(gid)
        if i is not None:
            self.reps[i] = pid
        if changed:
            self.draw.changed()  # Stack covers, group rosters and the sea share this representative.

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
        before = self.ranker.post
        was = np.argsort(np.argsort(-before.mu)) if before is not None else None
        obs, self.compared, self.recent = self._observations()
        self.n_votes = len(self.store.votes())
        self.ranker.fit(obs)
        self._conf_cache = None
        self.learning = None
        if before is not None:
            post = self.ranker.post
            delta = post.w[:self.n_hand] - before.w[:self.n_hand]
            features = [{"feature": self.names[int(i)], "up": bool(delta[i] > 0)}
                        for i in np.argsort(-abs(delta))[:2] if abs(delta[i]) > 0.002]
            moved = int(np.sum((was != np.argsort(np.argsort(-post.mu))) & (before.n_obs == 0) & self.ranker.active))
            if features or moved:
                self.learning = {"features": features, "unseen": moved}

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
        if self._minis_dirty:
            self._save_minis()
        busy = []  # shots on cards already headed to the screen: never put them on another card
        for cid in pending:
            c = self.cards.get(cid)
            if c and c["type"] == "duel":
                busy += [c["ia"], c["ib"]]
            elif c and c["type"] in ("frame", "mini") and self.gidx.get(c["gid"]) is not None:
                busy.append(self.gidx[c["gid"]])
        out = []
        if stage == "stacks":
            priority = self.gidx.get(self.priority)
            self.priority = None
            order = self.stacks_left()
            if priority is not None and r.active[priority]:
                order = [priority] + [i for i in order if i != priority]
            for i in order:
                if len(out) >= n:
                    break
                if i not in busy and (i == priority or self._needs_frame(i)) and (card := self._mini(i)) is not None:
                    busy.append(i)
                    out.append(self._public(card))
            return out
        if stage == "groups":
            for _ in range(n):
                card = self._followup(busy, stage="groups")
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
        if stage == "knockouts":
            if not self.knockouts_state():
                self.knockouts_start()
            card = self.knockouts_card(getattr(self, "ko_focus", None)) or self.knockouts_card()
            self.ko_focus = None
            return [self._public(card)] if card else []
        for _ in range(n):
            card = None
            if self.priority is not None:
                gid, self.priority = self.priority, None
                if self.gidx.get(gid) is not None and self.gidx[gid] not in busy:
                    card = self._mini(self.gidx[gid])
            if card is None:
                card = self._followup(busy)
            if card is None:
                pair = r.next_pair(self.recent, self.compared, explore=self._explore(), exclude=set(busy))
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
            self._save_minis()
            return card
        return self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib])

    def stacks_left(self) -> list[int]:
        """Stacks in this cup still waiting for their best frame (round one of the journey), likeliest to make the
        top first."""
        r = self.ranker
        if r is None or r.post is None:
            return []
        # Most libraries are loose photos. Only a real stack can still need a crown; visiting every active
        # photo on each HUD, board and paging request made these reads grow with the whole collection.
        left = [i for gid in self.distinct if len(self.distinct[gid]) >= 2
                and (i := self.gidx.get(gid)) is not None and r.active[i] and self._needs_frame(i, include_queued=True)]
        return sorted(left, key=lambda i: -r.post.p_in[i])

    def twins_left(self) -> int:
        """Pairs of shots that look like the same shot but aren't stacked, still to check (the Stacks stage)."""
        key = (self.store.get_meta("state_version"), len(self.store.get_meta("stack_dismissed", []) or []))
        if getattr(self, "_twins", (None,))[0] != key:
            self._twins = (key, library.suggest_merges(self.store, with_total=True)[1])
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
                c.executemany("UPDATE photos SET rep_pref=0 WHERE id=?", [(m,) for m in members])
                c.executemany("UPDATE photos SET rep_pref=1 WHERE id=?", [(g["rep"],) for g in stacks])
            self.refresh_async(full=False)
        self.wait_refresh()
        with self.lock:
            self.ensure_ranker(wait=True)
            if self._minis_dirty:
                self._save_minis()
        return len(stacks)

    def forget_unshown_frames(self, keep: list[str] = ()) -> None:
        """The browser threw its queue away (reload, undo): frame questions in it will be asked again."""
        for cid in [k for k, c in self.cards.items() if c["type"] in ("frame", "mini") and k not in keep]:
            del self.cards[cid]  # a stack mid-tournament resumes at the same round next time it comes up

    def _followup(self, busy: list[int], stage: str | None = None) -> dict | None:
        """A duel that was held back for a frame question, once nothing about it is still on its way."""
        r = self.ranker
        for k, (pa, pb) in enumerate(self.followups):
            ia, ib = self._item(pa), self._item(pb)
            if (ia is None or ib is None or ia == ib or not (r.active[ia] and r.active[ib])
                    or stage == "groups" and self.draw.group_of(ia, ib) is None):
                self.followups.pop(k)
                self._save_minis()
                return self._followup(busy, stage)
            if ia in busy or ib in busy:
                continue
            unpicked = [i for i in (ia, ib) if self._needs_frame(i)]
            if unpicked:
                card = self._mini(unpicked[0], pair=(ia, ib))
                if card is not None:
                    return card
            self.followups.pop(k)
            self._save_minis()
            return self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib])
        return None

    def _needs_frame(self, i: int, include_queued: bool = False) -> bool:
        g = self.groups.get(self.gids[i])
        if not g or (g["checked"] and self.gids[i] not in self.minis) or len(self.distinct.get(self.gids[i], ())) < 2:
            return False
        return include_queued or not any(c["type"] in ("frame", "mini") and c["gid"] == self.gids[i] for c in self.cards.values())

    # ------------------------------------------------------------------ mini-tournaments
    def crown_seeds(self, rows: list) -> list[int]:
        """Remember chosen takes before a membership edit clears the old crowns."""
        seeds = [pid for pid, _, pref in rows if pref]
        for gid in dict.fromkeys(self.photo_group.get(pid) for pid, _, _ in rows):
            seeds += self.minis.get(gid, {}).get("seeds", [])
        return list(dict.fromkeys(seeds))

    def _new_mini(self, gid: int, seeds=()) -> bool:
        g = self.groups[gid]
        if seeds:
            rows = {r["id"]: r for r in self.store.q("SELECT id, sha256, phash FROM photos WHERE group_id=?", (gid,))}
            self.distinct[gid] = self._distinct_takes(g["members"], rows, seeds)
        distinct = self.distinct.get(gid, [])
        seeds = [pid for pid in dict.fromkeys(seeds) if pid in distinct]
        ranked = sorted(distinct, key=lambda m: m != g["rep"])
        frames = (seeds + [pid for pid in ranked if pid not in seeds])[:max(MINI_MAX, len(seeds))]
        if len(frames) < 2:
            return False
        basis = self.draw.snapshot(g["members"])
        self.minis[gid] = {"frames": frames, "next": 1, "champ": frames[0], "beaten": [], "seeds": seeds,
                           "prev": next((pid for pid, _, pref in basis if pref), None), "held": None, "basis": basis}
        return True

    def seed_crowns(self, members, seeds) -> None:
        """Prepare edited stacks before another restart or merge can forget their former winners."""
        if not seeds:
            return
        for gid in dict.fromkeys(self.photo_group.get(pid) for pid in members):
            i = self.gidx.get(gid)
            if (i is not None and self.base_active[i] and not self.groups[gid]["checked"]
                    and set(seeds) & set(self.groups[gid]["members"])):
                self._new_mini(gid, seeds)
        self._save_minis()

    def _mini(self, i: int, pair: tuple[int, int] | None = None) -> dict | None:
        """King of the hill among a stack's frames: the current pick defends against each challenger."""
        gid = self.gids[i]
        g = self.groups.get(gid)
        if not g or not self.ranker.active[i]:
            return None
        if gid in self.minis and not self._mini_matches(gid, self.minis[gid]):
            del self.minis[gid]
        if gid not in self.minis and not self._new_mini(gid):
            return None
        if pair and not self.minis[gid]["held"]:
            self.minis[gid]["held"] = [self.reps[pair[0]], self.reps[pair[1]]]
        self._save_minis()
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
        i = self.gidx.get(gid)
        if (m is None or i is None or not self.ranker.active[i] or not self._mini_matches(gid, m)
                or m["champ"] != card["champ"] or m["frames"][m["next"]] not in (card["a"], card["b"])):
            self.minis.pop(gid, None)
            self._save_minis()
            abort(409, "That round is out of date; reloading.")
        champ, challenger = m["champ"], m["frames"][m["next"]]
        if outcome == "skip":
            # Defer the challenger, preserving every unresolved take and the number of actual decisions.
            frames = list(m["frames"])
            frames.append(frames.pop(m["next"]))
            m["frames"] = frames
            self._save_minis()
            return {"skipped": True, "mini": {"skipped": True}, "cards": [self._public(self._mini_card(gid))],
                    "progress": self.progress()}
        if outcome not in ("a", "b"):
            abort(400, "Choose a take or skip this comparison.")
        winner = card["a"] if outcome == "a" else card["b"]
        self.store.add_vote("fduel", card["a"], card["b"], winner, ms,
                            extra={"gid": gid, "frames": m["frames"], "step": m["next"], "champ": champ,
                                   "beaten": m["beaten"], "held": m["held"], "prev": m["prev"], "basis": m["basis"],
                                   "seeds": m.get("seeds", []), **({"lr": lr} if lr else {})})
        m["beaten"] = m["beaten"] + [challenger if winner == champ else champ]
        m["champ"], m["next"] = winner, m["next"] + 1
        self._save_minis()
        self._fit()
        result = {"mini": {"winner": winner, "defended": winner == champ}}
        if m["next"] < len(m["frames"]):
            return {**result, "cards": [self._public(self._mini_card(gid))], "progress": self.progress()}
        # Last challenger done: crown the champion, then play the duel this stack was holding up.
        del self.minis[gid]
        self._save_minis()
        g = self.groups.get(gid)
        stack = g["members"] if g else m["frames"]
        before = g["rep"] if g else m["frames"][0]
        brackets = tournament.capture(self.store)
        with self.store.tx() as c:
            c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
            c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (winner,))
            c.execute("UPDATE groups SET rep=?, frame_checked=1 WHERE id=?", (winner, gid))
        self.store.add_vote("frame", before, None, winner, None,
                            extra={"frames": m["frames"], "stack": stack, "prev": m["prev"], "held": m["held"], "mini": True, "flawless": len(m["beaten"]) >= 2 and winner not in m["beaten"],
                                   "overruled": winner != before, "after_basis": self.draw.snapshot(stack), "tournaments": brackets})
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
                "crowned": {"photo": winner, "frames": m["frames"], "overruled": winner != before}}

    def _mini_restore(self, extra: dict) -> dict | None:
        """Put a stack's tournament back to the round recorded in a mini vote (for undo)."""
        gid = self.photo_group.get(extra["frames"][0], extra["gid"])
        if gid not in self.groups or gid not in self.gidx:
            return None
        restored = {"frames": extra["frames"], "next": extra["step"], "champ": extra["champ"],
                    "beaten": extra.get("beaten") or [], "prev": extra.get("prev"), "held": extra.get("held"),
                    "seeds": extra.get("seeds", []),
                    **({"basis": extra["basis"]} if "basis" in extra else {})}
        if not self.base_active[self.gidx[gid]] or not self._mini_matches(gid, restored):
            return None
        restored.setdefault("basis", self.draw.snapshot(self.groups[gid]["members"]))
        self.minis[gid] = restored
        held = extra.get("held")
        if held:
            pair = (held[0], held[1])
            self.followups = [pair] + [f for f in self.followups if f != pair]
        self._save_minis()
        return self._mini_card(gid) if self.ranker.active[self.gidx[gid]] else None

    def crown_now(self, pid: int) -> bool:
        gid = self.photo_group.get(pid)
        i = self.gidx.get(gid)
        if gid not in self.groups or i is None or not self.ranker.active[i] or len(self.distinct.get(gid, ())) < 2:
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
        return {**v, "frames": len(self.distinct.get(self.photo_group.get(pid), ())) if g else 1,
                "members": g["members"] if g else [pid]}

    def _public(self, card: dict) -> dict:
        if card["type"] == "mini":
            return {"id": card["id"], "type": "mini", "a": card["a"], "b": card["b"], "champ": card["champ"],
                    "round": card["round"], "total": card["total"], "frames": card["frames"], "beaten": card["beaten"],
                    "photos": {m: self.photo_view(m) for m in card["frames"]}}
        if card["type"] in ("duel", "final", "knockout"):
            out = {"id": card["id"], "type": card["type"], "a": card["a"], "b": card["b"],
                   "photos": {card["a"]: self.photo_view(card["a"]), card["b"]: self.photo_view(card["b"])}}
            if card["type"] == "final":
                out.update(round=card["round"], label=ROUNDS[card["round"]], match=card["match"], cup=card["cup"])
            if card["type"] == "knockout":
                out.update(round=card["round"], label=f"Round of {card['round']}", match=card["match"], cup=card["cup"])
            ranks = self._ranks([self._item(card["a"]), self._item(card["b"])])
            out["ranks"] = {p: ranks.get(self._item(p)) for p in (card["a"], card["b"])}
            history = next((v for v in reversed(self.store.votes()) if v["kind"] == "duel" and
                            {v["a"], v["b"]} == {card["a"], card["b"]}), None)
            out["commentary"] = (f"Rematch: {'left' if history['winner'] == card['a'] else 'right'} won last time" if history
                                  else "Debut" if any(self.ranker.post.n_obs[self._item(p)] == 0 for p in (card["a"], card["b"]) if self._item(p) is not None)
                                  else " · ".join(f"#{ranks.get(self._item(p), '–')}" for p in (card["a"], card["b"])))
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
            if outcome not in {"a", "b", "great", "meh", "skip", "toss_a", "toss_b", "frame"}:
                abort(400, "Unknown outcome.")
            self.ensure_ranker()
            card = self.cards.get(cid)
            if cid.startswith("final:"):
                current = self.finals_view().get("card")
                card = current if current and current["id"] == cid else None
            if cid.startswith("ko:"):
                try:
                    match = int(cid.rsplit(":", 1)[1])
                except ValueError:
                    match = -1
                current = self.knockouts_card(match)
                card = current if current and current["id"] == cid else None
            if card is None:
                abort(409, "That card expired; reloading.")
            self.cards.pop(cid, None)
            if card["type"] == "mini":
                return self._mini_vote(card, outcome, ms, pending, stage, lr)
            if card["type"] == "final":
                return self._final_vote(card, outcome, ms)
            if card["type"] == "knockout":
                return self.knockouts_vote(card, outcome, ms, stage)
            if card["type"] == "frame":
                gid = card["gid"]
                pick = choice if choice in card["members"] else card["current"]
                stack = (self.groups.get(gid) or {}).get("members") or card["members"]
                brackets = tournament.capture(self.store)
                with self.store.tx() as c:
                    prev = c.execute(f"SELECT id FROM photos WHERE rep_pref=1 AND id IN ({','.join('?' * len(stack))})",
                                     stack).fetchone()
                    c.execute(f"UPDATE photos SET rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})", stack)
                    c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (pick,))
                self.store.add_vote("frame", card["current"], None, pick, ms,
                                    extra={"frames": card["members"], "stack": stack,
                                           "prev": prev["id"] if prev else None, "held": card.get("held"),
                                           "after_basis": self.draw.snapshot(stack), "tournaments": brackets})
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
                extra = {k: v for k, v in (("lr", lr), ("group", group)) if v is not None}
                items = [self._item(a), self._item(b)]
                was = self._ranks(items)
                rematch = None not in items and (min(items), max(items)) in self.compared
                story = None
                if outcome in ("a", "b") and None not in items:
                    wi, li = (items[0], items[1]) if outcome == "a" else (items[1], items[0])
                    prior = next((v for v in reversed(self.store.votes()) if v["kind"] == "duel" and {v["a"],v["b"]} == {a,b}), None)
                    if prior and prior["winner"] != (a if outcome == "a" else b):
                        story = "revenge"
                    elif wi in was and li in was and was[wi] - was[li] >= 5:
                        story = "upset"
                    elif rematch:
                        story = "rematch"
                    extra["story"] = story
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
        brackets = tournament.capture(self.store)
        with self.store.tx() as c:
            c.execute(f"UPDATE photos SET override='toss' WHERE id IN ({','.join('?' * len(members))})", members)
        vote = self.store.add_vote("toss", pid, other, None, ms, extra={"members": members, "card": card, "tournaments": brackets})
        i = self._item(pid)
        if i is not None:
            self.ranker.active[i] = self.base_active[i] = False
            self.ranker.n_active = int(self.ranker.active.sum())
        self._fit()
        self.refresh_async()
        return vote, list(members)

    def undo(self, stage: str | None = None) -> dict:
        """Restore a call under the lock, rebuild off it, then replay the precise question."""
        with self.lock:
            v = self.store.one("SELECT * FROM votes WHERE undone=0 AND kind != 'draw' ORDER BY id DESC LIMIT 1")
            history = self.store.get_meta("group_history", []) or []
            latest = history[-1] if history else {}
            qualification = latest.get("qualification")
            if stage == "groups" and qualification and qualification["cup"] == self.cup and (not v or v["id"] <= qualification["vote_after"]):
                step = self.draw.undo()
                tournament.reconcile(self.store)
                tournament.restore(self.store, step.get("tournaments"))
                self.cards.clear()
                return {"cards": self.next_cards(2, stage=stage), "progress": self.progress(), "undone": "qualification"}
            if v is None:
                self.forget_unshown_frames()
                return {"cards": self.next_cards(2, stage=stage), "progress": self.progress(), "undone": None}
            extra = json.loads(v["extra"] or "{}")
            restorable = tournament.restorable(self.store, extra.get("tournaments"))
            kind, rnd = v["kind"], None
            mini = kind == "fduel" or (kind == "frame" and extra.get("mini"))
            restore_frame = True
            if kind == "frame":
                group = self.groups.get(self.photo_group.get(v["winner"]))
                members = group["members"] if group else []
                basis = self.draw.snapshot(members)
                # Undo the teaching, but never overwrite a later stack edit or manual cover choice.
                restore_frame = (set(members) == set(extra.get("stack") or extra.get("frames") or [])
                                 and [pid for pid, _, pref in basis if pref] == [v["winner"]]
                                 and ("after_basis" not in extra or extra["after_basis"] == basis))
            with self.store.tx() as c:
                c.execute("UPDATE votes SET undone=1 WHERE id=?", (v["id"],))
                if kind == "sweep":
                    # Filter and later explicit choices can outlive this older Sweep call.
                    if extra.get("change"):
                        expected = "keep" if extra["change"] == "keep" else "toss"
                        c.executemany("UPDATE photos SET override=? WHERE id=? AND override=?",
                                      [(o, int(m), expected) for m, o in (extra.get("prev") or {}).items()])
                elif kind == "toss":
                    c.executemany("UPDATE photos SET override=NULL WHERE override='toss' AND id=?",
                                  [(m,) for m in (extra.get("members") or [v["a"]])])
                elif kind == "frame":
                    if restore_frame:
                        c.executemany("UPDATE photos SET rep_pref=0 WHERE id=?",
                                      [(m,) for m in (extra.get("stack") or [v["winner"]])])
                        if extra.get("prev"):
                            c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (extra["prev"],))
                    if mini:
                        rnd = c.execute("SELECT * FROM votes WHERE undone=0 AND kind='fduel' AND id<? ORDER BY id DESC LIMIT 1",
                                        (v["id"],)).fetchone()
                        if rnd:
                            c.execute("UPDATE votes SET undone=1 WHERE id=?", (rnd["id"],))
            if kind == "duel" and extra.get("final"):
                now = self.finals_state(extra["final"]) or {}
                if now and now.get("id") == extra.get("bracket"):
                    self.store.set_meta(f"finals:{extra['final']}", extra["before"])
                    champions = self.store.get_meta("champions", {}) or {}
                    previous = (extra.get("champs_before") or {}).get(extra["final"])
                    if previous is None:
                        champions.pop(extra["final"], None)
                    else:
                        champions[extra["final"]] = previous
                    self.store.set_meta("champions", champions)
                self._fit()
                return {**self.finals_view(extra["final"]), "cards": [], "progress": self.progress(), "undone": "final"}
            if kind == "duel" and extra.get("knockout"):
                now = self.store.get_meta(f"knockouts:{extra['knockout']}") or {}
                if now and now.get("id") == extra.get("bracket"):
                    tournament.retire(self.store, [extra["knockout"]], kinds=("finals",))
                    self.store.set_meta(f"knockouts:{extra['knockout']}", extra["before"])
                    self.cards.clear()
                self._fit()
                match = next((k for k, m in enumerate(extra["before"]["rounds"][-1]["matches"])
                              if m["a"] == v["a"] and m["b"] == v["b"]), None)
                card = self.knockouts_card(match)
                return {"cards": [self._public(card)] if card else [], "progress": self.progress(), "undone": "knockout"}
            refresh = kind == "toss" or (kind == "frame" and restore_frame) or (kind == "sweep" and extra.get("change"))
            if refresh:
                self.refresh_async(full=kind != "frame")
        if refresh:
            self.wait_refresh()
        with self.lock:
            r = self.ensure_ranker(wait=True)
            self._fit()
            if restore_frame:
                tournament.restore(self.store, restorable)
            self.forget_unshown_frames()
            cards = []
            if mini:
                replay = json.loads(rnd["extra"]) if rnd else extra if kind == "fduel" else None
                card = self._mini_restore(replay) if replay and restore_frame else None
                if card:
                    cards.append(self._public(card))
            elif r is not None and kind in ("duel", "great", "meh", "skip", "toss"):
                left, right = (extra.get("card") or [v["a"], v["b"]]) if kind == "toss" else (v["a"], v["b"])
                ia, ib = self._item(left), self._item(right)
                if ia is not None and ib is not None and ia != ib and r.active[ia] and r.active[ib]:
                    group = self.draw.group_of(ia, ib) if stage == "groups" else None
                    cards.append(self._public(self._card("duel", ia=ia, ib=ib, a=self.reps[ia], b=self.reps[ib], group=group)))
            elif r is not None and kind == "frame" and restore_frame:
                i = self._item(v["winner"])
                if i is not None and (card := self._mini(i)):
                    cards.append(self._public(card))
            cards += self.next_cards(2 - len(cards), [c["id"] for c in cards], stage)
            return {"cards": cards, "progress": self.progress(), "undone": "mini" if mini or kind == "frame" else kind,
                    **({"photo": v["a"]} if kind == "sweep" else {})}

    # ------------------------------------------------------------------ views
    def progress(self) -> dict:
        r = self.ranker
        if r is None or r.post is None:
            return {}
        if self._conf_cache is None or self._conf_cache[0] != self.store.vote_revision:
            self._conf_cache = (self.store.vote_revision, r.quality())
        _, quality = self._conf_cache
        merge_key = (self.version, self.draw.ver)
        if getattr(self, "_merged", (None,))[0] != merge_key:
            self._merged = (merge_key, self.store.one("SELECT COUNT(DISTINCT stack_key) AS n FROM photos WHERE stack_key LIKE 'm:%'")["n"])
        merged = self._merged[1]
        exported = int(any((self.workdir / "exports").glob("*-2*")))
        earned = self.store.get_meta("achievements", []) or []
        dj = self.draw.journey()
        drawn = {"all": dj["draw"]["done"], "groups_done": dj["groups"]["settled"] - dj["groups"].get("selected", 0), "stage_done": dj["groups"]["done"]}
        drawn["filter_done"] = filtering.stage(self.store)["done"]
        reviews = self.store.get_meta("filter_reviews", []) or []
        drawn["filter_reviewed"] = len({r.get("family") or f"p:{r['photo']}" for r in reviews})
        considered = set(self.store.get_meta("filter_considered") or [r["photo"] for r in reviews])
        eligibility_version = self.store.get_meta("state_version")
        if not hasattr(self, "_filter_eligible") or self._filter_eligible[0] != eligibility_version:
            self._filter_eligible = (eligibility_version, {r["id"] for r in self.store.q("SELECT id FROM photos WHERE status IN ('analyzed','error')")})
        eligible = self._filter_eligible[1]
        drawn["filter_considered"], drawn["filter_total"] = len(considered & eligible), len(eligible)
        crown_left = len(self.stacks_left())
        drawn.update(crown_done=not crown_left, knockout_done=quality >= DONE_QUALITY)
        ko = self.knockouts_state() or {}
        # Advancers who go straight into the bracket never played an elimination round: no stage bonus for that.
        drawn["knockout_done"] = bool(ko.get("qualified")) and bool(ko.get("rounds"))
        if self._game_history is None or self._game_rewrite != self.store.vote_rewrite:
            self._game_history, self._game_last = game.History(), 0
        if self._game_revision != self.store.vote_revision:
            rows = self.store.q("SELECT * FROM votes WHERE id>? ORDER BY id", (self._game_last,))
            self._game_history.extend([dict(v) for v in rows])
            if rows:
                self._game_last = rows[-1]["id"]
            self._game_revision, self._game_rewrite = self.store.vote_revision, self.store.vote_rewrite
        history = self._game_history
        drawn["comeback"] = bool(history.rescued & {self.reps[int(i)] for i in np.flatnonzero(r.active)[np.argsort(-r.post.mu[r.active])][:8]})
        play = game.stats(self._game_history, quality, merged, exported, mode=self.mode, earned=earned, drawn=drawn)
        play["welcomed"] = bool(self.store.get_meta("welcomed"))
        return {"votes": history.duels, "quality": round(quality, 3), "game": play, "crown_left": crown_left,
                "learning": getattr(self, "learning", None),
                "done": bool(r.done() or quality >= DONE_QUALITY),
                "shots": int(r.n_active), "k": r.k, "seen": int(((r.post.n_obs > 0) & r.active).sum()),
                "minutes": round(history.active_ms / 60000, 1), "started": history.first}

    def leaderboard_order(self) -> tuple[list[int], list[int]]:
        """Read the current board without loading or fitting the ranker just to open a photo's sticky."""
        r = self.ranker
        if r is None or r.post is None:
            return [], []
        top = r.select(r.post.mu)
        settled = [i for i in (self._item(pid) for pid in self.finals_order()) if i is not None and r.active[i]]
        if settled:  # the finals have the last word on the top of the board
            top = (settled + [i for i in top if i not in settled])[:max(r.k, len(settled))]
        return top, settled

    def shortlist(self) -> dict:
        r = self.ensure_ranker()
        if r is None:
            return {"items": [], "bubble": [], "added": []}
        mu, p = r.post.mu, r.post.p_in
        top, settled = self.leaderboard_order()
        chosen = set(top)
        favorites = list(dict.fromkeys(self.gidx[self.photo_group[row["id"]]] for row in self.store.q("SELECT id FROM photos WHERE pick=1")
                        if self.photo_group.get(row["id"]) in self.gidx and r.active[self.gidx[self.photo_group[row["id"]]]]))
        favorite_set = set(favorites)
        bubble = [int(i) for i in np.argsort(-mu) if r.active[i] and i not in chosen][:24]
        info = {}
        needed = set(self.reps[i] for i in top + bubble + favorites)
        needed = sorted(needed)
        for start in range(0, len(needed), 500):
            part = needed[start:start + 500]
            info.update((row["id"], row) for row in self.store.q(
                "SELECT id, rel, taken, flags, prior, pick, edits FROM photos WHERE id IN (%s)" % ",".join("?" * len(part)), part))

        def item(i, rank=None):
            pid = self.reps[i]
            row = info.get(pid)
            g = self.groups.get(self.gids[i], {})
            return {"photo": pid, "rank": rank, "p_in": round(float(p[i]), 3), "appeal": round(float(mu[i]), 3),
                    "duels": int(r.post.n_obs[i]), "frames": len(g.get("members", [pid])), "scene": int(r.scenes[i]),
                    "members": [int(m) for m in g.get("members", [pid])[:5]],  # the cover and its under-prints
                    "edits": json.loads(row["edits"]) if row and row["edits"] else {},  # the Leaderboard's touch-up choices
                    "flags": json.loads(row["flags"]) if row and row["flags"] else [], "rel": row["rel"] if row else "",
                    "taken": row["taken"] if row else None, "added": i in favorite_set,
                    "rescued": bool(row and any(f.startswith("rescued:") for f in json.loads(row["flags"] or "[]"))),
                    "box": self.view.get(pid, {}).get("box")}

        added = [item(i) for i in favorites if i not in chosen]
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
            rows = [{"rel": it["rel"], "rank": it["rank"], "edits": it.get("edits") or {}, "box": it.get("box")} for it in sl["items"]]
            rows += [{"rel": it["rel"], "rank": None, "edits": it.get("edits") or {}, "box": it.get("box")} for it in sl["added"]]
            recipes = {r["rel"]: json.loads(r["auto_look"] or "null") for r in self.store.q("SELECT rel,auto_look FROM photos WHERE auto_look IS NOT NULL")}
            for row in rows:
                row["auto_look"] = recipes.get(row["rel"])
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
            self.priority, self.version = None, None
            self.ensure_ranker()

    def sweep_cards(self, with_views=True) -> list[dict]:
        """Quick keep-or-toss calls where the sorter was least sure: set-aside photos that look like they might be
        fine (highest prior first) and shots in the running that look most like junk (lowest prior first)."""
        r = self.ranker
        if r is None:
            return []
        connection = self.store.conn()
        key = (filtering._preview_stamp(self, connection), self.version, self.cup)
        cached = getattr(self, "_sweep_cache", None)
        if cached is not None and cached[0] == key:
            return [{**c, "view": self.photo_view(c["photo"])} for c in cached[1]] if with_views else cached[1]
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
        self._sweep_cache = (key, out)
        return [{**c, "view": self.photo_view(c["photo"])} for c in out] if with_views else out

    def sweep(self, pid: int, keep: bool) -> dict:
        with self.lock:
            row = self.store.one("SELECT id, cut, override FROM photos WHERE id=?", (pid,))
            if row is None:
                abort(404, "Unknown photo.")
            g = self.photo_group.get(pid)
            members = (self.groups.get(g) or {}).get("members", [pid]) if row["cut"] is None else [pid]
            prev = {str(r_["id"]): r_["override"] for r_ in self.store.q(
                f"SELECT id, override FROM photos WHERE id IN ({','.join('?' * len(members))})", members)}
            brackets = tournament.capture(self.store)
            change = "keep" if keep and row["cut"] is not None else "toss" if not keep and row["cut"] is None else None
            if change:
                with self.store.tx() as c:
                    c.execute(f"UPDATE photos SET override=? WHERE id IN ({','.join('?' * len(members))})",
                              [change, *members])
            self.store.add_vote("sweep", pid, None, None, None, extra={"keep": keep, "prev": prev, "change": change, "tournaments": brackets})
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
                                                       "basis": tournament.basis(self.store, self.cup),
                                                       "id": secrets.token_hex(4)})
            return self.finals_view()

    def _finals_seeds(self, r) -> list[int]:
        """Who goes into the bracket if it's seeded now: the leaderboard's top 8 (or 4), best first."""
        ko = self.knockouts_state() or {}
        if ko.get("qualified"):
            qualified = [p for p in ko["qualified"] if self._item(p) is not None and r.active[self._item(p)]]
            size = 8 if len(qualified) >= 8 else 4 if len(qualified) >= 4 else 0
            return qualified[:size]
        top = [int(i) for i in r.select(r.post.mu)]
        top += [int(i) for i in np.argsort(-r.post.mu) if r.active[i] and int(i) not in top]
        size = 8 if len(top) >= 8 else 4 if len(top) >= 4 else 0
        return [self.reps[i] for i in top[:size]]

    def knockouts_state(self) -> dict | None:
        state = self.store.get_meta(f"knockouts:{self.cup}")
        # Old small fields stopped at three qualifiers; the next deal reseeds that impossible final.
        if state and 0 < len(state.get("qualified", [])) < 4 and self.ranker.n_active >= 4:
            return None
        return state

    def _knockout_seeds(self) -> list[int]:
        """Who the elimination rounds would seed right now: each group's advancers, plus shots in no group."""
        r = self.ranker
        groups = self.draw.stage()["groups"]
        eligible = {int(i) for g in groups.values() for i in g["order"][:g["adv"]]} if groups else set(np.flatnonzero(r.active))
        eligible.update(int(i) for i in np.flatnonzero(r.active & (self.draw.theme_of() < 0)))
        return [self.reps[int(i)] for i in np.argsort(-r.post.mu) if r.active[i] and int(i) in eligible]

    @staticmethod
    def _knockouts_direct(n: int) -> bool:
        """With this many seeds the advancers go straight into a bracket (4, or exactly 8): nothing to eliminate."""
        return n <= 4 or n == 8

    def knockouts_start(self) -> dict:
        """Seed the group advancers into elimination rounds; byes keep the bracket fair on any folder size."""
        seeds = self._knockout_seeds()
        target = 8 if len(seeds) >= 8 else 4
        st = {"id": secrets.token_hex(6), "cup": self.cup, "seeds": seeds, "rounds": [], "target": target,
              "basis": tournament.basis(self.store, self.cup),
              "qualified": seeds if len(seeds) <= target else []}
        if len(seeds) > target:
            size = 1 << (len(seeds)-1).bit_length()
            order = [1, 2]
            while len(order) < size:
                order = [x for seed in order for x in (seed, 2*len(order)+1-seed)]
            slots = [seeds[i-1] if i <= len(seeds) else None for i in order]
            matches = [{"a": a, "b": b, "winner": a or b if not a or not b else None, "bye": not a or not b}
                       for a, b in zip(slots[::2], slots[1::2])]
            st["rounds"].append({"size": size, "matches": matches})
        self.store.set_meta(f"knockouts:{self.cup}", st)
        return st

    def knockouts_card(self, match: int | None = None) -> dict | None:
        st = self.knockouts_state()
        if not st or st.get("qualified") or not st["rounds"]:
            return None
        rnd = st["rounds"][-1]
        matches = rnd["matches"]
        start = rnd.get("next", 0) % len(matches)
        for k in list(range(start, len(matches))) + list(range(start)):
            m = matches[k]
            if (match is None or match == k) and m["a"] and m["b"] and not m["winner"]:
                return {"id": f"ko:{st['id']}:{rnd['size']}:{k}", "type": "knockout", "match": k,
                        "a": m["a"], "b": m["b"], "round": rnd["size"], "cup": self.cup}
        return None

    def knockouts_vote(self, card, outcome, ms, stage):
        if outcome not in ("a", "b", "skip"):
            abort(400, "An elimination match needs a winner.")
        st = self.store.get_meta(f"knockouts:{card['cup']}")
        before = json.loads(json.dumps(st))
        m = st["rounds"][-1]["matches"][card["match"]]
        if outcome == "skip":
            st["rounds"][-1]["next"] = card["match"] + 1
            self.store.set_meta(f"knockouts:{card['cup']}", st)
            nxt = self.knockouts_card()
            return {"cards": [self._public(nxt)] if nxt else [], "progress": self.progress(), "knockouts": st, "skipped": True}
        winner, loser = (m["a"], m["b"]) if outcome == "a" else (m["b"], m["a"])
        m["winner"] = winner
        if all(x["winner"] for x in st["rounds"][-1]["matches"]):
            advancing = [x["winner"] for x in st["rounds"][-1]["matches"]]
            if len(advancing) <= st.get("target", 8):
                st["qualified"] = sorted(advancing, key=st["seeds"].index)
            else:
                st["rounds"].append({"size": len(advancing), "matches": [
                    {"a": a, "b": b, "winner": None, "bye": False} for a, b in zip(advancing[::2], advancing[1::2])]})
        upset = st["seeds"].index(winner) > st["seeds"].index(loser)
        self.store.add_vote("duel", m["a"], m["b"], winner, ms, extra={"knockout": card["cup"], "before": before,
                            "bracket": st["id"], "story": "upset" if upset else None, "round": card["round"]})
        self.store.set_meta(f"knockouts:{card['cup']}", st)
        self._fit()
        nxt = self.knockouts_card()
        return {"cards": [self._public(nxt)] if nxt else [], "progress": self.progress(), "knockouts": st,
                "story": "giant-killer" if upset else "into-finals" if st["qualified"] else None,
                "ranks": [{"photo": self.reps[i], "rank": rank, "was": rank} for i, rank in
                          self._ranks([self._item(winner), self._item(loser)]).items()]}

    def finals_view(self, cup: str | None = None) -> dict:
        cup = cup or self.cup
        st = self.finals_state(cup)
        n = int(self.ranker.n_active) if self.ranker is not None else 0
        if not st:
            r = self.ranker
            preview = self._finals_seeds(r) if r is not None and r.post is not None and cup == self.cup else []
            qualified = (self.knockouts_state() or {}).get("qualified") if r is not None and cup == self.cup else None
            return {"finals": None, "card": None, "eligible": len(preview) >= 4, "rounds": ROUNDS, "preview": preview,
                    "seed_source": "knockouts" if qualified and len(qualified) in (4, 8) else "leaderboard"}
        matches = st["matches"]
        ready = [k for k, m in enumerate(matches) if m["a"] and m["b"] and not m["winner"]]
        # A later round waits for every match in this one, even when its first pairing is already known.
        ready = [k for k in ready if matches[k]["round"] == matches[ready[0]]["round"]]
        start = st.get("next", 0) % len(matches)
        nxt = next((k for k in ready if k >= start), ready[0] if ready else None)
        card = None
        if nxt is not None:
            m = st["matches"][nxt]
            card = self._public({"id": f"final:{st['id']}:{nxt}", "type": "final", "match": nxt,
                                "a": m["a"], "b": m["b"], "round": m["round"], "cup": cup})
        return {"finals": st, "card": card, "eligible": True, "rounds": ROUNDS,
                "photos": {pid: self.photo_view(pid) for pid in st["seeds"]}}

    def _final_vote(self, card: dict, outcome: str, ms: int | None) -> dict:
        st = self.finals_state(card["cup"])
        m = st["matches"][card["match"]] if st else None
        if m is None or m["winner"] or (m["a"], m["b"]) != (card["a"], card["b"]):
            abort(409, "That match is out of date; reloading.")
        if outcome == "skip":
            st["next"] = card["match"] + 1
            self.store.set_meta(f"finals:{card['cup']}", st)
            return {**self.finals_view(card["cup"]), "progress": self.progress(), "skipped": True}
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
                                   "champs_before": champs, "bracket": st.get("id"), "seed": st["seeds"].index(w) + 1})
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
        left = len(self.sweep_cards(with_views=False))
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
            ko = self.knockouts_state() or {}
            biggest = max((g for g in self.groups.values() if len(g["members"]) > 1),
                          key=lambda g: len(g["members"]), default={})
            first_group = next((g for g in self.draw.stage()["groups"].values() if len(g["order"])), None)
            thumbs = {"stacks": biggest.get("rep"),
                      "draw": next((g["cover"] for g in self.draw.bins() if g.get("cover")), None),
                      "crown": next((v["winner"] for v in reversed(self.store.votes()) if v["kind"] == "frame"), None),
                      "groups": self.reps[int(first_group["order"][0])] if first_group else None,
                      "duels": ko.get("qualified", [None])[0] if ko.get("qualified") else self.reps[int(np.argmax(np.where(r.active, r.post.mu, -np.inf)))] if r.n_active else None}
            return {"mode": self.mode, "cup": self.cup, "cups": self.cups(), "progress": p,
                    "order": ["filter", "stacks", "crown", "draw", "groups", "duels", "finals", "reveal"], "side": ["sweep"],
                    "top": [{"photo": it["photo"], "box": it["box"]} for it in self.shortlist()["items"][:12]],
                    "summary": self.store.get_meta("summary"), "labels": library.CUT_LABELS, "thumbs": thumbs,
                    "stages": {
                        "filter": filtering.stage(self.store),
                        "sweep": self._sweep_stage(),
                        "stacks": {"twins": self.twins_left(),
                                   "stacks": sum(1 for i in np.flatnonzero(r.active) if len(self.groups.get(self.gids[i], {}).get("members", ())) > 1)},
                        "crown": {"left": len(self.stacks_left()),
                                  "total": sum(1 for i in np.flatnonzero(r.active) if len(self.distinct.get(self.gids[i], ())) > 1)},
                        **self.draw.journey(),
                        "duels": {"quality": q, "votes": p.get("votes", 0), "done": bool(ko.get("qualified")), "k": r.k,
                                  "knockouts": ko, "left": sum(not m["winner"] for rd in ko.get("rounds", []) for m in rd["matches"]),
                                  # skipped: it ended without a round; direct: it would, so the next stage is the finals
                                  "skipped": bool(ko.get("qualified")) and not ko.get("rounds"),
                                  "direct": self._knockouts_direct(len(ko["seeds"]) if ko else len(self._knockout_seeds()))},
                        "finals": {"state": "done" if done else "playing" if fin else "ready" if ko.get("qualified") or q >= 0.8 else "early",
                                   "champion": fin.get("champion") if fin else None, "eligible": len(self._finals_seeds(r)) >= 4},
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
                    "photos": {pid: self.photo_view(pid) for pid in podium}, "path": self.champion_path(podium[0]) if podium else []}

    def champion_path(self, pid: int) -> list[dict]:
        path = []
        for v in self.store.votes():
            if v["winner"] != pid:
                continue
            extra = json.loads(v["extra"] or "{}")
            if v["kind"] == "fduel": label = "Crown"
            elif extra.get("final"): label = ROUNDS.get(extra.get("round"), "Finals")
            elif extra.get("knockout"): label = f"Round of {extra['round']}"
            elif extra.get("group"): label = "Group stage"
            else: continue
            path.append({"stage": label, "beaten": v["b"] if v["a"] == pid else v["a"]})
        return path


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
        self._sessions = {}
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
                    self.session.analyzer.stop()
                s = self._sessions.get(str(source))
                if s is None or s.closed:
                    s = self._sessions[str(source)] = Session(source, self.data_dir)
                self.session = s
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
                self.session.analyzer.stop()
            self.session = None
            st = self._state()
            st["current"] = None
            self._save_state(st)

    def forget(self, source: Path) -> None:
        source = source.expanduser().resolve()
        with self.lock:
            old = self._sessions.pop(str(source), None)
            if self.session and self.session.source == source:
                self.close()
            if old:
                old.shutdown()
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
            votes = [dict(r) for r in con.execute("SELECT kind, a, ms, undone, ts, extra FROM votes ORDER BY id")]
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
    """Use the desktop's folder dialog; the in-page browser is always a fallback."""
    if sys.platform == "win32":
        import base64
        script = ("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
                  "Add-Type -AssemblyName System.Windows.Forms; "
                  "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                  "$d.Description = 'Pick your photo folder'; $d.SelectedPath = $env:MATCHER_PICK_START; "
                  "if ($d.ShowDialog() -eq 'OK') { [Console]::Write($d.SelectedPath) }; $d.Dispose()")
        env = desktop_env()
        env["MATCHER_PICK_START"] = start
        try:
            out = subprocess.run(["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand",
                                  base64.b64encode(script.encode("utf-16le")).decode("ascii")],
                                 capture_output=True, encoding="utf-8-sig", timeout=600, env=env,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise FileNotFoundError("no native dialog available") from e
        if out.returncode:
            raise FileNotFoundError("no native dialog available")
        return out.stdout.strip() or None
    for cmd in (["kdialog", "--title", "Pick your photo folder", "--getexistingdirectory", start],
                ["zenity", "--file-selection", "--directory", "--title=Pick your photo folder", f"--filename={start}/"]):
        if shutil.which(cmd[0]):
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=desktop_env())
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
    if sys.platform.startswith("linux"):
        for mount in sorted(Path(f"/run/user/{os.getuid()}").glob("*/storage/emulated/0")):  # KDE Connect phone mounts
            out.append({"label": "Phone (KDE Connect)", "path": str(mount)})
    known = {item["path"] for item in out}
    for path in mounted_folders():
        if path not in known:
            label = PureWindowsPath(path).drive if sys.platform == "win32" else Path(path).name
            out.append({"label": label or path, "path": path})
            known.add(path)
    return out


# ---------------------------------------------------------------------------- flask app

LOCKED_PAGE = """<!doctype html><meta charset="utf-8"><title>MatchER</title>
<body style="background:#0d0e10;color:#f4f1ec;font:16px system-ui;display:grid;place-items:center;height:90vh">
<div style="max-width:30em;text-align:center"><h1>MatchER is locked</h1><p>Open the link MatchER printed when it
started (or run <code>./matcher.sh</code> again; it opens the right link for you).</p></div>"""
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


def create_app(data_dir: Path = DATA_DIR, secret: str | None = None, allowed_hosts: set[str] | None = None,
               cookie: str = "matcher_k", debug_panel: bool = False) -> Flask:
    """secret: when set, every request needs the cookie that the one-time link (/?k=<secret>) hands out, so other
    programs and accounts on this machine (or your network, with --lan) can't use the app."""
    flask_app = Flask(__name__, static_folder=None)
    flask_app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
    app = App(data_dir)
    app.debug_panel = bool(debug_panel)  # --debug: the developer panel shows on every screen
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
                if not hmac.compare_digest(key.encode(), secret.encode()):
                    return LOCKED_PAGE, 403
                # Developer mode may ride along on the link (?k=...&debug=1); everything else is dropped.
                debug = request.args.get("debug")
                resp = redirect(f"/?debug={quote(debug)}" if debug in ("0", "1") else "/", 303)
                resp.set_cookie(cookie, secret, httponly=True, samesite="Strict", max_age=30 * 86400, path="/")
                return resp
            if not hmac.compare_digest(request.cookies.get(cookie, "").encode(), secret.encode()):
                if request.path == "/":
                    return LOCKED_PAGE, 403
                abort(403, "Open the link MatchER printed when it started.")
        if request.method == "POST" and request.headers.get("X-MatchER") != "1":
            abort(403, "Missing app header.")
        if request.method == "POST" and request.path.startswith("/api/"):
            body()
        numeric_args = {"after", "per", "page", "theme", "stack", "group", "match", "n", "uper", "circles",
                        "read", "cats", "seen", "identity", "org"}
        for name in numeric_args & request.args.keys():
            if abs(int(request.args[name] or 0)) > 10**12:
                abort(400, f"{name} is too large.")
        if any(isinstance(value, int) and abs(value) > 10**12 for value in (request.view_args or {}).values()):
            abort(400, "That id is too large.")

    @flask_app.after_request
    def headers(resp):
        s = getattr(g, "matcher_session", None)
        if request.method == "POST" and request.path not in {"/api/filter/preview", "/api/filter/learn", "/api/filter/review"} and resp.status_code < 400 and s and not s.closed:
            with s.lock:
                if not s.closed and s.ranker is not None:
                    earned = s.store.get_meta("achievements", []) or []
                    unlocked = s.progress().get("game", {}).get("unlocked", [])
                    if set(unlocked) - set(earned):
                        s.store.set_meta("achievements", sorted(set(unlocked) | set(earned)))
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
    @flask_app.errorhandler(413)
    def err(e):
        return jsonify(error=getattr(e, "description", str(e))), getattr(e, "code", 500)

    @flask_app.errorhandler(ValueError)
    def bad_value(e):  # a malformed number in a request, an empty export…: the request's fault, not a crash
        return jsonify(error=str(e) or "Bad request."), 400

    @flask_app.errorhandler(ClosedStoreError)
    def closed_save(e):
        return jsonify(error=str(e)), 409

    def sess() -> Session:
        if not hasattr(g, "matcher_session"):
            g.matcher_session = app.session
        s = g.matcher_session
        if s is None or s.closed:
            abort(409, "No photo folder chosen yet.")
        return s

    def body() -> dict:
        b = request.get_json(silent=True)
        if b is None and not request.data:
            return {}
        if not isinstance(b, dict):
            abort(400, "Send a JSON object.")
        numbers = {"photo", "target", "a", "b", "theme", "from", "into", "twin", "choice", "roll", "ms",
                   "finalists", "per_scene", "max_age_years"}
        strings = {"path", "mode", "match", "card", "outcome", "stage", "action", "name", "label", "emoji",
                   "key", "hint", "concept", "call", "kind", "lr", "source", "cup", "reason", "start"}
        lists = {"photos", "add", "reject", "order", "pending", "off", "ids"}
        if request.path == "/api/tags/set":
            lists.add("on")
        else:
            if "on" in b and not isinstance(b["on"], bool):
                abort(400, "on must be true or false.")
        for k, v in b.items():
            if k in numbers:
                if v is None and k in {"theme", "roll", "twin", "choice", "ms"}:
                    continue
                if isinstance(v, bool) or not isinstance(v, (int, float)) or abs(v) > 10**12 or not np.isfinite(v) or int(v) != v:
                    abort(400, f"{k} must be a whole number.")
                if v < 0:
                    abort(400, f"{k} cannot be negative.")
            elif k in strings:
                if v is None and (k in {"name", "emoji", "hint", "concept", "label", "lr"}
                                  or k == "reason" and request.path == "/api/filter/decision"):
                    continue
                if not isinstance(v, str):
                    abort(400, f"{k} must be text.")
                if len(v) > (4096 if k == "path" else 512):
                    abort(400, f"{k} is too long.")
            elif k in lists:
                limit = 200000 if k == "photos" and request.path in {"/api/tags/set", "/api/tags/new"} else 5000
                if not isinstance(v, list) or len(v) > limit:
                    abort(400, f"{k} must be a list of at most {limit} items.")
                text_items = k in {"pending", "on", "off"}
                if any(not isinstance(x, str) if text_items else
                       isinstance(x, bool) or not isinstance(x, int) or not 0 < x <= 10**12 for x in v):
                    abort(400, f"Invalid item in {k}.")
            elif k in {"hidden", "pinned", "sealed", "wild", "on", "keep", "wait", "exact"} and not isinstance(v, bool):
                abort(400, f"{k} must be true or false.")
        return b

    @contextmanager
    def settled(s):
        """Wait outside the session lock, then read one fully published set of stacks."""
        with s.stack_lock:
            while True:
                s.wait_refresh()
                with s.lock:
                    if s._refresh_running:
                        continue
                    yield
                    return

    def stack_edit(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            with sess().stack_lock:
                return fn(*args, **kwargs)
        return wrapped

    def locked(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            with sess().lock:
                return fn(*args, **kwargs)
        return wrapped

    # -------- pages and static files
    @flask_app.get("/img/atlas.jpg")
    def atlas():
        """Small previews for the density canvas: one bounded sheet instead of thousands of image elements."""
        s = sess()
        after = max(0, int(request.args.get("after", 0)))
        per = max(1, min(1000, int(request.args.get("per", 1000))))
        selected = request.args.get("ids")
        if selected is not None:
            parts = selected.split(",")
            if len(parts) > 1000 or any(not p.isascii() or not p.isdecimal() or len(p) > 15 for p in parts):
                abort(400, "Invalid atlas photo ids.")
            ids = [int(p) for p in parts]
        else:
            ids = [r["id"] for r in s.store.q("SELECT id FROM photos WHERE id>? AND status IN ('analyzed','error') ORDER BY id LIMIT ?",
                                            (after, per))]
        sheet = Image.new("RGB", (50 * 16, max(1, (len(ids) + 49)//50) * 16), "#15171c")
        for k, pid in enumerate(ids):
            try:
                with Image.open(s.workdir / "thumbs" / f"{pid}.jpg") as im:
                    im = im.convert("RGB")
                    # Fill the cell; the renderer restores the photo's aspect inside its paper window.
                    im = im.resize((16, 16), Image.Resampling.LANCZOS)
                    sheet.paste(im, ((k % 50)*16, (k//50)*16))
            except (OSError, ValueError):
                pass
        buf = io.BytesIO()
        sheet.save(buf, "JPEG", quality=80)
        buf.seek(0)
        return send_file(buf, mimetype="image/jpeg", max_age=3600)

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
        out = {"library": None, "recent": st.get("recent", []),
               "debug": bool(getattr(app, "debug_panel", False))}
        if s:
            out["library"] = {
                "source": str(s.source), "analyzing": s.analyzer.running(), "analyzed": s.analyzed(),
                "image_key": f"{s.workdir.name}-{s.analyzer.started if s.analyzer.running() else s.store.get_meta('analyzed_at', 0)}",
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
                    dirs.append({"name": e.name, "path": str(Path(e.path)), "photos": None})
            except OSError:
                continue
        crumbs = [{"label": ancestor.name or str(ancestor), "path": str(ancestor)}
                  for ancestor in [*reversed(p.parents), p]]
        return jsonify(path=str(p), parent=str(p.parent) if p.parent != p else None, dirs=dirs, crumbs=crumbs,
                       photos=None, suggestions=suggestions())

    @flask_app.get("/api/storage")
    def storage():
        # Poll connectivity without reopening save databases, scanning photos or starting analysis.
        out = {"saves": [{"path": r["path"], "exists": Path(r["path"]).is_dir()}
                         for r in app._state().get("recent", [])]}
        if request.args.get("browse") == "1":
            out["suggestions"] = suggestions()
            path = request.args.get("path")
            if path:
                out["folder"] = {"path": path, "exists": Path(path).expanduser().is_dir()}
        resp = jsonify(out)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @flask_app.post("/api/library")
    def open_library():
        mode = body().get("mode")
        raw = (body().get("path") or "").strip()
        p = Path(raw).expanduser()
        if not raw or not p.is_dir():
            abort(400, "That folder doesn't exist.")
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

    @flask_app.get("/api/sample")
    def sample_status():
        return jsonify(app.sample.status)

    @flask_app.post("/api/sample")
    def sample_start():
        """Prepare the bundled public-domain sample (only when you click "try it with sample photos")."""
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
    @locked
    def settings():
        s = sess()
        cur = s.settings
        b = body()
        if "help" in b:
            if not isinstance(b["help"], bool):
                abort(400, "help must be true or false.")
            cur["help"] = b["help"]
        if "sea_axes" in b:
            axes = b["sea_axes"]
            choices = sea_axes.KEYS
            if not isinstance(axes, dict) or set(axes) - {"x", "y", "reverseX", "reverseY"}:
                abort(400, "Choose the sea's horizontal and vertical axes.")
            if any(not isinstance(axes.get(key), str) or axes[key] not in choices for key in ("x", "y")):
                abort(400, "Choose a known measurement for each sea axis.")
            if any(key in axes and not isinstance(axes[key], bool) for key in ("reverseX", "reverseY")):
                abort(400, "Axis direction must be true or false.")
            cur["sea_axes"] = {key: axes[key] for key in ("x", "y")}
            cur["sea_axes"].update({key: axes.get(key, False) for key in ("reverseX", "reverseY")})
        if b and set(b) <= {"help", "sea_axes"}:
            # Display preferences never rebuild analysis, stacks, rankings or the user's undo history.
            s.store.set_meta("settings", {**(s.store.get_meta("settings", {}) or {}), **{key: cur[key] for key in b}})
            return jsonify(settings=cur)
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
        if "max_age_years" in b and s.store.get_meta("filter_policy"):
            s.store.set_meta("filter_policy", {**filtering.policy(s.store, cur), "max_age_years": cur["max_age_years"]})
        if refresh:
            s.refresh_async()
        with s.lock:
            s.version = None
        return jsonify(settings=cur)

    # -------- tournament
    @flask_app.get("/api/next")
    @locked
    def queued_cards():
        s = sess()
        _need(s)
        return jsonify(cards=[s._public(c) for c in list(s.cards.values())[:3]], progress=s.progress())

    @flask_app.post("/api/deal")
    def next_cards():
        s = sess()
        with settled(s):
            if s.ensure_ranker() is None:
                abort(409, "Still analyzing.")
            n = max(1, min(3, int(request.args.get("n", 2))))
            s.forget_unshown_frames()
            stage = request.args.get("stage") or None
            if request.args.get("stack"):
                if not s.crown_now(int(request.args["stack"])):
                    abort(400, "That stack has no Crown match in this cup.")
                stage = "stacks"
            if stage not in ("stacks", "groups", "knockouts", "open"):
                stage = s.draw.default_stage()  # the journey's: the group stage until it's settled, then the knockouts
            stage = None if stage == "open" else stage
            if stage == "groups" and request.args.get("group"):
                group = int(request.args["group"])
                table = s.draw.stage()["groups"].get(group)
                if table is None or table["settled"]:
                    abort(409, "That group is already decided.")
                s.draw.focus = group
            if stage == "knockouts" and request.args.get("match") is not None:
                s.ko_focus = int(request.args["match"])
            cards = s.next_cards(n, stage=stage)
            left = len(s.stacks_left()) if stage == "stacks" else None
            return jsonify(cards=cards, progress=s.progress(), left=left, stage=stage,
                           knockouts=s.store.get_meta(f"knockouts:{s.cup}") if stage == "knockouts" else None,
                           draw=s.draw.journey()["groups"])

    @flask_app.post("/api/stacks/auto")
    @stack_edit
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
        s = sess()
        with settled(s):
            return jsonify(s.journey())

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
    @locked
    def sweep_done():
        s = sess()
        s.store.set_meta(f"sweep_done:{s.cup}", time.time())
        return jsonify(ok=True)

    @flask_app.post("/api/welcome")
    @locked
    def welcome_seen():
        sess().store.set_meta("welcomed", True)
        return jsonify(ok=True)

    @flask_app.post("/api/sweep")
    def sweep_decide():
        b = body()
        s = sess()
        result = s.sweep(int(b.get("photo", 0)), bool(b.get("keep")))
        if b.get("wait"):
            s.wait_refresh()
            with s.lock:
                s.ensure_ranker(wait=True)
                result["progress"] = s.progress()
        return jsonify(result)

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
        for k in ("read", "cats", "seen", "identity", "org"):
            lst = f.get(k, [])
            since = max(0, int(request.args.get(k, 0) or 0))
            out[k] = lst[since:since + 2500]
            out[f"{k}_n"] = len(lst)
        return jsonify(out)

    @flask_app.get("/api/knockouts")
    @locked
    def knockouts():
        s = sess(); _need(s)
        return jsonify(knockouts=s.knockouts_state(), card=s.knockouts_card(), progress=s.progress())

    @flask_app.post("/api/knockouts/start")
    @locked
    def knockouts_start():
        s = sess(); _need(s)
        st = s.knockouts_state() or s.knockouts_start()
        card = s.knockouts_card()
        return jsonify(knockouts=st, cards=[s._public(card)] if card else [], progress=s.progress())

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
    def tournament_board():
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
                            "knockouts": s.store.get_meta(f"knockouts:{s.cup}"), **s.finals_view(), "progress": s.progress()})

    @flask_app.get("/api/reveal")
    @locked
    def reveal():
        s = sess()
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")
        return jsonify(s.reveal())

    @flask_app.post("/api/undo")
    def undo():
        stage = body().get("stage")
        stage = stage if stage in ("stacks", "groups", "knockouts") else None
        s = sess()
        s.wait_refresh()
        with s.lock:
            _need(s)
            ticket = edit_history.before_vote_undo(s, stage)
        result = s.undo(stage)
        with s.lock:
            if result.get("undone"):
                edit_history.after_undo(s, ticket, result, "vote")
            return jsonify({**result, "history": edit_history.history(s, "vote", stage)})

    @flask_app.get("/api/history")
    @locked
    def vote_history():
        if request.args.get("stage") == "home":
            return jsonify(edit_history.shared_history(sess()))
        return jsonify(edit_history.history(sess(), "vote", request.args.get("stage")))

    @flask_app.post("/api/redo")
    def redo():
        s = sess()
        result = _redo_edit(s, "vote")
        with s.lock:
            return jsonify({"ok": True, "redone": result["redone"], "cards": [], "progress": s.progress(),
                            "history": edit_history.history(s, "vote", body().get("stage"))})

    @flask_app.get("/api/shortlist")
    def shortlist():
        s = sess()
        with s.lock:
            return jsonify(s.shortlist())

    @flask_app.post("/api/pick")
    @locked
    def pick():
        s = sess()
        b = body()
        pid, on = int(b.get("photo", 0)), bool(b.get("on", True))
        if not s.store.one("SELECT id FROM photos WHERE id=?", (pid,)):
            abort(404, "Unknown photo.")
        members = [pid]
        if not on and s.ensure_ranker() is not None:
            members = (s.groups.get(s.photo_group.get(pid)) or {}).get("members", members)
        with s.store.tx() as c:
            c.executemany("UPDATE photos SET pick=? WHERE id=?", [(1 if on else 0, member) for member in members])
        return jsonify(ok=True)

    MARK_COLOURS = ("ink", "coral", "green", "gold")  # the pens and markers in the toolbelt

    @flask_app.get("/api/edits")
    @locked
    def read_edits():
        """The marks and finishing carried by a visible batch of cards, without one request per photo."""
        ids = request.args.get("photos", "").split(",")
        if len(ids) > 200 or any(not p.isascii() or not p.isdigit() or len(p) > 13 or not 0 < int(p) <= 10**12 for p in ids):
            abort(400, "Choose between one and 200 photos.")
        ids = list(dict.fromkeys(map(int, ids)))
        rows = sess().store.q(f"SELECT id,edits FROM photos WHERE id IN ({','.join('?' for _ in ids)})", ids)
        return jsonify(photos=[{"photo": r["id"], "edits": json.loads(r["edits"]) if r["edits"] else {}} for r in rows])

    @flask_app.route("/api/edit", methods=["GET", "POST"])
    @locked
    def edit_photo():
        """The Leaderboard's finishing choices for one shot: enhance (off, or back on) with its look knobs, crop
        (a mode, or "none"), rotate (clockwise degrees), the sticky note's spot, the toolbelt's marks and notes. GET
        ?photo= reads them. Only departures from the defaults are kept; each change to the shot is one undo step;
        Save my best bakes the finishing in."""
        s = sess()
        if request.method == "POST":
            _need(s)  # reading what a shot carries is fine mid-analysis; changing it waits for the library
        b = body() if request.method == "POST" else {"photo": request.args.get("photo", 0)}
        pid = int(b.get("photo", 0))
        row = s.store.one("SELECT edits FROM photos WHERE id=?", (pid,))
        if not row:
            abort(404, "Unknown photo.")
        old = row["edits"]
        edits = json.loads(old) if old else {}
        if request.method == "GET":
            return jsonify(photo=pid, edits=edits)
        for field, limit in (("title", 160), ("description", 8000)):
            if field in b:
                value = b[field]
                if value is not None and (not isinstance(value, str) or len(value) > limit):
                    abort(400, f"{field.capitalize()} is text of at most {limit} characters.")
                if value and value.strip():
                    edits[field] = value.strip()
                else:
                    edits.pop(field, None)
        if "enhance" in b:
            if b["enhance"] is None:
                edits.pop("enhance", None)
            elif isinstance(b["enhance"], bool):
                edits["enhance"] = b["enhance"]
            else:
                abort(400, "Enhance is on or off.")
        for field, label in (("auto_align", "Auto-align"), ("auto_skew", "Auto-skew")):
            if field in b:
                if b[field] is None:
                    edits.pop(field, None)
                elif isinstance(b[field], bool):
                    edits[field] = b[field]
                else:
                    abort(400, f"{label} is on or off.")
        if "composition" in b:
            if b["composition"] is None:
                edits.pop("composition", None)
            elif b["composition"] in ("natural", "upright", "expressive"):
                edits["composition"] = b["composition"]
            else:
                abort(400, "Choose Natural, Upright or Expressive composition.")
        if "skew" in b:
            value = b["skew"]
            if value is None:
                edits.pop("skew", None)
            else:
                if not isinstance(value, dict) or set(value) - {"horizontal", "vertical"}:
                    abort(400, "Perspective has horizontal and vertical adjustments.")
                try:
                    skew = {key: finishing.number(v, -.6, .6) for key, v in value.items()}
                except ValueError as error:
                    abort(400, str(error))
                if skew:
                    edits["skew"] = skew
                else:
                    edits.pop("skew", None)
        if "auto_amount" in b:
            try:
                amount = finishing.number(b["auto_amount"], 0, 1.5) if b["auto_amount"] is not None else 1
            except ValueError as error:
                abort(400, str(error))
            if amount == 1:
                edits.pop("auto_amount", None)
            else:
                edits["auto_amount"] = amount
        if "auto_parts" in b:
            parts = {} if b["auto_parts"] is None else b["auto_parts"]
            if not isinstance(parts, dict) or set(parts) - set(auto_look.PARTS) or any(not isinstance(v, bool) for v in parts.values()):
                abort(400, "Auto adjustments are tone, colour, grade, detail and subject, each on or off.")
            parts = {k: v for k, v in parts.items() if not v}
            if parts:
                edits["auto_parts"] = parts
            else:
                edits.pop("auto_parts", None)
        if "crop" in b:
            crop = "subject" if b["crop"] == "auto" else b["crop"]
            if crop not in (*touchup.CROPS, "custom", "none", "off", None):
                abort(400, "Crop is best, subject, height, width, custom or none.")
            if crop is None:
                edits.pop("crop", None)
            else:
                edits["crop"] = "off" if crop in {"none", "off"} else crop
        if "crop_box" in b:
            if b["crop_box"] is None:
                edits.pop("crop_box", None)
            else:
                rectangle = touchup.custom_crop(b["crop_box"])
                if rectangle is None:
                    abort(400, "Choose a crop rectangle inside the photo.")
                edits["crop_box"] = rectangle
        if edits.get("crop") == "custom" and not touchup.custom_crop(edits.get("crop_box")):
            abort(400, "A custom crop needs a rectangle.")
        for key in ("grade", "masks", "straighten"):
            if key not in b:
                continue
            try:
                value = (finishing.grade(b[key]) if key == "grade" else finishing.masks(b[key]) if key == "masks"
                         else finishing.number(b[key], -45, 45) if b[key] is not None else None)
            except ValueError as error:
                abort(400, str(error))
            if value or key == "straighten" and value is not None:
                edits[key] = value
            else:
                edits.pop(key, None)
        if "look" in b:  # the knobs on the auto look; only departures from the defaults are kept
            look = b["look"]
            if look is None:
                edits.pop("look", None)
            elif not isinstance(look, dict):
                abort(400, "A look is a set of knobs.")
            else:
                knobs = {}
                for key, value in look.items():
                    if key not in touchup.KNOBS or isinstance(value, bool) or not isinstance(value, (int, float)):
                        abort(400, f"Unknown or odd knob: {key}.")
                    lo, hi, default = touchup.KNOBS[key]
                    value = round(min(hi, max(lo, float(value))), 2)
                    if value != default:
                        knobs[key] = value
                if knobs:
                    edits["look"] = knobs
                else:
                    edits.pop("look", None)
        if "rotate" in b:
            try:
                turn = int(b["rotate"]) % 360
            except (TypeError, ValueError):
                abort(400, "Turns are degrees.")
            if turn % 90:
                abort(400, "Turns are quarter turns.")
            edits["rotate"] = turn
        if "note" in b:  # where the sticky note sits, in card widths from the card's top-left
            spot = b["note"]
            if spot is None:
                edits.pop("note", None)
            elif not (isinstance(spot, list) and len(spot) == 2
                      and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in spot)):
                abort(400, "A note's spot is two numbers.")
            else:
                edits["note"] = [round(max(-300.0, min(400.0, float(v))), 1) for v in spot]
        if "marks" in b:  # pen and marker strokes over the card, in card widths
            marks = b["marks"]
            if marks is None:
                edits.pop("marks", None)
            elif not isinstance(marks, list) or len(marks) > 300:
                abort(400, "Marks are a list of at most 300 strokes.")
            else:
                kept = []
                for stroke in marks:
                    if (not isinstance(stroke, dict) or stroke.get("t") not in ("pen", "marker") or stroke.get("c") not in MARK_COLOURS
                            or not isinstance(stroke.get("p"), list) or not 1 <= len(stroke["p"]) <= 600):
                        abort(400, "A stroke is a pen or marker, one of the colours, and up to 600 points.")
                    points = []
                    for point in stroke["p"]:
                        if not (isinstance(point, list) and len(point) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point)):
                            abort(400, "A point is two numbers.")
                        points.append([round(max(-300.0, min(400.0, float(v))), 1) for v in point])
                    kept.append({"t": stroke["t"], "c": stroke["c"], "p": points})
                if kept:
                    edits["marks"] = kept
                else:
                    edits.pop("marks", None)
        if "notes" in b:  # your own sticky notes on the card
            notes = b["notes"]
            if notes is None:
                edits.pop("notes", None)
            elif not isinstance(notes, list) or len(notes) > 30:
                abort(400, "At most 30 notes on a shot.")
            else:
                kept = []
                for note in notes:
                    if not isinstance(note, dict) or not isinstance(note.get("text", ""), str) or len(note.get("text", "")) > 400:
                        abort(400, "A note is a spot and up to 400 characters.")
                    try:
                        x, y = float(note.get("x", 0)), float(note.get("y", 0))
                    except (TypeError, ValueError):
                        abort(400, "A note's spot is two numbers.")
                    if isinstance(note.get("x"), bool) or isinstance(note.get("y"), bool):
                        abort(400, "A note's spot is two numbers.")
                    kept.append({"x": round(max(-300.0, min(400.0, x)), 1), "y": round(max(-300.0, min(400.0, y)), 1), "text": note.get("text", "")})
                if kept:
                    edits["notes"] = kept
                else:
                    edits.pop("notes", None)
        edits = {k: v for k, v in edits.items() if not (k == "crop" and v not in (*touchup.CROPS, "custom", "off"))
                 and not (k == "rotate" and not v)}
        value = json.dumps(edits) if edits else None
        if value != old:
            with s.store.tx() as c:
                c.execute("UPDATE photos SET edits=? WHERE id=?", (value, pid))
            # Moving the sorter's note or one of yours is not a change to the shot; everything else is one undo step.
            def shape(e: dict) -> dict:
                out = {k: v for k, v in e.items() if k != "note"}
                if "notes" in out:
                    out["notes"] = [n.get("text", "") for n in out["notes"]]
                return out
            if shape(edits) != shape(json.loads(old) if old else {}):
                s.draw.remember("edit", edits=[[pid, old]], photo=pid)
        return jsonify(_draw_reply(s, {"photo": pid, "edits": edits}))

    @flask_app.post("/api/frame")
    @stack_edit
    def set_frame():
        """Swap which frame of a burst represents it (from the shortlist)."""
        s = sess()
        with s.lock:
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
        _regroup(s)
        with s.lock:
            s.version = None
            s.ensure_ranker()
            return jsonify(_draw_reply(s, {"ok": True}))

    @flask_app.get("/api/photo/<int:pid>")
    @locked
    def photo_details(pid):
        """The original file for this exact take, including files still being read or set aside."""
        s = sess()
        row = s.store.one("SELECT rel FROM photos WHERE id=?", (pid,))
        if row is None:
            abort(404, "Unknown photo.")
        rel = Path(row["rel"])
        windows = PureWindowsPath(row["rel"])
        if not row["rel"] or "\0" in row["rel"] or rel.anchor or windows.anchor or ".." in rel.parts or ".." in windows.parts or not rel.parts:
            abort(400, "This photo has an invalid original file path.")
        # Keep the imported spelling (including symlinks) without opening or resolving the original file.
        return jsonify(photo=pid, rel=row["rel"], original_path=os.path.abspath(s.source / rel))

    @flask_app.get("/api/group/<int:pid>")
    @locked
    def group(pid):
        s = sess()
        if s.ensure_ranker() is None:
            abort(409, "Still analyzing.")
        g = s.photo_group.get(pid)
        stack = s.groups.get(g, {})
        i = s.gidx.get(g)
        crownable = i is not None and bool(s.ranker.active[i]) and len(s.distinct.get(g, [])) >= 2
        return jsonify(members=stack.get("members", [pid]), rep=stack.get("rep", pid), crownable=crownable)

    @flask_app.get("/api/photo/<int:pid>/notes")
    @locked
    def photo_notes(pid):
        """The saved evidence and choices for this exact take; opening its sheet never decodes the original."""
        s = sess()
        row = s.store.one("SELECT * FROM photos WHERE id=?", (pid,))
        if row is None:
            abort(404, "Unknown photo.")
        photo = {k: row[k] for k in row.keys() if k not in {"emb", "crop_emb", "sha256", "phash", "mtime_ns"}}
        for field in ("flags", "subject", "salient", "zs", "recognized_tags", "edits", "auto_look"):
            photo[field] = json.loads(photo[field]) if photo.get(field) else ({} if field in {"edits", "zs", "recognized_tags"} else [] if field == "flags" else None)
        meta = tags.rows(s.store)
        effective = tags.effective(s.store, [pid]).get(pid, set())
        automatic = {r["tag"]: r["score"] for r in s.store.q("SELECT tag, score FROM photo_tags WHERE photo_id=?", (pid,))}
        edited = {r["tag"]: bool(r["val"]) for r in s.store.q("SELECT tag, val FROM tag_edits WHERE photo_id=?", (pid,))}
        photo["tags"] = [{**meta.get(key, {"key": key, "label": key, "emoji": "🏷️"}),
                          "score": automatic.get(key), "edited": edited.get(key)} for key in sorted(effective)]
        photo["tag_edits"] = [{"key": key, "label": meta.get(key, {}).get("label", key), "on": value} for key, value in edited.items()]
        photo["faces"] = [{k: r[k] for k in r.keys() if k not in {"emb", "lm"}}
                          for r in s.store.q("SELECT * FROM faces WHERE photo_id=? ORDER BY idx", (pid,))]
        stack = s.store.one("SELECT rep,members FROM groups WHERE id=?", (row["group_id"],))
        photo["stack"] = {"rep": stack["rep"] if stack else pid, "members": json.loads(stack["members"]) if stack else [pid]}
        photo["group"] = dict(s.store.one("SELECT id,name,emoji FROM themes WHERE id=?", (row["theme_id"],)) or {})
        photo["available_groups"] = [dict(r) for r in s.store.q("SELECT id,name,emoji FROM themes ORDER BY COALESCE(pos,id),id")]
        index = getattr(s, "gidx", {}).get(row["group_id"])
        if index is not None and s.ranker is not None and s.ranker.post is not None:
            post = s.ranker.post
            top, _ = s.leaderboard_order()
            active = bool(s.ranker.active[index])
            chosen = set(top)
            bubble = [int(i) for i in np.argsort(-post.mu) if s.ranker.active[i] and i not in chosen][:24]
            photo["ranking"] = {"appeal": round(float(post.mu[index]), 3), "inclusion": round(float(post.p_in[index]), 3),
                                "duels": int(post.n_obs[index]), "rank": top.index(index) + 1 if index in top else None,
                                "bubble": index in bubble, "active": active}
        photo["history"] = [dict(r) for r in s.store.q("SELECT id,ts,kind,a,b,winner,undone FROM votes WHERE a=? OR b=? OR winner=? ORDER BY id DESC LIMIT 30", (pid, pid, pid))]
        return jsonify(photo)

    @flask_app.get("/api/search")
    def search_photos():
        query = request.args.get("q", "").strip()
        if len(query) > 200:
            abort(400, "Search with up to 200 characters.")
        s = sess()
        if not s.analyzed():
            abort(409, "Let analysis finish before searching your photos.")
        try:
            results = s.search.find(query, limit=60)
        except (OSError, RuntimeError) as error:
            abort(503, f"Photo search couldn't load its local model: {error}")
        return jsonify(query=query, photos=results)

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
        open_directory(target)
        return jsonify(ok=True)

    # -------- Filter: a complete review, with a draft that cannot change the tournament until Apply
    def _filter_ready(s, ranker=True):
        if s.analyzer.running():
            abort(409, "Let the current photo scan finish before reviewing Filter rules.")
        s.wait_refresh()  # The worker needs the Session lock to finish; never wait while holding it.
        if ranker:
            with s.lock:
                _need(s)

    @contextmanager
    def _filter_lock(s):
        with s.lock:
            if s.closed or s.analyzer.running() or s._refresh_running:
                abort(409, "Your photos are being updated. Try the Filter review again in a moment.")
            with s.store.refresh_lock:
                yield

    def _filter_reply(s, edit, draft=None):
        if edit and edit["refresh"]:
            try:
                s.wait_refresh()
            except ValueError as error:
                with s.lock:
                    history = s.store.get_meta("group_history", []) or []
                    rollback = bool(history and history[-1].get("filter_after") == edit["token"])
                    if rollback:
                        s.draw.undo()
                        s.refresh_async()
                if rollback:
                    try:
                        s.wait_refresh()
                    except ValueError:
                        pass  # The old policy is restored even if its derived rebuild needs a later retry.
                raise ValueError(f"Filter could not be applied: {error}") from error
        with s.lock:
            s.ensure_ranker(wait=True)
            progress = s.progress()
            return jsonify(_draw_reply(s, {"ok": True, "edited": bool(edit), "changed": edit["changed"] if edit else 0,
                           "counts": s.store.get_meta("filter_counts", {}), "stage": filtering.stage(s.store), "progress": progress,
                           **({"learning": filtering.learning(s, draft)} if draft is not None else {})}))

    @flask_app.get("/api/filter")
    def filter_page():
        s = sess(); _filter_ready(s, ranker="photo" not in request.args)
        with _filter_lock(s):
            if "photo" in request.args:
                return jsonify(filtering.photo_page(s, request.args))
            return jsonify(filtering.current_page(s, request.args))

    @flask_app.route("/api/filter/preview", methods=["GET", "POST"])
    def filter_preview():
        s = sess(); _filter_ready(s, ranker=request.method == "POST" or "photo" not in request.args)
        with _filter_lock(s):
            if request.method == "POST":
                return jsonify(filtering.preview(s, body()))
            if "photo" in request.args:
                return jsonify(filtering.photo_page(s, request.args, request.args.get("token", "")))
            preview = filtering.get_preview(s, request.args.get("token"))
            return jsonify(filtering.page(s, preview["rows"], preview["policy"], request.args, preview["token"]))

    @flask_app.post("/api/filter/apply")
    def filter_apply():
        s = sess(); _filter_ready(s)
        b = body()
        if not isinstance(b.get("finish", False), bool):
            abort(400, "finish must be true or false.")
        with _filter_lock(s):
            preview = filtering.get_preview(s, b.get("token"))
            edit = filtering.change(s, preview["policy"], preview["overrides"], b.get("finish", False))
            s.filter_preview = None
            if edit and edit["refresh"]:
                s.refresh_async()
        return _filter_reply(s, edit)

    @flask_app.post("/api/filter/decision")
    def filter_decision():
        s = sess(); _filter_ready(s)
        b = body()
        reason = filtering.decision_reason(b.get("reason", filtering.UNSPECIFIED))
        with _filter_lock(s):
            draft = filtering.draft_policy(s, b.get("policy"))
            photos = filtering.snapshot(s)[0]
            ids = b.get("photos", [])
            if not isinstance(ids, list) or not 1 <= len(ids) <= 5000:
                abort(400, "Choose between 1 and 5000 photos.")
            overrides = filtering.decisions([{"photo": pid, "action": b.get("action")} for pid in ids], photos)
            edit = filtering.change(s, overrides=overrides, label={"keep": "filter keep", "aside": "filter aside", "reset": "filter reset"}[b["action"]], learn=True, reason=reason)
            if edit and edit["refresh"]:
                s.refresh_async()
        return _filter_reply(s, edit, draft)

    @flask_app.post("/api/filter/learn")
    def filter_learn():
        s = sess(); _filter_ready(s, ranker=False)
        b = body()
        with _filter_lock(s):
            return jsonify(learning=filtering.learning(s, filtering.draft_policy(s, b.get("policy"))))

    @flask_app.post("/api/filter/tune")
    def filter_tune():
        s = sess(); _filter_ready(s, ranker=False)
        b = body()
        direction, pid = b.get("direction"), b.get("photo")
        if not isinstance(direction, str) or direction not in {"toward", "away", "reset"}:
            abort(400, "direction must be toward, away or reset.")
        if isinstance(pid, bool) or not isinstance(pid, int) or not 0 < pid <= 10**12:
            abort(400, "Choose a photo to tune from.")
        with _filter_lock(s):
            row = s.store.one("SELECT status FROM photos WHERE id=?", (pid,))
            if row is None:
                abort(404, "Unknown photo.")
            if row["status"] != "analyzed" and direction != "reset":
                abort(400, "This photo needs to be read before it can teach the filter.")
            draft = filtering.draft_policy(s, b.get("policy"))
            edit = filtering.change(s, label=f"filter tune {direction}",
                                    overrides={} if direction == "reset" else {pid: "keep" if direction == "toward" else "toss"},
                                    learn=direction != "reset",
                                    preferences={pid: {"toward": "keep", "away": "toss", "reset": None}[direction]})
            if edit and edit["refresh"]:
                s.refresh_async()
        return _filter_reply(s, edit, draft)

    @flask_app.post("/api/filter/review")
    def filter_review():
        s = sess(); _filter_ready(s, ranker=False)
        with _filter_lock(s):
            return jsonify(filtering.review(s, body()))

    @flask_app.post("/api/filter/finish")
    def filter_finish():
        s = sess(); _filter_ready(s)
        with _filter_lock(s):
            edit = filtering.change(s, finish=True, label="filter complete")
        return _filter_reply(s, edit)

    # -------- review cuts / people
    @flask_app.get("/api/cuts")
    @locked
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
    @locked
    def rescue():
        """on=true brings photos back into the tournament, on=false sets them aside again.
        Automatic set-asides flip an override; tossed photos are un-tossed (and the toss stops teaching
        the model) or re-tossed."""
        s = sess()
        b = body()
        ids = [int(i) for i in b.get("ids", [])][:5000]
        on = bool(b.get("on", True))
        tossed_view = b.get("reason") == "tossed"
        changed, overrides, vote_states, inserted = 0, [], [], []
        with s.store.tx() as c:
            tosses = None
            for pid in ids:
                row = c.execute("SELECT override, status FROM photos WHERE id=?", (pid,)).fetchone()
                if row is None:
                    continue
                if on and row["status"] == "error":
                    abort(400, "This photo could not be read. Re-scan it before bringing it back.")
                ov = row["override"]
                if on and ov == "toss":
                    c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
                    if tosses is None:
                        tosses = [(v["id"], (json.loads(v["extra"]).get("members") if v["extra"] else None) or [v["a"]])
                                  for v in c.execute("SELECT id, a, extra FROM votes WHERE kind='toss' AND undone=0")]
                    for vid, members in tosses:
                        if pid in members:
                            if [vid, 0] not in vote_states:
                                vote_states.append([vid, 0])
                            c.execute("UPDATE votes SET undone=1 WHERE id=?", (vid,))
                elif on and ov is None:
                    c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
                elif not on and ov in (None, "keep") and tossed_view:
                    c.execute("UPDATE photos SET override='toss' WHERE id=?", (pid,))
                    cursor = c.execute("INSERT INTO votes(ts, kind, a, extra) VALUES(?, 'toss', ?, ?)",
                              (time.time(), pid, json.dumps({"members": [pid]})))
                    inserted.append(cursor.lastrowid)
                elif not on and ov == "keep":
                    c.execute("UPDATE photos SET override=NULL WHERE id=?", (pid,))
                else:
                    continue
                changed += 1
                overrides.append([pid, ov])
        if changed:
            s.draw.remember("rescue" if on else "set aside", overrides=overrides, vote_states=vote_states, inserted_votes=inserted)
            s.draw.changed()
            s.refresh_async()
        return jsonify(_draw_reply(s, {"ok": True, "changed": changed}))

    @flask_app.get("/api/people")
    @locked
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
        with s.lock:
            log = s.store.get_meta("people_log", []) or []
            if not log:
                abort(400, "Nothing to undo.")
            last = log.pop()
            restore = tournament.restorable(s.store, last.get("tournaments"))
            _people_change(s, last["action"], last["key"], last["cen"], undo=True)
            s.store.set_meta("people_log", log)
            s.refresh_async()
        s.wait_refresh()
        with s.lock:
            tournament.restore(s.store, restore)
        return jsonify(ok=True, undone=last["action"])

    @flask_app.post("/api/people/<int:key>")
    @locked
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
        brackets = tournament.capture(s.store)
        _people_change(s, action, key, cen)
        s.store.set_meta("people_log", ((s.store.get_meta("people_log", []) or []) + [
            {"action": action, "key": key, "cen": cen, "tournaments": brackets}])[-50:])
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
        s.refresh_async(full=False)
        s.wait_refresh()
        with s.lock:
            s.version = None
            s.ensure_ranker(wait=True)
            if s._minis_dirty:
                s._save_minis()

    def _ordered_shots(s: Session, view: str, order: str, theme: int | None = None, reorder: bool = False) -> list[dict]:
        """Every shot in display order. Stacks keep member slots across edits so paging and undo stay put.
        theme: only one of the Draw's groups (-1: the shots in none yet)."""
        if view in ("stacks", "all") and reorder:
            s.stack_orders.pop((view, order, theme), None)
            s.groups_cache = {}
        key = (s.store.get_meta("state_version"), s.version, view, order, theme, s.draw.ver)
        hit = s.groups_cache.get("key") == key
        if hit:
            return s.groups_cache["shots"]
        rows = {r[0]: r for r in s.store.q(
            "SELECT id, taken, taken_ts, stack_key, rep_pref FROM photos WHERE group_id IS NOT NULL")}
        empty = (None, None, None, None, None)
        shots = []
        tm, pool = (s.draw.theme_of(), s.draw.pool_mask()) if theme is not None else (None, None)
        for gid, g in s.groups.items():
            members = g["members"]
            if view == "stacks" and len(members) < 2:
                continue
            if theme is not None and ((i := s.gidx.get(gid)) is None or not pool[i] or tm[i] != theme):
                continue
            rep = rows.get(g["rep"], empty)
            if len(members) == 1:
                stack_key = rep[3] or ""
                manual, solo, kept = stack_key.startswith("m:"), stack_key.startswith("solo:"), bool(rep[4])
            else:
                keys = {rows.get(m, empty)[3] or "" for m in members}
                manual, solo = any(k.startswith("m:") for k in keys), False
                kept = any(rows.get(m, empty)[4] for m in members)
            shots.append({"gid": gid, "rep": g["rep"], "members": members,
                          "manual": manual, "solo": solo, "kept": kept,
                          "crownable": bool(s.ranker.active[s.gidx[gid]]) and len(s.distinct.get(gid, [])) >= 2,
                          "taken": rep[1], "ts": rep[2],
                          "box": s.view.get(g["rep"], {}).get("box")})
        shots.sort(key=lambda x: (x["ts"] is None, x["ts"] or 0, x["gid"]))
        # The Stacks page and the Groups board both keep member slots across edits: a split, merge or crown changes
        # a stack's cover without moving the row you reached for.
        ledger = s.stack_orders.get((view, order, theme)) if view in ("stacks", "all") else None
        if order == "look" and ledger is None:
            shots = _lookalike(s, shots)
        if view in ("stacks", "all"):
            if ledger is None:
                ledger = {"members": {}, "next": 0, "family": max((x.get("family") or 0 for x in shots), default=0) + 1}
                s.stack_orders[(view, order, theme)] = ledger
                # A new ledger is already in display order. Avoid another roster, lookup and sort for every
                # loose photo when first opening a large library.
                for slot, shot in enumerate(shots):
                    family = shot.get("family", ledger["family"])
                    ledger["family"] += 1
                    ledger["members"].update((pid, (slot, family)) for pid in shot["members"])
                    if order == "look":
                        shot["family"] = family
                ledger["next"] = len(shots)
            else:
                slots = {}
                for shot in shots:
                    known = [ledger["members"][pid] for pid in shot["members"] if pid in ledger["members"]]
                    if known:
                        slot, family = min(known, key=lambda entry: entry[0])
                    else:
                        slot, family = ledger["next"], shot.get("family", ledger["family"])
                        ledger["next"] += 1
                        ledger["family"] += 1
                    # Keep every old member's slot: undoing a merge restores both original positions and family labels.
                    for pid in shot["members"]:
                        ledger["members"].setdefault(pid, (slot, family))
                    if order == "look":
                        shot["family"] = family
                    slots[shot["gid"]] = (slot, min(shot["members"]))
                shots.sort(key=lambda shot: slots[shot["gid"]])
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
            view = request.args.get("view", "stacks")
            counts = {"stacks": sum(1 for g in s.groups.values() if len(g["members"]) > 1), "shots": len(s.groups)}
            if view == "suggest":
                sug, total = library.suggest_merges(s.store, with_total=True)
                counts["suggest"] = total
                for x in sug:
                    x["box_a"], x["box_b"] = s.view.get(x["a"], {}).get("box"), s.view.get(x["b"], {}).get("box")
                return jsonify(suggestions=sug, counts=counts)
            order = "look" if request.args.get("order", "look") == "look" else "time"
            theme = request.args.get("theme")
            shots = _ordered_shots(s, view, order, int(theme) if theme not in (None, "") else None,
                                   reorder=request.args.get("reorder") == "1" and request.args.get("page", "0") == "0")
            # Pages of about `per` items that never split a look-alike family; the page asks for them one by one.
            per = max(1, min(500, int(request.args.get("per", 120 if view == "all" else 24))))
            bounds, start = [], 0
            for k in range(1, len(shots) + 1):
                if k == len(shots) or (k - start >= per and (order == "time" or shots[k].get("family") != shots[k - 1].get("family"))) \
                        or k - start >= 2 * per:
                    bounds.append((start, k))
                    start = k
            page = max(0, int(request.args.get("page", 0)))
            extra = {}
            if order == "time" and (request.args.get("dates") == "1" or "date" in request.args):
                # The whole date index is tiny. Jump straight to its page without fetching every intervening shot.
                dates = {}
                for number, (lo, hi) in enumerate(bounds):
                    for shot in shots[lo:hi]:
                        day = (shot["taken"] or "")[:10] or "undated"
                        entry = dates.setdefault(day, {"date": day, "photo": shot["rep"], "page": number, "count": 0})
                        entry["count"] += 1
                extra["dates"] = sorted(dates.values(), key=lambda d: (d["date"] == "undated", d["date"]))
                if "date" in request.args:
                    day = request.args["date"]
                    if day != "undated" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                        abort(400, "Choose a date in YYYY-MM-DD form.")
                    entry = dates.get(day) or next((d for d in extra["dates"] if d["date"] >= day), None)
                    if entry is None and extra["dates"]:
                        entry = extra["dates"][-1]
                    if entry:
                        page = entry["page"]
                        extra["jump"] = entry
            if "at" in request.args:
                pid = int(request.args["at"])
                index = next((i for i, shot in enumerate(shots) if pid in shot["members"]), None)
                page = next((p for p, (lo, hi) in enumerate(bounds) if index is not None and lo <= index < hi), min(page, max(0, len(bounds)-1)))
            part = shots[slice(*bounds[page])] if page < len(bounds) else []
            counts["suggest"] = None
            return jsonify(shots=part, counts=counts, page=page, pages=len(bounds), total=len(shots),
                           undo=s.draw.last_step(), **extra,
                           boxes={m: s.view.get(m, {}).get("box") for x in part for m in x["members"]})

    @flask_app.get("/api/draw/history")
    @locked
    def groups_history():
        return jsonify(edit_history.history(sess()))

    @flask_app.post("/api/draw/undo")
    @stack_edit
    def groups_undo():
        """Take back your last change on the Draw or to the stacking (merge, split, move, keep, a call, a group…)."""
        s = sess()
        with s.lock:
            _need(s)
            ticket = edit_history.before_undo(s)
            r = s.draw.undo()
        if r.get("refresh"):
            s.refresh_async()
            s.wait_refresh()
            with s.lock:
                s.ensure_ranker(wait=True)
                if s._minis_dirty:
                    s._save_minis()
        elif r["stacks"]:
            _regroup(s)
        with s.lock:
            s.seed_crowns(r.get("crown_members", []), r.get("crown_seeds", []))
            if r.get("content_brackets"):
                filtering.restore_content_brackets(s, r["content_brackets"])
            tournament.reconcile(s.store)
            tournament.restore(s.store, r.get("tournaments"))
            edit_history.after_undo(s, ticket, r)
            return jsonify(_draw_reply(s, {"ok": True, "undone": r["undone"], "next": r["next"], "history": edit_history.history(s)}))

    @flask_app.post("/api/draw/redo")
    @stack_edit
    def groups_redo():
        s = sess()
        r = _redo_edit(s, "group")
        with s.lock:
            return jsonify(_draw_reply(s, {"ok": True, "redone": r["redone"], "history": edit_history.history(s)}))

    def _redo_edit(s, stream):
        s.wait_refresh()
        with s.lock:
            _need(s)
            r = edit_history.redo(s, stream)
        if r["refresh"]:
            s.refresh_async()
            s.wait_refresh()
        elif r["stacks"]:
            _regroup(s)
        with s.lock:
            s.ensure_ranker(wait=True)
            if s._minis_dirty:
                s._save_minis()
            tournament.reconcile(s.store)
            return r

    @flask_app.post("/api/groups/merge")
    @stack_edit
    def groups_merge():
        """Stack the shots containing these photos into one. Yours from now on: nothing else joins it,
        and it plays a mini-tournament to crown its best frame."""
        s = sess()
        with s.lock:
            s.ensure_ranker()
            members: set[int] = set()
            for pid in [int(x) for x in body().get("photos", [])][:500]:
                g = _shot_of(s, pid)
                members |= set(g["members"]) if g else {pid}
            if len(members) < 2:
                abort(400, "Pick at least two shots to merge.")
            snap = _snapshot(s, members)
            seeds = s.crown_seeds(snap)
            key = "m:" + secrets.token_hex(6)
            target = s._item(int(body().get("photos", [0])[-1]))
            theme = int(s.draw.theme_of()[target]) if target is not None else -1
            old = [[r["id"], r["theme_id"]] for r in s.store.q(
                f"SELECT id, theme_id FROM photos WHERE id IN ({','.join('?' * len(members))})", list(members))]
            with s.store.tx() as c:
                c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(members))})",
                          [key, *members])
                # The whole stack joins the destination's group, including its unassigned pile.
                c.execute(f"UPDATE photos SET theme_id=? WHERE id IN ({','.join('?' * len(members))})",
                          [theme if theme >= 0 else None, *members])
            _remember(s, "merge", snap, themes=old, vote=s.draw._xp("twin", min(members)))  # (stacking earns XP)
            s.draw.changed()
        _regroup(s)
        with s.lock:
            s.seed_crowns(members, seeds)
            return jsonify(_draw_reply(s, {"ok": True, "size": len(members)}))

    @flask_app.post("/api/groups/split")
    @stack_edit
    def groups_split():
        """Take one photo out of its stack. The rest stays stacked exactly as you saw it."""
        s = sess()
        with s.lock:
            s.ensure_ranker()
            pid = int(body().get("photo", 0))
            g = _shot_of(s, pid)
            if not g or len(g["members"]) < 2:
                abort(400, "That photo isn't in a stack.")
            rest = [m for m in g["members"] if m != pid]
            snap = _snapshot(s, g["members"])
            seeds = s.crown_seeds(snap)
            _remember(s, "split", snap)
            with s.store.tx() as c:
                c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{pid}", pid))
                if len(rest) > 1:
                    c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(rest))})",
                              ["m:" + secrets.token_hex(6), *rest])
                else:
                    c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{rest[0]}", rest[0]))
        _regroup(s)
        with s.lock:
            s.seed_crowns(rest, seeds)
            return jsonify(_draw_reply(s, {"ok": True}))

    @flask_app.post("/api/groups/move")
    @stack_edit
    def groups_move():
        """Drag one frame onto another shot: it leaves its stack (the rest stays as you saw it) and joins that shot."""
        s = sess()
        with s.lock:
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
            snap = _snapshot(s, set(rest) | set(joined))
            seeds = s.crown_seeds(snap)
            theme = int(s.draw.theme_of()[s._item(target)])
            old = [[r["id"], r["theme_id"]] for r in s.store.q(
                f"SELECT id, theme_id FROM photos WHERE id IN ({','.join('?' * len(joined))})", joined)]
            with s.store.tx() as c:
                if len(rest) > 1:
                    c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(rest))})",
                              ["m:" + secrets.token_hex(6), *rest])
                elif rest:
                    c.execute("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", (f"solo:{rest[0]}", rest[0]))
                c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(joined))})",
                          ["m:" + secrets.token_hex(6), *joined])
                c.execute(f"UPDATE photos SET theme_id=? WHERE id IN ({','.join('?' * len(joined))})",
                          [theme if theme >= 0 else None, *joined])
            _remember(s, "move", snap, themes=old)
            s.draw.changed()
        _regroup(s)
        with s.lock:
            s.seed_crowns(rest + joined, seeds)
            return jsonify(_draw_reply(s, {"ok": True, "size": len(joined)}))

    @flask_app.post("/api/groups/unstack")
    @stack_edit
    def groups_unstack():
        """Split a whole stack into separate shots."""
        s = sess()
        with s.lock:
            s.ensure_ranker()
            g = _shot_of(s, int(body().get("photo", 0)))
            if not g or len(g["members"]) < 2:
                abort(400, "That isn't a stack.")
            _remember(s, "unstack", _snapshot(s, g["members"]))
            with s.store.tx() as c:
                c.executemany("UPDATE photos SET stack_key=?, rep_pref=0 WHERE id=?", [(f"solo:{m}", m) for m in g["members"]])
        _regroup(s)
        with s.lock:
            return jsonify(_draw_reply(s, {"ok": True, "size": len(g["members"])}))

    @flask_app.post("/api/groups/reset")
    @stack_edit
    def groups_reset():
        """Hand shots back to the automatic stacking rules (a stack you made, or a photo you split out)."""
        s = sess()
        with s.lock:
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
        with s.lock:
            return jsonify(_draw_reply(s, {"ok": True}))

    @flask_app.post("/api/groups/dismiss")
    @locked
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

    @flask_app.route("/api/draw/qualify", methods=["GET", "POST"])
    @locked
    def draw_qualify():
        s = sess(); _need(s)
        if request.method == "GET":
            return jsonify(s.draw.qualification())
        return jsonify(_draw_reply(s, s.draw.qualify(body().get("basis"))))

    @flask_app.get("/api/draw/deck")
    def draw_deck():
        s = sess()
        with s.lock:
            _need(s)
            nobulk = {int(x) for x in request.args.get("nobulk", "").split(",")[:200] if x.strip().isdigit()}
            return jsonify(s.draw.deck(int(request.args.get("theme", 0)), max(1, min(20, int(request.args.get("n", 10)))), nobulk))

    @flask_app.post("/api/draw/new")
    def draw_new():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.create(_draw_photos(b))}))

    def _draw_photos(b):
        photos = b.get("photos", [])
        if not isinstance(photos, list) or len(photos) > 50000:
            abort(400, "Choose at most 50,000 photos for one group edit.")
        return [int(x) for x in photos]

    @flask_app.get("/api/draw/board")
    def draw_board():
        """The Groups page in one go: every group with its first shots (look-alikes side by side), and the unsorted pile."""
        s = sess()
        with s.lock:
            _need(s)
            per = max(4, min(2000, int(request.args.get("per", 24))))
            key = (s.version, s.store.get_meta("state_version"), s.draw.ver, s.cup, s.store.vote_revision)
            cached = getattr(s.draw, "_board_cache", None)
            if cached is None or cached[0] != key:
                shots = _ordered_shots(s, "all", "look" if len(s.groups) <= 3000 else "time")
                tm, pool = s.draw.theme_of(), s.draw.pool_mask()
                by: dict[int, list] = {}
                for x in shots:
                    i = s.gidx.get(x["gid"])
                    if i is not None and pool[i]:
                        by.setdefault(int(tm[i]), []).append(x)
                st = s.draw.state()
                bins = {b["id"]: b for b in s.draw.bins()}
                s.draw._board_cache = (key, by, st, bins)
            _, by, st, bins = s.draw._board_cache
            full = {int(x) for x in request.args.get("full", "").split(",") if x.strip().lstrip("-").isdigit()}
            uper = max(4, min(5000, int(request.args.get("uper", per))))  # the unsorted pile can have its own cap

            page = max(0, int(request.args.get("page", 0)))
            def cap(t):
                size = uper if t == -1 else per
                return by.get(t, []) if t in full else by.get(t, [])[page * size:(page + 1) * size]
            groups = [{**g, "adv": bins.get(g["id"], {}).get("adv", 0), "shots": cap(g["id"]),
                       "count": len(by.get(g["id"], []))} for g in st["groups"]]
            part = [x for g in groups for x in g["shots"]] + cap(-1)
            out = {**st, "cup": s.cup, "groups": groups, "bins": list(bins.values()),
                   "version": [s.version, s.draw.ver, s.store.get_meta("tag_version", 0)],
                   "unsorted": {"shots": cap(-1), "count": len(by.get(-1, []))},
                   "page": page, "more": any((page + 1) * (uper if t == -1 else per) < len(xs)
                                               for t, xs in by.items() if t not in full),
                   "total": sum(map(len, by.values())),
                   "boxes": {m: s.view.get(m, {}).get("box") for x in part for m in x["members"]}}
            out = _draw_reply(s, out)
        if request.args.get("tags"):
            out["tagging"] = s.draw.tagging(max(1, min(24, int(request.args.get("circles", 6)))))
        return jsonify(out)

    @flask_app.get("/api/world")
    @locked
    def world():
        """Every photo, including other cups, takes and set-aside photos, in stable bounded pages."""
        s = sess()
        _need(s)
        after = max(0, int(request.args.get("after", 0)))
        per = max(1, min(1000, int(request.args.get("per", 400))))
        rows = s.store.q("SELECT id, group_id, theme_id, category, cut, override, flags, width, height, luma, chroma, saturation, hue, "
                         "taken, taken_ts, prior, sharp, n_faces, rel, size, fmt, make, model, zs, subject, edits, auto_look, luma_lo, luma_hi FROM photos "
                         "WHERE id>? AND status IN ('analyzed','error') ORDER BY id LIMIT ?", (after, per + 1))
        more, part = len(rows) > per, rows[:per]
        sets = tags.effective(s.store, [r["id"] for r in part])
        faces = {}
        for start in range(0, len(part), 400):
            batch = part[start:start + 400]
            for f in s.store.q(f"SELECT photo_id,w,h,smile,blink_l,blink_r,yaw,roll FROM faces WHERE photo_id IN ({','.join('?' for _ in batch)})", [r["id"] for r in batch]):
                previous = faces.get(f["photo_id"])
                if previous is None or f["w"] * f["h"] > previous["w"] * previous["h"]:
                    faces[f["photo_id"]] = f
        themes = {r["id"]: dict(r) for r in s.store.q("SELECT id,name FROM themes")}
        out = []
        for r in part:
            g = s.groups.get(r["group_id"], {})
            index = s.gidx.get(r["group_id"])
            out.append({"id": r["id"], "gid": r["group_id"], "rep": g.get("rep", r["id"]),
                        "members": g.get("members", [r["id"]]) if g.get("rep") == r["id"] else [r["id"]],
                        "theme": r["theme_id"] if r["theme_id"] is not None else -1,
                        "category": r["category"], "cut": r["cut"], "tags": sorted(sets.get(r["id"], [])),
                        "rescued": r["override"] == "keep", "box": s.view.get(r["id"], {}).get("box"),
                        "dims": [r["width"] or 1, r["height"] or 1],
                        "auto_look": json.loads(r["auto_look"] or "null"),
                        "render_edits": {k: v for k, v in json.loads(r["edits"] or "{}").items() if k in {"enhance", "look", "grade", "auto_amount", "auto_parts", "auto_align", "straighten", "auto_skew", "skew", "composition", "rotate", "crop", "crop_box"}},
                        "taken": r["taken"],
                        "measurements": sea_axes.measurements(r, face=faces.get(r["id"]), stack=g, theme=themes.get(r["theme_id"]),
                                                             post=s.ranker.post, index=index, tag_count=len(sets.get(r["id"], []))),
                        "visual": visual.descriptor(r["luma"], r["chroma"], r["saturation"], r["hue"])})
        total = s.store.one("SELECT COUNT(*) AS n FROM photos WHERE status IN ('analyzed','error')")["n"]
        return jsonify(photos=out, after=part[-1]["id"] if part else after, more=more, total=total,
                       version=[s.version, s.draw.ver, s.store.get_meta("tag_version", 0)])

    @flask_app.get("/api/auto-looks")
    @locked
    def auto_looks():
        s = sess()
        working = bool(s._looks_thread and s._looks_thread.is_alive())
        after = max(0, request.args.get("after", 0, type=int))
        per = min(250, max(1, request.args.get("per", 250, type=int)))
        # The worker advances in id order. Fence each page at what it has committed so later updates cannot
        # appear behind the browser's cursor while a large collection is still upgrading.
        through = getattr(s, "_looks_after", 0) if working else s.store.one("SELECT MAX(id) AS n FROM photos")["n"] or 0
        rows = s.store.q("SELECT id,auto_look FROM photos WHERE id>? AND id<=? AND auto_version>=? AND auto_look IS NOT NULL ORDER BY id LIMIT ?",
                         (after, through, auto_look.VERSION, per))
        after = rows[-1]["id"] if rows else max(after, through)
        return jsonify(working=working, version=auto_look.VERSION, after=after, more=len(rows) == per and after < through,
                       recipes=[{"id": r["id"], "recipe": json.loads(r["auto_look"])} for r in rows])

    @flask_app.get("/api/tags")
    def tags_page():
        s = sess()
        with s.lock:
            _need(s)
            key = (s.version, s.store.get_meta("tag_version", 0))
        if request.args.get("all") == "1":
            cached = getattr(s.draw, "_all_tag_cache", None)
            if cached is None or cached[0] != key:
                meta = tags.rows(s.store)
                sets = tags.effective(s.store)
                count = Counter(t for ts in sets.values() for t in ts)
                value = {"tags": [{**t, "count": count[k], "catchy": tags.catchy_names(k)[:2]} for k, t in meta.items() if count[k]],
                         "visible": tags.choose_visible(sets, meta, limit=24)}
                s.draw._all_tag_cache = (key, value)
            else:
                value = cached[1]
            return jsonify(value)
        out = s.draw.tagging(max(1, min(24, int(request.args.get("circles", 6)))))
        return jsonify(out)

    @flask_app.get("/api/tags/deck")
    @locked
    def tags_deck():
        s = sess(); _need(s)
        key = request.args.get("key", "")
        if not s.store.one("SELECT key FROM tags WHERE key=?", (key,)):
            abort(404, "No such tag.")
        rows = s.store.q("SELECT p.id, t.score FROM photos p LEFT JOIN photo_tags t ON t.photo_id=p.id AND t.tag=? "
                         "WHERE p.status='analyzed' AND NOT EXISTS (SELECT 1 FROM tag_edits e WHERE e.photo_id=p.id AND e.tag=?) "
                         "AND (p.group_id IS NULL OR p.id IN (SELECT rep FROM groups)) "
                         "ORDER BY ABS(COALESCE(t.score,0.5)-0.5), p.id LIMIT 30", (key, key))
        return jsonify(cards=[{"photo": r["id"], "score": r["score"]} for r in rows])

    @flask_app.post("/api/tags/merge")
    @flask_app.post("/api/tags/delete")
    @locked
    def tags_merge():
        s, b = sess(), body()
        _need(s)
        return jsonify(_draw_reply(s, s.draw.tag_merge(b.get("source", ""),
                              b.get("key") if request.path.endswith("merge") else None)))

    @flask_app.post("/api/tags/set")
    def tags_set():
        """Where you dropped a photo on the tag sea: the circles it's now in, and the ones it's now out of."""
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.set_tags(b.get("photos", []),
                                                          [str(t) for t in b.get("on", [])], [str(t) for t in b.get("off", [])], b.get("exact", False))))

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
            return jsonify(_draw_reply(s, s.draw.tag_new(b.get("label"), b.get("emoji"),
                                                         b.get("photos", []), b.get("exact", False))))

    @flask_app.post("/api/tags/group")
    def tags_group():
        """Make a suggested group: the intersection's shots that aren't in a group yet."""
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, {"theme": s.draw.tag_group(_draw_photos(b),
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
            members = [int(b.get("photo", 0)), int(b.get("twin") or 0)]
            seed_members = [pid for p in members for pid in (s.groups.get(s.photo_group.get(p)) or {}).get("members", [])]
            seeds = s.crown_seeds(_snapshot(s, seed_members)) if b.get("call") == "twin" else []
            r = s.draw.call(int(b.get("theme", 0)), int(b.get("photo", 0)), str(b.get("call", "")),
                            int(b["twin"]) if b.get("twin") else None, int(ms) if isinstance(ms, (int, float)) else None)
        if r["stacks"]:
            _regroup(s)
        with s.lock:
            if r["stacks"]:
                s.seed_crowns(seed_members, seeds)
            return jsonify(_draw_reply(s, r))

    @flask_app.post("/api/draw/bulk")
    def draw_bulk():
        s, b = sess(), body()
        with s.lock:
            _need(s)
            return jsonify(_draw_reply(s, s.draw.bulk(int(b.get("theme", 0)), [int(x) for x in b.get("add", [])][:50],
                                                      [int(x) for x in b.get("reject", [])][:50])))

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
            return jsonify(_draw_reply(s, s.draw.toss_many(b.get("photos", [int(b.get("photo", 0))]))))

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
            return jsonify(_draw_reply(s, s.draw.move(_draw_photos(b),
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
    MIP_LEVELS = (800, 200, 100, 50)  # halvings of the 1600-px preview beyond the 400-px thumbnail; made on first request

    def _mip(s: Session, pid: int, level: int) -> Path | None:
        """The pyramid level for one photo (`?m=<level>` on a thumbnail or preview address): a halving of its
        preview, written beside the previews the first time it is asked for, so a sea of tiny prints never decodes
        more pixels than it shows. Levels above 400 come from the preview, below from the thumbnail."""
        out = s.workdir / "mips" / str(level) / f"{pid}.jpg"
        if out.is_file():
            return out
        src = s.workdir / ("previews" if level > 400 else "thumbs") / f"{pid}.jpg"
        if not src.is_file():
            return None
        out.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((level, level), Image.Resampling.LANCZOS)
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "JPEG", quality=84 if level >= 200 else 80)
            tmp.replace(out)
        return out

    SHOWABLE = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}
    full_images_lock = threading.Lock()  # only one large RAW/HEIC/TIFF decode at a time, outside the game lock

    def _full_image(s: Session, pid: int, original: Path) -> Path:
        stamp = original.stat()
        key = hashlib.sha256(f"{original}:{stamp.st_mtime_ns}:{stamp.st_size}".encode()).hexdigest()[:16]
        out = s.workdir / "full" / f"{pid}-{key}.png"
        if out.is_file():
            return out
        with full_images_lock:
            if not out.is_file():
                # Browsers cannot display every imported format. Decode its full-size pixels, rather than sending
                # the analysis preview under an original-image URL. Lossless pixels preserve fine RAW detail;
                # nothing here crops, enhances or adds JPEG compression to the photo.
                decoded = imageio.decode(original)
                tmp = out.with_suffix(f".{secrets.token_hex(4)}.tmp")
                try:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    decoded.image.save(tmp, "PNG", compress_level=3)
                    tmp.replace(out)
                finally:
                    decoded.image.close()
                    tmp.unlink(missing_ok=True)
        return out

    def _img(sub: str, pid: int):
        s = sess()
        path, mimetype = s.workdir / sub / f"{pid}.jpg", "image/jpeg"
        m = request.args.get("m", "")
        if m == "full":
            row = s.store.one("SELECT rel FROM photos WHERE id=?", (pid,))
            original = s.source / row["rel"] if row else None
            if not original or not original.is_file():
                abort(404, "The original photo is missing.")
            if original.suffix.lower() in SHOWABLE:
                path, mimetype = original, SHOWABLE[original.suffix.lower()]
            else:
                try:
                    path, mimetype = _full_image(s, pid, original), "image/png"
                except (OSError, ValueError, RuntimeError):
                    abort(422, "Could not decode this photo at full resolution.")
        else:
            try:
                level = int(m or 0)
            except ValueError:
                level = 0
            if level in MIP_LEVELS:
                path = _mip(s, pid, level) or path
        if not path.is_file():
            abort(404)
        resp = send_file(path, mimetype=mimetype, conditional=True, max_age=3600)
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
