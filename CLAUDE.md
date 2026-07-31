# Trident Virtual AI

Yacht/fleet intelligence platform: NestJS backend + React (Vite) frontend + React Native mobile app (separate repo). Single production vessel today (Sea Wolf X), but code must stay fleet-ready.

## Commands

| What | Where | Command |
|---|---|---|
| Backend typecheck | `backend/` | `npm run typecheck` (tsc --noEmit) |
| Backend lint | `backend/` | `npm run lint` (eslint) |
| Backend dev server | `backend/` | `npm run start:dev` (port 3000, kills stale listener first) |
| Frontend verify | `frontend/` | `npm run build` — **this is the check that matches prod** (tsc -b + vite); do not rely on tsc --noEmit alone |
| Frontend lint | `frontend/` | `npm run lint` |
| Frontend dev | `frontend/` | `npm run dev` (port 5173, no proxy — calls localhost:3000/api directly) |
| Local Postgres | — | Homebrew `postgresql@16` on 5432 (NOT the docker-compose on 5433): `brew services start postgresql@16` |
| DB migrations | `backend/` | `npm run db:migrate` (`-t each` flag matters; migrations do NOT auto-run — `migrationsRun: false`) |

CI (`.github/workflows/ci.yml` + `checks` job in `deploy.yml`) runs typecheck + lint + frontend build. Deploy will not start if checks fail.

## Deployment — READ BEFORE PUSHING

- **Push to `main` = automatic production deploy** (GitHub Action → SSH to DO droplet → `scripts/deploy.sh`) with a ~30s outage. **Never push without the user's explicit per-push OK.** Local commits are fine anytime.
- Batch commits and push once, not per-commit.
- Prod: frontend `trident-virtual.ai`, API `https://api.trident-virtual.ai/api`, DO droplet FRA1 (PM2 process `trident-backend`, live dir `/var/www/trident-virtual-ai/backend`), DO managed Postgres. See `.claude/skills/prod-debug` for access recipes.
- Prod migrations run automatically: `scripts/deploy.sh` executes `npm run db:migrate` as a deploy step (verified live 2026-07-20). Verify they landed (deploy-check skill); no separate manual step. Locally they stay manual (table above).
- **A deploy is not finished when the droplet's commit changes.** `git reset --hard` is the first step, the migrations run ~90s later after both builds. Check `/var/log/trident-deploy.log` on the droplet — every run logs START → COMPLETE, or `DEPLOY FAILED (exit N)`. Judging by `git log` mid-deploy looks like a failed migration and is not one (2026-07-31).
- This is a multi-developer repo (Mark, Shaun and others commit) — expect main to move; rebase/merge before starting work.

## Architecture map

- `backend/src/modules/` — domain: ships, assets (register + SFI), pms (tasks/maintenance, mirrors IDEA yacht PMS), compliance (doc-control: 11 archetypes, BASE+archetype fields), documents (knowledge base), metrics (Influx catalog + semantic concepts + analyzer tools), alerts (Grafana webhook ingest), chat (orchestration/routing/responders), access-control (position-based RBAC matrix), crew, inventory, sfi, users, admin.
- `backend/src/integrations/` — influx, rag (RAGFlow), llm (Anthropic primary, OpenAI-compatible fallback), web-search, transcription, grafana-llm, windy. Shared HTTP clients in `integrations/shared/`.
- `frontend/src/api/` — one `<domain>Api.ts` per module + `core.ts` (`fetchWithAuth`, `getApiUrl`). `client.ts` is the legacy grab-bag — put new endpoints in per-domain files.
- Alerts flow: Grafana Cloud (`tridentvirtual.grafana.net`, stack `stacks-1327514`) evaluates Influx and POSTs to `/api/alerts/grafana` (Bearer `GRAFANA_WEBHOOK_SECRET`). Rules use per-rule contact points (simplified routing); the Trident webhook is an extra integration inside each IRM receiver. Resolution: `metric_key` label → `ship_metric_catalog`, else `ship_id` label, else single-vessel fallback. Alerts do NOT auto-create PMS tasks by default (`ALERT_AUTO_TASK_SEVERITY` default `off`; set to `critical`/`high`/… to re-enable the spawn).

## Working agreement

- Run `/code-review` on the diff before every commit (bugs); `/simplify` optional for cleanups.
- A PostToolUse hook (`.claude/settings.json`) runs tsc + eslint on the touched package after every Edit/Write to backend/frontend source — fix failures immediately, don't defer.

## Gotchas / conventions

- **Prompts are English-only — no exceptions.** Every string sent to a model (system prompts, tool descriptions/examples, decomposer/classifier/router instructions, brief and alert questions) must be written in English. Russian wording inside prompts — above all the examples in `tool-definitions.const.ts` — dragged answers into Russian on English conversations (2026-07-27). To control the OUTPUT language, pass `answerLanguage` to `MetricAnalyzerResponderService.answer()` instead; never translate the prompt. This does NOT apply to: regexes that match Russian user input (`chat-pending-write-confirmation.util.ts`, `chat-turn-classifier.service.ts`, document/parts keyword lists), transliteration tables, or user-facing strings shown to the crew.

- **Secrets:** grep `.env` files by exact var name only (`grep '^VAR_NAME='`) — never dump them; never print secret values into chat/logs.
- Health endpoint `reachable: false` for influx/rag/llm/web-search is hardcoded cosmetics (`getStatus()` never probes) — not an outage signal.
- `severity` label from Grafana arrives as `severity` or `Severity` (hand-made rules) — webhook normalizes both.
- Asset import: header matching + display-name matching use `assets.normalization.ts` (`lowerTrim`, `normalizeHeaderKey`). The register is built by overlay: `build.py` = structure, user xlsx = content, matched by `drawing_code` — never regenerate blindly.
- Compliance `updateDoc` intentionally replaces (not merges) `fields` — clearing a field must delete it.
- The various `normalizeOptional*` DTO helpers and metrics tokenizers/humanizers diverge **on purpose** (null vs undefined semantics, unicode vs ascii, camelCase splitting) — do not "dedupe" them mechanically.
- ESLint: new react-hooks rules (`set-state-in-effect`, `refs`, `immutability`) and backend `no-explicit-any` are warnings = tracked debt; don't add new ones.
- God files pending split (own branch, big diffs): `metrics-semantic-catalog.service.ts`, `PmsSection.tsx`, `TagsSection.tsx`, `MetricsSemanticConceptsPanel.tsx`.
- The assets module was split on 2026-07-31 and is the pattern to follow: the service keeps the register's own rows (`assets.service.ts`), and everything with its own subject lives beside it — `asset-xlsx.codec.ts` (the sheet, no DB), `asset-import.service.ts` (preview + commit), `asset-links.service.ts` (documents + metrics), `asset-id.service.ts`, `asset-snapshot.service.ts`, `asset-service-rules.service.ts`. On the UI side `useAssetRegisterView` owns the filter/sort/selection chain and each drawer tab is a file under `components/admin/assets/drawer/`.
