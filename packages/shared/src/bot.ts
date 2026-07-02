import { Chess } from "chess.js";

const PIECE_VALUE: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

export function chooseBotMove(fen: string): string {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    throw new Error("No legal bot moves are available.");
  }
  const color = chess.turn();
  const scored = moves.map((move) => {
    const next = new Chess(fen);
    next.move(move);
    let score = materialScore(next, color);
    if (move.captured) score += (PIECE_VALUE[move.captured] ?? 0) * 1.25;
    if (move.promotion) score += PIECE_VALUE[move.promotion] ?? 0;
    if (next.isCheckmate()) score += 100_000;
    else if (next.isCheck()) score += 45;
    if (["d4", "d5", "e4", "e5"].includes(move.to)) score += 12;
    return { move, score };
  });
  scored.sort((a, b) => b.score - a.score || a.move.san.localeCompare(b.move.san));
  return scored[0].move.san;
}

function materialScore(chess: Chess, color: "w" | "b"): number {
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = PIECE_VALUE[piece.type] ?? 0;
      score += piece.color === color ? value : -value;
    }
  }
  return score;
}
