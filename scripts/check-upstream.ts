#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const checkout = process.argv[2];
assert(checkout, "Usage: bun scripts/check-upstream.ts <cursor/plugins checkout>");
const root = resolve(import.meta.dir, "..");
const inventory = await Bun.file(join(root, "upstream.json")).json();
const result = Bun.spawnSync(["git", "-C", resolve(checkout), "ls-tree", "-rzt", inventory.commit, "--", "pstack", "cursor-team-kit"], { stdout: "pipe", stderr: "pipe" });
assert.equal(result.exitCode, 0, result.stderr.toString());
const sources = new Map<string, { mode: string; blob: string }>();
let subtree: string | undefined;
for (const record of result.stdout.toString().split("\0")) {
  if (!record) continue;
  const [metadata, path] = record.split("\t");
  const [mode, kind, blob] = metadata!.split(" ");
  if (path === "pstack") subtree = blob;
  if (kind === "blob") sources.set(path!, { mode: mode!, blob: blob! });
}
assert.equal(subtree, inventory.subtree, "Pinned subtree must belong to the pinned commit");
const recorded = new Set<string>();
let exactFiles = 0;
let adaptedFiles = 0;
for (const file of inventory.files) {
  assert(!recorded.has(file.source), `Duplicate source ${file.source}`);
  recorded.add(file.source);
  const source = sources.get(file.source);
  assert(source, `Source missing at pinned commit: ${file.source}`);
  assert.equal(file.blob, source.blob, `Wrong source blob for ${file.source}`);
  assert.equal(file.mode, source.mode, `Wrong source mode for ${file.source}`);
  if (file.adaptation) {
    adaptedFiles++;
    continue;
  }
  const bytes = await readFile(join(root, file.target));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, source.blob, `Unadapted target differs from upstream: ${file.target}`);
  exactFiles++;
}
const omitted = [...sources.keys()].filter(path => path.startsWith("pstack/") && !recorded.has(path));
assert.deepEqual(omitted, [], "Every upstream P Stack file must have an inventory entry");
console.log(JSON.stringify({ ok: true, commit: inventory.commit, subtree, upstreamFiles: [...sources.keys()].filter(path => path.startsWith("pstack/")).length, inventoryFiles: recorded.size, exactFiles, adaptedFiles, adaptedContent: "Requires semantic review and check:content verification contracts" }, null, 2));
