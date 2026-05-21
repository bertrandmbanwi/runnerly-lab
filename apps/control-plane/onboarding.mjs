import { normalizeLabels } from "../../packages/shared/schema.mjs";

const hiddenLabels = new Set(["portfolio-demo", "lab-host"]);

export function buildRepositoryOnboarding({ repositories, runners, jobs, auditEvents, github }) {
  return repositories.map((repository) => {
    const requiredLabels = publicLabels(repository.allowedLabels ?? []);
    const key = `${repository.owner}/${repository.name}`;
    const matchingRunners = runners.filter((runner) => runnerCoversRepository(runner, requiredLabels, key));
    const onlineRunners = matchingRunners.filter((runner) => runner.status === "online");
    const latestJob = latestForRepository(jobs, key);
    const latestWebhookEvent = latestWebhookForRepository(auditEvents, key);
    const webhookStatus = webhookStatusFor(github, latestWebhookEvent);
    const runnerStatus = onlineRunners.length ? "ready" : matchingRunners.length ? "degraded" : "missing";
    const registrationMode = github?.mode === "management" ? "app-token" : "manual-token";
    const registrationScope = github?.runnerRegistrationScope ?? "org";

    return {
      repository: key,
      owner: repository.owner,
      name: repository.name,
      visibility: repository.visibility,
      requiredLabels,
      runnerStatus,
      runnerCount: matchingRunners.length,
      onlineRunnerCount: onlineRunners.length,
      matchingRunners: matchingRunners.map((runner) => ({
        id: runner.id,
        name: runner.name,
        status: runner.status,
        lastSeenAt: runner.lastSeenAt
      })),
      webhookStatus,
      latestWebhookEvent,
      latestJob,
      registrationMode,
      registrationScope,
      installCommand: buildInstallCommand(repository, requiredLabels, registrationMode, registrationScope),
      workflowSnippet: buildWorkflowSnippet(requiredLabels)
    };
  });
}

function publicLabels(labels) {
  return orderWorkflowLabels(normalizeLabels(labels).filter((label) => !hiddenLabels.has(label)));
}

function runnerCoversLabels(runner, requiredLabels) {
  const runnerLabels = new Set(normalizeLabels(runner.labels ?? []));
  return requiredLabels.every((label) => runnerLabels.has(label));
}

function runnerCoversRepository(runner, requiredLabels, repository) {
  const runnerRepositories = runner.metadata?.githubRunner?.repositories?.length
    ? runner.metadata.githubRunner.repositories
    : [runner.metadata?.githubRunner?.repository].filter(Boolean);

  if (runnerRepositories.length && !runnerRepositories.includes(repository)) {
    return false;
  }

  return runnerCoversLabels(runner, requiredLabels);
}

function latestForRepository(jobs, repository) {
  return jobs
    .filter((job) => job.repository === repository)
    .sort((a, b) => timestampFor(b) - timestampFor(a))
    .at(0) ?? null;
}

function latestWebhookForRepository(auditEvents, repository) {
  const event = auditEvents
    .filter((item) => item.action?.startsWith("github.workflow_") && item.payload?.repository === repository)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .at(0);

  if (!event) {
    return null;
  }

  return {
    action: event.action,
    status: event.payload?.status ?? null,
    createdAt: event.createdAt,
    target: event.target
  };
}

function webhookStatusFor(github, latestWebhookEvent) {
  if (latestWebhookEvent) {
    return "receiving";
  }

  if (github?.webhookSecretConfigured) {
    return "waiting";
  }

  return "not_configured";
}

function buildInstallCommand(repository, requiredLabels, registrationMode, registrationScope = "org") {
  const labels = requiredLabels.length ? orderWorkflowLabels(requiredLabels) : ["self-hosted"];
  const isOrgScoped = registrationScope === "org";
  const runnerName = isOrgScoped ? "$(hostname)-org" : `$(hostname)-${repository.name}`;
  const runnerDirectory = isOrgScoped ? "/opt/actions-runner" : `/opt/actions-runner-${shellValue(repository.name)}`;
  const repoLines = isOrgScoped ? [] : [`  GITHUB_REPO=${shellValue(repository.name)} \\`];

  if (registrationMode === "app-token") {
    return [
      `sudo GITHUB_OWNER=${shellValue(repository.owner)} \\`,
      `  GITHUB_RUNNER_SCOPE=${isOrgScoped ? "org" : "repo"} \\`,
      ...repoLines,
      `  RUNNER_DIR=${runnerDirectory} \\`,
      `  RUNNER_NAME="${runnerName}" \\`,
      `  RUNNER_LABELS=${shellValue(labels.join(","))} \\`,
      `  RUNNERLY_AGENT_TOKEN="$(sudo sed -n 's/^RUNNERLY_AGENT_TOKEN=//p' /etc/runnerly/agent.env)" \\`,
      "  bash /opt/runnerly/app/ops/scripts/install-github-runner.sh"
    ].join("\n");
  }

  return [
    `sudo GITHUB_OWNER=${shellValue(repository.owner)} \\`,
    `  GITHUB_RUNNER_SCOPE=${isOrgScoped ? "org" : "repo"} \\`,
    ...repoLines,
    `  GITHUB_RUNNER_TOKEN='<paste GitHub registration token>' \\`,
    `  RUNNER_DIR=${runnerDirectory} \\`,
    `  RUNNER_NAME="${runnerName}" \\`,
    `  RUNNER_LABELS=${shellValue(labels.join(","))} \\`,
    "  bash /opt/runnerly/app/ops/scripts/install-github-runner.sh"
  ].join("\n");
}

function buildWorkflowSnippet(requiredLabels) {
  const labels = ["self-hosted", ...orderWorkflowLabels(requiredLabels).map(canonicalWorkflowLabel)];
  return [
    "jobs:",
    "  validate:",
    `    runs-on: [${labels.join(", ")}]`
  ].join("\n");
}

function orderWorkflowLabels(labels) {
  const order = new Map([
    ["linux", 0],
    ["windows", 0],
    ["macos", 0],
    ["x64", 1],
    ["arm64", 1]
  ]);

  return [...labels].sort((a, b) => {
    const left = order.get(a) ?? 10;
    const right = order.get(b) ?? 10;
    return left - right || a.localeCompare(b);
  });
}

function canonicalWorkflowLabel(label) {
  if (label === "linux") {
    return "Linux";
  }

  if (label === "arm64") {
    return "ARM64";
  }

  if (label === "x64") {
    return "X64";
  }

  return label;
}

function shellValue(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9._/-]+$/.test(text)) {
    return text;
  }

  return `'${text.replaceAll("'", "'\\''")}'`;
}

function timestampFor(item) {
  return Date.parse(item.updatedAt ?? item.completedAt ?? item.startedAt ?? item.createdAt ?? 0);
}
