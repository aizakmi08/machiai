import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegistry,
  classifyClaudeLine,
  claudeSessionState,
  codexSessionState,
  codexSurface,
  hookEventState,
  resolveReference,
  type HookEvent,
} from "../packages/cli/src/session-registry.js";
import type { AgentSessionSummary } from "../packages/shared/src/index.js";

const now = new Date("2026-07-02T12:00:00.000Z");
const nowMs = now.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();

test("claude state: mid-turn is running, finished turn goes idle after quiet, unknown uses recency", () => {
  assert.equal(claudeSessionState({ active: true, lastEventAt: nowMs - 90_000, now: nowMs }), "running");
  // A finished reply flips to idle quickly (short grace only), instead of lingering as "running".
  assert.equal(claudeSessionState({ active: false, lastEventAt: nowMs - 1_000, now: nowMs }), "running");
  assert.equal(claudeSessionState({ active: false, lastEventAt: nowMs - 5_000, now: nowMs }), "idle");
  assert.equal(claudeSessionState({ active: undefined, lastEventAt: nowMs - 5_000, now: nowMs }), "running");
  assert.equal(claudeSessionState({ active: undefined, lastEventAt: nowMs - 120_000, now: nowMs }), "idle");
  // A turn that looks in-progress but has been silent for many minutes is treated as abandoned.
  assert.equal(claudeSessionState({ active: true, lastEventAt: nowMs - 10 * 60_000, now: nowMs }), "idle");
});

test("classifyClaudeLine: tool_use and trailing tool_result are mid-turn, end_turn is finished", () => {
  assert.equal(classifyClaudeLine({ type: "assistant", message: { stop_reason: "tool_use" } }), true);
  assert.equal(classifyClaudeLine({ type: "assistant", message: { stop_reason: "end_turn" } }), false);
  // A huge tool result at the tail must still read as running (the real-world false-idle bug).
  assert.equal(classifyClaudeLine({ type: "user", message: { content: [{ type: "tool_result" }] } }), true);
  assert.equal(classifyClaudeLine({ type: "last-prompt", lastPrompt: "hi" }), undefined);
});

test("codex state keys off task_started / task_complete / turn_aborted", () => {
  assert.equal(codexSessionState({ lastTurnMarker: "task_started", lastEventAt: nowMs - 60_000, now: nowMs }), "running");
  assert.equal(codexSessionState({ lastTurnMarker: "task_complete", lastEventAt: nowMs - 1_000, now: nowMs }), "idle");
  assert.equal(codexSessionState({ lastTurnMarker: "turn_aborted", lastEventAt: nowMs - 1_000, now: nowMs }), "idle");
  assert.equal(codexSessionState({ lastTurnMarker: null, lastEventAt: nowMs - 5_000, now: nowMs }), "running");
});

test("codex surface: desktop/vscode is app, everything else terminal", () => {
  assert.equal(codexSurface("Codex Desktop", "vscode"), "app");
  assert.equal(codexSurface("codex_exec", "exec"), "terminal");
  assert.equal(codexSurface(undefined, undefined), "terminal");
});

test("hook events map to lifecycle states", () => {
  assert.equal(hookEventState("UserPromptSubmit"), "running");
  assert.equal(hookEventState("PostToolUse"), "running");
  assert.equal(hookEventState("Stop"), "idle");
  assert.equal(hookEventState("SessionStart"), "idle");
  assert.equal(hookEventState("SessionEnd"), "ended");
});

test("buildRegistry: hook state wins, transcript surface/workspace survive the merge", () => {
  const claude: AgentSessionSummary[] = [
    {
      id: "s1",
      agent: "claude",
      surface: "terminal",
      state: "idle",
      workspace: "/Users/me/proj",
      gitBranch: "main",
      title: "old idea",
      lastEventAt: ago(10_000),
      signal: "transcript",
    },
  ];
  const hooks: HookEvent[] = [{ agent: "claude", event: "UserPromptSubmit", sessionId: "s1", ts: ago(2_000) }];
  const [session] = buildRegistry({ now, claude, hooks });
  assert.equal(session.state, "running"); // hook beats transcript
  assert.equal(session.signal, "hook");
  assert.equal(session.surface, "terminal"); // transcript metadata preserved
  assert.equal(session.workspace, "/Users/me/proj");
});

test("buildRegistry: stale hook running state falls back to idle (crash backstop)", () => {
  const hooks: HookEvent[] = [{ agent: "codex", event: "UserPromptSubmit", sessionId: "z", ts: ago(10 * 60_000) }];
  const [session] = buildRegistry({ now, hooks });
  assert.equal(session.state, "idle");
});

test("buildRegistry: ended sessions and very old sessions are dropped, running sorts first", () => {
  const codex: AgentSessionSummary[] = [
    { id: "a", agent: "codex", surface: "terminal", state: "idle", lastEventAt: ago(30_000), signal: "transcript" },
    { id: "b", agent: "codex", surface: "app", state: "running", lastEventAt: ago(60_000), signal: "transcript" },
    { id: "c", agent: "codex", surface: "terminal", state: "idle", lastEventAt: ago(7 * 60 * 60_000), signal: "transcript" },
  ];
  const hooks: HookEvent[] = [{ agent: "claude", event: "SessionEnd", sessionId: "d", ts: ago(5_000) }];
  const list = buildRegistry({ now, codex, hooks });
  assert.deepEqual(list.map((s) => s.id), ["b", "a"]); // c too old, d ended
});

test("buildRegistry: a newer running transcript beats a stale idle hook", () => {
  const claude: AgentSessionSummary[] = [
    { id: "s2", agent: "claude", surface: "terminal", state: "running", lastEventAt: ago(1_000), signal: "transcript" },
  ];
  const hooks: HookEvent[] = [{ agent: "claude", event: "Stop", sessionId: "s2", ts: ago(40_000) }];
  const [s] = buildRegistry({ now, claude, hooks });
  assert.equal(s.state, "running"); // live transcript wins over the old Stop
});

test("buildRegistry: a just-fired Stop hook wins the tie over the turn's final transcript line", () => {
  const claude: AgentSessionSummary[] = [
    { id: "s3", agent: "claude", surface: "terminal", state: "running", lastEventAt: ago(1_000), signal: "transcript" },
  ];
  const hooks: HookEvent[] = [{ agent: "claude", event: "Stop", sessionId: "s3", ts: ago(1_500) }];
  const [s] = buildRegistry({ now, claude, hooks });
  assert.equal(s.state, "idle"); // near-simultaneous -> stronger signal (hook) decides
});

test("resolveReference: auto, session pin, and agent/surface filter", () => {
  const sessions: AgentSessionSummary[] = [
    { id: "run-codex", agent: "codex", surface: "terminal", state: "running", lastEventAt: ago(1_000), signal: "hook" },
    { id: "idle-claude", agent: "claude", surface: "terminal", state: "idle", lastEventAt: ago(2_000), signal: "transcript" },
  ];
  assert.equal(resolveReference(sessions, { kind: "auto" }).matched?.id, "run-codex");
  assert.equal(resolveReference(sessions, { kind: "session", sessionId: "idle-claude" }).idleMatch?.id, "idle-claude");
  assert.equal(resolveReference(sessions, { kind: "filter", agent: "codex" }).matched?.id, "run-codex");
  // Filter that matches only an idle session yields idleMatch, not matched.
  const res = resolveReference(sessions, { kind: "filter", agent: "claude" });
  assert.equal(res.matched, undefined);
  assert.equal(res.idleMatch?.id, "idle-claude");
});

test("a transcript clearly newer than a Stop hook keeps the session running (resume after stop)", () => {
  const claude: AgentSessionSummary[] = [
    { id: "s4", agent: "claude", surface: "terminal", state: "running", lastEventAt: ago(500), signal: "transcript" },
  ];
  const hooks: HookEvent[] = [{ agent: "claude", event: "Stop", sessionId: "s4", ts: ago(9_000) }];
  const [s] = buildRegistry({ now, claude, hooks });
  assert.equal(s.state, "running"); // live activity newer than a stale Stop wins, so the user isn't locked out
});

test("Auto pick is deterministic and order-independent for concurrent agents (no headline flicker)", () => {
  const at = ago(1_000);
  const codex: AgentSessionSummary = { id: "c", agent: "codex", surface: "app", state: "running", lastEventAt: at, signal: "transcript" };
  const claude: AgentSessionSummary = { id: "l", agent: "claude", surface: "terminal", state: "running", lastEventAt: at, signal: "transcript" };
  const a = resolveReference([codex, claude], { kind: "auto" });
  const b = resolveReference([claude, codex], { kind: "auto" });
  assert.equal(a.matched?.id, b.matched?.id); // same pick regardless of input order
  assert.equal(a.matched?.agent, "claude"); // stable tiebreak within the sticky window
});
