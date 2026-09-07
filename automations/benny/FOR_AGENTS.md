# benny automation intent

## what i want to automate

i want two OMP-native automations that work together in one slack issue channel. both are served by the deterministic native runner: the coordinator advances persisted stages, and every Slack, tracker, and pull-request write goes through bound actions gated by the runner.
`pstack` commands below are run through the installed-root launcher `bun "$PSTACK_ROOT/src/cli.ts" ...`: resolve `PSTACK_ROOT` once with the install resolver in the omp-pstack README (`running the pstack CLI after install`; inside the package checkout, `PSTACK_ROOT="$(pwd)"`). a marketplace install does not put `pstack` on PATH.

### automation 1: triage issue reports

- trigger: when someone posts a new top-level report in my configured source slack channel, i want this automation to start on that report and keep its original thread coordinates. delivery comes from the external CLI (`bun "$PSTACK_ROOT/src/cli.ts" benny run`) or Slack Socket Mode.
- tracker: i want it to search my configured tracker for duplicates, update a confident duplicate, and create a ticket only for a clear net-new bug.
- tools: i want bound read-only slack thread and tracker actions, tracker write actions in the coordinator only, and my committed routing map (it may be an empty map when no owner routing is wanted, but its configured path is required).
- outcome: i want exactly one reply in the source thread with a short verdict and `[benny:bug]`, `[benny:performance]`, or `[benny:other]`. a bug or performance marker may include the tracker url.
- boundary: i never want this automation to post a root message in the source channel.

### automation 2: reproduce and fix confirmed bugs

- trigger: i want this automation to start from the same new top-level report, then wait for the trusted triage marker in the original thread.
- gates: i want it to stop when someone clearly owns the fix. if an existing pull request or merged commit may fix the report, i want verification instead of a competing change.
- behavior: i want it to use my configured control adapter inside a disposable workspace container and the committed feature map, reproduce the exact symptom twice through the real ui, and capture screenshots, video, and a read-only state cross-check.
- fix: i want it to verify existing pull requests without authoring over them. after a confirmed repro, it may attempt one bounded root-cause fix, use tdd when the test is cheap, smoke the blast radius, and open a draft pull request only when before-and-after proof passes.
- tools: i want bound slack thread read and reply actions, read-only repository access, a disposable container workspace, draft pull request creation through the runner's `gh`-backed action, my configured tracker, and my control adapter.
- outcome: i want evidence and a verified result in the source or optional operations threads, plus an optional draft pull request. updates should be concise.
- boundary: i never want this automation to post a root message in the source channel.

### shared rules

- i want the source channel and root thread coordinates to stay immutable for the whole run.
- i treat utility and debug bots as evidence, not delegation or fix ownership.
- i allow subagents to help, but they cannot post to slack or receive slack credentials. delegated sessions get read-only bound actions only.
- i want this entire pack installed at `.omp/automations/benny/` in the target repository. its `SKILL.md` files are direct automation instructions read by the runner, not registered plugin skills.
- i want shared pstack dependencies (`how`, `why`, `tdd`, `unslop`, and the required principle skills) available through a committed project-scoped omp-pstack plugin install, not a global link.
- i want each live automation prompt to receive its committed operational file directly. i do not want plugin cache paths, copied excerpts, or slash-skill discovery.
- i keep user-owned configuration, feature maps, routing maps, and secrets outside `.omp/automations/benny/` so pack refreshes cannot overwrite them.
- i want both automations to fail closed when channel coordinates, tracker access, the control adapter, or the feature map are missing or uncertain.
- i want draft pull requests only. do not merge or deploy.
- i want enabling to be an explicit, gated step: validated config, committed `.omp` declarations, and a passing canary for the exact current configuration and revision before live traffic.

### my configuration

- source slack channel: `<channel>`
- optional operations channel: `<channel or none>`
- repository and default branch: `<repo>`, `<branch>`
- tracker: `<bundled linear adapter; team, project, labels, intake status>`
- routing map: `<committed path; the map may be empty for no owner routing>`
- triage identity: `<slack identity>`
- control adapter: `<trusted adapter command plus workspace image, configured in the runtime section>`
- feature map: `<committed same-repo path outside the copied pack>`
- models: `<concrete omp model selectors for triage, reproduce, code, media review>`
- status emoji strings: `<seen, reproducing, reproduced, blocked, fixing, failed, pull request opened>`
- budgets: `<polling, verdict wait, follow-up, repro, rejection, fix>`
- optional bot token capability: `<none, file download, or editable operations status>`
- trigger transport: `<external cli or socket-mode>`

start from [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md). copy and fill them outside this pack, for example under `.omp/benny/`. keep secret values in environment variables named by the config's runtime section.

## for the agent

the human installs benny by running `bun "$PSTACK_ROOT/src/cli.ts" benny setup --target <repo>` from the omp-pstack checkout. do not look for or invoke a discovered benny slash skill. the intent below describes what setup and the later gates must deliver.
1. ask which repository will run the automations.
2. run `bun "$PSTACK_ROOT/src/cli.ts" benny setup --target <repo>`. it merges the source pack into `<target-repository>/.omp/automations/benny/`: new files copied, identical files no-op, differing managed files reported as conflicts for review, destination-only files preserved. it never deletes unrelated files or overwrites user-owned configuration, feature maps, or routing maps.
4. verify that the copied `FOR_AGENTS.md` and `skills/setup-benny/SKILL.md` exist in the target repository.
5. read and follow `.omp/automations/benny/skills/setup-benny/SKILL.md` directly from the target repository.

setup installs the omp-pstack plugin at project scope in the target (`omp plugin marketplace add <this package>` plus `omp plugin install --scope project omp-pstack@omp-pstack`) and verifies the durable declarations `.omp/plugins/installed_plugins.json` and `.omp/plugins/omp-plugins.lock.json` name omp-pstack. preserve every unrelated project configuration file.

verify from a fresh agent rooted in the target repository that omp-pstack's `how`, `why`, `tdd`, `unslop`, and the principle skills used by benny resolve at project scope. do not count skills loaded from the current session or a user-scoped install.

if the project-scoped install fails or any shared dependency does not resolve, stop and explain what failed. do not add `.omp/automations/benny/` to a plugin manifest or expect its files to appear in the slash-skill list.

tell me that `.omp/plugins/installed_plugins.json`, `.omp/plugins/omp-plugins.lock.json`, `.omp/automations/benny/`, the committed configuration (`.omp/benny/configuration.yaml` and any referenced feature or routing map), and any referenced secret-free configuration must be committed before either automation is enabled. `bun "$PSTACK_ROOT/src/cli.ts" benny check` enforces this and refuses to enable with uncommitted declarations.
for first-time deployment: fill and commit the configuration, run `bun "$PSTACK_ROOT/src/cli.ts" benny check --config <path>` until every check passes except the expected not-yet-run `canary` row, run `bun "$PSTACK_ROOT/src/cli.ts" benny canary --config <path> --event <harmless-test-report.json>` in the configured test targets, rerun `bun "$PSTACK_ROOT/src/cli.ts" benny check --config <path>` until every check including `canary` passes, then run `bun "$PSTACK_ROOT/src/cli.ts" benny enable --config <path>`. the canary uses the real transport and action paths while background admission stays disabled, and records observed checks for the exact current configuration hash and repository revision.
the triage run reads and follows `.omp/automations/benny/skills/triage-issue-reports/SKILL.md`. the repro run reads and follows `.omp/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`. the runner loads these committed operational files directly; prompts never embed plugin cache paths or file copies.

deliver reports through one of the two supported transports: the external CLI (`bun "$PSTACK_ROOT/src/cli.ts" benny run --config <path> --event <json-file|->` with a Slack Events API envelope from a trusted local caller) or Slack Socket Mode (`runtime.trigger: "socket-mode"`, served by the native runner). do not invent a third trigger path, and do not enable live traffic without the canary gate.
