

/**
 * Batch reproject GeoJSON → WGS84 (EPSG:4326) using GDAL.
 * ใช้: node tools/reproject_wgs84.js --dir dist --glob "Floor*.grouped.geojson" --src EPSG:3857
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import url from 'node:url';

function die(msg, code = 1) { console.error(`[reproject] ${msg}`); process.exit(code); }

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = { dir: 'dist', glob: '*.geojson', src: null, inplace: false, precision: 6 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') cfg.dir = args[++i];
    else if (a === '--glob') cfg.glob = args[++i];
    else if (a === '--src') cfg.src = args[++i];                 // EPSG:3857 หรือ PROJ string
    else if (a === '--inplace') cfg.inplace = true;
    else if (a === '--precision') cfg.precision = Number(args[++i] || 6);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node tools/reproject_wgs84.js --dir dist --glob "Floor*.grouped.geojson" [--src EPSG:3857] [--inplace] [--precision 6]`);
      process.exit(0);
    }
  }
  return cfg;
}

function checkOgr() {
  const r = spawnSync('ogr2ogr', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    die('ไม่พบ ogr2ogr ใน PATH. ติดตั้ง GDAL ก่อน (macOS: brew install gdal, Ubuntu: apt-get install gdal-bin, Windows: OSGeo4W/GISInternals).');
  }
  console.log(`[reproject] ${r.stdout.trim()}`);
}

function globToRegex(glob) {
  // รองรับ * และ ?
  let s = '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(s, 'i');
}

function listFiles(dir, regex) {
  if (!fs.existsSync(dir)) die(`ไม่พบโฟลเดอร์: ${dir}`);
  return fs.readdirSync(dir).filter(f => regex.test(f) && fs.statSync(path.join(dir, f)).isFile());
}

function runOgr(inPath, outPath, src, precision) {
  const args = [];
  if (src) args.push('-s_srs', src);
  args.push('-t_srs', 'EPSG:4326', '-lco', `COORDINATE_PRECISION=${precision}`, outPath, inPath);
  const r = spawnSync('ogr2ogr', args, { encoding: 'utf8' });
  return r;
}

function sampleCoordFromGeoJSON(file) {
  try {
    const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const f of gj.features || []) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Point') return g.coordinates;
      if (g.type === 'MultiPoint' || g.type === 'LineString') return g.coordinates?.[0];
      if (g.type === 'MultiLineString' || g.type === 'Polygon') return g.coordinates?.[0]?.[0];
      if (g.type === 'MultiPolygon') return g.coordinates?.[0]?.[0]?.[0];
    }
  } catch { /* ignore */ }
  return null;
}

function isWGS84LonLat(x, y) { return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90; }

(function main() {
  const cfg = parseArgs();
  checkOgr();

  const dir = path.resolve(cfg.dir);
  const rx = globToRegex(cfg.glob);
  const files = listFiles(dir, rx);
  if (!files.length) die(`ไม่พบไฟล์ที่ตรงกับ glob "${cfg.glob}" ใต้โฟลเดอร์ ${dir}`);

  console.log(`[reproject] Source dir: ${dir}`);
  console.log(`[reproject] Files: ${files.length} ไฟล์`);
  console.log(`[reproject] Options: src=${cfg.src || '(auto)'} inplace=${cfg.inplace} precision=${cfg.precision}`);

  let ok = 0, fail = 0;
  for (const f of files) {
    const inPath = path.join(dir, f);
    const outPath = cfg.inplace ? inPath : path.join(dir, f.replace(/\.geojson$/i, '.wgs84.geojson'));
    const tmpOut = cfg.inplace ? inPath + '.tmp.wgs84.geojson' : outPath;

    process.stdout.write(`[reproject] → ${path.basename(f)} ... `);
    const r = runOgr(inPath, tmpOut, cfg.src, cfg.precision);
    if (r.status !== 0) {
      fail++;
      console.log(`FAIL\n  ${r.stderr.trim()}`);
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      continue;
    }

    const c = sampleCoordFromGeoJSON(tmpOut);
    if (!c || !isWGS84LonLat(c[0], c[1])) {
      fail++;
      console.log(`FAIL (พิกัดไม่เป็น WGS84)`);
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      continue;
    }

    if (cfg.inplace) fs.renameSync(tmpOut, outPath);
    ok++;
    console.log('OK');
  }

  console.log(`[reproject] เสร็จสิ้น: OK=${ok}, FAIL=${fail}`);
  if (ok > 0 && !cfg.inplace) {
    console.log(`\nต่อไป: ชี้ไฟล์ที่แปลงแล้วในเว็บเพจ เช่น
  FLOOR_GEOJSON_PATTERN: '../dist/Floor{pp}.grouped.wgs84.geojson'`);
  }
})();
