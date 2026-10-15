"""Filter rewards useful review without rewarding rejection or repeated calls."""
import pytest

from matcher import game
from tests.test_filtering import client, fetch, post


def test_filter_review_rewards_are_bounded_and_separate_from_stage_completion():
    assert game.stats([], drawn={"filter_reviewed": 12})["xp"] == 24
    assert "filter_round" in game.stats([], drawn={"filter_reviewed": 12})["unlocked"]
    assert "filter_round" not in game.stats([], drawn={"filter_reviewed": 11})["unlocked"]
    assert game.stats([], drawn={"filter_reviewed": 10000})["xp"] == 48
    assert game.stats([], drawn={"filter_reviewed": 24, "filter_done": True})["xp"] == 48 + game.STAGE_XP["filter"]
    assert next(a for a in game.catalog([]) if a["id"] == "filter_round")["stage"] == "Filter"


@pytest.mark.parametrize("action", ["keep", "aside"])
def test_filter_review_reward_counts_one_family_and_undo_restores_it(client, action):
    s = client.session
    data = fetch(client)
    family = s.store.one("SELECT group_id FROM photos WHERE group_id>0 GROUP BY group_id HAVING COUNT(*)>1 LIMIT 1")
    assert family
    ids = [r["id"] for r in s.store.q("SELECT id FROM photos WHERE group_id=? ORDER BY id", (family["group_id"],))]
    first = ids[0]
    assert len(ids) >= 2
    base = s.progress()["game"]["xp"]
    assert post(client, "/api/filter/decision", {"photos": [first], "action": action}).status_code == 200
    assert s.progress()["game"]["xp"] == base + 2
    assert post(client, "/api/filter/decision", {"photos": ids, "action": action}).status_code == 200
    assert s.progress()["game"]["xp"] == base + 2
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.progress()["game"]["xp"] == base + 2
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.progress()["game"]["xp"] == base
    assert fetch(client)["policy"] == data["policy"]


def test_every_take_achievement_requires_real_nonempty_coverage_and_stays_earned():
    for total, considered in [(0, 0), (12, 0), (12, 11)]:
        assert 'filter_all' not in game.stats([], drawn={
            'filter_total': total, 'filter_considered': considered, 'filter_done': True})['unlocked']
    complete = game.stats([], drawn={'filter_total': 12, 'filter_considered': 12})
    assert 'filter_all' in complete['unlocked']
    assert complete['xp'] == 0  # Coverage is a nudge, never a reason to rush or farm calls.
    assert 'filter_all' in game.stats([], drawn={'filter_total': 12, 'filter_considered': 11},
                                    earned=complete['unlocked'])['unlocked']
    assert next(a for a in game.catalog([]) if a['id'] == 'filter_all')['stage'] == 'Filter'


def test_every_take_achievement_counts_takes_not_stacks_and_excludes_automatic_filtering(client):
    initial = fetch(client)
    ids = [row['id'] for row in initial['photos']]
    assert len(ids) == initial['counts']['total'] and len(ids) > 1
    assert 'filter_all' not in client.session.progress()['game']['unlocked']
    post(client, '/api/filter/finish')
    assert 'filter_all' not in client.session.progress()['game']['unlocked']
    for pid in ids[:-1]:
        response = post(client, '/api/filter/decision', {'photos': [pid], 'action': 'keep'})
        assert response.status_code == 200
    before = client.session.progress()['game']
    assert before['filter_considered'] == len(ids) - 1
    assert 'filter_all' not in before['unlocked']
    response = post(client, '/api/filter/tune', {'photo': ids[-1], 'direction': 'away'})
    assert response.status_code == 200
    complete = client.session.progress()['game']
    assert complete['filter_considered'] == complete['filter_total'] == len(ids)
    assert 'filter_all' in complete['unlocked']
    assert post(client, '/api/draw/undo').status_code == 200
    after = client.session.progress()['game']
    assert after['filter_considered'] == len(ids) - 1
    assert 'filter_all' in after['unlocked']
