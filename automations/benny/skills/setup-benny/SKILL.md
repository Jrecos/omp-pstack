---
name: setup-benny
description: Configure Benny and prepare its triage and repro automations. Use when installing Benny or changing its Slack, tracker, repository, routing, control, model, or budget settings.
disable-model-invocation: true
---

# Set up Benny

Benny ships as a dormant automation pack inside omp-pstack. The plugin manifest exposes only omp-pstack's normal skill root; this file and the two operational files are not slash skills. The native runner reads them directly.
`pstack` commands below run through the installed-root launcher `bun "$PSTACK_ROOT/src/cli.ts" ...`: resolve `PSTACK_ROOT` once with the install resolver in the omp-pstack README (`running the pstack CLI after install`; inside the package checkout, `PSTACK_ROOT="$(pwd)"`). A marketplace install does not put `pstack` on PATH.

Benny runs through the deterministic native runner: `bun "$PSTACK_ROOT/src/cli.ts" benny setup|check|run|canary|enable|disable`. The runner holds all Slack, tracker, GitHub, and model credentials; coordinator sessions receive only bound actions and a disposable container workspace.

Never put a secret value in pack files, prompts, or committed configuration. Enablement lives in workspace-namespaced private OMP profile state; repository-local state is never authority and the default is disabled.
Configuration keys shaped like credential carriers inside `runtime.control_config` or `runtime.environment` are rejected outright, as are raw secret values anywhere in the config; the typed `*_token_env` fields are the only credential references.

## 1. Install the pack and enable shared omp-pstack skills

Ask which repository will run the automations. The source pack is the `automations/benny/` directory of the installed omp-pstack package. The destination is `<target-repository>/.omp/automations/benny/`.

Run `bun "$PSTACK_ROOT/src/cli.ts" benny setup --target <repo>` from the omp-pstack checkout. Setup performs a conservative merge into the destination:

1. Creates the destination when it is absent.
2. Copies every source file to the same relative path; identical files are no-ops.
3. Preserves destination-only files. Never deletes unrelated files during install or refresh.
4. Leaves user-owned configuration, feature maps, and routing maps outside the destination untouched.
5. Reports differing source-managed files as conflicts for diff/merge review. Never blind-overwrites a local edit; if ownership is ambiguous, stop and ask before replacing it.
6. Adds the anchored `.omp/pstack/state/` rule to the repository's private `.git/info/exclude` through the authoritative git path — `git rev-parse --git-path info/exclude`, so linked worktrees resolve to their own exclude file — and proves the rule with `git check-ignore`. Setup fails instead of writing through an unsafe Git metadata path, and repository-local state is never the enablement authority.
7. Verifies that the destination contains `FOR_AGENTS.md`, this setup file, both operational files, their references, and the templates.

Setup also installs omp-pstack at project scope in the target so shared skills resolve in fresh target sessions. It runs `omp plugin marketplace add <this package>` and `omp plugin install --scope project omp-pstack@omp-pstack`, then verifies that the durable declarations `.omp/plugins/installed_plugins.json` and `.omp/plugins/omp-plugins.lock.json` contain the omp-pstack entry. If the target is not a git repository or the install fails, setup reports it; fix the cause and rerun. Preserve every unrelated project configuration file.

Verify from a fresh agent rooted in the target repository that these shared omp-pstack skills resolve at project scope:

- `how`
- `why`
- `tdd`
- `unslop`
- `principle-separate-before-serializing-shared-state`
- `principle-minimize-reader-load`
- `principle-guard-the-context-window`
- `principle-sequence-verifiable-units`
- `principle-fix-root-causes`
- `principle-prove-it-works`

Do not count a skill loaded from the current session or a user-scoped install. The check must show that a fresh agent in the target repository receives omp-pstack through the committed project-scoped installation.

If the project-scoped install is unavailable or any shared dependency does not resolve, stop and explain the failure.

The Benny files are read directly from `.omp/automations/benny/`. Do not add that directory to a plugin manifest or expect its `SKILL.md` files to appear in the slash-skill list.

Tell the user that `.omp/plugins/installed_plugins.json`, `.omp/plugins/omp-plugins.lock.json`, `.omp/automations/benny/`, the committed configuration, and any referenced secret-free configuration must be committed before either automation is enabled. `bun "$PSTACK_ROOT/src/cli.ts" benny check` enforces this. Do not commit anything unless the user asks.

Once this check passes, live automation runs receive the committed operational files directly by their stable repository-relative paths. They never embed a plugin cache path or a copied file body.

## 2. Adapt the configuration

Open these copied examples:

- `../../templates/configuration.example.yaml`
- `../reproduce-and-fix-issues/references/feature-map.example.md`

Create user-owned copies outside `.omp/automations/benny/`. The default locations match the example config paths:

- Project config: `.omp/benny/configuration.yaml`
- Project feature map: `.omp/benny/feature-map.md`
- Project routing map: `.omp/benny/routing.md`
- The operational configuration must be a regular non-symlink file committed inside the target repository. It may live outside the copied pack — `.omp/benny/` is the default location — but never outside the repository and never uncommitted: the runner refuses a symlinked, uncommitted, or out-of-repo configuration before any run, canary, or admission.

Fill one feature-map section for every user-facing feature the automation may reproduce. Keep it at the user point of view. Do not freeze implementation details or current code paths in the map.

Do not edit the copied examples. Pack refreshes may update source-managed files after conflict review, but they must never touch the user-owned copies.

- Configuration and every referenced map must be committed inside the target repository; uncommitted files can never pass `bun "$PSTACK_ROOT/src/cli.ts" benny check`. Reference a repository file only after that check confirms the committed-declarations gate passes for it.

Use stable repository-relative paths for committed pack and configuration files. Never reference the plugin source directory or a plugin cache path from a live run.

## 3. Fill the required choices

Ask for or confirm:

- Source Slack channel ID
- Optional operations or status channel ID
- Repository URL and default branch
- Triage identity or Slack user ID
- Issue tracker: team, project, labels, and intake status (bundled `linear` adapter)
- Routing map path (required): a committed same-repo path whose map may be empty for no owner routing
- Workspace boundary: `runtime.workspace_image`, trusted controller `runtime.control_command`, worker app bootstrap `runtime.control_config.worker_command`, and internal `runtime.control_config.app_url`
- Required user-facing feature-map path
- Status emoji strings
- Pull request URL format
- Polling and effort budgets
- Trigger transport: `runtime.trigger: "external"` or `"socket-mode"`, plus the Slack token environment-variable names
- Concrete OMP model selectors for triage, repro, code work, and media review

Use only concrete OMP model selectors that resolve in the runner's authenticated model registry. Validate the choices with `bun "$PSTACK_ROOT/src/cli.ts" benny check`; a selector the runner cannot resolve fails validation and blocks enabling. Do not guess a selector and do not carry over a private default.

The source channel, triage identity, repository, tracker (the bundled bounded Linear adapter), control adapter, and feature map must be explicit. Fail setup if any required value stays ambiguous.

Use omp-pstack's `unslop` skill on the final automation names, descriptions, and prompt text before committing them.

## 4. Check integration capabilities

The triage run needs:

- Read access to the configured source Slack channel and its threads, through the bundled Slack Web API transport with the token named by `runtime.slack_read_token_env`
- Thread-reply access in that channel, through the token named by `runtime.slack_write_token_env`
- Attachment metadata and file download access when reports include media
- Search, read, create, update, and compensation access through the bundled Linear tracker

The repro run needs:

- Read access to the source thread
- Thread-reply access in the source channel
- Optional post and edit access in the configured operations channel
- Repository read and history access
- A draft pull request action (the runner's `gh`-backed GitHub action, which always reads back `isDraft`, head, and base)
- The configured control adapter command inside the trusted workspace image

- Optional narrow gaps such as editing one operations status message or downloading an attachment may use the bot token named by `slack.optional_bot_token_env`. Store the value in the runner's environment, not in YAML. Only the bundled Slack Web API, Linear, and `gh`-backed GitHub transports execute: OMP supplies no narrow host broker for configured actions, so named MCP action mappings and `slack.prefer_configured_actions: true` are rejected outright at parse time and before admission. Do not configure them.

Do not use undocumented integration endpoints.

## 5. Prepare the routing map

`routing.map_path` is required and must point at a regular committed file inside the repository (the config schema rejects an empty path). Its CONTENT may be an empty map:

1. Copy `../triage-issue-reports/references/routing.example.md` outside `.omp/automations/benny/`, for example to `.omp/benny/routing.md`.
2. Point `routing.map_path` at the copy.
3. If the user wants no reroutes or owner pings, ship the map EMPTY (no routes, empty fallback) and keep it committed; an empty map is the documented way to run with no owner routing.
4. Otherwise replace every placeholder with public or organization-local values.
5. Keep owner pings off by default.
6. Allow a ping only for a configured feature owner or a confirmed likely regression author.

A missing or uncommitted map path fails preflight and blocks enabling; triage never guesses a destination or owner.

## 6. Verify the control adapter

Read `../reproduce-and-fix-issues/references/control-adapter.md` and the user's completed feature map.

The control adapter is the trusted command configured at `runtime.control_command`, executed in the controller side of the split disposable workspace built from `runtime.workspace_image`. The repository and `runtime.control_config.worker_command` exist only in the untrusted worker side; the controller never mounts the worktree. Neither container receives host credentials. Confirm that the adapter can:

- Bring up the target app
- Navigate every mapped feature through the real UI
- Exercise mapped states through declared adapter actions
- Inspect state without forcing the result
- Capture screenshots
- Start and stop a recording
- Clean up its processes and temporary data

`bun "$PSTACK_ROOT/src/cli.ts" benny check` verifies that the workspace image is inspectable and that the control command is executable inside it. If any capability is missing, leave the repro automation disabled. It must fail closed rather than claim a reproduction it did not perform.

## 7. Prepare the live automations

Read `../../FOR_AGENTS.md` from the copied pack as the primary user-intent source. Use it to understand the two triggers, tools, instructions, outcomes, and shared rules. There is no interactive automation editor to drive; deployment flows through the CLI gates:

### Deployment path

1. Finish configuration, routing-map, control-adapter, and feature-map validation per sections 2–6.
2. Commit the `.omp` declarations: `.omp/plugins/installed_plugins.json`, `.omp/plugins/omp-plugins.lock.json`, `.omp/automations/benny/`, `.omp/benny/configuration.yaml`, and every referenced feature or routing map committed under `.omp/`.
3. Run `bun "$PSTACK_ROOT/src/cli.ts" benny check --config <path>`. Every check must pass except the expected not-yet-run `canary` row — committed declarations, environment tokens, the tracker, the workspace image and control command, the feature map, and allowed endpoints.
4. Run `bun "$PSTACK_ROOT/src/cli.ts" benny canary --config <path> --event <harmless-test-report.json>`. A canary is one explicitly authorized report in the configured test targets; it uses the real transport and action paths while background admission stays disabled, and records observed checks, source coordinates, the behavior-configuration hash, and the repository revision in private runtime state.
5. Rerun `bun "$PSTACK_ROOT/src/cli.ts" benny check --config <path>`. Every check, including `canary`, must now pass. Then run `bun "$PSTACK_ROOT/src/cli.ts" benny enable --config <path>`. Enable re-runs full preflight and requires a passing canary recorded for the exact current configuration hash and repository revision. Any later config or revision change requires a fresh canary before re-enabling.

Never claim a deployment is ready while any check fails or the canary has not passed for the current hash and revision.

### Trigger transports

Deliver reports through exactly one of the two supported transports:

- External CLI: a trusted local caller supplies a Slack Events API envelope (`event_id`, `team_id`, `event`) to `bun "$PSTACK_ROOT/src/cli.ts" benny run --config <path> --event <json-file|->`. Admission deduplicates on `(team_id, event_id, phase)` and on `(team_id, source_channel, root_ts, phase)`.
- Slack Socket Mode: set `runtime.trigger: "socket-mode"` and export the app-level token named by `runtime.slack_app_token_env`. The native runner connects through `apps.connections.open`, persists accepted events before acknowledgment, and handles reconnects. Both transports call the same run implementation.

Do not invent a third trigger path, an HTTP webhook for Slack, or a scheduled poller.

### Thread-safety gate

Do not enable live traffic until the thread-safety test in section 8 passes on the canary and a harmless test report.

## 8. Test thread safety

Use a test channel or a harmless test report.

Before testing, confirm the committed-declarations gate passes and both transports resolve their operational files from `.omp/automations/benny/`. If any check fails, stop. Tell the user that the automation cannot be enabled yet.

Verify:

1. Triage stores the root `thread_ts` and posts exactly one verdict as a reply.
2. The verdict contains one configured marker.
3. Repro accepts the marker only from the configured triage identity.
4. Repro keeps the same immutable source coordinates.
5. No source-channel root message appears.
6. A delegated worker cannot use any Slack write action.
7. Missing coordinates, a deleted parent, or a failed preflight produces no post and no tracker issue.

Enable normal traffic only after all seven checks pass and `bun "$PSTACK_ROOT/src/cli.ts" benny enable --config <path>` succeeds.

## 9. Keep evidence retention running on a quiet host

Published evidence (screenshots, recordings) expires after `control.artifact_retention_hours`. The native runner sweeps expired evidence at startup and while runs settle, but a host with no further events needs an external pass: schedule the one-shot sweep from cron or a systemd timer (hourly is plenty):

```bash
bun "$PSTACK_ROOT/src/cli.ts" benny sweep --config <path>
```

`PSTACK_ROOT` resolves once per host with the omp-pstack README install resolver (`running the pstack CLI after install`; inside the package checkout, `PSTACK_ROOT="$(pwd)"`). The sweep removes only expired evidence no queued or running run owns, and it deletes nothing when run ownership cannot be established.
