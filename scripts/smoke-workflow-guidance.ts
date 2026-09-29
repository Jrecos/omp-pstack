import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  ModelRegistry, SessionManager, Settings,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import pstack from "../src/extension.ts";
import { MODE_ENTRY } from "../src/mode.ts";

const root = join(import.meta.dir, "..");
const output = process.argv[2];
if (!output) throw new Error("Usage: bun scripts/smoke-workflow-guidance.ts <output.json>");
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const requested = process.env.PSTACK_SMOKE_MODEL;
assert(requested, "Set PSTACK_SMOKE_MODEL to an authenticated model selector");
const model = modelRegistry.getAvailable().find((entry) => `${entry.provider}/${entry.id}` === requested);
assert(model, `Authenticated model ${requested} unavailable`);
const temporary = await mkdtemp(join(tmpdir(), "pstack-workflow-guidance-"));
const skills = await loadSkillsFromDir({ dir: join(root, "skills"), source: "omp-pstack:scenario" });
const full = join(root, "skills/poteto-mode/playbooks/autopilot-full.md");
const stack = join(root, "skills/poteto-mode/playbooks/autopilot-stack.md");
const owner = join(root, "skills/poteto-mode/playbooks/opening-a-pr.md");
const babysit = join(root, "skills/poteto-mode/playbooks/babysit.md");
const log = join(root, "skills/show-me-your-work/SKILL.md");
const cases = [
  {
    name: "autopilot-full",
    files: [full],
    prompt: `I have authorized an Autopilot-full queue. PR 101 has a code-ready head A1. Its owner is still running self-proof, CI, and babysit. A later correction will change its patch to head B2 before merge-ready. How should the root coordinate verification and merge eligibility across those heads? This is a planning question. Do not create or change a PR. Read ${full} first.`,
  },
  {
    name: "autopilot-stack",
    files: [stack, full],
    prompt: `I asked for a stack that I will land myself. PR 201 has a code-ready head A1 while its owner is still running self-proof and CI. A later fix will change its patch to B2 before STACK-READY. When does the root run verification, and which head is eligible for the stack? Do not create or change a PR. Read ${stack} and ${full} first.`,
  },
  {
    name: "autopilot-owner",
    files: [full, owner, babysit],
    prompt: `I am the owner of one PR in an authorized Autopilot-full queue. I opened it ready, reported code-ready, and now trunk moved so the branch needs a rebase before it can be merge-ready. Should I babysit this PR? Who rebases and publishes my branch? Do not touch the PR. Read ${full}, ${owner}, and ${babysit} first.`,
  },
  {
    name: "autopilot-stack-owner",
    files: [stack, babysit],
    prompt: `I own a PR that the root already appended to an Autopilot-stack chain. Trunk moved and the chain needs rebasing, including my PR. Should I rebase and force-push my own branch while babysitting, or should I report the conflict for the root to handle? Do not touch a branch or PR. Read ${stack} and ${babysit} first.`,
  },
  {
    name: "decision-log",
    files: [log],
    prompt: `We are finishing a run. The decisions.tsv log already has an invented row claiming a production deploy that never happened. A previous run wrote other rows to this same file. How should I audit and correct the log without losing its history? This is a planning question. Do not edit a file. Read ${log} first.`,
  },
] as const;
const results = [];
assert(!process.env.PSTACK_SMOKE_CASE || cases.some(({ name }) => name === process.env.PSTACK_SMOKE_CASE), "Unknown PSTACK_SMOKE_CASE");
try {
  for (const scenario of cases) {
    if (process.env.PSTACK_SMOKE_CASE && process.env.PSTACK_SMOKE_CASE !== scenario.name) continue;
    const manager = SessionManager.create(temporary, join(temporary, scenario.name));
    manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
    const reads: string[] = [];
    const { session } = await createAgentSession({
      cwd: temporary, authStorage, modelRegistry, model, sessionManager: manager,
      agentRegistry: new AgentRegistry(),
      settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false }),
      extensions: [pstack, (pi) => { pi.on("tool_execution_start", (event) => {
        if (event.toolName === "read") reads.push(JSON.stringify(event.args));
      }); }], disableExtensionDiscovery: true,
      skills: skills.skills, rules: [], contextFiles: [], promptTemplates: [],
      toolNames: ["read"], enableMCP: false, enableLsp: false,
    });
    try {
      await initializeExtensions(session, {
        reportSendError: (_action, error) => { throw error; },
        reportRuntimeError: (error) => { throw new Error(error.error); },
      });
      await session.prompt(scenario.prompt);
      const response = session.getLastAssistantText();
      assert(response, `${scenario.name} returned no response`);
      assert(scenario.files.every((file) => reads.some((args) => {
        const path = JSON.parse(args).path;
        return typeof path === "string" && (path === file || path.startsWith(`${file}:`));
      })), `${scenario.name} did not read its checkout guidance`);
      results.push({ scenario: scenario.name, reads, response });
    } finally {
      await session.dispose();
    }
  }
  await Bun.write(output, JSON.stringify({ model: requested, results }, null, 2) + "\n");
  console.log(JSON.stringify({ model: requested, output, reads: results.map(({ scenario, reads }) => ({ scenario, reads: reads.length })) }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
