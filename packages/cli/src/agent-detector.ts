import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { AgentDetection, WaitSession } from "../../shared/src/index.js";
import { isFreshWaitSession, loadState, type LocalState } from "./local.js";

const execFileAsync = promisify(execFile);

const ACTIVE_CLI_PROCESS_NAMES = new Set(["codex", "claude", "cursor-agent"]);
const GUI_APP_PROCESS_NAMES = [/^Codex(?: Helper.*)?$/, /^Claude(?: Helper.*)?$/, /^Cursor(?: Helper.*)?$/];

export interface AgentDetectionOptions {
  now?: Date;
  state?: LocalState;
  processNames?: string[];
  trustVisibleAgentApps?: boolean;
}

export async function detectAgentActivity(options: AgentDetectionOptions = {}): Promise<AgentDetection> {
  const now = options.now ?? new Date();
  const state = options.state ?? loadState();
  const localSession = latestActiveSession(state.waitSessions, now);
  if (localSession) {
    return {
      status: "active",
      source: "local-session",
      agent: localSession.agent,
      sessionId: localSession.sessionId,
      workspace: localSession.workspace,
      goal: localSession.goal,
      reason: `${localSession.agent} is running through Machiai.`,
      detectedAt: now.toISOString(),
    };
  }

  const processNames = options.processNames ?? (await readProcessNames());
  const activeCli = processNames.find((name) => ACTIVE_CLI_PROCESS_NAMES.has(name));
  if (activeCli) {
    if (options.trustVisibleAgentApps) {
      return {
        status: "active",
        source: "process",
        agent: activeCli,
        reason: `${activeCli} is running as a local agent process.`,
        detectedAt: now.toISOString(),
      };
    }
    return {
      status: "maybe",
      source: "process",
      agent: activeCli,
      reason: `${activeCli} is open, but Machiai cannot prove an agent is currently running.`,
      detectedAt: now.toISOString(),
    };
  }

  const guiApp = processNames.find((name) => GUI_APP_PROCESS_NAMES.some((pattern) => pattern.test(name)));
  if (guiApp) {
    if (options.trustVisibleAgentApps) {
      return {
        status: "active",
        source: "app",
        agent: guiApp,
        reason: `${guiApp} is open. Overlay app-detection mode is unlocked.`,
        detectedAt: now.toISOString(),
      };
    }
    return {
      status: "maybe",
      source: "app",
      agent: guiApp,
      reason: `${guiApp} is open, but Machiai cannot prove an agent is currently running.`,
      detectedAt: now.toISOString(),
    };
  }

  return {
    status: "inactive",
    source: "none",
    reason: "No active Machiai wait session or supported agent process was detected.",
    detectedAt: now.toISOString(),
  };
}

function latestActiveSession(sessions: WaitSession[], now = new Date()): WaitSession | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (isFreshWaitSession(sessions[i], now)) return sessions[i];
  }
  return undefined;
}

async function readProcessNames(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "comm="], { maxBuffer: 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .map((line) => basename(line.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}
