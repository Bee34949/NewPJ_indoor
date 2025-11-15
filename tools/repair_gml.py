# FILE: tools/repair_gml.py
# Purpose: Diagnose & auto-repair common XML/GML issues (mismatched tag, stray '&') then save a fixed .gml
# Usage:
#   python repair_gml.py -i nodefloor3.gml -o nodefloor3.fixed.gml
#   python gml_to_csv.py -i nodefloor3.fixed.gml -j out_json -c out_csv -f all -y

from __future__ import annotations

import argparse
import io
import os
import re
import sys
import textwrap
import traceback
from typing import Optional, Tuple

import xml.etree.ElementTree as ET

try:
    # lxml gives us recover=True to auto-fix many malformed XMLs.
    from lxml import etree as LET  # type: ignore
    HAS_LXML = True
except Exception:
    HAS_LXML = False


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def find_parse_error(text: str) -> Tuple[Optional[int], Optional[int], Optional[str]]:
    try:
        ET.parse(io.StringIO(text))
        return None, None, None
    except ET.ParseError as e:
        msg = str(e)
        # Typical: 'mismatched tag: line 1699, column 88'
        m = re.search(r"line\s+(\d+),\s*column\s+(\d+)", msg)
        if m:
            return int(m.group(1)), int(m.group(2)), msg
        return None, None, msg


def show_context(text: str, line: int, col: int, radius: int = 4) -> str:
    lines = text.splitlines()
    start = max(1, line - radius)
    end = min(len(lines), line + radius)
    out = []
    for i in range(start, end + 1):
        prefix = ">>" if i == line else "  "
        content = lines[i - 1]
        out.append(f"{prefix} {i:>6}: {content}")
        if i == line:
            caret = " " * (col + 10) + "^"
            out.append(f"{' ' * 2}{caret}")
    return "\n".join(out)


def escape_stray_ampersands(text: str) -> str:
    # Replace & that are not part of a known entity with &amp;
    # This fixes many “not well-formed” errors coming from SVG/GML labels.
    return re.sub(r"&(?!(?:[a-zA-Z]+|#\d+|#x[0-9A-Fa-f]+);)", "&amp;", text)


def try_etree_parse(text: str) -> Tuple[bool, Optional[ET.ElementTree], Optional[str]]:
    try:
        tree = ET.parse(io.StringIO(text))
        return True, tree, None
    except ET.ParseError as e:
        return False, None, str(e)


def lxml_recover(xml_bytes: bytes) -> Optional[bytes]:
    if not HAS_LXML:
        return None
    parser = LET.XMLParser(recover=True, huge_tree=True)
    try:
        root = LET.fromstring(xml_bytes, parser=parser)
        return LET.tostring(root, pretty_print=True, xml_declaration=True, encoding="UTF-8")
    except Exception:
        return None


def repair_gml(raw: bytes, verbose: bool = True) -> Tuple[bytes, bool, str]:
    """
    Returns (fixed_bytes, repaired?, log)
    """
    log_lines = []
    # Normalize newlines and strip BOM
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = text.lstrip("\ufeff")

    ok, _, err = try_etree_parse(text)
    if ok:
        log_lines.append("ET.parse: OK (no repair needed)")
        return text.encode("utf-8"), False, "\n".join(log_lines)

    # Show context of first error
    line, col, msg = find_parse_error(text)
    if line:
        log_lines.append(f"First parse error: {msg}")
        log_lines.append("Context:")
        log_lines.append(show_context(text, line, col or 1))

    # Heuristic 1: escape stray ampersands
    text2 = escape_stray_ampersands(text)
    if text2 != text:
        ok2, _, err2 = try_etree_parse(text2)
        if ok2:
            log_lines.append("Heuristic: escaped stray '&' → FIXED")
            return text2.encode("utf-8"), True, "\n".join(log_lines)
        else:
            log_lines.append(f"Heuristic '&' failed: {err2}")

    # Heuristic 2: common bad self-closing tags accidentally written as <tag></tag> mismatch
    # We can't safely auto-fix mismatched tags without schema, so fall back to lxml recover.
    recovered = lxml_recover(text2.encode("utf-8"))
    if recovered is not None:
        ok3, _, err3 = try_etree_parse(recovered.decode("utf-8", errors="replace"))
        if ok3:
            log_lines.append("lxml.recover: FIXED (auto-recovered malformed XML)")
            return recovered, True, "\n".join(log_lines)
        else:
            log_lines.append(f"lxml.recover still not well-formed for ET: {err3}")

    # Give up but return original bytes so caller can still save a copy
    log_lines.append("Unable to auto-repair. Please fix manually using the context above.")
    return raw, False, "\n".join(log_lines)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Diagnose & auto-repair malformed IndoorGML/XML before converting."
    )
    ap.add_argument("-i", "--input", required=True, help="Path to input .gml")
    ap.add_argument("-o", "--output", help="Path to write fixed .gml (default: <input>.fixed.gml)")
    ap.add_argument("--dry-run", action="store_true", help="Do not write output, only show diagnostics")
    args = ap.parse_args()

    src = args.input
    dst = args.output or (src.rsplit(".", 1)[0] + ".fixed.gml")

    raw = read_bytes(src)
    fixed, repaired, log = repair_gml(raw)

    print("\n=== Repair Report ===")
    print(log)
    print("=====================\n")

    if args.dry_run:
        print("Dry-run only; no file written.")
        return

    if repaired:
        write_bytes(dst, fixed)
        print(f"Written repaired file: {dst}")
        print("Next step:")
        print(f"  python gml_to_csv.py -i {dst} -j out_json -c out_csv -f all -y")
    else:
        # Still write out a .fixed copy so user can hand-edit around the shown context.
        write_bytes(dst, fixed)
        print(f"Could not auto-repair; wrote a copy for manual fix: {dst}")
        if HAS_LXML:
            print("Hint: open the 'Context' lines above; fix the tag mismatch around that position.")
        else:
            print("Tip: install lxml for better auto-repair:  pip install lxml")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
