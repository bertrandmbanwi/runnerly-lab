#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/runnerly/app}"
DATA_DIR="${DATA_DIR:-/opt/runnerly/data}"
HOSTNAME_VALUE="${RUNNERLY_HOSTNAME:-actions-runner-control-plane}"
NODE_MAJOR="${NODE_MAJOR:-24}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root, for example: sudo APP_DIR=$APP_DIR bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Setting hostname to ${HOSTNAME_VALUE}"
hostnamectl set-hostname "${HOSTNAME_VALUE}" || true

echo "==> Installing base packages"
apt-get update
apt-get install -y ca-certificates curl git gnupg openssl

if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= ${NODE_MAJOR} ? 0 : 1)"; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/runnerly-nodesource.sh
  bash /tmp/runnerly-nodesource.sh
  apt-get install -y nodejs
fi

echo "==> Ensuring runnerly user and directories"
if ! id runnerly >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin runnerly
fi

mkdir -p /etc/runnerly "${DATA_DIR}" "$(dirname "${APP_DIR}")"
chown -R runnerly:runnerly "$(dirname "${APP_DIR}")"
chmod 0755 /etc/runnerly

if [ -f /etc/runnerly/control-plane.env ]; then
  # shellcheck disable=SC1091
  . /etc/runnerly/control-plane.env
fi

AGENT_TOKEN="${RUNNERLY_AGENT_TOKEN:-$(openssl rand -hex 32)}"
ADMIN_TOKEN="${RUNNERLY_ADMIN_TOKEN:-$(openssl rand -hex 32)}"
SESSION_SECRET="${RUNNERLY_SESSION_SECRET:-$(openssl rand -hex 32)}"
TOKEN_LOGIN_ENABLED="${RUNNERLY_TOKEN_LOGIN_ENABLED:-true}"
ALLOWED_REPOSITORIES="${RUNNERLY_ALLOWED_REPOSITORIES:-example-org/actions-runner-control-plane:linux+arm64+build-worker,example-org/security-scanner:linux+arm64+scanner}"
GITHUB_WEBHOOK_SECRET="${RUNNERLY_GITHUB_WEBHOOK_SECRET:-}"
PUBLIC_WEBHOOK_URL="${RUNNERLY_PUBLIC_WEBHOOK_URL:-}"
GITHUB_APP_ID="${RUNNERLY_GITHUB_APP_ID:-}"
GITHUB_INSTALLATION_ID="${RUNNERLY_GITHUB_INSTALLATION_ID:-}"
GITHUB_APP_PRIVATE_KEY_FILE="${RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE:-}"
PUBLIC_BASE_URL="${RUNNERLY_PUBLIC_BASE_URL:-}"
GITHUB_OAUTH_CLIENT_ID="${RUNNERLY_GITHUB_OAUTH_CLIENT_ID:-}"
GITHUB_OAUTH_CLIENT_SECRET="${RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET:-}"
GITHUB_OAUTH_CALLBACK_URL="${RUNNERLY_GITHUB_OAUTH_CALLBACK_URL:-}"
GITHUB_ADMIN_ORG="${RUNNERLY_GITHUB_ADMIN_ORG:-example-org}"
GITHUB_ADMIN_TEAM_SLUGS="${RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS:-}"
GITHUB_ALLOW_ORG_ADMINS="${RUNNERLY_GITHUB_ALLOW_ORG_ADMINS:-true}"
BACKUP_ENABLED="${RUNNERLY_BACKUP_ENABLED:-true}"
BACKUP_DIR="${RUNNERLY_BACKUP_DIR:-/opt/runnerly/data/backups}"
BACKUP_INTERVAL_MS="${RUNNERLY_BACKUP_INTERVAL_MS:-86400000}"
BACKUP_RETENTION_DAYS="${RUNNERLY_BACKUP_RETENTION_DAYS:-14}"
BACKUP_MAX_FILES="${RUNNERLY_BACKUP_MAX_FILES:-14}"
ENABLE_LOCAL_AGENT="${RUNNERLY_ENABLE_LOCAL_AGENT:-false}"

echo "==> Writing default agent config"
EXISTING_AGENT_CONFIG="$(mktemp)"
if [ -f /etc/runnerly/agent.json ]; then
  cp /etc/runnerly/agent.json "${EXISTING_AGENT_CONFIG}"
fi

cat >/etc/runnerly/agent.json <<'JSON'
{
  "runnerId": "runnerly-managed-01",
  "runnerName": "runnerly-managed-01",
  "labels": ["linux", "arm64", "managed", "lab-host"],
  "controlPlaneUrl": "http://127.0.0.1:8787",
  "diskPath": "/",
  "services": ["runnerly-control-plane.service"],
  "commands": [
    { "name": "node", "bin": "node", "args": ["--version"] },
    { "name": "npm", "bin": "npm", "args": ["--version"] },
    { "name": "git", "bin": "git", "args": ["--version"] }
  ]
}
JSON
if [ -s "${EXISTING_AGENT_CONFIG}" ] || [ -f /opt/actions-runner/.runner ]; then
  EXISTING_AGENT_CONFIG="${EXISTING_AGENT_CONFIG}" node --input-type=module -e '
    import { readFile, writeFile } from "node:fs/promises";

    const path = "/etc/runnerly/agent.json";
    const existingPath = process.env.EXISTING_AGENT_CONFIG;
    const config = JSON.parse(await readFile(path, "utf8"));
    let existing = {};

    try {
      existing = JSON.parse(await readFile(existingPath, "utf8"));
    } catch {
      existing = {};
    }

    if (Array.isArray(existing.githubRunners) && existing.githubRunners.length) {
      config.githubRunners = existing.githubRunners;
    } else if (existing.githubRunner) {
      config.githubRunners = [existing.githubRunner];
    } else {
      try {
        await readFile("/opt/actions-runner/.runner", "utf8");
        config.githubRunners = [{
          enabled: true,
          required: true,
          scope: process.env.RUNNERLY_GITHUB_RUNNER_SCOPE ?? "org",
          runnerDirectory: "/opt/actions-runner",
          owner: process.env.RUNNERLY_GITHUB_OWNER ?? "example-org",
          repo: process.env.RUNNERLY_GITHUB_RUNNER_SCOPE === "repo"
            ? process.env.RUNNERLY_GITHUB_REPO ?? "actions-runner-control-plane"
            : null
        }];
      } catch {
        config.githubRunners = [];
      }
    }

    if (config.githubRunners.length) {
      config.githubRunner = config.githubRunners[0];
    }

    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  '
fi
rm -f "${EXISTING_AGENT_CONFIG}"
chown runnerly:runnerly /etc/runnerly/agent.json
chmod 0640 /etc/runnerly/agent.json

cat >/etc/runnerly/control-plane.env <<'EOF'
RUNNERLY_HOST=127.0.0.1
RUNNERLY_PORT=8787
RUNNERLY_DB_PATH=/opt/runnerly/data/runnerly.sqlite
RUNNERLY_SEED_DEMO_DATA=false
EOF
cat >>/etc/runnerly/control-plane.env <<EOF
RUNNERLY_AGENT_TOKEN=${AGENT_TOKEN}
RUNNERLY_ADMIN_TOKEN=${ADMIN_TOKEN}
RUNNERLY_SESSION_SECRET=${SESSION_SECRET}
RUNNERLY_TOKEN_LOGIN_ENABLED=${TOKEN_LOGIN_ENABLED}
RUNNERLY_ALLOWED_REPOSITORIES=${ALLOWED_REPOSITORIES}
RUNNERLY_GITHUB_OWNER=example-org
RUNNERLY_GITHUB_RUNNER_SCOPE=org
RUNNERLY_GITHUB_ADMIN_ORG=${GITHUB_ADMIN_ORG}
RUNNERLY_GITHUB_ALLOW_ORG_ADMINS=${GITHUB_ALLOW_ORG_ADMINS}
RUNNERLY_BACKUP_ENABLED=${BACKUP_ENABLED}
RUNNERLY_BACKUP_DIR=${BACKUP_DIR}
RUNNERLY_BACKUP_INTERVAL_MS=${BACKUP_INTERVAL_MS}
RUNNERLY_BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS}
RUNNERLY_BACKUP_MAX_FILES=${BACKUP_MAX_FILES}
EOF
if [ -n "${PUBLIC_BASE_URL}" ]; then
  printf 'RUNNERLY_PUBLIC_BASE_URL=%s\n' "${PUBLIC_BASE_URL}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_WEBHOOK_SECRET}" ]; then
  printf 'RUNNERLY_GITHUB_WEBHOOK_SECRET=%s\n' "${GITHUB_WEBHOOK_SECRET}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${PUBLIC_WEBHOOK_URL}" ]; then
  printf 'RUNNERLY_PUBLIC_WEBHOOK_URL=%s\n' "${PUBLIC_WEBHOOK_URL}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_APP_ID}" ]; then
  printf 'RUNNERLY_GITHUB_APP_ID=%s\n' "${GITHUB_APP_ID}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_INSTALLATION_ID}" ]; then
  printf 'RUNNERLY_GITHUB_INSTALLATION_ID=%s\n' "${GITHUB_INSTALLATION_ID}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_APP_PRIVATE_KEY_FILE}" ]; then
  printf 'RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE=%s\n' "${GITHUB_APP_PRIVATE_KEY_FILE}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_OAUTH_CLIENT_ID}" ]; then
  printf 'RUNNERLY_GITHUB_OAUTH_CLIENT_ID=%s\n' "${GITHUB_OAUTH_CLIENT_ID}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_OAUTH_CLIENT_SECRET}" ]; then
  printf 'RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET=%s\n' "${GITHUB_OAUTH_CLIENT_SECRET}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_OAUTH_CALLBACK_URL}" ]; then
  printf 'RUNNERLY_GITHUB_OAUTH_CALLBACK_URL=%s\n' "${GITHUB_OAUTH_CALLBACK_URL}" >>/etc/runnerly/control-plane.env
fi
if [ -n "${GITHUB_ADMIN_TEAM_SLUGS}" ]; then
  printf 'RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS=%s\n' "${GITHUB_ADMIN_TEAM_SLUGS}" >>/etc/runnerly/control-plane.env
fi
chown runnerly:runnerly /etc/runnerly/control-plane.env
chmod 0640 /etc/runnerly/control-plane.env

cat >/etc/runnerly/agent.env <<EOF
RUNNERLY_AGENT_TOKEN=${AGENT_TOKEN}
EOF
chown runnerly:runnerly /etc/runnerly/agent.env
chmod 0640 /etc/runnerly/agent.env

if [ ! -d "${APP_DIR}/.git" ] && [ ! -f "${APP_DIR}/package.json" ]; then
  echo "==> App directory is not present yet: ${APP_DIR}"
  echo "Copy the repository there, then rerun this script to install services."
  exit 0
fi

echo "==> Verifying Runnerly application"
chown -R runnerly:runnerly "$(dirname "${APP_DIR}")"
sudo -u runnerly npm --prefix "${APP_DIR}" run check

echo "==> Installing systemd units"
install -m 0644 "${APP_DIR}/ops/systemd/runnerly-control-plane.service" /etc/systemd/system/runnerly-control-plane.service
install -m 0644 "${APP_DIR}/ops/systemd/runnerly-agent.service" /etc/systemd/system/runnerly-agent.service
install -m 0644 "${APP_DIR}/ops/systemd/runnerly-webhook-relay.service" /etc/systemd/system/runnerly-webhook-relay.service
systemctl daemon-reload
systemctl enable runnerly-control-plane.service
if [ "${ENABLE_LOCAL_AGENT}" = "true" ]; then
  systemctl enable runnerly-agent.service
else
  systemctl disable --now runnerly-agent.service >/dev/null 2>&1 || true
fi
if [ -f /etc/runnerly/webhook-relay.env ]; then
  if ! command -v smee >/dev/null 2>&1; then
    echo "==> Installing smee-client for webhook relay"
    npm install -g smee-client
  fi
  systemctl enable runnerly-webhook-relay.service
  systemctl restart runnerly-control-plane.service runnerly-webhook-relay.service
else
  systemctl disable --now runnerly-webhook-relay.service >/dev/null 2>&1 || true
  systemctl restart runnerly-control-plane.service
fi
if [ "${ENABLE_LOCAL_AGENT}" = "true" ]; then
  systemctl restart runnerly-agent.service
fi

echo "==> Service status"
systemctl --no-pager --full status runnerly-control-plane.service || true
if [ "${ENABLE_LOCAL_AGENT}" = "true" ]; then
  systemctl --no-pager --full status runnerly-agent.service || true
else
  echo "runnerly-agent.service disabled on control-plane-only host"
fi
if [ -f /etc/runnerly/webhook-relay.env ]; then
  systemctl --no-pager --full status runnerly-webhook-relay.service || true
fi

echo "==> Runnerly bootstrap complete"
if [ -n "${PUBLIC_BASE_URL}" ]; then
  echo "Dashboard URL: ${PUBLIC_BASE_URL}"
else
  echo "Use SSH port forwarding to view the dashboard:"
  echo "ssh -L 8787:127.0.0.1:8787 ubuntu@<public-ip>"
fi
