# ======================================================================
# File: tools/emit_pgvector_sql.py
# WHY: สร้างสคริปต์ SQL สำหรับนำเข้าข้อมูลสู่ Postgres + pgvector (ทำทีหลัง)
# Run: python tools/emit_pgvector_sql.py --dataset B1-F06 --out data/B1-F06/ingest_pgvector.sql
# ======================================================================
import json, argparse
from pathlib import Path

def load(p): return json.loads(Path(p).read_text(encoding="utf-8"))

ap=argparse.ArgumentParser()
ap.add_argument("--dataset", required=True)
ap.add_argument("--root", default="data")
ap.add_argument("--out",  default=None)
a=ap.parse_args()

root = Path(a.root)/a.dataset
pts = load(root/"points.json")
sig = load(root/"signatures.json")
apd = sig["ap_dict"]; W = sig.get("weights_sqrt", [])
M = int(sig["dim"])

def vec_of(p):
    FILL=-100.0
    v=[FILL]*len(apd)
    for b,r in (p.get("rssi") or {}).items():
        i = apd.get(b)
        if i is not None: v[i]=float(r)
    # pre-scale
    return [v[i]*(float(W[i]) if i < len(W) else 0.0) for i in range(len(apd))]

out = Path(a.out or (root/"ingest_pgvector.sql"))
with out.open("w", encoding="utf-8") as f:
    f.write("""-- pgvector ingest
CREATE EXTENSION IF NOT EXISTS vector;
DROP TABLE IF EXISTS fp_points CASCADE;
DROP TABLE IF EXISTS fp_sigs CASCADE;
CREATE TABLE fp_points (
  id TEXT PRIMARY KEY,
  floor TEXT, lon DOUBLE PRECISION, lat DOUBLE PRECISION
);
CREATE TABLE fp_sigs (
  id TEXT PRIMARY KEY REFERENCES fp_points(id),
  vec VECTOR(%d)
);
""" % M)
    for p in pts.get("points",[]):
        f.write("INSERT INTO fp_points(id,floor,lon,lat) VALUES (%s,%s,%s,%s);\n" % (
            repr(p["id"]), repr(str(p.get("floor",""))), float(p["lon"]), float(p["lat"])
        ))
    for p in pts.get("points",[]):
        v = vec_of(p)
        f.write("INSERT INTO fp_sigs(id,vec) VALUES (%s, '%s');\n" % (
            repr(p["id"]), "[" + ",".join(f"{x:.4f}" for x in v) + "]"
        ))
    f.write("""
-- ตัวอย่างคิวรี k-NN (pgvector):
-- SELECT id, l2_distance(vec, '[...]') AS d FROM fp_sigs ORDER BY vec <-> '[...]' LIMIT 5;
-- หรือ
-- SELECT p.*, (s.vec <-> '[...]') AS d FROM fp_sigs s JOIN fp_points p USING(id) ORDER BY s.vec <-> '[...]' LIMIT 5;
""")
print(f"[pgvector] wrote {out}")
