"""Automatic descriptions need positive evidence; ranking within a folder cannot create it."""
import json
from types import SimpleNamespace

import numpy as np

from matcher import library, tags, themes


def scores(**rows):
    out = np.zeros((1, len(themes.CONCEPTS)), np.float32)
    keys = [c[0] for c in themes.CONCEPTS]
    for key, value in rows.items():
        out[0, keys.index(key)] = value
    return out


def model(monkeypatch, C, positive=.0, negative=.0):
    """Controlled cosine evidence, including the misleading dog-vs-person comparison."""
    monkeypatch.setattr(themes, 'concept_scores', lambda E: np.repeat(C, len(E), axis=0))
    def prompts(ps):
        out = np.zeros((len(ps), 768), np.float32)
        for i, p in enumerate(ps):
            out[i, 0] = positive if p == 'a person with a dog' else negative
        return out
    monkeypatch.setattr(library, '_prompt_embeddings', prompts)
    E = np.zeros((1, 768), np.float32)
    E[0, 0] = 1
    return E


def test_uniform_and_tiny_outliers_abstain_instead_of_forcing_tags(monkeypatch):
    for C in (np.full((1, len(themes.CONCEPTS)), .01),
              np.full((1, len(themes.CONCEPTS)), .1), scores(dogs=.025, cats=.01)):
        E = model(monkeypatch, C, positive=.035, negative=-.015)
        assert tags.recognize(E) == [{}]  # old binary comparison exceeds .99 despite weak dog evidence
    monkeypatch.setattr(library, 'category_scores', lambda E: np.full((len(E), 6), .01))
    assert library.category_names(E) == ['']


def test_competing_explanations_do_not_gain_dog_tag_from_binary_attribute(monkeypatch):
    for other in ('cats', 'food', 'selfie', 'forest'):
        C = scores(dogs=.04, **{other: .085})
        E = model(monkeypatch, C, positive=.08, negative=-.01)
        found = tags.recognize(E)[0]
        assert other in found
        assert 'dogs' not in found


def test_strong_dog_evidence_survives_alone_and_with_people(monkeypatch):
    for C in (scores(dogs=.075, cats=.01), scores(dogs=.085, portrait=.13, style=.10)):
        E = model(monkeypatch, C, positive=.09, negative=.01)
        assert 'dogs' in tags.recognize(E)[0]
    assert 'a person with a dog' in next(c[2] for c in themes.CONCEPTS if c[0] == 'dogs')


def test_recognition_does_not_depend_on_library_composition(monkeypatch):
    E = model(monkeypatch, scores(dogs=.08, cats=.005), positive=.085, negative=.005)
    alone = tags.recognize(E)[0]
    assert all(row == alone for row in tags.recognize(np.repeat(E, 120, axis=0)))


def test_faces_fill_uncertain_kinds_without_overruling_strong_scene_evidence(monkeypatch):
    C = np.full((3, len(library.CATEGORIES)), .01, np.float32)
    C[0, list(library.CATEGORIES).index('nature')] = .12
    monkeypatch.setattr(library, 'category_scores', lambda E: C)
    lib = SimpleNamespace(emb=np.zeros((3, 768)), has_emb=np.ones(3, bool),
                          photos=[{'id': i} for i in range(3)], faces=[{'px': 70}, {'px': 80}],
                          faces_by_photo={0: [0], 1: [1]})
    assert library.categorize(lib) == ['nature', 'people', '']


def test_legacy_discoveries_revalidated_manual_edits_and_confirmed_history_preserved(lib_env, monkeypatch):
    _, _, store, _ = lib_env
    ids = [r['id'] for r in store.q('SELECT id FROM photos ORDER BY id LIMIT 3')]
    with store.tx() as c:
        for pid in ids:
            c.execute('UPDATE photos SET recognized_tags=? WHERE id=?', (json.dumps({'dogs': .99, 'faces': 1}), pid))
        c.execute('UPDATE photos SET recognized_tags=? WHERE id=?', (tags.discovery_json({'beach': .08}), ids[2]))
        c.executemany('INSERT INTO tag_edits(photo_id,tag,val) VALUES(?,?,?)', [(ids[0], 'dogs', 1), (ids[1], 'faces', 0)])
        c.execute("INSERT INTO tags(key,label,emoji,family,named) VALUES('dogs','My dogs','🐕','what',1)")
    # Nothing in this synthetic batch supplies semantic evidence; measured face tags still have their own source.
    monkeypatch.setattr(tags, 'recognize', lambda full, crop=None: [{} for _ in full])
    library.refresh(store)
    eff = tags.effective(store)
    assert 'dogs' in eff[ids[0]] and 'dogs' not in eff[ids[1]]
    assert 'faces' not in eff[ids[1]] and 'beach' in eff[ids[2]]
    assert tags.rows(store)['dogs']['label'] == 'My dogs'
    for pid in ids[:2]:
        found, current = tags.discovery(store.one('SELECT recognized_tags FROM photos WHERE id=?', (pid,))[0])
        assert current and found == {'faces': 1.0}
    library.refresh(store)
    assert tags.effective(store) == eff
    assert store.get_meta('derived_version') == library.DERIVED_VERSION


def test_analysis_and_refresh_share_the_same_conservative_discoveries(lib_env, monkeypatch):
    from matcher.analyze import Analyzer
    src, work, store, _ = lib_env
    pid = store.one('SELECT id FROM photos ORDER BY id LIMIT 1')[0]
    E = model(monkeypatch, scores(cats=.085, dogs=.035), positive=.08, negative=-.01)
    monkeypatch.setattr(library, 'category_names', lambda full: ['animals' for _ in full])
    analyzer = Analyzer(store, src, work)
    analyzer._sig = SimpleNamespace(embed_images=lambda batch: np.repeat(E, len(batch), axis=0))
    analyzer._embed([{'id': pid}], lambda r: np.zeros((3, 224, 224), np.float32), 'emb', 'understanding', kinds=True)
    discovered = {t[3] for t in analyzer.feed['cats'][-1][2]}
    assert discovered == {'cats'}
    found, current = tags.discovery(store.one('SELECT recognized_tags FROM photos WHERE id=?', (pid,))[0])
    assert current and set(found) == discovered
    analyzer._embed([{'id': pid, 'me_face': None}], lambda r: (None, np.zeros((3, 224, 224), np.float32)),
                    'crop_emb', 'details', closer=True)
    closer = {t[3] for t in analyzer.feed['seen'][-1][2]}
    assert 'cats' in closer and 'dogs' not in closer
    library.refresh(store)
    assert 'cats' in tags.effective(store)[pid] and 'dogs' not in tags.effective(store)[pid]


def test_automatic_group_names_need_majority_evidence(monkeypatch):
    E = model(monkeypatch, scores(dogs=.02, cats=.01))
    namer = themes.Namer(np.repeat(E, 8, axis=0))
    assert {o['concept'] for o in namer.options(range(8), set())} == {'wild'}
    E = model(monkeypatch, scores(dogs=.075))
    namer = themes.Namer(np.repeat(E, 8, axis=0))
    assert {o['concept'] for o in namer.options(range(8), set())} == {'dogs'}
