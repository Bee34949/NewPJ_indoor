import { distLngLat } from './graph.js';

export function createPlayback(map, opts){
  const state={
    points:[], idx:0, speed:1.2, follow:true,
    marker:null, lastTs:0, playing:false,
    trailSeg:[], trailFeats:[], trailFloor:null,
    pauseMs:300, trailOnlySameFloor:true,
    currentFloor:'ALL',
    onFloorChange:null, // cb(floor, dir, kind)
  };

  const toast = document.getElementById('toast');
  const showToast=(msg,ms=900)=>{ toast.textContent=msg; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'), ms); };

  const ensureMarker=()=>{
    if(state.marker) return;
    const el=document.createElement('div'); el.className='pulse';
    state.marker=new maplibregl.Marker({element:el,anchor:'center'});
  };

  const trailSrc=()=>map.getSource('anim_trail');

  const trailClear=()=>{
    state.trailSeg=[]; state.trailFeats=[]; state.trailFloor=null;
    trailSrc().setData({type:'FeatureCollection',features:[]});
  };
  const trailStart=p=>{ state.trailSeg=[[p.lon,p.lat]]; state.trailFloor=p.floor; };
  const trailCommit=()=>{
    if(state.trailSeg.length>1 && state.trailFloor){
      state.trailFeats.push({type:'Feature',properties:{floor:state.trailFloor},geometry:{type:'LineString',coordinates:state.trailSeg.slice()}});
    }
    state.trailSeg=[]; state.trailFloor=null;
  };
  const trailPush=p=>{ if(!state.trailSeg.length){ trailStart(p); return; } state.trailSeg.push([p.lon,p.lat]); };
  const trailUpdate=()=>{
    const feats = state.trailSeg.length>1 ? [...state.trailFeats,{type:'Feature',properties:{floor:state.trailFloor},geometry:{type:'LineString',coordinates:state.trailSeg}}] : [...state.trailFeats];
    trailSrc().setData({type:'FeatureCollection',features:feats});
  };

  const setFloor=(floor)=>{
    state.currentFloor = floor;
    // filter layers by floor
    const ids=['rooms-fill','rooms-outline','features-line','rooms-hover','nodes-gj','nodes-gj-label','route-line','anim-trail'].filter(id=>map.getLayer(id));
    const flt=(floor==='ALL')?null:['==',['to-string',['get','floor']],floor];
    ids.forEach(id=>map.setFilter(id, flt));
    // if showing trail only same floor, hide previous segments:
    if(state.trailOnlySameFloor){
      const feats = (state.trailSeg.length>1 && state.trailFloor===floor)
        ? [{type:'Feature',properties:{floor},geometry:{type:'LineString',coordinates:state.trailSeg}}]
        : [];
      trailSrc().setData({type:'FeatureCollection',features:feats});
    }
  };

  const updateMarker=(p, force=false)=>{
    ensureMarker(); state.marker.setLngLat([p.lon,p.lat]).addTo(map);
    if(force||state.follow) map.easeTo({center:[p.lon,p.lat], duration:120});
    if(state.currentFloor!==p.floor) setFloor(p.floor);
  };

  const tick=(ts)=>{
    if(!state.playing) return;
    if(!state.lastTs) state.lastTs=ts;
    let remain = state.speed * ((ts - state.lastTs)/1000);
    state.lastTs = ts;

    while(remain>0 && state.idx < state.points.length-1){
      const a=state.points[state.idx], b=state.points[state.idx+1];

      // warp/floor change
      if(b.warpFromPrev || a.floor!==b.floor){
        state.idx++;
        trailCommit(); trailStart(state.points[state.idx]); updateMarker(state.points[state.idx], true);

        if(state.onFloorChange){
          const dir = (b.floor > a.floor) ? 'up' : 'down';
          const kind = null; // เดาได้จาก caller ถ้าต้องการ
          state.onFloorChange(b.floor, dir, kind);
        }
        state.playing=false;
        setTimeout(()=>{ state.playing=true; state.lastTs=0; requestAnimationFrame(tick); }, state.pauseMs);
        return;
      }

      const d=distLngLat([a.lon,a.lat],[b.lon,b.lat]);
      if(remain >= d){ state.idx++; trailPush(b); remain-=d; }
      else{
        const t=remain/d; const nx=a.lon+(b.lon-a.lon)*t; const ny=a.lat+(b.lat-a.lat)*t;
        state.points[state.idx]={lon:nx,lat:ny,floor:b.floor}; trailPush(state.points[state.idx]); remain=0;
      }
      if(state.trailSeg.length%5===0 && !state.trailOnlySameFloor) trailUpdate();
    }

    const p=state.points[Math.min(state.idx, state.points.length-1)];
    updateMarker(p);
    if(state.idx >= state.points.length-1){ trailCommit(); if(!state.trailOnlySameFloor) trailUpdate(); state.playing=false; return; }
    requestAnimationFrame(tick);
  };

  return {
    setRoutePoints(points){ state.points=points; state.idx=0; state.lastTs=0; trailClear(); if(points.length){ setFloor(points[0].floor); trailStart(points[0]); updateMarker(points[0], true);} },
    play(){ if(!state.points.length) return; state.playing=true; requestAnimationFrame(tick); },
    pause(){ state.playing=false; },
    reset(){ if(!state.points.length) return; state.idx=0; state.lastTs=0; trailClear(); trailStart(state.points[0]); updateMarker(state.points[0], true); },
    setSpeed(v){ state.speed=v; },
    followCamera(v){ state.follow=v; },
    setPauseMs(ms){ state.pauseMs=ms; },
    setTrailSameFloor(v){ state.trailOnlySameFloor=v; if(v) trailClear(); },
    onFloorChange(cb){ state.onFloorChange=cb; },
    toast: showToast,
    setFloor
  };
}