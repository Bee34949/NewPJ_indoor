// demo/js/rtls_poll_client.js  (fixed)
const urlFromConfig = () => {
  if (window.SCAN_URL) return window.SCAN_URL;
  const q = new URLSearchParams(location.search);
  const port = q.get('scanPort') || '8765';
  const host = location.hostname || '127.0.0.1';
  return `http://${host}:${port}/scan.json`;
};

let URL_SCAN = urlFromConfig();
let failCount = 0;

async function tick(){
  try{
    const res = await fetch(URL_SCAN, { cache:'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const scan = await res.json();
    const n = Object.keys(scan||{}).length;
    console.log('[poll] OK', n, 'APs');
    if (window.onScanPolled) window.onScanPolled({n, scan});
    if (window.pushScan && n) window.pushScan(scan);
    failCount = 0;
  }catch(err){
    failCount++;
    if (failCount % 5 === 0) console.warn('[poll] ERR', URL_SCAN, err?.message || err);
  }
}
setInterval(tick, 1000);
console.log('[poll] polling', URL_SCAN);
