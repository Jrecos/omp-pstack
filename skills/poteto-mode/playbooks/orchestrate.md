### Orchestrate

**You run the program, never the code. Decide which agent does each piece of work, then check what each one produces.** For a standing project handed to one coordinator chat: multi-day, many stacked PRs, dozens to hundreds of subagents, few human turns. One task driven to a predicate is Autonomous run. One ambitious run that needs a bespoke workflow is figure-it-out. Work that one agent could finish inside the session's budget is not a program.

Run it with native tools. Resolve each worker through `pstack_agent` for its configured role and dispatch native `task` with the returned `agent`. Keep the program's state in the root agent's store and tracker, with durable file paths in each brief. Use native job inspection and completion deliveries. Watch each PR through forge event subscriptions when available, otherwise inspect its current state at checkpoints. Do not build a script coordinator or polling loop, and never relay messages or status between agents.

#### Topology

- **One owner per PR.** The owner is the only writer of its branch and carries the PR from build to merge. Only the owner pushes, rebases, or retargets it. Closing or retargeting a base PR orphans every PR above it, so the owner does that only on your call. You never author or edit code. Conflicted merges, chain rebases, and fixes go to owners.
- **A fresh worker for each independent task.** Its kickoff carries the goal and file pointers to every upstream report it needs. Give each writer a distinct worktree or isolated checkout and verify its base, branch, cwd, dependencies, and environment. Use native per-item isolation only when the task schema advertises it. Do not change global settings. Runtime checks use `../references/omp-control-ui.md` or `../references/omp-control-cli.md`. Pick reasoning and speed through the configured role, per the Subagents section.
- **A sub-coordinator only when one area has many parallel workers.** It owns that area's workers and kickoffs and sends you one rollup, never raw worker reports. Stay within the host's recursion and concurrency caps. Start the next worker as one finishes instead of waiting on a whole batch.
- **Reuse a worker only when new work needs its built state,** such as its checkout, uncommitted changes, or a running process, per the Subagents section. Otherwise dispatch a fresh worker. Inspect jobs without messaging workers for status, because a message can restart an idle agent.
- **Each PR gets a verifier that isn't its author,** on a different model family. The owner merges only on that verifier's pass at the current head.
- **Start with one unit.** Take it through kickoff, owner, verifier, and merge before you fan out, so a flaw in the kickoff costs one agent instead of fifty. On near-identical cheap units, the first unit is that test.

#### Supervision

- **Each kickoff names the evidence that proves the work is done,** such as a command and its expected output, a control-skill check, or an artifact. It also names the goal, the paths the worker may and may not write, and the actions it must not take. If you can't name the evidence, the unit isn't scoped yet.
- **Read the diff or the artifact, not only the worker's summary.** Green CI is an input to a verdict, not a verdict. Behavioral work needs more than a type check. A verdict covers one head SHA, so a new push needs a new verdict. Read a sample of each sub-coordinator's kickoffs while its workers run, and fix its instructions when one fails.
- **Send back work that drifts from scope or grows past what was asked.** Keep only the fixes that block the program, and park the rest as follow-ups.
- **Check a PR's live state before you report on it,** with `gh pr view` and `gh pr checks` or your forge's equivalents, not the worker's last report. Account for every worker you spawned as done, replaced, or absorbed into another worker's scope.
- **Stop or replace a worker that stalls or loops.** Judge it by its pushes and PR activity, not its status text. Retry by cause. Narrow scope after a context or memory limit and repeat the kickoff after a dropped connection. A model change must remain within the configured role and approved pool, through `/setup-pstack`, never an invented fallback. After two retries, drop the unit and replan around it. When a stopped worker returns late, check its result against the PR's current state, and hand any unique findings to a fresh worker.
- **Ask the user only for a real decision or a blocker,** such as an irreversible action, a product or preference call that no experiment settles, or a dead end that survived a replan. Rebase mechanics, retries, CI flakes, review triage, and "should I keep going" never reach the user.

**Reply:** what landed against the goal, each PR's live state and verdict with its link, what was dropped and why, and the decisions waiting on the user.
