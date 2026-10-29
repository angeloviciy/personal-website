"""Matte figures out of a painting for the homepage's ASCII scene.

Paintings have dark, busy grounds that a flood fill (statue_cutout.py's
default) can't separate, so this runs two rembg models and merges them:
u2net keeps large, low-contrast forms (the lion's body in shadow) while
isnet is sharper on limbs against the ground. Requires `pip install rembg`;
the models download on first use.

    python3 pipeline/painting_mask.py SRC MASK.png [--warm x0,y0,x1,y1 ...]
    python3 pipeline/statue_cutout.py SRC OUT --mask MASK.png ...

--warm adds back, within a box, pixels redder than they are green: dark
hair against a dark green ground is lost by both models. The homepage's
Hercules was made with

    python3 pipeline/painting_mask.py SRC pipeline/hercules-mask.png --warm 178,36,248,82
    python3 pipeline/statue_cutout.py SRC assets/hercules-lion.png \
        --mask pipeline/hercules-mask.png --crop 40,30,440,430 --gamma 0.9 \
        --levels 60,195 --clahe 3 --sharpen 140 --cool 0
"""

import argparse

from PIL import Image, ImageChops, ImageDraw, ImageFilter
from rembg import new_session, remove


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--warm", action="append", default=[], type=lambda s: tuple(int(v) for v in s.split(",")))
    a_ = ap.parse_args()
    src, out = a_.src, a_.out
    im = Image.open(src).convert("RGB")
    a = remove(im, session=new_session("u2net")).getchannel("A")
    b = remove(im, session=new_session("isnet-general-use")).getchannel("A")
    b = b.point(lambda v: 255 if v > 150 else 0)
    m = ImageChops.lighter(a, b)
    for box in a_.warm:
        r, g, _ = im.split()
        warm = ImageChops.subtract(r, g).point(lambda v: 255 if v > 3 else 0)
        keep = Image.new("L", im.size, 0)
        ImageDraw.Draw(keep).rectangle(box, fill=255)
        m = ImageChops.lighter(m, ImageChops.multiply(warm, keep))
        # Close over the box, so darker strands between the warm ones (and
        # the shadow where hair meets shoulder) are kept too.
        closed = m.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.MinFilter(11))
        m = ImageChops.lighter(m, ImageChops.multiply(closed, keep))
    m = m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(0.8))
    m.save(out)
    print(out, m.getbbox())


if __name__ == "__main__":
    main()
