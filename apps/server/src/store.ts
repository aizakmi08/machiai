import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import type { GameState, LeaderboardEntry, PlayerProfile, RatingChange, WaitSession } from "../../../packages/shared/src/index.js";

const { Pool } = pg;

export interface MachiaiStore {
  init(): Promise<void>;
  upsertPlayer(player: PlayerProfile): Promise<PlayerProfile>;
  getPlayer(playerId: string): Promise<PlayerProfile | undefined>;
  getPlayerByXUserId(xUserId: string): Promise<PlayerProfile | undefined>;
  listLeaderboard(limit: number): Promise<LeaderboardEntry[]>;
  updatePlayerRating(playerId: string, change: RatingChange): Promise<PlayerProfile>;
  upsertWaitSession(session: WaitSession): Promise<WaitSession>;
  getWaitSession(sessionId: string): Promise<WaitSession | undefined>;
  endWaitSession(sessionId: string, endedAt: string): Promise<WaitSession | undefined>;
  upsertGame(game: GameState): Promise<GameState>;
  getGame(gameId: string): Promise<GameState | undefined>;
  listActiveGamesForPlayer(playerId: string): Promise<GameState[]>;
  tryClaimRatingFinalization(gameId: string, createdAt: string): Promise<boolean>;
  upsertXAuthSession(session: StoredXAuthSession): Promise<StoredXAuthSession>;
  getXAuthSession(sessionId: string): Promise<StoredXAuthSession | undefined>;
  getXAuthSessionByState(state: string): Promise<StoredXAuthSession | undefined>;
  countPendingXAuthSessions(): Promise<number>;
  deleteExpiredXAuthSessions(beforeMs: number): Promise<void>;
  recordRatingEvent(input: {
    gameId: string;
    playerId: string;
    oldMmr: number;
    newMmr: number;
    delta: number;
    createdAt: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface StoredXAuthSession {
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

interface Snapshot {
  players: PlayerProfile[];
  waitSessions: WaitSession[];
  games: GameState[];
  xAuthSessions?: StoredXAuthSession[];
  ratingEvents: Array<{
    gameId: string;
    playerId: string;
    oldMmr: number;
    newMmr: number;
    delta: number;
    createdAt: string;
  }>;
  ratingFinalizations: Array<{ gameId: string; createdAt: string }>;
}

export class JsonFileStore implements MachiaiStore {
  private players = new Map<string, PlayerProfile>();
  private waitSessions = new Map<string, WaitSession>();
  private games = new Map<string, GameState>();
  private xAuthSessions = new Map<string, StoredXAuthSession>();
  private ratingEvents: Snapshot["ratingEvents"] = [];
  private ratingFinalizations = new Map<string, string>();

  constructor(private readonly path?: string) {}

  async init(): Promise<void> {
    if (!this.path) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
      this.players = new Map((snapshot.players ?? []).map((p) => [p.playerId, p]));
      this.waitSessions = new Map((snapshot.waitSessions ?? []).map((s) => [s.sessionId, s]));
      this.games = new Map((snapshot.games ?? []).map((g) => [g.gameId, g]));
      this.xAuthSessions = new Map((snapshot.xAuthSessions ?? []).map((s) => [s.sessionId, s]));
      this.ratingEvents = snapshot.ratingEvents ?? [];
      this.ratingFinalizations = new Map((snapshot.ratingFinalizations ?? []).map((item) => [item.gameId, item.createdAt]));
    } catch {
      this.flush();
    }
  }

  async upsertPlayer(player: PlayerProfile): Promise<PlayerProfile> {
    this.players.set(player.playerId, player);
    this.flush();
    return player;
  }

  async getPlayer(playerId: string): Promise<PlayerProfile | undefined> {
    return this.players.get(playerId);
  }

  async getPlayerByXUserId(xUserId: string): Promise<PlayerProfile | undefined> {
    return [...this.players.values()].find((player) => player.xUserId === xUserId);
  }

  async listLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
    return [...this.players.values()]
      .sort((a, b) => b.mmr - a.mmr || b.ratedGames - a.ratedGames || a.handle.localeCompare(b.handle))
      .slice(0, limit)
      .map(({ playerId, handle, displayName, twitterHandle, mmr, ratedGames }) => ({
        playerId,
        handle,
        displayName,
        twitterHandle,
        mmr,
        ratedGames,
      }));
  }

  async updatePlayerRating(playerId: string, change: RatingChange): Promise<PlayerProfile> {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    const next = { ...player, mmr: change.newMmr, ratedGames: player.ratedGames + 1, updatedAt: new Date().toISOString() };
    this.players.set(playerId, next);
    this.flush();
    return next;
  }

  async upsertWaitSession(session: WaitSession): Promise<WaitSession> {
    this.waitSessions.set(session.sessionId, session);
    this.flush();
    return session;
  }

  async getWaitSession(sessionId: string): Promise<WaitSession | undefined> {
    return this.waitSessions.get(sessionId);
  }

  async endWaitSession(sessionId: string, endedAt: string): Promise<WaitSession | undefined> {
    const session = this.waitSessions.get(sessionId);
    if (!session) return undefined;
    const next = { ...session, active: false, endedAt, lastHeartbeatAt: endedAt };
    this.waitSessions.set(sessionId, next);
    this.flush();
    return next;
  }

  async upsertGame(game: GameState): Promise<GameState> {
    this.games.set(game.gameId, game);
    this.flush();
    return game;
  }

  async getGame(gameId: string): Promise<GameState | undefined> {
    return this.games.get(gameId);
  }

  async listActiveGamesForPlayer(playerId: string): Promise<GameState[]> {
    return [...this.games.values()].filter(
      (game) => game.status === "active" && (game.whitePlayerId === playerId || game.blackPlayerId === playerId),
    );
  }

  async recordRatingEvent(input: Snapshot["ratingEvents"][number]): Promise<void> {
    this.ratingEvents.push(input);
    this.flush();
  }

  async tryClaimRatingFinalization(gameId: string, createdAt: string): Promise<boolean> {
    if (this.ratingFinalizations.has(gameId)) return false;
    this.ratingFinalizations.set(gameId, createdAt);
    this.flush();
    return true;
  }

  async upsertXAuthSession(session: StoredXAuthSession): Promise<StoredXAuthSession> {
    this.xAuthSessions.set(session.sessionId, session);
    this.flush();
    return session;
  }

  async getXAuthSession(sessionId: string): Promise<StoredXAuthSession | undefined> {
    return this.xAuthSessions.get(sessionId);
  }

  async getXAuthSessionByState(state: string): Promise<StoredXAuthSession | undefined> {
    return [...this.xAuthSessions.values()].find((session) => session.state === state);
  }

  async countPendingXAuthSessions(): Promise<number> {
    return [...this.xAuthSessions.values()].filter((session) => session.status === "pending").length;
  }

  async deleteExpiredXAuthSessions(beforeMs: number): Promise<void> {
    for (const [sessionId, session] of this.xAuthSessions) {
      if (session.createdAtMs < beforeMs) this.xAuthSessions.delete(sessionId);
    }
    this.flush();
  }

  async close(): Promise<void> {
    this.flush();
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const snapshot: Snapshot = {
      players: [...this.players.values()],
      waitSessions: [...this.waitSessions.values()],
      games: [...this.games.values()],
      xAuthSessions: [...this.xAuthSessions.values()],
      ratingEvents: this.ratingEvents,
      ratingFinalizations: [...this.ratingFinalizations].map(([gameId, createdAt]) => ({ gameId, createdAt })),
    };
    writeFileSync(this.path, JSON.stringify(snapshot, null, 2));
  }
}

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
};

export class SqliteStore implements MachiaiStore {
  private db?: SqliteDatabase;

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const sqlite = (await new Function("specifier", "return import(specifier)")("node:sqlite")) as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.db = new sqlite.DatabaseSync(this.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        device_key TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT,
        twitter_handle TEXT,
        x_user_id TEXT,
        auth_token TEXT,
        profile_image_url TEXT,
        mmr INTEGER NOT NULL,
        rated_games INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wait_sessions (
        session_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        workspace TEXT,
        goal TEXT,
        active INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        rated INTEGER NOT NULL,
        white_player_id TEXT NOT NULL,
        black_player_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        end_reason TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moves (
        game_id TEXT NOT NULL,
        ply INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        san TEXT NOT NULL,
        from_sq TEXT NOT NULL,
        to_sq TEXT NOT NULL,
        fen_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, ply)
      );
      CREATE TABLE IF NOT EXISTS rating_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        old_mmr INTEGER NOT NULL,
        new_mmr INTEGER NOT NULL,
        delta INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rating_finalizations (
        game_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS x_auth_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL UNIQUE,
        code_verifier TEXT NOT NULL,
        player_id TEXT NOT NULL,
        device_key TEXT,
        created_at_ms INTEGER NOT NULL,
        redirect_uri TEXT NOT NULL,
        status TEXT NOT NULL,
        player_json TEXT,
        error TEXT
      );
    `);
    this.tryAddColumn("players", "twitter_handle", "TEXT");
    this.tryAddColumn("players", "x_user_id", "TEXT");
    this.tryAddColumn("players", "auth_token", "TEXT");
    this.tryAddColumn("players", "profile_image_url", "TEXT");
  }

  async upsertPlayer(player: PlayerProfile): Promise<PlayerProfile> {
    this.requiredDb()
      .prepare(
        `INSERT INTO players (player_id, device_key, handle, display_name, twitter_handle, x_user_id, auth_token, profile_image_url, mmr, rated_games, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
          device_key=excluded.device_key,
          handle=excluded.handle,
          display_name=excluded.display_name,
          twitter_handle=excluded.twitter_handle,
          x_user_id=excluded.x_user_id,
          auth_token=excluded.auth_token,
          profile_image_url=excluded.profile_image_url,
          mmr=excluded.mmr,
          rated_games=excluded.rated_games,
          updated_at=excluded.updated_at`,
      )
      .run(
        player.playerId,
        player.deviceKey,
        player.handle,
        player.displayName ?? null,
        player.twitterHandle ?? null,
        player.xUserId ?? null,
        player.authToken ?? null,
        player.profileImageUrl ?? null,
        player.mmr,
        player.ratedGames,
        player.createdAt,
        player.updatedAt,
      );
    return player;
  }

  async getPlayer(playerId: string): Promise<PlayerProfile | undefined> {
    const row = this.requiredDb().prepare("SELECT * FROM players WHERE player_id = ?").get(playerId);
    return row ? rowToPlayer(row) : undefined;
  }

  async getPlayerByXUserId(xUserId: string): Promise<PlayerProfile | undefined> {
    const row = this.requiredDb().prepare("SELECT * FROM players WHERE x_user_id = ?").get(xUserId);
    return row ? rowToPlayer(row) : undefined;
  }

  async listLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
    return this.requiredDb()
      .prepare("SELECT * FROM players ORDER BY mmr DESC, rated_games DESC, handle ASC LIMIT ?")
      .all(limit)
      .map(rowToPlayer)
      .map(({ playerId, handle, displayName, twitterHandle, mmr, ratedGames }) => ({ playerId, handle, displayName, twitterHandle, mmr, ratedGames }));
  }

  async updatePlayerRating(playerId: string, change: RatingChange): Promise<PlayerProfile> {
    const player = await this.getPlayer(playerId);
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    const next = { ...player, mmr: change.newMmr, ratedGames: player.ratedGames + 1, updatedAt: new Date().toISOString() };
    await this.upsertPlayer(next);
    return next;
  }

  async upsertWaitSession(session: WaitSession): Promise<WaitSession> {
    this.requiredDb()
      .prepare(
        `INSERT INTO wait_sessions (session_id, player_id, agent, workspace, goal, active, started_at, ended_at, last_heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          player_id=excluded.player_id,
          agent=excluded.agent,
          workspace=excluded.workspace,
          goal=excluded.goal,
          active=excluded.active,
          ended_at=excluded.ended_at,
          last_heartbeat_at=excluded.last_heartbeat_at`,
      )
      .run(
        session.sessionId,
        session.playerId,
        session.agent,
        session.workspace ?? null,
        session.goal ?? null,
        session.active ? 1 : 0,
        session.startedAt,
        session.endedAt ?? null,
        session.lastHeartbeatAt,
      );
    return session;
  }

  async getWaitSession(sessionId: string): Promise<WaitSession | undefined> {
    const row = this.requiredDb().prepare("SELECT * FROM wait_sessions WHERE session_id = ?").get(sessionId);
    return row ? rowToWaitSession(row) : undefined;
  }

  async endWaitSession(sessionId: string, endedAt: string): Promise<WaitSession | undefined> {
    const session = await this.getWaitSession(sessionId);
    if (!session) return undefined;
    const next = { ...session, active: false, endedAt, lastHeartbeatAt: endedAt };
    await this.upsertWaitSession(next);
    return next;
  }

  async upsertGame(game: GameState): Promise<GameState> {
    this.requiredDb()
      .prepare(
        `INSERT INTO games (game_id, mode, rated, white_player_id, black_player_id, status, result, end_reason, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET
          mode=excluded.mode,
          rated=excluded.rated,
          white_player_id=excluded.white_player_id,
          black_player_id=excluded.black_player_id,
          status=excluded.status,
          result=excluded.result,
          end_reason=excluded.end_reason,
          json=excluded.json`,
      )
      .run(
        game.gameId,
        game.mode,
        game.rated ? 1 : 0,
        game.whitePlayerId,
        game.blackPlayerId,
        game.status,
        game.result ?? null,
        game.endReason ?? null,
        JSON.stringify(game),
      );
    this.requiredDb().prepare("DELETE FROM moves WHERE game_id = ?").run(game.gameId);
    const insertMove = this.requiredDb().prepare(
      "INSERT INTO moves (game_id, ply, player_id, san, from_sq, to_sq, fen_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const move of game.moves) {
      insertMove.run(game.gameId, move.ply, move.playerId, move.san, move.from, move.to, move.fenAfter, move.createdAt);
    }
    return game;
  }

  async getGame(gameId: string): Promise<GameState | undefined> {
    const row = this.requiredDb().prepare("SELECT json FROM games WHERE game_id = ?").get(gameId);
    return row ? (JSON.parse(String(row.json)) as GameState) : undefined;
  }

  async listActiveGamesForPlayer(playerId: string): Promise<GameState[]> {
    return this.requiredDb()
      .prepare("SELECT json FROM games WHERE status = 'active' AND (white_player_id = ? OR black_player_id = ?)")
      .all(playerId, playerId)
      .map((row) => JSON.parse(String(row.json)) as GameState);
  }

  async recordRatingEvent(input: {
    gameId: string;
    playerId: string;
    oldMmr: number;
    newMmr: number;
    delta: number;
    createdAt: string;
  }): Promise<void> {
    this.requiredDb()
      .prepare("INSERT INTO rating_events (game_id, player_id, old_mmr, new_mmr, delta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.gameId, input.playerId, input.oldMmr, input.newMmr, input.delta, input.createdAt);
  }

  async tryClaimRatingFinalization(gameId: string, createdAt: string): Promise<boolean> {
    const result = this.requiredDb().prepare("INSERT OR IGNORE INTO rating_finalizations (game_id, created_at) VALUES (?, ?)").run(gameId, createdAt) as {
      changes?: number;
    };
    return result.changes !== 0;
  }

  async upsertXAuthSession(session: StoredXAuthSession): Promise<StoredXAuthSession> {
    this.requiredDb()
      .prepare(
        `INSERT INTO x_auth_sessions (session_id, state, code_verifier, player_id, device_key, created_at_ms, redirect_uri, status, player_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          state=excluded.state,
          code_verifier=excluded.code_verifier,
          player_id=excluded.player_id,
          device_key=excluded.device_key,
          created_at_ms=excluded.created_at_ms,
          redirect_uri=excluded.redirect_uri,
          status=excluded.status,
          player_json=excluded.player_json,
          error=excluded.error`,
      )
      .run(
        session.sessionId,
        session.state,
        session.codeVerifier,
        session.playerId,
        session.deviceKey ?? null,
        session.createdAtMs,
        session.redirectUri,
        session.status,
        session.player ? JSON.stringify(session.player) : null,
        session.error ?? null,
      );
    return session;
  }

  async getXAuthSession(sessionId: string): Promise<StoredXAuthSession | undefined> {
    const row = this.requiredDb().prepare("SELECT * FROM x_auth_sessions WHERE session_id = ?").get(sessionId);
    return row ? rowToXAuthSession(row) : undefined;
  }

  async getXAuthSessionByState(state: string): Promise<StoredXAuthSession | undefined> {
    const row = this.requiredDb().prepare("SELECT * FROM x_auth_sessions WHERE state = ?").get(state);
    return row ? rowToXAuthSession(row) : undefined;
  }

  async countPendingXAuthSessions(): Promise<number> {
    const row = this.requiredDb().prepare("SELECT COUNT(*) AS count FROM x_auth_sessions WHERE status = 'pending'").get();
    return Number(row?.count ?? 0);
  }

  async deleteExpiredXAuthSessions(beforeMs: number): Promise<void> {
    this.requiredDb().prepare("DELETE FROM x_auth_sessions WHERE created_at_ms < ?").run(beforeMs);
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  private requiredDb(): SqliteDatabase {
    if (!this.db) throw new Error("SQLite store is not initialized.");
    return this.db;
  }

  private tryAddColumn(table: string, column: string, type: string): void {
    try {
      this.requiredDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists on upgraded stores.
    }
  }
}

type PgPool = pg.Pool;
type PgRow = Record<string, unknown>;

export class PostgresStore implements MachiaiStore {
  private pool?: PgPool;

  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: Number(process.env.MACHIAI_PG_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    await this.requiredPool().query(`
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        device_key TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT,
        twitter_handle TEXT,
        x_user_id TEXT UNIQUE,
        auth_token TEXT,
        profile_image_url TEXT,
        mmr INTEGER NOT NULL,
        rated_games INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS players_leaderboard_idx ON players (mmr DESC, rated_games DESC, handle ASC);

      CREATE TABLE IF NOT EXISTS wait_sessions (
        session_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        workspace TEXT,
        goal TEXT,
        active BOOLEAN NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_heartbeat_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wait_sessions_player_active_idx ON wait_sessions (player_id, active);

      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        rated BOOLEAN NOT NULL,
        white_player_id TEXT NOT NULL,
        black_player_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        end_reason TEXT,
        json JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_active_white_idx ON games (white_player_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS games_active_black_idx ON games (black_player_id) WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS moves (
        game_id TEXT NOT NULL,
        ply INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        san TEXT NOT NULL,
        from_sq TEXT NOT NULL,
        to_sq TEXT NOT NULL,
        fen_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, ply)
      );

      CREATE TABLE IF NOT EXISTS rating_events (
        event_id BIGSERIAL PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        old_mmr INTEGER NOT NULL,
        new_mmr INTEGER NOT NULL,
        delta INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rating_finalizations (
        game_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS x_auth_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL UNIQUE,
        code_verifier TEXT NOT NULL,
        player_id TEXT NOT NULL,
        device_key TEXT,
        created_at_ms BIGINT NOT NULL,
        redirect_uri TEXT NOT NULL,
        status TEXT NOT NULL,
        player_json JSONB,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS x_auth_sessions_created_idx ON x_auth_sessions (created_at_ms);
      CREATE INDEX IF NOT EXISTS rating_events_game_idx ON rating_events (game_id);
    `);
  }

  async upsertPlayer(player: PlayerProfile): Promise<PlayerProfile> {
    await this.requiredPool().query(
      `INSERT INTO players (player_id, device_key, handle, display_name, twitter_handle, x_user_id, auth_token, profile_image_url, mmr, rated_games, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(player_id) DO UPDATE SET
        device_key=excluded.device_key,
        handle=excluded.handle,
        display_name=excluded.display_name,
        twitter_handle=excluded.twitter_handle,
        x_user_id=excluded.x_user_id,
        auth_token=excluded.auth_token,
        profile_image_url=excluded.profile_image_url,
        mmr=excluded.mmr,
        rated_games=excluded.rated_games,
        updated_at=excluded.updated_at`,
      [
        player.playerId,
        player.deviceKey,
        player.handle,
        player.displayName ?? null,
        player.twitterHandle ?? null,
        player.xUserId ?? null,
        player.authToken ?? null,
        player.profileImageUrl ?? null,
        player.mmr,
        player.ratedGames,
        player.createdAt,
        player.updatedAt,
      ],
    );
    return player;
  }

  async getPlayer(playerId: string): Promise<PlayerProfile | undefined> {
    const result = await this.requiredPool().query<PgRow>("SELECT * FROM players WHERE player_id = $1", [playerId]);
    return result.rows[0] ? rowToPlayer(result.rows[0]) : undefined;
  }

  async getPlayerByXUserId(xUserId: string): Promise<PlayerProfile | undefined> {
    const result = await this.requiredPool().query<PgRow>("SELECT * FROM players WHERE x_user_id = $1", [xUserId]);
    return result.rows[0] ? rowToPlayer(result.rows[0]) : undefined;
  }

  async listLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
    const result = await this.requiredPool().query<PgRow>(
      "SELECT * FROM players ORDER BY mmr DESC, rated_games DESC, handle ASC LIMIT $1",
      [limit],
    );
    return result.rows
      .map(rowToPlayer)
      .map(({ playerId, handle, displayName, twitterHandle, mmr, ratedGames }) => ({ playerId, handle, displayName, twitterHandle, mmr, ratedGames }));
  }

  async updatePlayerRating(playerId: string, change: RatingChange): Promise<PlayerProfile> {
    const result = await this.requiredPool().query<PgRow>(
      `UPDATE players
       SET mmr = $2, rated_games = rated_games + 1, updated_at = $3
       WHERE player_id = $1
       RETURNING *`,
      [playerId, change.newMmr, new Date().toISOString()],
    );
    if (!result.rows[0]) throw new Error(`Unknown player: ${playerId}`);
    return rowToPlayer(result.rows[0]);
  }

  async upsertWaitSession(session: WaitSession): Promise<WaitSession> {
    await this.requiredPool().query(
      `INSERT INTO wait_sessions (session_id, player_id, agent, workspace, goal, active, started_at, ended_at, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(session_id) DO UPDATE SET
        player_id=excluded.player_id,
        agent=excluded.agent,
        workspace=excluded.workspace,
        goal=excluded.goal,
        active=excluded.active,
        ended_at=excluded.ended_at,
        last_heartbeat_at=excluded.last_heartbeat_at`,
      [
        session.sessionId,
        session.playerId,
        session.agent,
        session.workspace ?? null,
        session.goal ?? null,
        session.active,
        session.startedAt,
        session.endedAt ?? null,
        session.lastHeartbeatAt,
      ],
    );
    return session;
  }

  async getWaitSession(sessionId: string): Promise<WaitSession | undefined> {
    const result = await this.requiredPool().query<PgRow>("SELECT * FROM wait_sessions WHERE session_id = $1", [sessionId]);
    return result.rows[0] ? rowToWaitSession(result.rows[0]) : undefined;
  }

  async endWaitSession(sessionId: string, endedAt: string): Promise<WaitSession | undefined> {
    const session = await this.getWaitSession(sessionId);
    if (!session) return undefined;
    const next = { ...session, active: false, endedAt, lastHeartbeatAt: endedAt };
    await this.upsertWaitSession(next);
    return next;
  }

  async upsertGame(game: GameState): Promise<GameState> {
    const pool = this.requiredPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO games (game_id, mode, rated, white_player_id, black_player_id, status, result, end_reason, json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT(game_id) DO UPDATE SET
          mode=excluded.mode,
          rated=excluded.rated,
          white_player_id=excluded.white_player_id,
          black_player_id=excluded.black_player_id,
          status=excluded.status,
          result=excluded.result,
          end_reason=excluded.end_reason,
          json=excluded.json`,
        [
          game.gameId,
          game.mode,
          game.rated,
          game.whitePlayerId,
          game.blackPlayerId,
          game.status,
          game.result ?? null,
          game.endReason ?? null,
          JSON.stringify(game),
        ],
      );
      await client.query("DELETE FROM moves WHERE game_id = $1", [game.gameId]);
      for (const move of game.moves) {
        await client.query(
          "INSERT INTO moves (game_id, ply, player_id, san, from_sq, to_sq, fen_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [game.gameId, move.ply, move.playerId, move.san, move.from, move.to, move.fenAfter, move.createdAt],
        );
      }
      await client.query("COMMIT");
      return game;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getGame(gameId: string): Promise<GameState | undefined> {
    const result = await this.requiredPool().query<{ json: GameState }>("SELECT json FROM games WHERE game_id = $1", [gameId]);
    return result.rows[0]?.json;
  }

  async listActiveGamesForPlayer(playerId: string): Promise<GameState[]> {
    const result = await this.requiredPool().query<{ json: GameState }>(
      "SELECT json FROM games WHERE status = 'active' AND (white_player_id = $1 OR black_player_id = $1)",
      [playerId],
    );
    return result.rows.map((row) => row.json);
  }

  async recordRatingEvent(input: {
    gameId: string;
    playerId: string;
    oldMmr: number;
    newMmr: number;
    delta: number;
    createdAt: string;
  }): Promise<void> {
    await this.requiredPool().query(
      "INSERT INTO rating_events (game_id, player_id, old_mmr, new_mmr, delta, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [input.gameId, input.playerId, input.oldMmr, input.newMmr, input.delta, input.createdAt],
    );
  }

  async tryClaimRatingFinalization(gameId: string, createdAt: string): Promise<boolean> {
    const result = await this.requiredPool().query("INSERT INTO rating_finalizations (game_id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      gameId,
      createdAt,
    ]);
    return result.rowCount === 1;
  }

  async upsertXAuthSession(session: StoredXAuthSession): Promise<StoredXAuthSession> {
    await this.requiredPool().query(
      `INSERT INTO x_auth_sessions (session_id, state, code_verifier, player_id, device_key, created_at_ms, redirect_uri, status, player_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT(session_id) DO UPDATE SET
        state=excluded.state,
        code_verifier=excluded.code_verifier,
        player_id=excluded.player_id,
        device_key=excluded.device_key,
        created_at_ms=excluded.created_at_ms,
        redirect_uri=excluded.redirect_uri,
        status=excluded.status,
        player_json=excluded.player_json,
        error=excluded.error`,
      [
        session.sessionId,
        session.state,
        session.codeVerifier,
        session.playerId,
        session.deviceKey ?? null,
        session.createdAtMs,
        session.redirectUri,
        session.status,
        session.player ? JSON.stringify(session.player) : null,
        session.error ?? null,
      ],
    );
    return session;
  }

  async getXAuthSession(sessionId: string): Promise<StoredXAuthSession | undefined> {
    const result = await this.requiredPool().query<PgRow>("SELECT * FROM x_auth_sessions WHERE session_id = $1", [sessionId]);
    return result.rows[0] ? rowToXAuthSession(result.rows[0]) : undefined;
  }

  async getXAuthSessionByState(state: string): Promise<StoredXAuthSession | undefined> {
    const result = await this.requiredPool().query<PgRow>("SELECT * FROM x_auth_sessions WHERE state = $1", [state]);
    return result.rows[0] ? rowToXAuthSession(result.rows[0]) : undefined;
  }

  async countPendingXAuthSessions(): Promise<number> {
    const result = await this.requiredPool().query<{ count: string }>("SELECT COUNT(*) AS count FROM x_auth_sessions WHERE status = 'pending'");
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteExpiredXAuthSessions(beforeMs: number): Promise<void> {
    await this.requiredPool().query("DELETE FROM x_auth_sessions WHERE created_at_ms < $1", [beforeMs]);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private requiredPool(): PgPool {
    if (!this.pool) throw new Error("Postgres store is not initialized.");
    return this.pool;
  }
}

export async function createStore(path?: string): Promise<MachiaiStore> {
  if (process.env.DATABASE_URL || process.env.MACHIAI_STORE_DRIVER === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when MACHIAI_STORE_DRIVER=postgres.");
    const store = new PostgresStore(connectionString);
    await store.init();
    return store;
  }

  const resolved = path ?? ".machiai/server-store.sqlite";
  if (process.env.MACHIAI_STORE_DRIVER !== "json") {
    try {
      const store = new SqliteStore(resolved.endsWith(".json") ? resolved.replace(/\.json$/, ".sqlite") : resolved);
      await store.init();
      return store;
    } catch {
      // Older Node releases do not expose node:sqlite. Keep the server usable.
    }
  }
  const store = new JsonFileStore(resolved.endsWith(".sqlite") ? resolved.replace(/\.sqlite$/, ".json") : resolved);
  await store.init();
  return store;
}

function rowToPlayer(row: Record<string, unknown>): PlayerProfile {
  return {
    playerId: String(row.player_id),
    deviceKey: String(row.device_key),
    handle: String(row.handle),
    displayName: row.display_name ? String(row.display_name) : undefined,
    twitterHandle: row.twitter_handle ? String(row.twitter_handle) : undefined,
    xUserId: row.x_user_id ? String(row.x_user_id) : undefined,
    authToken: row.auth_token ? String(row.auth_token) : undefined,
    profileImageUrl: row.profile_image_url ? String(row.profile_image_url) : undefined,
    mmr: Number(row.mmr),
    ratedGames: Number(row.rated_games),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToWaitSession(row: Record<string, unknown>): WaitSession {
  return {
    sessionId: String(row.session_id),
    playerId: String(row.player_id),
    agent: String(row.agent),
    workspace: row.workspace ? String(row.workspace) : undefined,
    goal: row.goal ? String(row.goal) : undefined,
    active: Number(row.active) === 1,
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    lastHeartbeatAt: String(row.last_heartbeat_at),
  };
}

function rowToXAuthSession(row: Record<string, unknown>): StoredXAuthSession {
  const playerJson = row.player_json;
  const player = typeof playerJson === "string" ? (JSON.parse(playerJson) as PlayerProfile) : playerJson ? (playerJson as PlayerProfile) : undefined;
  return {
    sessionId: String(row.session_id),
    state: String(row.state),
    codeVerifier: String(row.code_verifier),
    playerId: String(row.player_id),
    deviceKey: row.device_key ? String(row.device_key) : undefined,
    createdAtMs: Number(row.created_at_ms),
    redirectUri: String(row.redirect_uri),
    status: String(row.status) as StoredXAuthSession["status"],
    player,
    error: row.error ? String(row.error) : undefined,
  };
}
