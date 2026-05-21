import { normalizeLabels } from "../../packages/shared/schema.mjs";

const runnerClassLabels = ["scanner", "heavy-build", "build-worker", "utility", "micro"];

export function buildRunnerPolicyReport({ repositories, jobs, runnerGroups = null }) {
  const repositoryByName = new Map(repositories.map((repository) => [
    `${repository.owner}/${repository.name}`,
    repository
  ]));
  const repositoryPolicies = repositories.map((repository) => repositoryPolicy(repository, jobs));
  const workflowFindings = workflowPolicyFindings(jobs, repositoryByName);
  const runnerGroupPolicies = runnerGroupPolicy(runnerGroups?.runner_groups ?? runnerGroups?.runnerGroups ?? []);
  const violations = [
    ...repositoryPolicies.filter((policy) => policy.status === "violation"),
    ...workflowFindings.filter((finding) => finding.severity === "violation"),
    ...runnerGroupPolicies.filter((policy) => policy.status === "violation")
  ];
  const warnings = [
    ...repositoryPolicies.filter((policy) => policy.status === "warning"),
    ...workflowFindings.filter((finding) => finding.severity === "warning"),
    ...runnerGroupPolicies.filter((policy) => policy.status === "warning")
  ];

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      repositoryPolicyCount: repositoryPolicies.length,
      publicRepositoryCount: repositoryPolicies.filter((policy) => policy.visibility === "public").length,
      publicSelfHostedAllowedCount: repositoryPolicies.filter((policy) => policy.visibility === "public" && policy.selfHostedAllowed).length,
      runnerGroupCount: runnerGroupPolicies.length,
      runnerGroupPublicAccessCount: runnerGroupPolicies.filter((policy) => policy.allowsPublicRepositories).length,
      broadSelfHostedWorkflowCount: workflowFindings.filter((finding) => finding.kind === "broad-self-hosted").length,
      publicSelfHostedWorkflowCount: workflowFindings.filter((finding) => finding.kind === "public-self-hosted").length,
      violationCount: violations.length,
      warningCount: warnings.length
    },
    repositoryPolicies,
    runnerGroupPolicies,
    workflowFindings
  };
}

export function classifyRunnerLabels(labels = []) {
  const normalized = normalizeLabels(labels);
  const labelSet = new Set(normalized);

  if (!labelSet.has("self-hosted")) {
    return {
      type: "github-hosted",
      lane: githubHostedLane(normalized),
      broad: false
    };
  }

  if (labelSet.has("scanner")) {
    return { type: "self-hosted", lane: "scanner", broad: false };
  }

  if (labelSet.has("heavy-build")) {
    return { type: "self-hosted", lane: "heavy-build", broad: false };
  }

  if (labelSet.has("build-worker")) {
    return { type: "self-hosted", lane: "build-worker", broad: false };
  }

  if (labelSet.has("micro") || labelSet.has("utility")) {
    return { type: "self-hosted", lane: "utility", broad: false };
  }

  return {
    type: "self-hosted",
    lane: "broad",
    broad: true
  };
}

export function targetRunsOnForWorkflow({ labels = [], workflow = "" }) {
  const labelSet = new Set(normalizeLabels(labels));
  const workflowName = String(workflow ?? "").toLowerCase();
  const lane = runnerLaneFor({ labelSet, workflowName });
  const arch = lane === "utility" ? "x64" : "arm64";
  const runsOn = lane === "utility"
    ? ["self-hosted", "linux", arch, "micro", "utility"]
    : ["self-hosted", "linux", arch, lane];
  return `[${runsOn.join(", ")}]`;
}

function repositoryPolicy(repository, jobs) {
  const repositoryName = `${repository.owner}/${repository.name}`;
  const labels = normalizeLabels(repository.allowedLabels ?? []);
  const classLabels = labels.filter((label) => runnerClassLabels.includes(label));
  const selfHostedAllowed = repository.visibility !== "public" && !labels.includes("github-hosted");
  const selfHostedJobs = jobs.filter((job) => (
    job.repository === repositoryName &&
    classifyRunnerLabels(job.labels).type === "self-hosted"
  ));

  if (repository.visibility === "public") {
    return {
      repository: repositoryName,
      visibility: repository.visibility,
      allowedLabels: labels,
      selfHostedAllowed: false,
      status: selfHostedJobs.length ? "violation" : "ready",
      detail: selfHostedJobs.length
        ? "Public repository has observed self-hosted workflow jobs."
        : "Public repository can send webhooks but is not eligible for self-hosted runner routing."
    };
  }

  if (!classLabels.length) {
    return {
      repository: repositoryName,
      visibility: repository.visibility,
      allowedLabels: labels,
      selfHostedAllowed,
      status: "ready",
      detail: "Private repository accepts workflow-specific runner lanes; workflow evidence enforces class labels."
    };
  }

  return {
    repository: repositoryName,
    visibility: repository.visibility,
    allowedLabels: labels,
    selfHostedAllowed,
    status: "ready",
    detail: `Private repository is routed to ${classLabels.join(", ")}.`
  };
}

function workflowPolicyFindings(jobs, repositoryByName) {
  const latest = latestJobsByWorkflow(jobs);
  const findings = [];

  for (const job of latest) {
    const repository = repositoryByName.get(job.repository);
    const runner = classifyRunnerLabels(job.labels);

    if (repository?.visibility === "public" && runner.type === "self-hosted") {
      findings.push({
        kind: "public-self-hosted",
        severity: "violation",
        repository: job.repository,
        workflow: job.workflow,
        labels: normalizeLabels(job.labels ?? []),
        targetRunsOn: null,
        detail: "Public repository workflow used self-hosted runner labels."
      });
      continue;
    }

    if (runner.broad) {
      findings.push({
        kind: "broad-self-hosted",
        severity: "warning",
        repository: job.repository,
        workflow: job.workflow,
        labels: normalizeLabels(job.labels ?? []),
        targetRunsOn: targetRunsOnForWorkflow({ labels: job.labels, workflow: job.workflow }),
        detail: "Self-hosted workflow is missing a specific runner class label."
      });
    }
  }

  return findings.sort((a, b) => `${a.repository}:${a.workflow}`.localeCompare(`${b.repository}:${b.workflow}`));
}

function runnerGroupPolicy(runnerGroups) {
  return runnerGroups.map((group) => {
    const allowsPublicRepositories = Boolean(group.allows_public_repositories ?? group.allowsPublicRepositories);
    const visibility = group.visibility ?? "unknown";
    const status = allowsPublicRepositories
      ? "violation"
      : visibility === "private" || visibility === "selected" || visibility === "all"
        ? "ready"
        : "warning";

    return {
      id: group.id,
      name: group.name,
      visibility,
      allowsPublicRepositories,
      restrictedToWorkflows: Boolean(group.restricted_to_workflows ?? group.restrictedToWorkflows),
      status,
      detail: allowsPublicRepositories
        ? "Runner group allows public repositories to use self-hosted runners."
        : "Runner group blocks public repositories from self-hosted runner access."
    };
  });
}

function latestJobsByWorkflow(jobs) {
  const latest = new Map();
  for (const job of jobs) {
    if (!job.repository) {
      continue;
    }
    const key = `${job.repository}:${job.workflow || "GitHub workflow"}`;
    const existing = latest.get(key);
    if (!existing || jobTimestamp(job) > jobTimestamp(existing)) {
      latest.set(key, job);
    }
  }
  return [...latest.values()];
}

function runnerLaneFor({ labelSet, workflowName }) {
  if (
    labelSet.has("scanner") ||
    labelSet.has("codeql") ||
    /\b(secret|security|scan|scanner|codeql|dependency|semgrep|gitleaks|trufflehog)\b/.test(workflowName)
  ) {
    return "scanner";
  }

  if (
    labelSet.has("heavy-build") ||
    labelSet.has("docker") ||
    /\b(docker|image|e2e|browser|playwright|deploy|release)\b/.test(workflowName)
  ) {
    return "heavy-build";
  }

  if (
    labelSet.has("micro") ||
    labelSet.has("utility") ||
    /\b(notify|notification|reminder|sync|plan|drift|access review|dashboard|protect|maintenance)\b/.test(workflowName)
  ) {
    return "utility";
  }

  return "build-worker";
}

function githubHostedLane(labels) {
  return labels.find((label) => (
    label.startsWith("ubuntu-") ||
    label.startsWith("windows-") ||
    label.startsWith("macos-")
  )) ?? "hosted";
}

function jobTimestamp(job) {
  return Date.parse(job.updatedAt ?? job.completedAt ?? job.startedAt ?? 0) || 0;
}
