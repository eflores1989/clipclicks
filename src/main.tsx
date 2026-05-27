// PixiJS v8 compiles shaders with `new Function()` by default, which needs
// `unsafe-eval` in the CSP. We keep our CSP strict, so we import this side-
// effect module which swaps in a Function-free shader system. MUST be the
// very first import so it runs before any PixiJS code loads.
import 'pixi.js/unsafe-eval';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
