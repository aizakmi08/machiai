import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { MachiaiServer } from "../apps/server/src/server.js";
import { createStore, JsonFileStore } from "../apps/server/src/store.js";
import { botMmrForPlayer, createDeviceKey, createId, STARTING_MMR, type GameState, type PlayerProfile, type PresenceState } from "../packages/shared/src/index.js";

test("two clients match, finish a rated game, and receive rating updates", async () => {
  const { server, url, store } = await startTestServer();
  const alice = signedPlayer("alice");
  const bob = { ...signedPlayer("bob"), twitterHandle: "bob_codes", displayName: "@bob_codes" };
  await store.upsertPlayer(alice);
  await store.upsertPlayer(bob);
  const a = await client(url, alice);
  const b = await client(url, bob);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", agent: "codex", active: true });
  await emitAck(b, "wait.heartbeat", { sessionId: "wait-b", agent: "claude", active: true });
  const started = onceSocket<GameState>(a, "game.started");
  await emitAck(a, "queue.join", { sessionId: "wait-a" });
  await emitAck(b, "queue.join", { sessionId: "wait-b" });
  const game = await started;
  assert.equal(game.whiteMmr, STARTING_MMR);
  assert.equal(game.blackMmr, STARTING_MMR);
  const bobTwitter = game.whitePlayerId === bob.playerId ? game.whiteTwitterHandle : game.blackTwitterHandle;
  assert.equal(bobTwitter, "bob_codes");
  const whiteSocket = game.whitePlayerId === alice.playerId ? a : b;
  const blackSocket = game.blackPlayerId === alice.playerId ? a : b;
  const rating = onceSocket<{ rating: { delta: number } }>(whiteSocket, "rating.updated");
  let next = (await emitAck(whiteSocket, "game.move", { gameId: game.gameId, move: "e2e4" })) as { game: GameState };
  next = (await emitAck(blackSocket, "game.move", { gameId: game.gameId, move: "e7e5" })) as { game: GameState };
  assert.equal(next.game.bothPlayersMoved, true);
  await emitAck(blackSocket, "game.resign", { gameId: game.gameId });
  const ratingPayload = await rating;
  assert.notEqual(ratingPayload.rating.delta, 0);
  a.disconnect();
  b.disconnect();
  await server.stop();
});

test("agent completion locks the next queue but does not pause current game", async () => {
  const { server, url, store } = await startTestServer();
  const alice = signedPlayer("alice");
  const bob = signedPlayer("bob");
  await store.upsertPlayer(alice);
  await store.upsertPlayer(bob);
  const a = await client(url, alice);
  const b = await client(url, bob);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", agent: "codex", active: true });
  await emitAck(b, "wait.heartbeat", { sessionId: "wait-b", agent: "claude", active: true });
  const started = onceSocket<GameState>(a, "game.started");
  await emitAck(a, "queue.join", { sessionId: "wait-a" });
  await emitAck(b, "queue.join", { sessionId: "wait-b" });
  const game = await started;
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", active: false });
  const whiteSocket = game.whitePlayerId === alice.playerId ? a : b;
  const response = (await emitAck(whiteSocket, "game.move", { gameId: game.gameId, move: "e2e4" })) as { game: GameState };
  assert.equal(response.game.moves.length, 1);
  await assert.rejects(() => emitAck(a, "queue.join", { sessionId: "wait-a" }), /Rated queue is locked/);
  a.disconnect();
  b.disconnect();
  await server.stop();
});

test("bot fallback starts an unrated game when lobby is empty", async () => {
  const { server, url, store } = await startTestServer({ botFallbackMs: 20, botMoveMs: 20 });
  const alice = signedPlayer("alice");
  await store.upsertPlayer(alice);
  const a = await client(url, alice);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", agent: "codex", active: true });
  const started = onceSocket<GameState>(a, "game.started");
  await emitAck(a, "queue.join", { sessionId: "wait-a" });
  const game = await started;
  assert.equal(game.mode, "bot");
  assert.equal(game.rated, false);
  assert.equal(game.whiteMmr, STARTING_MMR);
  assert.equal(game.blackMmr, botMmrForPlayer(STARTING_MMR));
  const botReply = waitForGameState(a, (state) => state.gameId === game.gameId && state.moves.length === 2);
  const response = (await emitAck(a, "game.move", { gameId: game.gameId, move: "e2e4" })) as { game: GameState };
  assert.equal(response.game.moves.length, 1);
  assert.equal(response.game.turn, "black");
  const afterBot = await botReply;
  assert.equal(afterBot.moves.length, 2);
  assert.equal(afterBot.turn, "white");
  assert.ok(afterBot.clocks.blackMs < response.game.clocks.blackMs);
  a.disconnect();
  await server.stop();
});

test("players can send in-game reactions and quick chat", async () => {
  const { server, url, store } = await startTestServer();
  const alice = signedPlayer("alice");
  const bob = signedPlayer("bob");
  await store.upsertPlayer(alice);
  await store.upsertPlayer(bob);
  const a = await client(url, alice);
  const b = await client(url, bob);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", agent: "codex", active: true });
  await emitAck(b, "wait.heartbeat", { sessionId: "wait-b", agent: "claude", active: true });
  const started = onceSocket<GameState>(a, "game.started");
  await emitAck(a, "queue.join", { sessionId: "wait-a" });
  await emitAck(b, "queue.join", { sessionId: "wait-b" });
  const game = await started;

  const reaction = onceSocket<{ gameId: string; reaction: string; playerId: string; handle: string; createdAt: string }>(b, "reaction.received");
  await emitAck(a, "reaction.send", { gameId: game.gameId, reaction: "💀" });
  const reactionPayload = await reaction;
  assert.equal(reactionPayload.gameId, game.gameId);
  assert.equal(reactionPayload.playerId, alice.playerId);
  assert.equal(reactionPayload.handle, "@alice");
  assert.equal(reactionPayload.reaction, "💀");

  const chat = onceSocket<{ message: string; playerId: string }>(a, "chat.received");
  await emitAck(b, "chat.send", { gameId: game.gameId, message: "gg after this?" });
  const chatPayload = await chat;
  assert.equal(chatPayload.playerId, bob.playerId);
  assert.equal(chatPayload.message, "gg after this?");

  a.disconnect();
  b.disconnect();
  await server.stop();
});

test("rated queue requires X login", async () => {
  const { server, url } = await startTestServer();
  const alice = player("alice");
  const a = await client(url, alice);
  await emitAck(a, "wait.heartbeat", { sessionId: "wait-a", agent: "codex", active: true });
  await assert.rejects(() => emitAck(a, "queue.join", { sessionId: "wait-a" }), /Sign in with X/);
  a.disconnect();
  await server.stop();
});

test("presence counts unique online players", async () => {
  const { server, url } = await startTestServer();
  const alice = player("alice");
  const bob = player("bob");
  const a = io(url, { transports: ["websocket", "polling"] });
  const aSecondWindow = io(url, { transports: ["websocket", "polling"] });
  const b = io(url, { transports: ["websocket", "polling"] });
  await Promise.all([onceSocket(a, "connect"), onceSocket(aSecondWindow, "connect"), onceSocket(b, "connect")]);

  const aliceOnline = onceSocket<PresenceState>(a, "presence.updated");
  await emitAck(a, "auth.anonymous", alice);
  assert.equal((await aliceOnline).onlinePlayers, 1);

  const bobOnline = onceSocket<PresenceState>(a, "presence.updated");
  await emitAck(b, "auth.anonymous", bob);
  assert.equal((await bobOnline).onlinePlayers, 2);

  const duplicateWindow = onceSocket<PresenceState>(a, "presence.updated");
  await emitAck(aSecondWindow, "auth.anonymous", alice);
  assert.equal((await duplicateWindow).onlinePlayers, 2);

  const bobOffline = onceSocket<PresenceState>(a, "presence.updated");
  b.disconnect();
  assert.equal((await bobOffline).onlinePlayers, 1);

  a.disconnect();
  aSecondWindow.disconnect();
  const emptyPresence = await waitForPresence(url, 0);
  assert.equal(emptyPresence.onlinePlayers, 0);
  await server.stop();
});

test("socket events are rate limited before they can spam the server", async () => {
  const { server, url } = await startTestServer();
  const alice = player("alice");
  const socket = io(url, { transports: ["websocket", "polling"] });
  await onceSocket(socket, "connect");
  for (let i = 0; i < 12; i++) {
    await emitAck(socket, "auth.anonymous", { ...alice, displayName: `alice-${i}` });
  }
  await assert.rejects(() => emitAck(socket, "auth.anonymous", alice), /Too many auth\.anonymous events/);
  socket.disconnect();
  await server.stop();
});

test("auth preserves existing server rating when client profile is stale", async () => {
  const store = new JsonFileStore();
  const server = new MachiaiServer({ store, botFallbackMs: 1000, reconnectGraceMs: 20 });
  const url = await server.start(0);
  const saved = { ...player("alice"), mmr: 640, ratedGames: 9 };
  await store.upsertPlayer(saved);

  const stale = { ...saved, displayName: "alice-new", mmr: STARTING_MMR, ratedGames: 0 };
  const socket = io(url, { transports: ["websocket", "polling"] });
  await onceSocket(socket, "connect");
  const response = (await emitAck(socket, "auth.anonymous", stale)) as { player: PlayerProfile };

  assert.equal(response.player.mmr, 640);
  assert.equal(response.player.ratedGames, 9);
  assert.equal(response.player.displayName, "alice-new");
  socket.disconnect();
  await server.stop();
});

test("profile update sanitizes and stores twitter handle", async () => {
  const { server, url } = await startTestServer();
  const alice = player("alice");
  const a = await client(url, alice);
  const response = (await emitAck(a, "profile.update", { twitterHandle: "https://twitter.com/alice_dev/status/1" })) as { player: PlayerProfile };
  assert.equal(response.player.twitterHandle, "alice_dev");
  a.disconnect();
  await server.stop();
});

test("public HTTP endpoints expose server status", async () => {
  const { server, url } = await startTestServer();
  const root = await fetch(new URL("/", url));
  const health = await fetch(new URL("/health", url));
  const presence = await fetch(new URL("/presence", url));
  const stats = await fetch(new URL("/stats", url));
  assert.equal(root.status, 200);
  assert.equal(health.status, 200);
  assert.equal(presence.status, 200);
  assert.equal(stats.status, 200);
  assert.equal(((await root.json()) as { service: string; stats: string }).service, "machiai");
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  assert.equal(((await presence.json()) as PresenceState).onlinePlayers, 0);
  const statsPayload = (await stats.json()) as { ok: boolean; sockets: number; onlinePlayers: number; queuedPlayers: number };
  assert.equal(statsPayload.ok, true);
  assert.equal(statsPayload.onlinePlayers, 0);
  assert.equal(statsPayload.queuedPlayers, 0);
  await server.stop();
});

test("default store persists players across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "machiai-store-"));
  const storePath = join(dir, "server-store.sqlite");
  const store = await createStore(storePath);
  const alice = player("alice");
  await store.upsertPlayer(alice);
  await store.close();

  const reopened = await createStore(storePath);
  const saved = await reopened.getPlayer(alice.playerId);
  assert.equal(saved?.mmr, STARTING_MMR);
  assert.equal(saved?.handle, "alice");
  await reopened.close();
});

test("store rating finalization claims are idempotent", async () => {
  const store = new JsonFileStore();
  await store.init();
  assert.equal(await store.tryClaimRatingFinalization("game_once", new Date().toISOString()), true);
  assert.equal(await store.tryClaimRatingFinalization("game_once", new Date().toISOString()), false);
  await store.close();
});

test("postgres store driver requires DATABASE_URL", async () => {
  const previousDriver = process.env.MACHIAI_STORE_DRIVER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.MACHIAI_STORE_DRIVER = "postgres";
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(() => createStore(), /DATABASE_URL is required/);
  } finally {
    if (previousDriver === undefined) delete process.env.MACHIAI_STORE_DRIVER;
    else process.env.MACHIAI_STORE_DRIVER = previousDriver;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

async function startTestServer(options: { botFallbackMs?: number; botMoveMs?: number } = {}) {
  const store = new JsonFileStore();
  const server = new MachiaiServer({
    store,
    botFallbackMs: options.botFallbackMs ?? 1000,
    botMoveMs: options.botMoveMs ?? 20,
    reconnectGraceMs: 20,
  });
  const url = await server.start(0);
  return { server, url, store };
}

function player(displayName: string): PlayerProfile {
  const now = new Date().toISOString();
  return {
    playerId: createId(displayName),
    deviceKey: createDeviceKey(),
    handle: displayName,
    displayName,
    mmr: STARTING_MMR,
    ratedGames: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function signedPlayer(displayName: string): PlayerProfile {
  const base = player(displayName);
  return {
    ...base,
    displayName: `@${displayName}`,
    twitterHandle: displayName,
    xUserId: `x_${displayName}`,
    authToken: `test_token_${displayName}`,
  };
}

async function client(url: string, profile: PlayerProfile): Promise<Socket> {
  const socket = io(url, { transports: ["websocket", "polling"] });
  await onceSocket(socket, "connect");
  await emitAck(socket, "auth.anonymous", profile);
  return socket;
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error: Error | null, response: { ok?: boolean; error?: { message: string } }) => {
      if (error) reject(error);
      else if (response?.ok === false) reject(new Error(response.error?.message ?? `${event} failed`));
      else resolve(response);
    });
  });
}

function onceSocket<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (...args: unknown[]) => void));
}

function waitForGameState(socket: Socket, predicate: (state: GameState) => boolean): Promise<GameState> {
  return new Promise((resolve) => {
    const onState = (state: GameState) => {
      if (!predicate(state)) return;
      socket.off("game.state", onState);
      resolve(state);
    };
    socket.on("game.state", onState);
  });
}

async function waitForPresence(url: string, expectedOnlinePlayers: number): Promise<PresenceState> {
  let last: PresenceState | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(new URL("/presence", url));
    last = (await response.json()) as PresenceState;
    if (last.onlinePlayers === expectedOnlinePlayers) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return last ?? { onlinePlayers: -1, updatedAt: new Date().toISOString() };
}
