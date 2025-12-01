# ============================
# file: tools/scan_server.py
# ============================
# Minimal offline scan server (HTTP) -> /scan.json คืน {bssid:rssi,...}
# ใช้ได้บน Windows/macOS/Linux ไม่ต้องติดตั้งแพ็กเกจเพิ่ม
# รัน:  python tools/scan_server.py --port 8765  (แนะนำ PowerShell/CMD บน Windows)
import argparse, json, platform, re, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

FILL = -100

def norm_bssid(s: str) -> str:
    import re
    s = (s or "").strip().lower().replace('-', ':')
    s = re.sub(r'[^0-9a-f:]', '', s)
    parts = [p.zfill(2) for p in s.split(':') if p]
    return ':'.join(parts[:6])

def scan_windows():
    out = subprocess.check_output(["netsh","wlan","show","networks","mode=bssid"])
    try:
        ch = subprocess.check_output(["chcp"], shell=True).decode(errors="ignore")
        import re
        cp = re.search(r":\s*(\d+)", ch)
        enc = f"cp{cp.group(1)}" if cp else "mbcs"
        text = out.decode(enc, errors="ignore")
    except Exception:
        text = out.decode("mbcs", errors="ignore")

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    mac_re = re.compile(r"([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})")
    perc_re = re.compile(r"(\d{1,3})\s*%")

    scans = {}
    i=0
    while i < len(lines):
        ln = lines[i]
        m = mac_re.search(ln)
        if m:
            bssid = norm_bssid(m.group(1))
            rssi = None; j=i+1
            while j < len(lines):
                ln2 = lines[j]
                if mac_re.search(ln2): break
                mp = perc_re.search(ln2)
                if mp:
                    perc = int(mp.group(1))
                    rssi = int(round(perc/2 - 100))
                    break
                j+=1
            if rssi is not None: scans[bssid]=rssi
            i=j; continue
        i+=1
    return scans

def scan_macos():
    airport="/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
    out = subprocess.check_output([airport,"-s"], encoding="utf-8", errors="ignore")
    scans={}
    for ln in out.splitlines()[1:]:
        mb=re.search(r"([0-9a-f]{2}(?::[0-9a-f]{2}){5})", ln, re.I)
        mr=re.search(r"\s(-?\d+)\s", ln)
        if mb and mr: scans[norm_bssid(mb.group(1))]=int(mr.group(1))
    return scans

def scan_linux():
    try:
        out = subprocess.check_output(["nmcli","-f","BSSID,SIGNAL","dev","wifi","list"], encoding="utf-8", errors="ignore")
        scans={}
        for ln in out.splitlines():
            mb=re.search(r"([0-9A-Fa-f:]{17})", ln)
            if not mb: continue
            b=norm_bssid(mb.group(1))
            ms=re.search(r"\s(\d{1,3})\s", ln)
            perc=int(ms.group(1)) if ms else 0
            scans[b]=int(round(perc/2 - 100))
        return scans
    except Exception:
        pass
    # fallback iw
    try:
        import subprocess
        iface = subprocess.check_output(["bash","-lc","iw dev | awk '$1==\"Interface\"{print $2; exit}'"], encoding="utf-8").strip() or "wlan0"
        raw = subprocess.check_output(["bash","-lc", f"iw dev {iface} scan"], encoding="utf-8", errors="ignore")
        scans={}
        cur_b=None; cur_r=None
        for ln in raw.splitlines():
            mb=re.search(r"BSS\s+([0-9A-Fa-f:]{17})", ln)
            if mb: cur_b=norm_bssid(mb.group(1)); continue
            mr=re.search(r"signal:\s*(-?\d+\.?\d*)", ln)
            if mr and cur_b: scans[cur_b]=int(round(float(mr.group(1))))
        return scans
    except Exception:
        return {}

def do_scan():
    sys=platform.system().lower()
    if "windows" in sys: return scan_windows()
    if "darwin" in sys:  return scan_macos()
    return scan_linux()

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, data, mime="application/json"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Type", mime)
        self.end_headers()
        self.wfile.write(data.encode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/scan.json"):
            scans = do_scan()
            self._send(200, json.dumps(scans, ensure_ascii=False))
        else:
            self._send(200, json.dumps({"ok": True, "hint": "/scan.json"}))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[scan_server] http://127.0.0.1:{args.port}/scan.json  (Ctrl+C to stop)")
    srv.serve_forever()

if __name__ == "__main__":
    main()


