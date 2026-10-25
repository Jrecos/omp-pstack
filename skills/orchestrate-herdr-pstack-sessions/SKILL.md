---
name: orchestrate-herdr-pstack-sessions
description: "Launch parallel top-level OMP sessions in Herdr panes, each running /poteto-mode on a self-contained brief written by this session, then monitor, unblock, and integrate their reports. Use when the user asks to run work in parallel Herdr panes, panels, or sessions. Distinct from swarm and native task, which run subagents inside this session. Requires HERDR_ENV=1."
---

# Orchestrate Herdr P Stack sessions

This session is the orchestrator. Each worker is a full OMP session in its own Herdr pane, started in Poteto mode on a brief you write. Workers outlive your turn, run their own subagents, and accept input the user types into their pane.

Use native `task` subagents when the work fits inside this session. Use worker sessions when a slice needs its own long-running session, its own fan-out, or a pane the user wants to watch and steer.

## Preconditions

1. `test "${HERDR_ENV:-}" = 1`. If it fails, say this session is not inside Herdr and stop.
2. If `PSTACK_HERDR_RUN` is set, this session is a worker. Do not orchestrate. Use native `task` for any fan-out.
3. Resolve the installed plugin root once with the `PSTACK_ROOT` resolver in the omp-pstack README (*running the `pstack` CLI after install*). Inside the plugin's own checkout, use `PSTACK_ROOT="$(pwd)"`. Launch and wait only through `bun "$PSTACK_ROOT/src/cli.ts" herdr-run`. Do not create panes, start agents, or wait with raw `herdr` commands.

## 1. Plan the run

Split the work into slices that are independent end to end. Slices that write the same file, branch, or state merge into one slice, or share a contract you fix before launch (**principle-separate-before-serializing-shared-state**).

- Keep at most 4 workers working at once. A run launches once and holds 1 to 4 workers. When a worker finishes and slices are still queued, launch the next ones as a new run.
- Pick a run id such as `auth-1430`. It must match `[a-z][a-z0-9_-]{0,29}`. Create `RUN="${TMPDIR:-/tmp}/pstack-herdr/<run-id>"`. Worker `<n>` is named `<run-id>-<n>`, reads `$RUN/<n>/brief.md`, and writes `$RUN/<n>/report.md`.
- Give each code-writing worker its own worktree from the agreed base: `git worktree add ../<repo>-<run-id>-<n> -b pstack/<run-id>/<n> <base>`. Read-only workers share the current checkout. A new worktree does not copy the source checkout's ignored files, such as `node_modules` and `.env`, so the brief names the setup command.

## 2. Write each brief

The worker has none of this conversation. The brief, plus the files it points to, is everything it knows about the task. Use this shape and fill every section:

```markdown
# Brief: <run-id>-<n> (run <run-id>)

## Goal
<Run goal in one sentence.> Your slice: <the outcome this worker owns>.

## Playbook
Run the poteto-mode <Feature | Bug fix | Investigation | Refactoring | ...> playbook.

## Context
- <Decisions already made, constraints, and findings, with file:line pointers.>
- <Leads recalled from memory, labeled unverified.>

## Ownership
- Working directory: <absolute path>. Branch: <branch, or "read-only">.
- You own <files or directories>. Do not edit anything else.
- Fixed shared contract: <interfaces, paths, or formats other workers rely on>.

## Acceptance
- <Checks that pass or fail, each with its exact command.>

## Autonomy
- Decide reversible questions yourself and list them under Open decisions.
- <Code-writing worker:> Commit to your branch. <Read-only worker:> Edit nothing except the report.
- Do not push, open PRs, merge, deploy, or delete data unless granted here: <grant, or "none">.
- Do not start Herdr sessions.
- If you cannot continue without an answer, write the report with Status BLOCKED and the question, then stop.

## Deliverable
Write <absolute $RUN/<n>/report.md path> with a first line `Status: DONE`, `Status: PARTIAL`, or `Status: BLOCKED`, then sections Changes, Verification (commands run and observed output), Open decisions, and Blockers.
Then reply with one line `PSTACK-DONE <run-id>-<n> <report path>` and stop.
```

- Point at files instead of pasting them. Paste only decisions the worker cannot rediscover.
- Name the playbook so the worker does not reroute the task.
- Write acceptance the worker can run. A worker with no runnable check stops at "looks done".

## 3. Launch

Write `$RUN/workers.json` as a JSON array in worker order. Each entry has `cwd`, the absolute working directory, and an optional `model`. Take the model from the user, or from `pstack_models` action `show` when the user names a role, and pass the P Stack selector whole, such as `litellm/glm-5.3:max`. Omit `model` for the profile default.

```json
[{"cwd": "/work/repo-auth-1430-1", "model": "litellm/glm-5.3:max"}, {"cwd": "/work/repo-auth-1430-2"}]
```

Then run:

```bash
bun "$PSTACK_ROOT/src/cli.ts" herdr-run launch "$RUN"
```

The helper checks `workers.json`, the briefs, the reports, and that no live Herdr agent already holds a worker name, all before it creates anything. It opens a tab labeled `pstack <run-id>`, gives each worker its own pane there, starts OMP in Poteto mode on the brief, and writes `$RUN/run.json` with each worker's real pane and, when OMP reported one during launch, its session. Your own pane is never split. It prints the same record.

- `startup: "working"` means the worker began its turn. `startup: "blocked"` goes to the `blocked` row in step 4.
- `startup: "unknown"` means Herdr did not report that worker working or blocked within the 60 seconds launch waits for each worker. Read the pane with `herdr agent read <name> --source recent-unwrapped --lines 120` before sending anything. If the pane visibly works while `herdr agent get <name>` reports `idle`, Herdr may not be receiving OMP state. Ask the user to confirm `herdr integration install omp`, then restart that worker.
- An input problem exits 1 before anything is created and writes no `run.json`. A launch that fails after that exits 1 and leaves `run.json` showing how far it got. A worker at stage `prompted` received its brief. A worker at stage `pane` or `agent` did not. A second launch of the same `$RUN` is refused, so a brief is never sent twice. Inspect the panes the record names, then launch the slices that never received a brief as a new run.
- `run.json` is the recovery record if this session compacts or restarts. Only the helper writes it.

## 4. Monitor

For each worker, run one async bash call with the bash tool's own `timeout: 0`:

```bash
bun "$PSTACK_ROOT/src/cli.ts" herdr-run wait "$RUN" <n>
```

It returns when the worker is `idle`, `done`, or `blocked`, with no deadline of its own, and prints the state and report path. The result arrives without polling. Handle each return:

| State | Report | Action |
|---|---|---|
| `done` or `idle` | Status DONE or PARTIAL | Go to step 5 for this worker. |
| `done` or `idle` | Status BLOCKED | Answer inside the brief's scope, or relay the question to the user. Send the answer with `herdr agent prompt <name> "<answer>"`, then wait again. |
| `done` or `idle` | Missing, or no `Status:` line | Read `herdr agent read <name> --source recent-unwrapped --lines 120`. Answer a question it asked, or prompt "Finish per your brief and write the report." Wait again. |
| `blocked` | Any | Read the pane. An approval or question dialog, or a provider failure, is waiting. Show it to the user. Never answer an approval dialog unless the user granted it. |
| `wait` exits 1 | Any | Read its stderr. `agent_not_found` means the worker's OMP session exited. Read its report and pane before deciding anything. |

Never add `--wait` to `herdr agent prompt`. Keep one outstanding prompt per worker. A user typing directly into a worker pane is normal. Read the pane before prompting a worker you did not just leave idle.

## 5. Integrate

You own the outcome. Do not pass reports through.

1. Read each report and check its claims against the worker's tree: `git -C <worktree> log --oneline <base>..HEAD` and the diff.
2. Rerun each acceptance command yourself.
3. Merge, stack, or open PRs for the branches through the matching poteto-mode playbook. Resolve cross-slice conflicts in this session.
4. Reply with one row per worker: status, branch, verification you reran, open decisions.

## 6. Clean up

Leave panes open while the user may still read them. Close only the tab this run created, `herdr tab close <tab>` with the `tab` from `run.json`. A closed worker resumes with `omp --resume <session>` when its `run.json` entry has a `session`. Remove a worktree only after its branch merged or the user dropped it.
