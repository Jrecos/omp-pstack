<p align="center">
  <img src="./assets/omp-pstack-hero.webp" alt="Illustrated Jrecos leading four OMP robot agents in a watercolor engineering workshop beside the omp-pstack title." width="100%">
</p>

# omp-pstack

`omp-pstack` is our OMP-native adaptation of [P Stack](https://github.com/cursor/plugins/tree/main/pstack). This repository is the independently maintained OMP plugin: its packaging, host integrations, CLI/runtime, automations, and documentation are built for OMP rather than Cursor.

The original P Stack was created by [Lauren Tan (poteto)](https://x.com/poteto). Its engineering approach and much of its skill content originated in the upstream project. This adaptation preserves that credit and the original MIT license while owning the OMP-specific implementation and direction here.

P Stack is an answer to AI-generated slop: go deep before going fast, write less code, and demand evidence that the result works.

**pstack gives you fearless parallelism.** when you can go deep on one agent and trust it to write good, verifiable code, you can truly parallelize with confidence. start multiple agents with `poteto-mode` and trust that they'll apply rigorous engineering principles to their work.

**omp-pstack gives you the best of OMP.** use P Stack with any model available through OMP, including its multi-model workflows, native agents, tools, and plugin runtime.

fork it. improve it. make it yours. PRs are welcome!

## install in OMP

```bash
omp plugin marketplace add https://github.com/Jrecos/omp-pstack
omp plugin install omp-pstack@omp-pstack
```

Use OMP 18.3.4 with this checkout. The pinned SDK uses the 18.3.4 settings registry for model-role dispatch.

### running the `pstack` CLI after install

the helper commands (`orch`, `watch-pr`, `check-plan`, `worktree-audit`, `log`, plus the `routine` and `benny` commands documented below) live in the installed package. invoke them through the installed root, whatever scope you installed in:

```bash
PSTACK_ROOT="$(omp plugin list --json | bun -e 'const d=await Bun.stdin.json(); const m=(d.marketplace??[]).filter(p=>p.id==="omp-pstack@omp-pstack"&&!p.shadowedBy).flatMap(p=>p.entries??[]).find(e=>e.enabled!==false&&e.installPath); const n=(d.npm??[]).find(p=>p.name==="omp-pstack"&&p.enabled!==false); process.stdout.write(m?.installPath ?? n?.path ?? "")')"
bun "$PSTACK_ROOT/src/cli.ts" routine list
```

marketplace installs are listed under the canonical id `omp-pstack@omp-pstack`, and each entry carries an `installPath` — project-scope installs are listed before user-scope (a shadowed user entry is marked `shadowedBy`), so the resolver above picks the active scope automatically. npm/link installs appear under `npm` with `path`. working from a checkout of this repository instead? skip the resolver: `PSTACK_ROOT="$(pwd)"`.

### update

Refresh the marketplace catalog before upgrading the installed plugin:

```bash
omp plugin marketplace update omp-pstack
omp plugin upgrade omp-pstack@omp-pstack
```

Restart OMP after the upgrade to load the updated extension and skills. Check the installed version with `omp plugin list`.

`plugin upgrade` and forced reinstalls can use a stale marketplace cache. Do not skip `marketplace update`, and do not add the marketplace again.

If your OMP version has no `plugin upgrade`, refresh the catalog and force a reinstall:

```bash
omp plugin marketplace update omp-pstack
omp plugin install omp-pstack@omp-pstack --force
```

updating replaces the plugin code (skills, CLI, runtime) but keeps your configuration: the managed rule `rules/pstack-models.md`, your approved model pool, and the prepared agent profiles under `agents/` are regenerated on the next `/setup-pstack` save or `pstack prepare`, not by the update itself. after a breaking change to agent naming or profile layout, run `/setup-pstack` once and save to restage fresh profiles and sweep stale ones.

upgrading from a pre-0.15.0 config: the `how critics` role is retired and the 17-role parser rejects a config still carrying its line. before the next `/setup-pstack` save, edit `rules/pstack-models.md` to remove the `how critics:` role line, and any stale `# how critics[...]` address comments next to it. keep the approved model pool and every other role assignment. do not delete the whole config.

repo maintainers can verify manifest completeness, recorded source blobs, and byte-exact unadapted files against the pinned upstream commit with `bun scripts/check-upstream.ts <cursor/plugins checkout>`.

to move the pin, run `bun scripts/sync-upstream.ts <cursor/plugins checkout> <commit> <version>`. it copies unadapted files, three-way merges adapted files against the old upstream blob (conflicts land as `<<<<<<< omp` markers), adds new upstream files, and rewrites `upstream.json`. then resolve the markers, record new adaptations, and repin `EXPECTED_HEADER` and the inventory digest in `scripts/check-content.ts`.

## get started

two steps:

1. run [`/setup-pstack`](./skills/setup-pstack/SKILL.md), pick a reasoning budget, and choose which models you want.
2. use [`/poteto-mode`](./skills/poteto-mode/SKILL.md) whenever you're doing anything that requires rigor.

new here? the [pstack guide](./docs/guide/README.md) walks you through a first real task, from setup and prompting through verification and overnight runs. stuck, or unsure which skill fits? ask [`/poteto-help`](./skills/poteto-help/SKILL.md).

that's it. the other skills are situational. the mode uses them as needed. [`/setup-pstack`](./skills/setup-pstack/SKILL.md) asks you to approve a model pool, choose a reasoning budget, and confirm the role map. no model is used without your approval. an unset role needs setup.

## usage
[![Illustrated Jrecos routes OMP robot agents through bug-fix, feature, and investigation playbooks.](./assets/readme-routing.webp)](./docs/guide/02-poteto-mode.md)


use [`/poteto-mode`](./skills/poteto-mode/SKILL.md) at the start of a task. it reads your request, picks from a set of playbooks, and runs the other skills as the steps need them.

For a substantive task, Poteto mode uses task-specific memory already in the conversation. It calls OMP's native `recall` tool only when that context is missing or a new historical question arises. This is separate from the [P Stack `recall` skill](./skills/recall/SKILL.md), which reconstructs broader working history. Recalled claims are unverified until checked against current evidence and never authorize action. The mode instructs the agent to keep irrelevant or malicious memories out of replies and delegate briefs. If memory is unavailable, work continues without installing or repairing it.

These are agent instructions, not runtime guarantees of retrieval, deduplication, or filtering. Verify consequential remembered claims against current primary evidence.

To check a configured model, set `PSTACK_SMOKE_MODEL` to its authenticated selector and run `bun scripts/smoke-memory-context.ts /tmp/pstack-memory-context.json`. This optional native SDK smoke uses controlled memories and an isolated profile. It checks lookup discipline, rejected-memory omission, and a prepared read-only delegate. The same model also reviews unsupported incident and rationale claims. That verdict is not a semantic correctness guarantee. Inspect the recorded answers. A failure reports a model or integration limit rather than silently accepting it.

### optional official Spec Kit Feature lane

Use this lane only for a Feature request that explicitly asks for official GitHub Spec Kit. Install the pinned stable `specify-cli` **1.0.12** release and initialize a fresh, separate Git worktree from its root:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.12
specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force
specify integration status --json
```

The status must be `ok` with no findings. Then ask `/poteto-mode Build <feature> with official Spec Kit`. P Stack keeps its eight Feature steps and configured model roles. Its read-only `pstack_speckit` tool checks the installed CLI, OMP command source and rendered arguments, and plugin-owned SHA-256 pins for official commands, Bash scripts, and templates. It returns one phase's instructions without executing them. It does not register `/speckit.*` commands, run a workflow, or select a separate model. The feature spec, plan, quickstart, and tasks remain official CLI-generated OMP artifacts.

The pin covers the files that supply phase instructions or executable shell behavior. `.specify/init-options.json`, `.specify/.gitignore`, and `.specify/workflows/` are not pinned because this lane supplies the feature directory explicitly, does not execute workflow YAML, and does not treat ignore rules as authority. Custom presets, template overrides, and extensions are rejected rather than trusted.

The tool also refuses active or malformed `.specify/extensions.yml` hooks, unsafe feature paths, symlinks, status warnings, shared checkouts, and missing official assets. Choose a new direct child of `specs/` and pass it as `featureDirectory` even for the first `specify` phase. Do not put `SPECIFY_FEATURE_DIRECTORY` inside any phase argument. Keep one feature binding per worktree. Review `.specify/feature.json` against the original request and pass the same canonical directory to each later phase. The check does not sandbox another process that mutates files concurrently. If any gate fails, stop this opted-in run rather than switching to ordinary Feature.

Run `bun run check:speckit-assets` when reviewing a CLI pin change. This regenerates a clean official fixture and checks immutable plugin-owned hashes without repinning them. Review upstream source before changing a pin. For completion, inspect `quickstart.md` before execution and observe a real product effect. Generated files and exit status alone do not prove the Feature works.

### just use [`/poteto-mode`](./skills/poteto-mode/SKILL.md)

this skill is the main shortcut for rigorous engineering work. it comes with twenty-three playbooks:
```
/poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even when idle. repro
first, then fix and verify.
```

```
/poteto-mode i'm going to bed. land the stack even if ci flakes. i want everything merged by
morning.
```

<details>
<summary>the twenty-three playbooks</summary>

| playbook | for |
|---|---|
| [investigation](./skills/poteto-mode/playbooks/investigation.md) | a read-only question. how does x work, why was y built this way, are we sure. |
| [bug fix](./skills/poteto-mode/playbooks/bug-fix.md) | reproduce a defect, root-cause it, and fix with runtime evidence. |
| [perf](./skills/poteto-mode/playbooks/perf-issue.md) | trace a measured slowness and improve it against a baseline. |
| [hillclimb](./skills/poteto-mode/playbooks/hillclimb.md) | sustained, scientific improvement of one metric against a target, looping hypotheses with before/after measurement and one commit per accepted win. |
| [runtime forensics](./skills/poteto-mode/playbooks/runtime-forensics.md) | diagnose a live symptom (leak, idle-cpu spin, glitch) from instrumentation. |
| [trace forensics](./skills/poteto-mode/playbooks/trace-forensics.md) | diagnose a captured profiling artifact (cpuprofile, trace, spindump, heap snapshot). |
| [feature](./skills/poteto-mode/playbooks/feature.md) | new or changed behavior, built from a named data shape. |
| [refactoring](./skills/poteto-mode/playbooks/refactoring.md) | a behavior-preserving change to structure or shape. |
| [prototype](./skills/poteto-mode/playbooks/prototype.md) | a throwaway sketch to make a design or behavioral decision cheaply, or to settle an empirical fork by observing it. |
| [visual parity](./skills/poteto-mode/playbooks/visual-parity.md) | pixel-exact ui equivalence between two implementations. |
| [authoring a skill](./skills/poteto-mode/playbooks/authoring-a-skill.md) | writing or editing a SKILL.md. |
| [eval](./skills/poteto-mode/playbooks/eval.md) | test how a skill or prompt change affects agent behavior, blinded. |
| [babysit](./skills/poteto-mode/playbooks/babysit.md) | drive a pr or a stack to merge-ready: conflicts, review threads, ci. |
| [shipping](./skills/poteto-mode/playbooks/shipping.md) | independently verify a green stack, then land the contiguous verified run bottom-up through github by default or origin when available. |
| [autonomous run](./skills/poteto-mode/playbooks/autonomous-run.md) | drive a long task to completion without stopping. |
| [orchestrate](./skills/poteto-mode/playbooks/orchestrate.md) | a standing project handed to one coordinator chat: multi-day, many stacked prs, fleets of subagents. |
| [autopilot-full](./skills/poteto-mode/playbooks/autopilot-full.md) | run independent prs to merged with one owner per pr and a root swarm verification round at code-ready and after each patch-changing push. |
| [autopilot-stack](./skills/poteto-mode/playbooks/autopilot-stack.md) | build and verify one linear base-branch stack for the operator to review and land. |
| [session pickup](./skills/poteto-mode/playbooks/session-pickup.md) | resume or take over a prior agent's in-flight work. |
| [pause safely](./skills/poteto-mode/playbooks/pause-safely.md) | suspend in-flight work cleanly so it can be resumed later. |
| [multi-phase plan](./skills/poteto-mode/playbooks/multi-phase-plan.md) | work that spans phases or stacked PRs. |
| [worktree cleanup](./skills/poteto-mode/playbooks/worktree-cleanup.md) | reclaim disk by pruning merged or abandoned worktrees and stale ios simulators, safety-gated. |
| [opening a pr](./skills/poteto-mode/playbooks/opening-a-pr.md) | open a ready pr from small ordered commits with a conventional commits title and a briefing-style body. invoked at the end of every other playbook. |

</details>



when invoked it:

1. matches your task to a [playbook](./skills/poteto-mode/playbooks/) and opens a todo list whose first items are its steps, copied in verbatim.
2. routes to the other skills as the steps fire.
3. writes unslopped replies framed for the consumer and the maintainer.

the full rules and playbooks live in [`skills/poteto-mode/SKILL.md`](./skills/poteto-mode/SKILL.md).

Invoking [`/poteto-mode`](./skills/poteto-mode/SKILL.md) turns on persistent mode for the current OMP session branch. The plugin keeps its rules in context on later turns. It applies when a playbook matches or the task needs rigor and stays out of the way otherwise. Say "stop poteto mode" or "normal mode" to turn it off.

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) works extremely well with omp's built-in `/loop` command. you can make the agent work for many hours without sacrificing rigor.

## skills

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) runs most supporting skills for you when a step needs them. Invoke a direct workflow skill when you want that specific behavior:

```
/how do we cancel runs? do we have an n+1 when we look up every run to cancel?
```

```
/interrogate review this pr.
```

The [complete skills reference](./docs/guide/skills.md) lists all 52 discoverable skills with their purposes and source files. It separates 28 direct workflow skills from 24 supporting principles. Bare `/<name>` commands are available for direct skills when no other command owns the name. OMP's `/skill:<name>` form reaches all 52.

| New skill | Use it when |
|---|---|
| [`/poteto-help`](./skills/poteto-help/SKILL.md) | Find the skill, playbook, or principle for your goal and get a prompt to send. It runs only when you invoke it and does not start the work. |
| [`/correct`](./skills/correct/SKILL.md) | Fix repeated agent mistakes at the highest enforceable level, with architecture first and documentation last. Pair each rule with its enforcement. |
| [`/benchmark-checklist`](./skills/benchmark-checklist/SKILL.md) | Vet a measured number for its limiter, tuning, errors, repeatability, end-to-end relevance, and whether the timed work ran. |

`/session-review` reviews the last 10 sessions in the current workspace. Use `/session-review 25` to select the last 25, or `/session-review 25 --plugin-report` to add a separate, sanitized plugin-feedback section. The bare command rejects invalid counts and flags locally before dispatching a model turn. The `/skill:session-review` alternative is prompt-driven and has no host-side argument gate. The review uses the full available history window, not only the last seven days, and never edits the repository or sends a report elsewhere. Results appear in chat unless you explicitly request a private saved copy.

The repository report names the selected sessions and cites entry IDs for supported findings, recoveries, and counterexamples. It checks relevant current files before suggesting a small change. Fewer available sessions, unreadable records, partial history, and uncertain causes stay visible in the coverage and limits. The optional plugin section is written to stand alone without session IDs, private paths, or transcript excerpts; inspect it yourself before sharing. History lives locally, but the configured model and provider process the selected content through your normal account. The history reader does not supply exact timing, cost, or full subagent traces.

Maintainers can exercise the command with `PSTACK_SMOKE_MODEL=<authenticated-selector> bun scripts/smoke-session-review.ts`. The smoke uses synthetic sessions in a disposable profile and records the observed reports in `proofs/session-review.json`.



### examples

most workflows start with [`/poteto-mode`](./skills/poteto-mode/SKILL.md) and let it route to a playbook. the other skills fire as the steps need them; invoke one directly only when you want that specific workflow.


<details>
<summary>all the examples</summary>

```
bug fix:           /poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even
                   when idle. repro first, then fix and verify.
perf:              /poteto-mode a big list takes a second or two to load even though we virtualize.
                   run a cpu trace and tell me why.
feature:           /poteto-mode build a small feature behind a feature flag. verify it really works.
prototype:         /poteto-mode build two prototypes of the markdown renderer so we can compare.
                   spawn an agent for each.
multi-phase:       /poteto-mode open source these skills as a plugin. nothing internal leaks, work
                   in a temp dir, show me the dependency graph first.
overnight run:     /poteto-mode i'm going to bed. land the stack even if ci flakes. i want
                   everything merged by morning.
babysit:           /poteto-mode check on pr 123. anything outstanding?
visual parity:     /poteto-mode the row spacing is too tall when this flag is on. the second image
                   is correct. repro and fix until it matches.
figure it out:     /poteto-mode i'm stepping away. migrate every caller from the synchronous store
                   to the new async one, keeping behavior identical. i want to trust it was done
                   right when i'm back.
how:               /how do we cancel runs? do we have an n+1 when we look up every run to cancel?
why:               /why is this feature flag not on yet?
architect:         design this instrumentation to be high signal with no false positives. /architect
                   this first.
arena:             /arena take my prompt to the arena verbatim. i want to compare their proposals
                   with yours.
swarm:             /swarm check every package under packages/ against its check.sh. one worker per
                   package. one report.
interrogate:       /interrogate review this pr.
tdd:               /tdd implement
unslop:            can we unslop and tighten the new changes?
reflect:           /reflect that took too long. capture what we learned so the next run doesn't
                   repeat it.
correct:           /correct
show-me-your-work: /show-me-your-work keep a decision trail i can review when i'm back.
automate-me:       /automate-me
help:              /poteto-help which skill should i use to review this branch?
```

</details>

## the `poteto-agent` and Comment Sicko subagents

pstack ships the [`poteto-agent`](./agents/poteto-agent.md) wrapper to run poteto's style end to end. for role-based dispatch, call `pstack_agent` with the configured role and `kind: "poteto"`, then pass its returned `agent` to native `task`. the prepared agent pins your approved model and reads `poteto-mode` in full, including its principles index, before doing any work.

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) and prepared Poteto agents use the same style instructions.

pstack also ships [Comment Sicko](./agents/comment-sicko.md), a read-only comment reviewer shipped as a native agent. dispatch it with a native `task` call and `agent` set to `Comment Sicko`. usually invoke it through [`/no-comments`](./skills/no-comments/SKILL.md), not directly.

## principles
[![Illustrated Jrecos supervises OMP robot agents verifying a real machine and capturing evidence.](./assets/readme-verification.webp)](./docs/guide/06-verify-and-ship.md)


twenty-four short skills, one principle each. `poteto-mode` indexes them inline and reads that index at task start. the standalone files are there so other skills can reference a principle by name, and so the index can point at the full rule for each.

<details>
<summary>all twenty-four principles</summary>

| principle | group | rule |
|---|---|---|
| [laziness-protocol](./skills/principle-laziness-protocol/SKILL.md) | core | Bias toward deletion and the smallest change that solves the problem. |
| [foundational-thinking](./skills/principle-foundational-thinking/SKILL.md) | core | Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes obvious. |
| [redesign-from-first-principles](./skills/principle-redesign-from-first-principles/SKILL.md) | core | Redesign as if the requirement had been a foundational assumption from day one, instead of bolting it on. |
| [attack-the-premise](./skills/principle-attack-the-premise/SKILL.md) | core | Apply when two or more fixes that share one premise have failed the same gate. Take a census of which actors hold the imbalance before the next fix, then question the premise instead of writing another fix that assumes it. |
| [subtract-before-you-add](./skills/principle-subtract-before-you-add/SKILL.md) | core | Remove dead weight, redundant validators, and stub references first, then build on the simpler base. |
| [minimize-reader-load](./skills/principle-minimize-reader-load/SKILL.md) | core | Count layers between question and answer, and hidden state in the reader's head; collapse one-caller wrappers and shrink mutable scope. |
| [outcome-oriented-execution](./skills/principle-outcome-oriented-execution/SKILL.md) | core | Apply during planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture; don't preserve smooth intermediate states with throwaway compatibility code. |
| [experience-first](./skills/principle-experience-first/SKILL.md) | core | Choose user delight over implementation convenience; ship fewer polished features over more rough ones. |
| [exhaust-the-design-space](./skills/principle-exhaust-the-design-space/SKILL.md) | core | Build 2-3 competing prototypes and compare side by side before committing. |
| [build-the-lever](./skills/principle-build-the-lever/SKILL.md) | core | Apply to any non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator, or a skill your subagents follow) instead of working by hand. The tool is the artifact a reviewer can rerun. |
| [model-the-domain](./skills/principle-model-the-domain/SKILL.md) | architecture | Encode the domain in a structure instead of scattered conditionals. |
| [boundary-discipline](./skills/principle-boundary-discipline/SKILL.md) | architecture | Concentrate guards at system boundaries (CLI, config, network, external APIs); trust internal types and keep business logic in pure functions. |
| [type-system-discipline](./skills/principle-type-system-discipline/SKILL.md) | architecture | Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, refuse to lie to the compiler, exhaust variants, derive from authoritative schemas. |
| [make-operations-idempotent](./skills/principle-make-operations-idempotent/SKILL.md) | architecture | Converge to the same end state regardless of partial prior runs. |
| [migrate-callers-then-delete-legacy-apis](./skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md) | architecture | Migrate callers and delete the old API in the same wave instead of preserving compatibility layers. |
| [separate-before-serializing-shared-state](./skills/principle-separate-before-serializing-shared-state/SKILL.md) | architecture | Eliminate the sharing first; serialize structurally only when one shared writer is a real invariant. |
| [prove-it-works](./skills/principle-prove-it-works/SKILL.md) | verification | Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.'. |
| [fix-root-causes](./skills/principle-fix-root-causes/SKILL.md) | verification | Trace each symptom to its root cause and fix it there; reproduce first, ask why until you reach it, resist nil-check guards that silence crashes. |
| [sequence-verifiable-units](./skills/principle-sequence-verifiable-units/SKILL.md) | verification | Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself to a reviewer. |
| [test-behavior-not-implementation](./skills/principle-test-behavior-not-implementation/SKILL.md) | verification | Apply when you write, change, or keep a test. Call the code the way its users do and assert the result they observe against a literal expected value. If the test would still pass when every imported function returns undefined, rewrite the assertion or delete the test. |
| [explain-the-number](./skills/principle-explain-the-number/SKILL.md) | verification | Before trusting, reporting, or acting on a measured number, find what limits it. Rule out that it measured work other than the work you intended. |
| [guard-the-context-window](./skills/principle-guard-the-context-window/SKILL.md) | delegation | Route bulk to subagents; keep summaries in the main thread, not raw payloads. |
| [never-block-on-the-human](./skills/principle-never-block-on-the-human/SKILL.md) | delegation | Proceed, present the result, let the human course-correct after the fact; reserve confirmation for irreversible actions. |
| [encode-lessons-in-structure](./skills/principle-encode-lessons-in-structure/SKILL.md) | meta | Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. |

</details>

## host adaptations

a few things `poteto-mode` references needed omp translations. the adapted guidance ships inside this plugin, under `skills/poteto-mode/references/`:

- `omp-deslop.md` replaces the `cursor-team-kit` `deslop` skill: the same diff-cleanliness checks over the diff against main.
- `omp-control-cli.md` and `omp-control-ui.md` replace `control-cli` and `control-ui`: driving CLIs/TUIs and browser/Electron/web UIs with native tools (supervised processes, `browser.*`, hub process control).
- `omp-create-skill.md` is the skill-authoring guidance other skills route through.

inside `poteto-mode`, the [babysit playbook](./skills/poteto-mode/playbooks/babysit.md) owns pr-status requests; don't route those to a built-in skill whose description matches the same words.

## why are there no planning skills?

omp has native plan mode, which works well with pstack. planning is deliberately not the default: code is usually the best spec. when a plan is useful, [`/poteto-mode`](./skills/poteto-mode/SKILL.md) covers it.

## make it yours

`poteto-mode` encodes poteto's style. you may not want exactly that.

type [`/automate-me`](./skills/automate-me/SKILL.md). it mines your recent transcripts, drafts a `<your-name>-mode` skill from how you've actually worked, and routes through pstack underneath. you keep pstack as the base and end up with your own routing skill alongside `poteto-mode`.

models are configurable too. type [`/setup-pstack`](./skills/setup-pstack/SKILL.md). it detects the models you have access to, takes the approved pool first, and writes a small always-applied rule mapping each role (code, judgment, the review panels) to a pool member. every skill reads that rule; there are no hardcoded defaults left, so a role that isn't configured needs setup, and dispatch fails closed rather than substituting a model you didn't approve.

Rerunning setup keeps your approved pool and role identities unless you change them. It infers your current reasoning budget from saved effort suffixes. Removing a role line makes that role unconfigured. Run `/setup-pstack` to assign it again.

## automations
[![Illustrated Jrecos supervises an autonomous plan, build, verify, review, and ship loop.](./assets/readme-automation.webp)](./docs/guide/07-overnight.md)


pstack also ships a dormant [benny automation pack](./automations/benny/). benny triages slack issue reports, then reproduces and fixes confirmed bugs with real ui evidence. its files are not registered as slash skills.

to set it up, run the CLI from the installed root (see [running the `pstack` CLI after install](#running-the-pstack-cli-after-install)): `bun "$PSTACK_ROOT/src/cli.ts" benny setup --target <repo>` (intent documented in [`FOR_AGENTS.md`](./automations/benny/FOR_AGENTS.md)). setup copies the pack into the target repository at `.omp/automations/benny/`, installs omp-pstack there at project scope for the shared skills, and keeps user configuration outside the copied pack under `.omp/benny/`. deployment is gated: `pstack benny check` (every check except `canary`), then a passing `pstack benny canary`, then a rerun of `pstack benny check` (all checks pass, including `canary`), before `pstack benny enable`.

evidence retention: every benny run's screenshots and recordings expire after `control.artifact_retention_hours` (default 24). the native runner sweeps expired evidence on startup and while runs settle, but a quiet host with no further events needs an external pass: schedule the one-shot sweep from cron or a systemd timer, e.g. hourly

```bash
bun "$PSTACK_ROOT/src/cli.ts" benny sweep --config .omp/benny/configuration.yaml
```

with `PSTACK_ROOT` resolved once per host as in [running the `pstack` CLI after install](#running-the-pstack-cli-after-install). the sweep never deletes evidence owned by queued or running runs, and it fails closed (deletes nothing) when run ownership cannot be established.

## releases

After checks pass, each pull request merged into `main` gets a GitHub release. [`.github/workflows/release.yml`](./.github/workflows/release.yml) handles merged pull requests, including fork contributions, and queues release runs. It runs type checking, release regression tests, and content integrity checks on trusted `main`, then passes the verified commit to [`scripts/release.ts`](./scripts/release.ts). If `main` changes before publication, the run fails rather than releasing unchecked code. The first release is `1.0.0`. Later releases use the pull request title and breaking-change footer:

| pull request | bump |
| --- | --- |
| A title such as `feat!:` or `fix(cli)!:`, or a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer | major |
| `feat:` or `feat(scope):` | minor |
| everything else, including `docs:` and untyped titles | patch |

The release commit updates `package.json` to match its `vX.Y.Z` tag. The annotated tag records the version, pull request, and release notes. A rerun uses that record instead of allocating another version. The script never moves or deletes tags, pushes the branch and tag atomically without force, and does not publish to npm. This project's version is independent of the upstream P Stack version recorded in `upstream.json`.

To recover a failed or cancelled run, use `gh workflow run release.yml -f pr=<number>` from this repository, or select **Run workflow** in the Actions tab.

- If `main` changed or the push was rejected, rerun after `main` is stable.
- If the tag was pushed but release publication failed, a rerun publishes that tag without another version bump.
- Before allocating a version, the script repairs missing releases for earlier managed tags.

The token needs permission to write repository contents. Future branch rules must allow the release bot's version commits. The queue holds 100 pending runs. GitHub cancels overflow runs, which need manual recovery. Releases follow queue order rather than merge order. Each release is a cumulative snapshot of verified `main`, so it can include changes merged after the pull request that triggered it.

## credits and license

Based on [P Stack](https://github.com/cursor/plugins/tree/main/pstack) by [Lauren Tan (poteto)](https://x.com/poteto), adapted from upstream version `0.15.15`. Exact upstream repository, commit, file lineage, and adaptation records are tracked in [`upstream.json`](./upstream.json).

Released under the [MIT License](./LICENSE). The original copyright notice is retained.
