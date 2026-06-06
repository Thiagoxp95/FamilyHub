# FamilyHub

Electron application in an npm workspace managed by Turborepo.

## Scripts

- `npm run dev` starts the Electron app in development mode.
- `npm run build` typechecks and builds the app.
- `npm run lint` runs ESLint across workspaces.
- `npm run typecheck` runs TypeScript checks across workspaces.
- `npm run format` formats the repo with Prettier.

## Structure

```text
apps/electron
  src/main      Electron main process
  src/preload   Isolated preload bridge
  src/renderer  React renderer
```

## Voice assistant (James)

The assistant uses an always-on local ASR sidecar (Parakeet, Apple Silicon) for
the "James" wake word and to capture speech while the Gemini Live session
connects. Set it up once (requires Python 3.10+):

```bash
cd sidecar
./setup.sh
```

Required environment (in `.env.local` or `~/.familyhub/.env`):

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — Gemini Live conversation.

Google Cloud Speech credentials are now optional (used only by the diagnostics
chunk path, not for the wake word).
