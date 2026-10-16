import numpy as np

from matcher import search
from matcher.store import unblob
from tests.test_draw import client, post, single


def test_visual_search_uses_saved_full_and_crop_vectors_and_keeps_every_take(client, monkeypatch):
    s = client.matcher.session
    pid = single(client, 1)
    vector = unblob(s.store.one("SELECT emb FROM photos WHERE id=?", (pid,))[0])
    monkeypatch.setattr(search, "encode", lambda query: vector / np.linalg.norm(vector))
    before = s.store.conn().total_changes
    result = client.get('/api/search?q=red+jacket').get_json()
    assert result['query'] == 'red jacket' and result['photos'][0]['photo'] == pid
    assert len({p['photo'] for p in result['photos']}) == len(result['photos'])
    assert s.store.conn().total_changes == before
    assert client.get('/api/search?q=').get_json()['photos'] == []
    assert client.get('/api/search?q=' + 'x' * 201).status_code == 400


def test_titles_and_tag_names_become_searchable_immediately(client, monkeypatch):
    s = client.matcher.session
    pid = single(client, 2)
    monkeypatch.setattr(search, "encode", lambda query: np.zeros(768, np.float32))
    client.get('/api/search?q=warming+the+cache')
    post(client, '/api/edit', {'photo': pid, 'title': 'My red jacket'})
    result = client.get('/api/search?q=red+jacket').get_json()['photos']
    assert result[0]['photo'] == pid and result[0]['match'] == 'name'
    other = single(client, 3)
    post(client, '/api/tags/new', {'label': 'Evening clothes', 'photos': [other], 'exact': True})
    result = client.get('/api/search?q=evening+clothes').get_json()['photos']
    assert result[0]['photo'] == other and result[0]['match'] == 'tag'
    post(client, '/api/draw/undo')
    assert all(p['match'] != 'tag' for p in client.get('/api/search?q=evening+clothes').get_json()['photos'])
