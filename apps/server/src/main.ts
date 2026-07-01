#!/usr/bin/env node
import { resolve } from "node:path";
import { MachiaiServer } from "./server.js";

function readPort(argv: string[]): number {
  const args = argv.filter((arg) => arg !== "--");
  const explicitPort = args.find((arg) => /^\d+$/.test(arg));
  const portFlagIndex = args.indexOf("--port");
  const portValue = portFlagIndex >= 0 ? args[portFlagIndex + 1] : explicitPort;
  return Number(process.env.PORT ?? portValue ?? 4137);
}

const port = readPort(process.argv.slice(2));
const host = process.env.HOST ?? "127.0.0.1";
const storePath = process.env.MACHIAI_STORE ?? resolve(process.cwd(), ".machiai", "server-store.sqlite");

const server = new MachiaiServer({ storePath });
const url = await server.start(port, host);
console.log(`Machiai server listening on ${url}`);
console.log(`Store: ${storePath}`);

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});
