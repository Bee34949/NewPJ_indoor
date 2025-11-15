import { FLOORS, ORIGIN, loadNodes, precomputeAdj, buildGlobalGraph, dijkstra, pathToFloorSegments } from './graph.js';
import { buildDoorIndex, mountDoorUI } from './search.js';
import { createPlayback } from './playback.js';

// ===== Config
const TILE_BASE = (()=>{ try { return new URL('/dist/', location.origin).origin; } catch { return location.origin; }})();
const TILE_URL  = `${TILE_BASE}/dist/tiles/{z}/{x}/{y}.pbf?v=5`;
const NODES_URL = `${TILE_BASE}/dist/_tmp/nodes.geojson?v=${Date.now()}`;
const FLOOR_COST = 8;

// ===== Map
const map = new maplibregl.Map({
  container:'map',
  style:{ version:8, glyphs:"https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources:{
      indoor:{type:'vector',tiles:[TILE_URL],minzoom:0,maxzoom:22,scheme:'xyz'},
      route:{type:'geojson',data:{type:'FeatureCollection',features:[]}},
      anim_trail:{type:'geojson',data:{type:'FeatureCollection',features:[]}}
    },
    layers:[
      {id:'bg',type:'background',paint:{'background-color':'#eef2f5'}},
      {id:'rooms-fill',type:'fill',source:'indoor','source-layer':'rooms',
        paint:{'fill-color':['match',['to-string',['get','floor']],'01','#8dd3c7','02','#ffffb3','03','#bebada','04','#fb8072','05','#80b1d3','06','#fdb462','#ccebc5'],'fill-opacity':0.45}},
      {id:'rooms-outline',type:'line',source:'indoor','source-layer':'rooms',paint:{'line-color':'#e11d48','line-width':1}},
      {id:'features-line',type:'line',source:'indoor','source-layer':'features',paint:{'line-color':'#e11d48','line-width':1}},
      {id:'route-line',type:'line',source:'route',paint:{'line-color':'#ff3333','line-width':3}},
      {id:'anim-trail',type:'line',source:'anim_trail',paint:{'line-color':'#111','line-width':4,'line-opacity':0.8}}
    ]},
  center:[ORIGIN.lon,ORIGIN.lat], zoom:19
});

// ===== State
let BY_FLOOR={}, ADJ={}, DOOR_IDX=null, G=null;
const HUD={ nodes:document.getElementById('hud-nodes'), segs:document.getElementById('hud-segs'), fps:document.getElementById('hud-fps') };
let lastFpsTs=0, frames=0;
function hudTick(ts){ frames++; if(!lastFpsTs) lastFpsTs=ts; if(ts-lastFpsTs>1000){ HUD.fps.textContent='fps '+frames; frames=0; lastFpsTs=ts; } requestAnimationFrame(hudTick); }
requestAnimationFrame(hudTick);

// ===== Playback
const PB = createPlayback(map);
PB.onFloorChange((floor, dir)=>{ PB.toast(`${dir==='up'?'ขึ้น':'ลง'}ชั้น ${floor}`, 800); });

// ===== UI Setup
function mountFloors(){
  const chips=document.getElementById('floor-chips');
  chips.innerHTML = `<button class="chip active" data-floor="ALL">ทุกชั้น</button>` + FLOORS.map(f=>`<button class="chip" data-floor="${f}">${f}</button>`).join('');
  chips.querySelectorAll('.chip').forEach(b=>b.onclick=()=>setFloor(b.dataset.floor));
}
function setFloor(floor){
  const ids=['rooms-fill','rooms-outline','features-line','nodes-gj','nodes-gj-label','route-line','anim-trail'].filter(id=>map.getLayer(id));
  const flt=(floor==='ALL')?null:['==',['to-string',['get','floor']],floor];
  ids.forEach(id=>map.setFilter(id, flt));
  document.querySelectorAll('#floor-chips .chip').forEach(b=>b.classList.toggle('active',b.dataset.floor===floor));
  PB.setFloor(floor);
}
function fillSelectors(){
  const s=document.getElementById('pf-start'), g=document.getElementById('pf-goal');
  const list=FLOORS.flatMap(f=>Object.values(BY_FLOOR[f]||{}));
  list.sort((a,b)=>(a.floor===b.floor)?a.id.localeCompare(b.id):a.floor.localeCompare(b.floor));
  const html=list.map(n=>`<option value="${n.floor}:${n.id}">${n.id} (${n.floor})</option>`).join('');
  s.innerHTML=html; g.innerHTML=html;
}

// ===== Nodes layer
async function ensureNodesLayer(){
  const srcId='nodes_gj';
  if(map.getSource(srcId)) return;
  const { fc } = await loadNodes(NODES_URL);
  map.addSource(srcId,{type:'geojson',data:fc});
  map.addLayer({id:'nodes-gj',type:'circle',source:srcId,minzoom:12,
    paint:{'circle-radius':['interpolate',['linear'],['zoom'],17,2.2,19,3.2,21,4.0],
           'circle-color':['match',['downcase',['get','type']],'door','#ff00aa','stairs','#ff8800','stair','#ff8800','elevator','#0062ff','corridor','#00b894','junction','#333','poi','#6c5ce7','#6c5ce7'],
           'circle-stroke-color':'#fff','circle-stroke-width':1}});
  map.addLayer({id:'nodes-gj-label',type:'symbol',source:srcId,minzoom:14,
    layout:{'text-field':['get','id'],'text-size':11,'text-offset':[0,1]},paint:{'text-color':'#111','text-halo-color':'#fff','text-halo-width':1}});
}

// ===== Pathfinder
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
  HUD.segs.textContent = 'segments '+feats.length;

  // build playback points
  const points=[];
  for(let i=0;i<feats.length;i++){
    const f=feats[i], fl=f.properties.floor;
    for(const c of f.geometry.coordinates) points.push({lon:c[0],lat:c[1],floor:fl});
    if(i<feats.length-1){
      const firstNext=feats[i+1].geometry.coordinates[0];
      points.push({lon:firstNext[0],lat:firstNext[1],floor:feats[i+1].properties.floor,warpFromPrev:true});
    }
  }
  PB.setRoutePoints(points);
}

// ===== Door UI
function mountDoor(){
  DOOR_IDX = buildDoorIndex(BY_FLOOR);
  mountDoorUI(map, BY_FLOOR, DOOR_IDX);
  document.getElementById('node-count').textContent = `nodes:${Object.values(BY_FLOOR).reduce((a,m)=>a+Object.keys(m).length,0)}`;
  HUD.nodes.textContent = `nodes ${Object.values(BY_FLOOR).reduce((a,m)=>a+Object.keys(m).length,0)}`;
}

// ===== Presets
function applyPreset(name){
  const s=document.getElementById('pf-start'), g=document.getElementById('pf-goal');
  const find=(floor,id)=>`${floor}:${id}`;
  if(name==='same'){ s.value=find('03','N170'); g.value=find('03','N171'); }
  if(name==='up'){   s.value=find('03','N170'); g.value=find('04','N102'); }
  if(name==='down'){ s.value=find('04','N102'); g.value=find('02','N050'); }
  runPathfinder();
}

// ===== Wire UI
function wireUI(){
  document.getElementById('pf-run').onclick=runPathfinder;
  document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>applyPreset(b.dataset.preset));
  document.getElementById('pb-play').onclick = ()=>PB.play();
  document.getElementById('pb-pause').onclick= ()=>PB.pause();
  document.getElementById('pb-reset').onclick= ()=>PB.reset();
  document.getElementById('pb-follow').onchange=e=>PB.followCamera(e.target.checked);
  const spd=document.getElementById('pb-speed'); const spdVal=document.getElementById('pb-speed-val');
  spd.oninput=e=>{ spdVal.textContent=e.target.value; PB.setSpeed(parseFloat(e.target.value)); };
  const ps=document.getElementById('pb-pause-ms'); const psVal=document.getElementById('pb-pause-val');
  ps.oninput=e=>{ psVal.textContent=e.target.value+'s'; PB.setPauseMs(parseFloat(e.target.value)*1000); };
  document.getElementById('pb-trail-same').onchange=e=>PB.setTrailSameFloor(e.target.checked);
}

// ===== Init
map.on('load', async ()=>{
  await ensureNodesLayer();
  const { byFloor } = await loadNodes(NODES_URL);
  BY_FLOOR = byFloor; ADJ = precomputeAdj(BY_FLOOR, 6);
  mountFloors(); fillSelectors(); mountDoor(); wireUI();
  document.getElementById('cost-badge').textContent = FLOOR_COST+'m';
  setFloor('ALL');
});