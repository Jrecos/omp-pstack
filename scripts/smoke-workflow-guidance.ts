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
const modeGuidance = join(root, "skills/poteto-mode/SKILL.md");
const writing = join(root, "skills/technical-writing/SKILL.md");
const unslop = join(root, "skills/unslop/SKILL.md");
const boundarySource = join(temporary, "documentation-boundary.ts");
const boundaryDiff = join(temporary, "documentation-boundary.diff");
const staleReadme = join(temporary, "documentation-README.md");
const staleReference = join(temporary, "documentation-reference.md");
const acceptedAdr = join(temporary, "documentation-adr-001.md");
const observations = join(temporary, "documentation-observations.txt");
const noImpactSource = join(temporary, "documentation-no-impact.ts");
const noImpactDiff = join(temporary, "documentation-no-impact.diff");
const noImpactReference = join(temporary, "documentation-no-impact-reference.md");
const fixtureFiles = [
  [boundarySource, `export const listenerHost = "127.0.0.1";
export const auditRetentionDays = 30;
export function authorizeRequest(host: string, token: string, expectedToken: string): boolean {
  return host === listenerHost && token.length > 0 && token === expectedToken;
}
`],
  [boundaryDiff, `Synthetic architectural change. Current source is documentation-boundary.ts.
- export const listenerHost = "0.0.0.0";
+ export const listenerHost = "127.0.0.1";
- return token.length === 0 || token === expectedToken;
+ return host === listenerHost && token.length > 0 && token === expectedToken;
`],
  [staleReadme, `# Synthetic service
The service listens on all network interfaces. Guests can omit a token.
Production deletes all audit records after 30 days.
`],
  [staleReference, `# Synthetic API reference
Listener host: 0.0.0.0.
Authentication: an empty token grants guest access.
Audit retention: production enforces deletion after 30 days.
`],
  [acceptedAdr, `# ADR 001. Public guest access
Status: Accepted.
Context: Remote guest clients need access.
Decision: Bind all interfaces and allow an empty token.
Alternatives: Loopback-only access with a required token.
Consequences: Remote guests can connect without credentials.
`],
  [observations, `Explicitly supplied synthetic contract observations, not runs performed by this smoke.
authorizeRequest("127.0.0.1", "secret", "secret") => true.
authorizeRequest("127.0.0.1", "", "secret") => false.
authorizeRequest("0.0.0.0", "secret", "secret") => false.
No production logs, deployed configuration, deletion job, or retention observation is available.
The 30-day constant is intent, not proof of production deletion.
`],
  [noImpactSource, `// Reject negative counts.
export function acceptCount(count: number): boolean {
  return Number.isInteger(count) && count >= 0;
}
`],
  [noImpactDiff, `Synthetic comment-only fix in documentation-no-impact.ts.
- // Reject negtive counts.
+ // Reject negative counts.
No executable statement, signature, configuration, or contract changed.
`],
  [noImpactReference, `# Synthetic count API
acceptCount accepts nonnegative integers and rejects other numbers.
The spelling of source comments is not part of the public contract.
`],
] as const;
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
    prompt: `I own a dependent PR in an Autopilot-stack chain, and I am its only branch writer. Its parent branch moved and my PR needs rebasing. The root coordinates the chain. Who rebases and publishes my branch, what is its rebase target, and what checks guard that publication and the later operator handoff? Do not touch a branch or PR. Read ${stack} and ${babysit} first.`,
    semanticConditions: [
      "The PR owner leaves babysit to rebase and publish only its own branch. The root coordinates owners and does not rewrite their branches.",
      "A dependent child rebases onto its parent branch, while a stack root or independent PR rebases onto trunk.",
      "Check the remote tip and stop on an unexpected writer. Pin force-with-lease to the last pushed or taken-over SHA.",
      "Reassess patch verdict coverage. A rebase gets a fresh single verifier unless a major change requires a full swarm. Require green CI and mergeability for the new head. Do not merge or push after operator handoff without the operator's go.",
    ],
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
        content: "[Synthetic fixture user] Any deletion of the archived checkouts archive/native-port-0.15.15, archive/caller-migration, or archive/release-snapshot requires my explicit approval for that item. Do not delete it without asking me.",
      },
      {
        role: "assistant", label: "pending-cleanup-approval",
        content: "[Synthetic fixture assistant] Cleanup approval is still pending. All three archived checkouts are retained. Each preserves a separate recovery copy and uses its existing disk space. Deleting one would free its space but remove that recovery copy. I recommend keeping it until validation is complete. Without approval I will keep it. No disk size was measured.",
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
      "Open with one pending user call, approval to delete archived checkouts. List all three waiting items by their names, including the two raised before the last message. Never replace the item list with a count or link.",
      "Report the completed explicit-base audit fix and caller updates as progress since the last substantive user message.",
      "Do not recount the earlier unrelated demo theme color update as new progress.",
      "Treat the notification and subagent report as postboundary evidence, not new user messages.",
      "Explain keeping versus approving deletion, their recovery-copy and disk-space tradeoffs, the recommendation to keep, and the default to keep without approval.",
      "A Markdown table does not count as a visual. Draw a small genuine Mermaid diagram only if it explains the explicit-base change or the choices better than prose. Do not manufacture a screenshot, video, or disk size. For a visible change without a screenshot, say No screenshot yet and explain what changed on screen.",
      "List bun run typecheck, bun run check:content, and bun test as remaining assistant-runnable work, not user action items.",
      "Do not claim validation ran, external PR or CI state was checked, or a screenshot or link exists.",
    ],
  },
  {
    name: "documentation-gate",
    files: [modeGuidance, owner, writing, unslop, boundarySource, boundaryDiff, staleReadme, staleReference, acceptedAdr, observations],
    prompt: `A permanent architectural and security-boundary change is ready for delivery. Read ${modeGuidance}, ${owner}, ${writing}, ${unslop}, and all six synthetic fixture files ${boundarySource}, ${boundaryDiff}, ${staleReadme}, ${staleReference}, ${acceptedAdr}, ${observations}. These are real temporary files containing a synthetic service, not this repository's implementation. The current README and reference still contain their old claims. A prior assistant said docs were done. No independent documentation review has run. The required production retention guarantee must be verified before delivery, but no runtime evidence is available. Decide whether commit, ready, or completion is permitted and give the documentation todo and factual review plan. Identify specific claims and their evidence status. This is a read-only guidance smoke. Do not edit docs, dispatch a reviewer, or claim any check or review ran.`,
    seeds: [
      {
        role: "assistant", label: "unsupported-docs-complete",
        content: "[Synthetic fixture assistant] All docs are done. README and the API reference are accurate, ADR 001 still applies, and production deletes audit records after 30 days. We can commit and mark ready. I have no source citations, check output, or independent review to show.",
      },
    ],
    semanticConditions: [
      "Reject the prior assistant's docs-done and production-retention claims as proof. Do not permit commit, ready, or completion with unresolved required documentation.",
      "Put Documentation completion gate explicitly in task todos before delivery, including local no-PR work.",
      "Identify stale all-interface and guest-token claims in both README and API reference using the current source, diff, and explicitly synthetic observations.",
      "Require README and reference corrections plus a new ADR superseding accepted ADR 001 without rewriting its accepted history. Include context, decision, alternatives, consequences, and links.",
      "Use technical-writing and unslop, inspect existing conventions, and select affected docs without mechanically creating every doc type.",
      "Require a fresh independent read-only factual reviewer for changed docs, with per-claim CONFIRMED, WRONG, or UNVERIFIABLE and source evidence. The session's own assessment is not that independent review.",
      "Classify the production retention guarantee as UNVERIFIABLE and name unavailable runtime evidence as an unresolved blocker, not a pass based on a source constant.",
      "Plan safe snippet and available docs/link checks, terminology/link/diagram consistency checks, corrections, revalidation, and fresh review of corrected claims.",
      "Report intended docs paths and only exercised accuracy checks in final reply and PR Verification. Do not claim doc edits, executable checks, production observation, or independent review happened in this read-only smoke.",
    ],
  },
  {
    name: "documentation-no-impact",
    files: [modeGuidance, owner, writing, unslop, noImpactSource, noImpactDiff, noImpactReference],
    prompt: `I made a permanent local comment-spelling fix with no PR. Read ${modeGuidance}, ${owner}, ${writing}, ${unslop}, ${noImpactSource}, ${noImpactDiff}, and ${noImpactReference}. The last three are real temporary files containing an explicitly synthetic comment-only diff, current source, and API docs. What does the documentation gate require before delivery? Give a concrete applicability outcome and reason tied to the diff and docs. This is a read-only guidance smoke. Do not create an ADR, edit docs, or claim executable checks or independent review ran.`,
    semanticConditions: [
      "Apply the documentation gate to this permanent local no-PR fix and put it in task todos before delivery.",
      "Record no documentation change warranted with a specific reason. The diff only corrects a comment typo, executable code and contracts are unchanged, and the inspected reference already describes the same nonnegative-integer behavior.",
      "Do not create an unnecessary ADR or mechanically demand other doc types. Changed-doc independent review is not required when no docs changed.",
      "Report the inspected source, diff, and reference plus the concrete no-impact reason. Do not claim executable checks, doc writes, or independent factual review ran.",
      "Distinguish the gate's no-impact outcome from a silent skip and from exemption of casual chat or read-only questions.",
    ],
  },
];
const results = [];
assert(!process.env.PSTACK_SMOKE_CASE || cases.some(({ name }) => name === process.env.PSTACK_SMOKE_CASE), "Unknown PSTACK_SMOKE_CASE");
try {
  for (const [path, content] of fixtureFiles) await Bun.write(path, content);
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
          if (scenario.name === "ketchup") assert(session.extensionRunner?.getCommand("ketchup"), "native ketchup command registered");
          await session.prompt(scenario.prompt);
        })(),
        completion.promise,
      ]);
      const response = session.getLastAssistantText();
      assert(response, `${scenario.name} returned no response`);
      const missingReads = scenario.files.filter((file) => !reads.some((args) => {
        const path = JSON.parse(args).path;
        return typeof path === "string" && (path === file || path.startsWith(`${file}:`));
      }));
      assert.equal(missingReads.length, 0, `${scenario.name} did not read ${JSON.stringify(missingReads)}; read calls: ${JSON.stringify(reads)}; response: ${response}`);
      assert(readReceipts.length === reads.length && readReceipts.every(({ isError }) => !isError), `${scenario.name} completed its reads successfully`);
      results.push({
        scenario: scenario.name, reads, readReceipts, response,
        ...(scenario.seeds || scenario.semanticConditions ? {
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
