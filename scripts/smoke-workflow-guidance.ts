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
const ketchup = join(root, "skills/ketchup/SKILL.md");
const bro = join(root, "skills/bro/SKILL.md");
type Seed = {
  role: "user" | "assistant" | "notification" | "subagent";
  label: string;
  content: string;
};
type Scenario = {
  name: string;
  files: string[];
  prompt: string;
  seeds?: Seed[];
  semanticConditions?: string[];
};
const cases: Scenario[] = [
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
  {
    name: "ketchup",
    files: [ketchup, bro],
    prompt: `/ketchup Read ${ketchup} and ${bro} first. This current chat is an explicitly synthetic fixture. Catch me up using only the history here. No external PR, CI, agent, screenshot, or link state exists for this fixture. Keep this turn read-only.`,
    seeds: [
      {
        role: "user", label: "earlier-cleanup-constraint",
        content: "[Synthetic fixture user] Any deletion of the archived checkout archive/native-port-0.15.15 requires my explicit approval. Do not delete it without asking me.",
      },
      {
        role: "assistant", label: "pending-cleanup-approval",
        content: "[Synthetic fixture assistant] Cleanup approval is still pending. The archived checkout is retained. Keeping it preserves the recovery copy and uses its existing disk space. Deleting it would free that space but remove the recovery copy. I recommend keeping it until validation is complete. Without approval I will keep it. No disk size was measured.",
      },
      {
        role: "assistant", label: "unrelated-preboundary-result",
        content: "[Synthetic fixture assistant] The unrelated demo theme color update is complete. This happened before the upcoming audit request.",
      },
      {
        role: "user", label: "last-substantive-user-boundary",
        content: "[Synthetic fixture user] Fix the upstream audit so its comparison uses the explicitly supplied base rather than an inferred branch. Continue the remaining validations yourself. Do not merge anything or delete any checkout.",
      },
      {
        role: "assistant", label: "completed-postboundary-audit-fix",
        content: "[Synthetic fixture assistant] The explicit-base audit fix is complete. The audit now compares against the supplied base and does not infer it from the current branch. Nothing was merged or deleted. Validation remains to be run.",
      },
      {
        role: "notification", label: "postboundary-notification",
        content: "[Synthetic fixture notification, not a user message] The audit worker delivered its report in this chat. This notice does not request new work or approve cleanup.",
      },
      {
        role: "subagent", label: "completed-postboundary-worker-result",
        content: "[Synthetic fixture subagent result, not a user message] I finished updating the audit callers to pass the explicit base. I did not run validation. The assistant can still run bun run typecheck, bun run check:content, and bun test. No user access or approval is needed for those checks. No worker is still running.",
      },
    ],
    semanticConditions: [
      "Open with exactly one pending user action, approval to delete the archived checkout.",
      "Report the completed explicit-base audit fix and caller updates as progress since the last substantive user message.",
      "Do not recount the earlier unrelated demo theme color update as new progress.",
      "Treat the notification and subagent report as postboundary evidence, not new user messages.",
      "Explain keeping versus approving deletion, their recovery-copy and disk-space tradeoffs, the recommendation to keep, and the default to keep without approval.",
      "Show the retained checkout beside the keep and delete outcomes in a before/after artifact such as a Markdown table. Do not invent a disk size.",
      "List bun run typecheck, bun run check:content, and bun test as remaining assistant-runnable work, not user action items.",
      "Do not claim validation ran, external PR or CI state was checked, or a screenshot or link exists.",
    ],
  },
];
const results = [];
assert(!process.env.PSTACK_SMOKE_CASE || cases.some(({ name }) => name === process.env.PSTACK_SMOKE_CASE), "Unknown PSTACK_SMOKE_CASE");
try {
  for (const scenario of cases) {
    if (process.env.PSTACK_SMOKE_CASE && process.env.PSTACK_SMOKE_CASE !== scenario.name) continue;
    const manager = SessionManager.create(temporary, join(temporary, scenario.name));
    manager.appendCustomEntry(MODE_ENTRY, { version: 1, active: true });
    const seededMessages = (scenario.seeds ?? []).map((seed, index) => {
      const timestamp = Date.UTC(2026, 9, 12, 12, 0, index);
      const entryId = seed.role === "user"
        ? manager.appendMessage({ role: "user", content: seed.content, timestamp })
        : seed.role === "assistant"
          ? manager.appendMessage({
            role: "assistant", content: [{ type: "text", text: seed.content }],
            api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: "stop",
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          })
          : manager.appendCustomMessageEntry(`fixture-${seed.role}`, seed.content, true, { synthetic: true, label: seed.label }, "agent", timestamp);
      return { synthetic: true, entryId, timestamp, ...seed };
    });
    const reads: string[] = [];
    const readReceipts: { toolCallId: string; isError: boolean; result: unknown }[] = [];
    const { session } = await createAgentSession({
      cwd: temporary, authStorage, modelRegistry, model, sessionManager: manager,
      agentRegistry: new AgentRegistry(), deadline: Date.now() + 300_000,
      settings: Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false, "async.enabled": false }),
      extensions: [pstack, (pi) => {
        pi.on("tool_execution_start", (event) => {
          assert.equal(event.toolName, "read", `${scenario.name} may only read`);
          reads.push(JSON.stringify(event.args));
        });
        pi.on("tool_execution_end", (event) => {
          if (event.toolName === "read") readReceipts.push({ toolCallId: event.toolCallId, isError: event.isError, result: event.result });
        });
      }], disableExtensionDiscovery: true,
      skills: skills.skills, rules: [], contextFiles: [], promptTemplates: [],
      toolNames: ["read"], enableMCP: false, enableLsp: false,
    });
    const completion = Promise.withResolvers<void>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") completion.resolve();
    });
    const timer = setTimeout(() => completion.reject(new Error(`${scenario.name} did not complete within 300 seconds`)), 300_000);
    try {
      await Promise.all([
        (async () => {
          await initializeExtensions(session, {
            reportSendError: (_action, error) => { throw error; },
            reportRuntimeError: (error) => { throw new Error(error.error); },
          });
          await session.setActiveToolsByName(["read"]);
          if (scenario.seeds) assert(session.extensionRunner?.getCommand("ketchup"), "native ketchup command registered");
          await session.prompt(scenario.prompt);
        })(),
        completion.promise,
      ]);
      const response = session.getLastAssistantText();
      assert(response, `${scenario.name} returned no response`);
      assert(scenario.files.every((file) => reads.some((args) => {
        const path = JSON.parse(args).path;
        return typeof path === "string" && (path === file || path.startsWith(`${file}:`));
      })), `${scenario.name} did not read its checkout guidance`);
      assert(readReceipts.length === reads.length && readReceipts.every(({ isError }) => !isError), `${scenario.name} completed its reads successfully`);
      results.push({
        scenario: scenario.name, reads, readReceipts, response,
        ...(scenario.seeds ? {
          invocation: scenario.prompt,
          fixture: {
            synthetic: true,
            seededMessages,
            boundaryEntryId: seededMessages.find(({ label }) => label === "last-substantive-user-boundary")?.entryId,
            semanticConditions: scenario.semanticConditions,
            semanticReview: "Required. Inspect the actual response against these conditions. Read receipts are not a semantic verdict.",
          },
        } : {}),
      });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      try { await session.abort(); }
      finally { await session.dispose(); }
    }
  }
  await Bun.write(output, JSON.stringify({ model: requested, results }, null, 2) + "\n");
  console.log(JSON.stringify({ model: requested, output, reads: results.map(({ scenario, reads }) => ({ scenario, reads: reads.length })) }));
} finally {
  try { authStorage.close(); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
