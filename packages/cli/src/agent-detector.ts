import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { AgentDetection, WaitSession } from "../../shared/src/index.js";
import { isFreshWaitSession, loadState, type LocalState } from "./local.js";

const execFileAsync = promisify(execFile);

const GUI_APP_PROCESS_NAMES = [/^Codex(?: Helper.*)?$/, /^Claude(?: Helper.*)?$/, /^Cursor(?: Helper.*)?$/];
const SELF_PROCESS_RE = /(?:^|\s)(?:machiai|@aizakmi08\/machiai)(?:\s|$)/i;

export interface AgentDetectionOptions {
  now?: Date;
  state?: LocalState;
  processNames?: string[];
  processes?: ProcessSnapshot[];
  trustVisibleAgentApps?: boolean;
}

export interface ProcessSnapshot {
  name: string;
  commandLine: string;
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

  const processes = options.processes ?? snapshotsFromProcessNames(options.processNames) ?? (await readProcessSnapshots());
  const activeCli = processes.map(classifyCliProcess).find((item): item is CliProcessMatch => Boolean(item?.active));
  if (activeCli) {
    return {
      status: "active",
      source: "process",
      agent: activeCli.agent,
      reason: `${activeCli.agent} is running an agent command.`,
      detectedAt: now.toISOString(),
    };
  }

  const maybeCli = processes.map(classifyCliProcess).find((item): item is CliProcessMatch => Boolean(item));
  if (maybeCli) {
    if (options.trustVisibleAgentApps) {
      return activeFromTrustedProcess(maybeCli.agent, now);
    }
    return {
      status: "maybe",
      source: "process",
      agent: maybeCli.agent,
      reason: `${maybeCli.agent} is open, but Machiai cannot prove it is currently running a task.`,
      detectedAt: now.toISOString(),
    };
  }

  const guiApp = processes.find((process) => GUI_APP_PROCESS_NAMES.some((pattern) => pattern.test(process.name)))?.name;
  if (guiApp) {
    if (options.trustVisibleAgentApps) {
      return activeFromTrustedProcess(guiApp, now, "app");
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

interface CliProcessMatch {
  agent: string;
  active: boolean;
}

function classifyCliProcess(process: ProcessSnapshot): CliProcessMatch | undefined {
  if (SELF_PROCESS_RE.test(process.commandLine)) return undefined;
  const tokens = process.commandLine.split(/\s+/).filter(Boolean);
  const lowerCommand = process.commandLine.toLowerCase();
  const name = process.name;

  if (name === "cursor-agent" || /\bcursor-agent\b/.test(lowerCommand)) {
    return { agent: "cursor-agent", active: true };
  }

  if (lowerCommand.includes("/codex.app/") && !lowerCommand.includes("/resources/codex")) return undefined;
  if (name === "codex" || hasExecutableToken(tokens, "codex")) {
    if (/\bcodex(?:\s|$)/.test(lowerCommand) && /\bapp-server\b/.test(lowerCommand)) return undefined;
    return { agent: "codex", active: hasCodexActiveSubcommand(tokens, lowerCommand) };
  }

  if (lowerCommand.includes("/claude.app/")) return undefined;
  if (name === "claude" || hasExecutableToken(tokens, "claude")) {
    return { agent: "claude", active: hasClaudeActiveArgs(tokens) };
  }

  return undefined;
}

function hasExecutableToken(tokens: string[], executable: string): boolean {
  return tokens.some((token) => {
    const base = basename(token);
    if (base === executable) return true;
    return token.includes("/") && base.toLowerCase() === executable;
  });
}

function hasCodexActiveSubcommand(tokens: string[], lowerCommand: string): boolean {
  const executableIndex = tokens.findIndex((token) => basename(token).toLowerCase() === "codex");
  const args = executableIndex >= 0 ? tokens.slice(executableIndex + 1) : tokens;
  if (args.includes("exec")) return true;
  if (/\bcodex(?:\s+--[^\s]+)*\s+exec\b/.test(lowerCommand)) return true;
  return false;
}

function hasClaudeActiveArgs(tokens: string[]): boolean {
  const executableIndex = tokens.findIndex((token) => basename(token).toLowerCase() === "claude");
  const args = executableIndex >= 0 ? tokens.slice(executableIndex + 1) : tokens;
  return args.includes("-p") || args.includes("--print") || args.includes("--prompt");
}

function activeFromTrustedProcess(agent: string, now: Date, source: "process" | "app" = "process"): AgentDetection {
  return {
    status: "active",
    source,
    agent,
    reason: `${agent} is visible and trusted by overlay app-detection mode.`,
    detectedAt: now.toISOString(),
  };
}

function latestActiveSession(sessions: WaitSession[], now = new Date()): WaitSession | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (isFreshWaitSession(sessions[i], now)) return sessions[i];
  }
  return undefined;
}

function snapshotsFromProcessNames(processNames: string[] | undefined): ProcessSnapshot[] | undefined {
  return processNames?.map((name) => ({ name, commandLine: name }));
}

async function readProcessSnapshots(): Promise<ProcessSnapshot[]> {
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], { maxBuffer: 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((commandLine) => ({ name: inferProcessName(commandLine), commandLine }));
  } catch {
    return [];
  }
}

function inferProcessName(commandLine: string): string {
  const lowerCommand = commandLine.toLowerCase();
  if (lowerCommand.includes("/codex.app/contents/resources/codex")) return "codex";
  if (lowerCommand.includes("/codex.app/")) return "Codex";
  if (lowerCommand.includes("/claude.app/")) return lowerCommand.includes("helper") ? "Claude Helper" : "Claude";
  if (lowerCommand.includes("cursor-agent")) return "cursor-agent";
  const first = commandLine.split(/\s+/).find(Boolean) ?? "";
  return basename(first);
}
