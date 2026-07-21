// geojson.js — build the downloadable FeatureCollections for the manual labels.
//
// EPSG:32638 (UTM zone 38N). Coordinates are rounded to 2 dp (~cm). Matches the
// envelopes pinned by scripts/jason_corona/label_tool_site/tests/test_geojson.mjs.
//
// Pure ES module: no DOM, no Node-only APIs.

const CRS_BLOCK = {
  type: 'name',
  properties: { name: 'urn:ogc:def:crs:EPSG::32638' },
};

/** Round to 2 decimal places. */
function round2(v) {
  return Math.round(v * 100) / 100;
}

function shaftProps(mark, labeler) {
  return {
    // per-mark owner wins (shared pool); fall back to the caller-supplied default.
    labeler: (mark && mark.labeler) || labeler,
    project: mark.project ?? null,
    crop_id: mark.cropId,
    created: mark.created,
    source: 'web_label_tool',
    crop_p_pos: mark.pPos,
    // provenance (stamped at save time; null on marks that predate the feature)
    world_bbox: mark.worldBbox ?? null,
    crs: mark.crs ?? null,
    crop_px: mark.cropPx ?? null,
    tifs: mark.tifs ?? null,
    crop_sha256: mark.cropSha256 ?? null,
    build_id: mark.buildId ?? null,
    autocontrast: mark.autocontrast ?? null,
  };
}

/**
 * @param {Array<{cropId:string, pPos:number, world:[number,number], created:string}>} shaftMarks
 * @param {{labeler:string}} opts
 * @returns {object} GeoJSON FeatureCollection
 */
export function buildShaftsFeatureCollection(shaftMarks, opts) {
  const labeler = (opts && opts.labeler) || '';
  const features = (shaftMarks || []).map((m) => ({
    type: 'Feature',
    properties: shaftProps(m, labeler),
    geometry: {
      type: 'Point',
      coordinates: [round2(m.world[0]), round2(m.world[1])],
    },
  }));
  return {
    type: 'FeatureCollection',
    name: 'qanat_shafts_manual',
    crs: CRS_BLOCK,
    features,
  };
}

/**
 * @param {Array<{cropId:string, pPos:number, world:Array<[number,number]>, created:string}>} lineMarks
 * @param {{labeler:string}} opts
 * @returns {object} GeoJSON FeatureCollection
 */
export function buildLinesFeatureCollection(lineMarks, opts) {
  const labeler = (opts && opts.labeler) || '';
  const features = [];
  for (const m of lineMarks || []) {
    const verts = m.world || [];
    if (verts.length < 2) continue; // drop degenerate lines
    features.push({
      type: 'Feature',
      properties: shaftProps(m, labeler),
      geometry: {
        type: 'MultiLineString',
        coordinates: [verts.map((v) => [round2(v[0]), round2(v[1])])],
      },
    });
  }
  return {
    type: 'FeatureCollection',
    name: 'qanat_channels_manual',
    crs: CRS_BLOCK,
    features,
  };
}
