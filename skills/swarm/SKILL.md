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
4. Pick the worker model from the configured `swarm workers` role (from the `pstack-models` profile rule written by `/setup-pstack`; query it with `pstack_models` action `show`) when present. Otherwise use `grok-4.6-fast-xhigh`. For a model race, name each arm's model up front and dispatch each arm through `pstack_agent` with `model` set to that arm's selector (per-arm overrides are allowed here).
5. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`.

## Phase B: Fan out

Get each worker's descriptor from `pstack_agent` (`{role: "swarm workers", kind: "general"}` — with the arm-specific `model` override for a race) and spawn all N workers in one message as native `task` calls using only each returned `agent`. `pstack_agent` has already resolved the configured or overridden model into the prepared agent; its returned `model` is metadata, not a native `task` field. Workers run locally; give each one its own writable checkout when it writes (worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`), never a shared working tree. Pass `context` naming the shared goal so workers coordinate cancellation through the native job/hub surface.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
