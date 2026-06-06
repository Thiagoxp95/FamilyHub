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
