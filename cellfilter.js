// cellfilter.js — pure logic for the sidebar/map cell filter.
//
// The filter has TWO independent conditions, combined with AND:
//
//   1. p_pos RANGE, expressed over RANK (an index into the p_pos-DESCENDING
//      cell array), not over the value. The measured p_pos distribution is
//      extremely skewed (median 0.084; 42% of cells below 0.05; a second small
//      peak above 0.95), so a linear 0..1 value slider would spend half its
//      travel on nothing and drop 2000+ cells in a single pixel of motion.
//      Over rank the control is uniform by construction, and because the array
//      is already sorted the selection is a contiguous slice -> O(1) test.
//   2. "labeled by…", a UNION over any number of checked labelers, plus a
//      mutually-exclusive "(unlabeled)" pseudo-entry. NOTHING checked means the
//      condition is INACTIVE (every cell passes) — never "show zero cells".
//
// Browser + node safe: no DOM, no globals beyond Map/Set/Math.

/** Inclusive at both ends. `rank` outside [0, ...] (unknown cell) never passes. */
export function rankInRange(rank, lo, hi) {
  if (!Number.isFinite(rank) || rank < 0) return false;
  return rank >= lo && rank <= hi;
}

/**
 * The "labeled by…" half of the predicate.
 * @param {string} cid            cell id
 * @param {Set<string>} checked   normalized labeler names that are checked
 * @param {boolean} unlabeledOnly "(unlabeled)" is selected (excludes `checked`)
 * @param {{byLabeler: Map<string, Set<string>>, any: Set<string>}} labelerCells
 */
export function labelerPasses(cid, checked, unlabeledOnly, labelerCells) {
  const any = (labelerCells && labelerCells.any) || EMPTY_SET;
  if (unlabeledOnly) return !any.has(cid);
  if (!checked || checked.size === 0) return true; // condition inactive
  const byLabeler = (labelerCells && labelerCells.byLabeler) || EMPTY_MAP;
  for (const who of checked) {
    const s = byLabeler.get(who);
    if (s && s.has(cid)) return true; // union: ANY checked labeler is enough
  }
  return false;
}

/** rank-range AND labeler condition — the single predicate for list + map. */
export function cellPasses(cid, rank, opts) {
  const o = opts || {};
  return rankInRange(rank, o.lo, o.hi) &&
    labelerPasses(cid, o.checked, o.unlabeledOnly, o.labelerCells);
}

/** True when at least one condition actually narrows the 0..maxRank universe. */
export function filterIsActive(opts, maxRank) {
  const o = opts || {};
  if (o.unlabeledOnly) return true;
  if (o.checked && o.checked.size > 0) return true;
  return o.lo > 0 || o.hi < maxRank;
}

/**
 * Drop checked labelers that no longer exist in the pool (project switch, a
 * refresh that removed someone's last mark) — silently, per the old dropdown's
 * stale-selection hygiene. Returns a NEW Set.
 */
export function pruneSelection(checked, poolNames) {
  const pool = poolNames instanceof Set ? poolNames : new Set(poolNames || []);
  const out = new Set();
  for (const n of checked || []) if (pool.has(n)) out.add(n);
  return out;
}

/** Checkbox-list order: me first (when present in the pool), then the rest A-Z. */
export function labelerOrder(names, me) {
  const all = [...(names || [])].filter((n) => n);
  const others = all.filter((n) => n !== me).sort();
  return all.includes(me) ? [me, ...others] : others;
}

/**
 * Percentile of a rank within the FULL cell set ("top X%"). Always relative to
 * every cell, never to the labeler-filtered subset, so the slider readout never
 * shifts underfoot when checkboxes change.
 */
export function rankPercent(rank, total) {
  if (!total) return 0;
  return ((rank + 1) / total) * 100;
}
export function fmtPercent(p) {
  if (p >= 10) return String(Math.round(p));
  // the very top of a 4992-cell list is 0.02% — don't render that as "0.0%"
  return p < 1 ? p.toFixed(2) : p.toFixed(1);
}

/**
 * One-line summary for the collapsed header. Clauses for inactive conditions
 * are omitted; the match count is always present.
 * @param {{lo,hi,checked,unlabeledOnly}} opts
 * @param {{total:number, matched:number, me:string, meLabel:string}} ctx
 */
export function filterSummary(opts, ctx) {
  const o = opts || {};
  const total = ctx.total || 0;
  const maxRank = total ? total - 1 : 0;
  const parts = [];
  if (o.lo > 0 || o.hi < maxRank) {
    const hiPct = fmtPercent(rankPercent(o.hi, total));
    parts.push(o.lo > 0
      ? `top ${fmtPercent(rankPercent(o.lo, total))}–${hiPct}%`
      : `top ${hiPct}%`);
  }
  if (o.unlabeledOnly) parts.push('unlabeled');
  else if (o.checked && o.checked.size === 1) {
    const only = [...o.checked][0];
    parts.push(only === ctx.me ? (ctx.meLabel || 'me') : only);
  } else if (o.checked && o.checked.size > 1) {
    parts.push(`${o.checked.size} labelers`);
  }
  const active = filterIsActive(o, maxRank);
  const count = active ? `${ctx.matched} / ${total}` : `${total}`;
  return 'Filters: ' + (parts.length ? parts.join(' · ') : 'off') + ' · ' + count;
}

const EMPTY_SET = new Set();
const EMPTY_MAP = new Map();
