"""Installed builds need writable storage and OS integration without touching real saves."""
from pathlib import Path
from types import SimpleNamespace

from matcher import platforms


def test_existing_checkout_keeps_its_saves(tmp_path):
    (tmp_path / ".git").mkdir()
    assert platforms.storage_paths(tmp_path, env={}, frozen=False) == (tmp_path / "data", tmp_path / "models")


def test_installer_ignores_its_read_only_bundle(tmp_path):
    (tmp_path / ".git").mkdir()
    data, models = platforms.storage_paths(tmp_path, env={"LOCALAPPDATA": "C:/Users/Zoë/AppData/Local"},
                                          platform="win32", frozen=True)
    assert str(data).replace("\\", "/") == "C:/Users/Zoë/AppData/Local/MatchER/data"
    assert str(models).replace("\\", "/") == "C:/Users/Zoë/AppData/Local/MatchER/models"
    assert tmp_path not in data.parents


def test_xdg_and_explicit_homes(tmp_path):
    env = {"XDG_DATA_HOME": str(tmp_path / "xdg"), "XDG_CACHE_HOME": str(tmp_path / "cache")}
    assert platforms.storage_paths(tmp_path / "installed", env=env, platform="linux", frozen=True) == (
        tmp_path / "xdg" / "matcher", tmp_path / "cache" / "matcher" / "models")
    env.update(MATCHER_DATA=str(tmp_path / "scratch"), MATCHER_MODELS=str(tmp_path / "weights"))
    assert platforms.storage_paths(tmp_path, env=env, platform="win32", frozen=True) == (tmp_path / "scratch", tmp_path / "weights")


def test_frozen_system_programs_use_system_libraries(monkeypatch):
    monkeypatch.setattr(platforms.sys, "frozen", True, raising=False)
    monkeypatch.setattr(platforms.sys, "platform", "linux")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/app/_internal")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/system/libraries")
    assert platforms.desktop_env()["LD_LIBRARY_PATH"] == "/system/libraries"
    monkeypatch.delenv("LD_LIBRARY_PATH_ORIG")
    assert "LD_LIBRARY_PATH" not in platforms.desktop_env()


def test_open_export_on_windows_and_linux(monkeypatch, tmp_path):
    opened = []
    monkeypatch.setattr(platforms.sys, "platform", "win32")
    monkeypatch.setattr(platforms.os, "startfile", lambda p: opened.append(p), raising=False)
    platforms.open_directory(tmp_path / "photo export & notes")
    assert opened == [str(tmp_path / "photo export & notes")]
    monkeypatch.setattr(platforms.sys, "platform", "linux")
    monkeypatch.setattr(platforms.subprocess, "Popen", lambda args, **kwargs: opened.append(args))
    platforms.open_directory(tmp_path / "photo export & notes")
    assert opened[-1] == ["xdg-open", str(tmp_path / "photo export & notes")]


def test_windows_folder_dialog_keeps_unicode_and_paths_out_of_code(monkeypatch):
    from matcher import server
    calls = []
    monkeypatch.setattr(server.sys, "platform", "win32")
    monkeypatch.setattr(server.subprocess, "CREATE_NO_WINDOW", 0, raising=False)
    def run(args, **kw):
        calls.append((args, kw))
        return SimpleNamespace(returncode=0, stdout="C:\\Photos\\Zoë & friends")
    monkeypatch.setattr(server.subprocess, "run", run)
    assert server.native_pick("C:\\a';bad") == "C:\\Photos\\Zoë & friends"
    assert calls[0][1]["env"]["MATCHER_PICK_START"] == "C:\\a';bad"
    assert "C:\\a';bad" not in " ".join(calls[0][0])
    assert server.suggestions()[0]["label"] == "Home"
