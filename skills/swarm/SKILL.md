---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not a concurrency limit.
4. Pick the worker model from the configured `swarm workers` role in `rules/pstack-models.md`. Query it with `pstack_models` action `show`. If the role is unset or a selected model is unavailable, run `/setup-pstack` first. Never substitute another model. `inherit-parent` and `auto` resolve to the live parent model through the returned agent. For a model race, name each arm's model and pass its selector as the `model` override to `pstack_agent`. Overrides must belong to the approved pool.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the sample count, what one sample is, and the order. The worker records both the SHAs and method in its result.

## Phase B: Fan out

Get each worker's descriptor from `pstack_agent` with `{role: "swarm workers", kind: "general"}`. Include the arm-specific `model` override for a race. Spawn all N workers in one native `task` batch using only each returned `agent`. The returned `model` is metadata, not a native `task` field. Ordinary tasks return final text by default, not `yield`. Eval `agent()` and `workpool` remain structured. Give each writer a distinct checkout or output directory. If the native schema advertises per-item `isolated`, use it only with isolation enabled and plan mode off. With one integration owner, use controlled `task.isolation.apply=false` and review retained patch or branch artifacts. Otherwise use the existing distinct-checkout fallback. Pass shared goal pointers in `context`. Use native owner-scoped job or Agent Hub controls for cancellation.

When a worker needs a non-default pushed branch, prepare its isolated checkout from that exact branch before dispatch and include the checkout path in its brief.

Never let sibling writers share a working tree. Verify each coding checkout's base, branch, and cwd. Check dependencies and environment files after clone fallback, and recheck private enablement. Do not change global settings. A main-session worktree or transcript fork does not isolate sibling workers, and native isolation does not replace Docker.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
