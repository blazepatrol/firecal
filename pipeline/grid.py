"""Region and common grid shared by both sensors: 1 km cells grouped into blocks over one bounding box.

Pick the region with the FIRECAL_REGION environment variable (default: houston).
Plain lat/lon scaling to kilometres is close to equal-area within a region this size
(the longitude scale changes by under 3% across 29.0-30.9 N).
"""
import math
import os

REGIONS = {
    "houston": {
        "name": "Greater Houston and the Sam Houston National Forest, Texas",
        "short": "Greater Houston",
        "bbox": (-96.2, 29.0, -94.6, 30.9),  # W, S, E, N
        "block_cells": 10,
        "focus": (-95.3698, 29.7604, "Houston"),
        "presets": {
            "Houston core (±25 km)": (-95.63, 29.535, -95.11, 29.985),
            "Sam Houston National Forest": (-95.75, 30.3, -95.0, 30.8),
            "Coastal prairie (Katy–Brazoria)": (-96.2, 29.0, -95.4, 29.9),
        },
        "events": {"2011": "2011 drought", "2023": "2023 drought"},
    },
    "arcadia": {
        "name": "San Gabriel front range around Arcadia, California",
        "short": "San Gabriel front range",
        "bbox": (-118.6, 34.0, -117.6, 34.5),
        "block_cells": 5,
        "focus": (-118.035, 34.14, "Arcadia"),
        "presets": {"Arcadia ±10 km": (-118.145, 34.05, -117.925, 34.23)},
        "events": {"2009": "Station Fire", "2020": "Bobcat Fire", "2025": "Eaton Fire"},
    },
}
REGION = os.environ.get("FIRECAL_REGION", "houston")
CFG = REGIONS[REGION]
REGION_NAME = CFG["name"]
W, S, E, N = CFG["bbox"]
LAT0 = (S + N) / 2
KX = 111.41288 * math.cos(math.radians(LAT0)) - 0.09350 * math.cos(math.radians(3 * LAT0))  # km per degree lon
KY = 111.13295 - 0.55982 * math.cos(math.radians(2 * LAT0)) + 0.00117 * math.cos(math.radians(4 * LAT0))  # km per degree lat
CELL_KM = 1
BLOCK_CELLS = CFG["block_cells"]
NX = math.ceil((E - W) * KX / CELL_KM)
NY = math.ceil((N - S) * KY / CELL_KM)
NBX = math.ceil(NX / BLOCK_CELLS)
NBY = math.ceil(NY / BLOCK_CELLS)


def cell_xy(lon, lat):
    """Cell column/row for array-likes of lon/lat (numpy or pandas)."""
    ix = ((lon - W) * KX // CELL_KM).astype(int).clip(0, NX - 1)
    iy = ((lat - S) * KY // CELL_KM).astype(int).clip(0, NY - 1)
    return ix, iy


def block_id(ix, iy):
    return (iy // BLOCK_CELLS) * NBX + (ix // BLOCK_CELLS)


def block_bounds(b: int):
    bx, by = b % NBX, b // NBX
    km = BLOCK_CELLS * CELL_KM
    return (
        round(W + bx * km / KX, 5),
        round(S + by * km / KY, 5),
        round(min(E, W + (bx + 1) * km / KX), 5),
        round(min(N, S + (by + 1) * km / KY), 5),
    )
