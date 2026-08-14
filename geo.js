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
