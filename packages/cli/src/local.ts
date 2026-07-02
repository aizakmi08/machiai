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
  type PlayerProfile,
  type WaitSession,
} from "../../shared/src/index.js";

export interface LocalState {
  profile: PlayerProfile;
  waitSessions: WaitSession[];
  games: GameState[];
}

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
  if (!state.profile.handle.startsWith("machiai-")) return { state, changed: false };
  return {
    state: {
      ...state,
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
  state.profile = { ...state.profile, ...profile, twitterHandle: profile.twitterHandle, updatedAt: profile.updatedAt ?? new Date().toISOString() };
  saveState(state);
  return state.profile;
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

export function activeLocalWaitSession(): WaitSession | undefined {
  const sessions = loadState().waitSessions;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].active) return sessions[i];
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
  const session = state.waitSessions.find((item) => item.sessionId === sessionId && item.active);
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
