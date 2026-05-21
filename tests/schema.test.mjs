import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLabels,
  summarizeChecks,
  validateJobRecord,
  validateRepositoryRecord,
  validateRunnerHeartbeat
} from "../packages/shared/schema.mjs";

test("normalizes labels deterministically", () => {
  assert.deepEqual(normalizeLabels(["ARM64", "linux", "arm64", "  lab-host  "]), [
    "arm64",
    "lab-host",
    "linux"
  ]);
});

test("validates runner heartbeat payloads", () => {
  const heartbeat = validateRunnerHeartbeat({
    runnerId: "actions-runner-control-plane-host",
    runnerName: "Actions Runner Control Plane Host",
    hostname: "actions-runner-control-plane-host",
    labels: ["linux", "arm64"],
    status: "online",
    observedAt: "2026-05-17T20:00:00.000Z",
    metadata: { region: "region-1" }
  });

  assert.equal(heartbeat.runnerId, "actions-runner-control-plane-host");
  assert.equal(heartbeat.observedAt, "2026-05-17T20:00:00.000Z");
});

test("summarizes health checks", () => {
  assert.deepEqual(
    summarizeChecks([
      { status: "ok" },
      { status: "ok" },
      { status: "degraded" },
      { status: "failed" },
      { status: "weird" }
    ]),
    { ok: 2, degraded: 1, failed: 1, unknown: 1 }
  );
});

test("validates repository and job records", () => {
  const repository = validateRepositoryRecord({
    owner: "example-org",
    name: "actions-runner-control-plane",
    visibility: "private",
    allowedLabels: ["ARM64", "arm64-lab"]
  });
  assert.deepEqual(repository.allowedLabels, ["arm64", "arm64-lab"]);

  const job = validateJobRecord({
    id: "github-job:1",
    repositoryId: "github:example-org:actions-runner-control-plane",
    workflow: "CI",
    status: "queued",
    labels: ["Linux"],
    queuedAt: "2026-05-18T19:00:00.000Z",
    pickedUpAt: "2026-05-18T19:01:00.000Z",
    conclusion: "success",
    url: "https://github.com/example-org/actions-runner-control-plane/actions"
  });
  assert.equal(job.status, "queued");
  assert.deepEqual(job.labels, ["linux"]);
  assert.equal(job.queuedAt, "2026-05-18T19:00:00.000Z");
  assert.equal(job.pickedUpAt, "2026-05-18T19:01:00.000Z");
  assert.equal(job.conclusion, "success");
});
