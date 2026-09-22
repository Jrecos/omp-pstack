import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentRegistry, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  ModelRegistry, SessionManager, Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { CreateAgentSessionOptions, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions, type InitializeExtensionsOptions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import pstack from "../src/extension.ts";
import { MODE_ENTRY, replayMode } from "../src/mode.ts";
import type { ModeAnchor } from "../src/mode.ts";

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "pstack-native-smoke-"));
const loaded = await loadSkillsFromDir({ dir: join(root, "skills"), source: "omp-pstack:project" });
assert.equal(loaded.skills.length, 47);
assert(!loaded.skills.some((skill) => skill.filePath.includes("automations/benny")));
const modeSkill = loaded.skills.find((skill) => skill.name === "poteto-mode")!;
assert(modeSkill);
const modeAnchor: ModeAnchor = {
  loadedSkillPath: realpathSync(modeSkill.filePath),
  stableSkillDir: dirname(modeSkill.filePath),
  cacheIdentity: null,
};
for (const name of ["principle-attack-the-premise", "principle-test-behavior-not-implementation"]) {
  assert(loaded.skills.some((skill) => skill.name === name), `${name} not discovered from the project skills dir`);
}
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const requested = process.env.PSTACK_SMOKE_MODEL ?? "openai-codex/gpt-6-astra";
const model = modelRegistry.getAvailable().find((candidate) => `${candidate.provider}/${candidate.id}` === requested);
assert(model, `Authenticated smoke model ${requested} unavailable; set PSTACK_SMOKE_MODEL explicitly.`);
const promptModes: number[] = [];
const observer = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", (event) => {
    assert(event.systemPrompt.includes("PSTACK_HOST_BLOCK"), "existing host system blocks are preserved");
    promptModes.push(event.systemPrompt.filter((block) => block.startsWith("<omp-pstack-mode ")).length);
  });
};
const manager = SessionManager.create(temporary, join(temporary, "sessions"));
const options: CreateAgentSessionOptions = {
  cwd: temporary,
  authStorage, modelRegistry, model,
  sessionManager: manager,
  agentRegistry: new AgentRegistry(),
  settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "compaction.keepRecentTokens": 128 }),
  extensions: [pstack, observer], disableExtensionDiscovery: true,
  skills: loaded.skills, rules: [], contextFiles: [], promptTemplates: [],
  systemPrompt: (blocks) => [...blocks, "PSTACK_HOST_BLOCK"],
  toolNames: [], enableMCP: false, enableLsp: false,
};
const runtime: InitializeExtensionsOptions = {
  reportSendError: (_action, error) => { throw error; },
  reportRuntimeError: (error) => { throw new Error(error.error); },
};
const { session } = await createAgentSession(options);
try {
  await initializeExtensions(session, runtime);
  const before = manager.appendCustomEntry("pstack-smoke.anchor", {});
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
  const after = manager.getLeafId()!;
  await session.prompt("Casual smoke check. Reply exactly PSTACK_ACTIVE. Use no tools.");
  assert.equal(promptModes.at(-1), 1, "active mode appends exactly one system block");
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  await session.prompt("Casual smoke check. Reply exactly PSTACK_OFF. Use no tools.");
  assert.equal(promptModes.at(-1), 0, "off removes the injected system block");
  const activeMarkers = () =>
    manager.getBranch().filter((entry) => {
      if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) return false;
      const data = entry.data;
      return !!data && typeof data === "object" && "active" in data && data.active === true;
    }).length;
  const nativeMarkersBefore = activeMarkers();
  await session.promptCustomMessage({
    customType: "skill-prompt", attribution: "user", display: false,
    details: { name: "poteto-mode", path: modeSkill.filePath },
    content: `${(await Bun.file(modeSkill.filePath).text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}\n\nCasual native-skill smoke check. Reply exactly PSTACK_NATIVE_SKILL. Use no tools.`,
  });
  assert(replayMode(manager.getBranch(), modeAnchor, (message) => { throw new Error(message); }), "native invocation activates durable branch state");
  await session.prompt("Casual smoke check. Reply exactly PSTACK_NATIVE_ACTIVE. Use no tools.");
  assert.equal(promptModes.at(-1), 1, "native invocation persists into the next prompt");
  assert.equal(activeMarkers() - nativeMarkersBefore, 1, "the context handler converges the native invocation into exactly one durable marker");
  await session.compact("Retain only the smoke-check facts.");
  await session.prompt("Casual smoke check. Reply exactly PSTACK_COMPACT_ACTIVE. Use no tools.");
  assert.equal(promptModes.at(-1), 1, "compaction retains durable mode");
  manager.branch(before);
  assert.equal(replayMode(manager.getBranch(), modeAnchor, () => {}), false);
  manager.branch(after);
  assert.equal(replayMode(manager.getBranch(), modeAnchor, () => {}), true);
  assert.equal(replayMode(SessionManager.inMemory().getBranch(), modeAnchor, () => {}), false);
  const file = session.sessionFile!;
  await session.dispose();
  const resumed = (await createAgentSession({ ...options, sessionManager: await SessionManager.open(file), agentRegistry: new AgentRegistry() })).session;
  try {
    await initializeExtensions(resumed, runtime);
    await resumed.prompt("Casual smoke check. Reply exactly PSTACK_RESUMED_ACTIVE. Use no tools.");
    assert.equal(promptModes.at(-1), 1, "resumed native session restores mode");
    await resumed.prompt("Stop using Poteto mode. Turn it off for this conversation.");
    assert.equal(replayMode(resumed.sessionManager.getBranch(), modeAnchor, () => {}), false, "natural-language opt-out persists through the real mode tool");
  } finally { await resumed.dispose(); }
  const fresh = (await createAgentSession({ ...options, sessionManager: SessionManager.create(temporary, join(temporary, "independent")), agentRegistry: new AgentRegistry() })).session;
  try {
    await initializeExtensions(fresh, runtime);
    await fresh.prompt("Casual smoke check. Reply exactly PSTACK_INDEPENDENT_OFF. Use no tools.");
    assert.equal(promptModes.at(-1), 0, "independent native session stays inactive");
  } finally { await fresh.dispose(); }
  const swapPlugins = join(temporary, "swap-plugins");
  const swapOld = join(swapPlugins, "cache", "plugins", "omp-pstack___omp-pstack___1.1.6");
  const swapNew = join(swapPlugins, "cache", "plugins", "omp-pstack___omp-pstack___1.1.7");
  const swapLink = join(swapPlugins, "node_modules", "omp-pstack");
  await mkdir(join(swapOld, "src"), { recursive: true });
  await mkdir(swapNew, { recursive: true });
  await mkdir(dirname(swapLink), { recursive: true });
  await cp(join(root, "skills"), join(swapOld, "skills"), { recursive: true });
  await cp(join(root, "skills"), join(swapNew, "skills"), { recursive: true });
  await cp(join(root, "src", "extension.ts"), join(swapOld, "src", "extension.ts"));
  for (const name of ["install.ts", "mode.ts", "history.ts", "models.ts"]) await symlink(join(root, "src", name), join(swapOld, "src", name));
  await symlink(swapOld, swapLink, "dir");
  const swappedFactory = (await import(`${swapLink}/src/extension.ts?pstack-swap=${Date.now()}`)).default;
  await unlink(swapLink);
  await rm(swapOld, { recursive: true, force: true });
  await symlink(swapNew, swapLink, "dir");
  const swapSources: string[] = [];
  const swapObserver = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      for (const block of event.systemPrompt) {
        if (block.startsWith("<omp-pstack-mode ")) swapSources.push(/ source=("[^"]+")/.exec(block)![1]);
      }
    });
  };
  const swapManager = SessionManager.create(temporary, join(temporary, "swap-sessions"));
  const swapped = (await createAgentSession({ ...options, sessionManager: swapManager, extensions: [swappedFactory, swapObserver] })).session;
  try {
    await initializeExtensions(swapped, runtime);
    swapManager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
    await swapped.prompt("Casual smoke check. Reply exactly PSTACK_SWAP. Use no tools.");
    assert.equal(swapSources.length, 1, "the swapped factory injects its mode block exactly once");
    const swapSource = JSON.parse(swapSources[0]!);
    assert(!swapSource.includes("/cache/plugins/"), `swapped mode source still names the deleted version: ${swapSource}`);
    assert(await Bun.file(join(swapSource, "SKILL.md")).exists(), "swapped mode source stays readable through the repointed runtime link");
  } finally { await swapped.dispose(); }
  console.log(JSON.stringify({ ok: true, model: requested, skills: loaded.skills.length, promptModeBlocks: promptModes, branchReplay: "passed", compaction: "active", resume: "active", naturalLanguageOptOut: "inactive", separateSession: "inactive", factorySwap: "stable-source" }));
} finally {
  await session.dispose();
  await rm(temporary, { recursive: true, force: true });
}
