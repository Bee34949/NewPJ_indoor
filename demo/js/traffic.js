// ============================================================================
// File: demo/js/traffic.js
// Traffic/Footflow overlay + route coloring + ETA + auto reload
// ============================================================================
export const TRAFFIC_FILES = ['traffic.geojson','footflow.geojson'];

export const TRAFFIC_LEVELS = {
  0: { name: 'normal', color: '#3b82f6', speedFactor: 1.00 }, // ฟ้า
  1: { name: 'slow',   color: '#f59e0b', speedFactor: 0.70 }, // เหลือง
  2: { name: 'heavy',  color: '#ef4444', speedFactor: 0.45 }, // แดง
};

let _trafficFC = null;
let _timer = null;

/** ลองโหลด traffic จากชื่อไฟล์ที่รองรับ (ตัวแรกที่พบจะใช้เลย) */
export async function loadTrafficAuto(baseUrl){
  for(const name of TRAFFIC_FILES){
    const url = `${baseUrl}/dist/_tmp/${name}?v=${Date.now()}`;
    const ok = await loadTraffic(url, {quiet:true});
    if(ok) return true;
  }
  console.warn('[traffic] no traffic/footflow file found → route colored as normal');
  return false;
}

export async function loadTraffic(url, {quiet=false}={}){
  try{
    const r = await fetch(url, {cache:'no-store'});
    if(!r.ok) throw new Error(String(r.status));
    const fc = await r.json();
    _trafficFC = normalizeTraffic(fc);
    if(!quiet) console.info('[traffic] loaded:', (_trafficFC?.features?.length||0));
    return true;
  }catch(e){
    if(!quiet) console.warn('[traffic] load fail:', e);
    _trafficFC = null;
    return false;
  }
}

function normalizeTraffic(fc){
  const out = { type:'FeatureCollection', features:[] };
  for(const f of (fc.features||[])){
    if(!f?.geometry || f.geometry.type!=='LineString') continue;
    const lv = clampLevel(f.properties?.level);
    out.features.push({ type:'Feature', properties:{ level: lv }, geometry:f.geometry });
  }
  return out;
}
const clampLevel = (x)=> (x===1||x===2)?x:0;

// ------------------------ geometry helpers (ระยะสั้นในอาคารพอ) ----------------
const R=6371000, toRad=(d)=>d*Math.PI/180;
function haversineMeters(lon1,lat1,lon2,lat2){
  const φ1=toRad(lat1), φ2=toRad(lat2), Δφ=toRad(lat2-lat1), Δλ=toRad(lon2-lon1);
  const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
export function segmentMeters(a,b){ return haversineMeters(a[0],a[1],b[0],b[1]); }

function distPointToLineMeters(pt, line){
  let min=Infinity;
  for(let i=0;i<line.length-1;i++){
    const d=distPointToSegMeters(pt, line[i], line[i+1]);
    if(d<min) min=d;
  }
  return min;
}
function distPointToSegMeters(p,a,b){
  const [ax,ay]=a,[bx,by]=b,[px,py]=p;
  const abx=bx-ax, aby=by-ay; const len2=abx*abx+aby*aby;
  let t = len2? ((px-ax)*abx+(py-ay)*aby)/len2 : 0; t=Math.max(0,Math.min(1,t));
  const qx=ax+t*abx, qy=ay+t*aby;
  return haversineMeters(px,py,qx,qy);
}

function matchTrafficLevel([ax,ay],[bx,by], threshold=4){
  if(!_trafficFC) return 0;
  const mid=[(ax+bx)/2,(ay+by)/2];
  let bestLv=0, best=Infinity;
  for(const f of _trafficFC.features){
    const d = distPointToLineMeters(mid, f.geometry.coordinates);
    if(d<best){ best=d; bestLv=clampLevel(f.properties.level); }
  }
  return (best<=threshold) ? bestLv : 0;
}

// ----------------------- route color + ETA computation -----------------------
/**
 * @param {Feature[]} routeFeats  LineString-per-floor (จาก pathToFloorSegments)
 * @param {{baseWalkMps?:number, stairsPenalty?:number, elevatorPenalty?:number}} opts
 * @returns {{feats:Feature[], seconds:number}}
 */
export function colorizeRouteAndETA(routeFeats, opts={}){
  const base = opts.baseWalkMps ?? 1.3;
  const pStair = opts.stairsPenalty ?? 5;
  const pElev  = opts.elevatorPenalty ?? 15;

  let secs=0;
  const colored = routeFeats.map(f=>{
    const cs=f.geometry.coordinates;
    let lv=0, length=0;
    for(let i=0;i<cs.length-1;i++){
      const a=cs[i], b=cs[i+1];
      length += segmentMeters(a,b);
      lv = Math.max(lv, matchTrafficLevel(a,b));
    }
    const speed = base * (TRAFFIC_LEVELS[lv]?.speedFactor ?? 1.0);
    secs += length / Math.max(0.01, speed);
    return { type:'Feature', properties:{...f.properties, level:lv}, geometry:f.geometry };
  });

  for(const f of colored){
    if (f.properties?.warpFromPrev){
      secs += (f.properties?.isElevator ? pElev : pStair);
    }
  }
  return { feats: colored, seconds: Math.round(secs) };
}

// ----------------------- overlay + legend + auto reload ----------------------
export function mountTrafficOverlay(map, srcId='traffic'){
  if(!_trafficFC) return;
  if(!map.getSource(srcId)) map.addSource(srcId,{type:'geojson',data:_trafficFC});
  else map.getSource(srcId).setData(_trafficFC);
  if(!map.getLayer('traffic-line')){
    map.addLayer({
      id:'traffic-line', type:'line', source:srcId,
      paint:{
        'line-color': ['match',['get','level'], 2,'#ef4444', 1,'#f59e0b', 0,'#3b82f6', '#3b82f6'],
        'line-width': 2, 'line-opacity': 0.6
      }
    });
  }
}

export function unmountTrafficOverlay(map){
  if(map.getLayer('traffic-line')) map.removeLayer('traffic-line');
}

/** วาด legend ขนาดเล็ก */
export function ensureTrafficLegend(containerId='traffic-legend'){
  let box=document.getElementById(containerId);
  if(!box){
    box=document.createElement('div');
    box.id=containerId;
    box.style.cssText='display:flex;gap:10px;font-size:12px;align-items:center;flex-wrap:wrap';
    document.getElementById('traffic-panel')?.appendChild(box);
  }
  box.innerHTML = Object.entries(TRAFFIC_LEVELS).map(([k,v]) =>
    `<span style="display:inline-flex;align-items:center;gap:6px">
       <i style="display:inline-block;width:10px;height:10px;background:${v.color};border-radius:2px"></i>${v.name}
     </span>`).join('');
}

/** เริ่ม auto reload; เรียก cb หลังโหลดสำเร็จ */
export function startTrafficAutoReload({baseUrl, intervalSec=30, onReload}){
  stopTrafficAutoReload();
  _timer = setInterval(async ()=>{
    const ok = await loadTrafficAuto(baseUrl);
    if(ok) onReload?.();
  }, Math.max(5, intervalSec)*1000);
}
export function stopTrafficAutoReload(){
  if(_timer){ clearInterval(_timer); _timer=null; }
}
export function hasTraffic(){ return !!_trafficFC; }
