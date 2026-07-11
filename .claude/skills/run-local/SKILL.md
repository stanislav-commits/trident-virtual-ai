---
name: run-local
description: Run, start, launch, screenshot, or smoke-test the Trident app locally (Postgres + Nest backend :3000 + Vite frontend :5173), including driving the UI programmatically via the bundled playwright driver.
---

# Run Trident locally

Paths are relative to the repo root. Verified 2026-07-11 on macOS, node 26, Homebrew Postgres 16, system Google Chrome.

## 1. Postgres (Homebrew, NOT docker)

`backend/.env` points at **local Homebrew Postgres 16 on 5432**. The docker-compose file (port 5433) is legacy; `docker` is not installed on this machine.

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

## 4. Drive the UI (agent path)

The driver is `.claude/skills/run-local/driver.mjs` — playwright-core + the **system Chrome** (`channel: 'chrome'`, no browser download). It logs in with the dev-seed admin and screenshots the login page and the app shell.

One-time setup (outside the repo, so its node_modules never touches the tree):

```bash
mkdir -p /tmp/trident-ui-driver && cd /tmp/trident-ui-driver
npm init -y && npm i playwright-core
```

Run (cwd must be the driver dir — that's how playwright-core resolves):

```bash
cd /tmp/trident-ui-driver
node <repo>/.claude/skills/run-local/driver.mjs <screenshots-out-dir>
```

Success output ends with `OK: logged in as admin — title: Trident Intelligence Platform` and writes `01-login.png` / `02-after-login.png` (on failure: `99-failure.png`). **Look at the screenshots** — `02-after-login.png` must show the chat shell with the vessel picker ("SeaWolf X"), not a blank page.

Credentials come from the dev seed (`backend/src/core/database/seeds/dev.seed.ts`): `admin` / `admin12345` (admin), `crew-demo` / `crew12345` (crew). Override with `TRIDENT_URL` / `TRIDENT_USER` / `TRIDENT_PASS` env vars.

## 5. API smoke (no browser)

```bash
curl -s http://localhost:3000/api/health     # 200 JSON (reachable:false is cosmetic, ignore)
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"userId":"admin","password":"admin12345"}'   # returns {"access_token":"..."}
```

Use the token as `Authorization: Bearer <token>` for any authed route.

## 6. Human path

Open http://localhost:5173/ and log in as above. Both processes hot-reload (nest --watch, vite HMR).

## Gotchas

- Login is by **User ID**, not email; the form fields are matched by placeholder (`User ID`, `Password`) — the driver relies on those placeholders.
- If the DB is empty, seed first: `cd backend && npm run db:seed` (creates the admin/crew users and a demo ship).
- The frontend build check that matches prod is `npm run build` (tsc -b), not `tsc --noEmit` — see CLAUDE.md.
- `chromium-cli` and a repo-local playwright are NOT installed; the system-Chrome driver above is the only verified browser path.
