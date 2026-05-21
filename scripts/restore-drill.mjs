import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const options = parseArgs(process.argv.slice(2));
const backupPath = resolveBackupPath(options);
const drillDir = mkdtempSync(join(tmpdir(), "runnerly-restore-drill-"));
const drillPath = join(drillDir, basename(backupPath));

copyFileSync(backupPath, drillPath);

const db = new DatabaseSync(drillPath, { readOnly: true });
try {
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${integrity}`);
  }

  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) {
    throw new Error(`SQLite foreign_key_check returned ${foreignKeys.length} violation(s)`);
  }

  const report = {
    ok: true,
    backupPath,
    drillPath,
    backupBytes: statSync(backupPath).size,
    generatedAt: new Date().toISOString(),
    tables: {
      runners: countRows(db, "runners"),
      repositories: countRows(db, "repositories"),
      jobs: countRows(db, "jobs"),
      auditEvents: countRows(db, "audit_events"),
      settings: countRows(db, "settings")
    },
    latestJob: latestJob(db),
    latestAuditEvent: latestAuditEvent(db)
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--backup") {
      parsed.backup = args[index + 1];
      index += 1;
    } else if (arg === "--backup-dir") {
      parsed.backupDir = args[index + 1];
      index += 1;
    } else if (arg === "--db") {
      parsed.db = args[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function resolveBackupPath(options) {
  if (options.backup) {
    const backup = resolve(options.backup);
    if (!existsSync(backup)) {
      throw new Error(`Backup does not exist: ${backup}`);
    }
    return backup;
  }

  const backupDir = resolve(
    options.backupDir ??
      process.env.RUNNERLY_BACKUP_DIR ??
      join(dirname(resolve(options.db ?? process.env.RUNNERLY_DB_PATH ?? ".runnerly/runnerly.sqlite")), "backups")
  );
  if (!existsSync(backupDir)) {
    throw new Error(`Backup directory does not exist: ${backupDir}`);
  }

  const latest = readdirSync(backupDir)
    .filter((fileName) => fileName.startsWith("runnerly-") && fileName.endsWith(".sqlite"))
    .map((fileName) => {
      const filePath = join(backupDir, fileName);
      return {
        filePath,
        updatedAt: statSync(filePath).mtimeMs
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .at(0);

  if (!latest) {
    throw new Error(`No Runnerly backup files found in ${backupDir}`);
  }

  return latest.filePath;
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function latestJob(db) {
  return db.prepare(`
    SELECT id, workflow, status, conclusion, updated_at AS updatedAt
    FROM jobs
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() ?? null;
}

function latestAuditEvent(db) {
  return db.prepare(`
    SELECT id, actor, action, target, created_at AS createdAt
    FROM audit_events
    ORDER BY created_at DESC
    LIMIT 1
  `).get() ?? null;
}

function printHelp() {
  console.log(`Usage: npm run restore:drill -- [options]

Options:
  --backup <path>      Restore-drill a specific backup file.
  --backup-dir <path>  Restore-drill the newest backup in a directory.
  --db <path>          Derive backup directory from a database path.

The drill copies the backup to a temporary path, opens it read-only, runs
SQLite integrity checks, and prints a JSON summary. It never overwrites the
live database.`);
}
