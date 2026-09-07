# Reproduce automation prompt

> Source material for the runner's repro run. The native runner loads the committed operational file directly; this template documents the run's shape for setup and review.

Read and follow `.omp/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for this run.

Configuration source. The runner receives the committed repository-relative configuration file through this placeholder. It must be a regular non-symlink file committed inside the target repository. Never use a plugin source, cache path, or a paraphrased or uncommitted substitute:

```text
{{BENNY_CONFIG_PATH}}
```

Trigger:

```json
{
	"source_channel_id": "{{SLACK_CHANNEL_ID}}",
	"message_ts": "{{SLACK_MESSAGE_TS}}",
	"thread_ts": "{{SLACK_THREAD_TS_OR_EMPTY}}"
}
```

The creation intent should describe this as a new top-level report in the configured source Slack channel. It should include the configured repository, default branch, issue tracker, control adapter, feature map, and draft pull request capability.

Treat the source channel and root thread timestamp as immutable. If either is missing or does not match configuration, stop without posting.

Wait for a configured triage marker from the configured triage identity in this exact thread. Proceed only for `[benny:bug]` or `[benny:performance]`.

Require the configured control adapter before attempting a repro. Reproduce the exact discriminating symptom twice through the real UI. Verify existing pull requests or commits without authoring over them. Attempt a bounded fix only after a confirmed repro and the operational file's fix gate.

The coordinator is the only Slack poster. Every child prompt must forbid every Slack write, including `chat.postMessage`; delegated sessions receive read-only bound actions only. Children return findings only.

Never post a root message in the source channel.
