export type Color = "white" | "black";

export type GameMode = "rated" | "bot";

export type GameStatus = "active" | "ended";

export type GameResult = "white_win" | "black_win" | "draw" | "aborted";

export type GameEndReason =
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resignation"
  | "timeout"
  | "disconnect"
  | "aborted";

export interface PlayerProfile {
  playerId: string;
  deviceKey: string;
  handle: string;
  displayName?: string;
  twitterHandle?: string;
  xUserId?: string;
  authToken?: string;
  profileImageUrl?: string;
  mmr: number;
  ratedGames: number;
  createdAt: string;
  updatedAt: string;
}

export interface WaitSession {
  sessionId: string;
  playerId: string;
  agent: string;
  workspace?: string;
  goal?: string;
  active: boolean;
  startedAt: string;
  endedAt?: string;
  lastHeartbeatAt: string;
}

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  lastTickAt: string;
}

export interface MoveRecord {
  ply: number;
  playerId: string;
  color: Color;
  san: string;
  from: string;
  to: string;
  promotion?: string;
  fenAfter: string;
  createdAt: string;
}

export interface GameState {
  gameId: string;
  mode: GameMode;
  rated: boolean;
  status: GameStatus;
  whitePlayerId: string;
  blackPlayerId: string;
  whiteHandle: string;
  blackHandle: string;
  whiteTwitterHandle?: string;
  blackTwitterHandle?: string;
  whiteMmr?: number;
  blackMmr?: number;
  fen: string;
  pgn: string;
  turn: Color;
  clocks: ClockState;
  moves: MoveRecord[];
  startedAt: string;
  endedAt?: string;
  result?: GameResult;
  endReason?: GameEndReason;
  bothPlayersMoved: boolean;
}

export interface RatingInput {
  mmr: number;
  ratedGames: number;
}

export interface RatingChange {
  oldMmr: number;
  newMmr: number;
  delta: number;
}

export interface RatingResult {
  white: RatingChange;
  black: RatingChange;
}

export interface QueueTicket {
  playerId: string;
  handle: string;
  twitterHandle?: string;
  mmr: number;
  sessionId: string;
  joinedAt: string;
  socketId: string;
}

export interface LeaderboardEntry {
  playerId: string;
  handle: string;
  displayName?: string;
  twitterHandle?: string;
  mmr: number;
  ratedGames: number;
}

export interface MachiaiError {
  code: string;
  message: string;
}

export interface PresenceState {
  onlinePlayers: number;
  updatedAt: string;
}

export const STARTING_MMR = 500;
export const BLITZ_CLOCK_MS = 3 * 60 * 1000;
export const RECONNECT_GRACE_MS = 30 * 1000;
export const BOT_FALLBACK_MS = 20 * 1000;
