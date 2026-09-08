---
name: setup-pstack
description: Configure which models pstack uses per role. Detects your available models, takes an approved pool first, then recommends the 18-role map and writes an always-applied rule. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Save the approved pool plus the role-to-model mapping with the `pstack_models` tool (`action: "save"`). It writes the plugin-managed rule `rules/pstack-models.md` in the active OMP profile directory (resolved with the SDK's `getAgentDir()`), as an always-applied rule. The skills read that rule for every dispatch. There are no built-in defaults: a role left unconfigured, or a model outside the approved pool, requires setup rather than a silent substitution.

## Steps

### 1. Detect available models

Enumerate the models authenticated in this session with `pstack_models` (`action: "list"`); it returns the current pool (if a rule exists) plus each detected model's `selector`, `name`, `family`, `reasoning`, and `thinking.efforts`. `ctx.models.list()` is the same registry `pstack_models` validates against, so it is the dependable source. Prefer the authenticated list for what can actually dispatch; a model the user is entitled to but not yet authenticated cannot carry a role. If you cannot detect any, ask the user to name the models they have access to. Never write a real selector you have not confirmed is available.

### 2. Select the approved pool (before any role map)

Ask the user to choose the pool: the set of models pstack may dispatch. Present each detected model with its metadata (name, family, reasoning, efforts) so the choice is informed. Shape the pool from the user's real access and stated preferences (cost, speed, reasoning depth, per-family diversity); do not invent a brand set. `inherit-parent` and `auto` belong in the pool only if the user explicitly permits them, because an alias a role uses must itself be a pool member. Persist models the user approves even if no role will use them right now, so they can be routed to later without a re-run. A model outside the pool can never be assigned; dispatch fails closed rather than substituting another family.

### 3. Recommend the 18-role map from the pool

Using only pool members, propose a value for each of the 18 roles (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `how critics`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`). For each role, state a short honest rationale drawn from recognisable capability (reasoning depth and efforts, family strengths, speed) and the user's stated preferences — never a fixed brand list. Use the `poteto` kind for code-writing roles, `general` for judgment roles, and `readonly` for review panels. A role left with no value is unconfigured and will not dispatch until setup assigns one. Do not silently fill an unconfigured role.

### 4. Confirm panel count and diversity

For panel roles (`how critics`, `arena runners`, `architect runners`, `interrogate reviewers`, `arena cross-judge pool`) the value is a list; one subagent runs per entry, so the list length sets the fan-out count, and the mix of entries sets the diversity. Show the proposed count and the family/model spread, then ask explicitly whether the count and diversity are right before proceeding. Ordered duplicate entries are allowed but count as separate members; never deduplicate or silently shrink the list.

### 5. Validate

Every role selector must be a member of `pool`, compared by base identity (the thinking suffix is ignored — `provider/id:effort` matches the pool entry `provider/id`). `inherit-parent` and `auto` pass only if the token is itself in `pool`. `pstack_models` validates before saving and refuses the write if any role is empty, a selector is not in the pool, or an alias is not permitted. Nothing half-valid lands; a role with no line is unconfigured, not defaulted.

### 6. Write the rule

Save with `pstack_models` (`action: "save"`, `pool`, and `roles` mapping each role label to its selector or comma-separated list). `pool` is required for a new save. The tool atomically replaces the full managed body of `rules/pstack-models.md` so re-runs stay idempotent; comments outside the managed body survive. If the existing file is malformed, the tool errors rather than silently resetting it — fix the file by hand, then save. Shape (values are placeholders for the pool the user approved):

```
---
description: pstack per-role model choices (approved pool plus per-role mapping)
alwaysApply: true
---
# pstack model configuration. `pool` lists the approved models pstack may dispatch. One line per role.
# A role selector must be a member of `pool` (compared by base identity; the thinking suffix is ignored).
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (dispatch without a model override). An alias must itself be in `pool`.
# Delete a role line to mark it unconfigured: it will not dispatch until /setup-pstack is rerun; no default is substituted.
pool: <provider/id>, <provider/id>
feature, refactoring: <provider/id>:<effort>
bug-fix: <provider/id>
perf-issue: <provider/id>
hillclimb: <provider/id>
judgment and prose: <provider/id>
hardest tasks: <provider/id>
how explorer: <provider/id>
how explainer: <provider/id>
how critics: <provider/id>, <provider/id>
why investigators: <provider/id>
why synthesizer: <provider/id>
reflect tooling: <provider/id>
reflect judgment, divergent, synthesizer: <provider/id>
arena runners: <provider/id>, <provider/id>
arena cross-judge pool: <provider/id>, <provider/id>
swarm workers: <provider/id>
architect runners: <provider/id>, <provider/id>
interrogate reviewers: <provider/id>, <provider/id>
```

### 7. Confirm

Tell the user the rule was written and that it applies to new dispatches. Re-running this skill updates it. A role left unconfigured, or a model outside the pool, fails closed at dispatch — rerun setup to fix it.

### 8. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed — project, profile, or plugin). On no, move on without pushing.
