"""Stack edits keep the page in place; an explicit order change can arrange it again."""
import time

import pytest

from matcher import library
from matcher.server import _slug, create_app
from tests.conftest import build_library


@pytest.fixture
def client(tmp_path, fake_prompts):
    source, data = tmp_path / "photos", tmp_path / "data"
    store, _ = build_library(source, data / _slug(source.resolve()), n_singles=0,
                             bursts=tuple((3, f"burst{i}") for i in range(8)), strangers=0, screenshots=0)
    library.refresh(store)
    store.set_meta("analyzed_at", time.time())
    store.set_meta("source", str(source.resolve()))
    app = create_app(data, allowed_hosts={"localhost"})
    app.config["MATCHER"].open(source, start=False)
    client = app.test_client()
    client.matcher = app.config["MATCHER"]
    yield client
    client.matcher.close()
    for session in client.matcher._sessions.values():
        session.shutdown()
    store.close()


def post(client, path, payload=None):
    response = client.post(path, json=payload or {}, headers={"X-MatchER": "1"})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def shots(client, order="look", **options):
    response = client.get("/api/groups", query_string={"view": "stacks", "order": order, "per": 500, **options})
    assert response.status_code == 200
    return response.get_json()


def identities(rows):
    return [(frozenset(x["members"]), x.get("family")) for x in rows]


@pytest.mark.parametrize("order", ["look", "time"])
def test_picking_another_take_keeps_stack_and_family_positions(client, order):
    before = shots(client, order)["shots"]
    target = before[4]
    chosen = next(m for m in target["members"] if m != target["rep"])
    post(client, "/api/frame", {"photo": chosen})
    # Other views also use the response cache; they must not erase the Stacks ordering ledger.
    assert client.get("/api/groups?view=all&order=look").status_code == 200
    after = shots(client, order)["shots"]
    assert identities(after) == identities(before)
    assert after[4]["rep"] == chosen
    post(client, "/api/draw/undo")
    assert identities(shots(client, order)["shots"]) == identities(before)


def test_merge_and_undo_preserve_surviving_slots_and_page_order(client):
    before = shots(client)["shots"]
    a, b = before[1], before[5]
    post(client, "/api/groups/merge", {"photos": [a["rep"], b["rep"]]})
    expected = identities(before)
    expected[1] = (frozenset(a["members"] + b["members"]), a.get("family"))
    del expected[5]
    assert identities(shots(client)["shots"]) == expected
    first = shots(client, per=2)
    pages = first["shots"][:]
    for page in range(1, first["pages"]):
        pages += shots(client, per=2, page=page)["shots"]
    assert identities(pages) == expected
    assert len({p for x in pages for p in x["members"]}) == sum(len(x["members"]) for x in pages)
    post(client, "/api/draw/undo")
    assert identities(shots(client)["shots"]) == identities(before)


def test_explicit_reorder_rebuilds_the_view_without_database_edits(client, monkeypatch):
    before = shots(client)["shots"]
    original = library.lookalike_order
    def reversed_order(embeddings):
        order, families = original(embeddings)
        return list(reversed(order)), families
    monkeypatch.setattr(library, "lookalike_order", reversed_order)
    session = client.matcher.session
    writes = session.store.conn().total_changes
    assert identities(shots(client)["shots"]) == identities(before)
    after = shots(client, reorder=1)["shots"]
    assert [frozenset(x["members"]) for x in after] == [frozenset(x["members"]) for x in reversed(before)]
    assert session.store.conn().total_changes == writes
