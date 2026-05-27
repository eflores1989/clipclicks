import type { VideoZoomApi } from '../../../electron/preload';

declare global {
  interface Window {
    videoZoom: VideoZoomApi;
  }
}

export {};
