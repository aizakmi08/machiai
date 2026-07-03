import { contextBridge, ipcRenderer } from "electron";
import type { AgentDetection, MatchRecord, OverlayBootstrap, PlayerProfile, ReferenceSelector, SnapResult } from "../../../packages/shared/src/index.js";
import type { LinkSummary } from "../../../packages/cli/src/hook-install.js";

export interface MachiaiOverlayApi {
  bootstrap(): Promise<OverlayBootstrap>;
  detectAgent(): Promise<AgentDetection>;
  setReference(selector: ReferenceSelector): Promise<AgentDetection>;
  linkHooks(): Promise<LinkSummary[]>;
  recordMatch(record: MatchRecord): Promise<MatchRecord>;
  ratingResult(gameId: string, mmrDelta: number, mmrAfter: number): Promise<MatchRecord | undefined>;
  listMatches(): Promise<MatchRecord[]>;
  signOut(): Promise<PlayerProfile>;
  updateProfile(displayName: string, twitterHandle?: string): Promise<PlayerProfile>;
  saveProfile(profile: PlayerProfile): Promise<PlayerProfile>;
  openExternal(url: string): Promise<void>;
  snap(): Promise<SnapResult>;
  attention(): Promise<void>;
}

const api: MachiaiOverlayApi = {
  bootstrap: () => ipcRenderer.invoke("machiai:bootstrap") as Promise<OverlayBootstrap>,
  detectAgent: () => ipcRenderer.invoke("machiai:detect-agent") as Promise<AgentDetection>,
  setReference: (selector: ReferenceSelector) => ipcRenderer.invoke("machiai:set-reference", selector) as Promise<AgentDetection>,
  linkHooks: () => ipcRenderer.invoke("machiai:link-hooks") as Promise<LinkSummary[]>,
  recordMatch: (record: MatchRecord) => ipcRenderer.invoke("machiai:record-match", record) as Promise<MatchRecord>,
  ratingResult: (gameId: string, mmrDelta: number, mmrAfter: number) => ipcRenderer.invoke("machiai:rating-result", gameId, mmrDelta, mmrAfter) as Promise<MatchRecord | undefined>,
  listMatches: () => ipcRenderer.invoke("machiai:list-matches") as Promise<MatchRecord[]>,
  signOut: () => ipcRenderer.invoke("machiai:sign-out") as Promise<PlayerProfile>,
  updateProfile: (displayName: string, twitterHandle?: string) => ipcRenderer.invoke("machiai:update-profile", displayName, twitterHandle) as Promise<PlayerProfile>,
  saveProfile: (profile: PlayerProfile) => ipcRenderer.invoke("machiai:save-profile", profile) as Promise<PlayerProfile>,
  openExternal: (url: string) => ipcRenderer.invoke("machiai:open-external", url) as Promise<void>,
  snap: () => ipcRenderer.invoke("machiai:snap") as Promise<SnapResult>,
  attention: () => ipcRenderer.invoke("machiai:attention") as Promise<void>,
};

contextBridge.exposeInMainWorld("machiaiOverlay", api);
