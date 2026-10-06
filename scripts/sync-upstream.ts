#!/usr/bin/env bun
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [checkoutArg, commitArg, version] = process.argv.slice(2);
assert(checkoutArg && commitArg && version, "Usage: bun scripts/sync-upstream.ts <cursor/plugins checkout> <commit> <version>");
const checkout = resolve(checkoutArg);
const root = resolve(import.meta.dir, "..");
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout;
};
const commit = git("rev-parse", `${commitArg}^{commit}`).toString().trim();
const inventory = await Bun.file(join(root, "upstream.json")).json();
const tree = new Map<string, { mode: string; blob: string }>();
let subtree = "";
for (const record of git("ls-tree", "-rzt", commit, "--", "pstack", "cursor-team-kit").toString().split("\0")) {
  if (!record) continue;
  const [metadata, path] = record.split("\t");
  const [mode, kind, blob] = metadata!.split(" ");
  if (path === "pstack") subtree = blob!;
  if (kind === "blob") tree.set(path!, { mode: mode!, blob: blob! });
}

const scratch = await mkdtemp(join(tmpdir(), "pstack-sync-"));
const report = { commit, version, copied: [] as string[], merged: [] as string[], conflicted: [] as string[], added: [] as string[], removed: [] as string[] };
try {
  for (const file of inventory.files) {
    const next = tree.get(file.source);
    if (!next) {
      report.removed.push(file.source);
      continue;
    }
    if (next.blob === file.blob && next.mode === file.mode) continue;
    const target = join(root, file.target);
    if (next.blob === file.blob) {
      await chmod(target, Number.parseInt(next.mode.slice(-3), 8));
      report.copied.push(file.target);
    } else if (!file.adaptation) {
      await writeFile(target, git("cat-file", "blob", next.blob));
      await chmod(target, Number.parseInt(next.mode.slice(-3), 8));
      report.copied.push(file.target);
    } else {
      // Three-way merge keeps the OMP adaptation and replays only the upstream delta.
      const base = join(scratch, "base");
      const theirs = join(scratch, "theirs");
      await writeFile(base, git("cat-file", "blob", file.blob));
      await writeFile(theirs, git("cat-file", "blob", next.blob));
      const merge = Bun.spawnSync(["git", "merge-file", "-L", "omp", "-L", "upstream-base", "-L", "upstream-next", target, base, theirs], { stderr: "pipe" });
      assert(merge.exitCode !== null && merge.exitCode >= 0 && merge.exitCode < 128, merge.stderr.toString());
      (merge.exitCode === 0 ? report.merged : report.conflicted).push(file.target);
    }
    file.blob = next.blob;
    file.mode = next.mode;
  }
  const recorded = new Set(inventory.files.map((file: { source: string }) => file.source));
  for (const [source, next] of tree) {
    if (!source.startsWith("pstack/") || recorded.has(source)) continue;
    const target = source.slice("pstack/".length);
    await mkdir(dirname(join(root, target)), { recursive: true });
    await writeFile(join(root, target), git("cat-file", "blob", next.blob));
    await chmod(join(root, target), Number.parseInt(next.mode.slice(-3), 8));
    inventory.files.push({ source, blob: next.blob, target, mode: next.mode });
    report.added.push(target);
  }
  Object.assign(inventory, { commit, version, subtree });
  await writeFile(join(root, "upstream.json"), `${JSON.stringify(inventory, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
