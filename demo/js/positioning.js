// ============================================================================
// File: demo/js/positioning.js
// Minimal positioning abstraction + blue dot overlay + simulator + WiFi stub.
// ============================================================================

/* WHY: กั้นขอบเขต "วิธีระบุตำแหน่ง" ออกจาก UI/แผนที่ ให้สลับ provider ได้ทีหลัง */

export class EventEmitter {
  constructor(){ this._ev = new Map(); }
  on(k, fn){ (this._ev.get(k) || this._ev.set(k, []).get(k)).push(fn); return () => this.off(k, fn); }
  off(k, fn){ const a=this._ev.get(k)||[]; const i=a.indexOf(fn); if(i>=0) a.splice(i,1); }
  emit(k, v){ (this._ev.get(k)||[]).forEach(fn=>fn(v)); }
}

export const uuidv4 = () =>
  (crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
  }));

// ---- Interface --------------------------------------------------------------
export class PositionProvider extends EventEmitter {
  constructor(opts={}){ super(); this.opts=opts; this.active=false; }
  async start(){ this.active=true; this.emit('status', {state:'starting'}); }
  async stop(){ this.active=false; this.emit('status', {state:'stopped'}); }
  // emit samples:
  // this.emit('position', {lng,lat,accuracy: m, ts})
  // this.emit('heading', {deg, ts})
  // this.emit('floor', {floor})
}

// ---- Simulator (for UI bring-up) -------------------------------------------
export class SimulatedProvider extends PositionProvider {
  constructor(pathGeoJSON, opts={speed:1.2, loop:true, follow:true}) {
    super(opts);
    this.path = (pathGeoJSON?.coordinates || []);
    this.i = 0; this.timer = null;
  }
  async start(){
    await super.start();
    if (!this.path.length){ this.emit('error',{msg:'sim: empty path'}); return; }
    const dt = 300; // ms
    this.timer = setInterval(()=>{
      if(!this.active) return;
      const [lng,lat,floor] = this.path[this.i];
      const [lng2,lat2] = this.path[(this.i+1)%this.path.length];
      const hdg = Math.atan2(lng2-lng, lat2-lat) * 180/Math.PI; // approx
      this.emit('position', {lng,lat,accuracy:2.5, ts:Date.now()});
      if (!Number.isNaN(hdg)) this.emit('heading', {deg:(hdg+360)%360, ts:Date.now()});
      if (floor!=null) this.emit('floor',{floor:String(floor)});
      this.i = (this.i+1) % this.path.length;
      if (this.i===0 && !this.opts.loop) this.stop();
    }, dt);
    this.emit('status',{state:'running'});
  }
  async stop(){ clearInterval(this.timer); await super.stop(); }
}

// ---- WiFi Fingerprint (stub) -----------------------------------------------
export class WiFiFingerprintProvider extends PositionProvider {
  constructor(model, opts={k:5, method:'wknn'}){ super(opts); this.model=model||{anchors:[], samples:[]}; }
  async start(){ await super.start(); this.emit('status',{state:'idle'}); }
  // observation = [{bssid, rssi}, ...]
  predict(observation){
    // TODO: ระยะถัดไป—คำนวณระยะ RSSI distance & weighted centroid หรือ Bayesian
    return null;
  }
  ingestSample({lng,lat,floor, rssis, ts=Date.now()}){
    this.model.samples.push({lng,lat,floor,rssis,ts});
  }
}

// ---- Map overlay (blue dot + heading) --------------------------------------
export function attachBlueDot(map, {sourceId='me-src', layerId='me-dot'} = {}){
  if(!map.getSource(sourceId)){
    map.addSource(sourceId, { type:'geojson', data:{type:'FeatureCollection', features:[]} });
    map.addLayer({
      id: layerId,
      type: 'symbol',
      source: sourceId,
      layout: {
        'icon-image': 'me-dot',
        'icon-size': ['interpolate',['linear'],['zoom'],17,0.6,21,1.0],
        'icon-rotate': ['get','heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true
      }
    });
    // runtime-generated icon (circle + cone)
    const c = document.createElement('canvas'); c.width=c.height=64;
    const x=32,y=32, ctx=c.getContext('2d');
    ctx.fillStyle='#3b82f6'; ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=0.35; ctx.beginPath(); ctx.moveTo(x,y); ctx.arc(x,y,22,-0.35,0.35); ctx.closePath(); ctx.fill();
    map.addImage('me-dot', { width:64, height:64, data:c.getContext('2d').getImageData(0,0,64,64).data, sdf:false }, { pixelRatio:2 });
  }

  const update = (lng,lat,heading=0)=>{
    const fc = {
      type:'FeatureCollection',
      features:[{ type:'Feature', properties:{heading}, geometry:{type:'Point', coordinates:[lng,lat]} }]
    };
    map.getSource(sourceId).setData(fc);
  };
  return update;
}

// ---- Wiring helper ----------------------------------------------------------
export function wirePositionToMap(map, provider, {follow=true, onFloor} = {}){
  const update = attachBlueDot(map, {});
  let lastFloor = null;
  provider.on('position', ({lng,lat})=>{
    update(lng,lat, _heading);
    if(follow) map.easeTo({center:[lng,lat], duration:400});
  });
  let _heading = 0;
  provider.on('heading', ({deg})=>{ _heading = deg; });
  provider.on('floor', ({floor})=>{
    if(lastFloor!==floor){ lastFloor=floor; onFloor?.(floor); }
  });
  provider.on('status', s=>console.debug('[pos]', s));
  provider.on('error', e=>console.warn('[pos]', e));
  return {
    start: ()=>provider.start(),
    stop:  ()=>provider.stop(),
  };
}