"""The tournament model: correct math, sensible pairs, honest progress."""
import numpy as np
import pytest

from matcher.ranker import SB, ST, W_BAR, Obs, Ranker


def toy(n=60, d=6, seed=0, scenes=None):
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 1, (n, d))
    w0 = np.zeros(d)
    sd = np.full(d, 0.5)
    sc = np.arange(n) if scenes is None else scenes
    return X, w0, sd, sc


def neg_log_post(r: Ranker, obs, w, b_map, t):
    """Independent re-implementation of the objective, for checking the fit."""
    theta = r.X @ w
    for i, v in b_map.items():
        theta[i] += v
    total = 0.0
    for o in obs:
        if o.kind == "duel":
            u = theta[o.i] - theta[o.j]
        elif o.kind == "above":
            u = theta[o.i] - t
        else:
            u = t - theta[o.i]
        total += o.w * np.logaddexp(0, -u)
    total += 0.5 * np.sum((w - r.w0) ** 2 * r.prec_w)
    total += 0.5 * sum(v * v for v in b_map.values()) / SB**2
    total += 0.5 * (t - r.t0) ** 2 / ST**2
    return total


def test_no_observations_returns_prior():
    X, w0, sd, sc = toy()
    w0 = np.linspace(-1, 1, X.shape[1])
    r = Ranker(X, w0, sd, sc, k=10)
    post = r.fit([])
    np.testing.assert_allclose(post.mu, X @ w0, atol=1e-8)
    expected_var = (X**2) @ (sd**2) + SB**2
    np.testing.assert_allclose(post.var, expected_var, rtol=1e-6)


def test_fit_is_a_stationary_point_of_the_posterior():
    X, w0, sd, sc = toy(n=30, d=4, seed=3)
    r = Ranker(X, w0, sd, sc, k=8)
    rng = np.random.default_rng(1)
    obs = [Obs("duel", int(a), int(b)) for a, b in rng.integers(0, 30, (40, 2)) if a != b]
    obs += [Obs("above", 3, w=W_BAR), Obs("below", 7, w=W_BAR), Obs("below", 11, w=0.5)]
    r.fit(obs)
    w, t = r._warm_w.copy(), r._warm_t
    b_map = dict(r._warm)
    base = neg_log_post(r, obs, w, b_map, t)
    eps = 1e-4
    for k in range(len(w)):  # gradient ~ 0 in every direction
        for sgn in (1, -1):
            w2 = w.copy()
            w2[k] += sgn * eps
            assert neg_log_post(r, obs, w2, b_map, t) >= base - 1e-9
    for key in list(b_map)[:6]:
        for sgn in (1, -1):
            b2 = dict(b_map)
            b2[key] += sgn * eps
            assert neg_log_post(r, obs, w, b2, t) >= base - 1e-9
    for sgn in (1, -1):
        assert neg_log_post(r, obs, w, b_map, t + sgn * eps) >= base - 1e-9


def test_consistent_duels_recover_the_order():
    n = 25
    X = np.zeros((n, 1))
    r = Ranker(X, np.zeros(1), np.full(1, 0.01), np.arange(n), k=5)
    truth = np.linspace(3, -3, n)  # item 0 best
    rng = np.random.default_rng(0)
    obs = []
    for _ in range(800):
        i, j = rng.choice(n, 2, replace=False)
        p = 1 / (1 + np.exp(-(truth[i] - truth[j])))
        obs.append(Obs("duel", int(i), int(j)) if rng.random() < p else Obs("duel", int(j), int(i)))
    post = r.fit(obs)
    rho = np.corrcoef(np.argsort(np.argsort(-post.mu)), np.arange(n))[0, 1]
    assert rho > 0.95
    assert set(r.select(post.mu)) & {0, 1, 2, 3, 4} >= {0, 1, 2}


def test_taste_generalizes_to_unseen_shots():
    """Duels among some shots move the estimates of shots never shown (shared w)."""
    rng = np.random.default_rng(5)
    n = 80
    X = rng.normal(0, 1, (n, 1))
    r = Ranker(X, np.zeros(1), np.full(1, 1.0), np.arange(n), k=10)
    seen = np.arange(40)
    obs = []
    for _ in range(300):
        i, j = rng.choice(seen, 2, replace=False)
        obs.append(Obs("duel", int(i), int(j)) if X[i, 0] > X[j, 0] else Obs("duel", int(j), int(i)))
    post = r.fit(obs)
    unseen = np.arange(40, 80)
    assert np.corrcoef(post.mu[unseen], X[unseen, 0])[0, 1] > 0.99
    assert post.w[0] > 0.5


def test_bar_observations_move_shots_and_the_bar():
    X, w0, sd, sc = toy(n=20, d=2)
    r = Ranker(X, w0, sd, sc, k=5)
    base = r.fit([]).mu.copy()
    post = r.fit([Obs("below", 4, w=W_BAR)] * 3 + [Obs("above", 9, w=W_BAR)] * 3)
    assert post.mu[4] < base[4] and post.mu[9] > base[9]


def test_scene_cap_and_inactive_items_respected():
    n = 30
    scenes = np.repeat(np.arange(10), 3)        # 10 scenes x 3 shots
    X = np.zeros((n, 1))
    active = np.ones(n, bool)
    active[0] = False
    r = Ranker(X, np.zeros(1), np.full(1, 0.01), scenes, k=8, cap=1, active=active)
    scores = -np.arange(n, dtype=float)          # item 0 best, but inactive
    sel = r.select(scores)
    assert 0 not in sel
    assert len({int(scenes[i]) for i in sel}) == len(sel) == 8
    post = r.fit([])
    assert post.p_in[0] == 0
    assert abs(post.p_in.sum() - 8) < 1e-9


def test_next_pair_is_valid_and_avoids_repeats_and_inactive():
    X, w0, sd, sc = toy(n=40)
    active = np.ones(40, bool)
    active[:5] = False
    r = Ranker(X, w0, sd, sc, k=10, active=active)
    r.fit([])
    seen_pairs = set()
    for _ in range(30):
        i, j = r.next_pair([], seen_pairs)
        assert i != j and active[i] and active[j]
        seen_pairs.add((min(i, j), max(i, j)))
    assert len(seen_pairs) >= 25  # mostly fresh pairs


def test_confidence_rises_with_evidence():
    rng = np.random.default_rng(2)
    n = 120
    X = rng.normal(0, 1, (n, 3))
    truth = X @ np.array([1.0, -0.5, 0.3]) + rng.normal(0, 0.5, n)
    r = Ranker(X, np.zeros(3), np.full(3, 0.5), np.arange(n), k=15)
    r.fit([])
    c0 = r.confidence()
    obs, recent, done = [], [], set()
    for _ in range(250):
        i, j = r.next_pair(recent, done)
        obs.append(Obs("duel", i, j) if truth[i] > truth[j] else Obs("duel", j, i))
        recent += [i, j]
        done.add((min(i, j), max(i, j)))
        r.fit(obs)
    assert r.confidence() > c0 + 0.25
    assert len(set(r.select(r.post.mu)) & set(np.argsort(-truth)[:15])) >= 9


@pytest.mark.parametrize("n,k", [(3, 5), (1, 1), (0, 5)])
def test_tiny_libraries(n, k):
    X = np.zeros((n, 2))
    r = Ranker(X, np.zeros(2), np.ones(2), np.arange(n), k=k)
    post = r.fit([])
    assert len(post.mu) == n
    if n < 2:
        assert r.next_pair() is None
