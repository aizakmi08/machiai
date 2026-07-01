import type { GameResult, RatingInput, RatingResult } from "./types.js";

export function kFactor(player: RatingInput): number {
  return player.ratedGames < 20 ? 40 : 24;
}

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

export function resultScores(result: GameResult): { white: number; black: number } {
  if (result === "white_win") return { white: 1, black: 0 };
  if (result === "black_win") return { white: 0, black: 1 };
  if (result === "draw") return { white: 0.5, black: 0.5 };
  return { white: 0, black: 0 };
}

export function calculateRating(
  white: RatingInput,
  black: RatingInput,
  result: GameResult,
): RatingResult {
  if (result === "aborted") {
    return {
      white: { oldMmr: white.mmr, newMmr: white.mmr, delta: 0 },
      black: { oldMmr: black.mmr, newMmr: black.mmr, delta: 0 },
    };
  }

  const scores = resultScores(result);
  const whiteExpected = expectedScore(white.mmr, black.mmr);
  const blackExpected = expectedScore(black.mmr, white.mmr);
  const whiteDelta = Math.round(kFactor(white) * (scores.white - whiteExpected));
  const blackDelta = Math.round(kFactor(black) * (scores.black - blackExpected));

  return {
    white: {
      oldMmr: white.mmr,
      newMmr: Math.max(100, white.mmr + whiteDelta),
      delta: whiteDelta,
    },
    black: {
      oldMmr: black.mmr,
      newMmr: Math.max(100, black.mmr + blackDelta),
      delta: blackDelta,
    },
  };
}
