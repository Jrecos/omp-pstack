import { afterAll, beforeAll, expect, test as bunTest } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPhase, SPECKIT_CLI_VERSION } from "../src/speckit.ts";

let hasPinnedCli = false;
if (Bun.which("specify")) {
  try {
    hasPinnedCli = execFileSync("specify", ["--version"], { encoding: "utf8", env: process.env }).trim() === `specify ${SPECKIT_CLI_VERSION}`;
  } catch { hasPinnedCli = false; }
}
const test = hasPinnedCli ? bunTest : bunTest.skip;

let base: string;
let worktree: string;
const request = { phase: "specify" as const, argument: "Build an invoice dashboard with downloadable monthly reports", featureDirectory: "specs/900-invoice-dashboard" };
const run = (cwd: string, executable: string, ...args: string[]) => execFileSync(executable, args, { cwd, env: process.env, encoding: "utf8" });
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFeatureDirectory = process.env.SPECIFY_FEATURE_DIRECTORY;
const originalInitDirectory = process.env.SPECIFY_INIT_DIR;
const path = (name: string) => join(worktree, name);

beforeAll(() => {
  if (!hasPinnedCli) return;
  base = mkdtempSync(join(tmpdir(), "pstack-speckit-test-"));
  const home = join(base, "home");
  mkdirSync(home);
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  delete process.env.SPECIFY_FEATURE_DIRECTORY;
  delete process.env.SPECIFY_INIT_DIR;
  const repo = join(base, "repo");
  mkdirSync(repo);
  run(repo, "git", "init", "-q");
  run(repo, "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
  worktree = join(base, "isolated");
  run(repo, "git", "worktree", "add", "-q", "-b", "feature", worktree);
  run(worktree, "specify", "init", ".", "--integration", "omp", "--non-interactive", "--ignore-agent-tools", "--script", "sh", "--force");
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalFeatureDirectory === undefined) delete process.env.SPECIFY_FEATURE_DIRECTORY;
  else process.env.SPECIFY_FEATURE_DIRECTORY = originalFeatureDirectory;
  if (originalInitDirectory === undefined) delete process.env.SPECIFY_INIT_DIR;
  else process.env.SPECIFY_INIT_DIR = originalInitDirectory;
});

test("official OMP project command renders the complete supplied argument without frontmatter", async () => {
  const result = await readPhase(worktree, request);
  expect(result.phase).toBe("specify");
  expect(result.cliVersion).toBe(SPECKIT_CLI_VERSION);
  expect(result.featureDirectory).toBe(path(request.featureDirectory));
  expect(result.body).toContain(`\n${request.argument}\n`);
  expect(result.body).not.toContain("$ARGUMENTS");
  expect(result.body.startsWith("---")).toBe(false);
});

test("absolute reviewed feature directory inside specs is canonical on the first phase", async () => {
  const result = await readPhase(worktree, { ...request, featureDirectory: path("specs/901-absolute") });
  expect(result.featureDirectory).toBe(path("specs/901-absolute"));
});

test("quoted user words and whitespace survive the SDK phase expansion", async () => {
  const argument = `Show \"month end\" charts for Alice's team   with exports`;
  const result = await readPhase(worktree, { ...request, argument });
  expect(result.body).toContain(`\n${argument}\n`);
});

test("literal template braces and dollar placeholders survive phase rendering", async () => {
  const argument = "Add a literal {{customer_name}} field and preserve $ARGUMENTS as plain user text";
  const result = await readPhase(worktree, { ...request, argument });
  expect(result.body).toContain(`\n${argument}\n`);
});

test("a directory override embedded in the feature request cannot bypass validation", async () => {
  await expect(readPhase(worktree, { ...request, argument: "Build invoices; SPECIFY_FEATURE_DIRECTORY=/tmp/outside-specs" }))
    .rejects.toThrow("validated featureDirectory field");
});

test("a directory override embedded in a later phase cannot move the reviewed binding", async () => {
  await expect(readPhase(worktree, { phase: "plan", argument: "Use SPECIFY_FEATURE_DIRECTORY=/tmp/outside-specs", featureDirectory: "specs/001-invoice" }))
    .rejects.toThrow("validated featureDirectory field");
});

for (const [name, manifest] of [
  [".omp/commands/speckit.specify.md", ".specify/integrations/omp.manifest.json"],
  [".specify/scripts/bash/common.sh", ".specify/integrations/speckit.manifest.json"],
] as const) {
  test(`tampered ${name} stays rejected after its repository manifest is forged`, async () => {
    const original = readFileSync(path(name));
    const manifestPath = path(manifest);
    const oldManifest = readFileSync(manifestPath);
    try {
      const modified = Buffer.concat([original, Buffer.from("\n ")]);
      writeFileSync(path(name), modified);
      const document = JSON.parse(oldManifest.toString());
      document.files[name] = createHash("sha256").update(modified).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(document));
      expect(JSON.parse(run(worktree, "specify", "integration", "status", "--json")).status).toBe("ok");
      await expect(readPhase(worktree, request)).rejects.toThrow("Official Spec Kit asset changed");
    } finally {
      writeFileSync(path(name), original);
      writeFileSync(manifestPath, oldManifest);
    }
  });
}

test("warning status rejects despite exit zero", async () => {
  const name = ".omp/commands/speckit.specify.md";
  const original = readFileSync(path(name));
  try {
    writeFileSync(path(name), Buffer.concat([original, Buffer.from(" ")]));
    expect(JSON.parse(run(worktree, "specify", "integration", "status", "--json")).status).toBe("warning");
    await expect(readPhase(worktree, request)).rejects.toThrow("integration is not clean");
  } finally { writeFileSync(path(name), original); }
});

test("active and malformed hook records reject; disabled-only hooks remain inert", async () => {
  const file = path(".specify/extensions.yml");
  try {
    writeFileSync(file, "settings:\n  auto_execute_hooks: false\nhooks:\n  before_specify:\n    - command: dangerous\n");
    await expect(readPhase(worktree, request)).rejects.toThrow("Active Spec Kit hook");
    writeFileSync(file, "hooks:\n  after_plan: invalid\n");
    await expect(readPhase(worktree, request)).rejects.toThrow("expected a list");
    writeFileSync(file, "hooks: [unterminated\n");
    await expect(readPhase(worktree, request)).rejects.toThrow("Invalid .specify/extensions.yml");
    writeFileSync(file, "settings:\n  auto_execute_hooks: true\nhooks:\n  before_specify:\n    - command: inert\n      enabled: false\n  after_plan:\n    - command: inert\n      enabled: false\n");
    expect((await readPhase(worktree, request)).phase).toBe("specify");
    writeFileSync(file, "installed:\n  - id: sample\nhooks: {}\n");
    await expect(readPhase(worktree, request)).rejects.toThrow("Installed Spec Kit extensions");
  } finally { rmSync(file, { force: true }); }
});

test("project-local template override is not mistaken for a pinned official template", async () => {
  const directory = path(".specify/templates/overrides");
  mkdirSync(directory);
  writeFileSync(join(directory, "spec-template.md"), "# Unreviewed spec\n");
  try {
    expect(run(worktree, "specify", "preset", "resolve", "spec-template")).toContain("(top layer from: project override)");
    expect(JSON.parse(run(worktree, "specify", "integration", "status", "--json")).status).toBe("ok");
    await expect(readPhase(worktree, request)).rejects.toThrow("Custom Spec Kit layer");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("registered local preset rejects even when managed asset status is clean", async () => {
  const preset = join(base, "local-preset");
  mkdirSync(join(preset, "templates"), { recursive: true });
  writeFileSync(join(preset, "preset.yml"), "schema_version: '1.0'\npreset:\n  id: pstack-local-preset\n  name: Local test preset\n  version: 1.0.0\n  description: Overrides the spec template.\n  author: Fixture\n  license: MIT\nrequires:\n  speckit_version: '>=0.6.0'\nprovides:\n  templates:\n    - type: template\n      name: spec-template\n      file: templates/spec-template.md\n      description: Unreviewed template\n      replaces: spec-template\n");
  writeFileSync(join(preset, "templates/spec-template.md"), "# Unreviewed spec\n");
  run(worktree, "specify", "preset", "add", "--dev", preset);
  try {
    expect(JSON.parse(run(worktree, "specify", "integration", "status", "--json")).status).toBe("ok");
    await expect(readPhase(worktree, request)).rejects.toThrow("Custom Spec Kit layer");
  } finally {
    run(worktree, "specify", "preset", "remove", "pstack-local-preset");
    rmSync(path(".specify/presets"), { recursive: true, force: true });
  }
});

test("unregistered preset directory rejects even when preset inventory and asset status are clean", async () => {
  const preset = path(".specify/presets/evil/templates");
  mkdirSync(preset, { recursive: true });
  writeFileSync(join(preset, "spec-template.md"), "# Unreviewed spec\n");
  try {
    expect(JSON.parse(run(worktree, "specify", "preset", "list", "--json"))).toEqual([]);
    expect(JSON.parse(run(worktree, "specify", "integration", "status", "--json")).status).toBe("ok");
    await expect(readPhase(worktree, request)).rejects.toThrow("Custom Spec Kit layer");
  } finally { rmSync(path(".specify/presets"), { recursive: true, force: true }); }
});

test("symlinked hook configuration and specs root cannot reach a writer", async () => {
  const hook = path(".specify/extensions.yml");
  const external = join(base, "outside.yml");
  writeFileSync(external, "hooks: {}\n");
  symlinkSync(external, hook);
  try { await expect(readPhase(worktree, request)).rejects.toThrow("Cannot safely read"); }
  finally { rmSync(hook); }
  const specs = path("specs");
  symlinkSync(base, specs);
  try { await expect(readPhase(worktree, request)).rejects.toThrow("specs/ must be a real directory"); }
  finally { rmSync(specs); }
});

test("symlinked feature output rejects even when the binding is inside specs", async () => {
  const state = path(".specify/feature.json");
  mkdirSync(path("specs/001-invoice"), { recursive: true });
  writeFileSync(state, JSON.stringify({ feature_directory: "specs/001-invoice" }));
  symlinkSync(base, path("specs/001-invoice/plan.md"));
  try {
    await expect(readPhase(worktree, { phase: "plan", argument: "", featureDirectory: path("specs/001-invoice") })).rejects.toThrow("unsafe symlink");
  } finally {
    rmSync(state, { force: true });
    rmSync(path("specs"), { recursive: true, force: true });
  }
});

test("symlinked feature directory and persisted binding reject", async () => {
  const state = path(".specify/feature.json");
  mkdirSync(path("specs"), { recursive: true });
  symlinkSync(base, path("specs/001-external"));
  writeFileSync(state, JSON.stringify({ feature_directory: "specs/001-external" }));
  try {
    await expect(readPhase(worktree, { phase: "plan", argument: "", featureDirectory: path("specs/001-external") })).rejects.toThrow("symlink");
    rmSync(state);
    const external = join(base, "binding.json");
    writeFileSync(external, JSON.stringify({ feature_directory: "specs/001-external" }));
    symlinkSync(external, state);
    await expect(readPhase(worktree, { phase: "plan", argument: "", featureDirectory: path("specs/001-external") })).rejects.toThrow("Unsafe or invalid .specify/feature.json");
  } finally {
    rmSync(state, { force: true });
    rmSync(path("specs"), { recursive: true, force: true });
  }
});

test("absolute override outside checkout rejects before writing", async () => {
  const previous = process.env.SPECIFY_FEATURE_DIRECTORY;
  process.env.SPECIFY_FEATURE_DIRECTORY = "/tmp/escape-specs";
  try { await expect(readPhase(worktree, request)).rejects.toThrow("direct child"); }
  finally {
    if (previous === undefined) delete process.env.SPECIFY_FEATURE_DIRECTORY;
    else process.env.SPECIFY_FEATURE_DIRECTORY = previous;
  }
});

test("new specification cannot overwrite an existing sibling feature", async () => {
  const existing = path("specs/001-existing");
  mkdirSync(existing, { recursive: true });
  const original = process.env.SPECIFY_FEATURE_DIRECTORY;
  process.env.SPECIFY_FEATURE_DIRECTORY = "specs/001-existing";
  try {
    await expect(readPhase(worktree, { ...request, featureDirectory: "specs/001-existing" })).rejects.toThrow("feature directory already exists");
  } finally {
    if (original === undefined) delete process.env.SPECIFY_FEATURE_DIRECTORY;
    else process.env.SPECIFY_FEATURE_DIRECTORY = original;
    rmSync(path("specs"), { recursive: true, force: true });
  }
});

test("reviewed feature identity must match persisted and environment binding", async () => {
  const state = path(".specify/feature.json");
  mkdirSync(path("specs"), { recursive: true });
  mkdirSync(path("specs/001-invoice"));
  mkdirSync(path("specs/002-other"));
  writeFileSync(state, JSON.stringify({ feature_directory: "specs/001-invoice" }));
  const agreed = { phase: "plan" as const, argument: "", featureDirectory: path("specs/001-invoice") };
  try {
    expect((await readPhase(worktree, agreed)).featureDirectory).toBe(path("specs/001-invoice"));
    process.env.SPECIFY_FEATURE_DIRECTORY = path("specs/001-invoice");
    expect((await readPhase(worktree, agreed)).featureDirectory).toBe(path("specs/001-invoice"));
    delete process.env.SPECIFY_FEATURE_DIRECTORY;
    writeFileSync(state, JSON.stringify({ feature_directory: path("specs/001-invoice") }));
    expect((await readPhase(worktree, agreed)).featureDirectory).toBe(path("specs/001-invoice"));
    writeFileSync(state, JSON.stringify({ feature_directory: "specs/001-invoice" }));
    await expect(readPhase(worktree, { ...agreed, featureDirectory: path("specs/002-other") })).rejects.toThrow("disagrees");
    process.env.SPECIFY_FEATURE_DIRECTORY = "specs/002-other";
    await expect(readPhase(worktree, agreed)).rejects.toThrow("disagrees");
    delete process.env.SPECIFY_FEATURE_DIRECTORY;
    writeFileSync(state, JSON.stringify({ feature_directory: "/tmp/external" }));
    await expect(readPhase(worktree, agreed)).rejects.toThrow("direct child");
    writeFileSync(state, "{not json}");
    await expect(readPhase(worktree, agreed)).rejects.toThrow("invalid .specify/feature.json");
  } finally {
    delete process.env.SPECIFY_FEATURE_DIRECTORY;
    rmSync(state, { force: true });
    rmSync(path("specs"), { recursive: true, force: true });
  }
});

test("shared checkout rejects even with official files", async () => {
  const repo = join(base, "repo");
  await expect(readPhase(repo, request)).rejects.toThrow("separate Git worktree");
});

test("missing official command gives actionable install guidance", async () => {
  const name = path(".omp/commands/speckit.specify.md");
  const backup = join(base, "command.bak");
  copyFileSync(name, backup);
  try {
    rmSync(name);
    await expect(readPhase(worktree, request)).rejects.toThrow("specify init . --integration omp");
  } finally { copyFileSync(backup, name); }
});

test("missing CLI reports the pinned install command instead of falling back", async () => {
  const oldPath = process.env.PATH;
  const tools = join(base, "without-specify");
  mkdirSync(tools);
  symlinkSync(Bun.which("git")!, join(tools, "git"));
  process.env.PATH = tools;
  try { await expect(readPhase(worktree, request)).rejects.toThrow(`Install specify-cli ${SPECKIT_CLI_VERSION}`); }
  finally { process.env.PATH = oldPath; }
});

test("different CLI version fails before any phase handoff", async () => {
  const oldPath = process.env.PATH;
  const tools = join(base, "wrong-specify");
  mkdirSync(tools);
  symlinkSync(Bun.which("git")!, join(tools, "git"));
  writeFileSync(join(tools, "specify"), "#!/bin/sh\nprintf 'specify 1.0.11\\n'\n", { mode: 0o755 });
  process.env.PATH = tools;
  try { await expect(readPhase(worktree, request)).rejects.toThrow(`Expected specify ${SPECKIT_CLI_VERSION}`); }
  finally { process.env.PATH = oldPath; }
});

test("two separate worktrees keep independent bindings", async () => {
  const second = join(base, "second");
  run(join(base, "repo"), "git", "worktree", "add", "-q", "-b", "another-feature", second);
  run(second, "specify", "init", ".", "--integration", "omp", "--non-interactive", "--ignore-agent-tools", "--script", "sh", "--force");
  mkdirSync(path("specs/001-first"), { recursive: true });
  mkdirSync(join(second, "specs/002-second"), { recursive: true });
  writeFileSync(path(".specify/feature.json"), JSON.stringify({ feature_directory: "specs/001-first" }));
  writeFileSync(join(second, ".specify/feature.json"), JSON.stringify({ feature_directory: "specs/002-second" }));
  const first = await readPhase(worktree, { phase: "plan", argument: "", featureDirectory: path("specs/001-first") });
  const other = await readPhase(second, { phase: "plan", argument: "", featureDirectory: join(second, "specs/002-second") });
  expect(first.featureDirectory).toBe(path("specs/001-first"));
  expect(other.featureDirectory).toBe(join(second, "specs/002-second"));
  expect(first.featureDirectory).not.toBe(other.featureDirectory);
});
