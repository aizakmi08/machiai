import { Chess } from "chess.js";

export function chooseBotMove(fen: string): string {
  const chess = new Chess(fen);
  const moves = chess.moves();
  if (moves.length === 0) {
    throw new Error("No legal bot moves are available.");
  }
  return moves[0];
}
