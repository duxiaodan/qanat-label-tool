// Stable identity is derived from baseline coordinates, never edited coordinates.
// One source point shared by multiple crops has one correction per board/project.
export async function indexOriginalLabels(cells) {
  const byCoords = new Map(), byCell = new Map();
  for (const cell of cells) {
    const points = [];
    for (const world of cell.gt_points || []) {
      const key = JSON.stringify(world);
      if (!byCoords.has(key)) byCoords.set(key, { world: [...world], cells: new Set() });
      const point = byCoords.get(key); point.cells.add(cell.id); points.push(point);
    }
    byCell.set(cell.id, [...new Set(points)]);
  }
  await Promise.all([...byCoords.entries()].map(async ([key, point]) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('qanat-original-shaft-v1:' + key));
    point.id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }));
  return { byCell, points: [...byCoords.values()] };
}
export function effectiveOriginals(points, edits, includeDeleted = false) {
  return points.filter(p => includeDeleted || !edits.get(p.id)?.deleted).map(p => ({
    id: p.id, world: edits.get(p.id)?.world || p.world,
    editedBy: edits.get(p.id)?.edited_by || null, deleted: !!edits.get(p.id)?.deleted,
  }));
}
