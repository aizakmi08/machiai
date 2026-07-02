import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { detectAgentActivity, resetAgentDetectionMemoryForTests } from "../packages/cli/src/agent-detector.js";
import type { LocalState } from "../packages/cli/src/local.js";

const now = new Date("2026-07-01T12:00:00.000Z");

beforeEach(() => {
  resetAgentDetectionMemoryForTests();
});

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

test("terminal codex and claude processes are only maybe without a Machiai wait session", async () => {
  const codex = await detectAgentActivity({
    now,
    processNames: ["launchd", "codex"],
    state: stateWithSession(false),
  });
  assert.equal(codex.status, "maybe");
  assert.equal(codex.source, "process");
  assert.equal(codex.agent, "codex");

  const claude = await detectAgentActivity({
    now,
    processNames: ["launchd", "claude"],
    state: stateWithSession(false),
  });
  assert.equal(claude.status, "maybe");
  assert.equal(claude.source, "process");
  assert.equal(claude.agent, "claude");
});

test("one-shot codex and claude CLI agent commands unlock the overlay", async () => {
  const codex = await detectAgentActivity({
    now,
    processes: [
      {
        name: "codex",
        commandLine: '/Applications/Codex.app/Contents/Resources/codex exec "build the feature"',
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(codex.status, "active");
  assert.equal(codex.source, "process");
  assert.equal(codex.agent, "codex");

  const claude = await detectAgentActivity({
    now,
    processes: [
      {
        name: "claude",
        commandLine: 'claude -p "fix the bug"',
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(claude.status, "active");
  assert.equal(claude.source, "process");
  assert.equal(claude.agent, "claude");
});

test("codex app-server and visible app processes stay maybe instead of active", async () => {
  const detection = await detectAgentActivity({
    now,
    processes: [
      {
        name: "codex",
        commandLine: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
        cpuPercent: 0,
      },
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/MacOS/Codex",
        cpuPercent: 0,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(detection.status, "maybe");
  assert.equal(detection.source, "app");
  assert.equal(detection.agent, "Codex");
});

test("active Codex app CPU activity unlocks the overlay without reading app contents", async () => {
  const detection = await detectAgentActivity({
    now,
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
        cpuPercent: 12.5,
      },
      {
        name: "codex",
        commandLine: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
        cpuPercent: 1.1,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(detection.status, "active");
  assert.equal(detection.source, "app-activity");
  assert.equal(detection.agent, "Codex");
});

test("background-only Codex helper activity does not unlock the overlay", async () => {
  const detection = await detectAgentActivity({
    now,
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler",
        cpuPercent: 99,
      },
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/MacOS/Codex",
        cpuPercent: 0,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(detection.status, "maybe");
  assert.equal(detection.source, "app");
});

test("recent Codex app activity stays active between CPU bursts", async () => {
  const active = await detectAgentActivity({
    now,
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
        cpuPercent: 18,
      },
      {
        name: "codex",
        commandLine: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
        cpuPercent: 0.2,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(active.status, "active");
  assert.equal(active.source, "app-activity");

  const quiet = await detectAgentActivity({
    now: new Date(now.getTime() + 2000),
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/MacOS/Codex",
        cpuPercent: 0,
      },
      {
        name: "codex",
        commandLine: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
        cpuPercent: 0,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(quiet.status, "active");
  assert.equal(quiet.source, "app-activity");
  assert.match(quiet.reason, /between work bursts/);
});

test("recent app activity expires instead of unlocking forever", async () => {
  await detectAgentActivity({
    now,
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
        cpuPercent: 18,
      },
    ],
    state: stateWithSession(false),
  });

  const expired = await detectAgentActivity({
    now: new Date(now.getTime() + 46_000),
    processes: [
      {
        name: "Codex",
        commandLine: "/Applications/Codex.app/Contents/MacOS/Codex",
        cpuPercent: 0,
      },
    ],
    state: stateWithSession(false),
  });
  assert.equal(expired.status, "maybe");
  assert.equal(expired.source, "app");
});

test("overlay app mode can unlock visible agent processes", async () => {
  const codex = await detectAgentActivity({
    now,
    processNames: ["launchd", "codex"],
    state: stateWithSession(false),
    trustVisibleAgentApps: true,
  });
  assert.equal(codex.status, "active");
  assert.equal(codex.source, "process");

  const app = await detectAgentActivity({
    now,
    processNames: ["Codex Helper (Renderer)"],
    state: stateWithSession(false),
    trustVisibleAgentApps: true,
  });
  assert.equal(app.status, "active");
  assert.equal(app.source, "app");
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

test("stale active local wait sessions do not unlock the overlay", async () => {
  const state = stateWithSession(true);
  state.waitSessions[0].lastHeartbeatAt = "2026-07-01T11:58:00.000Z";
  const detection = await detectAgentActivity({
    now,
    processNames: [],
    state,
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
