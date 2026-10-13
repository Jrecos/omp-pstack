import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, createAgentSession, discoverAuthStorage, loadSkillsFromDir, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { getAgentDir, getConfigAgentDirName, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import pstack from "../src/extension.ts";
import { ROLES, parseConfig, resolvePaths, saveRoles } from "../src/models.ts";

import { manifestDigest } from "./manifest-digest.ts";
const root = join(import.meta.dir, "..");
const temporary = process.env.PSTACK_SMOKE_HOME ?? await mkdtemp(join(tmpdir(), "pstack-model-smoke-"));
const profile = join(temporary, getConfigAgentDirName());
const cwd = join(temporary, "workspace");
const previousProfile = process.env.PI_CODING_AGENT_DIR;
const previousHome = process.env.HOME;
const worktreeBase = join(temporary, "worktrees");
const previousGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
const previousWorktreeBase = process.env.OMP_WORKTREE_DIR;
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "P Stack isolation fixture", GIT_AUTHOR_EMAIL: "pstack-smoke@example.invalid",
  GIT_COMMITTER_NAME: "P Stack isolation fixture", GIT_COMMITTER_EMAIL: "pstack-smoke@example.invalid",
};
if (!process.env.PSTACK_SMOKE_HOME) {
  const child = Bun.spawn(["bun", import.meta.path], {
    cwd: root, stdout: "inherit", stderr: "inherit",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), ...gitEnvironment, HOME: temporary, PI_CODING_AGENT_DIR: profile, OMP_WORKTREE_DIR: worktreeBase, PSTACK_SMOKE_HOME: temporary, PSTACK_SMOKE_AUTH_DIR: getAgentDir() },
  });
  let code: number;
  try { code = await child.exited; }
  finally { await rm(temporary, { recursive: true, force: true }); }
  process.exit(code);
}
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, gitEnvironment);
process.env.OMP_WORKTREE_DIR = worktreeBase;
process.umask(0o077);

async function git(repo: string, args: string[], requireSuccess = true) {
  const started = performance.now();
  const child = spawn("git", args, { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, overflow = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collect = (text: string, error: boolean) => {
    if (error) stderr += text;
    else stdout += text;
    if (stdout.length + stderr.length > 1_048_576) { overflow = true; child.kill("SIGKILL"); }
  };
  child.stdout.on("data", (text: string) => collect(text, false));
  child.stderr.on("data", (text: string) => collect(text, true));
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const sample = { argv: ["git", ...args], cwd: repo, ...exit, stdout, stderr, timedOut, overflow, durationMs: performance.now() - started };
    if (requireSuccess) assert(!timedOut && !overflow && exit.code === 0, JSON.stringify(sample));
    return sample;
  } finally { clearTimeout(timer); }
}
const authStorage = await discoverAuthStorage(process.env.PSTACK_SMOKE_AUTH_DIR);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const firstName = process.env.PSTACK_SMOKE_MODEL ?? "openai-codex/gpt-6-astra";
const secondName = process.env.PSTACK_SMOKE_SECOND_MODEL ?? "openai-codex/gpt-5.6-luna";
const first = modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === firstName);
const second = modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === secondName);
assert(first && second && firstName !== secondName, "Two explicitly selected authenticated models are required.");
const taskBatches: TaskToolDetails[] = [];
let isolationFailureRecorded = false;
const observer = (pi: ExtensionAPI) => {
  pi.on("tool_execution_end", (event) => {
    if (event.isError) console.error(JSON.stringify({ tool: event.toolName, error: event.result }));
    if (event.toolName !== "task" || event.isError) return;
    const result = event.result;
    assert(result && typeof result === "object" && "details" in result);
    // This is the installed native task tool's declared result, not model-authored JSON.
    const details = result.details as TaskToolDetails;
    assert(Array.isArray(details.results));
    taskBatches.push(details);
  });
};
try {
  await mkdir(profile, { recursive: true });
  await mkdir(cwd);
  await symlink(join(root, "skills"), join(profile, "skills"), "dir");
  process.env.HOME = temporary;
  process.env.PI_CODING_AGENT_DIR = profile;
  refreshDirsFromEnv();
  const paths = resolvePaths();
  const roles: Record<string, string | string[]> = Object.fromEntries(ROLES.map((role) => [role, "inherit-parent"]));
  roles["interrogate reviewers"] = ["inherit-parent", "auto", secondName];
  // Approved pool: the concrete identities actually routed plus explicit alias
  // permission. gpt-6-astra is kept even though no role uses it concretely, so
  // the smoke also exercises unused-pool persistence.
  const pool = [`${first.provider}/${first.id}`, `${second.provider}/${second.id}`, "inherit-parent", "auto"];
  const loaded = await loadSkillsFromDir({ dir: join(root, "skills"), source: "omp-pstack:smoke" });
  const manager = SessionManager.create(cwd, join(temporary, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir: profile, authStorage, modelRegistry, model: first, sessionManager: manager,
    agentRegistry: new AgentRegistry(),
    settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "async.enabled": false, "task.maxConcurrency": 3, "task.structured": false }),
    extensions: [pstack, observer], disableExtensionDiscovery: true,
    skills: loaded.skills, rules: [], contextFiles: [], promptTemplates: [],
    toolNames: ["task", "pstack_agent", "pstack_models"], enableMCP: false, enableLsp: false,
  });
  try {
    await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: (error) => { throw new Error(error.error); } });
    const parameters = session.getAllToolInfos().find((tool) => tool.name === "pstack_agent")?.parameters as { toJsonSchema?: () => unknown } | undefined;
    if (typeof parameters?.toJsonSchema !== "function") throw new Error("pstack_agent did not publish a native tool schema");
    console.error(JSON.stringify({ lookupSchema: parameters.toJsonSchema() }));
    const setup = loaded.skills.find((skill) => skill.name === "setup-pstack")!;
    await session.promptCustomMessage({
      customType: "skill-prompt", attribution: "user", display: false,
      details: { name: "setup-pstack", path: setup.filePath },
      content: `${(await readFile(setup.filePath, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}\n\nComplete setup now; there is no human to confirm with, so proceed autonomously. Detect models with pstack_models list. The approved pool is EXACTLY: ${pool.join(", ")}. Persist all four members even though no role uses ${first.provider}/${first.id} concretely (it stays routed for later). The user chose the budget "medium — high reasoning". Recommend a value for all 17 roles from that pool, routing at least the judgment roles to concrete pool models, apply the budget, then save with pstack_models (action "save", pool, and all 17 roles). Never use a model outside the pool. Do not ask questions; after saving, print a one-line confirmation.`,
    });
    const recommendedRule = await readFile(paths.rulePath, "utf8");
    const recommended = parseConfig(recommendedRule);
    assert(recommended.exists, "completed setup must have written the pstack-models rule");
    assert.match(recommendedRule, /^pool: /m);
    for (const member of pool) assert.ok(recommendedRule.includes(member), `recommended rule must persist pool member ${member}`);
    // save enforces pool membership, so a completed save already proves every
    // recommended selector is a pool member or a granted alias.
    const configuredCount = ROLES.filter((role) => (recommended.roles[role] ?? []).length > 0).length;
    assert.equal(configuredCount, ROLES.length, "completed setup must configure every supported role");
    const concrete = ROLES.flatMap((role) => recommended.roles[role] ?? []).filter((entry) => entry !== "inherit-parent" && entry !== "auto");
    assert(concrete.length > 0, "setup must route at least one role to a concrete pool model");
    for (const entry of concrete) assert.match(entry, /:high$/, `medium budget must set :high on concrete selector ${entry}`);
    await saveRoles(roles, { list: () => modelRegistry.getAvailable(), current: () => first }, paths, cwd, pool);
    const savedRule = await readFile(paths.rulePath, "utf8");
    assert.match(savedRule, /^pool: /m);
    for (const member of pool) assert.ok(savedRule.includes(member), `pool must persist member ${member}`);
    const beforeCancel = await readFile(paths.rulePath, "utf8");
    await session.promptCustomMessage({
      customType: "skill-prompt", attribution: "user", display: false,
      details: { name: "setup-pstack", path: setup.filePath },
      content: `${(await readFile(setup.filePath, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}\n\nThe user CANCELS setup. Do not save or prepare anything. Confirm cancellation only.`,
    });
    assert.equal(await readFile(paths.rulePath, "utf8"), beforeCancel);
    const runPanel = async (label: string, expectedParent: string) => {
      const start = taskBatches.length;
      await session.prompt(`Call pstack_agent with exactly {"role":"interrogate reviewers","index":1,"kind":null,"model":null}, then index 2, then index 3. Use the saved role/index, not remembered setup defaults. Call native task once with the three returned agent names, preserving both alias entries and that order. Give each item solutionSpace "One literal final response; no files or implementation." Item N must ask its child to return exactly PSTACK_${label}_INDEX_N, with N replaced by its numeric index. Use names ${label}One, ${label}Two, ${label}Three. Shared context is "Return the assigned literal as the final message. No files, research, edits, tests, output schemas, or yield tool." Wait for all three. Do not omit or deduplicate a member. Afterwards say PANEL_COMPLETE.`);
      const results = taskBatches.slice(start).flatMap((batch) => batch.results);
      assert.equal(results.length, 3, `${label}: exactly three native tasks must settle`);
      for (const [index, result] of results.entries()) {
        assert.equal(result.exitCode, 0, result.error ?? result.stderr);
        const expected = index < 2 ? expectedParent : secondName;
        assert(result.resolvedModel === expected || result.resolvedModel?.startsWith(`${expected}:`), `${result.resolvedModel} must resolve to ${expected}`);
        assert.equal(result.output, `PSTACK_${label}_INDEX_${index + 1}`, "native task must return the assigned final text");
      }
    };
    const runArchitect = async (label: string, expectedParent: string) => {
      const start = taskBatches.length;
      await session.prompt(`Call pstack_agent with exactly {"role":"architect runners","index":1,"kind":null,"model":null}. Call native task once with the returned agent name and solutionSpace "One literal final response; no files or implementation." Use name ${label}Architect. Ask the child to return exactly PSTACK_${label}_ARCH as its final message. Shared context is "No files, research, edits, tests, output schemas, or yield tool." Wait for the result. Afterwards say ARCHITECT_COMPLETE.`);
      const results = taskBatches.slice(start).flatMap((batch) => batch.results);
      assert.equal(results.length, 1, `${label}: exactly one architect task must settle`);
      const result = results[0];
      assert.equal(result.exitCode, 0, result.error ?? result.stderr);
      assert.equal(result.output, `PSTACK_${label}_ARCH`, "native architect task must return the assigned final text");
      // The alias must follow the live parent after a model change.
      assert(result.resolvedModel === expectedParent || result.resolvedModel?.startsWith(`${expectedParent}:`), `${result.resolvedModel} must resolve to ${expectedParent}`);
    };
    await runPanel("First", firstName);
    await runArchitect("First", firstName);
    await session.setModelTemporary(second);
    await runPanel("Second", secondName);
    await runArchitect("Second", secondName);
    const sdkManifest = join(root, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json");
    const sdkMetadata: unknown = JSON.parse(await readFile(sdkManifest, "utf8"));
    assert(sdkMetadata && typeof sdkMetadata === "object" && "version" in sdkMetadata && typeof sdkMetadata.version === "string");
    const sdkVersion = sdkMetadata.version;
    const isolationCases = [];
    for (const apply of [false, true]) {
      const label = apply ? "ApplyOn" : "ApplyOff";
      const repo = join(cwd, `isolated-${label}`);
      const verification = join(cwd, `verify-${label}`);
      const marker = `PSTACK_${label}.txt`;
      const expectedBytes = `PSTACK_${label}_MARKER\n`;
      const expectedFinal = `PSTACK_${label}_ISOLATED`;
      const commands = [];
      const start = taskBatches.length;
      const taskCalls: Record<string, unknown>[] = [];
      const descriptorReceipts: unknown[] = [];
      const settings = {
        "memory.backend": "off", "autolearn.enabled": false, "async.enabled": false,
        "task.structured": false, "task.batch": true, "task.maxConcurrency": 1,
        "task.maxRuntimeMs": 180_000, "task.isolation.enabled": true,
        "task.isolation.apply": apply, "task.isolation.merge": "patch",
        "isolation.backend": "rcopy", "worktree.base": worktreeBase,
      } as const;
      await mkdir(repo, { mode: 0o700 });
      let isolatedSession: typeof session | undefined;
      const isolatedManager = SessionManager.create(repo, join(temporary, `sessions-${label}`));
      try {
        commands.push(await git(repo, ["init", "--template=", "-b", "main"]));
        commands.push(await git(repo, ["config", "user.name", gitEnvironment.GIT_AUTHOR_NAME]));
        commands.push(await git(repo, ["config", "user.email", gitEnvironment.GIT_AUTHOR_EMAIL]));
        commands.push(await git(repo, ["config", "core.hooksPath", "/dev/null"]));
        await writeFile(join(repo, "fixture.txt"), "PSTACK_ISOLATION_BASE\n");
        commands.push(await git(repo, ["add", "fixture.txt"]));
        commands.push(await git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "Isolation fixture"]));
        const base = await git(repo, ["rev-parse", "HEAD"]);
        commands.push(base);
        assert.equal(await Bun.file(join(repo, marker)).exists(), false);
        const capture = (pi: ExtensionAPI) => {
          pi.on("tool_call", event => {
            if (event.toolName !== "task") return;
            const input = event.input;
            assert(!("model" in input), "No per-call task model override is permitted");
            assert(Array.isArray(input.tasks) && input.tasks.length === 1, "Isolation requires one batch item");
            for (const item of input.tasks) {
              assert(item && typeof item === "object" && !("model" in item) && !("tools" in item));
              assert.equal(item.isolated, true);
              assert.equal(typeof item.solutionSpace, "string");
            }
            taskCalls.push(input);
          });
          pi.on("tool_execution_end", event => {
            if (event.toolName === "pstack_agent" && !event.isError) descriptorReceipts.push(event.result);
          });
        };
        ({ session: isolatedSession } = await createAgentSession({
          cwd: repo, agentDir: profile, authStorage, modelRegistry, model: first, sessionManager: isolatedManager,
          agentRegistry: new AgentRegistry(), settings: Settings.isolated(settings),
          extensions: [pstack, observer, capture], disableExtensionDiscovery: true,
          skills: [], rules: [], contextFiles: [], promptTemplates: [],
          toolNames: ["task", "pstack_agent"], enableMCP: false, enableLsp: false,
        }));
        await initializeExtensions(isolatedSession, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: (error) => { throw new Error(error.error); } });
        const parentTools = isolatedSession.getEnabledToolNames();
        assert(!parentTools.includes("write"), "Parent must have no write tool authority");
        const taskParameters = isolatedSession.getAllToolInfos().find(tool => tool.name === "task")?.parameters;
        assert(taskParameters && (typeof taskParameters === "object" || typeof taskParameters === "function") && "toJsonSchema" in taskParameters && typeof taskParameters.toJsonSchema === "function");
        const taskSchema: unknown = taskParameters.toJsonSchema();
        assert(taskSchema && typeof taskSchema === "object" && "properties" in taskSchema);
        const taskProperties = taskSchema.properties;
        assert(taskProperties && typeof taskProperties === "object" && "tasks" in taskProperties);
        const taskArray = taskProperties.tasks;
        assert(taskArray && typeof taskArray === "object" && "items" in taskArray);
        const itemSchema = taskArray.items;
        assert(itemSchema && typeof itemSchema === "object" && "properties" in itemSchema && "required" in itemSchema);
        const itemProperties = itemSchema.properties;
        assert(itemProperties && typeof itemProperties === "object" && Array.isArray(itemSchema.required));
        const started = performance.now();
        await isolatedSession.prompt(`Call pstack_agent with exactly {"role":"judgment and prose","index":null,"kind":null,"model":null}. This saved role resolves a generated general worker. Then call native task once with context "Write only the assigned marker in your isolated checkout. Do not edit the parent checkout, commit, run tests, spawn tasks, or use output schemas or yield. Return only the assigned final literal." and one tasks item. Use the returned agent, name "${label}Worker", isolated true, and solutionSpace "One new UTF-8 marker file with exact given bytes; no design choices." The task must tell the child to create relative file "${marker}" with exact UTF-8 bytes ${JSON.stringify(expectedBytes)} and finish with exactly "${expectedFinal}". Do not pass model or tools overrides. Wait for the native result. Afterwards say ISOLATION_COMPLETE. The parent has no file-writing tool and must not create the marker itself.`);
        const elapsedMs = performance.now() - started;
        const nativeBatches = taskBatches.slice(start);
        const results = nativeBatches.flatMap(batch => batch.results);
        assert.equal(taskCalls.length, 1);
        assert.equal(descriptorReceipts.length, 1);
        const receipt = descriptorReceipts[0];
        assert(receipt && typeof receipt === "object" && "details" in receipt);
        const descriptor = receipt.details;
        assert(descriptor && typeof descriptor === "object" && "agent" in descriptor && "kind" in descriptor && "model" in descriptor);
        assert.equal(descriptor.model, firstName);
        assert.equal(descriptor.kind, "general");
        assert.equal(results.length, 1, "Exactly one native isolated worker must settle");
        const result = results[0]!;
        assert.equal(result.agent, descriptor.agent);
        assert.equal(result.isolated, true);
        assert.equal(result.exitCode, 0, result.error ?? result.stderr);
        assert.equal(result.output, expectedFinal);
        assert(result.resolvedModel === firstName || result.resolvedModel?.startsWith(`${firstName}:`));
        assert(result.patchPath && result.hasRootChanges === true, "Native isolation must capture actual root changes");
        const patch = await readFile(result.patchPath, "utf8");
        assert(patch.trim().length > 0, "Retained native patch must be nonempty");
        const parentMarkerPresent = await Bun.file(join(repo, marker)).exists();
        assert.equal(parentMarkerPresent, apply);
        let verifiedBytes: string;
        if (apply) {
          verifiedBytes = await readFile(join(repo, marker), "utf8");
        } else {
          commands.push(await git(repo, ["worktree", "add", "--detach", verification, base.stdout.trim()]));
          commands.push(await git(verification, ["apply", "--check", result.patchPath]));
          commands.push(await git(verification, ["apply", result.patchPath]));
          verifiedBytes = await readFile(join(verification, marker), "utf8");
          assert.equal(await Bun.file(join(repo, marker)).exists(), false, "Verifying a retained patch must not mutate the parent");
        }
        assert.equal(verifiedBytes, expectedBytes);
        assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "PSTACK_ISOLATION_BASE\n");
        const status = await git(apply ? repo : verification, ["status", "--porcelain", "--untracked-files=all"]);
        commands.push(status);
        assert.equal(status.stdout, `?? ${marker}\n`, "Only the assigned marker may change");
        const parentStatus = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
        commands.push(parentStatus);
        assert.equal(parentStatus.stdout, apply ? `?? ${marker}\n` : "", "Apply-off must leave the entire parent checkout unchanged");
        isolationCases.push({
          name: label, sdkVersion,
          settings: {
            "task.structured": settings["task.structured"], "task.isolation.enabled": settings["task.isolation.enabled"],
            "task.isolation.apply": apply, "task.isolation.merge": settings["task.isolation.merge"],
            "isolation.backend": settings["isolation.backend"],
          },
          parentModel: { provider: first.provider, id: first.id, api: first.api }, parentTools,
          schema: {
            isolatedPresent: Object.hasOwn(itemProperties, "isolated"),
            solutionSpaceRequired: itemSchema.required.includes("solutionSpace"),
            modelOverridePresent: Object.hasOwn(itemProperties, "model"),
            outputSchemaPresent: Object.hasOwn(itemProperties, "outputSchema"),
            schemaModePresent: Object.hasOwn(itemProperties, "schemaMode"),
          },
          expectedBytes, expectedFinal, elapsedMs,
          result: {
            agent: result.agent, resolvedModel: result.resolvedModel, exitCode: result.exitCode,
            output: result.output, isolated: result.isolated, hasRootChanges: result.hasRootChanges,
          },
          retainedPatch: { bytes: Buffer.byteLength(patch), sha256: createHash("sha256").update(patch).digest("hex") },
          parentMarkerPresent, verifiedBytes, independentlyApplied: !apply,
        });
      } catch (error) {
        await writeFile(join(root, "proofs", "native-models-failure.json"), JSON.stringify({
          case: label, entries: isolatedManager.getEntries(), taskCalls, descriptorReceipts,
          nativeBatches: taskBatches.slice(start), commands,
        }, null, 2) + "\n");
        isolationFailureRecorded = true;
        throw error;
      } finally {
        try { await isolatedSession?.dispose(); }
        finally {
          await git(repo, ["worktree", "remove", "--force", verification], false);
          await rm(verification, { recursive: true, force: true });
          await rm(repo, { recursive: true, force: true });
        }
      }
    }
    const proof = {
      ok: true, cancellationUnchanged: true, recommendedRule, sdkVersion,
      capturedAt: new Date().toISOString(), fixtureOnly: true,
      producerInputs: await Promise.all(["scripts/smoke-models.ts", "scripts/manifest-digest.ts", "package.json", "bun.lock", "src/extension.ts", "src/models.ts", "src/mode.ts"].map(async path => ({
        path, sha256: path === "package.json" ? manifestDigest(await readFile(join(root, path))) : createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
      }))),
      models: { first: { provider: first.provider, id: first.id, api: first.api }, second: { provider: second.provider, id: second.id, api: second.api } }, isolationCases,
      limits: ["Authenticated fixture samples only. No accuracy or performance gain is claimed.", "Native checkout isolation is not the Benny Docker security boundary.", "The inputs bind the listed producer and P Stack files, not a complete transitive-source release gate."],
      nativeBatches: taskBatches.map((batch) => batch.results.map(({ id, agent, task, exitCode, output, resolvedModel }) => ({ id, agent, task, exitCode, output, resolvedModel }))),
    };
    await rm(join(root, "proofs", "native-models-failure.json"), { force: true });
    await writeFile(join(root, "proofs", "native-models.json"), JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify(proof));
  } catch (error) {
    if (!isolationFailureRecorded) {
      await writeFile(join(root, "proofs", "native-models-failure.json"), JSON.stringify({
        case: "RootModelSmoke", entries: manager.getEntries(), nativeBatches: taskBatches,
      }, null, 2) + "\n");
    }
    throw error;
  } finally { await session.dispose(); }
} finally {
  await rm(worktreeBase, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  Object.assign(process.env, previousGit);
  if (previousWorktreeBase === undefined) delete process.env.OMP_WORKTREE_DIR;
  else process.env.OMP_WORKTREE_DIR = previousWorktreeBase;
  if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousProfile;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  refreshDirsFromEnv();
}
