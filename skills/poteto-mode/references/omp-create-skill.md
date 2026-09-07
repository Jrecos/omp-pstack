---
name: omp-create-skill
description: Native OMP skill-authoring guide. Write, validate, and test a SKILL.md that OMP discovers and triggers reliably. Use when creating or reviewing any skill, including agent-facing skills this package loads.
---

# Authoring a native OMP skill

There is no upstream source for this guide. It packages the native skill-authoring requirements OMP enforces, in place of Cursor's built-in create-skill skill.

## Shape

1. One directory per skill, one level deep: `skills/<skill-name>/SKILL.md`, with any references, scripts, or assets inside that same directory. Nested skill directories are not discovered.
2. Frontmatter requires exactly what discovery requires:
   - `name`: lowercase-hyphenated, matching the directory name. OMP addresses skills as `skill:<name>`; a display-name heading inside the body can stay friendlier.
   - `description`: the trigger surface. State what the skill does and the concrete requests that should load it. This text is what the model matches against; a vague description means the skill never fires.
   - `disable-model-invocation: true` when only a slash command or an explicit reference should load it. Keep behavior explicit either way.
3. Assets and references are relative paths inside the skill directory (`../references/x.md`, `scripts/run.sh`). Never absolute paths, never `~`, never another package's tree.
4. The body is instructions for an agent, not prose for a human. Every sentence either changes what the agent does or goes.

## Triggers

- Write the description from real request phrasing: the words a user types, not the vocabulary of the implementation.
- Name the disambiguation when a host built-in or sibling skill matches the same words, so the router picks deliberately.
- One skill, one trigger cluster. Two unrelated jobs get two skills.

## Validation

Before declaring the skill done:

1. Frontmatter has `name` and `description`, and the name matches the directory.
2. Every referenced file exists at the stated relative path; every cross-skill link resolves to a real skill.
3. Scripts it names are executable and their arguments match the text.
4. **Real invocation check.** Load the skill in an actual OMP session (a temporary profile with this package installed is enough) and confirm both that discovery lists it and that invoking it produces the intended behavior on a concrete task. A skill that only looks right in the editor is not done.
5. If the skill ships executable steps, run them once on a throwaway fixture and keep the output as the evidence.

## Review bar

When in doubt, delete; prose earns its keep by changing a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config); hardcoded details go stale. Delegate to other skills by path; don't restate.
