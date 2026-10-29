---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners from the configured `arena runners` role in `rules/pstack-models.md`. Query it with `pstack_models` action `show`. If the role is unset or a selected model is unavailable, run `/setup-pstack` first. Never substitute another model. `inherit-parent` and `auto` entries resolve to the live parent model through the returned agent, including cross-judge entries. Spawn more runners when the arena covers multiple design directions. Use the same model N times when generation, rather than judgment, limits the work. Ordered duplicate entries count as separate runners.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Get each runner's descriptor from `pstack_agent` with `{role: "arena runners", index: <1-based entry number>, kind: "general"}`. Spawn all N subagents in one native `task` batch, each with the returned `agent`, the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected. Dispatch is asynchronous. The returned `model` is metadata, not a native `task` field.

For code-writing candidates, add per-item `isolated: true` only when the native schema advertises it, with isolation enabled and plan mode off. Use controlled `task.isolation.apply=false` when one owner selects and integrates the winner. Retain candidate patch or branch artifacts until grafting and verification finish. Otherwise prepare distinct worktrees or checkouts before dispatch. Verify the intended base, branch, and actual cwd. Check dependencies and environment files after clone fallback, and recheck private enablement per checkout. Do not change global settings. A main worktree or transcript fork does not isolate sibling candidates, and native isolation does not replace Docker. Ordinary task results are final text by default, not `yield`. Eval `agent()` and `workpool` keep their structured contract.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, get the judge descriptor from `pstack_agent` with `{role: "arena cross-judge pool", kind: "readonly"}` and no index. The tool selects the first configured entry from a different family than the live parent's, or the first entry if none differs. If the role is unset or unavailable, run `/setup-pstack`. Spawn one readonly judge through native `task` with the returned `agent`. It sees the rubric and candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Do not spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
