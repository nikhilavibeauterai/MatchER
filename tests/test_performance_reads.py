"""Read optimizations preserve edits, group changes and undo on synthetic libraries."""
import json
import sqlite3
from types import SimpleNamespace

import pytest

from tests.test_draw import client, post, single  # noqa: F401
from tests.benchmark_performance import catalogue
from matcher.server import create_app


def test_visible_cards_read_their_full_edits_in_one_batch_without_writes(client):
    s = client.matcher.session
    ids = [single(client, i) for i in range(3)]
    # Count the request's writes only after background thumbnail upgrades have finished.
    for worker in (s._subjects_thread, s._looks_thread):
        if worker is not None:
            worker.join(timeout=10)
            assert not worker.is_alive()
    edits = {"title": "Saved title", "notes": [{"x": 8, "y": 120, "text": "Keep this note"}],
             "marks": [{"t": "pen", "c": "ink", "w": 1, "p": [[1, 2], [3, 4]]}]}
    with s.store.tx() as c:
        c.execute("UPDATE photos SET edits=? WHERE id=?", (json.dumps(edits), ids[0]))
    before = s.store.conn().total_changes, s.draw.last_step()
    result = client.get('/api/edits?photos=' + ','.join(map(str, [*ids, ids[0], 999999]))).get_json()
    rows = {r['photo']: r['edits'] for r in result['photos']}
    assert set(rows) == set(ids) and rows[ids[0]] == edits and rows[ids[1]] == {}
    assert (s.store.conn().total_changes, s.draw.last_step()) == before


@pytest.mark.parametrize('query', ['', '-1', '1,x', '1,', '9' * 30, ','.join(map(str, range(1, 202)))])
def test_edit_batch_is_bounded_and_rejects_invalid_photo_ids(client, query):
    assert client.get('/api/edits?photos=' + query).status_code == 400


def test_board_pages_share_a_snapshot_but_group_changes_and_undo_replace_it(client, monkeypatch):
    s = client.matcher.session
    a, b = single(client, 0), single(client, 1)
    group = post(client, '/api/draw/new', {'photos': [a], 'name': 'Original group'}).get_json()['theme']['id']
    calls = []; state = s.draw.state
    monkeypatch.setattr(s.draw, 'state', lambda: (calls.append(1), state())[1])
    first = client.get('/api/draw/board?per=4').get_json()
    assert first['version'] == client.get('/api/world?per=4').get_json()['version']
    cached = s.draw._board_cache
    client.get('/api/draw/board?per=4&page=1')
    assert s.draw._board_cache is cached and len(calls) == 1
    assert first['groups'][0]['count'] == 1
    post(client, '/api/draw/move', {'photos': [b], 'theme': group})
    changed = client.get('/api/draw/board?per=4').get_json()
    assert changed['version'] != first['version']
    assert s.draw._board_cache is not cached and changed['groups'][0]['count'] == 2
    post(client, '/api/draw/undo')
    restored = client.get('/api/draw/board?per=4').get_json()
    assert restored['groups'][0]['count'] == 1
    post(client, '/api/draw/rename', {'theme': group, 'name': 'Renamed group'})
    assert client.get('/api/draw/board').get_json()['groups'][0]['name'] == 'Renamed group'


def test_journey_chooses_its_group_thumbnail_without_building_every_roster(client, monkeypatch):
    s = client.matcher.session
    post(client, '/api/draw/new', {'photos': [single(client, i) for i in range(10)]})
    expected = s.draw.tables()[0]['rows'][0]['photo']
    monkeypatch.setattr(s.draw, 'tables', lambda: pytest.fail('The HUD only needs one thumbnail'))
    assert client.get('/api/journey').get_json()['thumbs']['groups'] == expected


def test_large_group_edits_do_not_truncate_the_selection_and_undo_every_photo(tmp_path, monkeypatch):
    s = catalogue(tmp_path, 1200)
    app = create_app(tmp_path / 'scratch', allowed_hosts={'localhost'}); app.config['MATCHER'].session = s
    c = app.test_client(); ids = s.reps
    s.store.conn().setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
    pool, calls = s.draw.pool_mask, []
    monkeypatch.setattr(s.draw, 'pool_mask', lambda: (calls.append(1), pool())[1])
    s.draw._space = (*s.draw._space[:3], SimpleNamespace(name=lambda *_: {'name': 'Synthetic', 'emoji': '🌈', 'concept': None}), *s.draw._space[4:])
    try:
        reply = post(c, '/api/draw/move', {'photos': ids, 'theme': 2})
        assert reply.status_code == 200, reply.get_json()
        assert s.store.one('SELECT COUNT(*) AS n FROM photos WHERE theme_id=2')['n'] == len(ids)
        assert len(calls) < 30, 'Validating the selection does not build 1,200 whole-library masks'
        assert post(c, '/api/draw/undo').status_code == 200
        assert s.store.one('SELECT COUNT(*) AS n FROM photos WHERE theme_id=1')['n'] == 600
        reply = post(c, '/api/draw/new', {'photos': ids, 'name': 'Every selected photo'})
        assert reply.status_code == 200, reply.get_json()
        group = reply.get_json()['theme']
        assert group['size'] == len(ids)
        assert post(c, '/api/draw/undo').status_code == 200
        assert s.store.one('SELECT COUNT(*) AS n FROM photos WHERE theme_id=2')['n'] == 600
    finally:
        s.shutdown()


def test_sweep_hud_reuses_candidates_without_building_photo_views(client, monkeypatch):
    s = client.matcher.session; s.ensure_ranker()
    expected = len(s.sweep_cards())
    monkeypatch.setattr(s, 'photo_view', lambda *_: pytest.fail('The HUD only needs a count'))
    assert s._sweep_stage()['left'] == expected
