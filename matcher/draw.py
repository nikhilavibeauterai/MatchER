"""The Draw and the group stage for one library: its shots go into themed groups (you call the likely matches the
machine deals, or let it draw the rest), each group plays its own matches, and the group winners go on to the
knockouts. Every change can be undone, stack edits included. Methods expect the session lock to be held."""
from __future__ import annotations

import json
import math
import re
import secrets
import time
from collections import Counter

import numpy as np
from flask import abort

from . import library, tags, themes
from .store import unblob

TWIN_SIM = 0.88     # a candidate this alike (image embeddings) to a member and close in time asks "same moment?",
TWIN_ANY = 0.93     # or this alike at any time (the lines library.suggest_merges uses)
TWIN_SECONDS = 15 * 60
SETTLED = 0.15      # a group is settled once nobody's chance of going through is between this and 1 minus it
GROUP_BUDGET = 1.2  # …or after this many matches per member (everyone plays at least once either way)
WILDCARD_P = 0.3    # a shot outside its group's places still plays the knockouts at this chance of making the top
HISTORY = 50        # undo steps kept
HINT_WEIGHT = 1.2   # what you said to look for counts this much against looks when dealing (both z-scored)
NAME_WEIGHT = 0.7   # a name you typed yourself steers too, a little less


def _sigmoid(u):
    return 1.0 / (1.0 + np.exp(-u))


class Draw:
    def __init__(self, s):
        self.s = s
        self.ver = 0          # bumped by every change to the themes or who's in them
        self._space = None    # (key, E, F, namer, has, lines, taken_ts per item)
        self._tm = None       # (key, theme id per item, -1 for none)
        self._stage = None    # (key, stage)
        self.focus = None     # the group the group stage is playing right now
        self._words: dict[str, np.ndarray] = {}  # text → SigLIP text embedding

    # ------------------------------------------------------------------ basics
    def changed(self) -> None:
        self.ver += 1
        self._stage = None
        self.s.groups_cache = {}

    def pool_mask(self) -> np.ndarray:
        """What the Draw sorts: the shots in the running in this cup (every cup's, in the Grand Cup)."""
        s = self.s
        if s.cup == "all":
            return s.base_active.copy()
        return s.base_active & (np.array(s.cats) == s.cup)

    def space(self):
        s = self.s
        if self._space is None or self._space[0] != s.version:
            reps = s.reps
            emb, ts = {}, {}
            for k in range(0, len(reps), 500):
                chunk = reps[k:k + 500]
                for r in s.store.q(f"SELECT id, emb, taken_ts FROM photos WHERE id IN ({','.join('?' * len(chunk))})", chunk):
                    ts[r["id"]] = r["taken_ts"]
                    if r["emb"] is not None:
                        emb[r["id"]] = unblob(r["emb"])
            d = len(next(iter(emb.values()))) if emb else 1
            E = np.zeros((len(reps), d), np.float32)
            has = np.zeros(len(reps), bool)
            for i, pid in enumerate(reps):
                v = emb.get(pid)
                if v is not None:
                    E[i] = v / max(float(np.linalg.norm(v)), 1e-9)
                    has[i] = True
            fit = self.s.base_active & has
            F, namer = themes.space(E, fit)
            lines = themes.lines(F, np.flatnonzero(fit))
            self._space = (s.version, E, F, namer, has, lines, np.array([ts.get(p) or np.nan for p in reps], float))
        return self._space[1:]

    def rows(self) -> dict[int, dict]:
        """Every group, in your order (then the order they were made)."""
        return {r["id"]: dict(r) for r in self.s.store.q("SELECT * FROM themes ORDER BY COALESCE(pos, id), id")}

    def reorder(self, order: list[int]) -> dict:
        """Put the groups in this order (ids; any left out keep their place after these). Undoable."""
        rows = self.rows()
        ids = [t for t in dict.fromkeys(int(x) for x in order) if t in rows] + [t for t in rows if t not in set(map(int, order))]
        with self.s.store.tx() as c:
            c.executemany("UPDATE themes SET pos=? WHERE id=?", [(k, t) for k, t in enumerate(ids)])
        self.remember("reorder", before=list(rows.values()))
        self.changed()
        return {"order": ids}

    def theme_of(self) -> np.ndarray:
        s = self.s
        key = (s.version, self.ver)
        if self._tm is None or self._tm[0] != key:
            by_photo = {r["id"]: r["theme_id"] for r in s.store.q("SELECT id, theme_id FROM photos WHERE theme_id IS NOT NULL")}
            tm = np.full(len(s.gids), -1, np.int64)
            for i, gid in enumerate(s.gids):
                t = by_photo.get(s.reps[i])
                if t is None:
                    g = s.groups.get(gid)
                    t = next((by_photo[m] for m in (g["members"] if g else ()) if m in by_photo), None)
                if t is not None:
                    tm[i] = t
            self._tm = (key, tm)
        return self._tm[1]

    def members(self, tid: int) -> np.ndarray:
        return np.flatnonzero(self.pool_mask() & (self.theme_of() == tid))

    def unsorted(self) -> np.ndarray:
        return np.flatnonzero(self.pool_mask() & (self.theme_of() < 0))

    def _photos_of(self, items) -> list[int]:
        s = self.s
        out: list[int] = []
        for i in items:
            g = s.groups.get(s.gids[i])
            out += g["members"] if g else [s.reps[i]]
        return out

    def item(self, photo) -> int:
        i = self.s._item(int(photo))
        if i is None or not self.pool_mask()[i]:
            abort(400, "That photo isn't in the running.")
        return i

    def theme(self, tid) -> dict:
        row = self.s.store.one("SELECT * FROM themes WHERE id=?", (int(tid),))
        if row is None:
            abort(404, "No such group.")
        return dict(row)

    def taken(self) -> set[str]:
        return {r["name"].lower() for r in self.s.store.q("SELECT name FROM themes")}

    # ------------------------------------------------------------------ undo (shared with stack edits)
    def snapshot(self, pids) -> list:
        """How these photos are stacked right now (stack key and crowned frame), to put back on undo."""
        pids = sorted({int(p) for p in pids})
        rows = []
        for k in range(0, len(pids), 500):
            chunk = pids[k:k + 500]
            rows += [[r["id"], r["stack_key"], r["rep_pref"]] for r in self.s.store.q(
                f"SELECT id, stack_key, rep_pref FROM photos WHERE id IN ({','.join('?' * len(chunk))})", chunk)]
        return rows

    def remember(self, label: str, rows: list | None = None, **parts) -> None:
        """One undo step: `rows` (stacking, see snapshot), `themes` ([photo, old theme]), `no` ([theme, photo]
        added), `created` (theme ids to delete), `before` (theme rows to restore), `vote` (a Draw call to take back).
        A group this change left empty goes away, and comes back with the same undo."""
        gone = self._prune()
        if gone:
            parts["before"] = list(parts.get("before", [])) + gone
        hist = self.s.store.get_meta("group_history", []) or []
        self.s.store.set_meta("group_history", (hist + [{"label": label, "rows": rows or [], **parts}])[-HISTORY:])

    def _prune(self) -> list[dict]:
        """Delete groups with no shots left; returns their rows (for undo)."""
        rows = [dict(r) for r in self.s.store.q(
            "SELECT * FROM themes WHERE id NOT IN (SELECT DISTINCT theme_id FROM photos WHERE theme_id IS NOT NULL)")]
        if rows:
            ids = [r["id"] for r in rows]
            with self.s.store.tx() as c:
                c.execute(f"DELETE FROM themes WHERE id IN ({','.join('?' * len(ids))})", ids)
                c.execute(f"DELETE FROM theme_no WHERE theme_id IN ({','.join('?' * len(ids))})", ids)
        return rows

    def last_step(self) -> str | None:
        hist = self.s.store.get_meta("group_history", []) or []
        return hist[-1]["label"] if hist else None

    def undo(self) -> dict:
        """Take back the last change on the Draw or to the stacking. Returns what it was and whether stacks moved."""
        s = self.s
        hist = s.store.get_meta("group_history", []) or []
        if not hist:
            abort(400, "Nothing to undo.")
        last = hist.pop()
        with s.store.tx() as c:
            c.executemany("UPDATE photos SET stack_key=?, rep_pref=? WHERE id=?",
                          [(key, pref, pid) for pid, key, pref in last.get("rows", [])])
            c.executemany("UPDATE photos SET theme_id=? WHERE id=?", [(t, pid) for pid, t in last.get("themes", [])])
            c.executemany("DELETE FROM theme_no WHERE theme_id=? AND photo_id=?", last.get("no", []))
            for tid in last.get("created", []):
                c.execute("DELETE FROM themes WHERE id=?", (tid,))
                c.execute("DELETE FROM theme_no WHERE theme_id=?", (tid,))
            for row in last.get("before", []):
                c.execute("INSERT OR REPLACE INTO themes(id, name, emoji, concept, seed, created, sealed, hint, pos) "
                          "VALUES(?,?,?,?,?,?,?,?,?)", (row["id"], row["name"], row["emoji"], row["concept"], row["seed"],
                                                        row["created"], row["sealed"], row.get("hint"), row.get("pos")))
            if last.get("dismissed"):
                seen = s.store.get_meta("stack_dismissed", []) or []
                c.execute("UPDATE meta SET value=? WHERE key='stack_dismissed'",
                          (json.dumps([p for p in seen if p not in last["dismissed"]]),))
            if last.get("vote"):
                c.execute("UPDATE votes SET undone=1 WHERE id=?", (last["vote"],))
            if last.get("tags"):  # your tag edits, as they were
                tags.unedit(c, last["tags"])
            if last.get("toss"):  # a toss from Quick sort: back in the running
                t = last["toss"]
                c.execute("UPDATE votes SET undone=1 WHERE id=?", (t["vote"],))
                c.execute(f"UPDATE photos SET override=NULL WHERE override='toss' AND id IN ({','.join('?' * len(t['members']))})",
                          t["members"])
        s.store.set_meta("group_history", hist)
        if last.get("toss"):
            library.refresh(s.store)
            s.version = None
            s.ensure_ranker()
            s._fit()
        self.changed()
        return {"undone": last["label"], "next": hist[-1]["label"] if hist else None, "stacks": bool(last.get("rows")),
                "created": last.get("created", [])}

    def _xp(self, call: str, photo: int | None = None, theme: int | None = None, n: int = 1, ms: int | None = None) -> int:
        return self.s.store.add_vote("draw", photo, None, None, ms, extra={"call": call, "theme": theme, "n": n})

    def _assign(self, items, tid: int | None) -> list:
        """Put these shots (every frame of each) in a group, or back in the unsorted pile; returns the undo rows."""
        pids = self._photos_of(items)
        old = []
        for k in range(0, len(pids), 500):
            chunk = pids[k:k + 500]
            old += [[r["id"], r["theme_id"]] for r in self.s.store.q(
                f"SELECT id, theme_id FROM photos WHERE id IN ({','.join('?' * len(chunk))})", chunk)]
            with self.s.store.tx() as c:
                c.execute(f"UPDATE photos SET theme_id=? WHERE id IN ({','.join('?' * len(chunk))})", [tid, *chunk])
        return old

    # ------------------------------------------------------------------ the Draw
    def summary(self, row: dict, mu: np.ndarray | None = None) -> dict:
        s = self.s
        m = self.members(row["id"])
        _, _, _, _, _, ts = self.space()
        if mu is None and s.ranker is not None and s.ranker.post is not None:
            mu = s.ranker.post.mu
        best = m[np.argsort(-mu[m])] if mu is not None and len(m) else m
        return {"id": row["id"], "name": row["name"], "emoji": row["emoji"], "concept": row["concept"], "hint": row.get("hint"),
                "sealed": bool(row["sealed"]), "size": int(len(m)), "seed": row["seed"],
                "cover": s.reps[int(best[0])] if len(best) else row["seed"],
                "mosaic": [s.reps[int(i)] for i in best[:4]],
                "tagline": themes.tagline([None if np.isnan(t) else t for t in ts[m]]) if len(m) else ""}

    def visible(self, rows: dict) -> list[int]:
        """Groups to show in this cup: those with shots here (a group never stays empty: see _prune)."""
        here = set(np.unique(self.theme_of()[self.pool_mask()]).tolist())
        return [t for t in rows if t in here]

    def state(self) -> dict:
        s = self.s
        rows = self.rows()
        mu = s.ranker.post.mu if s.ranker is not None and s.ranker.post is not None else None
        groups = [self.summary(rows[t], mu) for t in self.visible(rows)]
        total = int(self.pool_mask().sum())
        left = len(self.unsorted())
        return {"total": total, "drawn": total - left, "groups": groups, "undo": self.last_step(),
                "done": not left and bool(groups)}

    def create(self, photos, name: str | None = None, emoji: str | None = None) -> dict:
        """A new group from these shots (named for them unless you pass a name, as a tag suggestion does; the first
        one is its seed). One undo step."""
        s = self.s
        tm = self.theme_of()
        items = list(dict.fromkeys(self.item(p) for p in photos))
        if not items:
            abort(400, "Pick at least one photo.")
        _, F, namer, has, _, _ = self.space()
        crew = [i for i in items if has[i]]
        if len(crew) < 3 and crew:  # a name from one or two shots reads better with their closest neighbours
            pool = self.unsorted()
            near, _ = themes.rank(F, crew, [], pool[~np.isin(pool, crew)])
            crew = crew + [int(j) for j in near[:5 - len(crew)]]
        nm = namer.name(crew or items, self.taken())
        if name:
            nm = {"name": re.sub(r"\s+", " ", name).strip()[:60], "emoji": emoji or nm["emoji"], "concept": None}
        with s.store.tx() as c:
            tid = c.execute("INSERT INTO themes(name, emoji, concept, seed, created, sealed, pos) VALUES(?,?,?,?,?,1,(SELECT COALESCE(MAX(COALESCE(pos, id)), 0) + 1 FROM themes))",
                            (nm["name"], nm["emoji"], nm["concept"], s.reps[items[0]], time.time())).lastrowid
        old = self._assign(items, tid)
        vote = self._xp("start", s.reps[items[0]], tid, n=len(items))
        self.remember("new group", themes=old, created=[tid], vote=vote)
        self.changed()
        return self.summary(self.theme(tid))

    def start(self, photo, name: str | None = None, emoji: str | None = None, concept: str | None = None) -> dict:
        s = self.s
        i = self.item(photo)
        if self.theme_of()[i] >= 0:
            abort(400, "That shot is already in a group.")
        _, F, namer, has, _, _ = self.space()
        if not name:
            pool = self.unsorted()
            near, _ = themes.rank(F, [i], [], pool[pool != i]) if has[i] else (np.zeros(0, int), None)
            nm = namer.name([i, *near[:5]], self.taken())
            name, emoji, concept = nm["name"], nm["emoji"], nm["concept"]
        with s.store.tx() as c:
            tid = c.execute("INSERT INTO themes(name, emoji, concept, seed, created, pos) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(COALESCE(pos, id)), 0) + 1 FROM themes))",
                            (str(name)[:60], (emoji or "🗂️")[:8], concept, s.reps[i], time.time())).lastrowid
        old = self._assign([i], tid)
        vote = self._xp("start", s.reps[i], tid)
        self.remember("new group", themes=old, created=[tid], vote=vote)
        self.changed()
        return self.summary(self.theme(tid))

    def rename(self, tid, name: str | None = None, roll: int | None = None, emoji: str | None = None) -> dict:
        """A new name (yours, or the next suggestion with `roll`), or just a new emoji."""
        row = self.theme(tid)
        if emoji is not None and name is None and roll is None:
            emoji = emoji.strip()
            if not emoji or len(emoji) > 16:
                abort(400, "Pick one emoji.")
            name, concept = row["name"], row["concept"]
        elif roll is not None:
            m = self.members(row["id"])
            taken = self.taken() - {row["name"].lower()}
            nm = self.space()[2].name(list(m) or [], taken, int(roll)) if len(m) else themes.wild_name(taken)[0]
            name, emoji, concept = nm["name"], nm["emoji"], nm["concept"]
        else:
            name = (name or "").strip()[:60]
            if not name:
                abort(400, "Give it a name.")
            emoji, concept = row["emoji"], row["concept"]
        with self.s.store.tx() as c:
            c.execute("UPDATE themes SET name=?, emoji=?, concept=? WHERE id=?", (name, emoji, concept, row["id"]))
        self.remember("emoji" if name == row["name"] and emoji != row["emoji"] else "rename", before=[row])
        self.changed()
        return self.summary(self.theme(tid))

    def set_hint(self, tid, hint: str | None) -> dict:
        """What to look for, in your words ("laptops, screens, desks"): the deal leans on it from the next card."""
        row = self.theme(tid)
        hint = (hint or "").strip()[:120] or None
        if hint:
            self._embed(self._queries({**row, "hint": hint})[0])  # embed now, while you wait for one answer
        with self.s.store.tx() as c:
            c.execute("UPDATE themes SET hint=? WHERE id=?", (hint, row["id"]))
        self.remember("look for", before=[row])
        self.changed()
        return self.summary(self.theme(tid))

    def _queries(self, row: dict) -> tuple[list[str], float]:
        """The phrases a group's deal is steered by, and how hard: its "look for" words, else a name you typed."""
        if row.get("hint"):
            terms = [t.strip() for t in re.split(r"[,;/]| or | and ", row["hint"]) if t.strip()][:8]
            return [f"a photo of {t}" for t in terms], HINT_WEIGHT
        if row.get("name") and not themes.stock_name(row["name"]):
            return [f"a photo of {row['name'].strip()}"], NAME_WEIGHT
        return [], 0.0

    def _embed(self, texts: list[str]) -> np.ndarray:
        todo = [t for t in texts if t not in self._words]
        if todo:
            for t, e in zip(todo, library._prompt_embeddings(todo)):
                self._words[t] = e
        return np.stack([self._words[t] for t in texts])

    def _words_for(self, row: dict) -> tuple[np.ndarray | None, float]:
        """Every shot's best match to the group's phrases (None when nothing steers it)."""
        texts, weight = self._queries(row)
        if not texts:
            return None, 0.0
        E = self.space()[0]
        return (E @ self._embed(texts).T).max(1), weight

    def _twin(self, i: int, members: np.ndarray) -> dict | None:
        """The member this candidate might be the same moment as (a merge the stacking missed), if any."""
        s = self.s
        E, _, _, has, _, ts = self.space()
        if not has[i] or not len(members):
            return None
        sims = E[members] @ E[i]
        k = int(np.argmax(sims))
        m, sim = int(members[k]), float(sims[k])
        gap = abs(ts[i] - ts[m])
        if not (sim >= TWIN_ANY or (sim >= TWIN_SIM and not np.isnan(gap) and gap <= TWIN_SECONDS)):
            return None
        pair = sorted((s.reps[i], s.reps[m]))
        if pair in (s.store.get_meta("stack_dismissed", []) or []):
            return None
        return {"of": s.reps[m], "apart": None if np.isnan(gap) else int(gap), "similarity": round(sim, 3)}

    def bins(self) -> list[dict]:
        """Every group in this cup as a drop target, in the order they were made: size and cover (its best shot)."""
        s = self.s
        tm = self.theme_of()
        pool = self.pool_mask()
        rows = self.rows()
        mu = s.ranker.post.mu if s.ranker is not None and s.ranker.post is not None else np.zeros(len(tm))
        size: Counter = Counter()
        cover: dict[int, int] = {}
        for i in np.flatnonzero(pool & (tm >= 0))[np.argsort(-mu[np.flatnonzero(pool & (tm >= 0))], kind="stable")]:
            t = int(tm[i])
            size[t] += 1
            cover.setdefault(t, s.reps[int(i)])
        return [{"id": t, "name": rows[t]["name"], "emoji": rows[t]["emoji"], "size": size[t],
                 "cover": cover.get(t, rows[t]["seed"]), "hint": rows[t].get("hint")} for t in self.visible(rows)]

    def _fits(self, items: list[int], skip: int) -> dict[int, list[int]]:
        """For each item, the (up to) three other groups whose closest shot is most like it."""
        F = self.space()[1]
        tm = self.theme_of()
        pool = self.pool_mask()
        keys = [t for t in self.rows() if t != skip]
        groups = [np.flatnonzero(pool & (tm == t)) for t in keys]
        keys = [t for t, g in zip(keys, groups) if len(g)]
        groups = [g for g in groups if len(g)]
        if not items or not groups:
            return {}
        cols = np.concatenate(groups)
        starts = np.cumsum([0] + [len(g) for g in groups])[:-1]
        per = np.maximum.reduceat(F[items] @ F[cols].T, starts, axis=1)
        return {i: [keys[k] for k in np.argsort(-row)[:3]] for i, row in zip(items, per)}

    def deck(self, tid, n: int = 10, nobulk: set[int] = frozenset()) -> dict:
        """The next likely matches for a group, best first. A run of sure things at the top comes as one bulk card;
        `long` marks candidates no closer than two random shots of this library usually are."""
        s = self.s
        row = self.theme(tid)
        _, F, namer, has, (alike, sure), _ = self.space()
        members = self.members(row["id"])  # (an empty group deals by its words, else in the order shots were taken)
        no = {r["photo_id"] for r in s.store.q("SELECT photo_id FROM theme_no WHERE theme_id=?", (row["id"],))}
        rejected = [i for i in (s._item(p) for p in no) if i is not None]
        rej = set(rejected)
        pool = np.array([i for i in self.unsorted() if has[i] and i not in rej], np.int64)
        words, weight = self._words_for(row)
        if len(members) or words is not None:
            order, score = themes.rank(F, members, rejected, pool, namer.concept_z(row["concept"] or ""), words, weight)
        else:
            ts = self.space()[5]
            order = pool[np.argsort(np.nan_to_num(ts[pool], nan=np.inf), kind="stable")]
            score = np.full(len(order), alike, np.float32)
        wz = themes._z(words[pool]) if words is not None and len(pool) > 1 else None
        wz_of = dict(zip(pool.tolist(), wz.tolist())) if wz is not None else {}
        cards = []
        for i, sc in zip(order[:max(n, 16)], score[:max(n, 16)]):
            pid = s.reps[int(i)]
            fits_words = wz_of.get(int(i), -9) >= 1.0  # a strong match to your words isn't a long shot
            cards.append({"photo": pid, "score": round(float(sc), 3), "long": bool(sc < alike and not fits_words),
                          "twin": self._twin(int(i), members), "view": s.photo_view(pid)})
        run = 0
        while (words is None and run < len(cards) and cards[run]["score"] >= sure and not cards[run]["twin"]
               and cards[run]["photo"] not in nobulk):
            run += 1
        bulk = cards[:min(run, 12)] if run >= themes.BULK_MIN and len(members) >= 2 else []
        rest = cards[len(bulk):][:n]
        fits = self._fits([s._item(c["photo"]) for c in rest], row["id"])
        for c in rest:
            c["fits"] = fits.get(s._item(c["photo"]), [])
        return {"theme": self.summary(row), "bulk": bulk, "cards": rest, "left": int(len(pool)),
                "members": [s.reps[int(i)] for i in members[::-1][:40]], "bins": self.bins()}

    def call(self, tid, photo, call: str, twin: int | None = None, ms: int | None = None) -> dict:
        """One call on a dealt candidate: "in" (joins the group), "out" (not offered to it again) or "twin" (same
        moment as member `twin`: stacked with it, and so in the group too)."""
        s = self.s
        row = self.theme(tid)
        i = self.item(photo)
        tm = self.theme_of()
        if tm[i] >= 0 and call != "out":
            abort(409, "That shot was drawn already.")
        rep = s.reps[i]
        if call == "out":
            with s.store.tx() as c:
                c.execute("INSERT OR IGNORE INTO theme_no(theme_id, photo_id) VALUES(?,?)", (row["id"], rep))
            vote = self._xp("out", rep, row["id"], ms=ms)
            self.remember("not this one", no=[[row["id"], rep]], vote=vote)
        elif call == "in":
            old = self._assign([i], row["id"])
            dismissed = []
            if twin:  # offered as a possible twin, and you said it's its own moment: don't ask again
                pair = sorted((rep, int(twin)))
                seen = s.store.get_meta("stack_dismissed", []) or []
                if pair not in seen:
                    s.store.set_meta("stack_dismissed", seen + [pair])
                    dismissed = [pair]
            vote = self._xp("in", rep, row["id"], ms=ms)
            self.remember("add", themes=old, vote=vote, dismissed=dismissed)
        elif call == "twin":
            j = self.item(twin or 0)
            if tm[j] != row["id"]:
                abort(400, "Stack it with a shot that's in this group.")
            stack = sorted(set(self._photos_of([i, j])))
            rows = self.snapshot(stack)
            old = self._assign([i], row["id"])
            with s.store.tx() as c:
                c.execute(f"UPDATE photos SET stack_key=?, rep_pref=0 WHERE id IN ({','.join('?' * len(stack))})",
                          ["m:" + secrets.token_hex(6), *stack])
            vote = self._xp("twin", rep, row["id"], ms=ms)
            self.remember("twin", rows=rows, themes=old, vote=vote)
        else:
            abort(400, "Unknown call.")
        self.changed()
        return {"stacks": call == "twin"}

    def bulk(self, tid, add, reject) -> dict:
        s = self.s
        row = self.theme(tid)
        tm = self.theme_of()
        items = [i for i in (self.item(p) for p in add) if tm[i] < 0]
        out = [s.reps[self.item(p)] for p in reject]
        old = self._assign(items, row["id"]) if items else []
        with s.store.tx() as c:
            c.executemany("INSERT OR IGNORE INTO theme_no(theme_id, photo_id) VALUES(?,?)", [(row["id"], p) for p in out])
        vote = self._xp("bulk", None, row["id"], n=len(items) + len(out))
        self.remember("bulk add", themes=old, no=[[row["id"], p] for p in out], vote=vote)
        self.changed()
        return {"added": len(items)}

    def seal(self, tid, sealed: bool = True) -> dict:
        row = self.theme(tid)
        if bool(row["sealed"]) == sealed:
            return self.summary(row)
        with self.s.store.tx() as c:
            c.execute("UPDATE themes SET sealed=? WHERE id=?", (int(sealed), row["id"]))
        vote = self._xp("seal", None, row["id"]) if sealed else None
        self.remember("seal" if sealed else "reopen", before=[row], vote=vote)
        self.changed()
        return self.summary(self.theme(tid))

    def auto(self) -> dict:
        """Draw every unsorted shot for you: new groups for the families among them, the rest into the group they fit
        best (or the wildcards), and every group sealed."""
        s = self.s
        _, F, namer, has, (alike, _), ts = self.space()
        left = self.unsorted()
        if not len(left):
            abort(400, "Everything is drawn already.")
        left = left[np.argsort(np.nan_to_num(ts[left], nan=np.inf), kind="stable")]
        pool = np.array([i for i in left if has[i]], np.int64)
        groups, wild = themes.auto_draw(F, pool) if len(pool) else ([], [])
        wild += [int(i) for i in left if not has[i]]
        before = [r for r in self.rows().values() if not r["sealed"]]
        taken = self.taken()
        created, old = [], []
        now = time.time()
        existing = {t: list(self.members(t)) for t in self.rows()}
        for g in groups:
            nm = namer.name(g, taken)
            taken.add(nm["name"].lower())
            with s.store.tx() as c:
                tid = c.execute("INSERT INTO themes(name, emoji, concept, seed, created, sealed, pos) VALUES(?,?,?,?,?,1,(SELECT COALESCE(MAX(COALESCE(pos, id)), 0) + 1 FROM themes))",
                                (nm["name"], nm["emoji"], nm["concept"], s.reps[g[0]], now)).lastrowid
            created.append(tid)
            old += self._assign(g, tid)
            existing[tid] = list(g)
        homeless = [i for i in wild if not has[i]]
        keys = [t for t, m in existing.items() if m]
        seen = [i for i in wild if has[i]]
        best, fit = themes.best_group(F, seen, [existing[t] for t in keys])
        joins: dict[int, list[int]] = {}
        for i, g, f in zip(seen, best, fit):  # a straggler joins the group it fits best, if it fits well enough
            if g >= 0 and f >= alike:
                joins.setdefault(keys[g], []).append(i)
            else:
                homeless.append(i)
        for t, items in joins.items():
            old += self._assign(items, t)
        for k in range(0, len(homeless), themes.THEME_CAP):
            nm = themes.wild_name(taken)[0]
            taken.add(nm["name"].lower())
            with s.store.tx() as c:
                tid = c.execute("INSERT INTO themes(name, emoji, concept, seed, created, sealed, pos) VALUES(?,?,?,?,?,1,(SELECT COALESCE(MAX(COALESCE(pos, id)), 0) + 1 FROM themes))",
                                (nm["name"], nm["emoji"], nm["concept"], s.reps[homeless[k]], now)).lastrowid
            created.append(tid)
            old += self._assign(homeless[k:k + themes.THEME_CAP], tid)
        with s.store.tx() as c:
            c.execute("UPDATE themes SET sealed=1 WHERE sealed=0")
        vote = self._xp("auto", None, None, n=len(left))
        self.remember("auto-draw", themes=old, created=created, before=before, vote=vote)
        self.changed()
        return {"groups": len(created), "placed": int(len(left))}

    def stragglers(self, n: int = 12) -> list[dict]:
        """Unsorted shots, each with the three groups it fits best."""
        s = self.s
        _, F, _, has, _, _ = self.space()
        rows = self.rows()
        sets = {t: self.members(t) for t in rows}
        sets = {t: m for t, m in sets.items() if len(m)}
        ts = self.space()[5]
        left = self.unsorted()
        out = []
        for i in left[np.argsort(np.nan_to_num(ts[left], nan=np.inf), kind="stable")][:n]:  # in the order they were taken
            fits = sorted(((float(themes._topmean(F[[i]], F[m])[0]) if has[i] else 0.0, t) for t, m in sets.items()),
                          reverse=True)[:3]
            out.append({"photo": s.reps[int(i)], "view": s.photo_view(s.reps[int(i)]),
                        "options": [{"id": t, "name": rows[t]["name"], "emoji": rows[t]["emoji"],
                                     "fit": round(f, 3)} for f, t in fits]})
        return out

    def place(self, photo, tid=None, wild: bool = False) -> dict:
        """Put one shot in a group (a straggler, or a move from a group's board); wild: into the wildcards."""
        s = self.s
        i = self.item(photo)
        if wild:
            row = s.store.one("SELECT * FROM themes WHERE concept='wild' ORDER BY id DESC LIMIT 1")
            if row is None:
                nm = themes.wild_name(self.taken())[0]
                with s.store.tx() as c:
                    tid = c.execute("INSERT INTO themes(name, emoji, concept, seed, created, sealed, pos) VALUES(?,?,?,?,?,1,(SELECT COALESCE(MAX(COALESCE(pos, id)), 0) + 1 FROM themes))",
                                    (nm["name"], nm["emoji"], nm["concept"], s.reps[i], time.time())).lastrowid
                old = self._assign([i], tid)
                vote = self._xp("in", s.reps[i], tid)
                self.remember("to the wildcards", themes=old, created=[tid], vote=vote)
                self.changed()
                return {"theme": tid}
            tid = row["id"]
        row = self.theme(tid)
        old = self._assign([i], row["id"])
        vote = self._xp("in", s.reps[i], row["id"])
        self.remember("place", themes=old, vote=vote)
        self.changed()
        return {"theme": row["id"]}

    # ------------------------------------------------------------------ tags
    def tag_sets(self) -> dict[int, set[str]]:
        """Each shot in this cup (by the photo it shows) with its tags as they stand."""
        s = self.s
        reps = [s.reps[int(i)] for i in np.flatnonzero(self.pool_mask())]
        eff = tags.effective(s.store, reps)
        return {r: eff.get(r, set()) for r in reps}

    def tagging(self) -> dict:
        """What the tag sea needs: every tag here and how many shots carry it, the ones drawn as circles and the
        Venn diagrams they fall into, each shot's tags, and the groups their intersections suggest."""
        s = self.s
        sets = self.tag_sets()
        meta = tags.rows(s.store)
        count = Counter(t for v in sets.values() for t in v)
        visible = tags.choose_visible(sets, meta)
        open_reps = {s.reps[int(i)] for i in self.unsorted()}
        order = {f: k for k, f in enumerate(tags.FAMILIES)}
        listed = sorted(({**meta[k], "count": n} for k, n in count.items() if k in meta),
                        key=lambda r: (order.get(r["family"], 9), -r["count"], r["label"]))
        return {"tags": listed, "visible": visible, "diagrams": tags.diagrams(visible, sets),
                "shot_tags": {r: sorted(v) for r, v in sets.items()},
                "suggestions": self._suggestions(sets, open_reps, visible, meta)}

    def _suggestions(self, sets, open_reps, visible, meta) -> list[dict]:
        """The groups the tags suggest: every shot here is clustered (so making one group leaves the other suggestions
        where they were), and each suggestion offers the shots of its cluster that aren't in a group yet."""
        out = []
        for sg in tags.cluster(sets, set(sets), visible, meta, self.taken()):
            shots = [r for r in sg["shots"] if r in open_reps]
            if shots:
                out.append({**sg, "shots": shots})
        return out

    def set_tags(self, photos, on, off) -> dict:
        """Add and take away tags on these shots (every take of each). One undo step."""
        items = list(dict.fromkeys(self.item(p) for p in photos))
        meta = tags.rows(self.s.store)
        on = [t for t in dict.fromkeys(on) if t in meta]
        off = [t for t in dict.fromkeys(off) if t in meta and t not in on]
        if not items or not (on or off):
            abort(400, "Nothing to change.")
        undo = tags.edit(self.s.store, self._photos_of(items), on, off)
        self.remember("tags", tags=undo)
        self.changed()
        return {"on": on, "off": off, "shots": len(items)}

    def tag_meta(self, key: str, label: str | None = None, emoji: str | None = None, hidden=None, pinned=None) -> dict:
        """Rename a tag (a person's tag gets their name), change its emoji, or say whether it's a circle on the sea."""
        s = self.s
        row = s.store.one("SELECT * FROM tags WHERE key=?", (key,))
        if row is None:
            abort(404, "No such tag.")
        sets, args = [], []
        if label is not None and label.strip():
            sets += ["label=?", "named=1"]
            args.append(re.sub(r"\s+", " ", label).strip()[:40])
        if emoji:
            sets += ["emoji=?", "named=1"]
            args.append(emoji[:16])
        if hidden is not None:
            sets.append("hidden=?")
            args.append(int(bool(hidden)))
            if hidden:
                sets.append("pinned=0")
        if pinned is not None:
            sets.append("pinned=?")
            args.append(int(bool(pinned)))
            if pinned:
                sets.append("hidden=0")
        if sets:
            with s.store.tx() as c:
                c.execute(f"UPDATE tags SET {', '.join(sets)} WHERE key=?", (*args, key))
        self.changed()
        return dict(s.store.one("SELECT * FROM tags WHERE key=?", (key,)))

    def tag_new(self, label: str, emoji: str | None, photos) -> dict:
        """A tag of your own, on these shots."""
        if not label or not label.strip():
            abort(400, "Give the tag a name.")
        key = tags.new_tag(self.s.store, label, emoji)
        out = self.set_tags(photos, [key], []) if photos else {}
        return {"key": key, **out}

    def tag_group(self, photos, name: str | None, emoji: str | None) -> dict:
        """A group from a tag suggestion: the shots of that intersection that aren't in a group yet."""
        tm = self.theme_of()
        items = [i for i in dict.fromkeys(self.item(p) for p in photos) if tm[i] < 0]
        if not items:
            abort(400, "Those shots are all in groups already.")
        return self.create([self.s.reps[i] for i in items], name=name, emoji=emoji)

    def toss(self, photo) -> dict:
        """Out of the running, like a toss in a duel: it goes to Set aside (as tossed) instead of into a group."""
        s = self.s
        pid = s.reps[self.item(photo)]
        vote, members = s._toss(pid, None, None)
        self.remember("toss", toss={"vote": vote, "members": members})
        self.changed()
        return {"tossed": pid}

    def move(self, photos, tid=None) -> dict:
        """Move shots to another group (or back to the unsorted pile, tid None)."""
        items = sorted({self.item(p) for p in photos})
        if not items:
            abort(400, "Pick some shots first.")
        target = self.theme(tid)["id"] if tid is not None else None
        old = self._assign(items, target)
        self.remember("move" if target else "unsort", themes=old)
        self.changed()
        return {"moved": len(items)}

    def merge_groups(self, src, dst) -> dict:
        a, b = self.theme(src), self.theme(dst)
        if a["id"] == b["id"]:
            abort(400, "Pick two different groups.")
        old = self._assign(self.members(a["id"]), b["id"])
        with self.s.store.tx() as c:
            c.execute("DELETE FROM themes WHERE id=?", (a["id"],))
        self.remember("merge groups", themes=old, before=[a])
        self.changed()
        return self.summary(self.theme(b["id"]))

    def dissolve(self, tid) -> dict:
        row = self.theme(tid)
        old = self._assign(self.members(row["id"]), None)
        with self.s.store.tx() as c:
            c.execute("DELETE FROM themes WHERE id=?", (row["id"],))
        self.remember("dissolve", themes=old, before=[row])
        self.changed()
        return {"ok": True}

    # ------------------------------------------------------------------ the group stage
    def stage(self) -> dict:
        """This cup's groups (lettered in the order they were made): members in standings order,
        places going through, matches played, and whether each is settled."""
        s, r = self.s, self.s.ranker
        key = (s.n_votes, s.version, self.ver, s.cup)
        if self._stage is not None and self._stage[0] == key:
            return self._stage[1]
        tm = self.theme_of()
        rows = self.rows()
        active = r.active
        sets = [(t, np.flatnonzero(active & (tm == t))) for t in rows]
        sets = [(t, m) for t, m in sets if len(m)]
        adv = themes.advancers({t: len(m) for t, m in sets}, r.k)
        mu, var = r.post.mu, r.post.var
        played = np.zeros(len(tm), np.int64)
        count: Counter = Counter()
        for i, j in s.compared:
            if tm[i] >= 0 and tm[i] == tm[j] and active[i] and active[j]:
                count[int(tm[i])] += 1
                played[i] += 1
                played[j] += 1
        w, l, d = Counter(), Counter(), Counter()
        matches: Counter = Counter()
        for v in s.store.votes():
            if v["kind"] not in ("duel", "great", "meh", "skip"):
                continue
            a, b = s._item(v["a"]), s._item(v["b"])
            if a is None or b is None or a == b or tm[a] < 0 or tm[a] != tm[b]:
                continue
            matches[int(tm[a])] += 1
            if v["kind"] == "duel":
                win = s._item(v["winner"])
                w[win] += 1
                l[b if win == a else a] += 1
            else:
                d[a] += 1
                d[b] += 1
        rng = np.random.default_rng(7)
        groups = {}
        for k, (t, m) in enumerate(sets):
            a, n = adv[t], len(m)
            odds = themes.group_odds(mu[m], var[m], a, rng)
            unsure = float(np.max(np.minimum(odds, 1 - odds))) if n > a else 0.0
            budget = 0 if n <= a else min(math.ceil(GROUP_BUDGET * n), n * (n - 1) // 2)
            settled = n <= a or (played[m].min() >= 1 and (unsure < SETTLED or max(count[t], matches[t]) >= budget))
            order = m[np.argsort(-mu[m], kind="stable")]
            groups[t] = {"id": t, "letter": themes.letter(k), "name": rows[t]["name"], "emoji": rows[t]["emoji"],
                         "n": n, "adv": a, "played": max(count[t], matches[t]), "budget": budget, "settled": bool(settled),
                         "order": order, "odds": {int(i): float(o) for i, o in zip(m, odds)}}
        st = {"groups": groups, "order": [t for t, _ in sets], "played": played, "w": w, "l": l, "d": d}
        self._stage = (key, st)
        return st

    def table(self, tid: int) -> dict | None:
        """One group's standings, as the duel screen shows them."""
        st = self.stage()
        g = st["groups"].get(tid)
        if g is None:
            return None
        s = self.s
        return {"id": tid, "letter": g["letter"], "name": g["name"], "emoji": g["emoji"], "adv": g["adv"],
                "played": g["played"], "budget": g["budget"], "settled": g["settled"],
                "rows": [{"photo": s.reps[int(i)], "w": st["w"][int(i)], "l": st["l"][int(i)], "d": st["d"][int(i)],
                          "through": k < g["adv"], "odds": round(g["odds"][int(i)], 2)}
                         for k, i in enumerate(g["order"])]}

    def team_of(self, pid) -> dict | None:
        """The group a shot plays for (its team in the knockouts and the finals), if it's in one."""
        i = self.s._item(int(pid))
        if i is None:
            return None
        g = self.stage()["groups"].get(int(self.theme_of()[i]))
        return {"letter": g["letter"], "emoji": g["emoji"], "name": g["name"]} if g else None

    def tables(self) -> list[dict]:
        """Every group's standings, A first: the group stage's roster."""
        return [t for t in (self.table(tid) for tid in self.stage()["groups"]) if t]

    def group_of(self, ia: int, ib: int) -> int | None:
        tm = self.theme_of()
        t = int(tm[ia])
        return t if t >= 0 and t == int(tm[ib]) and t in self.stage()["groups"] else None

    def _best_pair(self, st: dict, t: int, busy: set[int]) -> tuple[int, int, bool] | None:
        """The most telling match left in group t among shots not already on their way to the screen: a member that
        hasn't played yet if there is one, else the pair whose result says most about who goes through. Returns
        (a, b, rematch); a rematch only when every free pairing has been played."""
        s, r = self.s, self.s.ranker
        g = st["groups"][t]
        m = [int(i) for i in g["order"] if int(i) not in busy]
        if len(m) < 2:
            return None
        mu, var = r.post.mu, r.post.var
        odds = g["odds"]
        u = {i: odds[i] * (1 - odds[i]) for i in m}
        recent = set(s.recent[-6:])
        fresh = [i for i in m if st["played"][i] == 0]
        if fresh:
            pairs = [(fresh[0], j) for j in m if j != fresh[0]]
        else:
            pool = sorted(m, key=lambda i: -u[i])[:30]
            pairs = [(a, b) for k, a in enumerate(pool) for b in pool[k + 1:]]
        best, top = None, None
        for a, b in pairs:
            q = float(_sigmoid((mu[a] - mu[b]) / math.sqrt(1 + math.pi / 8 * (var[a] + var[b]))))
            v = math.sqrt(q * (1 - q)) * (u[a] * math.sqrt(var[a]) + u[b] * math.sqrt(var[b]) + 0.05)
            if a in recent or b in recent:
                v *= 0.4
            key = ((min(a, b), max(a, b)) not in s.compared, v)  # a fresh pairing beats any rematch
            if top is None or key > top:
                best, top = (a, b), key
        return (best[0], best[1], not top[0]) if best else None

    def group_pair(self, busy: set[int]) -> tuple[int, int, int] | None:
        """The next group-stage match. The group being played keeps going until it settles; when its free shots have
        no fresh pairing left (the other card on its way holds the rest), the match comes from the next open group
        rather than replaying one."""
        st = self.stage()
        open_ = [t for t in st["order"] if not st["groups"][t]["settled"]]
        if not open_:
            return None
        if self.focus not in open_:
            self.focus = open_[0]
        fallback = None
        for t in [self.focus] + [t for t in open_ if t != self.focus]:
            got = self._best_pair(st, t, busy)
            if got is None:
                continue
            a, b, rematch = got
            if rematch:
                fallback = fallback or (a, b, t)
                continue
            return (a, b, t) if np.random.random() < 0.5 else (b, a, t)
        return fallback

    def outside_knockouts(self) -> set[int]:
        """Shots in this cup that don't play the knockouts: grouped, out of their group's places and not a strong
        enough runner-up for a wildcard. Shots in no group play on their own."""
        st = self.stage()
        if not st["groups"]:
            return set()
        r = self.s.ranker
        tm = self.theme_of()
        inside = set()
        for g in st["groups"].values():
            inside |= {int(i) for i in g["order"][:g["adv"]]}
        out = set()
        for i in np.flatnonzero(r.active):
            i = int(i)
            if i not in inside and int(tm[i]) in st["groups"] and r.post.p_in[i] < WILDCARD_P:
                out.add(i)
        return out

    def default_stage(self) -> str | None:
        st = self.stage()
        if not st["groups"]:
            return None
        return "groups" if any(not g["settled"] for g in st["groups"].values()) else "knockouts"

    def journey(self) -> dict:
        st = self.stage()
        total = int(self.pool_mask().sum())
        left = len(self.unsorted())
        G = st["groups"].values()
        settled = sum(g["settled"] for g in G)
        focus = st["groups"].get(self.focus) or next((g for g in G if not g["settled"]), None)
        return {"draw": {"total": total, "drawn": total - left, "groups": len(st["groups"]), "open": 0,
                         "done": left == 0 and total > 0},
                "groups": {"groups": len(st["groups"]), "settled": settled, "done": bool(st["groups"]) and settled == len(st["groups"]),
                           "now": {"letter": focus["letter"], "name": focus["name"], "emoji": focus["emoji"]} if focus else None,
                           "through": sum(g["adv"] for g in G)}}
