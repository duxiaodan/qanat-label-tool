// Overview-only image pyramid. Labels, heatmap and crop editing keep their
// existing world coordinates and stacking. Old manifests require no tiles.
export const MAX_TILES = 48; // decoded 512² RGBA ~= 48 MiB, excluding browser overhead
export const MAX_REQUESTS = 4;

export function overviewMaxScale(swath) {
  const levels = swath?.pyramid?.levels;
  return levels?.length ? swath.m_per_px / Math.min(...levels.map(l => l.m_per_px)) : 40;
}

export function visibleTiles(swath, level, view, width, height) {
  const step = swath.pyramid.tile_px * level.m_per_px / swath.m_per_px;
  const x0 = Math.max(0, Math.floor(-view.x / view.scale / step));
  const y0 = Math.max(0, Math.floor(-view.y / view.scale / step));
  const x1 = Math.min(level.cols, Math.ceil((width - view.x) / view.scale / step));
  const y1 = Math.min(level.rows, Math.ceil((height - view.y) / view.scale / step));
  const tiles = [];
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const file = level.tiles[`${col},${row}`];
      if (file) tiles.push({ file, x: col * step, y: row * step, size: step });
    }
  }
  // Centre first: useful detail appears before the edges on a slow connection.
  const cx = (width / 2 - view.x) / view.scale;
  const cy = (height / 2 - view.y) / view.scale;
  return tiles.sort((a, b) => Math.hypot(a.x + step / 2 - cx, a.y + step / 2 - cy)
    - Math.hypot(b.x + step / 2 - cx, b.y + step / 2 - cy));
}

export function planTiles(swath, view, width, height, dpr = 1) {
  const levels = swath?.pyramid?.levels || [];
  if (!levels.length || width <= 0 || height <= 0) return [];
  const wantedResolution = swath.m_per_px / (view.scale * Math.min(2, dpr));
  if (wantedResolution >= swath.m_per_px) return [];
  // Use the coarsest level that supplies at least one pixel per display pixel.
  let index = levels.findIndex(l => l.m_per_px <= wantedResolution);
  if (index < 0) index = levels.length - 1;
  for (; index >= 0; index--) {
    const tiles = visibleTiles(swath, levels[index], view, width, height);
    // Leave cache room for recently visited tiles. Very large screens fall back
    // to a coarser level instead of an unbounded decoded image working set.
    if (tiles.length <= MAX_TILES - MAX_REQUESTS) return tiles;
  }
  return [];
}

export class OverviewTiles {
  constructor(container, swath, load, status = () => {}) {
    this.container = container;
    this.swath = swath;
    this.load = load; // (file, AbortSignal) -> decoded HTMLImageElement + blob URL
    this.status = status;
    this.cache = new Map();
    this.running = new Map();
    this.failed = new Map();
    this.wanted = [];
    this.timer = null;
    this.closed = false;
  }

  schedule(view, width, height, dpr = 1) {
    clearTimeout(this.timer);
    // CSS pan/zoom happens immediately; fetch only after a short settling time.
    this.timer = setTimeout(() => this.update(view, width, height, dpr), 100);
  }

  update(view, width, height, dpr = 1) {
    if (this.closed) return;
    this.wanted = planTiles(this.swath, view, width, height, dpr);
    const files = new Set(this.wanted.map(t => t.file));
    for (const [file, controller] of this.running) {
      if (!files.has(file)) controller.abort();
    }
    for (const [file, entry] of this.cache) {
      if (!files.has(file)) entry.img.remove();
    }
    for (const tile of this.wanted) this.show(tile);
    this.pump();
  }

  show(tile) {
    const entry = this.cache.get(tile.file);
    if (!entry) return;
    // Map insertion order is the LRU order.
    this.cache.delete(tile.file); this.cache.set(tile.file, entry);
    const img = entry.img;
    img.style.left = `${tile.x}px`; img.style.top = `${tile.y}px`;
    img.style.width = `${tile.size}px`; img.style.height = `${tile.size}px`;
    if (!img.isConnected) this.container.appendChild(img);
  }

  pump() {
    if (this.closed) return;
    for (const tile of this.wanted) {
      if (this.running.size >= MAX_REQUESTS) break;
      if (this.cache.has(tile.file) || this.running.has(tile.file)
          || (this.failed.get(tile.file) || 0) > Date.now()) continue;
      const controller = new AbortController();
      this.running.set(tile.file, controller);
      const timeout = setTimeout(() => {
        this.failed.set(tile.file, Date.now() + 15000);
        controller.abort();
      }, 20000);
      Promise.resolve().then(() => this.load(tile.file, controller.signal)).then(entry => {
        if (this.closed || controller.signal.aborted) {
          URL.revokeObjectURL(entry.url); return;
        }
        this.failed.delete(tile.file);
        this.cache.set(tile.file, entry);
        if (this.wanted.some(t => t.file === tile.file)) this.show(tile);
        this.evict();
      }).catch(() => {
        if (!controller.signal.aborted) this.failed.set(tile.file, Date.now() + 15000);
      }).finally(() => {
        clearTimeout(timeout);
        this.running.delete(tile.file);
        this.pump();
      });
    }
    const missing = this.wanted.filter(t => !this.cache.has(t.file));
    this.status(missing.length ? (missing.some(t => (this.failed.get(t.file) || 0) > Date.now())
      ? 'Some map detail is unavailable. Pan or zoom to retry.' : 'Loading map detail…') : '');
  }

  evict() {
    const visible = new Set(this.wanted.map(t => t.file));
    for (const [file, entry] of this.cache) {
      if (this.cache.size <= MAX_TILES) break;
      if (visible.has(file)) continue;
      entry.img.remove(); URL.revokeObjectURL(entry.url); this.cache.delete(file);
    }
    // Expired failures should not accumulate during a long browsing session.
    for (const [file, until] of this.failed) if (until <= Date.now()) this.failed.delete(file);
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const controller of this.running.values()) controller.abort();
    for (const entry of this.cache.values()) {
      entry.img.remove(); URL.revokeObjectURL(entry.url);
    }
    this.cache.clear(); this.failed.clear();
    this.status('');
  }
}
