import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const roots = ["apps", "packages", "scripts", "tests"];
const files = [];

for (const root of roots) {
  files.push(...await collectJavaScriptFiles(root));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files`);

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      collected.push(...await collectJavaScriptFiles(path));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      collected.push(path);
    }
  }

  return collected;
}
