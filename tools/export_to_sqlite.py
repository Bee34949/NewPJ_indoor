# ======================================================================
# File: tools/export_to_sqlite.py
# WHY: แปลง points.json + signatures.json → SQLite (ออฟไลน์ พกไฟล์เดียว)
# Run:  python tools/export_to_sqlite.py --dataset B1-F06 --out data/B1-F06/export.sqlite
# ======================================================================
import json, sqlite3, argparse, math
from pathlib import Path

def load_json(p): return json.loads(Path(p).read_text(encoding="utf-8"))

def ensure_schema(c, dim:int):
    c.executescript(f"""
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS points (
  id TEXT PRIMARY KEY, floor TEXT, lon REAL, lat REAL
);
CREATE TABLE IF NOT EXISTS point_rssi (
  point_id TEXT, bssid TEXT, rssi REAL,
  PRIMARY KEY(point_id,bssid)
);
CREATE TABLE IF NOT EXISTS ap_dict (
  bssid TEXT PRIMARY KEY, idx INTEGER
);
CREATE TABLE IF NOT EXISTS weights_sqrt (
  idx INTEGER PRIMARY KEY, w REAL
);
CREATE TABLE IF NOT EXISTS signatures_vec (
  id TEXT PRIMARY KEY,                        -- point id
  vec TEXT                                    -- JSON string of pre-scaled vector length {dim}
);
""")

def vectorize(p_rssi:dict, ap_dict:dict, fill=-100.0):
    M = len(ap_dict)
    v = [fill]*M
    for b,r in (p_rssi or {}).items():
        i = ap_dict.get(b)
        if i is not None:
            v[i] = float(r)
    return v

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--root", default="data")
    ap.add_argument("--out",  default=None)
    a=ap.parse_args()

    ds = a.dataset
    root = Path(a.root)/ds
    pts = load_json(root/"points.json")
    sig = load_json(root/"signatures.json")

    out = Path(a.out or (root/"export.sqlite"))
    out.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(out))
    c = con.cursor()
    ensure_schema(c, int(sig["dim"]))

    # meta
    c.execute("REPLACE INTO meta(k,v) VALUES(?,?)", ("dataset", ds))
    c.execute("REPLACE INTO meta(k,v) VALUES(?,?)", ("created_at", sig.get("created_at","")))

    # dictionaries
    c.executemany("REPLACE INTO ap_dict(bssid,idx) VALUES(?,?)", sig["ap_dict"].items())
    for i,w in enumerate(sig.get("weights_sqrt", [])):
        c.execute("REPLACE INTO weights_sqrt(idx,w) VALUES(?,?)", (i,float(w)))

    # points
    for p in pts.get("points",[]):
        c.execute("REPLACE INTO points(id,floor,lon,lat) VALUES(?,?,?,?)",
                  (p["id"], str(p.get("floor","")), float(p["lon"]), float(p["lat"])))
        for b,r in (p.get("rssi") or {}).items():
            c.execute("REPLACE INTO point_rssi(point_id,bssid,rssi) VALUES(?,?,?)",
                      (p["id"], b, float(r)))

    # pre-scaled vectors (เพื่อใช้กับ L2)
    apd = sig["ap_dict"]; W = sig.get("weights_sqrt", [])
    for p in pts.get("points",[]):
        v = vectorize(p.get("rssi") or {}, apd)
        vp = [v[i]*(float(W[i]) if i < len(W) else 0.0) for i in range(len(apd))]
        c.execute("REPLACE INTO signatures_vec(id,vec) VALUES(?,?)", (p["id"], json.dumps(vp)))

    con.commit(); con.close()
    print(f"[sqlite] wrote {out}")

if __name__ == "__main__":
    main()
