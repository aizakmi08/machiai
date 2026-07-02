import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentRun {
  started: Promise<void>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export function startAgent(command: string, args: string[], onOutput: (chunk: string) => void): AgentRun {
  const resolvedCommand = resolveAgentCommand(command);
  const ptyRun = tryStartPty(resolvedCommand, args, onOutput);
  if (ptyRun) return ptyRun;

  const child = spawn(resolvedCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data: Buffer) => onOutput(data.toString()));
  child.stderr.on("data", (data: Buffer) => onOutput(data.toString()));
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      onOutput(`\nAgent failed to start: ${error.message}\n`);
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    started,
    done,
    kill: (signal = "SIGTERM") => child.kill(signal),
  };
}

function tryStartPty(command: string, args: string[], onOutput: (chunk: string) => void): AgentRun | undefined {
  if (process.env.MACHIAI_DISABLE_PTY === "1") return undefined;
  try {
    const req = eval("require") as NodeRequire;
    const pty = req("node-pty") as {
      spawn: (
        command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
      ) => {
        onData(callback: (data: string) => void): void;
        onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
        kill(signal?: string): void;
      };
    };
    const proc = pty.spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
    proc.onData(onOutput);
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.onExit((event) => resolve({ code: event.exitCode, signal: null }));
    });
    return {
      started: Promise.resolve(),
      done,
      kill: (signal = "SIGTERM") => proc.kill(signal),
    };
  } catch {
    return undefined;
  }
}

export function resolveAgentCommand(command: string): string {
  if (command.includes("/")) return command;
  if (command === "codex") {
    const bundledCodex = "/Applications/Codex.app/Contents/Resources/codex";
    if (existsSync(bundledCodex)) return bundledCodex;
  }
  if (command === "claude") {
    for (const candidate of [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(homedir(), ".local", "bin", "claude"),
      join(homedir(), ".npm-global", "bin", "claude"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}
