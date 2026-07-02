import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server as SocketServer, type Socket } from "socket.io";
import {
  BOT_FALLBACK_MS,
  RECONNECT_GRACE_MS,
  STARTING_MMR,
  abortGame,
  applyMove,
  calculateRating,
  chooseBotMove,
  createGame,
  createHandle,
  createId,
  resignGame,
  tickClock,
  type GameState,
  type PlayerProfile,
  type PresenceState,
  type QueueTicket,
  type WaitSession,
} from "../../../packages/shared/src/index.js";
import { createStore, type MachiaiStore } from "./store.js";

export interface MachiaiServerOptions {
  store?: MachiaiStore;
  storePath?: string;
  botFallbackMs?: number;
  botMoveMs?: number;
  reconnectGraceMs?: number;
}

export class MachiaiServer {
  readonly http: HttpServer;
  readonly io: SocketServer;
  private store?: MachiaiStore;
  private readonly queue: QueueTicket[] = [];
  private readonly finalizedRatings = new Set<string>();
  private readonly socketsByPlayer = new Map<string, Set<string>>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly botTimers = new Map<string, NodeJS.Timeout>();
  private readonly botMoveTimers = new Map<string, NodeJS.Timeout>();
  private readonly botFallbackMs: number;
  private readonly botMoveMs: number;
  private readonly reconnectGraceMs: number;

  constructor(private readonly options: MachiaiServerOptions = {}) {
    this.http = createServer((req, res) => {
      void this.handleHttp(req.url ?? "/", res);
    });
    this.io = new SocketServer(this.http, {
      cors: { origin: "*" },
    });
    this.botFallbackMs = options.botFallbackMs ?? BOT_FALLBACK_MS;
    this.botMoveMs = options.botMoveMs ?? 650;
    this.reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  }

  async start(port = 4137, host = "127.0.0.1"): Promise<string> {
    this.store = this.options.store ?? (await createStore(this.options.storePath));
    this.registerSocketHandlers();
    await new Promise<void>((resolve) => this.http.listen(port, host, resolve));
    const address = this.http.address() as AddressInfo;
    return `http://${address.address}:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const timer of this.botTimers.values()) clearTimeout(timer);
    for (const timer of this.botMoveTimers.values()) clearTimeout(timer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.store?.close();
  }

  private registerSocketHandlers(): void {
    this.io.on("connection", (socket) => {
      socket.on("auth.anonymous", (payload, ack) => void this.onAuth(socket, payload, ack));
      socket.on("profile.update", (payload, ack) => void this.onProfileUpdate(socket, payload, ack));
      socket.on("wait.heartbeat", (payload, ack) => void this.onWaitHeartbeat(socket, payload, ack));
      socket.on("queue.join", (payload, ack) => void this.onQueueJoin(socket, payload, ack));
      socket.on("queue.leave", (_payload, ack) => void this.onQueueLeave(socket, ack));
      socket.on("game.move", (payload, ack) => void this.onGameMove(socket, payload, ack));
      socket.on("game.resign", (payload, ack) => void this.onGameResign(socket, payload, ack));
      socket.on("reaction.send", (payload, ack) => void this.onReactionSend(socket, payload, ack));
      socket.on("chat.send", (payload, ack) => void this.onChatSend(socket, payload, ack));
      socket.on("disconnect", () => void this.onDisconnect(socket));
    });
  }

  private async onAuth(socket: Socket, payload: Partial<PlayerProfile>, ack?: (value: unknown) => void): Promise<void> {
    const now = new Date().toISOString();
    const playerId = payload.playerId ?? createId("player");
    const existing = await this.requiredStore().getPlayer(playerId);
    const player: PlayerProfile = {
      playerId,
      deviceKey: payload.deviceKey ?? existing?.deviceKey ?? createId("device"),
      handle: payload.handle ?? existing?.handle ?? createHandle(),
      displayName: payload.displayName ?? existing?.displayName,
      mmr: existing?.mmr ?? payload.mmr ?? STARTING_MMR,
      ratedGames: existing?.ratedGames ?? payload.ratedGames ?? 0,
      createdAt: existing?.createdAt ?? payload.createdAt ?? now,
      updatedAt: now,
    };
    await this.requiredStore().upsertPlayer(player);
    const previousPlayerId = socket.data.playerId as string | undefined;
    if (previousPlayerId && previousPlayerId !== player.playerId) {
      this.untrackSocket(previousPlayerId, socket.id);
      socket.leave(`player:${previousPlayerId}`);
    }
    socket.data.playerId = player.playerId;
    socket.join(`player:${player.playerId}`);
    this.trackSocket(player.playerId, socket.id);
    this.clearDisconnectTimer(player.playerId);
    socket.emit("auth.ready", player);
    const presence = this.broadcastPresence();
    ack?.({ ok: true, player, presence });
  }

  private async onProfileUpdate(socket: Socket, payload: { displayName?: string; handle?: string }, ack?: (value: unknown) => void) {
    const player = await this.requireSocketPlayer(socket);
    const updated = {
      ...player,
      displayName: payload.displayName ?? player.displayName,
      handle: payload.handle ?? player.handle,
      updatedAt: new Date().toISOString(),
    };
    await this.requiredStore().upsertPlayer(updated);
    socket.emit("auth.ready", updated);
    ack?.({ ok: true, player: updated });
  }

  private async onWaitHeartbeat(
    socket: Socket,
    payload: { sessionId?: string; agent?: string; workspace?: string; goal?: string; active?: boolean },
    ack?: (value: unknown) => void,
  ): Promise<void> {
    const player = await this.requireSocketPlayer(socket);
    const now = new Date().toISOString();
    const existing = payload.sessionId ? await this.requiredStore().getWaitSession(payload.sessionId) : undefined;
    const session: WaitSession = {
      sessionId: existing?.sessionId ?? payload.sessionId ?? createId("wait"),
      playerId: player.playerId,
      agent: payload.agent ?? existing?.agent ?? "agent",
      workspace: payload.workspace ?? existing?.workspace,
      goal: payload.goal ?? existing?.goal,
      active: payload.active ?? true,
      startedAt: existing?.startedAt ?? now,
      endedAt: payload.active === false ? now : existing?.endedAt,
      lastHeartbeatAt: now,
    };
    await this.requiredStore().upsertWaitSession(session);
    ack?.({ ok: true, session });
  }

  private async onQueueJoin(socket: Socket, payload: { sessionId: string }, ack?: (value: unknown) => void): Promise<void> {
    const player = await this.requireSocketPlayer(socket);
    const session = await this.requiredStore().getWaitSession(payload.sessionId);
    if (!session || !session.active || session.playerId !== player.playerId) {
      const locked = { code: "wait_required", message: "Rated queue is locked until an agent is running." };
      socket.emit("wait.locked", locked);
      ack?.({ ok: false, error: locked });
      return;
    }
    if (!this.queue.some((ticket) => ticket.playerId === player.playerId)) {
      this.queue.push({
        playerId: player.playerId,
        handle: player.displayName || player.handle,
        mmr: player.mmr,
        sessionId: session.sessionId,
        joinedAt: new Date().toISOString(),
        socketId: socket.id,
      });
    }
    socket.emit("queue.status", { status: "searching", playersWaiting: this.queue.length });
    ack?.({ ok: true });
    await this.tryMatch();
    this.scheduleBotFallback(player.playerId);
  }

  private async onQueueLeave(socket: Socket, ack?: (value: unknown) => void): Promise<void> {
    const playerId = socket.data.playerId as string | undefined;
    if (playerId) this.removeFromQueue(playerId);
    ack?.({ ok: true });
  }

  private async onGameMove(socket: Socket, payload: { gameId: string; move: string }, ack?: (value: unknown) => void): Promise<void> {
    try {
      const player = await this.requireSocketPlayer(socket);
      const game = await this.requireGame(payload.gameId);
      const { game: next } = applyMove(game, player.playerId, payload.move);
      await this.requiredStore().upsertGame(next);
      this.io.to(`game:${next.gameId}`).emit("game.state", next);
      await this.finalizeGameIfNeeded(next);
      if (next.mode === "bot" && next.status === "active" && next.turn === "black") {
        this.scheduleBotMove(next.gameId);
      }
      ack?.({ ok: true, game: next });
    } catch (error) {
      this.emitError(socket, error, ack);
    }
  }

  private async onGameResign(socket: Socket, payload: { gameId: string }, ack?: (value: unknown) => void): Promise<void> {
    try {
      const player = await this.requireSocketPlayer(socket);
      const game = await this.requireGame(payload.gameId);
      const next = resignGame(game, player.playerId);
      this.clearBotMove(next.gameId);
      await this.requiredStore().upsertGame(next);
      this.io.to(`game:${next.gameId}`).emit("game.ended", next);
      await this.finalizeGameIfNeeded(next);
      ack?.({ ok: true, game: next });
    } catch (error) {
      this.emitError(socket, error, ack);
    }
  }

  private async onReactionSend(socket: Socket, payload: { gameId: string; reaction: string }, ack?: (value: unknown) => void): Promise<void> {
    try {
      const player = await this.requireSocketPlayer(socket);
      const game = await this.requireGame(payload.gameId);
      this.assertPlayerInGame(game, player.playerId);
      const reaction = String(payload.reaction ?? "").trim().slice(0, 4);
      if (!reaction) throw new Error("Reaction is empty.");
      this.io.to(`game:${game.gameId}`).emit("reaction.received", {
        gameId: game.gameId,
        playerId: player.playerId,
        handle: player.displayName || player.handle,
        reaction,
        createdAt: new Date().toISOString(),
      });
      ack?.({ ok: true });
    } catch (error) {
      this.emitError(socket, error, ack);
    }
  }

  private async onChatSend(socket: Socket, payload: { gameId: string; message: string }, ack?: (value: unknown) => void): Promise<void> {
    try {
      const player = await this.requireSocketPlayer(socket);
      const game = await this.requireGame(payload.gameId);
      this.assertPlayerInGame(game, player.playerId);
      const message = String(payload.message ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!message) throw new Error("Message is empty.");
      this.io.to(`game:${game.gameId}`).emit("chat.received", {
        gameId: game.gameId,
        playerId: player.playerId,
        handle: player.displayName || player.handle,
        message,
        createdAt: new Date().toISOString(),
      });
      ack?.({ ok: true });
    } catch (error) {
      this.emitError(socket, error, ack);
    }
  }

  private async onDisconnect(socket: Socket): Promise<void> {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return;
    this.untrackSocket(playerId, socket.id);
    this.broadcastPresence();
    this.removeFromQueue(playerId);
    if ((this.socketsByPlayer.get(playerId)?.size ?? 0) > 0) return;
    const timer = setTimeout(() => void this.forfeitActiveGames(playerId), this.reconnectGraceMs);
    timer.unref?.();
    this.disconnectTimers.set(playerId, timer);
  }

  private async tryMatch(): Promise<void> {
    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i];
      for (let j = i + 1; j < this.queue.length; j++) {
        const b = this.queue[j];
        if (a.playerId === b.playerId) continue;
        const elapsed = Math.max(Date.now() - Date.parse(a.joinedAt), Date.now() - Date.parse(b.joinedAt));
        const range = 100 + Math.floor(elapsed / 1000) * 25;
        if (Math.abs(a.mmr - b.mmr) > range) continue;
        this.queue.splice(j, 1);
        this.queue.splice(i, 1);
        await this.startHumanGame(a, b);
        return this.tryMatch();
      }
    }
  }

  private async startHumanGame(a: QueueTicket, b: QueueTicket): Promise<GameState> {
    this.clearBotFallback(a.playerId);
    this.clearBotFallback(b.playerId);
    const flip = Math.random() >= 0.5;
    const white = flip ? a : b;
    const black = flip ? b : a;
    const game = createGame({
      mode: "rated",
      whitePlayerId: white.playerId,
      blackPlayerId: black.playerId,
      whiteHandle: white.handle,
      blackHandle: black.handle,
    });
    await this.requiredStore().upsertGame(game);
    this.io.sockets.sockets.get(white.socketId)?.join(`game:${game.gameId}`);
    this.io.sockets.sockets.get(black.socketId)?.join(`game:${game.gameId}`);
    this.io.to(`game:${game.gameId}`).emit("game.started", game);
    this.io.to(`game:${game.gameId}`).emit("game.state", game);
    return game;
  }

  private async startBotGame(ticket: QueueTicket): Promise<GameState | undefined> {
    const index = this.queue.findIndex((queued) => queued.playerId === ticket.playerId);
    if (index === -1) return undefined;
    this.queue.splice(index, 1);
    const game = createGame({
      mode: "bot",
      whitePlayerId: ticket.playerId,
      blackPlayerId: "bot",
      whiteHandle: ticket.handle,
      blackHandle: "Machiai Bot",
    });
    await this.requiredStore().upsertGame(game);
    this.io.sockets.sockets.get(ticket.socketId)?.join(`game:${game.gameId}`);
    this.io.to(`game:${game.gameId}`).emit("game.started", game);
    this.io.to(`game:${game.gameId}`).emit("game.state", game);
    return game;
  }

  private scheduleBotFallback(playerId: string): void {
    this.clearBotFallback(playerId);
    const timer = setTimeout(() => {
      const ticket = this.queue.find((queued) => queued.playerId === playerId);
      if (ticket) void this.startBotGame(ticket);
    }, this.botFallbackMs);
    timer.unref?.();
    this.botTimers.set(playerId, timer);
  }

  private scheduleBotMove(gameId: string): void {
    this.clearBotMove(gameId);
    const timer = setTimeout(() => void this.playBotMove(gameId), this.botMoveMs);
    timer.unref?.();
    this.botMoveTimers.set(gameId, timer);
  }

  private async playBotMove(gameId: string): Promise<void> {
    this.botMoveTimers.delete(gameId);
    const current = await this.requiredStore().getGame(gameId);
    if (!current || current.status !== "active" || current.mode !== "bot" || current.turn !== "black") return;
    const now = new Date();
    let next = tickClock(current, now);
    if (next.status === "active") {
      next = applyMove(next, next.blackPlayerId, chooseBotMove(next.fen), now).game;
    }
    await this.requiredStore().upsertGame(next);
    this.io.to(`game:${next.gameId}`).emit(next.status === "ended" ? "game.ended" : "game.state", next);
    await this.finalizeGameIfNeeded(next);
  }

  private async finalizeGameIfNeeded(game: GameState): Promise<void> {
    if (game.status !== "ended") return;
    this.clearBotMove(game.gameId);
    const eventName = game.endReason === "resignation" || game.endReason === "timeout" || game.endReason === "disconnect" ? "game.ended" : "game.state";
    this.io.to(`game:${game.gameId}`).emit(eventName, game);
    if (!game.rated || !game.bothPlayersMoved || !game.result || game.result === "aborted" || this.finalizedRatings.has(game.gameId)) {
      return;
    }
    this.finalizedRatings.add(game.gameId);
    const white = await this.requiredStore().getPlayer(game.whitePlayerId);
    const black = await this.requiredStore().getPlayer(game.blackPlayerId);
    if (!white || !black) return;
    const rating = calculateRating(white, black, game.result);
    const updatedWhite = await this.requiredStore().updatePlayerRating(white.playerId, rating.white);
    const updatedBlack = await this.requiredStore().updatePlayerRating(black.playerId, rating.black);
    const createdAt = new Date().toISOString();
    await this.requiredStore().recordRatingEvent({ gameId: game.gameId, playerId: white.playerId, createdAt, ...rating.white });
    await this.requiredStore().recordRatingEvent({ gameId: game.gameId, playerId: black.playerId, createdAt, ...rating.black });
    this.io.to(`player:${white.playerId}`).emit("rating.updated", { player: updatedWhite, rating: rating.white });
    this.io.to(`player:${black.playerId}`).emit("rating.updated", { player: updatedBlack, rating: rating.black });
  }

  private async forfeitActiveGames(playerId: string): Promise<void> {
    const games = await this.requiredStore().listActiveGamesForPlayer(playerId);
    for (const game of games) {
      const result = game.whitePlayerId === playerId ? "black_win" : "white_win";
      const next = { ...abortGame(game, "disconnect"), result } as GameState;
      await this.requiredStore().upsertGame(next);
      this.io.to(`game:${next.gameId}`).emit("game.ended", next);
      await this.finalizeGameIfNeeded(next);
    }
  }

  private async handleHttp(url: string, res: import("node:http").ServerResponse): Promise<void> {
    if (url === "/" || url.startsWith("/?")) {
      return this.json(res, {
        ok: true,
        service: "machiai",
        tagline: "Chess for people waiting on AI agents.",
        health: "/health",
        presence: "/presence",
        leaderboard: "/leaderboard",
      });
    }
    if (url.startsWith("/health")) {
      return this.json(res, { ok: true, service: "machiai", now: new Date().toISOString() });
    }
    if (url.startsWith("/leaderboard")) {
      const entries = await this.requiredStore().listLeaderboard(25);
      return this.json(res, { entries });
    }
    if (url.startsWith("/presence")) {
      return this.json(res, this.currentPresence());
    }
    res.statusCode = 404;
    this.json(res, { error: "not_found" });
  }

  private json(res: import("node:http").ServerResponse, value: unknown): void {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value, null, 2));
  }

  private requiredStore(): MachiaiStore {
    if (!this.store) throw new Error("Machiai server store is not initialized.");
    return this.store;
  }

  private async requireSocketPlayer(socket: Socket): Promise<PlayerProfile> {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) throw new Error("Socket is not authenticated.");
    const player = await this.requiredStore().getPlayer(playerId);
    if (!player) throw new Error("Authenticated player was not found.");
    return player;
  }

  private async requireGame(gameId: string): Promise<GameState> {
    const game = await this.requiredStore().getGame(gameId);
    if (!game) throw new Error(`Unknown game: ${gameId}`);
    return game;
  }

  private assertPlayerInGame(game: GameState, playerId: string): void {
    if (game.whitePlayerId !== playerId && game.blackPlayerId !== playerId) {
      throw new Error("Player is not in this game.");
    }
  }

  private trackSocket(playerId: string, socketId: string): void {
    const set = this.socketsByPlayer.get(playerId) ?? new Set<string>();
    set.add(socketId);
    this.socketsByPlayer.set(playerId, set);
  }

  private untrackSocket(playerId: string, socketId: string): void {
    const set = this.socketsByPlayer.get(playerId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.socketsByPlayer.delete(playerId);
  }

  private currentPresence(): PresenceState {
    return {
      onlinePlayers: this.socketsByPlayer.size,
      updatedAt: new Date().toISOString(),
    };
  }

  private broadcastPresence(): PresenceState {
    const presence = this.currentPresence();
    this.io.emit("presence.updated", presence);
    return presence;
  }

  private clearDisconnectTimer(playerId: string): void {
    const timer = this.disconnectTimers.get(playerId);
    if (!timer) return;
    clearTimeout(timer);
    this.disconnectTimers.delete(playerId);
  }

  private clearBotFallback(playerId: string): void {
    const timer = this.botTimers.get(playerId);
    if (!timer) return;
    clearTimeout(timer);
    this.botTimers.delete(playerId);
  }

  private clearBotMove(gameId: string): void {
    const timer = this.botMoveTimers.get(gameId);
    if (!timer) return;
    clearTimeout(timer);
    this.botMoveTimers.delete(gameId);
  }

  private removeFromQueue(playerId: string): void {
    const index = this.queue.findIndex((ticket) => ticket.playerId === playerId);
    if (index >= 0) this.queue.splice(index, 1);
    this.clearBotFallback(playerId);
  }

  private emitError(socket: Socket, error: unknown, ack?: (value: unknown) => void): void {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { code: "machiai_error", message };
    socket.emit("error", payload);
    ack?.({ ok: false, error: payload });
  }
}
