import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "benny-root-boundary-"));
const home = join(root, "home");
const target = join(root, "target");
mkdirSync(home, { mode: 0o700 });
mkdirSync(target, { mode: 0o700 });
process.env.HOME = home;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_PROFILE;
// SDK directory singletons must load after the disposable HOME is selected.
const { createBennyWorkspace, decodeVideoFrames } = await import("../../src/benny-workspace.ts");
const { controlChecks } = await import("../../src/benny-setup.ts");
const { ensureImage, proofConfig } = await import("../../scripts/fixtures/benny-workspace/proof.ts");
const config = proofConfig("root-boundary-must-not-build");
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
let processAttempts = 0;
const forbidProcess = () => { processAttempts++; throw new Error("Root boundary attempted a child process"); };
Bun.spawn = forbidProcess as typeof Bun.spawn;
Bun.spawnSync = forbidProcess as typeof Bun.spawnSync;
const failures: Record<string, string> = {};
try {
  for (const [name, operation] of [
    ["workspace", () => createBennyWorkspace({ config, cwd: target, runId: "root-boundary", revision: "0".repeat(40), artifactDir: ".omp/pstack/state/benny-evidence", deadline: Date.now() + 60_000 })],
    ["decoder", () => decodeVideoFrames("root-boundary-must-not-run", new Uint8Array([1]))],
    ["preflight", () => controlChecks(config, target, "0".repeat(40))],
    ["fixture", () => ensureImage("root-boundary-must-not-build")],
  ] as const) {
    try { await operation(); failures[name] = "Unexpected success"; }
    catch (error) { failures[name] = error instanceof Error ? error.message : String(error); }
  }
  console.log(JSON.stringify({
    uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
    processAttempts, targetEntries: readdirSync(target), homeEntries: readdirSync(home), failures,
  }));
} finally {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
  rmSync(root, { recursive: true, force: true });
}
