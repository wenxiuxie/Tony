#!/usr/bin/env python3
"""Cut the Overthinking sleeve into the four planes the card composites.

    python tools/sleeve.py [--preview]

Reads the `layers` block on a release in content/shared.json and writes,
for the one sleeve that declares it:

    img/album-overthinking-back.webp   the paper, empty
    img/album-overthinking-ink.webp    his scribbles, 3 frames side by side
    img/album-overthinking-near.webp   him, with an alpha channel
    img/album-overthinking-mark.webp   the printed pink badge, alpha

The card stacks those in that order and slides them at different rates
under the cursor, so the photograph lifts off the paper it is printed on.
The ink sheet is a sprite: the card steps through its three frames, which
is a boil - the wobble a hand-drawn line has because every frame of it was
drawn again. The drawing on this sleeve is Tony's own hand, so it is the
one element on the site with a right to move like a drawing.

RUN THIS AFTER CHANGING THE SLEEVE ARTWORK. As with tools/planes.py,
build.py cannot tell that the derived files are stale, only that they are
missing - it falls back to the flat artwork when `layers` is absent.

Separation is by connected component rather than the GrabCut the hero
needs: this artwork is line and photograph on white paper, so

    largest non-white blob = him        (his shirt reaches three edges)
    every other blob       = a stroke
    magenta, bottom right  = the badge  (his beanie is magenta too, which
                                         is what the corner test is for)

Dependencies beyond the stdlib are OpenCV, numpy and Pillow. Same reason
as planes.py: the Pages build runs a bare `python build.py`, and these are
committed assets rather than build output.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# Paper is not #fff after WebP - it sits a couple of levels below and
# carries a faint warm cast, so the test needs slack in it.
PAPER_V = 236        # value at or above this, and
PAPER_S = 28         # saturation at or below it, counts as bare paper
INK_MIN_AREA = 24    # smaller blobs are compression noise, not a pen mark

FRAMES = 3           # frames in the boil. Three is the classic minimum:
                     # two reads as a flicker between two states.
# Warp amplitude in source pixels. The sleeve renders around 340px wide in
# a card, so 3px here is a shade over 1px on screen - a redrawn line, not a
# vibrating one. This is the line the hero taught us to stay above: below
# it, movement stops reading as drawing and starts reading as the page
# shaking.
BOIL_PX = 3.0
BOIL_CELLS = 10      # displacement grid. ~70px per cell at this size, so a
                     # stroke bends along its length instead of sliding.
# Alpha gamma per frame: a hand redrawing a line does not reproduce its
# weight either. Below 1 fattens, above 1 thins.
BOIL_WEIGHT = (1.0, 0.90, 1.12)

# Alpha steps kept in the ink sheet. WebP stores alpha losslessly whatever
# the quality setting, and three full-resolution frames of line art come to
# 175 KB of it. Rounding alpha to 16 steps takes the sheet to 59 KB, and it
# is invisible: the only place alpha is not 0 or 255 is the pen's own
# antialiasing, a ramp one or two pixels wide.
INK_ALPHA_STEPS = 16
INK_RGB = (18, 16, 18)   # every stroke on this sleeve is the same black pen
INK_COLOUR_SPREAD = 40   # ... except a couple of marks. Channel spread above
                         # this keeps its own colour; see _pack.


def _masks(src: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """-> (him, ink, badge), each uint8 0/255 at full resolution."""
    hsv = cv2.cvtColor(src, cv2.COLOR_RGB2HSV)
    v, s, h = hsv[..., 2].astype(int), hsv[..., 1].astype(int), hsv[..., 0].astype(int)
    H, W = src.shape[:2]

    marked = (((v < PAPER_V) | (s > PAPER_S)) * 255).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(marked, 8)
    if n < 2:
        raise SystemExit("artwork is blank - nothing separated from the paper")

    subject_id = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    him = ((lab == subject_id) * 255).astype(np.uint8)

    ink = np.zeros((H, W), np.uint8)
    for i in range(1, n):
        if i != subject_id and stats[i, cv2.CC_STAT_AREA] >= INK_MIN_AREA:
            ink[lab == i] = 255

    # The badge is magenta and in the bottom-right corner. The beanie is
    # magenta and is not, which is the whole reason for the corner test.
    magenta = ((s > 120) & (v > 90) & ((h > 160) | (h < 6))).astype(np.uint8) * 255
    corner = np.zeros((H, W), np.uint8)
    corner[int(H * 0.72):, int(W * 0.66):] = 255
    badge = cv2.bitwise_and(magenta, corner)
    badge = cv2.morphologyEx(badge, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n2, lab2, stats2, _ = cv2.connectedComponentsWithStats(badge, 8)
    if n2 > 1:
        # the disc only, not the stray pink webp leaves scattered around it
        keep = 1 + int(np.argmax(stats2[1:, cv2.CC_STAT_AREA]))
        badge = ((lab2 == keep) * 255).astype(np.uint8)
        badge = cv2.dilate(badge, np.ones((5, 5), np.uint8))
        # Fill it. The type inside the disc is white, so it is not magenta,
        # and unfilled it would punch his name straight through the badge.
        cnts, _ = cv2.findContours(badge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(badge, cnts, -1, 255, cv2.FILLED)
    else:
        badge = np.zeros((H, W), np.uint8)

    return him, ink, badge


def _under_badge(him: np.ndarray, badge: np.ndarray) -> np.ndarray:
    """Where his shirt runs on underneath the badge.

    The badge is contiguous with his shirt, so the blob test hands it back
    as part of him - including the crescent of it that overhangs the bare
    paper. Left alone that crescent rides out with him as a black bite out
    of the sleeve. Inpainting the silhouette across the badge continues the
    shoulder line through it instead, which is all the shape needs to be:
    the badge itself covers the repair, and only the couple of pixels that
    slide out from under it are ever seen.
    """
    outline = cv2.inpaint(cv2.bitwise_and(him, cv2.bitwise_not(badge)),
                          cv2.dilate(badge, np.ones((3, 3), np.uint8)),
                          9, cv2.INPAINT_TELEA)
    return ((outline > 127) * 255).astype(np.uint8)


def _matte(src: np.ndarray, mask: np.ndarray, paper: np.ndarray) -> np.ndarray:
    """Ink as straight RGBA: how far each pixel falls from bare paper.

    A hard cut along the blob mask would give every stroke a stair-stepped
    edge, because the mask was thresholded. Taking alpha from the darkness
    instead keeps the pen's own antialiasing, and compositing the result
    back over the paper reproduces the artwork exactly.
    """
    d = np.clip(paper.astype(np.int16) - src.astype(np.int16), 0, 255)
    alpha = d.max(axis=2).astype(np.float32) / 255.0
    alpha *= (cv2.GaussianBlur(mask, (0, 0), 1.2).astype(np.float32) / 255.0)
    alpha = np.clip(alpha * 1.25, 0, 1)                   # thin strokes stay solid

    a = np.maximum(alpha, 1e-3)[..., None]
    rgb = (src.astype(np.float32) - (1 - a) * paper) / a  # un-composite off the paper
    rgb = np.clip(rgb, 0, 255)
    return np.dstack([rgb, alpha * 255]).astype(np.uint8)


def _pack(frame: np.ndarray) -> np.ndarray:
    """Flatten the ink to one colour and coarsen its alpha, for size.

    Un-compositing leaves noise in RGB wherever alpha is near zero, which
    is most of the sheet, and that noise is expensive to store and never
    seen. Painting the whole plane one black instead costs nothing and
    compresses to almost nothing - so long as the handful of marks he drew
    in colour are exempted, which is what the spread test does.
    """
    out = frame.copy()
    rgb = out[..., :3].astype(np.int16)
    keep = (rgb.max(axis=2) - rgb.min(axis=2)) > INK_COLOUR_SPREAD
    flat = np.full_like(out[..., :3], np.uint8(INK_RGB))
    out[..., :3] = np.where(keep[..., None], out[..., :3], flat)

    n = INK_ALPHA_STEPS - 1
    a = out[..., 3].astype(np.float32) / 255.0
    out[..., 3] = np.clip(np.round(a * n) / n * 255, 0, 255).astype(np.uint8)
    return out


def _boil(sheet: np.ndarray, seed: int) -> list[np.ndarray]:
    """The same drawing, drawn FRAMES times."""
    H, W = sheet.shape[:2]
    rng = np.random.default_rng(seed)
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32),
                         np.arange(H, dtype=np.float32))
    out = []
    for f in range(FRAMES):
        frame = sheet
        if f:
            dx, dy = (cv2.resize(rng.standard_normal((BOIL_CELLS, BOIL_CELLS)).astype(np.float32),
                                 (W, H), interpolation=cv2.INTER_CUBIC) for _ in range(2))
            frame = cv2.remap(sheet, gx + dx * BOIL_PX, gy + dy * BOIL_PX,
                              cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                              borderValue=(0, 0, 0, 0))
        w = BOIL_WEIGHT[f]
        if w != 1.0:
            frame = frame.copy()
            frame[..., 3] = np.clip(
                ((frame[..., 3].astype(np.float32) / 255.0) ** w) * 255,
                0, 255).astype(np.uint8)
        out.append(frame)
    return out


def build(src_path: Path, out: dict[str, Path], preview: bool = False) -> None:
    src = np.array(Image.open(src_path).convert("RGB"))
    H, W = src.shape[:2]
    him, ink, badge = _masks(src)

    him = _under_badge(him, badge)
    paper = np.median(src[(him == 0) & (ink == 0) & (badge == 0)], axis=0).astype(np.float32)

    # ---- back: the paper, with everything lifted off it ----------------
    # Not inpainted: there is nothing to reconstruct. The sheet is one flat
    # tone, so painting it flat is both truer than a repair and the reason
    # this file lands in the low single-digit KB.
    Image.fromarray(np.full((H, W, 3), paper, np.uint8)).save(
        out["back"], quality=90, method=6)

    # ---- ink: three frames of it, side by side -------------------------
    frames = [_pack(f) for f in _boil(_matte(src, ink, paper), seed=7)]
    sheet = np.zeros((H, W * FRAMES, 4), np.uint8)
    for i, f in enumerate(frames):
        sheet[:, i * W:(i + 1) * W] = f
    Image.fromarray(sheet, "RGBA").save(out["ink"], lossless=True, method=6)

    # ---- near: him, with the badge repaired out ------------------------
    # The badge is printed over him and rides on its own plane above, so
    # his copy of it has to go or it doubles the moment the planes part.
    # The repair is a flat fill from the shirt immediately around it rather
    # than an inpaint: an inpaint reaches into the bare paper on the badge's
    # other side and drags a pale smear into the shirt, and the shirt here
    # is one unbroken black anyway.
    body = src.copy()
    ring = cv2.bitwise_and(cv2.dilate(badge, np.ones((21, 21), np.uint8)) - badge, him)
    body[badge > 0] = np.median(src[ring > 0], axis=0).astype(np.uint8)
    patch = cv2.GaussianBlur(body, (0, 0), 3.0)
    soft = cv2.GaussianBlur(badge, (0, 0), 4.0) > 8
    body[soft] = patch[soft]

    alpha = cv2.GaussianBlur(him, (0, 0), 1.1)
    # Same pull-in as the hero planes: a feathered edge over a lighter
    # plane keeps a rim of half-opacity paper, and that rim reads as a halo
    # the moment the planes separate.
    alpha = np.clip((alpha.astype(np.int16) - 30) * 1.5, 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([body, alpha]), "RGBA").save(
        out["near"], quality=90, method=6)

    # ---- mark: the badge, nailed to the paper --------------------------
    # Written on the full canvas rather than cropped to the disc, so the
    # card can stack it with the other three at inset:0 and never has to be
    # told where on the sleeve the badge sits. The empty 97% of the frame
    # costs about a hundred bytes.
    Image.fromarray(np.dstack([src, cv2.GaussianBlur(badge, (0, 0), 0.8)]),
                    "RGBA").save(out["mark"], quality=92, method=6)

    if preview:
        base = Image.fromarray(np.full((H, W, 3), paper, np.uint8))
        near = Image.open(out["near"]).convert("RGBA")
        mark = Image.open(out["mark"]).convert("RGBA")
        strip = Image.new("RGB", (W * FRAMES + 8 * (FRAMES - 1), H), (20, 20, 20))
        for i in range(FRAMES):
            t = base.copy()
            fr = Image.fromarray(frames[i], "RGBA")
            t.paste(fr, (-2 * i, 0), fr)
            # him, shoved about as far as the cursor takes him at the far
            # corner of the card - scaled up to source pixels
            t.paste(near, (-13 * i, -5 * i), near)
            t.paste(mark, (0, 0), mark)
            strip.paste(t, (i * (W + 8), 0))
        p = ROOT / "tools" / "sleeve-preview.png"
        strip.save(p)
        print(f"preview -> {p}")


def main() -> int:
    shared = json.loads((ROOT / "content" / "shared.json").read_text("utf-8"))
    done = 0
    for rel in shared["releases"]:
        layers = rel.get("layers")
        if not layers:
            continue
        src = ROOT / rel["art"]
        if not src.exists():
            print(f"missing source: {src}", file=sys.stderr)
            return 1
        out = {k: ROOT / layers[k] for k in ("back", "ink", "near", "mark")}
        build(src, out, preview="--preview" in sys.argv)
        for f in (src, *out.values()):
            print(f"{f.relative_to(ROOT).as_posix():<36} {f.stat().st_size / 1024:6.1f} KB")
        done += 1
    if not done:
        print("no release declares a `layers` block", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
