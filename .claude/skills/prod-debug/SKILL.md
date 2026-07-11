---
name: prod-debug
description: Inspect Trident production (DO droplet, PM2, managed Postgres, Grafana Cloud) — logs, DB queries, env, webhook checks. Use when diagnosing prod issues or verifying deploys.
---

# Prod debugging recipes

Verified 2026-07-11. **Read-only by default; confirm with the user before mutating prod.**

## Access

- Droplet: `ssh -i ~/.ssh/id_ed25519_tridentV2 root@139.59.130.215` (DO FRA1)
- Live backend dir: `/var/www/trident-virtual-ai/backend` — always take it from `pm2 jlist` → `pm_cwd`, NOT `find` (stale backups exist under `/root/backups/`).
- Frontend: https://trident-virtual.ai · API: https://api.trident-virtual.ai/api

## PM2

```bash
pm2 jlist | python3 -c 'import json,sys; [print(p["name"], p["pm2_env"]["status"], p["pm2_env"]["pm_cwd"]) for p in json.load(sys.stdin)]'
tail -100 ~/.pm2/logs/trident-backend-out.log
tail -100 ~/.pm2/logs/trident-backend-error.log
pm2 restart trident-backend --update-env      # after .env changes (MUTATING)
```

## Prod DB (DO managed Postgres — no psql on droplet)

Query via the backend's own node_modules on the droplet:

```bash
cd /var/www/trident-virtual-ai/backend && node -e "
require('dotenv').config();
const {Client}=require('pg');
const c=new Client({host:process.env.DB_HOST,port:+process.env.DB_PORT,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,ssl:{rejectUnauthorized:false}});
c.connect().then(async()=>{
  const r=await c.query('select count(*) from alerts');
  console.log(r.rows); await c.end();
}).catch(e=>{console.error(e.message);process.exit(1)});
"
```

## Health & alerts webhook

```bash
curl -s https://api.trident-virtual.ai/api/health
# reachable:false for influx/rag/llm is HARDCODED cosmetics, not an outage.

# webhook auth check (401 = alive and secured):
curl -s -o /dev/null -w "%{http_code}" -X POST https://api.trident-virtual.ai/api/alerts/grafana -d '{}'
```

Secret: `grep '^GRAFANA_WEBHOOK_SECRET=' /var/www/trident-virtual-ai/backend/.env` — fetch into a shell var, never print.

## Grafana Cloud (tridentvirtual.grafana.net)

- k8s-style API namespace: `stacks-1327514`. Provisioning API needs an SA token (`glsa_...`) — ask the user, rotate after use.
- Alert rules use **simplified routing** (per-rule contact point → IRM receivers), so the notification-policy tree is bypassed; the Trident webhook lives as a second integration INSIDE each receiver (Stas/Shaun IRM Critical/Default, Schedule Critical/Default). When adding a receiver, add the webhook integration to it too.
- Useful endpoints: `/api/v1/provisioning/contact-points`, `/api/v1/provisioning/policies`, `/api/v1/provisioning/alert-rules`, live states `/api/prometheus/grafana/api/v1/rules`, dispatcher groups `/api/alertmanager/grafana/api/v2/alerts/groups`.
- Env knobs on prod: `GRAFANA_WEBHOOK_SECRET`, `ALERT_AUTO_TASK_SEVERITY` (default critical → auto unplanned PMS task).

## Deploy

Push to main auto-deploys (GH Action `deploy.yml` → `scripts/deploy.sh`, ~30s outage). Migrations do NOT auto-run: `npm run db:migrate` on the droplet when needed (backup first for destructive ones).
