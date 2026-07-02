import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AgentDetection,
  Color,
  GameState,
  MachiaiError,
  OverlayBootstrap,
  PlayerProfile,
  PresenceState,
  SnapResult,
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
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

type QueueState = "idle" | "searching" | "in_game";
type ConnectionState = "connecting" | "online" | "offline";

export function App() {
  const socketRef = useRef<Socket | undefined>(undefined);
  const activeSessionRef = useRef<string | undefined>(undefined);
  const profileRef = useRef<PlayerProfile | undefined>(undefined);
  const gameStatusRef = useRef<GameState["status"] | undefined>(undefined);
  const [bootstrap, setBootstrap] = useState<OverlayBootstrap | undefined>();
  const [profile, setProfile] = useState<PlayerProfile | undefined>();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [detection, setDetection] = useState<AgentDetection | undefined>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [queue, setQueue] = useState<QueueState>("idle");
  const [game, setGame] = useState<GameState | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [message, setMessage] = useState("Opening Machiai.");
  const [agentFinished, setAgentFinished] = useState(false);
  const [ratingDelta, setRatingDelta] = useState<number | undefined>();
  const [presence, setPresence] = useState<PresenceState | undefined>();
  const [, setClockTick] = useState(0);

  const playerColor = useMemo(() => {
    if (!game || !profile) return "white" as Color;
    return game.blackPlayerId === profile.playerId ? "black" : "white";
  }, [game, profile]);

  useEffect(() => {
    profileRef.current = profile;
    if (profile && !editingName) setDraftName(displayNameForProfile(profile));
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

  useEffect(() => {
    let disposed = false;
    void window.machiaiOverlay.bootstrap().then((nextBootstrap) => {
      if (disposed) return;
      profileRef.current = nextBootstrap.profile;
      setBootstrap(nextBootstrap);
      setProfile(nextBootstrap.profile);
      setDetection(nextBootstrap.detection);
      setMessage(nextBootstrap.detection.reason);

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
              await window.machiaiOverlay.saveProfile(response.player);
            }
            return syncWait(nextBootstrap.detection);
          })
          .catch((error) => setMessage(errorMessage(error)));
      });
      socket.on("disconnect", () => {
        setConnection("offline");
        setPresence(undefined);
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
        setGame(nextGame);
        setQueue("in_game");
        setSelected(undefined);
        setMessage("Game started.");
      });
      socket.on("game.state", (nextGame: GameState) => {
        setGame(nextGame);
        setQueue(nextGame.status === "active" ? "in_game" : "idle");
        setSelected(undefined);
      });
      socket.on("game.ended", (nextGame: GameState) => {
        setGame(nextGame);
        setQueue("idle");
        setSelected(undefined);
        setMessage(resultMessage(nextGame, nextBootstrap.profile.playerId));
      });
      socket.on("rating.updated", (payload: { player: PlayerProfile; rating: { delta: number } }) => {
        void window.machiaiOverlay.saveProfile(payload.player).catch((error) => setMessage(errorMessage(error)));
        profileRef.current = payload.player;
        setProfile(payload.player);
        setRatingDelta(payload.rating.delta);
      });
      socket.on("presence.updated", (nextPresence: PresenceState) => setPresence(nextPresence));
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
  const board = useMemo(() => parseFen(game?.fen ?? START_FEN), [game?.fen]);
  const squares = useMemo(() => orientedSquares(playerColor), [playerColor]);
  const topPlayerId = game ? (playerColor === "white" ? game.blackPlayerId : game.whitePlayerId) : undefined;
  const bottomPlayerId = game ? (playerColor === "white" ? game.whitePlayerId : game.blackPlayerId) : profile?.playerId;
  const topPlayer = labelForPlayer(topPlayerId, playerColor === "white" ? game?.blackHandle : game?.whiteHandle, profile, "Opponent");
  const bottomPlayer = labelForPlayer(bottomPlayerId, playerColor === "white" ? game?.whiteHandle : game?.blackHandle, profile, "You");
  const topClock = game ? (playerColor === "white" ? game.clocks.blackMs : game.clocks.whiteMs) : 3 * 60 * 1000;
  const bottomClock = game ? (playerColor === "white" ? game.clocks.whiteMs : game.clocks.blackMs) : 3 * 60 * 1000;
  const serverHost = bootstrap ? new URL(bootstrap.serverUrl).host : "server";
  const startLabel = connection !== "online" ? "Connecting" : detection?.status === "active" ? "Start" : "No agent";

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

  async function resign() {
    const socket = socketRef.current;
    if (!socket || !game || game.status !== "active") return;
    await emitAck(socket, "game.resign", { gameId: game.gameId });
  }

  async function snap() {
    const result = (await window.machiaiOverlay.snap()) as SnapResult;
    setMessage(result.reason ?? (result.ok ? "Window snapped." : "Could not snap window."));
  }

  async function saveDisplayName() {
    const nextName = draftName.trim();
    if (!nextName) {
      setMessage("Username cannot be empty.");
      return;
    }
    try {
      const nextProfile = await window.machiaiOverlay.updateProfile(nextName);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      setEditingName(false);
      setMessage(`Username set to ${nextName}.`);
      const socket = socketRef.current;
      if (socket?.connected) {
        await emitAck(socket, "profile.update", { displayName: nextName });
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function makeMove(from: string, to: string) {
    const socket = socketRef.current;
    if (!socket || !game || game.status !== "active") return;
    const piece = board.get(from);
    const promotion = piece?.toLowerCase() === "p" && (to.endsWith("8") || to.endsWith("1")) ? "q" : "";
    try {
      await emitAck(socket, "game.move", { gameId: game.gameId, move: `${from}${to}${promotion}` });
      setSelected(undefined);
      setMessage("Move sent.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function onSquareClick(square: string) {
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
    void makeMove(selected, square);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <strong>Machiai</strong>
        <div className="topActions">
          <span className="onlineCount" aria-label={`${presence?.onlinePlayers ?? 0} players online`}>
            {formatOnlineCount(presence?.onlinePlayers, connection)}
          </span>
          <button className="iconButton" onClick={() => void snap()} title="Snap beside Codex, Claude, Cursor, or Terminal">
            ⇱
          </button>
        </div>
      </header>

      <section className="statusBar">
        <span className={`pill ${detection?.status ?? "inactive"}`}>{agentLabel(detection)}</span>
        <span className={`pill ${connection}`}>{connectionLabel(connection, serverHost)}</span>
      </section>

      <section className="gamePanel">
        <div className="boardFrame">
          <section className="playerRow top">
            <span>{topPlayer}</span>
            <strong>{formatClock(liveClock(game, playerColor === "white" ? "black" : "white", topClock))}</strong>
          </section>

          <section className="board" aria-label="Chess board">
            {squares.map((square) => {
              const piece = board.get(square);
              const isSelected = selected === square;
              return (
                <button
                  key={square}
                  className={`square ${squareShade(square)} ${isSelected ? "selected" : ""}`}
                  onClick={() => onSquareClick(square)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = event.dataTransfer.getData("text/plain");
                    if (from) void makeMove(from, square);
                  }}
                >
                  <span
                    className={`piece ${pieceColor(piece) ?? ""}`}
                    draggable={isOwnPiece(piece, playerColor)}
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", square)}
                  >
                    {piece ? PIECES[piece] : ""}
                  </span>
                </button>
              );
            })}
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
              <button type="submit">Save</button>
              <button
                type="button"
                onClick={() => {
                  setDraftName(profile ? displayNameForProfile(profile) : "");
                  setEditingName(false);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <span className="nameWithEdit">
              <span>{bottomPlayer}</span>
              <button type="button" onClick={() => setEditingName(true)}>
                Edit
              </button>
            </span>
          )}
          <strong>{formatClock(liveClock(game, playerColor, bottomClock))}</strong>
        </section>
        </div>
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
          <button className="primary" disabled={!canQueue} onClick={() => void joinQueue()}>
            {startLabel}
          </button>
        )}
        <div className="rating">
          <span>{profile?.mmr ?? 500} MMR</span>
          {ratingDelta !== undefined ? <em>{ratingDelta > 0 ? `+${ratingDelta}` : ratingDelta}</em> : null}
        </div>
      </section>

      <footer>
        <span>{agentFinished ? "Agent finished. Finish this game." : queue === "searching" ? "Searching. Bot starts if lobby is empty." : message}</span>
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

function agentLabel(detection: AgentDetection | undefined): string {
  if (!detection) return "checking";
  if (detection.status === "active") return "agent active";
  if (detection.status === "maybe") return "agent maybe";
  return "agent idle";
}

function connectionLabel(connection: ConnectionState, host: string): string {
  if (connection === "online") return host.startsWith("127.0.0.1") ? "local server" : "online";
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
  return won ? "You won." : "You lost.";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
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
