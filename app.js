// app.js — DOM glue for the qanat label tool.
//
// Imports the three pure modules (geo.js, geojson.js, crypto.js) and wires up:
//   passcode gate -> decrypt manifest + swath + heatmap -> swath view (pan/zoom,
//   cell rects, GT + my-marks layers, side list) -> crop popup (raw 1024² canvas,
//   autocontrast toggle, point/polyline drawing, undo/clear/save) -> localStorage
//   persistence -> GeoJSON download.
//
// Browser-only (uses DOM, fetch, localStorage). Not exercised by `node --test`.

import { pixelToWorld, worldToPixel } from './geo.js';
import { buildShaftsFeatureCollection, buildLinesFeatureCollection } from './geojson.js';
import { deriveKey, decryptBlob, verifyPasscode } from './crypto.js';

// --------------------------------------------------------------------------- //
// state
// --------------------------------------------------------------------------- //
const S = {
  key: null,            // CryptoKey
  manifest: null,       // decrypted manifest object
  cells: [],            // manifest.cells (p_pos desc)
  cellById: new Map(),
  swathW: 0, swathH: 0, // swath image pixel size
  swathBounds: null,    // [minx, miny, maxx, maxy]
  // per-session marks
  shaftMarks: [],       // {cropId, pPos, world:[x,y], created}
  lineMarks: [],        // {cropId, pPos, world:[[x,y],...], created}
  done: new Set(),      // cell ids with >=1 saved mark
  storageKey: 'qanat-labels:v1',
  // swath view transform
  view: { x: 0, y: 0, scale: 1 },
  suppressCellClick: false, // set true when a swath pan-drag ends, so the
                            // trailing click on a cell rect is ignored

  // crop modal
  crop: null,           // {cell, raw: ImageData, ctx, view:{x,y,scale}, marks:{points:[[col,row]..], lines:[[[col,row]..]..]}, inProgress:[], selected:null}
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.json();
}
async function decryptToBlobUrl(url, mime) {
  const enc = await fetchBytes(url);
  const pt = await decryptBlob(S.key, enc);
  return URL.createObjectURL(new Blob([pt], { type: mime }));
}
function setStatus(msg) { $('status').textContent = msg || ''; }
function fmtP(p) { return (Math.round(p * 1000) / 1000).toFixed(3); }
function sanitize(s) { return (s || 'anon').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'anon'; }
function ymd(d) {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// --------------------------------------------------------------------------- //
// persistence
// --------------------------------------------------------------------------- //
function persist() {
  try {
    localStorage.setItem(S.storageKey, JSON.stringify({
      shaftMarks: S.shaftMarks, lineMarks: S.lineMarks, done: [...S.done],
    }));
  } catch (e) { /* quota / disabled — non-fatal */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(S.storageKey);
    if (!raw) return;
    const o = JSON.parse(raw);
    S.shaftMarks = Array.isArray(o.shaftMarks) ? o.shaftMarks : [];
    S.lineMarks = Array.isArray(o.lineMarks) ? o.lineMarks : [];
    S.done = new Set(Array.isArray(o.done) ? o.done : []);
  } catch (e) { /* corrupt — ignore */ }
}

// --------------------------------------------------------------------------- //
// passcode gate
// --------------------------------------------------------------------------- //
async function unlock() {
  const pw = $('passcode').value;
  $('gate-msg').textContent = '';
  if (!pw) { $('gate-msg').textContent = 'enter a passcode'; return; }
  let cj;
  try { cj = await fetchJson('crypto.json'); }
  catch (e) { $('gate-msg').textContent = 'cannot load crypto.json — is the site served correctly?'; return; }
  const ok = await verifyPasscode(cj, pw);
  if (!ok) { $('gate-msg').textContent = 'wrong passcode'; return; }
  $('gate-loading').hidden = false;
  try {
    const salt = Uint8Array.from(atob(cj.salt), (c) => c.charCodeAt(0));
    S.key = await deriveKey(pw, salt, cj.iterations);
    // manifest
    const manBytes = await decryptBlob(S.key, await fetchBytes('manifest.enc'));
    S.manifest = JSON.parse(new TextDecoder().decode(manBytes));
    S.cells = (S.manifest.cells || []).slice().sort((a, b) => b.p_pos - a.p_pos);
    for (const c of S.cells) S.cellById.set(c.id, c);
    S.swathW = S.manifest.swath.width; S.swathH = S.manifest.swath.height;
    S.swathBounds = S.manifest.swath.world_bounds;
    S.storageKey = 'qanat-labels:' + (S.swathBounds ? S.swathBounds.map((v) => Math.round(v)).join('_') : 'v1');
    restore();
    // images
    const swathUrl = await decryptToBlobUrl('swath.enc', 'image/jpeg');
    const heatUrl = await decryptToBlobUrl(S.manifest.swath.heatmap || 'heatmap.enc', 'image/png');
    $('swath-img').src = swathUrl;
    $('heat-img').src = heatUrl;
  } catch (e) {
    $('gate-loading').hidden = true;
    $('gate-msg').textContent = 'decryption failed: ' + e.message;
    return;
  }
  // reveal app
  $('gate').hidden = true;
  $('app').hidden = false;
  sessionStorage.setItem('qanat-unlocked', '1');
  buildSideList();
  buildSwathLayers();
  fitSwath();
  updateDownloadEnabled();
}

// --------------------------------------------------------------------------- //
// side list
// --------------------------------------------------------------------------- //
function buildSideList() {
  const ul = $('cell-list');
  ul.innerHTML = '';
  for (const c of S.cells) {
    const li = document.createElement('li');
    li.dataset.cid = c.id;
    li.innerHTML = `<span class="done">${S.done.has(c.id) ? '✓' : ''}</span>` +
      `<span class="cid">${c.id}</span><span class="pp">${fmtP(c.p_pos)}</span>`;
    li.addEventListener('click', () => openCrop(c.id));
    li.addEventListener('mouseenter', () => highlightCell(c.id, true));
    li.addEventListener('mouseleave', () => highlightCell(c.id, false));
    ul.appendChild(li);
  }
}
function refreshDoneMarks() {
  for (const li of $('cell-list').children) {
    const cid = li.dataset.cid;
    li.querySelector('.done').textContent = S.done.has(cid) ? '✓' : '';
  }
  document.querySelectorAll('#swath-svg .cell-rect').forEach((r) => {
    r.classList.toggle('done', S.done.has(r.dataset.cid));
  });
}
function highlightCell(cid, on) {
  document.querySelectorAll(`#cell-list li[data-cid="${CSS.escape(cid)}"]`).forEach((li) => li.classList.toggle('hl', on));
  document.querySelectorAll(`#swath-svg .cell-rect[data-cid="${CSS.escape(cid)}"]`).forEach((r) => r.classList.toggle('hover', on));
}

// --------------------------------------------------------------------------- //
// swath view
// --------------------------------------------------------------------------- //
function worldToSwathPx(x, y) {
  const [minx, miny, maxx, maxy] = S.swathBounds;
  const mPerPx = S.manifest.swath.m_per_px;
  return [(x - minx) / mPerPx, (maxy - y) / mPerPx];
}
function svgEl(name, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function buildSwathLayers() {
  const img = $('swath-img'); const heat = $('heat-img'); const svg = $('swath-svg');
  img.width = S.swathW; img.height = S.swathH;
  heat.width = S.swathW; heat.height = S.swathH;
  svg.setAttribute('width', S.swathW); svg.setAttribute('height', S.swathH);
  svg.setAttribute('viewBox', `0 0 ${S.swathW} ${S.swathH}`);
  svg.innerHTML = '';
  const gGt = svgEl('g', { id: 'g-gt' });
  const gMine = svgEl('g', { id: 'g-mine' });
  const gCells = svgEl('g', { id: 'g-cells' });
  svg.appendChild(gGt); svg.appendChild(gMine); svg.appendChild(gCells);

  for (const c of S.cells) {
    const [x0, y0, x1, y1] = c.world_bbox;
    const [px0, py0] = worldToSwathPx(x0, y1); // top-left
    const [px1, py1] = worldToSwathPx(x1, y0); // bottom-right
    const rect = svgEl('rect', {
      x: Math.min(px0, px1), y: Math.min(py0, py1),
      width: Math.abs(px1 - px0), height: Math.abs(py1 - py0),
      class: 'cell-rect' + (S.done.has(c.id) ? ' done' : ''),
    });
    rect.dataset.cid = c.id;
    rect.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // A pan-drag that ends over this rect fires a trailing click; ignore it
      // so only a genuine (near-stationary) click opens the crop.
      if (S.suppressCellClick) { S.suppressCellClick = false; return; }
      openCrop(c.id);
    });
    rect.addEventListener('mouseenter', () => highlightCell(c.id, true));
    rect.addEventListener('mouseleave', () => highlightCell(c.id, false));
    gCells.appendChild(rect);

    // existing GT (cell.gt_points / gt_lines are in world coords)
    for (const [gx, gy] of c.gt_points || []) {
      const [sx, sy] = worldToSwathPx(gx, gy);
      gGt.appendChild(svgEl('circle', { cx: sx, cy: sy, r: 1.2, class: 'gt-dot' }));
    }
    for (const part of c.gt_lines || []) {
      if (!part || part.length < 2) continue;
      const pts = part.map(([gx, gy]) => worldToSwathPx(gx, gy).join(',')).join(' ');
      gGt.appendChild(svgEl('polyline', { points: pts, class: 'gt-line' }));
    }
  }
  rebuildMineLayer();
  applyLayerToggles();
}
function rebuildMineLayer() {
  const g = document.getElementById('g-mine');
  if (!g) return;
  g.innerHTML = '';
  for (const m of S.shaftMarks) {
    const [sx, sy] = worldToSwathPx(m.world[0], m.world[1]);
    g.appendChild(svgEl('circle', { cx: sx, cy: sy, r: 1.6, class: 'mine-dot' }));
  }
  for (const m of S.lineMarks) {
    if (!m.world || m.world.length < 2) continue;
    const pts = m.world.map(([x, y]) => worldToSwathPx(x, y).join(',')).join(' ');
    g.appendChild(svgEl('polyline', { points: pts, class: 'mine-line' }));
  }
}
function applyLayerToggles() {
  $('heat-img').style.display = $('tg-heatmap').checked ? '' : 'none';
  const gGt = document.getElementById('g-gt'); if (gGt) gGt.style.display = $('tg-gt').checked ? '' : 'none';
  const gMine = document.getElementById('g-mine'); if (gMine) gMine.style.display = $('tg-mine').checked ? '' : 'none';
}
function applySwathTransform() {
  const { x, y, scale } = S.view;
  $('swath-stage').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  updateScaleBar();
}
// "nice" round distances (m) for the dynamic scale bar (1/2/5 x 10^n)
const SCALE_NICE_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3,
                      1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];
const SCALE_TARGET_PX = 140; // pick the largest nice distance whose bar <= this
function updateScaleBar() {
  const bar = $('swath-scale-bar'); const label = $('swath-scale-label');
  if (!bar || !label) return;
  const mPerImgPx = S.manifest && S.manifest.swath ? S.manifest.swath.m_per_px : 0;
  if (!mPerImgPx || !S.view.scale) return;
  // image px -> screen px is S.view.scale, so meters per *screen* px is:
  const mPerScreenPx = mPerImgPx / S.view.scale;
  const targetM = SCALE_TARGET_PX * mPerScreenPx;
  let niceM = SCALE_NICE_M[0];
  for (const m of SCALE_NICE_M) { if (m <= targetM) niceM = m; else break; }
  bar.style.width = (niceM / mPerScreenPx).toFixed(1) + 'px';
  label.textContent = niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`;
}
function fitSwath() {
  const wrap = $('swath-wrap');
  const sx = wrap.clientWidth / S.swathW, sy = wrap.clientHeight / S.swathH;
  S.view.scale = Math.min(sx, sy) * 0.98;
  S.view.x = (wrap.clientWidth - S.swathW * S.view.scale) / 2;
  S.view.y = (wrap.clientHeight - S.swathH * S.view.scale) / 2;
  applySwathTransform();
}
function setupSwathPanZoom() {
  const wrap = $('swath-wrap');
  const CLICK_MOVE_PX = 5; // total movement under this (screen px) is a click, not a pan
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  wrap.addEventListener('mousedown', (e) => {
    dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY;
    S.suppressCellClick = false; // only a real drag (below) re-arms this
  });
  window.addEventListener('mouseup', (e) => {
    if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_MOVE_PX) {
      S.suppressCellClick = true; // gesture was a pan -> swallow the trailing cell click
    }
    dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    S.view.x += e.clientX - lastX; S.view.y += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    applySwathTransform();
  });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.max(0.05, Math.min(40, S.view.scale * factor));
    // keep the point under the cursor fixed
    S.view.x = mx - (mx - S.view.x) * (ns / S.view.scale);
    S.view.y = my - (my - S.view.y) * (ns / S.view.scale);
    S.view.scale = ns;
    applySwathTransform();
  }, { passive: false });
}

// --------------------------------------------------------------------------- //
// crop popup
// --------------------------------------------------------------------------- //
async function openCrop(cid) {
  const cell = S.cellById.get(cid);
  if (!cell) return;
  setStatus(`loading crop ${cid}…`);
  let img;
  try {
    const url = await decryptToBlobUrl('crops/' + cell.crop, 'image/jpeg');
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  } catch (e) { setStatus('crop load failed: ' + e.message); return; }
  setStatus('');
  const canvas = $('crop-canvas');
  canvas.width = 1024; canvas.height = 1024;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 1024, 1024);
  const raw = ctx.getImageData(0, 0, 1024, 1024);

  // restore this cell's own marks from session (pixel coords via worldToPixel)
  const points = [];
  for (const m of S.shaftMarks) if (m.cropId === cid) {
    const [c, r] = worldToPixel(m.world[0], m.world[1], cell.world_bbox);
    points.push([c, r]);
  }
  const lines = [];
  for (const m of S.lineMarks) if (m.cropId === cid) {
    lines.push(m.world.map(([x, y]) => worldToPixel(x, y, cell.world_bbox)));
  }

  S.crop = {
    cell, raw, ctx, img,
    view: { x: 0, y: 0, scale: 1 },
    marks: { points, lines },
    inProgress: [],
    selected: { points: new Set(), lines: new Set() },  // indices of own marks currently selected
    selectBox: null,       // [c0, r0, c1, r1] in 1024² coords while rubber-band-dragging
  };
  $('crop-title').textContent = `${cell.id}   p_pos=${fmtP(cell.p_pos)}   (${cell.gt_points.length} GT shafts, ${cell.gt_lines.length} GT lines)`;
  $('crop-autocontrast').checked = false;
  $('crop-gt').checked = true;
  document.querySelector('input[name="drawmode"][value="point"]').checked = true;
  $('crop-modal').hidden = false;
  fitCrop();
  redrawCrop();
}
function closeCrop(save) {
  if (S.crop && save) commitCrop();
  S.crop = null;
  $('crop-modal').hidden = true;
}
// ---- selection helpers (S.crop.selected = {points:Set<idx>, lines:Set<idx>}) ----
function selClear() { if (S.crop) { S.crop.selected.points.clear(); S.crop.selected.lines.clear(); } }
function selCount() { return S.crop ? S.crop.selected.points.size + S.crop.selected.lines.size : 0; }
function selSet(kind, idx, additive) {
  if (!additive) selClear();
  (kind === 'point' ? S.crop.selected.points : S.crop.selected.lines).add(idx);
}
function boxNorm(b) { return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]; }
function pointInBox([c, r], b) { const [a0, a1, a2, a3] = boxNorm(b); return c >= a0 && c <= a2 && r >= a1 && r <= a3; }
function selectFromBox(box, additive) {
  if (!additive) selClear();
  S.crop.marks.points.forEach(([c, r], i) => { if (pointInBox([c, r], box)) S.crop.selected.points.add(i); });
  S.crop.marks.lines.forEach((ln, i) => { if (ln.some((v) => pointInBox(v, box))) S.crop.selected.lines.add(i); });
}
function deleteSelected() {
  if (!S.crop || selCount() === 0) return;
  const pi = [...S.crop.selected.points].sort((a, b) => b - a);
  for (const i of pi) S.crop.marks.points.splice(i, 1);
  const li = [...S.crop.selected.lines].sort((a, b) => b - a);
  for (const i of li) S.crop.marks.lines.splice(i, 1);
  selClear();
  redrawCrop();
}
function fitCrop() {
  const stage = $('crop-stage');
  const s = Math.min(stage.clientWidth / 1024, stage.clientHeight / 1024) * 0.98;
  S.crop.view = { scale: s, x: (stage.clientWidth - 1024 * s) / 2, y: (stage.clientHeight - 1024 * s) / 2 };
  applyCropTransform();
}
function applyCropTransform() {
  const { x, y, scale } = S.crop.view;
  $('crop-canvas').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}
function autocontrast(src) {
  // 1%-cutoff per-channel histogram stretch on the (greyscale) crop.
  const d = src.data;
  const n = d.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const cut = Math.max(1, Math.floor(n * 0.01));
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  if (hi <= lo) { hi = 255; lo = 0; }
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
  const out = new ImageData(1024, 1024);
  for (let i = 0; i < d.length; i += 4) {
    const g = lut[d[i]];
    out.data[i] = g; out.data[i + 1] = lut[d[i + 1]]; out.data[i + 2] = lut[d[i + 2]]; out.data[i + 3] = 255;
  }
  return out;
}
function redrawCrop() {
  if (!S.crop) return;
  const { ctx, raw } = S.crop;
  ctx.putImageData($('crop-autocontrast').checked ? autocontrast(raw) : raw, 0, 0);
  // existing GT (locked, read-only): shafts = red, channels = cyan
  if ($('crop-gt').checked) {
    ctx.save();
    ctx.fillStyle = '#ff3b30';
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    for (const [gx, gy] of S.crop.cell.gt_points || []) {
      const [c, r] = worldToPixel(gx, gy, S.crop.cell.world_bbox);
      ctx.beginPath(); ctx.arc(c, r, 4, 0, 2 * Math.PI); ctx.fill();
    }
    for (const part of S.crop.cell.gt_lines || []) {
      if (!part || part.length < 2) continue;
      ctx.beginPath();
      part.forEach(([gx, gy], i) => { const [c, r] = worldToPixel(gx, gy, S.crop.cell.world_bbox); if (i === 0) ctx.moveTo(c, r); else ctx.lineTo(c, r); });
      ctx.stroke();
    }
    ctx.restore();
  }
  // my marks (lime); selected ones get a magenta halo
  const SEL = '#ff00ff';
  ctx.save();
  ctx.strokeStyle = '#39ff14'; ctx.fillStyle = '#39ff14'; ctx.lineWidth = 2;
  S.crop.marks.lines.forEach((ln, idx) => {
    if (ln.length < 1) return;
    ctx.beginPath();
    ln.forEach(([c, r], i) => { if (i === 0) ctx.moveTo(c, r); else ctx.lineTo(c, r); });
    ctx.stroke();
    if (S.crop.selected.lines.has(idx)) {
      ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 3.5; ctx.stroke(); ctx.restore();
    }
    for (const [c, r] of ln) { ctx.beginPath(); ctx.arc(c, r, 3, 0, 2 * Math.PI); ctx.fill(); }
  });
  S.crop.marks.points.forEach(([c, r], idx) => {
    ctx.beginPath(); ctx.arc(c, r, 5, 0, 2 * Math.PI); ctx.fill();
    if (S.crop.selected.points.has(idx)) {
      ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(c, r, 8.5, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    }
  });
  // in-progress polyline (white)
  if (S.crop.inProgress.length) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath();
    S.crop.inProgress.forEach(([c, r], i) => { if (i === 0) ctx.moveTo(c, r); else ctx.lineTo(c, r); });
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (const [c, r] of S.crop.inProgress) { ctx.beginPath(); ctx.arc(c, r, 3, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
  // rubber-band selection rectangle
  if (S.crop.selectBox) {
    const [a0, a1, a2, a3] = boxNorm(S.crop.selectBox);
    ctx.save();
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(a0, a1, a2 - a0, a3 - a1);
    ctx.strokeRect(a0, a1, a2 - a0, a3 - a1);
    ctx.restore();
  }
}
function canvasEventToPx(e) {
  const canvas = $('crop-canvas');
  const rect = canvas.getBoundingClientRect();
  // rect already reflects the CSS transform (scale); map to the 1024² space
  const col = ((e.clientX - rect.left) / rect.width) * 1024;
  const row = ((e.clientY - rect.top) / rect.height) * 1024;
  return [col, row];
}
function drawMode() { return document.querySelector('input[name="drawmode"]:checked').value; }
function hitTestOwn([col, row]) {
  const tol = 8 / Math.max(0.2, S.crop.view.scale); // a few screen px
  for (let i = 0; i < S.crop.marks.points.length; i++) {
    const [c, r] = S.crop.marks.points[i];
    if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'point', idx: i };
  }
  for (let i = 0; i < S.crop.marks.lines.length; i++) {
    for (const [c, r] of S.crop.marks.lines[i]) {
      if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'line', idx: i };
    }
  }
  return null;
}
function finishInProgressLine() {
  if (S.crop.inProgress.length >= 2) S.crop.marks.lines.push(S.crop.inProgress.slice());
  S.crop.inProgress = [];
  redrawCrop();
}
function setupCropInteractions() {
  const canvas = $('crop-canvas');
  const stage = $('crop-stage');

  // ---- pan: right-drag or middle-drag anywhere; left-drag on the empty stage margin ----
  let panning = false, lastX = 0, lastY = 0;
  // ---- press gesture on the canvas: left-click = add/select; left-drag = box-select ----
  let pressActive = false, pressX = 0, pressY = 0, pressPx = null, pressMoved = false, pressAdditive = false;

  stage.addEventListener('contextmenu', (e) => { if (S.crop) e.preventDefault(); });
  stage.addEventListener('mousedown', (e) => {
    if (!S.crop) return;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.target === stage)) {
      if (e.button === 1) e.preventDefault();
      panning = true; lastX = e.clientX; lastY = e.clientY;
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!S.crop || e.button !== 0) return;   // non-left bubbles to stage for panning
    e.stopPropagation();
    pressActive = true; pressMoved = false; pressX = e.clientX; pressY = e.clientY;
    pressPx = canvasEventToPx(e);
    pressAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
    S.crop.selectBox = null;
  });
  window.addEventListener('mousemove', (e) => {
    if (!S.crop) return;
    if (panning) {
      S.crop.view.x += e.clientX - lastX; S.crop.view.y += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY; applyCropTransform();
      return;
    }
    if (pressActive) {
      if (Math.abs(e.clientX - pressX) + Math.abs(e.clientY - pressY) > 3) pressMoved = true;
      if (pressMoved) {
        const cur = canvasEventToPx(e);
        S.crop.selectBox = [pressPx[0], pressPx[1], cur[0], cur[1]];
        redrawCrop();
      }
    }
  });
  window.addEventListener('mouseup', () => {
    if (panning) panning = false;
    if (pressActive) {
      pressActive = false;
      if (!S.crop) return;
      if (pressMoved && S.crop.selectBox) {
        selectFromBox(S.crop.selectBox, pressAdditive);
        S.crop.selectBox = null;
        redrawCrop();
      } else {
        S.crop.selectBox = null;
        const hit = hitTestOwn(pressPx);
        if (hit) { selSet(hit.kind, hit.idx, pressAdditive); redrawCrop(); return; }
        if (!pressAdditive) selClear();
        if (drawMode() === 'point') S.crop.marks.points.push(pressPx);
        else S.crop.inProgress.push(pressPx);
        redrawCrop();
      }
    }
  });
  stage.addEventListener('wheel', (e) => {
    if (!S.crop) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.max(0.1, Math.min(20, S.crop.view.scale * factor));
    S.crop.view.x = mx - (mx - S.crop.view.x) * (ns / S.crop.view.scale);
    S.crop.view.y = my - (my - S.crop.view.y) * (ns / S.crop.view.scale);
    S.crop.view.scale = ns; applyCropTransform();
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    if (!S.crop) return;
    e.preventDefault();
    if (drawMode() === 'line') finishInProgressLine();
  });
  $('crop-autocontrast').addEventListener('change', redrawCrop);
  $('crop-gt').addEventListener('change', redrawCrop);
  $('crop-undo').addEventListener('click', () => {
    if (!S.crop) return;
    if (S.crop.inProgress.length) { S.crop.inProgress.pop(); }
    else if (S.crop.marks.points.length || S.crop.marks.lines.length) {
      // undo whichever was added last is ambiguous after reload; pop a point first, else a line
      if (S.crop.marks.points.length) S.crop.marks.points.pop();
      else S.crop.marks.lines.pop();
    }
    selClear();
    redrawCrop();
  });
  $('crop-clear').addEventListener('click', () => {
    if (!S.crop) return;
    if (!confirm('Remove all your marks for this crop?')) return;
    S.crop.marks.points = []; S.crop.marks.lines = []; S.crop.inProgress = []; S.crop.selectBox = null; selClear();
    redrawCrop();
  });
  $('crop-save').addEventListener('click', () => { commitCrop(); setStatus('saved ' + S.crop.cell.id); });
  $('crop-close').addEventListener('click', () => closeCrop(false));
  document.querySelectorAll('input[name="drawmode"]').forEach((r) => r.addEventListener('change', () => {
    if (S.crop && drawMode() === 'point') finishInProgressLine();
  }));
  document.addEventListener('keydown', (e) => {
    if (!S.crop || $('crop-modal').hidden) return;
    if (e.key === 'Enter') { if (drawMode() === 'line') finishInProgressLine(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selCount() > 0) { deleteSelected(); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      if (S.crop.inProgress.length) { S.crop.inProgress = []; redrawCrop(); }
      else if (selCount() > 0 || S.crop.selectBox) { selClear(); S.crop.selectBox = null; redrawCrop(); }
      else closeCrop(false);
    }
  });
}
function commitCrop() {
  if (!S.crop) return;
  const cell = S.crop.cell;
  // flush any in-progress polyline
  if (S.crop.inProgress.length >= 2) S.crop.marks.lines.push(S.crop.inProgress.slice());
  S.crop.inProgress = [];
  // drop this cell's old marks, re-add the current set as world coords
  S.shaftMarks = S.shaftMarks.filter((m) => m.cropId !== cell.id);
  S.lineMarks = S.lineMarks.filter((m) => m.cropId !== cell.id);
  const now = new Date().toISOString();
  for (const [c, r] of S.crop.marks.points) {
    const [x, y] = pixelToWorld(c, r, cell.world_bbox);
    S.shaftMarks.push({ cropId: cell.id, pPos: cell.p_pos, world: [x, y], created: now });
  }
  for (const ln of S.crop.marks.lines) {
    if (ln.length < 2) continue;
    S.lineMarks.push({ cropId: cell.id, pPos: cell.p_pos, world: ln.map(([c, r]) => pixelToWorld(c, r, cell.world_bbox)), created: now });
  }
  const hasMarks = S.crop.marks.points.length > 0 || S.crop.marks.lines.some((l) => l.length >= 2);
  if (hasMarks) S.done.add(cell.id); else S.done.delete(cell.id);
  refreshDoneMarks();
  rebuildMineLayer();
  applyLayerToggles();
  persist();
  redrawCrop();
}

// --------------------------------------------------------------------------- //
// download
// --------------------------------------------------------------------------- //
function updateDownloadEnabled() {
  $('btn-download').disabled = !($('labeler').value.trim());
}
function triggerDownload(obj, fname) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function download() {
  const labeler = $('labeler').value.trim();
  if (!labeler) { setStatus('enter a labeler name first'); return; }
  const lab = sanitize(labeler);
  const d = ymd(new Date());
  const shafts = buildShaftsFeatureCollection(S.shaftMarks, { labeler });
  const lines = buildLinesFeatureCollection(S.lineMarks, { labeler });
  triggerDownload(shafts, `qanat_shafts_manual_${lab}_${d}.geojson`);
  triggerDownload(lines, `qanat_channels_manual_${lab}_${d}.geojson`);
  setStatus(`downloaded ${shafts.features.length} shafts + ${lines.features.length} channels`);
}

// --------------------------------------------------------------------------- //
// boot
// --------------------------------------------------------------------------- //
function boot() {
  $('unlock').addEventListener('click', unlock);
  $('passcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('btn-download').addEventListener('click', download);
  $('labeler').addEventListener('input', updateDownloadEnabled);
  ['tg-heatmap', 'tg-gt', 'tg-mine'].forEach((id) => $(id).addEventListener('change', applyLayerToggles));
  setupSwathPanZoom();
  setupCropInteractions();
  window.addEventListener('resize', () => { if (!$('app').hidden) applySwathTransform(); });
  // never auto-reveal content; the passcode must always be re-entered after a reload.
  $('passcode').focus();
}
boot();
