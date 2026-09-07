export interface BennyConfig {
  schema_version: 1;
  automations: { triage_name: string; reproduce_name: string };
  slack: {
    source_channel_id: string; operations_channel_id: string; triage_identity_user_id: string;
    read_action: string; thread_post_action: string; file_download_action: string; operations_edit_action: string;
    prefer_configured_actions: boolean; optional_bot_token_env: string;
    allow_source_root_posts: false; allow_worker_slack_writes: false;
  };
  repository: { url: string; default_branch: string; pull_request_action: string; pull_request_url_format: string; draft_only: true };
  tracker: {
    type: "linear"; team: string; project: string;
    labels: { bug: string; performance: string; intake: string; needs_repro: string };
    status: string; source_link_title: string; require_compensation_action: true;
  };
  routing: { map_path: string; owner_pings_default: boolean; allow_feature_owner_ping: boolean; allow_confirmed_regression_author_ping: boolean };
  control: { skill_name: string; feature_map_path: string; environment: string; artifact_directory: string; artifact_retention_hours: number };
  verdict_markers: { bug: string; performance: string; other: string; tracker_attribute: string };
  status_emoji: { seen: string; reproducing: string; reproduced: string; could_not_reproduce: string; blocked: string; fixing: string; fix_failed: string; pull_request_opened: string };
  budgets: { poll_seconds: number; verdict_wait_minutes: number; triage_follow_up_minutes: number; triage_total_minutes: number; repro_minutes: number; rejection_window_minutes: number; fix_minutes: number; operations_follow_up_minutes: number };
  models: { triage: string; reproduce: string; code: string; media_review: string };
  runtime: {
    trigger: "external" | "socket-mode";
    slack_app_token_env: string; slack_read_token_env: string; slack_write_token_env: string; tracker_token_env: string;
    workspace_image: string; control_command: string[]; control_config: Record<string, unknown>;
    environment: Record<string, string>; allowed_endpoints: string[];
    slack_api_url?: string; linear_api_url?: string;
  };
}

export interface SourceCoordinates { teamId: string; channel: string; rootTs: string }
export interface RemoteReceipt { id: string; url?: string; verified: true; observed: Record<string, unknown> }
export interface SlackMessage {
  type?: string; channel?: string; ts: string; thread_ts?: string; user?: string;
  bot_id?: string; subtype?: string; text?: string; client_msg_id?: string; files?: Array<Record<string, unknown>>;
}
export interface ActionJournal {
  begin(id: string, kind: string, input: unknown): { state: "new" | "done" | "uncertain"; receipt?: RemoteReceipt };
  complete(id: string, receipt: RemoteReceipt, continuation?: ActionContinuation): void;
  uncertain(id: string, reason: string): void;
  /** Read-only lookup of a durable intent; undefined when none exists. */
  peek?(id: string): { state: "open" | "done" | "uncertain"; receipt?: RemoteReceipt } | undefined;
}

/** Continuation checkpoint persisted atomically with journal completion: the exact stage and payload needed to resume after a crash. */
export interface ActionContinuation {
	stage: string;
	state: string;
}

export interface RoutingRoute {
	name: string;
	owners: string[];
	allowFeatureOwnerPing: boolean;
}

export interface RoutingRoutes {
	routes: RoutingRoute[];
	fallbackOwners: string[];
	fallbackAllowFeatureOwnerPing: boolean;
}

/**
 * Parse the routing map's documented route table (the ```yaml block from the
 * shipped example). Returns null on any malformed or absent table so callers
 * fail closed to zero pings instead of guessing routes.
 */
export function parseRoutingRoutes(routingMap: string): RoutingRoutes | null {
	const fence = /```yaml\s*\n([\s\S]*?)```/.exec(routingMap);
	if (!fence) return null;
	let value: unknown;
	try {
		value = Bun.YAML.parse(fence[1]!);
	} catch {
		return null;
	}
	if (!record(value) || !Array.isArray(value.routes)) return null;
	const routes: RoutingRoute[] = [];
	for (const entry of value.routes) {
		if (!record(entry) || typeof entry.name !== "string" || !entry.name) return null;
		if (!Array.isArray(entry.owners) || entry.owners.some((owner) => typeof owner !== "string" || !owner)) return null;
		const allow = entry.allow_feature_owner_ping;
		if (allow !== undefined && typeof allow !== "boolean") return null;
		routes.push({ name: entry.name, owners: entry.owners as string[], allowFeatureOwnerPing: allow === true });
	}
	let fallbackOwners: string[] = [];
	let fallbackAllow = false;
	if (value.fallback !== undefined) {
		if (!record(value.fallback) || !Array.isArray(value.fallback.owners) || value.fallback.owners.some((owner) => typeof owner !== "string")) return null;
		fallbackOwners = value.fallback.owners as string[];
		fallbackAllow = value.fallback.allow_feature_owner_ping === true;
	}
	return { routes, fallbackOwners, fallbackAllowFeatureOwnerPing: fallbackAllow };
}

/**
 * Exact IDs found in the routing map text. An owner must be written as its
 * real Slack user ID (optionally inside a <@…|name> mention) in the map to be
 * pingable; unlisted or paraphrased mentions are stripped.
 */
export function routingMentionIds(routingMap: string): Set<string> {
	const ids = new Set<string>();
	for (const match of routingMap.matchAll(/[UW][A-Z0-9]{8,}/g)) ids.add(match[0]);
	return ids;
}

/**
 * Host-enforced mention policy: broadcast/channel/group mention tokens are
 * ALWAYS stripped before any coordinator post, and a user mention survives
 * only when the EXACT user ID appears in the explicitly supplied per-route
 * allowlist and the specific policy/context permits user pings at all. The
 * model never controls this — stripping happens on the post path, so a
 * verdict cannot ping a person or group the configuration forbids.
 */
export function stripDisallowedMentions(text: string, allow: boolean, allowedUserIds: ReadonlySet<string> = new Set()): string {
	return text
		.replace(/<!(?:here|channel|everyone|subteam[^>]*)>/g, "")
		.replace(/<#[^>]*>/g, "")
		.replace(/<@([^>|]+)(?:\|[^>]*)?>/g, (_match, id: string) => (allow && allowedUserIds.has(id) ? `<@${id}>` : ""))
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n +/g, "\n")
		.trim();
}
export interface ArtifactReceipt { path: string; sha256: string; mimeType: string }
export interface ControlReceipt {
  runId: string; capability: string; at: number; revision: string;
  result: Record<string, unknown>; artifacts: ArtifactReceipt[];
}
export interface TrialReceipt {
  runId: string; phase: "baseline" | "patched"; revision: string; at: number;
  stepIds: string[]; resetId: string; observed: "broken" | "correct";
  stateChecks: Record<string, unknown>; artifacts: ArtifactReceipt[]; controlIds: string[];
}
export interface DraftProof {
  runId: string; trials: TrialReceipt[];
  media: { confirmed: boolean; reviewedHashes: string[]; evidence: string[] };
  sourceReply: { id: string; verified: boolean; at: number };
  rejectionEndsAt: number; ownershipCheckedAt: number; artifactsCheckedAt: number;
  owned: boolean; existingFix: boolean; rejected: boolean; blastRadiusPassed: boolean;
  now: number; deadline: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function selectBennyEvent(value: unknown, config: BennyConfig): { eventId: string; source: SourceCoordinates; root: SlackMessage } | null {
  if (!record(value) || !record(value.event)) throw new Error("Expected Slack Events API envelope with event_id, team_id and event");
  const event = value.event;
  if (event.type !== "message" || event.channel !== config.slack.source_channel_id || event.subtype || event.bot_id || (event.thread_ts !== undefined && event.thread_ts !== event.ts)) return null;
  if (typeof event.user !== "string" || !event.user || event.user === config.slack.triage_identity_user_id) return null;
  if (typeof value.event_id !== "string" || !value.event_id.trim() || value.event_id.length > 128 || typeof value.team_id !== "string" || !value.team_id.trim()) throw new Error("Slack event identity is missing or invalid");
  if (typeof event.ts !== "string" || !/^\d+\.\d+$/.test(event.ts)) throw new Error("Slack source root timestamp is missing or invalid");
  return {
    eventId: value.event_id,
    source: { teamId: value.team_id, channel: config.slack.source_channel_id, rootTs: event.ts },
    root: event as unknown as SlackMessage,
  };
}

export function trustedVerdict(messages: SlackMessage[], config: BennyConfig, source: SourceCoordinates): "bug" | "performance" | "other" | "conflict" | null {
  let verdict: "bug" | "performance" | "other" | null = null;
  for (const message of messages) {
    if (message.user !== config.slack.triage_identity_user_id || !message.thread_ts || message.ts === message.thread_ts) continue;
    if (message.thread_ts !== source.rootTs || (message.channel !== undefined && message.channel !== source.channel)) continue;
    let found: "bug" | "performance" | "other" | null = null;
    for (const kind of ["bug", "performance", "other"] as const) {
      const marker = config.verdict_markers[kind];
      const first = marker ? (message.text ?? "").indexOf(marker) : -1;
      if (first < 0) continue;
      if (found !== null || message.text!.indexOf(marker, first + marker.length) !== -1) return "conflict";
      found = kind;
    }
    if (found === null) continue;
    if (verdict !== null && verdict !== found) return "conflict";
    verdict = found;
  }
  return verdict;
}

export function canCreateDraft(proof: DraftProof): { allowed: boolean; reason?: string } {
  const deny = (reason: string) => ({ allowed: false, reason });
  if (!Number.isFinite(proof.now) || !Number.isFinite(proof.deadline) || proof.now >= proof.deadline) return deny("Workflow deadline expired");
  if (proof.owned || proof.existingFix || proof.rejected) return deny("Ownership, existing fix or rejected setup forbids an authored PR");
  if (!proof.blastRadiusPassed) return deny("Blast-radius checks did not pass");
  if (!proof.media.confirmed || !proof.media.evidence.length) return deny("Independent media review did not confirm the evidence");
  if (!proof.sourceReply.verified || !proof.sourceReply.id || !Number.isFinite(proof.sourceReply.at) || proof.sourceReply.at > proof.rejectionEndsAt) return deny("A verified source reply must open the rejection window");
  if (!Number.isFinite(proof.rejectionEndsAt) || proof.now < proof.rejectionEndsAt) return deny("Rejection window is still open");
  const baseline = proof.trials.filter((trial) => trial.phase === "baseline");
  const patched = proof.trials.filter((trial) => trial.phase === "patched");
  if (baseline.length !== 2 || patched.length !== 2) return deny("Two baseline and two patched UI trials are required");
  const all = [...baseline, ...patched];
  const steps = JSON.stringify(baseline[0]!.stepIds);
  if (!baseline[0]!.stepIds.length || !baseline[0]!.revision || !patched[0]!.revision || baseline[0]!.revision === patched[0]!.revision) return deny("Missing UI path or distinct baseline/patched revisions");
  if (new Set(all.map((trial) => trial.resetId)).size !== 4) return deny("Each UI trial requires its own independent reset");
  for (const trial of all) {
    if (trial.runId !== proof.runId || !trial.resetId || !trial.controlIds.length || !Number.isFinite(trial.at) || trial.at > proof.now) return deny("Trial receipt does not belong to this run or lacks actual control calls");
    if (JSON.stringify(trial.stepIds) !== steps) return deny("Baseline and patched trials did not execute the same ordered UI path");
    if (trial.revision !== (trial.phase === "baseline" ? baseline[0]!.revision : patched[0]!.revision)) return deny("Revision changed within a pair of trials");
    if (trial.observed !== (trial.phase === "baseline" ? "broken" : "correct") || !Object.keys(trial.stateChecks).length) return deny("Discriminating UI state and read-only state checks are missing");
    if (!trial.artifacts.some((artifact) => artifact.mimeType.startsWith("image/")) || !trial.artifacts.some((artifact) => artifact.mimeType.startsWith("video/"))) return deny("Each trial needs a screenshot and recording");
    for (const artifact of trial.artifacts) {
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !proof.media.reviewedHashes.includes(artifact.sha256)) return deny("Captured artifact hash is missing from independent media review");
    }
  }
  const lastProofAt = Math.max(proof.rejectionEndsAt, ...all.map((trial) => trial.at));
  if (!Number.isFinite(proof.ownershipCheckedAt) || !Number.isFinite(proof.artifactsCheckedAt) || proof.ownershipCheckedAt < lastProofAt || proof.artifactsCheckedAt < lastProofAt || proof.ownershipCheckedAt > proof.now || proof.artifactsCheckedAt > proof.now) return deny("Fresh ownership and fix-artifact reads are required after proof and rejection window");
  return { allowed: true };
}
