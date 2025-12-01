# tools/dedup_points.py  —  keep latest per id (or merge median RSSI)
import json, sys
from collections import defaultdict

path_in  = sys.argv[1]  # data/B1-F06/points.json
path_out = sys.argv[2]  # data/B1-F06/points.json (หรือไฟล์ใหม่)

obj = json.load(open(path_in, "r", encoding="utf-8"))
by_id = defaultdict(list)
for p in obj.get("points", []):
    by_id[p["id"]].append(p)

def merge_points(arr):
    if len(arr) == 1: return arr[0]
    # รวม RSSI แบบ median ต่อ BSSID
    from statistics import median
    base = {k:v for k,v in arr[-1].items() if k != "rssi"}
    rssi_all = defaultdict(list)
    for p in arr:
        for b,v in (p.get("rssi") or {}).items():
            rssi_all[b].append(float(v))
    base["rssi"] = {b: float(median(vs)) for b,vs in rssi_all.items()}
    return base

deduped = []
for id_, arr in by_id.items():
    arr.sort(key=lambda p: p.get("stats",{}).get("ts",""))  # ล่าสุดท้ายสุด
    deduped.append(merge_points(arr))

obj["points"] = deduped
json.dump(obj, open(path_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"dedup -> {path_out}: {len(deduped)} points")
