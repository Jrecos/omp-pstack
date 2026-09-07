import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { MODE_ENTRY, replayMode } from "../src/mode.ts";

const skill = realpathSync(`${import.meta.dir}/../skills/poteto-mode/SKILL.md`);

test("active branch inherits activation but earlier branch and separate sessions do not", () => {
  const manager = SessionManager.inMemory();
  const before = manager.appendCustomEntry("test.anchor", {});
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
  const activated = manager.getLeafId()!;
  expect(replayMode(manager.getBranch(), skill, () => {})).toBe(true);
  manager.branch(before);
  expect(replayMode(manager.getBranch(), skill, () => {})).toBe(false);
  manager.branch(activated);
  expect(replayMode(manager.getBranch(), skill, () => {})).toBe(true);
  expect(replayMode(SessionManager.inMemory().getBranch(), skill, () => {})).toBe(false);
});

test("native invocation activates once and cannot undo a later off entry", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: skill }, "user");
  expect(replayMode(manager.getBranch(), skill, () => {})).toBe(true);
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  const entries = manager.getBranch();
  expect(replayMode([...entries, entries[0]!], skill, () => {})).toBe(false);
});

test("quoted, agent-attributed and foreign-package invocations never activate", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: skill }, "agent");
  manager.appendCustomMessageEntry("skill-prompt", "mode body", false, { name: "poteto-mode", path: import.meta.path }, "user");
  manager.appendCustomMessageEntry("quoted", "poteto-mode", false, { name: "poteto-mode", path: skill }, "user");
  expect(replayMode(manager.getBranch(), skill, () => {})).toBe(false);
});

test("malformed and unknown-version entries preserve the last valid state", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
  manager.appendCustomEntry(MODE_ENTRY, { version: 2, active: true });
  const messages: string[] = [];
  expect(replayMode(manager.getBranch(), skill, (message) => messages.push(message))).toBe(true);
  expect(messages.length).toBe(1);

  // Off stays off past a malformed entry.
  const off = SessionManager.inMemory();
  off.appendCustomEntry(MODE_ENTRY, { version: 1, active: false });
  off.appendCustomEntry(MODE_ENTRY, { version: 9, active: true });
  expect(replayMode(off.getBranch(), skill, () => {})).toBe(false);

  // No valid entry at all still defaults inactive.
  const fresh = SessionManager.inMemory();
  fresh.appendCustomEntry(MODE_ENTRY, { version: 2, active: true });
  const only: string[] = [];
  expect(replayMode(fresh.getBranch(), skill, (message) => only.push(message))).toBe(false);
  expect(only.length).toBe(1);
});
