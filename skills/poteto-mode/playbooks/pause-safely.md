### Pause safely

**You own a clean stop. Leave a checkpoint a cold-start agent can resume from.** This is explicit only. On "keep going", "going to bed, keep going", or "don't stop", do not pause.

1. Stop at a safe boundary. Finish the current atomic step or back out of it. Start nothing new, and cancel any nested subagents through native job or Agent Hub controls. SDK consumers inspect with `getAsyncJobSnapshot()` and `inspectAsyncJob(id)`, then cancel owned jobs with `cancelAsyncJob(id)`. Record settlement and preserve the ledger. Do not infer process exit from transcript age.
2. Take no irreversible action to pause. No PR and no push unless you already had one out.
3. Make the work durable. Commit uncommitted edits as one clear `wip:` commit on the current branch so nothing is lost. If the tree is broken, say so in the commit body in one line.
4. Write the resume note off-context. Capture intent, what you were doing, progress and what's verified, current state, next steps, key files, and gotchas. For the compaction trigger write it to a file like `/tmp/<slug>-resume.md`. If a show-me-your-work trail exists, point at it instead of duplicating it.
   For an optional session transfer, use `omp session pack <session.jsonl> <archive.tar>`, then `omp session unpack <archive.tar> --cwd <destination>` in the receiving environment. Preserve the source and resume note. Use `omp session moved <source-session.jsonl> --to <recipient>` only after arrival is confirmed. These commands carry the session and artifacts, not credentials, a repository checkout, services, or external referenced files. Keep the irreversible-action pause.

**Reply:** where you are in the loop, what's on disk versus still in your head (paths, no diff dumps), the commits you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.
