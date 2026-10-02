# Skills reference

The plugin ships 48 discoverable skills under `skills/`. The 25 direct workflow skills have bare `/<name>` commands. The 23 supporting `principle-*` skills do not have bare commands. OMP also exposes all 48 through `/skill:<name>`.

A foreign command or an OMP built-in can own a bare name. In that case, use `/skill:<name>` for the plugin skill. Workflows that dispatch agents require configured model roles. `/setup-pstack` selects an approved model pool and saves the role map. An unset or unavailable role blocks dispatch rather than choosing another model.

## Direct workflow skills (25)

| Skill | Purpose and use case |
|---|---|
| [`architect`](../../skills/architect/SKILL.md) | Settle caller usage, types, and module shape before code crosses a function boundary. |
| [`arena`](../../skills/arena/SKILL.md) | Compare parallel solutions to one task, select a base, and graft in stronger parts from other candidates. |
| [`automate-me`](../../skills/automate-me/SKILL.md) | Draft or refresh a personal `-mode` skill from your work history. |
| [`blast-radius`](../../skills/blast-radius/SKILL.md) | Trace what a change could break outside the diff and prove a safety claim with running code. |
| [`bro`](../../skills/bro/SKILL.md) | Restate the last message in plain language without jargon. |
| [`create-verification-skill`](../../skills/create-verification-skill/SKILL.md) | Create a project-local verification skill and feature map when behavior lacks a repeatable check. |
| [`figure-it-out`](../../skills/figure-it-out/SKILL.md) | Design an auditable playbook when no bundled playbook fits a task. |
| [`how`](../../skills/how/SKILL.md) | Explain a subsystem's code path, ownership, and runtime behavior. |
| [`interrogate`](../../skills/interrogate/SKILL.md) | Have independent models challenge a diff from different review angles. |
| [`maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md) | Compare a verification skill and its feature map with current source and one live pass, then correct proven drift. |
| [`make-bot-ui`](../../skills/make-bot-ui/SKILL.md) | Build a bot interface whose buttons wake an agent routine through a webhook, with sender-key and Tailscale access. |
| [`no-comments`](../../skills/no-comments/SKILL.md) | Have Comment Sicko challenge comments before review and fix accepted findings. |
| [`poteto-mode`](../../skills/poteto-mode/SKILL.md) | Route a nontrivial task through a matching playbook and supporting skills. The mode stays active until disabled. |
| [`recall`](../../skills/recall/SKILL.md) | Rebuild recent working context from chat history and the shared record into a current-state brief. |
| [`reflect`](../../skills/reflect/SKILL.md) | Review the active transcript with parallel reviewers and propose concrete skill edits from durable lessons. |
| [`session-review`](../../skills/session-review/SKILL.md) | Review recent workspace sessions for supported repository navigation, setup, or documentation problems. |
| [`setup-pstack`](../../skills/setup-pstack/SKILL.md) | Choose an approved model pool and save the role map used by delegated workflows. |
| [`show-me-your-work`](../../skills/show-me-your-work/SKILL.md) | Keep a TSV decision trail with reasons and evidence during long or unattended work. |
| [`swarm`](../../skills/swarm/SKILL.md) | Assign parallel workers distinct slices, races, or checks and return one combined report. |
| [`tdd`](../../skills/tdd/SKILL.md) | Write a failing test before the fix when TDD is requested or a cheap local test path is clear. |
| [`teach`](../../skills/teach/SKILL.md) | Explain a change or subsystem in plain language by combining how it works with why it exists. |
| [`technical-writing`](../../skills/technical-writing/SKILL.md) | Apply a layered writing standard to technical docs, READMEs, PR descriptions, or commits. |
| [`typescript-best-practices`](../../skills/typescript-best-practices/SKILL.md) | Apply TypeScript rules while reading or editing `.ts` and `.tsx` files. |
| [`unslop`](../../skills/unslop/SKILL.md) | Remove AI writing patterns from prose. |
| [`why`](../../skills/why/SKILL.md) | Investigate a decision or tradeoff through available evidence sources and report cited findings. |

`/session-review [N] [--plugin-report]` reads the last N session files in the current workspace. N defaults to 10. The review is read-only and reports its evidence, recoveries, and limits in chat. `--plugin-report` explicitly adds a separate sanitized plugin-feedback section for you to inspect before sharing. The bare command rejects invalid arguments before a model turn. `/skill:session-review` does not have that host-side argument gate. A private saved copy requires an explicit request. Local history storage does not mean local-only processing. Your configured model and provider process the selected session content through your normal account.

## Supporting principles (23)

These skills guide decisions within workflows, especially `/poteto-mode`. They have no bare `/principle-*` aliases. Use their names to steer a workflow or invoke a specific skill through `/skill:principle-<name>`.

| Skill | Purpose and use case |
|---|---|
| [`principle-attack-the-premise`](../../skills/principle-attack-the-premise/SKILL.md) | Census the actors and question a shared premise after two fixes fail the same way. |
| [`principle-boundary-discipline`](../../skills/principle-boundary-discipline/SKILL.md) | Validate at system boundaries instead of repeating guards inside typed code. |
| [`principle-build-the-lever`](../../skills/principle-build-the-lever/SKILL.md) | Build a rerunnable tool that performs or proves nontrivial work. |
| [`principle-encode-lessons-in-structure`](../../skills/principle-encode-lessons-in-structure/SKILL.md) | Turn repeated guidance into a check, script, or metadata rule. |
| [`principle-exhaust-the-design-space`](../../skills/principle-exhaust-the-design-space/SKILL.md) | Compare two or three prototypes for a novel design without precedent. |
| [`principle-experience-first`](../../skills/principle-experience-first/SKILL.md) | Choose the user's result over implementation convenience in product tradeoffs. |
| [`principle-fix-root-causes`](../../skills/principle-fix-root-causes/SKILL.md) | Reproduce a defect and trace its cause before editing. |
| [`principle-foundational-thinking`](../../skills/principle-foundational-thinking/SKILL.md) | Choose core types and data structures before writing dependent logic. |
| [`principle-guard-the-context-window`](../../skills/principle-guard-the-context-window/SKILL.md) | Send bulk reading to subagents and keep only findings in the main conversation. |
| [`principle-laziness-protocol`](../../skills/principle-laziness-protocol/SKILL.md) | Prefer deletion and the smallest change that solves a refactor or improvement. |
| [`principle-make-operations-idempotent`](../../skills/principle-make-operations-idempotent/SKILL.md) | Make retries and repeated lifecycle operations converge to the same result. |
| [`principle-migrate-callers-then-delete-legacy-apis`](../../skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md) | Move every caller to a new API and delete the old one in the same change. |
| [`principle-minimize-reader-load`](../../skills/principle-minimize-reader-load/SKILL.md) | Collapse excess layers and hidden state when code is hard to trace. |
| [`principle-model-the-domain`](../../skills/principle-model-the-domain/SKILL.md) | Put repeated domain rules in a structure instead of scattered branches. |
| [`principle-never-block-on-the-human`](../../skills/principle-never-block-on-the-human/SKILL.md) | Proceed on reversible work rather than ask a question that tools can answer. |
| [`principle-outcome-oriented-execution`](../../skills/principle-outcome-oriented-execution/SKILL.md) | Complete a rewrite toward its target design without retaining temporary compatibility states. |
| [`principle-prove-it-works`](../../skills/principle-prove-it-works/SKILL.md) | Verify the real artifact rather than infer success from a proxy check. |
| [`principle-redesign-from-first-principles`](../../skills/principle-redesign-from-first-principles/SKILL.md) | Integrate a new requirement as though the existing design had included it from the start. |
| [`principle-separate-before-serializing-shared-state`](../../skills/principle-separate-before-serializing-shared-state/SKILL.md) | Remove shared writable state between concurrent actors before adding coordination. |
| [`principle-sequence-verifiable-units`](../../skills/principle-sequence-verifiable-units/SKILL.md) | Split multi-step work into ordered units that each end in a check. |
| [`principle-subtract-before-you-add`](../../skills/principle-subtract-before-you-add/SKILL.md) | Remove dead weight before adding new behavior or rewriting code. |
| [`principle-test-behavior-not-implementation`](../../skills/principle-test-behavior-not-implementation/SKILL.md) | Test code as users call it and assert literal results rather than internal calls. |
| [`principle-type-system-discipline`](../../skills/principle-type-system-discipline/SKILL.md) | Choose types that make invalid states impossible to express. |

## Other packaged material

The [23 playbooks](../../skills/poteto-mode/playbooks/) are files routed by `poteto-mode`, not separately discoverable skills or slash commands. Nested `references/` files support skill bodies; they are not skills. The `pstack_models`, `pstack_agent`, and `pstack_history` tools are tools, not slash commands. The `poteto-agent` and `Comment Sicko` agents are dispatched through the native task tool. The Benny operational skills under `automations/benny/skills/` are read by their automation runner. They are outside the plugin's skill discovery root and do not have `/skill:<name>` entries here.

`bun run check:content` verifies the shipped skill set and reports its count.
