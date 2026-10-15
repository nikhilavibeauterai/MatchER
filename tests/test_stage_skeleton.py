"""Every stage ends the same way: a skipped knockouts stage says so (and earns no bonus), teams carry one colour,
and groups, suggestions and sea flocks share one playful voice."""
from matcher import game, tags
from tests.test_tournament_consistency import call, field
from tests.test_filtering import client  # noqa: F401 (the synthetic library fixture)


def test_catchy_names_speak_with_one_voice():
    assert tags.catchy_names("beach")[0] == "Beach Bum Era"          # a concept's names
    assert tags.catchy_names("kind:things")[0] == "Odds & Ends"      # a kind leading a group
    assert tags.catchy_names("faces")[0] == "Face Value"             # a fixed tag that had no name before
    assert tags.catchy_names("smiling") == tags.catchy_names("smile")  # aliases share them
    assert tags.catchy_names("person:5") == []                       # people keep their own names
    name, _ = tags.name_for(["kind:things", "art"], {"art": {"label": "Art"}}, set())
    assert name == "Odds & Ends", "a catchy name stands alone; the tags it combines are listed beside it"


def test_small_field_skips_the_knockouts_without_a_stage_bonus(client):
    ids = field(client, 4)
    group = call(client, "/api/draw/new", {"photos": ids})["theme"]
    before = client.get("/api/journey").get_json()["stages"]["duels"]
    assert before["direct"] is True and before["skipped"] is False, "four advancers go straight into a bracket"
    run = call(client, "/api/knockouts/start")
    assert run["knockouts"]["qualified"] and not run["knockouts"]["rounds"]
    after = client.get("/api/journey").get_json()
    assert after["stages"]["duels"]["skipped"] is True and after["stages"]["duels"]["done"] is True
    assert after["progress"]["game"]["stage_xp"]["knockouts"] == 0, "no elimination round was played"
    team = client.session.draw.team_of(ids[0])
    assert team["id"] == group["id"] and isinstance(team["letter"], str), "a team carries its group id for one colour everywhere"


def test_finals_bonus_is_reported_as_its_own_stage():
    played = game.stats([{"kind": "fduel", "ms": 900, "undone": 0, "extra": {"final": "f1", "round": "final", "seed": 1}}])
    assert played["stage_xp"]["finals"] == game.STAGE_XP["champion"]
    assert game.stats([])["stage_xp"]["finals"] == 0


def test_tag_listing_carries_the_names(client):
    listed = {t["key"]: t for t in client.get("/api/tags?all=1").get_json()["tags"]}
    assert all("catchy" in t for t in listed.values())
    assert all(isinstance(t["catchy"], list) and len(t["catchy"]) <= 2 for t in listed.values())
