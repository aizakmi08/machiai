import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GameState, LeaderboardEntry, PlayerProfile, RatingChange, WaitSession } from "../../../packages/shared/src/index.js";

export interface MachiaiStore {
  init(): Promise<void>;
  upsertPlayer(player: PlayerProfile): Promise<PlayerProfile>;
  getPlayer(playerId: string): Promise<PlayerProfile | undefined>;
  listLeaderboard(limit: number): Promise<LeaderboardEntry[]>;
  updatePlayerRating(playerId: string, change: RatingChange): Promise<PlayerProfile>;
  upsertWaitSession(session: WaitSession): Promise<WaitSession>;
  getWaitSession(sessionId: string): Promise<WaitSession | undefined>;
  endWaitSession(sessionId: string, endedAt: string): Promise<WaitSession | undefined>;
  upsertGame(game: GameState): Promise<GameState>;
  getGame(gameId: string): Promise<GameState | undefined>;
  listActiveGamesForPlayer(playerId: string): Promise<GameState[]>;
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

interface Snapshot {
  players: PlayerProfile[];
  waitSessions: WaitSession[];
  games: GameState[];
  ratingEvents: Array<{
    gameId: string;
    playerId: string;
    oldMmr: number;
    newMmr: number;
    delta: number;
    createdAt: string;
  }>;
}

export class JsonFileStore implements MachiaiStore {
  private players = new Map<string, PlayerProfile>();
  private waitSessions = new Map<string, WaitSession>();
  private games = new Map<string, GameState>();
  private ratingEvents: Snapshot["ratingEvents"] = [];

  constructor(private readonly path?: string) {}

  async init(): Promise<void> {
    if (!this.path) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
      this.players = new Map((snapshot.players ?? []).map((p) => [p.playerId, p]));
      this.waitSessions = new Map((snapshot.waitSessions ?? []).map((s) => [s.sessionId, s]));
      this.games = new Map((snapshot.games ?? []).map((g) => [g.gameId, g]));
      this.ratingEvents = snapshot.ratingEvents ?? [];
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
      ratingEvents: this.ratingEvents,
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
    `);
    this.tryAddColumn("players", "twitter_handle", "TEXT");
  }

  async upsertPlayer(player: PlayerProfile): Promise<PlayerProfile> {
    this.requiredDb()
      .prepare(
        `INSERT INTO players (player_id, device_key, handle, display_name, twitter_handle, mmr, rated_games, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
          device_key=excluded.device_key,
          handle=excluded.handle,
          display_name=excluded.display_name,
          twitter_handle=excluded.twitter_handle,
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

export async function createStore(path?: string): Promise<MachiaiStore> {
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
