import { randomBytes, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function createDeviceKey(): string {
  return randomBytes(24).toString("base64url");
}

export function createHandle(): string {
  const n = randomBytes(2).readUInt16BE(0) % 10000;
  return `coder-${n.toString().padStart(4, "0")}`;
}
