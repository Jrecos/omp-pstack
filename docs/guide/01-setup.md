# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

From a terminal, add this repository as an OMP marketplace and install the plugin:

```bash
omp plugin marketplace add https://github.com/Jrecos/omp-pstack
omp plugin install omp-pstack@omp-pstack
```

OMP confirms the plugin is installed.

## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to and asks you to approve a pool. It asks for a reasoning budget and recommends a model for each role from that pool. You confirm or adjust the map. The `pstack_models` tool writes `rules/pstack-models.md` in your OMP profile. Every pstack skill reads that rule.

There are no built-in model defaults. A role with no line in the rule is unconfigured. It cannot dispatch until `/setup-pstack` assigns it a model from the pool. Every selector must belong to the pool. pstack fails closed rather than substituting a model you did not approve. Unused pool members stay saved for later routing.

The budgets target reasoning effort. `unlimited` targets `max`, `large` targets `xhigh`, `medium` targets `high`, and `small` targets `medium`. Each concrete role selector gets an effort suffix capped to the model's authenticated supported efforts. Non-reasoning models have no suffix. Aliases stay unchanged and keep the parent chat's reasoning. Rerunning setup infers the current budget from saved suffixes and keeps your approved pool and role identities unless you change them. Removing a role line makes it unconfigured, not defaulted.

Set a role to `inherit-parent` or `auto` to use your parent chat model. The alias must appear in the approved pool. `pstack_agent` resolves the prepared worker for the configured role. Ordinary delegates use `kind: "poteto"`. Native `task` receives only the returned `agent`, not a `model` field. Both aliases mean the same thing, and neither is a model slug. A panel list sets the number of candidates or reviewers. Arena selects one judge from `arena cross-judge pool`, preferring a different model family when possible. Setup also configures `swarm workers`, the model every `/swarm` worker uses unless a race names a model for each arm.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `<skill-root>/verify-<app>/` in an existing `.agents/skills/` or `.omp/skills/` root, asking which to create if neither exists. The project-local skill teaches agents to drive your app the way a user does and is proved once before handoff. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers when it earns its place.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that cannot check hands every result back to you for a manual check. The verification skill saves that work.

After setup, start a new chat. The model rule applies to new sessions.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. Invoking `/poteto-mode` turns on persistent mode for this OMP session branch. The plugin keeps its rules in context on later turns until you opt out. Say "stop poteto mode" or "normal mode" to turn it off.

## Opt into official Spec Kit for a Feature

If you want official GitHub Spec Kit artifacts, install the pinned stable `specify-cli` version `1.0.12`. Create a separate Git worktree for one feature and initialize it from that worktree's root:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.12
specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force
specify integration status --json
```

Check that status is `ok` with an empty `findings` array. Ask `/poteto-mode Build <feature> with official Spec Kit`. The Feature playbook keeps its eight steps. It chooses a new direct child of `specs/`, passes it to `pstack_speckit` as `featureDirectory` before the first writing phase, and checks official CLI-generated assets against plugin-owned hashes. Review the same bound directory after `specify`. Do not share a worktree or its `.specify/feature.json` between features. A failing check stops this opt-in run. Ordinary Feature requests do not enter the lane. See the [Spec Kit security limits and regeneration check](../../README.md#optional-official-spec-kit-feature-lane).

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
