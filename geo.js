// geo.js — cell pixel <-> world (UTM-38N) coordinate transforms, plus the
// pure 2-D mark hit-test used by the crop popup's hover tooltip.
//
// Mirrors scripts/jason_corona/build_label_tool_site.py's cell_pixel_to_world /
// world_to_cell_pixel exactly. north-up convention: pixel row 0 = TOP = y1.
//
// Pure ES module: uses no DOM, no Node-only APIs — runs unchanged in the browser
// and under `node --test`.

/**
 * Cell pixel (col, row) -> world [x, y].
 *   x = x0 + col/cropPx * (x1 - x0)
 *   y = y1 - row/cropPx * (y1 - y0)
 * @param {number} col
 * @param {number} row
 * @param {[number,number,number,number]} worldBbox [x0, y0, x1, y1] with y0 < y1
 * @param {number} [cropPx=1024]
 * @returns {[number, number]}
 */
export function pixelToWorld(col, row, worldBbox, cropPx = 1024) {
  const [x0, y0, x1, y1] = worldBbox;
  const x = x0 + (col / cropPx) * (x1 - x0);
  const y = y1 - (row / cropPx) * (y1 - y0);
  return [x, y];
}

/**
 * World [x, y] -> cell pixel [col, row]. Exact inverse of pixelToWorld.
 * @param {number} x
 * @param {number} y
 * @param {[number,number,number,number]} worldBbox [x0, y0, x1, y1] with y0 < y1
 * @param {number} [cropPx=1024]
 * @returns {[number, number]}
 */
export function worldToPixel(x, y, worldBbox, cropPx = 1024) {
  const [x0, y0, x1, y1] = worldBbox;
  const col = ((x - x0) / (x1 - x0)) * cropPx;
  const row = ((y1 - y) / (y1 - y0)) * cropPx;
  return [col, row];
}

/** Squared distance from point (px, py) to segment (ax, ay)-(bx, by). */
function segmentDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // param of the projection onto the segment, clamped to [0, 1]
  // (a zero-length segment degenerates to point distance)
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

/**
 * Nearest mark within `tol` of (col, row), or null.
 *
 * All coordinates and the tolerance share ONE space — the caller picks it (the
 * crop popup passes image px with tol = screen-px tolerance / view scale, the
 * same convention as its own-mark click hit-test). Points compete by distance
 * to the dot centre; polylines by distance to their nearest SEGMENT (not just
 * vertices). When several marks are within tolerance the closest one wins, so
 * overlapping marks never tie.
 *
 * @param {Array<[number,number]>} points  dot marks
 * @param {Array<Array<[number,number]>>} lines  polyline marks (vertex lists)
 * @param {number} col
 * @param {number} row
 * @param {number} tol  inclusive distance tolerance (> 0)
 * @returns {{kind:'point'|'line', idx:number, d2:number}|null}
 */
export function nearestMark(points, lines, col, row, tol) {
  let best = null;
  const tol2 = tol * tol;
  const consider = (kind, idx, d2) => {
    if (d2 <= tol2 && (!best || d2 < best.d2)) best = { kind, idx, d2 };
  };
  points.forEach(([c, r], i) => consider('point', i, (c - col) ** 2 + (r - row) ** 2));
  lines.forEach((pts, i) => {
    if (!pts.length) return;
    if (pts.length === 1) { consider('line', i, (pts[0][0] - col) ** 2 + (pts[0][1] - row) ** 2); return; }
    let d2 = Infinity;
    for (let s = 0; s + 1 < pts.length; s++) {
      d2 = Math.min(d2, segmentDist2(col, row, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
    }
    consider('line', i, d2);
  });
  return best;
}

/**
 * Where a press at (col, row) grabs a polyline, for drag-move.
 *
 * Vertex first: the NEAREST vertex within `vertexTol` wins -> that single
 * vertex is dragged. Otherwise, if the press is within `tol` of any SEGMENT,
 * the whole polyline is dragged rigidly. Beyond both -> null (no grab).
 * All coordinates + tolerances share one space, exactly like nearestMark.
 *
 * @param {Array<[number,number]>} pts  polyline vertices
 * @param {number} col
 * @param {number} row
 * @param {number} tol       segment (whole-line) grab tolerance
 * @param {number} [vertexTol=tol]  vertex grab tolerance
 * @returns {{mode:'vertex', vIdx:number}|{mode:'whole'}|null}
 */
export function resolveLineGrab(pts, col, row, tol, vertexTol = tol) {
  if (!pts || !pts.length) return null;
  let vIdx = -1, bestD2 = Infinity;
  const vt2 = vertexTol * vertexTol;
  pts.forEach(([c, r], i) => {
    const d2 = (c - col) ** 2 + (r - row) ** 2;
    if (d2 <= vt2 && d2 < bestD2) { vIdx = i; bestD2 = d2; }
  });
  if (vIdx >= 0) return { mode: 'vertex', vIdx };
  if (pts.length < 2) return null;               // single-vertex "line": vertex or nothing
  let d2 = Infinity;
  for (let s = 0; s + 1 < pts.length; s++) {
    d2 = Math.min(d2, segmentDist2(col, row, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
  }
  return d2 <= tol * tol ? { mode: 'whole' } : null;
}

/**
 * Clamp a rigid-translate delta so EVERY point stays inside [0, size]².
 * Returns the largest |delta| <= the requested one that keeps all points in
 * bounds (a drag "stops at the edge" instead of escaping the crop). A point
 * already out of bounds on an axis with an empty feasible interval gets 0 on
 * that axis (never move it further out, never force it around).
 *
 * @param {Array<[number,number]>} pts
 * @param {number} dc  requested column delta
 * @param {number} dr  requested row delta
 * @param {number} [size=1024]
 * @returns {[number, number]} the clamped [dc, dr]
 */
export function clampDelta(pts, dc, dr, size = 1024) {
  if (!pts || !pts.length) return [0, 0];
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const [c, r] of pts) {
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  const clampAxis = (d, lo, hi) => (lo > hi ? 0 : Math.min(hi, Math.max(lo, d)));
  return [
    clampAxis(dc, -minC, size - maxC),
    clampAxis(dr, -minR, size - maxR),
  ];
}

/**
 * Rigidly translate a vertex list (fresh arrays; input untouched).
 * @param {Array<[number,number]>} pts
 * @param {number} dc
 * @param {number} dr
 * @returns {Array<[number,number]>}
 */
export function translatePoints(pts, dc, dr) {
  return (pts || []).map(([c, r]) => [c + dc, r + dr]);
}
