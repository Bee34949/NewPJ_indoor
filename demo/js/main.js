// ============================
// File: demo/js/main.js
// ============================
import { FLOORS, ORIGIN, loadNodes, precomputeAdj, buildGlobalGraph, dijkstra, pathToFloorSegments } from './graph.js';
import { buildDoorIndex, mountDoorUI } from './search.js';
import { createPlayback } from './playback.js';
// positioning ถูกคอมเมนต์ไว้ตามที่แจ้ง
// import { RouteFollowProvider, wirePositionToMap } from './positioning.js';
import { loadPOIs, buildPOIIndex, mountSearchUI, defaultPOIUrl, poisFromNodes } from './search_index.js';

const BASE_URL  = new URL('.', location.href).toString().replace(/\/$/, '');
const TILE_URL  = `${BASE_URL}/dist/tiles/{z}/{x}/{y}.pbf?v=5`;
const NODES_URL = `${BASE_URL}/dist/_tmp/nodes.geojson?v=${Date.now()}`;
const POIS_URL  = defaultPOIUrl(BASE_URL);
const FLOOR_COST = 8;

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      indoor:     { type:'vector', tiles:[TILE_URL], minzoom:14, maxzoom:22, scheme:'xyz' },
      route:      { type:'geojson', data:{ type:'FeatureCollection', features:[] } },
      anim_trail: { type:'geojson', data:{ type:'FeatureCollection', features:[] } }
    },
    layers: [
      { id:'bg', type:'background', paint:{ 'background-color':'#eef2f5' } },
      { id:'rooms-fill', type:'fill', source:'indoor', 'source-layer':'rooms',
        paint:{ 'fill-color':['match',['to-string',['get','floor']],
          '01','#8dd3c7','02','#ffffb3','03','#bebada','04','#fb8072','05','#80b1d3','06','#fdb462','#ccebc5'],'fill-opacity':0.45 } },
      { id:'rooms-outline', type:'line', source:'indoor', 'source-layer':'rooms', paint:{ 'line-color':'#e11d48','line-width':1 } },
      { id:'features-line', type:'line', source:'indoor', 'source-layer':'features', paint:{ 'line-color':'#e11d48','line-width':1 } },
      { id:'route-line', type:'line', source:'route', paint:{ 'line-color':'#2563eb', 'line-width':4 } },
      { id:'anim-trail', type:'line', source:'anim_trail', paint:{ 'line-color':'#111','line-width':4,'line-opacity':0.8 } }
    ]
  },
  center:[ORIGIN.lon, ORIGIN.lat], zoom:19
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}), 'top-right');

// ----- State / HUD / Playback -----
let BY_FLOOR = {};
let ADJ = {};
let DOOR_IDX = null;

const HUD = {
  nodes: document.getElementById('hud-nodes'),
  segs:  document.getElementById('hud-segs'),
  fps:   document.getElementById('hud-fps')
};
let lastFpsTs=0, frames=0;
(function tick(ts){ frames++; if(!lastFpsTs) lastFpsTs=ts; if(ts-lastFpsTs>1000){ HUD.fps && (HUD.fps.textContent='fps '+frames); frames=0; lastFpsTs=ts; } requestAnimationFrame(tick); })(0);

const PB = createPlayback(map);
PB.onFloorChange((floor, dir)=>{ PB.toast(`${dir==='up'?'ขึ้น':'ลง'}ชั้น ${floor}`, 800); });

// ----- Floor UI -----
function mountFloors(){
  const chips=document.getElementById('floor-chips');
  chips.innerHTML = `<button class="chip active" data-floor="ALL">ทุกชั้น</button>` + FLOORS.map(f=>`<button class="chip" data-floor="${f}">${f}</button>`).join('');
  chips.querySelectorAll('.chip').forEach(b=>b.onclick=()=>setFloor(b.dataset.floor));
}
function setFloor(floor){
  const ids=['rooms-fill','rooms-outline','features-line','nodes-gj','pois','route-line','anim-trail','poi-search-pin'].filter(id=>map.getLayer(id));
  const flt=(floor==='ALL')?null:['==',['to-string',['get','floor']],floor];
  ids.forEach(id=>map.setFilter(id, flt));
  document.querySelectorAll('#floor-chips .chip').forEach(b=>b.classList.toggle('active',b.dataset.floor===floor));
  PB.setFloor(floor);
}

// ----- Helpers -----
const WALKLIKE = ['walk','corridor','junction','path','hall'];
const canonType = (t) => { const s=String(t||'').toLowerCase(); if(s.includes('door'))return'door'; if(s.includes('elevator')||s.includes('lift'))return'elevator'; if(s.includes('stair')||s.includes('บันได'))return'stairs'; if(s.includes('poi'))return'poi'; return'node'; };
const isWalklike = (t) => { const s=String(t||'').toLowerCase(); return WALKLIKE.some(w => s.includes(w)); };
function fillSelectors(){
  const s = document.getElementById('pf-start');
  const g = document.getElementById('pf-goal');
  const list = FLOORS
    .flatMap(f => Object.values(BY_FLOOR[f] || {}))
    .filter(n => !isWalklike(n.type))
    .sort((a, b) => (a.floor === b.floor) ? a.id.localeCompare(b.id) : a.floor.localeCompare(b.floor));
  const html = list.map(n => `<option value="${n.floor}:${n.id}">[${canonType(n.type)}] ${n.id} (F${n.floor})</option>`).join('');
  s.innerHTML = html; g.innerHTML = html;
}

// ----- Nodes layer -----
async function ensureNodesLayer(){
  const srcId = 'nodes_gj'; if (map.getSource(srcId)) return;
  const { fc } = await loadNodes(NODES_URL);
  const filtered = { type:'FeatureCollection', features:(fc.features||[]).filter(f=>{
    const t=String(f.properties?.type||'').toLowerCase();
    return t.includes('door')||t.includes('elevator')||t.includes('lift')||t.includes('stair')||t.includes('บันได');
  })};
  map.addSource(srcId, { type:'geojson', data: filtered });
  map.addLayer({
    id:'nodes-gj', type:'circle', source:srcId, minzoom:12,
    paint:{
      'circle-radius':['interpolate',['linear'],['zoom'],17,2.2,19,3.2,21,4.0],
      'circle-color':[
        'case',
        ['to-boolean',['index-of','door',['downcase',['get','type']]]],'#2563eb',
        ['any',
          ['to-boolean',['index-of','elevator',['downcase',['get','type']]]],
          ['to-boolean',['index-of','lift',['downcase',['get','type']]]]
        ],'#16a34a',
        ['any',
          ['to-boolean',['index-of','stair',['downcase',['get','type']]]],
          ['to-boolean',['index-of','บันได',['downcase',['get','type']]]]
        ],'#fb923c',
        '#111827'
      ],
      'circle-stroke-color':'#fff','circle-stroke-width':1
    }
  });
}
function waitForSource(id){
  return new Promise(resolve=>{
    if (map.getSource(id)) return resolve();
    const on = ()=>{ if (map.getSource(id)){ map.off('sourcedata', on); resolve(); } };
    map.on('sourcedata', on);
  });
}

// ----- Pathfinder -----
function runPathfinder(){
  const sSel=document.getElementById('pf-start').value;
  const gSel=document.getElementById('pf-goal').value;
  const avoid = document.getElementById('pf-avoid-stairs').checked;
  const allowCross = document.getElementById('pf-cross').checked;

  const [sf, sid]=sSel.split(':'), [gf, gid]=gSel.split(':');
  if(!allowCross && sf!==gf) return alert('ปิดข้ามชั้นอยู่');

  const Gg = buildGlobalGraph(BY_FLOOR, ADJ, {avoidStairs:avoid}, FLOOR_COST);
  const path = dijkstra(Gg, `${sf}:${sid}`, `${gf}:${gid}`);
  if(!path){ alert('หาเส้นทางไม่สำเร็จ'); return; }

  const feats = pathToFloorSegments(path, BY_FLOOR);
  map.getSource('route').setData({type:'FeatureCollection',features:feats});
  HUD.segs && (HUD.segs.textContent = 'segments '+feats.length);

  const points=[];
  for(let i=0;i<feats.length;i++){
    const f=feats[i], fl=f.properties.floor;
    for(const c of f.geometry.coordinates) points.push({lon:c[0],lat:c[1],floor:fl});
    if(i<feats.length-1){
      const n0=feats[i+1].geometry.coordinates[0];
      points.push({lon:n0[0],lat:n0[1],floor:feats[i+1].properties.floor,warpFromPrev:true});
    }
  }
  PB.setRoutePoints(points);
}

// ----- Door UI / Misc -----
function mountDoor(){
  DOOR_IDX = buildDoorIndex(BY_FLOOR);
  mountDoorUI(map, BY_FLOOR, DOOR_IDX);
  const cnt = Object.values(BY_FLOOR).reduce((a,m)=>a+Object.keys(m).length,0);
  const el = document.getElementById('node-count'); if(el) el.textContent = `nodes:${cnt}`;
  HUD.nodes && (HUD.nodes.textContent = `nodes ${cnt}`);
}
function wireUI(){
  document.getElementById('pf-run').onclick=runPathfinder;
  document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>applyPreset(b.dataset.preset));
  document.getElementById('pb-play')?.addEventListener('click', ()=>PB.play());
  document.getElementById('pb-pause')?.addEventListener('click', ()=>PB.pause());
  document.getElementById('pb-reset')?.addEventListener('click', ()=>PB.reset());
  document.getElementById('pb-follow')?.addEventListener('change',e=>PB.followCamera(e.target.checked));
  const spd=document.getElementById('pb-speed'), spdVal=document.getElementById('pb-speed-val');
  spd?.addEventListener('input',e=>{ const v=parseFloat(e.target.value); spdVal.textContent=v; PB.setSpeed(v); });
  const ps=document.getElementById('pb-pause-ms'), psVal=document.getElementById('pb-pause-val');
  ps?.addEventListener('input',e=>{ psVal.textContent=e.target.value+'s'; PB.setPauseMs(parseFloat(e.target.value)*1000); });
  document.getElementById('pb-trail-same')?.addEventListener('change',e=>PB.setTrailSameFloor(e.target.checked));
}
function applyPreset(name){
  const s=document.getElementById('pf-start'), g=document.getElementById('pf-goal');
  const pick=(floor,id)=>`${floor}:${id}`;
  if(name==='same'){ s.value=pick('03','N170'); g.value=pick('03','N171'); }
  if(name==='up'){   s.value=pick('03','N170'); g.value=pick('04','N102'); }
  if(name==='down'){ s.value=pick('04','N102'); g.value=pick('02','N050'); }
  runPathfinder();
}

// ----- Boot -----
map.on('load', async ()=>{
  await ensureNodesLayer(); await waitForSource('nodes_gj');

  // tooltip
  const tip=new maplibregl.Popup({closeButton:false, closeOnClick:false});
  map.on('mousemove','nodes-gj',(e)=>{
    const f=e.features?.[0]; if(!f) return;
    const p=f.properties||{};
    tip.setLngLat(e.lngLat).setHTML(`<div style="font:12px ui-sans-serif"><strong>[${(p.type||'').toLowerCase()}]</strong> ${p.name||p.id||''} (F${p.floor||''})</div>`).addTo(map);
  });
  map.on('mouseleave','nodes-gj',()=>tip.remove());

  // graph
  const { byFloor } = await loadNodes(NODES_URL);
  BY_FLOOR = byFloor;
  ADJ = precomputeAdj(BY_FLOOR, 6);

  // POIs + index + UI (with chips)
  let pois = await loadPOIs(POIS_URL);
  if (!pois.length) { pois = poisFromNodes(BY_FLOOR); }
  const idx = buildPOIIndex(pois);
  mountSearchUI(map, idx, {
    onPick: (poi) => {
      const g = document.getElementById('pf-goal'); if (g) g.value = `${poi.floor}:${poi.id}`;
      const s = document.getElementById('pf-start'); if (s && s.value) runPathfinder();
    }
  });

  mountFloors(); fillSelectors(); mountDoor(); wireUI();
  const badge=document.getElementById('cost-badge'); if(badge) badge.textContent = FLOOR_COST+'m';
  setFloor('ALL');
});
