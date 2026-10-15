# Build and release

The desktop app is Electron around the existing local Flask app, served by Waitress. A PyInstaller **onedir**
backend contains Python and native dependencies. Electron starts that exact child on a random loopback port,
keeps its private link in the main process and exposes only native folder selection through an isolated preload.
Closing the window sends a stop command over the child's stdin; EOF also stops it if the parent disappears.
No model weights, saves or personal photos go into an installer.

## Prerequisites

Build natively on Windows x64 or Linux x64, with Python 3.13 and Node.js 24 LTS. Linux CI uses Ubuntu 22.04
to avoid accidentally requiring a newer glibc. Build on the oldest Linux distribution you intend to support.
Windows needs no developer compiler: runtime wheels and PyInstaller provide the native libraries.

```sh
python -m venv .venv
# Linux: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install --require-hashes --only-binary=:all: -r requirements.lock
python -m pip install --require-hashes -r packaging/requirements.lock
python scripts/build_backend.py
```

Check the actual frozen backend, including native imports, multiprocessing spawn, bundled assets, authenticated
HTTP, the offline sample and shutdown:

```sh
# Windows: dist\backend\matcher-backend\matcher-backend.exe
python scripts/smoke_backend.py dist/backend/matcher-backend/matcher-backend
# Add --analyze to download models into a throwaway dir and scan the public sample too.
```

Then build the window and installers:

```sh
cd desktop
npm ci
npm test
npm run pack    # unpacked executable for a quick check
npm run dist    # Linux AppImage + deb, or Windows NSIS installer
```

Artifacts appear in `dist/desktop/`. For development, `npm start` launches the checkout backend; set
`MATCHER_PYTHON` to use a different interpreter. Use throwaway `MATCHER_DATA` and `MATCHER_MODELS` paths when testing.
`scripts/smoke_desktop.cjs` drives the actual Electron window with Playwright. It requires `tests/ui`'s npm deps
and a display (Linux CI supplies Xvfb). It checks the preload, isolated renderer, welcome screen and clean exit.

## Release process

1. Update `matcher.__version__` and `desktop/package.json` together, then run `npm install --package-lock-only`
   inside `desktop`.
2. Run the Python, JS and relevant browser suites. Keep test photos public domain and data directories disposable.
3. Push a `v<version>` tag or dispatch **Desktop release**. CI builds and smoke-tests on both operating systems.
   Its artifacts include installers and SHA-256 checksums. Tagged builds create a **draft** release only after
   both platforms pass; a maintainer reviews the results before publishing.
4. Download and manually install each package, check first launch, choosing a Unicode folder, sample analysis,
   export, quit and reopening the saved game. Check the Windows install/uninstall flow and a clean Linux desktop.
5. Publish the draft with honest preview notes, minimum OS versions and any remaining limitations.

The first preview has no automatic updater. Install the next release over the current one; saves are stored
separately and survive upgrades. Windows signing is not configured yet. Set up a signing identity before
claiming signed installers.

## Updating dependencies

`requirements.txt` holds runtime pins; `requirements.lock` is universal, including Windows-only dependencies
and hashes for each platform's wheels. `packaging/requirements.lock` separately pins build/test tooling.
Use a known `uv` version (currently 0.13.1) to regenerate:

```sh
uv pip compile --universal --python-version 3.13 --generate-hashes requirements.txt -o requirements.lock
uv pip compile --universal --python-version 3.13 --generate-hashes packaging/requirements.txt -o packaging/requirements.lock
```

Review changes and run both native builds; a Linux-only install is not proof that Windows works.
Electron's npm lock is committed, and `npm ci` verifies registry integrity values.

Python wheels and source distributions include the static UI, fonts and public demo. Inspect package contents
before release. Private data directories, model caches, local captures and planning transcripts must remain excluded.
