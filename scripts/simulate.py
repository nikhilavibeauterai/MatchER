"""How many duels does it take to settle the top K? Simulated user, known ground truth.

    .venv/bin/python scripts/simulate.py [--n 600] [--k 40] [--seeds 3] [--strategies value,lucb,random]

The simulated user prefers shots by a hidden appeal that only partly agrees with the hand-set
prior (taste mismatch), answers noisily, and uses "both meh" / "both great" like a person would.
Metrics per checkpoint:
  recall   share of the true (scene-capped) top K that the current shortlist contains
  top2K    share of the shortlist that is at least in the true top 2K (i.e. no real duds)
  utility  how close the shortlist's true appeal is to the ideal shortlist's (100% = ideal)
  conf     the app's own estimate of recall (should track the real one)
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from matcher.ranker import W_BAR, Obs, Ranker  # noqa: E402


def world(n, d_hand, d_emb, seed, prior_quality=0.6):
    rng = np.random.default_rng(seed)
    X = np.hstack([rng.normal(0, 0.5, (n, d_hand)), rng.normal(0, 1, (n, d_emb))])
    w0 = np.concatenate([rng.normal(0, 0.5, d_hand), np.zeros(d_emb)])
    sd = np.concatenate([np.full(d_hand, 0.4), np.full(d_emb, 0.12)])
    w_true = np.concatenate([w0[:d_hand] * prior_quality + rng.normal(0, 0.3, d_hand), rng.normal(0, 0.15, d_emb)])
    theta = X @ w_true + rng.normal(0, 0.8, n)
    scenes = np.repeat(np.arange(n), rng.integers(1, 6, n))[:n]
    return X, w0, sd, theta, scenes


def run(strategy, X, w0, sd, theta, scenes, k, cap, checkpoints, seed, noise=1.0, buttons=True, explore=None):
    rng = np.random.default_rng(seed + 1000)
    if strategy == "no-taste":
        sd = np.full_like(sd, 1e-3)
    r = Ranker(X, w0, sd, scenes, k=k, cap=cap, seed=seed)
    truth = r.select(theta)
    tset, t2 = set(truth), set(r.select(theta) if False else np.argsort(-theta)[: 2 * k].tolist())
    bar = theta[truth[-1]]
    base, ideal = theta.mean(), theta[truth].mean()
    obs, recent, compared = [], [], set()
    r.fit(obs)
    out, n_items = {}, len(theta)
    for n in range(1, max(checkpoints) + 1):
        if strategy == "random":
            i, j = (int(v) for v in rng.choice(n_items, 2, replace=False))
        else:
            kw = {} if explore is None else {"explore": explore}
            i, j = r.next_pair(recent, compared, strategy="value" if strategy in ("no-taste",) or strategy.startswith("value") else strategy, **kw)
        if buttons and theta[i] < bar - 0.7 and theta[j] < bar - 0.7 and rng.random() < 0.8:
            obs += [Obs("below", i, w=W_BAR), Obs("below", j, w=W_BAR)]
        elif buttons and theta[i] > bar + 0.3 and theta[j] > bar + 0.3 and rng.random() < 0.5:
            obs += [Obs("above", i, w=W_BAR), Obs("above", j, w=W_BAR)]
        else:
            p = 1 / (1 + np.exp(-(theta[i] - theta[j]) / noise))
            win, lose = (i, j) if rng.random() < p else (j, i)
            obs.append(Obs("duel", win, lose))
        recent += [i, j]
        compared.add((min(i, j), max(i, j)))
        if strategy != "random" or n in checkpoints:
            r.fit(obs)
        if n in checkpoints:
            sel = r.select(r.post.mu)
            out[n] = dict(recall=len(set(sel) & tset) / k, top2k=len(set(sel) & t2) / k,
                          utility=(theta[sel].mean() - base) / (ideal - base), conf=r.confidence(),
                          settled=r.settled(), seen=float((r.post.n_obs > 0).mean()), quality=r.quality())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=600)
    ap.add_argument("--k", type=int, default=40)
    ap.add_argument("--cap", type=int, default=3)
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--noise", type=float, default=1.0, help="user noise scale (higher = less consistent)")
    ap.add_argument("--prior", type=float, default=0.6, help="how much the true taste follows the hand prior")
    ap.add_argument("--no-buttons", action="store_true", help="user never presses both-meh / both-great")
    ap.add_argument("--strategies", default="value,lucb,thompson,no-taste,random")
    ap.add_argument("--checkpoints", default="50,100,200,300,450,600")
    ap.add_argument("--explore", type=float, default=None, help="override the exploration rate")
    ap.add_argument("--metrics", default="recall,top2k,utility,conf")
    a = ap.parse_args()
    cps = [int(c) for c in a.checkpoints.split(",")]
    print(f"n={a.n} k={a.k} cap={a.cap} noise={a.noise} prior={a.prior} buttons={not a.no_buttons} seeds={a.seeds}")
    for strat in a.strategies.split(","):
        t0 = time.time()
        rows = [run(strat, *world(a.n, 24, 36, s, a.prior), a.k, a.cap, cps, s, a.noise, not a.no_buttons, a.explore)
                for s in range(a.seeds)]
        for metric in a.metrics.split(","):
            vals = "  ".join(f"{c:>4}:{np.mean([r[c][metric] for r in rows]) * 100:5.1f}%" for c in cps)
            label = strat if metric == "recall" else ""
            print(f"{label:<10} {metric:<8} {vals}")
        print(f"{'':<10} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
