---
name: run-local
description: Launch the Trident app locally (Postgres + Nest backend + Vite frontend) and smoke-test it. Use when asked to run/start the app or verify a change in the running app.
---

# Run Trident locally

Verified 2026-07-11 on macOS (darwin), node 26, Homebrew Postgres 16.

## 1. Postgres (Homebrew, NOT docker)

`backend/.env` points at **local Homebrew Postgres 16 on 5432**. The docker-compose file (port 5433) is legacy — do not use it; `docker` is not installed on this machine.

```bash
brew services list | grep postgres          # check
brew services start postgresql@16           # start if "none"
lsof -i :5432 -sTCP:LISTEN                   # confirm listening
```

## 2. Backend (port 3000)

```bash
cd backend && npm run start:dev
```

Run in background; logs to a scratchpad file. The script kills any stale :3000 listener itself. Ready when the log says `Backend listening on http://localhost:3000/api` (~146 routes mapped).

## 3. Frontend (port 5173)

```bash
cd frontend && npm run dev
```

The dev script kills any stale :5173 listener itself. There is **no vite proxy** — the frontend calls `http://localhost:3000/api` directly (`VITE_API_URL` fallback in `src/api/core.ts`), so a 404 from `localhost:5173/api/...` is normal.

## 4. Smoke test

```bash
curl -s http://localhost:3000/api/health            # 200 JSON (ignore reachable:false — cosmetic)
curl -s http://localhost:5173/ | grep -o "<title>[^<]*</title>"   # "Trident Intelligence Platform"
```

Then open http://localhost:5173/. Both processes hot-reload (nest --watch, vite HMR).
