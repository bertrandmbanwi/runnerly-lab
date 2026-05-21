# Operations Examples

Operational assets for installing Runnerly Lab on a generic Linux host or a
managed runner host.

The templates in `systemd/` assume the repository is checked out at:

```text
/opt/runnerly/app
```

They are intentionally conservative:

- Bind the control plane to `127.0.0.1` by default.
- Put public access behind a TLS reverse proxy and Runnerly auth.
- Restart on failure.
- Keep secrets in `/etc/runnerly/*.env`, outside the repository.
- Run as a dedicated `runnerly` user.

Create the user before installing units:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin runnerly
sudo mkdir -p /etc/runnerly /opt/runnerly
sudo chown -R runnerly:runnerly /opt/runnerly
```

Or run the bundled bootstrap script as root:

```bash
sudo bash ops/scripts/bootstrap-linux-vm.sh
```

The script installs Node.js 24, creates `/etc/runnerly` and `/opt/runnerly`,
writes example environment files, and installs systemd units after the app
exists at `/opt/runnerly/app`.

## Example Deploy

`ops/scripts/deploy-linux-vm.example.sh` is intentionally an example, not a
production deployment path. Override the host and key explicitly:

```bash
VM_HOST=runnerly.example.test \
SSH_KEY=/path/to/runnerly-lab-key \
ops/scripts/deploy-linux-vm.example.sh
```

## GitHub Runner Install

After the control plane has GitHub App credentials, install an organization
runner on a separate managed worker host:

```bash
sudo GITHUB_OWNER=example-org GITHUB_RUNNER_SCOPE=org \
  RUNNERLY_AGENT_TOKEN=replace-with-agent-token \
  bash /opt/runnerly/app/ops/scripts/install-github-runner.sh
```

Use `GITHUB_RUNNER_SCOPE=repo GITHUB_REPO=<name>` only when a runner should be
restricted to one repository.

The installer downloads the official GitHub Actions runner, configures it,
installs its systemd service, and restarts the Runnerly agent so the dashboard
can report runner service health.
