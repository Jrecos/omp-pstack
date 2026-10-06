---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects available models, takes an approved pool first, then recommends the 17-role map and writes an always-applied rule. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Save the approved pool plus the role-to-model mapping with the `pstack_models` tool (`action: "save"`). It writes the plugin-managed rule `rules/pstack-models.md` in the active OMP profile directory (resolved with the SDK's `getAgentDir()`), as an always-applied rule. The skills read that rule for every dispatch. There are no built-in defaults: a role left unconfigured, or a model outside the approved pool, requires setup rather than a silent substitution.

## Steps

### 1. Detect available models

Enumerate the models authenticated in this session with `pstack_models` (`action: "list"`). It returns the current pool and roles, plus each detected model's `selector`, `name`, `family`, `reasoning`, and `efforts`. Use that registry to decide what can dispatch. A model the user can access but has not authenticated cannot carry a role. If no model is detected, ask the user to name their available models. Never save a concrete selector without confirming its availability.

### 2. Select the approved pool (before any role map)

Ask the user to choose the pool of models pstack may dispatch. Present each detected model's name, family, reasoning support, and efforts. Use the user's access and preferences for cost, speed, reasoning depth, and diversity. Do not invent a brand set. Include `inherit-parent` or `auto` only with explicit permission. An alias used by a role must itself be in the pool. Keep approved models even if no role uses them yet. A model outside the pool cannot be assigned.

### 3. Choose the budget and recommend the 17-role map

Load the existing choices with `pstack_models` (`action: "show"`) when a rule exists. Preserve every existing role's model identity, ordered panel list, and aliases unless the user asks to change them. Remove retired role lines, such as `how critics`, and report them before saving. If they prevent parsing, correct those lines in `rules/pstack-models.md` before using the managed save.

**Ask for a budget.** Use `ask` to offer these exact labels:

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

On a re-run, infer and name the current effective budget from existing concrete selectors' thinking suffixes. `max`, `xhigh`, `high`, and `medium` correspond to `unlimited`, `large`, `medium`, and `small`. If suffixes differ, name the current budget as mixed and show the efforts. If only lower efforts occur, name the budget as custom. If no suffix records an effort, say the current budget is unknown. Model caps can hide the original target. Do not claim a stored target or a default budget.

**Recommend the map.** Using only pool members, propose a value for each of the 17 roles (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`). Preserve existing choices on a re-run. State a short rationale based on detected capabilities and the user's preferences. Use the `poteto` kind for code-writing roles, `general` for judgment roles, and `readonly` for review panels. A role with no value is unconfigured. Do not silently fill it.

**Apply the budget.** `unlimited`, `large`, `medium`, and `small` target `max`, `xhigh`, `high`, and `medium`. Set the `:<effort>` thinking suffix on every concrete role selector, including every panel entry. Keep the exact provider and model id. Match the full registry identity before separating a thinking suffix. Do not rewrite effort-like tokens inside a model id or switch models to obtain an effort. Use the model's `efforts` from `pstack_models list`. If the target is unsupported, select its highest supported effort at or below the target on the ladder `max` > `xhigh` > `high` > `medium` > `low` > `minimal`. If no supported effort qualifies, mark the role as needing a choice. A model without reasoning support or efforts gets no suffix. Leave `inherit-parent` and `auto` unchanged.

**Confirm the roles.** Show all roles with their budget-adjusted selectors. Mark unavailable models and choices outside the pool as needing a choice. List any retired lines removed. Use `ask` to confirm the map or change specific roles. Offer only available approved models and explicitly approved aliases. Reapply the chosen budget to any changed concrete entries. `swarm workers` supplies each worker's model unless a race assigns an approved model per arm.

### 4. Confirm panel count and diversity

For panel roles (`arena runners`, `architect runners`, `interrogate reviewers`), one subagent runs per ordered entry, including aliases. The list length sets the fan-out count. `arena cross-judge pool` is also an ordered list, but Arena selects one judge, preferring a different family from the parent's. Show each panel's proposed count and model spread. Use `ask` to confirm the count and diversity. Ordered duplicate entries count separately. Never deduplicate or silently shrink a list.

### 5. Validate

Every concrete role selector must resolve in the detected registry and belong to `pool` by base identity. A thinking suffix does not change pool membership. `inherit-parent` and `auto` pass only if the token itself is in `pool`. `pstack_models` refuses invalid choices before saving. A role without a line is unconfigured, not defaulted.

### 6. Write the rule

Save with `pstack_models` (`action: "save"`, `pool`, and `roles` mapping each role label to its selector or ordered list). `pool` is required. The tool atomically replaces the managed body of `rules/pstack-models.md`. Comments outside that body survive. If the file is malformed, fix it before saving. OMP stores the budget in concrete selectors' thinking suffixes, not a separate `# budget` line. The values below illustrate the shape, not defaults:

```
---
description: pstack per-role model choices (approved pool plus per-role mapping)
alwaysApply: true
---
# pstack model configuration. `pool` lists the approved models pstack may dispatch. One line per role.
# A thinking suffix does not change pool membership.
# `inherit-parent` and `auto` use the parent model and require explicit pool permission.
# A missing role line is unconfigured. No default is substituted.
pool: <provider/id>, <provider/id>
feature, refactoring: <provider/id>:<effort>
bug-fix: <provider/id>:<effort>
perf-issue: <provider/id>:<effort>
hillclimb: <provider/id>:<effort>
judgment and prose: <provider/id>:<effort>
hardest tasks: <provider/id>:<effort>
how explorer: <provider/id>:<effort>
how explainer: <provider/id>:<effort>
why investigators: <provider/id>:<effort>
why synthesizer: <provider/id>:<effort>
reflect tooling: <provider/id>:<effort>
reflect judgment, divergent, synthesizer: <provider/id>:<effort>
arena runners: <provider/id>:<effort>, <provider/id>:<effort>
arena cross-judge pool: <provider/id>:<effort>, <provider/id>:<effort>
swarm workers: <provider/id>:<effort>
architect runners: <provider/id>:<effort>, <provider/id>:<effort>
interrogate reviewers: <provider/id>:<effort>, <provider/id>:<effort>
```

### 7. Confirm

Tell the user the rule was written and name the chosen budget and any model-specific effort caps. It applies to new dispatches. Re-running this skill updates it. An unconfigured role or a model outside the pool fails closed. Rerun setup to fix it.

### 8. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof, such as a `verify-*` skill or an existing harness. If not, offer once. "Want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` from the project's, profile's, or plugin's installed skills. On no, move on without pushing.
