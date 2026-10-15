# Third-party notices

MatchER uses third-party software under its respective licenses. Desktop packages include Electron's
`LICENSE` and `LICENSES.chromium.html`, and the Python backend's `_internal/licenses/` directory contains
the dependency license files and a version inventory collected from the build environment. Keep these
notices with redistributed packages. Source dependencies are pinned in `requirements.lock` and
`desktop/package-lock.json`.

- Python: [PSF license](https://docs.python.org/3/license.html), also included at `_internal/licenses/Python/LICENSE.txt`.
- Electron: [MIT](https://github.com/electron/electron/blob/main/LICENSE); Chromium and its libraries have
  their own notices in the shipped `LICENSES.chromium.html`.
- The photo stack includes NumPy, Pillow, pillow-heif/libheif, rawpy/LibRaw, OpenCV, MediaPipe,
  ONNX Runtime and Hugging Face tokenizers. Native libraries can have different licenses from their
  Python wrappers; their original wheel notices are included in the backend inventory.
- [LibRaw source and licenses](https://www.libraw.org/download),
  [libheif source and license](https://github.com/strukturag/libheif),
  [rawpy source and license](https://github.com/letmaik/rawpy).

The Caveat and Patrick Hand fonts are distributed under the SIL Open Font License 1.1. Their complete
notices live beside the fonts in `matcher/static/fonts/*-OFL.txt`.

The nine bundled demo images are public domain. The [manifest](matcher/demo/manifest.json) records the
source, license and SHA-256 of every original. Four derived Ducreux takes are generated locally for the
sample stack. Screenshots in `docs/images/` show only that sample library.

Model weights are downloaded separately on first analysis, rather than included in the installer.
The pinned URLs and SHA-256 values are in `matcher/models.py`. Upstream sources and their model licenses:

- [OpenCV YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
- [OpenCV SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [SigLIP ONNX conversion](https://huggingface.co/Xenova/siglip-base-patch16-224), from
  [Google SigLIP](https://huggingface.co/google/siglip-base-patch16-224)
