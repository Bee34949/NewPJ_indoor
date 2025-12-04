# ===============================================
# File: tools/offline_scanner.py  (Node-ID ready, improved)
# ===============================================
# Offline Wi-Fi RSSI Collector with Node-ID support
# Added:
#   - --overwrite           replace existing point with same id
#   - --min-aps N           require at least N APs to store a point
#   - --retry-scans N       retry inside a survey if a scan returns empty
#   - survey-batch: --non-interactive, --sleep-before SEC
#   - build-dataset: --export-csv
# Keep: probe, survey, survey-batch, build-dataset, locate
#
# Usage (PowerShell/CMD):
#   python tools/offline_scanner.py probe
#   python tools/offline_scanner.py survey --dataset B1-F06 --id N601 --node-id N601 --nodes data/graph/nodes.geojson --scans 12
#   python tools/offline_scanner.py survey-batch --dataset B1-F06 --nodes data/graph/nodes.geojson --ids N601 N602 N603
#   python tools/offline_scanner.py build-dataset --dataset B1-F06 --export-csv
#   python tools/offline_scanner.py locate --dataset B1-F06 --k 3
import argparse
import csv
import json
import math
import os
import platform
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any

DATA_ROOT = Path("data")
FILL_RSSI: float = -100.0
DEFAULT_SCANS: int = 12
DEFAULT_INTERVAL: float = 0.9

def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")

def write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def norm_bssid(s: str) -> str:
    s = (s or "").strip().lower().replace("-", ":")
    s = re.sub(r"[^0-9a-f:]", "", s)
    parts = [p.zfill(2) for p in s.split(":") if p]
    return ":".join(parts[:6])

def mean(vs: List[float]) -> float:
    return float(sum(vs) / len(vs)) if vs else FILL_RSSI

def median(vs: List[float]) -> float:
    try:
        return float(statistics.median(vs)) if vs else FILL_RSSI
    except statistics.StatisticsError:
        return FILL_RSSI

def _run(cmd: List[str], text: bool = True) -> str:
    return subprocess.check_output(cmd, encoding="utf-8" if text else None, errors="ignore")

# ---------- OS scanners (offline) ----------
def scan_windows(debug_file: Optional[Path] = None) -> List[Tuple[str, int, str]]:
    out = subprocess.check_output(["netsh", "wlan", "show", "networks", "mode=bssid"])
    try:
        chcp = subprocess.check_output(["chcp"], shell=True).decode(errors="ignore")
        cp = re.search(r":\s*(\d+)", chcp)
        enc = f"cp{cp.group(1)}" if cp else "mbcs"
        text = out.decode(enc, errors="ignore")
    except Exception:
        text = out.decode("mbcs", errors="ignore")
    if debug_file:
        debug_file.write_text(text, encoding="utf-8")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    mac_re = re.compile(r"([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})")
    perc_re = re.compile(r"(\d{1,3})\s*%")
    is_ssid = lambda s: bool(re.search(r"\bSSID\b|\u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e04\u0e23\u0e37\u0e2d\u0e02\u0e48\u0e32\u0e22", s, re.I))
    res: List[Tuple[str, int, str]] = []
    current_ssid: Optional[str] = None
    i = 0
    while i < len(lines):
        ln = lines[i]
        if is_ssid(ln):
            m = re.search(r":\s*(.+)$", ln)
            current_ssid = (m.group(1).strip() if m else current_ssid)
            i += 1
            continue
        m_mac = mac_re.search(ln)
        if m_mac:
            bssid = norm_bssid(m_mac.group(1))
            rssi = None
            j = i + 1
            while j < len(lines):
                ln2 = lines[j]
                if mac_re.search(ln2) or is_ssid(ln2):
                    break
                m_perc = perc_re.search(ln2)
                if m_perc:
                    perc = int(m_perc.group(1))
                    rssi = int(round(perc / 2 - 100))
                    break
                j += 1
            if rssi is not None:
                res.append((bssid, rssi, current_ssid or ""))
            i = j
            continue
        i += 1
    return res

def scan_macos(debug_file: Optional[Path] = None) -> List[Tuple[str, int, str]]:
    airport = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
    out = _run([airport, "-s"])
    if debug_file:
        debug_file.write_text(out, encoding="utf-8")
    res: List[Tuple[str, int, str]] = []
    for ln in out.splitlines()[1:]:
        mb = re.search(r"([0-9a-f]{2}(?::[0-9a-f]{2}){5})", ln, re.I)
        mr = re.search(r"\s(-?\d+)\s", ln)
        ms = re.match(r"(.+?)\s{2,}", ln)
        if not (mb and mr and ms):
            continue
        ssid = ms.group(1).strip()
        bssid = norm_bssid(mb.group(1))
        rssi = int(mr.group(1))
        res.append((bssid, rssi, ssid))
    return res

def scan_linux(iface: Optional[str], debug_file: Optional[Path] = None) -> List[Tuple[str, int, str]]:
    try:
        out = _run(["nmcli", "-f", "BSSID,SIGNAL,SSID", "dev", "wifi", "list"])
        if debug_file:
            debug_file.write_text(out, encoding="utf-8")
        res: List[Tuple[str, int, str]] = []
        for ln in out.splitlines():
            if "BSSID" in ln and "SIGNAL" in ln:
                continue
            mb = re.search(r"([0-9A-Fa-f:]{17})", ln)
            if not mb:
                continue
            bssid = norm_bssid(mb.group(1))
            ms = re.search(r"\s(\d{1,3})\s", ln)
            perc = int(ms.group(1)) if ms else 0
            rssi = int(round(perc / 2 - 100))
            parts = ln.split()
            ssid = parts[-1] if parts else ""
            res.append((bssid, rssi, ssid))
        return res
    except Exception:
        pass  # why: fall back to `iw` if nmcli missing
    if not iface:
        try:
            iface = _run(["bash", "-lc", "iw dev | awk '$1==\"Interface\"{print $2; exit}'"]).strip()
        except Exception:
            iface = "wlan0"
    raw = _run(["bash", "-lc", f"iw dev {iface} scan"])
    if debug_file:
        debug_file.write_text(raw, encoding="utf-8")
    res: List[Tuple[str, int, str]] = []
    cur_b = None
    cur_r = None
    for ln in raw.splitlines():
        mb = re.search(r"BSS\s+([0-9A-Fa-f:]{17})", ln)
        if mb:
            cur_b = norm_bssid(mb.group(1))
            cur_r = None
            continue
        mr = re.search(r"signal:\s*(-?\d+\.?\d*)", ln)
        if mr:
            cur_r = int(round(float(mr.group(1))))
            continue
        ms = re.search(r"SSID:\s*(.*)", ln)
        if ms and cur_b is not None:
            ssid = ms.group(1).strip()
            res.append((cur_b, cur_r if cur_r is not None else int(FILL_RSSI), ssid))
            cur_b = cur_r = None
    return res

def do_scan(iface: Optional[str] = None, debug_path: Optional[Path] = None) -> List[Tuple[str, int, str]]:
    sysname = platform.system().lower()
    try:
        if "windows" in sysname:
            return scan_windows(debug_path)
        if "darwin" in sysname:
            return scan_macos(debug_path)
        return scan_linux(iface, debug_path)
    except subprocess.CalledProcessError:
        return []

def apply_filters(
    scans: List[Tuple[str, int, str]],
    ssid_filter: Optional[str],
    bssid_whitelist: Optional[List[str]],
) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for b, r, ssid in scans:
        if ssid_filter and ssid_filter.lower() not in (ssid or "").lower():
            continue
        if bssid_whitelist and b not in bssid_whitelist:
            continue
        out[b] = int(r)
    return out

# ---------- nodes.geojson helpers ----------
def load_nodes_gj(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"nodes.geojson not found: {path}")
    gj = json.loads(path.read_text(encoding="utf-8"))
    m: Dict[str, Dict[str, Any]] = {}
    for f in gj.get("features", []):
        if f.get("geometry", {}).get("type") != "Point":
            continue
        props = f.get("properties", {}) or {}
        nid = str(props.get("id") or props.get("node_id") or props.get("name") or "").strip()
        if not nid:
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        floor = str(props.get("floor") or props.get("level") or "")
        m[nid] = {"id": nid, "lon": float(lon), "lat": float(lat), "floor": floor}
    return m

# ---------- dataset helpers ----------
def load_points(ds_dir: Path) -> List[Dict[str, Any]]:
    return (load_json(ds_dir / "points.json", {"points": []}) or {"points": []}).get("points", [])

def save_points(ds_dir: Path, points: List[Dict[str, Any]]) -> None:
    write_json(ds_dir / "points.json", {"points": points})

def upsert_point(points: List[Dict[str, Any]], rec: Dict[str, Any], overwrite: bool) -> Tuple[List[Dict[str, Any]], bool]:
    for i, p in enumerate(points):
        if p.get("id") == rec.get("id"):
            if overwrite:
                points[i] = rec  # why: replace existing point by id
                return points, True
            return points, False
    points.append(rec)
    return points, True

# ---------- commands ----------
def cmd_probe(args: argparse.Namespace) -> None:
    dbg = Path(args.debug) if args.debug else None
    scans = do_scan(args.iface, dbg)
    if not scans:
        print("⚠️  ไม่พบ AP — เปิด Wi-Fi / อย่าใช้ WSL/VM / ลอง --debug")
        return
    print(f"พบ {len(scans)} APs")
    for b, r, ssid in scans[:80]:
        print(f"{b:17s}  {r:4d} dBm  {ssid}")

def resolve_target(args: argparse.Namespace) -> Tuple[float, float, str, Optional[str]]:
    if args.node_id:
        nodes = load_nodes_gj(Path(args.nodes))
        if args.node_id not in nodes:
            raise SystemExit(f"node '{args.node_id}' not found in {args.nodes}")
        n = nodes[args.node_id]
        return n["lon"], n["lat"], n["floor"], args.node_id
    if args.lon is None or args.lat is None or args.floor is None:
        raise SystemExit("need --node-id or --lon/--lat/--floor")
    return float(args.lon), float(args.lat), str(args.floor), None

def _single_scan_with_retry(
    iface: Optional[str],
    debug_dir: Optional[Path],
    base_id: str,
    idx: int,
    ssid_filter: Optional[str],
    whitelist: Optional[List[str]],
    retry_scans: int,
) -> Dict[str, int]:
    dbg = (debug_dir / f"{base_id}_{idx:03d}.txt") if debug_dir else None
    for attempt in range(1, retry_scans + 1):
        scans = do_scan(iface, dbg)
        sample = apply_filters(scans, ssid_filter, whitelist)
        if sample:
            return sample
        # why: brief pause before retry when no AP seen
        time.sleep(0.35)
    return {}

def cmd_survey(args: argparse.Namespace) -> None:
    ds_dir = DATA_ROOT / args.dataset
    ensure_dir(ds_dir)
    ensure_dir(ds_dir / "raw")
    lon, lat, floor, node_id = resolve_target(args)

    bssid_whitelist = None
    if args.whitelist and Path(args.whitelist).exists():
        bssid_whitelist = [
            norm_bssid(x)
            for x in Path(args.whitelist).read_text(encoding="utf-8").splitlines()
            if x.strip()
        ]

    all_samples: Dict[str, List[int]] = {}
    seen_any = False
    debug_dir = Path(args.debug) if args.debug else None
    if debug_dir:
        ensure_dir(debug_dir)

    for i in range(1, args.scans + 1):
        sample = _single_scan_with_retry(
            iface=args.iface,
            debug_dir=debug_dir,
            base_id=args.id,
            idx=i,
            ssid_filter=args.ssid_filter,
            whitelist=bssid_whitelist,
            retry_scans=args.retry_scans,
        )
        (ds_dir / "raw" / f"{args.id}_{i:03d}.json").write_text(
            json.dumps({"ts": now_iso(), "bssids": sample}, ensure_ascii=False),
            encoding="utf-8",
        )
        for b, v in sample.items():
            all_samples.setdefault(b, []).append(v)
        seen_any = seen_any or bool(sample)
        print(f"[{i}/{args.scans}] seen={len(sample)} APs")
        time.sleep(args.interval)

    if not seen_any:
        print("❌ ไม่เห็น AP เลย → ไม่บันทึกจุดนี้")
        return

    agg = {b: int(median(vs)) for b, vs in all_samples.items()}
    if args.min_aps and len(agg) < args.min_aps:
        print(f"❌ APs ที่ได้ {len(agg)} < --min-aps {args.min_aps} → ไม่บันทึก")
        return

    rec = {
        "id": args.id,
        "label": args.id,
        "floor": str(floor),
        "lon": float(lon),
        "lat": float(lat),
        "rssi": agg,
        "node_id": node_id,
        "stats": {
            "samples": {b: {"n": len(v), "mean": mean(v), "median": median(v)} for b, v in all_samples.items()},
            "ts": now_iso(),
        },
    }

    points = load_points(ds_dir)
    points, ok = upsert_point(points, rec, overwrite=bool(args.overwrite))
    if not ok:
        print(f"⚠️  พบ point id='{args.id}' อยู่แล้ว (ใช้ --overwrite เพื่อแทนที่)")
        return

    save_points(ds_dir, points)
    (ds_dir / "records.jsonl").open("a", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"✅ บันทึกแล้ว → {ds_dir/'points.json'}  (APs={len(agg)})  node_id={node_id or '-'}  overwrite={bool(args.overwrite)}")

def cmd_survey_batch(args: argparse.Namespace) -> None:
    if not args.ids and not args.ids_file:
        raise SystemExit("need --ids ... or --ids-file file.txt")
    ids: List[str] = list(args.ids or [])
    if args.ids_file:
        ids += [ln.strip() for ln in Path(args.ids_file).read_text(encoding="utf-8").splitlines() if ln.strip()]
    nodes = load_nodes_gj(Path(args.nodes))
    todo = [nid for nid in ids if nid in nodes]
    missing = [nid for nid in ids if nid not in nodes]
    if missing:
        print(f"⚠️  not in nodes.geojson: {', '.join(missing)}")

    for i, nid in enumerate(todo, 1):
        n = nodes[nid]
        if args.non_interactive:
            if args.sleep_before > 0:
                print(f"[{i}/{len(todo)}] ไปที่ {nid} (F{n['floor']}) เริ่มใน {args.sleep_before:.1f}s ...")
                time.sleep(args.sleep_before)
        else:
            input(f"[{i}/{len(todo)}] ไปที่ {nid} (F{n['floor']}) แล้วกด Enter เพื่อเริ่มเก็บ ...")

        ns = argparse.Namespace(
            dataset=args.dataset,
            id=nid,
            floor=n["floor"],
            lon=n["lon"],
            lat=n["lat"],
            scans=args.scans,
            interval=args.interval,
            ssid_filter=args.ssid_filter,
            whitelist=args.whitelist,
            iface=args.iface,
            debug=args.debug,
            node_id=nid,
            nodes=args.nodes,
            overwrite=args.overwrite,
            min_aps=args.min_aps,
            retry_scans=args.retry_scans,
        )
        cmd_survey(ns)

def cmd_build(args: argparse.Namespace) -> None:
    ds_dir = DATA_ROOT / args.dataset
    points = load_points(ds_dir)
    if not points:
        print("❌ ยังไม่มีจุดใน points.json — รัน survey ก่อน")
        return

    # unique APs + index
    ap_set = set()
    for p in points:
        for b in p["rssi"].keys():
            ap_set.add(norm_bssid(b))
    aps = sorted(ap_set)
    ap_idx = {b: i for i, b in enumerate(aps)}
    M = len(aps)

    # compute weights from variance (lower variance → higher weight)
    vals: Dict[str, List[float]] = {b: [] for b in aps}
    for p in points:
        for b in aps:
            vals[b].append(p["rssi"].get(b, FILL_RSSI))

    def variance(x: List[float]) -> float:
        xs = [v for v in x if v > FILL_RSSI]
        return statistics.pvariance(xs) if xs else 1.0

    sqrt_w = [1.0 / max(math.sqrt(variance(vals[b])), 1e-3) for b in aps]

    out = {
        "dataset": args.dataset,
        "dim": M,
        "ap_dict": ap_idx,
        "weights_sqrt": sqrt_w,
        "points": [
            {
                "id": p["id"],
                "label": p.get("label", p["id"]),
                "floor": str(p["floor"]),
                "lon": float(p["lon"]),
                "lat": float(p["lat"]),
                "rssi": {norm_bssid(b): float(v) for b, v in p["rssi"].items()},
                "node_id": p.get("node_id"),
            }
            for p in points
        ],
        "created_at": now_iso(),
    }
    write_json(ds_dir / "signatures.json", out)
    print(f"✅ สร้าง signatures.json แล้ว → {ds_dir/'signatures.json'}  (dim={M}, points={len(points)})")

    if args.export_csv:
        csv_path = ds_dir / "signatures_points.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "label", "floor", "lon", "lat", "node_id", "ap_count"])
            for p in points:
                w.writerow([p["id"], p.get("label", p["id"]), p["floor"], p["lon"], p["lat"], p.get("node_id", ""), len(p["rssi"])])
        print(f"✅ export CSV → {csv_path}")

def _vectorize(sig: Dict[str, Any], scan_map: Dict[str, int]) -> List[float]:
    ap_idx = sig["ap_dict"]
    w = sig["weights_sqrt"]
    M = sig["dim"]
    X = [FILL_RSSI] * M
    for b, r in scan_map.items():
        j = ap_idx.get(norm_bssid(b))
        if j is not None:
            X[j] = float(r)
    return [X[j] * w[j] for j in range(M)]

def _dist_l2(a: List[float], b: List[float]) -> float:
    return math.sqrt(sum((ai - bi) ** 2 for ai, bi in zip(a, b)))

def cmd_locate(args: argparse.Namespace) -> None:
    ds_dir = DATA_ROOT / args.dataset
    sig = load_json(ds_dir / "signatures.json")
    if not sig:
        print("❌ ไม่มี signatures.json — run build-dataset ก่อน")
        return
    scans = do_scan(args.iface, Path(args.debug) if args.debug else None)
    if not scans:
        print("⚠️  สแกนไม่พบ AP — ตรวจ Wi-Fi/สิทธิ์ และลอง --debug")
        return
    sample = apply_filters(scans, args.ssid_filter, None)
    if not sample:
        print("⚠️  ผ่าน filter แล้วว่างเปล่า — ลองไม่ใส่ --ssid-filter")
        return
    X = _vectorize(sig, sample)

    def prescale(vec: Dict[str, float]) -> List[float]:
        V = [FILL_RSSI] * sig["dim"]
        ap = sig["ap_dict"]
        w = sig["weights_sqrt"]
        for b, j in ap.items():
            V[j] = float(vec.get(b, FILL_RSSI)) * w[j]
        return V

    cands: List[Tuple[float, Dict[str, Any]]] = []
    for p in sig["points"]:
        S = prescale(p["rssi"])
        d = _dist_l2(X, S)
        cands.append((d, p))
    cands.sort(key=lambda x: x[0])
    top = cands[: args.k]

    eps = 1e-6
    wx = wy = ws = 0.0
    for d, p in top:
        wgt = 1 / (d + eps)  # why: inverse distance weighting softens outliers
        wx += p["lon"] * wgt
        wy += p["lat"] * wgt
        ws += wgt
    est = {"lon": wx / ws, "lat": wy / ws, "floor": top[0][1]["floor"], "node_id": top[0][1].get("node_id")}
    print("neighbors:")
    for d, p in top:
        print(f"  {p['id']}  F{p['floor']}  node={p.get('node_id') or '-'}  d={d:.3f}")
    print(f"→ estimate: ({est['lon']:.6f},{est['lat']:.6f})  floor F{est['floor']}  node≈{est['node_id'] or '-'}")

def main() -> None:
    ap = argparse.ArgumentParser(description="Offline Wi-Fi RSSI Collector (with Node-ID)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="สแกน 1 ครั้ง (ตรวจว่าเห็น AP)")
    p.add_argument("--iface")
    p.add_argument("--debug", help="โฟลเดอร์เก็บ raw output")
    p.set_defaults(func=cmd_probe)

    s = sub.add_parser("survey", help="เก็บจุดเดียว หลายสแกน (รองรับ --node-id)")
    s.add_argument("--dataset", required=True)
    s.add_argument("--id", required=True)
    s.add_argument("--floor")
    s.add_argument("--lon", type=float)
    s.add_argument("--lat", type=float)
    s.add_argument("--node-id")
    s.add_argument("--nodes", default="data/graph/nodes.geojson")
    s.add_argument("--scans", type=int, default=DEFAULT_SCANS)
    s.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    s.add_argument("--ssid-filter")
    s.add_argument("--whitelist")
    s.add_argument("--iface")
    s.add_argument("--debug")
    s.add_argument("--overwrite", action="store_true", help="แทนที่ point id เดิมหากซ้ำ")
    s.add_argument("--min-aps", type=int, default=0, help="ขั้นต่ำจำนวน AP ที่ต้องเห็นเพื่อบันทึก")
    s.add_argument("--retry-scans", type=int, default=1, help="จำนวนครั้ง retry ในแต่ละสแกนเมื่อว่างเปล่า")
    s.set_defaults(func=cmd_survey)

    sb = sub.add_parser("survey-batch", help="เก็บหลาย Node IDs ทีละจุด")
    sb.add_argument("--dataset", required=True)
    sb.add_argument("--nodes", default="data/graph/nodes.geojson")
    sb.add_argument("--ids", nargs="*")
    sb.add_argument("--ids-file")
    sb.add_argument("--scans", type=int, default=DEFAULT_SCANS)
    sb.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    sb.add_argument("--ssid-filter")
    sb.add_argument("--whitelist")
    sb.add_argument("--iface")
    sb.add_argument("--debug")
    sb.add_argument("--overwrite", action="store_true")
    sb.add_argument("--min-aps", type=int, default=0)
    sb.add_argument("--retry-scans", type=int, default=1)
    sb.add_argument("--non-interactive", action="store_true", help="รันต่อเนื่องไม่ต้องกด Enter")
    sb.add_argument("--sleep-before", type=float, default=0.0, help="หน่วงเวลาก่อนเริ่มแต่ละ node (วินาที)")
    sb.set_defaults(func=cmd_survey_batch)

    b = sub.add_parser("build-dataset", help="รวม → signatures.json (พก node_id ไปด้วย)")
    b.add_argument("--dataset", required=True)
    b.add_argument("--export-csv", action="store_true", help="export สรุปจุดเป็น CSV เพิ่มเติม")
    b.set_defaults(func=cmd_build)

    l = sub.add_parser("locate", help="คำนวณตำแหน่งสดจาก signatures.json")
    l.add_argument("--dataset", required=True)
    l.add_argument("--k", type=int, default=3)
    l.add_argument("--ssid-filter")
    l.add_argument("--iface")
    l.add_argument("--debug")
    l.set_defaults(func=cmd_locate)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
