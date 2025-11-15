from __future__ import annotations
import csv
from pathlib import Path
from .models import Dataset, Floor, Node, Edge, gen_id, NodeType
def load_csv(floors_csv: Path, nodes_csv: Path, edges_csv: Path) -> Dataset:
    ds = Dataset.new()
    with open(floors_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            fid = r.get("id") or gen_id()
            ds.floors[fid] = Floor(id=fid, name=r["name"], level=int(r["level"]))
    with open(nodes_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            nid = r.get("id") or gen_id()
            nt: NodeType = r["type"] if r["type"] in {"corridor","door","room","connector"} else "corridor"
            ds.nodes[nid] = Node(id=nid, x=float(r["x"]), y=float(r["y"]), floor_id=r["floor_id"], type=nt, name=r.get("name") or None)
    with open(edges_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            eid = r.get("id") or gen_id()
            ds.edges[eid] = Edge(id=eid, u=r["u"], v=r["v"], weight=float(r.get("weight") or 1.0), kind=(r.get("kind") or "walk"), oneway=(r.get("oneway") or "false").lower() in {"1","true","yes"})
    return ds