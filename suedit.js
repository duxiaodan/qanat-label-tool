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
 * After rpc_insert_marks: stamp the server-assigned row id (dbId) and
 * created_at onto EVERY local object describing each inserted mark. Matching
 * is by geom ciphertext — unique per row (AES-GCM random IV) and byte-stable
 * across the round-trip, unlike array order (inserts may split into several
 * POSTs by key signature).
 *
 * Each insert record carries up to TWO object graphs for the same mark:
 *   mark — the pool-shaped object (S.shaftMarks / S.lineMarks), and
 *   src  — the originating crop-modal entry (S.crop.marks.points/lines),
 *          present while the crop that saved is still open.
 * BOTH must learn the new dbId + created. If only the pool object is updated,
 * the still-open crop keeps a dbId-less entry: its History… button stays
 * disabled until the crop is reopened, and a SECOND save of the same open crop
 * re-runs the reconcile on the "new-looking" mark — deleting the fresh row and
 * re-inserting it under a NEW id (identity/history churn, and created_at is
 * not echoed). Mutates in place; unmatched rows are skipped.
 * @param {Array<{mark:object, src?:object|null, row:{geom:string}}>} inserts
 * @param {Array<{id:number, geom:string, created_at?:string}>|null|undefined} inserted
 * @returns {number} count of inserted rows matched back to an insert record
 */
export function backfillInsertedIds(inserts, inserted) {
  const byGeom = new Map((inserts || []).map((x) => [x.row.geom, x]));
  let n = 0;
  for (const ins of inserted || []) {
    const rec = byGeom.get(ins.geom);
    if (!rec) continue;
    for (const t of [rec.mark, rec.src]) {
      if (!t) continue;
      t.dbId = ins.id;
      t.created = ins.created_at || t.created || null;
    }
    n += 1;
  }
  return n;
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
 * Full enablement decision for the crop toolbar's History… button, as one pure
 * function: {enabled, dbId, hint} (hint doubles as the button tooltip).
 *
 * The rule: a SUPERUSER session and exactly one selected mark that exists
 * server-side. Viewing an OWN mark's history is not a cross-labeler edit, so it
 * does NOT require the "Edit others" toggle — only others' marks do (their
 * selections can only exist while the toggle is on anyway; the check here is a
 * defensive backstop). A single own mark WITHOUT a dbId is the freshly-drawn,
 * NEVER-SAVED case — a drag-move keeps the dbId now (own moves commit as
 * identity-preserving UPDATEs on the same row), so only never-saved marks get
 * the "save first" hint instead of the generic one.
 * @param {{su:boolean, editOthers:boolean,
 *          sel:{points:Set<number>, lines:Set<number>,
 *               oPoints:Set<number>, oLines:Set<number>}|null|undefined,
 *          marks:{points:Array, lines:Array}|null|undefined,
 *          others:{points:Array, lines:Array}|null|undefined}} s
 * @returns {{enabled:boolean, dbId:number|null, hint:string}}
 */
export function historyButtonState(s) {
  const off = (hint) => ({ enabled: false, dbId: null, hint });
  const generic = 'select exactly one saved mark';
  if (!s || !s.su || !s.sel || !s.marks || !s.others) return off(generic);
  const own = [];
  for (const i of s.sel.points || []) own.push(s.marks.points[i]);
  for (const i of s.sel.lines || []) own.push(s.marks.lines[i]);
  const oth = [];
  for (const i of s.sel.oPoints || []) oth.push(s.others.points[i]);
  for (const i of s.sel.oLines || []) oth.push(s.others.lines[i]);
  if (own.length + oth.length !== 1) return off(generic);
  const pick = own.length === 1 ? own[0] : oth[0];
  if (!pick) return off(generic);
  if (oth.length === 1 && !s.editOthers) {
    return off("turn on Edit others to view another labeler's mark history");
  }
  const id = pick.dbId;
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    return off('unsaved mark — save first to view its history');
  }
  return { enabled: true, dbId: id, hint: "view this mark's history" };
}

/**
 * Whether a rpc_mark_history entry is a restorable STATE. Under state
 * semantics (sql/06) each entry represents the mark AFTER that operation, so
 * only entries with a new_row (INSERT / UPDATE) are valid targets. DELETE
 * entries have no post-state — the server rejects them ("restoring a deleted
 * state — delete the mark instead"), so the button is disabled client-side too.
 * @param {{new_row?: object|null}} row
 * @returns {boolean}
 */
export function canRestoreHistoryRow(row) {
  return !!(row && row.new_row != null && typeof row.new_row === 'object');
}

/**
 * Same-geometry test between two marks_history row copies (old_row/new_row
 * jsonb objects). `geom` is AES ciphertext, but ciphertext equality is still a
 * faithful one-way signal: identical bytes => identical geometry (rows are
 * copied verbatim through snapshots/restores, never re-encrypted), while a
 * genuinely-moved mark always re-encrypts to different bytes. `kind` is
 * compared too so a defensive kind flip never reads as "no change".
 */
function _sameRowGeom(a, b) {
  return !!(a && b && a.geom != null && a.geom === b.geom && a.kind === b.kind);
}

/**
 * Collapse a mark's rpc_mark_history rows for display.
 *
 * rpc_restore_snapshot deletes + re-inserts EVERY scoped mark, so each
 * restore gives a mark a DELETE+INSERT pair with identical changed_at and
 * via='snapshot_restore'. Shown raw (newest-first), that pair reads as
 * "insert then delete" — alarming for marks the restore didn't even change.
 * This collapses each such pair into ONE synthetic entry.
 *
 * Returns display entries, newest-first (within identical timestamps: hid
 * DESCENDING = reverse transaction order, so even uncollapsed same-instant
 * rows read in true reverse-chronological order). Each entry is either
 *   {kind:'entry', row}                                — a plain history row
 *   {kind:'restore', hid, changed_at, actor, noChange, delRow, insRow}
 * where hid is the INSERT side — under state semantics the collapsed row
 * represents the mark's state AFTER the snapshot restore, and the INSERT
 * side's new_row IS that state, i.e. what "Restore" should bring back —
 * and noChange means the restore left the mark's geometry untouched
 * (Restore button disabled).
 *
 * Pairing requires BOTH sides (same changed_at string, via='snapshot_restore',
 * one DELETE + one INSERT). Asymmetric leftovers — e.g. a mark created after
 * the snapshot gets only a DELETE from the restore, one deleted after the
 * snapshot gets only an INSERT — are NOT collapsed and pass through as plain
 * entries.
 * @param {Array<{hid:number, op:string, changed_at:string, actor?:string,
 *                via?:string|null, old_row?:object|null, new_row?:object|null}>} rows
 * @returns {Array<object>}
 */
export function collapseHistoryRows(rows) {
  const list = (rows || []).filter((r) => r && typeof r === 'object').slice();
  list.sort((a, b) => {
    const ta = Date.parse(a.changed_at || '');
    const tb = Date.parse(b.changed_at || '');
    // Date.parse drops sub-ms precision; exact-equal parses (incl. both NaN)
    // fall through to hid, which IS transaction order at full precision.
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return (b.hid || 0) - (a.hid || 0);
  });
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ins = list[i];
    const del = list[i + 1];
    if (del
        && ins.via === 'snapshot_restore' && del.via === 'snapshot_restore'
        && ins.op === 'INSERT' && del.op === 'DELETE'
        && ins.changed_at != null && ins.changed_at === del.changed_at) {
      out.push({
        kind: 'restore',
        hid: ins.hid,
        changed_at: del.changed_at,
        actor: del.actor || ins.actor || '',
        noChange: _sameRowGeom(del.old_row, ins.new_row),
        delRow: del,
        insRow: ins,
      });
      i++; // the DELETE side is consumed by the pair
      continue;
    }
    out.push({ kind: 'entry', row: ins });
  }
  return out;
}

/**
 * Display label for an UNCOLLAPSED history row. Version restores read as a
 * restore ("↺ version restore"); an asymmetric snapshot-restore leftover keeps
 * its op but says where it came from; everything else ('edit' / NULL / legacy)
 * keeps the plain op label.
 * @param {{op?:string, via?:string|null}|null|undefined} row
 * @returns {string}
 */
export function historyOpLabel(row) {
  const op = (row && row.op) || '?';
  if (row && row.via === 'version_restore') return '↺ version restore';
  if (row && row.via === 'snapshot_restore') return `${op} (snapshot restore)`;
  return op;
}

/**
 * Per-row Restore button decision for the history panel, under STATE
 * semantics: every displayed row is a state the mark has been in, and Restore
 * returns the mark to that state.
 *
 *   * the NEWEST displayed row IS the current state -> disabled ("current");
 *   * a collapsed snapshot-restore row restores the POST-restore state (the
 *     INSERT side's new_row — `en.hid` is already wired to it by
 *     collapseHistoryRows), disabled when the restore changed nothing;
 *   * a DELETE row has no post-state -> disabled (an unpaired lone DELETE
 *     from a snapshot restore falls under this rule too);
 *   * INSERT / UPDATE rows are valid targets (an INSERT's new_row is the
 *     mark's first state).
 *
 * @param {object|null|undefined} en   one collapseHistoryRows display entry
 * @param {boolean} isNewest           is this the first (newest) entry?
 * @returns {{enabled:boolean, hid:number|null, hint:string}}
 */
export function historyRestoreState(en, isNewest) {
  const off = (hint) => ({ enabled: false, hid: null, hint });
  if (!en) return off('');
  if (isNewest) return off('current state — the mark is already here');
  if (en.kind === 'restore') {
    if (en.noChange) return off('no change — this restore left the mark as it was');
    return { enabled: true, hid: en.hid, hint: 'return the mark to its state after this restore' };
  }
  const r = en.row;
  if (!canRestoreHistoryRow(r)) {
    return off('a DELETE has no state to restore — delete the mark instead');
  }
  return { enabled: true, hid: r.hid, hint: 'return the mark to its state after this operation' };
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
 * User-facing identity of a snapshot in messages/confirms: the same 7-char
 * short hash the list rows lead with. ONLY a hashless snapshot (pre-migration
 * degenerate case — the row the list shows as "—") falls back to `#<id>` so a
 * message is never empty; with neither hash nor id it degrades to '—'.
 * Internal RPC calls keep using the numeric id — this is display-only.
 * @param {string|null|undefined} hash  full snap_hash (or already-short form)
 * @param {number|null|undefined} id    numeric snapshot id (fallback only)
 * @returns {string}
 */
export function snapIdent(hash, id) {
  const h = shortHash(hash);
  if (h) return h;
  return (id === null || id === undefined) ? '—' : `#${id}`;
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
 * in-progress polyline, pending others-edits (deletes AND drag-moves), OR
 * pending OWN drag-moves (a saved own mark moved but not yet committed via
 * rpc_update_mark) all make the crop dirty (and therefore guarded by the
 * 3-way save/discard/cancel prompt on nav/close).
 * @param {{dirty?: boolean, inProgressLen?: number, pendingOthers?: number,
 *          pendingMoves?: number, pendingOwnMoves?: number}} s
 * @returns {boolean}
 */
export function cropDirtyState(s) {
  if (!s) return false;
  return s.dirty === true || (s.inProgressLen || 0) > 0
    || (s.pendingOthers || 0) > 0 || (s.pendingMoves || 0) > 0
    || (s.pendingOwnMoves || 0) > 0;
}
