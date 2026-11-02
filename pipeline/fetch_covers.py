"""Find book covers for readings.json on Open Library and save them locally.

    python3 pipeline/fetch_covers.py            # entries without a "cover"
    python3 pipeline/fetch_covers.py --dry-run  # show matches, save nothing

Each match is shrunk to 240 px wide into assets/covers/ and its file name
written back into the entry. Entries that get no match are marked
"cover": false so later runs skip them; they render as an outlined title
card. To use a specific cover, save it in assets/covers/ yourself and set
"cover" to its file name; to retry a lookup, delete the "cover" field.
Check new matches by eye: an essay can share its title with a book.
"""

import argparse
import io
import json
import re
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LIST = ROOT / "readings.json"
COVERS = ROOT / "assets" / "covers"
WIDTH = 240


try:
    # python.org builds ship without a CA bundle; certifi supplies one.
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = None


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "personal-website-covers/1.0"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        return r.read()


def lookup(title, author):
    # Drop honorifics like "Gen." that the catalogue won't have.
    names = re.sub(r"^\w+\.\s+", "", author).split()
    q = urllib.parse.urlencode({"title": title, "author": names[-1], "limit": 10, "fields": "title,author_name,cover_i"})
    docs = json.loads(get("https://openlibrary.org/search.json?" + q))["docs"]
    # The search is loose: require the same title and the same first name,
    # so "Leadership" by one Ridgway doesn't pick up another's book.
    def same(d):
        authors = " ".join(d.get("author_name", [])).lower()
        return (d.get("cover_i") and d["title"].lower().startswith(title.lower())
                and names[0].lower() in authors and names[-1].lower() in authors)
    return next((d for d in docs if same(d)), None)


def trim(im):
    """Crop the white margins some scans carry around the cover."""
    g = im.convert("L").point(lambda v: 255 if v < 232 else 0)
    box = g.getbbox()
    # A white cover has no margin to find: cropping deep means we're
    # cutting into its design, so leave it whole.
    if not box or box[2] - box[0] < 0.9 * im.width or box[3] - box[1] < 0.9 * im.height:
        return im
    return im.crop(box)


def slug(entry):
    # Surname with its particles ("le-guin"), then the title.
    names = re.sub(r"^\w+\.\s+", "", entry["author"]).split()[1:]
    s = " ".join(n for n in names if not n.endswith(".")) + " " + entry["title"]
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    dry = ap.parse_args().dry_run
    entries = json.loads(LIST.read_text())
    COVERS.mkdir(parents=True, exist_ok=True)
    for e in entries:
        if "title" not in e or "cover" in e:
            continue
        doc = lookup(e["title"], e["author"])
        if not doc:
            print(f"none   {e['title']}")
            if not dry:
                e["cover"] = False
            continue
        print(f"found  {e['title']}  <-  {doc['title']} / {', '.join(doc.get('author_name', []))}")
        if dry:
            continue
        im = Image.open(io.BytesIO(get(f"https://covers.openlibrary.org/b/id/{doc['cover_i']}-L.jpg"))).convert("RGB")
        im = trim(im)
        im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
        name = slug(e) + ".jpg"
        im.save(COVERS / name, quality=82, optimize=True, progressive=True)
        e["cover"] = name
    if not dry:
        LIST.write_text("[\n" + ",\n".join("  " + json.dumps(e, ensure_ascii=False) for e in entries) + "\n]\n")


if __name__ == "__main__":
    main()
