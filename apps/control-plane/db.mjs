import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeLabels, validateJobRecord, validateRepositoryRecord, validateRunnerHeartbeat } from "../../packages/shared/schema.mjs";

const now = () => new Date().toISOString();

export function openRunnerlyDatabase(dbPath = ".runnerly/runnerly.sqlite") {
  const resolvedPath = resolve(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  if (process.env.RUNNERLY_SEED_DEMO_DATA !== "false") {
    seedDemoData(db);
  }
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      status TEXT NOT NULL,
      github_runner_id TEXT,
      busy INTEGER NOT NULL DEFAULT 0,
      runner_group_name TEXT,
      scope TEXT,
      owner TEXT,
      repo TEXT,
      last_seen_at TEXT,
      version TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL,
      allowed_labels_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, owner, name)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      runner_id TEXT,
      github_run_id TEXT,
      github_job_id TEXT,
      workflow TEXT NOT NULL,
      status TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      queued_at TEXT,
      picked_up_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      conclusion TEXT,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repository_id) REFERENCES repositories(id),
      FOREIGN KEY(runner_id) REFERENCES runners(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, "jobs", "github_job_id", "TEXT");
  addColumnIfMissing(db, "jobs", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "jobs", "queued_at", "TEXT");
  addColumnIfMissing(db, "jobs", "picked_up_at", "TEXT");
  addColumnIfMissing(db, "jobs", "conclusion", "TEXT");
  addColumnIfMissing(db, "runners", "github_runner_id", "TEXT");
  addColumnIfMissing(db, "runners", "busy", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "runners", "runner_group_name", "TEXT");
  addColumnIfMissing(db, "runners", "scope", "TEXT");
  addColumnIfMissing(db, "runners", "owner", "TEXT");
  addColumnIfMissing(db, "runners", "repo", "TEXT");
}

export function listOverview(db) {
  const runners = listRunners(db);
  const repositories = listRepositories(db);
  const jobs = listJobs(db);
  const auditEvents = listAuditEvents(db);

  return {
    generatedAt: now(),
    summary: {
      runnerCount: runners.length,
      onlineRunnerCount: runners.filter((runner) => runner.status === "online").length,
      busyRunnerCount: runners.filter((runner) => runner.busy).length,
      repositoryCount: repositories.length,
      privateRepositoryCount: repositories.filter((repository) => repository.visibility !== "public").length,
      publicRepositoryCount: repositories.filter((repository) => repository.visibility === "public").length,
      activeJobCount: jobs.filter((job) => ["queued", "running"].includes(job.status)).length,
      queuedJobCount: jobs.filter((job) => job.status === "queued").length,
      runningJobCount: jobs.filter((job) => job.status === "running").length,
      medianPickupSeconds: medianPickupSeconds(jobs)
    },
    runners,
    repositories,
    jobs,
    auditEvents
  };
}

export function listRunners(db) {
  return db
    .prepare("SELECT * FROM runners ORDER BY updated_at DESC")
    .all()
    .map(mapRunner)
    .filter(isFleetRunner);
}

export function listRepositories(db) {
  return db
    .prepare("SELECT * FROM repositories ORDER BY owner, name")
    .all()
    .map(mapRepository);
}

export function listJobs(db) {
  return db
    .prepare(`
      SELECT jobs.*, repositories.owner AS repository_owner, repositories.name AS repository_name
      FROM jobs
      LEFT JOIN repositories ON repositories.id = jobs.repository_id
      ORDER BY COALESCE(jobs.started_at, jobs.created_at) DESC
      LIMIT 50
    `)
    .all()
    .map(mapJob);
}

export function listWorkflowInventoryJobs(db) {
  return db
    .prepare(`
      SELECT jobs.*, repositories.owner AS repository_owner, repositories.name AS repository_name
      FROM jobs
      LEFT JOIN repositories ON repositories.id = jobs.repository_id
      ORDER BY COALESCE(jobs.started_at, jobs.created_at) DESC
      LIMIT 500
    `)
    .all()
    .map(mapJob);
}

export function pruneRepositoriesToPolicy(db, allowedRepositories) {
  if (!allowedRepositories.length) {
    return;
  }

  const allowedIds = new Set(allowedRepositories.map((repository) => (
    `github:${repository.owner}:${repository.repo}`
  )));

  const staleRepositories = db
    .prepare("SELECT id FROM repositories WHERE provider = 'github'")
    .all()
    .filter((repository) => !allowedIds.has(repository.id));

  for (const repository of staleRepositories) {
    db.prepare("DELETE FROM jobs WHERE repository_id = ?").run(repository.id);
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repository.id);
  }
}

export function listAuditEvents(db) {
  return db
    .prepare(`
      SELECT *
      FROM audit_events
      WHERE action <> 'runner.heartbeat'
      ORDER BY created_at DESC
      LIMIT 50
    `)
    .all()
    .map(mapAuditEvent);
}

export function listWorkflowAuditEvents(db) {
  return db
    .prepare(`
      SELECT *
      FROM audit_events
      WHERE action LIKE 'github.workflow_%'
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all()
    .map(mapAuditEvent);
}

export function listDatabaseBackups(backupDir = defaultBackupDir()) {
  const directory = resolve(backupDir);
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((fileName) => fileName.startsWith("runnerly-") && fileName.endsWith(".sqlite"))
    .map((fileName) => {
      const filePath = join(directory, fileName);
      const stats = statSync(filePath);
      return {
        fileName,
        bytes: stats.size,
        createdAt: stats.birthtime?.toISOString?.() ?? stats.mtime.toISOString(),
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function createDatabaseBackup(db, options = {}) {
  const backupDir = resolve(options.backupDir ?? defaultBackupDir());
  const retentionDays = Number.parseInt(options.retentionDays ?? process.env.RUNNERLY_BACKUP_RETENTION_DAYS ?? "14", 10);
  const maxBackups = Number.parseInt(options.maxBackups ?? process.env.RUNNERLY_BACKUP_MAX_FILES ?? "14", 10);
  const createdAt = now();
  const fileName = `runnerly-${createdAt.replaceAll(":", "-").replaceAll(".", "-")}.sqlite`;
  const filePath = join(backupDir, fileName);

  mkdirSync(backupDir, { recursive: true });
  db.prepare("VACUUM INTO ?").run(filePath);

  const stats = statSync(filePath);
  const pruned = pruneDatabaseBackups(backupDir, { retentionDays, maxBackups });
  return {
    fileName,
    bytes: stats.size,
    createdAt,
    updatedAt: stats.mtime.toISOString(),
    pruned
  };
}

export function pruneDatabaseBackups(backupDir = defaultBackupDir(), options = {}) {
  const retentionDays = Number.parseInt(options.retentionDays ?? process.env.RUNNERLY_BACKUP_RETENTION_DAYS ?? "14", 10);
  const maxBackups = Number.parseInt(options.maxBackups ?? process.env.RUNNERLY_BACKUP_MAX_FILES ?? "14", 10);
  const backups = listDatabaseBackups(backupDir);
  const cutoff = Number.isFinite(retentionDays) && retentionDays > 0
    ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
    : null;
  const keepLimit = Number.isFinite(maxBackups) && maxBackups > 0 ? maxBackups : backups.length;
  const removals = [];

  backups.forEach((backup, index) => {
    const expired = cutoff ? Date.parse(backup.updatedAt) < cutoff : false;
    const overLimit = index >= keepLimit;
    if (expired || overLimit) {
      const filePath = join(resolve(backupDir), backup.fileName);
      unlinkSync(filePath);
      removals.push({
        fileName: backup.fileName,
        reason: expired ? "expired" : "retention_limit"
      });
    }
  });

  return removals;
}

export function recordAuditEvent(db, event) {
  const createdAt = event.createdAt ?? now();
  db.prepare(`
    INSERT INTO audit_events (actor, action, target, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    event.actor ?? "system",
    event.action,
    event.target,
    JSON.stringify(event.payload ?? {}),
    createdAt
  );
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
  return row ? parseJson(row.value_json, fallback) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now());
}

export function upsertRepository(db, payload) {
  const repository = validateRepositoryRecord(payload);
  const timestamp = payload.updatedAt ?? now();
  const id = repository.id ?? `${repository.provider}:${repository.owner}:${repository.name}`;
  const allowedLabels = repository.visibility === "public"
    ? ["github-hosted"]
    : repository.allowedLabels;

  db.prepare(`
    INSERT INTO repositories (
      id, provider, owner, name, visibility, allowed_labels_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, owner, name) DO UPDATE SET
      visibility = excluded.visibility,
      allowed_labels_json = excluded.allowed_labels_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    repository.provider,
    repository.owner,
    repository.name,
    repository.visibility,
    JSON.stringify(allowedLabels),
    timestamp,
    timestamp
  );

  return mapRepository(db
    .prepare("SELECT * FROM repositories WHERE provider = ? AND owner = ? AND name = ?")
    .get(repository.provider, repository.owner, repository.name));
}

export function upsertJob(db, payload) {
  const job = validateJobRecord(payload);
  const timestamp = payload.updatedAt ?? now();

  db.prepare(`
    INSERT INTO jobs (
      id, repository_id, runner_id, github_run_id, github_job_id, workflow, status,
      labels_json, queued_at, picked_up_at, started_at, completed_at, conclusion,
      url, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repository_id = excluded.repository_id,
      runner_id = excluded.runner_id,
      github_run_id = excluded.github_run_id,
      github_job_id = excluded.github_job_id,
      workflow = excluded.workflow,
      status = excluded.status,
      labels_json = excluded.labels_json,
      queued_at = COALESCE(excluded.queued_at, jobs.queued_at),
      picked_up_at = COALESCE(excluded.picked_up_at, jobs.picked_up_at),
      started_at = COALESCE(excluded.started_at, jobs.started_at),
      completed_at = excluded.completed_at,
      conclusion = COALESCE(excluded.conclusion, jobs.conclusion),
      url = excluded.url,
      updated_at = excluded.updated_at
  `).run(
    job.id,
    job.repositoryId,
    job.runnerId,
    job.githubRunId,
    job.githubJobId,
    job.workflow,
    job.status,
    JSON.stringify(job.labels),
    job.queuedAt,
    job.pickedUpAt,
    job.startedAt,
    job.completedAt,
    job.conclusion,
    job.url,
    timestamp,
    timestamp
  );

  return mapJob(db.prepare(`
    SELECT jobs.*, repositories.owner AS repository_owner, repositories.name AS repository_name
    FROM jobs
    LEFT JOIN repositories ON repositories.id = jobs.repository_id
    WHERE jobs.id = ?
  `).get(job.id));
}

export function upsertRunnerHeartbeat(db, payload, options = {}) {
  const heartbeat = validateRunnerHeartbeat(payload);
  const timestamp = heartbeat.observedAt ?? now();
  const existing = db.prepare("SELECT id FROM runners WHERE id = ?").get(heartbeat.runnerId);
  const githubRunner = heartbeat.metadata?.githubRunner ?? {};

  db.prepare(`
    INSERT INTO runners (
      id, name, hostname, labels_json, status, github_runner_id, busy, runner_group_name,
      scope, owner, repo, last_seen_at, version,
      metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      hostname = excluded.hostname,
      labels_json = excluded.labels_json,
      status = excluded.status,
      github_runner_id = excluded.github_runner_id,
      busy = excluded.busy,
      runner_group_name = excluded.runner_group_name,
      scope = excluded.scope,
      owner = excluded.owner,
      repo = excluded.repo,
      last_seen_at = excluded.last_seen_at,
      version = excluded.version,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    heartbeat.runnerId,
    heartbeat.runnerName,
    heartbeat.hostname,
    JSON.stringify(heartbeat.labels),
    heartbeat.status,
    optionalText(githubRunner.githubRunnerId),
    githubRunner.busy ? 1 : 0,
    optionalText(githubRunner.runnerGroupName ?? heartbeat.metadata?.runnerGroupName),
    optionalText(githubRunner.scope),
    optionalText(githubRunner.owner),
    optionalText(githubRunner.repo),
    timestamp,
    heartbeat.version,
    JSON.stringify(heartbeat.metadata),
    timestamp,
    timestamp
  );

  if (options.audit !== false) {
    recordAuditEvent(db, {
      actor: heartbeat.runnerId,
      action: existing ? "runner.heartbeat" : "runner.registered",
      target: heartbeat.runnerId,
      payload: {
        status: heartbeat.status,
        labels: heartbeat.labels,
        hostname: heartbeat.hostname,
        busy: Boolean(githubRunner.busy)
      },
      createdAt: timestamp
    });
  }

  return mapRunner(db.prepare("SELECT * FROM runners WHERE id = ?").get(heartbeat.runnerId));
}

function seedDemoData(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM runners").get().count;
  if (count > 0) {
    return;
  }

  const createdAt = now();
  db.prepare(`
    INSERT INTO runners (
      id, name, hostname, labels_json, status, github_runner_id, busy,
      runner_group_name, scope, owner, repo, last_seen_at, version,
      metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "lab-heavy-runner-01",
    "lab-heavy-runner-01",
    "lab-heavy-runner-01",
    JSON.stringify(["self-hosted", "linux", "arm64", "heavy-build", "scanner"]),
    "online",
    "66",
    0,
    "default",
    "org",
    "example-org",
    null,
    createdAt,
    "github-actions",
    JSON.stringify({
      source: "github-reconcile",
      provider: "github-actions",
      runnerGroupName: "default",
      githubRunner: {
        configured: true,
        configuredOnHost: null,
        runnerName: "lab-heavy-runner-01",
        scope: "org",
        owner: "example-org",
        repo: null,
        repository: null,
        repositories: [],
        githubRunnerId: "66",
        runnerGroupName: "default",
        busy: false,
        external: true,
        services: []
      },
      checks: [
        { name: "github-actions-runner", status: "ok", detail: "online" },
        { name: "job-slot", status: "ok", detail: "idle" }
      ]
    }),
    createdAt,
    createdAt
  );

  db.prepare(`
    INSERT INTO runners (
      id, name, hostname, labels_json, status, github_runner_id, busy,
      runner_group_name, scope, owner, repo, last_seen_at, version,
      metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "lab-build-runner-01",
    "lab-build-runner-01",
    "lab-build-runner-01",
    JSON.stringify(["self-hosted", "linux", "arm64", "build-worker"]),
    "online",
    "67",
    0,
    "default",
    "org",
    "example-org",
    null,
    createdAt,
    "github-actions",
    JSON.stringify({
      source: "github-reconcile",
      provider: "github-actions",
      runnerGroupName: "default",
      githubRunner: {
        configured: true,
        configuredOnHost: null,
        runnerName: "lab-build-runner-01",
        scope: "org",
        owner: "example-org",
        repo: null,
        repository: null,
        repositories: [],
        githubRunnerId: "67",
        runnerGroupName: "default",
        busy: false,
        external: true,
        services: []
      },
      checks: [
        { name: "github-actions-runner", status: "ok", detail: "online" },
        { name: "job-slot", status: "ok", detail: "idle" }
      ]
    }),
    createdAt,
    createdAt
  );

  db.prepare(`
    INSERT INTO repositories (
      id, provider, owner, name, visibility, allowed_labels_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "github:example-org:infra-deployments",
    "github",
    "example-org",
    "infra-deployments",
    "private",
    JSON.stringify(["linux", "arm64", "build-worker"]),
    createdAt,
    createdAt
  );

  db.prepare(`
    INSERT INTO repositories (
      id, provider, owner, name, visibility, allowed_labels_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "github:example-org:actions-runner-control-plane",
    "github",
    "example-org",
    "actions-runner-control-plane",
    "private",
    JSON.stringify(["linux", "arm64", "build-worker"]),
    createdAt,
    createdAt
  );

  const queuedAt = new Date(Date.parse(createdAt) - 180_000).toISOString();
  const pickedUpAt = new Date(Date.parse(createdAt) - 120_000).toISOString();
  db.prepare(`
    INSERT INTO jobs (
      id, repository_id, runner_id, github_run_id, github_job_id, workflow, status,
      labels_json, queued_at, picked_up_at, started_at, completed_at, conclusion,
      url, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "demo-job-1",
    "github:example-org:infra-deployments",
    "lab-heavy-runner-01",
    "pending-live-webhook",
    "demo-job-1",
    "Security checks",
    "completed",
    JSON.stringify(["self-hosted", "linux", "arm64", "scanner"]),
    queuedAt,
    pickedUpAt,
    pickedUpAt,
    createdAt,
    "success",
    "https://github.com/example-org/infra-deployments/actions",
    createdAt,
    createdAt
  );

  recordAuditEvent(db, {
    actor: "runnerly",
    action: "system.seeded",
    target: "control-plane",
    payload: { mode: "demo" },
    createdAt
  });
}

function mapRunner(row) {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    labels: parseJson(row.labels_json, []),
    status: row.status,
    githubRunnerId: row.github_runner_id,
    busy: Boolean(row.busy),
    runnerGroupName: row.runner_group_name,
    scope: row.scope,
    owner: row.owner,
    repo: row.repo,
    lastSeenAt: row.last_seen_at,
    version: row.version,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isFleetRunner(runner) {
  const labels = normalizeLabels(runner.labels ?? []);

  if (runner.id?.startsWith("github-actions-") && !labels.includes("self-hosted")) {
    return false;
  }

  if (runner.metadata?.source === "github-webhook" && !labels.includes("self-hosted")) {
    return false;
  }

  return true;
}

function mapRepository(row) {
  return {
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    visibility: row.visibility,
    allowedLabels: parseJson(row.allowed_labels_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapJob(row) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repository: row.repository_owner && row.repository_name
      ? `${row.repository_owner}/${row.repository_name}`
      : null,
    runnerId: row.runner_id,
    githubRunId: row.github_run_id,
    githubJobId: row.github_job_id,
    workflow: row.workflow,
    status: row.status,
    labels: normalizeLabels(parseJson(row.labels_json, [])),
    queuedAt: row.queued_at,
    pickedUpAt: row.picked_up_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    conclusion: row.conclusion,
    url: row.url,
    pickupSeconds: durationSeconds(row.queued_at, row.picked_up_at ?? row.started_at),
    durationSeconds: durationSeconds(row.started_at, row.completed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function medianPickupSeconds(jobs) {
  const values = jobs
    .map((job) => job.pickupSeconds)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!values.length) {
    return null;
  }

  return values[Math.floor(values.length / 2)];
}

function durationSeconds(start, end) {
  if (!start || !end) {
    return null;
  }

  const value = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapAuditEvent(row) {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionalText(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function defaultBackupDir() {
  const dbPath = process.env.RUNNERLY_DB_PATH ?? ".runnerly/runnerly.sqlite";
  return process.env.RUNNERLY_BACKUP_DIR ?? join(dirname(resolve(dbPath)), "backups");
}
