from __future__ import annotations
import argparse
from pathlib import Path
from .loaders import load_csv
from .validators import validate
from .exporters import export_geojson
import json

def main():
    ap = argparse.ArgumentParser("indoor-etl")
    ap.add_argument("--floors", required=True)
    ap.add_argument("--nodes", required=True)
    ap.add_argument("--edges", required=True)
    ap.add_argument("--out", default="out_json")
    args = ap.parse_args()

    ds = load_csv(Path(args.floors), Path(args.nodes), Path(args.edges))
    errs = validate(ds)
    if errs:
        print("VALIDATION ERRORS:"); [print(" -", e) for e in errs]
    else:
        print("Validation: OK")

    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    export_geojson(ds, out)
    graph = {
        "floors": [vars(f) for f in ds.floors.values()],
        "nodes": {k: vars(v) for k, v in ds.nodes.items()},
        "edges": {k: vars(v) for k, v in ds.edges.items()},
    }
    (out / "graph.json").write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")
    print(f"Exported GeoJSON & graph.json to {out}")

if __name__ == "__main__":
    main()