import test from "node:test";
import assert from "node:assert/strict";
import { buildRunnerPolicyReport, classifyRunnerLabels, targetRunsOnForWorkflow } from "../apps/control-plane/policy.mjs";

test("classifies explicit runner lanes and broad self-hosted labels", () => {
  assert.deepEqual(classifyRunnerLabels(["self-hosted", "linux", "arm64", "build-worker"]), {
    type: "self-hosted",
    lane: "build-worker",
    broad: false
  });
  assert.deepEqual(classifyRunnerLabels(["self-hosted", "linux", "arm64"]), {
    type: "self-hosted",
    lane: "broad",
    broad: true
  });
});

test("routes utility workflows to the x64 micro runner lane", () => {
  assert.equal(
    targetRunsOnForWorkflow({ labels: ["self-hosted", "linux", "arm64"], workflow: "Drift Detection" }),
    "[self-hosted, linux, x64, micro, utility]"
  );
});

test("builds policy report for public guardrails and broad self-hosted findings", () => {
  const report = buildRunnerPolicyReport({
    runnerGroups: {
      runner_groups: [
        {
          id: 1,
          name: "Default",
          visibility: "all",
          allows_public_repositories: false
        }
      ]
    },
    repositories: [
      {
        owner: "example-org",
        name: "actions-runner-control-plane",
        visibility: "private",
        allowedLabels: ["linux", "arm64", "build-worker"]
      },
      {
        owner: "example-org",
        name: "public-status",
        visibility: "public",
        allowedLabels: ["github-hosted"]
      }
    ],
    jobs: [
      {
        repository: "example-org/actions-runner-control-plane",
        workflow: "CI",
        labels: ["self-hosted", "linux", "arm64"],
        updatedAt: "2026-05-19T01:00:00.000Z"
      }
    ]
  });

  assert.equal(report.summary.runnerGroupPublicAccessCount, 0);
  assert.equal(report.summary.broadSelfHostedWorkflowCount, 1);
  assert.equal(report.summary.warningCount, 1);
  assert.equal(report.summary.violationCount, 0);
  assert.equal(report.repositoryPolicies.find((policy) => policy.repository === "example-org/public-status").selfHostedAllowed, false);
});
