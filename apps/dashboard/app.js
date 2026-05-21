const state = {
  overview: null,
  github: null,
  onboarding: null,
  policy: null,
  workflows: null,
  reconcile: null,
  backups: null,
  liveEvent: null
};

const copyValues = new Map();
const hiddenLabels = new Set(["portfolio-demo", "lab-host"]);

const elements = {
  auditRows: document.querySelector("#auditRows"),
  backupButton: document.querySelector("#backupButton"),
  backupStatus: document.querySelector("#backupStatus"),
  busyRunnerCount: document.querySelector("#busyRunnerCount"),
  githubDetails: document.querySelector("#githubDetails"),
  githubStatus: document.querySelector("#githubStatus"),
  healthAlerts: document.querySelector("#healthAlerts"),
  healthStatus: document.querySelector("#healthStatus"),
  jobRows: document.querySelector("#jobRows"),
  lastUpdated: document.querySelector("#lastUpdated"),
  liveEventDetails: document.querySelector("#liveEventDetails"),
  liveStatus: document.querySelector("#liveStatus"),
  medianPickupSeconds: document.querySelector("#medianPickupSeconds"),
  onboardingCards: document.querySelector("#onboardingCards"),
  onboardingUpdated: document.querySelector("#onboardingUpdated"),
  onlineRunnerCount: document.querySelector("#onlineRunnerCount"),
  policyIssueCount: document.querySelector("#policyIssueCount"),
  policyRows: document.querySelector("#policyRows"),
  policySummary: document.querySelector("#policySummary"),
  privateRepositoryCount: document.querySelector("#privateRepositoryCount"),
  queuedJobCount: document.querySelector("#queuedJobCount"),
  reconcileButton: document.querySelector("#reconcileButton"),
  reconcileStatus: document.querySelector("#reconcileStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  repoRows: document.querySelector("#repoRows"),
  runningJobCount: document.querySelector("#runningJobCount"),
  runnerList: document.querySelector("#runnerList"),
  webhookEventDetails: document.querySelector("#webhookEventDetails"),
  workflowRows: document.querySelector("#workflowRows"),
  workflowSummary: document.querySelector("#workflowSummary")
};

let liveRefreshTimer = null;

elements.refreshButton.addEventListener("click", () => loadOverview());
elements.reconcileButton.addEventListener("click", reconcileNow);
elements.backupButton.addEventListener("click", backupNow);
document.addEventListener("click", copyFromButton);
await loadOverview();
connectLiveEvents();

async function loadOverview(options = {}) {
  const background = Boolean(options.background);
  if (!background) {
    elements.refreshButton.disabled = true;
  }
  try {
    const [overviewResponse, githubResponse, onboardingResponse, policyResponse, workflowsResponse, reconcileResponse, backupsResponse] = await Promise.all([
      fetch("/api/overview", { cache: "no-store" }),
      fetch("/api/github/status", { cache: "no-store" }),
      fetch("/api/onboarding", { cache: "no-store" }),
      fetch("/api/policy", { cache: "no-store" }),
      fetch("/api/workflows", { cache: "no-store" }),
      fetch("/api/reconcile", { cache: "no-store" }),
      fetch("/api/backups", { cache: "no-store" })
    ]);

    if (
      overviewResponse.status === 401 ||
      githubResponse.status === 401 ||
      onboardingResponse.status === 401 ||
      policyResponse.status === 401 ||
      workflowsResponse.status === 401 ||
      reconcileResponse.status === 401 ||
      backupsResponse.status === 401
    ) {
      window.location.assign("/login.html");
      return;
    }

    if (!overviewResponse.ok) {
      throw new Error(`API returned ${overviewResponse.status}`);
    }

    state.overview = await overviewResponse.json();
    state.github = githubResponse.ok ? await githubResponse.json() : null;
    state.onboarding = onboardingResponse.ok ? await onboardingResponse.json() : null;
    state.policy = policyResponse.ok ? await policyResponse.json() : state.overview.policy;
    state.workflows = workflowsResponse.ok ? await workflowsResponse.json() : null;
    state.reconcile = reconcileResponse.ok ? await reconcileResponse.json() : null;
    state.backups = backupsResponse.ok ? await backupsResponse.json() : null;
    render();
  } catch (error) {
    if (!background) {
      renderError(error);
    }
  } finally {
    if (!background) {
      elements.refreshButton.disabled = false;
    }
  }
}

function connectLiveEvents() {
  if (!("EventSource" in window)) {
    updateLiveStatus("offline", "Live updates unavailable");
    return;
  }

  const events = new EventSource("/api/events");
  events.addEventListener("open", () => {
    updateLiveStatus("online", "Live updates on");
  });
  events.addEventListener("runnerly", (event) => {
    const payload = parseLiveEvent(event);
    if (!payload) {
      return;
    }
    updateLiveStatus("online", `Live ${payload.reason ? payload.reason.replaceAll("_", " ") : payload.type}`);
    state.liveEvent = payload;
    renderLiveOperations(state.overview?.health, state.liveEvent, state.overview?.lastWebhook);
    if (payload.type === "refresh") {
      scheduleLiveRefresh();
    }
  });
  events.addEventListener("error", () => {
    updateLiveStatus("offline", "Live reconnecting");
  });
}

function parseLiveEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function scheduleLiveRefresh() {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    void loadOverview({ background: true });
  }, 500);
}

function updateLiveStatus(status, message) {
  if (!elements.liveStatus) {
    return;
  }
  elements.liveStatus.className = `live-status ${status}`;
  elements.liveStatus.textContent = message;
}

async function reconcileNow() {
  elements.reconcileButton.disabled = true;
  elements.reconcileButton.textContent = "Reconciling";
  try {
    const response = await fetch("/api/reconcile", {
      method: "POST",
      cache: "no-store"
    });

    if (response.status === 401) {
      window.location.assign("/login.html");
      return;
    }

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    state.reconcile = await response.json();
    await loadOverview();
  } catch (error) {
    renderError(error);
  } finally {
    elements.reconcileButton.disabled = false;
    elements.reconcileButton.textContent = "Reconcile GitHub";
  }
}

async function backupNow() {
  elements.backupButton.disabled = true;
  elements.backupButton.textContent = "Backing up";
  try {
    const response = await fetch("/api/backups", {
      method: "POST",
      cache: "no-store"
    });

    if (response.status === 401) {
      window.location.assign("/login.html");
      return;
    }

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    state.backups = await response.json();
    renderBackups(state.backups);
  } catch (error) {
    renderError(error);
  } finally {
    elements.backupButton.disabled = false;
    elements.backupButton.textContent = "Create backup";
  }
}

function render() {
  const overview = state.overview;
  elements.onlineRunnerCount.textContent = overview.summary.onlineRunnerCount;
  elements.busyRunnerCount.textContent = overview.summary.busyRunnerCount;
  elements.privateRepositoryCount.textContent = overview.summary.privateRepositoryCount;
  elements.queuedJobCount.textContent = overview.summary.queuedJobCount;
  elements.runningJobCount.textContent = overview.summary.runningJobCount;
  elements.medianPickupSeconds.textContent = formatSeconds(overview.summary.medianPickupSeconds);
  elements.policyIssueCount.textContent = state.policy?.summary
    ? state.policy.summary.violationCount + state.policy.summary.warningCount
    : overview.policy?.summary?.violationCount ?? 0;
  elements.lastUpdated.textContent = `Updated ${formatTime(overview.generatedAt)}`;

  renderRunners(overview.runners, overview.jobs);
  renderRepositories(overview.repositories);
  renderJobs(overview.jobs);
  renderAuditEvents(overview.auditEvents);
  renderGitHub(state.github?.github);
  renderLiveOperations(overview.health, state.liveEvent ?? overview.lastEvent, overview.lastWebhook);
  renderPolicy(state.policy ?? overview.policy);
  renderReconcileStatus(state.reconcile?.reconcile ?? overview.reconcile, overview.runnerHeartbeat);
  renderBackups(state.backups);
  renderOnboarding(state.onboarding);
  renderWorkflowInventory(state.workflows);
}

function renderLiveOperations(health, liveEvent, lastWebhook) {
  if (elements.healthStatus) {
    const healthStatus = health?.status ?? "waiting";
    elements.healthStatus.textContent = healthStatus;
    elements.healthStatus.className = `status ${escapeHtml(healthStatus === "ok" ? "ready" : healthStatus)}`;
  }

  if (elements.liveEventDetails) {
    elements.liveEventDetails.innerHTML = renderSignalCard({
      label: "Last control-plane event",
      title: liveEvent?.reason ? liveEvent.reason.replaceAll("_", " ") : liveEvent?.type ?? "waiting",
      detail: liveEvent
        ? signalDetails([
          ["event", liveEvent.event],
          ["action", liveEvent.action],
          ["repository", liveEvent.repository],
          ["runner", liveEvent.runnerId],
          ["reason", liveEvent.reason]
        ])
        : "No live event received yet",
      timestamp: liveEvent?.generatedAt
    });
  }

  if (elements.webhookEventDetails) {
    elements.webhookEventDetails.innerHTML = renderSignalCard({
      label: "Last GitHub webhook",
      title: lastWebhook?.event ?? "waiting",
      detail: lastWebhook
        ? signalDetails([
          ["action", lastWebhook.action],
          ["repository", lastWebhook.repository]
        ])
        : "No GitHub webhook recorded yet",
      timestamp: lastWebhook?.generatedAt
    });
  }

  if (!elements.healthAlerts) {
    return;
  }

  const alerts = health?.alerts ?? [];
  if (!alerts.length) {
    elements.healthAlerts.innerHTML = `
      <div class="alert-item ready">
        <span class="status ready">ok</span>
        <strong>Control plane healthy</strong>
        <span>No runner, webhook, reconcile, or budget guardrail alerts.</span>
      </div>
    `;
    return;
  }

  elements.healthAlerts.innerHTML = alerts.map((alert) => `
    <div class="alert-item ${escapeHtml(alert.severity)}">
      <span class="status ${escapeHtml(alert.severity === "notice" ? "observe" : alert.severity)}">${escapeHtml(alert.severity)}</span>
      <strong>${escapeHtml(alert.target ?? alert.kind)}</strong>
      <span>${escapeHtml(alert.message)}</span>
      ${alert.observedAt ? `<small>${escapeHtml(formatTime(alert.observedAt))}</small>` : ""}
    </div>
  `).join("");
}

function renderSignalCard({ label, title, detail, timestamp }) {
  return `
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(title ?? "waiting")}</strong>
    <p>${escapeHtml(detail)}</p>
    <small>${escapeHtml(timestamp ? formatTime(timestamp) : "No timestamp")}</small>
  `;
}

function signalDetails(entries) {
  return entries
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ") || "No additional detail";
}

function renderRunners(runners, jobs) {
  if (!runners.length) {
    elements.runnerList.innerHTML = emptyState("No runners registered");
    return;
  }

  elements.runnerList.innerHTML = `
    <div class="fleet-console">
      <table class="fleet-table">
        <thead>
          <tr>
            <th>Runner</th>
            <th>Labels</th>
            <th>Status</th>
            <th>Lane</th>
            <th>Current job</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          ${runners.map((runner) => {
            const group = runner.metadata?.githubRunner?.runnerGroupName ?? runner.metadata?.runnerGroupName ?? "unknown";
            const arch = runner.metadata?.arch ?? labelValue(runner.labels, "arm64", "unknown");
            const currentJob = activeJobForRunner(runner, jobs);
            return `
              <tr>
                <td>
                  <div class="runner-identity">
                    <strong>${escapeHtml(runner.name)}</strong>
                    <span>${escapeHtml(runner.hostname)}</span>
                    <span>${escapeHtml(runnerOrigin(runner))}</span>
                  </div>
                </td>
                <td>
                  <div class="labels">${labelPills(runner.labels)}</div>
                </td>
                <td>
                  <span class="status ${escapeHtml(runner.status)}">${escapeHtml(runner.status)}</span>
                  ${runner.busy ? `<span class="status running">busy</span>` : `<span class="status ready">idle</span>`}
                  <span class="fleet-muted">Last seen ${formatTime(runner.lastSeenAt)}</span>
                </td>
                <td>
                  <div class="runner-scope">
                    <strong>${escapeHtml(runnerLane(runner))}</strong>
                    <span>${escapeHtml(runnerScope(runner))}</span>
                    <span>Group ${escapeHtml(group)} · ${escapeHtml(arch)}</span>
                  </div>
                </td>
                <td>${renderJobMotion(currentJob, runner.busy)}</td>
                <td>${renderRunnerEvidence(runner.metadata?.checks ?? [])}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderReconcileStatus(reconcile, heartbeat) {
  if (!reconcile && !heartbeat) {
    elements.reconcileStatus.innerHTML = "";
    return;
  }

  const reconcileStatus = reconcile?.failed ? "failed" : reconcile?.skipped ? "waiting" : "ready";
  const reconcileMessage = !reconcile
    ? "full reconcile not run"
    : reconcile.failed
      ? reconcile.message
      : reconcile.skipped
        ? reconcile.reason
        : `${reconcile.onlineRunnerCount ?? 0} online, ${reconcile.busyRunnerCount ?? 0} busy, ${reconcile.privateRepositoryCount ?? 0} private repos`;
  const heartbeatStatus = heartbeat?.failed ? "failed" : heartbeat?.skipped ? "waiting" : "online";
  const heartbeatMessage = !heartbeat
    ? "runner heartbeat not run"
    : heartbeat.failed
      ? heartbeat.message
      : heartbeat.skipped
        ? heartbeat.reason
        : `${heartbeat.onlineRunnerCount ?? 0} online, ${heartbeat.busyRunnerCount ?? 0} busy`;

  elements.reconcileStatus.innerHTML = `
    <span class="status ${escapeHtml(reconcileStatus)}">${escapeHtml(reconcile?.failed ? "failed" : reconcile?.skipped ? "waiting" : "reconciled")}</span>
    <strong>${escapeHtml(reconcileMessage ?? "not run")}</strong>
    <span>${escapeHtml(reconcile?.generatedAt ? `Full ${formatTime(reconcile.generatedAt)}` : "Full not run")}</span>
    <span class="status ${escapeHtml(heartbeatStatus)}">${escapeHtml(heartbeat?.failed ? "failed" : heartbeat?.skipped ? "waiting" : "heartbeat")}</span>
    <strong>${escapeHtml(heartbeatMessage ?? "not run")}</strong>
    <span>${escapeHtml(heartbeat?.generatedAt ? `Light ${formatTime(heartbeat.generatedAt)}` : "Light not run")}</span>
  `;
}

function renderGitHub(github) {
  if (!github) {
    elements.githubStatus.textContent = "Unknown";
    elements.githubStatus.className = "status degraded";
    elements.githubDetails.innerHTML = emptyState("GitHub status unavailable");
    return;
  }

  elements.githubStatus.textContent = github.configured ? "Configured" : "Not configured";
  elements.githubStatus.className = `status ${github.configured ? "online" : "degraded"}`;
  elements.githubDetails.innerHTML = [
    ["Mode", github.mode ?? "unknown"],
    ["GitHub App", github.appIdConfigured ? "ready" : "missing"],
    ["Installation", github.installationIdConfigured ? "ready" : "missing"],
    ["Private key", github.privateKeyConfigured ? "ready" : "missing"],
    ["Runner scope", github.runnerRegistrationScope === "org" ? "organization" : "repository"],
    ["Webhook secret", github.webhookSecretConfigured ? "ready" : "missing"],
    ["Webhook URL", github.publicWebhookUrl ?? "not set"],
    ["Allowed repos", github.allowedRepositories?.length ? github.allowedRepositories.map((repo) => `${repo.owner}/${repo.repo}`).join(", ") : "all accepted"]
  ].map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderPolicy(policy) {
  if (!policy) {
    elements.policySummary.innerHTML = "";
    elements.policyRows.innerHTML = `<tr><td colspan="4">${emptyState("Policy data unavailable")}</td></tr>`;
    return;
  }

  elements.policySummary.innerHTML = [
    ["Violations", policy.summary.violationCount],
    ["Warnings", policy.summary.warningCount],
    ["Public groups", policy.summary.runnerGroupPublicAccessCount],
    ["Broad jobs", policy.summary.broadSelfHostedWorkflowCount]
  ].map(([label, value]) => `<span><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</span>`).join("");

  const rows = [
    ...policy.runnerGroupPolicies.map((item) => ({
      scope: `Runner group: ${item.name}`,
      status: item.status,
      guardrail: item.allowsPublicRepositories ? "Public repositories allowed" : "Public repositories blocked",
      evidence: `${item.visibility} visibility · ${item.detail}`
    })),
    ...policy.repositoryPolicies.map((item) => ({
      scope: item.repository,
      status: item.status,
      guardrail: item.selfHostedAllowed ? "Self-hosted eligible" : "GitHub-hosted/webhook only",
      evidence: `${item.visibility} · ${item.detail}`
    })),
    ...policy.workflowFindings.map((item) => ({
      scope: `${item.repository} / ${item.workflow}`,
      status: item.severity,
      guardrail: item.kind === "public-self-hosted" ? "Public self-hosted blocked" : "Specific runner class required",
      evidence: item.targetRunsOn
        ? `${item.detail} Target ${item.targetRunsOn}`
        : item.detail
    }))
  ];

  if (!rows.length) {
    elements.policyRows.innerHTML = `<tr><td colspan="4">${emptyState("No policy data observed")}</td></tr>`;
    return;
  }

  elements.policyRows.innerHTML = rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.scope)}</strong></td>
      <td><span class="status ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.guardrail)}</td>
      <td><span class="fleet-muted">${escapeHtml(row.evidence)}</span></td>
    </tr>
  `).join("");
}

function renderOnboarding(payload) {
  copyValues.clear();

  if (!payload?.onboarding?.length) {
    elements.onboardingUpdated.textContent = "Waiting for data";
    elements.onboardingCards.innerHTML = emptyState("No repositories ready for onboarding");
    return;
  }

  elements.onboardingUpdated.textContent = `Updated ${formatTime(payload.generatedAt)}`;
  elements.onboardingCards.innerHTML = payload.onboarding.map((item, index) => {
    const installKey = `install-${index}`;
    const workflowKey = `workflow-${index}`;
    const installCommand = sanitizePublicSnippet(item.installCommand);
    const workflowSnippet = sanitizePublicSnippet(item.workflowSnippet);
    copyValues.set(installKey, installCommand);
    copyValues.set(workflowKey, workflowSnippet);

    const latestJob = item.latestJob
      ? `${item.latestJob.workflow ?? "Workflow"} ${item.latestJob.status} · ${formatTime(item.latestJob.updatedAt ?? item.latestJob.completedAt ?? item.latestJob.startedAt)}`
      : "No jobs observed";
    const webhookDetail = item.latestWebhookEvent
      ? `${item.latestWebhookEvent.status ?? "event"} · ${formatTime(item.latestWebhookEvent.createdAt)}`
      : item.webhookStatus === "waiting" ? "Secret configured, waiting for first event" : "Not configured";
    const runnerDetail = item.onlineRunnerCount
      ? `${item.onlineRunnerCount} online of ${item.runnerCount} matching`
      : item.runnerCount ? `${item.runnerCount} matching but offline` : "No matching runner";
    const registrationLabel = item.registrationMode === "app-token" ? "GitHub App token" : "Manual token";
    const registrationDetail = item.registrationMode === "app-token"
      ? "Runnerly can mint short-lived registration tokens"
      : "Paste a one-time token from GitHub runner settings";
    const matchingRunners = item.matchingRunners.length
      ? `<div class="matching-runners">${item.matchingRunners.map((runner) => `
          <span><strong>${escapeHtml(runner.name)}</strong> ${escapeHtml(runner.status)} · last seen ${formatTime(runner.lastSeenAt)}</span>
        `).join("")}</div>`
      : `<div class="matching-runners muted">No runner has reported this repo and label set yet.</div>`;

    return `
      <article class="onboarding-card">
        <div class="card-heading">
          <div>
            <h3>${escapeHtml(item.repository)}</h3>
            <p class="meta">${escapeHtml(item.visibility)} · ${labelPills(item.requiredLabels)}</p>
          </div>
          <span class="status ${escapeHtml(item.runnerStatus)}">${escapeHtml(item.runnerStatus)}</span>
        </div>
        <div class="readiness-grid">
          ${readinessItem("Runner coverage", item.runnerStatus, runnerDetail)}
          ${readinessItem("Webhook telemetry", item.webhookStatus, webhookDetail)}
          ${readinessItem("Latest job", item.latestJob?.status ?? "waiting", latestJob)}
          ${readinessItem("Registration", item.registrationMode === "app-token" ? "ready" : "manual", registrationDetail, registrationLabel)}
        </div>
        ${matchingRunners}
        <div class="setup-grid">
          ${setupBlock("Workflow target", workflowSnippet, workflowKey)}
          ${setupBlock("Runner install", installCommand, installKey)}
        </div>
      </article>
    `;
  }).join("");
}

function readinessItem(label, status, detail, value = status) {
  return `
    <div class="readiness-item">
      <span>${escapeHtml(label)}</span>
      <strong><span class="status ${escapeHtml(status)}">${escapeHtml(value)}</span></strong>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function setupBlock(title, value, copyKey) {
  return `
    <div class="setup-block">
      <div class="setup-heading">
        <strong>${escapeHtml(title)}</strong>
        <button type="button" data-copy-key="${escapeAttribute(copyKey)}">Copy</button>
      </div>
      <pre><code>${escapeHtml(value)}</code></pre>
    </div>
  `;
}

function renderChecks(checks) {
  if (!checks.length) {
    return "";
  }

  return `
    <div class="checks">
      ${checks.slice(0, 6).map((check) => `
        <span class="check ${escapeHtml(check.status)}">${escapeHtml(check.name)}: ${escapeHtml(check.detail ?? check.status)}</span>
      `).join("")}
    </div>
  `;
}

function renderRunnerEvidence(checks) {
  if (!checks.length) {
    return `<span class="muted">No checks reported</span>`;
  }

  return `
    <div class="check-stack">
      ${checks.slice(0, 3).map((check) => `
        <span class="check ${escapeHtml(check.status)}">
          <strong>${escapeHtml(check.name)}</strong>
          ${escapeHtml(check.detail ?? check.status)}
        </span>
      `).join("")}
      ${checks.length > 3 ? `<span class="fleet-muted">+${checks.length - 3} more checks</span>` : ""}
    </div>
  `;
}

function renderRepositories(repositories) {
  if (!repositories.length) {
    elements.repoRows.innerHTML = `<tr><td colspan="3">${emptyState("No repositories allowed")}</td></tr>`;
    return;
  }

  elements.repoRows.innerHTML = repositories.map((repo) => `
    <tr>
      <td><strong>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</strong></td>
      <td>${escapeHtml(repo.visibility)}</td>
      <td>${labelPills(repo.allowedLabels)}</td>
    </tr>
  `).join("");
}

function renderWorkflowInventory(payload) {
  if (!payload) {
    elements.workflowSummary.innerHTML = "";
    elements.workflowRows.innerHTML = `<tr><td colspan="5">${emptyState("Workflow inventory unavailable")}</td></tr>`;
    return;
  }

  const rows = payload.repositories.flatMap((repo) => (
    repo.workflows.length
      ? repo.workflows.map((workflow) => ({ repo, workflow }))
      : [{ repo, workflow: null }]
  ));

  elements.workflowSummary.innerHTML = [
    ["Private repos", payload.summary.privateRepositoryCount],
    ["Candidates", payload.summary.candidateCount],
    ["Self-hosted", payload.summary.selfHostedWorkflowCount],
    ["Public telemetry", payload.summary.publicRepositoryCount]
  ].map(([label, value]) => `<span><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</span>`).join("");

  if (!rows.length) {
    elements.workflowRows.innerHTML = `<tr><td colspan="5">${emptyState("No private repositories in policy")}</td></tr>`;
    return;
  }

  elements.workflowRows.innerHTML = rows.map(({ repo, workflow }) => {
    if (!workflow) {
      return `
        <tr>
          <td><strong>${escapeHtml(repo.repository)}</strong><span class="fleet-muted">${escapeHtml(repo.visibility)}</span></td>
          <td><span class="muted">No workflow events observed yet</span></td>
          <td><span class="muted">unknown</span></td>
          <td><span class="status waiting">Observe</span><span class="fleet-muted">Waiting for webhook telemetry</span></td>
          <td><code>[self-hosted, linux, arm64, build-worker]</code></td>
        </tr>
      `;
    }

    const recommendation = workflow.recommendation;
    return `
      <tr>
        <td><strong>${escapeHtml(repo.repository)}</strong><span class="fleet-muted">${escapeHtml(repo.visibility)}</span></td>
        <td>${workflow.latestJob.url ? `<a href="${escapeAttribute(workflow.latestJob.url)}">${escapeHtml(workflow.workflow)}</a>` : escapeHtml(workflow.workflow)}</td>
        <td>
          <strong>${escapeHtml(workflow.runner.name)}</strong>
          <span class="fleet-muted">${escapeHtml(workflow.runner.detail)}</span>
        </td>
        <td>
          <span class="status ${escapeHtml(recommendation.kind)}">${escapeHtml(recommendation.label)}</span>
          <span class="fleet-muted">${escapeHtml(recommendation.detail)}</span>
        </td>
        <td>${recommendation.targetRunsOn ? `<code>${escapeHtml(recommendation.targetRunsOn)}</code>` : `<span class="muted">No change</span>`}</td>
      </tr>
    `;
  }).join("");
}

function renderJobs(jobs) {
  if (!jobs.length) {
    elements.jobRows.innerHTML = `<tr><td colspan="5">${emptyState("No jobs observed")}</td></tr>`;
    return;
  }

  elements.jobRows.innerHTML = jobs.map((job) => {
    const runner = jobRunnerLabel(job);

    return `
      <tr>
        <td>${job.url ? `<a href="${escapeAttribute(job.url)}">${escapeHtml(job.workflow)}</a>` : escapeHtml(job.workflow)}</td>
        <td>${escapeHtml(job.repository ?? "Unknown")}</td>
        <td>
          <strong>${escapeHtml(runner.name)}</strong>
          <span class="fleet-muted">${escapeHtml(runner.detail)}</span>
        </td>
        <td><span class="status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></td>
        <td>
          <strong>${escapeHtml(jobTiming(job))}</strong>
          <span class="fleet-muted">${escapeHtml(job.conclusion ?? "latest signal")}</span>
        </td>
      </tr>
    `;
  }).join("");
}

function renderBackups(payload) {
  if (!payload) {
    elements.backupStatus.innerHTML = emptyState("Backup status unavailable");
    return;
  }

  const latest = payload.backups?.at(0);
  const status = payload.backup?.failed ? "failed" : latest ? "ready" : "waiting";
  const detail = payload.backup?.failed
    ? payload.backup.message
    : latest
      ? `${formatBytes(latest.bytes)} · ${formatTime(latest.updatedAt)}`
      : "No backups yet";

  elements.backupStatus.innerHTML = `
    <div class="backup-head">
      <span class="status ${escapeHtml(status)}">${escapeHtml(status === "ready" ? "current" : status)}</span>
      <strong>${escapeHtml(detail ?? "not run")}</strong>
      <span>${escapeHtml(`${payload.backups?.length ?? 0} retained`)}</span>
    </div>
    ${payload.backups?.length ? `
      <ol class="backup-list">
        ${payload.backups.slice(0, 5).map((backup) => `
          <li>
            <strong>${escapeHtml(backup.fileName)}</strong>
            <span>${escapeHtml(formatBytes(backup.bytes))} · ${escapeHtml(formatTime(backup.updatedAt))}</span>
          </li>
        `).join("")}
      </ol>
    ` : ""}
  `;
}

function renderAuditEvents(events) {
  if (!events.length) {
    elements.auditRows.innerHTML = emptyState("No audit events recorded");
    return;
  }

  elements.auditRows.innerHTML = events.map((event) => `
    <li>
      <time>${formatTime(event.createdAt)}</time>
      <strong>${escapeHtml(event.action)}</strong>
      <span>${escapeHtml(event.target)}</span>
    </li>
  `).join("");
}

function renderError(error) {
  elements.lastUpdated.textContent = "Control plane unavailable";
  elements.runnerList.innerHTML = emptyState(error.message);
}

function runnerOrigin(runner) {
  if (runner.metadata?.githubRunner?.external || runner.metadata?.source === "github-webhook") {
    return "Self-hosted runner";
  }

  if (runner.metadata?.provider) {
    return "Runnerly-managed host";
  }

  return "Runnerly agent";
}

function jobRunnerLabel(job) {
  if (job.runnerId) {
    return {
      name: job.runnerId,
      detail: displayLabels(job.labels ?? []).join(" ") || "self-hosted"
    };
  }

  if (isGitHubHostedJob(job)) {
    return {
      name: "GitHub-hosted",
      detail: displayLabels(job.labels ?? []).join(" ") || "ephemeral"
    };
  }

  return {
    name: "pending",
    detail: displayLabels(job.labels ?? []).join(" ") || "not assigned"
  };
}

function activeJobForRunner(runner, jobs) {
  return jobs.find((job) => (
    job.runnerId === runner.id &&
    ["running", "queued"].includes(job.status)
  )) ?? null;
}

function renderJobMotion(job, runnerBusy) {
  if (job) {
    const pulse = job.status === "queued" ? `<span class="pulse-dot" aria-hidden="true"></span>` : "";
    const progress = job.status === "running" ? `<span class="job-progress" aria-hidden="true"><span></span></span>` : "";
    return `
      <div class="job-motion ${escapeHtml(job.status)}">
        ${progress}${pulse}
        <strong>${job.url ? `<a href="${escapeAttribute(job.url)}">${escapeHtml(job.workflow)}</a>` : escapeHtml(job.workflow)}</strong>
        <span>${escapeHtml(job.repository ?? "unknown repository")}</span>
      </div>
    `;
  }

  if (runnerBusy) {
    return `
      <div class="job-motion running">
        <span class="job-progress" aria-hidden="true"><span></span></span>
        <strong>Runner busy</strong>
        <span>Waiting for workflow_job event</span>
      </div>
    `;
  }

  return `<span class="muted">idle · waiting</span>`;
}

function isGitHubHostedJob(job) {
  return normalizeLabels(job.labels ?? []).some((label) => (
    label.startsWith("ubuntu-") ||
    label.startsWith("windows-") ||
    label.startsWith("macos-")
  ));
}

function runnerScope(runner) {
  if (runner.scope === "org") {
    return `Organization: ${runner.owner ?? "GitHub"}`;
  }

  const githubRunner = runner.metadata?.githubRunner;
  if (githubRunner?.scope === "org" || (githubRunner?.owner && !githubRunner?.repo && !githubRunner?.repository)) {
    return `Organization: ${githubRunner.owner}`;
  }

  const repositories = runner.metadata?.githubRunner?.repositories;
  if (repositories?.length) {
    return repositories.join(", ");
  }

  if (runner.metadata?.githubRunner?.repository) {
    return runner.metadata.githubRunner.repository;
  }

  return "fleet";
}

function runnerLane(runner) {
  const labels = normalizeLabels(runner.labels ?? []);
  if (labels.includes("scanner")) {
    return "Scanner";
  }

  if (labels.includes("heavy-build")) {
    return "Heavy build";
  }

  if (labels.includes("build-worker")) {
    return "Build worker";
  }

  return labels.includes("self-hosted") ? "General worker" : "Control";
}

function labelValue(labels, expected, fallback) {
  return normalizeLabels(labels).includes(expected) ? expected : fallback;
}

function labelPills(labels) {
  const visibleLabels = displayLabels(labels);

  if (!visibleLabels.length) {
    return `<span class="muted">none</span>`;
  }

  return visibleLabels.map((label) => `<span class="label">${escapeHtml(label)}</span>`).join(" ");
}

function normalizeLabels(labels) {
  return labels.map((label) => String(label).toLowerCase());
}

function displayLabels(labels = []) {
  return labels.filter((label) => !hiddenLabels.has(String(label).toLowerCase()));
}

function sanitizePublicSnippet(value) {
  return String(value ?? "")
    .replaceAll(", arm64-lab", "")
    .replaceAll(",arm64-lab", "")
    .replaceAll("+arm64-lab", "")
    .replaceAll(" arm64-lab", "");
}

function jobTiming(job) {
  if (Number.isFinite(job.pickupSeconds)) {
    return `pickup ${formatSeconds(job.pickupSeconds)}`;
  }

  if (Number.isFinite(job.durationSeconds)) {
    return `ran ${formatSeconds(job.durationSeconds)}`;
  }

  return formatTime(job.updatedAt ?? job.completedAt ?? job.startedAt ?? job.queuedAt);
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (value < 60) {
    return `${value}s`;
  }

  const minutes = Math.round(value / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) {
    return "--";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function copyFromButton(event) {
  const button = event.target.closest("[data-copy-key]");
  if (!button) {
    return;
  }

  const value = copyValues.get(button.dataset.copyKey);
  if (!value) {
    return;
  }

  await navigator.clipboard.writeText(value);
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function emptyState(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function formatTime(value) {
  if (!value) {
    return "never";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
