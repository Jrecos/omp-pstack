---
name: setup-pstack
description: Configure which models pstack uses per role. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Save the role-to-model mapping with the `pstack_models` tool (`action: "save"`). It writes the plugin-managed rule `rules/pstack-models.md` in the active OMP profile directory (resolved with the SDK's `getAgentDir()`), as an always-applied rule. The skills read it and fall back to their inline defaults when a line is absent, so this is an override layer, not a requirement.

## Steps

### 1. Detect available models

Enumerate the models authenticated in this session (`ctx.models.list()`; the `pstack_models` tool validates against the same registry); that is the dependable source. If the OMP model registry also exposes models the user is entitled to but that are not yet authenticated, prefer the authenticated list for what can actually dispatch. If you cannot detect any, ask the user to name the models they have access to. Never write a real model selector you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected models.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If a `pstack-models` rule already exists, read it (`pstack_models` action `show`) and treat its values as the current choices. Otherwise start from those defaults.

### 3. Map and confirm

Show every role with its current model, marking any real selector not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Prefer a short structured question over free text. For panel roles (how critics, arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm. In a headless or non-interactive run with no way to confirm a choice, cancel and write nothing.

### 4. Validate

Every real selector written must be in the detected set; `inherit-parent` and `auto` always pass. If a chosen real selector is not available, stop and ask again. A rule pointing at a model the user cannot use breaks every delegation that reads it. `pstack_models` validates every concrete choice before saving and refuses the save if one fails, so nothing half-valid ever lands.

### 5. Write the rule

Save with `pstack_models` (`action: "save"`, `roles` mapping each role label to its model or comma-separated list), using the same labels poteto-mode uses. The tool atomically replaces the full managed body of `rules/pstack-models.md` so re-runs stay idempotent; comments outside the managed body survive. If the existing file is malformed, the tool errors rather than silently resetting it — fix the file by hand, then save. Shape:

```
---
description: pstack per-role model choices (overrides skill defaults)
alwaysApply: true
---
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (dispatch without a model override). Alias entries in a panel list still count toward its fan-out.
feature, refactoring: grok-4.6-fast-xhigh
bug-fix: claude-fable-5-1-thinking-max
perf-issue: claude-fable-5-1-thinking-max
hillclimb: claude-fable-5-1-thinking-max
judgment and prose: claude-fable-5-1-thinking-max
hardest tasks: claude-fable-5-1-thinking-max
how explorer: grok-4.6-fast-xhigh
how explainer: claude-fable-5-1-thinking-max
how critics: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
why investigators: grok-4.6-fast-xhigh
why synthesizer: claude-fable-5-1-thinking-max
reflect tooling: gpt-5.6-sol-max
reflect judgment, divergent, synthesizer: claude-fable-5-1-thinking-max
arena runners: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
arena cross-judge pool: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
swarm workers: grok-4.6-fast-xhigh
architect runners: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
interrogate reviewers: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
```

### 6. Confirm

Tell the user the rule was written and that it applies to new dispatches. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed — project, profile, or plugin). On no, move on without pushing.
