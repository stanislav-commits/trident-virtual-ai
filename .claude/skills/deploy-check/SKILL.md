---
name: deploy-check
description: Verify a Trident production deploy landed and is healthy (Action status, API health, PM2, migrations). Run after every push to main.
---

# Post-deploy verification

## 1. GitHub Action

```bash
gh run list --workflow deploy.yml --limit 3
gh run watch <run-id>        # if still running
```

The `checks` job (typecheck+lint+build) gates `deploy`; a red `checks` means prod was NOT touched.

## 2. API health + version signal

```bash
curl -s https://api.trident-virtual.ai/api/health    # expect HTTP 200
# reachable:false for influx/rag/llm/web-search is cosmetic (hardcoded), ignore.
curl -s -o /dev/null -w "%{http_code}\n" https://trident-virtual.ai/
```

Expect ~30s of downtime during the deploy itself; retry before concluding failure.

## 3. Process + fresh boot log

```bash
ssh -i ~/.ssh/id_ed25519_tridentV2 root@139.59.130.215 \
  'pm2 jlist | python3 -c "import json,sys; [print(p[\"name\"],p[\"pm2_env\"][\"status\"]) for p in json.load(sys.stdin)]"; \
   tail -20 ~/.pm2/logs/trident-backend-out.log'
```

Look for `Nest application successfully started` after the deploy timestamp, and no ERROR burst in `trident-backend-error.log`.

## 4. Migrations (only if the push contained new ones)

Migrations do NOT auto-run (`migrationsRun: false`). On the droplet:

```bash
cd /var/www/trident-virtual-ai/backend && npm run db:migrate
```

Backup the DB first if any migration is destructive. Then re-run step 2.

## 5. Feature probe

Hit one endpoint the deploy actually changed (with auth if needed) — health alone doesn't prove the feature works. For alerts: see `prod-debug` skill, query the `alerts` table.
