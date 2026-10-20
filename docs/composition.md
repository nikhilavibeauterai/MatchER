# Automatic composition

MatchER considers rotation and two independent perspective directions together. Its default, **Natural**, tries
to improve the view while keeping depth and room around the subject. **Upright** gives structural alignment more
weight. **Expressive** can rotate a strong existing diagonal towards a 30° rhythm, with at most six extra degrees.
It does not put an arbitrary Dutch angle on a photo without that evidence.

This is a deterministic local heuristic, not a learned verdict on beauty. Two tastes can choose the same result,
and preserving an original composition is a valid result. The selected taste, manual overrides and automatic
switches are undoable per-photo choices in **Notes → Look → Align & perspective**. Colour enhancement is independent.

The estimator measures a proof with an 800-pixel longest edge. It detects long straight segments, merges duplicate
detections, excludes the image border, and requires spatially separated references. Each line family needs at
least three independent inliers, 68% weighted agreement and enough spread before it can propose a vanishing
direction. A clear horizon can supply rotation alone. Competing structures, curves, noise and strong deliberate
tilts do not manufacture a perspective correction.

It searches a bounded set of original, partial and full corrections. Candidate views are evaluated using:

- Alignment of the supported structural references, with a stronger preference for this in Upright.
- Retained source area and loss of visual attention, including the subject region already saved during analysis.
- Every detected face: projected bounds protect against clipping, and the local transform protects proportions.
- Soft alternatives for subject placement: centre or thirds, with no requirement to force either.
- Correction strength and lost depth; horizontal rectification has a higher cost in Natural and Expressive.
- Existing diagonal rhythm in Expressive.

Candidates retaining less than 62% of the source or losing more than 20% of a distinct saved subject region are rejected.
A face may extend at most 2.5% in total beyond the
output bounds, and the local anisotropy limit is 0.24 log units (about 27%). A small score improvement is required
to replace the original. These are heuristic limits, not guarantees of ideal framing; all three sliders remain
available, and **Hold for original** compares against the untouched source.

Geometry uses a centred projective homography, with the largest centred rectangle of the original aspect ratio
that introduces no empty corners. The browser applies it to the existing image element; decoded image upgrades
keep the same transform. Tiny atlas images are inverse-sampled once per recipe or edit, never during camera
motion. Export performs one full-resolution geometry resampling after light, colour and original-coordinate masks.
Quarter turns and crop rectangles change the coordinate basis rather than losing the saved perspective.

Version 4 look recipes store all three proposals and their explanations. Older libraries rebuild these from cached
previews in bounded background batches, retaining edits, votes and original files. There are no new downloads or
external services. `tests/test_composition.py` covers evidence, alternatives, face protection, browser/export maths,
validation, undo and exports; `auto_compose` checks real editing, projective crop gestures, phone controls and measured
browser/export pixels.

The projective model follows [OpenCV’s homography tutorial](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html).
Evaluating composition and attention together is also the motivation of
[Image Cropping with Composition and Saliency Aware Aesthetic Score Map](https://arxiv.org/abs/1911.10492).
MatchER implements its own lightweight search and does not use that paper’s trained network or weights.
