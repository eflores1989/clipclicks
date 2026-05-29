// PixiJS v8 compiles shaders with `new Function()` by default, which needs
// `unsafe-eval` in the CSP. We keep our CSP strict, so we import this side-
// effect module which swaps in a Function-free shader system. MUST be the
// very first import so it runs before any PixiJS code loads.
import 'pixi.js/unsafe-eval';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { ensureCustomBackgroundsLoaded } from './features/editor/useCustomBackgrounds';

// Kick off the custom-backgrounds registry hydration as soon as the renderer
// loads, so that any project referencing a `custom:<id>` background can resolve
// it on the first paint instead of after the user opens the BG library.
ensureCustomBackgroundsLoaded();

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
