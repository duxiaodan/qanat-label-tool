// geo.js — cell pixel <-> world (UTM-38N) coordinate transforms.
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
