# Runnerly Lab Operator Runbook

This runbook is a generic guide for operating Runnerly Lab on a Linux host. It
uses placeholder values only.

## Local Health Checks

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/auth/status
```

If installed with the example systemd units:

```bash
sudo systemctl status runnerly-control-plane
sudo journalctl -u runnerly-control-plane -n 80 --no-pager
```

## Expected Demo State

With demo data enabled, the dashboard should show:

- Multiple example runners across build, scanner, and utility lanes.
- A mix of private and public demo repositories.
- Public repositories marked as webhook-only / GitHub-hosted.
- Recent demo workflow jobs.
- A live operations panel.
- Evidence export links.

## Environment

Common control-plane settings:

```text
RUNNERLY_HOST=127.0.0.1
RUNNERLY_PORT=8787
RUNNERLY_DB_PATH=/opt/runnerly/data/runnerly.sqlite
RUNNERLY_AGENT_TOKEN=replace-with-random-token
RUNNERLY_ADMIN_TOKEN=replace-with-random-token
RUNNERLY_SESSION_SECRET=replace-with-random-secret
RUNNERLY_TOKEN_LOGIN_ENABLED=true
RUNNERLY_ALLOWED_REPOSITORIES=example-org/runnerly-lab:linux+arm64+build-worker,example-org/security-scanner:linux+arm64+scanner
```

Optional GitHub App / OAuth settings:

```text
RUNNERLY_GITHUB_APP_ID=...
RUNNERLY_GITHUB_INSTALLATION_ID=...
RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE=/etc/runnerly/github-app.private-key.pem
RUNNERLY_GITHUB_WEBHOOK_SECRET=...
RUNNERLY_PUBLIC_WEBHOOK_URL=https://runnerly.example.test/api/github/webhook
RUNNERLY_PUBLIC_BASE_URL=https://runnerly.example.test
RUNNERLY_GITHUB_OAUTH_CLIENT_ID=...
RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET=...
RUNNERLY_GITHUB_OAUTH_CALLBACK_URL=https://runnerly.example.test/api/auth/github/callback
RUNNERLY_GITHUB_ADMIN_ORG=example-org
RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS=platform-admins
```

Never commit private keys, webhook secrets, admin tokens, agent tokens, or OAuth
client secrets.

## Reconcile

Runnerly treats GitHub webhooks as the near-real-time source for workflow
activity. A lightweight runner heartbeat can poll GitHub runner status every
30 seconds, while a slower full reconcile updates repository visibility, runner
groups, runner labels, and runner busy state.

From the dashboard, use **Reconcile GitHub** to trigger a manual correction
loop.

With token auth enabled:

```bash
curl -fsS -X POST \
  -H "authorization: Bearer $RUNNERLY_ADMIN_TOKEN" \
  http://127.0.0.1:8787/api/reconcile
```

## Backups

Runnerly stores SQLite backups locally when backup scheduling is enabled.

```bash
npm run restore:drill
```

The restore drill verifies that the newest backup can be opened without
modifying the active database.

## Incident Checklist

1. Check `/api/health`.
2. Check `runnerly-control-plane` logs.
3. Confirm disk space on the data directory.
4. Confirm webhook deliveries in GitHub.
5. Trigger a manual reconcile.
6. Export evidence from the dashboard if you need an incident snapshot.
