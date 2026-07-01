import { io } from "socket.io-client";
import { MachiaiServer } from "../../../apps/server/src/server.js";
import { createDeviceKey, createHandle, createId, STARTING_MMR, type GameState, type PlayerProfile } from "../../shared/src/index.js";
import { JsonFileStore } from "../../../apps/server/src/store.js";

export async function runDemo(): Promise<void> {
  const server = new MachiaiServer({ store: new JsonFileStore(), botFallbackMs: 250 });
  const url = await server.start(0);
  console.log(`Machiai demo server: ${url}`);

  const alice = createDemoPlayer("alice");
  const bob = createDemoPlayer("bob");
  const a = io(url, { transports: ["websocket", "polling"] });
  const b = io(url, { transports: ["websocket", "polling"] });
  await Promise.all([onceSocket(a, "connect"), onceSocket(b, "connect")]);
  await emitAck(a, "auth.anonymous", alice);
  await emitAck(b, "auth.anonymous", bob);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait_alice", agent: "codex", active: true });
  await emitAck(b, "wait.heartbeat", { sessionId: "wait_bob", agent: "claude", active: true });

  const gamePromise = new Promise<GameState>((resolve) => {
    a.once("game.started", (game) => resolve(game));
  });
  await emitAck(a, "queue.join", { sessionId: "wait_alice" });
  await emitAck(b, "queue.join", { sessionId: "wait_bob" });
  let game = await gamePromise;
  console.log(`Matched: ${game.whiteHandle} vs ${game.blackHandle}`);
  const white = game.whitePlayerId === alice.playerId ? a : b;
  const black = game.blackPlayerId === alice.playerId ? a : b;

  game = await move(white, game.gameId, "e2e4");
  game = await move(black, game.gameId, "e7e5");
  game = await move(white, game.gameId, "g1f3");
  game = await move(black, game.gameId, "b8c6");
  await emitAck(black, "game.resign", { gameId: game.gameId });
  console.log("Demo finished: black resigned after four plies.");

  a.disconnect();
  b.disconnect();
  await server.stop();
}

function createDemoPlayer(name: string): PlayerProfile {
  const now = new Date().toISOString();
  return {
    playerId: createId(name),
    deviceKey: createDeviceKey(),
    handle: createHandle(),
    displayName: name,
    mmr: STARTING_MMR,
    ratedGames: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function move(socket: ReturnType<typeof io>, gameId: string, moveInput: string): Promise<GameState> {
  const response = (await emitAck(socket, "game.move", { gameId, move: moveInput })) as { game: GameState };
  return response.game;
}

function emitAck(socket: ReturnType<typeof io>, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error: Error | null, response: { ok?: boolean; error?: { message: string } }) => {
      if (error) reject(error);
      else if (response?.ok === false) reject(new Error(response.error?.message ?? `${event} failed`));
      else resolve(response);
    });
  });
}

function onceSocket<T = unknown>(socket: ReturnType<typeof io>, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (...args: unknown[]) => void));
}
