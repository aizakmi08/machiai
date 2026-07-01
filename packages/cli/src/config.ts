export const DEFAULT_SERVER_URL = "https://machiai-aizakmi08.onrender.com";

export function serverUrl(): string {
  return process.env.MACHIAI_SERVER_URL ?? DEFAULT_SERVER_URL;
}

export function parseCommandAfterDoubleDash(args: string[]): string[] {
  const index = args.indexOf("--");
  return index >= 0 ? args.slice(index + 1) : args;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
