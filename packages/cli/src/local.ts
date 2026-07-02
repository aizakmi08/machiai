import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  STARTING_MMR,
  botMmrForPlayer,
  createDeviceKey,
  createGame,
  createHandle,
  createId,
  normalizeTwitterHandle,
  type GameState,
  type MatchRecord,
  type PlayerProfile,
  type ReferenceSelector,
  type WaitSession,
} from "../../shared/src/index.js";

export interface LocalState {
  profile: PlayerProfile;
  waitSessions: WaitSession[];
  games: GameState[];
  referenceSelector?: ReferenceSelector;
  matches?: MatchRecord[];
  /** Ratings that arrived before their match was recorded, keyed by gameId. */
  pendingRatings?: Record<string, { mmrDelta: number; mmrAfter: number }>;
}

const MAX_STORED_MATCHES = 200;
const MAX_PENDING_RATINGS = 50;

export const LOCAL_WAIT_SESSION_TTL_MS = 45_000;

export function machiaiHome(): string {
  return process.env.MACHIAI_HOME ? resolve(process.env.MACHIAI_HOME) : join(homedir(), ".machiai");
}

export function statePath(): string {
  return join(machiaiHome(), "state.json");
}

export function loadState(): LocalState {
  const path = statePath();
  if (existsSync(path)) {
    const state = JSON.parse(readFileSync(path, "utf8")) as LocalState;
    const normalized = normalizeState(state);
    if (normalized.changed) saveState(normalized.state);
    return normalized.state;
  }
  const now = new Date().toISOString();
  const profile: PlayerProfile = {
    playerId: createId("player"),
    deviceKey: createDeviceKey(),
    handle: createHandle(),
    mmr: STARTING_MMR,
    ratedGames: 0,
    createdAt: now,
    updatedAt: now,
  };
  const state = { profile, waitSessions: [], games: [] };
  saveState(state);
  return state;
}

function normalizeState(state: LocalState): { state: LocalState; changed: boolean } {
  let changed = false;
  const now = new Date();
  const waitSessions = state.waitSessions.map((session) => {
    if (!session.active || isFreshWaitSession(session, now)) return session;
    changed = true;
    const endedAt = now.toISOString();
    return { ...session, active: false, endedAt, lastHeartbeatAt: endedAt };
  });
  if (!state.profile.handle.startsWith("machiai-")) return { state: { ...state, waitSessions }, changed };
  return {
    state: {
      ...state,
      waitSessions,
      profile: {
        ...state.profile,
        handle: state.profile.handle.replace(/^machiai-/, "coder-"),
        updatedAt: new Date().toISOString(),
      },
    },
    changed: true,
  };
}

export function saveState(state: LocalState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function updateProfile(displayName?: string, twitterHandle?: string): PlayerProfile {
  const state = loadState();
  if (displayName !== undefined || twitterHandle !== undefined) {
    state.profile = {
      ...state.profile,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(twitterHandle !== undefined ? { twitterHandle: normalizeTwitterHandle(twitterHandle) } : {}),
      updatedAt: new Date().toISOString(),
    };
    saveState(state);
  }
  return state.profile;
}

export function saveProfile(profile: PlayerProfile): PlayerProfile {
  const state = loadState();
  state.profile = {
    ...state.profile,
    ...profile,
    twitterHandle: "twitterHandle" in profile ? profile.twitterHandle : state.profile.twitterHandle,
    xUserId: "xUserId" in profile ? profile.xUserId : state.profile.xUserId,
    authToken: "authToken" in profile ? profile.authToken : state.profile.authToken,
    profileImageUrl: "profileImageUrl" in profile ? profile.profileImageUrl : state.profile.profileImageUrl,
    updatedAt: profile.updatedAt ?? new Date().toISOString(),
  };
  saveState(state);
  return state.profile;
}

/** Drop the stored X auth so the UI returns to a signed-out state (e.g. server no longer knows the token). */
export function clearAuth(): PlayerProfile {
  const state = loadState();
  const profile = { ...state.profile };
  delete profile.authToken;
  delete profile.xUserId;
  profile.updatedAt = new Date().toISOString();
  state.profile = profile;
  saveState(state);
  return state.profile;
}

export function recordMatch(record: MatchRecord): MatchRecord {
  const state = loadState();
  const pending = state.pendingRatings?.[record.gameId];
  const finalRecord: MatchRecord = pending ? { ...record, mmrDelta: pending.mmrDelta, mmrAfter: pending.mmrAfter } : record;
  const matches = state.matches ?? [];
  const index = matches.findIndex((item) => item.gameId === finalRecord.gameId);
  if (index >= 0) matches[index] = { ...matches[index], ...finalRecord };
  else matches.push(finalRecord);
  state.matches = matches.slice(-MAX_STORED_MATCHES);
  if (pending && state.pendingRatings) delete state.pendingRatings[record.gameId];
  saveState(state);
  return finalRecord;
}

/** Attach a rating to its game by id; if the match isn't recorded yet, buffer it (events can race). */
export function attachMatchRating(gameId: string, mmrDelta: number, mmrAfter: number): MatchRecord | undefined {
  const state = loadState();
  const matches = state.matches ?? [];
  const index = matches.findIndex((item) => item.gameId === gameId);
  if (index >= 0) {
    matches[index] = { ...matches[index], mmrDelta, mmrAfter };
    state.matches = matches;
    saveState(state);
    return matches[index];
  }
  const pending = { ...(state.pendingRatings ?? {}), [gameId]: { mmrDelta, mmrAfter } };
  const keys = Object.keys(pending);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PENDING_RATINGS))) delete pending[key];
  state.pendingRatings = pending;
  saveState(state);
  return undefined;
}

export function recentMatches(limit = 25): MatchRecord[] {
  const matches = loadState().matches ?? [];
  return matches.slice(-limit).reverse();
}

export function getReferenceSelector(): ReferenceSelector | undefined {
  return loadState().referenceSelector;
}

export function setReferenceSelector(selector: ReferenceSelector): ReferenceSelector {
  const state = loadState();
  state.referenceSelector = selector;
  saveState(state);
  return selector;
}

export function createLocalWaitSession(input: { agent: string; workspace?: string; goal?: string }): WaitSession {
  const state = loadState();
  const now = new Date().toISOString();
  const session: WaitSession = {
    sessionId: createId("wait"),
    playerId: state.profile.playerId,
    agent: input.agent,
    workspace: input.workspace,
    goal: input.goal,
    active: true,
    startedAt: now,
    lastHeartbeatAt: now,
  };
  state.waitSessions.push(session);
  saveState(state);
  return session;
}

export function endLocalWaitSession(sessionId: string): WaitSession | undefined {
  const state = loadState();
  const now = new Date().toISOString();
  const session = state.waitSessions.find((item) => item.sessionId === sessionId);
  if (!session) return undefined;
  session.active = false;
  session.endedAt = now;
  session.lastHeartbeatAt = now;
  saveState(state);
  return session;
}

export function heartbeatLocalWaitSession(sessionId: string): WaitSession | undefined {
  const state = loadState();
  const now = new Date().toISOString();
  const session = state.waitSessions.find((item) => item.sessionId === sessionId);
  if (!session || !session.active) return undefined;
  session.lastHeartbeatAt = now;
  saveState(state);
  return session;
}

export function isFreshWaitSession(session: WaitSession, now = new Date()): boolean {
  if (!session.active) return false;
  const lastHeartbeatMs = Date.parse(session.lastHeartbeatAt || session.startedAt);
  return Number.isFinite(lastHeartbeatMs) && now.getTime() - lastHeartbeatMs <= LOCAL_WAIT_SESSION_TTL_MS;
}

export function activeLocalWaitSession(now = new Date()): WaitSession | undefined {
  const sessions = loadState().waitSessions;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (isFreshWaitSession(sessions[i], now)) return sessions[i];
  }
  return undefined;
}

export function upsertLocalGame(game: GameState): GameState {
  const state = loadState();
  const index = state.games.findIndex((item) => item.gameId === game.gameId);
  if (index >= 0) state.games[index] = game;
  else state.games.push(game);
  saveState(state);
  return game;
}

export function createLocalBotGame(sessionId: string): GameState {
  const state = loadState();
  const session = state.waitSessions.find((item) => item.sessionId === sessionId && isFreshWaitSession(item));
  if (!session) throw new Error("Rated queue is locked until an agent is running.");
  const game = createGame({
    mode: "bot",
    whitePlayerId: state.profile.playerId,
    blackPlayerId: "bot",
    whiteHandle: state.profile.displayName || state.profile.handle,
    blackHandle: "Machiai Bot",
    whiteTwitterHandle: state.profile.twitterHandle,
    whiteMmr: state.profile.mmr,
    blackMmr: botMmrForPlayer(state.profile.mmr),
  });
  state.games.push(game);
  saveState(state);
  return game;
}
