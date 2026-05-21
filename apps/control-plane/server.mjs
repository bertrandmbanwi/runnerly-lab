import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authStatusHandler,
  githubAuthCallbackHandler,
  githubAuthStartHandler,
  isAdminAuthEnabled,
  loginHandler,
  logoutHandler,
  redirectToLogin,
  requireAdmin
} from "./auth.mjs";
import {
  githubIntegrationStatus,
  createRunnerRegistrationToken,
  listGitHubRunners,
  processGitHubWebhook,
  verifyWebhookSignature
} from "./github.mjs";
import {
  createDatabaseBackup,
  getSetting,
  listDatabaseBackups,
  listAuditEvents,
  listJobs,
  listOverview,
  listRepositories,
  listRunners,
  listWorkflowInventoryJobs,
  listWorkflowAuditEvents,
  openRunnerlyDatabase,
  pruneRepositoriesToPolicy,
  recordAuditEvent,
  setSetting,
  upsertJob,
  upsertRepository,
  upsertRunnerHeartbeat
} from "./db.mjs";
import { buildRepositoryOnboarding } from "./onboarding.mjs";
import { buildRunnerPolicyReport } from "./policy.mjs";
import { githubRunnerToHeartbeat, reconcileGitHubState } from "./reconcile.mjs";
import { buildControlPlaneHealth } from "./health.mjs";
import { buildWorkflowInventory } from "./workflows.mjs";

const dashboardRoot = resolve(fileURLToPath(new URL("../dashboard/", import.meta.url)));
const port = Number.parseInt(process.env.RUNNERLY_PORT ?? "8787", 10);
const host = process.env.RUNNERLY_HOST ?? "127.0.0.1";
const db = openRunnerlyDatabase(process.env.RUNNERLY_DB_PATH);
const store = {
  recordAuditEvent,
  setSetting,
  upsertJob,
  upsertRepository,
  upsertRunnerHeartbeat
};
let reconcilePromise = null;
let backupPromise = null;
let runnerHeartbeatPromise = null;
const liveClients = new Set();
let liveEventSequence = 0;
syncAllowedRepositories(db);
scheduleGitHubRunnerHeartbeat();
scheduleGitHubReconciler();
scheduleDatabaseBackups();

const publicRoutes = new Map([
  ["GET /api/health", healthHandler],
  ["GET /api/auth/status", authStatus],
  ["GET /api/auth/github/start", authGithubStart],
  ["GET /api/auth/github/callback", authGithubCallback],
  ["POST /api/auth/login", authLogin],
  ["POST /api/auth/logout", authLogout],
  ["POST /api/github/webhook", githubWebhookHandler]
]);

const adminRoutes = new Map([
  ["GET /api/overview", overviewHandler],
  ["GET /api/runners", runnersHandler],
  ["GET /api/repositories", repositoriesHandler],
  ["GET /api/jobs", jobsHandler],
  ["GET /api/audit-events", auditEventsHandler],
  ["GET /api/onboarding", onboardingHandler],
  ["GET /api/policy", policyHandler],
  ["GET /api/workflows", workflowsHandler],
  ["GET /api/github/status", githubStatusHandler],
  ["GET /api/github/runners", githubRunnersHandler],
  ["GET /api/events", liveEventsHandler],
  ["GET /api/reconcile", reconcileStatusHandler],
  ["GET /api/backups", backupsStatusHandler],
  ["GET /api/exports/evidence.json", evidenceJsonExportHandler],
  ["GET /api/exports/runners.csv", runnersCsvExportHandler],
  ["GET /api/exports/repositories.csv", repositoriesCsvExportHandler],
  ["GET /api/exports/jobs.csv", jobsCsvExportHandler],
  ["GET /api/exports/audit.csv", auditCsvExportHandler],
  ["POST /api/reconcile", reconcileNowHandler],
  ["POST /api/backups", backupNowHandler],
  ["POST /api/github/runner-registration-token", githubRunnerTokenHandler],
  ["POST /api/audit-events", createAuditEventHandler]
]);

const agentRoutes = new Map([
  ["POST /api/runners/heartbeat", heartbeatHandler]
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const routeKey = `${request.method} ${url.pathname}`;
    const publicRoute = publicRoutes.get(routeKey);

    if (publicRoute) {
      await publicRoute(request, response, url);
      return;
    }

    const agentRoute = agentRoutes.get(routeKey);
    if (agentRoute) {
      requireAgentToken(request);
      await agentRoute(request, response, url);
      return;
    }

    const adminRoute = adminRoutes.get(routeKey);
    if (adminRoute) {
      if (routeKey === "POST /api/github/runner-registration-token") {
        requireAdminOrAgent(request);
      } else {
        requireAdmin(request);
      }
      await adminRoute(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    await serveStatic(request, url.pathname, response);
  } catch (error) {
    console.error(error);
    const statusCode = error.statusCode ?? 500;
    sendJson(response, statusCode, {
      error: statusCode === 401 ? "unauthorized" : "internal_error",
      detail: error.message
    });
  }
});

server.listen(port, host, () => {
  console.log(`Runnerly control plane listening on http://${host}:${port}`);
});

function syncAllowedRepositories(db) {
  const { allowedRepositories = [] } = githubIntegrationStatus();
  const existingRepositories = new Map(listRepositories(db).map((repository) => [
    `${repository.owner}/${repository.name}`,
    repository
  ]));

  for (const repository of allowedRepositories) {
    const existing = existingRepositories.get(`${repository.owner}/${repository.repo}`);
    upsertRepository(db, {
      provider: "github",
      owner: repository.owner,
      name: repository.repo,
      visibility: existing?.visibility ?? "private",
      allowedLabels: repository.labels
    });
  }

  pruneRepositoriesToPolicy(db, allowedRepositories);
}

async function healthHandler(_request, response) {
  sendJson(response, 200, {
    ok: true,
    service: "runnerly-control-plane",
    generatedAt: new Date().toISOString()
  });
}

async function authStatus(request, response) {
  await authStatusHandler(request, response, { sendJson });
}

async function authLogin(request, response) {
  await loginHandler(request, response, { readJson, sendJson });
}

async function authGithubStart(request, response) {
  await githubAuthStartHandler(request, response, { sendJson });
}

async function authGithubCallback(request, response, url) {
  await githubAuthCallbackHandler(request, response, url);
}

async function authLogout(request, response) {
  await logoutHandler(request, response);
}

async function overviewHandler(_request, response) {
  const overview = listOverview(db);
  const github = githubIntegrationStatus();
  const reconcile = getSetting(db, "github.reconcile");
  const runnerHeartbeat = getSetting(db, "github.runnerHeartbeat");
  const lastWebhook = getSetting(db, "github.lastWebhook");
  const webhookHealth = getSetting(db, "github.webhookHealth");
  const lastEvent = getSetting(db, "runnerly.lastEvent");
  sendJson(response, 200, {
    ...overview,
    health: buildCurrentHealthReport({
      overview,
      github,
      reconcile,
      runnerHeartbeat,
      webhookHealth
    }),
    policy: buildCurrentPolicyReport(overview),
    reconcile,
    runnerHeartbeat,
    lastWebhook,
    webhookHealth,
    lastEvent
  });
}

async function runnersHandler(_request, response) {
  sendJson(response, 200, { runners: listRunners(db) });
}

async function repositoriesHandler(_request, response) {
  sendJson(response, 200, { repositories: listRepositories(db) });
}

async function jobsHandler(_request, response) {
  sendJson(response, 200, { jobs: listJobs(db) });
}

async function auditEventsHandler(_request, response) {
  sendJson(response, 200, { auditEvents: listAuditEvents(db) });
}

async function onboardingHandler(_request, response) {
  const overview = listOverview(db);
  const github = githubIntegrationStatus();
  sendJson(response, 200, {
    generatedAt: overview.generatedAt,
    onboarding: buildRepositoryOnboarding({
      repositories: privateRepositories(overview.repositories),
      runners: overview.runners,
      jobs: overview.jobs,
      auditEvents: listWorkflowAuditEvents(db),
      github
    })
  });
}

async function workflowsHandler(_request, response) {
  sendJson(response, 200, buildWorkflowInventory({
    repositories: listRepositories(db),
    jobs: listWorkflowInventoryJobs(db)
  }));
}

async function policyHandler(_request, response) {
  sendJson(response, 200, buildCurrentPolicyReport());
}

function buildCurrentPolicyReport(overview = listOverview(db)) {
  return buildRunnerPolicyReport({
    repositories: overview.repositories,
    jobs: listWorkflowInventoryJobs(db),
    runnerGroups: getSetting(db, "github.runnerGroups", { runnerGroups: [] })
  });
}

function buildCurrentHealthReport({
  overview = listOverview(db),
  github = githubIntegrationStatus(),
  reconcile = getSetting(db, "github.reconcile"),
  runnerHeartbeat = getSetting(db, "github.runnerHeartbeat"),
  webhookHealth = getSetting(db, "github.webhookHealth")
} = {}) {
  return buildControlPlaneHealth({
    overview,
    github,
    reconcile,
    runnerHeartbeat,
    webhookHealth,
    thresholds: {
      runnerStaleSeconds: numberEnv("RUNNERLY_STALE_RUNNER_SECONDS", 180),
      runnerHeartbeatStaleSeconds: numberEnv("RUNNERLY_RUNNER_HEARTBEAT_STALE_SECONDS", 90),
      reconcileStaleSeconds: numberEnv("RUNNERLY_RECONCILE_STALE_SECONDS", 900)
    }
  });
}

function privateRepositories(repositories) {
  return repositories.filter((repository) => repository.visibility !== "public");
}

async function heartbeatHandler(request, response) {
  const payload = await readJson(request);
  const runner = upsertRunnerHeartbeat(db, payload);
  broadcastDashboardRefresh("runner_heartbeat", {
    runnerId: runner.id,
    source: payload.metadata?.source ?? "agent"
  });
  sendJson(response, 202, { runner });
}

async function createAuditEventHandler(request, response) {
  const payload = await readJson(request);

  if (!payload.action || !payload.target) {
    sendJson(response, 422, { error: "invalid_audit_event" });
    return;
  }

  recordAuditEvent(db, payload);
  broadcastDashboardRefresh("audit_event_created", {
    action: payload.action,
    target: payload.target
  });
  sendJson(response, 201, { auditEvents: listAuditEvents(db) });
}

async function githubStatusHandler(_request, response) {
  sendJson(response, 200, { github: githubIntegrationStatus() });
}

async function githubRunnersHandler(_request, response, url) {
  const owner = url.searchParams.get("owner") ?? process.env.RUNNERLY_GITHUB_OWNER;
  const requestedRepo = url.searchParams.get("repo");
  const scope = url.searchParams.get("scope") ?? (requestedRepo ? "repo" : process.env.RUNNERLY_GITHUB_RUNNER_SCOPE);
  const repo = requestedRepo ?? (scope === "repo" ? process.env.RUNNERLY_GITHUB_REPO : undefined);
  const runners = await listGitHubRunners({ owner, repo, scope });
  sendJson(response, 200, runners);
}

async function liveEventsHandler(_request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write(": connected\n\n");
  liveClients.add(response);
  sendLiveEvent(response, "runnerly", {
    id: ++liveEventSequence,
    type: "connected",
    generatedAt: new Date().toISOString()
  });

  const keepAlive = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 25_000);
  keepAlive.unref?.();

  response.on("close", () => {
    clearInterval(keepAlive);
    liveClients.delete(response);
  });
}

async function githubRunnerTokenHandler(request, response) {
  const payload = await readJson(request);
  const owner = payload.owner ?? process.env.RUNNERLY_GITHUB_OWNER;
  const scope = payload.scope ?? (payload.repo ? "repo" : process.env.RUNNERLY_GITHUB_RUNNER_SCOPE);
  const repo = payload.repo ?? (scope === "repo" ? process.env.RUNNERLY_GITHUB_REPO : undefined);
  const token = await createRunnerRegistrationToken({ owner, repo, scope });
  recordAuditEvent(db, {
    actor: authenticatedActor(request),
    action: "github.runner_registration_token.created",
    target: token.target,
    payload: { expiresAt: token.expiresAt }
  });
  sendJson(response, 201, token);
}

async function reconcileStatusHandler(_request, response) {
  sendJson(response, 200, {
    inFlight: Boolean(reconcilePromise),
    reconcile: getSetting(db, "github.reconcile", {
      skipped: true,
      reason: "not_run",
      generatedAt: null,
      runnerCount: 0,
      repositoryCount: 0
    }),
    runnerHeartbeat: getSetting(db, "github.runnerHeartbeat", {
      skipped: true,
      reason: "not_run",
      generatedAt: null,
      runnerCount: 0
    })
  });
}

async function reconcileNowHandler(request, response) {
  const result = await runGitHubReconcile({
    actor: authenticatedActor(request)
  });
  sendJson(response, 202, {
    inFlight: Boolean(reconcilePromise),
    reconcile: result,
    runnerHeartbeat: getSetting(db, "github.runnerHeartbeat")
  });
}

async function backupsStatusHandler(_request, response) {
  sendJson(response, 200, {
    inFlight: Boolean(backupPromise),
    backup: getSetting(db, "database.backup", {
      skipped: true,
      reason: "not_run",
      generatedAt: null
    }),
    backups: listDatabaseBackups()
  });
}

async function backupNowHandler(request, response) {
  const result = await runDatabaseBackup({
    actor: authenticatedActor(request)
  });
  sendJson(response, 202, {
    inFlight: Boolean(backupPromise),
    backup: result,
    backups: listDatabaseBackups()
  });
}

async function evidenceJsonExportHandler(_request, response) {
  const overview = listOverview(db);
  const github = githubIntegrationStatus();
  const policy = buildCurrentPolicyReport(overview);
  const payload = {
    exportType: "runnerly-evidence-v1",
    generatedAt: overview.generatedAt,
    github: {
      mode: github.mode,
      publicWebhookUrl: github.publicWebhookUrl,
      runnerRegistrationScope: github.runnerRegistrationScope,
      allowedRepositories: github.allowedRepositories
    },
    summary: overview.summary,
    runners: overview.runners,
    repositories: overview.repositories,
    jobs: overview.jobs,
    workflows: buildWorkflowInventory({
      repositories: overview.repositories,
      jobs: listWorkflowInventoryJobs(db)
    }),
    policy,
    onboarding: buildRepositoryOnboarding({
      repositories: privateRepositories(overview.repositories),
      runners: overview.runners,
      jobs: overview.jobs,
      auditEvents: listWorkflowAuditEvents(db),
      github
    }),
    auditEvents: overview.auditEvents
  };

  sendJsonDownload(response, `runnerly-evidence-${exportStamp()}.json`, payload);
}

async function runnersCsvExportHandler(_request, response) {
  sendCsv(response, `runnerly-runners-${exportStamp()}.csv`, [
    ["id", "name", "status", "busy", "scope", "owner", "repo", "runnerGroup", "labels", "lastSeenAt", "version"],
    ...listRunners(db).map((runner) => [
      runner.id,
      runner.name,
      runner.status,
      runner.busy ? "true" : "false",
      runner.scope ?? "",
      runner.owner ?? "",
      runner.repo ?? "",
      runner.runnerGroupName ?? runner.metadata?.githubRunner?.runnerGroupName ?? "",
      (runner.labels ?? []).join(" "),
      runner.lastSeenAt ?? "",
      runner.version ?? ""
    ])
  ]);
}

async function repositoriesCsvExportHandler(_request, response) {
  sendCsv(response, `runnerly-repositories-${exportStamp()}.csv`, [
    ["id", "provider", "owner", "name", "visibility", "allowedLabels", "updatedAt"],
    ...listRepositories(db).map((repository) => [
      repository.id,
      repository.provider,
      repository.owner,
      repository.name,
      repository.visibility,
      (repository.allowedLabels ?? []).join(" "),
      repository.updatedAt
    ])
  ]);
}

async function jobsCsvExportHandler(_request, response) {
  sendCsv(response, `runnerly-jobs-${exportStamp()}.csv`, [
    ["id", "repository", "workflow", "status", "conclusion", "runnerId", "labels", "queuedAt", "pickedUpAt", "startedAt", "completedAt", "pickupSeconds", "durationSeconds", "url"],
    ...listWorkflowInventoryJobs(db).map((job) => [
      job.id,
      job.repository ?? "",
      job.workflow,
      job.status,
      job.conclusion ?? "",
      job.runnerId ?? "",
      (job.labels ?? []).join(" "),
      job.queuedAt ?? "",
      job.pickedUpAt ?? "",
      job.startedAt ?? "",
      job.completedAt ?? "",
      job.pickupSeconds ?? "",
      job.durationSeconds ?? "",
      job.url ?? ""
    ])
  ]);
}

async function auditCsvExportHandler(_request, response) {
  sendCsv(response, `runnerly-audit-${exportStamp()}.csv`, [
    ["id", "createdAt", "actor", "action", "target", "payload"],
    ...listAuditEvents(db).map((event) => [
      event.id,
      event.createdAt,
      event.actor,
      event.action,
      event.target,
      JSON.stringify(event.payload ?? {})
    ])
  ]);
}

async function githubWebhookHandler(request, response) {
  const rawBody = await readRequestBody(request);
  const signature = headerValue(request.headers["x-hub-signature-256"]);
  if (!verifyWebhookSignature(rawBody, signature)) {
    const result = {
      failed: true,
      reason: "invalid_signature",
      message: "GitHub webhook signature verification failed",
      generatedAt: new Date().toISOString()
    };
    setSetting(db, "github.webhookHealth", result);
    broadcastDashboardRefresh("github_webhook_failed", {
      event: headerValue(request.headers["x-github-event"]) ?? "unknown",
      reason: result.reason
    });
    sendJson(response, 401, { error: "invalid_signature" });
    return;
  }

  const eventName = headerValue(request.headers["x-github-event"]) ?? "unknown";
  const payload = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  let result;
  try {
    result = await processGitHubWebhook(db, eventName, payload, {
      recordAuditEvent,
      upsertJob,
      upsertRepository,
      upsertRunnerHeartbeat
    });
  } catch (error) {
    const failure = {
      failed: true,
      reason: "webhook_processing_failed",
      message: error.message,
      statusCode: error.statusCode ?? null,
      generatedAt: new Date().toISOString(),
      event: eventName,
      action: payload.action ?? null
    };
    setSetting(db, "github.webhookHealth", failure);
    broadcastDashboardRefresh("github_webhook_failed", {
      event: eventName,
      action: payload.action ?? null,
      reason: failure.reason
    });
    throw error;
  }

  const lastWebhook = {
    generatedAt: new Date().toISOString(),
    event: eventName,
    action: payload.action ?? null,
    repository: result.repository ? `${result.repository.owner}/${result.repository.name}` : null
  };
  setSetting(db, "github.lastWebhook", lastWebhook);
  setSetting(db, "github.webhookHealth", {
    failed: false,
    generatedAt: lastWebhook.generatedAt,
    event: eventName,
    action: payload.action ?? null
  });

  broadcastDashboardRefresh("github_webhook", {
    event: eventName,
    action: payload.action ?? null,
    repository: result.repository ? `${result.repository.owner}/${result.repository.name}` : null
  });
  sendJson(response, 202, result);
}

function broadcastDashboardRefresh(reason, payload = {}) {
  const event = {
    id: ++liveEventSequence,
    type: "refresh",
    reason,
    generatedAt: new Date().toISOString(),
    ...payload
  };
  setSetting(db, "runnerly.lastEvent", event);

  if (!liveClients.size) {
    return;
  }

  for (const client of liveClients) {
    sendLiveEvent(client, "runnerly", event);
  }
}

function sendLiveEvent(response, eventName, payload) {
  try {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    liveClients.delete(response);
  }
}

function headerValue(value) {
  return Array.isArray(value) ? value.at(0) : value;
}

function numberEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requireAgentToken(request) {
  const expected = process.env.RUNNERLY_AGENT_TOKEN;
  if (!expected) {
    return;
  }

  const received = request.headers.authorization ?? "";
  if (received !== `Bearer ${expected}`) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function requireAdminOrAgent(request) {
  if (!isAdminAuthEnabled() && !process.env.RUNNERLY_AGENT_TOKEN) {
    const error = new Error("registration token endpoint requires RUNNERLY_ADMIN_TOKEN or RUNNERLY_AGENT_TOKEN");
    error.statusCode = 503;
    throw error;
  }

  try {
    requireAdmin(request);
    return;
  } catch {
    requireAgentToken(request);
  }
}

function authenticatedActor(request) {
  const bearer = request.headers.authorization ?? "";
  if (process.env.RUNNERLY_AGENT_TOKEN && bearer === `Bearer ${process.env.RUNNERLY_AGENT_TOKEN}`) {
    return "runnerly-agent";
  }
  return "runnerly-admin";
}

async function runGitHubRunnerHeartbeat() {
  if (runnerHeartbeatPromise) {
    return runnerHeartbeatPromise;
  }

  const github = githubIntegrationStatus();
  const generatedAt = new Date().toISOString();

  if (github.mode !== "management") {
    const result = {
      skipped: true,
      reason: "github_app_not_configured",
      generatedAt,
      runnerCount: 0,
      onlineRunnerCount: 0,
      busyRunnerCount: 0
    };
    setSetting(db, "github.runnerHeartbeat", result);
    broadcastDashboardRefresh("github_runner_heartbeat", { skipped: true });
    return result;
  }

  const owner = process.env.RUNNERLY_GITHUB_OWNER ?? github.allowedRepositories.at(0)?.owner;
  if (!owner) {
    const result = {
      skipped: true,
      reason: "github_owner_not_configured",
      generatedAt,
      runnerCount: 0,
      onlineRunnerCount: 0,
      busyRunnerCount: 0
    };
    setSetting(db, "github.runnerHeartbeat", result);
    broadcastDashboardRefresh("github_runner_heartbeat", { skipped: true });
    return result;
  }

  runnerHeartbeatPromise = listGitHubRunners({ owner, scope: "org" })
    .then((payload) => {
      const runners = (payload.runners ?? []).map((runner) => (
        upsertRunnerHeartbeat(db, githubRunnerToHeartbeat(runner, { owner }), { audit: false })
      ));
      const result = {
        skipped: false,
        generatedAt: new Date().toISOString(),
        runnerCount: runners.length,
        onlineRunnerCount: runners.filter((runner) => runner.status === "online").length,
        busyRunnerCount: runners.filter((runner) => runner.busy).length
      };
      setSetting(db, "github.runnerHeartbeat", result);
      broadcastDashboardRefresh("github_runner_heartbeat", {
        failed: false,
        skipped: false,
        runnerCount: result.runnerCount
      });
      return result;
    })
    .catch((error) => {
      const result = {
        failed: true,
        skipped: false,
        reason: "github_runner_heartbeat_failed",
        message: error.message,
        statusCode: error.statusCode ?? null,
        generatedAt: new Date().toISOString()
      };
      setSetting(db, "github.runnerHeartbeat", result);
      broadcastDashboardRefresh("github_runner_heartbeat", {
        failed: true,
        skipped: false
      });
      return result;
    })
    .finally(() => {
      runnerHeartbeatPromise = null;
    });

  return runnerHeartbeatPromise;
}

async function runGitHubReconcile({ actor = "runnerly-reconciler" } = {}) {
  if (reconcilePromise) {
    return reconcilePromise;
  }

  reconcilePromise = reconcileGitHubState(db, store, { actor })
    .then((result) => {
      broadcastDashboardRefresh("github_reconcile", {
        failed: Boolean(result.failed),
        skipped: Boolean(result.skipped)
      });
      return result;
    })
    .catch((error) => {
      const result = {
        failed: true,
        skipped: false,
        reason: "github_reconcile_failed",
        message: error.message,
        statusCode: error.statusCode ?? null,
        generatedAt: new Date().toISOString()
      };

      setSetting(db, "github.reconcile", result);
      recordAuditEvent(db, {
        actor,
        action: "github.reconcile_failed",
        target: "github",
        payload: result
      });

      broadcastDashboardRefresh("github_reconcile", {
        failed: true,
        skipped: false
      });
      return result;
    })
    .finally(() => {
      reconcilePromise = null;
    });

  return reconcilePromise;
}

async function runDatabaseBackup({ actor = "runnerly-backup" } = {}) {
  if (backupPromise) {
    return backupPromise;
  }

  backupPromise = Promise.resolve()
    .then(() => createDatabaseBackup(db))
    .then((backup) => {
      const result = {
        failed: false,
        generatedAt: new Date().toISOString(),
        ...backup
      };

      setSetting(db, "database.backup", result);
      recordAuditEvent(db, {
        actor,
        action: "database.backup.created",
        target: backup.fileName,
        payload: {
          bytes: backup.bytes,
          pruned: backup.pruned
        }
      });

      return result;
    })
    .catch((error) => {
      const result = {
        failed: true,
        reason: "database_backup_failed",
        message: error.message,
        generatedAt: new Date().toISOString()
      };

      setSetting(db, "database.backup", result);
      recordAuditEvent(db, {
        actor,
        action: "database.backup_failed",
        target: "sqlite",
        payload: result
      });

      return result;
    })
    .finally(() => {
      backupPromise = null;
    });

  return backupPromise;
}

function scheduleGitHubRunnerHeartbeat() {
  if (process.env.RUNNERLY_RUNNER_HEARTBEAT_ENABLED === "false") {
    return;
  }

  const intervalMs = Number.parseInt(process.env.RUNNERLY_RUNNER_HEARTBEAT_INTERVAL_MS ?? "30000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    console.warn("RUNNERLY_RUNNER_HEARTBEAT_INTERVAL_MS must be at least 10000; runner heartbeat disabled");
    return;
  }

  const initialDelay = Number.parseInt(process.env.RUNNERLY_RUNNER_HEARTBEAT_INITIAL_DELAY_MS ?? "2000", 10);
  const initialTimer = setTimeout(() => {
    void runGitHubRunnerHeartbeat();
  }, Number.isFinite(initialDelay) && initialDelay >= 0 ? initialDelay : 2_000);
  initialTimer.unref?.();

  const timer = setInterval(() => {
    void runGitHubRunnerHeartbeat();
  }, intervalMs);
  timer.unref?.();
}

function scheduleGitHubReconciler() {
  if (process.env.RUNNERLY_RECONCILE_ENABLED === "false") {
    return;
  }

  const intervalMs = Number.parseInt(process.env.RUNNERLY_RECONCILE_INTERVAL_MS ?? "300000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
    console.warn("RUNNERLY_RECONCILE_INTERVAL_MS must be at least 60000; scheduled reconciliation disabled");
    return;
  }

  const initialDelay = Math.min(5_000, intervalMs);
  const initialTimer = setTimeout(() => {
    void runGitHubReconcile();
  }, initialDelay);
  initialTimer.unref?.();

  const timer = setInterval(() => {
    void runGitHubReconcile();
  }, intervalMs);
  timer.unref?.();
}

function scheduleDatabaseBackups() {
  if (process.env.RUNNERLY_BACKUP_ENABLED === "false") {
    return;
  }

  const intervalMs = Number.parseInt(process.env.RUNNERLY_BACKUP_INTERVAL_MS ?? "86400000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 3_600_000) {
    console.warn("RUNNERLY_BACKUP_INTERVAL_MS must be at least 3600000; scheduled backups disabled");
    return;
  }

  const initialDelay = Number.parseInt(process.env.RUNNERLY_BACKUP_INITIAL_DELAY_MS ?? "60000", 10);
  const initialTimer = setTimeout(() => {
    void runDatabaseBackup();
  }, Number.isFinite(initialDelay) && initialDelay >= 0 ? initialDelay : 60_000);
  initialTimer.unref?.();

  const timer = setInterval(() => {
    void runDatabaseBackup();
  }, intervalMs);
  timer.unref?.();
}

async function serveStatic(request, pathname, response) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(normalized);
  const requestedPath = resolve(dashboardRoot, `.${decodedPath}`);

  const publicAsset = isPublicStaticAsset(decodedPath);
  if (isAdminAuthEnabled() && !publicAsset) {
    try {
      requireAdmin(request);
    } catch {
      redirectToLogin(response);
      return;
    }
  }

  if (!requestedPath.startsWith(`${dashboardRoot}${sep}`) && requestedPath !== dashboardRoot) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  if (!existsSync(requestedPath)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(requestedPath),
    "cache-control": "no-store"
  });
  createReadStream(requestedPath).pipe(response);
}

function isPublicStaticAsset(pathname) {
  if (["/login.html", "/login.js", "/styles.css"].includes(pathname)) {
    return true;
  }

  return pathname.startsWith("/assets/")
    && !pathname.includes("..")
    && !pathname.includes("\\");
}

async function readJson(request) {
  const body = await readRequestBody(request);

  if (!body.toString("utf8").trim()) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) {
      throw new Error("request_body_too_large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(payload.statusCode ?? statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendJsonDownload(response, fileName, payload) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendCsv(response, fileName, rows) {
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store"
  });
  response.end(`${rows.map(csvRow).join("\n")}\n`);
}

function csvRow(values) {
  return values.map((value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",");
}

function exportStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function contentTypeFor(filePath) {
  const extension = extname(filePath);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  };
  return types[extension] ?? "application/octet-stream";
}
