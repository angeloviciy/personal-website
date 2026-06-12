"""Compute cycling travel times from 62 Moss St to the same grid used by
compute_times.py. Bikes have no timetable, so one slice covers the whole day.

Output: ../assets/bike.bin  uint8 minutes, shape [NY][NX], 255 = unreachable
"""

import datetime
import pathlib

import geopandas as gpd
import numpy as np
import shapely
import r5py

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"
OUT = HERE.parent / "assets"

ORIGIN_LON, ORIGIN_LAT = -122.4080696, 37.7775962  # 62 Moss Street

LON_MIN, LON_MAX = -122.525, -122.350
LAT_MIN, LAT_MAX = 37.703, 37.836
NX, NY = 140, 133
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

print("Building transport network...")
network = r5py.TransportNetwork(str(DATA / "sf.osm.pbf"))

matrix = r5py.TravelTimeMatrix(
    network,
    origins=origin,
    destinations=destinations,
    departure=datetime.datetime(2026, 6, 17, 12, 0),
    transport_modes=[r5py.TransportMode.BICYCLE],
    max_time=datetime.timedelta(minutes=MAX_MINUTES),
    speed_cycling=15.0,
)

grid = np.full(NX * NY, 255.0)
valid = matrix.dropna(subset=["travel_time"])
grid[valid["to_id"].to_numpy(dtype=int)] = valid["travel_time"].to_numpy()
bike = np.clip(grid, 0, 255).astype(np.uint8).reshape(NY, NX)
(OUT / "bike.bin").write_bytes(bike.tobytes())
v = bike[bike < 255]
print(f"reachable {v.size} cells, median {np.median(v):.0f} min, "
      f"p90 {np.percentile(v, 90):.0f} min")
