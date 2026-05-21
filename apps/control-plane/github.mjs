import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const githubApiBaseUrl = process.env.RUNNERLY_GITHUB_API_BASE_URL ?? "https://api.github.com";
const githubWebUrl = process.env.RUNNERLY_GITHUB_WEB_URL ?? "https://github.com";
const hiddenLabels = new Set(["portfolio-demo", "lab-host"]);

export function githubIntegrationStatus() {
  const appConfigured = hasGitHubAppConfig();
  const webhookSecretConfigured = Boolean(process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET);
  const privateKeyConfigured = hasPrivateKeyConfig();

  return {
    configured: appConfigured || webhookSecretConfigured,
    mode: appConfigured ? "management" : webhookSecretConfigured ? "webhook" : "unconfigured",
    webhookSecretConfigured,
    publicWebhookUrl: process.env.RUNNERLY_PUBLIC_WEBHOOK_URL ?? null,
    appIdConfigured: Boolean(process.env.RUNNERLY_GITHUB_APP_ID),
    installationIdConfigured: Boolean(process.env.RUNNERLY_GITHUB_INSTALLATION_ID),
    privateKeyConfigured,
    runnerRegistrationScope: runnerRegistrationScope(),
    allowedRepositories: allowedRepositories()
  };
}

export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RUNNERLY_GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(signatureHeader, expected);
}

export async function processGitHubWebhook(db, eventName, payload, store) {
  if (eventName === "ping") {
    const repository = payload.repository ? upsertWebhookRepository(db, payload.repository, store) : null;
    store.recordAuditEvent(db, {
      actor: "github",
      action: "github.webhook.ping",
      target: repository?.id ?? payload.hook_id?.toString() ?? "github",
      payload: {
        hookId: payload.hook_id,
        zen: payload.zen
      }
    });
    return { accepted: true, event: eventName, repository };
  }

  if (eventName === "repository") {
    const repository = upsertWebhookRepository(db, payload.repository, store);
    store.recordAuditEvent(db, {
      actor: "github",
      action: `github.repository.${payload.action ?? "unknown"}`,
      target: `${repository.owner}/${repository.name}`,
      payload: {
        visibility: repository.visibility,
        private: repository.visibility === "private"
      }
    });
    return { accepted: true, event: eventName, repository };
  }

  if (eventName === "workflow_job") {
    const repository = upsertWebhookRepository(db, payload.repository, store);
    const selfHostedWorkflowJob = isSelfHostedWorkflowJob(payload.workflow_job);
    const publicSelfHostedJob = repository.visibility === "public" && selfHostedWorkflowJob;
    const runner = payload.workflow_job?.runner_name && store.upsertRunnerHeartbeat && selfHostedWorkflowJob && !publicSelfHostedJob
      ? store.upsertRunnerHeartbeat(db, workflowJobToRunnerHeartbeat(payload.workflow_job, repository))
      : null;
    const job = store.upsertJob(db, workflowJobToRecord(payload.workflow_job, repository));
    if (publicSelfHostedJob) {
      store.recordAuditEvent(db, {
        actor: "github",
        action: "policy.public_self_hosted_observed",
        target: `${repository.owner}/${repository.name}`,
        payload: {
          workflow: payload.workflow_job?.workflow_name ?? payload.workflow_job?.name ?? null,
          labels: payload.workflow_job?.labels ?? [],
          runnerName: payload.workflow_job?.runner_name ?? null
        }
      });
    }
    store.recordAuditEvent(db, {
      actor: "github",
      action: `github.workflow_job.${payload.action ?? "unknown"}`,
      target: job.id,
      payload: {
        repository: `${repository.owner}/${repository.name}`,
        runnerName: payload.workflow_job?.runner_name ?? null,
        status: job.status
      }
    });
    return { accepted: true, event: eventName, repository, runner, job };
  }

  if (eventName === "workflow_run") {
    const repository = upsertWebhookRepository(db, payload.repository, store);
    const job = store.upsertJob(db, workflowRunToRecord(payload.workflow_run, repository));
    store.recordAuditEvent(db, {
      actor: "github",
      action: `github.workflow_run.${payload.action ?? "unknown"}`,
      target: job.id,
      payload: {
        repository: `${repository.owner}/${repository.name}`,
        status: job.status
      }
    });
    return { accepted: true, event: eventName, repository, job };
  }

  store.recordAuditEvent(db, {
    actor: "github",
    action: "github.webhook.ignored",
    target: eventName ?? "unknown",
    payload: {
      action: payload.action ?? null
    }
  });

  return { accepted: true, event: eventName, ignored: true };
}

export async function createRunnerRegistrationToken({ owner, repo, scope } = {}) {
  const normalizedScope = normalizeRunnerScope(scope ?? runnerRegistrationScope());

  if (!owner) {
    throw Object.assign(new Error("owner is required"), { statusCode: 422 });
  }

  if (normalizedScope === "repo" && !repo) {
    throw Object.assign(new Error("repo is required for repo-scoped runners"), { statusCode: 422 });
  }

  if (normalizedScope === "org") {
    assertOwnerAllowed(owner);
  } else {
    assertRepositoryAllowed(owner, repo);
  }

  const installationToken = await createInstallationAccessToken();
  const endpoint = normalizedScope === "org"
    ? `/orgs/${encodeURIComponent(owner)}/actions/runners/registration-token`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runners/registration-token`;
  const response = await githubRequest(
    endpoint,
    {
      method: "POST",
      token: installationToken.token
    }
  );

  return {
    scope: normalizedScope,
    owner,
    repository: normalizedScope === "repo" ? `${owner}/${repo}` : null,
    target: normalizedScope === "org" ? owner : `${owner}/${repo}`,
    token: response.token,
    expiresAt: response.expires_at,
    runnerUrl: normalizedScope === "org" ? `${githubWebUrl}/${owner}` : `${githubWebUrl}/${owner}/${repo}`
  };
}

export async function listGitHubRunners({ owner, repo, scope } = {}) {
  const normalizedScope = normalizeRunnerScope(scope ?? runnerRegistrationScope());

  if (!owner) {
    throw Object.assign(new Error("owner is required"), { statusCode: 422 });
  }

  if (normalizedScope === "repo" && !repo) {
    throw Object.assign(new Error("repo is required for repo-scoped runners"), { statusCode: 422 });
  }

  if (normalizedScope === "org") {
    assertOwnerAllowed(owner);
  } else {
    assertRepositoryAllowed(owner, repo);
  }

  const installationToken = await createInstallationAccessToken();
  const endpoint = normalizedScope === "org"
    ? `/orgs/${encodeURIComponent(owner)}/actions/runners`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runners`;

  return githubRequest(
    endpoint,
    {
      method: "GET",
      token: installationToken.token
    }
  );
}

export async function listGitHubRunnerGroups({ owner } = {}) {
  if (!owner) {
    throw Object.assign(new Error("owner is required"), { statusCode: 422 });
  }

  assertOwnerAllowed(owner);

  const installationToken = await createInstallationAccessToken();
  return githubRequest(
    `/orgs/${encodeURIComponent(owner)}/actions/runner-groups`,
    {
      method: "GET",
      token: installationToken.token
    }
  );
}

export async function updateGitHubRunnerGroup({ owner, runnerGroupId, name, visibility, allowsPublicRepositories } = {}) {
  if (!owner || !runnerGroupId || !name) {
    throw Object.assign(new Error("owner, runnerGroupId, and name are required"), { statusCode: 422 });
  }

  assertOwnerAllowed(owner);

  const installationToken = await createInstallationAccessToken();
  return githubRequest(
    `/orgs/${encodeURIComponent(owner)}/actions/runner-groups/${encodeURIComponent(runnerGroupId)}`,
    {
      method: "PATCH",
      token: installationToken.token,
      body: {
        name,
        visibility,
        allows_public_repositories: Boolean(allowsPublicRepositories)
      }
    }
  );
}

export async function getGitHubRepository({ owner, repo } = {}) {
  if (!owner || !repo) {
    throw Object.assign(new Error("owner and repo are required"), { statusCode: 422 });
  }

  assertRepositoryAllowed(owner, repo);

  const installationToken = await createInstallationAccessToken();
  return githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      method: "GET",
      token: installationToken.token
    }
  );
}

export function workflowJobToRecord(workflowJob, repository) {
  if (!workflowJob) {
    throw Object.assign(new Error("workflow_job payload is required"), { statusCode: 422 });
  }

  return {
    id: `github-job:${workflowJob.id}`,
    repositoryId: repository.id,
    runnerId: isSelfHostedWorkflowJob(workflowJob) ? normalizeRunnerId(workflowJob.runner_name) : null,
    githubRunId: workflowJob.run_id?.toString() ?? null,
    githubJobId: workflowJob.id?.toString() ?? null,
    workflow: workflowJob.workflow_name ?? workflowJob.name ?? "GitHub workflow job",
    status: mapWorkflowJobStatus(workflowJob),
    labels: workflowJob.labels ?? [],
    queuedAt: workflowJob.created_at ?? workflowJob.queued_at ?? null,
    pickedUpAt: workflowJob.started_at ?? null,
    startedAt: workflowJob.started_at ?? null,
    completedAt: workflowJob.completed_at ?? null,
    conclusion: workflowJob.conclusion ?? null,
    url: workflowJob.html_url ?? null
  };
}

export function workflowJobToRunnerHeartbeat(workflowJob, repository) {
  if (!workflowJob?.runner_name) {
    throw Object.assign(new Error("workflow_job runner_name is required"), { statusCode: 422 });
  }

  if (!isSelfHostedWorkflowJob(workflowJob)) {
    throw Object.assign(new Error("workflow_job is not running on a self-hosted runner"), { statusCode: 422 });
  }

  const repositoryName = `${repository.owner}/${repository.name}`;

  return {
    runnerId: normalizeRunnerId(workflowJob.runner_name),
    runnerName: workflowJob.runner_name,
    hostname: workflowJob.runner_name,
    labels: workflowJob.labels ?? ["self-hosted"],
    status: "online",
    observedAt: workflowJob.completed_at ?? workflowJob.started_at ?? new Date().toISOString(),
    version: "github-actions",
    metadata: {
      source: "github-webhook",
      provider: "github-actions",
      runnerGroupName: workflowJob.runner_group_name ?? null,
      githubRunner: {
        configured: true,
        configuredOnHost: null,
        runnerName: workflowJob.runner_name,
        runnerDirectory: null,
        repository: null,
        repositories: [],
        observedRepository: repositoryName,
        busy: workflowJob.status === "in_progress",
        external: true,
        services: []
      },
      checks: [
        {
          name: "github-actions-runner",
          status: "ok",
          detail: `observed via workflow_job.${workflowJob.status ?? "unknown"}`
        }
      ]
    }
  };
}

export function isSelfHostedWorkflowJob(workflowJob) {
  return workflowJobLabels(workflowJob).includes("self-hosted");
}

function workflowJobLabels(workflowJob) {
  return (workflowJob?.labels ?? [])
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}

export function workflowRunToRecord(workflowRun, repository) {
  if (!workflowRun) {
    throw Object.assign(new Error("workflow_run payload is required"), { statusCode: 422 });
  }

  return {
    id: `github-run:${workflowRun.id}`,
    repositoryId: repository.id,
    runnerId: null,
    githubRunId: workflowRun.id?.toString() ?? null,
    githubJobId: null,
    workflow: workflowRun.name ?? workflowRun.display_title ?? "GitHub workflow run",
    status: mapWorkflowRunStatus(workflowRun),
    labels: [],
    queuedAt: workflowRun.created_at ?? null,
    pickedUpAt: workflowRun.run_started_at ?? null,
    startedAt: workflowRun.run_started_at ?? workflowRun.created_at ?? null,
    completedAt: workflowRun.updated_at ?? null,
    conclusion: workflowRun.conclusion ?? null,
    url: workflowRun.html_url ?? null
  };
}

export function mapWorkflowJobStatus(workflowJob) {
  if (workflowJob.status === "queued" || workflowJob.status === "waiting") {
    return "queued";
  }

  if (workflowJob.status === "in_progress") {
    return "running";
  }

  return mapConclusion(workflowJob.conclusion);
}

export function mapWorkflowRunStatus(workflowRun) {
  if (workflowRun.status === "queued" || workflowRun.status === "requested" || workflowRun.status === "waiting") {
    return "queued";
  }

  if (workflowRun.status === "in_progress") {
    return "running";
  }

  return mapConclusion(workflowRun.conclusion);
}

function mapConclusion(conclusion) {
  if (conclusion === "success") {
    return "completed";
  }

  if (conclusion === "cancelled" || conclusion === "skipped") {
    return "cancelled";
  }

  if (conclusion) {
    return "failed";
  }

  return "completed";
}

function upsertWebhookRepository(db, githubRepository, store) {
  if (!githubRepository) {
    throw Object.assign(new Error("repository payload is required"), { statusCode: 422 });
  }

  const owner = githubRepository.owner?.login ?? githubRepository.full_name?.split("/").at(0);
  const name = githubRepository.name;
  assertRepositoryAllowed(owner, name);

  return store.upsertRepository(db, {
    provider: "github",
    owner,
    name,
    visibility: githubRepository.private ? "private" : "public",
    allowedLabels: labelsForRepository(owner, name)
  });
}

function labelsForRepository(owner, repo) {
  const configured = allowedRepositories().find((entry) => entry.owner === owner && entry.repo === repo);
  return configured?.labels ?? ["self-hosted"];
}

function assertRepositoryAllowed(owner, repo) {
  const allowed = allowedRepositories();
  if (!allowed.length) {
    return;
  }

  if (allowed.some((entry) => entry.owner === owner && entry.repo === repo)) {
    return;
  }

  throw Object.assign(new Error(`repository is not allowed: ${owner}/${repo}`), { statusCode: 403 });
}

function assertOwnerAllowed(owner) {
  const configuredOwner = process.env.RUNNERLY_GITHUB_OWNER;
  const allowed = allowedRepositories();

  if (configuredOwner && configuredOwner === owner) {
    return;
  }

  if (allowed.some((entry) => entry.owner === owner)) {
    return;
  }

  if (!configuredOwner && !allowed.length) {
    return;
  }

  throw Object.assign(new Error(`owner is not allowed: ${owner}`), { statusCode: 403 });
}

function runnerRegistrationScope() {
  return normalizeRunnerScope(process.env.RUNNERLY_GITHUB_RUNNER_SCOPE ?? "org");
}

function normalizeRunnerScope(scope) {
  const normalized = String(scope ?? "").trim().toLowerCase();
  if (["org", "organization", "organisation"].includes(normalized)) {
    return "org";
  }
  if (["repo", "repository"].includes(normalized)) {
    return "repo";
  }
  throw Object.assign(new Error(`unsupported runner registration scope: ${scope}`), { statusCode: 422 });
}

function allowedRepositories() {
  const raw = process.env.RUNNERLY_ALLOWED_REPOSITORIES ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [repoPart, labelsPart] = entry.split(":", 2);
      const [owner, repo] = repoPart.split("/", 2);
      return {
        owner,
        repo,
        labels: sanitizeAllowedLabels(labelsPart ? labelsPart.split("+").map((label) => label.trim()).filter(Boolean) : ["self-hosted"])
      };
    })
    .filter((entry) => entry.owner && entry.repo);
}

function sanitizeAllowedLabels(labels) {
  const sanitized = labels.filter((label) => !hiddenLabels.has(label.toLowerCase()));
  return sanitized.length ? sanitized : ["self-hosted"];
}

function normalizeRunnerId(runnerName) {
  if (!runnerName) {
    return null;
  }

  return runnerName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function createInstallationAccessToken() {
  if (!hasGitHubAppConfig()) {
    throw Object.assign(new Error("GitHub App credentials are not configured"), { statusCode: 503 });
  }

  const jwt = await createGitHubAppJwt();
  const installationId = process.env.RUNNERLY_GITHUB_INSTALLATION_ID;
  return githubRequest(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: jwt
  });
}

async function createGitHubAppJwt() {
  const appId = process.env.RUNNERLY_GITHUB_APP_ID;
  const privateKey = await readPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: appId
  });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

async function readPrivateKey() {
  if (process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY) {
    return process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n");
  }

  if (process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE) {
    return readFile(process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE, "utf8");
  }

  throw Object.assign(new Error("GitHub App private key is not configured"), { statusCode: 503 });
}

async function githubRequest(pathname, { method, token, body }) {
  const response = await fetch(new URL(pathname, githubApiBaseUrl), {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "runnerly-control-plane"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(payload.message ?? `GitHub API returned ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function hasGitHubAppConfig() {
  return Boolean(
    process.env.RUNNERLY_GITHUB_APP_ID &&
      process.env.RUNNERLY_GITHUB_INSTALLATION_ID &&
      hasPrivateKeyConfig()
  );
}

function hasPrivateKeyConfig() {
  if (process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY) {
    return true;
  }

  if (process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE) {
    return existsSync(process.env.RUNNERLY_GITHUB_APP_PRIVATE_KEY_FILE);
  }

  return false;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
