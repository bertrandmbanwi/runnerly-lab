import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlaneHealth } from "../apps/control-plane/health.mjs";

test("reports healthy control plane with public repository budget notice", () => {
  const health = buildControlPlaneHealth({
    now: new Date("2026-05-20T02:00:00.000Z"),
    github: { mode: "management" },
    reconcile: { generatedAt: "2026-05-20T01:58:00.000Z" },
    runnerHeartbeat: { generatedAt: "2026-05-20T01:59:45.000Z" },
    overview: {
      generatedAt: "2026-05-20T02:00:00.000Z",
      runners: [
        {
          name: "lab-heavy-runner-01",
          status: "online",
          lastSeenAt: "2026-05-20T01:59:45.000Z"
        }
      ],
      repositories: [
        { owner: "example-org", name: "public-status", visibility: "public" },
        { owner: "example-org", name: "runnerly-lab", visibility: "private" }
      ]
    }
  });

  assert.equal(health.status, "ok");
  assert.equal(health.alerts.length, 1);
  assert.equal(health.alerts[0].kind, "hosted-minutes-guardrail");
});

test("raises critical alerts for failed webhook and stale runner", () => {
  const health = buildControlPlaneHealth({
    now: new Date("2026-05-20T02:00:00.000Z"),
    github: { mode: "management" },
    reconcile: { generatedAt: "2026-05-20T01:58:00.000Z" },
    runnerHeartbeat: { generatedAt: "2026-05-20T01:59:45.000Z" },
    webhookHealth: {
      failed: true,
      message: "GitHub webhook signature verification failed",
      generatedAt: "2026-05-20T01:59:00.000Z"
    },
    overview: {
      generatedAt: "2026-05-20T02:00:00.000Z",
      runners: [
        {
          name: "lab-heavy-runner-01",
          status: "online",
          lastSeenAt: "2026-05-20T01:54:00.000Z"
        }
      ],
      repositories: []
    }
  });

  assert.equal(health.status, "critical");
  assert.equal(health.alerts.some((alert) => alert.kind === "runner-stale"), true);
  assert.equal(health.alerts.some((alert) => alert.kind === "webhook-failed"), true);
});
