// File: demo/js/editor.js
const BASE = new URL('.', location.href).toString().replace(/\/$/, '');
const TILE_URL  = `${BASE}/dist/tiles/{z}/{x}/{y}.pbf`;
const NODES_URL = `${BASE}/dist/_tmp/nodes.geojson`;
const POIS_URL  = `${BASE}/dist/_tmp/pois.geojson`;

const ORIGIN = { lon: 100.50095, lat: 13.75645 }; // ใช้ค่าเดียวกับแอปหลักของคุณ

// ---------- State ----------
let nodesFC = null;     // FeatureCollection (nodes)
let poisFC  = null;     // FeatureCollection (pois)
let list = [];          // merged index for sidebar
let activeId = null;
let addMode = false;

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      indoor: { type:'vector', tiles:[TILE_URL], minzoom:14, maxzoom:22, scheme:'xyz' },
      nodes:  { type:'geojson', data:{type:'FeatureCollection', features:[]} },
      pois:   { type:'geojson', data:{type:'FeatureCollection', features:[]} }
    },
    layers: [
      { id:'bg', type:'background', paint:{ 'background-color':'#0ea5e917' } },
      { id:'rooms-fill', type:'fill', source:'indoor', 'source-layer':'rooms',
        paint:{ 'fill-color':'#a5f3fc','fill-opacity':0.35 } },
      { id:'rooms-outline', type:'line', source:'indoor', 'source-layer':'rooms',
        paint:{ 'line-color':'#ef4444','line-width':1 } },
      // nodes (door/elevator/stairs)
      { id:'nodes-pt', type:'circle', source:'nodes',
        paint:{
          'circle-radius': ['interpolate',['linear'],['zoom'],17,2.2,19,3.4,21,4.6],
          'circle-color': [
            'case',
            ['==',['get','kind'],'door'], '#2563eb',
            ['==',['get','kind'],'lift'], '#16a34a',
            ['==',['get','kind'],'stairs'], '#fb923c',
            '#94a3b8'
          ],
          'circle-stroke-color':'#fff','circle-stroke-width':1
        } },
      { id:'pois-pt', type:'symbol', source:'pois',
        layout:{
          'text-field':['coalesce',['get','name'],['get','id']],
          'text-size':12, 'icon-image':'marker-15', 'text-offset':[0,-1.2]
        },
        paint:{ 'text-color':'#0f172a' }
      }
    ]
  },
  center:[ORIGIN.lon, ORIGIN.lat],
  zoom:19
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}), 'top-right');

// ---------- Utils ----------
const $ = (id)=>document.getElementById(id);
const toFC = (f=[])=>({type:'FeatureCollection', features:f});
const uuid = ()=>crypto.randomUUID ? crypto.randomUUID() : 'id-'+Math.random().toString(36).slice(2);
const parseCSV = (s)=> s.split(',').map(x=>x.trim()).filter(Boolean);
const saveLS = ()=> localStorage.setItem('editor_draft', JSON.stringify({nodesFC, poisFC}));
const loadLS = ()=>{
  try{
    const raw = localStorage.getItem('editor_draft');
    if(!raw) return false;
    const {nodesFC:n, poisFC:p} = JSON.parse(raw);
    if(n?.type==='FeatureCollection') nodesFC=n;
    if(p?.type==='FeatureCollection') poisFC=p;
    return true;
  }catch{ return false; }
};
function toast(msg, ms=1400){
  let el = document.querySelector('.toast');
  if(!el){ el=document.createElement('div'); el.className='toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display='block';
  clearTimeout(el._t); el._t=setTimeout(()=>el.style.display='none', ms);
}
function downloadJSON(obj, filename){
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 500);
}
const kindFromType = (t)=> {
  const s = String(t||'').toLowerCase();
  if (s.includes('door')) return 'door';
  if (s.includes('elev')||s.includes('lift')) return 'lift';
  if (s.includes('stair')||s.includes('บันได')) return 'stairs';
  return 'poi';
};

// ---------- Load data ----------
async function fetchJSON(url){
  const r = await fetch(url, {cache:'no-store'});
  if(!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function loadAll(){
  // local draft first
  const usedDraft = loadLS();

  if(!nodesFC){
    try{
      const raw = await fetchJSON(NODES_URL);
      // normalize nodes: expect lon/lat in properties or geometry Point
      const feats = (raw.features||[]).filter(f=>f.geometry?.type==='Point').map(f=>{
        const p=f.properties||{};
        const kind = kindFromType(p.type||p.kind);
        return { type:'Feature', properties:{
          id: String(p.id||'').trim() || uuid(),
          floor: String(p.floor||'').padStart(2,'0'),
          kind, name: p.name||'', type: p.type||kind, props:p
        }, geometry: f.geometry };
      });
      nodesFC = toFC(feats);
    }catch(e){ nodesFC = toFC([]); console.warn('nodes load fail', e); }
  }
  if(!poisFC){
    try{
      const raw = await fetchJSON(POIS_URL);
      const feats = (raw.features||[]).filter(f=>f.geometry?.type==='Point').map(f=>{
        const p=f.properties||{};
        return { type:'Feature', properties:{
          id:String(p.id||'').trim()||uuid(),
          floor:String(p.floor||'').padStart(2,'0'),
          kind:'poi',
          name:p.name||'', name_th:p.name_th||'',
          categories: Array.isArray(p.categories)?p.categories:[],
          aliases: Array.isArray(p.aliases)?p.aliases:[],
          open_hours: p.open_hours ?? '',
          meta: p.meta ?? {}
        }, geometry:f.geometry };
      });
      poisFC = toFC(feats);
    }catch(e){ poisFC = toFC([]); console.warn('pois load fail', e); }
  }

  // map sources
  map.getSource('nodes').setData(nodesFC);
  map.getSource('pois').setData(poisFC);

  // floor select
  const floors = new Set([
    ...nodesFC.features.map(f=>f.properties.floor),
    ...poisFC.features.map(f=>f.properties.floor)
  ].filter(Boolean));
  const sel = $('filter-floor');
  sel.innerHTML = `<option value="">ทุกชั้น</option>` + [...floors].sort().map(f=>`<option>${f}</option>`).join('');

  rebuildList(); bindMapEvents();
  toast(usedDraft ? 'โหลดจากร่างในเครื่อง' : 'โหลดข้อมูลแล้ว');
}

// ---------- Sidebar list / filters ----------
function rebuildList(){
  const q = $('q').value.trim().toLowerCase();
  const floor = $('filter-floor').value;
  const cat = $('filter-cat').value;

  list = [];
  const push = (f, src)=>{
    const p=f.properties||{}, id=p.id||'(no-id)';
    if (floor && p.floor!==floor) return;
    if (q && ![id, p.name||'', p.name_th||'', (p.categories||[]).join(','),(p.aliases||[]).join(',')].some(s=>String(s).toLowerCase().includes(q))) return;
    if (cat){
      if (src==='poi' && !(p.categories||[]).map(String).includes(cat)) return;
      if (src==='node' && p.kind!==cat && !['door','lift','stairs'].includes(cat)) { /* pass */ }
    }
    list.push({ src, id, name:p.name||'', floor:p.floor||'', f });
  };
  nodesFC.features.forEach(f=>push(f,'node'));
  poisFC.features.forEach(f=>push(f,'poi'));
  list.sort((a,b)=> (a.floor===b.floor? a.id.localeCompare(b.id) : a.floor.localeCompare(b.floor)));

  const ul = $('result');
  ul.innerHTML = list.map(x=>`<div class="item ${x.id===activeId?'active':''}" data-id="${x.id}" data-src="${x.src}">
    <div><strong>${x.id}</strong> <span class="muted">F${x.floor||'-'} · ${x.src}</span></div>
    <div class="muted">${x.name||'-'}</div>
  </div>`).join('');
  ul.querySelectorAll('.item').forEach(el=>{
    el.onclick = ()=>{
      activeId = el.dataset.id;
      const src = el.dataset.src;
      const ft = (src==='poi'? poisFC : nodesFC).features.find(v=>v.properties.id===activeId);
      fillForm(src, ft);
      ul.querySelectorAll('.item').forEach(x=>x.classList.toggle('active', x===el));
      // fly
      if(ft?.geometry?.type==='Point'){
        const [lng,lat] = ft.geometry.coordinates;
        map.easeTo({center:[lng,lat], zoom:20, duration:400});
      }
    };
  });
}
['q','filter-floor','filter-cat'].forEach(id => $(id).addEventListener('input', rebuildList));

// ---------- Form ----------
function fillForm(src, ft){
  $('f-id').value = ft?.properties?.id || '';
  $('f-floor').value = ft?.properties?.floor || '';
  $('f-kind').value = src==='node' ? (ft?.properties?.kind || 'junction') : 'poi';
  $('f-name').value = ft?.properties?.name || '';
  $('f-name-th').value = ft?.properties?.name_th || '';
  $('f-cats').value = (ft?.properties?.categories || []).join(', ');
  $('f-aliases').value = (ft?.properties?.aliases || []).join(', ');
  const oh = ft?.properties?.open_hours;
  $('f-hours').value = typeof oh==='string' ? oh : (oh ? JSON.stringify(oh) : '');
  $('f-meta').value = JSON.stringify(ft?.properties?.meta || {}, null, 2);
  $('btn-del-item').disabled = !ft;
  $('btn-save-item').dataset.src = src;
}
$('btn-uuid').onclick = ()=> $('f-id').value = uuid();

$('btn-save-item').onclick = ()=>{
  const src = $('btn-save-item').dataset.src || 'poi';
  const id = $('f-id').value.trim() || uuid();
  const floor = $('f-floor').value.trim() || '';
  const kind = $('f-kind').value;
  const name = $('f-name').value.trim();
  const name_th = $('f-name-th').value.trim();
  const cats = parseCSV($('f-cats').value);
  const aliases = parseCSV($('f-aliases').value);
  let open_hours = $('f-hours').value.trim();
  if (open_hours && open_hours.includes('{')) { try{ open_hours = JSON.parse(open_hours); }catch{} }
  let meta = {}; try{ meta = JSON.parse($('f-meta').value || '{}'); }catch{}

  // find feature
  const coll = src==='node' ? nodesFC : poisFC;
  let ft = coll.features.find(v=>v.properties.id===id);
  if(!ft){
    // create new at center of map
    const c=map.getCenter();
    ft = { type:'Feature', properties:{id}, geometry:{type:'Point', coordinates:[c.lng,c.lat]} };
    coll.features.push(ft);
  }
  Object.assign(ft.properties, {
    id, floor, name, name_th, aliases, open_hours, meta
  });
  if(src==='node'){ ft.properties.kind = kind; } else { ft.properties.categories = cats; ft.properties.kind='poi'; }

  map.getSource(src==='node'?'nodes':'pois').setData(coll);
  activeId = id; rebuildList(); saveLS();
  toast('บันทึกแล้ว');
};

$('btn-del-item').onclick = ()=>{
  if(!activeId) return;
  const src = $('btn-save-item').dataset.src || 'poi';
  const coll = src==='node' ? nodesFC : poisFC;
  const i = coll.features.findIndex(v=>v.properties.id===activeId);
  if(i>=0){ coll.features.splice(i,1); map.getSource(src==='node'?'nodes':'pois').setData(coll); saveLS(); rebuildList(); toast('ลบแล้ว'); }
  activeId = null; fillForm('poi', null);
};

// ---------- Add mode (click to add) ----------
$('btn-add-point').onclick = ()=>{
  addMode = !addMode;
  $('btn-add-point').textContent = addMode ? 'กำลังเพิ่ม… (คลิกแผนที่)' : 'โหมดเพิ่ม: คลิกบนแผนที่';
  $('btn-add-point').classList.toggle('danger', addMode);
};
map.on('click', (e)=>{
  if(!addMode) return;
  const kind = $('new-kind').value;
  const id = uuid();
  const floor = $('filter-floor').value || '';
  const ft = { type:'Feature', properties:{ id, floor, kind, name:'' }, geometry:{ type:'Point', coordinates:[e.lngLat.lng, e.lngLat.lat] } };
  if(kind==='poi'){
    poisFC.features.push({ ...ft, properties:{...ft.properties, categories:[], aliases:[], name_th:'', open_hours:'', meta:{} } });
    map.getSource('pois').setData(poisFC);
    $('btn-save-item').dataset.src='poi';
  }else{
    nodesFC.features.push(ft);
    map.getSource('nodes').setData(nodesFC);
    $('btn-save-item').dataset.src='node';
  }
  activeId = id; fillForm(kind==='poi'?'poi':'node', ft); rebuildList(); saveLS();
});

// ---------- Map interactions ----------
function bindMapEvents(){
  map.on('click','nodes-pt',(e)=>{
    const f=e.features?.[0]; if(!f) return;
    activeId = f.properties.id; fillForm('node', getById('node',activeId)); rebuildList();
  });
  map.on('click','pois-pt',(e)=>{
    const f=e.features?.[0]; if(!f) return;
    activeId = f.properties.id; fillForm('poi', getById('poi',activeId)); rebuildList();
  });
}
function getById(src,id){
  return (src==='node'?nodesFC:poisFC).features.find(v=>v.properties.id===id);
}

// ---------- Import / Export ----------
$('btn-load-pois').onclick = async ()=>{
  poisFC = null; // force reload
  await loadAll();
};
$('btn-import-pois').onclick = ()=>{
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.geojson,application/json';
  inp.onchange = async ()=>{
    const file=inp.files?.[0]; if(!file) return;
    const txt = await file.text(); const json = JSON.parse(txt);
    if(json.type!=='FeatureCollection'){ alert('ไม่ใช่ FeatureCollection'); return; }
    poisFC = json; map.getSource('pois').setData(poisFC); saveLS(); rebuildList();
    toast('นำเข้า POIs แล้ว');
  };
  inp.click();
};
$('btn-save-pois').onclick = ()=> downloadJSON(poisFC || toFC([]), 'pois.geojson');
$('btn-save-nodes').onclick = ()=> downloadJSON(nodesFC || toFC([]), 'nodes.geojson');

// ---------- Boot ----------
map.on('load', loadAll);
