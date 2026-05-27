// Tiny shared flag so the editor's preview rAF can stand down while an export
// is running. The export uses its OWN (persistent) PixiScene, but pausing the
// preview render avoids two WebGL apps doing heavy work at once.
let exporting = false;

export function setExporting(v: boolean): void { exporting = v; }
export function isExporting(): boolean { return exporting; }
