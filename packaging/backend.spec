# Build on each target OS; PyInstaller cannot cross-compile the native photo libraries.
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

root = Path(SPECPATH).parent
datas = collect_data_files('matcher', includes=['static/**', 'demo/**'])
datas += [(str(root / 'THIRD_PARTY_NOTICES.md'), '.')]
datas += [(str(root / 'LICENSE'), '.'), (str(root / 'SOURCE.md'), '.')]
if (root / 'build' / 'licenses').is_dir():
    datas += [(str(root / 'build' / 'licenses'), 'licenses')]
binaries, hidden = [], ['waitress', 'rawpy', 'pillow_heif', 'exifread', 'tokenizers']
if sys.platform.startswith('linux'):
    # MediaPipe loads its C library lazily. PyInstaller otherwise misses these GL dispatch libraries.
    from PyInstaller.depend.bindepend import resolve_library_path
    for name in ('libGLESv2.so.2', 'libEGL.so.1', 'libGLdispatch.so.0'):
        found = resolve_library_path(name)
        if not found:
            raise SystemExit(f'Install libgles2 and libegl1 before building: missing {name}')
        binaries.append((found, '.'))
for package in ('mediapipe', 'pillow_heif', 'tokenizers'):
    package_data, package_binaries, package_hidden = collect_all(package)
    datas += package_data
    binaries += package_binaries
    hidden += package_hidden
for package in ('mediapipe', 'onnxruntime', 'tokenizers', 'huggingface_hub', 'rawpy', 'pillow_heif'):
    datas += copy_metadata(package)
a = Analysis([str(root / 'scripts' / 'backend_entry.py')], pathex=[str(root)], binaries=binaries, datas=datas,
             hiddenimports=hidden, excludes=['pytest', 'IPython', 'notebook', 'tkinter'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='matcher-backend', debug=False, strip=False,
          upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='matcher-backend')
