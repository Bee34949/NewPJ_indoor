from __future__ import annotations
import json, argparse

def affine_coords(coords, sx, sy, tx, ty, invert_y=False):
    # why: MapLibre ต้องการ lon/lat; ใช้ affine linear map ให้วางลงใกล้ lon0/lat0
    out = []
    for x, y in coords:
        yy = -y if invert_y else y
        out.append([tx + sx * x, ty + sy * yy])
    return out

def walk_geom(g, sx, sy, tx, ty, invert_y):
    t = g["type"]
    if t == "Point":
        x, y = g["coordinates"]
        yy = -y if invert_y else y
        g["coordinates"] = [tx + sx * x, ty + sy * yy]
    elif t == "LineString":
        g["coordinates"] = affine_coords(g["coordinates"], sx, sy, tx, ty, invert_y)
    elif t == "Polygon":
        g["coordinates"] = [affine_coords(r, sx, sy, tx, ty, invert_y) for r in g["coordinates"]]
    elif t == "MultiLineString":
        g["coordinates"] = [affine_coords(r, sx, sy, tx, ty, invert_y) for r in g["coordinates"]]
    elif t == "MultiPolygon":
        g["coordinates"] = [[affine_coords(r, sx, sy, tx, ty, invert_y) for r in p] for p in g["coordinates"]]
    return g

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--lon0", type=float, required=True)
    ap.add_argument("--lat0", type=float, required=True)
    ap.add_argument("--sx", type=float, required=True)
    ap.add_argument("--sy", type=float, required=True)
    ap.add_argument("--invert-y", action="store_true")
    a = ap.parse_args()

    fc = json.load(open(a.inp, "r", encoding="utf-8"))
    for f in fc.get("features", []):
        f["geometry"] = walk_geom(f["geometry"], a.sx, a.sy, a.lon0, a.lat0, a.invert_y)
    with open(a.out, "w", encoding="utf-8") as w:
        json.dump(fc, w, ensure_ascii=False)
    print(f"Wrote {a.out}")

if __name__ == "__main__":
    main()