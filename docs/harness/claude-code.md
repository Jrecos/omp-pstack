# Upstream Claude Code provenance

Canonical P Stack 0.15.28 adds a generated Claude Code distribution under `harness/pstack/claude-code/`, an overview at `harness/pstack/README.md`, a generator at `scripts/generate-pstack-harness-trees.mjs`, and a root `.claude-plugin/marketplace.json` registration.

`upstream.json` records those source blobs and modes as intentional absences under `upstream-only/`. The content checker rejects a present target in that namespace. The upstream checker compares each recorded source with the pinned commit and requires complete coverage of the selected source trees.

OMP loads one package identity through `package.json` and `.omp-plugin/`. It discovers this package's `skills/` and `agents/`. Installing the generated tree would duplicate skills and agents and enable another host's plugin metadata. This package does not install that tree, its generator, or the Claude Code marketplace.

The canonical adapter maps Cursor tools to Claude Code tools, permits model fallback, writes `~/.claude/rules/`, and uses Claude Code session paths. Those rules do not apply to OMP. OMP uses native `task`, `pstack_agent`, the user-approved role map, active-profile configuration, and workspace-scoped history. It does not silently replace an unavailable configured model.

This file records the upstream assessment. It does not advertise a second supported runtime or instruct an OMP agent to load the canonical Claude Code adapter.
