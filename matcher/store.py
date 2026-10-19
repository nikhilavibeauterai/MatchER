"""SQLite storage for one photo library: analysis results, derived state, and every vote."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    rel TEXT UNIQUE NOT NULL,
    size INTEGER, mtime_ns INTEGER, sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'new',         -- new | analyzed | error
    error TEXT,
    width INTEGER, height INTEGER, fmt TEXT,
    taken TEXT, taken_ts REAL, taken_src TEXT,
    make TEXT, model TEXT,
    phash TEXT, luma REAL, luma_lo REAL, luma_hi REAL, sharp REAL, chroma REAL, saturation REAL, hue REAL,
    n_faces INTEGER,
    emb BLOB, crop_emb BLOB, crop_face INTEGER, zs TEXT, recognized_tags TEXT,
    -- derived by library.refresh()
    me_face INTEGER, me_sim REAL, group_id INTEGER, scene_id INTEGER,
    cut TEXT, flags TEXT, prior REAL,
    -- user decisions
    override TEXT,                               -- keep | toss
    rep_pref INTEGER NOT NULL DEFAULT 0,         -- chosen as best frame of its burst
    pick INTEGER NOT NULL DEFAULT 0              -- hand-added to the export
);
CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    idx INTEGER,
    x REAL, y REAL, w REAL, h REAL, score REAL, lm TEXT,
    emb BLOB, sharp REAL, luma REAL,
    blink_l REAL, blink_r REAL, smile REAL, jaw REAL, squint REAL, yaw REAL, pitch REAL, roll REAL,
    person INTEGER,
    label TEXT                                   -- me | other (user override)
);
CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    rep INTEGER NOT NULL,
    members TEXT NOT NULL,
    scene INTEGER,
    frame_checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    is_me INTEGER NOT NULL DEFAULT 0,
    n_photos INTEGER, faces TEXT, excluded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,                          -- duel | great | meh | toss | skip | frame
    a INTEGER, b INTEGER,                        -- photo ids as shown (left, right)
    winner INTEGER,                              -- photo id (duel, frame)
    ms INTEGER,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS frame_seen (members_key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS themes (                -- the Draw: themed groups that play a group stage
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL, emoji TEXT, concept TEXT,
    seed INTEGER,                                -- the photo it started from
    created REAL, sealed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS theme_no (theme_id INTEGER NOT NULL, photo_id INTEGER NOT NULL,
    PRIMARY KEY (theme_id, photo_id));           -- "doesn't belong": not offered to that theme again
CREATE TABLE IF NOT EXISTS tags (                  -- what it recognizes (and what you add): many per photo
    key TEXT PRIMARY KEY, label TEXT NOT NULL, emoji TEXT, family TEXT,   -- family: what | people | look | when
    user INTEGER NOT NULL DEFAULT 0,             -- you made it
    named INTEGER NOT NULL DEFAULT 0,            -- you renamed it: a refresh keeps your name
    hidden INTEGER NOT NULL DEFAULT 0,           -- never a circle on the sea
    pinned INTEGER NOT NULL DEFAULT 0            -- always a circle
);
CREATE TABLE IF NOT EXISTS photo_tags (photo_id INTEGER NOT NULL, tag TEXT NOT NULL, score REAL,
    PRIMARY KEY (photo_id, tag));                -- the automatic ones, rewritten by every refresh
CREATE TABLE IF NOT EXISTS tag_edits (photo_id INTEGER NOT NULL, tag TEXT NOT NULL, val INTEGER NOT NULL,
    PRIMARY KEY (photo_id, tag));                -- yours: 1 adds the tag, 0 takes it away
CREATE TABLE IF NOT EXISTS tag_aliases (source TEXT PRIMARY KEY, target TEXT);
CREATE INDEX IF NOT EXISTS photo_tags_tag ON photo_tags(tag, photo_id);
CREATE INDEX IF NOT EXISTS photos_group ON photos(group_id);
CREATE INDEX IF NOT EXISTS votes_live ON votes(undone, id);
"""


def f16(a: np.ndarray | None) -> bytes | None:
    return None if a is None else np.asarray(a, dtype=np.float16).tobytes()


def f32(a: np.ndarray | None) -> bytes | None:
    return None if a is None else np.asarray(a, dtype=np.float32).tobytes()


def unblob(b: bytes | None, dtype=np.float16) -> np.ndarray | None:
    return None if b is None else np.frombuffer(b, dtype=dtype).astype(np.float32)


class ClosedStoreError(RuntimeError):
    """A request outlived the save it was reading."""


class Store:
    """One SQLite file per library. Thread-safe for the web server's worker threads."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.refresh_lock = threading.RLock()  # library.refresh() vs. readers of its outputs
        self._connection = None
        self._closed = False
        self.vote_revision = 0
        self.vote_rewrite = 0
        self._votes = None
        with self.tx() as c:
            c.executescript(SCHEMA)
            cols = {r[1] for r in c.execute("PRAGMA table_info(votes)")}
            if "extra" not in cols:  # added after the first release of the schema
                c.execute("ALTER TABLE votes ADD COLUMN extra TEXT")
            photo_cols = {r[1] for r in c.execute("PRAGMA table_info(photos)")}
            if "auto_look" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN auto_look TEXT")
            if "auto_version" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN auto_version INTEGER NOT NULL DEFAULT 0")
            if "subject" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN subject TEXT")  # auto-crop box, set by refresh()
            if "salient" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN salient TEXT")  # the salient region's frame (analysis), for photos without a face
            if "stack_key" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN stack_key TEXT")  # your merges/splits (Groups page)
            if "category" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN category TEXT")  # what it's mostly of (gallery cups)
            if "theme_id" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN theme_id INTEGER")  # its group in the Draw
            if "recognized_tags" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN recognized_tags TEXT")  # discoveries shown during analysis
            if "edits" not in photo_cols:
                c.execute("ALTER TABLE photos ADD COLUMN edits TEXT")  # your touch-up choices from the Leaderboard (enhance, crop, rotate)
            for name in ("saturation", "hue"):
                if name not in photo_cols:
                    c.execute(f"ALTER TABLE photos ADD COLUMN {name} REAL")  # measured during the existing decode
            theme_cols = {r[1] for r in c.execute("PRAGMA table_info(themes)")}
            if "hint" not in theme_cols:
                c.execute("ALTER TABLE themes ADD COLUMN hint TEXT")  # what to look for, in your words
            if "pos" not in theme_cols:
                c.execute("ALTER TABLE themes ADD COLUMN pos REAL")  # where it sits in your order of groups (and its key)

    def conn(self) -> sqlite3.Connection:
        # All access already holds this lock. Sharing its connection keeps short-lived HTTP threads from
        # leaving descriptors behind, and keeps the Filter preview's change counter valid between requests.
        with self.lock:
            if self._closed:
                raise ClosedStoreError("This save is closed.")
            if self._connection is None:
                c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
                c.row_factory = sqlite3.Row
                c.execute("PRAGMA journal_mode=WAL")
                c.execute("PRAGMA synchronous=NORMAL")
                c.execute("PRAGMA foreign_keys=ON")
                c.set_trace_callback(self._trace)
                self._connection = c
            return self._connection

    def _trace(self, sql):
        if re.match(r'\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+["`\[]?votes\b', sql, re.I):
            self.vote_revision += 1
            if not re.match(r'\s*INSERT\b', sql, re.I):
                self.vote_rewrite += 1
            self._votes = None

    def close(self) -> None:
        """Close the library's connection after its work has stopped, before a save is removed."""
        with self.lock:
            self._closed = True
            self._filter_fit_embeddings = None
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def tx(self):
        store = self

        class _Tx:
            def __enter__(self):
                store.lock.acquire()
                try:
                    self.c = store.conn()
                except BaseException:
                    store.lock.release()
                    raise
                return self.c

            def __exit__(self, et, ev, tb):
                try:
                    if et is None:
                        self.c.commit()
                    else:
                        self.c.rollback()
                        # Readers inside the transaction may have cached votes that no longer exist.
                        store._votes = None
                        store.vote_revision += 1
                        store.vote_rewrite += 1
                finally:
                    store.lock.release()

        return _Tx()

    def q(self, sql: str, args: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn().execute(sql, tuple(args)).fetchall()

    def one(self, sql: str, args: Iterable[Any] = ()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    # ---- meta / settings
    def get_meta(self, key: str, default=None):
        r = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return default if r is None else json.loads(r["value"])

    def set_meta(self, key: str, value) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (key, json.dumps(value)))

    # ---- votes
    def add_vote(self, kind: str, a: int | None, b: int | None = None, winner: int | None = None,
                 ms: int | None = None, extra=None) -> int:
        with self.tx() as c:
            cur = c.execute("INSERT INTO votes(ts, kind, a, b, winner, ms, extra) VALUES(?,?,?,?,?,?,?)",
                            (time.time(), kind, a, b, winner, ms, None if extra is None else json.dumps(extra)))
            c.execute("DELETE FROM meta WHERE key IN ('group_redo','vote_redo')")
            return cur.lastrowid

    def votes(self) -> list[sqlite3.Row]:
        with self.lock:
            if self._votes is None:
                self._votes = tuple(self.q("SELECT * FROM votes WHERE undone=0 ORDER BY id"))
            return self._votes
