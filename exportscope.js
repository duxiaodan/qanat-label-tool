// exportscope.js — pure logic for the "Download GeoJSON" dialog.
//
// The download used to be one-shot: it dumped the ENTIRE pulled pool (everyone's
// marks) under a filename bearing YOUR name. The dialog replaces that with three
// INDEPENDENT axes, ANDed into a single MARK-level predicate:
//
//   1. CROPS      'all' | 'filter'   — restrict to cells passing the sidebar
//                                      filter (injected as `cellPasses`, so this
//                                      module never touches app state or a DOM).
//   2. MARKS BY   'everyone' | 'me' | 'choose'
//   3. CREATED    'any' | 'session' | 'since'
//
// Defaults ('all' × 'everyone' × 'any') reproduce the old button exactly — every
// mark in the pool — so "open the dialog, hit Download" is a no-op change.
//
// TIME IS THE SUBTLE PART. `mark.created` is a SERVER timestamp; the browser
// clock can be minutes off, so "this session" must NOT be derived from the
// client clock. The app records `S.sessionSince` = max(created) over the pool at
// unlock, and "this session" is `created > sessionSince` — a pure server-vs-server
// comparison. 'since <date>' does compare against a client-derived cutoff, but at
// LOCAL-MIDNIGHT (day) granularity, where a few minutes of skew is immaterial.
//
// Browser + node safe: no DOM, no globals beyond Date/Map/Set.

/** Sanitizer for one filename component (mirrors app.js `sanitize`). */
function slugPart(s) {
  return (s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** ms since epoch, or NaN when absent/unparseable. */
export function parseTs(s) {
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 'YYYY-MM-DD' (an <input type=date> value) -> LOCAL midnight, or NaN.
 * Deliberately not `Date.parse`, which reads a bare date as UTC and would shift
 * the cutoff by up to a day for users west/east of Greenwich.
 */
export function localMidnight(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
}

/**
 * The CREATED axis.
 * A mark with an empty/unparseable `created` passes ONLY 'any time' — it is
 * never silently swept into a time-bounded export.
 */
export function createdPasses(created, scope) {
  const s = scope || {};
  const mode = s.created || 'any';
  if (mode === 'any') return true;
  const ts = parseTs(created);
  if (!Number.isFinite(ts)) return false; // unknown age -> excluded
  if (mode === 'session') {
    const since = s.sessionSince || '';
    if (!since) return true;              // empty pool at unlock -> everything is new
    const sinceTs = parseTs(since);
    // ISO-8601 strings of one format also compare correctly as strings; that is
    // only the fallback for a stamp Date.parse cannot read.
    if (Number.isFinite(sinceTs)) return ts > sinceTs;
    return String(created) > String(since);
  }
  if (mode === 'since') {
    const cut = localMidnight(s.since);
    if (!Number.isFinite(cut)) return false; // no date picked -> nothing qualifies
    return ts >= cut;
  }
  return true;
}

/** The MARKS BY axis (`labeler` is already normalized on pulled marks). */
export function marksByPasses(labeler, scope) {
  const s = scope || {};
  const mode = s.marksBy || 'everyone';
  if (mode === 'everyone') return true;
  if (mode === 'me') return (labeler || '') === (s.me || '');
  if (mode === 'choose') {
    const chosen = s.chosen instanceof Set ? s.chosen : new Set(s.chosen || []);
    return chosen.has(labeler || '');
  }
  return true;
}

/**
 * The CROPS axis. `scope.cellPasses(cropId)` is injected by the caller (the app
 * passes `cellMatchesFilter`). A MISSING predicate falls back to "passes", so a
 * wiring mistake can never silently drop data.
 *
 * ORPHANS: marks whose cropId is absent from the manifest (a rebuild can drop
 * cells) have no rank, so `cellPasses` rejects them — correct under 'filter'.
 * Under 'all' they are exported like any other mark; losing them would be data
 * loss with no way back.
 */
export function cropPasses(cropId, scope) {
  const s = scope || {};
  if ((s.crops || 'all') !== 'filter') return true;
  return typeof s.cellPasses === 'function' ? !!s.cellPasses(cropId) : true;
}

/** The three axes ANDed — the single predicate behind the preview AND the export. */
export function markPasses(mark, scope) {
  if (!mark) return false;
  return cropPasses(mark.cropId, scope) &&
    marksByPasses(mark.labeler, scope) &&
    createdPasses(mark.created, scope);
}

/** Filter an array of marks with `markPasses` (order preserved). */
export function selectMarks(marks, scope) {
  return (marks || []).filter((m) => markPasses(m, scope));
}

/** True when every axis sits at its default (i.e. the whole pool). */
export function scopeIsDefault(scope) {
  const s = scope || {};
  return (s.crops || 'all') === 'all' &&
    (s.marksBy || 'everyone') === 'everyone' &&
    (s.created || 'any') === 'any';
}

/**
 * A reason the current selection cannot be exported, or '' when it is usable.
 * Distinct from "0 features": these are UNANSWERED questions, not empty results.
 */
export function scopeProblem(scope) {
  const s = scope || {};
  if ((s.marksBy || 'everyone') === 'choose') {
    const chosen = s.chosen instanceof Set ? s.chosen : new Set(s.chosen || []);
    if (chosen.size === 0) return 'pick at least one labeler';
  }
  if ((s.created || 'any') === 'since' && !Number.isFinite(localMidnight(s.since))) {
    return 'pick a date';
  }
  return '';
}

/**
 * Filename component describing the non-default axes, so a received file is
 * self-describing: 'all', 'mine', 'filtered', 'mine_filtered', 'mine_session',
 * 'alice_since20260701'. Order is marks-by, crops, created.
 */
export function scopeSlug(scope) {
  const s = scope || {};
  const parts = [];
  const by = s.marksBy || 'everyone';
  if (by === 'me') parts.push('mine');
  else if (by === 'choose') {
    const chosen = [...(s.chosen instanceof Set ? s.chosen : new Set(s.chosen || []))];
    if (chosen.length === 1) parts.push(slugPart(chosen[0]) || 'user');
    else if (chosen.length > 1) parts.push(`${chosen.length}users`);
  }
  if ((s.crops || 'all') === 'filter') parts.push('filtered');
  const when = s.created || 'any';
  if (when === 'session') parts.push('session');
  else if (when === 'since') {
    const d = String(s.since || '').replace(/-/g, '');
    parts.push(d ? `since${d}` : 'since');
  }
  return parts.length ? parts.join('_') : 'all';
}

/** How many marks reference a cell the manifest no longer has. */
export function countOrphans(markLists, hasCell) {
  const has = typeof hasCell === 'function' ? hasCell : () => true;
  let n = 0;
  for (const list of markLists || []) {
    for (const m of list || []) if (!has(m && m.cropId)) n++;
  }
  return n;
}

/**
 * The `export_scope` FOREIGN MEMBER stamped on each FeatureCollection. Foreign
 * members are legal GeoJSON (RFC 7946 §6.1) and ignored by conformant parsers,
 * so QGIS et al. are unaffected while the file still records what it contains.
 * Per-feature properties are untouched.
 */
export function buildExportScope(scope, ctx) {
  const s = scope || {};
  const c = ctx || {};
  const by = s.marksBy || 'everyone';
  const chosen = [...(s.chosen instanceof Set ? s.chosen : new Set(s.chosen || []))].sort();
  const when = s.created || 'any';
  let cutoff = null;
  if (when === 'session') cutoff = s.sessionSince || null;
  else if (when === 'since') {
    const t = localMidnight(s.since);
    cutoff = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return {
    project: c.project ?? null,
    crops: {
      mode: (s.crops || 'all') === 'filter' ? 'current_filter' : 'all',
      cells: c.cropCount ?? null,
    },
    marks_by: {
      mode: by,
      names: by === 'everyone' ? null : (by === 'me' ? [s.me || ''] : chosen),
    },
    created: { mode: when, cutoff },
    slug: scopeSlug(s),
    exported_at: c.exportedAt || new Date().toISOString(),
    feature_count: c.featureCount ?? null,
    source: 'web_label_tool',
  };
}
