---
name: omp-deslop
description: Packaged OMP adaptation of cursor-team-kit's deslop skill. Remove AI-generated code slop and clean up code style.
---

# Remove AI code slop

> Adapted from `cursor-team-kit/skills/deslop/SKILL.md` at `cursor/plugins` commit `1b6d44ff26d4e242f4e8f68c391e6d2f7ca16def` (source SHA-1 `1b3827c7f991182149a7abda696af43ff8f17a12`). The checklist and guardrails are preserved verbatim; this is the packaged reference OMP runs before commit in place of the Cursor plugin skill.

Check the diff against main and remove AI-generated slop introduced in the branch.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Keep the final summary concise (1-3 sentences).
