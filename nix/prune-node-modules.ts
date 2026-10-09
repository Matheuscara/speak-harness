// Removes packages whose package.json `os`/`cpu`/`libc` fields exclude the target platform.
// The fixed-output node_modules is installed for every supported platform so one hash
// serves all systems; this trims it to what the host can load.
// Usage: bun prune-node-modules.ts <node_modules> <os> <cpu> [libc]
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [root, os, cpu, libc] = process.argv.slice(2);
if (!root || !os || !cpu) {
  console.error("usage: prune-node-modules.ts <node_modules> <os> <cpu> [libc]");
  process.exit(2);
}

function allows(list: unknown, value: string | undefined): boolean {
  if (!Array.isArray(list) || list.length === 0 || value === undefined) return true;
  if (list.includes(`!${value}`)) return false;
  const positives = list.filter((entry) => typeof entry === "string" && !entry.startsWith("!"));
  return positives.length === 0 || positives.includes(value);
}

function packageDirs(nodeModules: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith(".")) continue;
    const path = join(nodeModules, entry);
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(path)) dirs.push(join(path, scoped));
    } else {
      dirs.push(path);
    }
  }
  return dirs;
}

let removed = 0;
function prune(nodeModules: string): void {
  for (const dir of packageDirs(nodeModules)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { os?: unknown; cpu?: unknown; libc?: unknown };
    if (!allows(pkg.os, os) || !allows(pkg.cpu, cpu) || !allows(pkg.libc, libc)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
      continue;
    }
    const nested = join(dir, "node_modules");
    if (existsSync(nested)) prune(nested);
  }
}

prune(root);

// Drop `.bin` links left dangling by removed packages.
const bin = join(root, ".bin");
if (existsSync(bin)) {
  for (const entry of readdirSync(bin)) {
    const link = join(bin, entry);
    if (lstatSync(link).isSymbolicLink() && !existsSync(link)) rmSync(link);
  }
}

console.log(`pruned ${removed} packages not built for ${os}/${cpu}${libc ? `/${libc}` : ""}`);
