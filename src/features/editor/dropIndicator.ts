// Singleton DOM reference for the timeline's drop indicator. Both
// ClipSegments (drag-to-reorder) and MediaPool (drag-from-pool) need to show
// the same visual line; rather than re-rendering React on every pointer move,
// we update the element's style directly via these helpers.

let indicatorEl: HTMLDivElement | null = null;

export function bindDropIndicator(el: HTMLDivElement | null): void {
  indicatorEl = el;
  if (el) el.style.display = 'none';
}

export function showDropIndicator(leftPct: number): void {
  const el = indicatorEl;
  if (!el) return;
  el.style.display = 'block';
  el.style.left = `${leftPct}%`;
}

export function hideDropIndicator(): void {
  if (indicatorEl) indicatorEl.style.display = 'none';
}
