#!/usr/bin/env python3
"""Cut the hero portrait into the two depth planes the first screen uses.

    python tools/planes.py

Reads `images.hero` from content/shared.json and writes the two derived
files next to it:

    img/hero-subject.webp   him, with an alpha channel
    img/hero-plate.webp     the same frame with him painted out

The hero composites those two at slightly different rates under the
cursor, which is where its sense of depth comes from. The plate is why
that works: without a real backdrop behind the cut-out, the far plane
still holds a copy of him and the two separate into a double image.

RUN THIS AFTER CHANGING THE HERO PHOTOGRAPH. build.py falls back to the
flat single image only when the two keys are absent from shared.json —
it cannot tell that they are present but stale, so a new portrait with
old planes will render the old person.

Only dependency beyond the stdlib is OpenCV (plus numpy and Pillow),
which is why this lives in tools/ and not in build.py: the Pages build
runs `python build.py` with nothing installed, and these are committed
assets, not build output.

The segmentation is GrabCut seeded with a rectangle, which is enough
because the source is a studio frame — one subject, a smooth backdrop,
no clutter. It is not enough for a location shot, so check the result.
Pass --preview to write /tmp/planes-preview.png: the composite on the
left, the near plane shoved 40px on the right. If the right-hand image
shows a ghost of him in the backdrop, the plate has not covered his
outline and INPAINT_DILATE wants raising.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# How far past the mask the inpainting reaches before repairing the hole.
# Generous on purpose: a surviving fringe of him in the plate is the one
# artefact that is obvious in motion, and the backdrop is a smooth
# gradient, so over-painting it costs nothing.
INPAINT_DILATE = 25
GRABCUT_ITERS = 6


def build(src_path: Path, plate_path: Path, subject_path: Path,
          preview: bool = False) -> None:
    src = np.array(Image.open(src_path).convert("RGB"))
    H, W = src.shape[:2]

    # GrabCut at half resolution: it is an iterative graph cut and the
    # extra detail costs several seconds without moving the boundary by
    # more than the feather below smooths away anyway.
    small = cv2.resize(src, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    h, w = small.shape[:2]

    mask = np.zeros((h, w), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    rect = (int(w * 0.15), 2, int(w * 0.85) - 2, h - 3)
    cv2.grabCut(cv2.cvtColor(small, cv2.COLOR_RGB2BGR), mask, rect,
                bgd, fgd, GRABCUT_ITERS, cv2.GC_INIT_WITH_RECT)

    m = np.where((mask == 2) | (mask == 0), 0, 255).astype(np.uint8)

    # Largest connected component only. GrabCut reliably leaves a few
    # islands out in the backdrop where the gradient banding confuses it,
    # and every one of them would fly around on its own under the cursor.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n > 1:
        m = (lab == 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR)

    # ---- plate: him removed --------------------------------------------
    hole = cv2.dilate((m > 100).astype(np.uint8) * 255,
                      np.ones((INPAINT_DILATE, INPAINT_DILATE), np.uint8),
                      iterations=3)
    plate = cv2.inpaint(cv2.cvtColor(src, cv2.COLOR_RGB2BGR), hole, 12,
                        cv2.INPAINT_TELEA)
    plate = cv2.cvtColor(plate, cv2.COLOR_BGR2RGB)
    # TELEA leaves swirls across a hole this size. The backdrop is a
    # smooth studio gradient and the plane is rendered blurred anyway, so
    # blurring the repair is free accuracy rather than a compromise — and
    # it is most of why this file compresses to a few KB.
    plate = cv2.GaussianBlur(plate, (0, 0), 9.0)
    Image.fromarray(plate).save(plate_path, quality=86, method=6)

    # ---- subject: him alone --------------------------------------------
    alpha = cv2.GaussianBlur(m, (0, 0), 1.6)          # hairline feather
    # Pull the edge in slightly and steepen it. A feathered mask laid over
    # the plate keeps a ring of half-opacity backdrop grey, which reads as
    # a halo the moment the planes separate.
    alpha = np.clip((alpha.astype(np.int16) - 26) * 1.35, 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([src, alpha]), "RGBA").save(
        subject_path, quality=88, method=6)

    if preview:
        pl = Image.open(plate_path).convert("RGB")
        su = Image.open(subject_path).convert("RGBA")
        comp = pl.copy(); comp.paste(su, (0, 0), su)
        shifted = pl.copy(); shifted.paste(su, (-40, -14), su)
        out = Image.new("RGB", (W // 2 * 2 + 12, H // 2), (20, 20, 20))
        out.paste(comp.resize((W // 2, H // 2)), (0, 0))
        out.paste(shifted.resize((W // 2, H // 2)), (W // 2 + 12, 0))
        out.save("/tmp/planes-preview.png")
        print("preview -> /tmp/planes-preview.png")


def main() -> int:
    shared = json.loads((ROOT / "content" / "shared.json").read_text("utf-8"))
    img = shared["images"]
    src = ROOT / img["hero"]
    if not src.exists():
        print(f"missing source: {src}", file=sys.stderr)
        return 1

    plate = ROOT / img.get("heroPlate", "img/hero-plate.webp")
    subject = ROOT / img.get("heroSubject", "img/hero-subject.webp")
    build(src, plate, subject, preview="--preview" in sys.argv)

    for f in (src, plate, subject):
        print(f"{f.relative_to(ROOT).as_posix():<28} {f.stat().st_size / 1024:6.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
