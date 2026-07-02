import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMove, chooseBotMove, formatClock, formatGameLine, renderBoard, resignGame, type GameState } from "../../shared/src/index.js";
import { loadState, upsertLocalGame } from "./local.js";

export function printHero(): void {
  console.log("Machiai");
  console.log("Chess for people waiting on AI agents.");
  console.log("");
}

export function printAgentFinished(): void {
  process.stdout.write("\u0007");
  console.log("");
  console.log("Agent finished. Finish this game or return to work. Next match locked until an agent is running.");
  console.log("");
}

export function renderGame(game: GameState, playerId?: string, ascii = false): void {
  console.clear();
  console.log(formatGameLine(game, playerId));
  console.log("");
  console.log(renderBoard(game.fen, playerId === game.blackPlayerId ? "black" : "white", ascii));
  console.log("");
  if (game.status === "active") {
    console.log(`White ${formatClock(game.clocks.whiteMs)}  |  Black ${formatClock(game.clocks.blackMs)}`);
    console.log("Enter SAN/UCI move (e2e4, Nf3), or 'resign'.");
  } else {
    console.log(`Game over: ${game.result} by ${game.endReason}`);
  }
  console.log("");
}

export async function playLocalBotGame(initial: GameState, options: { ascii?: boolean; agentDone?: Promise<unknown> } = {}): Promise<GameState> {
  let game = initial;
  const state = loadState();
  const rl = readline.createInterface({ input, output });
  let notified = false;
  options.agentDone?.then(() => {
    notified = true;
    printAgentFinished();
  });
  try {
    while (game.status === "active") {
      renderGame(game, state.profile.playerId, options.ascii);
      if (notified) console.log("Agent is done. You can finish this game, but next match is locked.");
      const answer = (await rl.question("> ")).trim();
      if (!answer) continue;
      try {
        if (answer.toLowerCase() === "resign") {
          game = resignGame(game, state.profile.playerId);
        } else {
          game = applyMove(game, state.profile.playerId, answer).game;
          if (game.status === "active") {
            game = applyMove(game, game.blackPlayerId, chooseBotMove(game.fen, game.blackMmr)).game;
          }
        }
        upsertLocalGame(game);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        await rl.question("Press Enter to continue.");
      }
    }
    renderGame(game, state.profile.playerId, options.ascii);
    return game;
  } finally {
    rl.close();
  }
}

export function printTranscriptTail(tail: string[]): void {
  if (tail.length === 0) return;
  console.log("Agent transcript tail:");
  for (const line of tail.slice(-8)) console.log(`  ${line}`);
}
