import type { PlayerProfile, WaitSession } from "./types.js";

export type AgentDetectionStatus = "active" | "maybe" | "inactive";

export type AgentDetectionSource = "local-session" | "session" | "process" | "app-activity" | "app" | "none";

/** The coding agent behind a session. Open string so unknown agents still flow through. */
export type AgentKind = "claude" | "codex" | "cursor" | (string & {});

/** Where the session lives. `terminal` = CLI/TUI, `app` = desktop/IDE. */
export type AgentSurface = "terminal" | "app" | "unknown";

/** Whether the agent is mid-turn (`running`), waiting on the human (`idle`), or gone (`ended`). */
export type SessionState = "running" | "idle" | "ended";

/** Which signal decided a session's state, strongest first: wait > hook > transcript > process. */
export type SessionSignal = "wait" | "hook" | "transcript" | "process";

/** One live coding-agent session in the registry. */
export interface AgentSessionSummary {
  id: string;
  agent: AgentKind;
  surface: AgentSurface;
  state: SessionState;
  workspace?: string;
  gitBranch?: string;
  title?: string;
  startedAt?: string;
  lastEventAt: string;
  lastEventKind?: string;
  signal: SessionSignal;
}

/**
 * What the user is watching to decide "can I start a new game".
 * `auto` follows the most-recently-active running session; `session` pins one;
 * `filter` matches any running session of a given agent/surface.
 */
export type ReferenceSelector =
  | { kind: "auto" }
  | { kind: "session"; sessionId: string }
  | { kind: "filter"; agent?: AgentKind | "any"; surface?: AgentSurface | "any" };

export const DEFAULT_REFERENCE_SELECTOR: ReferenceSelector = { kind: "auto" };

export interface AgentDetection {
  status: AgentDetectionStatus;
  source: AgentDetectionSource;
  agent?: string;
  sessionId?: string;
  workspace?: string;
  goal?: string;
  reason: string;
  detectedAt: string;
  /** All live sessions the registry knows about (for the picker UI). */
  sessions?: AgentSessionSummary[];
  /** The selector that produced this detection. */
  reference?: ReferenceSelector;
  /** The session that satisfied (or would satisfy) the gate, when known. */
  referenceSessionId?: string;
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
