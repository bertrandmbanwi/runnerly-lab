import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function inspectGitHubRunner(agentConfig) {
  const runnerConfigs = githubRunnerConfigs(agentConfig);
  const primaryRunner = runnerConfigs.at(0) ?? {};
  const runnerDirectory = primaryRunner.runnerDirectory ?? "/opt/actions-runner";
  const servicePattern = primaryRunner.servicePattern ?? "actions.runner.*.service";
  const checks = [];
  const metadata = {
    configured: runnerConfigs.some((runner) => runner.enabled),
    runnerDirectory,
    scope: primaryRunner.scope ?? (primaryRunner.repo ? "repo" : "org"),
    owner: primaryRunner.owner ?? null,
    repo: primaryRunner.repo ?? null,
    repository: repositoryFor(primaryRunner),
    repositories: runnerConfigs.map(repositoryFor).filter(Boolean),
    runners: [],
    services: []
  };

  const services = await listRunnerServices(servicePattern);
  metadata.services = services.map((service) => service.name);
  metadata.runners = await Promise.all(runnerConfigs.map(async (runner) => {
    const directory = runner.runnerDirectory ?? runnerDirectory;
    const configExists = await fileExists(join(directory, ".runner"));
    const repository = repositoryFor(runner);

    return {
      runnerDirectory: directory,
      scope: runner.scope ?? (runner.repo ? "repo" : "org"),
      owner: runner.owner ?? null,
      repo: runner.repo ?? null,
      repository,
      configuredOnHost: configExists,
      runnerName: configExists ? await readRunnerName(directory) : null,
      services: services
        .filter((service) => serviceMatchesRepository(service.name, repository))
        .map((service) => service.name)
    };
  }));
  metadata.configuredOnHost = metadata.runners.some((runner) => runner.configuredOnHost);
  metadata.runnerName = metadata.runners.find((runner) => runner.runnerName)?.runnerName ?? null;

  if (!services.length) {
    checks.push({
      name: "github-actions-runner",
      status: runnerConfigs.some((runner) => runner.required) ? "failed" : "unknown",
      detail: "No actions.runner.* systemd service found"
    });
    return { metadata, checks };
  }

  for (const service of services) {
    checks.push({
      name: service.name,
      status: service.active ? "ok" : "failed",
      detail: service.state
    });
  }

  return { metadata, checks };
}

function githubRunnerConfigs(agentConfig) {
  if (Array.isArray(agentConfig.githubRunners) && agentConfig.githubRunners.length) {
    return agentConfig.githubRunners;
  }

  if (agentConfig.githubRunner) {
    return [agentConfig.githubRunner];
  }

  return [];
}

function repositoryFor(runner) {
  const scope = runner.scope ?? (runner.repo ? "repo" : "org");
  return scope === "repo" && runner.owner && runner.repo ? `${runner.owner}/${runner.repo}` : null;
}

function serviceMatchesRepository(serviceName, repository) {
  if (!repository) {
    return true;
  }

  return serviceName.startsWith(`actions.runner.${repository.replace("/", "-")}.`);
}

async function listRunnerServices(pattern) {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["list-units", "--type=service", "--all", "--plain", "--no-legend", pattern],
      { timeout: 3000 }
    );

    return stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          name: parts[0],
          active: parts[2] === "active",
          state: [parts[2], parts[3]].filter(Boolean).join("/")
        };
      });
  } catch {
    return [];
  }
}

async function readRunnerName(runnerDirectory) {
  try {
    const raw = await readFile(join(runnerDirectory, ".runner"), "utf8");
    const payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return payload.runnerName ?? payload.name ?? payload.agentName ?? null;
  } catch {
    return null;
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
