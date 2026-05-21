import test from "node:test";
import assert from "node:assert/strict";
import { githubRunnerToHeartbeat } from "../apps/control-plane/reconcile.mjs";

test("maps org-level GitHub runners into fleet heartbeats", () => {
  const heartbeat = githubRunnerToHeartbeat(
    {
      id: 67,
      name: "lab-build-runner-01",
      os: "linux",
      status: "online",
      busy: false,
      runner_group_name: "default",
      labels: [
        { name: "self-hosted" },
        { name: "linux" },
        { name: "arm64" },
        { name: "build-worker" }
      ]
    },
    { owner: "example-org" }
  );

  assert.equal(heartbeat.runnerId, "lab-build-runner-01");
  assert.equal(heartbeat.status, "online");
  assert.deepEqual(heartbeat.labels, ["self-hosted", "linux", "arm64", "build-worker"]);
  assert.equal(heartbeat.metadata.githubRunner.scope, "org");
  assert.equal(heartbeat.metadata.githubRunner.owner, "example-org");
  assert.equal(heartbeat.metadata.githubRunner.githubRunnerId, "67");
  assert.deepEqual(heartbeat.metadata.githubRunner.repositories, []);
  assert.equal(heartbeat.metadata.checks.at(1).detail, "idle");
});
