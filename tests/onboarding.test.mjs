import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryOnboarding } from "../apps/control-plane/onboarding.mjs";

test("summarizes repository runner and webhook readiness", () => {
  const [repo] = buildRepositoryOnboarding({
    repositories: [
      {
        owner: "example-org",
        name: "actions-runner-control-plane",
        visibility: "private",
        allowedLabels: ["linux", "arm64", "managed"]
      }
    ],
    runners: [
      {
        id: "runnerly-managed-01",
        name: "runnerly-managed-01",
        labels: ["Linux", "ARM64", "managed", "example-org"],
        status: "online",
        lastSeenAt: "2026-05-18T01:00:00.000Z"
      }
    ],
    jobs: [
      {
        repository: "example-org/actions-runner-control-plane",
        status: "completed",
        updatedAt: "2026-05-18T01:10:00.000Z"
      }
    ],
    auditEvents: [
      {
        action: "github.workflow_job.completed",
        target: "github-job:1",
        payload: { repository: "example-org/actions-runner-control-plane", status: "completed" },
        createdAt: "2026-05-18T01:10:00.000Z"
      }
    ],
    github: { mode: "webhook", webhookSecretConfigured: true }
  });

  assert.equal(repo.runnerStatus, "ready");
  assert.equal(repo.webhookStatus, "receiving");
  assert.equal(repo.registrationMode, "manual-token");
  assert.match(repo.installCommand, /GITHUB_RUNNER_TOKEN='<paste GitHub registration token>'/);
  assert.equal(repo.workflowSnippet, "jobs:\n  validate:\n    runs-on: [self-hosted, Linux, ARM64, managed]");
});

test("uses GitHub App registration tokens when management mode is configured", () => {
  const [repo] = buildRepositoryOnboarding({
    repositories: [
      {
        owner: "example-org",
        name: "infra-deployments",
        visibility: "private",
        allowedLabels: ["linux", "arm64", "example-org"]
      }
    ],
    runners: [],
    jobs: [],
    auditEvents: [],
    github: { mode: "management", webhookSecretConfigured: true, runnerRegistrationScope: "org" }
  });

  assert.equal(repo.runnerStatus, "missing");
  assert.equal(repo.webhookStatus, "waiting");
  assert.equal(repo.registrationMode, "app-token");
  assert.equal(repo.registrationScope, "org");
  assert.match(repo.installCommand, /GITHUB_RUNNER_SCOPE=org/);
  assert.match(repo.installCommand, /RUNNERLY_AGENT_TOKEN=/);
  assert.doesNotMatch(repo.installCommand, /GITHUB_REPO/);
  assert.doesNotMatch(repo.installCommand, /GITHUB_RUNNER_TOKEN/);
});

test("treats org-scoped runners as repository coverage", () => {
  const [repo] = buildRepositoryOnboarding({
    repositories: [
      {
        owner: "example-org",
        name: "infra-deployments",
        visibility: "private",
        allowedLabels: ["linux", "arm64"]
      }
    ],
    runners: [
      {
        id: "actions-runner-control-plane-host",
        name: "actions-runner-control-plane-host",
        labels: ["self-hosted", "linux", "arm64"],
        status: "online",
        lastSeenAt: "2026-05-18T01:00:00.000Z",
        metadata: {
          githubRunner: {
            scope: "org",
            owner: "example-org"
          }
        }
      }
    ],
    jobs: [],
    auditEvents: [],
    github: { mode: "management", webhookSecretConfigured: true, runnerRegistrationScope: "org" }
  });

  assert.equal(repo.runnerStatus, "ready");
  assert.equal(repo.onlineRunnerCount, 1);
});

test("does not treat a different repo-scoped runner as repository coverage", () => {
  const [repo] = buildRepositoryOnboarding({
    repositories: [
      {
        owner: "example-org",
        name: "infra-deployments",
        visibility: "private",
        allowedLabels: ["linux", "arm64", "example-org"]
      }
    ],
    runners: [
      {
        id: "runnerly-managed-01",
        name: "runnerly-managed-01",
        labels: ["Linux", "ARM64", "example-org"],
        status: "online",
        metadata: {
          githubRunner: {
            repositories: ["example-org/actions-runner-control-plane"]
          }
        }
      }
    ],
    jobs: [],
    auditEvents: [],
    github: { mode: "webhook", webhookSecretConfigured: true }
  });

  assert.equal(repo.runnerStatus, "missing");
  assert.equal(repo.onlineRunnerCount, 0);
});
