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

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, asks you to pick an approved pool first, then recommends a model for each role (code delegates, judgment, the review panels) from that pool, with a short rationale. You confirm or adjust, and it writes the `pstack-models` rule into your OMP profile's `rules/` directory, a small always-applied rule every pstack skill reads.

There are no built-in defaults a role can fall back to. A role with no line in the rule is unconfigured and won't dispatch until `/setup-pstack` assigns it a model from the pool. Every selector must be a member of the pool; pstack fails closed rather than substituting a model you didn't approve. Unused pool members stay saved so you can route to them later.

You might be wondering what happens if you use Auto. Set a role to `inherit-parent` or `auto` (both must appear in the approved pool) and pstack omits the subagent `model` field, so the subagent inherits your parent chat model. Both values mean the same thing, and neither is a model slug. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also sets `swarm workers`, the model every `/swarm` worker uses unless a race names a model for each arm.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `<skill-root>/verify-<app>/` in an existing `.agents/skills/` or `.omp/skills/` root, asking which to create if neither exists. The project-local skill teaches agents to drive your app the way a user does and is proved once before handoff. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers when it earns its place.

After setup, start a new chat. The model rule applies to new sessions.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. `/poteto-mode` is sticky. It stays on for the conversation until you opt out by saying so.

## Opt into official Spec Kit for a Feature

If you want official GitHub Spec Kit artifacts, install the pinned stable `specify-cli` version `1.0.12`. Create a separate Git worktree for one feature and initialize it from that worktree's root:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.12
specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force
specify integration status --json
```

Check that status is `ok` with an empty `findings` array. Ask `/poteto-mode Build <feature> with official Spec Kit`. The Feature playbook keeps its eight steps. It chooses a new direct child of `specs/`, passes it to `pstack_speckit` as `featureDirectory` before the first writing phase, and checks official CLI-generated assets against plugin-owned hashes. Review the same bound directory after `specify`. Do not share a worktree or its `.specify/feature.json` between features. A failing check stops this opt-in run. Ordinary Feature requests do not enter the lane. See the [Spec Kit security limits and regeneration check](../../README.md#optional-official-spec-kit-feature-lane).

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
