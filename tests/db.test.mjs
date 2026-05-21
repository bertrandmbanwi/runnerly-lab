import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  listOverview,
  openRunnerlyDatabase,
  upsertJob,
  upsertRepository,
  upsertRunnerHeartbeat
} from "../apps/control-plane/db.mjs";

test("persists runner busy state and job timing facts", () => {
  const previousSeed = process.env.RUNNERLY_SEED_DEMO_DATA;
  process.env.RUNNERLY_SEED_DEMO_DATA = "false";
  const db = openRunnerlyDatabase(join(mkdtempSync(join(tmpdir(), "runnerly-db-")), "runnerly.sqlite"));

  try {
    const repository = upsertRepository(db, {
      provider: "github",
      owner: "example-org",
      name: "actions-runner-control-plane",
      visibility: "private",
      allowedLabels: ["linux", "arm64", "build-worker"]
    });

    upsertRunnerHeartbeat(db, {
      runnerId: "lab-build-runner-01",
      runnerName: "lab-build-runner-01",
      hostname: "lab-build-runner-01",
      labels: ["self-hosted", "linux", "arm64", "build-worker"],
      status: "online",
      observedAt: "2026-05-18T19:00:30.000Z",
      metadata: {
        githubRunner: {
          scope: "org",
          owner: "example-org",
          githubRunnerId: "67",
          runnerGroupName: "default",
          busy: true
        }
      }
    });

    upsertJob(db, {
      id: "github-job:67",
      repositoryId: repository.id,
      runnerId: "lab-build-runner-01",
      githubRunId: "123",
      githubJobId: "67",
      workflow: "CI",
      status: "running",
      labels: ["self-hosted", "linux", "arm64", "build-worker"],
      queuedAt: "2026-05-18T19:00:00.000Z",
      pickedUpAt: "2026-05-18T19:00:30.000Z",
      startedAt: "2026-05-18T19:00:30.000Z"
    });

    const overview = listOverview(db);
    assert.equal(overview.summary.busyRunnerCount, 1);
    assert.equal(overview.summary.runningJobCount, 1);
    assert.equal(overview.summary.medianPickupSeconds, 30);
    assert.equal(overview.runners[0].githubRunnerId, "67");
    assert.equal(overview.runners[0].scope, "org");
    assert.equal(overview.jobs[0].pickupSeconds, 30);
  } finally {
    db.close();
    if (previousSeed === undefined) {
      delete process.env.RUNNERLY_SEED_DEMO_DATA;
    } else {
      process.env.RUNNERLY_SEED_DEMO_DATA = previousSeed;
    }
  }
});

test("can refresh runner heartbeat state without writing audit events", () => {
  const previousSeed = process.env.RUNNERLY_SEED_DEMO_DATA;
  process.env.RUNNERLY_SEED_DEMO_DATA = "false";
  const db = openRunnerlyDatabase(join(mkdtempSync(join(tmpdir(), "runnerly-db-")), "runnerly.sqlite"));

  try {
    upsertRunnerHeartbeat(db, {
      runnerId: "lab-build-runner-01",
      runnerName: "lab-build-runner-01",
      hostname: "lab-build-runner-01",
      labels: ["self-hosted", "linux", "arm64", "build-worker"],
      status: "online",
      observedAt: "2026-05-18T19:00:30.000Z",
      metadata: {
        githubRunner: {
          scope: "org",
          owner: "example-org",
          githubRunnerId: "67",
          busy: false
        }
      }
    }, { audit: false });

    const auditCount = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
    assert.equal(auditCount, 0);
  } finally {
    db.close();
    if (previousSeed === undefined) {
      delete process.env.RUNNERLY_SEED_DEMO_DATA;
    } else {
      process.env.RUNNERLY_SEED_DEMO_DATA = previousSeed;
    }
  }
});

test("creates retained SQLite backups", () => {
  const previousSeed = process.env.RUNNERLY_SEED_DEMO_DATA;
  process.env.RUNNERLY_SEED_DEMO_DATA = "false";
  const root = mkdtempSync(join(tmpdir(), "runnerly-backup-"));
  const db = openRunnerlyDatabase(join(root, "runnerly.sqlite"));

  try {
    upsertRepository(db, {
      provider: "github",
      owner: "example-org",
      name: "actions-runner-control-plane",
      visibility: "private",
      allowedLabels: ["linux", "arm64"]
    });

    const backup = createDatabaseBackup(db, {
      backupDir: join(root, "backups"),
      retentionDays: 14,
      maxBackups: 2
    });
    const backups = listDatabaseBackups(join(root, "backups"));

    assert.match(backup.fileName, /^runnerly-.*\.sqlite$/);
    assert.ok(backup.bytes > 0);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].fileName, backup.fileName);
  } finally {
    db.close();
    if (previousSeed === undefined) {
      delete process.env.RUNNERLY_SEED_DEMO_DATA;
    } else {
      process.env.RUNNERLY_SEED_DEMO_DATA = previousSeed;
    }
  }
});
