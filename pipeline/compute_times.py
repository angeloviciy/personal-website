"""Compute 24h of travel times (min of walking & transit) from 62 Moss St
to a regular lon/lat grid over San Francisco, using R5 via r5py.

Output:
  ../assets/times.bin   uint8 minutes, shape [N_SLICES][NY][NX], 255 = unreachable
  ../assets/times.json  grid + slice metadata for the client
"""

import datetime
import json
import pathlib

import geopandas as gpd
import numpy as np
import shapely
import r5py

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"
OUT = HERE.parent / "assets"
OUT.mkdir(exist_ok=True)

ORIGIN_LON, ORIGIN_LAT = -122.4080696, 37.7775962  # 62 Moss Street

# Grid over SF proper (excludes Treasure Island; includes full peninsula city)
LON_MIN, LON_MAX = -122.525, -122.350
LAT_MIN, LAT_MAX = 37.703, 37.836
NX, NY = 140, 133

# Departure slices: every 30 min through a representative Wednesday
SERVICE_DATE = datetime.date(2026, 6, 17)
N_SLICES = 48
MAX_MINUTES = 150

lons = np.linspace(LON_MIN, LON_MAX, NX)
lats = np.linspace(LAT_MIN, LAT_MAX, NY)
gx, gy = np.meshgrid(lons, lats)
points = shapely.points(gx.ravel(), gy.ravel())
destinations = gpd.GeoDataFrame(
    {"id": np.arange(points.size)}, geometry=points, crs="EPSG:4326"
)
origin = gpd.GeoDataFrame(
    {"id": [0]},
    geometry=[shapely.Point(ORIGIN_LON, ORIGIN_LAT)],
    crs="EPSG:4326",
)

print("Building transport network (streets + Muni + BART)...")
network = r5py.TransportNetwork(
    str(DATA / "sf.osm.pbf"),
    [str(DATA / "muni.gtfs.zip"), str(DATA / "bart.gtfs.zip")],
)

times = np.full((N_SLICES, NY, NX), 255, dtype=np.uint8)

for s in range(N_SLICES):
    hh, mm = divmod(s * 30, 60)
    departure = datetime.datetime.combine(SERVICE_DATE, datetime.time(hh, mm))
    matrix = r5py.TravelTimeMatrix(
        network,
        origins=origin,
        destinations=destinations,
        departure=departure,
        departure_time_window=datetime.timedelta(minutes=20),
        transport_modes=[r5py.TransportMode.TRANSIT, r5py.TransportMode.WALK],
        max_time=datetime.timedelta(minutes=MAX_MINUTES),
        speed_walking=4.8,
    )
    grid = np.full(NX * NY, 255.0)
    valid = matrix.dropna(subset=["travel_time"])
    grid[valid["to_id"].to_numpy(dtype=int)] = valid["travel_time"].to_numpy()
    times[s] = np.clip(grid, 0, 255).astype(np.uint8).reshape(NY, NX)
    reach = (times[s] < 255).mean() * 100
    print(f"  {hh:02d}:{mm:02d}  reachable {reach:.0f}% of grid")

(OUT / "times.bin").write_bytes(times.tobytes())
meta = {
    "origin": [ORIGIN_LON, ORIGIN_LAT],
    "bbox": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
    "nx": NX,
    "ny": NY,
    "slices": N_SLICES,
    "sliceMinutes": 30,
    "maxMinutes": MAX_MINUTES,
    "serviceDate": SERVICE_DATE.isoformat(),
}
(OUT / "times.json").write_text(json.dumps(meta))
print(f"Wrote {OUT/'times.bin'} ({times.nbytes/1024:.0f} KB) and times.json")
