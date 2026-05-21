import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  githubIntegrationStatus,
  isSelfHostedWorkflowJob,
  mapWorkflowJobStatus,
  processGitHubWebhook,
  verifyWebhookSignature,
  workflowJobToRecord,
  workflowJobToRunnerHeartbeat
} from "../apps/control-plane/github.mjs";

test("reports webhook-only GitHub observation mode as configured", () => {
  process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET = "test-secret";
  delete process.env.RUNNERLY_GITHUB_APP_ID;
  delete process.env.RUNNERLY_GITHUB_INSTALLATION_ID;
  delete process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY;
  delete process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE;

  const status = githubIntegrationStatus();

  assert.equal(status.configured, true);
  assert.equal(status.mode, "webhook");
  assert.equal(status.webhookSecretConfigured, true);
  assert.equal(status.privateKeyConfigured, false);
  assert.equal(status.runnerRegistrationScope, "org");

  delete process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET;
});

test("verifies GitHub webhook signatures when a secret is configured", () => {
  process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET = "test-secret";
  const body = Buffer.from(JSON.stringify({ action: "queued" }));
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;

  assert.equal(verifyWebhookSignature(body, signature), true);
  assert.equal(verifyWebhookSignature(body, "sha256=bad"), false);

  delete process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET;
});

test("maps workflow job states to Runnerly job states", () => {
  assert.equal(mapWorkflowJobStatus({ status: "queued" }), "queued");
  assert.equal(mapWorkflowJobStatus({ status: "in_progress" }), "running");
  assert.equal(mapWorkflowJobStatus({ status: "completed", conclusion: "success" }), "completed");
  assert.equal(mapWorkflowJobStatus({ status: "completed", conclusion: "failure" }), "failed");
  assert.equal(mapWorkflowJobStatus({ status: "completed", conclusion: "cancelled" }), "cancelled");
});

test("converts workflow_job payloads into job records", () => {
  const record = workflowJobToRecord(
    {
      id: 123,
      run_id: 456,
      runner_name: "Actions Runner Control Plane Host",
      workflow_name: "Security checks",
      status: "in_progress",
      labels: ["self-hosted", "ARM64"],
      started_at: "2026-05-18T01:00:00Z",
      html_url: "https://github.com/example-org/actions-runner-control-plane/actions/runs/456/job/123"
    },
    { id: "github:example-org:actions-runner-control-plane" }
  );

  assert.equal(record.id, "github-job:123");
  assert.equal(record.runnerId, "actions-runner-control-plane-host");
  assert.equal(record.status, "running");
  assert.deepEqual(record.labels, ["self-hosted", "ARM64"]);
});

test("keeps GitHub-hosted workflow jobs out of the self-hosted fleet", () => {
  const record = workflowJobToRecord(
    {
      id: 321,
      run_id: 654,
      runner_name: "GitHub Actions 1000063459",
      workflow_name: "Security Scan",
      status: "completed",
      conclusion: "success",
      labels: ["ubuntu-24.04"],
      completed_at: "2026-05-18T15:29:41Z"
    },
    { id: "github:example-org:infra-deployments" }
  );

  assert.equal(isSelfHostedWorkflowJob({ labels: ["ubuntu-24.04"] }), false);
  assert.equal(record.runnerId, null);
  assert.throws(
    () => workflowJobToRunnerHeartbeat(
      {
        runner_name: "GitHub Actions 1000063459",
        labels: ["ubuntu-24.04"]
      },
      { owner: "example-org", name: "infra-deployments" }
    ),
    /not running on a self-hosted runner/
  );
});

test("converts workflow_job payloads into external runner heartbeats", () => {
  const heartbeat = workflowJobToRunnerHeartbeat(
    {
      runner_name: "lab-heavy-runner-01",
      runner_group_name: "default",
      status: "completed",
      labels: ["self-hosted", "linux", "arm64"],
      completed_at: "2026-05-18T00:01:37Z"
    },
    { owner: "example-org", name: "infra-deployments" }
  );

  assert.equal(heartbeat.runnerId, "lab-heavy-runner-01");
  assert.equal(heartbeat.status, "online");
  assert.equal(heartbeat.metadata.githubRunner.external, true);
  assert.equal(heartbeat.metadata.githubRunner.repository, null);
  assert.deepEqual(heartbeat.metadata.githubRunner.repositories, []);
  assert.equal(heartbeat.metadata.githubRunner.observedRepository, "example-org/infra-deployments");
  assert.equal(heartbeat.metadata.githubRunner.busy, false);
});

test("accepts public self-hosted workflow events without adding fleet heartbeat", async () => {
  const events = [];
  const jobs = [];
  const repositories = [];
  const runners = [];

  const result = await processGitHubWebhook(
    {},
    "workflow_job",
    {
      action: "completed",
      repository: {
        owner: { login: "example-org" },
        name: "public-status",
        private: false
      },
      workflow_job: {
        id: 99,
        run_id: 100,
        runner_name: "lab-heavy-runner-01",
        workflow_name: "Public CI",
        status: "completed",
        conclusion: "success",
        labels: ["self-hosted", "linux", "arm64"],
        completed_at: "2026-05-19T01:00:00Z"
      }
    },
    {
      recordAuditEvent(_db, event) {
        events.push(event);
      },
      upsertRepository(_db, repository) {
        repositories.push(repository);
        return {
          id: `github:${repository.owner}:${repository.name}`,
          ...repository
        };
      },
      upsertJob(_db, job) {
        jobs.push(job);
        return { ...job, id: job.id };
      },
      upsertRunnerHeartbeat(_db, runner) {
        runners.push(runner);
        return runner;
      }
    }
  );

  assert.equal(result.accepted, true);
  assert.equal(repositories[0].visibility, "public");
  assert.equal(jobs[0].runnerId, "lab-heavy-runner-01");
  assert.equal(runners.length, 0);
  assert.equal(events.some((event) => event.action === "policy.public_self_hosted_observed"), true);
});

test("updates repository policy state from repository webhooks", async () => {
  const events = [];
  const repositories = [];

  const result = await processGitHubWebhook(
    {},
    "repository",
    {
      action: "privatized",
      repository: {
        owner: { login: "example-org" },
        name: "actions-runner-control-plane",
        private: true
      }
    },
    {
      recordAuditEvent(_db, event) {
        events.push(event);
      },
      upsertRepository(_db, repository) {
        repositories.push(repository);
        return {
          id: `github:${repository.owner}:${repository.name}`,
          ...repository
        };
      }
    }
  );

  assert.equal(result.accepted, true);
  assert.equal(repositories[0].visibility, "private");
  assert.equal(events[0].action, "github.repository.privatized");
});
