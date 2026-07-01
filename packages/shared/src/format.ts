import { Chess } from "chess.js";
import type { Color, GameState } from "./types.js";

const PIECES: Record<string, string> = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const ASCII: Record<string, string> = {
  wp: "P",
  wn: "N",
  wb: "B",
  wr: "R",
  wq: "Q",
  wk: "K",
  bp: "p",
  bn: "n",
  bb: "b",
  br: "r",
  bq: "q",
  bk: "k",
};

export function formatClock(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.ceil(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function renderBoard(fen: string, perspective: Color = "white", ascii = false): string {
  const chess = new Chess(fen);
  const board = chess.board();
  const ranks = perspective === "white" ? board : [...board].reverse();
  const rankLabels = perspective === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = perspective === "white" ? ["a", "b", "c", "d", "e", "f", "g", "h"] : ["h", "g", "f", "e", "d", "c", "b", "a"];
  const pieceMap = ascii ? ASCII : PIECES;
  const rows = ranks.map((rank, i) => {
    const filesInRank = perspective === "white" ? rank : [...rank].reverse();
    const cells = filesInRank
      .map((piece) => {
        if (!piece) return ascii ? "." : "·";
        return pieceMap[`${piece.color}${piece.type}`] ?? "?";
      })
      .join(" ");
    return `${rankLabels[i]}  ${cells}`;
  });
  return `${rows.join("\n")}\n\n   ${files.join(" ")}`;
}

export function formatGameLine(game: GameState, playerId?: string): string {
  const you =
    playerId === game.whitePlayerId ? "White" : playerId === game.blackPlayerId ? "Black" : "Spectator";
  const result = game.status === "ended" ? ` ${game.result ?? "ended"} by ${game.endReason ?? "unknown"}` : "";
  return `${you} | ${game.whiteHandle} ${formatClock(game.clocks.whiteMs)} vs ${game.blackHandle} ${formatClock(
    game.clocks.blackMs,
  )} | turn=${game.turn}${result}`;
}
