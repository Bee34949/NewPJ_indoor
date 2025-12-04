// PATCH: demo/js/search.js  (แทนทั้งไฟล์ได้เลย)
// Search เฉพาะ ประตู/ลิฟท์/บันได; แผนที่ยังแสดงโหนดทั้งหมดจาก main.js
import { FLOORS } from './graph.js';

console.info('[search.js] v2 (no-uuid)');

export function buildDoorIndex(byFloor){
  const idx = new Map();
  const isSearchable = (t) => {
    const s = String(t || '').toLowerCase();
    return (
      s.includes('door') ||
      s.includes('elevator') || s.includes('lift') ||
      s.includes('stair') || s.includes('บันได')
    );
  };
  for (const f of FLOORS) {
    const floorNodes = byFloor[f] || {};
    for (const id in floorNodes) {
      const n = floorNodes[id];
      if (!isSearchable(n.type)) continue;
      idx.set(n.id.toLowerCase(), { id:n.id, floor:n.floor, lon:n.lon, lat:n.lat });
    }
  }
  return idx;
}

export function mountDoorUI(map, byFloor, doorIndex){
  const q   = document.getElementById('door-q');
  const go  = document.getElementById('door-go');
  const dl  = document.getElementById('door-list');
  const stat= document.getElementById('door-stat');

  const opts = [...doorIndex.values()]
    .sort((a,b)=>a.id.localeCompare(b.id))
    .map(d=>`<option value="${d.id} — ชั้น ${d.floor}">`)
    .join('');
  if (dl) dl.innerHTML = opts;
  if (stat) stat.textContent = `index: ${doorIndex.size}`;

  let pulse = null;
  function focusNode(d){
    map.flyTo({ center:[d.lon,d.lat], zoom: 20 });
    if (!pulse) {
      const el = document.createElement('div');
      el.style.width='16px'; el.style.height='16px';
      el.style.border='3px solid #2563eb'; el.style.borderRadius='9999px';
      el.style.background='white'; el.style.boxShadow='0 0 0 3px rgba(37,99,235,.25)';
      pulse = new maplibregl.Marker({ element: el, anchor:'center' });
    }
    pulse.setLngLat([d.lon,d.lat]).addTo(map);
  }

  const onGo = ()=>{
    const raw = (q?.value || '');
    const id = raw.replace(/—.*$/,'').trim().toLowerCase();
    const d = doorIndex.get(id);
    if (!d) { alert('ไม่พบ'); return; }
    focusNode(d);
  };
  if (go) go.onclick = onGo;
  if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter') onGo(); });
}
