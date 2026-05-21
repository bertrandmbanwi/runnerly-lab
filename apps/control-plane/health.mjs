const DEFAULT_THRESHOLDS = {
  runnerStaleSeconds: 180,
  runnerHeartbeatStaleSeconds: 90,
  reconcileStaleSeconds: 900
};

export function buildControlPlaneHealth({
  overview,
  github,
  reconcile,
  runnerHeartbeat,
  webhookHealth,
  now = new Date(),
  thresholds = {}
} = {}) {
  const effectiveThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...thresholds
  };
  const alerts = [];
  const runners = overview?.runners ?? [];
  const repositories = overview?.repositories ?? [];

  for (const runner of runners) {
    const ageSeconds = ageInSeconds(runner.lastSeenAt, now);
    if (runner.status !== "online") {
      alerts.push({
        severity: "critical",
        kind: "runner-offline",
        target: runner.name,
        message: `${runner.name} is ${runner.status ?? "not online"}`,
        observedAt: runner.lastSeenAt ?? null
      });
      continue;
    }

    if (ageSeconds !== null && ageSeconds > effectiveThresholds.runnerStaleSeconds) {
      alerts.push({
        severity: "warning",
        kind: "runner-stale",
        target: runner.name,
        message: `${runner.name} has not checked in for ${formatAge(ageSeconds)}`,
        observedAt: runner.lastSeenAt
      });
    }
  }

  if (runnerHeartbeat?.failed) {
    alerts.push({
      severity: "critical",
      kind: "runner-heartbeat-failed",
      target: "github-runners",
      message: runnerHeartbeat.message ?? "GitHub runner heartbeat failed",
      observedAt: runnerHeartbeat.generatedAt ?? null
    });
  } else if (github?.mode === "management") {
    const heartbeatAge = ageInSeconds(runnerHeartbeat?.generatedAt, now);
    if (heartbeatAge === null) {
      alerts.push({
        severity: "warning",
        kind: "runner-heartbeat-missing",
        target: "github-runners",
        message: "GitHub runner heartbeat has not run yet",
        observedAt: null
      });
    } else if (heartbeatAge > effectiveThresholds.runnerHeartbeatStaleSeconds) {
      alerts.push({
        severity: "warning",
        kind: "runner-heartbeat-stale",
        target: "github-runners",
        message: `GitHub runner heartbeat is ${formatAge(heartbeatAge)} old`,
        observedAt: runnerHeartbeat.generatedAt
      });
    }
  }

  if (reconcile?.failed) {
    alerts.push({
      severity: "critical",
      kind: "reconcile-failed",
      target: "github",
      message: reconcile.message ?? "Full GitHub reconcile failed",
      observedAt: reconcile.generatedAt ?? null
    });
  } else if (github?.mode === "management") {
    const reconcileAge = ageInSeconds(reconcile?.generatedAt, now);
    if (reconcileAge === null) {
      alerts.push({
        severity: "warning",
        kind: "reconcile-missing",
        target: "github",
        message: "Full GitHub reconcile has not run yet",
        observedAt: null
      });
    } else if (reconcileAge > effectiveThresholds.reconcileStaleSeconds) {
      alerts.push({
        severity: "warning",
        kind: "reconcile-stale",
        target: "github",
        message: `Full GitHub reconcile is ${formatAge(reconcileAge)} old`,
        observedAt: reconcile.generatedAt
      });
    }
  }

  if (webhookHealth?.failed) {
    alerts.push({
      severity: "critical",
      kind: "webhook-failed",
      target: "github-webhook",
      message: webhookHealth.message ?? webhookHealth.reason ?? "GitHub webhook delivery failed",
      observedAt: webhookHealth.generatedAt ?? null
    });
  }

  const publicRepositoryCount = repositories.filter((repository) => repository.visibility === "public").length;
  if (publicRepositoryCount > 0) {
    alerts.push({
      severity: "notice",
      kind: "hosted-minutes-guardrail",
      target: "public-repositories",
      message: `${publicRepositoryCount} public repositories are webhook-only and should stay on GitHub-hosted runners`,
      observedAt: overview?.generatedAt ?? null
    });
  }

  return {
    generatedAt: now.toISOString(),
    status: summarizeStatus(alerts),
    alerts
  };
}

function summarizeStatus(alerts) {
  if (alerts.some((alert) => alert.severity === "critical")) {
    return "critical";
  }
  if (alerts.some((alert) => alert.severity === "warning")) {
    return "warning";
  }
  return "ok";
}

function ageInSeconds(timestamp, now) {
  if (!timestamp) {
    return null;
  }
  const observed = new Date(timestamp);
  if (Number.isNaN(observed.getTime())) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - observed.getTime()) / 1000));
}

function formatAge(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h`;
}
