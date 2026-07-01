import type { PlayerProfile, WaitSession } from "./types.js";

export type AgentDetectionStatus = "active" | "maybe" | "inactive";

export type AgentDetectionSource = "local-session" | "process" | "app" | "none";

export interface AgentDetection {
  status: AgentDetectionStatus;
  source: AgentDetectionSource;
  agent?: string;
  sessionId?: string;
  workspace?: string;
  goal?: string;
  reason: string;
  detectedAt: string;
}

export interface OverlayBootstrap {
  profile: PlayerProfile;
  serverUrl: string;
  detection: AgentDetection;
  activeWaitSession?: WaitSession;
}

export interface SnapResult {
  ok: boolean;
  reason?: string;
}
