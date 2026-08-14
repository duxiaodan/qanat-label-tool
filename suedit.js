// suedit.js — pure decision logic for the superuser "Edit others" tools.
//
// The superuser crop view can select and delete OTHER labelers' marks. Those
// edits are NOT part of the own-marks reconcile in commitCrop (which is scoped
// to S.me's rows); they are tracked in a separate pending-set of row ids and
// committed as explicit rpc_delete_marks / rpc_update_mark calls. The helpers
// here decide what enters that pending-set, how the crop's others-list is
// pruned while deletes are pending, when a crop counts as dirty, and how a
// mark's attribution line reads once a superuser has edited it.
//
// Browser + node safe: no DOM, no fetch — everything here is unit-testable.

/**
 * Attribution line for a mark's hover tooltip. A mark always belongs to its
 * `labeler` (superuser edits NEVER reassign ownership — the server stamps
 * `edited_by` instead), so an edited mark reads "Alice · edited by Bob".
 * A self-edit (edited_by === labeler) or an unedited mark is just the owner.
 * @param {string} labeler   the owning labeler (may be '')
 * @param {string|null|undefined} editedBy  marks.edited_by
 * @returns {string}
 */
export function attribution(labeler, editedBy) {
  const who = labeler || '';
  const ed = editedBy || '';
  if (!ed || ed === who) return who;
  return `${who} · edited by ${ed}`;
}

/**
 * The row ids a batch of others' marks contributes to the pending delete-set.
 * Only marks that exist server-side (numeric dbId) can be deleted via RPC;
 * anything without a dbId is silently dropped (others' marks always come from
 * the DB, so this is a guard, not a path).
 * @param {Array<{dbId?: number|null}>} marks
 * @returns {Array<number>}
 */
export function othersDeleteIds(marks) {
  const ids = [];
  for (const m of marks || []) {
    const id = m && m.dbId;
    if (typeof id === 'number' && Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

/**
 * Prune a list of others' marks against the pending delete-set, so a
 * mid-session refresh (which re-pulls the pool, where the rows still exist)
 * cannot resurrect a mark the superuser already deleted but hasn't saved yet.
 * @param {Array<{dbId?: number|null}>} marks
 * @param {Set<number>} pendingIds
 * @returns {Array} marks not pending deletion
 */
export function pruneOthers(marks, pendingIds) {
  if (!pendingIds || pendingIds.size === 0) return (marks || []).slice();
  return (marks || []).filter((m) => !(m && m.dbId != null && pendingIds.has(m.dbId)));
}

/**
 * Remove pool marks whose dbId is in `ids` (post-commit cleanup after the
 * server confirmed a cross-labeler delete). Marks without a dbId are kept.
 * @param {Array<{dbId?: number|null}>} pool
 * @param {Set<number>} ids
 * @returns {Array} the surviving pool marks
 */
export function dropPoolMarksByDbId(pool, ids) {
  if (!ids || ids.size === 0) return (pool || []).slice();
  return (pool || []).filter((m) => !(m && m.dbId != null && ids.has(m.dbId)));
}

/**
 * Merge one drag-move into the pending others-moves map (dbId -> geometry
 * entry, {kind:'point', px:[c,r]} or {kind:'line', pts:[[c,r]..]}). LAST MOVE
 * WINS: moving the same mark again simply replaces its entry. Only marks that
 * exist server-side (finite numeric dbId) can be patched via rpc_update_mark;
 * anything else leaves the map unchanged. Returns a NEW Map.
 * @param {Map<number, object>|null|undefined} moves
 * @param {number|null|undefined} dbId
 * @param {object} entry
 * @returns {Map<number, object>}
 */
export function mergePendingMove(moves, dbId, entry) {
  const out = new Map(moves || []);
  if (typeof dbId === 'number' && Number.isFinite(dbId) && entry) out.set(dbId, entry);
  return out;
}

/**
 * Drop pending moves for marks that are now pending DELETION (delete wins:
 * a deleted mark's move is meaningless — the row is going away). Also the
 * post-commit cleanup once a move is confirmed. Returns a NEW Map.
 * @param {Map<number, object>|null|undefined} moves
 * @param {Iterable<number>} ids
 * @returns {Map<number, object>}
 */
export function dropMovesForIds(moves, ids) {
  const out = new Map(moves || []);
  for (const id of ids || []) out.delete(id);
  return out;
}

/**
 * Re-apply pending (unsaved) moves over a freshly reloaded others-list, so a
 * mid-session refresh (which re-pulls the pool, where the rows still hold the
 * OLD geometry) cannot visually snap a moved-but-unsaved mark back. Marks are
 * matched by dbId; a kind mismatch (defensive) leaves the mark untouched.
 * @param {Array<{dbId?:number|null, px?:Array, pts?:Array}>} marks
 * @param {Map<number, {kind:string, px?:Array, pts?:Array}>|null|undefined} moves
 * @returns {Array} marks with pending geometry substituted (fresh arrays)
 */
export function applyPendingMoves(marks, moves) {
  if (!moves || moves.size === 0) return (marks || []).slice();
  return (marks || []).map((m) => {
    if (!m || m.dbId == null || !moves.has(m.dbId)) return m;
    const mv = moves.get(m.dbId);
    if (mv && mv.kind === 'point' && m.px && mv.px) return { ...m, px: [mv.px[0], mv.px[1]] };
    if (mv && mv.kind === 'line' && m.pts && mv.pts) return { ...m, pts: mv.pts.map((p) => [p[0], p[1]]) };
    return m;
  });
}

/**
 * Patch pool marks by db row id (post-commit: the server confirmed an update,
 * e.g. {world, editedBy} after a cross-labeler move). Marks without a dbId or
 * not in the map are returned as-is; patched marks are fresh objects.
 * @param {Array<{dbId?:number|null}>} pool
 * @param {Map<number, object>|null|undefined} byId  dbId -> partial mark patch
 * @returns {Array}
 */
export function patchPoolMarksByDbId(pool, byId) {
  if (!byId || byId.size === 0) return (pool || []).slice();
  return (pool || []).map((m) => (
    (m && m.dbId != null && byId.has(m.dbId)) ? { ...m, ...byId.get(m.dbId) } : m
  ));
}

/**
 * The db row id behind the crop's selection, IFF exactly one mark is selected
 * (own or others') and that mark exists server-side. This is the enablement
 * rule for the History… button: history is per-row, so a multi-selection or a
 * never-saved mark (no dbId yet) has nothing to show.
 * @param {{points:Set<number>, lines:Set<number>, oPoints:Set<number>, oLines:Set<number>}} sel
 * @param {{points:Array, lines:Array}} marks   own marks ({dbId} entries)
 * @param {{points:Array, lines:Array}} others  others' marks ({dbId} entries)
 * @returns {number|null}
 */
export function singleSelectionDbId(sel, marks, others) {
  if (!sel || !marks || !others) return null;
  const picks = [];
  for (const i of sel.points || []) picks.push(marks.points[i]);
  for (const i of sel.lines || []) picks.push(marks.lines[i]);
  for (const i of sel.oPoints || []) picks.push(others.points[i]);
  for (const i of sel.oLines || []) picks.push(others.lines[i]);
  if (picks.length !== 1 || !picks[0]) return null;
  const id = picks[0].dbId;
  return (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

/**
 * Whether a rpc_mark_history entry can be rolled back to: only entries with an
 * old_row (UPDATE / DELETE). INSERT entries have no previous version — the
 * server rejects them, so the button is disabled client-side too.
 * @param {{old_row?: object|null}} row
 * @returns {boolean}
 */
export function canRestoreHistoryRow(row) {
  return !!(row && row.old_row != null && typeof row.old_row === 'object');
}

/**
 * 7-char git-style display form of a stored full-length hash. Empty string
 * for anything that isn't a string (missing hash on a pre-migration row).
 * @param {string|null|undefined} h
 * @returns {string}
 */
export function shortHash(h) {
  return (typeof h === 'string') ? h.slice(0, 7) : '';
}

/**
 * Duplicate-content badges for the snapshots dialog. Rows come from
 * rpc_list_snapshots in ANY order (the RPC sends newest-first); duplication is
 * resolved globally against the EARLIEST snapshot (lowest id — ids are
 * monotonic with creation) holding each content_sha. Every later row with the
 * same content_sha gets a badge pointing at that earliest row's snap_hash —
 * including content that changed and later returned. The earliest occurrence
 * itself gets no badge. Rows without an id or content_sha (pre-migration,
 * defensive) neither anchor nor receive badges.
 * @param {Array<{id?:number, content_sha?:string, snap_hash?:string}>} rows
 * @returns {Map<number, string>} row id -> the earliest same-content row's
 *   FULL snap_hash (callers shorten for display)
 */
export function snapshotDupBadges(rows) {
  const usable = (rows || []).filter((r) => r && r.id != null && r.content_sha);
  usable.sort((a, b) => a.id - b.id);
  const earliest = new Map(); // content_sha -> earliest row
  const out = new Map();      // later row id -> earliest row's snap_hash
  for (const r of usable) {
    const first = earliest.get(r.content_sha);
    if (first === undefined) earliest.set(r.content_sha, r);
    else out.set(r.id, first.snap_hash || '');
  }
  return out;
}

/**
 * The crop-level dirty test, as one pure decision: unsaved own-mark edits, an
 * in-progress polyline, OR pending others-edits (deletes AND drag-moves) all
 * make the crop dirty (and therefore guarded by the 3-way save/discard/cancel
 * prompt on nav/close).
 * @param {{dirty?: boolean, inProgressLen?: number, pendingOthers?: number,
 *          pendingMoves?: number}} s
 * @returns {boolean}
 */
export function cropDirtyState(s) {
  if (!s) return false;
  return s.dirty === true || (s.inProgressLen || 0) > 0
    || (s.pendingOthers || 0) > 0 || (s.pendingMoves || 0) > 0;
}
