import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { detectAgentActivity, resetAgentDetectionMemoryForTests } from "../packages/cli/src/agent-detector.js";
import type { LocalState } from "../packages/cli/src/local.js";
import type { AgentSessionSummary, ReferenceSelector } from "../packages/shared/src/index.js";

beforeEach(() => resetAgentDetectionMemoryForTests());

const now = new Date("2026-07-02T12:00:00.000Z");

// A realistic mixed registry: Claude running in a terminal, Codex idle in the app.
const registry: AgentSessionSummary[] = [
  { id: "claude-1", agent: "claude", surface: "terminal", state: "running", lastEventAt: now.toISOString(), signal: "transcript" },
  { id: "codex-1", agent: "codex", surface: "app", state: "idle", lastEventAt: now.toISOString(), signal: "transcript" },
];

function emptyState(): LocalState {
  return {
    profile: {
      playerId: "p", deviceKey: "d", handle: "coder-x", mmr: 500, ratedGames: 0,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    },
    waitSessions: [],
    games: [],
  };
}

async function detectWith(reference: ReferenceSelector) {
  return detectAgentActivity({ now, state: emptyState(), processes: [], registry, reference });
}

test("Auto unlocks on any running agent", async () => {
  const d = await detectWith({ kind: "auto" });
  assert.equal(d.status, "active");
  assert.equal(d.agent, "claude");
});

test("Only Claude unlocks (Claude is running)", async () => {
  const d = await detectWith({ kind: "filter", agent: "claude" });
  assert.equal(d.status, "active");
  assert.equal(d.agent, "claude");
});

test("Only Codex does NOT unlock (Codex is idle)", async () => {
  const d = await detectWith({ kind: "filter", agent: "codex" });
  assert.equal(d.status, "maybe");
  assert.equal(d.source, "session");
});

test("Only terminal unlocks (the running Claude is a terminal session)", async () => {
  const d = await detectWith({ kind: "filter", surface: "terminal" });
  assert.equal(d.status, "active");
});

test("Only app does NOT unlock (the only app session is idle)", async () => {
  const d = await detectWith({ kind: "filter", surface: "app" });
  assert.equal(d.status, "maybe");
});

test("Pinning the running session unlocks; pinning the idle one does not", async () => {
  const run = await detectWith({ kind: "session", sessionId: "claude-1" });
  assert.equal(run.status, "active");
  assert.equal(run.sessionId, "claude-1");

  const idle = await detectWith({ kind: "session", sessionId: "codex-1" });
  assert.equal(idle.status, "maybe");
});

test("Pinning a session that no longer exists self-heals to Auto", async () => {
  const d = await detectWith({ kind: "session", sessionId: "ended-yesterday" });
  assert.equal(d.status, "active"); // fell back to Auto, which sees the running Claude
  assert.equal(d.reference?.kind, "auto");
});

test("With no sessions at all, nothing unlocks", async () => {
  const d = await detectAgentActivity({ now, state: emptyState(), processes: [], registry: [], reference: { kind: "auto" } });
  assert.equal(d.status, "inactive");
});

// Registry with only an IDLE Codex session (no running session), to exercise the app-CPU fallback path.
const idleCodexOnly: AgentSessionSummary[] = [
  { id: "codex-1", agent: "codex", surface: "app", state: "idle", lastEventAt: now.toISOString(), signal: "transcript" },
];

test("an idle transcript suppresses same-agent app-CPU noise (idle Codex app can't fake active)", async () => {
  const codexAppCpu = [
    { name: "Codex", commandLine: "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)", cpuPercent: 18 },
  ];
  const d = await detectAgentActivity({ now, state: emptyState(), processes: codexAppCpu, registry: idleCodexOnly, reference: { kind: "auto" } });
  assert.equal(d.status, "maybe"); // codex transcript is idle -> not overridden by app CPU
  assert.equal(d.source, "session");
});

test("app-CPU still unlocks for an agent the transcript does NOT track (e.g. Cursor)", async () => {
  const cursorAppCpu = [
    { name: "Cursor", commandLine: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor (Renderer)", cpuPercent: 22 },
  ];
  const d = await detectAgentActivity({ now, state: emptyState(), processes: cursorAppCpu, registry: idleCodexOnly, reference: { kind: "auto" } });
  assert.equal(d.status, "active");
  assert.equal(d.source, "app-activity");
});
