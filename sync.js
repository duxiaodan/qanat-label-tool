// sync.js — thin Supabase PostgREST client over `fetch` (no SDK, no bundler).
//
// Stores one row per mark in a shared `marks` table so multiple labelers can
// see everyone's progress. Geometry stays encrypted: callers pass/receive the
// already-base64'd AES ciphertext in `geom` — crypto lives in app.js, never here.
//
// READS go straight to PostgREST (`anon` keeps SELECT on public.marks).
// WRITES all go through token-gated security-definer RPCs — anon lost
// INSERT/UPDATE/DELETE on the table (sql/02_write_rpcs.sql):
//   POST /rest/v1/rpc/rpc_insert_marks   {token, actor, rows}    -> inserted rows
//   POST /rest/v1/rpc/rpc_delete_marks   {token, actor, ids}     -> count deleted
//   POST /rest/v1/rpc/rpc_update_mark    {token, actor, mark_id, patch} -> row
// `auth` = {token, actor}: token = sha256_hex('qanat-write-v1'||passcode)
// (deriveWriteToken in crypto.js — computed once at unlock, memory only; which
// passcode was typed decides the role server-side), actor = the gate name.
// Ownership is enforced SERVER-side: a normal token may only touch rows whose
// labeler equals actor; cross-labeler writes need the superuser token.
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
    // PostgREST errors are JSON {code, message, ...} — surface `message` so a
    // rejected write (e.g. "invalid write token") reads clearly in the UI.
    let msg = body;
    try { const j = JSON.parse(body); if (j && j.message) msg = j.message; } catch (e) { /* not JSON */ }
    const err = new Error(`supabase ${what} -> ${r.status} ${msg}`.trim());
    err.status = r.status;
    err.rpcMessage = typeof msg === 'string' ? msg : '';
    throw err;
  }
  return r;
}

/** POST /rest/v1/rpc/<fn> with the anon apikey; returns the parsed JSON body. */
async function _rpc(cfg, fn, args) {
  const r = await fetch(`${_base(cfg)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: _headers(cfg),
    body: JSON.stringify(args),
  });
  await _check(r, fn);
  return r.json();
}

/** Validate the {token, actor} pair every write needs; throws early with a
 * clearer message than the server's "write token required". */
function _auth(auth) {
  if (!auth || !auth.token) throw new Error('no write token (locked site?)');
  if (!auth.actor) throw new Error('no actor for write');
  return auth;
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
export async function fetchAllMarks(cfg, board, project) {
  if (!cfg) return [];
  const url = `${_base(cfg)}/rest/v1/marks?board=eq.${encodeURIComponent(board)}` +
    `&project=eq.${encodeURIComponent(project)}&select=*&order=id.asc`;
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
  // first-save server timestamp; left undefined on new marks → the RPC's
  // coalesce(created_at, now()) applies.
  'created_at',
];

/** The `(board, project, labeler, cell_id)` scope filter shared by the
 * cell-level READS. `project` is part of the scope so that saving a crop in
 * one project can never delete or reconcile away the same user's rows for the
 * same crop in ANOTHER project. */
function _cellScope(board, labeler, cellId, project) {
  return `board=eq.${encodeURIComponent(board)}` +
    `&project=eq.${encodeURIComponent(project)}` +
    `&labeler=eq.${encodeURIComponent(labeler)}` +
    `&cell_id=eq.${encodeURIComponent(cellId)}`;
}

/**
 * GET my current row ids for one (board, labeler, cell_id). Used by the
 * reconcile-on-save flow in app.js: untouched marks (their dbId still present
 * here) are left completely alone — no delete, no re-insert.
 * @returns {Promise<Array<{id:number, kind:string}>>}
 */
export async function fetchMyCellMarks(cfg, board, labeler, cellId, project) {
  if (!cfg) throw new Error('no supabase config');
  const url = `${_base(cfg)}/rest/v1/marks?${_cellScope(board, labeler, cellId, project)}&select=id,kind`;
  const r = await fetch(url, { headers: _headers(cfg), cache: 'no-store' });
  await _check(r, 'fetchMyCellMarks');
  return r.json();
}

/**
 * Delete specific rows by id via rpc_delete_marks. The old direct-table DELETE
 * carried a (board, labeler, cell_id) filter as a belt-and-braces guard; the
 * RPC deletes by id only, but ownership is now enforced server-side — a normal
 * token cannot delete another labeler's rows no matter what ids it sends (the
 * ids themselves still come from the scoped fetchMyCellMarks). No-op on an
 * empty id list.
 * @param {Array<number>} ids
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<number|null>} rows deleted (null on empty no-op)
 */
export async function deleteMarksByIds(cfg, board, labeler, cellId, ids, project, auth) {
  if (!cfg) throw new Error('no supabase config');
  if (!ids || ids.length === 0) return null;
  const { token, actor } = _auth(auth);
  const n = await _rpc(cfg, 'rpc_delete_marks', { token, actor, ids: ids.map(Number) });
  return typeof n === 'number' ? n : Number(n);
}

/**
 * Insert new encrypted rows for one (board, labeler, cell_id) via
 * rpc_insert_marks. Each row should be `{kind, geom}` (+ optional
 * PROVENANCE_ROW_FIELDS, passed through verbatim — dumb pass-through, no
 * crypto here); board/project/labeler/cell_id are filled in.
 *
 * One POST for ALL rows: the RPC takes a jsonb array, so the old PostgREST
 * PGRST102 "all object keys must match" constraint (which forced one POST per
 * key signature) no longer applies — rows with and without created_at ride in
 * the same request, and the server's coalesce(created_at, now()) fills gaps.
 *
 * @param {Array<{kind:string, geom:string}>} rows
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<Array<object>>} the inserted rows (the RPC returns setof marks)
 */
export async function insertMarks(cfg, board, labeler, cellId, rows, project, auth) {
  if (!cfg) throw new Error('no supabase config');
  const payload = (rows || []).map((row) => {
    const out = { board, project, labeler, cell_id: cellId, kind: row.kind, geom: row.geom };
    for (const k of PROVENANCE_ROW_FIELDS) if (row[k] !== undefined) out[k] = row[k];
    return out;
  });
  if (payload.length === 0) return [];
  const { token, actor } = _auth(auth);
  const inserted = await _rpc(cfg, 'rpc_insert_marks', { token, actor, rows: payload });
  return Array.isArray(inserted) ? inserted : [];
}

/**
 * Patch one mark row via rpc_update_mark. `patch` is a plain object of mutable
 * marks columns (kind, geom, provenance, …). A normal token may only update
 * rows whose labeler = actor; a superuser token may cross labelers (the server
 * then stamps `edited_by = actor` on the row).
 * @param {number} markId
 * @param {object} patch
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<object>} the updated row
 */
export async function updateMark(cfg, markId, patch, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token, actor } = _auth(auth);
  return _rpc(cfg, 'rpc_update_mark', { token, actor, mark_id: Number(markId), patch: patch || {} });
}

// --------------------------------------------------------------------------- //
// snapshots (superuser-only RPCs — sql/03_snapshots.sql). The server rejects
// a normal token with "superuser token required"; nothing is enforced here.
// --------------------------------------------------------------------------- //

/**
 * Create a snapshot of every mark row in (board, project) via
 * rpc_create_snapshot.
 * @param {string|null} label  optional human label
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<{id:number, row_count:number, content_sha:string, snap_hash:string}>}
 */
export async function createSnapshot(cfg, board, project, label, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token, actor } = _auth(auth);
  return _rpc(cfg, 'rpc_create_snapshot', {
    token, actor, label: label || null, board, project,
  });
}

/**
 * List snapshot METADATA for (board, project) via rpc_list_snapshots —
 * id, created_at, actor, label, board, project, row_count, content_sha,
 * snap_hash; payload never included. Newest first (the RPC orders by id desc).
 * @param {{token:string, actor:string}} auth (actor unused by this RPC)
 * @returns {Promise<Array<object>>}
 */
export async function listSnapshots(cfg, board, project, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token } = _auth(auth);
  const out = await _rpc(cfg, 'rpc_list_snapshots', { token, board, project });
  return Array.isArray(out) ? out : [];
}

/**
 * Restore a snapshot via rpc_restore_snapshot. The server first auto-creates
 * an 'auto-pre-restore' snapshot of the current scope, then replaces the
 * scoped marks with the payload (one transaction).
 * @param {number} snapshotId
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<{snapshot_id:number, pre_restore_snapshot_id:number, restored_rows:number}>}
 */
export async function restoreSnapshot(cfg, snapshotId, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token, actor } = _auth(auth);
  return _rpc(cfg, 'rpc_restore_snapshot', { token, actor, snapshot_id: Number(snapshotId) });
}

/**
 * One mark's full audit trail via rpc_mark_history (superuser-only): jsonb
 * array of {hid, op, changed_at, actor, via, old_row, new_row}, newest first.
 * old_row/new_row are full marks rows (geom still ciphertext); `via` is the
 * write path that produced the entry ('edit' | 'snapshot_restore' |
 * 'version_restore' | null for direct/legacy writes — sql/05_history_via.sql).
 * @param {number} markId
 * @param {{token:string, actor:string}} auth (actor unused by this RPC)
 * @returns {Promise<Array<object>>}
 */
export async function fetchMarkHistory(cfg, markId, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token } = _auth(auth);
  const out = await _rpc(cfg, 'rpc_mark_history', { token, mark_id: Number(markId) });
  return Array.isArray(out) ? out : [];
}

/**
 * Return one mark to a history entry's STATE via rpc_restore_mark_version
 * (superuser-only, state semantics — sql/06): applies the entry's new_row,
 * i.e. the mark's state AFTER that operation. Updates in place, or re-inserts
 * with the original id if the mark was deleted; DELETE entries (new_row null)
 * are rejected server-side ("restoring a deleted state — delete the mark
 * instead"); INSERT entries are valid targets.
 * @param {number} hid  the history entry id
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<object>} the restored marks row
 */
export async function restoreMarkVersion(cfg, hid, auth) {
  if (!cfg) throw new Error('no supabase config');
  const { token, actor } = _auth(auth);
  return _rpc(cfg, 'rpc_restore_mark_version', { token, actor, hid: Number(hid) });
}

/**
 * Delete ALL my rows for (board, labeler, cell_id). Not used by the normal
 * save path (which reconciles per row — see app.js commitCrop); kept as a
 * utility for admin/cleanup use. Now RPC-backed: reads the scoped ids first,
 * then deletes them via rpc_delete_marks.
 * @param {{url:string, anonKey:string}|null|undefined} cfg
 * @param {{token:string, actor:string}} auth
 * @returns {Promise<number|null>} rows deleted (null when the cell had none)
 */
export async function deleteMyCellMarks(cfg, board, labeler, cellId, project, auth) {
  if (!cfg) throw new Error('no supabase config');
  const existing = await fetchMyCellMarks(cfg, board, labeler, cellId, project);
  return deleteMarksByIds(cfg, board, labeler, cellId, existing.map((r) => r.id), project, auth);
}

// Crop workflow is opt-in at the manifest; shared state remains server-confirmed.
export async function fetchWorkflowStates(cfg, board, project) {
  if (!cfg) throw new Error('workflow requires an online backend');
  const url = `${_base(cfg)}/rest/v1/crop_workflow?board=eq.${encodeURIComponent(board)}&project=eq.${encodeURIComponent(project)}&select=*&order=cell_id.asc`;
  const all = [];
  for (let from=0;;from+=FETCH_PAGE) {
    const r=await fetch(url,{headers:{..._headers(cfg),Range:`${from}-${from+FETCH_PAGE-1}`},cache:'no-store'});
    await _check(r,'fetchWorkflowStates'); const rows=await r.json(); all.push(...rows);
    if (rows.length<FETCH_PAGE) return all;
  }
}
export async function fetchCropView(cfg, board, project, cellId, auth) {
  if (!cfg) throw new Error('workflow requires an online backend');
  const {token}=_auth(auth);
  return _rpc(cfg,'rpc_crop_view',{token,board,project,cell_id:cellId});
}
export async function cropCommand(cfg, command, requestId, auth) {
  if (!cfg) throw new Error('workflow requires an online backend');
  const {token,actor}=_auth(auth);
  return _rpc(cfg,'rpc_crop_command',{token,actor,request_id:requestId,command});
}
export async function fetchCropHistory(cfg, board, project, cellId, auth) {
  if (!cfg) throw new Error('workflow requires an online backend');
  const {token}=_auth(auth); const all=[]; let before_id=null;
  for (;;) {
    const rows=await _rpc(cfg,'rpc_crop_history',{token,board,project,cell_id:cellId,before_id});
    all.push(...rows); if(rows.length<500) return all;
    before_id=rows.at(-1).id;
  }
}
