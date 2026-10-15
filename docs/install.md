# Install MatchER

MatchER is an early preview for **Windows 10/11 x64** and **Linux x64**. Desktop packages contain Python,
Chromium and the photo-processing libraries. No account, subscription or GPU is required. Allow roughly
2 GB for the installed app and models, plus space for your library's previews. First analysis needs an
internet connection to fetch about 256 MB of checksum-verified models; later sessions can run offline.

## Windows

1. Open [Releases](https://github.com/nikhilavibeauterai/MatchER/releases).
2. Download `MatchER-<version>-win-x64.exe` from the release's **Assets**.
3. Run the installer. It installs for your account without administrator access and adds a Start menu entry.
4. Open **MatchER**, then choose **Try it with sample photos** or **Choose folder…**.

The first preview installers are unsigned. Windows may show an unknown-publisher/SmartScreen prompt.
Only continue for a download you trust from the repository's Releases page. A signed installer is still
on the release roadmap.

## Linux

On Ubuntu 22.04 or newer, Debian 12 or newer, and similar x64 desktop distributions:

- **Debian / Ubuntu:** download the `.deb`, open it in your software installer, then launch MatchER from
  the applications menu. From a terminal, `sudo apt install ./MatchER-<version>-linux-x64.deb` installs its
  system dependencies too.
- **Other distributions / portable use:** download the `.AppImage`, enable **Allow executing file as program**
  in its file properties, and double-click it. Or run `chmod +x MatchER-*.AppImage` once, then open it.

If AppImage reports missing FUSE, use the `.deb` where available or run the AppImage with
`--appimage-extract-and-run`. Chromium also needs a normal desktop session with its sandbox available;
run MatchER as your own user. ARM and macOS packages are not included in this preview.

## First five minutes

1. **Try the sample.** The bundled public-domain paintings, NASA photos and meme faces let you explore
   without choosing personal photos. Models download on the first scan, with progress shown in the app.
2. **Choose a folder.** Gallery works for trips, pets, landscapes and friends. Profile finds photos of you.
   Analysis reads subfolders, stacks similar takes and gives everything tags.
3. **Play Filter.** Arrow keys keep, toss, love or hate; Space skips; Z undoes. Enter continues when you're ready.
4. **Crown the best takes**, build groups, and play your favourites through to the final.
5. **Save my best** exports your picks. Original photo files stay untouched; progress saves after each choice.

You can close MatchER and return later. Closing the desktop window also stops its local server and workers.
The [full guide](guide.md) covers the journey, keys, settings and exports.

## Where your saves live

| Install | Saves, previews and exports | Downloaded models |
|---|---|---|
| Windows desktop | `%LOCALAPPDATA%\MatchER\data` | `%LOCALAPPDATA%\MatchER\models` |
| Linux desktop | `~/.local/share/matcher` | `~/.cache/matcher/models` |
| Git checkout | `data/` inside the checkout | `models/` inside the checkout |

Linux respects `XDG_DATA_HOME` and `XDG_CACHE_HOME`. `MATCHER_DATA` and `MATCHER_MODELS` override these locations.
A source ZIP without `.git` uses the desktop storage locations. Desktop **MatchER → Your saves folder** opens
the right place. Back up the saves folder to preserve decisions and notes. Uninstalling the desktop app keeps
your saves; deleting a save inside MatchER never deletes the original folder.

To move a checkout's existing saves into the desktop app, close both instances, copy `data/` into the desktop
saves folder and `models/` into its model cache. Keep the source photos at their existing paths. Alternatively,
set `MATCHER_DATA` and `MATCHER_MODELS` to your existing directories before launching the desktop app.
Use one MatchER instance per data directory.

## Run from source

Install **Python 3.13** (on Windows include the Python launcher), download the repository ZIP and extract it,
or clone the repository. Open `matcher.cmd` on Windows, or run `./matcher.sh` on Linux. The launcher creates
`.venv` and installs exact, hash-checked dependencies. Linux may need its `python3.13-venv` package.
These launchers open the app in your browser; the desktop packages have their own window.

For an existing environment:

```sh
python -m pip install --require-hashes --only-binary=:all: -r requirements.lock
python -m matcher
```

Options include `--port 8765`, `--no-browser`, `--data DIR`, `--debug` and `--lan`. LAN access is opt-in and
uses the private link printed in the terminal. Never post that link in an issue.

## If something goes wrong

- **Download failed:** check your connection and retry. Model files are verified before use and partial
  downloads are discarded. The originals are never uploaded to obtain the models.
- **Blank window / startup failure:** use **Help → Open startup log**, then attach only the relevant error to
  a [bug report](https://github.com/nikhilavibeauterai/MatchER/issues/new/choose). Remove personal file paths
  and private links. Don't attach databases, previews, face crops or personal photos.
- **Folder chooser unavailable in a browser:** choose **Browse here** or paste the full folder path. Desktop
  builds use the operating system's dialog directly.
- **Browser says locked:** open the exact link printed by your source launcher. The desktop app handles it for you.
- **Slow first scan:** models run on the CPU. Large libraries need time; progress is retained if you stop and resume.
- **Missing native library in a Linux source install:** Debian/Ubuntu users can install `libgl1`, `libegl1`,
  `libopengl0` and `libportaudio2` with their package manager. Desktop packages bundle the Python libraries;
  the `.deb` declares its desktop system dependencies.

If a release has no installers yet, it is still building or awaiting checks. The source launchers work independently;
[build instructions](building.md) describe how the same desktop packages are made.
