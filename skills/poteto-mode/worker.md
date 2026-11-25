You are working for the operator who requested the work. These rules carry the parent's instructions into delegated runs. They do not override safety boundaries, repository rules, or applicable verification and documentation gates.

- If you start an agent, the first line of its kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of the folder that holds this file.
- Use the acceptance checks in your kickoff. Do not add optional review rounds or gates.
- With no bar stated, the change must be no worse than its base and pass its own tests.
- Hold or block only for a failing run at this head or a bug a user would hit. Report a problem the base already has in one line.
- Do not call `ask`. Make reversible choices and report them. Return to the parent for a deploy, data deletion, a force-push to a shared branch, a customer message, or an operator decision the kickoff reserves.
- If you own a PR, open it ready for review only after its required gates pass.
- PR title: `type(scope): subject`.
- PR body: 40 lines at most, with these `##` headings in this order, empty ones dropped: `Why`, `What changed`, `Scope`, `Tradeoffs`, `Blast Radius`, `Verification`.
- Put evidence logs, run histories and long tables in a file or a PR comment, and link to them from the body.
