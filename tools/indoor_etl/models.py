from __future__ import annotations
from dataclasses import dataclass
from typing import Literal, Dict
import uuid
NodeType = Literal["corridor","door","room","connector"]
@dataclass(frozen=True)
class Floor: id: str; name: str; level: int
@dataclass(frozen=True)
class Node: id: str; x: float; y: float; floor_id: str; type: NodeType; name: str | None = None
@dataclass(frozen=True)
class Edge: id: str; u: str; v: str; weight: float; kind: Literal["walk","stairs","lift","escalator"]="walk"; oneway: bool=False
@dataclass
class Dataset:
    floors: Dict[str, Floor]; nodes: Dict[str, Node]; edges: Dict[str, Edge]
    @staticmethod
    def new() -> "Dataset": return Dataset({}, {}, {})
def gen_id() -> str: return uuid.uuid4().hex