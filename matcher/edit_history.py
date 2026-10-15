"""Redo replays the actual fields restored by undo, never a freshly interpreted player vote."""
from __future__ import annotations

import json
import time

from flask import abort

from .filtering import digest

LIMIT = 50
TABLES = {
    "photos": ("id", "stack_key", "rep_pref", "theme_id", "override", "edits"),
    "themes": ("id", "name", "emoji", "concept", "seed", "created", "sealed", "hint", "pos"),
    "theme_no": ("theme_id", "photo_id"),
    "tags": ("key", "label", "emoji", "family", "user", "named", "hidden", "pinned"),
    "tag_edits": ("photo_id", "tag", "val"),
    "tag_aliases": ("source", "target"),
    "votes": ("id", "undone"),
}
KEYS = {"theme_no": 2, "tag_edits": 2}
META = {"stack_dismissed", "filter_policy", "filter_policy_version", "filter_finished", "filter_edit_token",
        "filter_reviews", "filter_considered", "filter_preferences", "filter_bracket_archive", "tournament_archive", "champions", "mini_state"}


def _keys(entry):
    photos = {row[0] for key in ("rows", "themes", "overrides", "tags", "edits") for row in entry.get(key, [])}
    if entry.get("photo") is not None:
        photos.add(entry["photo"])
    photos.update(int(pid) for pid, _ in (entry.get("filter_before") or {}).get("decision_patch", []))
    themes = set(entry.get("created", [])) | {row["id"] for row in entry.get("before", [])}
    themes.update(row[0] for row in entry.get("no", []))
    votes = {entry["vote"]} if entry.get("vote") else set()
    votes.update(row[0] for row in entry.get("vote_states", []))
    votes.update(entry.get("inserted_votes", []))
    for toss in entry.get("tosses", [entry["toss"]] if entry.get("toss") else []):
        photos.update(toss.get("members", [])); votes.add(toss["vote"])
    return {"photos": sorted(photos), "themes": sorted(themes), "theme_no": sorted(themes),
            "votes": sorted(votes), "tags": [row[0] for row in entry.get("tag_rows", [])],
            "tag_aliases": [row[0] for row in entry.get("tag_aliases", [])],
            "tag_edits": [row[:2] for row in entry.get("tags", [])]}


def capture(s, scope):
    state = {}
    for table, columns in TABLES.items():
        keys = scope[table]
        rows = []
        for start in range(0, len(keys), 400):
            batch = keys[start:start + 400]
            if table == "tag_edits":
                where, values = " OR ".join("(photo_id=? AND tag=?)" for _ in batch), [value for pair in batch for value in pair]
            else:
                where, values = f"{columns[0]} IN ({','.join('?' * len(batch))})", batch
            rows.extend(s.store.q(f"SELECT {','.join(columns)} FROM {table} WHERE {where}", values))
        state[table] = {json.dumps(list(row)[:KEYS.get(table, 1)]): list(row) for row in rows}
    state["meta"] = {row["key"]: json.loads(row["value"]) for row in s.store.q(
        f"SELECT key,value FROM meta WHERE key IN ({','.join('?' * len(META))}) "
        "OR key LIKE 'finals:%' OR key LIKE 'knockouts:%' OR key LIKE 'group_qualification:%'", list(META))}
    state["meta"]["settings:max_age_years"] = s.settings["max_age_years"]
    if scope["photos"]:
        decisions = s.store.get_meta("filter_decisions", {}) or {}
        state["meta"].update((f"filter_decision:{pid}", decisions.get(str(pid))) for pid in scope["photos"])
    return state


def guard(s):
    # Later game calls and a changed library invalidate forward replay, even if their own undo follows.
    votes = s.store.one("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS last, COALESCE(SUM(id*undone),0) AS undone FROM votes")
    return [list(votes), s.store.get_meta("filter_revision")]


def describe(s, entry):
    if not entry:
        return None
    photos = _keys(entry)["photos"]
    if entry.get("photo") is not None:
        photos = [entry["photo"], *[pid for pid in photos if pid != entry["photo"]]]
    if not photos and entry.get("vote"):
        vote = s.store.one("SELECT a,b FROM votes WHERE id=?", (entry["vote"],))
        if vote:
            photos = [pid for pid in vote if pid is not None]
    if not photos:
        photos = [row["seed"] for row in entry.get("before", []) if row.get("seed")]
    if not photos and entry.get("qualification"):
        saved = s.store.get_meta(f"group_qualification:{entry['qualification']['cup']}") or {}
        photos = sorted({pid for group in (saved.get("leaders") or {}).values() for pid in group})
    return {"label": entry["label"], "photo": photos[0] if photos else None, "photos": photos[:4], "count": len(photos)}


def _available(s, redo, history):
    if not redo or redo[-1]["history"] != digest(history) or redo[-1]["guard"] != guard(s):
        return False
    item = redo[-1]
    current = capture(s, item["scope"])
    return all(current[table].get(key) == old for table, key, old, _ in item["patch"])


def history(s, stream="group", stage=None):
    undo = s.store.get_meta("group_history", []) or []
    redo = s.store.get_meta(f"{stream}_redo", []) or []
    entry = vote_entry(s, stage) if stream == "vote" else undo[-1] if undo else None
    return {"undo": describe(s, entry),
            "redo": redo[-1].get("descriptor") or describe(s, redo[-1]["entry"]) if _available(s, redo, undo) else None}


def shared_history(s):
    """Home follows the most recent action across editors and games, with an independent redo stream."""
    groups = s.store.get_meta("group_history", []) or []
    group, vote = groups[-1] if groups else None, vote_entry(s)
    selected, ambiguous = None, False
    if not group or not vote:
        selected = "group" if group else "vote" if vote else None
    else:
        boundary = group.get("vote_boundary", group.get("filter_vote_after", (group.get("qualification") or {}).get("vote_after")))
        if boundary is None:
            boundary = max([group.get("vote", 0), *group.get("inserted_votes", [])]) or None
        if boundary is None:
            ambiguous = True  # Old unsequenced edits cannot truthfully be ordered against game votes.
        else:
            selected = "group" if boundary >= vote["vote"] else "vote"
    forward = []
    for stream in ("group", "vote"):
        items = s.store.get_meta(f"{stream}_redo", []) or []
        if _available(s, items, groups):
            forward.append((items[-1].get("at", 0), stream, items[-1]))
    latest = max(forward, key=lambda item: item[0]) if forward else None
    redo_stream = latest[1] if latest else None
    return {"stream": selected or redo_stream, "undo_stream": selected, "redo_stream": redo_stream, "ambiguous": ambiguous,
            "undo": describe(s, group if selected == "group" else vote) if selected else None,
            "redo": (latest[2].get("descriptor") or describe(s, latest[2]["entry"])) if latest else None}


def before_undo(s):
    history = s.store.get_meta("group_history", []) or []
    if not history:
        return None
    entry = history[-1]
    scope = _keys(entry)
    return {"entry": entry, "scope": scope, "state": capture(s, scope), "history": digest(history[:-1]),
            "draw": True, "descriptor": describe(s, entry)}


def vote_entry(s, stage=None):
    vote = s.store.one("SELECT * FROM votes WHERE undone=0 AND kind!='draw' ORDER BY id DESC LIMIT 1")
    rows = s.store.get_meta("group_history", []) or []
    latest = rows[-1] if rows else {}
    qualification = latest.get("qualification")
    if stage == "groups" and qualification and qualification["cup"] == s.cup and (not vote or vote["id"] <= qualification["vote_after"]):
        return latest
    if not vote:
        return None
    extra = json.loads(vote["extra"] or "{}")
    photos = {vote[key] for key in ("a", "b", "winner") if vote[key] is not None}
    for key in ("frames", "stack", "members"):
        photos.update(extra.get(key) or [])
    previous = extra.get("prev")
    photos.update(map(int, previous) if isinstance(previous, dict) else [previous] if previous else [])
    entry = {"label": "final" if extra.get("final") else "knockout" if extra.get("knockout") else
             "crown" if vote["kind"] in {"frame", "fduel"} else vote["kind"],
             "photo": vote["winner"] or vote["a"], "vote": vote["id"], "rows": [[pid] for pid in sorted(photos)],
             "refresh": vote["kind"] in {"toss", "sweep", "frame"}, "game_vote": True}
    if vote["kind"] == "frame" and extra.get("mini"):
        rnd = s.store.one("SELECT id FROM votes WHERE undone=0 AND kind='fduel' AND id<? ORDER BY id DESC LIMIT 1", (vote["id"],))
        if rnd:
            entry["vote_states"] = [[rnd["id"], 0]]
    return entry


def before_vote_undo(s, stage=None):
    entry = vote_entry(s, stage)
    if not entry:
        return None
    if not entry.get("game_vote"):
        return before_undo(s)
    scope = _keys(entry)
    return {"entry": entry, "scope": scope, "state": capture(s, scope), "draw": False, "descriptor": describe(s, entry),
            "history": digest(s.store.get_meta("group_history", []) or [])}


def after_undo(s, ticket, result, stream="group"):
    if not ticket or digest(s.store.get_meta("group_history", []) or []) != ticket["history"]:
        return
    undone = capture(s, ticket["scope"])
    patch = []
    for table, rows in ticket["state"].items():
        for key in rows.keys() | undone[table].keys():
            old, new = undone[table].get(key), rows.get(key)
            if old != new:
                patch.append([table, key, old, new])
    redo = s.store.get_meta(f"{stream}_redo", []) or []
    redo.append({"entry": ticket["entry"], "scope": ticket["scope"], "patch": patch,
                 "at": time.time_ns(),
                 "descriptor": ticket["descriptor"],
                 "history": ticket["history"], "guard": guard(s),
                 "draw": ticket["draw"], "refresh": result.get("refresh", ticket["entry"].get("refresh", False)),
                 "stacks": result.get("stacks", False)})
    s.store.set_meta(f"{stream}_redo", redo[-LIMIT:])


def redo(s, stream="group"):
    previous = s.store.get_meta("group_history", []) or []
    forward = s.store.get_meta(f"{stream}_redo", []) or []
    if not _available(s, forward, previous):
        abort(409, "That choice can no longer be redone after newer changes.")
    item = forward[-1]
    decision_updates = {key.split(":", 1)[1]: new for table, key, old, new in item["patch"]
                        if table == "meta" and key.startswith("filter_decision:")}
    with s.store.tx() as c:
        for table, key, old, new in item["patch"]:
            if table == "meta":
                if key.startswith("filter_decision:"):
                    continue
                if key == "settings:max_age_years":
                    key, new = "settings", {**s.settings, "max_age_years": new}
                if new is None:
                    c.execute("DELETE FROM meta WHERE key=?", (key,))
                else:
                    c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(new)))
                continue
            columns, size = TABLES[table], KEYS.get(table, 1)
            keys = json.loads(key)
            where = " AND ".join(f"{column}=?" for column in columns[:size])
            if new is None:
                c.execute(f"DELETE FROM {table} WHERE {where}", keys)
            elif table in {"photos", "votes"}:
                c.execute(f"UPDATE {table} SET {','.join(f'{column}=?' for column in columns[size:])} WHERE {where}", [*new[size:], *keys])
            else:
                c.execute(f"INSERT OR REPLACE INTO {table}({','.join(columns)}) VALUES({','.join('?' * len(columns))})", new)
        if decision_updates:
            decisions = s.store.get_meta("filter_decisions", {}) or {}
            for pid, value in decision_updates.items():
                if value is None:
                    decisions.pop(pid, None)
                else:
                    decisions[pid] = value
            c.execute("INSERT INTO meta(key,value) VALUES('filter_decisions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(decisions or None),))
        if item["draw"]:
            c.execute("INSERT INTO meta(key,value) VALUES('group_history',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps((previous + [item["entry"]])[-LIMIT:]),))
        c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (f"{stream}_redo", json.dumps(forward[:-1])))
    s.filter_preview = None
    s.draw.changed(reconcile=False)
    if any(table in {"tags", "tag_edits", "tag_aliases"} for table, *_ in item["patch"]):
        s.store.set_meta("tag_version", (s.store.get_meta("tag_version", 0) or 0) + 1)
        s.draw._tag_cache = None
    # Drawing or finishing a photo leaves the contenders and the pending match intact. Replaying those edits
    # during a duel must not retire the card the player is about to choose.
    if item["entry"]["label"] != "edit" or not item["entry"].get("edits"):
        s.cards.clear()
        s._mini_saved = s.store.get_meta("mini_state", {}) or {}
        s.minis = {}
        s.followups = list(s._mini_saved.get("followups", []))
        s._minis_dirty = False
        s.version = None
    return {"redone": item["entry"]["label"], "refresh": item["refresh"], "stacks": item["stacks"]}
