#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_ASSETS, SPECKIT_CLI_VERSION } from "../src/speckit.ts";

const printCandidates = process.argv.includes("--print-candidates");

const version = execFileSync("specify", ["--version"], { encoding: "utf8", env: process.env }).trim();
if (version !== `specify ${SPECKIT_CLI_VERSION}`) throw new Error(`Expected specify ${SPECKIT_CLI_VERSION}; found ${version}`);
const fixture = mkdtempSync(join(tmpdir(), "pstack-official-speckit-"));
try {
  execFileSync("specify", ["init", ".", "--integration", "omp", "--non-interactive", "--ignore-agent-tools", "--script", "sh", "--force"], {
    cwd: fixture, env: process.env, stdio: "pipe", timeout: 120_000,
  });
  const generated: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(join(fixture, dir), { withFileTypes: true })) {
      const name = join(dir, entry.name);
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile()) generated.push(name);
      else throw new Error(`Unexpected generated asset type: ${name}`);
    }
  };
  for (const root of [".omp/commands", ".specify/scripts/bash", ".specify/templates"]) collect(root);
  const actualAssets = Object.fromEntries(generated.sort().map((name) => [
    name,
    createHash("sha256").update(readFileSync(join(fixture, name))).digest("hex"),
  ]));
  if (printCandidates) {
    console.log(JSON.stringify(actualAssets, null, 2));
  } else {
    const expectedPaths = Object.keys(OFFICIAL_ASSETS).sort();
    if (JSON.stringify(generated) !== JSON.stringify(expectedPaths)) {
      throw new Error(`Official CLI asset inventory changed. Generated: ${generated.join(", ")}. Pinned: ${expectedPaths.join(", ")}`);
    }
    for (const [name, expected] of Object.entries(OFFICIAL_ASSETS)) {
      if (actualAssets[name] !== expected) throw new Error(`${name}: official CLI fixture has ${actualAssets[name]}, plugin pin requires ${expected}`);
    }
  }
  const status = JSON.parse(execFileSync("specify", ["integration", "status", "--json"], {
    cwd: fixture, env: process.env, encoding: "utf8", timeout: 20_000,
  }));
  if (status.status !== "ok" || !Array.isArray(status.findings) || status.findings.length) {
    throw new Error(`Generated fixture has unexpected integration status: ${JSON.stringify(status)}`);
  }
  if (!printCandidates) console.log(`Official specify ${SPECKIT_CLI_VERSION}: ${Object.keys(OFFICIAL_ASSETS).length} pinned command, script, and template hashes match regenerated assets.`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
