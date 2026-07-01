import type { MachiaiOverlayApi } from "../preload.js";

declare global {
  interface Window {
    machiaiOverlay: MachiaiOverlayApi;
  }
}

export {};
