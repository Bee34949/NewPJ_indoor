# FILE: tools/_xml_tolerant.py
# ใช้ใน gml_to_csv.py: from _xml_tolerant import parse_xml

from __future__ import annotations

import io
import os
from typing import Optional, Tuple
import xml.etree.ElementTree as ET

try:
    from lxml import etree as LET  # ให้ความสามารถ recover
    _HAS_LXML = True
except Exception:
    _HAS_LXML = False


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def _recover_with_lxml(xml_bytes: bytes) -> Optional[bytes]:
    if not _HAS_LXML:
        return None
    parser = LET.XMLParser(recover=True, huge_tree=True)
    root = LET.fromstring(xml_bytes, parser=parser)
    return LET.tostring(root, pretty_print=True, xml_declaration=True, encoding="UTF-8")


def parse_xml(path: str, tolerant: bool = False, recover_save: Optional[str] = None) -> ET.ElementTree:
    """
    โหลดยืดหยุ่น: ไฟล์เสีย → พยายามซ่อมด้วย lxml แล้วค่อย parse ด้วย ET
    tolerant=False: ทำงานเหมือน ET.parse(path)
    """
    if not tolerant:
        return ET.parse(path)

    raw = _read_bytes(path)
    fixed = _recover_with_lxml(raw)
    if fixed is None:
        # ไม่มี lxml → ตกกลับไป ET.parse ตามเดิม (จะ throw error เหมือนเดิม)
        return ET.parse(io.BytesIO(raw))

    # บันทึกสำเนาที่ซ่อมแล้วเพื่อ audit
    out_path = recover_save or (path.rsplit(".", 1)[0] + ".fixed.gml")
    _write_bytes(out_path, fixed)

    # ใช้ ET ต่อเพื่อความเข้ากันได้กับโค้ดเดิม
    return ET.parse(io.BytesIO(fixed))


# ----------------------------------------------------------------------
# FILE: tools/gml_to_csv.py  (PATCH เฉพาะส่วนที่เกี่ยวข้อง)
# 1) เพิ่ม import ใกล้ๆ ส่วน import เดิม:
# from _xml_tolerant import parse_xml
#
# 2) เพิ่มออปชัน argparse (ในฟังก์ชัน main หรือที่กำหนด args):
# parser.add_argument("--tolerant", action="store_true",
#                     help="ยอมรับ GML ที่ไม่สมบูรณ์ และพยายามซ่อมด้วย lxml(recover)")
# parser.add_argument("--recover-save", default=None,
#                     help="พาธไฟล์ที่ต้องการบันทึกฉบับที่ซ่อมแล้ว (.fixed.gml). ถ้าไม่ระบุจะใช้ <input>.fixed.gml")
#
# 3) เปลี่ยนบรรทัด parse เดิม:
#    root = ET.parse(in_path).getroot()
#    เป็น:
#    root = parse_xml(in_path, tolerant=args.tolerant, recover_save=args.recover_save).getroot()
#
# เสร็จสิ้น (ส่วนอื่นของไฟล์ไม่ต้องแก้)

# ----------------------------------------------------------------------
# ถ้าคุณต้องการไฟล์แยกที่ “รันจบในตัว” โดยไม่ไปแก้ของเดิม ให้ใช้ wrapper นี้แทน:

if __name__ == "__main__" and False:
    # FILE: tools/gml_to_csv_wrapper.py (ใช้เฉพาะกรณีไม่อยากแก้ไฟล์เดิม)
    # Usage:
    #   python gml_to_csv_wrapper.py -i nodefloor3.gml -- tolerant -- <args ของ gml_to_csv.py ต่อจากนี้>
    import argparse
    import subprocess
    import sys
    from _xml_tolerant import parse_xml

    wap = argparse.ArgumentParser()
    wap.add_argument("-i", "--input", required=True)
    wap.add_argument("--out-fixed", default=None)
    wap.add_argument("--python", default=sys.executable)
    wap.add_argument("--script", default="gml_to_csv.py")
    wap.add_argument("--", dest="rest", nargs=argparse.REMAINDER, help="args ต่อให้ gml_to_csv.py")
    wa = wap.parse_args()

    # ซ่อม GML ก่อน
    tree = parse_xml(wa.input, tolerant=True, recover_save=wa.out_fixed)
    fixed_path = wa.out_fixed or (wa.input.rsplit(".", 1)[0] + ".fixed.gml")
    # เขียนกลับ (ให้แน่ใจว่ามีไฟล์ fixed สำหรับตัวแปลงเดิม)
    tree.write(fixed_path, encoding="utf-8", xml_declaration=True)

    # เรียกสคริปต์เดิมโดยใช้ไฟล์ที่ซ่อมแล้ว
    cmd = [wa.python, wa.script, "-i", fixed_path]
    if wa.rest:
        cmd += wa.rest
    sys.exit(subprocess.call(cmd))
