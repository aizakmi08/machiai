import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Server as SocketServer, type Socket } from "socket.io";
import {
  BOT_FALLBACK_MS,
  RECONNECT_GRACE_MS,
  STARTING_MMR,
  abortGame,
  applyMove,
  botMmrForPlayer,
  calculateRating,
  chooseBotMove,
  createGame,
  createHandle,
  createId,
  isTwitterAuthenticated,
  normalizeTwitterHandle,
  twitterDisplayName,
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

interface XAuthSession {
  sessionId: string;
  state: string;
  codeVerifier: string;
  playerId: string;
  deviceKey?: string;
  createdAtMs: number;
  redirectUri: string;
  status: "pending" | "complete" | "error";
  player?: PlayerProfile;
  error?: string;
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
  private readonly xAuthSessions = new Map<string, XAuthSession>();
  private readonly botFallbackMs: number;
  private readonly botMoveMs: number;
  private readonly reconnectGraceMs: number;

  constructor(private readonly options: MachiaiServerOptions = {}) {
    this.http = createServer((req, res) => {
      void this.handleHttp(req, res);
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
    const authValid = Boolean(payload.authToken && existing?.authToken && payload.authToken === existing.authToken);
    const player: PlayerProfile = {
      playerId,
      deviceKey: payload.deviceKey ?? existing?.deviceKey ?? createId("device"),
      handle: payload.handle ?? existing?.handle ?? createHandle(),
      displayName: authValid ? (twitterDisplayName(existing?.twitterHandle) ?? existing?.displayName) : (payload.displayName ?? existing?.displayName),
      twitterHandle: authValid ? existing?.twitterHandle : normalizeTwitterHandle(payload.twitterHandle ?? existing?.twitterHandle),
      xUserId: existing?.xUserId,
      authToken: existing?.authToken,
      profileImageUrl: existing?.profileImageUrl,
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
    socket.data.twitterAuthenticated = authValid;
    socket.join(`player:${player.playerId}`);
    this.trackSocket(player.playerId, socket.id);
    this.clearDisconnectTimer(player.playerId);
    const responsePlayer = authValid ? player : stripPrivateAuth(player);
    socket.emit("auth.ready", responsePlayer);
    const presence = this.broadcastPresence();
    ack?.({ ok: true, player: responsePlayer, presence });
  }

  private async onProfileUpdate(socket: Socket, payload: { displayName?: string; handle?: string; twitterHandle?: string }, ack?: (value: unknown) => void) {
    const player = await this.requireSocketPlayer(socket);
    const updated = {
      ...player,
      displayName: payload.displayName ?? player.displayName,
      handle: payload.handle ?? player.handle,
      twitterHandle: payload.twitterHandle !== undefined ? normalizeTwitterHandle(payload.twitterHandle) : player.twitterHandle,
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
    if (!this.isSocketTwitterAuthenticated(socket, player)) {
      const locked = { code: "auth_required", message: "Sign in with X to play rated chess." };
      socket.emit("wait.locked", locked);
      ack?.({ ok: false, error: locked });
      return;
    }
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
        handle: twitterDisplayName(player.twitterHandle) ?? player.displayName ?? player.handle,
        twitterHandle: player.twitterHandle,
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
      whiteTwitterHandle: white.twitterHandle,
      blackTwitterHandle: black.twitterHandle,
      whiteMmr: white.mmr,
      blackMmr: black.mmr,
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
      whiteTwitterHandle: ticket.twitterHandle,
      whiteMmr: ticket.mmr,
      blackMmr: botMmrForPlayer(ticket.mmr),
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
      next = applyMove(next, next.blackPlayerId, chooseBotMove(next.fen, next.blackMmr), now).game;
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

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = req.url ?? "/";
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
    if (url.startsWith("/auth/x/start")) {
      return this.startXAuth(req, res);
    }
    if (url.startsWith("/auth/x/session/")) {
      const sessionId = decodeURIComponent(url.split("/auth/x/session/")[1]?.split(/[?#]/)[0] ?? "");
      return this.pollXAuthSession(sessionId, res);
    }
    if (url.startsWith("/auth/x/callback")) {
      return this.completeXAuth(req, res);
    }
    res.statusCode = 404;
    this.json(res, { error: "not_found" });
  }

  private async startXAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return this.json(res, { ok: false, error: "method_not_allowed" });
    }
    const config = this.xAuthConfig(req);
    if (!config) {
      res.statusCode = 501;
      return this.json(res, {
        ok: false,
        error: "x_auth_not_configured",
        message: "X login is not configured on this Machiai server.",
      });
    }
    const body = await readJsonBody(req);
    const playerId = typeof body.playerId === "string" && body.playerId ? body.playerId : createId("player");
    const deviceKey = typeof body.deviceKey === "string" ? body.deviceKey : undefined;
    const sessionId = createId("auth");
    const state = randomBase64Url(24);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    this.xAuthSessions.set(sessionId, {
      sessionId,
      state,
      codeVerifier,
      playerId,
      deviceKey,
      redirectUri: config.redirectUri,
      createdAtMs: Date.now(),
      status: "pending",
    });
    const authUrl = new URL("https://x.com/i/oauth2/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("scope", "tweet.read users.read");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    return this.json(res, { ok: true, sessionId, authUrl: authUrl.toString() });
  }

  private pollXAuthSession(sessionId: string, res: ServerResponse): void {
    const session = this.xAuthSessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      return this.json(res, { ok: false, status: "missing", error: "Unknown auth session." });
    }
    if (Date.now() - session.createdAtMs > 10 * 60 * 1000 && session.status === "pending") {
      session.status = "error";
      session.error = "X login expired. Try again.";
    }
    return this.json(res, {
      ok: session.status !== "error",
      status: session.status,
      player: session.player,
      error: session.error,
    });
  }

  private async completeXAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.xAuthConfig(req);
    const callbackUrl = new URL(req.url ?? "/", requestBaseUrl(req));
    const state = callbackUrl.searchParams.get("state") ?? "";
    const code = callbackUrl.searchParams.get("code") ?? "";
    const error = callbackUrl.searchParams.get("error");
    const session = [...this.xAuthSessions.values()].find((item) => item.state === state);
    if (!session) {
      res.statusCode = 400;
      return this.html(res, "Machiai", "Unknown or expired login session. Close this tab and try again.");
    }
    if (error || !code || !config) {
      session.status = "error";
      session.error = error ?? "X login failed.";
      res.statusCode = 400;
      return this.html(res, "Machiai", session.error);
    }

    try {
      const token = await exchangeXCode({ ...config, redirectUri: session.redirectUri, code, codeVerifier: session.codeVerifier });
      const xUser = await fetchXUser(token.accessToken);
      const twitterHandle = normalizeTwitterHandle(xUser.username);
      if (!twitterHandle) throw new Error("X did not return a username.");
      const existingByX = await this.requiredStore().getPlayerByXUserId(xUser.id);
      const existingLocal = await this.requiredStore().getPlayer(session.playerId);
      const existing = existingByX ?? existingLocal;
      const now = new Date().toISOString();
      const player: PlayerProfile = {
        playerId: existing?.playerId ?? session.playerId,
        deviceKey: existing?.deviceKey ?? session.deviceKey ?? createId("device"),
        handle: existing?.handle ?? createHandle(),
        displayName: twitterDisplayName(twitterHandle),
        twitterHandle,
        xUserId: xUser.id,
        authToken: createAuthToken(),
        profileImageUrl: xUser.profileImageUrl,
        mmr: existing?.mmr ?? STARTING_MMR,
        ratedGames: existing?.ratedGames ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.requiredStore().upsertPlayer(player);
      session.status = "complete";
      session.player = player;
      this.io.to(`player:${player.playerId}`).emit("auth.ready", player);
      return this.html(res, "Machiai", `Signed in as @${twitterHandle}. You can return to Machiai.`);
    } catch (caught) {
      session.status = "error";
      session.error = caught instanceof Error ? caught.message : String(caught);
      res.statusCode = 500;
      return this.html(res, "Machiai", "X login failed. Close this tab and try again.");
    }
  }

  private xAuthConfig(req: IncomingMessage): { clientId: string; clientSecret?: string; redirectUri: string } | undefined {
    const clientId = process.env.X_CLIENT_ID ?? process.env.TWITTER_CLIENT_ID;
    if (!clientId) return undefined;
    const publicUrl = (process.env.MACHIAI_PUBLIC_URL ?? requestBaseUrl(req)).replace(/\/+$/, "");
    return {
      clientId,
      clientSecret: process.env.X_CLIENT_SECRET ?? process.env.TWITTER_CLIENT_SECRET,
      redirectUri: `${publicUrl}/auth/x/callback`,
    };
  }

  private isSocketTwitterAuthenticated(socket: Socket, player: PlayerProfile): boolean {
    return socket.data.twitterAuthenticated === true && isTwitterAuthenticated(player);
  }

  private setCors(res: ServerResponse): void {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  }

  private json(res: ServerResponse, value: unknown): void {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value, null, 2));
  }

  private html(res: ServerResponse, title: string, message: string): void {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#000;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:32px;text-align:center}p{color:#bbb;line-height:1.5}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 32 * 1024) throw new Error("Request body is too large.");
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requestBaseUrl(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "127.0.0.1");
  return `${proto}://${host}`;
}

function randomBase64Url(bytes: number): string {
  return base64Url(randomBytes(bytes));
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createAuthToken(): string {
  return `machiai_${randomBase64Url(32)}`;
}

function stripPrivateAuth(player: PlayerProfile): PlayerProfile {
  return {
    ...player,
    xUserId: undefined,
    authToken: undefined,
    profileImageUrl: undefined,
  };
}

async function exchangeXCode(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (input.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", input.clientId);
  }
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? `X token exchange failed: ${response.status}`);
  }
  return { accessToken: payload.access_token };
}

async function fetchXUser(accessToken: string): Promise<{ id: string; username: string; profileImageUrl?: string }> {
  const response = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,name,username", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { id?: string; username?: string; profile_image_url?: string };
    detail?: string;
    title?: string;
  };
  const id = payload.data?.id;
  const username = payload.data?.username;
  if (!response.ok || !id || !username) {
    throw new Error(payload.detail ?? payload.title ?? `X user lookup failed: ${response.status}`);
  }
  return { id, username, profileImageUrl: payload.data?.profile_image_url };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
