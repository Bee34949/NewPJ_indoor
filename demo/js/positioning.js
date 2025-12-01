// ============================
// File: demo/js/positioning.js
// ============================

export class EventEmitter {
  constructor(){ this._ev = new Map(); }
  on(k, fn){ (this._ev.get(k) || this._ev.set(k, []).get(k)).push(fn); return () => this.off(k, fn); }
  off(k, fn){ const a=this._ev.get(k)||[]; const i=a.indexOf(fn); if(i>=0) a.splice(i,1); }
  emit(k, v){ (this._ev.get(k)||[]).forEach(fn=>fn(v)); }
}

export class PositionProvider extends EventEmitter {
  constructor(opts={}){ super(); this.opts=opts; this.active=false; }
  async start(){ this.active=true; this.emit('status', {state:'starting'}); }
  async stop(){ this.active=false; this.emit('status', {state:'stopped'}); }
}

const EPS = 1e-6;
export const canonBssid = (s) => {
  if (!s) return '';
  const hex = String(s).toLowerCase().replace(/[^0-9a-f]/g,'');
  return hex.slice(0,12);
};

// ---- WiFi Fingerprint (kNN)
export class WiFiFingerprintProvider extends PositionProvider {
  /**
   * model: { signatures: { ap_dict, points:[{lon,lat,floor,rssi:{bssid:rssi}}], weights_sqrt? } }
   * opts:  { k=4, minOverlap=0.2, minAP=3, floorHint? }
   */
  constructor(model, opts={k:4,minOverlap:0.2,minAP:3}) {
    super(opts);
    const S = model?.signatures || {};
    // canonicalize signature keys once
    const AP = Object.create(null);
    for (const k of Object.keys(S.ap_dict||{})) AP[canonBssid(k)] = true;
    const PTS = (S.points||[]).map(p=>{
      const r = Object.create(null);
      for (const [b, v] of Object.entries(p.rssi||{})) r[canonBssid(b)] = Number(v);
      return { id:p.id, lon:Number(p.lon), lat:Number(p.lat), floor:String(p.floor||''), rssi:r };
    });
    this.sign = { ap_set: AP, points: PTS };
  }
  async start(){ await super.start(); this.emit('status',{state:'idle'}); }
  // observation = [{bssid, rssi}, ...]  (bssid any format)
  predict(observation){
    if (!this.active) return null;
    const { k=4, minOverlap=0.2, minAP=3, floorHint=null } = this.opts || {};
    const obs = Object.create(null);
    for (const o of (observation||[])) obs[canonBssid(o.bssid)] = Number(o.rssi);
    const obsKeys = Object.keys(obs);
    if (!obsKeys.length) return null;

    let best = [];
    for (const p of this.sign.points){
      if (floorHint && p.floor !== String(floorHint)) continue;
      // overlap set
      let ol=0, dist=0;
      for (const b of obsKeys){
        const v2 = p.rssi[b];
        if (v2==null) continue;
        ol++;
        const d = (obs[b] - v2);
        dist += d*d;
      }
      if (ol < minAP || ol < Math.ceil(minOverlap * obsKeys.length)) continue; // WHY: กัน noise
      best.push({p, dist: Math.max(dist, EPS), ol});
    }
    if (!best.length) return null;

    best.sort((a,b)=>a.dist-b.dist);
    const top = best.slice(0, Math.max(1, k));

    // weighted centroid
    let wsum=0, lon=0, lat=0;
    const floors = Object.create(null);
    for (const {p, dist} of top){
      const w = 1.0 / (Math.sqrt(dist) + 1.0); // WHY: ลด bias ระยะ 0
      wsum += w; lon += p.lon*w; lat += p.lat*w;
      floors[p.floor] = (floors[p.floor]||0)+w;
    }
    lon/=wsum; lat/=wsum;

    // pick floor by max weight (or hint)
    let floor = floorHint || Object.entries(floors).sort((a,b)=>b[1]-a[1])[0][0] || '';
    return { lon, lat, floor };
  }
}

// ---- Blue dot overlay + wiring (เหมือนเดิม)
function ensureSource(map, id){
  if (map.getSource(id)) return;
  map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
  if (!map.getLayer(id)) map.addLayer({ id, type:'symbol', source:id, layout:{ 'icon-image':'marker-15' } });
}
export function attachBlueDot(map){
  const sourceId = 'rtls-blue-dot';
  ensureSource(map, sourceId);
  const update = (lng,lat,heading=0)=>{
    const fc = {
      type:'FeatureCollection',
      features:[{ type:'Feature', properties:{heading}, geometry:{type:'Point', coordinates:[lng,lat]} }]
    };
    map.getSource(sourceId).setData(fc);
  };
  return update;
}
export function wirePositionToMap(map, provider, {follow=true, onFloor} = {}){
  const update = attachBlueDot(map, {});
  let lastFloor = null;
  provider.on('position', ({lng,lat,heading})=>{
    update(lng,lat, heading);
    if(follow) map.easeTo({center:[lng,lat], duration:400});
  });
  provider.on('floor', ({floor})=>{
    if(lastFloor!==floor){ lastFloor=floor; onFloor?.(floor); }
  });
  provider.on('status', s=>console.debug('[pos]', s));
  provider.on('error', e=>console.warn('[pos]', e));
  return { start: ()=>provider.start(), stop: ()=>provider.stop() };
}