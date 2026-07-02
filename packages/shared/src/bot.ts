import { Chess, type Color as ChessColor, type Move } from "chess.js";

const PIECE_VALUE: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

export function botMmrForPlayer(playerMmr: number): number {
  if (playerMmr < 650) return 650;
  if (playerMmr < 900) return 850;
  if (playerMmr < 1200) return 1100;
  return 1400;
}

export function chooseBotMove(fen: string, botMmr = 650): string {
  const chess = new Chess(fen);
  const moves = orderedMoves(chess);
  if (moves.length === 0) {
    throw new Error("No legal bot moves are available.");
  }
  const botColor = chess.turn();
  const depth = botMmr >= 1200 ? 3 : botMmr >= 850 ? 2 : 1;
  const scored = moves.map((move) => {
    const next = new Chess(fen);
    next.move(move);
    return {
      move,
      score: search(next, depth - 1, botColor, -Infinity, Infinity),
    };
  });
  scored.sort((a, b) => b.score - a.score || moveTiebreak(a.move).localeCompare(moveTiebreak(b.move)));
  return scored[0].move.san;
}

function search(chess: Chess, depth: number, botColor: ChessColor, alpha: number, beta: number): number {
  if (depth <= 0 || chess.isGameOver()) return evaluate(chess, botColor);
  const maximizing = chess.turn() === botColor;
  const moves = orderedMoves(chess).slice(0, depth >= 2 ? 14 : 24);
  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      const next = new Chess(chess.fen());
      next.move(move);
      best = Math.max(best, search(next, depth - 1, botColor, alpha, beta));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    const next = new Chess(chess.fen());
    next.move(move);
    best = Math.min(best, search(next, depth - 1, botColor, alpha, beta));
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function evaluate(chess: Chess, botColor: ChessColor): number {
  if (chess.isCheckmate()) return chess.turn() === botColor ? -100_000 : 100_000;
  if (chess.isDraw()) return 0;

  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = PIECE_VALUE[piece.type] ?? 0;
      score += piece.color === botColor ? value : -value;
    }
  }
  if (chess.inCheck()) score += chess.turn() === botColor ? -35 : 35;
  return score;
}

function orderedMoves(chess: Chess): Move[] {
  const moves = chess.moves({ verbose: true });
  return moves.sort((a, b) => movePriority(b) - movePriority(a) || moveTiebreak(a).localeCompare(moveTiebreak(b)));
}

function movePriority(move: Move): number {
  let priority = 0;
  if (move.captured) priority += PIECE_VALUE[move.captured] ?? 0;
  if (move.promotion) priority += PIECE_VALUE[move.promotion] ?? 0;
  if (["d4", "d5", "e4", "e5"].includes(move.to)) priority += 12;
  if (move.san.includes("+")) priority += 25;
  if (move.san.includes("#")) priority += 100_000;
  return priority;
}

function moveTiebreak(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}
