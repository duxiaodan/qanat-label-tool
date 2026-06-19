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

/**
 * GET all marks for a board. Returns the raw rows (each row's `geom` is still
 * base64 ciphertext — do NOT decrypt here). Returns [] when no backend.
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 * @param {string} board
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllMarks(cfg, board) {
  if (!cfg) return [];
  const url = `${_base(cfg)}/rest/v1/marks?board=eq.${encodeURIComponent(board)}&select=*`;
  const r = await fetch(url, { headers: _headers(cfg), cache: 'no-store' });
  await _check(r, 'fetchAllMarks');
  return r.json();
}

/**
 * Replace *my* rows for one (board, labeler, cell_id): DELETE then POST the new
 * encrypted rows. Others' rows are never touched. Throws when no backend so the
 * caller can keep the local copy + flag "unsynced".
 *
 * Each row in `rows` should already be `{board, labeler, cell_id, kind, geom}`
 * with `geom` = base64( AES ciphertext ). `board`/`labeler`/`cell_id` are filled
 * in here from the arguments if a row omits them, for convenience.
 *
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 * @param {string} board
 * @param {string} labeler
 * @param {string} cellId
 * @param {Array<{kind:string, geom:string}>} rows
 * @returns {Promise<Array<object>>} the inserted rows (PostgREST `return=representation`)
 */
export async function replaceMyCellMarks(cfg, board, labeler, cellId, rows) {
  if (!cfg) throw new Error('no supabase config');
  await deleteMyCellMarks(cfg, board, labeler, cellId);
  const payload = (rows || []).map((row) => ({
    board, labeler, cell_id: cellId, kind: row.kind, geom: row.geom,
  }));
  if (payload.length === 0) return [];
  const url = `${_base(cfg)}/rest/v1/marks`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ..._headers(cfg), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  await _check(r, 'replaceMyCellMarks:insert');
  return r.json();
}

/**
 * DELETE my rows for (board, labeler, cell_id). Throws when no backend.
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 */
export async function deleteMyCellMarks(cfg, board, labeler, cellId) {
  if (!cfg) throw new Error('no supabase config');
  const q = `board=eq.${encodeURIComponent(board)}` +
    `&labeler=eq.${encodeURIComponent(labeler)}` +
    `&cell_id=eq.${encodeURIComponent(cellId)}`;
  const url = `${_base(cfg)}/rest/v1/marks?${q}`;
  const r = await fetch(url, { method: 'DELETE', headers: _headers(cfg) });
  await _check(r, 'deleteMyCellMarks');
  return r;
}
