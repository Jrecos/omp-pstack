#!/usr/bin/env bun
// Verifies the pinned upstream inventory, imported content integrity, skill/agent/
// playbook discovery surface, and Markdown link health. Nonzero exit on any violation.
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, normalize } from "node:path";

const EXPECTED_HEADER = {
  repository: "https://github.com/cursor/plugins",
  commit: "93b00b89ef425a9c1bac0d0b317dfc49c930ac99",
  version: "0.14.8",
  subtree: "ae6fff5803260f38f075feb8c3b008ed68153fa0",
};

const DIRECT_SKILLS = [
  "architect", "arena", "automate-me", "blast-radius", "bro",
  "create-verification-skill", "figure-it-out", "how", "interrogate",
  "maintain-verification-skill", "make-bot-ui", "no-comments", "poteto-mode",
  "recall", "reflect", "setup-pstack", "show-me-your-work", "swarm", "tdd",
  "teach", "technical-writing", "typescript-best-practices", "unslop", "why",
];

const PRINCIPLES = [
  "laziness-protocol", "foundational-thinking", "redesign-from-first-principles",
  "subtract-before-you-add", "minimize-reader-load", "outcome-oriented-execution",
  "experience-first", "exhaust-the-design-space", "build-the-lever",
  "model-the-domain", "boundary-discipline", "type-system-discipline",
  "make-operations-idempotent", "migrate-callers-then-delete-legacy-apis",
  "separate-before-serializing-shared-state", "prove-it-works", "fix-root-causes",
  "sequence-verifiable-units", "guard-the-context-window", "never-block-on-the-human",
  "encode-lessons-in-structure",
].map((p) => `principle-${p}`);

const EXPECTED_AGENTS = ["poteto-agent", "Comment Sicko"];

const PLAYBOOKS = [
  "investigation", "bug-fix", "perf-issue", "hillclimb", "runtime-forensics",
  "trace-forensics", "feature", "refactoring", "prototype", "visual-parity",
  "authoring-a-skill", "eval", "babysit", "shipping", "autonomous-run",
  "orchestrate", "autopilot-full", "autopilot-stack", "session-pickup",
  "pause-safely", "multi-phase-plan", "worktree-cleanup", "opening-a-pr",
];

const PROOF_KINDS = [
  "pinned-byte/link inspection", // unchanged prose/assets verified byte/link-level
  "omp/cli scenario",            // slash/mode/model/history/helper translations exercised in OMP or CLI
  "runner+http/container fixture", // routine/Benny host actions against real runner + HTTP/container fixtures
  "live readback",               // external deployment proven by reading remote state back
];

interface Verification {
  kind: string; // exactly one PROOF_KINDS value; "pending" and anything else fail
  artifacts: string[]; // concrete proof/scenario artifact paths that exist in the repo
}

interface Adaptation {
  reason: string;
  verification: Verification;
}

interface InventoryFile {
  source: string;
  blob: string;
  target: string;
  mode: string;
  adaptation?: Adaptation;
}

interface Inventory {
  repository: string;
  commit: string;
  version: string;
  subtree: string;
  files: InventoryFile[];
}

// Canonical verification map: the target-specific contract between adapted
// upstream content and the concrete artifacts that actually verify it. Every
// adapted file must match exactly one class, and its adaptation.verification
// must be exactly that class's {kind, artifacts} — citing an unrelated file
// that merely exists, broadening the artifact set, or substituting a kind
// fails. Artifacts listed here are proof/scenario files only; an artifact
// that is itself an adapted content file (self-reference) is rejected.
interface VerificationClass {
  id: string;
  pattern: RegExp;
  kind: string;
  artifacts: string[];
  contract: string;
  // A class that documents the removal of an upstream file (e.g. a deleted
  // entrypoint replaced by a native port) is the repository's explicit,
  // validated removal schema: an adapted inventory row whose target maps here
  // may be absent on disk. All other adapted rows must be present.
  authorizesAbsence?: true;
}

const VERIFICATION_CLASSES: VerificationClass[] = [
  {
    id: "package-metadata",
    pattern: /^package\.json$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts"],
    contract: "Root OMP package metadata proven by a real marketplace install with native skill/agent discovery from the installed package.",
  },
  {
    id: "runtime-state-ignore",
    pattern: /^\.gitignore$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Package-side ignore metadata; only presence/integrity is claimed. No runtime scenario artifact exercises the package checkout's own ignores.",
  },
  {
    id: "install-readme",
    pattern: /^README\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts"],
    contract: "Translated install instructions proven by executing the actual marketplace add/install path they describe.",
  },
  {
    id: "native-agent-dispatch",
    pattern: /^agents\/(comment-sicko|poteto-agent)\.md$|^skills\/no-comments\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts", "scripts/smoke.ts"],
    contract: "Native agent frontmatter (tools, autoloadSkills, no-spawns) proven by discovery of both upstream agents from a real project install, plus the poteto-mode autoload session scenario.",
  },
  {
    id: "benny-deployment-prose",
    pattern: /^automations\/benny\/(FOR_AGENTS\.md|README\.md)$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts", "scripts/smoke-benny.ts"],
    contract: "Setup/pack-deployment prose proven by the real `pstack benny setup` merge+install scenario; trigger/run semantics proven by the end-to-end benny fixture run.",
  },
  {
    id: "benny-operational-skill",
    pattern: /^automations\/benny\/skills\/reproduce-and-fix-issues\/(SKILL\.md|references\/control-adapter\.md)$/,
    kind: "runner+http/container fixture",
    artifacts: ["scripts/smoke-benny.ts", "tests/benny-workspace.test.ts"],
    contract: "Repro operational skill and control-adapter contract proven by the real runner+container fixture executing both phases with evidence-gated draft PR.",
  },
  {
    id: "benny-example-maps",
    pattern: /^automations\/benny\/skills\/[^/]+\/references\/(feature-map|routing)\.example\.md$/,
    kind: "runner+http/container fixture",
    artifacts: ["scripts/smoke-benny.ts"],
    contract: "Translated .omp example paths proven by the fixture run writing and consuming exactly those .omp/benny/ feature-map and routing paths.",
  },
  {
    id: "benny-setup-skill",
    pattern: /^automations\/benny\/skills\/setup-benny\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts"],
    contract: "Setup skill mechanics proven by the real `pstack benny setup` scenario: conservative merge, destination-only preservation, project-scoped install, discovery verification.",
  },
  {
    id: "benny-triage-skill",
    pattern: /^automations\/benny\/skills\/triage-issue-reports\/SKILL\.md$/,
    kind: "runner+http/container fixture",
    artifacts: ["scripts/smoke-benny.ts", "tests/benny-coordinator.test.ts"],
    contract: "Triage operational skill proven by the fixture runner executing the triage phase and by the coordinator suite loading the committed operational files.",
  },
  {
    id: "benny-config-template",
    pattern: /^automations\/benny\/templates\/configuration\.example\.yaml$/,
    kind: "runner+http/container fixture",
    artifacts: ["tests/benny-actions.test.ts", "tests/benny-policy.test.ts", "scripts/smoke-benny.ts"],
    contract: "Example configuration schema/values proven by the action and policy suites parsing this exact template and by the fixture run driving a live config derived from it.",
  },
  {
    id: "benny-operation-prompts",
    pattern: /^automations\/benny\/templates\/(reproduce|triage)-automation-prompt\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Automation prompt templates are setup/review documentation, not runtime consumers — the runner executes the operational SKILL.md files directly. Honest claim is link/asset health and inventory integrity.",
  },
  {
    id: "guide-prose",
    pattern: /^docs\/guide\/\d[^/]*\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Guide path/command translations are prose; the honest claim is link/asset health and inventory integrity, not a behavioral scenario.",
  },
  {
    id: "mode-skill",
    pattern: /^skills\/poteto-mode\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke.ts"],
    contract: "Mode skill translation proven by the real SDK session scenario: injection exactly once, native skill-prompt activation, branch replay, compaction/resume retention, opt-out.",
  },
  {
    id: "model-dispatch-skill",
    pattern: /^skills\/(arena|how|interrogate|reflect|setup-pstack|swarm|why)\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-models.ts"],
    contract: "pstack_agent/native-task fan-out translation proven by the generated-agent panel scenario: ordered alias entries execute, per-arm resolved-model readback, parent-model change re-resolves, cancelled setup writes nothing.",
  },
  {
    id: "history-skill",
    pattern: /^skills\/(automate-me|recall|show-me-your-work)\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["tests/history.test.ts", "scripts/smoke-models.ts"],
    contract: "History-backed translations proven by the pstack_history workspace/window/exclusion/citation suite; reviewer-dispatch claims additionally by the resolved-model fan-out scenario.",
  },
  {
    id: "routine-skill",
    pattern: /^skills\/make-bot-ui\/SKILL\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-routine.ts"],
    contract: "Bot-UI translation proven by the end-to-end routine smoke: create/enable, serve endpoint, key-less button page, one-try sender, durable admission, replay dedupe.",
  },
  {
    id: "verification-skill-prose",
    pattern: /^skills\/(create|maintain)-verification-skill\/SKILL\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Generated-skill path translations are prose; honest claim is link health and inventory integrity.",
  },
  {
    id: "control-reference-prose",
    pattern: /^skills\/poteto-mode\/references\/omp-(control-ui|control-cli|deslop)\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Host-control reference recipes are prose; honest claim is link/asset health against the pinned source, not a behavioral scenario.",
  },
  {
    id: "playbook-plan-template",
    pattern: /^skills\/poteto-mode\/playbooks\/multi-phase-plan\.md$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/check-content.ts", "tests/check-plan.test.ts"],
    contract: "The Verify-live template wording this playbook ships is enforced by the check-plan suite; remaining prose is link/asset checked.",
  },
  {
    id: "playbook-prose",
    pattern: /^skills\/poteto-mode\/playbooks\/(?!multi-phase-plan\.md$)[a-z-]+\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Playbook host translations are instructions, never executed as a unit; the honest claim is link/asset health and inventory integrity.",
  },
  {
    id: "reviewer-reference-prose",
    pattern: /^skills\/reflect\/references\/(divergent|judgment|tooling)-reviewer\.md$/,
    kind: "pinned-byte/link inspection",
    artifacts: ["scripts/check-content.ts"],
    contract: "Reviewer scan-pattern translations are prose; honest claim is link health and inventory integrity. The reviewer dispatch itself is covered by the model-dispatch class.",
  },
  {
    id: "watch-pr-mergeability-gate",
    pattern: /^skills\/poteto-mode\/scripts\/watch-pr\/(policy(?:\.test)?|render|types)\.ts$/,
    kind: "omp/cli scenario",
    artifacts: ["tests/watch-pr-mergeability.test.ts"],
    contract: "GitHub mergeability UNKNOWN remains nonterminal, MERGEABLE is required for READY, and CONFLICTING remains a blocker.",
  },
  {
    id: "helper-commander-resolution",
    pattern: /^skills\/poteto-mode\/scripts\/(orch\/orch\.ts|watch-pr\/watch-pr)$/,
    kind: "omp/cli scenario",
    artifacts: ["skills/poteto-mode/scripts/orch/orch.test.ts"],
    contract: "Shared launcher-resolution pattern proven by the orch suite spawning the script as a real subprocess; the watch-pr launcher is the same one-line resolution.",
  },
  {
    id: "helper-manifest-consolidation",
    pattern: /^skills\/poteto-mode\/scripts\/(bun\.lock|package\.json)$/,
    kind: "omp/cli scenario",
    artifacts: ["skills/poteto-mode/scripts/orch/orch.test.ts", "skills/poteto-mode/scripts/watch-pr/cli.test.ts"],
    contract: "Nested-manifest removal proven by both helper suites resolving commander through the root package graph.",
    authorizesAbsence: true,
  },
  {
    id: "helper-check-plan",
    pattern: /^skills\/poteto-mode\/scripts\/check-plan\.mjs$/,
    kind: "omp/cli scenario",
    artifacts: ["tests/check-plan.test.ts"],
    contract: "check-plan wording adaptation proven by its focused suite: complete plan passes, missing ten-lane swarm-workers sentence fails.",
  },
  {
    id: "helper-worktree-audit",
    pattern: /^skills\/poteto-mode\/scripts\/worktree-audit\.sh$/,
    kind: "omp/cli scenario",
    artifacts: ["tests/worktree-audit.test.ts"],
    contract: "Shell-entrypoint removal proven by the audit port's suite covering buckets, precedence, and read-only behavior.",
    authorizesAbsence: true,
  },
  {
    id: "helper-bootstrap-removal",
    pattern: /^skills\/poteto-mode\/scripts\/bootstrap\.ts$/,
    kind: "omp/cli scenario",
    artifacts: ["scripts/smoke-install.ts"],
    contract: "Bootstrap-installer removal proven by the native marketplace-install scenario succeeding without it.",
    authorizesAbsence: true,
  },
];

// Exactly one class must claim an adapted target; patterns are kept disjoint.
export function classFor(target: string): VerificationClass {
  const matched = VERIFICATION_CLASSES.filter((c) => c.pattern.test(target));
  if (matched.length !== 1) {
    throw new Error(`no single canonical verification class covers ${JSON.stringify(target)} (matched: ${matched.map((c) => c.id).join(", ") || "none"})`);
  }
  return matched[0]!;
}

// Pinned integrity digest: source, blob, mode, target, and the exact
// adaptation verification metadata (kind + artifacts). Tampering with any of
// them — swapping a verification to an unrelated file, editing a kind —
// changes the digest.
export function digestRow(f: { source: string; blob: string; mode: string; target: string; adaptation?: Adaptation }): string {
  const v = f.adaptation?.verification;
  return JSON.stringify([
    f.source, f.blob, f.mode, f.target,
    typeof v?.kind === "string" ? v.kind : "",
    Array.isArray(v?.artifacts) ? [...v.artifacts].sort().join("\u0000") : "",
  ]);
}

export function inventoryDigest(files: Array<Parameters<typeof digestRow>[0]>): string {
  const rows = files.map(digestRow).sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

// Map-level invariants: artifacts exist, are proof/scenario files, and are
// never adapted content files (no class can verify itself).
export async function checkVerificationMap(root: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const c of VERIFICATION_CLASSES) {
    if (seen.has(c.id)) found.push(`verification class ${c.id}: duplicate id`);
    seen.add(c.id);
    if (!PROOF_KINDS.includes(c.kind)) found.push(`verification class ${c.id}: kind ${JSON.stringify(c.kind)} is not a known proof kind`);
    if (c.artifacts.length === 0) found.push(`verification class ${c.id}: no artifacts`);
    for (const artifact of c.artifacts) {
      if (c.pattern.test(artifact)) {
        found.push(`verification class ${c.id}: artifact ${artifact} matches the class's own target pattern (self-reference)`);
      }
      if (VERIFICATION_CLASSES.some((other) => other.pattern.test(artifact))) {
        found.push(`verification class ${c.id}: artifact ${artifact} is itself an adapted content file, not a proof artifact`);
      }
      if (!["tests/", "scripts/", "proofs/"].some((d) => artifact.startsWith(d)) && !/\.test\.tsx?$/.test(artifact)) {
        found.push(`verification class ${c.id}: artifact ${artifact} is not a proof/scenario artifact (tests/, scripts/, proofs/ or *.test.ts)`);
      }
      if (!(await exists(join(root, artifact)))) {
        found.push(`verification class ${c.id}: artifact ${artifact} does not exist in the repository`);
      }
    }
  }
  return found;
}

const errors: string[] = [];

const notes: string[] = [];
function fail(msg: string): void {
  errors.push(msg);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Git blob sha1 of a file's bytes, so integrity is verifiable without a git checkout.
function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

// Markdown links outside fenced code blocks and inline-code spans. Command
// examples wrapped in backticks are not links; external URLs and pure anchors
// are not local targets.
function markdownLinks(text: string): Array<{ line: number; target: string }> {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("```")) {
      fenced = !fenced;
      lines.push("");
      continue;
    }
    lines.push(fenced ? "" : raw.replace(/`[^`\n]*`/g, "``"));
  }
  const out: Array<{ line: number; target: string }> = [];
  const link = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(link)) out.push({ line: i + 1, target: m[2] });
  });
  return out;
}

// Validate untrusted JSON into the inventory shape; null when malformed.
function parseInventory(data: unknown): Inventory | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const { repository, commit, version, subtree, files: rawFiles } = o;
  if (
    typeof repository !== "string" ||
    typeof commit !== "string" ||
    typeof version !== "string" ||
    typeof subtree !== "string" ||
    !Array.isArray(rawFiles)
  ) return null;
  const files: InventoryFile[] = [];
  for (const f of rawFiles) {
    if (typeof f !== "object" || f === null) return null;
    const e = f as Record<string, unknown>;
    if (typeof e.source !== "string" || typeof e.target !== "string") return null;
    files.push({
      source: e.source,
      target: e.target,
      blob: typeof e.blob === "string" ? e.blob : "",
      mode: typeof e.mode === "string" ? e.mode : "",
      adaptation:
        typeof e.adaptation === "object" && e.adaptation !== null
          ? (e.adaptation as unknown as Adaptation)
          : undefined,
    });
  }
  return { repository, commit, version, subtree, files };
}

function checkHeader(inv: Inventory): void {
  for (const [k, want] of Object.entries(EXPECTED_HEADER)) {
    if (inv[k as keyof typeof EXPECTED_HEADER] !== want) {
      fail(`upstream.json ${k}: expected ${want}, got ${JSON.stringify(inv[k as keyof typeof EXPECTED_HEADER])}`);
    }
  }
}

// Validates one inventory row against the package tree. Returns the concrete
// violation messages; empty means the row is intact. Absent targets are
// violations unless the row's adaptation maps to a verification class that
// authorizes the removal (this inventory's explicit removal schema): an
// adaptation documents how content changed or moved, and only a documented
// removal may let an upstream file be absent on disk.
export async function checkFileEntry(root: string, f: InventoryFile): Promise<string[]> {
  const found: string[] = [];
  const { source: src, target: tgt } = f;
  if (!src.startsWith("pstack/") && !/^cursor-team-kit\/skills\/(control-ui|control-cli|deslop)\/SKILL\.md$/.test(src)) found.push(`${src}: source is outside the approved upstream inventory`);
  if (!/^[0-9a-f]{40}$/.test(f.blob)) found.push(`${src}: blob is not a 40-hex sha`);
  if (f.mode !== "100644" && f.mode !== "100755") found.push(`${src}: unexpected mode ${JSON.stringify(f.mode)}`);

  const localPath = join(root, tgt);
  if (!(await exists(localPath))) {
    if (f.adaptation) {
      // An adapted row may pass absence only through the repository's explicit,
      // validated removal schema — a verification class whose contract
      // documents the removal. Any other absent adapted target is a silent
      // deletion and must fail.
      let cls: VerificationClass;
      try {
        cls = classFor(tgt);
      } catch (e) {
        found.push(`${src}: upstream file missing at target ${tgt}; ${e instanceof Error ? e.message : String(e)}`);
        return found;
      }
      if (cls.authorizesAbsence !== true) {
        found.push(`${src}: upstream file missing at target ${tgt} and no removal schema authorizes an adapted row's absence`);
      }
      return found;
    }
    found.push(`${src}: upstream file missing at target ${tgt} and no adaptation record explains its removal`);
    return found;
  }

  const bytes = await readFile(localPath);
  const actualMode = (await stat(localPath)).mode & 0o111 ? "100755" : "100644";
  if (actualMode !== f.mode) {
    found.push(`${tgt}: recorded mode ${f.mode} but file is ${actualMode} on disk`);
  }

  if (!f.adaptation) {
    const sha = gitBlobSha(bytes);
    if (sha !== f.blob) {
      found.push(`${tgt}: content diverges from pinned blob ${f.blob} (local ${sha}) with no adaptation record; add adaptation {reason, verification} or restore pinned bytes`);
    }
    return found;
  }

  found.push(...(await verifyAdaptationRecord(root, tgt, f.adaptation as Adaptation)));
  return found;
}

// Validating one adaptation record against the canonical verification map.
// Returns the concrete violation messages; empty means the record is
// evidence-backed exactly as its class requires.
export async function verifyAdaptationRecord(root: string, tgt: string, adapt: Adaptation): Promise<string[]> {
  const found: string[] = [];
  if (typeof adapt.reason !== "string" || adapt.reason.trim().length < 8) {
    found.push(`${tgt}: adaptation.reason must be a concrete reason (got ${JSON.stringify(adapt.reason)})`);
  }
  if ("proofKind" in adapt || "evidence" in adapt) {
    found.push(`${tgt}: adaptation uses the removed proofKind/evidence shape; use verification {kind, artifacts}`);
  }
  const v = adapt.verification;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    found.push(`${tgt}: adaptation.verification must be an object {kind, artifacts}`);
    return found;
  }
  let cls: VerificationClass;
  try {
    cls = classFor(tgt);
  } catch (e) {
    found.push(`${tgt}: ${e instanceof Error ? e.message : String(e)}`);
    return found;
  }
  if (v.kind !== cls.kind) {
    found.push(`${tgt}: verification.kind ${JSON.stringify(v.kind)} does not match the canonical class "${cls.id}" (${cls.kind}); substitutions are rejected`);
  }
  if (!Array.isArray(v.artifacts) || v.artifacts.length === 0 || v.artifacts.some((a) => typeof a !== "string" || a.trim() === "")) {
    found.push(`${tgt}: adaptation.verification.artifacts must be a nonempty array of repo paths`);
    return found;
  }
  const declared = [...v.artifacts].sort();
  const canonical = [...cls.artifacts].sort();
  if (JSON.stringify(declared) !== JSON.stringify(canonical)) {
    found.push(`${tgt}: verification.artifacts must be exactly the canonical class "${cls.id}" set [${canonical.join(", ")}]; got [${declared.join(", ")}] — unrelated or broadened mappings are rejected`);
  }
  for (const artifact of v.artifacts) {
    const path = artifact.split("#")[0].trim();
    if (path === tgt) {
      found.push(`${tgt}: self-reference — adaptation artifact ${path} is the adapted file itself`);
      continue;
    }
    if (!["tests/", "scripts/", "proofs/"].some((d) => path.startsWith(d)) && !/\.test\.tsx?$/.test(path)) {
      found.push(`${tgt}: adaptation artifact ${path} is not a proof/scenario artifact (tests/, scripts/, proofs/ or *.test.ts)`);
      continue;
    }
    if (!(await exists(join(root, path)))) {
      found.push(`${tgt}: adaptation artifact ${path} does not exist in the repository`);
    }
  }
  return found;
}

async function checkSkillDirs(root: string, expectedSkills: string[]): Promise<void> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(join(root, "skills"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    fail("skills/ directory is missing from the package");
    return;
  }
  for (const d of dirs) {
    if (!expectedSkills.includes(d)) fail(`skills/${d}: unexpected skill directory (expected exactly the 45 pinned IDs)`);
  }
  for (const d of expectedSkills) {
    if (!dirs.includes(d)) fail(`skills/${d}: expected skill directory is missing`);
    else if (!(await exists(join(root, "skills", d, "SKILL.md")))) fail(`skills/${d}/SKILL.md: missing`);
  }
}
function checkBennyExclusion(inv: Inventory): void {
  for (const f of inv.files) {
    const topRoot = f.target === "skills" || f.target === "agents" || f.target.startsWith("skills/") || f.target.startsWith("agents/");
    if (topRoot && f.target.includes("automations")) {
      fail(`${f.target}: Benny content must not be inside the skills/ or agents/ discovery roots`);
    }
  }
}
async function checkAgents(root: string): Promise<string[]> {
  let names: string[] = [];
  try {
    const entries = await readdir(join(root, "agents"), { withFileTypes: true });
    const mdFiles = entries.filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name);
    if (mdFiles.length !== 2) fail(`agents/: expected exactly 2 agent files, found ${mdFiles.length}`);
    for (const a of mdFiles) {
      const t = await readFile(join(root, "agents", a), "utf8");
      const m = t.match(/^name:\s*(.+)$/m);
      if (!m) fail(`agents/${a}: no frontmatter name`);
      else names.push(m[1].trim());
    }
  } catch {
    fail("agents/ directory is missing from the package");
  }
  for (const want of EXPECTED_AGENTS) {
    if (!names.includes(want)) fail(`agents/: expected upstream agent named "${want}" is not exported (found: ${names.join(", ") || "none"})`);
  }
  for (const got of names) {
    if (!EXPECTED_AGENTS.includes(got)) fail(`agents/: unexpected exported agent name "${got}"`);
  }
  return names;
}

async function checkPlaybooks(root: string): Promise<string[]> {
  let got: string[] = [];
  try {
    got = (await readdir(join(root, "skills/poteto-mode/playbooks")))
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.replace(/\.md$/, ""))
      .sort();
  } catch {
    fail("skills/poteto-mode/playbooks/ is missing");
    return [];
  }
  const want = [...PLAYBOOKS].sort();
  for (const p of want) {
    if (!got.includes(p)) fail(`skills/poteto-mode/playbooks/${p}.md: expected playbook missing`);
  }
  for (const p of got) {
    if (!want.includes(p)) fail(`skills/poteto-mode/playbooks/${p}.md: unexpected playbook`);
  }
  return got;
}


async function checkBennyFiles(root: string, inv: Inventory): Promise<void> {
  for (const f of inv.files) {
    if (f.source.startsWith("pstack/automations/benny/skills/") && f.target.endsWith("SKILL.md")) {
      if (!(await exists(join(root, f.target)))) {
        fail(`${f.target}: bundled Benny operational SKILL.md missing (must ship dormant, outside discovery roots)`);
      }
    }
  }
}

async function checkNoDiscoverySymlinks(root: string): Promise<void> {
  for (const dir of ["skills", "agents"]) {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) fail(`${dir}/${d.name}: symlinks are not allowed in discovery roots`);
    }
  }
}

async function checkLinks(root: string, inv: Inventory): Promise<void> {
  let placeholders = 0;
  for (const f of inv.files) {
    if (!f.target.endsWith(".md") || !(await exists(join(root, f.target)))) continue;
    const text = await readFile(join(root, f.target), "utf8");
    for (const { line, target } of markdownLinks(text)) {
      if (/^(https?:|mailto:|<)/i.test(target) || target.startsWith("#")) continue; // external or in-page anchor
      const path = target.split("#")[0].split("?")[0];
      if (!path) continue; // anchor-only link within the same file
      if (path === "url") {
        // Known upstream prompt-template placeholder in synthesizer-prompt.md
        // ("Source: [PR #123](url)"), not a real link. Counted, not skipped silently.
        placeholders++;
        continue;
      }
      const resolved = normalize(join(dirname(f.target), path));
      if (!(await exists(join(root, resolved)))) {
        fail(`${f.target}:${line}: broken relative link "${target}" -> ${resolved}`);
      }
    }
  }
  if (placeholders > 0) {
    notes.push(`known prompt-template placeholder target "url" x${placeholders} in skills/why/references/synthesizer-prompt.md (upstream template text, not a link)`);
  }
}

// Deterministic freshness evidence for the committed benny fixture artifact:
// the producer itself, the full transitive set of behavior-bearing Benny
// runtime sources (including src/runner.ts, src/models.ts and the dependency
// lock that pins every external input), the tracker adapters, the HTTP
// transports fixture, and the workspace fixture + installed Benny pack. The
// producer records this digest with the artifact; the checker recomputes it
// from the current tree, so evidence generated against edited or drifted
// behavior-bearing content (or one whose input list was hand-trimmed) fails
// instead of masquerading as current. This is freshness evidence only — it is
// self-asserted, recomputable JSON and proves nothing about execution; the
// runtime proof is actually running scripts/smoke-benny.ts, and
// live-deployment proof still requires the live readback gate.
const BENNY_PROOF_FIXED_INPUTS = [
  "src/benny.ts",
  "src/benny-actions.ts",
  "src/benny-policy.ts",
  "src/benny-run.ts",
  "src/benny-setup.ts",
  "src/benny-socket.ts",
  "src/benny-workspace.ts",
  "src/models.ts",
  "src/runner.ts",
  "bun.lock",
  "scripts/check-content.ts",
  "scripts/fixtures/benny-transports.ts",
  "scripts/smoke-benny.ts",
  "src/trackers/contract.ts",
  "src/trackers/linear.ts",
];
const BENNY_PROOF_INPUT_TREES = ["automations/benny", "scripts/fixtures/benny-workspace"];

async function walkProofInputs(root: string, rel: string, out: string[]): Promise<void> {
  const entries = (await readdir(join(root, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkProofInputs(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

export async function bennyProofInputs(root: string): Promise<string[]> {
  const inputs: string[] = [];
  for (const fixed of BENNY_PROOF_FIXED_INPUTS) {
    if (!(await exists(join(root, fixed)))) fail(`benny proof input ${fixed} does not exist`);
    inputs.push(fixed);
  }
  for (const tree of BENNY_PROOF_INPUT_TREES) await walkProofInputs(root, tree, inputs);
  return inputs.sort();
}

export async function bennyProofDigest(root: string): Promise<string> {
  const hasher = createHash("sha256");
  for (const rel of await bennyProofInputs(root)) {
    const bytes = await readFile(join(root, rel));
    hasher.update(`${rel}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return hasher.digest("hex");
}

// Exact per-phase receipt arrays the committed fixture proof must show
// (mirrors src/benny-run.ts CANARY_REQUIRED; update both together).
const BENNY_PROOF_PHASE_RECEIPTS: Record<string, string[]> = {
  triage: ["slack.verdict.readback", "tracker.mutation.readback"],
  reproduce: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"],
};

export async function checkBennyFixtureProof(root: string): Promise<string[]> {
  const found: string[] = [];
  // The committed artifact is deterministic freshness evidence, not
  // authenticated execution proof: every field below is ordinary,
  // repository-authored JSON. Its only checkable authority is the recomputed
  // digest over the canonical input set and the structural shape of the
  // recorded receipts. Runtime proof is executing scripts/smoke-benny.ts;
  // live-deployment proof requires the live Slack/tracker/GitHub readback gate.
  const label = "proofs/benny-runtime.json";
  const path = join(root, "proofs", "benny-runtime.json");
  if (!(await exists(path))) {
    found.push(`${label} is missing; the fixture-run freshness evidence must be committed`);
    return found;
  }
  let proof: unknown;
  try {
    proof = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    found.push(`${label} is not valid JSON: ${e}`);
    return found;
  }
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
    found.push(`${label} must be a JSON object`);
    return found;
  }
  const p = proof as Record<string, unknown>;
  if (p.fixture !== true) found.push(`${label}: fixture must be true — the artifact is fixture-only evidence`);
  if (p.liveReadback !== false) found.push(`${label}: liveReadback must be false — fixture runs never prove live-deployment parity`);
  if (typeof p.capturedAt !== "string" || Number.isNaN(Date.parse(p.capturedAt))) found.push(`${label}: capturedAt must be an ISO timestamp`);
  if (typeof p.actualModel !== "string" || p.actualModel.length === 0) found.push(`${label}: actualModel must name the concrete model the fixture run used`);

  // Every transport must be a local fixture endpoint; a live URL here would
  // mean the run touched something outside the fixture boundary.
  const transports = p.fixtureTransports;
  if (typeof transports !== "object" || transports === null || Array.isArray(transports)) {
    found.push(`${label}: fixtureTransports must record the slack/tracker/github fixture endpoints`);
  } else {
    const t = transports as Record<string, unknown>;
    for (const name of ["slack", "tracker", "github"]) {
      const value = t[name];
      const local =
        typeof value === "string" &&
        (name === "github"
          ? /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)
          : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)(\/|$)/.test(value));
      if (!local) found.push(`${label}: fixtureTransports.${name} must be a loopback fixture endpoint, got ${JSON.stringify(value)}`);
    }
  }

  // Zero-window disclosure: the proof must list exactly the budget windows the
  // fixture zeroed (at least one — the point is that no human-wait window ran).
  const budgets = p.effectiveBudgets;
  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    found.push(`${label}: effectiveBudgets must record the budgets the fixture ran with`);
  } else {
    const entries = Object.entries(budgets as Record<string, unknown>);
    if (entries.length === 0) found.push(`${label}: effectiveBudgets is empty`);
    for (const [key, value] of entries) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        found.push(`${label}: effectiveBudgets.${key} must be a nonnegative number`);
      }
    }
    const zeroed = entries.filter(([, value]) => value === 0).map(([key]) => key).sort();
    const disclosed = Array.isArray(p.effectiveZeroWaitWindows) ? [...(p.effectiveZeroWaitWindows as unknown[])].map(String).sort() : null;
    if (!disclosed) found.push(`${label}: effectiveZeroWaitWindows must disclose every zeroed budget window`);
    else if (JSON.stringify(disclosed) !== JSON.stringify(zeroed)) {
      found.push(`${label}: effectiveZeroWaitWindows [${disclosed}] does not match the zeroed budget windows [${zeroed}]`);
    } else if (zeroed.length === 0) {
      found.push(`${label}: the fixture must zero at least one wait window and disclose it`);
    }
  }

  // Both phases, in order, successful, with the exact receipt arrays.
  const phases = p.phases;
  if (!Array.isArray(phases) || phases.length !== 2) {
    found.push(`${label}: phases must record exactly the triage and reproduce phases, both executed`);
  } else {
    const [triage, reproduce] = phases as Array<Record<string, unknown>>;
    for (const [expected, phase] of [["triage", triage], ["reproduce", reproduce]] as const) {
      if (typeof phase !== "object" || phase === null) {
        found.push(`${label}: ${expected} phase result is missing`);
        continue;
      }
      if (phase.phase !== expected) found.push(`${label}: expected phase ${expected}, got ${JSON.stringify(phase.phase)}`);
      if (phase.status !== "succeeded") found.push(`${label}: phase ${expected} must have succeeded, got ${JSON.stringify(phase.status)}`);
      if (phase.diagnostic !== undefined) found.push(`${label}: phase ${expected} succeeded but recorded a diagnostic ${JSON.stringify(phase.diagnostic)}`);
      const required = BENNY_PROOF_PHASE_RECEIPTS[expected];
      if (JSON.stringify(phase.canaryEvidence) !== JSON.stringify(required)) {
        found.push(`${label}: phase ${expected} canaryEvidence must be exactly [${required.join(", ")}], got ${JSON.stringify(phase.canaryEvidence)}`);
      }
    }
  }

  // Outcome cardinality and readback shapes.
  if (p.trackerIssues !== 1) found.push(`${label}: trackerIssues must be exactly 1, got ${JSON.stringify(p.trackerIssues)}`);
  if (p.draftPulls !== 1) found.push(`${label}: draftPulls must be exactly 1, got ${JSON.stringify(p.draftPulls)}`);
  if (typeof p.publishedHeadOid !== "string" || !/^[0-9a-f]{40,64}$/.test(p.publishedHeadOid)) {
    found.push(`${label}: publishedHeadOid must be a 40-64 hex commit OID, got ${JSON.stringify(p.publishedHeadOid)}`);
  }
  if (typeof p.sourceThreadPosts !== "number" || p.sourceThreadPosts < 2) {
    found.push(`${label}: sourceThreadPosts must record at least the verdict and reproduction thread replies`);
  }
  if (p.canaryEligible !== true) found.push(`${label}: canaryEligible must be true — the fixture run must satisfy the recorded-canary gate`);

  // Producer binding: the input list must be the canonical behavior-bearing
  // set and the digest must match the current tree; anything else is stale or
  // handwritten.
  if (!Array.isArray(p.producerInputs) || (p.producerInputs as unknown[]).some((entry) => typeof entry !== "string")) {
    found.push(`${label}: producerInputs must list the exact behavior-bearing inputs the producer digested`);
  } else {
    const canonical = await bennyProofInputs(root);
    if (JSON.stringify(p.producerInputs) !== JSON.stringify(canonical)) {
      const missing = canonical.filter((entry) => !(p.producerInputs as string[]).includes(entry));
      const extra = (p.producerInputs as string[]).filter((entry) => !canonical.includes(entry));
      found.push(`${label}: producerInputs diverge from the canonical set (missing: [${missing}], extra: [${extra}])`);
    }
    if (typeof p.producerDigest !== "string") {
      found.push(`${label}: producerDigest must be the canonical digest of the producer plus behavior-bearing inputs`);
    } else {
      const digest = await bennyProofDigest(root);
      if (p.producerDigest !== digest) {
        found.push(`${label}: producerDigest ${p.producerDigest} does not match the current tree (${digest}) — regenerate the freshness evidence by running scripts/smoke-benny.ts`);
      }
    }
  }
  return found;
}
async function main(): Promise<void> {
  const root = process.cwd();

  let inv: Inventory | null = null;
  try {
    inv = parseInventory(JSON.parse(await readFile(join(root, "upstream.json"), "utf8")));
  } catch (e) {
    fail(`upstream.json is not valid JSON: ${e}`);
  }
  if (!inv) {
    fail("upstream.json does not match the inventory shape {repository,commit,version,subtree,files[]}");
  } else {
    checkHeader(inv);
    const digest = inventoryDigest(inv.files);
    const pinnedDigest = "990c1305804ee4d93f6c3da9d8e77b80349817446eba05ff8dcafb98e8815ba8";
    if (digest !== pinnedDigest) {
      fail(`upstream.json: pinned integrity digest mismatch (computed ${digest}, pinned ${pinnedDigest}) — source rows, targets, modes, or adaptation verification metadata (kind/artifacts) were changed without repinning`);
    }
    const seenSources: string[] = [];
    for (const f of inv.files) {
      if (seenSources.includes(f.source)) fail(`${f.source}: duplicate inventory entry`);
      seenSources.push(f.source);
      for (const e of await checkFileEntry(root, f)) fail(e);
    }
    const expectedSkills = [...DIRECT_SKILLS, ...PRINCIPLES];
    await checkSkillDirs(root, expectedSkills);
    const agentNames = await checkAgents(root);
    const playbooks = await checkPlaybooks(root);
    checkBennyExclusion(inv);
    await checkBennyFiles(root, inv);
    await checkNoDiscoverySymlinks(root);
    await checkLinks(root, inv);
    for (const e of await checkVerificationMap(root)) fail(e);
    for (const e of await checkBennyFixtureProof(root)) fail(e);
    console.log(`check-content: ${inv.files.length} inventory files, ${expectedSkills.length} expected skills, ${agentNames.length} agents, ${playbooks.length} playbooks`);
  }

  for (const n of notes) console.log(`NOTE ${n}`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`FAIL ${e}`);
    console.log(`check-content: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log("check-content: OK");
}

if (import.meta.main) await main();
