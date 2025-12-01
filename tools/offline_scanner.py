# File: tools/offline_scanner.py
# Purpose: เก็บ Wi-Fi RSSI แบบออฟไลน์ 100% → บันทึกไฟล์ในเครื่อง → รวมชุดข้อมูลภายหลัง
# Usage (PowerShell/Terminal):
#   python tools/offline_scanner.py probe
#   python tools/offline_scanner.py survey --dataset B1-F06 --id N601 --floor 06 --lon 100.5009 --lat 13.7564 --scans 12 --interval 0.9
#   python tools/offline_scanner.py build-dataset --dataset B1-F06
#   python tools/offline_scanner.py locate --dataset B1-F06 --k 3

import argparse, json, math, os, platform, re, statistics, subprocess, time
from pathlib import Path
from typing import Dict, List, Tuple, Optional

# ---------- Config (ออฟไลน์ล้วน) ----------
DATA_ROOT = Path("data")
FILL_RSSI = -100.0
DEFAULT_SCANS = 12
DEFAULT_INTERVAL = 0.9

# ---------- I/O ----------
def ensure_dir(p: Path): p.mkdir(parents=True, exist_ok=True)
def now_iso(): return time.strftime("%Y-%m-%dT%H:%M:%S")
def write_json(path: Path, obj): path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
def load_json(path: Path, default=None):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception: return default

# ---------- helpers ----------
def norm_bssid(s: str)->str:
    s = (s or "").strip().lower().replace('-', ':')
    s = re.sub(r'[^0-9a-f:]', '', s)
    parts = [p.zfill(2) for p in s.split(':') if p]
    return ':'.join(parts[:6])

def mean(vs): return float(sum(vs)/len(vs)) if vs else FILL_RSSI
def median(vs):
    try: return float(statistics.median(vs)) if vs else FILL_RSSI
    except statistics.StatisticsError: return FILL_RSSI

def _run(cmd: List[str], text=True):
    return subprocess.check_output(cmd, encoding="utf-8" if text else None, errors="ignore")

# ---------- OS scanners (ออฟไลน์/ไม่ใช้อินเทอร์เน็ต) ----------
def scan_windows(debug_file: Optional[Path]=None)->List[Tuple[str,int,str]]:
    out = subprocess.check_output(["netsh","wlan","show","networks","mode=bssid"])
    # พยายามถอดรหัสตาม codepage ปัจจุบัน (รองรับข้อความไทย)
    try:
        chcp = subprocess.check_output(["chcp"], shell=True).decode(errors="ignore")
        cp = re.search(r":\s*(\d+)", chcp)
        enc = f"cp{cp.group(1)}" if cp else "mbcs"
        text = out.decode(enc, errors="ignore")
    except Exception:
        text = out.decode("mbcs", errors="ignore")
    if debug_file: debug_file.write_text(text, encoding="utf-8")

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    def is_ssid_line(s): return bool(re.search(r"\bSSID\b|\u0e0a\u0e37\u0e48\u0e2d\u0e40\u0e04\u0e23\u0e37\u0e2d\u0e02\u0e48\u0e32\u0e22", s, re.I))
    mac_re = re.compile(r"([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})")
    perc_re = re.compile(r"(\d{1,3})\s*%")

    res=[]; current_ssid=None; i=0
    while i < len(lines):
        ln = lines[i]
        if is_ssid_line(ln):
            m = re.search(r":\s*(.+)$", ln); current_ssid = (m.group(1).strip() if m else current_ssid)
            i += 1; continue
        m_mac = mac_re.search(ln)
        if m_mac:
            bssid = norm_bssid(m_mac.group(1)); rssi=None; j=i+1
            while j < len(lines):
                ln2 = lines[j]
                if mac_re.search(ln2) or is_ssid_line(ln2): break
                m_perc = perc_re.search(ln2)
                if m_perc:
                    perc = int(m_perc.group(1))
                    rssi = int(round(perc/2 - 100))
                    break
                j += 1
            if rssi is not None:
                res.append((bssid, rssi, current_ssid or ""))
            i = j; continue
        i += 1
    return res

def scan_macos(debug_file: Optional[Path]=None)->List[Tuple[str,int,str]]:
    airport="/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
    out = _run([airport,"-s"])
    if debug_file: debug_file.write_text(out, encoding="utf-8")
    res=[]
    for ln in out.splitlines()[1:]:
        mb=re.search(r"([0-9a-f]{2}(?::[0-9a-f]{2}){5})", ln, re.I)
        mr=re.search(r"\s(-?\d+)\s", ln); ms=re.match(r"(.+?)\s{2,}", ln)
        if not (mb and mr and ms): continue
        ssid=ms.group(1).strip(); bssid=norm_bssid(mb.group(1)); rssi=int(mr.group(1))
        res.append((bssid,rssi,ssid))
    return res

def scan_linux(iface: Optional[str], debug_file: Optional[Path]=None)->List[Tuple[str,int,str]]:
    # nmcli ก่อน (ไม่ต้องเน็ต, ต้องมี NetworkManager)
    try:
        out = _run(["nmcli","-f","BSSID,SIGNAL,SSID","dev","wifi","list"])
        if debug_file: debug_file.write_text(out, encoding="utf-8")
        res=[]
        for ln in out.splitlines():
            if "BSSID" in ln and "SIGNAL" in ln: continue
            mb=re.search(r"([0-9A-Fa-f:]{17})", ln)
            if not mb: continue
            bssid=norm_bssid(mb.group(1))
            ms=re.search(r"\s(\d{1,3})\s", ln)
            perc=int(ms.group(1)) if ms else 0
            rssi=int(round(perc/2 - 100))
            ssid = ln.split()[-1] if ln.split() else ""
            res.append((bssid,rssi,ssid))
        return res
    except Exception:
        pass
    # fallback iw (สิทธิ์สูง)
    if not iface:
        try:
            iface = _run(["bash","-lc","iw dev | awk '$1==\"Interface\"{print $2; exit}'"]).strip()
        except Exception:
            iface = "wlan0"
    raw = _run(["bash","-lc", f"iw dev {iface} scan"])
    if debug_file: debug_file.write_text(raw, encoding="utf-8")
    res=[]; cur_b=None; cur_r=None; cur_s=None
    for ln in raw.splitlines():
        mb=re.search(r"BSS\s+([0-9A-Fa-f:]{17})", ln)
        if mb: cur_b=norm_bssid(mb.group(1)); continue
        mr=re.search(r"signal:\s*(-?\d+\.?\d*)", ln)
        if mr: cur_r=int(round(float(mr.group(1)))); continue
        ms=re.search(r"SSID:\s*(.*)", ln)
        if ms and cur_b is not None:
            cur_s=ms.group(1).strip()
            res.append((cur_b, cur_r if cur_r is not None else int(FILL_RSSI), cur_s))
            cur_b=cur_r=cur_s=None
    return res

def do_scan(iface=None, debug_path: Optional[Path]=None):
    sysname=platform.system().lower()
    try:
        if "windows" in sysname: return scan_windows(debug_path)
        if "darwin"  in sysname: return scan_macos(debug_path)
        return scan_linux(iface, debug_path)
    except subprocess.CalledProcessError:
        return []

# ---------- filters ----------
def apply_filters(scans, ssid_filter, bssid_whitelist):
    out={}
    for b,r,ssid in scans:
        if ssid_filter and ssid_filter.lower() not in (ssid or "").lower(): 
            continue
        if bssid_whitelist and b not in bssid_whitelist:
            continue
        out[b]=int(r)
    return out

# ---------- commands ----------
def cmd_probe(args):
    dbg = Path(args.debug) if args.debug else None
    scans = do_scan(args.iface, dbg)
    if not scans:
        print("⚠️  ไม่พบ AP — เปิด Wi-Fi, หลีกเลี่ยง WSL/VM, ใช้ PowerShell/CMD/Terminal ของ OS จริง, ลอง --debug")
        return
    print(f"พบ {len(scans)} APs")
    for b,r,ssid in scans[:60]:
        print(f"{b:17s}  {r:4d} dBm  {ssid}")

def cmd_survey(args):
    ds_dir = DATA_ROOT/args.dataset; ensure_dir(ds_dir); ensure_dir(ds_dir/"raw")
    bssid_whitelist=None
    if args.whitelist and Path(args.whitelist).exists():
        bssid_whitelist=[norm_bssid(x) for x in Path(args.whitelist).read_text(encoding="utf-8").splitlines() if x.strip()]
    all_samples={}; seen_any=False
    debug_dir = Path(args.debug) if args.debug else None

    for i in range(args.scans):
        dbg = (debug_dir/f"{args.id}_{i+1:03d}.txt") if debug_dir else None
        scans = do_scan(args.iface, dbg)
        sample = apply_filters(scans, args.ssid_filter, bssid_whitelist)
        if sample: seen_any=True
        (ds_dir/"raw"/f"{args.id}_{i+1:03d}.json").write_text(json.dumps({"ts":now_iso(),"bssids":sample},ensure_ascii=False),encoding="utf-8")
        for b,v in sample.items(): all_samples.setdefault(b,[]).append(v)
        print(f"[{i+1}/{args.scans}] seen={len(sample)} APs")
        time.sleep(args.interval)

    if not seen_any:
        print("❌ ไม่เห็น AP เลย → ไม่บันทึกจุดนี้ (ออฟไลน์โอเค แต่ต้องเปิด Wi-Fi/สิทธิ์สแกน)")
        return

    agg = { b:int(median(vs)) for b,vs in all_samples.items() }
    rec = {
        "id": args.id, "label": args.id, "floor": str(args.floor),
        "lon": float(args.lon), "lat": float(args.lat),
        "rssi": agg,
        "stats": {
            "samples": { b: {"n":len(v),"mean":mean(v),"median":median(v)} for b,v in all_samples.items() },
            "ts": now_iso()
        }
    }
    arr = load_json(ds_dir/"points.json", {"points":[]}); arr["points"].append(rec); write_json(ds_dir/"points.json", arr)
    (ds_dir/"records.jsonl").open("a",encoding="utf-8").write(json.dumps(rec,ensure_ascii=False)+"\n")
    print(f"✅ บันทึกแล้ว → {ds_dir/'points.json'}  (APs={len(agg)})")

def cmd_build(args):
    ds_dir = DATA_ROOT/args.dataset
    points = load_json(ds_dir/"points.json", {"points":[]}).get("points",[])
    if not points:
        print("❌ ยังไม่มีจุดใน points.json — รัน survey ก่อน")
        return

    # รวม AP ทั้งหมด + index
    ap_set=set()
    for p in points:
        for b in p["rssi"].keys(): ap_set.add(norm_bssid(b))
    aps=sorted(ap_set); ap_idx={b:i for i,b in enumerate(aps)}; M=len(aps)

    # สถิติ variance ต่อ AP (เพื่อถ่วงน้ำหนัก)
    vals={b:[] for b in aps}
    for p in points:
        for b in aps: vals[b].append(p["rssi"].get(b, FILL_RSSI))
    def variance(x):
        xs=[v for v in x if v>FILL_RSSI]
        return statistics.pvariance(xs) if xs else 1.0
    sqrt_w=[ 1.0/max(math.sqrt(variance(vals[b])), 1e-3) for b in aps ]

    out={
        "dataset": args.dataset,
        "dim": M,
        "ap_dict": ap_idx,
        "weights_sqrt": sqrt_w,
        "points": [ {"id":p["id"],"label":p.get("label",p["id"]),"floor":p["floor"],"lon":p["lon"],"lat":p["lat"],"rssi":p["rssi"]} for p in points ],
        "created_at": now_iso()
    }
    write_json(ds_dir/"signatures.json", out)
    print(f"✅ สร้าง signatures.json แล้ว → {ds_dir/'signatures.json'}  (dim={M}, points={len(points)})")

# ----- offline locate (ออฟไลน์/ไม่ต้องเน็ต) -----
def _vectorize(sig, scan_map):
    ap_idx = sig["ap_dict"]; w = sig["weights_sqrt"]; M = sig["dim"]
    X=[FILL_RSSI]*M
    for b,r in scan_map.items():
        j = ap_idx.get(norm_bssid(b))
        if j is not None: X[j]=float(r)
    return [ X[j]*w[j] for j in range(M) ]  # pre-scale √w

def _dist_l2(a,b): return math.sqrt(sum((ai-bi)**2 for ai,bi in zip(a,b)))

def cmd_locate(args):
    ds_dir = DATA_ROOT/args.dataset
    sig = load_json(ds_dir/"signatures.json")
    if not sig:
        print("❌ ไม่มี signatures.json — run build-dataset ก่อน"); return
    scans = do_scan(args.iface, Path(args.debug) if args.debug else None)
    if not scans:
        print("⚠️  สแกนไม่พบ AP — ตรวจ Wi-Fi/สิทธิ์ และลอง --debug"); return
    sample = apply_filters(scans, args.ssid_filter, None)
    if not sample:
        print("⚠️  ผ่าน filter แล้วว่างเปล่า — ลองไม่ใส่ --ssid-filter"); return

    X = _vectorize(sig, sample)
    aps = sig["ap_dict"]; W = sig["weights_sqrt"]

    def prescale(vec):  # สร้าง S' ของแต่ละจุด
        V=[FILL_RSSI]*sig["dim"]
        for b,j in aps.items():
            V[j] = float(vec.get(b, FILL_RSSI))*W[j]
        return V

    cands=[]
    for p in sig["points"]:
        S = prescale(p["rssi"])
        d = _dist_l2(X,S)
        cands.append((d,p))
    cands.sort(key=lambda x:x[0])
    top = cands[:args.k]

    # ถัวเฉลี่ยพิกัดด้วย 1/(d+eps)
    eps=1e-6; wx=wy=ws=0.0
    for d,p in top:
        w = 1/(d+eps); wx += p["lon"]*w; wy += p["lat"]*w; ws += w
    est = {"lon": wx/ws, "lat": wy/ws, "floor": top[0][1]["floor"]}
    print("neighbors:")
    for d,p in top:
        print(f"  {p['id']}  F{p['floor']}  d={d:.3f}  ({p['lon']:.6f},{p['lat']:.6f})")
    print(f"→ estimate: ({est['lon']:.6f},{est['lat']:.6f})  floor F{est['floor']}")

# ---------- CLI ----------
def main():
    ap = argparse.ArgumentParser(description="Offline Wi-Fi RSSI Collector (no Internet needed)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="สแกน 1 ครั้ง (ตรวจว่าเห็น AP)")
    p.add_argument("--iface"); p.add_argument("--debug", help="โฟลเดอร์บันทึก output ดิบ")
    p.set_defaults(func=cmd_probe)

    s = sub.add_parser("survey", help="เก็บที่จุดเดียว หลายสแกน ออฟไลน์ 100%")
    s.add_argument("--dataset", required=True); s.add_argument("--id", required=True)
    s.add_argument("--floor", required=True); s.add_argument("--lon", type=float, required=True); s.add_argument("--lat", type=float, required=True)
    s.add_argument("--scans", type=int, default=DEFAULT_SCANS); s.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    s.add_argument("--ssid-filter"); s.add_argument("--whitelist"); s.add_argument("--iface"); s.add_argument("--debug")
    s.set_defaults(func=cmd_survey)

    b = sub.add_parser("build-dataset", help="รวม → signatures.json (พร้อมคำนวณ)")
    b.add_argument("--dataset", required=True)
    b.set_defaults(func=cmd_build)

    l = sub.add_parser("locate", help="คำนวณตำแหน่งสดแบบออฟไลน์จาก signatures.json")
    l.add_argument("--dataset", required=True); l.add_argument("--k", type=int, default=3)
    l.add_argument("--ssid-filter"); l.add_argument("--iface"); l.add_argument("--debug")
    l.set_defaults(func=cmd_locate)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
