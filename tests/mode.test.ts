import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MODE_ENTRY, registerMode, replayMode } from "../src/mode.ts";
import type { ModeAnchor } from "../src/mode.ts";

const skill = realpathSync(`${import.meta.dir}/../skills/poteto-mode/SKILL.md`);
const anchor: ModeAnchor = { loadedSkillPath: skill, stableSkillDir: dirname(skill), cacheIdentity: null };

test("active branch inherits activation but earlier branch and separate sessions do not", () => {
  const manager = SessionManager.inMemory();
  const before = manager.appendCustomEntry("test.anchor", {});
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
  const activated = manager.getLeafId()!;
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(true);
  manager.branch(before);
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(false);
  manager.branch(activated);
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(true);
  expect(replayMode(SessionManager.inMemory().getBranch(), anchor, () => {})).toBe(false);
});

test("native invocation activates once and cannot undo a later off entry", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: skill }, "user");
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(true);
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  const entries = manager.getBranch();
  expect(replayMode([...entries, entries[0]!], anchor, () => {})).toBe(false);
});

test("quoted, agent-attributed and foreign-package invocations never activate", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: skill }, "agent");
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: import.meta.path }, "user");
  manager.appendCustomMessageEntry("quoted", "poteto-mode", false, { name: "poteto-mode", path: skill }, "user");
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(false);
});

test("malformed and unknown-version entries preserve the last valid state", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
  manager.appendCustomEntry(MODE_ENTRY, { version: 2, active: true });
  const messages: string[] = [];
  expect(replayMode(manager.getBranch(), anchor, (message) => messages.push(message))).toBe(true);
  expect(messages.length).toBe(1);

  // Off stays off past a malformed entry.
  const off = SessionManager.inMemory();
  off.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  off.appendCustomEntry(MODE_ENTRY, { version: 9, active: true });
  expect(replayMode(off.getBranch(), anchor, () => {})).toBe(false);

  // No valid entry at all still defaults inactive.
  const fresh = SessionManager.inMemory();
  fresh.appendCustomEntry(MODE_ENTRY, { version: 2, active: true });
  const only: string[] = [];
  expect(replayMode(fresh.getBranch(), anchor, (message) => only.push(message))).toBe(false);
  expect(only.length).toBe(1);
});

test("deleted paths and the selected live targets own a recorded invocation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pstack-mode-cache-"));
  try {
    const cacheParent = join(realpathSync(temporary), "cache", "plugins");
    const installRoot = (version: string) => join(cacheParent, `omp-pstack___omp-pstack___${version}`);
    const skillPath = (version: string) => join(installRoot(version), "skills", "poteto-mode", "SKILL.md");
    const loadedSkill = skillPath("1.1.6");
    const currentSkill = skillPath("1.1.7");
    const unrelatedLiveSkill = skillPath("1.1.8");
    const foreignRoot = join(realpathSync(temporary), "foreign", "cache", "plugins", "other___omp-pstack___1.1.7");
    const foreignSkill = join(foreignRoot, "skills", "poteto-mode", "SKILL.md");
    const runtimeLink = join(realpathSync(temporary), "node_modules", "omp-pstack");
    for (const path of [loadedSkill, currentSkill, unrelatedLiveSkill, foreignSkill]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "mode body");
    }
    await mkdir(dirname(runtimeLink), { recursive: true });
    await symlink(installRoot("1.1.7"), runtimeLink, "dir");
    const cached: ModeAnchor = {
      loadedSkillPath: loadedSkill,
      stableSkillDir: join(runtimeLink, "skills", "poteto-mode"),
      cacheIdentity: { cacheParent, marketplace: "omp-pstack", plugin: "omp-pstack" },
    };
    const replay = (recordedPath: string) => {
      const manager = SessionManager.inMemory();
      manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: recordedPath }, "user");
      const messages: string[] = [];
      const active = replayMode(manager.getBranch(), cached, (message) => messages.push(message));
      return { active, messages };
    };

    expect(replay(skillPath("1.1.5"))).toEqual({ active: true, messages: [] });
    expect(replay(loadedSkill)).toEqual({ active: true, messages: [] });
    expect(replay(currentSkill)).toEqual({ active: true, messages: [] });
    expect(replay(skillPath("1.1.6___hotfix"))).toEqual({ active: true, messages: [] });
    expect(replay(unrelatedLiveSkill)).toEqual({ active: false, messages: [] });
    await unlink(runtimeLink);
    await symlink(foreignRoot, runtimeLink, "dir");
    expect(replay(foreignSkill)).toEqual({ active: false, messages: [] });

    expect(replay(import.meta.path)).toEqual({ active: false, messages: [] });
    for (const foreign of [
      join(cacheParent, "other___omp-pstack___1.1.6", "skills", "poteto-mode", "SKILL.md"),
      join(cacheParent, "omp-pstack___other___1.1.6", "skills", "poteto-mode", "SKILL.md"),
      join(realpathSync(temporary), "other", "cache", "plugins", "omp-pstack___omp-pstack___1.1.6", "skills", "poteto-mode", "SKILL.md"),
      join(cacheParent, "omp-pstack___omp-pstack___1.1.6", "skills", "poteto", "SKILL.md"),
      join(cacheParent, "skills", "poteto-mode", "SKILL.md"),
    ]) {
      const result = replay(foreign);
      expect(result.active).toBe(false);
      expect(result.messages).toHaveLength(1);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("context converges a native invocation into one durable marker and a later off stays final", async () => {
  const manager = SessionManager.inMemory();
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const api = {
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
      manager.appendCustomEntry(type, data);
    },
    registerTool() {},
    logger: { warn() {} },
    zod,
  } as unknown as ExtensionAPI;
  const context = { sessionManager: manager, ui: { notify() {} } } as unknown as ExtensionContext;
  registerMode(api, () => anchor, "mode body");
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: skill }, "user");
  const observe = handlers.get("context")![0]!;
  const beforeAgentStart = handlers.get("before_agent_start")![0]!;

  await observe(undefined, context);
  await observe(undefined, context);
  expect(appended).toEqual([{ type: MODE_ENTRY, data: { version: 1, active: true } }]);
  expect(await beforeAgentStart({ systemPrompt: ["HOST"] }, context)).toEqual({
    systemPrompt: ["HOST", `<omp-pstack-mode source=${JSON.stringify(dirname(skill))}>\nmode body\n</omp-pstack-mode>`],
  });

  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  await observe(undefined, context);
  expect(appended).toHaveLength(1);
  expect(replayMode(manager.getBranch(), anchor, () => {})).toBe(false);
  expect(await beforeAgentStart({ systemPrompt: ["HOST"] }, context)).toBeUndefined();
});
