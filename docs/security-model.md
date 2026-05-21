# Security Model

Runnerly starts with a conservative security boundary.

## Trust assumptions

- GitHub Actions remains the CI coordinator.
- Runnerly controls which runner labels and repositories are expected.
- The runner host is owned by the team operating the control plane.
- The control plane process is private to the host and is not exposed directly.
- Operators access the lab dashboard through nginx TLS and GitHub OAuth, or
  through SSH port forwarding for break-glass diagnostics.

## MVP controls

- GitHub OAuth login for dashboard admins, restricted to the configured admin
  team when `RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS` is set. Organization admin
  fallback is opt-in through `RUNNERLY_GITHUB_ALLOW_ORG_ADMINS=true`.
- Admin-token gate for the dashboard and read APIs as a break-glass fallback
  when token login is explicitly enabled on the host.
- Shared token for agent-to-control-plane heartbeats.
- Repository allowlist data model.
- Runner labels are persisted and visible.
- Audit events are append-only records in SQLite.
- Agent checks report disk, service, and command health.
- GitHub webhook signature verification when a webhook secret is configured.
- GitHub App registration-token minting for organization-scoped runners, with
  repository-scoped minting available when a runner must stay narrow.
- GitHub App reconciliation for read-side runner/repository inventory before
  any lifecycle controls are introduced.
- Authenticated evidence exports and local SQLite backups retained on the
  control-plane host.

## Not in scope yet

- FedRAMP certification.
- Multi-tenant SaaS isolation.
- Secret scanning inside CI logs.
- Hosted identity provider integration beyond GitHub.
- Managed database, queue, load balancer, or Kubernetes deployment.

## Near-term hardening backlog

- Signed agent enrollment tokens.
- Job-level workspace cleanup verification.
- Docker or Podman execution policy checks.
- Backup download/restore runbook.
- GitHub App installation setup guide with screenshots.
- Reverse-proxy hardening beyond the current TLS edge, including rate limiting
  and explicit secure-cookie checks.
