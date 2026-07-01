import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { io, type Socket } from "socket.io-client";
import { formatGameLine, renderBoard, type GameState, type PlayerProfile, type WaitSession } from "../../shared/src/index.js";
import { printAgentFinished } from "./ui.js";

export interface OnlinePlayOptions {
  serverUrl: string;
  profile: PlayerProfile;
  waitSession: WaitSession;
  ascii?: boolean;
  agentDone?: Promise<unknown>;
}

export async function playOnline(options: OnlinePlayOptions): Promise<void> {
  const socket = io(options.serverUrl, { transports: ["websocket", "polling"], timeout: 5000 });
  await onceConnect(socket);
  await emitAck(socket, "auth.anonymous", options.profile);
  await emitAck(socket, "wait.heartbeat", {
    sessionId: options.waitSession.sessionId,
    agent: options.waitSession.agent,
    workspace: options.waitSession.workspace,
    goal: options.waitSession.goal,
    active: true,
  });

  const heartbeat = setInterval(() => {
    socket.emit("wait.heartbeat", { sessionId: options.waitSession.sessionId, active: true });
  }, 5000);

  options.agentDone?.then(() => {
    clearInterval(heartbeat);
    socket.emit("wait.heartbeat", { sessionId: options.waitSession.sessionId, active: false });
    printAgentFinished();
  });

  let game: GameState | undefined;
  let ended = false;
  socket.on("queue.status", (status) => {
    console.log(`Queue: ${status.status} (${status.playersWaiting} waiting)`);
  });
  socket.on("wait.locked", (payload) => {
    console.log(payload.message);
  });
  socket.on("game.started", (next: GameState) => {
    game = next;
    renderOnlineGame(next, options.profile.playerId, options.ascii);
  });
  socket.on("game.state", (next: GameState) => {
    game = next;
    renderOnlineGame(next, options.profile.playerId, options.ascii);
    if (next.status === "ended") ended = true;
  });
  socket.on("game.ended", (next: GameState) => {
    game = next;
    ended = true;
    renderOnlineGame(next, options.profile.playerId, options.ascii);
  });
  socket.on("rating.updated", (payload) => {
    console.log(`Rating: ${payload.rating.oldMmr} -> ${payload.rating.newMmr} (${payload.rating.delta >= 0 ? "+" : ""}${payload.rating.delta})`);
  });

  await emitAck(socket, "queue.join", { sessionId: options.waitSession.sessionId });
  const rl = readline.createInterface({ input, output });
  try {
    while (!ended) {
      const answer = (await rl.question("> ")).trim();
      if (!answer) continue;
      if (!game) {
        console.log("Still searching for a match.");
        continue;
      }
      if (answer.toLowerCase() === "resign") {
        await emitAck(socket, "game.resign", { gameId: game.gameId });
      } else {
        await emitAck(socket, "game.move", { gameId: game.gameId, move: answer });
      }
    }
  } finally {
    clearInterval(heartbeat);
    rl.close();
    socket.disconnect();
  }
}

export async function fetchLeaderboard(serverUrl: string): Promise<unknown> {
  const response = await fetch(new URL("/leaderboard", serverUrl));
  if (!response.ok) throw new Error(`Leaderboard request failed: ${response.status}`);
  return response.json();
}

function renderOnlineGame(game: GameState, playerId: string, ascii = false): void {
  console.clear();
  console.log(formatGameLine(game, playerId));
  console.log("");
  console.log(renderBoard(game.fen, playerId === game.blackPlayerId ? "black" : "white", ascii));
  console.log("");
}

function onceConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error: Error | null, response: { ok?: boolean; error?: { message: string } }) => {
      if (error) reject(error);
      else if (response?.ok === false) reject(new Error(response.error?.message ?? `${event} failed`));
      else resolve(response);
    });
  });
}
