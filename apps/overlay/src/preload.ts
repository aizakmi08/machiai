import { contextBridge, ipcRenderer } from "electron";
import type { AgentDetection, OverlayBootstrap, PlayerProfile, SnapResult } from "../../../packages/shared/src/index.js";

export interface MachiaiOverlayApi {
  bootstrap(): Promise<OverlayBootstrap>;
  detectAgent(): Promise<AgentDetection>;
  updateProfile(displayName: string): Promise<PlayerProfile>;
  snap(): Promise<SnapResult>;
}

const api: MachiaiOverlayApi = {
  bootstrap: () => ipcRenderer.invoke("machiai:bootstrap") as Promise<OverlayBootstrap>,
  detectAgent: () => ipcRenderer.invoke("machiai:detect-agent") as Promise<AgentDetection>,
  updateProfile: (displayName: string) => ipcRenderer.invoke("machiai:update-profile", displayName) as Promise<PlayerProfile>,
  snap: () => ipcRenderer.invoke("machiai:snap") as Promise<SnapResult>,
};

contextBridge.exposeInMainWorld("machiaiOverlay", api);
