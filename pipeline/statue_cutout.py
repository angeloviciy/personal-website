"""Prepare a statue photograph for the homepage's ASCII scene.

Cuts the statue out of a plain light background, crops it, optionally
erases a region (the bronze torch flame, replaced by a live one), and
re-tones it for glyph rendering: bronze photographs sit almost entirely
in the dark half of the range, which the ASCII pass turns into a wall of
dense glyphs. Lifting the mid-tones and sharpening the modelling spreads
the statue across the whole density ramp so faces and folds survive.

    python3 pipeline/statue_cutout.py SRC OUT --crop 170,0,690,560 \
        --erase 30,0,165,72 --erase 0,318,85,560 --erase 85,388,178,560 \
        --erase 135,318,178,388 --erase 455,385,520,560 --feather 4
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


def retone(rgb, gamma, sharpen, cool):
    # Lift mid-tones (gamma < 1 brightens).
    lut = [round(255 * (i / 255) ** gamma) for i in range(256)]
    rgb = rgb.point(lut * 3)
    # Bring out the sculpted relief.
    rgb = rgb.filter(ImageFilter.UnsharpMask(radius=3, percent=sharpen, threshold=1))
    # Cool the bronze a little toward grey-blue so it parts from the wheat.
    if cool:
        grey = rgb.convert("L").convert("RGB")
        rgb = Image.blend(rgb, grey, cool)
        rgb = ImageChops.multiply(rgb, Image.new("RGB", rgb.size, (238, 242, 255)))
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--crop", type=box)
    ap.add_argument("--erase", type=box, action="append", default=[])
    ap.add_argument("--threshold", type=int, default=238)
    ap.add_argument("--gamma", type=float, default=0.62)
    ap.add_argument("--sharpen", type=int, default=140)
    ap.add_argument("--cool", type=float, default=0.35)
    ap.add_argument("--feather", type=float, default=0)
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGB")
    alpha = cutout(im, a.threshold)
    rgb = retone(im, a.gamma, a.sharpen, a.cool)
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
    rgb.save(a.out, optimize=True)
    print(a.out, rgb.size)


if __name__ == "__main__":
    main()
