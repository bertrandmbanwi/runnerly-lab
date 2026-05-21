import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowInventory } from "../apps/control-plane/workflows.mjs";

test("builds private workflow migration recommendations and excludes public repos", () => {
  const inventory = buildWorkflowInventory({
    repositories: [
      {
        owner: "example-org",
        name: "runnerly-lab",
        visibility: "private",
        allowedLabels: ["linux", "arm64"]
      },
      {
        owner: "example-org",
        name: "public-status",
        visibility: "public",
        allowedLabels: ["linux", "arm64"]
      }
    ],
    jobs: [
      {
        id: "github-job:1",
        repository: "example-org/runnerly-lab",
        workflow: "CI",
        status: "completed",
        labels: ["ubuntu-latest"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      },
      {
        id: "github-job:2",
        repository: "example-org/public-status",
        workflow: "Deploy",
        status: "completed",
        labels: ["ubuntu-latest"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      }
    ]
  });

  assert.equal(inventory.summary.privateRepositoryCount, 1);
  assert.equal(inventory.summary.publicRepositoryCount, 1);
  assert.equal(inventory.summary.candidateCount, 1);
  assert.deepEqual(inventory.repositories.map((repo) => repo.repository), ["example-org/runnerly-lab"]);
  assert.equal(inventory.repositories[0].workflows[0].recommendation.kind, "candidate");
  assert.equal(inventory.repositories[0].workflows[0].recommendation.targetRunsOn, "[self-hosted, linux, arm64, build-worker]");
});

test("flags broad self-hosted workflows that are missing a runner class", () => {
  const inventory = buildWorkflowInventory({
    repositories: [
      {
        owner: "example-org",
        name: "infra-deployments",
        visibility: "private",
        allowedLabels: ["linux", "arm64"]
      }
    ],
    jobs: [
      {
        id: "github-job:1",
        repository: "example-org/infra-deployments",
        workflow: "Drift Detection",
        status: "completed",
        runnerId: "runnerly-lab-host",
        labels: ["self-hosted", "linux", "arm64"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      }
    ]
  });

  assert.equal(inventory.summary.selfHostedWorkflowCount, 1);
  assert.equal(inventory.repositories[0].workflows[0].recommendation.kind, "warning");
  assert.equal(inventory.repositories[0].workflows[0].recommendation.label, "Class missing");
  assert.equal(inventory.repositories[0].workflows[0].recommendation.targetRunsOn, "[self-hosted, linux, x64, micro, utility]");
});

test("keeps private workflows already on classed self-hosted runners", () => {
  const inventory = buildWorkflowInventory({
    repositories: [
      {
        owner: "example-org",
        name: "infra-deployments",
        visibility: "private",
        allowedLabels: ["linux", "x64", "micro", "utility"]
      }
    ],
    jobs: [
      {
        id: "github-job:1",
        repository: "example-org/infra-deployments",
        workflow: "Drift Detection",
        status: "completed",
        runnerId: "example-org-runner-micro-01",
        labels: ["self-hosted", "linux", "x64", "micro", "utility"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      }
    ]
  });

  assert.equal(inventory.summary.selfHostedWorkflowCount, 1);
  assert.equal(inventory.repositories[0].workflows[0].recommendation.kind, "keep");
  assert.equal(inventory.repositories[0].workflows[0].recommendation.label, "Classed runner");
});

test("routes security workflows to the scanner lane", () => {
  const inventory = buildWorkflowInventory({
    repositories: [
      {
        owner: "example-org",
        name: "security-scanner",
        visibility: "private",
        allowedLabels: ["linux", "arm64", "scanner"]
      }
    ],
    jobs: [
      {
        id: "github-job:1",
        repository: "example-org/security-scanner",
        workflow: "Security Scan",
        status: "completed",
        labels: ["ubuntu-24.04"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      }
    ]
  });

  assert.equal(inventory.repositories[0].workflows[0].recommendation.kind, "candidate");
  assert.equal(inventory.repositories[0].workflows[0].recommendation.targetRunsOn, "[self-hosted, linux, arm64, scanner]");
});
