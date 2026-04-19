# Backend

Fresh NestJS backend for Trident Virtual AI with a modular monolith architecture.

## Architecture

- `src/core` - auth, config, database, health, logging
- `src/common` - shared enums, DTOs, types
- `src/integrations` - adapters for Postgres health, Influx, RAG, web search, LLM
- `src/modules` - chat, planner, composer, executors, metrics, documents, web, admin, users, ships

## Local database

Local PostgreSQL runs in Docker on port `5433`.

```bash
cd backend
npm install
npm run db:up
npm run db:migrate
npm run db:seed
```

Default seeded credentials:

- Admin: `admin / admin12345`
- Crew user: `crew-demo / crew12345`

## Run backend

```bash
cd backend
npm run start
```

API base URL: `http://localhost:3000/api`

## Auth model

- `admin` has access to all ships and admin endpoints
- `user` is always attached to exactly one ship
- JWT auth is exposed via `POST /api/auth/login` and `GET /api/auth/me`

## Available endpoints

- `GET /api`
- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/users/me`
- `GET /api/users` (admin)
- `POST /api/users` (admin)
- `PATCH /api/users/:id/name` (admin)
- `PATCH /api/users/:id/reset-password` (admin)
- `DELETE /api/users/:id` (admin)
- `GET /api/ships`
- `GET /api/ships/:id`
- `POST /api/ships` (admin)
- `PATCH /api/ships/:id` (admin)
- `POST /api/chat/messages`
- `GET /api/metrics/catalog`
- `POST /api/metrics/query`
- `POST /api/documents/search`
- `POST /api/web/search`
- `GET /api/admin/overview` (admin)

## Next steps

1. Add chat session persistence and message history tables.
2. Replace metrics/documents/web stub execution with real Influx, RAG, and external providers.
3. Add refresh tokens, logout/session invalidation, and password rotation policies.
4. Cover auth, access control, and planner logic with unit and e2e tests.
