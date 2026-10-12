---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, the parent resolves this conversation's JSONL transcript in the current session directory. Pass its absolute path to every reviewer. Do not glob across other sessions or workspaces. That reads private chats unrelated to this session. If no path resolves, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Spawn three reviewers in one native `task` batch. Resolve each descriptor through `pstack_agent` and pass only its returned `agent`. The returned `model` is metadata, not a native `task` field. Use `kind: "general"` because reviewers need MCP access for tickets, chat threads, and traces. The `readonly` kind strips MCPs. The prompt forbids file writes. The parent applies edits.

Each reviewer and the synthesizer use the configured role in `rules/pstack-models.md`, managed by `pstack_models` through `/setup-pstack`. If a role is unset or its model is unavailable, run `/setup-pstack`. Never substitute another model. `inherit-parent` and `auto` resolve to the live parent model through the returned agent.

| Lens | `pstack_agent` role | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `task` result.

## 3. Synthesize

Resolve `pstack_agent` with `role: "reflect judgment, divergent, synthesizer"` and `kind: "general"`. Dispatch one native `task` with the returned `agent`. The synthesizer's citation spot-checks can need MCP access, which `readonly` strips. Pass `references/synthesizer.md` verbatim, with each reviewer's full output filled in. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the packaged OMP skill-authoring guidance (`skills/poteto-mode/references/omp-create-skill.md`) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to that guidance and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to that guidance. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
