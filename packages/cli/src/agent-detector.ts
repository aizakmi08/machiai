import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { AgentDetection, WaitSession } from "../../shared/src/index.js";
import { isFreshWaitSession, loadState, type LocalState } from "./local.js";

const execFileAsync = promisify(execFile);

const GUI_APP_PROCESS_NAMES = [/^Codex(?: Helper.*)?$/, /^Claude(?: Helper.*)?$/, /^Cursor(?: Helper.*)?$/];
const SELF_PROCESS_RE = /(?:^|\s)(?:machiai|@aizakmi08\/machiai)(?:\s|$)/i;
const ACTIVE_APP_TOTAL_CPU_THRESHOLD = 8;
const ACTIVE_APP_SINGLE_PROCESS_CPU_THRESHOLD = 5;
const ACTIVE_APP_SERVER_CPU_THRESHOLD = 0.75;
const APP_ACTIVITY_HOLD_MS = 45_000;

const recentAppActivity = new Map<string, number>();

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
  cpuPercent?: number;
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

  const activeApp = classifyActiveAppActivity(processes);
  if (activeApp) {
    rememberAppActivity(activeApp.agent, now);
    return {
      status: "active",
      source: "app-activity",
      agent: activeApp.agent,
      reason: `${activeApp.agent} is actively working on this Mac.`,
      detectedAt: now.toISOString(),
    };
  }

  const recentApp = recentAppActivityDetection(processes, now);
  if (recentApp) return recentApp;

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

export function resetAgentDetectionMemoryForTests(): void {
  recentAppActivity.clear();
}

interface CliProcessMatch {
  agent: string;
  active: boolean;
}

interface AppActivityMatch {
  agent: string;
  totalCpu: number;
  maxCpu: number;
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

function classifyActiveAppActivity(processes: ProcessSnapshot[]): AppActivityMatch | undefined {
  const totals = new Map<string, { totalCpu: number; maxCpu: number; appServerCpu: number }>();
  for (const process of processes) {
    const agent = agentAppName(process.commandLine);
    if (!agent || isBackgroundOnlyAgentAppProcess(process.commandLine)) continue;
    const cpu = process.cpuPercent ?? 0;
    if (cpu <= 0) continue;
    const current = totals.get(agent) ?? { totalCpu: 0, maxCpu: 0, appServerCpu: 0 };
    current.totalCpu += cpu;
    current.maxCpu = Math.max(current.maxCpu, cpu);
    if (/\bcodex\s+app-server\b/i.test(process.commandLine)) current.appServerCpu = Math.max(current.appServerCpu, cpu);
    totals.set(agent, current);
  }

  for (const [agent, stats] of totals) {
    if (
      stats.totalCpu >= ACTIVE_APP_TOTAL_CPU_THRESHOLD ||
      stats.maxCpu >= ACTIVE_APP_SINGLE_PROCESS_CPU_THRESHOLD ||
      stats.appServerCpu >= ACTIVE_APP_SERVER_CPU_THRESHOLD
    ) {
      return { agent, totalCpu: stats.totalCpu, maxCpu: stats.maxCpu };
    }
  }
  return undefined;
}

function rememberAppActivity(agent: string, now: Date): void {
  recentAppActivity.set(agent, now.getTime());
}

function recentAppActivityDetection(processes: ProcessSnapshot[], now: Date): AgentDetection | undefined {
  const nowMs = now.getTime();
  let mostRecent: { agent: string; lastActiveAt: number } | undefined;

  for (const [agent, lastActiveAt] of recentAppActivity) {
    const ageMs = Math.max(0, nowMs - lastActiveAt);
    if (ageMs > APP_ACTIVITY_HOLD_MS || !isAgentAppPresent(processes, agent)) {
      recentAppActivity.delete(agent);
      continue;
    }
    if (!mostRecent || lastActiveAt > mostRecent.lastActiveAt) {
      mostRecent = { agent, lastActiveAt };
    }
  }

  if (!mostRecent) return undefined;
  return {
    status: "active",
    source: "app-activity",
    agent: mostRecent.agent,
    reason: `${mostRecent.agent} was active moments ago; keeping the wait unlocked between work bursts.`,
    detectedAt: now.toISOString(),
  };
}

function isAgentAppPresent(processes: ProcessSnapshot[], agent: string): boolean {
  return processes.some((process) => {
    if (isBackgroundOnlyAgentAppProcess(process.commandLine)) return false;
    return agentNameForProcess(process) === agent;
  });
}

function agentNameForProcess(process: ProcessSnapshot): string | undefined {
  const fromCommand = agentAppName(process.commandLine);
  if (fromCommand) return fromCommand;
  if (/^Codex(?: Helper.*)?$/.test(process.name)) return "Codex";
  if (/^Claude(?: Helper.*)?$/.test(process.name)) return "Claude";
  if (/^Cursor(?: Helper.*)?$/.test(process.name)) return "Cursor";
  return undefined;
}

function agentAppName(commandLine: string): string | undefined {
  const lowerCommand = commandLine.toLowerCase();
  if (lowerCommand.includes("/codex.app/")) return "Codex";
  if (lowerCommand.includes("/claude.app/")) return "Claude";
  if (lowerCommand.includes("/cursor.app/")) return "Cursor";
  return undefined;
}

function isBackgroundOnlyAgentAppProcess(commandLine: string): boolean {
  return /crashpad|squirrel|shipit|sparkle|updater|bare-modifier-monitor|launch-services-helper/i.test(commandLine);
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
    const { stdout } = await execFileAsync("ps", ["-axo", "pcpu=,command="], { maxBuffer: 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^([0-9.]+)\s+(.+)$/);
        const cpuPercent = match ? Number(match[1]) : undefined;
        const commandLine = match ? match[2] : line;
        return {
          name: inferProcessName(commandLine),
          commandLine,
          ...(Number.isFinite(cpuPercent) ? { cpuPercent } : {}),
        };
      });
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
