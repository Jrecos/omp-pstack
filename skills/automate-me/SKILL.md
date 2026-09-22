---
name: automate-me
description: "Use for \"automate me\", creating or refreshing a personal -mode skill, capturing working preferences, or turning one narrow workflow into a reusable skill. Routes mode requests through history mining and regular workflows through native OMP skill authoring."
disable-model-invocation: true
---

# Automate me

Mode skills use the history-mining flow below. Every skill uses the packaged OMP authoring guidance (`skills/poteto-mode/references/omp-create-skill.md`) and the **unslop** skill.

## Flow

### 0. Classify the skill and choose its root

Classify the request before mining history.

- Broad working conventions, preferences, or agent behavior produce a `<handle>-mode` skill. Continue with steps 1-6.
- One task-specific workflow produces a regular skill. Run the workflow once when possible, then author it with the packaged guidance and **unslop**. Skip steps 1-3 and the mode-only fields in step 4. Do not stop after the live run or offer to write the skill later.

Read the authoring guide and execute its **Placement** section before running the workflow or searching for an existing skill. When Placement requires a question, call the structured-question tool and wait for the answer. Never infer or silently select the recommended root. A missing `.omp/skills/` or `.agents/skills/` directory is a placement choice, not a reason to stop.

For a mode skill, check `<skill-root>/*-mode/SKILL.md` and the active profile's `skills/*-mode/SKILL.md` for the user's handle. Skill directories are one level below their root. If one exists, ask one structured question unless the user already requested an update:

- Update the existing skill. This is the default for repeat runs.
- Start fresh. Ask why before replacing it.

Update mode changes the rest of the flow:
- Step 1 mines only history since the skill was last edited (`git log -1 --format=%cI <path>`).
- Step 2 asks what's changed or missing, not what to capture from zero.
- Step 4 edits the existing file in place. Preserve sections the user hasn't contradicted. Revise ones with new evidence. Add new sections only for genuinely new rules.

### 1. Mine their history

Mine the active workspace's chat history before fanning out. Reach it with `pstack_history` (`action: "list"` then `action: "read"`; workspace-scoped, excludes the current and subagent sessions). Use only that workspace's sessions. Don't glob across other workspaces' session directories. That crosses workspace boundaries and reads private chats from unrelated projects.

Survey recent agent conversations within that scope for recurring patterns. Run multiple parallel subagents across slices of history (e.g. last 2-4 weeks, split into 3 slices so each has enough material). Each slice mining subagent reads the slice the parent provides (the `pstack_history` list entries or session JSONL paths, workspace-scoped), looks for the signals below, and returns a short structured list of patterns it saw with evidence pointers. Default signals worth hunting:

- Response preferences (length, tone, format, "dumb it down" corrections)
- Delegation habits (subagents, models, specialized workflows, parallelism)
- Verification posture (what "done" means, unit tests vs live repro, reviewers)
- Code and prose discipline (style, principles cited, lint/format tools)
- Process conventions (worktrees, commits, PRs, review/merge tooling)
- Meta preferences (fixing skills mid-task, proposing new ones)

Cross-check across slices before elevating a signal. Patterns seen in 2+ slices are high-confidence. Lone signals are weak and usually get dropped.

### 2. Ask the user directly

Mining misses intent that hasn't come up yet. Ask with a short structured question (a few concrete options beat a blank prompt). Lower cognitive load, higher hit rate.

Shape: one or two questions with 4-6 options each, multiple selection allowed for category questions. Start broad ("Which areas matter most?"), then follow up on selected areas with specific options. After the structured rounds, one free-form chat question catches anything the options missed.

Don't dump 20 questions.

### 3. Cluster findings

Group the combined signals into sections. Common ones (use only what applies):

- **Response style**: length, tone, format.
- **Autonomy**: how much to do without asking, MCP tool use.
- **Understand first**: which skills to reach for when scoping or investigating a change.
- **Subagents**: default, parallelism, model-to-task, specialized workflows.
- **Prose / code discipline**: principles, lint tools, style guides.
- **Review and verify**: repro posture, verification skills, live-testing tools.
- **Process**: git worktrees, commits, PRs, review/merge tooling.
- **Skills**: skill-authoring habits, fix-the-skill-first, proposing new skills.

The **poteto-mode** skill shows the shape. Read it for granularity. Don't copy its content. The user's rules are not the same as poteto-mode's.

### 4. Draft the skill

Follow the packaged OMP skill-authoring guidance (`skills/poteto-mode/references/omp-create-skill.md`) to author the skill. Use the root selected in step 0. A new mode lives at `<skill-root>/<handle>-mode/SKILL.md`. Preserve an existing mode's path when updating it.

- Handle: the user's first name or chosen identifier.
- Frontmatter `description`: trigger on their name + `/<handle>-mode` + "work in their style", not on generic keywords like "write code" or "review PR".
- Frontmatter formatting: follow the authoring guidance's YAML rules. Keep `description` as one YAML scalar; quote it or use `description: >-` with indented continuation lines when punctuation or wrapping requires it.
- Frontmatter `disable-model-invocation: true` by default. Mode skills are heavy and opinionated; they should only apply when the user explicitly invokes them by name or slash command. Opt out only if the user explicitly wants their mode to apply on every turn.

### 5. Iterate on prose

Apply the **unslop** skill and the authoring guidance's writing rules to every line. Both apply to any agent-read prose, not just skills.

Show the draft to the user and take feedback. Expect multiple iterations. Cut ruthlessly. A mode skill is not a manual.

### 6. Land it

Work in a worktree off main. Commit and open a PR. Don't push to main directly.

## Guardrails

- **Don't overfit to one conversation.** A preference stated once and contradicted another time is noise. Require multiple instances before codifying it.
- **Don't be clever.** Restating other skills' contents, inventing metaphors, or writing "poetic" prose for an agent reader is cost without benefit. Keep it operational.
- **Reference, don't inline.** Other skills the user relies on should appear as path references, not pasted excerpts. Same for any principle docs they maintain elsewhere.
- **Keep sections minimal.** Only add a section if the user has a specific, non-default rule there. "Communicate clearly" is not a section. "Short paragraphs. Tables when comparing options. Bullets only when items are genuinely parallel." is.
- **Name conventions generic.** Use "the user" or "the human" in imperatives, not the author's first name.
- **Don't force symmetry.** If a user has no process rules worth writing down, skip the Process section entirely.

## Evaluation

A `-mode` skill is subjective output. A test/iterate benchmark loop isn't useful here. Vibe-check with the user: does it read like them? Did it miss anything? Then ship.

Run a description-optimization loop only if the skill's trigger accuracy turns out to be a problem in practice.

## Reference files

- The **poteto-mode** skill: example of the output shape.
- The **unslop** skill: prose discipline for every line.
- The packaged OMP skill-authoring guidance (`skills/poteto-mode/references/omp-create-skill.md`): skill authoring process and writing guidelines.
