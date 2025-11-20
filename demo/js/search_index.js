// ===============================
// File: demo/js/search_index.js
// ===============================
export const defaultPOIUrl = (base) => `${base}/dist/_tmp/pois.geojson?v=${Date.now()}`;

// ---------- Load POIs ----------
export async function loadPOIs(url){
  try{
    const r = await fetch(url, {cache:'no-store'});
    if(!r.ok) throw new Error(`pois ${r.status}`);
    const fc = await r.json();
    return (fc.features||[])
      .filter(f => f?.geometry?.type==='Point')
      .map(f => ({
        id:        String(f.properties?.id ?? ''),
        uuid:      f.properties?.uuid || null,
        name:      String(f.properties?.name ?? ''),
        name_th:   String(f.properties?.name_th ?? ''),
        aliases:   Array.isArray(f.properties?.aliases) ? f.properties.aliases.map(String) : [],
        categories:Array.isArray(f.properties?.categories) ? f.properties.categories.map(s=>String(s).toLowerCase()) : [],
        floor:     String(f.properties?.floor ?? ''),
        lng:       +f.geometry.coordinates[0],
        lat:       +f.geometry.coordinates[1],
        open_hours:f.properties?.open_hours ?? null,
        raw:       f
      }));
  }catch(e){
    console.warn('[pois] load fail:', e);
    return [];
  }
}

// ---------- Fallback: build POIs from graph nodes ----------
export function poisFromNodes(byFloor){
  const items = [];
  const norm = (s)=>String(s||'').toLowerCase();
  for (const [floor, nodes] of Object.entries(byFloor||{})) {
    for (const node of Object.values(nodes||{})) {
      const id = String(node.id||'').trim();
      if (!id) continue;
      const t = norm(node.type);
      const isDoor = t.includes('door');
      const isElev = t.includes('elevator') || t.includes('lift');
      const isStair= t.includes('stair') || t.includes('บันได');
      if (!(isDoor || isElev || isStair)) continue;
      const cat = isDoor ? 'door' : (isElev ? 'lift' : 'stairs');
      items.push({
        id, uuid:null, name:id, name_th:'',
        aliases:[], categories:[cat], floor:String(floor),
        lng:+node.lon, lat:+node.lat, open_hours:null, raw:node
      });
    }
  }
  return items;
}

// ---------- Normalize/Token ----------
const TH_DIAC = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
const EN_DIAC = /[\u0300-\u036f]/g;
const toASCII = (s) => s.normalize('NFD').replace(EN_DIAC,'');
const norm = (s) => toASCII(String(s||'').toLowerCase().replace(TH_DIAC,'').trim());
const toks = (s) => norm(s).split(/[^a-z0-9\u0E00-\u0E7F]+/).filter(Boolean);

// ---------- Category synonyms ----------
const CAT_SYNONYM = {
  restroom: ['restroom','toilet','wc','ห้องน้ำ','สุขา'],
  lift:     ['lift','elevator','ลิฟต์'],
  stairs:   ['stairs','บันได'],
  door:     ['door','ประตู'],
  cafe:     ['cafe','coffee','คาเฟ่','กาแฟ'],
  food:     ['food','canteen','ร้านอาหาร','อาหาร','โรงอาหาร'],
  office:   ['office','สำนักงาน'],
  classroom:['classroom','ห้องเรียน'],
  lab:      ['lab','ห้องแลป','ห้องทดลอง'],
  printer:  ['printer','พิมพ์','เครื่องพิมพ์'],
  exit:     ['exit','ทางออก'],
};
const TERM2CAT = (()=> {
  const m = new Map();
  for (const [cat, arr] of Object.entries(CAT_SYNONYM)) arr.forEach(t => m.set(norm(t), cat));
  return m;
})();

// ---------- Build index ----------
export function buildPOIIndex(items){
  const recs = items.map((it, i) => {
    const fields = [it.id, it.name, it.name_th, ...(it.aliases||[]), ...(it.categories||[])];
    const text = fields.filter(Boolean).map(norm).join(' ');
    const tokens = new Set(toks(text));
    const cats = new Set([...(it.categories||[]).map(norm)]);
    for (const t of tokens) { const c=TERM2CAT.get(t); if(c) cats.add(c); }
    return { i, it, text, tokens, cats, floors: new Set([norm(it.floor)]) };
  });
  return { items, recs, size: items.length };
}

// ---------- Fuzzy search ----------
const ed2 = (a,b)=>{ a=norm(a); b=norm(b);
  const la=a.length, lb=b.length; if(Math.abs(la-lb)>2) return 3;
  const dp=Array.from({length:la+1},(_,i)=>Array(lb+1).fill(0)); for(let i=0;i<=la;i++) dp[i][0]=i; for(let j=0;j<=lb;j++) dp[0][j]=j;
  for(let i=1;i<=la;i++) for(let j=1;j<=lb;j++){
    const cost = a[i-1]===b[j-1]?0:1;
    dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1]) dp[i][j]=Math.min(dp[i][j], dp[i-2][j-2]+1);
  }
  return dp[la][lb];
};
function scoreRecord(q, rec, wantCat){
  const nq = norm(q);
  if (wantCat && !rec.cats.has(wantCat)) return -Infinity;
  let s = 0;
  const qCat = TERM2CAT.get(nq); if (qCat && rec.cats.has(qCat)) s += 8;
  const fields = [rec.it.id, rec.it.name, rec.it.name_th, ...(rec.it.aliases||[])].map(norm);
  for (const f of fields) {
    if (!f) continue;
    if (f === nq) s+=10;
    else if (f.startsWith(nq)) s+=6;
    else if (f.includes(nq)) s+=3;
    else { const d=ed2(f,nq); if(d===1) s+=2; else if(d===2) s+=1; }
  }
  for (const t of toks(nq)) if (rec.tokens.has(t)) s+=2;
  const mf = nq.match(/f(\d{2})/i); if (mf && rec.floors.has(mf[1])) s+=2;
  return s;
}
export function searchPOIs(index, q, {limit=8, category=null} = {}){
  const wantCat = category ? norm(category) : null;
  const nq = norm(q||'');
  // empty query + category → top by category
  if (!nq && wantCat){
    const arr = index.recs.filter(r=>r.cats.has(wantCat)).slice(0, limit).map(({it})=>itToRes(it, wantCat));
    return arr;
  }
  if (!nq) return [];
  const scored = [];
  for (const rec of index.recs) {
    const s = scoreRecord(nq, rec, wantCat);
    if (s>0) scored.push({score:s, rec});
  }
  scored.sort((a,b)=> b.score - a.score);
  return scored.slice(0,limit).map(({rec})=>itToRes(rec.it, wantCat, nq, rec));
}
function itToRes(it, _cat, nq='', rec=null){
  return {
    id: it.id,
    name: it.name || it.name_th || it.id,
    name_th: it.name_th || '',
    floor: it.floor,
    categories: [...(rec?.cats || new Set(it.categories||[]))],
    lng: it.lng, lat: it.lat,
    highlight: mkHighlight(it, nq)
  };
}
function mkHighlight(it, nq){
  if(!nq) return it.name || it.name_th || it.id;
  const f = (s)=>{ const ns=norm(s), i=ns.indexOf(nq); if(i<0) return s; return s.substring(0,i)+'<mark>'+s.substring(i,i+nq.length)+'</mark>'+s.substring(i+nq.length); };
  return f(it.name || it.name_th || it.id);
}

// ---------- UI: Typeahead + Category Chips ----------
const DEFAULT_CHIPS = ['door','lift','stairs','restroom','cafe','food','office','classroom','lab','printer','exit'];

export function mountSearchUI(map, index, { onPick, chips=DEFAULT_CHIPS } = {}){
  const host = document.getElementById('right-panel') || document.body;
  const wrap = document.createElement('div');
  wrap.id = 'poi-search';
  wrap.style.cssText = 'position:relative;margin:6px 0 10px;padding:8px;border:1px solid #d1d5db;border-radius:10px;background:#fff;';
  wrap.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">
      <input id="poi-q" type="text" placeholder="ค้นหา: N089, restroom, ลิฟต์, cafe..." style="flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px"/>
      <button id="poi-clear" title="ล้าง" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc">✕</button>
    </div>
    <div id="poi-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
    <div id="poi-dd" style="position:absolute;left:8px;right:8px;top:98px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.08);display:none;max-height:280px;overflow:auto;z-index:5"></div>
  `;
  host.prepend(wrap);

  const qEl   = wrap.querySelector('#poi-q');
  const dd    = wrap.querySelector('#poi-dd');
  const chipsEl = wrap.querySelector('#poi-chips');
  const clrBtn = wrap.querySelector('#poi-clear');

  // chips
  let activeCat = '';
  chipsEl.innerHTML = chips.map(c=>`<button class="chip" data-cat="${c}" style="padding:6px 10px;border:1px solid #e5e7eb;border-radius:999px;background:#f8fafc;font-size:12px">${c}</button>`).join('');
  const setActive = (cat)=>{
    activeCat = cat;
    chipsEl.querySelectorAll('.chip').forEach(b=>b.style.background = (b.dataset.cat===cat)?'#e0f2fe':'#f8fafc');
    doSearch(); // refresh list
  };
  chipsEl.querySelectorAll('.chip').forEach(b=>{
    b.onclick = ()=> setActive( b.dataset.cat === activeCat ? '' : b.dataset.cat );
  });
  clrBtn.onclick = ()=>{ qEl.value=''; doSearch(); };

  // pin
  const srcId='poi-search-pin';
  if(!map.getSource(srcId)){
    map.addSource(srcId, {type:'geojson', data:{type:'FeatureCollection',features:[]}});
    map.addLayer({
      id:'poi-search-pin', type:'symbol', source:srcId,
      layout:{ 'text-field':['get','label'], 'text-size':12, 'text-offset':[0,-1.2], 'icon-image':'marker-15', 'icon-allow-overlap':true }
    });
  }

  let cursor = -1, results = [];
  const render = ()=>{
    if(!results.length){ dd.style.display='none'; return; }
    dd.style.display='block';
    dd.innerHTML = results.map((r, i)=>`
      <div data-i="${i}" style="padding:8px 10px;cursor:pointer;background:${i===cursor?'#eff6ff':'#fff'}">
        <div style="font-weight:600" class="hl">${r.highlight}</div>
        <div style="font-size:12px;color:#64748b">F${r.floor} · ${r.categories.join(', ')||'-'}</div>
      </div>`).join('');
    dd.querySelectorAll('[data-i]').forEach(el=> el.onclick = ()=> pick(+el.dataset.i) );
  };
  const pick = (i)=>{
    if(i<0||i>=results.length) return;
    const r = results[i];
    const fc={ type:'FeatureCollection', features:[{
      type:'Feature', properties:{ label: r.name || r.name_th || r.id }, geometry:{ type:'Point', coordinates:[r.lng, r.lat] }
    }]};
    map.getSource(srcId).setData(fc);
    map.easeTo({center:[r.lng, r.lat], zoom:20, duration:500});
    onPick?.(r);
    hide();
  };
  const hide = ()=>{ dd.style.display='none'; cursor=-1; };

  const doSearch = ()=>{
    const q = qEl.value.trim();
    const cat = activeCat || null;
    // empty + no category → hide
    if(!q && !cat){ results=[]; hide(); return; }
    results = searchPOIs(index, q, {limit:10, category:cat});
    cursor = results.length?0:-1;
    render();
  };
  const debounced = debounce(doSearch, 120);
  qEl.addEventListener('input', debounced);
  qEl.addEventListener('keydown', (e)=>{
    if(dd.style.display==='none') return;
    if(e.key==='ArrowDown'){ cursor=Math.min(cursor+1, results.length-1); render(); e.preventDefault(); }
    if(e.key==='ArrowUp'){ cursor=Math.max(cursor-1, 0); render(); e.preventDefault(); }
    if(e.key==='Enter'){ pick(cursor>=0?cursor:0); e.preventDefault(); }
    if(e.key==='Escape'){ hide(); }
  });
  document.addEventListener('click',(e)=>{ if(!wrap.contains(e.target)) hide(); });

  // autofocus
  setTimeout(()=>qEl.focus(), 50);
}

function debounce(fn, ms){ let t=null; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
