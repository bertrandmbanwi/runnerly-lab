#!/usr/bin/env bash
set -euo pipefail

RUNNER_USER="${RUNNER_USER:-actions-runner}"
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-github}"
RUNNER_LABELS="${RUNNER_LABELS:-linux,arm64,managed,example-org}"
RUNNER_WORK_DIR="${RUNNER_WORK_DIR:-_work}"
GITHUB_OWNER="${GITHUB_OWNER:-example-org}"
GITHUB_RUNNER_SCOPE="${GITHUB_RUNNER_SCOPE:-${RUNNERLY_GITHUB_RUNNER_SCOPE:-org}}"
GITHUB_REPO="${GITHUB_REPO:-}"
GITHUB_RUNNER_URL="${GITHUB_RUNNER_URL:-}"
RUNNERLY_CONTROL_PLANE_URL="${RUNNERLY_CONTROL_PLANE_URL:-http://127.0.0.1:8787}"
RUNNERLY_REGISTRATION_AUTH_TOKEN="${RUNNERLY_REGISTRATION_AUTH_TOKEN:-${RUNNERLY_AGENT_TOKEN:-}}"
RUNNERLY_AGENT_SERVICE="${RUNNERLY_AGENT_SERVICE:-runnerly-agent.service}"
UPDATE_RUNNERLY_AGENT_CONFIG="${UPDATE_RUNNERLY_AGENT_CONFIG:-auto}"
FORCE_REGISTER="${FORCE_REGISTER:-false}"

case "${GITHUB_RUNNER_SCOPE}" in
  org|organization|organisation)
    GITHUB_RUNNER_SCOPE="org"
    GITHUB_RUNNER_URL="${GITHUB_RUNNER_URL:-https://github.com/${GITHUB_OWNER}}"
    ;;
  repo|repository)
    GITHUB_RUNNER_SCOPE="repo"
    GITHUB_REPO="${GITHUB_REPO:-runnerly}"
    GITHUB_RUNNER_URL="${GITHUB_RUNNER_URL:-https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}}"
    ;;
  *)
    echo "GITHUB_RUNNER_SCOPE must be org or repo." >&2
    exit 1
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo GITHUB_OWNER=example-org GITHUB_RUNNER_SCOPE=org bash $0" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Run ops/scripts/bootstrap-linux-vm.sh first." >&2
  exit 1
fi

if ! id "${RUNNER_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${RUNNER_USER}"
fi

mkdir -p "${RUNNER_DIR}"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}"

if [ -f "${RUNNER_DIR}/.runner" ] && [ "${FORCE_REGISTER}" != "true" ]; then
  echo "==> GitHub runner is already configured at ${RUNNER_DIR}"
  if [ -x "${RUNNER_DIR}/svc.sh" ]; then
    "${RUNNER_DIR}/svc.sh" start || true
  fi
  exit 0
fi

echo "==> Fetching GitHub runner registration token for ${GITHUB_RUNNER_URL}"
if [ -z "${GITHUB_RUNNER_TOKEN:-}" ]; then
  if [ -z "${RUNNERLY_REGISTRATION_AUTH_TOKEN}" ]; then
    echo "Set GITHUB_RUNNER_TOKEN, RUNNERLY_AGENT_TOKEN, or RUNNERLY_REGISTRATION_AUTH_TOKEN." >&2
    exit 1
  fi

  GITHUB_RUNNER_TOKEN="$(
    RUNNERLY_CONTROL_PLANE_URL="${RUNNERLY_CONTROL_PLANE_URL}" \
    RUNNERLY_REGISTRATION_AUTH_TOKEN="${RUNNERLY_REGISTRATION_AUTH_TOKEN}" \
    GITHUB_OWNER="${GITHUB_OWNER}" \
    GITHUB_REPO="${GITHUB_REPO}" \
    GITHUB_RUNNER_SCOPE="${GITHUB_RUNNER_SCOPE}" \
    node --input-type=module -e '
      const response = await fetch(new URL("/api/github/runner-registration-token", process.env.RUNNERLY_CONTROL_PLANE_URL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.RUNNERLY_REGISTRATION_AUTH_TOKEN}`
        },
        body: JSON.stringify({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO || undefined,
          scope: process.env.GITHUB_RUNNER_SCOPE
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `token request failed: ${response.status}`);
      process.stdout.write(payload.token);
    '
  )"
fi

echo "==> Resolving latest official actions runner asset"
ASSET_URL="$(
  node --input-type=module -e '
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
    const response = await fetch("https://api.github.com/repos/actions/runner/releases/latest", {
      headers: { "accept": "application/vnd.github+json", "user-agent": "runnerly-runner-installer" }
    });
    const release = await response.json();
    if (!response.ok) throw new Error(release.message ?? `release lookup failed: ${response.status}`);
    const asset = release.assets.find((item) => item.name === `actions-runner-linux-${arch}-${release.tag_name.replace(/^v/, "")}.tar.gz`)
      ?? release.assets.find((item) => item.name.includes(`linux-${arch}`) && item.name.endsWith(".tar.gz"));
    if (!asset) throw new Error(`No linux-${arch} runner asset found`);
    process.stdout.write(asset.browser_download_url);
  '
)"

echo "==> Downloading ${ASSET_URL}"
curl -fsSL "${ASSET_URL}" -o /tmp/actions-runner.tgz
tar -xzf /tmp/actions-runner.tgz -C "${RUNNER_DIR}"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}"

echo "==> Configuring GitHub runner ${RUNNER_NAME}"
sudo -u "${RUNNER_USER}" bash -lc "
  cd '${RUNNER_DIR}'
  ./config.sh \
    --unattended \
    --url '${GITHUB_RUNNER_URL}' \
    --token '${GITHUB_RUNNER_TOKEN}' \
    --name '${RUNNER_NAME}' \
    --labels '${RUNNER_LABELS}' \
    --work '${RUNNER_WORK_DIR}' \
    --replace
"

echo "==> Installing and starting runner service"
cd "${RUNNER_DIR}"
./svc.sh install "${RUNNER_USER}"
./svc.sh start

if [ "${UPDATE_RUNNERLY_AGENT_CONFIG}" != "false" ] && [ -f /etc/runnerly/agent.json ]; then
  echo "==> Updating Runnerly agent config"
  RUNNER_DIR="${RUNNER_DIR}" \
  GITHUB_RUNNER_SCOPE="${GITHUB_RUNNER_SCOPE}" \
  GITHUB_OWNER="${GITHUB_OWNER}" \
  GITHUB_REPO="${GITHUB_REPO}" \
  node --input-type=module -e '
    import { readFile, writeFile } from "node:fs/promises";
    const path = "/etc/runnerly/agent.json";
    const config = JSON.parse(await readFile(path, "utf8"));
    const next = {
      enabled: true,
      required: true,
      scope: process.env.GITHUB_RUNNER_SCOPE,
      runnerDirectory: process.env.RUNNER_DIR ?? "/opt/actions-runner",
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_RUNNER_SCOPE === "repo" ? process.env.GITHUB_REPO : null
    };
    const current = Array.isArray(config.githubRunners)
      ? config.githubRunners
      : config.githubRunner
        ? [config.githubRunner]
        : [];
    config.githubRunners = [
      ...current.filter((runner) => {
        const sameDirectory = (runner.runnerDirectory ?? null) === next.runnerDirectory;
        const sameTarget = runner.owner === next.owner
          && (runner.repo ?? null) === next.repo
          && (runner.scope ?? "repo") === next.scope;
        return !sameDirectory && !sameTarget;
      }),
      next
    ];
    config.githubRunner = next;
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  '
  if id runnerly >/dev/null 2>&1; then
    chown runnerly:runnerly /etc/runnerly/agent.json
  fi
  if systemctl cat "${RUNNERLY_AGENT_SERVICE}" >/dev/null 2>&1; then
    systemctl restart "${RUNNERLY_AGENT_SERVICE}"
  else
    echo "==> Runnerly agent service is not installed; skipping restart"
  fi
else
  echo "==> Runnerly agent config is not present; skipping agent config update"
fi

echo "==> GitHub runner install complete"
