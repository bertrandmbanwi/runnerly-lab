import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { inspectGitHubRunner } from "./github-runner.mjs";
import { validateRunnerHeartbeat } from "../../packages/shared/schema.mjs";

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const configPath = process.env.RUNNERLY_AGENT_CONFIG ?? "runnerly.agent.json";
const intervalMs = Number.parseInt(process.env.RUNNERLY_AGENT_INTERVAL_MS ?? "30000", 10);

const config = await loadConfig(configPath);

if (once) {
  const heartbeat = await buildHeartbeat(config);
  await sendOrPrintHeartbeat(heartbeat, config);
} else {
  await runLoop(config);
}

async function runLoop(agentConfig) {
  for (;;) {
    try {
      const heartbeat = await buildHeartbeat(agentConfig);
      await sendOrPrintHeartbeat(heartbeat, agentConfig);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error.message }));
    }

    await sleep(intervalMs);
  }
}

async function buildHeartbeat(agentConfig) {
  const disk = await checkDisk(agentConfig.diskPath ?? "/");
  const services = await Promise.all((agentConfig.services ?? []).map(checkService));
  const commands = await Promise.all((agentConfig.commands ?? defaultCommands()).map(checkCommand));
  const githubRunner = await inspectGitHubRunner(agentConfig);
  const githubRunnerName = githubRunner.metadata.runnerName;
  const hostname = safeSystemValue(() => os.hostname(), "unknown-host");
  const cpus = safeSystemValue(() => os.cpus(), []);
  const platform = safeSystemValue(() => os.platform(), "unknown");
  const arch = safeSystemValue(() => os.arch(), "unknown");
  const checks = [...services, ...commands, ...githubRunner.checks];

  const heartbeat = {
    runnerId: githubRunnerName ?? agentConfig.runnerId ?? hostname,
    runnerName: githubRunnerName ?? agentConfig.runnerName ?? hostname,
    hostname,
    labels: agentConfig.labels ?? defaultLabels(),
    status: deriveStatus([...checks, disk]),
    version: "0.1.0",
    observedAt: new Date().toISOString(),
    metadata: {
      platform,
      arch,
      uptimeSeconds: safeSystemValue(() => Math.round(os.uptime()), null),
      cpu: {
        model: cpus[0]?.model ?? "unknown",
        cores: cpus.length
      },
      memory: {
        totalBytes: safeSystemValue(() => os.totalmem(), null),
        freeBytes: safeSystemValue(() => os.freemem(), null)
      },
      disk,
      githubRunner: githubRunner.metadata,
      checks
    }
  };

  return validateRunnerHeartbeat(heartbeat);
}

async function sendOrPrintHeartbeat(heartbeat, agentConfig) {
  const controlPlaneUrl = process.env.RUNNERLY_CONTROL_PLANE_URL ?? agentConfig.controlPlaneUrl;
  const token = process.env.RUNNERLY_AGENT_TOKEN ?? agentConfig.authToken;

  if (!controlPlaneUrl) {
    console.log(JSON.stringify(heartbeat, null, 2));
    return;
  }

  const response = await fetch(new URL("/api/runners/heartbeat", controlPlaneUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(heartbeat)
  });

  if (!response.ok) {
    throw new Error(`control plane rejected heartbeat: ${response.status}`);
  }

  console.log(JSON.stringify({ sent: true, runnerId: heartbeat.runnerId, status: heartbeat.status }));
}

async function loadConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function checkDisk(path) {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", path], { timeout: 3000 });
    const lines = stdout.trim().split("\n");
    const parts = lines.at(-1).split(/\s+/);
    const usedPercent = Number.parseInt(parts[4].replace("%", ""), 10);

    return {
      name: "disk",
      status: usedPercent >= 90 ? "failed" : usedPercent >= 75 ? "degraded" : "ok",
      path,
      usedPercent,
      detail: `${usedPercent}% used`
    };
  } catch (error) {
    return { name: "disk", status: "failed", path, detail: error.message };
  }
}

async function checkService(service) {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", service], { timeout: 3000 });
    const active = stdout.trim() === "active";
    return {
      name: service,
      status: active ? "ok" : "failed",
      detail: active ? "active" : stdout.trim()
    };
  } catch (error) {
    return { name: service, status: "failed", detail: error.message };
  }
}

async function checkCommand(command) {
  try {
    const { stdout } = await execFileAsync(command.bin, command.args ?? [], { timeout: 3000 });
    return {
      name: command.name,
      status: "ok",
      detail: stdout.trim().split("\n").at(0) ?? "ok"
    };
  } catch (error) {
    return { name: command.name, status: "degraded", detail: error.message };
  }
}

function deriveStatus(checks) {
  if (checks.some((check) => check.status === "failed")) {
    return "degraded";
  }

  return "online";
}

function defaultCommands() {
  return [
    { name: "git", bin: "git", args: ["--version"] },
    { name: "docker", bin: "docker", args: ["--version"] }
  ];
}

function defaultLabels() {
  const platform = safeSystemValue(() => os.platform(), "unknown");
  const arch = safeSystemValue(() => os.arch(), "unknown");
  const labels = ["self-hosted", platform, arch];
  if (arch === "arm64") {
    labels.push("arm64");
  }
  return [...new Set(labels)];
}

function safeSystemValue(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
