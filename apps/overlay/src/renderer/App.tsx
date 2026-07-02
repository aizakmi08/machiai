import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { io, type Socket } from "socket.io-client";
import { isTwitterAuthenticated, normalizeTwitterHandle, twitterDisplayName, twitterUrl } from "../../../../packages/shared/src/profile.js";
import type {
  AgentDetection,
  AgentSessionSummary,
  Color,
  GameState,
  MachiaiError,
  MatchRecord,
  OverlayBootstrap,
  PlayerProfile,
  PresenceState,
  ReferenceSelector,
} from "../../../../packages/shared/src/index.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const PIECES: Record<string, string> = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
  W_K: "♚",
  W_Q: "♛",
  W_R: "♜",
  W_B: "♝",
  W_N: "♞",
  W_P: "♟",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

type QueueState = "idle" | "searching" | "in_game";
type ConnectionState = "connecting" | "online" | "offline";
type ChatMessage = { gameId: string; playerId: string; handle: string; message: string; createdAt: string };
type ReactionMessage = { gameId: string; playerId: string; handle: string; reaction: string; createdAt: string };
type XAuthStart = { ok: boolean; sessionId?: string; authUrl?: string; message?: string; error?: string };
type XAuthPoll = { ok: boolean; status: "pending" | "complete" | "error" | "missing"; player?: PlayerProfile; error?: string };
type Premove = { from: string; to: string; promotion: string };

const REACTIONS = ["💀", "👀", "😂", "🤝"];

export function App() {
  const socketRef = useRef<Socket | undefined>(undefined);
  const activeSessionRef = useRef<string | undefined>(undefined);
  const profileRef = useRef<PlayerProfile | undefined>(undefined);
  const gameStatusRef = useRef<GameState["status"] | undefined>(undefined);
  const gameIdRef = useRef<string | undefined>(undefined); // the current/just-ended game, for rating correlation
  const [bootstrap, setBootstrap] = useState<OverlayBootstrap | undefined>();
  const [profile, setProfile] = useState<PlayerProfile | undefined>();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTwitter, setDraftTwitter] = useState("");
  const [detection, setDetection] = useState<AgentDetection | undefined>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [queue, setQueue] = useState<QueueState>("idle");
  const [game, setGame] = useState<GameState | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [premove, setPremove] = useState<Premove | undefined>();
  const [movePending, setMovePending] = useState(false);
  const [message, setMessage] = useState("Opening Machiai.");
  const [agentFinished, setAgentFinished] = useState(false);
  const [ratingDelta, setRatingDelta] = useState<number | undefined>();
  const [presence, setPresence] = useState<PresenceState | undefined>();
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [reaction, setReaction] = useState<ReactionMessage | undefined>();
  const [matchFound, setMatchFound] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [showDetection, setShowDetection] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [panelNote, setPanelNote] = useState<string | undefined>();
  const [, setClockTick] = useState(0);

  const playerColor = useMemo(() => {
    if (!game || !profile) return "white" as Color;
    return game.blackPlayerId === profile.playerId ? "black" : "white";
  }, [game, profile]);

  useEffect(() => {
    profileRef.current = profile;
    if (profile && !editingName) {
      setDraftName(displayNameForProfile(profile));
      setDraftTwitter(profile.twitterHandle ? `@${profile.twitterHandle}` : "");
    }
  }, [profile, editingName]);

  useEffect(() => {
    gameStatusRef.current = game?.status;
  }, [game?.status]);

  const syncWait = useCallback(
    async (nextDetection: AgentDetection) => {
      const socket = socketRef.current;
      const currentProfile = profileRef.current;
      if (!socket?.connected || !currentProfile) return;
      if (nextDetection.status === "active") {
        const sessionId = nextDetection.sessionId ?? `wait_overlay_${currentProfile.playerId}`;
        activeSessionRef.current = sessionId;
        setAgentFinished(false);
        await emitAck(socket, "wait.heartbeat", {
          sessionId,
          agent: nextDetection.agent ?? "agent",
          workspace: nextDetection.workspace,
          goal: nextDetection.goal,
          active: true,
        });
        return;
      }

      if (activeSessionRef.current) {
        await emitAck(socket, "wait.heartbeat", { sessionId: activeSessionRef.current, active: false });
        activeSessionRef.current = undefined;
        if (gameStatusRef.current === "active") setAgentFinished(true);
      }
    },
    [],
  );

  const refreshDetection = useCallback(async () => {
    const next = await window.machiaiOverlay.detectAgent();
    setDetection(next);
    try {
      await syncWait(next);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [syncWait]);

  const chooseReference = useCallback(
    async (selector: ReferenceSelector) => {
      try {
        setPanelNote(undefined);
        const next = await window.machiaiOverlay.setReference(selector);
        setDetection(next);
        await syncWait(next);
      } catch (error) {
        setPanelNote(errorMessage(error));
      }
    },
    [syncWait],
  );

  const enableExactDetection = useCallback(async () => {
    setLinking(true);
    setPanelNote(undefined);
    try {
      await window.machiaiOverlay.linkHooks();
      setLinked(true);
      await refreshDetection();
    } catch (error) {
      setPanelNote(errorMessage(error));
    } finally {
      setLinking(false);
    }
  }, [refreshDetection]);

  useEffect(() => {
    let disposed = false;
    void window.machiaiOverlay.bootstrap().then((nextBootstrap) => {
      if (disposed) return;
      profileRef.current = nextBootstrap.profile;
      setBootstrap(nextBootstrap);
      setProfile(nextBootstrap.profile);
      setDetection(nextBootstrap.detection);
      setMessage(nextBootstrap.detection.reason);
      void window.machiaiOverlay.listMatches().then(setMatches).catch(() => {});

      const socket = io(nextBootstrap.serverUrl, { transports: ["websocket", "polling"], timeout: 8000 });
      socketRef.current = socket;
      socket.on("connect", () => {
        setConnection("online");
        void emitAck(socket, "auth.anonymous", nextBootstrap.profile)
          .then(async (response) => {
            if (isAuthAck(response)) {
              profileRef.current = response.player;
              setProfile(response.player);
              setPresence(response.presence);
              await saveServerProfile(response.player);
            }
            return syncWait(nextBootstrap.detection);
          })
          .catch((error) => setMessage(errorMessage(error)));
      });
      socket.on("disconnect", () => {
        setConnection("offline");
        setPresence(undefined);
      });
      socket.on("auth.ready", (nextProfile: PlayerProfile) => {
        void saveServerProfile(nextProfile).catch((error) => setMessage(errorMessage(error)));
      });
      socket.on("connect_error", (error) => {
        setConnection("offline");
        setMessage(`Matchmaking unavailable: ${error.message}`);
      });
      socket.on("queue.status", () => setQueue("searching"));
      socket.on("wait.locked", (error: MachiaiError) => {
        setQueue("idle");
        setMessage(error.message);
      });
      socket.on("game.started", (nextGame: GameState) => {
        gameIdRef.current = nextGame.gameId;
        setGame(nextGame);
        setQueue("in_game");
        setSelected(undefined);
        setPremove(undefined);
        setMovePending(false);
        setChatMessages([]);
        setReaction(undefined);
        setMatchFound(true);
        window.setTimeout(() => setMatchFound(false), 1600);
        setMessage(nextGame.mode === "bot" ? "Practice bot found. No MMR change." : "Game found.");
      });
      socket.on("game.state", (nextGame: GameState) => {
        setGame(nextGame);
        setQueue(nextGame.status === "active" ? "in_game" : "idle");
        setSelected(undefined);
        setMovePending(false);
      });
      socket.on("game.ended", (nextGame: GameState) => {
        gameIdRef.current = nextGame.gameId;
        setGame(nextGame);
        setQueue("idle");
        setSelected(undefined);
        setPremove(undefined);
        setMovePending(false);
        const playerId = profileRef.current?.playerId ?? nextBootstrap.profile.playerId;
        setMessage(resultMessage(nextGame, playerId));
        const record = buildMatchRecord(nextGame, playerId);
        if (record) {
          void window.machiaiOverlay
            .recordMatch(record)
            .then(() => window.machiaiOverlay.listMatches())
            .then(setMatches)
            .catch(() => {});
        }
      });
      socket.on("rating.updated", (payload: { player: PlayerProfile; rating: { delta: number } }) => {
        void saveServerProfile(payload.player).catch((error) => setMessage(errorMessage(error)));
        setRatingDelta(payload.rating.delta);
        const ratedGameId = gameIdRef.current;
        if (ratedGameId) {
          void window.machiaiOverlay
            .ratingResult(ratedGameId, payload.rating.delta, payload.player.mmr)
            .then(() => window.machiaiOverlay.listMatches())
            .then(setMatches)
            .catch(() => {});
        }
      });
      socket.on("presence.updated", (nextPresence: PresenceState) => setPresence(nextPresence));
      socket.on("reaction.received", (payload: ReactionMessage) => {
        setReaction(payload);
        window.setTimeout(() => setReaction((current) => (current?.createdAt === payload.createdAt ? undefined : current)), 1800);
      });
      socket.on("chat.received", (payload: ChatMessage) => {
        setChatMessages((items) => [...items.slice(-3), payload]);
      });
      socket.on("error", (error: MachiaiError) => setMessage(error.message));
    });

    return () => {
      disposed = true;
      socketRef.current?.disconnect();
      socketRef.current = undefined;
    };
  }, [syncWait]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshDetection(), 2000);
    return () => window.clearInterval(timer);
  }, [refreshDetection]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, []);

  const canQueue = detection?.status === "active" && connection === "online" && queue === "idle" && game?.status !== "active";
  const signedIn = isTwitterAuthenticated(profile);
  const board = useMemo(() => parseFen(game?.fen ?? START_FEN), [game?.fen]);
  const squares = useMemo(() => orientedSquares(playerColor), [playerColor]);
  const lastMove = game?.moves.at(-1);
  const legalTargets = useMemo(
    () => legalMovesFor(game?.fen, selected, game?.status === "active" && !movePending, game?.turn === playerColor ? undefined : playerColor),
    [game?.fen, game?.status, game?.turn, movePending, playerColor, selected],
  );
  const canMoveNow = Boolean(game && game.status === "active" && game.turn === playerColor && !movePending);
  const canPlanPremove = Boolean(game && game.status === "active" && game.turn !== playerColor && !movePending);
  const topPlayerId = game ? (playerColor === "white" ? game.blackPlayerId : game.whitePlayerId) : undefined;
  const bottomPlayerId = game ? (playerColor === "white" ? game.whitePlayerId : game.blackPlayerId) : profile?.playerId;
  const topPlayer = labelForPlayer(topPlayerId, playerColor === "white" ? game?.blackHandle : game?.whiteHandle, profile, "Opponent");
  const bottomPlayer = signedIn ? (twitterDisplayName(profile?.twitterHandle) ?? "You") : labelForPlayer(bottomPlayerId, playerColor === "white" ? game?.whiteHandle : game?.blackHandle, profile, "You");
  const topTwitter = game ? (playerColor === "white" ? game.blackTwitterHandle : game.whiteTwitterHandle) : undefined;
  const bottomTwitter = game ? (playerColor === "white" ? game.whiteTwitterHandle : game.blackTwitterHandle) : profile?.twitterHandle;
  const showBottomTwitter = bottomTwitter && bottomPlayer !== `@${bottomTwitter}`;
  const topMmr = game ? (playerColor === "white" ? game.blackMmr : game.whiteMmr) : undefined;
  const bottomMmr = game ? (playerColor === "white" ? game.whiteMmr : game.blackMmr) : profile?.mmr;
  const topClock = game ? (playerColor === "white" ? game.clocks.blackMs : game.clocks.whiteMs) : 3 * 60 * 1000;
  const bottomClock = game ? (playerColor === "white" ? game.clocks.whiteMs : game.clocks.blackMs) : 3 * 60 * 1000;
  const serverHost = bootstrap ? new URL(bootstrap.serverUrl).host : "server";
  const startLabel =
    connection !== "online"
      ? "Connecting…"
      : !signedIn
        ? signingIn
          ? "Signing in…"
          : "Sign in with X to play"
        : detection?.status === "active"
          ? "Start game"
          : "Start an agent to play";
  const resultTone = game?.status === "ended" ? resultForPlayerColor(game, playerColor) : "none";
  const lastMoveLabel = lastMove ? `${lastMove.color === playerColor ? "You" : "Last"}: ${lastMove.san}` : "";
  const pendingPremoveLabel = premove ? `Premove: ${premove.from}-${premove.to}` : "";
  const footerText = agentFinished
    ? "Agent finished — you can finish this game, but not start a new one."
    : queue === "searching"
      ? "Searching… a bot joins if the lobby is empty."
      : game?.status === "ended"
        ? message
        : game?.status === "active"
          ? lastMoveLabel || "Your move."
          : detection?.status === "active"
            ? signedIn
              ? `${detection.agent ?? "Agent"} is running — press Start game.`
              : `${detection.agent ?? "An agent"} is running — sign in with X to play.`
            : detection?.status === "maybe"
              ? "Agent is idle — send it a prompt to unlock a new game."
              : detection?.status === "inactive"
                ? "No agent running. Start Claude or Codex, then press Start."
                : message;

  useEffect(() => {
    if (!premove || !game || game.status !== "active" || game.turn !== playerColor || movePending) return;
    const next = premove;
    setPremove(undefined);
    setSelected(undefined);
    if (!legalMovesFor(game.fen, next.from, true).has(next.to)) {
      setMessage("Premove cancelled.");
      return;
    }
    void makeMove(next.from, next.to);
  }, [game?.fen, game?.status, game?.turn, movePending, playerColor, premove]);

  async function joinQueue() {
    if (!canQueue || !detection || !profile) return;
    const socket = socketRef.current;
    if (!socket) return;
    try {
      await syncWait(detection);
      const sessionId = activeSessionRef.current ?? detection.sessionId ?? `wait_overlay_${profile.playerId}`;
      const response = await emitAck<{ ok: boolean; error?: MachiaiError }>(socket, "queue.join", { sessionId });
      if (!response.ok) throw new Error(response.error?.message ?? "Queue rejected.");
      setQueue("searching");
      setMessage("Finding another waiting coder.");
    } catch (error) {
      setQueue("idle");
      setMessage(errorMessage(error));
    }
  }

  async function leaveQueue() {
    const socket = socketRef.current;
    if (!socket) return;
    await emitAck(socket, "queue.leave", {});
    setQueue("idle");
    setMessage("Queue left.");
  }

  async function saveServerProfile(nextProfile: PlayerProfile) {
    const saved = await window.machiaiOverlay.saveProfile(nextProfile);
    profileRef.current = saved;
    setProfile(saved);
    return saved;
  }

  async function signInWithX() {
    if (!bootstrap || !profile || signingIn || connection !== "online") return;
    try {
      setSigningIn(true);
      setMessage("Opening X login.");
      const startResponse = await fetch(new URL("/auth/x/start", bootstrap.serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: profile.playerId, deviceKey: profile.deviceKey }),
      });
      const start = (await startResponse.json()) as XAuthStart;
      if (!startResponse.ok || !start.ok || !start.authUrl || !start.sessionId) {
        throw new Error(start.message ?? start.error ?? "X login is not available.");
      }
      await window.machiaiOverlay.openExternal(start.authUrl);
      setMessage("Finish X login in your browser.");
      const nextProfile = await pollXLogin(bootstrap.serverUrl, start.sessionId);
      const saved = await saveServerProfile(nextProfile);
      const socket = socketRef.current;
      if (socket?.connected) {
        const auth = (await emitAck(socket, "auth.anonymous", saved)) as { player?: PlayerProfile };
        if (auth.player) await saveServerProfile(auth.player);
      }
      setMessage(`Signed in as ${twitterDisplayName(saved.twitterHandle) ?? saved.displayName ?? saved.handle}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSigningIn(false);
    }
  }

  async function resign() {
    const socket = socketRef.current;
    if (!socket || !game || game.status !== "active") return;
    await emitAck(socket, "game.resign", { gameId: game.gameId });
  }

  async function saveDisplayName() {
    const nextName = draftName.trim();
    if (!nextName) {
      setMessage("Username cannot be empty.");
      return;
    }
    try {
      const nextTwitter = normalizeTwitterHandle(draftTwitter);
      const nextProfile = await window.machiaiOverlay.updateProfile(nextName, draftTwitter);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      setEditingName(false);
      setMessage(nextTwitter ? `Profile set: ${nextName} @${nextTwitter}.` : `Username set to ${nextName}.`);
      const socket = socketRef.current;
      if (socket?.connected) {
        await emitAck(socket, "profile.update", { displayName: nextName, twitterHandle: draftTwitter });
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function makeMove(from: string, to: string) {
    const socket = socketRef.current;
    if (!socket || !game || !profile || game.status !== "active" || game.turn !== playerColor || movePending) return;
    const piece = board.get(from);
    const promotion = piece?.toLowerCase() === "p" && (to.endsWith("8") || to.endsWith("1")) ? "q" : "";
    const moveInput = `${from}${to}${promotion}`;
    const previousGame = game;
    const optimistic = previewMove(game, profile.playerId, moveInput);
    if (!optimistic) {
      setMessage("Illegal move.");
      return;
    }
    try {
      setMovePending(true);
      setGame(optimistic);
      setSelected(undefined);
      const response = await emitAck<{ game: GameState }>(socket, "game.move", { gameId: game.gameId, move: moveInput });
      setGame(response.game);
      setSelected(undefined);
      setMovePending(false);
      setMessage("Move played.");
    } catch (error) {
      setGame(previousGame);
      setMovePending(false);
      setMessage(errorMessage(error));
    }
  }

  async function sendReaction(nextReaction: string) {
    const socket = socketRef.current;
    if (!socket || !game) return;
    try {
      await emitAck(socket, "reaction.send", { gameId: game.gameId, reaction: nextReaction });
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function sendChat() {
    const socket = socketRef.current;
    if (!socket || !game) return;
    const nextMessage = chatInput.trim();
    if (!nextMessage) return;
    try {
      setChatInput("");
      await emitAck(socket, "chat.send", { gameId: game.gameId, message: nextMessage });
    } catch (error) {
      setChatInput(nextMessage);
      setMessage(errorMessage(error));
    }
  }

  async function openTwitter(handle: string | undefined) {
    const normalized = normalizeTwitterHandle(handle);
    if (!normalized) return;
    await window.machiaiOverlay.openExternal(twitterUrl(normalized));
  }

  function onSquareClick(square: string) {
    if (!game || game.status !== "active" || movePending) return;
    const piece = board.get(square);
    if (!selected) {
      if (isOwnPiece(piece, playerColor)) setSelected(square);
      return;
    }
    if (selected === square) {
      setSelected(undefined);
      return;
    }
    if (isOwnPiece(piece, playerColor)) {
      setSelected(square);
      return;
    }
    if (canMoveNow) {
      void makeMove(selected, square);
      return;
    }
    if (canPlanPremove && legalTargets.has(square)) {
      const selectedPiece = board.get(selected);
      const promotion = selectedPiece?.toLowerCase() === "p" && (square.endsWith("8") || square.endsWith("1")) ? "q" : "";
      setPremove({ from: selected, to: square, promotion });
      setSelected(undefined);
      setMessage(`Premove set: ${selected}-${square}.`);
    }
  }

  function onSquareDrop(from: string, to: string) {
    if (!from || !game || game.status !== "active" || movePending) return;
    if (canMoveNow) {
      void makeMove(from, to);
      return;
    }
    if (!canPlanPremove || !isOwnPiece(board.get(from), playerColor) || !legalMovesFor(game.fen, from, true, playerColor).has(to)) return;
    const piece = board.get(from);
    const promotion = piece?.toLowerCase() === "p" && (to.endsWith("8") || to.endsWith("1")) ? "q" : "";
    setPremove({ from, to, promotion });
    setSelected(undefined);
    setMessage(`Premove set: ${from}-${to}.`);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <strong>Machiai</strong>
        <div className="topActions">
          <button
            type="button"
            className={`histBtn ${showHistory ? "open" : ""}`}
            onClick={() => {
              setShowHistory((value) => !value);
              setShowDetection(false);
            }}
            title="Match history"
            aria-expanded={showHistory}
          >
            Games
          </button>
          <span className="onlineCount" aria-label={`${presence?.onlinePlayers ?? 0} players online`}>
            {formatOnlineCount(presence?.onlinePlayers, connection)}
          </span>
        </div>
      </header>

      <section className="statusBar">
        <button
          type="button"
          className={`statusChip detect-${detection?.status ?? "inactive"} ${showDetection ? "open" : ""}`}
          onClick={() => {
            setShowDetection((value) => !value);
            setShowHistory(false);
          }}
          title="Choose which agent unlocks chess"
          aria-expanded={showDetection}
        >
          <span className={`dot ${detection?.status ?? "inactive"}`} aria-hidden />
          <span className="chipText">{detectionHeadline(detection)}</span>
          <span className="caret">▾</span>
        </button>
        <span className={`pill ${connection}`}>{connectionLabel(connection, serverHost)}</span>
      </section>

      {showDetection ? (
        <div className="detectionPanel" role="dialog" aria-label="Detection settings">
          <div className="detectionHead">
            <strong>Detection</strong>
            <button type="button" className="panelClose" onClick={() => setShowDetection(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <p className="detectExplain">Chess unlocks only while a coding agent is working. Choose which one to watch:</p>

          <select
            className="detectSelect"
            value={selectorToValue(detection?.reference)}
            onChange={(event) => void chooseReference(valueToSelector(event.currentTarget.value))}
          >
            <option value="auto">Auto — whichever agent is working</option>
            <option value="agent:claude">Only Claude</option>
            <option value="agent:codex">Only Codex</option>
            <option value="surface:terminal">Only terminal sessions</option>
            <option value="surface:app">Only app sessions</option>
            {(detection?.sessions ?? []).length > 0 ? (
              <optgroup label="One specific session">
                {(detection?.sessions ?? []).map((session) => (
                  <option key={session.id} value={`session:${session.id}`}>
                    {sessionOptionLabel(session)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>

          <div className="sessionList">
            {(detection?.sessions ?? []).length === 0 ? (
              <p className="sessionEmpty">No agent sessions yet. Start Claude Code or Codex and it appears here.</p>
            ) : (
              (detection?.sessions ?? []).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`sessionRow ${
                    detection?.reference?.kind === "session" && detection.reference.sessionId === session.id ? "active" : ""
                  }`}
                  onClick={() => void chooseReference({ kind: "session", sessionId: session.id })}
                  title={session.workspace ?? session.id}
                >
                  <span className={`stateDot ${session.state}`} aria-hidden />
                  <span className="sessMain">{session.title || shortWorkspace(session.workspace) || session.agent}</span>
                  <span className="sessMeta">
                    {session.agent}
                    {session.surface !== "unknown" ? ` · ${session.surface}` : ""}
                  </span>
                </button>
              ))
            )}
          </div>

          {panelNote ? (
            <p className="panelNote">{panelNote}</p>
          ) : detection?.reference ? (
            <p className="panelNote">Watching {describeSelector(detection.reference)}.</p>
          ) : null}

          <div className="detectFoot">
            {linked ? (
              <span className="linkDone">✓ Exact detection enabled</span>
            ) : (
              <button type="button" className="linkBtn" disabled={linking} onClick={() => void enableExactDetection()}>
                {linking ? "Enabling…" : "Enable exact detection"}
              </button>
            )}
            <span className="detectHint">Most accurate — adds Claude/Codex start &amp; stop hooks. Optional.</span>
          </div>
        </div>
      ) : null}

      {showHistory ? (
        <div className="detectionPanel historyPanel" role="dialog" aria-label="Match history">
          <div className="detectionHead">
            <strong>Match history</strong>
            <button type="button" className="panelClose" onClick={() => setShowHistory(false)} aria-label="Close">
              ✕
            </button>
          </div>
          {matches.length === 0 ? (
            <p className="sessionEmpty">No games yet. Play a 3+0 game while your agent works and it shows up here.</p>
          ) : (
            <>
              <p className="matchSummary">{matchSummary(matches)}</p>
              <div className="matchList">
                {matches.map((match) => (
                  <div key={match.gameId} className="matchRow">
                    <span className={`resultTag ${match.result}`}>{match.result === "win" ? "W" : match.result === "loss" ? "L" : "D"}</span>
                    <span className="matchOpp">{match.opponentTwitter ? `@${match.opponentTwitter}` : match.opponentHandle}</span>
                    <span className="matchDelta">{matchDeltaLabel(match)}</span>
                    <span className="matchAge">{timeAgo(match.playedAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}

      <section className="gamePanel">
        <div className="playArea">
          <div className="boardFrame">
            <section className="playerRow top">
              <span className="playerIdentity">
                {topTwitter ? (
                  <button className="playerNameLink" type="button" title={`Open @${topTwitter} on X`} onClick={() => void openTwitter(topTwitter)}>
                    {topPlayer}
                  </button>
                ) : (
                  <span>{topPlayer}</span>
                )}
                {topMmr ? <em>{topMmr} MMR</em> : null}
                {topTwitter && topPlayer !== `@${topTwitter}` ? (
                  <button className="twitterLink" type="button" onClick={() => void openTwitter(topTwitter)}>
                    @{topTwitter}
                  </button>
                ) : null}
              </span>
              <strong>{formatClock(liveClock(game, playerColor === "white" ? "black" : "white", topClock))}</strong>
            </section>

            <section className={`board ${movePending ? "pending" : ""}`} aria-label="Chess board">
              {squares.map((square) => {
                const piece = board.get(square);
                const isSelected = selected === square;
                const isLegal = legalTargets.has(square);
                const isLastMove = square === lastMove?.from || square === lastMove?.to;
                const isPremove = square === premove?.from || square === premove?.to;
                return (
                  <button
                    key={square}
                    className={`square ${squareShade(square)} ${isSelected ? "selected" : ""} ${isLegal ? "legalMove" : ""} ${isLastMove ? "lastMove" : ""} ${isPremove ? "premove" : ""}`}
                    onClick={() => onSquareClick(square)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = event.dataTransfer.getData("text/plain");
                      onSquareDrop(from, square);
                    }}
                  >
                    <span
                      className={`piece ${pieceColor(piece) ?? ""}`}
                      draggable={(canMoveNow || canPlanPremove) && isOwnPiece(piece, playerColor)}
                      onDragStart={(event) => event.dataTransfer.setData("text/plain", square)}
                    >
                      {piece ? pieceGlyph(piece) : ""}
                    </span>
                  </button>
                );
              })}
              {resultTone !== "none" ? <div className={`resultBurst ${resultTone}`}>{resultTone}</div> : null}
              {matchFound ? <div className="matchFound">Game found</div> : null}
              {reaction ? <div className="reactionFlash">{reaction.reaction}</div> : null}
            </section>

            <section className="playerRow bottom">
              {editingName ? (
                <form
                  className="nameEditor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveDisplayName();
                  }}
                >
                  <input
                    value={draftName}
                    maxLength={24}
                    onChange={(event) => setDraftName(event.currentTarget.value)}
                    aria-label="Username"
                  />
                  <input
                    value={draftTwitter}
                    maxLength={16}
                    placeholder="@twitter"
                    onChange={(event) => setDraftTwitter(event.currentTarget.value)}
                    aria-label="Twitter handle"
                  />
                  <button type="submit" data-short="OK">
                    Save
                  </button>
                  <button
                    type="button"
                    data-short="X"
                    onClick={() => {
                      setDraftName(profile ? displayNameForProfile(profile) : "");
                      setDraftTwitter(profile?.twitterHandle ? `@${profile.twitterHandle}` : "");
                      setEditingName(false);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <span className="nameWithEdit">
                  <span>{bottomPlayer}</span>
                  {bottomMmr ? <em>{bottomMmr} MMR</em> : null}
                  {showBottomTwitter ? <em>@{bottomTwitter}</em> : null}
                  {!signedIn ? (
                    <button type="button" onClick={() => setEditingName(true)}>
                      Edit
                    </button>
                  ) : null}
                </span>
              )}
              <strong>{formatClock(liveClock(game, playerColor, bottomClock))}</strong>
            </section>

            <section className="actions">
              {game?.status === "active" ? (
                <button className="secondary" onClick={() => void resign()}>
                  Resign
                </button>
              ) : queue === "searching" ? (
                <button className="secondary" onClick={() => void leaveQueue()}>
                  Leave Queue
                </button>
              ) : (
                <button className="primary" disabled={signedIn ? !canQueue : connection !== "online" || signingIn} onClick={() => void (signedIn ? joinQueue() : signInWithX())}>
                  {startLabel}
                </button>
              )}
              <div className="rating">
                <span>{profile?.mmr ?? 500} MMR</span>
                {ratingDelta !== undefined ? <em>{ratingDelta > 0 ? `+${ratingDelta}` : ratingDelta}</em> : null}
              </div>
            </section>
          </div>

          <aside className="sideRail" aria-label="Game actions">
            <div className="moveHint">{pendingPremoveLabel || lastMoveLabel}</div>
            <div className="reactionStack">
              {REACTIONS.map((item) => (
                <button key={item} type="button" disabled={!game} onClick={() => void sendReaction(item)}>
                  {item}
                </button>
              ))}
            </div>
            <div className="chatBox">
              <div className="chatLog">
                {chatMessages.length === 0 ? <span>quick chat</span> : null}
                {chatMessages.map((item) => (
                  <p key={`${item.createdAt}-${item.playerId}`}>
                    <b>{item.playerId === profile?.playerId ? "you" : item.handle}</b> {item.message}
                  </p>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendChat();
                }}
              >
                <input
                  value={chatInput}
                  maxLength={120}
                  placeholder="say gg"
                  disabled={!game}
                  onChange={(event) => setChatInput(event.currentTarget.value)}
                />
              </form>
            </div>
          </aside>
        </div>
      </section>

      <footer>
        <span>{footerText}</span>
      </footer>
    </main>
  );
}

function orientedSquares(color: Color): string[] {
  const ranks = color === "white" ? [...RANKS].reverse() : RANKS;
  const files = color === "white" ? FILES : [...FILES].reverse();
  return ranks.flatMap((rank) => files.map((file) => `${file}${rank}`));
}

function parseFen(fen: string): Map<string, string> {
  const map = new Map<string, string>();
  const [placement] = fen.split(" ");
  const rows = placement.split("/");
  for (let row = 0; row < rows.length; row++) {
    let fileIndex = 0;
    const rank = String(8 - row);
    for (const char of rows[row]) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        continue;
      }
      map.set(`${FILES[fileIndex]}${rank}`, char);
      fileIndex++;
    }
  }
  return map;
}

function legalMovesFor(fen: string | undefined, selected: string | undefined, enabled: boolean, turnOverride?: Color): Set<string> {
  if (!fen || !selected || !enabled) return new Set();
  try {
    const chess = new Chess(turnOverride ? fenWithTurn(fen, turnOverride) : fen);
    const moves = chess.moves({ square: selected as Square, verbose: true }) as Array<{ to: string }>;
    return new Set(moves.map((move) => move.to));
  } catch {
    return new Set();
  }
}

function previewMove(game: GameState, playerId: string, moveInput: string): GameState | undefined {
  try {
    const color = game.whitePlayerId === playerId ? "white" : game.blackPlayerId === playerId ? "black" : undefined;
    if (!color || color !== game.turn) return undefined;
    const chess = new Chess(game.fen);
    const move = parseMoveInput(chess, moveInput);
    const now = new Date();
    const elapsed = Math.max(0, now.getTime() - Date.parse(game.clocks.lastTickAt));
    const createdAt = now.toISOString();
    return {
      ...game,
      fen: chess.fen(),
      pgn: chess.pgn(),
      turn: chess.turn() === "w" ? "white" : "black",
      clocks: {
        whiteMs: color === "white" ? Math.max(0, game.clocks.whiteMs - elapsed) : game.clocks.whiteMs,
        blackMs: color === "black" ? Math.max(0, game.clocks.blackMs - elapsed) : game.clocks.blackMs,
        lastTickAt: createdAt,
      },
      moves: [
        ...game.moves,
        {
          ply: game.moves.length + 1,
          playerId,
          color,
          san: move.san,
          from: move.from,
          to: move.to,
          promotion: move.promotion,
          fenAfter: chess.fen(),
          createdAt,
        },
      ],
      bothPlayersMoved:
        game.bothPlayersMoved ||
        (color === "white" && game.moves.some((item) => item.color === "black")) ||
        (color === "black" && game.moves.some((item) => item.color === "white")),
    };
  } catch {
    return undefined;
  }
}

function parseMoveInput(chess: Chess, input: string) {
  const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(input.trim());
  const move = uci
    ? chess.move({ from: uci[1].toLowerCase(), to: uci[2].toLowerCase(), promotion: uci[3]?.toLowerCase() })
    : chess.move(input);
  if (!move) throw new Error(`Illegal move: ${input}`);
  return move;
}

function fenWithTurn(fen: string, color: Color): string {
  const parts = fen.split(" ");
  if (parts.length < 2) return fen;
  parts[1] = color === "white" ? "w" : "b";
  return parts.join(" ");
}

function pieceGlyph(piece: string): string {
  if (piece === piece.toUpperCase()) {
    return PIECES[`W_${piece}`] ?? PIECES[piece] ?? "";
  }
  return PIECES[piece] ?? "";
}

function pieceColor(piece?: string): Color | undefined {
  if (!piece) return undefined;
  return piece === piece.toUpperCase() ? "white" : "black";
}

function isOwnPiece(piece: string | undefined, color: Color): boolean {
  return pieceColor(piece) === color;
}

function squareShade(square: string): "light" | "dark" {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return (file + rank) % 2 === 0 ? "dark" : "light";
}

function liveClock(game: GameState | undefined, color: Color, baseMs: number): number {
  if (!game || game.status !== "active" || game.turn !== color) return baseMs;
  const elapsed = Math.max(0, Date.now() - Date.parse(game.clocks.lastTickAt));
  return Math.max(0, baseMs - elapsed);
}

function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function detectionHeadline(detection: AgentDetection | undefined): string {
  if (!detection) return "checking…";
  if (detection.status === "active") return `${detection.agent ?? "agent"} running`;
  if (detection.status === "maybe") return "agent idle";
  return "no agent";
}

function selectorToValue(selector: ReferenceSelector | undefined): string {
  if (!selector || selector.kind === "auto") return "auto";
  if (selector.kind === "session") return `session:${selector.sessionId}`;
  if (selector.agent && selector.agent !== "any") return `agent:${selector.agent}`;
  if (selector.surface && selector.surface !== "any") return `surface:${selector.surface}`;
  return "auto";
}

function valueToSelector(value: string): ReferenceSelector {
  if (value.startsWith("session:")) return { kind: "session", sessionId: value.slice("session:".length) };
  if (value.startsWith("agent:")) return { kind: "filter", agent: value.slice("agent:".length) };
  if (value.startsWith("surface:")) return { kind: "filter", surface: value.slice("surface:".length) as AgentSessionSummary["surface"] };
  return { kind: "auto" };
}

function describeSelector(selector: ReferenceSelector): string {
  if (selector.kind === "auto") return "the most active session";
  if (selector.kind === "session") return "one specific session";
  if (selector.agent && selector.agent !== "any") return `${selector.agent} sessions`;
  if (selector.surface && selector.surface !== "any") return `${selector.surface} sessions`;
  return "any session";
}

function sessionOptionLabel(session: AgentSessionSummary): string {
  const name = session.title || shortWorkspace(session.workspace) || session.agent;
  return `${session.agent} · ${name} — ${session.state}`;
}

function shortWorkspace(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function connectionLabel(connection: ConnectionState, host: string): string {
  if (connection === "online") return host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "local" : "online";
  if (connection === "connecting") return "connecting";
  return "offline";
}

function formatOnlineCount(count: number | undefined, connection: ConnectionState): string {
  if (connection !== "online") return "0 online";
  const next = count ?? 1;
  return `${next} online`;
}

function labelForPlayer(playerId: string | undefined, handle: string | undefined, profile: PlayerProfile | undefined, fallback: string): string {
  if (profile && playerId === profile.playerId) return displayNameForProfile(profile);
  return displayHandle(handle) || fallback;
}

function displayNameForProfile(profile: PlayerProfile): string {
  return profile.displayName?.trim() || displayHandle(profile.handle) || "coder";
}

function displayHandle(handle: string | undefined): string {
  return handle?.trim().replace(/^machiai-/, "coder-") ?? "";
}

function resultMessage(game: GameState, playerId: string): string {
  if (game.result === "draw") return "Draw.";
  if (game.result === "aborted") return "Game aborted.";
  const won = (game.result === "white_win" && game.whitePlayerId === playerId) || (game.result === "black_win" && game.blackPlayerId === playerId);
  if (game.mode === "bot") return won ? "Bot beaten. Practice game, no MMR change." : "Bot practice lost. No MMR change.";
  return won ? "You won." : "You lost.";
}

function resultForPlayerColor(game: GameState | undefined, color: Color): "win" | "loss" | "draw" | "none" {
  if (!game?.result || game.result === "aborted") return "none";
  if (game.result === "draw") return "draw";
  if (game.result === "white_win") return color === "white" ? "win" : "loss";
  return color === "black" ? "win" : "loss";
}

function buildMatchRecord(game: GameState, playerId: string): MatchRecord | undefined {
  const color: Color | undefined = game.whitePlayerId === playerId ? "white" : game.blackPlayerId === playerId ? "black" : undefined;
  if (!color) return undefined; // player isn't in this game (e.g. mid profile-id transition) — don't record a wrong result
  const result = resultForPlayerColor(game, color);
  if (result === "none") return undefined; // aborted games are not recorded
  return {
    gameId: game.gameId,
    playedAt: game.endedAt ?? new Date().toISOString(),
    mode: game.mode,
    rated: game.rated,
    result,
    opponentHandle: color === "white" ? game.blackHandle : game.whiteHandle,
    opponentTwitter: color === "white" ? game.blackTwitterHandle : game.whiteTwitterHandle,
  };
}

function matchSummary(matches: MatchRecord[]): string {
  const w = matches.filter((m) => m.result === "win").length;
  const l = matches.filter((m) => m.result === "loss").length;
  const d = matches.filter((m) => m.result === "draw").length;
  return `${w}W · ${l}L · ${d}D`;
}

function matchDeltaLabel(match: MatchRecord): string {
  if (match.rated && match.mmrDelta !== undefined) return match.mmrDelta > 0 ? `+${match.mmrDelta}` : `${match.mmrDelta}`;
  if (match.mode === "bot") return "practice";
  return "—";
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

async function pollXLogin(serverUrl: string, sessionId: string): Promise<PlayerProfile> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(new URL(`/auth/x/session/${encodeURIComponent(sessionId)}`, serverUrl));
    const payload = (await response.json()) as XAuthPoll;
    if (payload.status === "complete" && payload.player) return payload.player;
    if (payload.status === "error" || payload.status === "missing" || !payload.ok) {
      throw new Error(payload.error ?? "X login failed.");
    }
    await sleep(1500);
  }
  throw new Error("X login timed out.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function emitAck<T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error: Error | null, response: T) => {
      if (error) reject(error);
      else if (isErrorAck(response)) reject(new Error(response.error.message));
      else resolve(response);
    });
  });
}

function isErrorAck(value: unknown): value is { ok: false; error: MachiaiError } {
  return Boolean(value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false && "error" in value);
}

function isAuthAck(value: unknown): value is { ok: true; player: PlayerProfile; presence: PresenceState } {
  return Boolean(value && typeof value === "object" && "presence" in value);
}
