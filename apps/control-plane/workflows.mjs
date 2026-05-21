import { normalizeLabels } from "../../packages/shared/schema.mjs";
import { classifyRunnerLabels, targetRunsOnForWorkflow } from "./policy.mjs";

const githubHostedPrefixes = ["ubuntu-", "windows-", "macos-"];

export function buildWorkflowInventory({ repositories, jobs }) {
  const publicRepositoryCount = repositories.filter((repo) => repo.visibility === "public").length;
  const privateRepositories = repositories.filter((repo) => repo.visibility !== "public");
  const jobsByRepository = groupJobsByRepository(jobs);
  const repositoriesWithWorkflows = privateRepositories.map((repository) => {
    const repositoryName = `${repository.owner}/${repository.name}`;
    const repositoryJobs = jobsByRepository.get(repositoryName) ?? [];
    const workflows = latestJobsByWorkflow(repositoryJobs).map((job) => workflowFromJob(job));

    return {
      repository: repositoryName,
      visibility: repository.visibility,
      requiredLabels: repository.allowedLabels ?? [],
      workflowCount: workflows.length,
      candidateCount: workflows.filter((workflow) => workflow.recommendation.kind === "candidate").length,
      workflows
    };
  });

  const flattened = repositoriesWithWorkflows.flatMap((repo) => repo.workflows);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      privateRepositoryCount: privateRepositories.length,
      publicRepositoryCount,
      observedWorkflowCount: flattened.length,
      candidateCount: flattened.filter((workflow) => workflow.recommendation.kind === "candidate").length,
      selfHostedWorkflowCount: flattened.filter((workflow) => workflow.runner.type === "self-hosted").length,
      waitingRepositoryCount: repositoriesWithWorkflows.filter((repo) => repo.workflowCount === 0).length
    },
    repositories: repositoriesWithWorkflows
  };
}

function groupJobsByRepository(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (!job.repository) {
      continue;
    }

    const existing = groups.get(job.repository) ?? [];
    existing.push(job);
    groups.set(job.repository, existing);
  }
  return groups;
}

function latestJobsByWorkflow(jobs) {
  const latest = new Map();
  for (const job of jobs) {
    const key = job.workflow || "GitHub workflow";
    const existing = latest.get(key);
    if (!existing || jobTimestamp(job) > jobTimestamp(existing)) {
      latest.set(key, job);
    }
  }
  return [...latest.values()].sort((a, b) => jobTimestamp(b) - jobTimestamp(a));
}

function workflowFromJob(job) {
  const labels = normalizeLabels(job.labels ?? []);
  const runner = runnerClass(job, labels);
  const targetRunsOn = targetRunsOnForWorkflow({ labels, workflow: job.workflow });
  return {
    workflow: job.workflow,
    repository: job.repository,
    status: job.status,
    labels,
    runner,
    latestJob: {
      id: job.id,
      status: job.status,
      url: job.url,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    },
    recommendation: recommendationFor({ labels, runner, targetRunsOn })
  };
}

function runnerClass(job, labels) {
  const classification = classifyRunnerLabels(labels);
  if (classification.type === "self-hosted") {
    return {
      type: "self-hosted",
      name: job.runnerId ?? "self-hosted",
      detail: labels.length ? labels.join(", ") : "self-hosted",
      lane: classification.lane,
      broad: classification.broad
    };
  }

  const hostedLabel = labels.find((label) => githubHostedPrefixes.some((prefix) => label.startsWith(prefix)));
  if (hostedLabel) {
    return {
      type: "github-hosted",
      name: hostedLabel,
      detail: labels.join(", ")
    };
  }

  return {
    type: "unknown",
    name: "unknown",
    detail: labels.length ? labels.join(", ") : "No runner labels observed"
  };
}

function recommendationFor({ labels, runner, targetRunsOn }) {
  if (runner.type === "self-hosted") {
    if (runner.broad) {
      return {
        kind: "warning",
        label: "Class missing",
        detail: "Self-hosted workflow is missing scanner, heavy-build, build-worker, or utility labels.",
        targetRunsOn
      };
    }

    const expectedPlatform = labels.includes("linux") && (labels.includes("arm64") || labels.includes("x64"));
    return {
      kind: expectedPlatform ? "keep" : "review",
      label: expectedPlatform ? "Classed runner" : "Review labels",
      detail: expectedPlatform
        ? `Private workflow is using the ${runner.lane} runner lane.`
        : "Self-hosted workflow is missing one of the expected linux/arch labels.",
      targetRunsOn
    };
  }

  if (runner.type === "github-hosted" && labels.some((label) => label.startsWith("ubuntu-"))) {
    return {
      kind: "candidate",
      label: "Candidate",
      detail: `Private Linux workflow can move to the ${laneName(targetRunsOn)} lane after dependency and secret checks.`,
      targetRunsOn
    };
  }

  if (runner.type === "github-hosted") {
    return {
      kind: "keep",
      label: "Keep hosted",
      detail: "Workflow appears to require a GitHub-hosted OS image that the ARM64 fleet does not provide.",
      targetRunsOn: null
    };
  }

  return {
    kind: "observe",
    label: "Observe",
    detail: "Waiting for workflow_job labels before recommending a migration.",
    targetRunsOn
  };
}

function laneName(targetRunsOn) {
  const lane = String(targetRunsOn).match(/,\s*([^,\]]+)\]$/)?.[1] ?? "build-worker";
  return lane.replaceAll("-", " ");
}

function jobTimestamp(job) {
  return Date.parse(job.updatedAt ?? job.completedAt ?? job.startedAt ?? 0) || 0;
}
