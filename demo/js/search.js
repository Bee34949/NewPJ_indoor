import { FLOORS } from './graph.js';
import { uuidv4 } from './positioning.js';

export async function loadNodes(url){
  const res = await fetch(url, {cache:'no-store'});
  if(!res.ok) throw new Error('nodes fetch fail');
  const fc = await res.json();
  for (const f of (fc.features||[])) {
    const p = (f.properties ||= {});
    p.uuid = p.uuid || uuidv4();         // ensure uuid
    p.type = String(p.type||'node');     // normalize
    p.floor = String(p.floor||'');
  }
  return { fc };
}
export function buildDoorIndex(byFloor){
  const idx=new Map();
  for(const f of FLOORS){
    for(const id in (byFloor[f]||{})){
      const n=byFloor[f][id]; const t=(n.type||'').toLowerCase();
      if(t.includes('door')) idx.set(n.id.toLowerCase(), { id:n.id, floor:n.floor, lon:n.lon, lat:n.lat });
    }
  }
  return idx;
}

export function mountDoorUI(map, byFloor, doorIndex){
  const q = document.getElementById('door-q');
  const go = document.getElementById('door-go');
  const dl = document.getElementById('door-list');
  const stat = document.getElementById('door-stat');

  const opts = [...doorIndex.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(d=>`<option value="${d.id} — ชั้น ${d.floor}">`).join('');
  dl.innerHTML = opts; stat.textContent = `index: ${doorIndex.size}`;

  let pulse=null;
  function focusDoor(d){
    map.flyTo({center:[d.lon,d.lat], zoom:20});
    if(!pulse){ const el=document.createElement('div'); el.className='pulse'; pulse=new maplibregl.Marker({element:el,anchor:'center'}); }
    pulse.setLngLat([d.lon,d.lat]).addTo(map);
  }
  async function onGo(){
    const raw=q.value||''; const id=raw.replace(/—.*$/,'').trim().toLowerCase();
    const d = doorIndex.get(id);
    if(!d) return alert('ไม่พบประตู');
    focusDoor(d);
  }
  go.onclick=onGo; q.addEventListener('keydown',e=>{ if(e.key==='Enter') onGo(); });
}

