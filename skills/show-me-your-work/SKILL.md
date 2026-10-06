---
name: show-me-your-work
description: "Keep a reviewable decision trail for long-running or unattended work: a TSV log with one row per decision (what, why, evidence, result). Local by default; commit it when a reviewer needs the trail to trust the result. Use for /show-me-your-work, autonomous or multi-phase runs, or work a human reviews after stepping away."
disable-model-invocation: true
---

# Show me your work

Keep one canonical log.

## The format

A single TSV file, one row per decision. Cells stay single-line. Evidence is a pointer, not prose.

Copy `references/decision-log-template.tsv` (the header row) to start a clean log. Columns:

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words. If a principle drove it, say it plainly, not as a jargon tag.
- **evidence.** A link or path that proves it: commit SHA, PR number, `file:line`, or an artifact, trace, or screenshot path. Never a paragraph.
- **result.** The outcome or predicate state: `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance.

```
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components and roughly 75 hours	wanted to know the size before starting a long run	commit 3a9f1c2	found 5 things to sort out before starting
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new and catch any visual change	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the instructions for next time
```

## Logging a row

Write each entry the way you'd tell a teammate what you did. Plain words, concrete actions, no AI speak or abstract jargon (the **unslop** skill applies to log text too).

Use the stable `log` subcommand so rows stay well-formed. Resolve `PSTACK_ROOT` once with the install resolver documented in the README section on running the `pstack` CLI after install. Inside the checkout, use `PSTACK_ROOT="$(pwd)"`. Run `bun "$PSTACK_ROOT/src/cli.ts" log <logfile> <phase> <decision> <why> <evidence> <result>`. It stamps `ts`, writes the header on first use, and strips stray tabs and newlines. It prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote to prevent spreadsheet formula execution. A bare `printf` appending a row works too. Apply the same safeguards to generated or user-supplied cells.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. For loop runs, one row per iteration. Skip the trivial and self-evident.

A run is one agent conversation, including later turns and summaries. A pickup, replacement agent, or new chat starts another run. Before appending to a log that already has rows, write a `start` row that names this run in its evidence cell. On a later turn, read the log's last rows. If another run has written since this run's last row, write another `start` row before resuming. Each `start` row names the preceding rows' timestamp range that this run did not write in its decision cell. Reserve `start` for this boundary.

## Where it lives

By default the log is a working artifact, not committed. Keep it at `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` when several efforts run at once, and leave it out of git.

Commit it only when the work is ambitious enough that a reviewer needs the trail to trust the result.

## Rules

- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by committed scripts over hand-made one-offs (the **encode-lessons-in-structure** principle skill).

## Audit the log against the transcript

At the end of the run, before handing back, check that the log told the truth. Read this run's own transcript, the current session's JSONL file in the session directory. Do not glob across other sessions or workspaces. That reads unrelated private chats. Walk only this run's rows against what happened. Each stretch begins at this run's `start` row, or at the first row if this run created the log. It ends at the next `start` row from another run:

- Check that every row maps to a real decision or action.
- Check that each row's evidence resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but isn't logged is a gap. Add it.

Correct the log, not the story. Never edit or delete a row during the audit. For an invented, padded, or otherwise wrong row, append a row that supersedes it with what actually happened and a resolving evidence pointer. Audit only this run's stretches. Do not infer that a prior run's row is false solely from this run's transcript. If this run's own work disproves a prior row, supersede it like any wrong call.

## Cross-model review of the trail

Before handing back, pick an available model from a different family than the one that did the work (the session's model registry exposes the available models), then get a descriptor from `pstack_agent` with `role: "judgment and prose"`, `kind: "readonly"`, and that concrete selector as the `model` override. Dispatch a native `task` subagent with the returned `agent` only. The selected model is already resolved into the prepared agent; returned `model` is metadata for the report, not a native `task` field. Self-review is not a substitute; the point is fresh eyes you cannot bring yourself. The subagent reads the audit trail and the run's transcript, then flags what the user should pay attention to. Not a redo of the work, a scan for what's suboptimal or risky.

- Decisions logged with weak or absent evidence.
- Verification steps skipped or claimed without proof in the transcript.
- Choices that look risky in hindsight (premature, scope-creeping, papering over a symptom).
- Gaps the user would otherwise miss on a casual skim.

Every reply for a run that produced a trail ends with an "Attention" section. Lead with the reviewer's model on its own line (`reviewed by <model>`), then list each flag pointing to specific rows or moments. "No flags" is a valid value. The model name is not.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. GitHub renders a committed TSV as a table. `column -s$'\t' -t decisions.tsv` renders it in a terminal.

## Composing this skill

Other skills route their audit trail here instead of inventing one. Reference it by name and let it own the format. Don't restate the columns.
