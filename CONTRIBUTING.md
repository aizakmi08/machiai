# Contributing to Machiai

Machiai is a TypeScript CLI, desktop overlay, local/hosted server, and MCP experiment. Changes should keep the project easy to run locally and safe to use as a public package.

## Local Setup

```bash
pnpm install
pnpm test:build
```

## Quality Bar

- Keep shared game, rating, and session logic covered by focused tests.
- Run `pnpm check` before opening or merging changes.
- Run `pnpm test:build` for changes that touch CLI, server, shared packages, or tests.
- Run `pnpm smoke` before release-oriented changes.
- Keep public setup paths in `README.md` aligned with the actual CLI commands.

## Pull Request Notes

For meaningful changes, include what changed, how it was validated, and any operational follow-up for hosted server or npm release behavior.
