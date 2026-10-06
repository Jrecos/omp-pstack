---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

The parent resolves its own transcript before fanning out: the current session's JSONL file in the session directory. Pass its absolute path to every reviewer. Do not glob across other sessions or workspaces; that reads private chats unrelated to this session.

If no path resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

Spawn three reviewers in one native `task` batch. Resolve each descriptor through `pstack_agent` and pass only its returned `agent`. The returned `model` is metadata, not a native `task` field. Use `kind: "general"` because reviewers need MCP access for tickets, chat threads, and traces. The `readonly` kind strips MCPs. The prompt forbids file writes. The parent applies edits.

Each reviewer and the synthesizer use the configured role in `rules/pstack-models.md`, managed by `pstack_models` through `/setup-pstack`. If a role is unset or its model is unavailable, run `/setup-pstack`. Never substitute another model. `inherit-parent` and `auto` resolve to the live parent model through the returned agent.

| Lens | `pstack_agent` role | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `task` result.

### 3. Synthesize

Resolve `pstack_agent` with `role: "reflect judgment, divergent, synthesizer"` and `kind: "general"`. Dispatch one native `task` with the returned `agent`. The synthesizer's citation spot-checks can need MCP access, which `readonly` strips. Use `references/synthesizer.md` verbatim with each reviewer's full output filled in. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the packaged OMP skill-authoring guidance (`skills/poteto-mode/references/omp-create-skill.md`) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to that same guidance and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to that guidance. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
