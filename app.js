// app.js — DOM glue for the qanat label tool.
//
// Imports the three pure modules (geo.js, geojson.js, crypto.js) and wires up:
//   passcode gate -> decrypt manifest + swath + heatmap -> swath view (pan/zoom,
//   cell rects, GT + my-marks layers, side list) -> crop popup (raw 1024² canvas,
//   autocontrast toggle, point/polyline drawing, undo/clear/save) -> localStorage
//   persistence -> GeoJSON download.
//
// Browser-only (uses DOM, fetch, localStorage). Not exercised by `node --test`.

import { pixelToWorld, worldToPixel, nearestMark } from './geo.js';
import { buildShaftsFeatureCollection, buildLinesFeatureCollection } from './geojson.js';
import { deriveKey, decryptBlob, encryptBlob, verifyPasscode, openSuEnvelope, deriveWriteToken } from './crypto.js';
import { fetchAllMarks, fetchMyCellMarks, deleteMarksByIds, insertMarks } from './sync.js';
import {
  attribution, othersDeleteIds, pruneOthers, dropPoolMarksByDbId, cropDirtyState,
} from './suedit.js';
import {
  cellPasses, filterIsActive, pruneSelection, labelerOrder,
  rankPercent, fmtPercent, filterSummary, rectSubpath, spotlightPaths,
} from './cellfilter.js';
import {
  selectMarks, scopeSlug, scopeProblem, countOrphans, buildExportScope,
} from './exportscope.js';
import { SUPABASE } from './site_config.js';

// --------------------------------------------------------------------------- //
// state
// --------------------------------------------------------------------------- //
const S = {
  key: null,            // CryptoKey (site files: manifest/swath/heatmap/crops)
  marksKey: null,       // CryptoKey for DB-row geometry (marks_salt; stable across rebuilds)
  manifest: null,       // decrypted manifest object
  cells: [],            // manifest.cells (p_pos desc)
  cellById: new Map(),
  cellRank: new Map(),  // cell id -> index into S.cells (p_pos desc) — O(1) range test
  cellByCentre: new Map(), // `${round(cx)}_${round(cy)}` -> cell (adjacent-crop nav)
  swathW: 0, swathH: 0, // swath image pixel size
  swathBounds: null,    // [minx, miny, maxx, maxy]
  // identity (set at the gate; `me` is normalized for matching, `meDisplay` shown/exported)
  me: '',               // normalized owner key (trim+collapse+lowercase)
  meDisplay: '',        // as-typed display/export name
  su: false,            // superuser session — the SU passcode opened the gate via the
                        // su envelope (password-only role: any name + su passcode)
  writeToken: null,     // sha256_hex('qanat-write-v1'||entered passcode) — auth for the
                        // write RPCs; the token doubles as the role (x=normal, y=superuser).
                        // MEMORY ONLY: never persisted to localStorage/sessionStorage.
  board: null,          // namespace per dataset (mirrors storageKey suffix)
  // per-session marks (each mark carries `labeler` owner + optional `dbId`)
  shaftMarks: [],       // {cropId, pPos, world:[x,y], created, labeler, dbId?}
  lineMarks: [],        // {cropId, pPos, world:[[x,y],...], created, labeler, dbId?}
  done: new Set(),      // cell ids with >=1 saved mark (from anyone)
  unsynced: false,      // true when a save couldn't reach the backend
  // cell filter — ONE state object drives the sidebar list AND the map spotlight.
  // Two conditions ANDed: a p_pos RANGE over rank (indices into S.cells, which
  // is p_pos-descending, so the selection is a contiguous slice) and a
  // "labeled by…" union over checked labelers. See cellfilter.js.
  filter: {
    lo: 0,                 // first (highest-p_pos) rank kept, inclusive
    hi: 0,                 // last (lowest-p_pos) rank kept, inclusive; = cells-1 on unlock
    checked: new Set(),    // normalized labeler names; EMPTY = condition inactive
    unlabeled: false,      // "(unlabeled)" — mutually exclusive with `checked`
    open: false,           // Filters section expanded? (collapsed by default)
  },
  labelerCells: { byLabeler: new Map(), any: new Set() }, // derived from the pool
  // download dialog — three INDEPENDENT axes ANDed by exportscope.js. Defaults
  // reproduce the old one-shot button (the whole pool). Choices persist across
  // opens within a session (a re-download of the same scope is one click).
  dl: {
    crops: 'all',          // 'all' | 'filter'
    marksBy: 'everyone',   // 'everyone' | 'me' | 'choose'
    chosen: new Set(),     // normalized labeler names (marksBy === 'choose')
    created: 'any',        // 'any' | 'session' | 'since'
    since: '',             // 'YYYY-MM-DD' from <input type=date>
  },
  // max(created) over the pool AT UNLOCK — the boundary for "this session".
  // Server timestamps only: the browser clock is never consulted, so clock skew
  // cannot misclassify a mark saved near the boundary. Set ONCE, never refreshed.
  sessionSince: '',
  storageKey: 'qanat-labels:v1',
  // swath view transform
  view: { x: 0, y: 0, scale: 1 },
  suppressCellClick: false, // set true when a swath pan-drag ends, so the
                            // trailing click on a cell rect is ignored

  // crop modal
  crop: null,           // {cell, raw: ImageData, ctx, view:{x,y,scale}, marks:{points:[{px:[col,row],ac}..], lines:[{pts:[[col,row]..],ac}..]}, inProgress:[], selected:null}
                        // `ac` = autocontrast toggle state when the mark was drawn (null on
                        // pre-provenance marks reloaded from the pool; preserved across saves)
                        // `dirty` = the user changed marks since the last save/open.

  // adjacent-crop navigation + guarded close (both share the unsaved-marks prompt)
  navBusy: false,       // a jump/close is in flight (or its prompt is up) -> ignore further nav/close
  navDialog: null,      // resolver fn while the unsaved-changes prompt is open, else null

  // hidden GT-review mode (personal, local-only; NEVER synced to the backend).
  // `on` is decided once at boot from the URL; when false the feature is inert
  // and the page behaves exactly as before.
  review: {
    on: new URLSearchParams(location.search).get('gtreview') === '1',
    eligible: new Set(),  // cell ids with >=1 GT point AND exactly one owning TIF
    verdicts: {},         // {cellId: {verdict:'accurate'|'drifted', decided_at}}
  },
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
function setSyncStatus(msg, cls) {
  const el = $('sync-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}
function fmtP(p) { return (Math.round(p * 1000) / 1000).toFixed(3); }

// normalize a name for *matching* (trim + collapse internal whitespace + lowercase).
function normalize(name) { return (name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function backendOn() { return !!SUPABASE; }

// remembered display names -> datalist suggestions at the gate.
const NAMES_KEY = 'qanat-labeler-names';
function loadNames() {
  try { const a = JSON.parse(localStorage.getItem(NAMES_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function rememberName(display) {
  const d = (display || '').trim();
  if (!d) return;
  const names = loadNames();
  if (!names.some((n) => normalize(n) === normalize(d))) names.push(d);
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch (e) { /* non-fatal */ }
}
function fillNameDatalist() {
  const dl = $('name-suggestions');
  if (!dl) return;
  dl.innerHTML = '';
  for (const n of loadNames()) {
    const o = document.createElement('option'); o.value = n; dl.appendChild(o);
  }
}
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
      unsynced: S.unsynced,
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
    // localStorage is per-device → any cached mark without an owner is mine.
    for (const m of S.shaftMarks) if (!m.labeler) m.labeler = S.me;
    for (const m of S.lineMarks) if (!m.labeler) m.labeler = S.me;
    S.done = new Set(Array.isArray(o.done) ? o.done : []);
    S.unsynced = !!o.unsynced;
  } catch (e) { /* corrupt — ignore */ }
}
// recompute `done` from the merged pool: a cell is ✓ if anyone has a mark there.
function recomputeDone() {
  S.done = new Set();
  for (const m of S.shaftMarks) S.done.add(m.cropId);
  for (const m of S.lineMarks) if (m.world && m.world.length >= 2) S.done.add(m.cropId);
}

// --------------------------------------------------------------------------- //
// backend sync (Supabase) — crypto stays here; sync.js only moves ciphertext
// --------------------------------------------------------------------------- //
const _utf8 = new TextEncoder();
const _dutf8 = new TextDecoder();

function _bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function _b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Encrypt a mark's world geometry -> base64 ciphertext for the `geom` column. */
async function encryptGeom(world) {
  const json = JSON.stringify({ world });
  const blob = await encryptBlob(S.marksKey, _utf8.encode(json));
  return _bytesToB64(blob);
}
/** Decrypt a `geom` base64 ciphertext -> the world-coords array (or null on failure). */
async function decryptGeom(geomB64) {
  try {
    const pt = await decryptBlob(S.marksKey, _b64ToBytes(geomB64));
    const o = JSON.parse(_dutf8.decode(pt));
    return Array.isArray(o.world) ? o.world : null;
  } catch (e) { return null; }
}

/** kind tag in the DB: shafts are points, channels are polylines. */
const KIND_SHAFT = 'shaft';
const KIND_CHANNEL = 'channel';

/**
 * Pull the whole shared pool from the backend, decrypt, and replace S.*Marks —
 * but preserve my locally-unsynced marks (so a failed save isn't lost on refresh).
 * Falls back to the local cache when no backend is configured.
 */
async function pullAllMarks() {
  if (!backendOn()) { restore(); recomputeDone(); setSyncStatus('local-only', ''); return; }
  setSyncStatus('syncing…', '');
  // load the local cache first so any prior-session unsynced marks of mine survive
  // the merge below (they have no dbId; synced ones picked up dbIds on save).
  if (!S.shaftMarks.length && !S.lineMarks.length) restore();
  let rows;
  try {
    rows = await fetchAllMarks(SUPABASE, S.board, S.project);
  } catch (e) {
    // can't reach backend — fall back to whatever we have locally.
    restore();
    recomputeDone();
    S.unsynced = true;
    setSyncStatus('offline — using local cache', 'unsynced');
    return;
  }
  const shafts = [];
  const lines = [];
  for (const row of rows || []) {
    const world = await decryptGeom(row.geom);
    if (!world) continue; // skip rows we can't decrypt (wrong key / corrupt)
    const owner = row.labeler || '';
    const cropId = row.cell_id;
    const created = row.created_at || row.updated_at || '';
    // p_pos recorded at save time wins over the (possibly rebuilt) manifest's.
    const pPos = row.p_pos != null ? row.p_pos : cellPPos(cropId);
    // provenance columns (plaintext in the DB; null on rows that predate them)
    const prov = {
      worldBbox: row.world_bbox ?? null,
      crs: row.crs ?? null,
      cropPx: row.crop_px ?? null,
      tifs: row.tifs ?? null,
      cropSha256: row.crop_sha256 ?? null,
      buildId: row.build_id ?? null,
      autocontrast: row.autocontrast ?? null,
      project: row.project ?? null,
      // who last cross-edited this mark (server-stamped, superuser edits only);
      // drives the dual-attribution hover tooltip in the crop view.
      editedBy: row.edited_by ?? null,
    };
    if (row.kind === KIND_SHAFT) {
      // a shaft is stored as {world:[x,y]} (a flat pair); tolerate a nested
      // [[x,y]] too, in case any row was written in the other shape.
      const c = Array.isArray(world[0]) ? world[0] : world;
      if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number') continue;
      shafts.push({ cropId, pPos, world: [c[0], c[1]], created, labeler: owner, dbId: row.id, ...prov });
    } else if (row.kind === KIND_CHANNEL) {
      if (world.length < 2) continue;
      lines.push({ cropId, pPos, world, created, labeler: owner, dbId: row.id, ...prov });
    }
  }
  // merge my locally-unsynced marks (those without a dbId) so a pending save survives.
  for (const m of S.shaftMarks) if (m.labeler === S.me && !m.dbId) shafts.push(m);
  for (const m of S.lineMarks) if (m.labeler === S.me && !m.dbId) lines.push(m);
  S.shaftMarks = shafts;
  S.lineMarks = lines;
  recomputeDone();
  persist();
  if (S.unsynced) setSyncStatus('synced (local changes pending)', 'unsynced');
  else setSyncStatus('synced', 'ok');
}

function cellPPos(cropId) {
  const c = S.cellById.get(cropId);
  return c ? c.p_pos : 0;
}

/** Re-pull the pool + redraw everything (Refresh button + post-save consistency). */
async function refreshMarks() {
  await pullAllMarks();
  refreshFilterUI(); // labeler sets + dropdown options + filtered sidebar + tint
  refreshDoneMarks();
  rebuildMineLayer();
  applyLayerToggles();
  if (S.crop) reloadCropMarks();
}

// --------------------------------------------------------------------------- //
// GT review mode (hidden; active only with ?gtreview=1 in the URL)
//
// Personal spot-check of existing GT georeferencing: for cells that have GT
// shaft points AND a single unambiguous owning TIF, record whether the GT dots
// sit accurately on the imagery ('accurate') or are offset ('drifted').
// Verdicts live in localStorage ONLY (key `qanat-gtreview:<board>`), never in
// Supabase, and export as a standalone JSON — mark saving/sync is untouched.
// --------------------------------------------------------------------------- //
function reviewKey() { return 'qanat-gtreview:' + S.board; }
function reviewLoadVerdicts() {
  try {
    const o = JSON.parse(localStorage.getItem(reviewKey()) || '{}');
    S.review.verdicts = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { S.review.verdicts = {}; }
}
function reviewPersistVerdicts() {
  try { localStorage.setItem(reviewKey(), JSON.stringify(S.review.verdicts)); }
  catch (e) { /* quota / disabled — non-fatal */ }
}
/** Called from unlock() (review mode only): eligibility set + stored verdicts. */
function reviewInit() {
  S.review.eligible = new Set(
    S.cells
      .filter((c) => (c.gt_points || []).length > 0 && (c.tifs || []).length === 1)
      .map((c) => c.id));
  reviewLoadVerdicts();
}
function reviewVerdictOf(cid) {
  const v = S.review.verdicts[cid];
  return v && (v.verdict === 'accurate' || v.verdict === 'drifted') ? v.verdict : null;
}
function reviewCountReviewed() {
  let k = 0;
  for (const cid of S.review.eligible) if (reviewVerdictOf(cid)) k++;
  return k;
}
/** Set / toggle a verdict (clicking the active one again clears it). */
function reviewSetVerdict(cid, verdict) {
  if (!S.review.on || !S.review.eligible.has(cid)) return;
  if (reviewVerdictOf(cid) === verdict) delete S.review.verdicts[cid];
  else S.review.verdicts[cid] = { verdict, decided_at: new Date().toISOString() };
  reviewPersistVerdicts();
  reviewRefreshUI();
}
/** Repaint every review-mode surface: counter, badges, swath tints, buttons. */
function reviewRefreshUI() {
  if (!S.review.on) return;
  const n = S.review.eligible.size;
  const k = reviewCountReviewed();
  const cnt = $('gt-review-counter');
  if (cnt) { cnt.hidden = false; cnt.textContent = `GT review: ${n} eligible · ${k} reviewed`; }
  const dl = $('btn-gt-review-dl');
  if (dl) { dl.hidden = false; dl.disabled = k < 1; }
  document.querySelectorAll('#cell-list .gtr-badge').forEach((b) => {
    const v = reviewVerdictOf(b.parentElement.dataset.cid);
    b.textContent = v === 'accurate' ? '✓' : v === 'drifted' ? '✗' : '●';
    b.className = 'gtr-badge ' + (v === 'accurate' ? 'gtr-acc' : v === 'drifted' ? 'gtr-dr' : 'gtr-un');
  });
  document.querySelectorAll('#swath-svg .cell-rect.gt-eligible').forEach((r) => {
    const v = reviewVerdictOf(r.dataset.cid);
    r.classList.toggle('gt-accurate', v === 'accurate');
    r.classList.toggle('gt-drifted', v === 'drifted');
  });
  reviewSyncCropButtons();
}
/** Reflect the open crop's verdict on the two modal buttons (active state). */
function reviewSyncCropButtons() {
  if (!S.review.on || !S.crop) return;
  const el = $('gt-review-btns');
  if (!el || el.hidden) return;
  const v = reviewVerdictOf(S.crop.cell.id);
  $('gt-accurate').classList.toggle('active', v === 'accurate');
  $('gt-drifted').classList.toggle('active', v === 'drifted');
}
function reviewDownload() {
  if (!S.review.on) return;
  const verdicts = [];
  const perTif = {};
  for (const c of S.cells) { // manifest order (p_pos desc) for a stable export
    if (!S.review.eligible.has(c.id)) continue;
    const v = S.review.verdicts[c.id];
    const verdict = reviewVerdictOf(c.id);
    if (!verdict) continue;
    const tif = (c.tifs && c.tifs[0]) || null;
    if (tif != null) {
      const t = perTif[tif] || (perTif[tif] = { accurate: 0, drifted: 0 });
      t[verdict] += 1;
    }
    verdicts.push({
      cell_id: c.id,
      verdict,
      tif,
      n_gt_points: (c.gt_points || []).length,
      world_bbox: c.world_bbox,
      p_pos: c.p_pos,
      crop_sha256: c.crop_sha256 || null,
      decided_at: v.decided_at || null,
    });
  }
  const obj = {
    board: S.board,
    build_id: (S.manifest.build && S.manifest.build.build_id) || null,
    crs: S.manifest.crs || null,
    exported_at: new Date().toISOString(),
    n_eligible: S.review.eligible.size,
    n_reviewed: verdicts.length,
    per_tif: perTif,
    verdicts,
  };
  triggerDownload(obj, `gt_review_${sanitize(S.board).slice(0, 24)}_${ymd(new Date())}.json`);
  setStatus(`downloaded ${verdicts.length} GT review verdicts`);
}

// --------------------------------------------------------------------------- //
// passcode gate
// --------------------------------------------------------------------------- //
async function unlock() {
  const pw = $('passcode').value;
  $('gate-msg').textContent = '';
  const nameRaw = $('gate-name').value;
  if (!nameRaw.trim()) { $('gate-msg').textContent = 'enter your name before labeling'; return; }
  const project = $('gate-project').value;
  if (!project || !PROJECTS.includes(project)) { $('gate-msg').textContent = 'select a project before labeling'; return; }
  if (!pw) { $('gate-msg').textContent = 'enter a passcode'; return; }
  let cj;
  try { cj = await fetchJson('crypto.json'); }
  catch (e) { $('gate-msg').textContent = 'cannot load crypto.json — is the site served correctly?'; return; }
  // Superuser envelope first: when the site carries one (crypto.json "su" +
  // su.enc), try the entered passcode against it. Success -> superuser session;
  // the envelope payload yields the NORMAL passcode, and everything below
  // proceeds exactly as if that had been typed. Failure (or no envelope) ->
  // the normal sentinel path, unchanged. Role binds to the PASSWORD ONLY —
  // any name + the su passcode is a superuser, by design.
  let sitePw = pw;
  S.su = false;
  if (cj.su && cj.su.salt) {
    try {
      const suBlob = await fetchBytes(cj.su.file || 'su.enc');
      const payload = await openSuEnvelope(cj.su, suBlob, pw);
      if (payload) { S.su = true; sitePw = payload.passcode; }
    } catch (e) { /* su.enc unfetchable -> fall through to the normal path */ }
  }
  if (!S.su) {
    const ok = await verifyPasscode(cj, pw);
    if (!ok) { $('gate-msg').textContent = 'wrong passcode'; return; }
  }
  // Write-RPC token from the passcode AS ENTERED (x -> normal, y -> superuser;
  // the server decides the role by hashing the token again). In-memory only.
  S.writeToken = backendOn() ? await deriveWriteToken(pw) : null;
  // identity: normalize for matching, remember the display name for suggestions.
  S.meDisplay = nameRaw.trim().replace(/\s+/g, ' ');
  S.me = normalize(S.meDisplay);
  S.project = project;
  rememberName(S.meDisplay);
  $('me-name').textContent = S.meDisplay;
  $('me-project').textContent = S.project; // topbar reminder of the active project
  $('labeler').value = S.meDisplay; // keep the (hidden) download field in sync

  $('gate-loading').hidden = false;
  try {
    const salt = Uint8Array.from(atob(cj.salt), (c) => c.charCodeAt(0));
    S.key = await deriveKey(sitePw, salt, cj.iterations);
    // DB-row geometry key: derived from marks_salt, which survives site rebuilds
    // (the site salt above does not). Old deployments have no marks_salt ->
    // fall back to the site key so their existing rows keep decrypting.
    if (cj.marks_salt) {
      const msalt = Uint8Array.from(atob(cj.marks_salt), (c) => c.charCodeAt(0));
      S.marksKey = await deriveKey(sitePw, msalt, cj.iterations);
    } else {
      S.marksKey = S.key;
    }
    // manifest
    const manBytes = await decryptBlob(S.key, await fetchBytes('manifest.enc'));
    S.manifest = JSON.parse(new TextDecoder().decode(manBytes));
    S.cells = (S.manifest.cells || []).slice().sort((a, b) => b.p_pos - a.p_pos);
    S.cellRank = new Map();
    S.cells.forEach((c, i) => { S.cellById.set(c.id, c); S.cellRank.set(c.id, i); });
    buildCellCentreIndex(); // centre-keyed lookup for adjacent-crop navigation
    S.swathW = S.manifest.swath.width; S.swathH = S.manifest.swath.height;
    S.swathBounds = S.manifest.swath.world_bounds;
    S.board = (S.swathBounds ? S.swathBounds.map((v) => Math.round(v)).join('_') : 'v1');
    // cache is per (board, project) — without the project the offline cache
    // would bleed one project's marks into another even with the DB filtered.
    S.storageKey = 'qanat-labels:' + S.board + ':' + S.project;
    if (S.review.on) reviewInit(); // eligibility + stored verdicts (localStorage only)
    await pullAllMarks();
    computeSessionSince(); // "this session" boundary — ONLY here, never on refresh
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
  // superuser-only UI (Edit-others toggle, Snapshots, History). Built HERE, not
  // in the static HTML, so for normal users none of it is in the DOM at all.
  if (S.su) setupSuperuserUI();
  computeLabelerCells();   // before buildSideList: the per-labeler cell sets
  initRankSlider();        // rank bounds now that S.cells is known (full range)
  rebuildLabelerChecks();  // needs the freshly pulled pool and S.meDisplay
  updateFilterSummary();
  buildSideList();
  buildSwathLayers();
  fitSwath();
  updateDownloadEnabled();
  if (S.review.on) reviewRefreshUI(); // reveal counter/button + paint badges/tints
}

// --------------------------------------------------------------------------- //
// superuser tools — built at unlock ONLY when S.su, so a normal user's DOM
// carries none of it (not merely hidden). The "Edit others" toggle is DEFAULT
// OFF on every login and never persisted: cross-labeler editing is a per-
// session, deliberate opt-in. While ON, the topbar and crop modal tint amber
// and a chip reads "editing others' marks" (applySuEditCue).
// --------------------------------------------------------------------------- //
/** Cross-labeler editing is live: superuser session AND the toggle is checked. */
function suEditOn() {
  const tg = document.getElementById('tg-editothers');
  return S.su && !!(tg && tg.checked);
}
function setupSuperuserUI() {
  const toggles = document.querySelector('#topbar .toggles');
  if (!toggles || document.getElementById('tg-editothers')) return;
  // "Edit others" checkbox, appended to the layer toggles. Unchecked by
  // construction (fresh element per unlock; nothing ever persists it).
  const lab = document.createElement('label');
  lab.id = 'su-edit-wrap';
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.id = 'tg-editothers';
  lab.appendChild(inp);
  lab.appendChild(document.createTextNode(' Edit others'));
  toggles.appendChild(lab);
  // the strong visual cue while cross-labeler editing is armed
  const chip = document.createElement('span');
  chip.id = 'su-chip';
  chip.className = 'su-chip';
  chip.textContent = "editing others' marks";
  chip.hidden = true;
  toggles.insertAdjacentElement('afterend', chip);
  inp.addEventListener('change', applySuEditCue);
  applySuEditCue();
}
function applySuEditCue() {
  const on = suEditOn();
  document.body.classList.toggle('su-edit-on', on);
  const chip = document.getElementById('su-chip');
  if (chip) chip.hidden = !on;
  // turning the toggle OFF drops any others-selection (their marks are
  // read-only again); pending, still-unsaved others-deletes stay pending —
  // they are part of the crop's dirty state until saved or discarded.
  if (!on && S.crop) {
    S.crop.selected.oPoints.clear();
    S.crop.selected.oLines.clear();
    redrawCrop();
  }
}

// --------------------------------------------------------------------------- //
// cell filter — collapsible sidebar "Filters" block + map spotlight (g-filter).
//
// Two conditions, ANDed (predicate lives in cellfilter.js so it is unit-testable
// without a DOM):
//   * p_pos range, dragged over RANK with a dual-handle slider;
//   * "labeled by…" union over checkbox-selected labelers (+ an exclusive
//     "(unlabeled)" entry). Nothing checked = that condition is inactive.
// The labeler pool is derived entirely from the project-scoped pulled pool and
// recomputed on every pull/save, so the checkbox list never goes stale.
// --------------------------------------------------------------------------- //

/** One pass over the pool -> per-labeler cell sets + the "any mark" set. */
function computeLabelerCells() {
  const byLabeler = new Map();
  const any = new Set();
  const add = (m) => {
    if (!m.cropId) return;
    any.add(m.cropId);
    const who = m.labeler || '';
    let s = byLabeler.get(who);
    if (!s) byLabeler.set(who, (s = new Set()));
    s.add(m.cropId);
  };
  S.shaftMarks.forEach(add);
  S.lineMarks.forEach(add);
  S.labelerCells = { byLabeler, any };
}
/** The live predicate arguments (one object, so list + map can never diverge). */
function filterOpts() {
  return {
    lo: S.filter.lo, hi: S.filter.hi,
    checked: S.filter.checked, unlabeledOnly: S.filter.unlabeled,
    labelerCells: S.labelerCells,
  };
}
function maxRank() { return S.cells.length ? S.cells.length - 1 : 0; }
/** True when at least one condition narrows the set (drives the veil + summary). */
function filterActive() { return filterIsActive(filterOpts(), maxRank()); }
function cellMatchesFilter(cid) {
  const r = S.cellRank.has(cid) ? S.cellRank.get(cid) : -1;
  return cellPasses(cid, r, filterOpts());
}
function countMatches() {
  let n = 0;
  for (const c of S.cells) if (cellMatchesFilter(c.id)) n++;
  return n;
}

// ---- rank slider (two overlaid <input type=range> over indices into S.cells) --
// Native range inputs cannot express two handles, so both are stacked on one
// track. Pointer events are taken on the CONTAINER (the inputs themselves are
// pointer-events:none) and routed to whichever handle is nearer the click —
// deterministic even when the two handles sit on the same pixel, which the
// usual z-index juggling gets wrong. Keyboard still works: the chosen handle is
// focused on pointerdown, and each input's own `input` event is handled below.
const RANK_THUMB_PX = 14; // keep in sync with the thumb width in style.css

function initRankSlider() {
  const lo = $('rank-lo'), hi = $('rank-hi');
  if (!lo || !hi) return;
  const max = maxRank();
  S.filter.lo = 0; S.filter.hi = max;
  for (const el of [lo, hi]) { el.min = '0'; el.max = String(max); el.step = '1'; }
  lo.value = '0'; hi.value = String(max);
  syncRankUI();
}
/** Clamp so lo <= hi (a handle pushed past the other stops, never swaps). */
function setRankRange(lo, hi) {
  const max = maxRank();
  S.filter.lo = Math.max(0, Math.min(max, Math.round(lo)));
  S.filter.hi = Math.max(0, Math.min(max, Math.round(hi)));
  if (S.filter.lo > S.filter.hi) S.filter.lo = S.filter.hi;
  const loEl = $('rank-lo'), hiEl = $('rank-hi');
  if (loEl) loEl.value = String(S.filter.lo);
  if (hiEl) hiEl.value = String(S.filter.hi);
  syncRankUI();
}
/** Repaint the selected-range bar + the two value/percentile readouts. */
function syncRankUI() {
  const max = maxRank() || 1;
  const fill = $('rank-fill');
  if (fill) {
    fill.style.left = (S.filter.lo / max) * 100 + '%';
    fill.style.right = (1 - S.filter.hi / max) * 100 + '%';
  }
  const total = S.cells.length;
  const put = (id, rank) => {
    const el = $(id);
    if (!el) return;
    const c = S.cells[rank];
    el.textContent = c
      ? `${fmtP(c.p_pos)}  ·  top ${fmtPercent(rankPercent(rank, total))}%`
      : '—';
  };
  put('rank-lo-out', S.filter.lo);
  put('rank-hi-out', S.filter.hi);
}
/** Track x (client px) -> rank, matching the native thumb's half-width insets. */
function rankFromClientX(clientX) {
  const box = $('rank-slider').getBoundingClientRect();
  const usable = Math.max(1, box.width - RANK_THUMB_PX);
  const f = (clientX - box.left - RANK_THUMB_PX / 2) / usable;
  return Math.round(Math.max(0, Math.min(1, f)) * maxRank());
}
function setupRankSlider() {
  const wrap = $('rank-slider');
  if (!wrap) return;
  let dragging = null; // 'lo' | 'hi' while a pointer drag is in flight
  const applyAt = (clientX) => {
    const r = rankFromClientX(clientX);
    if (dragging === 'lo') setRankRange(Math.min(r, S.filter.hi), S.filter.hi);
    else setRankRange(S.filter.lo, Math.max(r, S.filter.lo));
    scheduleFilterRender();
  };
  wrap.addEventListener('pointerdown', (e) => {
    const r = rankFromClientX(e.clientX);
    // nearest handle wins; ties go to the one that can still move that way
    const dLo = Math.abs(r - S.filter.lo), dHi = Math.abs(r - S.filter.hi);
    dragging = (dLo < dHi || (dLo === dHi && r < S.filter.lo)) ? 'lo' : 'hi';
    const el = $(dragging === 'lo' ? 'rank-lo' : 'rank-hi');
    if (el) el.focus();
    wrap.setPointerCapture(e.pointerId);
    applyAt(e.clientX);
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => { if (dragging) applyAt(e.clientX); });
  const end = () => { dragging = null; };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  // keyboard (arrows / Home / End on the focused input)
  for (const id of ['rank-lo', 'rank-hi']) {
    $(id).addEventListener('input', () => {
      setRankRange(Number($('rank-lo').value), Number($('rank-hi').value));
      scheduleFilterRender();
    });
  }
}

// ---- "labeled by…" checkbox list -------------------------------------------
/** Display label for a normalized labeler name (mine gets the "(me)" suffix). */
function labelerLabel(who) {
  return who === S.me ? `${S.meDisplay || who} (me)` : who;
}
/**
 * Rebuild the checkbox list from the current pool, preserving the selection for
 * labelers that still exist and silently dropping those that vanished.
 */
function rebuildLabelerChecks() {
  const box = $('filter-labelers');
  if (!box) return;
  const pool = new Set([...S.labelerCells.byLabeler.keys()].filter((n) => n));
  S.filter.checked = pruneSelection(S.filter.checked, pool);
  const names = labelerOrder(pool, S.me);
  // the list is rebuilt wholesale on every pool change AND on every toggle, so
  // keep the user's place: scroll offset + which row had keyboard focus.
  const scroll = box.scrollTop;
  const act = document.activeElement;
  const keepKey = act && box.contains(act)
    ? (act.dataset.role ? 'role:' + act.dataset.role : 'who:' + act.dataset.who) : null;
  box.innerHTML = '';
  const row = (value, text, checked, role) => {
    const lab = document.createElement('label');
    lab.className = 'filter-chk' + (role ? ' filter-chk-' + role : '');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = checked;
    if (role) inp.dataset.role = role; else inp.dataset.who = value;
    const span = document.createElement('span');
    span.textContent = text;
    lab.appendChild(inp); lab.appendChild(span);
    box.appendChild(lab);
    return inp;
  };
  const allBox = row('', '(all users)', names.length > 0 && S.filter.checked.size === names.length, 'all');
  allBox.indeterminate = S.filter.checked.size > 0 && S.filter.checked.size < names.length;
  if (!names.length) {
    const em = document.createElement('div');
    em.className = 'filter-empty';
    em.textContent = 'nobody has labeled in this project yet';
    box.appendChild(em);
  }
  for (const n of names) row(n, labelerLabel(n), S.filter.checked.has(n));
  row('', '(unlabeled)', S.filter.unlabeled, 'unlabeled');
  box.querySelectorAll('input[type=checkbox]').forEach((inp) => {
    inp.addEventListener('change', () => onLabelerCheck(inp, names));
    const key = inp.dataset.role ? 'role:' + inp.dataset.role : 'who:' + inp.dataset.who;
    if (key === keepKey) inp.focus();
  });
  box.scrollTop = scroll;
}
/** Apply one checkbox change to S.filter, enforcing the exclusivity rules. */
function onLabelerCheck(inp, names) {
  const role = inp.dataset.role;
  if (role === 'unlabeled') {
    S.filter.unlabeled = inp.checked;
    if (inp.checked) S.filter.checked = new Set(); // exclusive with the labelers
  } else if (role === 'all') {
    S.filter.checked = inp.checked ? new Set(names) : new Set();
    if (inp.checked) S.filter.unlabeled = false;
  } else {
    const who = inp.dataset.who;
    if (inp.checked) { S.filter.checked.add(who); S.filter.unlabeled = false; }
    else S.filter.checked.delete(who);
  }
  rebuildLabelerChecks(); // repaint (all)/(unlabeled) states from the new truth
  scheduleFilterRender();
}

// ---- collapse / expand + summary -------------------------------------------
function setFilterOpen(open) {
  S.filter.open = !!open;
  const body = $('filter-body'), btn = $('filter-toggle'), caret = $('filter-caret');
  if (body) body.hidden = !S.filter.open;
  if (btn) btn.setAttribute('aria-expanded', S.filter.open ? 'true' : 'false');
  if (caret) caret.textContent = S.filter.open ? '▾' : '▸';
}
function updateFilterSummary() {
  const el = $('filter-summary');
  if (!el) return;
  el.textContent = filterSummary(filterOpts(), {
    total: S.cells.length,
    matched: countMatches(),
    me: S.me,
    meLabel: 'me',
  });
  const btn = $('filter-toggle');
  if (btn) btn.classList.toggle('is-active', filterActive());
  const reset = $('filter-reset');
  if (reset) reset.disabled = !filterActive();
}
function resetFilter() {
  S.filter.checked = new Set();
  S.filter.unlabeled = false;
  setRankRange(0, maxRank());
  rebuildLabelerChecks();
  scheduleFilterRender();
}

// ---- render coalescing ------------------------------------------------------
// Dragging a handle would otherwise rebuild ~5000 <li> plus a long SVG path per
// pointermove event. One pending rAF frame max keeps the drag smooth without
// the lag a timeout-debounce would add.
let _filterFrame = 0;
function scheduleFilterRender() {
  if (_filterFrame) return;
  _filterFrame = requestAnimationFrame(() => {
    _filterFrame = 0;
    applyFilterRender();
  });
}
function applyFilterRender() {
  updateFilterSummary();
  buildSideList();
  rebuildFilterLayer();
  applyLayerToggles();
  if (S.review.on) reviewRefreshUI(); // repaint badges on the rebuilt rows
}

/** Repaint the map SPOTLIGHT (a no-op when no filter condition is active).
 *
 *  The rule the spotlight enforces is "bright and colourful = in the filter
 *  result", and it takes TWO mechanisms to hold, because a black veil removes
 *  luminance but not chroma — under a 55% veil a filtered-OUT hot plasma cell
 *  was still more vividly coloured than a matching cold one:
 *
 *    1. VEIL — one even-odd path in #g-filter: the whole swath rect with a hole
 *       punched over each matching cell. #g-filter sits above every content
 *       layer (see buildSwathLayers), so marks, GT dots and cell outlines dim
 *       along with the imagery instead of floating over the veil.
 *    2. CLIP — the colour layers (#heat-img, #g-acc) are clipped to the
 *       matching cells, so outside them you get the plain greyscale swath under
 *       the veil: no chroma at all, not merely darker chroma.
 *
 *  The clip path is the exact geometric INVERSE of the veil path (veil =
 *  outer-rect MINUS matches, clip = matches only), so both are built from the
 *  same single pass over S.cells here — see spotlightPaths() in cellfilter.js.
 *  Splitting them into two passes/functions will let them drift out of sync. */
function rebuildFilterLayer() {
  const g = document.getElementById('g-filter');
  if (!g) return;
  g.innerHTML = '';
  if (!filterActive()) { applyFilterClip(''); return; }
  let holes = '';
  for (const c of S.cells) {
    if (!cellMatchesFilter(c.id)) continue;
    const [x0, y0, x1, y1] = c.world_bbox;
    const [px0, py0] = worldToSwathPx(x0, y1);
    const [px1, py1] = worldToSwathPx(x1, y0);
    holes += rectSubpath(Math.min(px0, px1), Math.min(py0, py1),
                         Math.abs(px1 - px0), Math.abs(py1 - py0));
  }
  const { veil, clip } = spotlightPaths(S.swathW, S.swathH, holes);
  g.appendChild(svgEl('path', { d: veil, 'fill-rule': 'evenodd', class: 'filter-dim' }));
  applyFilterClip(clip);
}
/** Point #heat-img and #g-acc at the spotlight clipPath, or release them.
 *
 *  Coordinate systems line up 1:1 with no conversion: #swath-svg is sized
 *  width/height = S.swathW/S.swathH with viewBox "0 0 swathW swathH", and
 *  #heat-img carries the same width/height attributes at left:0/top:0 inside
 *  #swath-stage — so SVG user units == swath pixels == the img's border-box
 *  pixels, which is what clipPathUnits="userSpaceOnUse" resolves against for an
 *  HTML referrer. The zoom is a CSS transform on the shared #swath-stage
 *  ancestor and therefore scales clip and content together.
 *
 *  Passing '' releases both clips. That is what makes the "Filter mask" toggle
 *  a complete escape hatch (see applyLayerToggles): hiding the veil without
 *  releasing the clips would leave a half-on state with the heatmap still
 *  punched out and nothing on screen explaining why. */
let _filterClipD = ''; // last built clip geometry; '' means "no spotlight"
function applyFilterClip(clipD) {
  if (clipD !== undefined) _filterClipD = clipD || '';
  const path = document.getElementById('filter-clip-path');
  if (path) path.setAttribute('d', _filterClipD);
  const tg = $('tg-filter');
  const ref = (_filterClipD && (!tg || tg.checked)) ? 'url(#filter-clip)' : '';
  const heat = document.getElementById('heat-img');
  if (heat) heat.style.clipPath = ref;
  const gAcc = document.getElementById('g-acc');
  if (gAcc) gAcc.style.clipPath = ref;
}
/** Full refresh of everything the filter drives (call after pool changes). */
function refreshFilterUI() {
  computeLabelerCells();
  rebuildLabelerChecks(); // keeps the selection for labelers that still exist
  updateFilterSummary();
  buildSideList();
  rebuildFilterLayer();
  if (S.review.on) reviewRefreshUI(); // repaint badges on the rebuilt rows
}

// --------------------------------------------------------------------------- //
// side list
// --------------------------------------------------------------------------- //
function buildSideList() {
  const ul = $('cell-list');
  ul.innerHTML = '';
  for (const c of S.cells) {
    if (!cellMatchesFilter(c.id)) continue; // active filter -> matching cells only
    const li = document.createElement('li');
    li.dataset.cid = c.id;
    li.innerHTML = `<span class="done">${S.done.has(c.id) ? '✓' : ''}</span>` +
      // review-mode badge slot (content painted by reviewRefreshUI); the added
      // string is '' in normal mode, so the markup is unchanged there.
      (S.review.on && S.review.eligible.has(c.id) ? '<span class="gtr-badge"></span>' : '') +
      `<span class="cid">${c.id}</span><span class="pp">${fmtP(c.p_pos)}</span>`;
    li.addEventListener('click', () => openCrop(c.id));
    li.addEventListener('mouseenter', () => highlightCell(c.id, true, true));
    li.addEventListener('mouseleave', () => highlightCell(c.id, false, true));
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
function highlightCell(cid, on, strong = false) {
  document.querySelectorAll(`#cell-list li[data-cid="${CSS.escape(cid)}"]`).forEach((li) => li.classList.toggle('hl', on));
  document.querySelectorAll(`#swath-svg .cell-rect[data-cid="${CSS.escape(cid)}"]`).forEach((r) => r.classList.toggle('hover', on));
  // sidebar-driven hover gets the strong casing highlight (the subtle blue is
  // invisible under the heatmap/mask, and the cursor isn't on the map to guide
  // the eye); direct map hover keeps the subtle style only.
  if (strong) setStrongHighlight(on ? cid : null);
}
/** Show the black/white casing rects over one cell (null = hide). */
function setStrongHighlight(cid) {
  const outer = document.getElementById('hl-outer');
  const inner = document.getElementById('hl-inner');
  if (!outer || !inner) return;
  const cell = cid ? S.cellById.get(cid) : null;
  if (!cell) {
    outer.setAttribute('visibility', 'hidden');
    inner.setAttribute('visibility', 'hidden');
    return;
  }
  const [x0, y0, x1, y1] = cell.world_bbox;
  const [px0, py0] = worldToSwathPx(x0, y1);
  const [px1, py1] = worldToSwathPx(x1, y0);
  for (const r of [outer, inner]) {
    r.setAttribute('x', Math.min(px0, px1));
    r.setAttribute('y', Math.min(py0, py1));
    r.setAttribute('width', Math.abs(px1 - px0));
    r.setAttribute('height', Math.abs(py1 - py0));
    r.setAttribute('visibility', 'visible');
  }
  updateHlStrokeWidths();
}
/** Keep the casing strokes a constant SCREEN width (5px black / 3px white).
 *  The zoom is a CSS scale() on #swath-stage, which scales the rendered SVG
 *  wholesale — SVG's vector-effect can't counteract an HTML-ancestor
 *  transform — so we divide the stroke width by the current zoom instead. */
function updateHlStrokeWidths() {
  const outer = document.getElementById('hl-outer');
  const inner = document.getElementById('hl-inner');
  const s = S.view.scale || 1;
  if (outer) outer.setAttribute('stroke-width', 5 / s);
  if (inner) inner.setAttribute('stroke-width', 3 / s);
}

// --------------------------------------------------------------------------- //
// swath view
// --------------------------------------------------------------------------- //
function worldToSwathPx(x, y) {
  const [minx, miny, maxx, maxy] = S.swathBounds;
  const mPerPx = S.manifest.swath.m_per_px;
  return [(x - minx) / mPerPx, (maxy - y) / mPerPx];
}
// TIFs whose existing GT was reviewed as ACCURATE (gt_review 2026-07-02, 25/25
// unanimous verdicts) — drives the toggleable light-green swath mask. Update
// this list as more GT-review verdicts come in.
// Labeling projects. Marks are fully separated per project: the gate requires
// picking one (never remembered across logins — a stale preselection is how
// labels end up in the wrong project), every DB row is stamped with it, and
// pull/save/reconcile are all scoped to it. Select-only: users cannot add
// projects; to add one, extend this list (alphabetical) and redeploy.
const PROJECTS = ['EPAS_2026_Q2', 'Test'];

const ACCURATE_TIFS = new Set([
  '1039-2088DA038_b_R_utm38n.tif',
  '1039-2088DA037_b_L_utm38n.tif',
  '1039-2088DA039_b_R_utm38n.tif',
  '1039-2088DA039_b_L_utm38n.tif',
]);

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
  // <defs> holds the filter spotlight's clipPath (never rendered directly; it is
  // referenced by #heat-img and #g-acc — see rebuildFilterLayer).
  const defs = svgEl('defs', {});
  const clip = svgEl('clipPath', { id: 'filter-clip', clipPathUnits: 'userSpaceOnUse' });
  clip.appendChild(svgEl('path', { id: 'filter-clip-path', d: '' }));
  defs.appendChild(clip);
  svg.appendChild(defs);
  const gAcc = svgEl('g', { id: 'g-acc' });   // accurate-TIF mask, under all other layers
  const gGt = svgEl('g', { id: 'g-gt' });
  const gMine = svgEl('g', { id: 'g-mine' });
  const gCells = svgEl('g', { id: 'g-cells' });
  // Filter SPOTLIGHT veil, deliberately appended ABOVE g-cells (it used to sit
  // just above g-acc, where it darkened only the base/heatmap imagery while GT
  // dots, other users' marks, my marks and every cell outline still painted at
  // full brightness on top of it — the exact inverse of "bright = matching").
  // Everything below it now dims together. Do NOT move it back down.
  const gFilter = svgEl('g', { id: 'g-filter' });
  svg.appendChild(gAcc); svg.appendChild(gGt); svg.appendChild(gMine);
  svg.appendChild(gCells); svg.appendChild(gFilter);
  // strong sidebar-hover highlight: white outline inside a black casing, in a
  // group appended LAST so it paints above every other layer (the heatmap is a
  // sibling <img> below the whole SVG). Hidden until a sidebar row is hovered.
  // This is the ONE layer that stays above the filter veil: hovering a sidebar
  // row is a deliberate "show me this cell" action and must win even when the
  // cell is filtered out (that is how you locate a non-matching cell at all).
  const gHl = svgEl('g', { id: 'g-hl' });
  gHl.appendChild(svgEl('rect', { id: 'hl-outer', class: 'hl-casing hl-outer', visibility: 'hidden' }));
  gHl.appendChild(svgEl('rect', { id: 'hl-inner', class: 'hl-casing hl-inner', visibility: 'hidden' }));
  svg.appendChild(gHl);

  for (const c of S.cells) {
    const [x0, y0, x1, y1] = c.world_bbox;
    const [px0, py0] = worldToSwathPx(x0, y1); // top-left
    const [px1, py1] = worldToSwathPx(x1, y0); // bottom-right
    // light-green mask over cells whose dominant owner TIF was reviewed accurate
    // (cell-level coverage, same footprint logic as the heatmap layer)
    if (ACCURATE_TIFS.has((c.tifs || [])[0])) {
      gAcc.appendChild(svgEl('rect', {
        x: Math.min(px0, px1), y: Math.min(py0, py1),
        width: Math.abs(px1 - px0), height: Math.abs(py1 - py0),
        class: 'acc-rect',
      }));
    }
    const rect = svgEl('rect', {
      x: Math.min(px0, px1), y: Math.min(py0, py1),
      width: Math.abs(px1 - px0), height: Math.abs(py1 - py0),
      class: 'cell-rect' + (S.done.has(c.id) ? ' done' : ''),
    });
    rect.dataset.cid = c.id;
    // review mode: amber outline on eligible cells (verdict tints via reviewRefreshUI)
    if (S.review.on && S.review.eligible.has(c.id)) rect.classList.add('gt-eligible');
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

    // existing GT shaft points only (cell.gt_points are in world coords);
    // GT polylines (cell.gt_lines) are deliberately NOT rendered — dots only.
    for (const [gx, gy] of c.gt_points || []) {
      const [sx, sy] = worldToSwathPx(gx, gy);
      gGt.appendChild(svgEl('circle', { cx: sx, cy: sy, r: 1.2, class: 'gt-dot' }));
    }
  }
  rebuildMineLayer();
  rebuildFilterLayer();
  applyLayerToggles();
}
function rebuildMineLayer() {
  const g = document.getElementById('g-mine');
  if (!g) return;
  g.innerHTML = '';
  // draw others' (read-only, greyed) marks first so my lime marks sit on top.
  for (const m of S.shaftMarks) {
    const mine = m.labeler === S.me;
    const [sx, sy] = worldToSwathPx(m.world[0], m.world[1]);
    g.appendChild(svgEl('circle', { cx: sx, cy: sy, r: mine ? 1.6 : 1.4, class: mine ? 'mine-dot' : 'others-dot' }));
  }
  for (const m of S.lineMarks) {
    if (!m.world || m.world.length < 2) continue;
    const mine = m.labeler === S.me;
    const pts = m.world.map(([x, y]) => worldToSwathPx(x, y).join(',')).join(' ');
    g.appendChild(svgEl('polyline', { points: pts, class: mine ? 'mine-line' : 'others-line' }));
  }
}
function applyLayerToggles() {
  $('heat-img').style.display = $('tg-heatmap').checked ? '' : 'none';
  const gGt = document.getElementById('g-gt'); if (gGt) gGt.style.display = $('tg-gt').checked ? '' : 'none';
  const gMine = document.getElementById('g-mine'); if (gMine) gMine.style.display = $('tg-mine').checked ? '' : 'none';
  const gAcc = document.getElementById('g-acc'); if (gAcc) gAcc.style.display = $('tg-acc').checked ? '' : 'none';
  // "Filter mask" is a COMPLETE escape hatch: it hides the veil AND releases the
  // clip on the colour layers, so unchecking it restores the full-colour heatmap
  // and green mask everywhere. Never leave one half of the spotlight on.
  const gFilter = document.getElementById('g-filter'); if (gFilter) gFilter.style.display = $('tg-filter').checked ? '' : 'none';
  applyFilterClip(); // re-resolve the clip refs against the toggle's new state
}
function applySwathTransform() {
  const { x, y, scale } = S.view;
  $('swath-stage').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  updateHlStrokeWidths(); // keep the hover-casing outline constant in screen px
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
  function endDrag(e) {
    if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_MOVE_PX) {
      S.suppressCellClick = true; // gesture was a pan -> swallow the trailing cell click
    }
    dragging = false;
  }
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // The mouseup can be swallowed (context menu, alt-tab, pointer leaving the
    // window); without this the map would keep following a button-less cursor.
    if (e.buttons === 0) { endDrag(e); return; }
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
  // mousedown above never filters on e.button, so a right-drag already pans —
  // the browser context menu just popped up over it. Suppress it on the map
  // ONLY, so right-click keeps working on the sidebar, topbar and the rest.
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
}

// --------------------------------------------------------------------------- //
// adjacent-crop navigation (neighbour lookup)
//
// Cells sit on a regular grid, so a neighbour is just "this cell's centre ±
// one cell size" — but the baked manifest has HOLES (cells were dropped when
// their valid-imagery fraction was too low), so the lookup must go through the
// actual cell set, never through arithmetic on the id alone. The step comes
// from the cell's own bbox rather than a hard-coded 2048 m.
// --------------------------------------------------------------------------- //
function centreKey(cx, cy) { return `${Math.round(cx)}_${Math.round(cy)}`; }
function cellCentre(cell) {
  const [x0, y0, x1, y1] = cell.world_bbox;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
/** Built once per unlock, alongside S.cellById. */
function buildCellCentreIndex() {
  S.cellByCentre = new Map();
  for (const c of S.cells) {
    if (!c.world_bbox) continue;
    const [cx, cy] = cellCentre(c);
    S.cellByCentre.set(centreKey(cx, cy), c);
  }
}
// screen direction -> world-coord step sign. Northing grows upward, so 'up' is +y.
const NAV_DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
const NAV_LABEL = { up: 'north', down: 'south', left: 'west', right: 'east' };
/** The adjacent cell in `dir`, or null when the grid has no cell there. */
function neighbourCell(cell, dir) {
  const d = NAV_DIRS[dir];
  if (!d || !cell || !cell.world_bbox) return null;
  const [x0, y0, x1, y1] = cell.world_bbox;
  const stepX = Math.abs(x1 - x0), stepY = Math.abs(y1 - y0);
  const [cx, cy] = cellCentre(cell);
  return S.cellByCentre.get(centreKey(cx + d[0] * stepX, cy + d[1] * stepY)) || null;
}
/** Show an edge arrow only where a neighbour actually exists. Runs per openCrop. */
function updateCropNavButtons() {
  const cell = S.crop ? S.crop.cell : null;
  for (const dir of Object.keys(NAV_DIRS)) {
    const b = $('crop-nav-' + dir);
    if (!b) continue;
    const n = cell ? neighbourCell(cell, dir) : null;
    b.hidden = !n;
    b.title = n ? `${NAV_LABEL[dir]} → ${n.id}` : '';
  }
}
/** Unsaved-marks test: an explicit edit, a polyline still being drawn, or a
 *  pending (unsaved) superuser delete of someone else's mark. */
function cropIsDirty() {
  if (!S.crop) return false;
  return cropDirtyState({
    dirty: S.crop.dirty,
    inProgressLen: S.crop.inProgress ? S.crop.inProgress.length : 0,
    pendingOthers: S.crop.pendingOthersDeletes ? S.crop.pendingOthersDeletes.size : 0,
  });
}
/** Per-action wording for the unsaved-marks prompt. 'nav' matches the static
 *  HTML defaults; 'close' rewords the message and the save/discard buttons.
 *  "Cancel" is the same for both. */
const UNSAVED_PROMPT_STRINGS = {
  nav: {
    msg: 'You changed marks on this crop without saving. What should happen before moving to the adjacent crop?',
    save: 'Save & go', discard: 'Discard & go',
  },
  close: {
    msg: 'You changed marks on this crop without saving. What should happen before closing this crop?',
    save: 'Save & close', discard: 'Discard & close',
  },
};
/** In-app 3-way prompt (window.confirm can only offer two). `action` is
 *  'nav' | 'close' and picks ONLY the wording — the choices and their
 *  semantics are identical either way. Resolves to 'save' | 'discard' |
 *  'cancel'. Esc cancels (see the keydown handler). */
function askUnsavedChoice(action) {
  return new Promise((resolve) => {
    const dlg = $('crop-nav-confirm');
    if (!dlg) { resolve('cancel'); return; }
    const str = UNSAVED_PROMPT_STRINGS[action] || UNSAVED_PROMPT_STRINGS.nav;
    const msg = dlg.querySelector('.nav-confirm-msg');
    if (msg) msg.textContent = str.msg;
    const save = $('crop-nav-save'), discard = $('crop-nav-discard');
    if (save) save.textContent = str.save;
    if (discard) discard.textContent = str.discard;
    S.navDialog = (choice) => {
      S.navDialog = null;
      dlg.hidden = true;
      resolve(choice);
    };
    dlg.hidden = false;
    const c = $('crop-nav-cancel');
    if (c) c.focus();
  });
}
function closeNavDialog(choice) { if (S.navDialog) S.navDialog(choice); }
/**
 * Jump to the neighbouring crop without leaving the modal.
 * ORDERING IS LOAD-BEARING: openCrop() replaces S.crop wholesale and commitCrop()
 * reads/mutates it, so the save must be fully awaited BEFORE the jump.
 * Zoom is deliberately not preserved — openCrop's fitCrop() resets it.
 */
async function navigateCrop(dir) {
  if (S.navBusy) return;                       // a jump/prompt is already running
  if (!S.crop || $('crop-modal').hidden) return;
  const target = neighbourCell(S.crop.cell, dir);
  if (!target) return;                          // no such neighbour -> nothing to do
  S.navBusy = true;
  try {
    if (cropIsDirty()) {
      const choice = await askUnsavedChoice('nav');
      if (choice === 'cancel') return;
      if (!S.crop) return;                      // modal closed while the prompt was up
      if (choice === 'save') {
        const savedId = S.crop.cell.id;
        await commitCrop();                     // MUST finish before openCrop replaces S.crop
        setStatus('saved ' + savedId);
      }
      // 'discard': openCrop below rebuilds the marks from the pool, so the
      // uncommitted edits simply never leave S.crop.
    }
    await openCrop(target.id);
  } finally {
    S.navBusy = false;
  }
}
/**
 * Close request from the Close button, a backdrop click, or Esc: same dirty test
 * (cropIsDirty) and same 3-way prompt as navigateCrop, with the pending action
 * being "close the modal" instead of "go to cell X" — askUnsavedChoice('close')
 * only rewords the dialog. A clean crop closes immediately, no prompt.
 * Shares S.navBusy so a close request can't race a pending nav prompt/jump.
 */
async function requestCloseCrop() {
  if (S.navBusy) return;                       // a jump/prompt is already running
  if (!S.crop || $('crop-modal').hidden) return;
  if (!cropIsDirty()) { closeCrop(false); return; }
  S.navBusy = true;
  try {
    const choice = await askUnsavedChoice('close');
    if (choice === 'cancel') return;
    if (!S.crop) return;                       // modal closed while the prompt was up
    if (choice === 'save') {
      const savedId = S.crop.cell.id;
      await commitCrop();                      // fully awaited BEFORE the close, like navigateCrop
      setStatus('saved ' + savedId);
    }
    // 'discard': closeCrop nulls S.crop, so the uncommitted edits never reach
    // the pool — the next openCrop rebuilds marks from the saved pool.
    closeCrop(false);
  } finally {
    S.navBusy = false;
  }
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

  S.crop = {
    cell, raw, ctx, img,
    view: { x: 0, y: 0, scale: 1 },
    marks: { points: [], lines: [] },      // MY editable marks ({px|pts, ac} objects)
    others: { points: [], lines: [] },     // OTHERS' read-only marks (bare pixel coords)
    inProgress: [],
    // indices of currently-selected marks. points/lines = OWN marks; oPoints/
    // oLines = OTHERS' marks (only ever populated while "Edit others" is on).
    selected: { points: new Set(), lines: new Set(), oPoints: new Set(), oLines: new Set() },
    selectBox: null,       // [c0, r0, c1, r1] in 1024² coords while rubber-band-dragging
    dirty: false,          // unsaved mark edits (drives the unsaved-marks prompt on nav AND close)
    // superuser cross-labeler edits pending commit: row ids of OTHERS' marks
    // deleted in this crop but not yet saved. Committed by commitCrop via
    // rpc_delete_marks (explicitly — the own-marks reconcile never touches
    // them); counted by cropIsDirty so the unsaved prompt guards them too.
    pendingOthersDeletes: new Set(),
  };
  loadCropMarksFor(cell);
  $('crop-title').textContent = `${cell.id}   p_pos=${fmtP(cell.p_pos)}   (${cell.gt_points.length} GT shafts)`;
  // GT-review verdict buttons: only in review mode AND for eligible cells
  // (in normal mode `show` is false and the span stays hidden, as shipped).
  const revBtns = $('gt-review-btns');
  if (revBtns) {
    const show = S.review.on && S.review.eligible.has(cell.id);
    revBtns.hidden = !show;
    if (show) reviewSyncCropButtons();
  }
  $('crop-autocontrast').checked = false;
  $('crop-gt').checked = true;
  document.querySelector('input[name="drawmode"][value="point"]').checked = true;
  $('crop-modal').hidden = false;
  updateCropNavButtons(); // edge arrows for whichever neighbours this cell has
  resizeCropOverlay();   // stage has a layout size only now that the modal is shown
  fitCrop();
  redrawCrop();
}
// (re)derive the crop's mine/others pixel marks from the merged S.*Marks pool.
function loadCropMarksFor(cell) {
  const cid = cell.id;
  const mine = { points: [], lines: [] };
  const others = { points: [], lines: [] };
  // my marks keep their per-mark autocontrast flag (`ac`; null on pre-provenance
  // rows), their `created` timestamp AND their `dbId` — an untouched mark keeps
  // its row byte-identical across saves (the reconcile in commitCrop skips it);
  // others' are display-only coords + the owner's name for the hover tooltip.
  for (const m of S.shaftMarks) if (m.cropId === cid) {
    const px = worldToPixel(m.world[0], m.world[1], cell.world_bbox);
    if (m.labeler === S.me) mine.points.push({ px, ac: m.autocontrast ?? null, created: m.created || null, dbId: m.dbId ?? null });
    else others.points.push({ px, labeler: m.labeler || '', dbId: m.dbId ?? null, editedBy: m.editedBy || null });
  }
  for (const m of S.lineMarks) if (m.cropId === cid) {
    const ln = m.world.map(([x, y]) => worldToPixel(x, y, cell.world_bbox));
    if (m.labeler === S.me) mine.lines.push({ pts: ln, ac: m.autocontrast ?? null, created: m.created || null, dbId: m.dbId ?? null });
    else others.lines.push({ pts: ln, labeler: m.labeler || '', dbId: m.dbId ?? null, editedBy: m.editedBy || null });
  }
  S.crop.marks = mine;
  // a mid-session refresh re-pulls the pool where still-unsaved others-deletes
  // still exist as rows — prune them so they can't visually resurrect.
  const pending = S.crop.pendingOthersDeletes || new Set();
  S.crop.others = {
    points: pruneOthers(others.points, pending),
    lines: pruneOthers(others.lines, pending),
  };
}
// after a refresh while the modal is open: reload others' marks (and any of mine
// not currently being edited) without clobbering in-progress drawing/selection.
function reloadCropMarks() {
  if (!S.crop) return;
  loadCropMarksFor(S.crop.cell);
  selClear();
  S.crop.selectBox = null;
  hideCropHoverTip();  // the hovered mark may have vanished; next pointermove re-tests
  redrawCrop();
}
function closeCrop(save) {
  if (S.crop && save) commitCrop();
  closeNavDialog('cancel');  // never leave the nav prompt up over a closed modal
  S.crop = null;
  drawCropOverlay();   // wipe the vector overlay so nothing is stale on reopen
  hideCropHoverTip();  // never leave a hover name up over a closed/reopened crop
  $('crop-modal').hidden = true;
}
// ---- selection helpers ------------------------------------------------------
// S.crop.selected = {points, lines, oPoints, oLines} (Sets of indices).
// points/lines index into S.crop.marks (own); oPoints/oLines into S.crop.others
// and are only ever populated while the superuser "Edit others" toggle is on.
const SEL_KIND = {
  point: (sel) => sel.points, line: (sel) => sel.lines,
  opoint: (sel) => sel.oPoints, oline: (sel) => sel.oLines,
};
function selClear() {
  if (!S.crop) return;
  S.crop.selected.points.clear(); S.crop.selected.lines.clear();
  S.crop.selected.oPoints.clear(); S.crop.selected.oLines.clear();
}
function selCount() {
  if (!S.crop) return 0;
  const s = S.crop.selected;
  return s.points.size + s.lines.size + s.oPoints.size + s.oLines.size;
}
function selSet(kind, idx, additive) {
  if (!additive) selClear();
  SEL_KIND[kind](S.crop.selected).add(idx);
}
function boxNorm(b) { return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]; }
function pointInBox([c, r], b) { const [a0, a1, a2, a3] = boxNorm(b); return c >= a0 && c <= a2 && r >= a1 && r <= a3; }
function selectFromBox(box, additive) {
  if (!additive) selClear();
  S.crop.marks.points.forEach((p, i) => { if (pointInBox(p.px, box)) S.crop.selected.points.add(i); });
  S.crop.marks.lines.forEach((ln, i) => { if (ln.pts.some((v) => pointInBox(v, box))) S.crop.selected.lines.add(i); });
  // with "Edit others" on, the SAME box-select also takes others' marks
  if (suEditOn()) {
    S.crop.others.points.forEach((p, i) => { if (pointInBox(p.px, box)) S.crop.selected.oPoints.add(i); });
    S.crop.others.lines.forEach((ln, i) => { if (ln.pts.some((v) => pointInBox(v, box))) S.crop.selected.oLines.add(i); });
  }
}
function deleteSelected() {
  if (!S.crop || selCount() === 0) return;
  const pi = [...S.crop.selected.points].sort((a, b) => b - a);
  for (const i of pi) S.crop.marks.points.splice(i, 1);
  const li = [...S.crop.selected.lines].sort((a, b) => b - a);
  for (const i of li) S.crop.marks.lines.splice(i, 1);
  if (pi.length || li.length) S.crop.dirty = true;
  // others' marks: remove from the crop view NOW, but the DB rows only go on
  // save — their ids enter the pending set that commitCrop turns into an
  // explicit rpc_delete_marks call. (oPoints/oLines can only be non-empty
  // while "Edit others" is on — see the selection paths.)
  const removedOthers = [];
  const opi = [...S.crop.selected.oPoints].sort((a, b) => b - a);
  for (const i of opi) removedOthers.push(...S.crop.others.points.splice(i, 1));
  const oli = [...S.crop.selected.oLines].sort((a, b) => b - a);
  for (const i of oli) removedOthers.push(...S.crop.others.lines.splice(i, 1));
  for (const id of othersDeleteIds(removedOthers)) S.crop.pendingOthersDeletes.add(id);
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
  // the overlay is NOT transformed — it must be repainted on every view change
  // (pan / wheel-zoom / fit), otherwise the marks would lag behind the imagery.
  drawCropOverlay();
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
// ---- crop rendering -------------------------------------------------------
// The imagery lives on #crop-canvas (1024², CSS-`scale()`d, `image-rendering:
// pixelated`). ALL vectors live on #crop-overlay, which is stage-sized and
// never transformed, so a mark's radius / line width is constant in SCREEN px
// at any zoom: zooming in shrinks a mark's ground footprint instead of growing
// it, which is what lets a shaft be seen under the dot that marks it.
// The numeric constants below are the historical image-px ones, now read as
// screen px — identical look at fit-zoom.
const CROP_MARK_TOL_SCREEN_PX = 8;   // click tolerance; must match what's drawn

// backing store = stage client size × devicePixelRatio, ctx scaled so all
// drawing below is in CSS px. Safe to call any time (no-ops without the modal).
function resizeCropOverlay() {
  const stage = $('crop-stage'), ov = $('crop-overlay');
  if (!stage || !ov) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  ov.style.width = w + 'px'; ov.style.height = h + 'px';
  if (ov.width !== bw || ov.height !== bh) { ov.width = bw; ov.height = bh; }
  const octx = ov.getContext('2d');
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);   // reset every time: setting .width clears it
  return octx;
}
// repaint ONLY the imagery (raw or autocontrast-stretched)
function redrawCropImage() {
  if (!S.crop) return;
  const { ctx, raw } = S.crop;
  ctx.putImageData($('crop-autocontrast').checked ? autocontrast(raw) : raw, 0, 0);
}
// repaint ONLY the vectors, in screen space. Called on every view change too.
function drawCropOverlay() {
  const ov = $('crop-overlay');
  if (!ov) return;
  const ctx = resizeCropOverlay();
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, ov.width / dpr, ov.height / dpr);
  if (!S.crop) return;
  const { x: vx, y: vy, scale } = S.crop.view;
  // image px -> screen (CSS) px within the stage
  const SX = (c) => vx + c * scale, SY = (r) => vy + r * scale;
  ctx.save();
  // clip to the imagery's on-screen rect, as when the marks lived on the image canvas
  ctx.beginPath(); ctx.rect(vx, vy, 1024 * scale, 1024 * scale); ctx.clip();
  // existing GT (locked, read-only): shaft dots = red. GT polylines
  // (cell.gt_lines) are deliberately NOT rendered — dots only.
  if ($('crop-gt').checked) {
    ctx.save();
    ctx.fillStyle = '#ff3b30';
    for (const [gx, gy] of S.crop.cell.gt_points || []) {
      const [c, r] = worldToPixel(gx, gy, S.crop.cell.world_bbox);
      ctx.beginPath(); ctx.arc(SX(c), SY(r), 4, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.restore();
  }
  // others' marks (read-only, orange) — drawn under mine, never selectable
  if (S.crop.others && (S.crop.others.points.length || S.crop.others.lines.length)) {
    ctx.save();
    ctx.strokeStyle = '#ff9500'; ctx.fillStyle = '#ff9500'; ctx.lineWidth = 2; ctx.globalAlpha = 0.95;
    // selected others (Edit-others mode) get the same magenta halo as own marks
    const OSEL = '#ff00ff';
    S.crop.others.lines.forEach(({ pts: ln }, idx) => {
      if (ln.length < 1) return;
      ctx.beginPath();
      ln.forEach(([c, r], i) => { if (i === 0) ctx.moveTo(SX(c), SY(r)); else ctx.lineTo(SX(c), SY(r)); });
      ctx.stroke();
      if (S.crop.selected.oLines.has(idx)) {
        ctx.save(); ctx.strokeStyle = OSEL; ctx.lineWidth = 3.5; ctx.stroke(); ctx.restore();
      }
      for (const [c, r] of ln) { ctx.beginPath(); ctx.arc(SX(c), SY(r), 2.5, 0, 2 * Math.PI); ctx.fill(); }
    });
    S.crop.others.points.forEach(({ px: [c, r] }, idx) => {
      ctx.beginPath(); ctx.arc(SX(c), SY(r), 4, 0, 2 * Math.PI); ctx.fill();
      if (S.crop.selected.oPoints.has(idx)) {
        ctx.save(); ctx.strokeStyle = OSEL; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(SX(c), SY(r), 7.5, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
      }
    });
    ctx.restore();
  }
  // my marks (lime); selected ones get a magenta halo
  const SEL = '#ff00ff';
  ctx.save();
  ctx.strokeStyle = '#39ff14'; ctx.fillStyle = '#39ff14'; ctx.lineWidth = 2;
  S.crop.marks.lines.forEach(({ pts }, idx) => {
    if (pts.length < 1) return;
    ctx.beginPath();
    pts.forEach(([c, r], i) => { if (i === 0) ctx.moveTo(SX(c), SY(r)); else ctx.lineTo(SX(c), SY(r)); });
    ctx.stroke();
    if (S.crop.selected.lines.has(idx)) {
      ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 3.5; ctx.stroke(); ctx.restore();
    }
    for (const [c, r] of pts) { ctx.beginPath(); ctx.arc(SX(c), SY(r), 3, 0, 2 * Math.PI); ctx.fill(); }
  });
  S.crop.marks.points.forEach(({ px: [c, r] }, idx) => {
    ctx.beginPath(); ctx.arc(SX(c), SY(r), 5, 0, 2 * Math.PI); ctx.fill();
    if (S.crop.selected.points.has(idx)) {
      ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(SX(c), SY(r), 8.5, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    }
  });
  // in-progress polyline (white)
  if (S.crop.inProgress.length) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath();
    S.crop.inProgress.forEach(([c, r], i) => { if (i === 0) ctx.moveTo(SX(c), SY(r)); else ctx.lineTo(SX(c), SY(r)); });
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (const [c, r] of S.crop.inProgress) { ctx.beginPath(); ctx.arc(SX(c), SY(r), 3, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
  // rubber-band selection rectangle (stored in image px, drawn in screen px)
  if (S.crop.selectBox) {
    const [a0, a1, a2, a3] = boxNorm(S.crop.selectBox);
    ctx.save();
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(SX(a0), SY(a1), (a2 - a0) * scale, (a3 - a1) * scale);
    ctx.strokeRect(SX(a0), SY(a1), (a2 - a0) * scale, (a3 - a1) * scale);
    ctx.restore();
  }
  ctx.restore();
}
// "repaint everything" entry point (kept so all existing call sites stay valid)
function redrawCrop() {
  if (!S.crop) return;
  redrawCropImage();
  drawCropOverlay();
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
  // marks are drawn at a constant SCREEN size, so the tolerance must be too:
  // convert the screen-px tolerance into the image-px space of the coords.
  const tol = CROP_MARK_TOL_SCREEN_PX / Math.max(0.01, S.crop.view.scale);
  for (let i = 0; i < S.crop.marks.points.length; i++) {
    const [c, r] = S.crop.marks.points[i].px;
    if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'point', idx: i };
  }
  for (let i = 0; i < S.crop.marks.lines.length; i++) {
    for (const [c, r] of S.crop.marks.lines[i].pts) {
      if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'line', idx: i };
    }
  }
  return null;
}
// same tolerance/order convention as hitTestOwn, over OTHERS' marks. Only
// consulted while "Edit others" is on (callers gate on suEditOn()).
function hitTestOthers([col, row]) {
  const tol = CROP_MARK_TOL_SCREEN_PX / Math.max(0.01, S.crop.view.scale);
  for (let i = 0; i < S.crop.others.points.length; i++) {
    const [c, r] = S.crop.others.points[i].px;
    if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'opoint', idx: i };
  }
  for (let i = 0; i < S.crop.others.lines.length; i++) {
    for (const [c, r] of S.crop.others.lines[i].pts) {
      if ((c - col) ** 2 + (r - row) ** 2 <= tol * tol) return { kind: 'oline', idx: i };
    }
  }
  return null;
}
// ---- hover tooltip: who labeled an OTHER user's mark (crop popup only) ----
// Display-only: others' marks stay exactly as non-interactive as before for
// clicks/selection, and my own (lime) marks deliberately show no tooltip.
function hideCropHoverTip() {
  const tip = $('crop-hover-tip');
  if (tip && !tip.hidden) tip.hidden = true;
}
// (sx, sy) = cursor position in stage-relative CSS px
function showCropHoverTip(name, sx, sy) {
  const tip = $('crop-hover-tip'), stage = $('crop-stage');
  if (!tip || !stage) return;
  tip.textContent = name;
  tip.hidden = false;
  // near the cursor with a small offset, clamped inside the stage bounds
  // (measure only after the text is set — the width depends on the name)
  const pad = 4, off = 14;
  const left = Math.min(sx + off, stage.clientWidth - tip.offsetWidth - pad);
  const top = Math.min(sy + off, stage.clientHeight - tip.offsetHeight - pad);
  tip.style.left = Math.max(pad, left) + 'px';
  tip.style.top = Math.max(pad, top) + 'px';
}
function finishInProgressLine() {
  // provenance: the line is stamped with the toggle state at COMPLETION time
  // (dblclick/Enter/mode-switch/commit flush), one `ac` flag per line.
  if (S.crop.inProgress.length >= 2) {
    S.crop.marks.lines.push({ pts: S.crop.inProgress.slice(), ac: $('crop-autocontrast').checked });
    S.crop.dirty = true;
  }
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
      hideCropHoverTip();   // a pan is starting
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!S.crop || e.button !== 0) return;   // non-left bubbles to stage for panning
    e.stopPropagation();
    pressActive = true; pressMoved = false; pressX = e.clientX; pressY = e.clientY;
    pressPx = canvasEventToPx(e);
    pressAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
    S.crop.selectBox = null;
    hideCropHoverTip();   // a click/box-select press is starting
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
        drawCropOverlay();   // imagery unchanged while rubber-banding
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
        // own marks first (they draw on top), then — with "Edit others" on —
        // others' marks become clickable/selectable through the same gesture.
        const hit = hitTestOwn(pressPx) || (suEditOn() ? hitTestOthers(pressPx) : null);
        if (hit) { selSet(hit.kind, hit.idx, pressAdditive); redrawCrop(); return; }
        if (!pressAdditive) selClear();
        // new point: stamped with the toggle state at the moment it is added.
        if (drawMode() === 'point') S.crop.marks.points.push({ px: pressPx, ac: $('crop-autocontrast').checked });
        else S.crop.inProgress.push(pressPx);
        S.crop.dirty = true;
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
    hideCropHoverTip();   // marks moved under the cursor; next pointermove re-tests
  }, { passive: false });

  // ---- hover on an OTHER labeler's mark shows who made it (crop popup only) ----
  // Screen-space convention mirrors hitTestOwn exactly: cursor -> image px via
  // canvasEventToPx (the canvas rect already reflects the CSS transform), and
  // the constant SCREEN-px tolerance divided by the view scale into image px.
  // A linear scan over the crop's few hundred marks per pointermove is cheap;
  // bail first while any gesture is active (pan / press drag / polyline draw).
  stage.addEventListener('pointermove', (e) => {
    if (!S.crop) { hideCropHoverTip(); return; }
    if (panning || pressActive || S.crop.inProgress.length) { hideCropHoverTip(); return; }
    const [col, row] = canvasEventToPx(e);
    const tol = CROP_MARK_TOL_SCREEN_PX / Math.max(0.01, S.crop.view.scale);
    const hit = nearestMark(
      S.crop.others.points.map((p) => p.px),
      S.crop.others.lines.map((l) => l.pts),
      col, row, tol,
    );
    const m = hit && (hit.kind === 'point'
      ? S.crop.others.points[hit.idx]
      : S.crop.others.lines[hit.idx]);
    // dual attribution when a superuser has edited the mark: "Alice · edited by Bob"
    const who = m ? attribution(m.labeler, m.editedBy) : '';
    if (!who) { hideCropHoverTip(); return; }
    const rect = stage.getBoundingClientRect();
    showCropHoverTip(who, e.clientX - rect.left, e.clientY - rect.top);
  });
  stage.addEventListener('pointerleave', hideCropHoverTip);

  canvas.addEventListener('dblclick', (e) => {
    if (!S.crop) return;
    e.preventDefault();
    if (drawMode() === 'line') finishInProgressLine();
  });
  // the overlay's backing store is tied to the stage size / devicePixelRatio
  window.addEventListener('resize', () => { if (S.crop) drawCropOverlay(); });
  $('crop-autocontrast').addEventListener('change', redrawCrop);
  $('crop-gt').addEventListener('change', redrawCrop);
  $('crop-undo').addEventListener('click', () => {
    if (!S.crop) return;
    if (S.crop.inProgress.length) { S.crop.inProgress.pop(); S.crop.dirty = true; }
    else if (S.crop.marks.points.length || S.crop.marks.lines.length) {
      // undo whichever was added last is ambiguous after reload; pop a point first, else a line
      if (S.crop.marks.points.length) S.crop.marks.points.pop();
      else S.crop.marks.lines.pop();
      S.crop.dirty = true;
    }
    selClear();
    redrawCrop();
  });
  $('crop-clear').addEventListener('click', () => {
    if (!S.crop) return;
    if (!confirm('Remove all your marks for this crop?')) return;
    S.crop.marks.points = []; S.crop.marks.lines = []; S.crop.inProgress = []; S.crop.selectBox = null; selClear();
    S.crop.dirty = true;
    redrawCrop();
  });
  $('crop-save').addEventListener('click', () => { commitCrop(); setStatus('saved ' + S.crop.cell.id); });
  // guarded: prompts Save & close / Discard & close / Cancel on unsaved marks
  $('crop-close').addEventListener('click', () => requestCloseCrop());
  // ---- backdrop click closes the crop view (guarded exactly like Close) ----
  // Close ONLY when BOTH pointerdown and pointerup land on the backdrop itself:
  // a drag that starts on the canvas/stage and ends outside the box (or the
  // reverse) must not close. We listen on pointerup rather than click because
  // a click whose down/up targets differ retargets to their common ancestor —
  // which IS the backdrop — and would defeat the both-ends rule.
  // While #crop-nav-confirm is open, its own overlay (absolute inset:0, above
  // the box) receives the events, so e.target is never the modal; the
  // S.navDialog test below is belt and braces. #dl-modal is a sibling overlay
  // stacked above — its events never bubble through here.
  const cropModal = $('crop-modal');
  let backdropPress = false;   // did the last pointerdown land on the backdrop?
  cropModal.addEventListener('pointerdown', (e) => { backdropPress = e.target === cropModal; });
  cropModal.addEventListener('pointerup', (e) => {
    const downOnBackdrop = backdropPress;
    backdropPress = false;
    if (!downOnBackdrop || e.target !== cropModal) return;
    if (S.navDialog) return;   // the unsaved-marks prompt owns the interaction
    requestCloseCrop();
  });
  // ---- adjacent-crop navigation: edge arrows + the unsaved-changes prompt ----
  // stopPropagation on both mousedown and click so the stage/canvas never reads
  // an arrow press as a pan gesture or a point-placement click.
  for (const dir of Object.keys(NAV_DIRS)) {
    const b = $('crop-nav-' + dir);
    if (!b) continue;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); navigateCrop(dir); });
  }
  const navChoice = { 'crop-nav-save': 'save', 'crop-nav-discard': 'discard', 'crop-nav-cancel': 'cancel' };
  for (const id in navChoice) {
    const b = $(id);
    if (b) b.addEventListener('click', (e) => { e.stopPropagation(); closeNavDialog(navChoice[id]); });
  }
  // clicking the prompt's backdrop (never its box) is a cancel
  const navDlg = $('crop-nav-confirm');
  if (navDlg) navDlg.addEventListener('click', (e) => { if (e.target === navDlg) closeNavDialog('cancel'); });
  document.querySelectorAll('input[name="drawmode"]').forEach((r) => r.addEventListener('change', () => {
    if (S.crop && drawMode() === 'point') finishInProgressLine();
  }));
  document.addEventListener('keydown', (e) => {
    if (!S.crop || $('crop-modal').hidden) return;
    // the download dialog stacks above everything: while it is open it owns the
    // keyboard (Esc closes IT), so the crop's Esc/arrow duties stand down.
    if (!$('dl-modal').hidden) return;
    // the unsaved-changes prompt is modal: Esc cancels it, everything else
    // (including the arrow keys and Esc's normal duties) is swallowed.
    if (S.navDialog) {
      if (e.key === 'Escape') { e.preventDefault(); closeNavDialog('cancel'); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // same action as the matching edge button; a no-op when that neighbour
      // is missing. inside the crop modal the arrows belong to crop navigation
      // unconditionally — we deliberately do NOT bail out when the event target is
      // a form control, so this overrides the native arrow behaviour of the
      // name="drawmode" radio group. considered and kept; not a bug to "fix".
      e.preventDefault();
      navigateCrop(e.key.slice(5).toLowerCase());   // ArrowUp -> 'up', …
    }
    else if (e.key === 'Enter') { if (drawMode() === 'line') finishInProgressLine(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selCount() > 0) { deleteSelected(); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      if (S.crop.inProgress.length) { S.crop.inProgress = []; redrawCrop(); }
      else if (selCount() > 0 || S.crop.selectBox) { selClear(); S.crop.selectBox = null; redrawCrop(); }
      // all three close routes (Close button, backdrop click, Esc) converge on
      // requestCloseCrop(): dirty crops get the 3-way unsaved-marks prompt,
      // clean crops close immediately. Fire-and-forget, same as the button.
      // No recursion risk: while the prompt is up S.navDialog is set, so the
      // next Esc is swallowed above as a prompt-cancel before reaching here,
      // and S.navBusy makes a second requestCloseCrop a no-op regardless.
      else requestCloseCrop();
    } else if (S.review.on && (e.key === 'a' || e.key === 'd') &&
               !e.ctrlKey && !e.metaKey && !e.altKey) {
      // GT-review shortcut (review mode only): a = accurate, d = drifted.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (S.review.eligible.has(S.crop.cell.id)) {
        reviewSetVerdict(S.crop.cell.id, e.key === 'a' ? 'accurate' : 'drifted');
        e.preventDefault();
      }
    }
  });
}
async function commitCrop() {
  if (!S.crop) return;
  const cell = S.crop.cell;
  // flush any in-progress polyline (completing it now → stamp the current toggle)
  if (S.crop.inProgress.length >= 2) {
    S.crop.marks.lines.push({ pts: S.crop.inProgress.slice(), ac: $('crop-autocontrast').checked });
  }
  S.crop.inProgress = [];
  // Snapshot the pending superuser others-deletes NOW: S.crop can be nulled or
  // replaced while the awaits below are in flight (closeCrop / navigation).
  const pendingOthers = new Set(S.crop.pendingOthersDeletes || []);
  // drop ONLY MY old marks for this cell; never touch others' marks.
  S.shaftMarks = S.shaftMarks.filter((m) => !(m.cropId === cell.id && m.labeler === S.me));
  S.lineMarks = S.lineMarks.filter((m) => !(m.cropId === cell.id && m.labeler === S.me));
  // provenance stamped on every mark at save time (camelCase locally, so the
  // GeoJSON export is faithful without a refetch; snake_case in the DB rows).
  // `autocontrast` is per mark — carried from draw time (or the original row on
  // reloaded marks), NOT the toggle state at save. `created` is per mark too:
  // reloaded marks keep their first-save server timestamp (echoed back to the
  // DB below); new marks stay null and pick up the DB's now() after insert.
  const prov = {
    worldBbox: cell.world_bbox,
    crs: S.manifest.crs || null,
    cropPx: S.manifest.crop_px || null,
    tifs: cell.tifs || null,
    cropSha256: cell.crop_sha256 || null,
    buildId: (S.manifest.build && S.manifest.build.build_id) || null,
    project: S.project || null,
  };
  const myShafts = [];
  const myLines = [];
  for (const p of S.crop.marks.points) {
    const [x, y] = pixelToWorld(p.px[0], p.px[1], cell.world_bbox);
    myShafts.push({ cropId: cell.id, pPos: cell.p_pos, world: [x, y], created: p.created || null, dbId: p.dbId ?? null, kind: KIND_SHAFT, labeler: S.me, ...prov, autocontrast: p.ac ?? null });
  }
  for (const ln of S.crop.marks.lines) {
    if (ln.pts.length < 2) continue;
    myLines.push({ cropId: cell.id, pPos: cell.p_pos, world: ln.pts.map(([c, r]) => pixelToWorld(c, r, cell.world_bbox)), created: ln.created || null, dbId: ln.dbId ?? null, kind: KIND_CHANNEL, labeler: S.me, ...prov, autocontrast: ln.ac ?? null });
  }
  S.shaftMarks.push(...myShafts);
  S.lineMarks.push(...myLines);
  recomputeDone();
  refreshFilterUI(); // pool changed -> labeler sets, dropdown, sidebar, tint
  refreshDoneMarks();
  rebuildMineLayer();
  applyLayerToggles();

  // push my marks for this cell to the backend, if configured. RECONCILE, not
  // replace: an untouched mark (its dbId still present server-side) is left
  // completely alone, so its row — id, created_at, updated_at, geom ciphertext,
  // provenance — stays byte-identical across saves. Only rows whose mark was
  // removed get deleted, and only new/stale marks get inserted (stale = a dbId
  // whose row vanished, e.g. after an earlier failed save; those echo their
  // created_at so the original timestamp survives the re-insert).
  if (backendOn()) {
    try {
      setSyncStatus('saving…', '');
      const existing = await fetchMyCellMarks(SUPABASE, S.board, S.me, cell.id, S.project);
      const existingIds = new Set(existing.map((r) => r.id));
      const mine = [...myShafts, ...myLines];
      const keptIds = new Set();
      for (const m of mine) if (m.dbId != null && existingIds.has(m.dbId)) keptIds.add(m.dbId);
      const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
      // same provenance as `prov` above, in the DB's snake_case column names;
      // `autocontrast` comes from each mark, not a shared save-time value.
      const rowProv = {
        world_bbox: cell.world_bbox,
        crs: S.manifest.crs || null,
        crop_px: S.manifest.crop_px || null,
        tifs: cell.tifs || null,
        crop_sha256: cell.crop_sha256 || null,
        build_id: (S.manifest.build && S.manifest.build.build_id) || null,
        p_pos: cell.p_pos,
      };
      // `created_at: undefined` on new marks → column omitted → DB default now().
      const inserts = [];
      for (const m of mine) {
        if (m.dbId != null && existingIds.has(m.dbId)) continue; // untouched — leave its row alone
        inserts.push({ mark: m, row: { kind: m.kind, geom: await encryptGeom(m.world), ...rowProv, autocontrast: m.autocontrast, created_at: m.created || undefined } });
      }
      // writes go through the token-gated RPCs; actor = the gate name.
      const auth = { token: S.writeToken, actor: S.me };
      await deleteMarksByIds(SUPABASE, S.board, S.me, cell.id, toDelete, S.project, auth);
      const inserted = await insertMarks(SUPABASE, S.board, S.me, cell.id, inserts.map((x) => x.row), S.project, auth);
      // tag freshly-inserted marks with their dbId (so the next save skips them)
      // and their server-stamped created_at (so any future re-insert echoes it).
      // Match by geom ciphertext — unique per row (AES-GCM random IV) and stable
      // across the round-trip, unlike array order (inserts may split into
      // several POSTs by key signature).
      const byGeom = new Map(inserts.map((x) => [x.row.geom, x.mark]));
      for (const ins of inserted || []) {
        const m = byGeom.get(ins.geom);
        if (m) { m.dbId = ins.id; m.created = ins.created_at || m.created; }
      }
      // superuser cross-labeler deletes ("Edit others"): committed as an
      // EXPLICIT rpc_delete_marks call — the own-marks reconcile above is
      // scoped to S.me and never touches others' rows. Pool rows are dropped
      // only after the server confirms, so a rejected RPC keeps the ids
      // pending (and the crop dirty) instead of silently losing the intent.
      if (pendingOthers.size) {
        await deleteMarksByIds(SUPABASE, S.board, S.me, cell.id, [...pendingOthers], S.project, auth);
        applyOthersDeletes(cell, pendingOthers);
      }
      S.unsynced = false;
      setSyncStatus('saved', 'ok');
    } catch (e) {
      // keep local, flag unsynced, retry on next save/refresh. Surface the
      // server's rejection reason (e.g. "invalid write token") — a rejected
      // write must read clearly, not silently look like a network blip.
      S.unsynced = true;
      const why = e && e.rpcMessage ? ` (${e.rpcMessage})` : '';
      setSyncStatus(`unsynced — kept locally${why}`, 'unsynced');
    }
  } else if (pendingOthers.size) {
    // localStorage-only mode: no server to confirm — apply the deletes locally.
    applyOthersDeletes(cell, pendingOthers);
  }
  persist();
  // everything the user drew is now in the pool (and, when configured, the DB) —
  // guard on the cell because closeCrop(true) can null/replace S.crop meanwhile.
  if (S.crop && S.crop.cell === cell) S.crop.dirty = false;
  redrawCrop();
}
/** Confirmed cross-labeler deletes: drop the rows from the pool, clear them
 *  from the crop's pending set, and repaint everything the pool drives. */
function applyOthersDeletes(cell, ids) {
  S.shaftMarks = dropPoolMarksByDbId(S.shaftMarks, ids);
  S.lineMarks = dropPoolMarksByDbId(S.lineMarks, ids);
  if (S.crop && S.crop.cell === cell && S.crop.pendingOthersDeletes) {
    for (const id of ids) S.crop.pendingOthersDeletes.delete(id);
  }
  recomputeDone();
  refreshFilterUI();
  refreshDoneMarks();
  rebuildMineLayer();
  applyLayerToggles();
}

// --------------------------------------------------------------------------- //
// download dialog
//
// The button used to emit both files immediately — the ENTIRE pulled pool
// (everyone's marks) under a filename bearing YOUR name. It now opens a dialog
// with three independent axes (crops / marks by / created); the predicate lives
// in exportscope.js so it is unit-testable without a DOM, and the filename +
// an `export_scope` foreign member record what the file actually contains.
// Defaults reproduce the old behaviour exactly.
// --------------------------------------------------------------------------- //
function updateDownloadEnabled() {
  // unchanged rule: no labeler name -> nothing to attribute an export to.
  $('btn-download').disabled = !($('labeler').value.trim());
}
function triggerDownload(obj, fname) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** "this session" boundary: the newest server timestamp present AT UNLOCK. */
function computeSessionSince() {
  let best = '';
  const consider = (m) => {
    const c = (m && m.created) || '';
    if (!c) return;
    if (!best) { best = c; return; }
    const a = Date.parse(c), b = Date.parse(best);
    if (Number.isFinite(a) && Number.isFinite(b)) { if (a > b) best = c; }
    else if (c > best) best = c;     // defensive: unparseable -> string compare
  };
  S.shaftMarks.forEach(consider);
  S.lineMarks.forEach(consider);
  S.sessionSince = best;             // '' (empty pool) => everything is "this session"
}

/** The dialog state as ONE plain object for exportscope.js (which has no DOM). */
function dlScope() {
  return {
    crops: S.dl.crops,
    cellPasses: cellMatchesFilter,   // injected: the very predicate the sidebar uses
    marksBy: S.dl.marksBy,
    me: S.me,
    chosen: S.dl.chosen,
    created: S.dl.created,
    since: S.dl.since,
    sessionSince: S.sessionSince,
  };
}
/**
 * Build exactly what the two files would contain, so the live preview counts
 * FEATURES (lines with < 2 vertices are dropped by the builder) and can never
 * disagree with what lands on disk.
 */
function dlBuild() {
  const scope = dlScope();
  const labeler = $('labeler').value.trim();
  const shafts = buildShaftsFeatureCollection(selectMarks(S.shaftMarks, scope), { labeler });
  const lines = buildLinesFeatureCollection(selectMarks(S.lineMarks, scope), { labeler });
  const slug = scopeSlug(scope);
  const d = ymd(new Date());
  const proj = sanitize(S.project || 'project');
  const tag = sanitize(slug);
  return {
    shafts, lines, scope,
    names: {
      shafts: `qanat_shafts_${proj}_${tag}_${d}.geojson`,
      lines: `qanat_channels_${proj}_${tag}_${d}.geojson`,
    },
  };
}
/** Marks pointing at a cell the manifest no longer has (a rebuild can drop cells). */
function dlOrphanCount() {
  return countOrphans([S.shaftMarks, S.lineMarks], (cid) => S.cellRank.has(cid));
}

// ---- dialog ----------------------------------------------------------------
function dlOpen() {
  if (!($('labeler').value.trim())) { setStatus('enter a labeler name first'); return; }
  // prune labelers who vanished from the pool (project switch / deleted marks)
  const pool = new Set([...S.labelerCells.byLabeler.keys()].filter((n) => n));
  S.dl.chosen = pruneSelection(S.dl.chosen, pool);
  $('dl-me-name').textContent = S.meDisplay || S.me || '—';
  $('dl-since').value = S.dl.since || '';
  for (const [name, val] of [['dl-crops', S.dl.crops], ['dl-marks', S.dl.marksBy], ['dl-created', S.dl.created]]) {
    const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (el) el.checked = true;
  }
  dlRebuildLabelerChecks();
  $('dl-modal').hidden = false;
  dlRefresh();
  $('dl-go').focus();
}
function dlClose() { $('dl-modal').hidden = true; }

/** Checkbox list for "choose…" — same ordering/master-checkbox idiom as Filters. */
function dlRebuildLabelerChecks() {
  const box = $('dl-labelers');
  if (!box) return;
  const pool = new Set([...S.labelerCells.byLabeler.keys()].filter((n) => n));
  const names = labelerOrder(pool, S.me);
  box.innerHTML = '';
  const row = (value, text, checked, role) => {
    const lab = document.createElement('label');
    lab.className = 'dl-chk' + (role ? ' dl-chk-' + role : '');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = checked;
    if (role) inp.dataset.role = role; else inp.dataset.who = value;
    const span = document.createElement('span');
    span.textContent = text;
    lab.appendChild(inp); lab.appendChild(span);
    box.appendChild(lab);
    return inp;
  };
  const allBox = row('', '(all users)', names.length > 0 && S.dl.chosen.size === names.length, 'all');
  allBox.indeterminate = S.dl.chosen.size > 0 && S.dl.chosen.size < names.length;
  if (!names.length) {
    const em = document.createElement('div');
    em.className = 'dl-empty';
    em.textContent = 'nobody has labeled in this project yet';
    box.appendChild(em);
  }
  for (const n of names) row(n, labelerLabel(n), S.dl.chosen.has(n));
  box.querySelectorAll('input[type=checkbox]').forEach((inp) => {
    inp.addEventListener('change', () => {
      if (inp.dataset.role === 'all') S.dl.chosen = inp.checked ? new Set(names) : new Set();
      else if (inp.checked) S.dl.chosen.add(inp.dataset.who);
      else S.dl.chosen.delete(inp.dataset.who);
      dlRebuildLabelerChecks();  // repaint the (all users) tri-state
      dlRefresh();
    });
  });
  box.hidden = S.dl.marksBy !== 'choose';
}

/** Live counts, filenames, guardrails — recomputed on every axis change. */
function dlRefresh() {
  if ($('dl-modal').hidden) return;
  const cnt = $('dl-crops-count');
  if (cnt) {
    const n = filterActive() ? countMatches() : S.cells.length;
    cnt.textContent = `${n} crop${n === 1 ? '' : 's'}`;
  }
  const built = dlBuild();
  const ns = built.shafts.features.length, nl = built.lines.features.length;
  const total = ns + nl;
  const prev = $('dl-preview');
  prev.textContent = `→ ${total} mark${total === 1 ? '' : 's'}  `;
  const split = document.createElement('span');
  split.className = 'dl-split';
  split.textContent = `(${ns} shaft${ns === 1 ? '' : 's'} + ${nl} channel${nl === 1 ? '' : 's'})`;
  prev.appendChild(split);
  $('dl-files').textContent = `${built.names.shafts} · ${built.names.lines}`;
  // orphans: exported under "all", necessarily excluded under "current filter"
  const orph = dlOrphanCount();
  const note = $('dl-note');
  note.hidden = orph === 0;
  if (orph) {
    note.textContent = `${orph} mark${orph === 1 ? '' : 's'} reference a crop that is no longer ` +
      `in the manifest — included under "all", excluded by "current filter".`;
  }
  const problem = scopeProblem(built.scope);
  const why = problem || (total === 0 ? 'nothing matches this selection' : '');
  $('dl-why').hidden = !why;
  $('dl-why').textContent = why;
  $('dl-go').disabled = !!why;
}

function dlDownload() {
  const built = dlBuild();
  const ns = built.shafts.features.length, nl = built.lines.features.length;
  if (scopeProblem(built.scope) || ns + nl === 0) return; // guarded; never emit empty files
  const exportedAt = new Date().toISOString();
  const meta = (featureCount) => buildExportScope(built.scope, {
    project: S.project || null,
    cropCount: filterActive() ? countMatches() : S.cells.length,
    featureCount, exportedAt,
  });
  // foreign member (RFC 7946 §6.1): records the scope without touching any
  // per-feature `properties`, so conformant parsers are unaffected.
  built.shafts.export_scope = meta(ns);
  built.lines.export_scope = meta(nl);
  triggerDownload(built.shafts, built.names.shafts);
  triggerDownload(built.lines, built.names.lines);
  setStatus(`downloaded ${ns + nl} marks (${ns} shafts + ${nl} channels)`);
  dlClose();
}

function setupDownloadDialog() {
  const modal = $('dl-modal');
  modal.addEventListener('click', (e) => { if (e.target === modal) dlClose(); });
  $('dl-cancel').addEventListener('click', dlClose);
  $('dl-go').addEventListener('click', dlDownload);
  document.querySelectorAll('input[name="dl-crops"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) { S.dl.crops = r.value; dlRefresh(); } }));
  document.querySelectorAll('input[name="dl-marks"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      S.dl.marksBy = r.value;
      $('dl-labelers').hidden = r.value !== 'choose';
      dlRefresh();
    }));
  document.querySelectorAll('input[name="dl-created"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) { S.dl.created = r.value; dlRefresh(); } }));
  $('dl-since').addEventListener('input', () => {
    S.dl.since = $('dl-since').value;
    // typing/picking a date is an unambiguous request for that option
    if (S.dl.since && S.dl.created !== 'since') {
      S.dl.created = 'since';
      $('dl-created-since').checked = true;
    }
    dlRefresh();
  });
  // Esc closes. The crop modal's keydown handler bails out while this dialog is
  // open (see setupCropInteractions), so exactly one modal ever reacts.
  document.addEventListener('keydown', (e) => {
    if ($('dl-modal').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); dlClose(); }
  });
}

// --------------------------------------------------------------------------- //
// boot
// --------------------------------------------------------------------------- //
function boot() {
  fillNameDatalist();
  // prefill the gate with the most-recently-remembered name (per-device convenience).
  const names = loadNames();
  if (names.length) $('gate-name').value = names[names.length - 1];
  // project dropdown: alphabetical, select-only, NEVER preselected (a fresh,
  // deliberate choice every login is the anti-mixing guarantee).
  const projSel = $('gate-project');
  for (const p of PROJECTS.slice().sort()) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    projSel.appendChild(o);
  }
  $('unlock').addEventListener('click', unlock);
  $('passcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('gate-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gate-project').focus(); });
  $('gate-project').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('passcode').focus(); });
  $('btn-download').addEventListener('click', dlOpen);
  setupDownloadDialog();
  $('btn-refresh').addEventListener('click', () => { refreshMarks(); });
  // GT-review wiring only exists when the URL opts in (?gtreview=1); in normal
  // mode no listener is attached and every review element stays [hidden].
  if (S.review.on) {
    $('btn-gt-review-dl').addEventListener('click', reviewDownload);
    $('gt-accurate').addEventListener('click', () => { if (S.crop) reviewSetVerdict(S.crop.cell.id, 'accurate'); });
    $('gt-drifted').addEventListener('click', () => { if (S.crop) reviewSetVerdict(S.crop.cell.id, 'drifted'); });
  }
  ['tg-heatmap', 'tg-gt', 'tg-mine', 'tg-acc', 'tg-filter'].forEach((id) => $(id).addEventListener('change', applyLayerToggles));
  // collapsible Filters block (collapsed by default) + its controls
  setFilterOpen(false);
  $('filter-toggle').addEventListener('click', () => setFilterOpen(!S.filter.open));
  $('filter-reset').addEventListener('click', resetFilter);
  setupRankSlider();
  setupSwathPanZoom();
  setupCropInteractions();
  window.addEventListener('resize', () => { if (!$('app').hidden) applySwathTransform(); });
  // never auto-reveal content; the passcode must always be re-entered after a reload.
  $('gate-name').value ? $('passcode').focus() : $('gate-name').focus();
}
boot();
