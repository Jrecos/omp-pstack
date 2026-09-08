import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, createAgentSession, discoverAuthStorage, loadSkillsFromDir, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { getAgentDir, getConfigAgentDirName, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import pstack from "../src/extension.ts";
import { ROLES, parseConfig, resolvePaths, saveRoles } from "../src/models.ts";

const root = join(import.meta.dir, "..");
const temporary = process.env.PSTACK_SMOKE_HOME ?? await mkdtemp(join(tmpdir(), "pstack-model-smoke-"));
const profile = join(temporary, getConfigAgentDirName());
const cwd = join(temporary, "workspace");
const previousProfile = process.env.PI_CODING_AGENT_DIR;
const previousHome = process.env.HOME;
if (!process.env.PSTACK_SMOKE_HOME) {
  const child = Bun.spawn(["bun", import.meta.path], {
    cwd: root, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, HOME: temporary, PI_CODING_AGENT_DIR: profile, PSTACK_SMOKE_HOME: temporary, PSTACK_SMOKE_AUTH_DIR: getAgentDir() },
  });
  let code: number;
  try { code = await child.exited; }
  finally { await rm(temporary, { recursive: true, force: true }); }
  process.exit(code);
}
const authStorage = await discoverAuthStorage(process.env.PSTACK_SMOKE_AUTH_DIR);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const firstName = process.env.PSTACK_SMOKE_MODEL ?? "openai-codex/gpt-6-astra";
const secondName = process.env.PSTACK_SMOKE_SECOND_MODEL ?? "openai-codex/gpt-5.4-mini";
const first = modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === firstName);
const second = modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === secondName);
assert(first && second && firstName !== secondName, "Two explicitly selected authenticated models are required.");
const taskBatches: TaskToolDetails[] = [];
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
  roles["how critics"] = ["inherit-parent", "auto", secondName];
  // Approved pool: the concrete identities actually routed plus explicit alias
  // permission. gpt-6-astra is kept even though no role uses it concretely, so
  // the smoke also exercises unused-pool persistence.
  const pool = [`${first.provider}/${first.id}`, `${second.provider}/${second.id}`, "inherit-parent", "auto"];
  const loaded = await loadSkillsFromDir({ dir: join(root, "skills"), source: "omp-pstack:smoke" });
  const manager = SessionManager.create(cwd, join(temporary, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir: profile, authStorage, modelRegistry, model: first, sessionManager: manager,
    agentRegistry: new AgentRegistry(),
    settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "async.enabled": false, "task.maxConcurrency": 3 }),
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
    // Real setup-recommendation evidence: drive /setup-pstack to COMPLETION on the
    // fresh profile (no rule yet). The model detects the session's models, picks
    // the approved pool, recommends the 18-role map from it, then saves. This is
    // the skill's recommendation path — not the cancellation we test next and not
    // the preconfigured dispatch after the reset.
    await session.promptCustomMessage({
      customType: "skill-prompt", attribution: "user", display: false,
      details: { name: "setup-pstack", path: setup.filePath },
      content: `${(await readFile(setup.filePath, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}\n\nComplete setup now; there is no human to confirm with, so proceed autonomously. Detect models with pstack_models list. The approved pool is EXACTLY: ${pool.join(", ")}. Persist all four members even though no role uses ${first.provider}/${first.id} concretely (it stays routed for later). Recommend a value for all 18 roles from that pool, then save with pstack_models (action "save", pool, and all 18 roles). Never use a model outside the pool. Do not ask questions; after saving, print a one-line confirmation.`,
    });
    const recommendedRule = await readFile(paths.rulePath, "utf8");
    const recommended = parseConfig(recommendedRule);
    assert(recommended.exists, "completed setup must have written the pstack-models rule");
    assert.match(recommendedRule, /^pool: /m);
    for (const member of pool) assert.ok(recommendedRule.includes(member), `recommended rule must persist pool member ${member}`);
    // save enforces pool membership, so a completed save already proves every
    // recommended selector is a pool member or a granted alias.
    const configuredCount = ROLES.filter((role) => (recommended.roles[role] ?? []).length > 0).length;
    assert(configuredCount > 0, "completed setup must recommend at least one role");
    // Deterministic baseline for the dispatch phases: reset the rule to a known
    // shape (all inherit-parent plus the concrete how-critics third entry). This
    // also re-verifies pool persistence after an agent-driven recommendation.
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
      await session.prompt(`Native generated-agent smoke ${label}. Call pstack_agent with exactly {"role":"how critics","index":1,"kind":null,"model":null}, then index 2, then index 3. Null means no override: use the saved role/index, not defaults remembered from setup. Then call native task exactly once with the three returned agent names, preserving both alias entries. Each task must say: "# Target\nReturn PSTACK_${label}_INDEX_N, replacing N with this assigned index.\n# Change\nNo files, research, edits, or tests. Native completion through yield is permitted and required.\n# Acceptance\nFinish using the native yield tool with data {text: the assigned literal}, never null." Use unique names ${label}One, ${label}Two, ${label}Three. Every task MUST set outputSchema to {"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false} and schemaMode to "strict". Shared context: "# Goal\nObserve real native model selection.\n# Constraints\nNo filesystem changes or research tools; native yield completes the assignment.\n# Contract\nEach child returns its assigned literal in the text field." Wait for all three. Do not omit or deduplicate a member. Afterwards say PANEL_COMPLETE. Do not run anything else.`);
      const results = taskBatches.slice(start).flatMap((batch) => batch.results);
      assert.equal(results.length, 3, `${label}: exactly three native tasks must settle`);
      for (const [index, result] of results.entries()) {
        assert.equal(result.exitCode, 0, result.error ?? result.stderr);
        const expected = index < 2 ? expectedParent : secondName;
        assert(result.resolvedModel === expected || result.resolvedModel?.startsWith(`${expected}:`), `${result.resolvedModel} must resolve to ${expected}`);
      }
    };
    // architect runners is a poteto-kind panel role; dispatching it proves the
    // poteto-kind resolution + native-task path that architect / the model-dispatch
    // skill class relies on (not only the readonly how-critics panel).
    const runArchitect = async (label: string, expectedParent: string) => {
      const start = taskBatches.length;
      await session.prompt(`Native generated-agent smoke ${label}. Call pstack_agent with exactly {"role":"architect runners","index":1,"kind":null,"model":null}. Then call native task exactly once with the returned agent name. The task must say: "# Target\nReturn PSTACK_${label}_ARCH, replacing ARCH with this assigned index.\n# Change\nNo files, research, edits, or tests. Native completion through yield is permitted and required.\n# Acceptance\nFinish using the native yield tool with data {text: the assigned literal}, never null." Use unique name ${label}Architect. Every task MUST set output as a string.`);
      const results = taskBatches.slice(start).flatMap((batch) => batch.results);
      assert.equal(results.length, 1, `${label}: exactly one architect task must settle`);
      const result = results[0];
      assert.equal(result.exitCode, 0, result.error ?? result.stderr);
      // architect runners[1] is the inherit-parent alias → resolves to the live parent.
      assert(result.resolvedModel === expectedParent || result.resolvedModel?.startsWith(`${expectedParent}:`), `${result.resolvedModel} must resolve to ${expectedParent}`);
    };
    await runPanel("First", firstName);
    await runArchitect("First", firstName);
    await session.setModelTemporary(second);
    await runPanel("Second", secondName);
    await runArchitect("Second", secondName);
    const proof = { ok: true, cancellationUnchanged: true, recommendedRule, nativeBatches: taskBatches.map((batch) => batch.results.map(({ id, agent, task, exitCode, output, resolvedModel }) => ({ id, agent, task, exitCode, output, resolvedModel }))) };
    await writeFile(join(root, "proofs", "native-models.json"), JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify(proof));
  } catch (error) {
    await writeFile(join(root, "proofs", "native-models-failure.json"), JSON.stringify(manager.getEntries(), null, 2) + "\n");
    throw error;
  } finally { await session.dispose(); }
} finally {
  if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousProfile;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  refreshDirsFromEnv();
}
