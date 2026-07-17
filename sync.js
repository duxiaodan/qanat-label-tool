// sync.js — thin Supabase PostgREST client over `fetch` (no SDK, no bundler).
//
// Stores one row per mark in a shared `marks` table so multiple labelers can
// see everyone's progress. Geometry stays encrypted: callers pass/receive the
// already-base64'd AES ciphertext in `geom` — crypto lives in app.js, never here.
//
// Every function is a clean no-op / throw when `cfg` is falsy, so app.js can
// branch on "no backend configured" and fall back to localStorage-only.
//
// Pure ES module: uses only `fetch` (browser + Node >= 18). No DOM.

/** Build the PostgREST auth/content headers from a {url, anonKey} config. */
function _headers(cfg) {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    'Content-Type': 'application/json',
  };
}

/** Trim a trailing slash so we can concatenate `/rest/v1/...` safely. */
function _base(cfg) {
  return String(cfg.url || '').replace(/\/+$/, '');
}

async function _check(r, what) {
  if (!r.ok) {
    let body = '';
    try { body = await r.text(); } catch (e) { /* ignore */ }
    throw new Error(`supabase ${what} -> ${r.status} ${body}`.trim());
  }
  return r;
}

/** Page size for fetchAllMarks. Supabase caps every REST response at its
 * "Max rows" setting (default 1000) SILENTLY, so a single un-ranged GET would
 * quietly truncate once the pool grows past it. Must not exceed that cap. */
const FETCH_PAGE = 1000;

/**
 * GET all marks for a board, paginated (Range headers, FETCH_PAGE rows per
 * request, stable id order) so the pool is complete at any size. Returns the
 * raw rows (each row's `geom` is still base64 ciphertext — do NOT decrypt
 * here). Returns [] when no backend.
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 * @param {string} board
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllMarks(cfg, board) {
  if (!cfg) return [];
  const url = `${_base(cfg)}/rest/v1/marks?board=eq.${encodeURIComponent(board)}&select=*&order=id.asc`;
  const rows = [];
  for (let from = 0; ; from += FETCH_PAGE) {
    const r = await fetch(url, {
      headers: { ..._headers(cfg), Range: `${from}-${from + FETCH_PAGE - 1}` },
      cache: 'no-store',
    });
    await _check(r, 'fetchAllMarks');
    const page = await r.json();
    rows.push(...page);
    if (page.length < FETCH_PAGE) return rows;
  }
}

/** Optional per-row plaintext provenance columns, passed through when present. */
const PROVENANCE_ROW_FIELDS = [
  'world_bbox', 'crs', 'crop_px', 'tifs', 'crop_sha256', 'build_id', 'p_pos', 'autocontrast',
  // created_at: echoed back on re-saves so a re-inserted mark keeps its
  // first-save server timestamp; left undefined on new marks → DB default now().
  'created_at',
];

/** The `(board, labeler, cell_id)` scope filter shared by the cell-level calls. */
function _cellScope(board, labeler, cellId) {
  return `board=eq.${encodeURIComponent(board)}` +
    `&labeler=eq.${encodeURIComponent(labeler)}` +
    `&cell_id=eq.${encodeURIComponent(cellId)}`;
}

/**
 * GET my current row ids for one (board, labeler, cell_id). Used by the
 * reconcile-on-save flow in app.js: untouched marks (their dbId still present
 * here) are left completely alone — no delete, no re-insert.
 * @returns {Promise<Array<{id:number, kind:string}>>}
 */
export async function fetchMyCellMarks(cfg, board, labeler, cellId) {
  if (!cfg) throw new Error('no supabase config');
  const url = `${_base(cfg)}/rest/v1/marks?${_cellScope(board, labeler, cellId)}&select=id,kind`;
  const r = await fetch(url, { headers: _headers(cfg), cache: 'no-store' });
  await _check(r, 'fetchMyCellMarks');
  return r.json();
}

/**
 * DELETE specific rows by id, still scoped to (board, labeler, cell_id) as a
 * belt-and-braces guard so a buggy id list can never touch another labeler's
 * (or cell's) rows. No-op on an empty id list.
 * @param {Array<number>} ids
 */
export async function deleteMarksByIds(cfg, board, labeler, cellId, ids) {
  if (!cfg) throw new Error('no supabase config');
  if (!ids || ids.length === 0) return null;
  const q = `${_cellScope(board, labeler, cellId)}&id=in.(${ids.map(Number).join(',')})`;
  const url = `${_base(cfg)}/rest/v1/marks?${q}`;
  const r = await fetch(url, { method: 'DELETE', headers: _headers(cfg) });
  await _check(r, 'deleteMarksByIds');
  return r;
}

/**
 * POST new encrypted rows for one (board, labeler, cell_id). Each row should be
 * `{kind, geom}` (+ optional PROVENANCE_ROW_FIELDS, passed through verbatim —
 * dumb pass-through, no crypto here); board/labeler/cell_id are filled in.
 *
 * PostgREST bulk inserts reject arrays whose objects have differing key sets
 * (PGRST102 "All object keys must match", and this deployment lacks
 * `missing=default`). Rows legitimately differ: re-inserted marks echo their
 * created_at while new marks omit it so the DB default now() applies. So
 * POST one request per distinct key signature.
 *
 * @param {Array<{kind:string, geom:string}>} rows
 * @returns {Promise<Array<object>>} the inserted rows (PostgREST `return=representation`)
 */
export async function insertMarks(cfg, board, labeler, cellId, rows) {
  if (!cfg) throw new Error('no supabase config');
  const payload = (rows || []).map((row) => {
    const out = { board, labeler, cell_id: cellId, kind: row.kind, geom: row.geom };
    for (const k of PROVENANCE_ROW_FIELDS) if (row[k] !== undefined) out[k] = row[k];
    return out;
  });
  if (payload.length === 0) return [];
  const groups = new Map();
  for (const row of payload) {
    const sig = Object.keys(row).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(row);
  }
  const url = `${_base(cfg)}/rest/v1/marks`;
  const inserted = [];
  for (const rows_ of groups.values()) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ..._headers(cfg), Prefer: 'return=representation' },
      body: JSON.stringify(rows_),
    });
    await _check(r, 'insertMarks');
    inserted.push(...await r.json());
  }
  return inserted;
}

/**
 * DELETE ALL my rows for (board, labeler, cell_id). Not used by the normal
 * save path (which reconciles per row — see app.js commitCrop); kept as a
 * utility for admin/cleanup use.
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 */
export async function deleteMyCellMarks(cfg, board, labeler, cellId) {
  if (!cfg) throw new Error('no supabase config');
  const url = `${_base(cfg)}/rest/v1/marks?${_cellScope(board, labeler, cellId)}`;
  const r = await fetch(url, { method: 'DELETE', headers: _headers(cfg) });
  await _check(r, 'deleteMyCellMarks');
  return r;
}
