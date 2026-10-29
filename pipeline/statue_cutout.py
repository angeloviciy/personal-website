"""Prepare a statue photograph for the homepage's ASCII scene.

Cuts the statue out of a plain light background, crops it, optionally
erases a region (the bronze torch flame, replaced by a live one), and
re-tones it for glyph rendering: bronze photographs sit almost entirely
in the dark half of the range, which the ASCII pass turns into a wall of
dense glyphs. Lifting the mid-tones and sharpening the modelling spreads
the statue across the whole density ramp so faces and folds survive.

    python3 pipeline/statue_cutout.py SRC OUT --crop 170,0,690,560 \
        --erase 30,0,165,72 --erase 0,318,85,560 --erase 85,388,178,560 \
        --erase 135,318,178,388 --erase 455,385,520,560 --feather 4 \
        --soften 196,268,236,312 --soften 258,276,304,318
"""

import argparse
from collections import deque

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def box(s):
    return tuple(int(v) for v in s.split(","))


def cutout(im, threshold):
    """Flood-fill the background from the image border."""
    w, h = im.size
    px = im.load()
    bg = bytearray(w * h)
    q = deque([(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)])
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or bg[y * w + x]:
            continue
        if min(px[x, y][:3]) <= threshold:
            continue
        bg[y * w + x] = 1
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    alpha = Image.frombytes("L", (w, h), bytes(0 if v else 255 for v in bg))
    return alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))


def retone(rgb, gamma, sharpen, cool, levels=(0, 255)):
    # Lift mid-tones (gamma < 1 brightens), then squeeze into `levels`:
    # pale flesh in a painting would otherwise fall below the lightest glyph.
    lo, hi = levels
    lut = [round(lo + (hi - lo) * (i / 255) ** gamma) for i in range(256)]
    rgb = rgb.point(lut * 3)
    # Bring out the sculpted relief.
    rgb = rgb.filter(ImageFilter.UnsharpMask(radius=3, percent=sharpen, threshold=1))
    # Cool the bronze a little toward grey-blue so it parts from the wheat.
    if cool:
        grey = rgb.convert("L").convert("RGB")
        rgb = Image.blend(rgb, grey, cool)
        rgb = ImageChops.multiply(rgb, Image.new("RGB", rgb.size, (238, 242, 255)))
    return rgb


def soften(rgb, r, feather):
    """Smooth a region toward a flat mid-tone, keeping only broad shading."""
    flat = rgb.filter(ImageFilter.GaussianBlur(6))
    grey = Image.new("RGB", rgb.size, flat.crop(r).resize((1, 1), Image.BOX).getpixel((0, 0)))
    flat = Image.blend(flat, grey, 0.4)
    m = Image.new("L", rgb.size, 0)
    ImageDraw.Draw(m).ellipse(r, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(max(feather, 4)))
    return Image.composite(flat, rgb, m)


def local_contrast(rgb, clip):
    """CLAHE on lightness: separates detail inside deep shadows (a face
    in a painting's chiaroscuro) that a global curve can't reach."""
    import cv2
    import numpy as np

    lab = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2LAB)
    lab[..., 0] = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(lab[..., 0])
    return Image.fromarray(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--crop", type=box)
    ap.add_argument("--mask", help="use this alpha mask instead of flood-filling the background")
    ap.add_argument("--erase", type=box, action="append", default=[])
    ap.add_argument("--threshold", type=int, default=238)
    ap.add_argument("--gamma", type=float, default=0.62)
    ap.add_argument("--sharpen", type=int, default=140)
    ap.add_argument("--cool", type=float, default=0.35)
    ap.add_argument("--clahe", type=float, default=0, help="local contrast clip limit (needs opencv)")
    ap.add_argument("--levels", type=box, default=(0, 255), help="output range lo,hi")
    ap.add_argument("--feather", type=float, default=0)
    ap.add_argument("--soften", type=box, action="append", default=[])
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGB")
    alpha = Image.open(a.mask).convert("L") if a.mask else cutout(im, a.threshold)
    if a.clahe:
        im = local_contrast(im, a.clahe)
    rgb = retone(im, a.gamma, a.sharpen, a.cool, a.levels)
    rgb.putalpha(alpha)
    if a.crop:
        rgb = rgb.crop(a.crop)
    if a.erase:
        # Feathered, so an erased region leaves no hard edge behind.
        keep = Image.new("L", rgb.size, 255)
        d = ImageDraw.Draw(keep)
        for r in a.erase:
            d.rectangle(r, fill=0)
        if a.feather:
            keep = keep.filter(ImageFilter.GaussianBlur(a.feather))
        rgb.putalpha(ImageChops.multiply(rgb.getchannel("A"), keep))
    if a.soften:
        alpha = rgb.getchannel("A")
        base = rgb.convert("RGB")
        for r in a.soften:
            base = soften(base, r, a.feather)
        base.putalpha(alpha)
        rgb = base
    rgb.save(a.out, optimize=True)
    print(a.out, rgb.size)


if __name__ == "__main__":
    main()
