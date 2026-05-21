import { getGitHubRepository, githubIntegrationStatus, listGitHubRunnerGroups, listGitHubRunners } from "./github.mjs";

export async function reconcileGitHubState(db, store, options = {}) {
  const github = githubIntegrationStatus();
  const actor = options.actor ?? "runnerly-reconciler";
  const startedAt = new Date().toISOString();

  if (github.mode !== "management") {
    const result = {
      skipped: true,
      reason: "github_app_not_configured",
      generatedAt: startedAt,
      runnerCount: 0,
      repositoryCount: 0
    };
    store.setSetting?.(db, "github.reconcile", result);
    return result;
  }

  const owner = process.env.RUNNERLY_GITHUB_OWNER ?? github.allowedRepositories.at(0)?.owner;
  if (!owner) {
    const result = {
      skipped: true,
      reason: "github_owner_not_configured",
      generatedAt: startedAt,
      runnerCount: 0,
      repositoryCount: 0
    };
    store.setSetting?.(db, "github.reconcile", result);
    return result;
  }

  const runners = await reconcileRunners(db, store, { owner });
  const runnerGroups = await reconcileRunnerGroups(db, store, { owner, actor });
  const repositories = await reconcileRepositories(db, store, github.allowedRepositories);

  const result = {
    skipped: false,
    generatedAt: new Date().toISOString(),
    runnerCount: runners.length,
    onlineRunnerCount: runners.filter((runner) => runner.status === "online").length,
    busyRunnerCount: runners.filter((runner) => runner.busy).length,
    runnerGroupCount: runnerGroups.length,
    runnerGroupPublicAccessCount: runnerGroups.filter((group) => group.allows_public_repositories).length,
    repositoryCount: repositories.length,
    privateRepositoryCount: repositories.filter((repo) => repo.visibility !== "public").length,
    publicRepositoryCount: repositories.filter((repo) => repo.visibility === "public").length
  };

  store.recordAuditEvent(db, {
    actor,
    action: "github.reconciled",
    target: owner,
    payload: result
  });
  store.setSetting?.(db, "github.reconcile", result);

  return result;
}

async function reconcileRunners(db, store, { owner }) {
  const payload = await listGitHubRunners({ owner, scope: "org" });
  const runners = payload.runners ?? [];

  return runners.map((runner) => store.upsertRunnerHeartbeat(db, githubRunnerToHeartbeat(runner, { owner })));
}

async function reconcileRunnerGroups(db, store, { owner, actor }) {
  try {
    const payload = await listGitHubRunnerGroups({ owner });
    const runnerGroups = payload.runner_groups ?? [];
    store.setSetting?.(db, "github.runnerGroups", {
      generatedAt: new Date().toISOString(),
      runnerGroups
    });
    return runnerGroups;
  } catch (error) {
    store.recordAuditEvent(db, {
      actor,
      action: "github.runner_groups_reconcile_failed",
      target: owner,
      payload: {
        message: error.message,
        statusCode: error.statusCode ?? null
      }
    });
    return [];
  }
}

async function reconcileRepositories(db, store, allowedRepositories) {
  const repositories = [];

  for (const repository of allowedRepositories) {
    try {
      const githubRepository = await getGitHubRepository({ owner: repository.owner, repo: repository.repo });
      repositories.push(store.upsertRepository(db, {
        provider: "github",
        owner: repository.owner,
        name: repository.repo,
        visibility: githubRepository.private ? "private" : githubRepository.visibility ?? "public",
        allowedLabels: repository.labels
      }));
    } catch (error) {
      store.recordAuditEvent(db, {
        actor: "runnerly-reconciler",
        action: "github.repository_reconcile_failed",
        target: `${repository.owner}/${repository.repo}`,
        payload: {
          message: error.message,
          statusCode: error.statusCode ?? null
        }
      });
    }
  }

  return repositories;
}

export function githubRunnerToHeartbeat(runner, { owner }) {
  const labels = (runner.labels ?? []).map((label) => label.name ?? label).filter(Boolean);
  const runnerGroupName = runner.runner_group_name ?? null;

  return {
    runnerId: normalizeRunnerId(runner.name),
    runnerName: runner.name,
    hostname: runner.name,
    labels,
    status: runner.status === "online" ? "online" : "offline",
    observedAt: new Date().toISOString(),
    version: "github-actions",
    metadata: {
      source: "github-reconcile",
      provider: "github-actions",
      runnerGroupName,
      githubRunner: {
        configured: true,
        configuredOnHost: null,
        external: true,
        scope: "org",
        owner,
        repo: null,
        repository: null,
        repositories: [],
        githubRunnerId: runner.id?.toString() ?? null,
        runnerName: runner.name,
        runnerGroupName,
        runnerDirectory: null,
        busy: Boolean(runner.busy),
        os: runner.os ?? null,
        services: []
      },
      checks: [
        {
          name: "github-actions-runner",
          status: runner.status === "online" ? "ok" : "failed",
          detail: runner.status ?? "unknown"
        },
        {
          name: "job-slot",
          status: runner.busy ? "degraded" : "ok",
          detail: runner.busy ? "busy" : "idle"
        }
      ]
    }
  };
}

function normalizeRunnerId(runnerName) {
  return String(runnerName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
