import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { machiaiHome } from "./local.js";

/** Sentinel appended to every command we own, so link/unlink is idempotent and never touches other hooks. */
const MARKER = "# machiai-hook";

interface HookHandler {
  type: string;
  command: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}
interface HooksConfig {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface AgentTarget {
  agent: "claude" | "codex";
  file: string;
  events: string[];
}

function targets(): AgentTarget[] {
  return [
    {
      agent: "claude",
      file: join(homedir(), ".claude", "settings.json"),
      events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop"],
    },
    {
      // Codex has no SessionEnd; sessions age out of the registry after the lookback window.
      agent: "codex",
      file: join(homedir(), ".codex", "hooks.json"),
      events: ["SessionStart", "UserPromptSubmit", "Stop"],
    },
  ];
}

export function hookRunnerPath(): string {
  return join(machiaiHome(), "hook-runner.mjs");
}

export interface LinkSummary {
  agent: string;
  file: string;
  events: string[];
  created: boolean;
}

export function linkHooks(): LinkSummary[] {
  writeHookRunner();
  const runner = hookRunnerPath();
  return targets().map((target) => applyToFile(target, (config) => {
    for (const event of target.events) {
      const groups = stripMachiai(config.hooks?.[event] ?? []);
      groups.push({ hooks: [{ type: "command", command: buildCommand(runner, target.agent, event) }] });
      config.hooks = config.hooks ?? {};
      config.hooks[event] = groups;
    }
  }));
}

export function unlinkHooks(): LinkSummary[] {
  return targets().map((target) => applyToFile(target, (config) => {
    for (const event of Object.keys(config.hooks ?? {})) {
      config.hooks![event] = stripMachiai(config.hooks![event]);
      if (config.hooks![event].length === 0) delete config.hooks![event];
    }
  }));
}

function applyToFile(target: AgentTarget, mutate: (config: HooksConfig) => void): LinkSummary {
  const existed = existsSync(target.file);
  const config: HooksConfig = existed ? readJson(target.file) : { hooks: {} };
  if (existed) backupOnce(target.file);
  mutate(config);
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
  return { agent: target.agent, file: target.file, events: target.events, created: !existed };
}

function stripMachiai(groups: HookGroup[]): HookGroup[] {
  return groups.filter((group) => !(group.hooks ?? []).some((handler) => (handler.command ?? "").includes(MARKER)));
}

function buildCommand(runner: string, agent: string, event: string): string {
  return `${quote(resolveNodeExecutable())} ${quote(runner)} ${agent} ${event} ${MARKER}`;
}

/**
 * The hook runs `<node> hook-runner.mjs`. When `machiai link` runs under the CLI, process.execPath
 * IS node. When it runs from the Electron overlay, process.execPath is the Electron binary — so we
 * resolve a real node from disk instead, falling back to PATH lookup at hook time.
 */
function resolveNodeExecutable(): string {
  const fromEnv = process.env.MACHIAI_NODE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (basename(process.execPath).toLowerCase() === "node") return process.execPath;
  for (const candidate of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(homedir(), ".local", "bin", "node"),
    join(homedir(), ".volta", "bin", "node"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "node";
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function readJson(file: string): HooksConfig {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HooksConfig;
  } catch {
    return { hooks: {} };
  }
}

function backupOnce(file: string): void {
  const backup = `${file}.machiai.bak`;
  if (!existsSync(backup)) {
    try {
      copyFileSync(file, backup);
    } catch {
      // best effort
    }
  }
}

/**
 * A dependency-free hook that reads the event JSON on stdin (session_id, cwd, hook_event_name),
 * appends one metadata line to ~/.machiai/agent-events.jsonl, and self-trims. Never blocks the agent.
 */
function writeHookRunner(): void {
  const home = machiaiHome();
  mkdirSync(home, { recursive: true });
  const script = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const agent = process.argv[2] || "unknown";
const eventArg = process.argv[3];
const home = process.env.MACHIAI_HOME || join(homedir(), ".machiai");
const file = join(home, "agent-events.jsonl");

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let data = {};
try { data = raw ? JSON.parse(raw) : {}; } catch {}

const sessionId = data.session_id || data.sessionId || "";
if (!sessionId) process.exit(0);
const record = {
  agent,
  event: data.hook_event_name || eventArg || "unknown",
  sessionId,
  cwd: data.cwd || data.project_dir || undefined,
  ts: new Date().toISOString(),
};

try {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\\n");
  // Keep the log bounded: when it grows past ~512KB, retain the last ~256KB.
  if (statSync(file).size > 512 * 1024) {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(text.length - 256 * 1024).replace(/^[^\\n]*\\n/, ""));
  }
} catch {}
`;
  writeFileSync(hookRunnerPath(), script);
}
