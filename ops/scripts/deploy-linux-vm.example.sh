#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:?Set VM_HOST to the target Linux host}"
VM_USER="${VM_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:?Set SSH_KEY to the private key for the target host}"
APP_DIR="${APP_DIR:-/opt/runnerly/app}"
ARCHIVE="${ARCHIVE:-/tmp/runnerly-src.tgz}"
KNOWN_HOSTS="${KNOWN_HOSTS:-/tmp/runnerly-known-hosts}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="${KNOWN_HOSTS}"
  -o IdentitiesOnly=yes
  -i "${SSH_KEY}"
)

echo "==> Packaging Runnerly from ${ROOT_DIR}"
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --exclude .git \
  --exclude node_modules \
  --exclude .runnerly \
  --exclude '._*' \
  --exclude '.DS_Store' \
  -czf "${ARCHIVE}" \
  -C "${ROOT_DIR}" .

echo "==> Uploading source bundle to ${VM_USER}@${VM_HOST}"
scp "${SSH_OPTS[@]}" "${ARCHIVE}" "${VM_USER}@${VM_HOST}:/tmp/runnerly-src.tgz"
scp "${SSH_OPTS[@]}" "${ROOT_DIR}/ops/scripts/bootstrap-linux-vm.sh" "${VM_USER}@${VM_HOST}:/tmp/bootstrap-linux-vm.sh"

echo "==> Installing on VM"
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" "
  set -euo pipefail
  sudo mkdir -p '${APP_DIR}'
  sudo tar -xzf /tmp/runnerly-src.tgz -C '${APP_DIR}'
  sudo find '${APP_DIR}' \( -name '._*' -o -name '.DS_Store' \) -delete
  sudo chown -R runnerly:runnerly /opt/runnerly || true
  sudo bash /tmp/bootstrap-linux-vm.sh
"

echo "==> Verifying Runnerly"
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" "
  set -euo pipefail
  systemctl is-active runnerly-control-plane
  curl -fsS http://127.0.0.1:8787/api/health
"

echo "==> Deployment complete"
