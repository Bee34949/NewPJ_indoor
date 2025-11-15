# FILE: tools/build_floor3_to_outdirs.py
# IndoorGML (.xml/.gml) -> out_json/* + out_csv/floor3_graph_csv.zip  (Floor 3 เท่านั้น, ไม่พึ่งสคริปต์อื่น)
from __future__ import annotations
import argparse, csv, json, math, re, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def _iter_local(root: ET.Element, local: str):
    q = f"}}{local}"
    for el in root.iter():
        if el.tag == local or (isinstance(el.tag, str) and el.tag.endswith(q)):
            yield el

def _first_local(parent: ET.Element, local: str):
    for el in _iter_local(parent, local):
        return el
    return None

def _text(el): return (el.text or "").strip() if el is not None else ""
def _fnum(s, d=0.0):
    try: return float(s)
    except: return float(d)
def _parse_state_id(gid: str):
    m = re.match(r"^state_(\d+)_(.+)$", gid or ""); 
    return (int(m.group(1)), m.group(2)) if m else (None, None)
def _euclid(a, b): return math.hypot(a["x"]-b["x"], a["y"]-b["y"])
def _load_root(p: Path):
    try: return ET.parse(p).getroot()
    except ET.ParseError as e: raise SystemExit(f"XML parse error: {e}")

def convert(gml_path: Path, jsondir: Path, csvdir: Path, default_floor: int, force: bool):
    root = _load_root(gml_path)
    nodes3: dict[str, dict] = {}
    edges3: list[dict] = []

    # States (keep floor 3)
    for st in _iter_local(root, "State"):
        gid = st.get("{http://www.opengis.net/gml/3.2}id") or st.get("gml:id") or st.get("id") or ""
        fl_from_id, nid_guess = _parse_state_id(gid)
        name = _text(_first_local(st, "name")) or (nid_guess or "")
        desc = _text(_first_local(st, "description"))
        meta = {}
        if desc:
            try: meta = json.loads(desc)
            except: meta = {}
        floor = int(meta.get("floor", fl_from_id or default_floor))
        if floor != 3: 
            continue
        pos = _first_local(st, "pos")
        coords = _text(pos).split() if pos is not None else []
        x = _fnum(coords[0], 0.0) if len(coords)>=1 else 0.0
        y = _fnum(coords[1], 0.0) if len(coords)>=2 else 0.0
        nid = (nid_guess or name or f"N{x:.0f}_{y:.0f}").strip()
        ntype = str(meta.get("type", "room"))
        nodes3[nid] = {"x": x, "y": y, "name": name or nid, "type": ntype, "floor": 3}

    # Transitions (same-floor=3)
    for tr in _iter_local(root, "Transition"):
        hrefs=[]
        for c in _iter_local(tr, "connects"):
            h = c.get("{http://www.w3.org/1999/xlink}href") or c.get("xlink:href") or c.get("href") or ""
            if h: hrefs.append(h.replace("#",""))
        if len(hrefs)<2: continue
        a_f,a_id=_parse_state_id(hrefs[0]); b_f,b_id=_parse_state_id(hrefs[1])
        if not a_id or not b_id: continue
        if int(a_f or default_floor)!=3 or int(b_f or default_floor)!=3: continue
        a=nodes3.get(a_id); b=nodes3.get(b_id)
        if not a or not b: continue
        edges3.append({"from":a_id,"to":b_id,"weight":round(_euclid(a,b),3)})

    # JSON out
    jsondir.mkdir(parents=True, exist_ok=True)
    def dump_json(p: Path, obj):
        if p.exists() and not force: return
        p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    dump_json(jsondir/"nodes_floor3.json", {"nodes": nodes3})
    dump_json(jsondir/"edges_floor3.json", {"edges": edges3})
    dump_json(jsondir/"graph_floor3.json", {"floor":3,"nodes":[{"id":k,**v} for k,v in nodes3.items()],"edges":edges3})

    # CSV out -> zip
    csvdir.mkdir(parents=True, exist_ok=True)
    nodes_csv = csvdir/"nodes_floor3.csv"
    edges_csv = csvdir/"edges_floor3.csv"
    def dump_csv(path: Path, headers, rows):
        if path.exists() and not force: return
        import csv
        with path.open("w", newline="", encoding="utf-8") as f:
            w=csv.writer(f); w.writerow(headers); w.writerows(rows)
    dump_csv(nodes_csv, ["id","x","y","name","type","floor"], [[nid,n["x"],n["y"],n["name"],n["type"],n["floor"]] for nid,n in nodes3.items()])
    dump_csv(edges_csv, ["from","to","weight"], [[e["from"],e["to"],e["weight"]] for e in edges3])

    zip_path = csvdir/"floor3_graph_csv.zip"
    if zip_path.exists() and force: zip_path.unlink()
    if not zip_path.exists():
        with zipfile.ZipFile(zip_path,"w",compression=zipfile.ZIP_DEFLATED) as z:
            z.write(nodes_csv, arcname=nodes_csv.name)
            z.write(edges_csv, arcname=edges_csv.name)
    return {"nodes":len(nodes3),"edges":len(edges3),"jsondir":str(jsondir),"csvzip":str(zip_path)}

def main():
    ap=argparse.ArgumentParser(description="IndoorGML (.xml/.gml) -> out_json & out_csv (Floor 3).")
    ap.add_argument("--gml", required=True, help="path to input (.xml/.gml)")
    ap.add_argument("--jsondir", default="out_json")
    ap.add_argument("--csvdir",  default="out_csv")
    ap.add_argument("--default-floor", type=int, default=3)
    ap.add_argument("--force", action="store_true")
    args=ap.parse_args()

    in_path=Path(args.gml); 
    if not in_path.is_absolute(): in_path=(Path.cwd()/in_path).resolve()
    if not in_path.exists(): raise SystemExit(f"XML/GML not found: {in_path}")

    jsondir=Path(args.jsondir); 
    if not jsondir.is_absolute(): jsondir=(Path.cwd()/jsondir).resolve()
    csvdir=Path(args.csvdir); 
    if not csvdir.is_absolute(): csvdir=(Path.cwd()/csvdir).resolve()

    out=convert(in_path,jsondir,csvdir,args.default_floor,args.force)
    print("==> Done")
    print(f"JSON out : {out['jsondir']}")
    print(f"CSV  zip : {out['csvzip']}")
    print(f"Nodes    : {out['nodes']}")
    print(f"Edges    : {out['edges']}")

if __name__=="__main__":
    main()


