import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  ModelRegistry, SessionManager, Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { CreateAgentSessionOptions, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions, type InitializeExtensionsOptions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import pstack from "../src/extension.ts";
import { MODE_ENTRY, replayMode } from "../src/mode.ts";

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "pstack-native-smoke-"));
const loaded = await loadSkillsFromDir({ dir: join(root, "skills"), source: "omp-pstack:project" });
assert.equal(loaded.skills.length, 45);
assert(!loaded.skills.some((skill) => skill.filePath.includes("automations/benny")));
const modeSkill = loaded.skills.find((skill) => skill.name === "poteto-mode")!;
assert(modeSkill);
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
  await session.promptCustomMessage({
    customType: "skill-prompt", attribution: "user", display: false,
    details: { name: "poteto-mode", path: modeSkill.filePath },
    content: `${(await Bun.file(modeSkill.filePath).text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}\n\nCasual native-skill smoke check. Reply exactly PSTACK_NATIVE_SKILL. Use no tools.`,
  });
  assert(replayMode(manager.getBranch(), modeSkill.filePath, (message) => { throw new Error(message); }), "native invocation activates durable branch state");
  await session.prompt("Casual smoke check. Reply exactly PSTACK_NATIVE_ACTIVE. Use no tools.");
  assert.equal(promptModes.at(-1), 1, "native invocation persists into the next prompt");
  await session.compact("Retain only the smoke-check facts.");
  await session.prompt("Casual smoke check. Reply exactly PSTACK_COMPACT_ACTIVE. Use no tools.");
  assert.equal(promptModes.at(-1), 1, "compaction retains durable mode");
  manager.branch(before);
  assert.equal(replayMode(manager.getBranch(), modeSkill.filePath, () => {}), false);
  manager.branch(after);
  assert.equal(replayMode(manager.getBranch(), modeSkill.filePath, () => {}), true);
  assert.equal(replayMode(SessionManager.inMemory().getBranch(), modeSkill.filePath, () => {}), false);
  const file = session.sessionFile!;
  await session.dispose();
  const resumed = (await createAgentSession({ ...options, sessionManager: await SessionManager.open(file), agentRegistry: new AgentRegistry() })).session;
  try {
    await initializeExtensions(resumed, runtime);
    await resumed.prompt("Casual smoke check. Reply exactly PSTACK_RESUMED_ACTIVE. Use no tools.");
    assert.equal(promptModes.at(-1), 1, "resumed native session restores mode");
    await resumed.prompt("Stop using Poteto mode. Turn it off for this conversation.");
    assert.equal(replayMode(resumed.sessionManager.getBranch(), modeSkill.filePath, () => {}), false, "natural-language opt-out persists through the real mode tool");
  } finally { await resumed.dispose(); }
  const fresh = (await createAgentSession({ ...options, sessionManager: SessionManager.create(temporary, join(temporary, "independent")), agentRegistry: new AgentRegistry() })).session;
  try {
    await initializeExtensions(fresh, runtime);
    await fresh.prompt("Casual smoke check. Reply exactly PSTACK_INDEPENDENT_OFF. Use no tools.");
    assert.equal(promptModes.at(-1), 0, "independent native session stays inactive");
  } finally { await fresh.dispose(); }
  console.log(JSON.stringify({ ok: true, model: requested, skills: loaded.skills.length, promptModeBlocks: promptModes, branchReplay: "passed", compaction: "active", resume: "active", naturalLanguageOptOut: "inactive", separateSession: "inactive" }));
} finally {
  await session.dispose();
  await rm(temporary, { recursive: true, force: true });
}
