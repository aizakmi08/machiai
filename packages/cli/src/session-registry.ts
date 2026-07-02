import { closeSync, existsSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentSessionSummary,
  AgentSurface,
  ReferenceSelector,
  SessionState,
  WaitSession,
} from "../../shared/src/index.js";
import { isFreshWaitSession, machiaiHome } from "./local.js";

// --- tuning knobs -----------------------------------------------------------

/** How far back a session can have last moved and still show up in the registry. */
export const REGISTRY_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/** With no decisive turn marker, activity newer than this still counts as running. */
export const RUNNING_GRACE_MS = 30_000;
/**
 * A finished-turn marker (`end_turn`) is only trusted after the session goes quiet this long.
 * A working agent keeps appending within seconds; a truly-waiting one stops. This debounces the
 * flicker where `end_turn` briefly surfaces between an agent's tool batches. Hooks (Stop) are exact.
 */
export const END_TURN_QUIET_MS = 12_000;
/** A transcript that looks mid-turn but has gone quiet this long is treated as abandoned. */
export const TRANSCRIPT_RUNNING_TTL_MS = 5 * 60 * 1000;
/** A hook "running" state with no Stop for this long is a crash backstop -> idle. */
export const HOOK_RUNNING_TTL_MS = 5 * 60 * 1000;
/** Two sources within this window are "simultaneous"; the stronger signal decides state, not recency. */
export const SIGNAL_TIE_MS = 3_000;
/** Bytes read from the end of a transcript to find the latest turn boundary. */
const TAIL_BYTES = 64 * 1024;
/** Safety cap so a giant history never makes a scan slow. */
const MAX_FILES_PER_AGENT = 200;

// --- paths ------------------------------------------------------------------

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}
export function codexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}
export function codexSessionIndexPath(): string {
  return join(homedir(), ".codex", "session_index.jsonl");
}
export function hookEventsPath(): string {
  return join(machiaiHome(), "agent-events.jsonl");
}

// --- public types -----------------------------------------------------------

export interface HookEvent {
  agent: string;
  event: string;
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  ts: string;
}

export interface RegistryParts {
  now: Date;
  claude?: AgentSessionSummary[];
  codex?: AgentSessionSummary[];
  hooks?: HookEvent[];
  waits?: WaitSession[];
}

export interface ReferenceResolution {
  /** A running session that satisfies the selector, if any. */
  matched?: AgentSessionSummary;
  /** A matching session that exists but is idle (for "prompt it" messaging). */
  idleMatch?: AgentSessionSummary;
}

// --- state heuristics (pure, unit-tested) -----------------------------------

const CLAUDE_TURN_DONE = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

/**
 * `active`: the last substantive transcript line shows a turn in progress (tool call, tool result,
 * fresh prompt, or streaming reply) = true; a finished reply (`end_turn`) = false; nothing decisive
 * in the window = undefined (fall back to recency). This is position-aware so huge tool outputs at
 * the tail don't get misread as a finished turn.
 */
export function claudeSessionState(input: { active?: boolean; lastEventAt: number; now: number }): SessionState {
  const age = input.now - input.lastEventAt;
  if (input.active === true) return age <= TRANSCRIPT_RUNNING_TTL_MS ? "running" : "idle";
  // Finished reply: idle only once the session has actually gone quiet (see END_TURN_QUIET_MS).
  if (input.active === false) return age <= END_TURN_QUIET_MS ? "running" : "idle";
  return age <= RUNNING_GRACE_MS ? "running" : "idle";
}

/** Classify one Claude transcript line as mid-turn (true), turn-finished (false), or irrelevant (undefined). */
export function classifyClaudeLine(line: Record<string, any>): boolean | undefined {
  if (line.type === "assistant" && line.message) {
    const stop = line.message.stop_reason as string | null | undefined;
    if (stop && CLAUDE_TURN_DONE.has(stop)) return false; // finished reply, waiting on the human
    return true; // tool_use or still-streaming reply
  }
  // A user line is either a fresh prompt or a tool result landing mid-turn; both mean the agent is working.
  if (line.type === "user" && line.message) return true;
  return undefined;
}

export function codexSessionState(input: {
  lastTurnMarker?: "task_started" | "task_complete" | "turn_aborted" | null;
  lastEventAt: number;
  now: number;
}): SessionState {
  const age = input.now - input.lastEventAt;
  if (input.lastTurnMarker === "task_started") return age <= TRANSCRIPT_RUNNING_TTL_MS ? "running" : "idle";
  if (input.lastTurnMarker === "task_complete" || input.lastTurnMarker === "turn_aborted") return "idle";
  return age <= RUNNING_GRACE_MS ? "running" : "idle";
}

export function hookEventState(event: string): SessionState {
  switch (event) {
    case "SessionEnd":
      return "ended";
    case "Stop":
    case "StopFailure":
    case "SessionStart":
      return "idle";
    default:
      // UserPromptSubmit, PreToolUse, PostToolUse, SubagentStop, Notification, ...
      return "running";
  }
}

export function codexSurface(originator?: string, source?: string): AgentSurface {
  const orig = (originator ?? "").toLowerCase();
  const src = (source ?? "").toLowerCase();
  if (src === "vscode" || orig.includes("desktop") || orig.includes("vscode") || orig.includes("ide")) return "app";
  return "terminal";
}

// --- reference resolution (pure) --------------------------------------------

export function resolveReference(sessions: AgentSessionSummary[], selector: ReferenceSelector): ReferenceResolution {
  const running = sessions.filter((s) => s.state === "running");
  if (selector.kind === "session") {
    const found = sessions.find((s) => s.id === selector.sessionId);
    if (!found) return {};
    return found.state === "running" ? { matched: found } : { idleMatch: found };
  }
  if (selector.kind === "filter") {
    const wantAgent = selector.agent && selector.agent !== "any" ? selector.agent : undefined;
    const wantSurface = selector.surface && selector.surface !== "any" ? selector.surface : undefined;
    const matches = (s: AgentSessionSummary) =>
      (!wantAgent || s.agent === wantAgent) && (!wantSurface || s.surface === wantSurface);
    const matched = running.filter(matches)[0];
    if (matched) return { matched };
    const idleMatch = sessions.filter((s) => s.state === "idle").filter(matches)[0];
    return idleMatch ? { idleMatch } : {};
  }
  // auto: newest running session; no running -> report newest idle for messaging
  if (running[0]) return { matched: running[0] };
  const idleMatch = sessions.find((s) => s.state === "idle");
  return idleMatch ? { idleMatch } : {};
}

// --- merge (pure) -----------------------------------------------------------

function rank(state: SessionState): number {
  return state === "running" ? 0 : state === "idle" ? 1 : 2;
}

export function buildRegistry(parts: RegistryParts): AgentSessionSummary[] {
  const nowMs = parts.now.getTime();
  const byId = new Map<string, AgentSessionSummary>();

  const add = (s: AgentSessionSummary) => {
    const existing = byId.get(s.id);
    if (!existing) {
      byId.set(s.id, s);
      return;
    }
    const strongest = signalRank(s.signal) <= signalRank(existing.signal) ? s : existing;
    const weakest = strongest === s ? existing : s;
    // State follows the NEWER event so a live "running" transcript beats a stale "idle" hook; when two
    // sources are near-simultaneous (e.g. a turn's final line and its Stop hook) the stronger signal wins.
    const sMs = Date.parse(s.lastEventAt);
    const eMs = Date.parse(existing.lastEventAt);
    const stateSource = Math.abs(sMs - eMs) <= SIGNAL_TIE_MS ? strongest : sMs >= eMs ? s : existing;
    byId.set(s.id, {
      ...weakest,
      ...strongest,
      state: stateSource.state,
      signal: stateSource.signal,
      lastEventKind: stateSource.lastEventKind,
      // Metadata prefers whoever actually knows it.
      workspace: strongest.workspace ?? weakest.workspace,
      gitBranch: strongest.gitBranch ?? weakest.gitBranch,
      title: strongest.title ?? weakest.title,
      surface: pickSurface(strongest.surface, weakest.surface),
      startedAt: strongest.startedAt ?? weakest.startedAt,
      lastEventAt: newerIso(strongest.lastEventAt, weakest.lastEventAt),
    });
  };

  for (const s of parts.claude ?? []) add(s);
  for (const s of parts.codex ?? []) add(s);

  for (const event of parts.hooks ?? []) {
    let state = hookEventState(event.event);
    const ageMs = nowMs - Date.parse(event.ts);
    if (state === "running" && ageMs > HOOK_RUNNING_TTL_MS) state = "idle";
    add({
      id: event.sessionId,
      agent: event.agent,
      // A hook fires for both terminal and app sessions; the transcript, if present, resolves which.
      surface: "unknown",
      state,
      workspace: event.cwd,
      gitBranch: event.gitBranch,
      title: event.title,
      lastEventAt: event.ts,
      lastEventKind: event.event,
      signal: "hook",
    });
  }

  for (const wait of parts.waits ?? []) {
    if (!isFreshWaitSession(wait, parts.now)) continue;
    add({
      id: wait.sessionId,
      agent: wait.agent,
      surface: "terminal",
      state: "running",
      workspace: wait.workspace,
      title: wait.goal,
      startedAt: wait.startedAt,
      lastEventAt: wait.lastHeartbeatAt || wait.startedAt,
      lastEventKind: "wait-heartbeat",
      signal: "wait",
    });
  }

  return [...byId.values()]
    .filter((s) => s.state !== "ended" && nowMs - Date.parse(s.lastEventAt) <= REGISTRY_LOOKBACK_MS)
    .sort((a, b) => rank(a.state) - rank(b.state) || Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
}

function signalRank(signal: AgentSessionSummary["signal"]): number {
  return signal === "wait" ? 0 : signal === "hook" ? 1 : signal === "transcript" ? 2 : 3;
}

function pickSurface(a: AgentSurface, b: AgentSurface): AgentSurface {
  const rankOf = (s: AgentSurface) => (s === "app" ? 0 : s === "terminal" ? 1 : 2);
  return rankOf(a) <= rankOf(b) ? a : b;
}

function newerIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// --- filesystem scanning ----------------------------------------------------

export function scanRegistry(now = new Date(), waits: WaitSession[] = []): AgentSessionSummary[] {
  return buildRegistry({
    now,
    claude: safe(() => scanClaudeSessions(now)),
    codex: safe(() => scanCodexSessions(now)),
    hooks: safe(() => readHookEvents(now)),
    waits,
  });
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

export function readHookEvents(now = new Date(), path = hookEventsPath()): HookEvent[] {
  if (!existsSync(path)) return [];
  const nowMs = now.getTime();
  const latest = new Map<string, HookEvent>();
  for (const line of readTail(path, TAIL_BYTES * 4).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as HookEvent;
      if (!event.sessionId || !event.ts) continue;
      if (nowMs - Date.parse(event.ts) > REGISTRY_LOOKBACK_MS) continue;
      const prev = latest.get(event.sessionId);
      if (!prev || Date.parse(event.ts) >= Date.parse(prev.ts)) latest.set(event.sessionId, event);
    } catch {
      // ignore partial/corrupt line
    }
  }
  return [...latest.values()];
}

// Parse results are cached by (path, mtime): a file only changes by appending, which bumps mtime.
// This keeps the 2s scan from re-reading and re-parsing every transcript; only running/idle state
// (which depends on the current time) is recomputed per scan.
interface ParsedClaude {
  id: string;
  workspace?: string;
  gitBranch?: string;
  title?: string;
  active?: boolean;
  lastEventAtMs: number;
  lastKind?: string;
}
interface ParsedCodex {
  id: string;
  surface: AgentSurface;
  workspace?: string;
  startedAt?: string;
  lastTurnMarker: "task_started" | "task_complete" | "turn_aborted" | null;
  lastEventAtMs: number;
  lastKind?: string;
}
const claudeCache = new Map<string, { mtimeMs: number; parsed: ParsedClaude | null }>();
const codexCache = new Map<string, { mtimeMs: number; parsed: ParsedCodex | null }>();

export function resetRegistryCacheForTests(): void {
  claudeCache.clear();
  codexCache.clear();
}

function pruneCache<T>(cache: Map<string, T>, seen: Set<string>): void {
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
}

function scanClaudeSessions(now: Date): AgentSessionSummary[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  const nowMs = now.getTime();
  const seen = new Set<string>();
  const out: AgentSessionSummary[] = [];
  for (const file of recentJsonl(root, nowMs)) {
    seen.add(file.path);
    let entry = claudeCache.get(file.path);
    if (!entry || entry.mtimeMs !== file.mtimeMs) {
      entry = { mtimeMs: file.mtimeMs, parsed: parseClaudeFile(file) };
      claudeCache.set(file.path, entry);
    }
    const p = entry.parsed;
    if (!p) continue;
    out.push({
      id: p.id,
      agent: "claude",
      surface: "terminal",
      state: claudeSessionState({ active: p.active, lastEventAt: p.lastEventAtMs, now: nowMs }),
      workspace: p.workspace,
      gitBranch: p.gitBranch,
      title: p.title,
      lastEventAt: new Date(p.lastEventAtMs).toISOString(),
      lastEventKind: p.lastKind,
      signal: "transcript",
    });
  }
  pruneCache(claudeCache, seen);
  return out;
}

function parseClaudeFile(file: FileEntry): ParsedClaude | null {
  const lines = parseJsonl(readTail(file.path, TAIL_BYTES));
  if (lines.length === 0) return null;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let title: string | undefined;
  let active: boolean | undefined; // position-aware: the last decisive line wins
  let lastKind: string | undefined;
  let lastTsMs = file.mtimeMs;
  for (const line of lines) {
    if (typeof line.sessionId === "string") sessionId = line.sessionId;
    if (typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.gitBranch === "string") gitBranch = line.gitBranch;
    if (line.type === "last-prompt" && typeof line.lastPrompt === "string") title = line.lastPrompt;
    const classified = classifyClaudeLine(line);
    if (classified !== undefined) {
      active = classified;
      lastKind = line.type === "assistant" ? `assistant:${line.message?.stop_reason ?? "streaming"}` : line.type;
    }
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(ts)) lastTsMs = Math.max(lastTsMs, ts);
  }
  return {
    id: sessionId ?? basename(file.path, ".jsonl"),
    workspace: cwd,
    gitBranch,
    title: shortTitle(title) ?? labelFromWorkspace(cwd),
    active,
    lastEventAtMs: lastTsMs,
    lastKind: lastKind ?? lines[lines.length - 1]?.type,
  };
}

function scanCodexSessions(now: Date): AgentSessionSummary[] {
  const root = codexSessionsDir();
  if (!existsSync(root)) return [];
  const nowMs = now.getTime();
  const titles = readCodexTitles(); // read fresh each scan — a thread can be renamed without touching the rollout
  const seen = new Set<string>();
  const out: AgentSessionSummary[] = [];
  for (const file of recentJsonl(root, nowMs)) {
    seen.add(file.path);
    let entry = codexCache.get(file.path);
    if (!entry || entry.mtimeMs !== file.mtimeMs) {
      entry = { mtimeMs: file.mtimeMs, parsed: parseCodexFile(file) };
      codexCache.set(file.path, entry);
    }
    const p = entry.parsed;
    if (!p) continue;
    out.push({
      id: p.id,
      agent: "codex",
      surface: p.surface,
      state: codexSessionState({ lastTurnMarker: p.lastTurnMarker, lastEventAt: p.lastEventAtMs, now: nowMs }),
      workspace: p.workspace,
      title: titles.get(p.id) ?? labelFromWorkspace(p.workspace),
      startedAt: p.startedAt,
      lastEventAt: new Date(p.lastEventAtMs).toISOString(),
      lastEventKind: p.lastKind,
      signal: "transcript",
    });
  }
  pruneCache(codexCache, seen);
  return out;
}

function parseCodexFile(file: FileEntry): ParsedCodex | null {
  // session_meta is the first line but carries base_instructions, which can be tens of KB.
  const head = parseJsonl(readHead(file.path, 256 * 1024))[0];
  const meta = head?.type === "session_meta" ? (head.payload as Record<string, unknown>) : undefined;
  const tail = parseJsonl(readTail(file.path, TAIL_BYTES));
  let lastTurnMarker: "task_started" | "task_complete" | "turn_aborted" | null = null;
  let lastTsMs = file.mtimeMs;
  let lastKind: string | undefined;
  for (const line of tail) {
    const payloadType = (line.payload as Record<string, unknown> | undefined)?.type;
    const kind = line.type === "event_msg" && typeof payloadType === "string" ? payloadType : line.type;
    if (typeof kind === "string") lastKind = kind;
    if (kind === "task_started" || kind === "task_complete" || kind === "turn_aborted") lastTurnMarker = kind;
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(ts)) lastTsMs = Math.max(lastTsMs, ts);
  }
  return {
    id:
      (typeof meta?.session_id === "string" && meta.session_id) ||
      (typeof meta?.id === "string" && (meta.id as string)) ||
      codexIdFromFilename(file.path),
    surface: codexSurface(meta?.originator as string | undefined, meta?.source as string | undefined),
    workspace: typeof meta?.cwd === "string" ? (meta.cwd as string) : undefined,
    startedAt: typeof meta?.timestamp === "string" ? (meta.timestamp as string) : undefined,
    lastTurnMarker,
    lastEventAtMs: lastTsMs,
    lastKind,
  };
}

function readCodexTitles(): Map<string, string> {
  const map = new Map<string, string>();
  const path = codexSessionIndexPath();
  if (!existsSync(path)) return map;
  for (const line of readTail(path, TAIL_BYTES * 2).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { id?: string; thread_name?: string };
      if (entry.id && entry.thread_name) map.set(entry.id, entry.thread_name);
    } catch {
      // ignore
    }
  }
  return map;
}

// --- small fs + parse helpers ----------------------------------------------

interface FileEntry {
  path: string;
  mtimeMs: number;
}

function recentJsonl(root: string, nowMs: number): FileEntry[] {
  const found: FileEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const mtimeMs = statSync(full).mtimeMs;
          if (nowMs - mtimeMs <= REGISTRY_LOOKBACK_MS) found.push({ path: full, mtimeMs });
        } catch {
          // ignore unreadable
        }
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES_PER_AGENT);
}

function readTail(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    // Drop a leading partial line when we started mid-file. If the window holds no newline at all
    // (a single line larger than maxBytes), the whole buffer is a fragment — discard it.
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(newline + 1) : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHead(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type JsonLine = Record<string, any>;

function parseJsonl(text: string): JsonLine[] {
  const out: JsonLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore partial/corrupt line
    }
  }
  return out;
}

function codexIdFromFilename(path: string): string {
  const name = basename(path, ".jsonl");
  const match = name.match(/rollout-[0-9T:-]+-([0-9a-f-]{36})$/i);
  return match ? match[1] : name;
}

function labelFromWorkspace(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  return basename(cwd) || cwd;
}

function shortTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}
