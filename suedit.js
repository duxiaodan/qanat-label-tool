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
 * The crop-level dirty test, as one pure decision: unsaved own-mark edits, an
 * in-progress polyline, OR pending others-edits all make the crop dirty (and
 * therefore guarded by the 3-way save/discard/cancel prompt on nav/close).
 * @param {{dirty?: boolean, inProgressLen?: number, pendingOthers?: number}} s
 * @returns {boolean}
 */
export function cropDirtyState(s) {
  if (!s) return false;
  return s.dirty === true || (s.inProgressLen || 0) > 0 || (s.pendingOthers || 0) > 0;
}
