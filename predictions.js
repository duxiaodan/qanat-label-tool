// Prediction views share immutable crop geometry and annotation identity.
// Only scores, ordering and the paired overlay change with the selected model.
export function predictionSources(manifest) {
  const cells = manifest.cells || [];
  const ids = new Set(cells.map(c => c.id));
  if (ids.size !== cells.length) throw new Error('Duplicate crop IDs');
  const base = { id: 'default', label: 'Default model',
    heatmap: manifest.swath.heatmap || 'heatmap.enc',
    build_id: manifest.build?.build_id ?? null,
    scores: Object.fromEntries(cells.map(c => [c.id, c.p_pos])) };
  const sources = [base, ...(manifest.prediction_sources || [])];
  const names = new Set();
  for (const source of sources) {
    if (!source.id || names.has(source.id)) throw new Error('Duplicate prediction source');
    names.add(source.id);
    if (!source.label || !/^[\w.-]+\.enc$/.test(source.heatmap)) throw new Error('Invalid prediction source');
    if (!source.scores || Object.keys(source.scores).length !== ids.size ||
        [...ids].some(id => !Object.hasOwn(source.scores, id) ||
          !Number.isFinite(source.scores[id]) || source.scores[id] < 0 || source.scores[id] > 1)) {
      throw new Error('Prediction scores must cover every crop exactly once');
    }
    if (source.id !== 'default' && (!source.build_id || source.build_id === base.build_id)) {
      throw new Error('Prediction source needs distinct provenance');
    }
  }
  return sources;
}

export function predictionCells(cells, source) {
  return cells.map(c => ({ ...c, p_pos: source.scores[c.id] }))
    .sort((a, b) => b.p_pos - a.p_pos);
}

export function predictionMetadata(source) {
  const { scores, heatmap, ...metadata } = source;
  return metadata;
}

// Saved marks keep the score/build association from their original save.
// The existing build_id database field identifies the prediction asset bundle;
// no schema migration or rewrite of historical rows is needed.
export function savedPrediction(mark) {
  return { pPos: mark.pPos ?? null, buildId: mark.buildId ?? null };
}

export function predictionForMark(entry, cell, source, previous = null) {
  return entry.prediction || (previous && savedPrediction(previous)) ||
    { pPos: cell.p_pos, buildId: source.build_id };
}
