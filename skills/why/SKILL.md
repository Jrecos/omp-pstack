---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
disable-model-invocation: true
---

# Why

Answer from the record, not the code. Read the commits and PR discussions that introduced the target and each later change, and other sources if the trail is thin. Cite what the authors wrote, mark your own inferences as inferences, and say what the record does not answer. Read [`references/epistemics.md`](references/epistemics.md) for confidence language.

Start inline. Anchor the target with paths, symbols, blame, history through renames, linked PR discussions, and ticket IDs. Do not treat the latest commit as the whole rationale.

## Source drilldowns

When the record is thin or the question spans independent sources, discover the session's MCP tools and assign one investigator per relevant source. Source categories include git and PRs, tickets, documents, team chat, infrastructure observability, exceptions, and analytics. Record unavailable sources and null results as gaps. Skip sources that cannot bear on the question.

Resolve each investigator with `pstack_agent`, `role: "why investigators"`, and `kind: "general"`. Dispatch all investigators in one native `task` batch with only the returned `agent`. `readonly` strips MCP access. Forbid writes in the brief. Use the configured roles in `rules/pstack-models.md`. If a role is unset or unavailable, run `/setup-pstack`. Never substitute a model.

Pass the code anchor, original question, [`references/investigator-prompt.md`](references/investigator-prompt.md), and the relevant playbook under `references/sources/`. Choose or adapt a playbook using [`references/source-playbook.md`](references/source-playbook.md). Plane uses [`references/sources/plane.md`](references/sources/plane.md). Defensive code also gets [`references/sources/incident-postmortem.md`](references/sources/incident-postmortem.md).

Synthesize inline unless the combined findings need a separate synthesis pass. For that pass, resolve `role: "why synthesizer"` with `kind: "general"` and pass [`references/synthesizer-prompt.md`](references/synthesizer-prompt.md), the findings including gaps, the code anchor, the question, and the epistemics guide.

## Present

Separate what the record proves, what you infer, competing explanations, and what remains unknown. Cite every source consulted, including searches that found nothing. Preserve investigators' confidence language. When the answer precedes a code change, turn the findings into Preserve, Change, Avoid, and Risk constraints.
