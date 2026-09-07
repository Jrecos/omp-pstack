/**
 * Benny deterministic coordinator: config, SQLite store, action journal, and
 * the restricted-session substrate shared by both phases.
 *
 * The coordinator alone advances persisted phases and authorizes remote
 * writes. Triage and reproduction run as separate restricted file-backed SDK
 * sessions whose only tools are bound, read-only action brokers and the
 * disposable workspace/control boundary. Every model result is parsed and
 * validated; receipts come only from real action/control calls. Source
 * bodies are untrusted data, never shell strings or instructions.
 */
import { pstackCommand } from "./cli-launch.ts";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
	type AgentSession,
	type AuthStorage,
	type CustomTool,
} from "@oh-my-pi/pi-coding-agent";
import { resolveModelFromString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	canCreateDraft,
	selectBennyEvent,
	trustedVerdict,
	type ActionContinuation,
	type ActionJournal,
	type BennyConfig,
	type ControlReceipt,
	type DraftProof,
	type RemoteReceipt,
	type SlackMessage,
	type SourceCoordinates,
	type TrialReceipt,
} from "./benny-policy.ts";
import {
	BOOT_ID,
	finishRun,
	getRun,
	openRunStore,
	ownerIncarnationAlive,
	PROCESS_INCARNATION,
	profileWorkspaceDir,
	securePrivateDir,
} from "./runner.ts";
import { ActionFailure, CanceledStateMissingError } from "./benny-actions.ts";


export { canCreateDraft, selectBennyEvent, trustedVerdict };
export { ActionFailure, CanceledStateMissingError };

export { setupBenny, checkBenny, setBennyEnabled, controlChecks } from "./benny-setup.ts";
export type { SetupResult, PreflightCheck } from "./benny-setup.ts";
import { BennyError, runBenny } from "./benny-run.ts";
export { BennyError, runBenny };
export type { BennyRunResult, BennyOutcome } from "./benny-run.ts";
export { startBennySocket } from "./benny-socket.ts";
export type {
	ActionJournal,
	BennyConfig,
	ControlReceipt,
	DraftProof,
	RemoteReceipt,
	SlackMessage,
	SourceCoordinates,
	TrialReceipt,
};

export const PHASES = ["triage", "reproduce"] as const;
export type Phase = (typeof PHASES)[number];

export class BennyConfigError extends Error {}

// ---------------------------------------------------------------------------
// Configuration: strict v1 schema, placeholders and secrets refused
// ---------------------------------------------------------------------------

const nonempty = z.string().min(1);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "expected an environment variable name");
/**
 * Behavior-bearing config paths must stay inside the target repository:
 * absolute paths or `..` segments would let the binding and preflight read
 * (or import) content outside the repo the enable gate binds to.
 */
const repoRelativePath = nonempty.refine((value) => {
	if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
	return !value.split(/[\\/]/).includes("..");
}, "expected a repository-relative path without '..' segments");

/**
 * Evidence storage is fixed beneath the secure private root; the config field
 * remains but must be exactly this literal, so no configuration value can
 * point artifacts (or their validation path) anywhere else.
 */
export const BENNY_ARTIFACT_ROOT = ".omp/pstack/state/benny-evidence";
const PLACEHOLDER_PATTERNS: RegExp[] = [
	/placeholder/i,
	/^SOURCE_CHANNEL_ID$/,
	/^TRIAGE_IDENTITY_USER_ID$/,
	/^choose-an-available-public-model-slug$/,
	/example-org/i,
	/^<.*>$/,
];

/**
 * A config value that looks like a live credential is a secret-in-config
 * violation. Every pattern requires the token prefix AND a substantial body,
 * so documented prefixes in ordinary prose ("xoxb-", "sk-", "github_pat_")
 * never match. Covers Slack (xoxb/xoxp/xoxc/xoxd/xoxr/xoxs/xoxa/xoxe and the
 * app-level xapp- form), OpenAI-style model keys (sk-, sk-proj-, sk-ant-),
 * GitHub PATs (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_),
 * Linear API keys, Google/Gemini, Hugging Face, Groq, xAI, GitLab and AWS
 * access keys.
 */
const SECRET_PATTERNS: RegExp[] = [
	/\bxox[a-z0-9]{1,4}-[A-Za-z0-9_-]{10,}/,
	/\bxapp-[A-Za-z0-9_-]{10,}/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/,
	/github_pat_[A-Za-z0-9_]{30,}/,
	/\blin_api_[A-Za-z0-9]{20,}/,
	/\bAIza[0-9A-Za-z_-]{35}/,
	/\bhf_[A-Za-z0-9]{20,}/,
	/\bgsk_[A-Za-z0-9]{20,}/,
	/\bxai-[A-Za-z0-9]{20,}/,
	/\bglpat-[A-Za-z0-9_-]{20,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
];

function rejectPlaceholder(value: string, path: string): void {
	for (const pattern of PLACEHOLDER_PATTERNS) {
		if (pattern.test(value)) {
			throw new BennyConfigError(`${path}: placeholder value "${value}" must be replaced with a real configured value`);
		}
	}
	if (value.length > 512) throw new BennyConfigError(`${path}: value is implausibly long for configuration`);
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(value)) {
			throw new BennyConfigError(`${path}: value looks like a secret; secrets belong in environment/profile, never in config`);
		}
	}
}
/** Shared with the Git-isolation scrubber: keys shaped like credential carriers. */
const CREDENTIAL_KEY = /secret|token|password|credential|api[-_]?key/i;

/**
 * runtime.control_config and runtime.environment are arbitrary operator maps:
 * any credential-shaped key at ANY nesting depth (objects, arrays of objects)
 * is rejected outright. The explicit typed *_token_env schema fields remain
 * the only credential references in a Benny configuration.
 */
function walkCredentialKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => walkCredentialKeys(item, `${path}[${index}]`));
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			if (CREDENTIAL_KEY.test(key)) {
				throw new BennyConfigError(
					`${path}.${key}: credential-shaped key "${key}" is not a configuration value; reference credentials with the typed *_token_env fields instead`,
				);
			}
			walkCredentialKeys(item, `${path}.${key}`);
		}
	}
}

function walkStrings(value: unknown, path: string): void {
	if (typeof value === "string") rejectPlaceholder(value, path);
	else if (Array.isArray(value)) value.forEach((item, index) => walkStrings(item, `${path}[${index}]`));
	else if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) walkStrings(item, `${path}.${key}`);
	}
}

const bennyConfigSchema = z.strictObject({
	schema_version: z.literal(1),
	automations: z.strictObject({ triage_name: nonempty, reproduce_name: nonempty }),
	slack: z.strictObject({
		source_channel_id: nonempty,
		operations_channel_id: z.string(),
		triage_identity_user_id: nonempty,
		read_action: nonempty,
		thread_post_action: nonempty,
		file_download_action: nonempty,
		operations_edit_action: nonempty,
		prefer_configured_actions: z.boolean(),
		optional_bot_token_env: envName,
		allow_source_root_posts: z.literal(false),
		allow_worker_slack_writes: z.literal(false),
	}),
	repository: z.strictObject({
		url: nonempty,
		default_branch: nonempty,
		pull_request_action: nonempty,
		pull_request_url_format: nonempty,
		draft_only: z.literal(true),
	}),
	tracker: z.strictObject({
		type: z.literal("linear"),
		team: nonempty,
		project: nonempty,
		labels: z.strictObject({ bug: nonempty, performance: nonempty, intake: nonempty, needs_repro: nonempty }),
		status: nonempty,
		source_link_title: nonempty,
		require_compensation_action: z.literal(true),
	}),
	routing: z.strictObject({
		map_path: repoRelativePath,
		owner_pings_default: z.boolean(),
		allow_feature_owner_ping: z.boolean(),
		allow_confirmed_regression_author_ping: z.boolean(),
	}),
	control: z.strictObject({
		skill_name: nonempty,
		feature_map_path: repoRelativePath,
		environment: nonempty,
		artifact_directory: z.literal(BENNY_ARTIFACT_ROOT),
		artifact_retention_hours: z.number().positive(),
	}),
	verdict_markers: z.strictObject({ bug: nonempty, performance: nonempty, other: nonempty, tracker_attribute: nonempty }),
	status_emoji: z.strictObject({
		seen: nonempty,
		reproducing: nonempty,
		reproduced: nonempty,
		could_not_reproduce: nonempty,
		blocked: nonempty,
		fixing: nonempty,
		fix_failed: nonempty,
		pull_request_opened: nonempty,
	}),
	budgets: z.strictObject({
		poll_seconds: z.number().int().positive(),
		verdict_wait_minutes: z.number().positive(),
		triage_follow_up_minutes: z.number().min(0),
		triage_total_minutes: z.number().positive(),
		repro_minutes: z.number().positive(),
		rejection_window_minutes: z.number().min(0),
		fix_minutes: z.number().positive(),
		operations_follow_up_minutes: z.number().min(0),
	}),
	models: z.strictObject({ triage: nonempty, reproduce: nonempty, code: nonempty, media_review: nonempty }),
	runtime: z.strictObject({
		trigger: z.enum(["external", "socket-mode"]),
		slack_app_token_env: envName,
		slack_read_token_env: envName,
		slack_write_token_env: envName,
		tracker_token_env: envName,
		workspace_image: nonempty,
		control_command: z.array(nonempty).min(1),
		control_config: z.record(z.string(), z.unknown()),
		environment: z.record(z.string(), z.string()),
		allowed_endpoints: z.array(nonempty),
		slack_api_url: z.string().optional(),
		linear_api_url: z.string().optional(),
	}),
});
export function parseBennyConfig(value: unknown): BennyConfig {
	// Custom tracker modules were withdrawn: in-process operator JavaScript
	// cannot be forcibly cancelled, so only the bundled bounded Linear
	// adapter executes. Refuse it at parse time — before admission, preflight
	// or any transport selection — with the remediation, not a generic
	// unrecognized-key error.
	if (value && typeof value === "object" && !Array.isArray(value) && "runtime" in value) {
		const runtime: unknown = value.runtime;
		if (runtime && typeof runtime === "object" && !Array.isArray(runtime) && "tracker_adapter" in runtime) {
			throw new BennyConfigError(
				"runtime.tracker_adapter is not supported: only the bundled bounded Linear tracker adapter executes; remove runtime.tracker_adapter and set tracker.type to 'linear'",
			);
		}
	}
	const parsed = bennyConfigSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new BennyConfigError(
			`configuration invalid at ${issue?.path.join(".") || "?"}: ${issue?.message ?? parsed.error.message}`,
		);
	}
	// OMP supplies no narrow host broker that can dispatch configured
	// Cursor-style actions, so a configured-action preference can never
	// execute. Refuse it at parse time — before admission, preflight or any
	// transport selection — instead of silently running the bundled
	// Slack/Linear/gh transports under a config that asked for something else.
	if (parsed.data.slack.prefer_configured_actions) {
		throw new BennyConfigError(
			"slack.prefer_configured_actions=true is not supported: OMP supplies no host broker for configured actions; set it to false to use the bundled Slack/Linear/gh transports",
		);
	}
	// Retained evidence must outlive every park that consumes it: the draft
	// gate re-reads published trial artifacts after the rejection window and
	// again after the operations follow-up, so an expiry inside that span
	// would make a resume block on evidence the config itself threw away.
	const maxParkMinutes = parsed.data.budgets.rejection_window_minutes + parsed.data.budgets.operations_follow_up_minutes;
	if (parsed.data.control.artifact_retention_hours * 60 < maxParkMinutes) {
		throw new BennyConfigError(
			`control.artifact_retention_hours=${parsed.data.control.artifact_retention_hours} is shorter than the longest evidence-consuming wait (rejection_window_minutes + operations_follow_up_minutes = ${maxParkMinutes} minutes); raise it or evidence may expire mid-run`,
		);
	}
	walkStrings(parsed.data, "config");
	walkCredentialKeys(parsed.data.runtime.control_config, "config.runtime.control_config");
	walkCredentialKeys(parsed.data.runtime.environment, "config.runtime.environment");
	return parsed.data as BennyConfig;
}

export function parseBennyConfigYaml(text: string): BennyConfig {
	let value: unknown;
	try {
		value = Bun.YAML.parse(text);
	} catch (error) {
		throw new BennyConfigError(`configuration is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseBennyConfig(value);
}

/**
 * PSTACK-SEC-CONFIG-004: the configuration path is containment-checked BEFORE
 * any read. It must be a regular non-symlink file whose every component is
 * physically inside the target worktree, so a tracked symlink to mutable
 * out-of-tree content can never pass as the committed configuration.
 */
export async function loadBennyConfig(configPath: string): Promise<BennyConfig> {
	const containment = configContainmentProblem(configPath, targetRootFor(configPath));
	if (containment) {
		throw new BennyError(2, `Benny configuration is not a contained regular repository file: ${containment}`);
	}
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		throw new BennyConfigError(
			`cannot read Benny configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseBennyConfigYaml(text);
}

/**
 * PSTACK-SEC-GIT-002: target cleanliness gates run while this process holds
 * Slack/tracker/GitHub credentials, and Git loads the TARGET repository's
 * local configuration — including `core.fsmonitor` and other executable
 * helper programs. Every target-repository Git invocation in the runner runs
 * with a scrubbed nonsecret environment (credential-shaped keys and known
 * runner credential namespaces dropped) and command-scope overrides that
 * disable fsmonitor, hooks and external diff helpers, so repository-local
 * executable Git configuration can never execute under the runner's
 * credential environment.
 */
const GIT_ISOLATION_FLAGS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"diff.external=/bin/true",
] as const;

export function gitIsolatedArgv(args: readonly string[]): string[] {
	return ["git", ...GIT_ISOLATION_FLAGS, ...args];
}

const CREDENTIAL_ENV_KEY = /secret|token|password|credential|api[-_]?key/i;
const CREDENTIAL_ENV_PREFIX = /^(GH|GITHUB|SLACK|LINEAR|PSTACK)_/i;

export function gitIsolationEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// Inherited GIT_* controls (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
		// GIT_CONFIG_COUNT/KEY_N/VALUE_N, GIT_SSH_COMMAND, GIT_ASKPASS, …)
		// can repoint every invocation at a foreign repository, inject
		// configuration, or execute helper programs. Only the explicitly
		// controlled variables this module adds on top are ever present.
		if (key.startsWith("GIT_") || CREDENTIAL_ENV_KEY.test(key) || CREDENTIAL_ENV_PREFIX.test(key)) continue;
		env[key] = value;
	}
	return env;
}

/**
 * The repository a config path belongs to. The containing Git worktree is the
 * authoritative binding for EVERY config path; the default pack layout
 * (<target>/.omp/benny/configuration.yaml) shortcut is accepted only when it
 * agrees with that worktree root, and a path that cannot be bound
 * unambiguously (no enclosing worktree) is an error — never the caller's
 * process.cwd() or the bare config parent directory, which would bind
 * admission, preflight and private state to the wrong repository.
 */
export function targetRootFor(configPath: string): string {
	const absolute = resolve(configPath);
	const parent = dirname(absolute);
	const layoutRoot =
		basename(parent) === "benny" && basename(dirname(parent)) === ".omp" ? resolve(dirname(dirname(parent))) : undefined;
	for (let dir = parent; ; dir = dirname(dir)) {
		const probe = Bun.spawnSync(gitIsolatedArgv(["-C", dir, "rev-parse", "--show-toplevel"]), {
			stdout: "pipe",
			stderr: "ignore",
			env: gitIsolationEnv(),
		});
		if (probe.exitCode === 0) {
			const top = probe.stdout.toString().trim();
			if (top) {
				if (layoutRoot !== undefined && resolve(top) !== layoutRoot) {
					throw new BennyError(
						2,
						`Benny configuration at ${absolute} follows the default layout of ${layoutRoot} but sits inside git worktree ${top}; the target root is ambiguous`,
					);
				}
				return top;
			}
		}
		if (dirname(dir) === dir) break;
	}
	throw new BennyError(
		2,
		`Benny configuration at ${absolute} is not inside a git worktree; the target root cannot be bound unambiguously`,
	);
}


/** Host env that explicitly opts a deployment into loopback fixture endpoints. */
const LOOPBACK_FIXTURE_ENV = "PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES";

/**
 * Endpoint policy guard: every configured service endpoint override must be
 * either the service's official origin (Slack https://slack.com, Linear
 * https://api.linear.app) or an explicitly opted-in loopback fixture (host
 * env PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES=1). Anything else — arbitrary
 * hosts, non-official https origins — throws, so credentials are never sent
 * to an unapproved destination. Unset endpoints default to the official origin.
 */
export function assertBennyEndpointPolicy(config: BennyConfig): void {
	const official: Array<[string, string | undefined, string]> = [
		["slack", config.runtime.slack_api_url, "https://slack.com"],
		["linear", config.runtime.linear_api_url, "https://api.linear.app"],
	];
	for (const [service, override, origin] of official) {
		if (override === undefined) continue;
		let parsed: URL;
		try {
			parsed = new URL(override);
		} catch {
			throw new BennyError(2, `${service} service endpoint override '${override}' is not a valid URL`);
		}
		if (parsed.origin === origin) continue;
		const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
		if (loopback && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
			if (process.env[LOOPBACK_FIXTURE_ENV] === "1") continue;
			throw new BennyError(
				2,
				`${service} service endpoint override '${override}' is a loopback fixture endpoint; set ${LOOPBACK_FIXTURE_ENV}=1 in the runner environment to admit it (test fixtures only)`,
			);
		}
		throw new BennyError(
			2,
			`${service} service endpoint override '${override}' is neither the official origin ${origin} nor an opted-in loopback fixture; refusing to send credentials there`,
		);
	}
}

export function bennyConfigHash(config: BennyConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/**
 * PSTACK-SEC-GIT-005: the admitted revision is read with replacement refs
 * disabled and a scrubbed environment, so a local refs/replace entry can
 * never substitute a different commit as the repository binding.
 */
export function bennyRepoRevision(target: string): string {
	const result = Bun.spawnSync(gitIsolatedArgv(["-C", target, "rev-parse", "HEAD"]), {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...gitIsolationEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
	});
	if (result.exitCode !== 0) {
		throw new BennyConfigError(`cannot read repository revision for ${target}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

/**
 * Exact regular-file blob bytes at `revision`, read with replacement refs
 * disabled and a scrubbed, hook/fsmonitor-isolated Git environment. Returns
 * an error string when the entry is missing or NOT a regular file — a
 * committed symlink (120000) is refused, never dereferenced.
 */
export function gitCommittedFileBytes(target: string, revision: string, relPath: string): { bytes?: Buffer; error?: string } {
	const listed = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "ls-tree", revision, "--", relPath]), {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...gitIsolationEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
	});
	const match = /^(\d+)\s+blob\s+([0-9a-f]{40,64})\t/.exec(listed.stdout.toString("utf8"));
	if (listed.exitCode !== 0 || !match || match[1] === "120000") {
		return { error: listed.stderr.toString().trim() || `not a regular tracked file at ${revision.slice(0, 12)}…: ${relPath}` };
	}
	const blob = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "cat-file", "blob", match[2]!]), {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...gitIsolationEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
	});
	if (blob.exitCode !== 0) return { error: blob.stderr.toString().trim() || `blob ${match[2]} unreadable` };
	return { bytes: Buffer.from(blob.stdout) };
}

/**
 * PSTACK-SEC-CONFIG-004: the configuration path must be a regular
 * non-symlink file whose canonical location stays inside the target root —
 * a symlinked intermediate component would redirect reads outside the repo.
 */
export function configContainmentProblem(configPath: string, target: string): string | null {
	const absolute = resolve(configPath);
	const rel = relative(resolve(target), absolute);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `${absolute} is not inside the target root ${resolve(target)}`;
	const st = lstatSync(absolute, { throwIfNoEntry: false });
	if (!st) return `${absolute} does not exist`;
	if (st.isSymbolicLink()) return `${absolute} is a symlink; a regular file is required`;
	if (!st.isFile()) return `${absolute} is not a regular file`;
	try {
		const realTarget = realpathSync(target);
		if (realpathSync(absolute) !== join(realTarget, rel)) return `${absolute} resolves outside the target root through a symlink`;
	} catch (error) {
		return `cannot canonicalize ${absolute}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return null;
}

/**
 * PSTACK-SEC-CONFIG-004: the on-disk configuration bytes must be the exact
 * regular blob tracked at the given revision — the same byte binding the
 * operational pack answers to. Returns the refusal reason or null.
 */
export function configBlobBindingProblem(configPath: string, target: string, revision: string): string | null {
	const containment = configContainmentProblem(configPath, target);
	if (containment) return containment;
	const rel = relative(resolve(target), resolve(configPath));
	const blob = gitCommittedFileBytes(target, revision, rel);
	if (!blob.bytes) return `configuration is absent from revision ${revision.slice(0, 12)}… (${blob.error ?? "unreadable"})`;
	if (!blob.bytes.equals(readFileSync(resolve(configPath)))) {
		return `worktree configuration bytes differ from revision ${revision.slice(0, 12)}…; commit the configuration and rerun enable/canary`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// SQLite store: phase dedupe, action journal, canary records
// ---------------------------------------------------------------------------

const RUN_STATUSES = ["queued", "running", "succeeded", "blocked", "failed", "interrupted"] as const;
export type BennyRunStatus = (typeof RUN_STATUSES)[number];

export function openBennyStore(db: Database): void {
	// Table creation, inspection and every conditional alter commit in ONE
	// BEGIN IMMEDIATE transaction: two CLI/service/socket processes opening
	// one pre-upgrade store take turns on the write lock (busy timeout) and
	// the loser re-inspects committed state, instead of both observing a
	// missing column and the second ALTER aborting startup.
	db.run("BEGIN IMMEDIATE");
	try {
		db.run(`CREATE TABLE IF NOT EXISTS benny_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id INTEGER NOT NULL,
			team_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			phase TEXT NOT NULL CHECK (phase IN ('triage','reproduce')),
			channel TEXT NOT NULL,
			root_ts TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','blocked','failed','interrupted')),
			stage TEXT NOT NULL DEFAULT 'admitted',
			canary INTEGER NOT NULL DEFAULT 0,
			config_hash TEXT NOT NULL DEFAULT '',
			repo_revision TEXT NOT NULL DEFAULT '',
			owner_pid INTEGER,
			owner_boot TEXT,
			deadline_ms INTEGER NOT NULL,
			not_before_ms INTEGER NOT NULL DEFAULT 0,
			wait_until_ms INTEGER,
			diagnostic TEXT,
			actions TEXT NOT NULL DEFAULT '[]',
			state TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(team_id, event_id, phase),
			UNIQUE(team_id, channel, root_ts, phase)
		)`);
		db.run(`CREATE TABLE IF NOT EXISTS benny_journal (
			action_id TEXT PRIMARY KEY,
			run_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			input TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('open','done','uncertain')),
			receipt TEXT,
			reason TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		db.run(`CREATE TABLE IF NOT EXISTS benny_canary (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL,
			config_hash TEXT NOT NULL,
			repo_revision TEXT NOT NULL,
			passed INTEGER NOT NULL,
			observed TEXT NOT NULL,
			at INTEGER NOT NULL,
			image_id TEXT NOT NULL DEFAULT ''
		)`);
		// Migration: stores created before the binding contract lack the binding
		// columns. Backfill '' — an identity that can never be claimed and that
		// flags legacy rows for re-admission under a fully bound identity.
		const columns = db.query("PRAGMA table_info(benny_runs)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "config_hash")) {
			db.run("ALTER TABLE benny_runs ADD COLUMN config_hash TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some((column) => column.name === "repo_revision")) {
			db.run("ALTER TABLE benny_runs ADD COLUMN repo_revision TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some((column) => column.name === "image_id")) {
			db.run("ALTER TABLE benny_runs ADD COLUMN image_id TEXT NOT NULL DEFAULT ''");
		}
		const canaryColumns = db.query("PRAGMA table_info(benny_canary)").all() as Array<{ name: string }>;
		if (!canaryColumns.some((column) => column.name === "image_id")) {
			db.run("ALTER TABLE benny_canary ADD COLUMN image_id TEXT NOT NULL DEFAULT ''");
		}
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

export interface BennyRunRow {
	id: number;
	run_id: number;
	team_id: string;
	event_id: string;
	phase: Phase;
	channel: string;
	root_ts: string;
	status: BennyRunStatus;
	stage: string;
	canary: number;
	config_hash: string;
	repo_revision: string;
	/** Resolved immutable workspace image id at admission ('' = legacy, unbound). */
	image_id: string;
	owner_pid: number | null;
	owner_boot: string | null;
	deadline_ms: number;
	not_before_ms: number;
	wait_until_ms: number | null;
	diagnostic: string | null;
	actions: string;
	state: string | null;
	created_at: number;
	updated_at: number;
}

function getBennyRun(db: Database, id: number): BennyRunRow | undefined {
	return db.query("SELECT * FROM benny_runs WHERE id = ?").get(id) as BennyRunRow | undefined;
}

export interface SelectedEvent {
	eventId: string;
	source: SourceCoordinates;
	root: SlackMessage;
}

export interface Admission {
	rows: Array<{ run: BennyRunRow; duplicate: boolean }>;
	duplicate: boolean;
}

/** Exact coordinator identity a benny run is bound to; claim and admission filters use it verbatim. */
export interface BennyBinding {
	configHash: string;
	repoRevision: string;
	canary: boolean;
	/** Resolved immutable workspace image id at admission; undefined = legacy unbound. */
	imageId?: string;
}

/**
 * Durable admission shared by the external CLI and Socket Mode. Dedupe on
 * (team,event,phase) and (team,channel,root,phase) protects against alternate
 * delivery IDs; a duplicate returns the existing row only when the binding
 * matches exactly — a replay with a different config hash, repo revision, or
 * canary flag fails closed instead of returning an unclaimable row that
 * would make the driver loop forever. The runs-table row (kind 'benny')
 * participates in the shared one-active checkout lock; the generic routine
 * worker can never claim it.
 *
 * `deadlines` is per phase (final absolute deadline each). The plain-number
 * fallback stamps the same value on both the lock row and every admitted
 * phase and exists only so legacy unit callsites compile. `config`, when
 * supplied, is the parsed canonical configuration snapshot persisted INSIDE
 * the admission transaction — resume executes from the stored snapshot and
 * OID, never from live enable state or live config.
 */
export function admitBennyEvent(
	db: Database,
	event: SelectedEvent,
	phases: Phase[],
	deadlines: Record<Phase, number> | number,
	binding: BennyBinding,
	config?: BennyConfig,
): Admission {
	const deadlineFor = (phase: Phase): number => (typeof deadlines === "number" ? deadlines : deadlines[phase]);
	const lockBody = JSON.stringify(
		config ? { source: event.source, root: event.root, config } : { source: event.source, root: event.root },
	);
	const now = Date.now();
	const assertSameBinding = (row: BennyRunRow, key: string): void => {
		if (
			row.config_hash !== binding.configHash ||
			row.repo_revision !== binding.repoRevision ||
			Boolean(row.canary) !== binding.canary ||
			row.image_id !== (binding.imageId ?? "")
		) {
			throw new BennyError(
				2,
				`benny admission conflict on ${key}: stored binding (config ${row.config_hash.slice(0, 12) || "(empty)"}…, revision ${row.repo_revision.slice(0, 12) || "(empty)"}…, canary=${Boolean(row.canary)}, image ${row.image_id.slice(0, 16) || "(unbound)"}) differs from the requested binding (config ${binding.configHash.slice(0, 12)}…, revision ${binding.repoRevision.slice(0, 12)}…, canary=${binding.canary}, image ${binding.imageId?.slice(0, 16) ?? "(unbound)"}); refuse rather than requeue an unclaimable duplicate`,
			);
		}
	};
	db.run("BEGIN IMMEDIATE");
	try {
		const rows: Admission["rows"] = [];
		for (const phase of phases) {
			const existing = db
				.query("SELECT * FROM benny_runs WHERE team_id = ? AND event_id = ? AND phase = ?")
				.get(event.source.teamId, event.eventId, phase) as BennyRunRow | undefined;
			if (existing) {
				assertSameBinding(existing, `event ${event.eventId}/${phase}`);
				rows.push({ run: existing, duplicate: true });
				continue;
			}
			// Alternate delivery IDs for the same source message must not create a
			// second run: the (team,channel,root,phase) key is backed by a UNIQUE index.
			const byRoot = db
				.query("SELECT * FROM benny_runs WHERE team_id = ? AND channel = ? AND root_ts = ? AND phase = ?")
				.get(event.source.teamId, event.source.channel, event.source.rootTs, phase) as BennyRunRow | undefined;
			if (byRoot) {
				assertSameBinding(byRoot, `root ${event.source.rootTs}/${phase}`);
				rows.push({ run: byRoot, duplicate: true });
				continue;
			}
			const lockResult = db.run(
				`INSERT INTO runs (routine, kind, event_id, body, body_digest, timestamp_ms, status, deadline_ms, prompt, model, created_at)
				 VALUES ('benny', 'benny', ?, ?, ?, ?, 'queued', ?, '', '', ?)`,
				[`${event.eventId}:${phase}`, lockBody, "benny-locked", now, deadlineFor(phase), now],
			);
			const lockRunId = Number(lockResult.lastInsertRowid);
			const result = db.run(
				`INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, stage, canary, config_hash, repo_revision, image_id, deadline_ms, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'queued', 'admitted', ?, ?, ?, ?, ?, ?, ?)`,
				[
					lockRunId,
					event.source.teamId,
					event.eventId,
					phase,
					event.source.channel,
					event.source.rootTs,
					binding.canary ? 1 : 0,
					binding.configHash,
					binding.repoRevision,
					binding.imageId ?? "",
					deadlineFor(phase),
					now,
					now,
				],
			);
			rows.push({ run: getBennyRun(db, Number(result.lastInsertRowid))!, duplicate: false });
		}
		db.run("COMMIT");
		return { rows, duplicate: rows.every((row) => row.duplicate) };
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/**
 * Transactional benny claim honoring the shared checkout lock across ALL run
 * kinds (one active run per writable checkout), FIFO among ready benny rows.
 * Only rows bound to the EXACT coordinator identity (config hash, repo
 * revision, canary flag) are claimable: a null ('' legacy) or differing
 * binding is never claimed, even though its row still holds the dedupe keys.
 */
export function claimBennyRun(db: Database, binding: BennyBinding): BennyRunRow | null {
	db.run("BEGIN IMMEDIATE");
	try {
	const now = Date.now();
	// Expired queued rows of this binding are terminally blocked in the SAME
	// transaction that selects the next claim: an expired row is never
	// globally claimable and never enters execution as an unexecuted expiry.
	for (const expired of db
		.query(
			"SELECT id, run_id FROM benny_runs WHERE status = 'queued' AND deadline_ms <= ? AND config_hash = ? AND repo_revision = ? AND canary = ? AND image_id = ?",
		)
		.all(now, binding.configHash, binding.repoRevision, binding.canary ? 1 : 0, binding.imageId ?? "") as Array<{ id: number; run_id: number }>) {
		db.run("UPDATE benny_runs SET status = 'blocked', diagnostic = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [
			"run deadline expired while queued; never executed",
			now,
			expired.id,
		]);
		// The shared checkout row is only released when no live foreign owner
		// holds it (mirrors settleBennyRun's ownership guard).
		const lock = db.query("SELECT status, owner_pid, owner_boot FROM runs WHERE id = ?").get(expired.run_id) as
			| { status: string; owner_pid: number | null; owner_boot: string | null }
			| undefined;
		if (lock && (lock.status === "queued" || lock.status === "running") && !ownerIncarnationAlive(lock.owner_pid, lock.owner_boot)) {
			db.run("UPDATE runs SET status = 'blocked', diagnostic = ?, finished_at = ?, owner_pid = NULL, owner_boot = NULL WHERE id = ?", [
				"run deadline expired while queued; never executed",
				now,
				expired.run_id,
			]);
		}
	}
		const active = db.query("SELECT id FROM runs WHERE status = 'running' LIMIT 1").get() as { id: number } | undefined;
		if (active) {
			db.run("COMMIT");
			return null;
		}
		const next = db
			.query(
				"SELECT * FROM benny_runs WHERE status = 'queued' AND not_before_ms <= ? AND deadline_ms > ? AND config_hash = ? AND repo_revision = ? AND canary = ? AND image_id = ? ORDER BY id LIMIT 1",
			)
			.get(now, now, binding.configHash, binding.repoRevision, binding.canary ? 1 : 0, binding.imageId ?? "") as BennyRunRow | undefined;
		if (!next) {
			db.run("COMMIT");
			return null;
		}

		db.run("UPDATE benny_runs SET status = 'running', owner_pid = ?, owner_boot = ?, updated_at = ? WHERE id = ?", [
			process.pid,
			PROCESS_INCARNATION,
			now,
			next.id,
		]);
		db.run("UPDATE runs SET status = 'running', owner_pid = ?, owner_boot = ? WHERE id = ?", [process.pid, PROCESS_INCARNATION, next.run_id]);
		db.run("COMMIT");
		return { ...next, status: "running", owner_pid: process.pid, owner_boot: PROCESS_INCARNATION };
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/**
 * Release the checkout during a bounded wait; the row stays queued with a
 * wake time. The requeue and the checkout release commit atomically: an
 * observer never sees the benny row queued while the checkout is still held
 * (a claim would deadlock) or the checkout freed while the row still reads
 * running (a routine worker would race it).
 */
export function parkBennyRun(
	db: Database,
	run: BennyRunRow,
	stage: string,
	notBeforeMs: number,
	waitUntilMs: number | null,
	stateJson?: string,
): void {
	db.run("BEGIN IMMEDIATE");
	try {
		const parked = db.run(
			"UPDATE benny_runs SET status = 'queued', stage = ?, not_before_ms = ?, wait_until_ms = ?, state = ?, owner_pid = NULL, owner_boot = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_boot IN (?, ?)",
			[stage, notBeforeMs, waitUntilMs, stateJson ?? run.state, Date.now(), run.id, process.pid, PROCESS_INCARNATION, BOOT_ID],
		);
		const released = db.run(
			"UPDATE runs SET status = 'queued', owner_pid = NULL, owner_boot = NULL WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_boot IN (?, ?)",
			[run.run_id, process.pid, PROCESS_INCARNATION, BOOT_ID],
		);
		if (parked.changes !== 1 || released.changes !== 1) throw new BennyError(1, `cannot atomically park benny run ${run.id}; ownership changed`);
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/**
 * Atomic settlement of BOTH rows of one run in a single transaction: the
 * benny phase row and its runs-table checkout row. Ownership is enforced so
 * no live foreign owner's work is ever cancelled: a queued row settles only
 * when unowned or parked by this process, a running row only under this
 * process's verified incarnation or a verifiably dead owner (crash
 * recovery). Any refusal throws and rolls back, so a half-settled pair can
 * never be observed. Already-terminal rows are an idempotent no-op.
 */
export function settleBennyRun(db: Database, run: BennyRunRow, status: BennyRunStatus, diagnostic?: string, actions: string[] = []): void {
	const now = Date.now();
	db.run("BEGIN IMMEDIATE");
	try {
		const row = getBennyRun(db, run.id);
		if (!row) {
			db.run("ROLLBACK");
			return;
		}
		if (row.status !== "queued" && row.status !== "running") {
			db.run("ROLLBACK");
			return;
		}
		if (!ownedByThisProcess(row.owner_pid, row.owner_boot) && ownerIncarnationAlive(row.owner_pid, row.owner_boot)) {
			throw new BennyError(1, `refusing to settle benny run ${row.id} (${row.phase}): live foreign owner pid ${row.owner_pid} holds it`);
		}
		// Release the checkout in the same transaction (no-op when the checkout
		// row was already settled); a live foreign holder refuses the whole
		// settlement instead of being overwritten.
		const lock = getRun(db, row.run_id);
		if (lock && (lock.status === "queued" || lock.status === "running")) {
			if (!ownedByThisProcess(lock.owner_pid, lock.owner_boot) && ownerIncarnationAlive(lock.owner_pid, lock.owner_boot)) {
				throw new BennyError(1, `refusing to settle benny run ${row.id}: its checkout row is held by live foreign owner pid ${lock.owner_pid}`);
			}
			db.run("UPDATE runs SET status = ?, diagnostic = ?, finished_at = ?, owner_pid = NULL, owner_boot = NULL WHERE id = ?", [status, diagnostic ?? null, now, row.run_id]);
		}
		db.run("UPDATE benny_runs SET status = ?, diagnostic = ?, actions = ?, updated_at = ? WHERE id = ?", [
			status,
			diagnostic ?? null,
			JSON.stringify(actions),
			now,
			row.id,
		]);
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

export function recordBennyStage(db: Database, run: BennyRunRow, stage: string): void {
	db.run("UPDATE benny_runs SET stage = ?, updated_at = ? WHERE id = ?", [stage, Date.now(), run.id]);
}



function ownedByThisProcess(ownerPid: number | null, ownerBoot: string | null): boolean {
	return ownerPid === process.pid && (ownerBoot === PROCESS_INCARNATION || ownerBoot === BOOT_ID);
}

// Explicitly safe checkpoints: 'admitted', triage's 'followup', reproduce's
// 'rejection-wait' and 'operations-followup' never hold a remote write in
// flight, and 'marker-wait' parks between polls.
const SAFE_CHECKPOINT_STAGES: Record<string, true> = {
	admitted: true,
	followup: true,
	"rejection-wait": true,
	"operations-followup": true,
};

// Stages that may be resumed from a journal continuation written atomically
// with the verified remote-write receipt (issue create, verdict post, branch
// publish, draft PR).
const CONTINUATION_STAGES: Record<string, true> = {
	create: true,
	verdict: true,
	draft: true,
};

/**
 * The continuation marker written by BennyJournal.complete: its presence on a
 * row means the stage's remote write completed with a verified receipt and
 * the exact resume payload was committed in the same transaction.
 */
interface RowContinuation {
	pstackContinuation: true;
	stage: string;
	data: unknown;
}

export function continuationState(stage: string, data: unknown): string {
	return JSON.stringify({ pstackContinuation: true, stage, data });
}

export function parseContinuation<T>(run: Pick<BennyRunRow, "stage" | "state">): { stage: string; data: T } | null {
	if (!run.state) return null;
	try {
		const value = JSON.parse(run.state) as Partial<RowContinuation>;
		if (value?.pstackContinuation !== true || typeof value.stage !== "string" || value.stage !== run.stage) return null;
		return { stage: value.stage, data: value.data as T };
	} catch {
		return null;
	}
}

function isSafeCheckpointStage(stage: string): boolean {
	return SAFE_CHECKPOINT_STAGES[stage] === true || stage.startsWith("marker-wait");
}


/**
 * Atomically requeue a dead-owner run: the dead-owner recheck and BOTH
 * owner-predicated updates (phase row and shared-checkout row) commit in one
 * BEGIN IMMEDIATE transaction, so an observer never sees the phase row queued
 * while the checkout is still held by a dead owner (which would block every
 * future claim), and a concurrent reconciler or a newly acquired live owner
 * can never be overwritten mid-update.
 */
function requeueBennyRun(db: Database, run: BennyRunRow, diagnostic: string): boolean {
	db.run("BEGIN IMMEDIATE");
	try {
		const current = getBennyRun(db, run.id);
		if (!current || current.status !== "running") {
			db.run("COMMIT");
			return false; // settled elsewhere; picked up by the next scan
		}
		if (ownedByThisProcess(current.owner_pid, current.owner_boot)) {
			db.run("COMMIT");
			return false;
		}
		if (ownerIncarnationAlive(current.owner_pid, current.owner_boot)) {
			db.run("COMMIT");
			return false; // a live foreign owner acquired it between scans
		}
		const lockRow = getRun(db, current.run_id);
		let lockRequeued = { changes: 1 };
		if (lockRow) {
			if (lockRow.status !== "running" || ownedByThisProcess(lockRow.owner_pid, lockRow.owner_boot) || ownerIncarnationAlive(lockRow.owner_pid, lockRow.owner_boot)) {
				db.run("COMMIT");
				return false;
			}
			lockRequeued = db.run(
				"UPDATE runs SET status = 'queued', diagnostic = ?, owner_pid = NULL, owner_boot = NULL, finished_at = NULL WHERE id = ? AND status = 'running'",
				[diagnostic, current.run_id],
			);
		}
		const rowRequeued = db.run(
			"UPDATE benny_runs SET status = 'queued', diagnostic = ?, owner_pid = NULL, owner_boot = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
			[diagnostic, Date.now(), current.id],
		);
		if (rowRequeued.changes !== 1 || lockRequeued.changes !== 1) {
			db.run("ROLLBACK");
			return false;
		}
		db.run("COMMIT");
		return true;
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/**
 * Graceful-shutdown release: the CURRENT owner (verified by the owner
 * predicate) puts its running row back to queued so startup recovery can
 * claim it and reconcile any open/uncertain journal write through the
 * reconcile-only replay. Never a terminal settlement of acknowledged
 * admitted work; safe checkpoints and continuation stages stay resumable.
 */
export function releaseBennyRunForRecovery(db: Database, run: Pick<BennyRunRow, "id" | "run_id">, diagnostic: string): boolean {
	db.run("BEGIN IMMEDIATE");
	try {
		const rowReleased = db.run(
			"UPDATE benny_runs SET status = 'queued', diagnostic = ?, owner_pid = NULL, owner_boot = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_boot IN (?, ?)",
			[diagnostic, Date.now(), run.id, process.pid, PROCESS_INCARNATION, BOOT_ID],
		);
		const lockReleased = db.run(
			"UPDATE runs SET status = 'queued', diagnostic = ?, owner_pid = NULL, owner_boot = NULL, finished_at = NULL WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_boot IN (?, ?)",
			[diagnostic, run.run_id, process.pid, PROCESS_INCARNATION, BOOT_ID],
		);
		if (rowReleased.changes !== 1 && lockReleased.changes !== 1) {
			db.run("ROLLBACK");
			return false;
		}
		db.run("COMMIT");
		return true;
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/**
 * Crash recovery: a benny row left running by a dead owner is reconciled.
 * An unresolved journal row (open OR uncertain) is a durable pre-dispatch
 * continuation — its kind/action_id/input fully identify the mutating call —
 * so the run REQUEUES for reconcile-only replay (the driver routes each row
 * back to the same action's reconcile path, never a blind resend). Rows
 * without unresolved writes requeue at an explicitly safe checkpoint OR at a
 * stage whose verified remote write completed with a journal continuation
 * (the next idempotent action resumes from the done receipt) — everything
 * else blocks with the exact ambiguity, never a blind rerun of mutating work.
 */

export function reconcileBennyRuns(db: Database): number[] {
	// Expiry is terminal everywhere: queued rows whose persisted deadline has
	// passed are blocked as unexecuted expiry at startup reconciliation, not
	// only at claim time. An expired row must never sit claimable forever.
	const expiredNow = Date.now();
	for (const expired of db.query("SELECT * FROM benny_runs WHERE status = 'queued' AND deadline_ms <= ?").all(expiredNow) as BennyRunRow[]) {
		try {
			settleBennyRun(db, expired, "blocked", "run deadline expired while queued; never executed", []);
		} catch {
			// A live foreign owner's checkout row refuses settlement. Its own
			// claimant sweeps the row atomically with its next claim.
		}
	}
	const rows = db.query("SELECT * FROM benny_runs WHERE status = 'running'").all() as BennyRunRow[];
	const recovered: number[] = [];
	for (const row of rows) {
		if (ownedByThisProcess(row.owner_pid, row.owner_boot)) continue;
		const lockRow = getRun(db, row.run_id);
		if (lockRow?.status !== "running") {
			settleBennyRun(db, row, "interrupted", "owner process died; the checkout row was already settled");
			recovered.push(row.id);
			continue;
		}
		if (ownedByThisProcess(lockRow.owner_pid, lockRow.owner_boot)) continue;
		if (ownerIncarnationAlive(lockRow.owner_pid, lockRow.owner_boot)) continue;
		const unresolved = db
			.query("SELECT action_id, reason FROM benny_journal WHERE run_id = ? AND state != 'done'")
			.all(row.id) as Array<{ action_id: string; reason: string }>;
		if (unresolved.length > 0) {
			if (
				requeueBennyRun(
					db,
					row,
					`owner died with unresolved writes: ${unresolved.map((u) => `${u.action_id} (${u.reason ?? "open intent"})`).join("; ")} — requeued for reconcile-only replay before any stage dispatch`,
				)
			) {
				recovered.push(row.id);
			}
			continue;
		}
		if (isSafeCheckpointStage(row.stage) || (CONTINUATION_STAGES[row.stage] === true && parseContinuation(row) !== null)) {
			if (requeueBennyRun(db, row, "owner died at a safe checkpoint; requeued")) recovered.push(row.id);
			continue;
		}
		settleBennyRun(db, row, "interrupted", `owner died at stage '${row.stage}'; external actions may be unresolved — reconcile the action journal`);
		recovered.push(row.id);
	}
	return recovered;
}

/** Coordinator-side action journal: durable intent before dispatch, receipts after readback. */
export class BennyJournal implements ActionJournal {
	constructor(
		private readonly db: Database,
		private readonly runId: number,
	) {}

	begin(id: string, kind: string, input: unknown): { state: "new" | "done" | "uncertain"; receipt?: RemoteReceipt } {
		const now = Date.now();
		const inserted = this.db.run(
			`INSERT INTO benny_journal (action_id, run_id, kind, input, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)
			 ON CONFLICT(action_id) DO NOTHING`,
			[id, this.runId, kind, JSON.stringify(input ?? null), now, now],
		);
		// Only a freshly inserted row is this call's intent; a pre-existing open
		// row is a durable intent from an earlier dispatch whose outcome is
		// unknown — reconcile-only, never a blind re-dispatch.
		if (Number(inserted.changes) === 1) return { state: "new" };
		const row = this.db.query("SELECT state, receipt FROM benny_journal WHERE action_id = ?").get(id) as
			| { state: "open" | "done" | "uncertain"; receipt: string | null }
			| undefined;
		if (row?.state === "done" && row.receipt) return { state: "done", receipt: JSON.parse(row.receipt) as RemoteReceipt };
		return { state: "uncertain" };
	}

	complete(id: string, receipt: RemoteReceipt, continuation?: ActionContinuation): void {
		// The receipt and the resume checkpoint commit in ONE transaction: a
		// process that dies between them leaves either the pre-dispatch world
		// (journal open → blocked) or a fully resumable continuation — never a
		// completed remote write whose continuation payload is missing.
		this.db.run("BEGIN IMMEDIATE");
		try {
			this.db.run("UPDATE benny_journal SET state = 'done', receipt = ?, updated_at = ? WHERE action_id = ?", [
				JSON.stringify(receipt),
				Date.now(),
				id,
			]);
			if (continuation) {
				// Best-effort continuation: the receipt is the durable truth; a
				// run row that already settled keeps it and reconciliation
				// treats the stage as unsafe (blocked) instead of throwing away
				// a completed remote write.
				this.db.run("UPDATE benny_runs SET stage = ?, state = ?, updated_at = ? WHERE id = ? AND status = 'running'", [
					continuation.stage,
					continuation.state,
					Date.now(),
					this.runId,
				]);
			}
			this.db.run("COMMIT");
		} catch (error) {
			this.db.run("ROLLBACK");
			throw error;
		}
	}

	peek(id: string): { state: "open" | "done" | "uncertain"; receipt?: RemoteReceipt } | undefined {
		const row = this.db.query("SELECT state, receipt FROM benny_journal WHERE action_id = ?").get(id) as
			| { state: "open" | "done" | "uncertain"; receipt: string | null }
			| undefined;
		if (!row) return undefined;
		if (row.state === "done" && row.receipt) return { state: "done", receipt: JSON.parse(row.receipt) as RemoteReceipt };
		return { state: row.state };
	}
	uncertain(id: string, reason: string): void {
		this.db.run("UPDATE benny_journal SET state = 'uncertain', reason = ?, updated_at = ? WHERE action_id = ?", [reason, Date.now(), id]);
	}
}

// ---------------------------------------------------------------------------
// Enabled state: profile-private runtime storage — never the committed
export interface EnableState {
	enabled: boolean;
	configHash?: string;
	repoRevision?: string;
	/** Resolved immutable workspace image id at enable/canary time, when the sibling setup flow recorded it. */
	imageId?: string;
	canaryEventId?: string;
	enabledAt?: number;
}

export function readBennyState(target: string): EnableState | undefined {
	// Enablement lives ONLY in the profile's workspace-namespaced private
	// state: a path inside the repo would let committed or planted repo
	// content carry enable authority, so repo-local state is not authority.
	const path = join(profileWorkspaceDir(target, "benny-state"), "benny-state.json");
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch {
		return undefined; // no state file: default-disabled
	}
	// A planted symlink must never redirect the private enabled state;
	if (st.isSymbolicLink() || !st.isFile()) return undefined;
	try {
		const state = JSON.parse(readFileSync(path, "utf8")) as EnableState;
		// Shape-validate every binding field: a corrupted or tampered state
		// file must disable, never half-enable with wrong-typed bindings.
		if (
			typeof state.enabled !== "boolean" ||
			!(state.configHash === undefined || typeof state.configHash === "string") ||
			!(state.repoRevision === undefined || typeof state.repoRevision === "string") ||
			!(state.imageId === undefined || typeof state.imageId === "string")
		) {
			return undefined;
		}
		return state;
	} catch {
		return undefined;
	}
}

export function writeBennyState(target: string, state: EnableState): void {
	const path = join(profileWorkspaceDir(target, "benny-state"), "benny-state.json");
	// profileWorkspaceDir already created the directory securely (0700).
	// Atomic exclusive write: a private 0600 temp file, then rename over the
	// target. rename never follows a planted symlink — it replaces the link.
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(tmp, "wx", 0o600);
		writeSync(fd, `${JSON.stringify(state, null, "\t")}\n`);
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, path);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort temp cleanup
		}
		throw error;
	}
}

/**
 * The dirty-worktree half of the revision binding: HEAD equality alone cannot
 * see uncommitted edits to behavior-bearing content made after a canary. The
 * complete operational set — the installed Benny pack (operational SKILL.md
 * files, references, templates), the tracker adapter, feature map and routing
 * map — must be exactly tracked and unmodified. Returns null when clean,
 * otherwise the refusal reason.
 */
export function bennyWorktreeDrift(target: string, config: BennyConfig): string | null {
	const files = [config.control.feature_map_path, config.routing.map_path];
	const directories = [join(".omp", "automations", "benny")];
	const paths = [...files, ...directories];
	const status = Bun.spawnSync(gitIsolatedArgv(["-C", target, "status", "--porcelain", "--", ...paths]), {
		stdout: "pipe",
		stderr: "pipe",
		env: gitIsolationEnv(),
	});
	if (status.exitCode !== 0) {
		return `cannot verify tracked worktree cleanliness for ${target}: ${status.stderr.toString().trim()}`;
	}
	const dirty = status.stdout.toString().split("\n").filter(Boolean);
	if (dirty.length > 0) {
		return `behavior-bearing files are modified or untracked; commit or revert before admission:\n${dirty.join("\n")}`;
	}
	// `git status` stays silent for ignored files: a repo-planted ignored
	// adapter would slip through. Require every bound file to be exactly
	// tracked and every bound directory to have tracked content.
	const tracked = Bun.spawnSync(gitIsolatedArgv(["-C", target, "ls-files", "--", ...paths]), {
		stdout: "pipe",
		stderr: "pipe",
		env: gitIsolationEnv(),
	});
	if (tracked.exitCode !== 0) {
		return `cannot verify tracked files for ${target}: ${tracked.stderr.toString().trim()}`;
	}
	const trackedPaths = new Set(tracked.stdout.toString().split("\n").filter(Boolean));
	const missingFiles = files.filter((path) => !trackedPaths.has(path));
	const missingDirectories = directories.filter((directory) => ![...trackedPaths].some((path) => path === directory || path.startsWith(`${directory}/`)));
	const missing = [...missingFiles, ...missingDirectories];
	if (missing.length > 0) {
		return `behavior-bearing files are not exactly tracked (ignored, untracked or missing): ${missing.join(", ")}`;
	}
	return null;
}

/**
 * The single admission gate both transports (external CLI and Socket Mode)
 * share: enabled=true in private runtime storage, the stored config hash and
 * repository revision still equal the live values, and the tracked worktree
 * is clean. With `currentImageId` (the caller's live resolution of
 * runtime.workspace_image), the persisted image binding must match exactly.
 * Any drift throws an exact BennyError so admission can never proceed
 * silently against changed configuration, code, or image bytes.
 */
export function assertBennyEnabled(target: string, config: BennyConfig, currentImageId?: string): EnableState {
	const state = readBennyState(target);
	if (state?.enabled !== true) {
		throw new BennyError(2, "Benny is not enabled for this target; admission refuses to start");
	}
	const hash = bennyConfigHash(config);
	if (state.configHash !== hash) {
		throw new BennyError(
			2,
			`Benny was enabled for config hash ${state.configHash?.slice(0, 12) ?? "(missing)"}… but the current configuration hashes to ${hash.slice(0, 12)}…; rerun \`${pstackCommand("benny", "enable")}\``,
		);
	}
	const revision = bennyRepoRevision(target);
	if (state.repoRevision !== revision) {
		throw new BennyError(
			2,
			`Benny was enabled at repository revision ${state.repoRevision?.slice(0, 12) ?? "(missing)"}… but HEAD is now ${revision.slice(0, 12)}…; rerun \`${pstackCommand("benny", "enable")}\``,
		);
	}
	// The enable flow binds the resolved immutable workspace image id; with a
	// live resolution supplied, admission rejects any retarget (or a legacy
	// state file without one) instead of re-resolving fresh bytes.
	if (currentImageId !== undefined) {
		if (!state.imageId) {
			throw new BennyError(2, `Benny enable state carries no workspace image id; rerun \`${pstackCommand("benny", "enable")}\` against the resolved image`);
		}
		if (state.imageId !== currentImageId) {
			throw new BennyError(
				2,
				`Benny was enabled on workspace image ${state.imageId.slice(0, 16)}… but the reference now resolves to ${currentImageId.slice(0, 16)}…; rerun the canary and \`${pstackCommand("benny", "enable")}\``,
			);
		}
	}
	const drift = bennyWorktreeDrift(target, config);
	if (drift) {
		throw new BennyError(2, `Benny admission requires a clean tracked worktree; ${drift}`);
	}
	return state;
}

export interface CanaryEligibility {
	eligible: boolean;
	reason?: string;
}

/** Main's exact canaryEvidence receipt arrays per phase (mirrors benny-run's recordCanary). */
const CANARY_PHASE_RECEIPTS: Record<Phase, string[]> = {
	triage: ["slack.verdict.readback", "tracker.mutation.readback"],
	reproduce: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"],
};

interface CanaryObserved {
	freshlyExecuted?: unknown;
	results?: Array<{ phase?: unknown; status?: unknown; diagnostic?: unknown; canaryEvidence?: unknown }>;
}

/**
 * A passed=1 flag alone is not trust: the recorded evidence must show the
 * canary was freshly executed and that each phase carried its exact
 * readback receipts with no diagnostic. Returns the gap or undefined.
 */
function canaryEvidenceGap(observed: CanaryObserved): string | undefined {
	if (observed.freshlyExecuted !== true) return "recorded canary was not freshly executed";
	if (!Array.isArray(observed.results)) return "recorded canary evidence has no phase results";
	for (const [phase, required] of Object.entries(CANARY_PHASE_RECEIPTS)) {
		const ok = observed.results.some(
			(item) =>
				item.phase === phase &&
				item.status === "succeeded" &&
				item.diagnostic === undefined &&
				required.every((receipt) => Array.isArray(item.canaryEvidence) && item.canaryEvidence.includes(receipt)),
		);
		if (!ok) return `recorded canary ${phase} phase lacks required readback receipts: ${required.join(", ")}`;
	}
	return undefined;
}

export function canaryEligible(target: string, config: BennyConfig, currentImageId?: string): CanaryEligibility {
	const drift = bennyWorktreeDrift(target, config);
	if (drift) return { eligible: false, reason: drift };
	const hash = bennyConfigHash(config);
	const revision = bennyRepoRevision(target);
	const db = openRunStore(target);
	openBennyStore(db);
	try {
		const row = db
			.query("SELECT observed, image_id FROM benny_canary WHERE config_hash = ? AND repo_revision = ? AND passed = 1 ORDER BY at DESC LIMIT 1")
			.get(hash, revision) as { observed: string; image_id: string } | undefined;
		if (!row) {
			return { eligible: false, reason: `no passing canary recorded for config hash ${hash.slice(0, 12)}… at revision ${revision.slice(0, 12)}…` };
		}
		const imageGap = canaryImageMismatch(row.image_id, currentImageId);
		if (imageGap) return { eligible: false, reason: imageGap };
		let observed: CanaryObserved;
		try {
			observed = JSON.parse(row.observed) as CanaryObserved;
		} catch {
			return { eligible: false, reason: "recorded canary evidence is not readable JSON" };
		}
		const gap = canaryEvidenceGap(observed);
		return gap ? { eligible: false, reason: gap } : { eligible: true };
	} finally {
		db.close();
	}
}

/**
 * With `currentImageId` supplied (the enable/canary flow resolves the live
 * workspace reference first), a passing canary only counts when its recorded
 * immutable image id matches exactly: a retagged or repulled workspace image
 * is different bytes and must re-pass the canary.
 */
function canaryImageMismatch(recordedImageId: string, currentImageId: string | undefined): string | undefined {
	if (currentImageId === undefined) return undefined;
	if (!recordedImageId) return "recorded canary carries no workspace image id; rerun the canary against the resolved image";
	if (recordedImageId !== currentImageId) {
		return `recorded canary ran on image ${recordedImageId.slice(0, 16)}… but the workspace image now resolves to ${currentImageId.slice(0, 16)}…; rerun the canary`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Restricted SDK sessions: the only model surface the coordinator allows
// ---------------------------------------------------------------------------

export interface RestrictedSession {
	prompt(text: string, images?: ImageContent[]): Promise<string>;
	session: AgentSession;
	dispose(): Promise<void>;
}

export interface SessionOptions {
	cwd: string;
	model: string;
	deadline: number;
	tools?: CustomTool[];
	signal?: AbortSignal;
}

/** Validate a configured selector against actually available, authenticated models. */
export function resolveConfiguredModel(selector: string, registry: ModelRegistry): { model: Model } {
	const bare = selector.split(":")[0];
	const available = registry.getAvailable();
	const model = resolveModelFromString(selector, available);
	if (!model || `${model.provider}/${model.id}` !== bare) {
		throw new BennyConfigError(`model '${selector}' is unavailable; rerun /setup-pstack`);
	}
	if (!registry.hasConfiguredAuth(model)) {
		throw new BennyConfigError(`no credentials for model '${selector}'`);
	}
	return { model };
}

/**
 * Exact authenticated checks for all four Benny model roles. No fuzzy
 * matching: every selector must resolve to an available model whose
 * provider/id identity matches exactly, with configured credentials.
 */
const BENNY_MODEL_ROLES = ["triage", "reproduce", "code", "media_review"] as const;

export function validateBennyModels(config: BennyConfig, registry: ModelRegistry): void {
	for (const role of BENNY_MODEL_ROLES) {
		try {
			resolveConfiguredModel(config.models[role], registry);
		} catch (error) {
			throw new BennyConfigError(`model role '${role}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** The process-wide authenticated model registry used by coordinator sessions and preflight. */
export async function sharedModelRegistry(): Promise<ModelRegistry> {
	return (await modelsOnce()).registry;
}

interface SharedModels {
	authStorage: AuthStorage;
	registry: ModelRegistry;
}

let sharedModels: Promise<SharedModels> | undefined;

/**
 * The SDK requires `createAgentSession` to receive the SAME authStorage
 * instance its modelRegistry was built with, so the pair is cached together.
 * A failed init clears the cache so a later call can retry instead of
 * replaying the rejected promise forever.
 */
function modelsOnce(): Promise<SharedModels> {
	sharedModels ??= (async () => {
		const authStorage = await discoverAuthStorage();
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		return { authStorage, registry };
	})().catch((error: unknown) => {
		sharedModels = undefined;
		throw error;
	});
	return sharedModels;
}

/**
 * A restricted Benny session: explicit tools only, no ambient extensions,
 * MCP, LSP, IRC, or skills. The operational SKILL.md body arrives as context,
 * never as a discovered skill.
 */
export async function openBennySession(options: SessionOptions): Promise<RestrictedSession> {
	const { cwd, model: selector, deadline, tools = [], signal } = options;
	// REL-SOCKET-002: a signal that fired before any await must never
	// create a coordinator session at all.
	if (signal?.aborted) throw new BennyError(1, "shutdown; refusing to create a Benny session after abort");
	const { authStorage, registry } = await modelsOnce();
	const { model } = resolveConfiguredModel(selector, registry);
	const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false });
	const sessionManager = SessionManager.create(cwd, securePrivateDir(cwd, ".omp", "pstack", "state", "benny", "sessions"));
	const created = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry: registry,
		model,
		settings,
		sessionManager,
		deadline,
		toolNames: tools.map((tool) => tool.name),
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		customTools: tools,
		disableExtensionDiscovery: true,
		enableLsp: false,
		enableIrc: false,
		skills: [],
		// Explicit empty ambient context: no AGENTS.md context files, rules,
		// prompt templates, file-backed slash commands, or MCP discovery can
		// leak into a coordinator session — the only surface is the bound
		// prompt and the explicit tools.
		contextFiles: [],
		rules: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		agentRegistry: new AgentRegistry(),
	});
	// CreateAgentSessionOptions has no signal; shutdown aborts in-flight model
	// calls through the session API instead. The abort check is repeated
	// AFTER the async creation: shutdown racing creation aborts and disposes
	// the session immediately instead of leaving it running to its deadline.
	const onSessionAbort = (): void => void created.session.abort().catch(() => undefined);
	if (signal) {
		if (signal.aborted) {
			onSessionAbort();
			try {
				await created.session.dispose();
			} catch {
				// the shutdown error below is what the caller must see
			}
			throw new BennyError(1, "shutdown; Benny session aborted during creation");
		}
		signal.addEventListener("abort", onSessionAbort, { once: true });
	}
	return {
		session: created.session,
		async prompt(text: string, images?: ImageContent[]): Promise<string> {
			await created.session.prompt(text, images ? { images } : undefined);
			await created.session.waitForIdle();
			const messages: unknown[] = [...created.session.messages];
			for (let index = messages.length - 1; index >= 0; index--) {
				const message: unknown = messages[index];
				if (message !== null && typeof message === "object" && (message as Record<string, unknown>).role === "assistant") {
					const content = (message as Record<string, unknown>).content;
					return Array.isArray(content)
						? content
								.map((block) =>
									block !== null && typeof block === "object" && (block as Record<string, unknown>).type === "text"
										? String((block as Record<string, unknown>).text ?? "")
										: "",
								)
								.join("\n")
						: "";
				}
			}
			return "";
		},
		async dispose(): Promise<void> {
			signal?.removeEventListener("abort", onSessionAbort);
			try {
				await created.session.dispose();
			} catch {
				// disposal failure must not mask the phase result
			}
		},
	};
}

/** Parse the model's JSON reply with a strict schema; one retry, then fail closed. */
export async function askStructured<T>(session: RestrictedSession, prompt: string, schema: z.ZodType<T>): Promise<T> {
	let text = await session.prompt(prompt);
	let issue = "no JSON object";
	for (let attempt = 0; attempt < 2; attempt++) {
		const match = text.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				const parsed = schema.safeParse(JSON.parse(match[0]));
				if (parsed.success) return parsed.data;
				issue = parsed.error.issues.map((entry) => `${entry.path.join(".") || "response"}: ${entry.message}`).join("; ");
			} catch {
				issue = "malformed JSON object";
			}
		}
		if (attempt === 0) {
			text = await session.prompt(`Your previous reply was invalid (${issue}). Respond with ONLY the JSON object matching the requested shape.`);
		}
	}
	throw new Error(`model did not return a valid structured decision (${issue}); failing closed`);
}

// ---------------------------------------------------------------------------
// Deterministic action IDs
// ---------------------------------------------------------------------------


/** Deterministic action IDs: stable across retries and process restarts. */
export function actionId(runId: number, kind: string, sequence: number): string {
	return `benny-${runId}-${kind}-${sequence}-${createHash("sha256").update(`${runId}:${kind}:${sequence}`).digest("hex").slice(0, 8)}`;
}
