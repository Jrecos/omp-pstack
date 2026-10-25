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
3. Run `herdr --help` and `herdr agent`. The installed CLI is the syntax authority. Parse every ID from JSON responses, never from examples or sidebar order.

## 1. Plan the run

Split the work into slices that are independent end to end. Slices that write the same file, branch, or state merge into one slice, or share a contract you fix before launch (**principle-separate-before-serializing-shared-state**).

- Run at most 4 workers at once. Queue the rest and start the next as one finishes.
- Pick a run id such as `auth-1430`. Name workers `<run-id>-<n>` or by slice. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live Herdr agents (`herdr agent list`).
- Create `RUN="${TMPDIR:-/tmp}/pstack-herdr/<run-id>"` with `$RUN/<worker>/brief.md` per worker. Reports go to `$RUN/<worker>/report.md`.
- Give each code-writing worker its own worktree from the agreed base: `git worktree add ../<repo>-<worker> -b pstack/<run-id>/<worker> <base>`. Read-only workers share the current checkout. A new worktree does not copy the source checkout's ignored files, such as `node_modules` and `.env`, so the brief names the setup command.
- Keep `$RUN/run.md` as a table with one row per worker: name, pane, cwd, branch, session, status. It is the recovery record if this session compacts or restarts. Reconcile it with `herdr agent list` before acting.

## 2. Write each brief

The worker has none of this conversation. The brief, plus the files it points to, is everything it knows about the task. Use this shape and fill every section:

```markdown
# Brief: <worker> (run <run-id>)

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
Write <absolute report path> with a first line `Status: DONE`, `Status: PARTIAL`, or `Status: BLOCKED`, then sections Changes, Verification (commands run and observed output), Open decisions, and Blockers.
Then reply with one line `PSTACK-DONE <worker> <report path>` and stop.
```

- Point at files instead of pasting them. Paste only decisions the worker cannot rediscover.
- Name the playbook so the worker does not reroute the task.
- Write acceptance the worker can run. A worker with no runnable check stops at "looks done".

## 3. Lay out panes

- One worker: split beside the caller, right for a wide pane and down for a tall one. `herdr pane split --current --direction right --cwd <cwd> --env PSTACK_HERDR_RUN=<run-id> --no-focus`, then read `.result.pane.pane_id`.
- Two to four workers: give the run its own tab so the user's pane keeps its size. `herdr tab create --cwd <cwd-1> --label "pstack <run-id>" --env PSTACK_HERDR_RUN=<run-id> --no-focus`. Worker 1 takes `.result.root_pane.pane_id`. Split the other panes by explicit pane ID, never `--current`, which targets your own pane: `herdr pane split <worker-1-pane> --direction right --cwd <cwd-2> --env PSTACK_HERDR_RUN=<run-id> --no-focus` for worker 2, `herdr pane split <worker-1-pane> --direction down ...` for worker 3, and `herdr pane split <worker-2-pane> --direction down ...` for worker 4.
- Label each pane with `herdr pane rename <pane> "<worker>"`.

## 4. Start each worker

```bash
herdr agent start <worker> --kind omp --pane <pane> [-- --model <provider/id> --thinking <effort>]
herdr agent prompt <worker> "/poteto-mode Read <brief path> in full and execute it. It is your whole task."
herdr agent wait <worker> --until working --until blocked --timeout 60000
```

- Omit the model flags to use the profile's default model. A P Stack selector such as `litellm/glm-5.3:max` is rejected by `--model`. Split it into `--model litellm/glm-5.3 --thinking max`. Take selectors from the user, or from `pstack_models` action `show` when the user names a role.
- Send the brief only through `agent prompt`. A slash command passed as an `omp` startup argument does not run as a command.
- Do not add `--wait` to that prompt. With `/poteto-mode` it was observed to fail with `agent_prompt_stalled` although the prompt was delivered. A `working` result from the follow-up wait means the worker started a turn. A `blocked` result goes to step 5. On a timeout, read the pane before sending anything again.
- Herdr learns OMP's working state from its OMP integration extension. Never start a worker with `--no-extensions`. If the pane visibly works while Herdr still reports `idle`, Herdr is not receiving that state. Check the launch flags, then ask the user to confirm `herdr integration install omp` and restart the worker.
- Record each worker's session from `herdr agent get <worker>` (`.result.agent.agent_session.value`) in `run.md`.

## 5. Monitor

Wait on each worker with `herdr agent wait <worker>` and no other flags. Without `--until` it returns on `idle`, `done`, or `blocked`. Without `--timeout` it waits indefinitely. `--timeout 0` is not "no limit". It times out immediately on a worker that is still working. Run each wait as an async bash call with the bash tool's own `timeout: 0`, so the default tool deadline does not kill it and results arrive without polling. Handle each return:

| Wait result | Report | Action |
|---|---|---|
| `done` or `idle` | Status DONE or PARTIAL | Go to step 6 for this worker. |
| `done` or `idle` | Status BLOCKED | Answer inside the brief's scope, or relay the question to the user. Send the answer with `herdr agent prompt`, then wait again. |
| `done` or `idle` | Missing | Read `herdr agent read <worker> --source recent-unwrapped --lines 120`. Answer a question it asked, or prompt "Finish per your brief and write the report." Wait again. |
| `blocked` | Any | Read the pane. An approval or question dialog, or a provider failure, is waiting. Show it to the user. Never answer an approval dialog unless the user granted it. |

Keep one outstanding prompt per worker. A user typing directly into a worker pane is normal. Read the pane before prompting a worker you did not just leave idle.

## 6. Integrate

You own the outcome. Do not pass reports through.

1. Read each report and check its claims against the worker's tree: `git -C <worktree> log --oneline <base>..HEAD` and the diff.
2. Rerun each acceptance command yourself.
3. Merge, stack, or open PRs for the branches through the matching poteto-mode playbook. Resolve cross-slice conflicts in this session.
4. Reply with one row per worker: status, branch, verification you reran, open decisions.

## 7. Clean up

Leave panes open while the user may still read them. Close only the tab or panes this run created (`herdr tab close <tab>` or `herdr pane close <pane>`). A closed worker resumes with `omp --resume <session>` from `run.md`. Remove a worktree only after its branch merged or the user dropped it.
