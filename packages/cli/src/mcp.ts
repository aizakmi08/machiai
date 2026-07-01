#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyMove, chooseBotMove, resignGame } from "../../shared/src/index.js";
import {
  activeLocalWaitSession,
  createLocalBotGame,
  createLocalWaitSession,
  endLocalWaitSession,
  loadState,
  upsertLocalGame,
} from "./local.js";

const server = new McpServer({
  name: "machiai",
  version: "0.1.0",
});

server.registerTool(
  "machiai_start_wait",
  {
    title: "Start Machiai wait",
    description: "Start an active wait session while an AI coding agent is running.",
    inputSchema: {
      agent: z.string(),
      workspace: z.string().optional(),
      goal: z.string().optional(),
    },
  },
  async ({ agent, workspace, goal }) => {
    const session = createLocalWaitSession({ agent, workspace, goal });
    return textResult(JSON.stringify({ session_id: session.sessionId, session }, null, 2));
  },
);

server.registerTool(
  "machiai_end_wait",
  {
    title: "End Machiai wait",
    description: "Mark a Machiai wait session complete. New rated games are locked after this.",
    inputSchema: {
      session_id: z.string(),
    },
  },
  async ({ session_id: sessionId }) => {
    const session = endLocalWaitSession(sessionId);
    return textResult(JSON.stringify({ session_id: sessionId, session }, null, 2));
  },
);

server.registerTool(
  "machiai_status",
  {
    title: "Machiai status",
    description: "Show local profile, active wait session, and recent games.",
    inputSchema: {
      session_id: z.string().optional(),
    },
  },
  async ({ session_id: sessionId }) => {
    const state = loadState();
    const wait = sessionId ? state.waitSessions.find((session) => session.sessionId === sessionId) : activeLocalWaitSession();
    return textResult(
      JSON.stringify(
        {
          profile: state.profile,
          active_wait: wait,
          recent_games: state.games.slice(-5),
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "machiai_join_queue",
  {
    title: "Join Machiai queue",
    description: "Join a Machiai game for an active wait session. MCP V1 starts an unrated bot game.",
    inputSchema: {
      session_id: z.string(),
    },
  },
  async ({ session_id: sessionId }) => {
    const game = createLocalBotGame(sessionId);
    return textResult(JSON.stringify({ game_id: game.gameId, game }, null, 2));
  },
);

server.registerTool(
  "machiai_make_move",
  {
    title: "Make Machiai move",
    description: "Make a chess move in SAN or UCI notation. Bot replies automatically in MCP V1.",
    inputSchema: {
      game_id: z.string(),
      move: z.string(),
    },
  },
  async ({ game_id: gameId, move }) => {
    const state = loadState();
    const game = state.games.find((item) => item.gameId === gameId);
    if (!game) throw new Error(`Unknown game: ${gameId}`);
    let next = applyMove(game, state.profile.playerId, move).game;
    if (next.status === "active") {
      next = applyMove(next, next.blackPlayerId, chooseBotMove(next.fen)).game;
    }
    upsertLocalGame(next);
    return textResult(JSON.stringify({ game_id: gameId, game: next }, null, 2));
  },
);

server.registerTool(
  "machiai_resign",
  {
    title: "Resign Machiai game",
    description: "Resign a local Machiai game.",
    inputSchema: {
      game_id: z.string(),
    },
  },
  async ({ game_id: gameId }) => {
    const state = loadState();
    const game = state.games.find((item) => item.gameId === gameId);
    if (!game) throw new Error(`Unknown game: ${gameId}`);
    const next = resignGame(game, state.profile.playerId);
    upsertLocalGame(next);
    return textResult(JSON.stringify({ game_id: gameId, game: next }, null, 2));
  },
);

server.registerTool(
  "machiai_leaderboard",
  {
    title: "Machiai leaderboard",
    description: "Show local profile as a leaderboard-compatible entry.",
    inputSchema: {
      limit: z.number().optional(),
    },
  },
  async () => {
    const { profile } = loadState();
    return textResult(
      JSON.stringify(
        {
          entries: [
            {
              playerId: profile.playerId,
              handle: profile.handle,
              displayName: profile.displayName,
              mmr: profile.mmr,
              ratedGames: profile.ratedGames,
            },
          ],
        },
        null,
        2,
      ),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}
