// /demo/js/graph.js
export const FLOORS = ["01","02","03","04","05","06"];
export const ORIGIN = { lon: 100.52952, lat: 13.73637 };

const R=6378137, D2R=Math.PI/180;
const llToMeters=p=>{const x=(p.lon-ORIGIN.lon)*D2R*R*Math.cos((p.lat+ORIGIN.lat)/2*D2R);const y=(p.lat-ORIGIN.lat)*D2R*R;return {x,y};};
export const distLngLat=(a,b)=>{const A=llToMeters({lon:a[0],lat:a[1]}),B=llToMeters({lon:b[0],lat:b[1]});return Math.hypot(A.x-B.x,A.y-B.y);};

const pad2=s=>('00'+String(s??'01')).slice(-2);
const kindOf = t=>{
  const s=String(t||'').toLowerCase();
  if(s.includes('elevator')||s.includes('lift')) return 'elevator';
  if(s.includes('stair')||s.includes('บันได')) return 'stairs';
  return null;
};
const normId = s => String(s||'').toLowerCase().replace(/\s+/g,''); // สำคัญสำหรับจับคู่ข้ามชั้น

export async function loadNodes(url){
  const r = await fetch(url, {cache:'no-store'}); if(!r.ok) throw new Error('nodes fetch fail');
  const fc = await r.json();
  const byFloor = {};
  for(const ft of fc.features||[]){
    if(ft.type!=='Feature') continue;
    const p=ft.properties||{}, [lon,lat]=ft.geometry?.coordinates||[];
    const id=String(p.id??'').trim(); if(!id||!isFinite(lon)||!isFinite(lat)) continue;
    const floor=pad2(p.floor), type=String(p.type||''), shaft=p.shaft??null, side=p.side??null;
    (byFloor[floor] ||= {})[id] = { id, lon:+lon, lat:+lat, floor, type, shaft, side };
  }
  return { fc, byFloor };
}

export function precomputeAdj(byFloor, k=6){
  const adj = {};
  for(const f of FLOORS){
    const nodes = byFloor[f]||{}; const ids = Object.keys(nodes);
    const out = {};
    for(let i=0;i<ids.length;i++){
      const a=nodes[ids[i]], cand=[];
      for(let j=0;j<ids.length;j++){
        if(i===j) continue;
        const b=nodes[ids[j]];
        cand.push({id:b.id, d: distLngLat([a.lon,a.lat],[b.lon,b.lat])});
      }
      cand.sort((u,v)=>u.d-v.d);
      out[a.id] = cand.slice(0, Math.min(k, cand.length)).map(nb=>({to:nb.id,w:nb.d}));
    }
    adj[f] = out;
  }
  return adj;
}

function buildSideMaps(byFloor){
  const sideMaps={elevator:{},stairs:{}};
  for(const f of FLOORS){
    const nodes=byFloor[f]||{}; const kinds={elevator:[],stairs:[]};
    for(const id in nodes){ const n=nodes[id]; const k=kindOf(n.type); if(!k) continue; kinds[k].push(n); }
    for(const k of ['elevator','stairs']){
      const arr=kinds[k]; if(!arr.length) continue; const m=sideMaps[k][f]={};
      const hasMeta=arr.some(n=>n.shaft||n.side);
      if(hasMeta){ for(const n of arr){ m[n.id]= n.shaft?`shaft:${n.shaft}` : (n.side?`side:${n.side}`:'side:?'); } }
      else{
        const sorted=[...arr].sort((a,b)=>a.lon-b.lon);
        for(let i=0;i<sorted.length;i++){
          const frac=(i+1)/(sorted.length+1), side=frac<=1/3?'L':(frac>=2/3?'R':'C');
          m[sorted[i].id]=`side:${side}`;
        }
      }
    }
  }
  return sideMaps;
}

/**
 * สร้างกราฟรวมทุกชั้น:
 * - in-floor: จาก adjPerFloor
 * - cross-floor: (1) จับคู่ด้วย normId+side/shaft (แข็งแรงกว่าเดิม)
 *                (2) fallback จับคู่ชั้นติดกันด้วย side เดียวกันและ "ใกล้สุด"
 */
export function buildGlobalGraph(byFloor, adjPerFloor, {avoidStairs=false}={}, floorCost=8){
  const G = {};
  const sideMaps=buildSideMaps(byFloor);

  // 1) in-floor edges
  for(const f of FLOORS){
    const adj = adjPerFloor[f]||{};
    for(const id in adj){
      for(const e of adj[id]){
        const a=`${f}:${id}`, b=`${f}:${e.to}`;
        (G[a] ||= []).push({v:b,w:e.w});
      }
    }
  }

  // อนุญาตชนิดตัวเชื่อม
  const allow = avoidStairs?['elevator']:['elevator','stairs'];

  // 2) จับคู่ด้วย group key = normId(id)|kind|side/shaft (ถ้าข้อมูลตั้งชื่อ staircase/elevator ตระกูลเดียวกันข้ามชั้น จะเชื่อมสมบูรณ์)
  const groups={};
  for(const f of FLOORS){
    for(const id in (byFloor[f]||{})){
      const n=byFloor[f][id]; const k=kindOf(n.type);
      if(!k || !allow.includes(k)) continue;
      const sideKey=(sideMaps[k]?.[f]?.[id])||'side:?';
      const gk=`${normId(id)}|${k}|${sideKey}`;
      (groups[gk] ||= []).push({floor:f,id});
    }
  }
  for(const key in groups){
    const arr=groups[key].sort((a,b)=>a.floor.localeCompare(b.floor));
    for(let i=1;i<arr.length;i++){
      const a=arr[i-1], b=arr[i];
      const ka=`${a.floor}:${a.id}`, kb=`${b.floor}:${b.id}`;
      (G[ka] ||= []).push({v:kb,w:floorCost});
      (G[kb] ||= []).push({v:ka,w:floorCost});
    }
  }

  // 3) Fallback: เชื่อม "ชั้นติดกัน" โดยจับคู่ตัวเชื่อมชนิดเดียวกัน + side เดียวกัน + ใกล้สุด (กันกรณีแต่ละชั้นใช้ id ไม่สอดคล้องกัน)
  for(let i=1;i<FLOORS.length;i++){
    const fA=FLOORS[i-1], fB=FLOORS[i];
    for(const k of allow){
      const A=Object.values(byFloor[fA]||{}).filter(n=>kindOf(n.type)===k);
      const B=Object.values(byFloor[fB]||{}).filter(n=>kindOf(n.type)===k);
      if(!A.length||!B.length) continue;
      const usedB=new Set();
      for(const a of A){
        const sideA=sideMaps[k]?.[fA]?.[a.id];
        let best=null,bestD=Infinity;
        for(const b of B){
          const sideB=sideMaps[k]?.[fB]?.[b.id];
          if(sideA&&sideB&&sideA!==sideB) continue;
          if(usedB.has(b.id)) continue;
          const d=distLngLat([a.lon,a.lat],[b.lon,b.lat]);
          if(d<bestD){bestD=d;best=b;}
        }
        if(best){
          usedB.add(best.id);
          const ka=`${a.floor}:${a.id}`, kb=`${best.floor}:${best.id}`;
          (G[ka] ||= []).push({v:kb,w:floorCost});
          (G[kb] ||= []).push({v:ka,w:floorCost});
        }
      }
    }
  }

  return G;
}

export function dijkstra(G, startKey, goalKey){
  const V = Object.keys(G); if(!V.includes(startKey) || !V.includes(goalKey)) return null;
  const D=new Map(), P=new Map(), Q=new Set(V);
  V.forEach(v=>D.set(v,Infinity)); D.set(startKey,0);
  while(Q.size){
    let u=null,best=Infinity; for(const v of Q){ const dv=D.get(v); if(dv<best){best=dv;u=v;} }
    if(u===null) break; Q.delete(u); if(u===goalKey) break;
    for(const e of (G[u]||[])){ if(!Q.has(e.v)) continue; const alt=D.get(u)+e.w; if(alt<D.get(e.v)){ D.set(e.v,alt); P.set(e.v,u); } }
  }
  if(startKey!==goalKey && !P.has(goalKey)) return null;
  const path=[]; let u=goalKey; while(u){ path.unshift(u); if(u===startKey) break; u=P.get(u); if(!u) break; }
  return path;
}

export function pathToFloorSegments(pathKeys, byFloor){
  const feats=[]; let curF=null, seg=[];
  const flush=()=>{ if(seg.length>1&&curF){ feats.push({type:'Feature',properties:{floor:curF},geometry:{type:'LineString',coordinates:seg.slice()}});} seg=[]; curF=null; };
  for(const k of pathKeys){
    const [f,id]=k.split(':'); const n=byFloor[f]?.[id]; if(!n) continue;
    if(curF===null){ curF=f; seg.push([n.lon,n.lat]); continue; }
    if(f===curF) seg.push([n.lon,n.lat]); else { flush(); curF=f; seg.push([n.lon,n.lat]); }
  }
  flush(); return feats;
}
