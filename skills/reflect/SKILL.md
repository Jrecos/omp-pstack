---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

- The user said "reflect" or "/reflect".
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.

Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

The parent resolves its own transcript before fanning out: the current session's JSONL file in the session directory. Pass its absolute path to every reviewer. Do not glob across other sessions or workspaces; that reads private chats unrelated to this session.

If no path resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

One message, three native `task` calls. For each reviewer, get a descriptor from `pstack_agent` and dispatch `task` with the returned `agent` only. `pstack_agent` has already resolved the configured model into the prepared agent; its returned `model` is metadata, not a native `task` field. Use `kind: "general"` — reviewers need MCP access for context lookups (tickets, chat threads, observability traces referenced in the transcript); the `readonly` kind strips MCPs. The prompt forbids file writes; the parent applies edits.

| Lens | `model` | Prompt template | `pstack_agent` role |
|---|---|---|---|
| Judgment | your configured reflect-judgment model (default `claude-fable-5-1-thinking-max`) | `references/judgment-reviewer.md` | `role: "reflect judgment, divergent, synthesizer"` |
| Tooling | your configured reflect-tooling model (default `gpt-5.6-sol-max`) | `references/tooling-reviewer.md` | `role: "reflect tooling"` |
| Divergent | your configured reflect-judgment model (default `claude-fable-5-1-thinking-max`) | `references/divergent-reviewer.md` | `role: "reflect judgment, divergent, synthesizer"` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `task` result.

### 3. Synthesize

One more `task` call, using `pstack_agent` with `role: "reflect judgment, divergent, synthesizer"` and `kind: "general"` (your configured reflect-judgment model, default `claude-fable-5-1-thinking-max`). The synthesizer's quality check includes spot-verifying citations, which can require MCP access; `readonly` strips MCPs. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. The synthesizer already applies this criterion; this is a final pass before edits land. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org; do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Those are tracker submissions, not skill edits. Only the Accepted list waits for approval.

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
