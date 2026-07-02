export function normalizeTwitterHandle(input: string | undefined): string | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;
  const withoutUrl = raw
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/[/?#].*$/, "");
  const handle = withoutUrl.replace(/^@+/, "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 15);
  return handle || undefined;
}

export function twitterUrl(handle: string): string {
  return `https://x.com/${normalizeTwitterHandle(handle) ?? ""}`;
}
