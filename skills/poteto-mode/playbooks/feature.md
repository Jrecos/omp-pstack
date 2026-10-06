### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

**Optional official Spec Kit lane.** Enter this lane only when the current Feature request explicitly opts into official GitHub Spec Kit. Keep the eight steps below and their configured P Stack roles. Do not register or impersonate `/speckit.*`, run a Spec Kit workflow, or send a nested slash message. The read-only `pstack_speckit` tool returns one rendered official OMP project command at a time. Follow its body in this session. On any gate error, stop the opted-in lane and report the error. Never fall back to ordinary Feature without asking. Other Feature requests and all other playbooks retain their normal route.

1. `how` over the affected subsystem.
   For the opt-in lane, first use a fresh separate Git worktree initialized by the official pinned CLI. Choose a new direct child under `specs/` for this feature. Call `pstack_speckit` phase `specify` with that `featureDirectory` and the complete original feature request as `argument`. Do not embed `SPECIFY_FEATURE_DIRECTORY` in the argument.
   The tool checks assets, hooks, installation status, and the chosen directory before returning writing instructions. Follow its rendered body using only the validated directory; pass that directory as the explicit Spec Kit feature-directory override when writing the spec. Review `spec.md` and `.specify/feature.json` against the original request before proceeding. Use the exact canonical directory returned by the tool for every later phase, with an explicit `argument` string, including `""` when there is no additional input. Run optional phase `clarify` only if real ambiguities remain.
2. `architect` for parallel design exploration. Skipping stays as `architect skipped: <reason>`. Do not fold the design decision silently into implementation.
   For the opt-in lane, pass the Arena's chosen design to `pstack_speckit` phase `plan` after the specification is reviewed. Follow its rendered body to produce `plan.md` and `quickstart.md` in the bound feature directory. Recheck the resulting design against the Arena choice. An architect skip still requires its ordinary explicit reason.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
   For the opt-in lane, use phase `tasks` after this checkpoint. Compare `tasks.md` to the approved spec and plan. Optional phases `checklist` and `analyze` belong to this review, not to outcome verification.
4. Delegate code-writing to a subagent using your configured feature model (set via `/setup-pstack`; if unset or unavailable, run setup first) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). Review its diff yourself. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Delegation is mandatory with no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
   Resolve the worker first with exactly `{ role: "feature, refactoring", kind: "poteto" }`. Then call native `task` separately with the returned `agent`. Never pass the task `context` or `tasks` payload to `pstack_agent`.
   For the opt-in lane, call phase `implement` with the reviewed feature directory. Pass its rendered body, reviewed `tasks.md`, and the agreed design to the configured `feature, refactoring` poteto worker. Resolve that worker through `pstack_agent` as above. Review its diff. Do not launch a separate Spec Kit process or select a raw model from workflow YAML.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
   For the opt-in lane, inspect `quickstart.md` for unsafe commands before running it. Require a zero exit and an independently observed product effect or an existing trusted real-surface scenario. A checked box, generated file, or agent report is not proof. Mark verification inconclusive if the surface cannot be exercised.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
   For the opt-in lane, preserve those same ordered verifiable commit boundaries. Generated Spec Kit artifacts are inputs, not substitutes for passing checks.
7. If the design is contested, `interrogate` before shipping.
   For the opt-in lane, interrogate contested choices in the existing P Stack panel. Optional Spec Kit analyze output does not replace the panel.
8. Run **Opening a PR**.
   For the opt-in lane, use the same PR safeguards. Never auto-merge or deploy.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline. That owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
