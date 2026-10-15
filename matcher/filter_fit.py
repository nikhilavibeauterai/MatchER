"""Continuous Filter positions from saved evidence; examples influence a local neighbourhood."""
from __future__ import annotations

import math

import numpy as np


CONTEXT_COLUMNS = "width,height,sharp,luma,luma_lo,luma_hi,chroma,saturation,hue,zs,sha256,phash,taken_ts"


def _number(value):
    return value if isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) else None


def quality(photo, evidence, policy, mode, reasons):
    """The default line reproduces existing rules exactly, with room to inspect their margins."""
    margins = []
    def low(value, key, radius):
        value = _number(value)
        if value is not None:
            margins.append((value - policy[key]) / radius)
    def high(value, key, radius):
        value = _number(value)
        if value is not None:
            margins.append((policy[key] - value) / radius)
    scores, face = evidence.get("scores") or {}, evidence.get("face") or {}
    width, height = _number(photo.get("width")), _number(photo.get("height"))
    if width and height:
        low(min(width, height), "min_pixels", max(200, policy["min_pixels"] * .5))
    light = photo.get("luma") if mode == "gallery" else face.get("luma")
    low(light, "min_luma", 32)
    high(light, "max_luma", 32)
    if mode == "gallery":
        sharp, blur = _number(photo.get("sharp")), _number(scores.get("blurry"))
        if sharp is not None and blur is not None:
            margins.append(max((sharp - policy["blur_sharpness"]) / max(10, policy["blur_sharpness"]),
                               (policy["blur_confidence"] - blur) / .15))
        for kind in ("document", "screenshot"):
            if policy[kind]:
                high(scores.get(kind), f"{kind}_confidence", .15)
    else:
        low(face.get("h"), "min_face_fraction", .08)
    # The rule evaluator remains authoritative for compound and categorical failures.
    distance = abs(min(margins, default=-1 if reasons else 1))
    distance = max(.1, distance)
    return .5 + (-1 if reasons else 1) * (.02 + .23 * math.tanh(distance))


def _embeddings(store):
    """Cache only saved vectors; moving the line never decodes a photo or runs a model."""
    from .store import unblob
    connection = store.conn()
    with store.lock:
        stamp = (connection.total_changes, connection.execute("PRAGMA data_version").fetchone()[0])
    cached = getattr(store, "_filter_fit_embeddings", None)
    if cached and cached[0] == stamp:
        return cached[1]
    groups = {}
    for row in store.q("SELECT id,emb FROM photos WHERE status='analyzed' AND emb IS NOT NULL"):
        try:
            vector = unblob(row["emb"])
        except (ValueError, TypeError):
            continue
        if vector is None or not vector.size or not np.isfinite(vector).all():
            continue
        norm = float(np.linalg.norm(vector))
        if norm > 1e-8:
            groups.setdefault(vector.size, []).append((row["id"], vector / norm))
    result = {dimension: (dict((pid, i) for i, (pid, _) in enumerate(rows)),
                          np.stack([vector for _, vector in rows])) for dimension, rows in groups.items()}
    store._filter_fit_embeddings = (stamp, result)
    return result


def _features(photo, evidence=None):
    """Natural measurement scales make a visible contrast meaningful without fitting library quantiles."""
    import json
    evidence = json.loads(photo.get("zs") or "{}") if evidence is None else evidence
    face = evidence.get("face") or {}
    def scaled(value, scale):
        value = _number(value)
        return value / scale if value is not None else np.nan
    def logarithm(value, scale=1):
        value = _number(value)
        return math.log2(1 + value) / scale if value is not None and value >= 0 else np.nan
    width, height = _number(photo.get("width")), _number(photo.get("height"))
    sized = width is not None and height is not None and width > 0 and height > 0
    low, high = _number(photo.get("luma_lo")), _number(photo.get("luma_hi"))
    hue = _number(photo.get("hue"))
    return [scaled(photo.get("luma"), 48), logarithm(photo.get("sharp"), 2),
            logarithm(min(width, height)) if sized else np.nan,
            math.log2(width / height) / .5 if sized else np.nan,
            scaled(high - low, 64) if low is not None and high is not None else np.nan,
            scaled(photo.get("chroma"), 24), scaled(photo.get("saturation"), .25),
            math.cos(hue * math.tau) if hue is not None else np.nan,
            math.sin(hue * math.tau) if hue is not None else np.nan,
            scaled(face.get("h"), .12), scaled(face.get("luma"), 48)]


def _contrast(rows, reference_features):
    toward = [reference_features[item["photo"]] for item in rows if item["direction"] == "toward"]
    away = [reference_features[item["photo"]] for item in rows if item["direction"] == "away"]
    if not toward or not away:
        return None
    delta = np.abs(np.asarray(toward)[:, None, :] - np.asarray(away)[None, :, :])
    active = np.any(np.isfinite(delta) & (delta >= 1), axis=(0, 1))
    return active if np.any(active) else None


def _copy_lessons(store, photos, examples, reference_rows, reference_features, subjects, contexts, matches, evidence):
    """A later lesson revises indistinguishable copies locally, not every photo with the same tags."""
    if len({item["direction"] for item in examples}) < 2:
        return {}
    examples = [item for item in examples if type(item.get("seq")) is int and 0 < item["seq"] < 2**53]
    if not examples:
        return {}
    examples.sort(key=lambda item: item["seq"], reverse=True)
    index = {row["id"]: i for i, row in enumerate(photos)}
    generic = {"me", "faces", "outdoors"}
    measured = np.asarray([_features(row, (evidence or {}).get(row["id"])) for row in photos])
    latest, conflicts = {}, set()
    settled = np.zeros(len(photos), np.int64)
    def consider(item, candidates):
        seq, pid = item.get("seq", 0), item["photo"]
        if not seq or pid not in reference_features or not len(candidates):
            return
        # Once a newer compatible copy lesson has settled a target, older lessons cannot change it.
        # This keeps a library containing thousands of duplicate exports cheap too. Ties still compare.
        candidates = candidates[settled[candidates] <= seq]
        if not len(candidates):
            return
        delta = np.abs(measured[candidates] - reference_features[pid])
        known = np.isfinite(delta)
        alike = (np.sum(known, axis=1) >= 2) & ~np.any(known & (delta >= 1), axis=1)
        wanted = subjects.get(pid, frozenset())
        for i in candidates[alike]:
            target = photos[i]["id"]
            member = subjects.get(target, frozenset())
            # Missing broad classifier tags do not make a copy a different subject. Distinct trusted
            # subject combinations and more specific lessons remain meaningful exceptions.
            if wanted - generic and member - generic and not wanted - generic <= member - generic:
                continue
            if any(wanted < other and target in matches[other] for other in contexts):
                continue
            previous = latest.get(i)
            if previous is None or seq > previous["seq"]:
                latest[i] = item
                settled[i] = seq
                conflicts.discard(i)
            elif seq == previous["seq"] and item["direction"] != previous["direction"]:
                conflicts.add(i)
    # Matching file hashes are decisive even if a saved vector is missing.
    identical = {}
    for i, photo in enumerate(photos):
        if photo.get("sha256"):
            identical.setdefault(photo["sha256"], []).append(i)
    for item in examples:
        reference = reference_rows.get(item["photo"], {})
        consider(item, np.asarray(identical.get(reference.get("sha256"), []), dtype=int))
    for positions, vectors in _embeddings(store).values():
        wanted = [item for item in examples if item.get("seq", 0) and item["photo"] in positions]
        found = [(index[pid], position) for pid, position in positions.items() if pid in index]
        if not wanted or not found:
            continue
        target_indices, vector_indices = map(np.asarray, zip(*found))
        candidates = vectors[vector_indices]
        for start in range(0, len(wanted), 32):
            batch = wanted[start:start + 32]
            if np.all(settled[target_indices] > batch[0]["seq"]):
                continue
            similarities = candidates @ vectors[[positions[item["photo"]] for item in batch]].T
            for column, item in enumerate(batch):
                available = settled[target_indices] <= item["seq"]
                if not np.any(available):
                    continue
                similar = similarities[:, column]
                selected = (similar >= .975) & available
                # The same conservative hash distance used for twins can confirm a changed export.
                # Require compatible saved visual evidence as well; flat images often share hashes.
                reference = reference_rows[item["photo"]]
                reference_hash = reference.get("phash")
                if reference_hash:
                    try:
                        reference_hash = int(reference_hash, 16)
                    except (TypeError, ValueError):
                        reference_hash = None
                    if reference_hash is not None:
                        reference_time = _number(reference.get("taken_ts"))
                        for j in np.flatnonzero((similar >= .90) & ~selected & available):
                            photo = photos[target_indices[j]]
                            value, taken = photo.get("phash"), _number(photo.get("taken_ts"))
                            try:
                                distance = (int(value, 16) ^ reference_hash).bit_count() if value else 65
                            except (TypeError, ValueError):
                                continue
                            # A crop in a close burst has three independent cues. Never extend this
                            # through a chain of neighbours or through a manually merged stack.
                            burst = (similar[j] >= .95 and distance <= 12 and reference_time is not None
                                     and taken is not None and abs(taken - reference_time) <= 30)
                            if distance <= 6 or burst:
                                selected[j] = True
                consider(item, target_indices[selected])
    return {i: item for i, item in latest.items() if i not in conflicts}


def influence(store, photos, sets, examples, evidence=None, matched=None):
    """Find the context of contrasting examples; duplicates never multiply their strength."""
    from . import tags
    ids = [row["id"] for row in photos]
    positive, negative = np.zeros(len(ids), np.float32), np.zeros(len(ids), np.float32)
    if matched is not None:
        matched.clear()
        latest = np.zeros(len(ids), np.int64)
        direction_at = np.zeros(len(ids), np.int8)
        strength_at = np.zeros(len(ids), np.float32)
    def sequence(item):
        value = item.get("seq", 0)
        return value if type(value) is int and value > 0 else 0
    def record(indices, strength, seq, direction):
        if matched is None or not seq:
            return
        strong = (strength >= .7) & (seq > latest[indices])
        selected = indices[strong]
        latest[selected], direction_at[selected] = seq, 1 if direction == "toward" else -1
        strength_at[selected] = strength[strong]
    if not examples or not ids:
        return positive
    index = {pid: i for i, pid in enumerate(ids)}
    reference_ids = {item["photo"] for item in examples}
    reference_rows = {row["id"]: dict(row) for row in store.q(
        f"SELECT id,{CONTEXT_COLUMNS} FROM photos WHERE status='analyzed' AND id IN ({','.join('?' * len(reference_ids))})", list(reference_ids))}
    metadata = tags.rows(store)
    def subjects(values):
        return frozenset(key for key in values if not key.startswith("x:")
                         and metadata.get(key, {}).get("family", tags.FIXED.get(key, (None, None, "what"))[2]) in {"what", "people"})
    sets = {**sets, **tags.effective(store, reference_ids - sets.keys())}
    subjects_by_id = {pid: subjects(values) for pid, values in sets.items()}
    members = {}
    for pid in ids:
        for key in subjects_by_id.get(pid, ()):
            members.setdefault(key, set()).add(pid)
    # These broad tags alone don't explain what a player liked about a picture.
    generic = {"me", "faces", "outdoors"}
    untagged, contexts = [], {}
    for example in examples:
        pid, direction = example["photo"], example["direction"]
        if pid not in reference_rows:
            continue
        wanted = subjects_by_id.get(pid, frozenset())
        if wanted - generic:
            contexts.setdefault(wanted, []).append(example)
        else:
            untagged.append(example)
    matches = {wanted: set.intersection(*(members.get(tag, set()) for tag in wanted)) for wanted in contexts}
    reference_features = {pid: _features(row, (evidence or {}).get(pid)) for pid, row in reference_rows.items()}
    measured = None
    for wanted, rows in contexts.items():
        # A more specific context can be an intentional exception: dogs at the beach versus dogs generally.
        matching = matches[wanted].difference(*(values for other, values in matches.items() if wanted < other))
        if not matching:
            continue
        active = _contrast(rows, reference_features)
        indices = np.array([index[pid] for pid in matching])
        affinities = np.array([1 / (1 + .12 * len(subjects_by_id.get(pid, ()) - wanted)) for pid in matching], np.float32)
        if active is not None and measured is None:
            measured = np.asarray([_features(row, (evidence or {}).get(row["id"])) for row in photos])
        for direction, target in (("toward", positive), ("away", negative)):
            examples_here = [item for item in rows if item["direction"] == direction]
            references = [reference_features[item["photo"]] for item in examples_here]
            if not references:
                continue
            strength = np.ones(len(indices), np.float32) if active is None else np.zeros(len(indices), np.float32)
            if active is None:
                record(indices, affinities, max(map(sequence, examples_here), default=0), direction)
            if active is not None:
                candidates = measured[indices][:, active]
                # Use every clear difference together. Similar subjects need not have the same light,
                # detail or framing, and one pair does not justify a global brightness/size rule.
                distinct, membership = np.unique(np.asarray(references)[:, active], axis=0, return_inverse=True)
                for group, reference in enumerate(distinct):
                    delta = candidates - reference
                    known = np.isfinite(delta)
                    distance = np.sum(np.where(known, delta * delta, 0), axis=1)
                    count = np.sum(known, axis=1)
                    similarity = np.exp(-2 * distance / np.maximum(count, 1)) * (count / len(reference))
                    strength = np.maximum(strength, similarity)
                    seq = max((sequence(examples_here[i]) for i in np.flatnonzero(membership == group)), default=0)
                    record(indices, affinities * similarity, seq, direction)
            target[indices] = np.maximum(target[indices], affinities * strength)
    if untagged:
        for positions, vectors in _embeddings(store).values():
            wanted = [item for item in untagged if item["photo"] in positions]
            found = [(index[pid], position) for pid, position in positions.items() if pid in index]
            if not wanted or not found:
                continue
            target_indices, vector_indices = map(np.asarray, zip(*found))
            candidates = vectors[vector_indices]
            # A fixed-size batch bounds temporary memory even with ten thousand takes.
            for start in range(0, len(wanted), 32):
                batch = wanted[start:start + 32]
                references = vectors[[positions[item["photo"]] for item in batch]]
                similarity = candidates @ references.T
                affinity = np.clip((similarity - .78) / .17, 0, 1)
                for column, item in enumerate(batch):
                    target = positive if item["direction"] == "toward" else negative
                    target[target_indices] = np.maximum(target[target_indices], affinity[:, column])
                    record(target_indices, affinity[:, column], sequence(item), item["direction"])
    pull = positive - negative
    revised = _copy_lessons(store, photos, examples, reference_rows, reference_features,
                           subjects_by_id, contexts, matches, evidence)
    for i, item in revised.items():
        direction = 1 if item["direction"] == "toward" else -1
        pull[i] = direction
        if matched is not None:
            latest[i], direction_at[i], strength_at[i] = item["seq"], direction, 1
    if matched is not None:
        # New teaching may revisit an older call only when its context has a clear winning preference.
        # Equally described different photos remain ambiguous; directly matched copies can revise a lesson.
        for i in np.flatnonzero((latest > 0) & (pull * direction_at >= .7)):
            matched[ids[i]] = {"direction": "toward" if direction_at[i] > 0 else "away",
                               "seq": int(latest[i]), "strength": float(strength_at[i])}
    return pull


def assess(store, photos, sets, policy, mode, evidence=None, now=None):
    """Return policy failures and displayed positions for the same inputs in preview and Apply."""
    import json
    from .filtering import evaluate
    evidence = evidence if evidence is not None else {photo["id"]: json.loads(photo.get("zs") or "{}") for photo in photos}
    pull = influence(store, photos, sets, policy.get("fit_examples", []), evidence)
    threshold = policy.get("fit_threshold", .5)
    result = {}
    for i, photo in enumerate(photos):
        pid = photo["id"]
        ev = evidence[pid]
        reasons = evaluate(photo, ev, policy, mode, sets.get(pid, ()), now)
        score = round(min(.99, max(.01, quality(photo, ev, policy, mode, reasons) + .38 * float(pull[i]))), 6)
        if photo.get("status") == "error":
            reasons, score = ["unreadable"], 0
        else:
            reasons = (reasons or ["filter_fit"]) if score < threshold else []
            if photo.get("override") in {"keep", "toss"}:
                score = 1 if photo["override"] == "keep" else 0
        result[pid] = (reasons, round(score, 6))
    return result
