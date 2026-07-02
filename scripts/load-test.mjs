#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { io } from "socket.io-client";

const args = parseArgs(process.argv.slice(2));
const clientsTarget = numberArg(args.clients, 1000);
const matchesTarget = Math.min(numberArg(args.matches, 50), Math.floor(clientsTarget / 2));
const churnTarget = Math.min(numberArg(args.churn, 100), clientsTarget);
const batchSize = numberArg(args.batch, 100);
const ackTimeoutMs = numberArg(args.ackTimeoutMs, 8000);

const { MachiaiServer } = await import("../dist/apps/server/src/server.js");
const { JsonFileStore } = await import("../dist/apps/server/src/store.js");
const { STARTING_MMR, createDeviceKey, createId } = await import("../dist/packages/shared/src/index.js");

const store = new JsonFileStore();
const server = new MachiaiServer({
  store,
  botFallbackMs: 120_000,
  botMoveMs: 50,
  reconnectGraceMs: 5_000,
});

const sockets = [];
const profiles = Array.from({ length: clientsTarget }, (_, index) => signedProfile(index));
const moveLatencies = [];
const start = performance.now();

try {
  for (const profile of profiles) await store.upsertPlayer(profile);
  const url = await server.start(0);
  console.log(`Machiai load test server: ${url}`);
  console.log(`clients=${clientsTarget} matches=${matchesTarget} churn=${churnTarget} batch=${batchSize}`);

  for (let index = 0; index < profiles.length; index += batchSize) {
    const batch = profiles.slice(index, index + batchSize);
    const connected = await Promise.all(batch.map((profile) => connectAndAuth(url, profile)));
    sockets.push(...connected);
    process.stdout.write(`\rconnected ${sockets.length}/${clientsTarget}`);
  }
  process.stdout.write("\n");

  await Promise.all(
    sockets.map((socket, index) =>
      emitAck(socket, "wait.heartbeat", {
        sessionId: `load_wait_${index}`,
        agent: "load-agent",
        active: true,
      }),
    ),
  );

  const presenceBefore = await getJson(new URL("/presence", url));
  assertEqual(presenceBefore.onlinePlayers, clientsTarget, "presence onlinePlayers");

  const participants = sockets.slice(0, matchesTarget * 2);
  const started = participants.map((socket) => onceSocket(socket, "game.started"));
  await Promise.all(participants.map((socket, index) => emitAck(socket, "queue.join", { sessionId: `load_wait_${index}` })));
  const startedEvents = await Promise.all(started);
  const games = uniqueGames(startedEvents).slice(0, matchesTarget);
  assertEqual(games.length, matchesTarget, "matched games");

  const socketsByPlayer = new Map(sockets.map((socket, index) => [profiles[index].playerId, socket]));
  for (const game of games) {
    const white = socketsByPlayer.get(game.whitePlayerId);
    const black = socketsByPlayer.get(game.blackPlayerId);
    if (!white || !black) throw new Error(`Missing socket for game ${game.gameId}`);
    const moveStart = performance.now();
    const first = await emitAck(white, "game.move", { gameId: game.gameId, move: "e2e4" });
    const second = await emitAck(black, "game.move", { gameId: game.gameId, move: "e7e5" });
    moveLatencies.push(performance.now() - moveStart);
    if (first.game.moves.length !== 1 || second.game.moves.length !== 2) throw new Error(`Unexpected move count in game ${game.gameId}`);
  }

  const churnSockets = sockets.splice(0, churnTarget);
  for (const socket of churnSockets) socket.disconnect();
  await sleep(150);
  const reconnected = await Promise.all(profiles.slice(0, churnTarget).map((profile) => connectAndAuth(url, profile)));
  sockets.unshift(...reconnected);

  const [presenceAfter, stats, leaderboard] = await Promise.all([getJson(new URL("/presence", url)), getJson(new URL("/stats", url)), getJson(new URL("/leaderboard", url))]);
  assertEqual(presenceAfter.onlinePlayers, clientsTarget, "presence after churn");
  assertEqual(stats.onlinePlayers, clientsTarget, "stats onlinePlayers");
  if (!Array.isArray(leaderboard.entries)) throw new Error("leaderboard entries missing");

  const elapsedMs = performance.now() - start;
  console.log(JSON.stringify(
    {
      ok: true,
      clients: clientsTarget,
      matches: games.length,
      churned: churnTarget,
      elapsedMs: Math.round(elapsedMs),
      moveLatencyMs: latencySummary(moveLatencies),
      stats: {
        sockets: stats.sockets,
        onlinePlayers: stats.onlinePlayers,
        queuedPlayers: stats.queuedPlayers,
        gameTimeoutTimers: stats.gameTimeoutTimers,
        redisAdapter: stats.redisAdapter,
      },
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    null,
    2,
  ));
} finally {
  for (const socket of sockets) socket.disconnect();
  await server.stop();
}

function parseArgs(items) {
  const parsed = {};
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=");
    parsed[key] = inline ?? items[++index];
  }
  return parsed;
}

function numberArg(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : fallback;
}

function signedProfile(index) {
  const now = new Date().toISOString();
  const handle = `load${index}`;
  return {
    playerId: createId(`load_${index}`),
    deviceKey: createDeviceKey(),
    handle,
    displayName: `@${handle}`,
    twitterHandle: handle,
    xUserId: `x_${handle}`,
    authToken: `test_token_${handle}`,
    mmr: STARTING_MMR + (index % 200),
    ratedGames: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function connectAndAuth(url, profile) {
  const socket = io(url, {
    transports: ["websocket"],
    timeout: ackTimeoutMs,
    reconnection: false,
    forceNew: true,
  });
  await onceSocket(socket, "connect");
  await emitAck(socket, "auth.anonymous", profile);
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(ackTimeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else if (response?.ok === false) reject(new Error(response.error?.message ?? `${event} failed`));
      else resolve(response);
    });
  });
}

function onceSocket(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ackTimeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} failed: ${response.status}`);
  return response.json();
}

function uniqueGames(events) {
  const seen = new Map();
  for (const game of events) seen.set(game.gameId, game);
  return [...seen.values()];
}

function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
