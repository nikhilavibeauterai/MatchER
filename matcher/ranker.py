"""The tournament brain: settle *which* shots belong in your top K with as few duels as possible.

Model. Each shot i has a latent appeal  θ_i = x_i·w + b_i  where x_i are its features (hand-made
cues + scene embedding), w is your taste (learned, starting from a hand-set prior) and b_i is what
is special about that one shot. A duel is a Bradley-Terry observation P(i beats j) = σ(θ_i − θ_j).
"Both great" / "both meh" / "toss" compare a shot against a learned bar t ("profile-worthy").
MAP fit by Newton's method, uncertainty by the Laplace approximation; because w is shared, every
duel also moves the estimates of shots you have never seen.

Selection. Monte Carlo over the posterior gives P(in top K) for every shot, honouring a per-scene
cap so the shortlist stays varied. The next duel is the pair whose outcome is most likely to move
shots that sit on the cutoff. No elimination: a shot that loses once is still in the running.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

SB = 1.0     # prior sd of a shot's individual deviation b_i
ST = 1.0     # prior sd of the bar around its starting point
W_DUEL, W_BAR, W_TOSS, W_FRAME = 1.0, 0.7, 0.5, 0.5
BIG_NB = 1500  # past this many shots with calls, Newton steps go iterative and the covariance approximate


def _sigmoid(u):
    return 0.5 * (1.0 + np.tanh(0.5 * u))


@dataclass
class Obs:
    kind: str       # duel | above | below | pair
    i: int          # winner (duel) or subject; unused for pair
    j: int = -1     # loser (duel)
    w: float = 1.0  # weight
    vec: np.ndarray | None = None  # pair: winner's features minus loser's (two frames of one stack: only
                                   # the taste weights can tell them apart, so no shot effects)


@dataclass
class Posterior:
    mu: np.ndarray
    var: np.ndarray
    bar: float
    w: np.ndarray
    p_in: np.ndarray = field(default_factory=lambda: np.zeros(0))
    n_obs: np.ndarray = field(default_factory=lambda: np.zeros(0))


class Ranker:
    def __init__(self, X: np.ndarray, w0: np.ndarray, sd: np.ndarray, scenes: np.ndarray,
                 k: int = 40, cap: int = 3, seed: int = 0, active: np.ndarray | None = None):
        self.X = np.asarray(X, np.float64)
        self.N, self.D = self.X.shape
        self.w0, self.prec_w = np.asarray(w0, np.float64), 1.0 / np.asarray(sd, np.float64) ** 2
        self.scenes = np.asarray(scenes, np.int64)
        self.active = np.ones(self.N, bool) if active is None else np.asarray(active, bool)
        self.n_active = int(self.active.sum())
        self.k, self.cap = int(k), int(cap)
        self.rng = np.random.default_rng(seed)
        prior = (self.X @ self.w0)[self.active]
        self.t0 = float(np.sort(prior)[::-1][min(self.k, len(prior)) - 1]) if len(prior) else 0.0
        self._warm: dict[int, float] = {}
        self._warm_w = self.w0.copy()
        self._warm_t = self.t0
        self.post: Posterior | None = None
        self.E0: float | None = None

    # ------------------------------------------------------------------ fit
    def fit(self, obs: list[Obs], iters: int = 30) -> Posterior:
        N, D = self.N, self.D
        items = sorted({o.i for o in obs if o.kind != "pair"} | {o.j for o in obs if o.kind == "duel"})
        loc = {it: k for k, it in enumerate(items)}
        nb, P = len(items), D + len(items) + 1
        M = len(obs)
        Aw = np.zeros((M, D))
        pos = np.full(M, -1)
        neg = np.full(M, -1)
        at = np.zeros(M)
        c = np.zeros(M)
        for m, o in enumerate(obs):
            c[m] = o.w
            if o.kind == "duel":
                Aw[m] = self.X[o.i] - self.X[o.j]
                pos[m], neg[m] = loc[o.i], loc[o.j]
            elif o.kind == "above":
                Aw[m] = self.X[o.i]
                pos[m], at[m] = loc[o.i], -1.0
            elif o.kind == "pair":
                Aw[m] = o.vec
            else:  # below
                Aw[m] = -self.X[o.i]
                neg[m], at[m] = loc[o.i], 1.0
        hp, hn = pos >= 0, neg >= 0

        def margins(w, b, t):
            u = Aw @ w + at * t
            u[hp] += b[pos[hp]]
            u[hn] -= b[neg[hn]]
            return u

        def loss(w, b, t):
            u = margins(w, b, t)
            return (float(c @ np.logaddexp(0.0, -u)) + 0.5 * float(((w - self.w0) ** 2 * self.prec_w).sum())
                    + 0.5 * float(b @ b) / SB**2 + 0.5 * (t - self.t0) ** 2 / ST**2)

        w = self._warm_w.copy()
        b = np.array([self._warm.get(it, 0.0) for it in items])
        t = self._warm_t
        for _ in range(iters):
            u = margins(w, b, t)
            s = _sigmoid(u)
            g = -c * (1.0 - s)           # dL/du
            r = c * s * (1.0 - s)        # d2L/du2
            grad_w = Aw.T @ g + (w - self.w0) * self.prec_w
            grad_b = b / SB**2
            np.add.at(grad_b, pos[hp], g[hp])
            np.add.at(grad_b, neg[hn], -g[hn])
            grad_t = float(at @ g) + (t - self.t0) / ST**2
            grad = np.concatenate([grad_w, grad_b, [grad_t]])
            if nb > BIG_NB:  # the dense solve is cubic in the shots you've called; this one is linear per step
                step = self._cg_step(Aw, pos, neg, at, r, hp, hn, nb, -grad)
            else:
                H = self._hessian(Aw, pos, neg, at, r, hp, hn, nb) + np.diag(self._prior_precisions(nb))
                step = np.linalg.solve(H, -grad)
            dec = -float(grad @ step)
            if dec < 1e-10:
                break
            f0, a = loss(w, b, t), 1.0
            while a > 1e-4:
                w1, b1, t1 = w + a * step[:D], b + a * step[D:D + nb], t + a * step[-1]
                if loss(w1, b1, t1) <= f0 - 0.25 * a * dec:
                    break
                a *= 0.5
            w, b, t = w1, b1, t1
            if a * np.abs(step).max() < 1e-7:
                break
        s = _sigmoid(margins(w, b, t))
        r = c * s * (1 - s)
        if nb > BIG_NB:
            Sww, Swb, Sbb_diag = self._schur_cov(Aw, pos, neg, at, r, hp, hn, nb)
        else:
            H = self._hessian(Aw, pos, neg, at, r, hp, hn, nb) + np.diag(self._prior_precisions(nb))
            cov = np.linalg.inv(H)
            Sww, Swb, Sbb_diag = cov[:D, :D], cov[:D, D:D + nb], np.diag(cov[D:D + nb, D:D + nb])
        mu = self.X @ w
        var = np.einsum("nd,de,ne->n", self.X, Sww, self.X) + SB**2
        if nb:
            idx = np.array(items)
            Xi = self.X[idx]
            mu[idx] += b
            var[idx] = np.einsum("nd,de,ne->n", Xi, Sww, Xi) + 2 * np.einsum("nd,dn->n", Xi, Swb) + Sbb_diag
        var = np.maximum(var, 1e-6)
        self._warm = dict(zip(items, b))
        self._warm_w, self._warm_t = w, t
        n_obs = np.zeros(N)
        for o in obs:
            if o.kind == "pair":
                continue
            n_obs[o.i] += 1
            if o.kind == "duel":
                n_obs[o.j] += 1
        self.post = Posterior(mu, var, float(t), w, n_obs=n_obs)
        self.post.p_in = self.membership(mu, var)
        e = self.expected_errors()
        if self.E0 is None or not obs:
            self.E0 = max(e, 1e-6)
        return self.post

    @staticmethod
    def _hessian(Aw, pos, neg, at, r, hp, hn, nb):
        D = Aw.shape[1]
        P = D + nb + 1
        H = np.zeros((P, P))
        H[:D, :D] = (Aw * r[:, None]).T @ Aw
        rA = Aw * r[:, None]
        Hbw = np.zeros((nb, D))
        np.add.at(Hbw, pos[hp], rA[hp])
        np.add.at(Hbw, neg[hn], -rA[hn])
        H[D:D + nb, :D] = Hbw
        H[:D, D:D + nb] = Hbw.T
        Hbb = np.zeros((nb, nb))
        np.add.at(Hbb, (pos[hp], pos[hp]), r[hp])
        np.add.at(Hbb, (neg[hn], neg[hn]), r[hn])
        both = hp & hn
        np.add.at(Hbb, (pos[both], neg[both]), -r[both])
        np.add.at(Hbb, (neg[both], pos[both]), -r[both])
        H[D:D + nb, D:D + nb] = Hbb
        rt = r * at
        H[:D, -1] = H[-1, :D] = Aw.T @ rt
        Hbt = np.zeros(nb)
        np.add.at(Hbt, pos[hp], rt[hp])
        np.add.at(Hbt, neg[hn], -rt[hn])
        H[D:D + nb, -1] = H[-1, D:D + nb] = Hbt
        H[-1, -1] = float(r @ (at * at))
        return H

    def _cg_step(self, Aw, pos, neg, at, r, hp, hn, nb, rhs, tol=1e-9, maxit=400):
        """Solve H·x = rhs by conjugate gradients with Hessian-vector products (H is never formed)."""
        D = self.D
        prec = self._prior_precisions(nb)

        def hv(v):
            vw, vb, vt = v[:D], v[D:D + nb], v[-1]
            jv = Aw @ vw + at * vt
            jv[hp] += vb[pos[hp]]
            jv[hn] -= vb[neg[hn]]
            z = r * jv
            ob = np.zeros(nb)
            np.add.at(ob, pos[hp], z[hp])
            np.add.at(ob, neg[hn], -z[hn])
            return np.concatenate([Aw.T @ z, ob, [at @ z]]) + prec * v
        diag_b = np.zeros(nb)
        np.add.at(diag_b, pos[hp], r[hp])
        np.add.at(diag_b, neg[hn], r[hn])
        m_inv = 1.0 / (np.concatenate([(Aw**2 * r[:, None]).sum(0), diag_b, [r @ (at * at)]]) + prec)
        x = np.zeros_like(rhs)
        res = rhs.copy()
        zv = m_inv * res
        pv = zv.copy()
        rz = res @ zv
        stop = tol * (rhs @ rhs)
        for _ in range(maxit):
            hp_v = hv(pv)
            alpha = rz / (pv @ hp_v)
            x += alpha * pv
            res -= alpha * hp_v
            if res @ res < stop:
                break
            zv = m_inv * res
            rz_new = res @ zv
            pv = zv + (rz_new / rz) * pv
            rz = rz_new
        return x

    def _schur_cov(self, Aw, pos, neg, at, r, hp, hn, nb):
        """Laplace covariance pieces for many shots: exact for the taste weights given a diagonal shot block
        (shot-to-shot coupling through shared duels is dropped), so it costs D^3 + calls x D, not shots^3."""
        D = self.D
        J = np.hstack([Aw, at[:, None]])                         # taste weights and the bar
        Hww = (J * r[:, None]).T @ J + np.diag(np.concatenate([self.prec_w, [1.0 / ST**2]]))
        rJ = J * r[:, None]
        Hwb = np.zeros((nb, D + 1))
        np.add.at(Hwb, pos[hp], rJ[hp])
        np.add.at(Hwb, neg[hn], -rJ[hn])
        dbb = np.full(nb, 1.0 / SB**2)
        np.add.at(dbb, pos[hp], r[hp])
        np.add.at(dbb, neg[hn], r[hn])
        G = Hwb / dbb[:, None]                                   # (nb, D+1) = Hbb^-1 Hbw
        Sww_full = np.linalg.inv(Hww - Hwb.T @ G)
        Swb_full = -(Sww_full @ G.T)                             # (D+1, nb)
        Sbb_diag = 1.0 / dbb + np.einsum("nd,de,ne->n", G, Sww_full, G)
        return Sww_full[:D, :D], Swb_full[:D], Sbb_diag

    def _prior_precisions(self, nb):
        return np.concatenate([self.prec_w, np.full(nb, 1.0 / SB**2), [1.0 / ST**2]])

    # ------------------------------------------------------------------ top-K
    def select(self, scores: np.ndarray, active: np.ndarray | None = None) -> list[int]:
        """Greedy top K by score with at most `cap` shots per scene."""
        per: dict[int, int] = {}
        out = []
        active = self.active if active is None else (active & self.active)
        for i in np.argsort(-scores):
            if not active[i]:
                continue
            sc = int(self.scenes[i])
            if per.get(sc, 0) >= self.cap:
                continue
            per[sc] = per.get(sc, 0) + 1
            out.append(int(i))
            if len(out) == self.k:
                break
        return out

    def membership(self, mu, var, samples: int = 256) -> np.ndarray:
        if self.n_active == 0:
            return np.zeros(self.N)
        if self.n_active <= self.k and self.cap >= self.k:
            return self.active.astype(float)
        Z = mu + np.sqrt(var) * self.rng.standard_normal((samples, self.N))
        Z[:, ~self.active] = -np.inf
        order = np.argsort(-Z, axis=1)[:, : min(self.N, self.k * 4)]
        counts = np.zeros(self.N)
        scenes = self.scenes.tolist()
        k, cap = self.k, self.cap
        want = min(k, self.n_active)
        for r, row in enumerate(order.tolist()):
            picks = self._capped(row, scenes, k, cap)
            if len(picks) < want and len(row) < self.N:  # caps ate the shortlist: walk the full draw
                picks = self._capped(np.argsort(-Z[r]).tolist(), scenes, k, cap, self.active)
            counts[picks] += 1
        return counts / samples

    @staticmethod
    def _capped(row, scenes, k, cap, active=None) -> list[int]:
        per: dict[int, int] = {}
        picks = []
        for i in row:
            if active is not None and not active[i]:
                continue
            sc = scenes[i]
            cnt = per.get(sc, 0)
            if cnt >= cap:
                continue
            per[sc] = cnt + 1
            picks.append(i)
            if len(picks) == k:
                break
        return picks

    def confidence(self, samples: int = 128) -> float:
        """Expected share of the current shortlist that a fully-informed you would also pick."""
        if self.post is None or self.n_active <= self.k:
            return 1.0
        mine = set(self.select(self.post.mu))
        Z = self.post.mu + np.sqrt(self.post.var) * self.rng.standard_normal((samples, self.N))
        return float(np.mean([len(mine & set(self.select(z))) / self.k for z in Z]))

    def quality(self, samples: int = 96) -> float:
        """Expected appeal of the current shortlist relative to the best possible one (1.0 = ideal),
        with 0 meaning no better than a random pick. Near-misses count as nearly as good."""
        if self.post is None or self.n_active <= self.k:
            return 1.0
        mine = np.array(self.select(self.post.mu))
        act = np.flatnonzero(self.active)
        Z = self.post.mu + np.sqrt(self.post.var) * self.rng.standard_normal((samples, self.N))
        num = den = 0.0
        for z in Z:
            base = z[act].mean()
            best = z[self.select(z)].mean()
            num += z[mine].mean() - base
            den += best - base
        return float(np.clip(num / den, 0.0, 1.0)) if den > 0 else 1.0

    def expected_errors(self) -> float:
        p = self.post.p_in
        return float(np.minimum(p, 1 - p).sum())

    def settled(self) -> float:
        if self.post is None or not self.E0:
            return 0.0
        return float(np.clip(1.0 - self.expected_errors() / self.E0, 0.0, 1.0))

    def done(self) -> bool:
        p = self.post.p_in
        unvetted = (p >= 0.05) & (self.post.n_obs == 0) & self.active
        return self.expected_errors() <= max(1.5, 0.04 * self.k) and not unvetted.any()

    # ------------------------------------------------------------------ next duel
    def next_pair(self, recent: list[int] = (), compared: set[tuple[int, int]] = frozenset(),
                  explore: float = 0.5, strategy: str = "value",
                  exclude: set[int] = frozenset()) -> tuple[int, int] | None:
        """`recent` shots are merely discouraged (variety); `exclude`d ones (already on a card that's on its
        way to the screen) are never picked unless nothing else is left."""
        post = self.post
        if post is None or self.N < 2:
            return None
        mu, var, p = post.mu, post.var, post.p_in
        if strategy in ("lucb", "thompson"):
            return self._boundary_pair(strategy, recent, compared)
        allowed = self.active.copy()
        if exclude:
            allowed[[i for i in exclude if 0 <= i < self.N]] = False
            if allowed.sum() < 2:
                allowed = self.active.copy()
        sd = np.sqrt(var)
        u = p * (1 - p)
        unseen = (post.n_obs == 0) & allowed
        cand = set([i for i in np.argsort(-(u * sd)).tolist() if allowed[i]][:28])
        fresh = None
        if unseen.any():
            up = np.where(unseen, p, -1)
            cand |= set(i for i in np.argsort(-up)[:8].tolist() if up[i] > 0.01)
            if self.rng.random() < explore:
                # Forced exploration: this duel shows a photo you haven't seen yet (likelier ones first),
                # so the model never gets to decide on its own that a shot isn't worth a look.
                pool = np.flatnonzero(unseen)
                wts = np.sqrt(p[pool] + 0.02)
                fresh = int(self.rng.choice(pool, p=wts / wts.sum()))
                cand.add(fresh)
        cand = np.array(sorted(cand))
        if len(cand) < 2:
            cand = np.array([i for i in np.argsort(-mu) if allowed[i]][:2])
            if len(cand) < 2:
                return None
        a, b = np.triu_indices(len(cand), 1)
        i, j = cand[a], cand[b]
        q = _sigmoid((mu[i] - mu[j]) / np.sqrt(1 + math.pi / 8 * (var[i] + var[j])))
        value = np.sqrt(q * (1 - q)) * (u[i] * sd[i] + u[j] * sd[j] + 0.02 * (unseen[i] + unseen[j]) + 1e-4)
        rec = list(recent)[-8:]
        hot = set(rec[-3:])
        warm = set(rec)
        seen: dict[int, int] = {}
        for x in list(recent)[-40:]:   # the last 20 duels: a photo in many of them sits a few out
            seen[x] = seen.get(x, 0) + 1
        pen = np.ones(len(i))
        for k in range(len(i)):
            ii, jj = int(i[k]), int(j[k])
            if ii in hot or jj in hot:
                pen[k] *= 0.15
            elif ii in warm or jj in warm:
                pen[k] *= 0.6
            pen[k] /= 1.0 + 0.6 * (max(0, seen.get(ii, 0) - 2) + max(0, seen.get(jj, 0) - 2))
            if (min(ii, jj), max(ii, jj)) in compared:
                pen[k] *= 0.02
        score = value * pen * self.rng.uniform(0.85, 1.15, len(i))
        if fresh is not None:
            score = np.where((i == fresh) | (j == fresh), score, -1.0)
        k = int(np.argmax(score))
        pair = (int(i[k]), int(j[k]))
        return pair if self.rng.random() < 0.5 else pair[::-1]

    def _boundary_pair(self, strategy, recent, compared):
        """LUCB: weakest-looking insider vs strongest-looking outsider. Thompson: same, on a posterior draw."""
        mu, sd = self.post.mu, np.sqrt(self.post.var)
        hot = set(list(recent)[-3:])
        ok = np.array([i not in hot for i in range(self.N)]) & self.active
        if strategy == "thompson":
            score = mu + sd * self.rng.standard_normal(self.N)
        else:
            score = mu
        inside = np.zeros(self.N, bool)
        inside[self.select(score)] = True
        lo, hi = mu - sd, mu + sd
        a_pool = np.flatnonzero(inside & ok)
        b_pool = np.flatnonzero(~inside & ok)
        if not len(a_pool) or not len(b_pool):
            return None
        a = int(a_pool[np.argmin(lo[a_pool])])
        order = b_pool[np.argsort(-hi[b_pool])]
        b = next((int(x) for x in order if (min(a, x), max(a, x)) not in compared), int(order[0]))
        return (a, b) if self.rng.random() < 0.5 else (b, a)
