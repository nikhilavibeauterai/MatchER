"""Bracket results belong to the contenders that played them; editing that field reopens the tournament."""
from __future__ import annotations

import hashlib
import json
import time


def fields(store, previous_themes=()):
    # Refresh replaces photos and groups together; take both reads from the same committed field.
    with store.lock:
        photos = {r["id"]: dict(r) for r in store.q("SELECT id,status,cut,category,theme_id FROM photos")}
        groups = store.q("SELECT rep,members FROM groups ORDER BY rep")
    for pid, theme in previous_themes:
        if pid in photos:
            photos[pid]["theme_id"] = theme
    cups = {"all": []}
    for group in groups:
        rep = photos.get(group["rep"])
        if rep is None or rep["status"] != "analyzed" or rep["cut"] is not None:
            continue
        members = sorted(json.loads(group["members"]))
        theme = rep["theme_id"]
        if theme is None:
            theme = next((photos[p]["theme_id"] for p in members if p in photos and photos[p]["theme_id"] is not None), None)
        entry = [group["rep"], members, theme]
        cups["all"].append(entry)
        if rep["category"]:
            cups.setdefault(rep["category"], []).append(entry)
    return cups


def signature(field):
    return hashlib.sha256(json.dumps(field, separators=(",", ":")).encode()).hexdigest()


def basis(store, cup):
    return signature(fields(store).get(cup, []))


def stamp_legacy(store, previous_themes=()):
    """The first explicit edit gives an older bracket its pre-edit field, before that evidence is lost."""
    rows = store.q("SELECT key,value FROM meta WHERE key LIKE 'knockouts:%' OR key LIKE 'finals:%'")
    missing = [(r["key"], json.loads(r["value"])) for r in rows if r["value"] != "null"]
    missing = [(key, state) for key, state in missing if state and not state.get("basis")]
    if missing:
        current = fields(store, previous_themes)
        with store.tx() as c:
            for key, state in missing:
                state["basis"] = signature(current.get(key.split(":", 1)[1], []))
                c.execute("UPDATE meta SET value=? WHERE key=?", (json.dumps(state), key))


def capture(store):
    keys = store.q("SELECT key,value FROM meta WHERE key LIKE 'knockouts:%' OR key LIKE 'finals:%'")
    champions = store.get_meta("champions", {}) or {}
    out = {}
    for row in keys:
        state = json.loads(row["value"])
        if state:
            kind, cup = row["key"].split(":", 1)
            out.setdefault(cup, {})[kind] = state
    for cup, winner in champions.items():
        out.setdefault(cup, {})["champion"] = winner
    if out:
        current = fields(store)
        for cup, saved in out.items():
            saved["basis"] = next((saved[k]["basis"] for k in ("knockouts", "finals")
                                   if saved.get(k, {}).get("basis")), signature(current.get(cup, [])))
    return out


def compatible(saved, field):
    expected = signature(field)
    if saved.get("basis") is not None and saved["basis"] != expected:
        return False
    reps = {row[0] for row in field}
    for kind in ("knockouts", "finals"):
        state = saved.get(kind) or {}
        if state.get("basis") is not None and state["basis"] != expected:
            return False
        seeds = state.get("seeds", [])
        if len(seeds) != len(set(seeds)) or not set(seeds) <= reps:
            return False
    return saved.get("champion") is None or saved["champion"] in reps


def reconcile(store):
    with store.lock:
        saved = capture(store)
        if not saved:
            return
        current = fields(store)
        invalid = {cup: state for cup, state in saved.items() if not compatible(state, current.get(cup, []))}
        retire(store, invalid, saved)


def retire(store, cups, saved=None, kinds=("knockouts", "finals")):
    saved = capture(store) if saved is None else saved
    parts = (*kinds, "basis", "champion") if "finals" in kinds else (*kinds, "basis")
    invalid = {cup: {k: v for k, v in saved[cup].items() if k in parts} for cup in cups if cup in saved
               and (any(saved[cup].get(k) for k in kinds) or "finals" in kinds and saved[cup].get("champion"))}
    if not invalid:
        return
    with store.tx() as c:
        def meta(key, value):
            c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
        champions = store.get_meta("champions", {}) or {}
        for cup in invalid:
            for kind in kinds:
                meta(f"{kind}:{cup}", None)
            if "finals" in kinds:
                champions.pop(cup, None)
        meta("champions", champions)
        archive = store.get_meta("tournament_archive", []) or []
        meta("tournament_archive", (archive + [{"at": time.time(), "cups": invalid}])[-20:])


def restore(store, saved):
    if not saved:
        return
    current = fields(store)
    champions = store.get_meta("champions", {}) or {}
    for cup, previous in saved.items():
        # A new run or a later edit has precedence over an old undo record.
        if cup in champions or any(store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals")):
            continue
        if not compatible(previous, current.get(cup, [])):
            continue
        for kind in ("knockouts", "finals"):
            store.set_meta(f"{kind}:{cup}", previous.get(kind))
        if previous.get("champion") is not None:
            champions[cup] = previous["champion"]
    store.set_meta("champions", champions)


def restorable(store, saved):
    """Capture replacement runs before undo's rebuild can retire them."""
    champions = store.get_meta("champions", {}) or {}
    return {cup: state for cup, state in (saved or {}).items() if cup not in champions and
            not any(store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals"))}
