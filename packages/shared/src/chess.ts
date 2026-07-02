import { Chess, type Move } from "chess.js";
import { BLITZ_CLOCK_MS, type Color, type GameEndReason, type GameResult, type GameState } from "./types.js";
import { createId } from "./ids.js";

export interface NewGameInput {
  mode: "rated" | "bot";
  whitePlayerId: string;
  blackPlayerId: string;
  whiteHandle: string;
  blackHandle: string;
  whiteTwitterHandle?: string;
  blackTwitterHandle?: string;
  whiteMmr?: number;
  blackMmr?: number;
  now?: Date;
}

export interface MoveResult {
  game: GameState;
  move?: Move;
}

export function createGame(input: NewGameInput): GameState {
  const now = (input.now ?? new Date()).toISOString();
  const chess = new Chess();
  return {
    gameId: createId("game"),
    mode: input.mode,
    rated: input.mode === "rated",
    status: "active",
    whitePlayerId: input.whitePlayerId,
    blackPlayerId: input.blackPlayerId,
    whiteHandle: input.whiteHandle,
    blackHandle: input.blackHandle,
    whiteTwitterHandle: input.whiteTwitterHandle,
    blackTwitterHandle: input.blackTwitterHandle,
    whiteMmr: input.whiteMmr,
    blackMmr: input.blackMmr,
    fen: chess.fen(),
    pgn: chess.pgn(),
    turn: "white",
    clocks: {
      whiteMs: BLITZ_CLOCK_MS,
      blackMs: BLITZ_CLOCK_MS,
      lastTickAt: now,
    },
    moves: [],
    startedAt: now,
    bothPlayersMoved: false,
  };
}

export function applyMove(game: GameState, playerId: string, moveInput: string, now = new Date()): MoveResult {
  ensureActive(game);
  let next = tickClock(game, now);
  if (next.status === "ended") return { game: next };

  const color = playerColor(next, playerId);
  if (color !== next.turn) {
    throw new Error(`It is ${next.turn}'s turn.`);
  }

  const chess = new Chess(next.fen);
  const move = makeMove(chess, moveInput);
  const createdAt = now.toISOString();
  next = {
    ...next,
    fen: chess.fen(),
    pgn: chess.pgn(),
    turn: chess.turn() === "w" ? "white" : "black",
    clocks: {
      ...next.clocks,
      lastTickAt: createdAt,
    },
    moves: [
      ...next.moves,
      {
        ply: next.moves.length + 1,
        playerId,
        color,
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion,
        fenAfter: chess.fen(),
        createdAt,
      },
    ],
  };

  next = {
    ...next,
    bothPlayersMoved: hasBothPlayersMoved(next),
  };

  if (chess.isCheckmate()) {
    return { game: endGame(next, color === "white" ? "white_win" : "black_win", "checkmate", now), move };
  }
  if (chess.isStalemate()) {
    return { game: endGame(next, "draw", "stalemate", now), move };
  }
  if (chess.isDraw()) {
    return { game: endGame(next, "draw", "draw", now), move };
  }
  return { game: next, move };
}

export function resignGame(game: GameState, playerId: string, now = new Date()): GameState {
  ensureActive(game);
  const color = playerColor(game, playerId);
  return endGame(game, color === "white" ? "black_win" : "white_win", "resignation", now);
}

export function abortGame(game: GameState, reason: GameEndReason = "aborted", now = new Date()): GameState {
  return endGame(game, "aborted", reason, now);
}

export function tickClock(game: GameState, now = new Date()): GameState {
  if (game.status === "ended") return game;
  const last = Date.parse(game.clocks.lastTickAt);
  const elapsed = Math.max(0, now.getTime() - last);
  const whiteMs = game.turn === "white" ? Math.max(0, game.clocks.whiteMs - elapsed) : game.clocks.whiteMs;
  const blackMs = game.turn === "black" ? Math.max(0, game.clocks.blackMs - elapsed) : game.clocks.blackMs;
  const next = {
    ...game,
    clocks: {
      whiteMs,
      blackMs,
      lastTickAt: now.toISOString(),
    },
  };
  if (whiteMs <= 0) return endGame(next, "black_win", "timeout", now);
  if (blackMs <= 0) return endGame(next, "white_win", "timeout", now);
  return next;
}

export function playerColor(game: GameState, playerId: string): Color {
  if (game.whitePlayerId === playerId) return "white";
  if (game.blackPlayerId === playerId) return "black";
  throw new Error("Player is not in this game.");
}

export function opponentColor(color: Color): Color {
  return color === "white" ? "black" : "white";
}

export function resultForColor(result: GameResult | undefined, color: Color): "win" | "loss" | "draw" | "none" {
  if (!result || result === "aborted") return "none";
  if (result === "draw") return "draw";
  if (result === "white_win") return color === "white" ? "win" : "loss";
  return color === "black" ? "win" : "loss";
}

export function boardFromFen(fen: string): string[][] {
  const board = new Chess(fen).board();
  return board.map((rank) => rank.map((piece) => (piece ? `${piece.color}${piece.type}` : "")));
}

function makeMove(chess: Chess, input: string): Move {
  const trimmed = input.trim();
  const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(trimmed);
  const move = uci
    ? chess.move({ from: uci[1].toLowerCase(), to: uci[2].toLowerCase(), promotion: uci[3]?.toLowerCase() })
    : chess.move(trimmed);
  if (!move) throw new Error(`Illegal move: ${input}`);
  return move;
}

function ensureActive(game: GameState): void {
  if (game.status !== "active") {
    throw new Error("Game is already ended.");
  }
}

function hasBothPlayersMoved(game: GameState): boolean {
  return game.moves.some((m) => m.color === "white") && game.moves.some((m) => m.color === "black");
}

function endGame(game: GameState, result: GameResult, reason: GameEndReason, now: Date): GameState {
  return {
    ...game,
    status: "ended",
    result,
    endReason: reason,
    endedAt: now.toISOString(),
    clocks: {
      ...game.clocks,
      lastTickAt: now.toISOString(),
    },
  };
}
