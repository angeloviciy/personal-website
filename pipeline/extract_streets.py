"""Extract the SF street grid from OSM as resampled polylines for warping.

Vertices are resampled to ~70 m spacing so straight streets bend smoothly
under the time-space projection. Coordinates are quantized to uint16 within
the same bbox used by compute_times.py.

Output: ../assets/streets.json
  { "bbox": [...], "major": [[x,y,x,y,...], ...], "minor": [...] }
"""

import json
import math
import pathlib

import osmium

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "assets"
OUT.mkdir(exist_ok=True)

LON_MIN, LAT_MIN, LON_MAX, LAT_MAX = -122.525, 37.703, -122.350, 37.836
# Streets north of the Golden Gate Bridge's north anchorage are outside
# the transit feeds' jurisdiction (no Golden Gate Transit in the data):
# they'd render as a frozen walking-time blob pinned at the compute cap.
# Keep the quantization bbox unchanged; just don't emit those vertices.
LAT_CLIP = 37.8315

MAJOR = {"motorway", "trunk", "primary", "secondary"}
MINOR = {"tertiary", "residential", "unclassified", "motorway_link",
         "trunk_link", "primary_link", "secondary_link", "living_street"}

RESAMPLE_M = 70.0
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(37.77))


def resample(coords, spacing_m):
    """Return points along the polyline every spacing_m meters (plus endpoints)."""
    out = [coords[0]]
    carry = 0.0
    for (lon0, lat0), (lon1, lat1) in zip(coords, coords[1:]):
        dx = (lon1 - lon0) * M_PER_DEG_LON
        dy = (lat1 - lat0) * M_PER_DEG_LAT
        seg = math.hypot(dx, dy)
        if seg < 1e-9:
            continue
        d = spacing_m - carry
        while d < seg:
            f = d / seg
            out.append((lon0 + (lon1 - lon0) * f, lat0 + (lat1 - lat0) * f))
            d += spacing_m
        carry = (carry + seg) % spacing_m
    out.append(coords[-1])
    return out


class Streets(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.major = []
        self.minor = []

    def way(self, w):
        hw = w.tags.get("highway")
        if hw in MAJOR:
            bucket = self.major
        elif hw in MINOR:
            bucket = self.minor
        else:
            return
        coords = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        coords = [
            (lon, lat) for lon, lat in coords
            if LON_MIN <= lon <= LON_MAX and LAT_MIN <= lat <= LAT_CLIP
        ]
        if len(coords) < 2:
            return
        pts = resample(coords, RESAMPLE_M)
        flat = []
        for lon, lat in pts:
            qx = round((lon - LON_MIN) / (LON_MAX - LON_MIN) * 65535)
            qy = round((lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * 65535)
            flat.extend((qx, qy))
        bucket.append(flat)


handler = Streets()
handler.apply_file(str(HERE / "data" / "sf.osm.pbf"), locations=True)

result = {
    "bbox": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
    "major": handler.major,
    "minor": handler.minor,
}
out_path = OUT / "streets.json"
out_path.write_text(json.dumps(result, separators=(",", ":")))
n_pts = sum(len(l) for l in handler.major + handler.minor) // 2
print(f"major ways: {len(handler.major)}  minor ways: {len(handler.minor)}  "
      f"points: {n_pts}  size: {out_path.stat().st_size/1e6:.1f} MB")
