import type { AutoZoomConfig, ZoomEvent } from '../types/project';
import type { MouseEventRaw } from '../types/recording';

interface SourceSize {
  width: number;
  height: number;
}

const SPATIAL_CLUSTER_RADIUS_PX = 200;
const DRAG_MIN_DISTANCE_PX = 40;
const DRAG_MIN_DURATION_MS = 200;
const SPAM_THRESHOLD = 5;
const SPAM_WINDOW_MS = 600;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:crypto').randomUUID() as string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Cluster {
  clicks: MouseEventRaw[];
  startMs: number;
  endMs: number;
  isDrag: boolean;
  dragBbox?: { minX: number; minY: number; maxX: number; maxY: number };
}

function detectDrags(
  mouseEvents: MouseEventRaw[],
): Map<number /* down.t */, { upT: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } }> {
  // Pair down/up events and detect ones whose pointer moved significantly.
  const drags = new Map<number, { upT: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } }>();
  let downAt: MouseEventRaw | null = null;
  let movesSinceDown: MouseEventRaw[] = [];
  for (const e of mouseEvents) {
    if (e.type === 'down') {
      downAt = e;
      movesSinceDown = [];
    } else if (e.type === 'up' && downAt) {
      const dist = Math.hypot(e.x - downAt.x, e.y - downAt.y);
      const duration = e.t - downAt.t;
      if (dist > DRAG_MIN_DISTANCE_PX && duration > DRAG_MIN_DURATION_MS) {
        const points = [downAt, ...movesSinceDown, e];
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        drags.set(downAt.t, {
          upT: e.t,
          bbox: {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
          },
        });
      }
      downAt = null;
      movesSinceDown = [];
    } else if (e.type === 'move' && downAt) {
      movesSinceDown.push(e);
    }
  }
  return drags;
}

export function generateZooms(
  mouseEvents: MouseEventRaw[],
  config: AutoZoomConfig,
  source: SourceSize,
  options?: { preserve?: ZoomEvent[] },
): ZoomEvent[] {
  if (!config.enabled || mouseEvents.length === 0) {
    return options?.preserve ?? [];
  }
  const preserved = options?.preserve?.filter((z) => z.source === 'manual' || z.locked) ?? [];

  // Heuristic for recordings made before we translated coordinates to the
  // captured monitor's local space: if any event has negative coords, shift
  // ALL events by the per-axis minimum so they land in [0, ...]. Focals will
  // be approximately correct as long as the events span a meaningful portion
  // of the monitor.
  const minX = mouseEvents.reduce((m, e) => Math.min(m, e.x), Number.POSITIVE_INFINITY);
  const minY = mouseEvents.reduce((m, e) => Math.min(m, e.y), Number.POSITIVE_INFINITY);
  const needsShift = minX < 0 || minY < 0;
  const shifted = needsShift
    ? mouseEvents.map((e) => ({ ...e, x: e.x - Math.min(0, minX), y: e.y - Math.min(0, minY) }))
    : mouseEvents;
  if (needsShift) {
    console.warn('[generateZooms] mouse events had negative coords; shifted by', { dx: -Math.min(0, minX), dy: -Math.min(0, minY) });
  }

  // Step 1: filter mousedowns and edge clicks. Skip the edge filter if the
  // recording's coord space looks off (we already shifted, but if many events
  // still sit outside source bounds, the bounds themselves are likely wrong
  // and we shouldn't drop everything).
  let clicks = shifted.filter((e) => e.type === 'down');
  const outOfBoundsRatio = clicks.length === 0
    ? 0
    : clicks.filter((c) => c.x < 0 || c.x > source.width || c.y < 0 || c.y > source.height).length / clicks.length;
  const safeEdgeFilter = config.ignoreEdgeClicks && outOfBoundsRatio < 0.2;
  if (safeEdgeFilter) {
    const xMin = source.width * 0.02;
    const xMax = source.width * 0.98;
    const yMin = source.height * 0.02;
    const yMax = source.height * 0.98;
    clicks = clicks.filter((e) => e.x >= xMin && e.x <= xMax && e.y >= yMin && e.y <= yMax);
  } else if (config.ignoreEdgeClicks && outOfBoundsRatio >= 0.2) {
    console.warn('[generateZooms] >20% of clicks lie outside source bounds; skipping edge filter');
  }
  if (clicks.length === 0) return preserved.sort((a, b) => a.startMs - b.startMs);

  const drags = detectDrags(shifted);

  // Step 2: temporal + spatial clustering. Drag downs always start a new cluster
  // because their focal point will be a region, not a centroid.
  const clusters: Cluster[] = [];
  let current: MouseEventRaw[] = [];
  for (const c of clicks) {
    if (drags.has(c.t)) {
      if (current.length > 0) {
        clusters.push({ clicks: current, startMs: current[0].t, endMs: current[current.length - 1].t, isDrag: false });
        current = [];
      }
      const d = drags.get(c.t)!;
      clusters.push({
        clicks: [c],
        startMs: c.t,
        endMs: d.upT,
        isDrag: true,
        dragBbox: d.bbox,
      });
      continue;
    }
    if (current.length === 0) {
      current.push(c);
      continue;
    }
    const last = current[current.length - 1];
    const timeDelta = c.t - last.t;
    const cx = current.reduce((s, e) => s + e.x, 0) / current.length;
    const cy = current.reduce((s, e) => s + e.y, 0) / current.length;
    const spatial = Math.hypot(c.x - cx, c.y - cy);
    if (timeDelta < config.clickGroupingWindowMs && spatial < SPATIAL_CLUSTER_RADIUS_PX) {
      current.push(c);
    } else {
      clusters.push({ clicks: current, startMs: current[0].t, endMs: current[current.length - 1].t, isDrag: false });
      current = [c];
    }
  }
  if (current.length > 0) {
    clusters.push({ clicks: current, startMs: current[0].t, endMs: current[current.length - 1].t, isDrag: false });
  }

  // Step 3: turn clusters into ZoomEvents.
  const generated: ZoomEvent[] = clusters.map((cluster) => {
    if (cluster.isDrag && cluster.dragBbox) {
      const bbox = cluster.dragBbox;
      const cx = (bbox.minX + bbox.maxX) / 2;
      const cy = (bbox.minY + bbox.maxY) / 2;
      const nx = clamp(cx / source.width, 0, 1);
      const ny = clamp(cy / source.height, 0, 1);
      const startMs = Math.max(0, cluster.startMs - config.enterMs - 150);
      const endMs = cluster.endMs + config.exitMs + 200;
      const total = endMs - startMs;
      const enterMs = Math.min(config.enterMs, Math.max(80, total / 4));
      const exitMs = Math.min(config.exitMs, Math.max(80, total / 4));
      return {
        id: newId(),
        source: 'auto',
        startMs,
        endMs,
        enterDurationMs: enterMs,
        holdDurationMs: total - enterMs - exitMs,
        exitDurationMs: exitMs,
        enterEasing: config.enterEasing,
        exitEasing: config.exitEasing,
        scale: config.defaultScale,
        target: {
          mode: 'region',
          nx,
          ny,
          region: {
            nx: bbox.minX / source.width,
            ny: bbox.minY / source.height,
            nw: (bbox.maxX - bbox.minX) / source.width,
            nh: (bbox.maxY - bbox.minY) / source.height,
          },
        },
        cursorBehavior: 'smoothed',
        smoothing: 0.7,
      };
    }

    // Weighted centroid: last click ×1.5.
    let sumX = 0;
    let sumY = 0;
    let totalW = 0;
    cluster.clicks.forEach((c, i) => {
      const w = i === cluster.clicks.length - 1 ? 1.5 : 1;
      sumX += c.x * w;
      sumY += c.y * w;
      totalW += w;
    });
    const focalNx = clamp(sumX / totalW / source.width, 0, 1);
    const focalNy = clamp(sumY / totalW / source.height, 0, 1);

    const first = cluster.clicks[0];
    const last = cluster.clicks[cluster.clicks.length - 1];
    const isSpam =
      cluster.clicks.length >= SPAM_THRESHOLD && last.t - first.t < SPAM_WINDOW_MS;

    const startMs = Math.max(0, first.t - config.enterMs - 150);
    const endMs = last.t + config.defaultDurationMs / 2 + config.exitMs;
    let scale = config.defaultScale;
    if (cluster.clicks.length > 3) scale += 0.2;
    if (isSpam) scale += 0.3;

    const total = endMs - startMs;
    const enterMs = Math.min(config.enterMs, Math.max(80, total / 4));
    const exitMs = Math.min(config.exitMs, Math.max(80, total / 4));

    return {
      id: newId(),
      source: 'auto',
      startMs,
      endMs,
      enterDurationMs: enterMs,
      holdDurationMs: total - enterMs - exitMs,
      exitDurationMs: exitMs,
      enterEasing: config.enterEasing,
      exitEasing: config.exitEasing,
      scale,
      target: { mode: 'point', nx: focalNx, ny: focalNy },
      cursorBehavior: config.followCursor ? 'smoothed' : 'static',
      smoothing: config.followCursor ? 0.85 : undefined,
    };
  });

  // Step 4: resolve overlaps. We do NOT merge zooms even when their focals
  // are close — that would silently drop a click event. Instead, if zoom A
  // and zoom B overlap, we shrink A's tail (exit) so B can start.
  const combined = [...generated, ...preserved].sort((a, b) => a.startMs - b.startMs);
  const resolved: ZoomEvent[] = [];
  for (const z of combined) {
    const last = resolved[resolved.length - 1];
    if (!last) {
      resolved.push(z);
      continue;
    }
    const overlapMs = last.endMs + config.minGapBetweenZoomsMs - z.startMs;
    if (overlapMs <= 0) {
      resolved.push(z);
      continue;
    }
    const lastIsImmutable = last.source === 'manual' || last.locked;
    if (lastIsImmutable) {
      // Don't touch a manual or locked zoom; keep both even with overlap.
      resolved.push(z);
      continue;
    }
    const desiredEnd = z.startMs - config.minGapBetweenZoomsMs;
    const minViableEnd = last.startMs + last.enterDurationMs + 100;
    if (desiredEnd > minViableEnd) {
      last.endMs = desiredEnd;
      const dur = last.endMs - last.startMs;
      last.enterDurationMs = Math.min(last.enterDurationMs, dur * 0.4);
      last.exitDurationMs = Math.min(last.exitDurationMs, dur * 0.4);
      last.holdDurationMs = Math.max(0, dur - last.enterDurationMs - last.exitDurationMs);
      resolved.push(z);
    } else {
      // Previous zoom too short to shrink usefully; drop it.
      resolved.pop();
      resolved.push(z);
    }
  }

  const final = resolved.sort((a, b) => a.startMs - b.startMs);
  console.log('[generateZooms]', {
    rawClicks: mouseEvents.filter((e) => e.type === 'down').length,
    afterEdgeFilter: clicks.length,
    drags: drags.size,
    clusters: clusters.length,
    generatedZooms: generated.length,
    preserved: preserved.length,
    finalZooms: final.length,
  });
  return final;
}
