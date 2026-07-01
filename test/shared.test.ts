import assert from "node:assert/strict";
import test from "node:test";
import {
  STARTING_MMR,
  applyMove,
  calculateRating,
  createGame,
  resignGame,
} from "../packages/shared/src/index.js";

test("legal moves update chess state and illegal moves throw", () => {
  const game = createGame({
    mode: "rated",
    whitePlayerId: "white",
    blackPlayerId: "black",
    whiteHandle: "white",
    blackHandle: "black",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const afterWhite = applyMove(game, "white", "e2e4", new Date("2026-07-01T00:00:01.000Z")).game;
  assert.equal(afterWhite.moves[0].san, "e4");
  assert.equal(afterWhite.turn, "black");
  assert.throws(() => applyMove(afterWhite, "white", "e2e5", new Date("2026-07-01T00:00:02.000Z")));
});

test("timeout ends the game without pausing", () => {
  const game = createGame({
    mode: "rated",
    whitePlayerId: "white",
    blackPlayerId: "black",
    whiteHandle: "white",
    blackHandle: "black",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const expired = applyMove(game, "white", "e2e4", new Date("2026-07-01T00:03:01.000Z")).game;
  assert.equal(expired.status, "ended");
  assert.equal(expired.result, "black_win");
  assert.equal(expired.endReason, "timeout");
});

test("resign records a rated loss result", () => {
  const game = createGame({
    mode: "rated",
    whitePlayerId: "white",
    blackPlayerId: "black",
    whiteHandle: "white",
    blackHandle: "black",
  });
  const ended = resignGame(game, "black");
  assert.equal(ended.status, "ended");
  assert.equal(ended.result, "white_win");
  assert.equal(ended.endReason, "resignation");
});

test("starting MMR changes symmetrically after a decisive first game", () => {
  const result = calculateRating(
    { mmr: STARTING_MMR, ratedGames: 0 },
    { mmr: STARTING_MMR, ratedGames: 0 },
    "white_win",
  );
  assert.equal(result.white.delta, 20);
  assert.equal(result.black.delta, -20);
  assert.equal(result.white.newMmr, 520);
  assert.equal(result.black.newMmr, 480);
});

test("aborted games do not change MMR", () => {
  const result = calculateRating({ mmr: 600, ratedGames: 4 }, { mmr: 500, ratedGames: 4 }, "aborted");
  assert.equal(result.white.delta, 0);
  assert.equal(result.black.delta, 0);
});
