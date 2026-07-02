import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachMatchRating, recentMatches, recordMatch } from "../packages/cli/src/local.js";
import type { MatchRecord } from "../packages/shared/src/index.js";

const HOME = join(tmpdir(), `machiai-match-test-${process.pid}`);

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  process.env.MACHIAI_HOME = HOME;
});

function rated(gameId: string, result: MatchRecord["result"]): MatchRecord {
  return { gameId, playedAt: new Date().toISOString(), mode: "rated", rated: true, result, opponentHandle: "opp" };
}

test("rating recorded, then attached in normal order", () => {
  recordMatch(rated("g1", "win"));
  attachMatchRating("g1", 24, 524);
  const m = recentMatches().find((x) => x.gameId === "g1");
  assert.equal(m?.mmrDelta, 24);
  assert.equal(m?.mmrAfter, 524);
});

test("rating that arrives BEFORE the match is buffered and applied on record (out-of-order)", () => {
  attachMatchRating("g2", -18, 482); // arrives first
  recordMatch(rated("g2", "loss"));
  const m = recentMatches().find((x) => x.gameId === "g2");
  assert.equal(m?.mmrDelta, -18);
  assert.equal(m?.mmrAfter, 482);
});

test("a late rating attaches to its OWN game, not the newest unrated one", () => {
  recordMatch(rated("gA", "win"));
  recordMatch(rated("gB", "loss"));
  attachMatchRating("gA", 10, 510); // belongs to the older game
  const list = recentMatches();
  assert.equal(list.find((x) => x.gameId === "gA")?.mmrDelta, 10);
  assert.equal(list.find((x) => x.gameId === "gB")?.mmrDelta, undefined); // NOT clobbered
});
