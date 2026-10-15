"""Small, varied Filter rounds from saved measurements; selection never calls a vision model."""
from __future__ import annotations

import math


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _boundary(row, policy, mode):
    """Distance is only a sampling hint, not the probability that a take should be kept."""
    metrics = row.get("metrics") or {}
    face, scores = metrics.get("face") or {}, metrics.get("scores") or {}
    choices = []

    def add(value, key, radius, label, active=True):
        value, threshold = _number(value), _number(policy.get(key))
        if active and value is not None and threshold is not None:
            choices.append((abs(value - threshold) / max(radius, 1e-6), label))

    width, height = _number(metrics.get("width")), _number(metrics.get("height"))
    size = min(width, height) if width and height and width > 0 and height > 0 else None
    add(size, "min_pixels", max(100, (policy.get("min_pixels") or 0) * .2), "Near your size limit", bool(policy.get("min_pixels")))
    light = metrics.get("brightness") if mode == "gallery" else face.get("luma")
    add(light, "min_luma", 16, "Near your darkness limit", bool(policy.get("min_luma")))
    add(light, "max_luma", 16, "Near your brightness limit", policy.get("max_luma", 255) < 255)
    sharp, blur = _number(metrics.get("sharpness")), _number(scores.get("blurry"))
    if mode == "gallery":
        # A sharpness limit has no effect without the second part of its blur check.
        add(sharp, "blur_sharpness", max(5, (policy.get("blur_sharpness") or 0) * .25), "Near your blur limit",
            blur is not None and blur > policy.get("blur_confidence", 1))
        add(blur, "blur_confidence", .08, "Near your blur check",
            sharp is not None and sharp < policy.get("blur_sharpness", 0))
        add(scores.get("document"), "document_confidence", .08, "Near your document check", policy.get("document", False))
        accidental, light = _number(scores.get("accidental")), _number(light)
        evidence = ((light is not None and light < policy.get("accidental_luma", 0)) or
                    (sharp is not None and sharp < policy.get("accidental_sharpness", 0)))
        add(accidental, "accidental_confidence", .08, "Near your accidental-shot check", policy.get("accidental", False) and evidence)
    else:
        pixels, face_sharp = _number(face.get("px")), _number(face.get("sharp"))
        measured = pixels is not None and pixels >= policy.get("face_blur_min_pixels", 0)
        add(sharp, "blur_sharpness", max(5, (policy.get("blur_sharpness") or 0) * .25), "Near your blur limit",
            measured and face_sharp is not None and face_sharp < policy.get("face_blur_sharpness", 0))
        add(face_sharp, "face_blur_sharpness", max(3, (policy.get("face_blur_sharpness") or 0) * .25), "Near your face-blur limit",
            measured and sharp is not None and sharp < policy.get("blur_sharpness", 0))
        add(face.get("h"), "min_face_fraction", .02, "Near your face-size limit", bool(policy.get("min_face_fraction")))
    add(scores.get("screenshot"), "screenshot_confidence", .08, "Near your screenshot check", policy.get("screenshot", False))
    return min(choices) if choices else (None, None)


def schedule(rows, policy, mode, tags, families, seen=(), deferred=(), scope="all", limit=12):
    """Choose a stable round; the caller holds it steady until the next round is requested.

    Family identities come from the library, so near-identical takes cannot crowd out other
    subjects. Once the distinct families have had a turn, their other takes remain available.
    At most twelve linear selections keep work bounded for a large library.
    """
    limit = max(0, min(12, int(limit)))
    if not limit:
        return {"ids": [], "why": {}}
    seen = set(seen)
    allowed = None if isinstance(scope, str) else set(scope)
    if isinstance(scope, str) and scope not in {"all", "kept", "aside", "changed"}:
        raise ValueError("Unknown Filter review scope.")
    previous = {families.get(pid, ("photo", pid)) for pid in seen}
    prepared = {}
    for row in rows:
        pid = row["id"]
        if pid in seen or row.get("playable") is False or row.get("status") == "error":
            continue
        aside = row.get("disposition") == "aside" if "disposition" in row else row.get("cut") is not None
        if (allowed is not None and pid not in allowed or scope == "kept" and aside or scope == "aside" and not aside
                or scope == "changed" and not row.get("changed")):
            continue
        distance, label = _boundary(row, policy, mode)
        prepared[pid] = {"id": pid, "family": families.get(pid, ("photo", pid)), "aside": aside,
                         "changed": bool(row.get("changed")), "distance": distance, "label": label,
                         "subject_check": bool(set(row.get("reasons") or ()) & {"required_tags", "excluded_tags"}),
                         "tags": set(tags.get(pid, ())) - {"x:cut"}, "manual": bool(row.get("override"))}
    picked, why, used, covered = [], {}, set(), set()

    def take(item, reason):
        pid = item["id"]
        picked.append(pid)
        why[pid] = reason
        used.add(item["family"])
        covered.update(item["tags"])
        prepared.pop(pid)

    # A deferred take returns in the next round without replacing the whole varied sample.
    for pid in dict.fromkeys(deferred):
        item = prepared.get(pid)
        if item is not None and item["family"] not in used:
            take(item, "Back from Later")
            if len(picked) >= min(2, limit):
                break
    plan = ("changed", "boundary", "subjects", "kept", "boundary", "content", "subjects", "aside",
            "changed", "boundary", "subjects", "boundary")
    for kind in plan:
        if len(picked) >= limit or not prepared:
            break
        # Prefer a new family even when a tempting boundary exists among an earlier stack.
        fresh = [item for item in prepared.values() if item["family"] not in used]
        candidates = fresh or list(prepared.values())
        unreviewed = [item for item in candidates if item["family"] not in previous]
        candidates = unreviewed or candidates
        def fits(item):
            if kind == "changed":
                return item["changed"]
            if kind == "boundary":
                return item["distance"] is not None and item["distance"] <= 1 and not item["manual"]
            if kind == "subjects":
                return bool(item["tags"] - covered)
            if kind == "content":
                return item["subject_check"] and not item["manual"]
            return item["aside"] == (kind == "aside") and not item["manual"]
        matching = [item for item in candidates if fits(item)]
        chosen_kind = kind if matching else "subjects"
        def rank(item):
            novelty = -len(item["tags"] - covered)
            distance = item["distance"]
            if chosen_kind == "boundary":
                return distance, novelty, item["id"]
            if chosen_kind in {"kept", "aside"}:
                return -(distance if distance is not None else -1), novelty, item["id"]
            return novelty, bool(item["manual"]), item["id"]
        item = min(matching or candidates, key=rank)
        label = {"changed": "Changed by this draft", "boundary": item["label"], "content": "Check a subject match",
                 "kept": "Spot-check an in-play take", "aside": "Spot-check a set-aside take",
                 "subjects": "A different mix of subjects" if item["tags"] - covered else "Another take to check"}[chosen_kind]
        take(item, label)
    return {"ids": picked, "why": why}
