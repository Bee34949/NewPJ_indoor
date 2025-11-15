from __future__ import annotations
from typing import List, Dict
from .models import Dataset
def validate(ds: Dataset) -> List[str]:
    errors: List[str] = []
    if not ds.floors: errors.append("no floors")
    for n in ds.nodes.values():
        if n.floor_id not in ds.floors: errors.append(f"node {n.id} floor missing: {n.floor_id}")
    for e in ds.edges.values():
        if e.u not in ds.nodes: errors.append(f"edge {e.id} missing u={e.u}")
        if e.v not in ds.nodes: errors.append(f"edge {e.id} missing v={e.v}")
        if e.u in ds.nodes and e.v in ds.nodes:
            if ds.nodes[e.u].floor_id != ds.nodes[e.v].floor_id and e.kind not in {"stairs","lift","escalator"}:
                errors.append(f"edge {e.id} cross-floor must be connector kind: {e.kind}")
    deg: Dict[str,int] = {}
    for e in ds.edges.values(): deg[e.u]=deg.get(e.u,0)+1; deg[e.v]=deg.get(e.v,0)+1
    for nid, n in ds.nodes.items():
        if n.type in {"corridor","connector"} and deg.get(nid,0) == 0: errors.append(f"dangling corridor/connector: {nid}")
    return errors