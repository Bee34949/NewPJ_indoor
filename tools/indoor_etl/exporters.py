from __future__ import annotations
from pathlib import Path
import json
from typing import Dict, Any, List
from .models import Dataset, Node, Edge
def _feature_point(n: Node) -> Dict[str, Any]:
    return {"type":"Feature","geometry":{"type":"Point","coordinates":[n.x,n.y]},"properties":{"id":n.id,"floor_id":n.floor_id,"type":n.type,"name":n.name}}
def _feature_line(u: Node, v: Node, e: Edge) -> Dict[str, Any]:
    return {"type":"Feature","geometry":{"type":"LineString","coordinates":[[u.x,u.y],[v.x,v.y]]},"properties":{"id":e.id,"u":e.u,"v":e.v,"weight":e.weight,"kind":e.kind,"oneway":e.oneway}}
def export_geojson(ds: Dataset, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    def fc(features: List[dict]) -> dict: return {"type":"FeatureCollection","features":features}
    rooms=[_feature_point(n) for n in ds.nodes.values() if n.type=="room"]
    doors=[_feature_point(n) for n in ds.nodes.values() if n.type=="door"]
    corridors=[_feature_point(n) for n in ds.nodes.values() if n.type=="corridor"]
    connectors=[_feature_point(n) for n in ds.nodes.values() if n.type=="connector"]
    edges=[_feature_line(ds.nodes[e.u], ds.nodes[e.v], e) for e in ds.edges.values()]
    (out_dir/"rooms.geojson").write_text(json.dumps(fc(rooms),ensure_ascii=False), encoding="utf-8")
    (out_dir/"doors.geojson").write_text(json.dumps(fc(doors),ensure_ascii=False), encoding="utf-8")
    (out_dir/"corridors.geojson").write_text(json.dumps(fc(corridors),ensure_ascii=False), encoding="utf-8")
    (out_dir/"connectors.geojson").write_text(json.dumps(fc(connectors),ensure_ascii=False), encoding="utf-8")
    (out_dir/"edges.geojson").write_text(json.dumps(fc(edges),ensure_ascii=False), encoding="utf-8")