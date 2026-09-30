#!/usr/bin/env python3
"""
Build the SF Bay water-mask polygon from NCEI CUDEM 1/9 arc-second tiles.

Reads the ~3 m topobathy tiles straight from NOAA's public S3 bucket (byte
ranges via GDAL's /vsicurl/), thresholds bed elevation to water/land,
polygonizes, simplifies, and writes one GeoJSON MultiPolygon covering the
SFBOFS regular-grid domain. The client clips the currents raster and the
particle field to this polygon (see src/renderer/layers/waterMask.ts).

Where no 1/9 tile exists (the Delta east of 121.75 W, open ocean west of
123.25 W) the domain is left unmasked so the model's own land mask still
applies there.

Usage:
    python3 -m venv .venv && .venv/bin/pip install rasterio shapely numpy
    .venv/bin/python scripts/build-shoreline.py [--step N] [--tiles k]

--step N   read every Nth pixel (3 ≈ 10 m). Default 1 = full 3 m resolution.
--tiles k  only process the first k tiles (smoke test).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import rasterio
from rasterio import features
from rasterio.windows import from_bounds
from shapely.geometry import MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import unary_union

BUCKET = "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/dem/NCEI_ninth_Topobathy_2014_8483/CA"

# SFBOFS regulargrid extent (0.0025° spacing, 553×329).
DOMAIN = dict(lon_min=-123.04, lon_max=-121.66, lat_min=37.41, lat_max=38.23)

# Water/land threshold in metres NAVD88. NAVD88 ≈ MSL − 0.035 m at the
# Golden Gate, so 0 m is effectively mean sea level.
WATER_THRESHOLD_M = 0.0

# Point known to be in the Bay, used to pick the connected water body.
GOLDEN_GATE = Point(-122.478, 37.818)

# Tiles that intersect the domain and exist in the bucket. Name encodes the
# tile's north edge (nXXxYY) and west edge (wZZZxWW), each 0.25° square.
TILES = [
    ("n37x50", "w122x00", "2022v1"), ("n37x50", "w122x25", "2022v1"),
    ("n37x50", "w122x50", "2022v1"), ("n37x50", "w122x75", "2022v1"),
    ("n37x75", "w122x00", "2022v1"), ("n37x75", "w122x25", "2022v1"),
    ("n37x75", "w122x50", "2022v1"), ("n37x75", "w122x75", "2022v1"),
    ("n38x00", "w122x00", "2022v1"), ("n38x00", "w122x25", "2022v1"),
    ("n38x00", "w122x50", "2022v1"), ("n38x00", "w122x75", "2022v1"),
    ("n38x00", "w123x00", "2025v1"), ("n38x00", "w123x25", "2025v1"),
    ("n38x25", "w122x00", "2022v1"), ("n38x25", "w122x25", "2022v1"),
    ("n38x25", "w122x50", "2022v1"), ("n38x25", "w122x75", "2022v1"),
    ("n38x25", "w123x00", "2025v1"), ("n38x25", "w123x25", "2025v1"),
]


def tile_bounds(n: str, w: str) -> tuple[float, float, float, float]:
    lat_n = float(n[1:].replace("x", "."))
    lon_w = -float(w[1:].replace("x", "."))
    return (lon_w, lat_n - 0.25, lon_w + 0.25, lat_n)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def process_tile(n: str, w: str, ver: str, step: int, simplify_deg: float, min_px: int):
    url = f"/vsicurl/{BUCKET}/ncei19_{n}_{w}_{ver}.tif"
    west, south, east, north = tile_bounds(n, w)
    # Tiles are 8112 px for a 0.25° (8100 px) square, i.e. they overlap their
    # neighbours by 6 px. Read past the nominal edge on every side so the
    # polygons from adjacent tiles genuinely overlap and union into one body
    # (clipping exactly at the nominal edge leaves float-noise gaps).
    pad = 0.0005
    rw = max(west - pad, DOMAIN["lon_min"] - 0.001)
    re_ = min(east + pad, DOMAIN["lon_max"] + 0.001)
    rs = max(south - pad, DOMAIN["lat_min"] - 0.001)
    rn = min(north + pad, DOMAIN["lat_max"] + 0.001)
    if rw >= re_ or rs >= rn:
        return None, None

    with rasterio.open(url) as ds:
        b = ds.bounds
        rw, re_, rs, rn = max(rw, b.left), min(re_, b.right), max(rs, b.bottom), min(rn, b.top)
        win = from_bounds(rw, rs, re_, rn, ds.transform).round_offsets().round_lengths()
        out_h = max(1, int(win.height) // step)
        out_w = max(1, int(win.width) // step)
        t0 = time.time()
        elev = ds.read(1, window=win, out_shape=(out_h, out_w), resampling=rasterio.enums.Resampling.nearest)
        nodata = ds.nodata if ds.nodata is not None else -9999.0
        transform = ds.window_transform(win) * rasterio.Affine.scale(win.width / out_w, win.height / out_h)
        log(f"  read {n}_{w} {out_w}x{out_h} in {time.time() - t0:.1f}s")

    water = (elev < WATER_THRESHOLD_M) | (elev == nodata)
    del elev
    mask = water.astype(np.uint8)

    # Drop speckle: tiny water pockets, then tiny land pockets.
    if min_px > 1:
        mask = features.sieve(mask, size=min_px)
        mask = 1 - features.sieve(1 - mask, size=min_px)

    t0 = time.time()
    polys = []
    for geom, val in features.shapes(mask, mask=mask == 1, transform=transform, connectivity=4):
        if val != 1:
            continue
        p = shape(geom)
        if simplify_deg > 0:
            p = p.simplify(simplify_deg, preserve_topology=True)
        if not p.is_empty:
            polys.append(p)
    log(f"  polygonized {n}_{w}: {len(polys)} polys in {time.time() - t0:.1f}s")
    return polys, box(rw, rs, re_, rn)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, default=1)
    ap.add_argument("--tiles", type=int, default=len(TILES))
    ap.add_argument("--simplify-m", type=float, default=2.0, help="simplify tolerance in metres")
    ap.add_argument("--min-area-m2", type=float, default=10000.0, help="drop water/land pockets smaller than this")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "shoreline", "sfbay-water.geojson"))
    args = ap.parse_args()

    # 1/9 arc-second ≈ 3.086e-5°; ~3.4 m N-S, ~2.7 m E-W at 38 N.
    px_deg = 3.0864197531134774e-05 * args.step
    px_area_m2 = (px_deg * 111_000) * (px_deg * 111_000 * np.cos(np.radians(37.8)))
    min_px = int(args.min_area_m2 / px_area_m2)
    simplify_deg = args.simplify_m / 111_000

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
    os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
    os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")

    all_polys: list[Polygon] = []
    coverage = []
    for (n, w, ver) in TILES[: args.tiles]:
        log(f"tile {n}_{w}_{ver}")
        polys, cov = process_tile(n, w, ver, args.step, simplify_deg, min_px)
        if polys is None:
            continue
        all_polys.extend(polys)
        coverage.append(cov)

    log(f"union of {len(all_polys)} polygons…")
    t0 = time.time()
    water = unary_union(all_polys)
    log(f"  union done in {time.time() - t0:.1f}s")

    parts = list(water.geoms) if isinstance(water, MultiPolygon) else [water]
    parts.sort(key=lambda p: p.area, reverse=True)
    main_body = next((p for p in parts if p.contains(GOLDEN_GATE)), parts[0])
    log(f"  {len(parts)} water bodies; keeping main body ({main_body.area * 111e3 * 111e3 * 0.79 / 1e6:.0f} km²), dropping the rest")

    domain = box(DOMAIN["lon_min"], DOMAIN["lat_min"], DOMAIN["lon_max"], DOMAIN["lat_max"])
    covered = unary_union(coverage)
    uncovered = domain.difference(covered)
    result = unary_union([main_body.intersection(domain), uncovered])
    result = result.simplify(0, preserve_topology=True)
    if isinstance(result, Polygon):
        result = MultiPolygon([result])

    n_vertices = sum(len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors) for p in result.geoms)
    log(f"result: {len(result.geoms)} polygons, {n_vertices} vertices")

    def rnd(coords):
        return [[round(x, 6), round(y, 6)] for x, y in coords]

    geom = {
        "type": "MultiPolygon",
        "coordinates": [[rnd(p.exterior.coords)] + [rnd(r.coords) for r in p.interiors] for p in result.geoms],
    }
    feature = {
        "type": "Feature",
        "properties": {
            "source": "NOAA NCEI CUDEM 1/9 arc-second topobathy (NAVD88)",
            "threshold_m_navd88": WATER_THRESHOLD_M,
            "step": args.step,
            "simplify_m": args.simplify_m,
            "domain": DOMAIN,
            "uncovered_is_water": True,
        },
        "geometry": geom,
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": [feature]}, f, separators=(",", ":"))
    log(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
