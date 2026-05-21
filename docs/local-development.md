# Local Development

## Requirements

- Node.js 24 or newer.
- No npm dependencies are required for the first scaffold.

## Start the control plane

```bash
npm run dev
```

The dashboard is served at:

```text
http://127.0.0.1:8787
```

The API health endpoint is:

```text
http://127.0.0.1:8787/api/health
```

The authenticated dashboard subscribes to live updates from:

```text
http://127.0.0.1:8787/api/events
```

## Send one local heartbeat

```bash
npm run agent:once
```

To send the heartbeat into the local control plane:

```bash
RUNNERLY_CONTROL_PLANE_URL=http://127.0.0.1:8787 npm run agent:once
```

## Optional shared token

Set the same token for the server and agent:

```bash
RUNNERLY_AGENT_TOKEN=local-dev-token npm run dev
```

Then in another terminal:

```bash
RUNNERLY_CONTROL_PLANE_URL=http://127.0.0.1:8787 RUNNERLY_AGENT_TOKEN=local-dev-token npm run agent:once
```

## Optional dashboard auth

Set `RUNNERLY_ADMIN_TOKEN` to require a browser token login:

```bash
RUNNERLY_ADMIN_TOKEN=local-admin npm run dev
```

Open `http://127.0.0.1:8787` and sign in with `local-admin`.

For GitHub admin login, set OAuth credentials and the admin boundary:

```bash
RUNNERLY_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
RUNNERLY_GITHUB_OAUTH_CLIENT_ID=... \
RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET=... \
RUNNERLY_GITHUB_ADMIN_ORG=example-org \
RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS=platform-admins \
RUNNERLY_GITHUB_ALLOW_ORG_ADMINS=false \
RUNNERLY_SESSION_SECRET=local-session-secret \
npm run dev
```

Use `http://127.0.0.1:8787/api/auth/github/callback` as the GitHub callback
URL. Set `RUNNERLY_TOKEN_LOGIN_ENABLED=false` once the GitHub path is working.

## Optional GitHub webhook smoke test

When `RUNNERLY_GITHUB_WEBHOOK_SECRET` is set, GitHub webhooks must include a
valid `X-Hub-Signature-256` header. Without the secret, local webhook payloads
are accepted for development.

```bash
curl -X POST http://127.0.0.1:8787/api/github/webhook \
  -H 'content-type: application/json' \
  -H 'x-github-event: ping' \
  -d '{"zen":"local","hook_id":1}'
```

## Checks

```bash
npm run check
npm test
```
