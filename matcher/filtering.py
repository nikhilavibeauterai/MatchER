"""Editable, reversible library admission rules. Preview reads measurements; it never runs vision models."""
from __future__ import annotations

import hashlib
import json
import math
import secrets
import time
from collections import Counter

from flask import abort

VERSION = 1
LABELS = {"required_tags": "Missing selected subjects", "excluded_tags": "Selected subject set aside",
          "filter_fit": "Below your Filter line"}
LEARNING_LIMIT = 256
LEARNING_SUPPORT = 3
REASONS = {"blur", "light", "size", "age", "subject", "exception"}
UNSPECIFIED = object()
RULE_REASONS = {"min_pixels": "size", "min_luma": "light", "max_luma": "light", "accidental_luma": "light",
                "max_age_years": "age", "blur_sharpness": "blur", "blur_confidence": "blur",
                "face_blur_sharpness": "blur", "face_blur_min_pixels": "blur", "accidental_sharpness": "blur"}


def defaults(settings):
    profile = settings.get("mode", "me") != "gallery"
    return {"min_pixels": 400, "blur_sharpness": 15 if profile else 25, "blur_confidence": .8,
            "min_luma": 28 if profile else 14, "max_luma": 240 if profile else 245,
            "screenshot": True, "screenshot_confidence": .85, "document": True, "document_confidence": .9,
            "accidental": True, "accidental_confidence": .85, "accidental_luma": 45, "accidental_sharpness": 60,
            "max_age_years": settings.get("max_age_years", 0), "require_face": True, "require_you": True,
            "excluded_people": True, "min_face_fraction": .025, "face_blur_sharpness": 8,
            "face_blur_min_pixels": 80, "require_tags": [], "require_mode": "all", "exclude_tags": [],
            "fit_threshold": .5, "fit_examples": []}


def rules(settings):
    profile = settings.get("mode", "me") != "gallery"
    def number(key, label, lo, hi, step, unit="", section="quality", help=""):
        return dict(key=key, label=label, type="number", min=lo, max=hi, step=step, unit=unit, section=section, help=help)
    def toggle(key, label, section="content"):
        return dict(key=key, label=label, type="boolean", section=section)
    out = [number("min_pixels", "Minimum short edge", 0, 10000, 50, "px", help="Smaller images are set aside. Zero keeps every size."),
           number("blur_sharpness", "Blur: sharpness below", 0, 2000, 1, help="Laplacian variance; lower values mean less detail. Unknown measurements are kept."),
           number("min_luma", "Minimum brightness", 0, 255, 1, help="0 is black, 255 is white. Uses your face in profile mode, the whole image otherwise."),
           number("max_luma", "Maximum brightness", 0, 255, 1),
           number("max_age_years", "Maximum age", 0, 100, 1, "years", help="Zero keeps every age; unknown dates are kept."),
           toggle("screenshot", "Set aside screenshots"),
           number("screenshot_confidence", "Screenshot score above", 0, 1, .01, section="content", help="Model comparison score, not a calibrated probability; camera photos need filename evidence.")]
    if profile:
        out += [toggle("require_face", "Require a visible face", "identity"), toggle("require_you", "Require you", "identity"),
                toggle("excluded_people", "Set aside excluded people", "identity"),
                number("min_face_fraction", "Minimum face height", 0, 1, .005, "image fraction", "identity"),
                number("face_blur_sharpness", "Face sharpness below", 0, 2000, 1, section="quality", help="Blur requires both the face and whole-image sharpness below their limits."),
                number("face_blur_min_pixels", "Measure face blur above", 0, 1600, 1, "px")]
    else:
        out += [number("blur_confidence", "Blur score above", 0, 1, .01, help="Blur requires both low measured sharpness and model evidence."),
                toggle("document", "Set aside documents and receipts"), number("document_confidence", "Document score above", 0, 1, .01, section="content"),
                toggle("accidental", "Set aside accidental shots"), number("accidental_confidence", "Accidental score above", 0, 1, .01, section="content"),
                number("accidental_luma", "Accidental: brightness below", 0, 255, 1),
                number("accidental_sharpness", "Accidental: sharpness below", 0, 2000, 1)]
    for rule in out:
        rule["advanced"] = (rule["key"].endswith("_confidence") or rule["key"].startswith("face_blur_")
                            or rule["key"] in {"accidental_luma", "accidental_sharpness", "min_face_fraction"})
    return out


def policy(store, settings=None):
    from .config import DEFAULT_SETTINGS
    settings = settings or {**DEFAULT_SETTINGS, **(store.get_meta("settings", {}) or {})}
    stored = store.get_meta("filter_policy") or {}
    return resolve_tags(store, {**defaults(settings), **stored})


def resolve_tags(store, p):
    """A renamed/merged tag keeps its meaning; deleting a tag also retires the rule referring to it."""
    aliases = {r["source"]: r["target"] for r in store.q("SELECT source,target FROM tag_aliases")}
    out = dict(p)
    for name in ("require_tags", "exclude_tags"):
        if name not in out or not isinstance(out[name], list):
            continue
        if any(not isinstance(key, str) for key in out[name]):
            continue  # Validation reports the malformed value without trying to hash it.
        resolved = []
        for key in out[name]:
            seen = set()
            while key in aliases and key not in seen:
                seen.add(key); key = aliases[key]
            if key is not None and key not in seen:
                resolved.append(key)
        out[name] = list(dict.fromkeys(resolved))
    return out


def validate(value, settings, known_tags):
    if not isinstance(value, dict):
        abort(400, "policy must be an object.")
    out = defaults(settings)
    bounds = {r["key"]: r for mode in ("me", "gallery") for r in rules({**settings, "mode": mode})}
    for key, val in value.items():
        if key not in out:
            abort(400, f"Unknown filter rule: {key}.")
        if key == "fit_threshold":
            if isinstance(val, bool) or not isinstance(val, (float, int)) or not math.isfinite(val) or not 0 <= val <= 1:
                abort(400, "fit_threshold must be between 0 and 1.")
            out[key] = val
        elif key == "fit_examples":
            if not isinstance(val, list) or len(val) > LEARNING_LIMIT:
                abort(400, f"fit_examples must contain at most {LEARNING_LIMIT} examples.")
            examples = {}
            for item in val:
                if (not isinstance(item, dict) or set(item) not in ({"photo", "direction"}, {"photo", "direction", "seq"})
                        or isinstance(item["photo"], bool) or not isinstance(item["photo"], int)
                        or not 0 < item["photo"] <= 10**12
                        or not isinstance(item["direction"], str) or item["direction"] not in {"toward", "away"}):
                    abort(400, "Each fit example needs a photo ID and toward or away direction.")
                if "seq" in item and (isinstance(item["seq"], bool) or not isinstance(item["seq"], int) or not 0 < item["seq"] < 2**53):
                    abort(400, "A teaching sequence must be a positive safe integer.")
                examples.pop(item["photo"], None)
                examples[item["photo"]] = dict(item)
            out[key] = list(examples.values())
        elif key in ("require_tags", "exclude_tags"):
            if not isinstance(val, list) or len(val) > 200 or any(not isinstance(x, str) or x not in known_tags for x in val):
                abort(400, f"{key} must contain existing tag keys (at most 200).")
            out[key] = sorted(set(val))
        elif key == "require_mode":
            if val not in ("all", "any"):
                abort(400, "require_mode must be all or any.")
            out[key] = val
        elif bounds[key]["type"] == "boolean":
            if not isinstance(val, bool):
                abort(400, f"{key} must be true or false.")
            out[key] = val
        else:
            rule = bounds[key]
            if isinstance(val, bool) or not isinstance(val, (float, int)) or not math.isfinite(val) or not rule["min"] <= val <= rule["max"]:
                abort(400, f"{key} must be between {rule['min']} and {rule['max']}.")
            out[key] = val
    if out["min_luma"] > out["max_luma"]:
        abort(400, "Minimum brightness cannot exceed maximum brightness.")
    return out


def evaluate(photo, evidence, p, mode, tag_set=(), now=None):
    """All policy reasons, in stable order. Equality passes; unknown measurements abstain."""
    from .library import SCREENSHOT_NAME
    now = time.time() if now is None else now
    scores, face = evidence.get("scores", {}), evidence.get("face") or {}
    def below(value, threshold):
        return value is not None and value < threshold
    def above(value, threshold):
        return value is not None and value > threshold
    why = []
    if photo.get("status") == "error":
        why.append("unreadable")
    if photo.get("width") and photo.get("height") and min(photo["width"], photo["height"]) < p["min_pixels"]:
        why.append("tiny")
    name = photo["rel"].rsplit("/", 1)[-1]
    if p["screenshot"] and (SCREENSHOT_NAME.search(name) or (above(scores.get("screenshot"), p["screenshot_confidence"]) and not photo.get("make"))):
        why.append("screenshot")
    if mode != "gallery":
        if p["excluded_people"] and evidence.get("excluded"):
            why.append("excluded_person")
        if p["require_face"] and evidence.get("faces") is not None and not evidence["faces"]:
            why.append("no_person" if above(scores.get("no_person"), .6) else "no_face")
        elif p["require_you"] and evidence.get("has_you") is not None and not evidence["has_you"]:
            why.append("not_you" if evidence.get("large_face") else "no_face")
        if face:
            if below(face.get("h"), p["min_face_fraction"]):
                why.append("too_small")
            if (face.get("px") or 0) >= p["face_blur_min_pixels"] and below(face.get("sharp"), p["face_blur_sharpness"]) and below(photo.get("sharp"), p["blur_sharpness"]):
                why.append("blurry")
            if below(face.get("luma"), p["min_luma"]) or above(face.get("luma"), p["max_luma"]):
                why.append("exposure")
    else:
        if p["document"] and above(scores.get("document"), p["document_confidence"]):
            why.append("document")
        if below(photo.get("luma"), p["min_luma"]) or (p["accidental"] and above(scores.get("accidental"), p["accidental_confidence"])
                and (below(photo.get("luma"), p["accidental_luma"]) or below(photo.get("sharp"), p["accidental_sharpness"]))):
            why.append("accidental")
        if below(photo.get("sharp"), p["blur_sharpness"]) and above(scores.get("blurry"), p["blur_confidence"]):
            why.append("blurry")
        if above(photo.get("luma"), p["max_luma"]):
            why.append("exposure")
    age = (now - photo["taken_ts"]) / (365.25 * 86400) if photo.get("taken_ts") else None
    if p["max_age_years"] and age is not None and age > p["max_age_years"]:
        why.append("old")
    actual = set(tag_set)
    required = set(p["require_tags"])
    if required and (not required <= actual if p["require_mode"] == "all" else not required & actual):
        why.append("required_tags")
    if actual & set(p["exclude_tags"]):
        why.append("excluded_tags")
    return list(dict.fromkeys(why))


def disposition(photo, reasons):
    # An override can rescue a judgement; it cannot manufacture pixels for a failed read.
    if photo.get("status") == "error":
        return "unreadable"
    if photo.get("override") == "keep":
        return None
    if photo.get("override") == "toss":
        return "tossed"
    return next(iter(reasons), None)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def input_revision(photos, p, mode, sets):
    """Completion follows the analysed inputs and policy, never a duel, cup switch or manual toss."""
    content = bool(p["require_tags"] or p["exclude_tags"] or p.get("fit_examples"))
    wanted = set().union(*sets.values()) if p.get("fit_examples") else set(p["require_tags"] + p["exclude_tags"])
    return digest([VERSION, mode, p, [[row["id"], row.get("status"), row.get("size"), row.get("mtime_ns"),
                    row.get("width"), row.get("height"), row.get("taken_ts"), row.get("sharp"), row.get("luma"),
                    [row.get(key) for key in ("luma_lo", "luma_hi", "chroma", "saturation", "hue")] if p.get("fit_examples") else None,
                    json.loads(row.get("zs") or "{}"),
                    sorted(sets.get(row["id"], set()) & wanted) if content else None] for row in photos]])


def stage(store):
    counts = store.get_meta("filter_counts") or {}
    accepted = store.get_meta("filter_finished")
    revision = store.get_meta("filter_revision")
    return {"done": bool(revision and accepted == revision), "total": counts.get("total", 0),
            "kept": counts.get("kept", 0), "aside": counts.get("aside", 0),
            "reviewed": counts.get("reviewed", 0)}


def counts(rows):
    return {"total": len(rows), "kept": sum(r["cut"] is None for r in rows), "aside": sum(r["cut"] is not None for r in rows),
            "changed": sum(r.get("changed", False) for r in rows), "to_keep": sum(r.get("changed", False) and r["cut"] is None for r in rows),
            "to_aside": sum(r.get("changed", False) and r["cut"] is not None for r in rows),
            "manual_keep": sum(r.get("override") == "keep" for r in rows), "manual_aside": sum(r.get("override") == "toss" for r in rows),
            "unreadable": sum(r.get("status") == "error" for r in rows)}


def snapshot(s):
    from . import tags
    photos = [dict(r) for r in s.store.q("SELECT id, rel, status, error, size, mtime_ns, sha256, phash, width, height, make, taken_ts, sharp, luma, luma_lo, luma_hi, chroma, saturation, hue, "
              "zs, cut, override, stack_key, group_id, rep_pref, theme_id FROM photos WHERE status IN ('analyzed','error') ORDER BY id")]
    sets = tags.effective(s.store)
    p = policy(s.store, s.settings)
    revision = {row["key"]: json.loads(row["value"]) for row in s.store.q(
        "SELECT key,value FROM meta WHERE key IN ('state_version','filter_reviews','filter_preferences','filter_decisions')")}
    key = digest([s.source.as_posix(), s.mode, revision.get("state_version"), revision.get("filter_reviews"),
                  revision.get("filter_preferences"), revision.get("filter_decisions"), p, photos,
                  [[pid, sorted(ts)] for pid, ts in sorted(sets.items())]])
    return photos, sets, p, key


def draft_policy(s, value=None):
    from . import tags
    if value is None:
        return policy(s.store, s.settings)
    return validate(resolve_tags(s.store, value) if isinstance(value, dict) else value, s.settings, tags.rows(s.store))


def reviewed(previous, overrides, photos, reason=UNSPECIFIED, provenance=()):
    """A take contributes one current call, however often it is clicked. Reset also unteaches it."""
    out = {r["photo"]: dict(r) for r in previous or []}
    members = {}
    for record in [*(provenance or []), *out.values()]:
        if record.get("family"):
            members.setdefault(record["family"], set()).update(record.get("members") or [record["photo"]])
    known = {pid: family for family, ids in members.items() for pid in ids}
    groups, group_of = {}, {}
    for row in photos:
        group = ("stack", row["stack_key"]) if row["stack_key"] else ("group", row["group_id"]) if row["group_id"] is not None else ("photo", row["id"])
        groups.setdefault(group, set()).add(row["id"])
        group_of[row["id"]] = group
    for pid, override in overrides.items():
        old = out.get(pid)
        intent = (old.get("reason") if old and old["action"] == override else None) if reason is UNSPECIFIED else reason
        if override is None:
            out.pop(pid, None)
        elif old is None or old["action"] != override or old.get("reason") != intent:
            family = known.get(pid)
            if family is None:
                cohort = groups.get(group_of.get(pid), {pid})
                related = {known[member] for member in cohort if member in known}
                family = min(related) if related else f"p:{min(cohort)}"
                cohort = set(cohort).union(*(members.get(key, set()) for key in related))
                # Remember the original auto-stack before setting aside makes negative singleton groups.
                if len(related) > 1:
                    for record in out.values():
                        if record.get("family") in related:
                            record["family"] = family
                members[family] = cohort
                known.update((member, family) for member in cohort)
            out.pop(pid, None)
            out[pid] = {"photo": pid, "action": override, "family": family}
            if intent is not None:
                out[pid]["reason"] = intent
    retained = list(out.values())[-LEARNING_LIMIT:]
    seen = set()
    for record in retained:
        record.pop("members", None)
        family = record.get("family")
        if family and family not in seen:
            record["members"] = sorted(members.get(family, {record["photo"]}))
            seen.add(family)
    return retained


def learning(s, p):
    """Local examples move related takes immediately; global rules still need contrasting evidence."""
    result = _boundary_learning(s, p)
    examples = {item["photo"]: dict(item) for item in p.get("fit_examples", [])}
    calls = (s.store.get_meta("filter_preferences", []) or [])[-LEARNING_LIMIT:]
    ids = [call["photo"] for call in calls]
    valid = {row["id"] for row in s.store.q(
        f"SELECT id FROM photos WHERE status='analyzed' AND id IN ({','.join('?' * len(ids))})", ids)} if ids else set()
    for call in calls:
        if call["photo"] not in valid:
            continue
        examples.pop(call["photo"], None)
        examples[call["photo"]] = {"photo": call["photo"], "direction": "toward" if call["action"] == "keep" else "away",
                                    **({"seq": call["seq"]} if call.get("seq") else {})}
    proposed = list(examples.values())[-LEARNING_LIMIT:]
    result["global_ready"] = result["ready"]
    if proposed != p.get("fit_examples", []):
        result["policy"] = {**result["policy"], "fit_examples": proposed}
        result["changes"].append({"key": "fit_examples", "label": "Similar takes", "before": p.get("fit_examples", []),
                                  "after": proposed, "summary": "Move similar takes toward your choices.",
                                  "reason": "Shared subjects and close saved visual matches follow these examples."})
        result["ready"] = True
    return result


def _boundary_learning(s, p, examples=None):
    """Explain a small boundary learned from contrasting Filter calls; never change the saved rules."""
    from . import tags
    from .library import SCREENSHOT_NAME
    settings, mode = s.settings, s.mode
    # Only explicit Love/Hate calls teach rules. Keep/Toss is a decision about one take.
    examples = s.store.get_meta("filter_preferences", []) if examples is None else examples
    calls = {call["photo"]: {**call, "preference": True} for call in (examples or [])[-LEARNING_LIMIT:]}
    reviews = list(calls.values())
    ids = [r["photo"] for r in reviews[-LEARNING_LIMIT:]]
    photos = [dict(r) for r in s.store.q(
        f"SELECT id,rel,status,size,mtime_ns,width,height,make,taken_ts,sharp,luma,zs,override,stack_key,group_id FROM photos WHERE id IN ({','.join('?' * len(ids))}) ORDER BY id", ids)] if ids else []
    photos = [{key: None if isinstance(value, float) and not math.isfinite(value) else value for key, value in row.items()} for row in photos]
    sets = tags.effective(s.store, ids) if ids else {}
    revision = digest([s.source.as_posix(), mode, reviews, photos, [[pid, sorted(ts)] for pid, ts in sorted(sets.items())]])
    by_id = {r["id"]: r for r in photos}
    prepared, parents, current_groups = [], {}, {}
    def root(family):
        parents.setdefault(family, family)
        while parents[family] != family:
            parents[family] = parents[parents[family]]
            family = parents[family]
        return family
    for call in reviews:
        row = by_id.get(call["photo"])
        if not row or row["status"] != "analyzed" or (not call.get("preference") and row["override"] != call["action"]):
            continue
        family = ("review", call["family"]) if call.get("family") else ("stack", row["stack_key"]) if row["stack_key"] else ("group", row["group_id"]) if row["group_id"] is not None else ("photo", row["id"])
        current = ("stack", row["stack_key"]) if row["stack_key"] else ("group", row["group_id"]) if (row["group_id"] or 0) > 0 else None
        # Provenance survives a toss/split, while a later merge can only reduce independence.
        if current in current_groups:
            parents[root(family)] = root(current_groups[current])
        elif current is not None:
            current_groups[current] = family
        prepared.append((family, {"row": row, "label": call["action"], "reason": call.get("reason"), "preference": bool(call.get("preference")),
                                  "evidence": json.loads(row["zs"] or "{}")}))
    families = {}
    for family, sample in prepared:
        families.setdefault(root(family), []).append(sample)
    consistent = [family[-1] for family in families.values() if len({r["label"] for r in family}) == 1]
    samples = [r for r in consistent if r["reason"] not in {"subject", "exception"}]
    support = {"keep": sum(r["label"] == "keep" for r in samples), "aside": sum(r["label"] == "toss" for r in samples)}
    result = {"policy": p, "changes": [], "samples": {**support, "reviewed": len(reviews), "conflicted": len(families) - len(consistent),
                                                      "personal": len(consistent) - len(samples),
                                                      "preferences": sum(bool(r.get("preference")) for r in reviews)},
              "needed": {key: max(0, LEARNING_SUPPORT - count) for key, count in support.items()},
              "ready": False, "revision": revision, "ambiguities": [], "reason_hints": {}}
    if min(support.values()) < LEARNING_SUPPORT:
        return result
    now = time.time()
    def finite(value, maximum=None):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 and (maximum is None or value <= maximum) else None
    def low(value, threshold):
        return value is not None and value < threshold
    def high(value, threshold):
        return value is not None and value > threshold
    def metric(sample, key):
        row, ev = sample["row"], sample["evidence"]
        face, scores = ev.get("face") or {}, ev.get("scores") or {}
        sharp, light = finite(row["sharp"]), finite(row["luma"], 255)
        fs, px = finite(face.get("sharp")), finite(face.get("px"))
        if key == "min_pixels":
            w, h = finite(row["width"]), finite(row["height"])
            return min(w, h) if w and h and min(w, h) > 0 else None
        if key in ("min_luma", "max_luma"):
            return light if mode == "gallery" else finite(face.get("luma"), 255)
        if key == "max_age_years":
            stamp = finite(row["taken_ts"])
            return max(0, (now - stamp) / (365.25 * 86400)) if p[key] and stamp else None
        if key == "min_face_fraction":
            return finite(face.get("h"), 1)
        if key == "blur_sharpness":
            gate = high(finite(scores.get("blurry"), 1), p["blur_confidence"]) if mode == "gallery" else px is not None and px >= p["face_blur_min_pixels"] and low(fs, p["face_blur_sharpness"])
            return sharp if gate else None
        if key == "blur_confidence":
            return finite(scores.get("blurry"), 1) if low(sharp, p["blur_sharpness"]) else None
        if key == "face_blur_sharpness":
            return fs if px is not None and px >= p["face_blur_min_pixels"] and low(sharp, p["blur_sharpness"]) else None
        if key == "face_blur_min_pixels":
            return px if low(fs, p["face_blur_sharpness"]) and low(sharp, p["blur_sharpness"]) else None
        if key == "screenshot_confidence":
            return finite(scores.get("screenshot"), 1) if p["screenshot"] and not row["make"] and not SCREENSHOT_NAME.search(row["rel"].rsplit("/", 1)[-1]) else None
        if key == "document_confidence":
            return finite(scores.get("document"), 1) if p["document"] else None
        if not p["accidental"]:
            return None
        if key == "accidental_confidence":
            return finite(scores.get("accidental"), 1) if low(light, p["accidental_luma"]) or low(sharp, p["accidental_sharpness"]) else None
        if not high(finite(scores.get("accidental"), 1), p["accidental_confidence"]):
            return None
        if key == "accidental_luma":
            return light if not low(sharp, p["accidental_sharpness"]) else None
        if key == "accidental_sharpness":
            return sharp if not low(light, p["accidental_luma"]) else None
        return None
    def predicts(sample, rules):
        # The manual exception is the training label, not an input to the prediction.
        return bool(evaluate(sample["row"], sample["evidence"], rules, mode, sets.get(sample["row"]["id"], ()), now))
    baseline = {sample["row"]["id"]: predicts(sample, p) for sample in samples}
    meta = tags.rows(s.store)
    def subjects(sample):
        return {tag for tag in sets.get(sample["row"]["id"], ()) if not tag.startswith("x:")
                and meta.get(tag, {}).get("family", tags.FIXED.get(tag, (None, None, "what"))[2]) in {"what", "people"}}
    suggestions = []
    for rule in rules(settings):
        key = rule["key"]
        if rule["type"] != "number":
            continue
        hint = RULE_REASONS.get(key)
        data = [(sample, value) for sample in samples if (sample["reason"] is None or sample["reason"] == hint)
                and (value := metric(sample, key)) is not None]
        eligible = {sample["row"]["id"] for sample, _ in data}
        kept = [value for sample, value in data if sample["label"] == "keep"]
        aside = [value for sample, value in data if sample["label"] == "toss"]
        if min(len(kept), len(aside)) < LEARNING_SUPPORT:
            continue
        upper = key in {"max_luma", "max_age_years", "face_blur_min_pixels"} or key.endswith("_confidence")
        overlap = max(kept) >= min(aside) if upper else max(aside) >= min(kept)
        if overlap:
            continue  # Overlapping examples cannot justify a single cutoff.
        kept_tags = [subjects(sample) for sample, _ in data if sample["label"] == "keep"]
        aside_tags = [subjects(sample) for sample, _ in data if sample["label"] == "toss"]
        # A subject present throughout only one side explains these calls just as well as this measurement.
        # Ask for intent instead of treating, for example, small dog photos as a dislike of small images.
        confounded = (set.intersection(*kept_tags) - set.union(*aside_tags)) | (set.intersection(*aside_tags) - set.union(*kept_tags))
        def cut(value, threshold):
            return value >= threshold if key == "face_blur_min_pixels" else value > threshold if upper else value < threshold
        step = rule["step"]
        choices = {round((math.floor(value / step) + offset) * step, 8) for _, value in data for offset in (-1, 0, 1, 2)}
        choices = [v for v in choices if rule["min"] <= v <= rule["max"] and v != p[key]
                   and not (key == "max_age_years" and v == 0)
                   and not (key == "min_luma" and v > p["max_luma"] or key == "max_luma" and v < p["min_luma"])]
        candidates = []
        for value in sorted(choices, key=lambda v: (abs(v - p[key]), v)):
            improved, consistent = 0, True
            for sample, measurement in data:
                want = sample["label"] == "toss"
                was, after = cut(measurement, p[key]) == want, cut(measurement, value) == want
                improved += not was and after
                consistent &= after
            if improved >= 2 and consistent:
                candidates.append(value)
        for value in candidates[:8]:
            proposed = {**p, key: value}
            corrected, worsened = [], False
            for sample in samples:
                pid, want = sample["row"]["id"], sample["label"] == "toss"
                was, after = baseline[pid] == want, predicts(sample, proposed) == want
                if not was and after and pid in eligible:
                    corrected.append(pid)
                worsened |= was and not after
            if len(corrected) < 2 or worsened:
                continue
            direct = [sample for sample, _ in data if sample["row"]["id"] in corrected and sample["reason"] == hint and hint]
            if confounded and len(direct) < LEARNING_SUPPORT:
                if not any(entry["key"] == key for entry in result["ambiguities"]):
                    clarification = {"key": key, "reason": "These calls also separate different subjects. An optional reason would distinguish quality from a personal choice.",
                                     "photos": corrected, "hint": hint or "subject", "tags": sorted(confounded)}
                    result["ambiguities"].append(clarification)
                    for pid in corrected:
                        result["reason_hints"][pid] = list(dict.fromkeys([hint or "subject", "subject", "exception"]))
                continue
            boundary = {side: [{"photo": sample["row"]["id"], "value": measurement}
                              for sample, measurement in sorted(data, key=lambda item: (abs(item[1] - value), item[0]["row"]["id"]))
                              if sample["label"] == label][:3] for side, label in (("keep", "keep"), ("aside", "toss"))}
            change = {"key": key, "label": rule["label"], "before": p[key], "after": value,
                      "evidence": {"keep": len(kept), "aside": len(aside)},
                      "photos": {"keep": [r["row"]["id"] for r, _ in data if r["label"] == "keep"],
                                 "aside": [r["row"]["id"] for r, _ in data if r["label"] == "toss"], "corrected": corrected},
                      "reason": f"{len(kept)} kept and {len(aside)} set-aside stacks support this boundary. It matches {len(corrected)} more of your calls without reversing another.",
                      "summary": _learned_summary(key, p[key], value), "boundary": {**boundary, "unit": rule["unit"]}}
            suggestions.append((len(corrected), abs(value - p[key]) / max(rule["max"] - rule["min"], step), change))
    # A repeated combination is one hypothesis, not a vote for whichever tag happens to be first.
    # Keep every shared subject in that combination, and retain the player's existing content rules.
    kept = [sample for sample in samples if sample["label"] == "keep"]
    aside = [sample for sample in samples if sample["label"] == "toss"]
    shared_keep = set.intersection(*(subjects(sample) for sample in kept))
    shared_aside = set.intersection(*(subjects(sample) for sample in aside))
    toward = sorted((shared_keep - shared_aside) & meta.keys())
    away = sorted((shared_aside - set.union(*(subjects(sample) for sample in kept))) & meta.keys())
    content = None
    candidates = []
    undirected = all(sample["reason"] is None for sample in samples)
    if toward and not p["require_tags"] and undirected:
        candidates.append(("require_tags", toward, {**p, "require_tags": toward, "require_mode": "all"}, "Favor " + " + ".join(meta.get(key, {}).get("label", key) for key in toward) + "."))
    if len(away) == 1 and undirected:
        candidates.append(("exclude_tags", sorted(set(p["exclude_tags"]) | set(away)),
                           {**p, "exclude_tags": sorted(set(p["exclude_tags"]) | set(away))},
                           "Set similar subjects aside."))
    for key, value, proposed, summary in candidates:
        if value == p[key] or any(predicts(sample, proposed) != (sample["label"] == "toss") for sample in samples):
            continue
        corrected = [sample["row"]["id"] for sample in samples if baseline[sample["row"]["id"]] != (sample["label"] == "toss")]
        if len(corrected) < LEARNING_SUPPORT:
            continue
        content = {"key": key, "label": "Subjects", "before": p[key], "after": value,
                   "evidence": {"keep": len(kept), "aside": len(aside)},
                   "photos": {"keep": [r["row"]["id"] for r in kept], "aside": [r["row"]["id"] for r in aside], "corrected": corrected},
                   "reason": "Repeated independent choices share these subjects without contradicting another choice.",
                   "summary": summary, "boundary": {"keep": [], "aside": [], "unit": ""}, "policy": proposed}
        break
    if content:
        quality_ambiguity = any(entry["hint"] in {"size", "light", "blur", "age"} for entry in result["ambiguities"])
        if suggestions or quality_ambiguity:
            result["ambiguities"].append({"key": content["key"], "hint": "subject", "photos": content["photos"]["corrected"],
                                           "tags": content["after"], "reason": "Subjects and quality both explain these choices. More varied examples will separate them."})
            # More varied rounds can settle this naturally; there is no need to ask for a reason.
            return result
        proposed = content.pop("policy")
        changes = [content]
        if proposed["require_mode"] != p["require_mode"]:
            changes.append({**content, "key": "require_mode", "before": p["require_mode"], "after": proposed["require_mode"]})
        result.update(policy=proposed, changes=changes, ready=True)
        return result
    if suggestions:
        most = max(item[0] for item in suggestions)
        best = [item for item in suggestions if item[0] == most]
        directed = [item for item in best if (hint := RULE_REASONS.get(item[2]["key"]))
                    and sum(sample["reason"] == hint and sample["row"]["id"] in item[2]["photos"]["corrected"]
                            for sample in samples) >= LEARNING_SUPPORT]
        best = directed or best
        intents = {RULE_REASONS.get(item[2]["key"], item[2]["key"]) for item in best}
        if len(intents) > 1:
            options = sorted({RULE_REASONS.get(item[2]["key"], "subject") for item in best})
            for _, _, change in best:
                if any(entry["key"] == change["key"] for entry in result["ambiguities"]):
                    continue
                result["ambiguities"].append({"key": change["key"], "reason": "More than one measurement explains these calls. An optional reason would show which matters to you.",
                                               "photos": change["photos"]["corrected"], "hint": RULE_REASONS.get(change["key"], "subject")})
                for pid in change["photos"]["corrected"]:
                    result["reason_hints"][pid] = list(dict.fromkeys([*options, "exception"]))
            return result
        _, _, change = min(best, key=lambda item: (item[1], item[2]["key"]))
        result.update(policy={**p, change["key"]: change["after"]}, changes=[change], ready=True)
    return result


def _learned_summary(key, before, after):
    increasing = after > before
    return {"min_pixels": ("Favor larger photos.", "Allow smaller photos."),
            "min_luma": ("Favor brighter photos.", "Allow darker photos."),
            "max_luma": ("Allow brighter photos.", "Set very bright photos aside."),
            "max_age_years": ("Allow older photos.", "Favor more recent photos."),
            "blur_sharpness": ("Be stricter about blurry photos.", "Allow softer photos."),
            "blur_confidence": ("Be more cautious about calling photos blurry.", "Set more blurry photos aside."),
            "min_face_fraction": ("Favor closer faces.", "Allow smaller faces."),
            "face_blur_sharpness": ("Be stricter about soft faces.", "Allow softer faces."),
            "face_blur_min_pixels": ("Allow more small faces.", "Check smaller faces for blur."),
            "screenshot_confidence": ("Be more cautious about calling photos screenshots.", "Set more screenshots aside."),
            "document_confidence": ("Be more cautious about calling photos documents.", "Set more documents aside."),
            "accidental_confidence": ("Be more cautious about calling photos accidental.", "Set more accidental shots aside."),
            "accidental_luma": ("Be stricter about dim accidental shots.", "Be more cautious about calling dark photos accidental."),
            "accidental_sharpness": ("Be stricter about soft accidental shots.", "Be more cautious about calling soft photos accidental.")}[key][0 if increasing else 1]


def decisions(value, photos):
    if not isinstance(value, list) or len(value) > 5000:
        abort(400, "overrides must be a list of at most 5000 decisions.")
    found = {r["id"]: r for r in photos}
    out = {}
    for item in value:
        if not isinstance(item, dict) or set(item) != {"photo", "action"}:
            abort(400, "Each override needs photo and action.")
        pid, action = item["photo"], item["action"]
        if isinstance(pid, bool) or not isinstance(pid, int) or pid not in found:
            abort(404, "Unknown photo.")
        if action not in ("keep", "aside", "reset"):
            abort(400, "action must be keep, aside or reset.")
        if action == "keep" and found[pid]["status"] == "error":
            abort(400, "This photo could not be read. Re-scan it before bringing it back.")
        out[pid] = {"keep": "keep", "aside": "toss", "reset": None}[action]
    return out


def decision_reason(value):
    if value is not UNSPECIFIED and value is not None and (not isinstance(value, str) or value not in REASONS):
        abort(400, "reason must be blur, light, size, age, subject, exception or null.")
    return value


def review_families(photos, reviews):
    """Current stacks and remembered pre-toss siblings remain one source of review evidence."""
    parents = {row["id"]: row["id"] for row in photos}
    def root(pid):
        while parents[pid] != pid:
            parents[pid] = parents[parents[pid]]
            pid = parents[pid]
        return pid
    def join(ids):
        ids = [pid for pid in ids if pid in parents]
        if ids:
            first = root(ids[0])
            for pid in ids[1:]:
                parents[root(pid)] = first
    current = {}
    for row in photos:
        group = ("stack", row["stack_key"]) if row["stack_key"] else ("group", row["group_id"]) if (row["group_id"] or 0) > 0 else ("photo", row["id"])
        current.setdefault(group, []).append(row["id"])
    for members in current.values():
        join(members)
    old = {}
    for call in reviews or []:
        family = call.get("family", f"p:{call['photo']}")
        old.setdefault(family, []).extend([call["photo"], *(call.get("members") or [])])
    for members in old.values():
        join(members)
    return {pid: root(pid) for pid in parents}


def catalogue(s, photos, sets, p, overrides=None, now=None):
    from .library import CUT_LABELS
    from .filter_fit import assess
    labels = {**CUT_LABELS, **LABELS}
    out, mode = [], s.mode
    reasons_by_id = {r["photo"]: r.get("reason") for r in s.store.get_meta("filter_reviews", []) or []}
    candidates = [{**row, "override": (overrides or {}).get(row["id"], row["override"])} for row in photos]
    assessed = assess(s.store, candidates, sets, p, mode, now=now)
    for row in photos:
        candidate = {**row, "override": (overrides or {}).get(row["id"], row["override"])}
        evidence = json.loads(row["zs"] or "{}")
        reasons, fit = assessed[row["id"]]
        cut = disposition(candidate, reasons)
        reason = cut or next(iter(reasons), None)
        explanation = labels.get(reason, "In the running")
        light = row["luma"] if mode == "gallery" else (evidence.get("face") or {}).get("luma")
        if reason in ("accidental", "exposure") and light is not None:
            if light < p["min_luma"]:
                explanation = f"Below minimum brightness ({light:.0f} < {p['min_luma']:g})."
            elif light > p["max_luma"]:
                explanation = f"Above maximum brightness ({light:.0f} > {p['max_luma']:g})."
        out.append({"id": row["id"], "photo": row["id"], "rel": row["rel"], "status": row["status"], "cut": cut, "fit": fit,
                    "reason": reason, "reason_text": explanation if row["status"] != "error" else "Could not read this file. Re-scan to try again.",
                    "reasons": reasons, "override": candidate["override"], "disposition": "aside" if cut else "keep",
                    "teaching_reason": reasons_by_id.get(row["id"]),
                    "playable": row["status"] != "error", "before": "aside" if row["cut"] else "keep",
                    "changed": (cut is None) != (row["cut"] is None),
                    "metrics": {"width": row["width"], "height": row["height"], "sharpness": row["sharp"], "brightness": row["luma"],
                                "face": evidence.get("face"), "scores": evidence.get("scores", {}), "taken_ts": row["taken_ts"]}})
    return out


def page(s, rows, p, params, token=None):
    from . import tags
    from .library import CUT_LABELS
    state = params.get("state", "all")
    if state not in ("all", "aside", "kept", "changed"):
        abort(400, "Unknown Filter view.")
    def integer(key, default):
        value = params.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            abort(400, f"{key} must be a whole number.")
        return int(value)
    number, per = max(0, integer("page", 0)), max(1, min(200, integer("per", 72)))
    wanted = [r for r in rows if state == "all" or state == "changed" and r["changed"] or state == "aside" and r["cut"] is not None or state == "kept" and r["cut"] is None]
    if params.get("reason"):
        wanted = [r for r in wanted if params["reason"] == r["reason"] or params["reason"] in r["reasons"]]
    if params.get("photo"):
        photo = integer("photo", 0)
        wanted = [r for r in wanted if r["id"] == photo]
        # A teaching turn needs one take, not another copy of every ID, tag count and undo snapshot.
        return {"scope": "library", "version": VERSION, "policy": p, "photos": wanted[number * per:(number + 1) * per],
                "page": number, "per": per, "total": len(wanted), "more": (number + 1) * per < len(wanted),
                **({"token": token} if token else {})}
    meta, effective = tags.rows(s.store), tags.effective(s.store)
    total_tags = Counter(t for ts in effective.values() for t in ts)
    reply = {"scope": "library", "version": VERSION, "teaching_revision": 2, "policy": p, "rules": rules(s.settings), "labels": {**CUT_LABELS, **LABELS},
             "tags": [{**r, "count": total_tags[key]} for key, r in meta.items() if key not in {"x:cut"}],
             "counts": counts(rows), "photos": wanted[number * per:(number + 1) * per], "page": number, "per": per,
             "total": len(wanted), "more": (number + 1) * per < len(wanted), "stage": stage(s.store), "undo": s.draw.last_step()}
    if number == 0:
        reply["scores"] = {r["id"]: r["fit"] for r in rows}
        reply["ids"] = {"kept": [r["id"] for r in rows if r["cut"] is None], "aside": [r["id"] for r in rows if r["cut"] is not None],
                        "changed": [r["id"] for r in rows if r["changed"]],
                        "failing": [r["id"] for r in rows if r["reasons"]],
                        "unreadable": [r["id"] for r in rows if not r["playable"]]}
    if token:
        reply["token"] = token
    return reply


def teaching_overrides(s, photos, sets, p):
    """New, confident teaching may revisit an older opposite call, only as an explicit preview proposal."""
    from .filter_fit import influence
    if not any(example.get("seq") for example in p.get("fit_examples", [])):
        return {}
    candidates = [row for row in photos if row["status"] == "analyzed" and row.get("override") in {"keep", "toss"}]
    if not candidates:
        return {}
    matched = {}
    evidence_ids = {example["photo"] for example in p["fit_examples"]} | {row["id"] for row in candidates}
    evidence = {row["id"]: json.loads(row.get("zs") or "{}") for row in photos if row["id"] in evidence_ids}
    influence(s.store, candidates, sets, p["fit_examples"], evidence, matched=matched)
    if not matched:
        return {}
    decisions = s.store.get_meta("filter_decisions", {}) or {}
    last = {row["id"]: int((decisions.get(str(row["id"])) or {}).get("seq", 0)) for row in candidates}
    # Sweep and recovery are individual choices too. An old lesson cannot dislodge a newer call there.
    for vote in s.store.q("SELECT a,ts,extra FROM votes WHERE undone=0 AND kind IN ('toss','sweep')"):
        extra = json.loads(vote["extra"] or "{}")
        members = extra.get("members") or list(map(int, (extra.get("prev") or {}).keys())) or [vote["a"]]
        for pid in set(members) & matched.keys():
            last[pid] = max(last[pid], int(vote["ts"] * 1_000_000))
    for entry in s.store.get_meta("group_history", []) or []:
        if entry["label"].startswith("filter"):
            continue
        for pid, _ in entry.get("overrides", []):
            if pid in matched:
                last[pid] = max(last[pid], int(entry.get("at", 0) * 1_000_000))
    return {row["id"]: None for row in candidates if row["id"] in matched
            and matched[row["id"]]["seq"] > last[row["id"]]
            and matched[row["id"]]["direction"] != ("toward" if row["override"] == "keep" else "away")}


def preview(s, body):
    from . import tags
    connection = s.store.conn()
    stamp = _preview_stamp(s, connection)
    photos, sets, _, key = snapshot(s)
    value = body.get("policy")
    p = validate(resolve_tags(s.store, value) if isinstance(value, dict) else value, s.settings, tags.rows(s.store))
    overrides = {**teaching_overrides(s, photos, sets, p), **decisions(body.get("overrides", []), photos)}
    now = time.time()
    rows = catalogue(s, photos, sets, p, overrides, now)
    token = secrets.token_urlsafe(24)
    deadlines = [r["taken_ts"] + p["max_age_years"] * 365.25 * 86400 for r in photos
                 if p["max_age_years"] and r["taken_ts"] and r["taken_ts"] + p["max_age_years"] * 365.25 * 86400 >= now]
    s.filter_preview = dict(token=token, key=key, source=s.source.as_posix(), policy=p, overrides=overrides, rows=rows, at=now,
                           by_id={row["id"]: row for row in rows}, connection=connection,
                           stamp=stamp if stamp == _preview_stamp(s, connection) else None,
                           deadline=min(deadlines, default=None))
    return page(s, rows, p, body, token)


def _preview_stamp(s, connection):
    # total_changes catches this connection's writes; data_version catches commits from every other one.
    # Store owns the connection and permits cross-thread use. Its lock also guards this cheap read.
    with s.store.lock:
        return connection.total_changes, connection.execute("PRAGMA data_version").fetchone()[0]


def get_preview(s, token, snapshot_data=None):
    stored = getattr(s, "filter_preview", None)
    if not isinstance(token, str) or not stored or not secrets.compare_digest(stored["token"], token) or time.time() - stored["at"] > 1800:
        abort(409, "That Filter preview expired. Preview these rules again.")
    if stored.get("source", s.source.as_posix()) != s.source.as_posix():
        abort(409, "That Filter preview belongs to another library. Preview these rules again.")
    if stored.get("deadline") is not None and time.time() > stored["deadline"]:
        abort(409, "A photo crossed your age limit. Preview these rules again before applying.")
    connection = stored.get("connection")
    stamp = _preview_stamp(s, connection) if connection is not None else None
    if snapshot_data is None and stamp is not None and stamp == stored.get("stamp"):
        return stored
    photos, sets, _, key = snapshot_data if snapshot_data is not None else snapshot(s)
    if key != stored["key"]:
        abort(409, "Your photos or choices changed. Preview these rules again before applying.")
    if stored["policy"]["max_age_years"] and [r["cut"] for r in catalogue(s, photos, sets, stored["policy"], stored["overrides"])] != [r["cut"] for r in stored["rows"]]:
        abort(409, "A photo crossed your age limit. Preview these rules again before applying.")
    if connection is not None:
        stored["stamp"] = stamp if stamp == _preview_stamp(s, connection) else None
    return stored


def photo_page(s, params, token=None):
    """One complete take for the teaching game, including policy failures behind a manual Keep."""
    from . import tags
    try:
        pid = int(params["photo"])
    except (ValueError, TypeError):
        abort(400, "photo must be a whole number.")
    if not 0 < pid <= 10**12:
        abort(400, "photo must be a positive photo ID.")
    if token is not None:
        cached = get_preview(s, token)
        found = cached.get("by_id", {}).get(pid)
        rows, p = [found] if found else [], cached["policy"]
    else:
        photos = [dict(r) for r in s.store.q("SELECT id,rel,status,error,sha256,phash,width,height,make,taken_ts,sharp,luma,luma_lo,luma_hi,chroma,saturation,hue,zs,cut,override "
                                            "FROM photos WHERE id=? AND status IN ('analyzed','error')", (pid,))]
        p = policy(s.store, s.settings)
        rows = catalogue(s, photos, tags.effective(s.store, [pid]), p)
    return page(s, rows, p, params, token)


def review(s, body):
    from .filter_review import schedule
    def ids(key):
        value = body.get(key, [])
        if not isinstance(value, list) or len(value) > 50000 or any(isinstance(pid, bool) or not isinstance(pid, int) or not 0 < pid <= 10**12 for pid in value):
            abort(400, f"{key} must contain at most 50000 photo IDs.")
        return list(dict.fromkeys(value))
    seen, deferred = ids("seen"), ids("deferred")
    scope, limit = body.get("scope", "all"), body.get("limit", 12)
    if not isinstance(scope, str) or scope not in {"all", "kept", "aside", "changed"}:
        abort(400, "scope must be all, kept, aside or changed.")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 12:
        abort(400, "limit must be a whole number between 1 and 12.")
    if "token" in body and "policy" in body:
        abort(400, "Choose a preview token or a draft policy, not both.")
    data = snapshot(s)
    photos, sets, saved, _ = data
    if "token" in body:
        preview = get_preview(s, body["token"], data)
        p, rows = preview["policy"], preview["rows"]
    else:
        p = draft_policy(s, body["policy"]) if "policy" in body else saved
        rows = catalogue(s, photos, sets, p)
    families = review_families(photos, [*(s.store.get_meta("filter_reviews", []) or []),
                                       *(s.store.get_meta("filter_preferences", []) or [])])
    return {**schedule(rows, p, s.mode, sets, families, seen, deferred, scope, limit), "policy": p}


def change(s, p=None, overrides=None, finish=False, label="filter rules", learn=False, reason=UNSPECIFIED, preferences=None):
    """Commit one edit. The caller holds the Session lock and refreshes after releasing it."""
    photos, sets, current, _ = snapshot(s)
    p = current if p is None else p
    overrides = overrides or {}
    rows = catalogue(s, photos, sets, p, overrides)
    before = {"policy": s.store.get_meta("filter_policy"), "finished": s.store.get_meta("filter_finished"),
              "token": s.store.get_meta("filter_edit_token"), "age": s.settings.get("max_age_years", 0),
              "version": s.store.get_meta("filter_policy_version"), "reviews": s.store.get_meta("filter_reviews"),
              "considered": s.store.get_meta("filter_considered"),
              "decisions": s.store.get_meta("filter_decisions"),
              "preferences": s.store.get_meta("filter_preferences")}
    considered = set(before["considered"] or [r["photo"] for r in before["reviews"] or []])
    if learn:
        considered.update(pid for pid, value in overrides.items() if value in {"keep", "toss"})
        considered.difference_update(pid for pid, value in overrides.items() if value is None)
    reviews = reviewed(before["reviews"], overrides, photos, reason, before["preferences"]) if learn else before["reviews"]
    preferred = reviewed(before["preferences"], preferences, photos, provenance=before["reviews"]) if preferences is not None else before["preferences"]
    decisions = {key: dict(value) for key, value in (before["decisions"] or {}).items()}
    previous_seq = s.store.get_meta("filter_event_seq", 0) or 0
    seq = max(previous_seq + 1, time.time_ns() // 1000)
    sequenced = False
    if learn:
        kind = "teaching" if preferences is not None else "individual"
        prior_preferences = {row["photo"]: row for row in before["preferences"] or []}
        for pid, value in overrides.items():
            old_call = decisions.get(str(pid))
            if value is None:
                decisions.pop(str(pid), None)
            elif (old_call != {"action": value, "kind": kind, "seq": previous_seq}
                  or preferences is not None and prior_preferences.get(pid, {}).get("seq") != previous_seq):
                decisions[str(pid)] = {"action": value, "kind": kind, "seq": seq}
                sequenced = True
        if sequenced:
            decisions.update({str(pid): {"action": value, "kind": kind, "seq": seq}
                              for pid, value in overrides.items() if value is not None})
        if sequenced and preferences is not None:
            for example in preferred or []:
                if example["photo"] in preferences and preferences[example["photo"]] is not None:
                    example["seq"] = seq
    changed_decisions = decisions != (before["decisions"] or {})
    learned = bool(reviews != before["reviews"] and (reviews or before["reviews"]))
    tuned = bool(preferred != before["preferences"] and (preferred or before["preferences"]))
    old = [[r["id"], r["override"]] for r in photos if r["id"] in overrides and r["override"] != overrides[r["id"]]]
    revision = input_revision(photos, p, s.mode, sets)
    changed_policy = p != current
    changed_finish = finish and before["finished"] != revision
    if not changed_policy and not old and not changed_finish and not learned and not tuned and not changed_decisions:
        return False
    # A later use of the old preview must not apply the same edit again or spend a second undo step.
    s.filter_preview = None
    token = secrets.token_hex(12)
    vote_states = []
    admitted = {row["id"] for row in rows if row["cut"] is None}
    rescuing = {pid for pid, prior in old if overrides[pid] == "keep" or prior == "toss" and overrides[pid] is None and pid in admitted}
    for v in s.store.q("SELECT id, kind, a, extra FROM votes WHERE undone=0 AND kind IN ('toss','sweep')"):
        extra = json.loads(v["extra"] or "{}")
        members = extra.get("members") or list(map(int, (extra.get("prev") or {}).keys())) or [v["a"]]
        if rescuing.intersection(members) and (v["kind"] == "toss" or extra.get("change") == "toss"):
            vote_states.append([v["id"], 0])
    affected = {r["id"] for r in rows if r["changed"]}
    cups = {"all"} if affected else set()
    if affected:
        cups.update(r["category"] for r in s.store.q("SELECT id, category FROM photos") if r["id"] in affected and r["category"])
        # A newly selected stack cover can change its cup. Retire all current brackets when admission changes;
        # their complete history remains archived, and undo can restore each untouched bracket.
        cups.update(r["key"].split(":", 1)[1] for r in s.store.q("SELECT key FROM meta WHERE key LIKE 'finals:%' OR key LIKE 'knockouts:%'"))
        cups.update((s.store.get_meta("champions", {}) or {}).keys())
    brackets, champions = {}, s.store.get_meta("champions", {}) or {}
    for cup in cups:
        saved = {kind: s.store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals")}
        if any(saved.values()) or cup in champions:
            brackets[cup] = {**saved, "champion": champions.get(cup)}
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET override=? WHERE id=?", [(overrides[pid], pid) for pid, _ in old])
        c.executemany("UPDATE votes SET undone=1 WHERE id=?", [(vid,) for vid, _ in vote_states])
        def meta(key, value):
            c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
        if changed_policy:
            meta("filter_policy", p)
            meta("filter_policy_version", VERSION)
            meta("settings", {**s.settings, "max_age_years": p["max_age_years"]})
        meta("filter_finished", revision if finish else None if changed_policy else before["finished"])
        meta("filter_edit_token", token)
        if learned:
            meta("filter_reviews", reviews)
        if learn:
            meta("filter_considered", sorted(considered))
        if changed_decisions:
            meta("filter_decisions", decisions)
        if sequenced:
            meta("filter_event_seq", seq)
        if tuned:
            meta("filter_preferences", preferred)
        if brackets:
            archive = s.store.get_meta("filter_bracket_archive", []) or []
            meta("filter_bracket_archive", (archive + [{"at": time.time(), "token": token, "cups": brackets}])[-20:])
            for cup in brackets:
                meta(f"knockouts:{cup}", None)
                meta(f"finals:{cup}", None)
                champions.pop(cup, None)
            meta("champions", champions)
        # The policy, overrides and their undo record commit together. Filtering never prunes your groups.
        undo_before = {key: value for key, value in before.items() if key != "decisions"}
        if changed_decisions:
            undo_before["decision_patch"] = [[str(pid), (before["decisions"] or {}).get(str(pid))] for pid in overrides
                                             if decisions.get(str(pid)) != (before["decisions"] or {}).get(str(pid))]
        s.draw.remember(label, prune=False, overrides=old, vote_states=vote_states,
                        photo=next(iter(preferences or overrides or sorted(affected)), None),
                        filter_before=undo_before, filter_after=token, filter_brackets=brackets,
                        filter_overrides=[[pid, overrides[pid]] for pid, _ in old],
                        filter_vote_after=s.store.one("SELECT COALESCE(MAX(id),0) AS n FROM votes")["n"])
    s.draw.changed()
    s.cards.clear()
    return {"changed": len(affected), "refresh": bool(changed_policy or old), "token": token}


def undo(s, entry, c):
    """Restore only Filter-owned metadata, and never overwrite a newer tournament."""
    before = entry["filter_before"]
    if s.store.get_meta("filter_edit_token") != entry["filter_after"]:
        return
    def meta(key, value):
        c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
    meta("filter_policy", before["policy"])
    meta("filter_policy_version", before.get("version"))
    meta("filter_finished", before["finished"])
    meta("filter_edit_token", before["token"])
    if "reviews" in before:
        meta("filter_reviews", before["reviews"])
    if "considered" in before:
        meta("filter_considered", before["considered"])
    if "decisions" in before:
        meta("filter_decisions", before["decisions"])
    elif before.get("decision_patch"):
        decisions = s.store.get_meta("filter_decisions", {}) or {}
        for pid, old in before["decision_patch"]:
            if old is None:
                decisions.pop(pid, None)
            else:
                decisions[pid] = old
        meta("filter_decisions", decisions or None)
    if "preferences" in before:
        meta("filter_preferences", before["preferences"])
    meta("settings", {**s.settings, "max_age_years": before["age"]})
    photos, sets, p, _ = snapshot(s)
    rows = catalogue(s, photos, sets, p)
    changed = any(row["changed"] for row in rows)
    eligible = {row["id"] for row in rows if row["cut"] is None}
    saved_brackets = entry.get("filter_brackets", {})
    champs = s.store.get_meta("champions", {}) or {}
    cups = set(saved_brackets)
    if changed:
        # A tournament can have started after this edit, even when there was none to archive before it.
        cups.update(r["key"].split(":", 1)[1] for r in s.store.q("SELECT key FROM meta WHERE key LIKE 'finals:%' OR key LIKE 'knockouts:%'"))
        cups.update(champs)
    newer = {}
    for cup in cups:
        current = {kind: s.store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals")}
        if any(current.values()) or cup in champs:
            if changed:
                newer[cup] = {**current, "champion": champs.pop(cup, None)}
                for kind in ("knockouts", "finals"):
                    meta(f"{kind}:{cup}", None)
            continue
        saved = saved_brackets.get(cup)
        if not saved or not bracket_eligible(saved, eligible):
            continue
        for kind in ("knockouts", "finals"):
            meta(f"{kind}:{cup}", saved[kind])
        if saved["champion"] is not None:
            champs[cup] = saved["champion"]
    if newer:
        archive = s.store.get_meta("filter_bracket_archive", []) or []
        meta("filter_bracket_archive", (archive + [{"at": time.time(), "filter_undo": True, "cups": newer}])[-20:])
    meta("champions", champs)
    s.filter_preview = None
    s.cards.clear()


def bracket_eligible(saved, eligible):
    """Later manual choices survive undo; so must their exclusion from old tournament seeds."""
    seeds = {pid for kind in ("knockouts", "finals") for field in ("seeds", "qualified")
             for pid in (saved.get(kind) or {}).get(field, [])}
    if saved.get("champion") is not None:
        seeds.add(saved["champion"])
    return seeds <= eligible


def content_changed(s, record=True):
    """A corrected tag changes admission too. Its existing undo step owns the affected tournament state."""
    photos, sets, p, _ = snapshot(s)
    if not any(r["changed"] for r in catalogue(s, photos, sets, p)):
        return
    cups = {r["key"].split(":", 1)[1] for r in s.store.q("SELECT key FROM meta WHERE key LIKE 'finals:%' OR key LIKE 'knockouts:%'")}
    champions = s.store.get_meta("champions", {}) or {}
    cups.update(champions)
    previous = {}
    for cup in cups:
        saved = {kind: s.store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals")}
        if any(saved.values()) or cup in champions:
            previous[cup] = {**saved, "champion": champions.get(cup)}
    if previous:
        with s.store.tx() as c:
            def meta(key, value):
                c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
            for cup in previous:
                for kind in ("knockouts", "finals"):
                    meta(f"{kind}:{cup}", None)
                champions.pop(cup, None)
            meta("champions", champions)
            archive = s.store.get_meta("filter_bracket_archive", []) or []
            meta("filter_bracket_archive", (archive + [{"at": time.time(), "tag_edit": True, "cups": previous}])[-20:])
            history = s.store.get_meta("group_history", []) or []
            if record and history and any(k in history[-1] for k in ("tags", "tag_rows", "tag_aliases")):
                history[-1]["content_brackets"] = previous
                meta("group_history", history)
    s.cards.clear()
    s.filter_preview = None


def restore_content_brackets(s, saved):
    """Called after undo's refresh, so a restored bracket never points at a still-excluded take."""
    champs = s.store.get_meta("champions", {}) or {}
    eligible = {r["id"] for r in s.store.q("SELECT id FROM photos WHERE status='analyzed' AND cut IS NULL")}
    for cup, previous in saved.items():
        if not bracket_eligible(previous, eligible) or any(s.store.get_meta(f"{kind}:{cup}") for kind in ("knockouts", "finals")):
            continue
        for kind in ("knockouts", "finals"):
            s.store.set_meta(f"{kind}:{cup}", previous[kind])
        if previous["champion"] is not None:
            champs[cup] = previous["champion"]
    s.store.set_meta("champions", champs)
