export const RUNNER_STATUSES = new Set(["online", "offline", "degraded"]);
export const JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
export const REPOSITORY_VISIBILITIES = new Set(["public", "private", "internal"]);

export function validateRunnerHeartbeat(payload) {
  assertObject(payload, "heartbeat");

  const runnerId = requiredString(payload.runnerId, "runnerId");
  const runnerName = requiredString(payload.runnerName, "runnerName");
  const hostname = requiredString(payload.hostname, "hostname");
  const labels = normalizeLabels(payload.labels);
  const status = payload.status ?? "online";

  if (!RUNNER_STATUSES.has(status)) {
    throw new TypeError(`status must be one of: ${[...RUNNER_STATUSES].join(", ")}`);
  }

  return {
    runnerId,
    runnerName,
    hostname,
    labels,
    status,
    version: optionalString(payload.version),
    observedAt: optionalIsoDate(payload.observedAt),
    metadata: normalizeMetadata(payload.metadata)
  };
}

export function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    throw new TypeError("labels must be an array");
  }

  const normalized = labels
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized)].sort();
}

export function validateRepositoryRecord(payload) {
  assertObject(payload, "repository");

  const provider = requiredString(payload.provider ?? "github", "provider");
  const owner = requiredString(payload.owner, "owner");
  const name = requiredString(payload.name, "name");
  const visibility = payload.visibility ?? "private";

  if (!REPOSITORY_VISIBILITIES.has(visibility)) {
    throw new TypeError(`visibility must be one of: ${[...REPOSITORY_VISIBILITIES].join(", ")}`);
  }

  return {
    id: optionalString(payload.id),
    provider,
    owner,
    name,
    visibility,
    allowedLabels: normalizeLabels(payload.allowedLabels ?? ["self-hosted"])
  };
}

export function validateJobRecord(payload) {
  assertObject(payload, "job");

  const status = payload.status ?? "queued";
  if (!JOB_STATUSES.has(status)) {
    throw new TypeError(`job status must be one of: ${[...JOB_STATUSES].join(", ")}`);
  }

  return {
    id: requiredString(payload.id, "id"),
    repositoryId: optionalString(payload.repositoryId),
    runnerId: optionalString(payload.runnerId),
    githubRunId: optionalString(payload.githubRunId),
    githubJobId: optionalString(payload.githubJobId),
    workflow: requiredString(payload.workflow, "workflow"),
    status,
    labels: normalizeLabels(payload.labels ?? []),
    queuedAt: optionalIsoDate(payload.queuedAt),
    pickedUpAt: optionalIsoDate(payload.pickedUpAt),
    startedAt: optionalIsoDate(payload.startedAt),
    completedAt: optionalIsoDate(payload.completedAt),
    conclusion: optionalString(payload.conclusion),
    url: optionalUrl(payload.url)
  };
}

export function summarizeChecks(checks = []) {
  const totals = {
    ok: 0,
    degraded: 0,
    failed: 0,
    unknown: 0
  };

  for (const check of checks) {
    const status = check?.status;
    if (status in totals) {
      totals[status] += 1;
    } else {
      totals.unknown += 1;
    }
  }

  return totals;
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) {
    return {};
  }

  assertObject(metadata, "metadata");
  return metadata;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }

  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }

  return value.trim();
}

function optionalIsoDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO date string");
  }

  return new Date(value).toISOString();
}

function optionalUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new TypeError("url must be a string");
  }

  try {
    return new URL(value).toString();
  } catch {
    throw new TypeError("url must be a valid URL");
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}
