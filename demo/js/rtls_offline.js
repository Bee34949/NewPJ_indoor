export async function loadSignatures(url){
  const r = await fetch(url, {cache:'no-store'});
  if(!r.ok) throw new Error(`signatures ${r.status}`);
  const sig = await r.json();
  if(!sig?.ap_dict || !sig?.weights_sqrt) throw new Error('bad signatures.json');
  return sig;
}

const FILL = -100;
const nb = b => String(b||'').trim().toLowerCase().replace(/-/g,':');

function vectorize(sig, scan){
  const M=sig.dim, ap=sig.ap_dict, w=sig.weights_sqrt;
  const X=new Float32Array(M).fill(FILL);
  for(const [b,r] of Object.entries(scan||{})){ const j=ap[nb(b)]; if(j!=null) X[j]=+r; }
  for(let j=0;j<M;j++) X[j]*=w[j]; // pre-scale √w
  return X;
}
function prescalePoint(sig, p){
  const M=sig.dim, ap=sig.ap_dict, w=sig.weights_sqrt;
  const V=new Float32Array(M).fill(FILL);
  for(const [b,r] of Object.entries(p.rssi||{})){ const j=ap[nb(b)]; if(j!=null) V[j]=+r; }
  for(let j=0;j<M;j++) V[j]*=w[j];
  return V;
}
function l2(a,b){ let s=0; for(let i=0;i<a.length;i++){ const d=a[i]-b[i]; s+=d*d; } return Math.sqrt(s); }

export function locateOffline(sig, scan, {k=3, floorHint=null}={}){
  if(!sig?.points?.length) return null;
  const X = vectorize(sig, scan);
  const cand=[];
  for(const p of sig.points){
    if(floorHint && String(p.floor)!==String(floorHint)) continue;
    const S = prescalePoint(sig, p);
    cand.push({ d:l2(X,S), p });
  }
  if(!cand.length) return null;
  cand.sort((a,b)=>a.d-b.d);
  const top=cand.slice(0,Math.min(k,cand.length));
  let wx=0,wy=0,ws=0;
  for(const {d,p} of top){ const w=1/(d+1e-6); wx+=p.lon*w; wy+=p.lat*w; ws+=w; }
  return {
    lon: wx/ws, lat: wy/ws, floor: top[0].p.floor,
    neighbors: top.map(({d,p})=>({id:p.id,dist:+d.toFixed(3),lon:p.lon,lat:p.lat,floor:p.floor}))
  };
}

// snap เข้าโหนดใกล้สุดของชั้นเดียวกัน
export function snapToGraph(est, BY_FLOOR){
  if(!est) return null;
  const nodes = (BY_FLOOR?.[String(est.floor)]?.nodes) || [];
  if(!nodes.length) return est;
  let best=null, bd=Infinity;
  for(const n of nodes){
    const dx=est.lon-n.lon, dy=est.lat-n.lat, d=dx*dx+dy*dy;
    if(d<bd){ bd=d; best=n; }
  }
  return best ? { lon:best.lon, lat:best.lat, floor:est.floor, snappedTo:best.id } : est;
}

// smoothing เวลา
export function ema(prev, cur, alpha=0.6){
  if(!prev) return cur;
  return {
    lon: prev.lon*(1-alpha) + cur.lon*alpha,
    lat: prev.lat*(1-alpha) + cur.lat*alpha,
    floor: cur.floor,
    snappedTo: cur.snappedTo || prev.snappedTo
  };
}

// วาดจุดตำแหน่งบน MapLibre
export function ensureRTLSLayer(map){
  const src='rtls-pt';
  if(!map.getSource(src)){
    map.addSource(src,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'rtls-pt',type:'circle',source:src,paint:{
      'circle-radius': 6,
      'circle-opacity': 0.95
      // สีเริ่มต้น ปล่อยให้ธีมกำหนดเอง
    }});
  }
}
export function drawRTLS(map, pos){
  const src=map.getSource('rtls-pt'); if(!src) return;
  const f = pos ? { type:'Feature', properties:{ id: pos.snappedTo||'' },
                    geometry:{ type:'Point', coordinates:[pos.lon,pos.lat] } } : null;
  src.setData({ type:'FeatureCollection', features: f?[f]:[] });
}
