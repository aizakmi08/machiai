#!/usr/bin/env node
import { resolve } from "node:path";
import { MachiaiServer } from "../../../apps/server/src/server.js";
import { startOverlayApp } from "./app.js";
import { startAgent } from "./agent.js";
import { parseCommandAfterDoubleDash, hasFlag, readOption, serverUrl } from "./config.js";
import { runDemo } from "./demo.js";
import { renderInkBanner } from "./ink-banner.js";
import { activeLocalWaitSession, createLocalBotGame, createLocalWaitSession, endLocalWaitSession, loadState, statePath, updateProfile } from "./local.js";
import { fetchLeaderboard, playOnline } from "./online.js";
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
  const wait = createLocalWaitSession({ agent: agentCommand, workspace: process.cwd(), goal: agentArgs.join(" ") || undefined });
  const transcriptTail: string[] = [];
  const agent = startAgent(agentCommand, agentArgs, (chunk) => {
    for (const line of chunk.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      transcriptTail.push(line);
      if (transcriptTail.length > 12) transcriptTail.shift();
    }
  });
  const agentDone = agent.done.then((result) => {
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
