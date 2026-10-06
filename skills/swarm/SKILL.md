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

Get each worker's descriptor from `pstack_agent` with `{role: "swarm workers", kind: "general"}`. Include the arm-specific `model` override for a race. Spawn all N workers in one native `task` batch using only each returned `agent`. The returned `model` is metadata, not a native `task` field. Workers run as native background task agents. Give each writer its own checkout or `/tmp/swarm-<slug>/worker-<n>/`, never a shared working tree. Pass `context` with the shared goal so workers coordinate cancellation through the native job/hub.

When a worker needs a non-default pushed branch, prepare its isolated checkout from that exact branch before dispatch and include the checkout path in its brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
