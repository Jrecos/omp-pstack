# Native capabilities and evidence

OMP 18.10.2 supplies checkout isolation, job controls, diagnostic exports, and session transfer without P Stack wrappers. P Stack adopts these where an existing workflow needs them. The receiving chat still owns the playbook, approved model pool, dispatch, review, and integration.

Main-session worktrees, isolated task workers, transcript forks, and Docker solve different problems. A main worktree separates the active checkout from its source. Each isolated worker separates its own edits from sibling edits. A transcript fork shares cwd. Benny's Docker boundary constrains processes and network access. None replaces the others.

## What the measurements mean

The [native capability proof](../../proofs/native-capabilities.json) records actual host and SDK 18.10.2 versions, producer inputs, commands, checks, and limitations. The [producer](../../scripts/smoke-native-capabilities.ts) uses generated fixtures rather than real user histories. Its command is `bun scripts/smoke-native-capabilities.ts` from the plugin checkout.

The content gate recomputes listed input hashes and checks the exact SDK pin. It does not authenticate execution or cover the complete transitive input tree. The aggregate digest, SDK package metadata, and host binary details are captured observations, not separately authenticated fields.

If the installed host has moved to another release, select the frozen native CLI explicitly with `PSTACK_NATIVE_PROOF_OMP="$PWD/node_modules/.bin/omp" bun scripts/smoke-native-capabilities.ts`. The producer resolves the executable and requires its exact version to match the SDK pin. It does not accept a major/minor-only match.

The headless producer exercises native CLI and SDK operations without model dispatch. It records four session-bound task schema gates, six gitGuard on/off pairs and safe unstaging, one owned job cancellation with the process gone, and two valid annotation anchors plus two mismatch rejections. Anonymization exports two transcripts with zero occurrences of three seeded canaries and refuses three unsafe output destinations. Transfer covers the original session, arrival, divergent unpack, and a moved marker while preserving an artifact.

These are individual fixtures, not statistical guarantees. One cancellation duration is not a latency improvement. Zero seeded leaks is not general anonymization accuracy. A schema gate is not worker execution. The filesystem rejected FICLONE, so the worktree fixture used a plain-checkout fallback and did not retain the ignored artifact in the child. It proves tracked-edit independence, not cloning speed or dependency availability.

The producer blocks and counts two SDK constructor preconnect hints separately from HTTP requests. It records zero model dispatches, zero credential requests, and zero HTTP fetches. Its aggregate checks pass. This fetch guard is not an OS-level network sandbox.

A separate 18.10.2 model smoke passes ten actual tasks. Eight produce exact literal results across Sol and Astra. Two Sol workers produce exact marker bytes in isolated checkouts. Apply-off leaves the entire parent checkout unchanged, and its retained patch applies successfully in a distinct verification worktree. Apply-on produces the exact bytes in the parent without parent write-tool authority. These are ten scoped cases, not an accuracy score. `bun scripts/smoke-models.ts` produces the authenticated report.

The [source port measurement](../../proofs/upstream-port.json) uses `o200k_base`.

| Scope | Before | After | Reduction |
|---|---:|---:|---:|
| Complete original Markdown inventory, 0.15.15 to 0.15.20 | 97,813 tokens | 92,179 tokens | 5.76% |
| Actual Poteto mode body injected by this plugin | 5,137 tokens | 4,856 tokens | 5.47% |

The inventory is not loaded into each session. The second row measures this plugin's injected body without frontmatter. Neither measurement establishes model accuracy.

## Decisions on the ten proposals

### 1. Main-session worktrees

Adopt explicit native worktree creation for writable coding. Reuse an appropriate already-isolated checkout when its base and ownership fit the task. Otherwise use `omp worktree add -b <branch> <path> <base>`. Check the resolved base, branch, and actual session cwd before editing. Check dependencies and environment files after clone fallback. Recheck private enablement in the new checkout.

The explicit CLI fixture creates one branch and keeps the source HEAD and tracked file unchanged after a child edit. Ignored-artifact cloning was unavailable on the measured filesystem. Automatic interactive startup remains source-assessed, not exercised.

Optional local startup uses `worktree.onStart=ask`, `worktree.onExit=keep`, and `worktree.cleanSource=false`. Startup begins at HEAD without source WIP. It applies to eligible fresh interactive launches, not resumed sessions or already-linked worktrees. A creation failure warns and continues in the original checkout. Do not assume startup isolated the session or change global settings.

Reject automatic native exit cleanup as a replacement for the audit. It can delete ignored files and cannot guarantee ownership survives a restart. The manual pinned-chat and WIP audit stays authoritative.

The guidance belongs in [Poteto mode](./02-poteto-mode.md#give-parallel-work-its-own-machine), [Opening a PR](../../skills/poteto-mode/playbooks/opening-a-pr.md), [Feature](../../skills/poteto-mode/playbooks/feature.md), and [Worktree cleanup](../../skills/poteto-mode/playbooks/worktree-cleanup.md).

### 2. Isolated task workers

Adopt conditional native per-worker isolation for coding. Add `isolated: true` to each task item only when the native schema advertises it. The field requires `task.isolation.enabled=true` and plan mode off. Four actual session-bound schemas cover the enabled and disabled settings in normal and plan modes. Only enabled normal mode advertises the field.

When one owner integrates changes, use controlled `task.isolation.apply=false` and review retained patch or branch artifacts. Automatic apply defaults to true. Otherwise prepare distinct checkout or worktree paths before dispatch. Never send an unsupported field or treat a parent's worktree as sibling isolation. Both actual worker fixtures produce exact bytes. Apply-off preserves the parent and retains an independently applicable patch. Apply-on integrates the assigned marker only.

The guidance belongs in [Feature](../../skills/poteto-mode/playbooks/feature.md), [Swarm](../../skills/swarm/SKILL.md), [Arena](../../skills/arena/SKILL.md), and [Orchestrate](../../skills/poteto-mode/playbooks/orchestrate.md). Approved pools, prepared-agent dispatch, private enablement, and Docker remain unchanged.

### 3. Plain task results

Adopt the native default final-text result. Do not require `yield`, `outputSchema`, or `schemaMode` for ordinary task completion. Keep required `solutionSpace`, shared `context`, and prepared-agent dispatch. The four schema gates contain no structured-result fields or per-call model override. The separate root smoke observed eight exact literal results, not an accuracy score.

Reject treating this as an Eval contract change. Eval `agent()` and `workpool` retain structured results. The guidance belongs in [Feature](../../skills/poteto-mode/playbooks/feature.md), [Swarm](../../skills/swarm/SKILL.md), and [Arena](../../skills/arena/SKILL.md). The authenticated producer owns result receipts.

### 4. Forks and terminal launch

Adopt transcript forks as conversation branches, not checkout isolation. One headless `SessionManager.fork` fixture creates a distinct identity and file, retains cwd and parent identity, and leaves the original bytes unchanged.

Defer live terminal success. `/fork pane`, `/fork window`, and optional `ctx.ui.openTerminal` require host terminal support. The fork retains the parent's cwd. No multiplexer launch or live terminal interaction is measured here.

Conditional guidance belongs in [Control CLI](../../skills/poteto-mode/references/omp-control-cli.md). Reject using a fork to separate code-writing workers.

### 5. Job metadata and cancellation

Adopt native job inspection and cancellation rather than a P Stack job registry. SDK callers use `getAsyncJobSnapshot()`, `inspectAsyncJob(id)`, and `cancelAsyncJob(id)`. Use the owning session's job controls and await native completion delivery rather than poll.

One bounded bash fixture exposes command, cwd, and PID metadata. Cancellation settles, the process is gone, and the delayed completion marker is absent. An independent SDK root cannot inspect or cancel that job. This does not prove every shared-manager subagent ownership case or rendered job-card interaction.

The guidance belongs in [Control CLI](../../skills/poteto-mode/references/omp-control-cli.md), [Pause safely](../../skills/poteto-mode/playbooks/pause-safely.md), and [Orchestrate](../../skills/poteto-mode/playbooks/orchestrate.md). Preserve the decision ledger when recording cancellation or failure.

### 6. Browser target adoption

Adopt only conditional host guidance. Native `action: "targets"` is available through Tern or relay, not ordinary local or headless browser mode. Select a page with explicit `app.target` URL or title criteria and confirm an app marker. Never close user-owned tabs.

Defer runtime success until a connected Tern or relay host is available. The current proof has no successful target enumeration or selection fixture. Reject a generic target-ID wrapper and any claim that headless Chromium proves this behavior.

The guidance belongs in [Control UI](../../skills/poteto-mode/references/omp-control-ui.md).

### 7. Diagnostic anonymization

Adopt optional `omp anonymize <session.jsonl> --out <new-or-empty-directory>` for diagnostics. Preserve the original histories and ledger. Review the export manually before sharing. Anonymization is not permission to publish private data or widen the session-review corpus.

The fixture exports a parent and child transcript with retained event metadata. Three seeded canaries have zero occurrences in the export. Three destinations refuse output, covering raw transcript storage, child transcript storage, and a nonempty directory. Malformed and unreadable child data is reported. Source bytes and members stay unchanged.

The guidance belongs in [Control CLI](../../skills/poteto-mode/references/omp-control-cli.md) and [Orchestrate](../../skills/poteto-mode/playbooks/orchestrate.md). Reject automatic publication and percentage accuracy claims.

### 8. Session transfer

Adopt optional native `omp session pack`, `omp session unpack`, and `omp session moved` for handoff. The fixture checks original entries and bytes, arrival with rewritten cwd, divergent unpack as a fork, and a moved marker on a copy. An artifact retains its hash. Two disjoint private profiles simulate the two environments, not two live machines.

Transfer does not move credentials, repository files, services, or external referenced files. Verify the destination before marking departure. Preserve the resume note and decision trail. Native model-generated `/handoff` summary and compaction are a different capability and remain unexercised here.

The guidance belongs in [Pause safely](../../skills/poteto-mode/playbooks/pause-safely.md) and [Session pickup](../../skills/poteto-mode/playbooks/session-pickup.md). Reject a custom archive wrapper or interpreting a moved marker as proof of destination readiness.

### 9. Annotations

Keep the native API available, but defer plugin integration. `ctx.annotations.submit` accepts explicit text and diff sources headlessly with `deliver: "none"`. Two valid anchors normalize feedback. Two mismatches reject a stale text quote and a stale raw diff line. Transcript entry count does not change.

No current plugin consumer needs another review tool. Do not add a custom annotation UI or integration without that caller. Overlay collection and composer delivery require a live supported TUI and remain unexercised.

The boundary belongs in [Control UI](../../skills/poteto-mode/references/omp-control-ui.md). Annotation notes are review input, not independently validated findings.

### 10. Git guard

Adopt opt-in `bash.gitGuard=true` as extra protection. It is off by default. Keep the existing destructive-command prohibition and Docker boundary. Do not change global settings to enable it.

Six embedded-shell command forms run with guard off and on. Guard-off commands change the tracked sentinel. Guard-on commands refuse and preserve it. The forms cover stash, hard reset, restore, a shell function, command substitution, and a directory change. One safe unstaging operation succeeds without changing the working file.

Reject calling this an external-shell sandbox. External shells, absolute Git paths, and arbitrary processes can bypass the embedded-shell guard. The guidance belongs in [Control CLI](../../skills/poteto-mode/references/omp-control-cli.md).

## What stays unchanged

The receiving chat owns native todo updates and playbook sequencing. Prepared agents come from the configured approved pool. Private enablement remains per checkout. Untrusted tools and context remain empty. The official Spec Kit lane remains explicit, read-only at its command boundary, and fail-closed on a gate error. No native convenience bypasses review or an irreversible-action pause.

## Release boundary

The implemented and measured baseline is SDK and CLI 18.10.2. During verification, the installed host moved to 18.10.3. A mismatched-host producer run correctly failed before its CLI fixtures. The frozen CLI override keeps the evidence reproducible without changing the installed host.

The [18.10.3 release notes](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.10.3/packages/coding-agent/CHANGELOG.md) add named-agent soft request budgets, `o200k` tokenizer overrides, and crash restoration with `omp --restore`. They also change compaction and shared prompt-cache behavior.

Named-agent budgets fit long reviewers and autonomous writers without loosening scout or sonic limits. Crash restoration fits interrupted autonomous runs, but needs a dedicated interruption-and-child-recovery fixture before P Stack instructs automatic recovery. Both remain source-assessed, not adopted or measured here. Tokenizer, compaction, cache-sharing, and tool-output changes belong to the host and need no plugin wrapper. The upstream claim of up to 1.7 times as many archive frames is not a measured P Stack accuracy or speed improvement.

