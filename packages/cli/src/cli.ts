#!/usr/bin/env node
import { resolve } from "node:path";
import { MachiaiServer } from "../../../apps/server/src/server.js";
import { startOverlayApp } from "./app.js";
import { startAgent } from "./agent.js";
import { parseCommandAfterDoubleDash, hasFlag, readOption, serverUrl } from "./config.js";
import { runDemo } from "./demo.js";
import { renderInkBanner } from "./ink-banner.js";
import {
  activeLocalWaitSession,
  createLocalBotGame,
  createLocalWaitSession,
  endLocalWaitSession,
  heartbeatLocalWaitSession,
  loadState,
  setReferenceSelector,
  statePath,
  updateProfile,
} from "./local.js";
import { fetchLeaderboard, playOnline } from "./online.js";
import { linkHooks, unlinkHooks } from "./hook-install.js";
import { resolveReference, scanRegistry } from "./session-registry.js";
import { DEFAULT_REFERENCE_SELECTOR, type AgentSessionSummary, type ReferenceSelector } from "../../shared/src/index.js";
import { playLocalBotGame, printHero, printTranscriptTail } from "./ui.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

try {
  if (command === "run") await runCommand(args.slice(1));
  else if (command === "app") await startOverlayApp(args.slice(1));
  else if (command === "play") await playCommand(args.slice(1));
  else if (command === "profile") profileCommand(args.slice(1));
  else if (command === "leaderboard") await leaderboardCommand();
  else if (command === "demo") await runDemo();
  else if (command === "server") await serverCommand(args.slice(1));
  else if (command === "sessions") sessionsCommand();
  else if (command === "watch") watchCommand(args.slice(1));
  else if (command === "link") linkCommand();
  else if (command === "unlink") unlinkCommand();
  else if (command === "mcp-config") mcpConfigCommand();
  else if (command === "serve") await import("./mcp.js");
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runCommand(args: string[]): Promise<void> {
  const commandArgs = parseCommandAfterDoubleDash(args).filter((arg) => arg !== "--ascii");
  const ascii = hasFlag(args, "--ascii");
  const overlay = hasFlag(args, "--overlay") || hasFlag(args, "--app");
  if (commandArgs.length === 0) {
    throw new Error("Usage: machiai run -- <agent command>");
  }
  const [agentCommand, ...agentArgs] = commandArgs;
  const profile = loadState().profile;
  const transcriptTail: string[] = [];
  const agent = startAgent(agentCommand, agentArgs, (chunk) => {
    for (const line of chunk.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      transcriptTail.push(line);
      if (transcriptTail.length > 12) transcriptTail.shift();
    }
  });

  try {
    await agent.started;
  } catch {
    const result = await agent.done;
    printTranscriptTail(transcriptTail);
    process.exitCode = result.code ?? 127;
    return;
  }

  const wait = createLocalWaitSession({ agent: agentCommand, workspace: process.cwd(), goal: agentArgs.join(" ") || undefined });
  const heartbeat = setInterval(() => {
    heartbeatLocalWaitSession(wait.sessionId);
  }, 5_000);
  heartbeat.unref?.();
  const agentDone = agent.done.then((result) => {
    clearInterval(heartbeat);
    endLocalWaitSession(wait.sessionId);
    return result;
  });

  renderInkBanner(`Agent running. Rated chess is unlocked for this wait session.`);
  if (overlay) {
    await startOverlayApp([], { waitForExit: false });
    const result = await agentDone;
    printTranscriptTail(transcriptTail);
    process.exitCode = result.code ?? 0;
    return;
  }

  try {
    await playOnline({
      serverUrl: serverUrl(),
      profile,
      waitSession: wait,
      ascii,
      agentDone,
    });
  } catch (error) {
    console.log(`Online matchmaking unavailable (${error instanceof Error ? error.message : String(error)}).`);
    console.log("Starting local unrated bot practice instead.");
    const game = createLocalBotGame(wait.sessionId);
    await playLocalBotGame(game, { ascii, agentDone });
  }
  const result = await agentDone;
  printTranscriptTail(transcriptTail);
  process.exitCode = result.code ?? 0;
}

async function playCommand(args: string[]): Promise<void> {
  const ascii = hasFlag(args, "--ascii");
  const session = activeLocalWaitSession();
  if (!session) {
    printHero();
    console.log("Rated queue is locked until an agent is running.");
    console.log("Start with: machiai run -- codex exec \"build the feature\"");
    return;
  }
  const game = createLocalBotGame(session.sessionId);
  await playLocalBotGame(game, { ascii });
}

function profileCommand(args: string[]): void {
  const name = readOption(args, "--name");
  const twitter = readOption(args, "--twitter") ?? readOption(args, "--x");
  const profile = updateProfile(name, twitter);
  console.log(`${profile.displayName || profile.handle}`);
  console.log(`Handle: ${profile.handle}`);
  console.log(`Twitter: ${profile.twitterHandle ? `@${profile.twitterHandle}` : "not set"}`);
  console.log(`MMR: ${profile.mmr}`);
  console.log(`Rated games: ${profile.ratedGames}`);
  console.log(`State: ${statePath()}`);
}

async function leaderboardCommand(): Promise<void> {
  try {
    const payload = (await fetchLeaderboard(serverUrl())) as { entries?: Array<{ handle: string; displayName?: string; mmr: number; ratedGames: number }> };
    for (const [index, entry] of (payload.entries ?? []).entries()) {
      console.log(`${index + 1}. ${entry.displayName || entry.handle}  ${entry.mmr} (${entry.ratedGames} games)`);
    }
  } catch (error) {
    console.log(`Leaderboard unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function serverCommand(args: string[]): Promise<void> {
  const port = Number(readOption(args, "--port") ?? process.env.PORT ?? 4137);
  const host = readOption(args, "--host") ?? process.env.HOST ?? "127.0.0.1";
  const storePath = readOption(args, "--store") ?? resolve(process.cwd(), ".machiai", "server-store.sqlite");
  const server = new MachiaiServer({ storePath });
  const url = await server.start(port, host);
  console.log(`Machiai server listening on ${url}`);
  console.log(`Set MACHIAI_SERVER_URL=${url}`);
}

function sessionsCommand(): void {
  const now = new Date();
  const state = loadState();
  const sessions = scanRegistry(now, state.waitSessions);
  const selector = state.referenceSelector ?? DEFAULT_REFERENCE_SELECTOR;
  const resolution = resolveReference(sessions, selector);

  if (sessions.length === 0) {
    console.log("No live agent sessions detected in the last 6 hours.");
    console.log("Start Claude Code or Codex, or run `machiai link` for exact hook-based detection.");
    return;
  }

  console.log(`Live agent sessions (${sessions.length}):\n`);
  for (const session of sessions) {
    const pin = resolution.matched?.id === session.id || resolution.idleMatch?.id === session.id ? "→" : " ";
    const place = [session.workspace ? basenameOf(session.workspace) : undefined, session.gitBranch]
      .filter(Boolean)
      .join(" @ ");
    console.log(
      `${pin} ${stateBadge(session.state)}  ${pad(session.agent, 7)} ${pad(session.surface, 9)} ` +
        `${pad(place, 22)} ${pad(session.title ?? "", 34)} ${formatAge(session.lastEventAt, now)}`,
    );
  }

  console.log(`\nWatching: ${describeSelector(selector)}`);
  if (resolution.matched) {
    console.log(`UNLOCKED — new game allowed (${resolution.matched.agent} is running).`);
  } else if (resolution.idleMatch) {
    console.log(`LOCKED — ${resolution.idleMatch.agent} finished its turn. Prompt it to unlock a new game.`);
  } else {
    console.log("LOCKED — no matching agent is running. Start/prompt an agent to unlock a new game.");
  }
  console.log("\nChange focus with: machiai watch [--auto | --agent codex|claude | --surface terminal|app | --session <id>]");
}

function watchCommand(args: string[]): void {
  let selector: ReferenceSelector | undefined;
  const sessionId = readOption(args, "--session");
  const agent = readOption(args, "--agent");
  const surface = readOption(args, "--surface");
  if (hasFlag(args, "--auto")) selector = { kind: "auto" };
  else if (sessionId) selector = { kind: "session", sessionId };
  else if (agent || surface) selector = { kind: "filter", agent: agent ?? "any", surface: normalizeSurface(surface) };

  if (!selector) {
    console.log("Usage: machiai watch [--auto | --agent codex|claude | --surface terminal|app | --session <id>]");
    console.log(`Current: ${describeSelector(loadState().referenceSelector ?? DEFAULT_REFERENCE_SELECTOR)}`);
    return;
  }
  setReferenceSelector(selector);
  console.log(`Now watching: ${describeSelector(selector)}`);
}

function linkCommand(): void {
  const summaries = linkHooks();
  console.log("Installed Machiai detection hooks (existing hooks were preserved):");
  for (const summary of summaries) {
    console.log(`  ${summary.agent}: ${summary.file} [${summary.events.join(", ")}]${summary.created ? " (created)" : ""}`);
  }
  console.log("\nNew Claude Code / Codex sessions now report start, prompt, and stop events to Machiai.");
  console.log("Undo any time with: machiai unlink");
}

function unlinkCommand(): void {
  const summaries = unlinkHooks();
  console.log("Removed Machiai detection hooks:");
  for (const summary of summaries) {
    console.log(`  ${summary.agent}: ${summary.file}`);
  }
}

function describeSelector(selector: ReferenceSelector): string {
  if (selector.kind === "auto") return "auto (the most recently active running session)";
  if (selector.kind === "session") return `session ${selector.sessionId}`;
  const agent = selector.agent && selector.agent !== "any" ? selector.agent : "any agent";
  const surface = selector.surface && selector.surface !== "any" ? selector.surface : "any surface";
  return `${agent} / ${surface}`;
}

function normalizeSurface(value: string | undefined): AgentSessionSummary["surface"] | "any" {
  if (value === "terminal" || value === "app") return value;
  return "any";
}

function stateBadge(state: AgentSessionSummary["state"]): string {
  if (state === "running") return "● running";
  if (state === "idle") return "○ idle   ";
  return "· ended  ";
}

function basenameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return clipped.padEnd(width);
}

function formatAge(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function mcpConfigCommand(): void {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          machiai: {
            command: "npx",
            args: ["-y", "@aizakmi08/machiai", "serve"],
          },
        },
      },
      null,
      2,
    ),
  );
}

function help(): void {
  console.log(`Machiai - chess for people waiting on AI agents.

Commands:
  machiai app [--dev-server <url>]  Open the floating desktop chess overlay
  machiai app --local               Open overlay with a private local server
  machiai run -- <command...>       Run an agent and unlock chess
  machiai run --overlay -- <cmd...> Run an agent and open the overlay
  machiai play                      Play only if a local wait session is active
  machiai sessions                  List live agent sessions and the current unlock focus
  machiai watch [--auto|--agent|--surface|--session]  Choose which session(s) unlock a new game
  machiai link                      Install exact detection hooks into Claude Code + Codex
  machiai unlink                    Remove Machiai detection hooks
  machiai profile [--name <name>] [--twitter <handle>]  Show or update anonymous profile
  machiai leaderboard               Show hosted leaderboard
  machiai demo                      Run a local two-client demo
  machiai server [--port 4137]      Start local matchmaking server
  machiai mcp-config                Print MCP config
  machiai serve                     Start MCP server

Examples:
  npx -y @aizakmi08/machiai app
  npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
  npx -y @aizakmi08/machiai run -- codex exec "build the feature"
  MACHIAI_SERVER_URL=http://127.0.0.1:4137 machiai run -- node fake-agent.js
`);
}
