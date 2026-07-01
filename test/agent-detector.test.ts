import assert from "node:assert/strict";
import test from "node:test";
import { detectAgentActivity } from "../packages/cli/src/agent-detector.js";
import type { LocalState } from "../packages/cli/src/local.js";

const now = new Date("2026-07-01T12:00:00.000Z");

test("active local wait sessions unlock the overlay", async () => {
  const detection = await detectAgentActivity({
    now,
    processNames: ["Codex"],
    state: stateWithSession(true),
  });
  assert.equal(detection.status, "active");
  assert.equal(detection.source, "local-session");
  assert.equal(detection.sessionId, "wait_test");
});

test("terminal codex and claude processes are treated as active", async () => {
  const codex = await detectAgentActivity({
    now,
    processNames: ["launchd", "codex"],
    state: stateWithSession(false),
  });
  assert.equal(codex.status, "active");
  assert.equal(codex.source, "process");
  assert.equal(codex.agent, "codex");

  const claude = await detectAgentActivity({
    now,
    processNames: ["launchd", "claude"],
    state: stateWithSession(false),
  });
  assert.equal(claude.status, "active");
  assert.equal(claude.source, "process");
  assert.equal(claude.agent, "claude");
});

test("open GUI apps are maybe, not active", async () => {
  const detection = await detectAgentActivity({
    now,
    processNames: ["Claude"],
    state: stateWithSession(false),
  });
  assert.equal(detection.status, "maybe");
  assert.equal(detection.source, "app");
});

test("no session and no supported process keeps the queue inactive", async () => {
  const detection = await detectAgentActivity({
    now,
    processNames: ["Finder"],
    state: stateWithSession(false),
  });
  assert.equal(detection.status, "inactive");
  assert.equal(detection.source, "none");
});

test("ended local wait sessions do not unlock the overlay", async () => {
  const detection = await detectAgentActivity({
    now,
    processNames: [],
    state: stateWithEndedSession(),
  });
  assert.equal(detection.status, "inactive");
  assert.equal(detection.source, "none");
});

function stateWithSession(active: boolean): LocalState {
  return {
    profile: {
      playerId: "player_test",
      deviceKey: "device_test",
      handle: "machiai-test",
      mmr: 500,
      ratedGames: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    waitSessions: active
      ? [
          {
            sessionId: "wait_test",
            playerId: "player_test",
            agent: "codex",
            workspace: "/tmp/workspace",
            active: true,
            startedAt: now.toISOString(),
            lastHeartbeatAt: now.toISOString(),
          },
        ]
      : [],
    games: [],
  };
}

function stateWithEndedSession(): LocalState {
  const state = stateWithSession(true);
  state.waitSessions[0].active = false;
  state.waitSessions[0].endedAt = now.toISOString();
  return state;
}
