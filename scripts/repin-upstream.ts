#!/usr/bin/env bun
import { resolve } from "node:path";

interface InventoryFile {
  source: string;
  blob: string;
  target: string;
  mode: string;
  adaptation?: {
    reason: string;
    verification: { kind: string; artifacts: string[] };
  };
}

interface Inventory {
  repository: string;
  commit: string;
  version: string;
  subtree: string;
  files: InventoryFile[];
}

const PRESERVED_0155_ADAPTATIONS: Record<string, string> = {
  "skills/blast-radius/SKILL.md": "Retain the complete OMP instruction set instead of upstream 0.15.3 density cuts.",
  "skills/figure-it-out/SKILL.md": "Retain the complete OMP workflow instead of upstream 0.15.3 density cuts.",
  "skills/how/references/explorer-prompt.md": "Retain the explicit OMP exploration rubric instead of upstream 0.15.3 instruction cuts.",
  "skills/interrogate/references/code-quality-review.md": "Retain the explicit OMP review rubric instead of upstream 0.15.3 instruction cuts.",
  "skills/interrogate/references/reviewer-prompt.md": "Retain the explicit OMP reviewer contract instead of upstream 0.15.3 instruction cuts.",
  "skills/interrogate/references/rubric.md": "Retain the complete OMP scoring rubric instead of upstream 0.15.3 instruction cuts.",
  "skills/principle-guard-the-context-window/SKILL.md": "Retain the complete OMP principle guidance instead of upstream 0.15.3 density cuts.",
  "skills/principle-never-block-on-the-human/SKILL.md": "Retain the complete OMP principle guidance instead of upstream 0.15.3 density cuts.",
  "skills/principle-outcome-oriented-execution/SKILL.md": "Retain the complete OMP principle guidance instead of upstream 0.15.3 density cuts.",
  "skills/principle-prove-it-works/SKILL.md": "Retain the complete OMP principle guidance instead of upstream 0.15.3 density cuts.",
  "skills/principle-sequence-verifiable-units/SKILL.md": "Retain the complete OMP principle guidance instead of upstream 0.15.3 density cuts.",
  "skills/tdd/SKILL.md": "Retain the complete OMP TDD workflow instead of upstream 0.15.3 instruction cuts.",
  "skills/technical-writing/SKILL.md": "Retain the complete OMP writing workflow instead of upstream 0.15.3 instruction cuts.",
  "skills/unslop/SKILL.md": "Retain the complete OMP prose rules instead of upstream 0.15.3 instruction cuts.",
};

const [checkoutArg, commitArg, version] = Bun.argv.slice(2);
if (!checkoutArg || !commitArg || !version) {
  console.error("usage: bun scripts/repin-upstream.ts <upstream-checkout> <commit> <version>");
  process.exit(2);
}

const checkout = resolve(checkoutArg);
const runGit = (args: string[]): string => {
  const result = Bun.spawnSync(["git", "-C", checkout, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
};

const commit = runGit(["rev-parse", `${commitArg}^{commit}`]);
const subtree = runGit(["rev-parse", `${commit}:pstack`]);
const entries = new Map<string, { mode: string; blob: string }>();
const tree = Bun.spawnSync(["git", "-C", checkout, "ls-tree", "-rz", commit, "--", "pstack", "cursor-team-kit"]);
if (tree.exitCode !== 0) throw new Error(tree.stderr.toString().trim());
for (const row of tree.stdout.toString().split("\0")) {
  if (!row) continue;
  const match = row.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/);
  if (match) entries.set(match[3], { mode: match[1], blob: match[2] });
}

const path = resolve("upstream.json");
const inventory = JSON.parse(await Bun.file(path).text()) as Inventory;
for (const file of inventory.files) {
  const entry = entries.get(file.source);
  if (!entry) throw new Error(`missing upstream source at ${commit}: ${file.source}`);
  file.mode = entry.mode;
  file.blob = entry.blob;
  const reason = version === "0.15.5" ? PRESERVED_0155_ADAPTATIONS[file.target] : undefined;
  if (reason && !file.adaptation) {
    file.adaptation = {
      reason,
      verification: {
        kind: "pinned-byte/link inspection",
        artifacts: ["scripts/check-content.ts"],
      },
    };
  }
}
const inventoried = new Set(inventory.files.map((file) => file.source));
const omitted = [...entries.keys()].filter((source) => source.startsWith("pstack/") && !inventoried.has(source));
if (omitted.length) throw new Error(`uninventoried pstack files:\n${omitted.join("\n")}`);

inventory.commit = commit;
inventory.version = version;
inventory.subtree = subtree;
await Bun.write(path, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`repinned ${inventory.files.length} files to P Stack ${version} at ${commit}`);
