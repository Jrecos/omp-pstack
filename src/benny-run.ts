/**
 * Benny phase execution: the deterministic coordinator that advances persisted
 * and authorizes every remote write.
 *
 * Actions journal their own intents (the actions layer owns begin/reconcile
 * semantics per actionId); the coordinator decides WHEN a write may happen,
 * never the model. Safe checkpoints are 'admitted', 'marker-wait',
 * 'rejection-wait' and triage's 'followup' — the only stages a recovered run
 * may resume from.
 */
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import type { CustomTool, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	ActionFailure,
	BennyJournal,
	PHASES,
	actionId,
	admitBennyEvent,
	askStructured,
	bennyConfigHash,
	bennyRepoRevision,
	bennyWorktreeDrift,
	canaryEligible,
	claimBennyRun,
	configBlobBindingProblem,
	continuationState,
	gitIsolatedArgv,
	gitIsolationEnv,
	loadBennyConfig,
	openBennyStore,
	openBennySession,
	assertBennyEnabled,
	parkBennyRun,
	parseContinuation,
	readBennyState,
	releaseBennyRunForRecovery,
	reconcileBennyRuns,
	recordBennyStage,
	settleBennyRun,
	targetRootFor,
	trustedVerdict,
	type BennyBinding,
	type BennyConfig,
	type BennyRunRow,
	type BennyRunStatus,
	type Phase,
	type RestrictedSession,
	type SelectedEvent,
	type SessionOptions,
} from "./benny.ts";
import { openRunStore, securePrivateDir, stateDir } from "./runner.ts";
import { CanceledStateMissingError, createBennyActions, gitCredentialHelperScript, parseGitHubRepository, rootDigest, type BennyActions } from "./benny-actions.ts";
import { pstackCommand } from "./cli-launch.ts";
import {
	WorkspaceBlockError,
	createBennyWorkspace,
	readPublishedEvidence,
	reclaimBennyRunResources,
	resolveImageId,
	reviewMedia,
	sweepExpiredEvidence,
	type BennyWorkspace,
	type ControlReceipt,
} from "./benny-workspace.ts";
import {
	canCreateDraft,
	selectBennyEvent,
	parseRoutingRoutes,
	routingMentionIds,
	type ActionContinuation,
	type DraftProof,
	type RemoteReceipt,
	type RoutingRoutes,
	type SlackMessage,
	type TrialReceipt,
} from "./benny-policy.ts";
import type { TrackerCategory } from "./trackers/contract.ts";

export interface BennyRunResult {
	phase: Phase;
	status: BennyRunStatus;
	duplicate: boolean;
	stage?: string;
	diagnostic?: string;
	actions: string[];
	canaryEvidence?: string[];
}

export interface BennyOutcome {
	admitted: boolean;
	eventId?: string;
	results: BennyRunResult[];
	diagnostic?: string;
	/** Canary truth: present only for canary invocations; success requires admitted + freshly executed + receipt-complete persisted pass. */
	canary?: CanaryResult;
}

export interface CanaryResult {
	passed: boolean;
	reason?: string;
}

export class BennyError extends Error {
	constructor(
		readonly exitCode: 1 | 2 | 64,
		message: string,
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Structured decisions the model must return; anything else fails closed
const TriageDecision = z.object({
	category: z.enum(["bug", "performance", "feature", "question", "reroute"]),
	verdict_text: z.string().min(1).max(8000),
	tracker_query: z.string().max(300).optional(),
	/** The routing-map route the model matched, by exact name; absent means the fallback owners apply. */
	route: z.string().max(120).optional(),
	create: z
		.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(8000) })
		.nullable(),
});
export type TriageDecision = z.infer<typeof TriageDecision>;

const DedupeDecision = z.object({
	outcome: z.enum(["confident-duplicate", "possible", "net-new"]),
	issue_id: z.string().max(64).optional(),
});
type DedupeDecision = z.infer<typeof DedupeDecision>;

const GateDecision = z.object({
	owned: z.boolean(),
	ownership_reason: z.string().max(1000),
	existing_fix_ref: z.string().max(120).nullable(),
});
type GateDecision = z.infer<typeof GateDecision>;

const ObservedDecision = z.object({ observed: z.enum(["broken", "correct"]) });

const RejectionDecision = z.object({ rejected: z.boolean(), reason: z.string().max(1000) });

const OperationsDecision = z.object({
	kind: z.enum(["none", "question", "correction", "stop"]),
	reply: z.string().max(1500),
	correction: z.string().max(1500),
});
const ReproPlan = z
	.object({
		feature: z.string().min(1).max(200),
		steps: z
			.array(
				z.object({
					id: z.string().min(1).max(40),
					capability: z.enum(["drive-ui", "drive-features", "inspect-state"]),
					input: z.record(z.string(), z.unknown()),
					description: z.string().max(400),
				}),
			)
			.min(1)
			.max(24),
		reset: z.object({ input: z.record(z.string(), z.unknown()) }),
		discriminating_state: z.string().min(1).max(1000),
		expected_state: z.string().min(1).max(1000),
		state_check: z.object({ key: z.string().min(1).max(100), broken: z.string().max(300), correct: z.string().max(300) }),
	})
	.refine((plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length, {
		message: "step ids must be unique",
	});
export type ReproPlan = z.infer<typeof ReproPlan>;

const BlastRadiusDecision = z.object({
	passed: z.boolean(),
	checks: z.array(z.string().max(400)).min(1).max(20),
});

const FixResult = z.object({
	summary: z.string().min(1).max(4000),
	changed_files: z.array(z.string().min(1).max(400)).min(1).max(50),
	tests_run: z.array(z.string().max(200)).max(20),
	commit_message: z.string().min(1).max(200),
});
type FixResult = z.infer<typeof FixResult>;

// ---------------------------------------------------------------------------
// Explicit tools for restricted sessions
// ---------------------------------------------------------------------------

function textResult(text: string, images: ImageContent[] = []): { content: Array<{ type: "text"; text: string } | ImageContent> } {
	return { content: [{ type: "text", text }, ...images] };
}

function actionsTool(actions: BennyActions): ToolDefinition {
	const params = Type.Object({
		op: Type.Union([
			Type.Literal("read_root"),
			Type.Literal("read_thread"),
			Type.Literal("permalink"),
			Type.Literal("download"),
			Type.Literal("tracker_resolve"),
			Type.Literal("tracker_search"),
			Type.Literal("tracker_read"),
		]),
		file_id: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()),
		id: Type.Optional(Type.String()),
	});
	return {
		name: "benny_actions",
		label: "Benny actions (read-only)",
		description:
			"Read-only access to the bound Slack source thread and tracker. Ops: read_root, read_thread, permalink, download(file_id), tracker_resolve, tracker_search(query), tracker_read(id). No write operation exists.",
		parameters: params,
		async execute(_id, p: Static<typeof params>) {
			try {
				switch (p.op) {
					case "read_root":
						return textResult(JSON.stringify(await actions.readRoot()));
					case "read_thread":
						return textResult(JSON.stringify(await actions.readThread()));
					case "permalink":
						return textResult(await actions.permalink());
					case "download": {
						if (!p.file_id) return textResult("download requires file_id");
						const file = await actions.download(p.file_id);
						const images: ImageContent[] = [];
						if (file.mimeType.startsWith("image/")) {
							try {
								const data = readFileSync(file.path);
								images.push({ type: "image", data: Buffer.from(data).toString("base64"), mimeType: file.mimeType });
							} catch {
								return textResult(`attachment metadata (bytes unreadable): ${JSON.stringify(file)}`);
							}
						}
						return {
							content: [
								{
									type: "text",
									text: file.mimeType.startsWith("video/")
										? `video attachment ${JSON.stringify(file)}; its frames are reviewed separately by the independent media reviewer`
										: `attachment: ${JSON.stringify(file)}`,
								},
								...images,
							],
						};
					}
					case "tracker_resolve":
						return textResult(JSON.stringify(await actions.trackerResolve()));
					case "tracker_search":
						return textResult(JSON.stringify(await actions.trackerSearch(p.query ?? "")));
					case "tracker_read":
						return textResult(JSON.stringify(await actions.trackerRead(p.id ?? "")));
				}
			} catch (error) {
				return textResult(`action failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return textResult("unknown op");
		},
	};
}

/**
 * One abortable, byte-bounded git invocation: the run deadline and shutdown
 * signal race the process, and streaming output is killed the moment it
 * exceeds its hard cap — a hung or flooding git call can never park the
 * coordinator or exhaust memory. Git is launched in its own process group
 * (POSIX `setsid` via Bun's detached spawn), so a kill takes down descendant
 * transports (credential helpers, ssh, filter processes) too; platforms
 * without process groups fall back to killing the direct child only. The
 * process exit AND both output streams are awaited before returning, so no
 * orphaned transport can outlive the call while holding the coordinator's
 * pipes or the shutdown path.
 */
export async function gitBounded(
	args: readonly string[],
	options: { cwd?: string; deadlineMs: number; signal?: AbortSignal; maxBytes: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
	const remaining = options.deadlineMs - Date.now();
	if (remaining <= 0) throw new Error("deadline expired before git invocation");
	if (options.signal?.aborted) throw new Error("aborted before git invocation");
	const signals: AbortSignal[] = [AbortSignal.timeout(remaining)];
	if (options.signal) signals.push(options.signal);
	const composite = AbortSignal.any(signals);
	const proc = Bun.spawn(["git", ...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	// Negative PID signals the whole process group; the fallback covers
	// platforms/groups where the group signal is unsupported or already gone.
	const kill = (): void => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			try {
				proc.kill(9);
			} catch {
				// already exited
			}
		}
	};
	const onAbort = () => kill();
	composite.addEventListener("abort", onAbort, { once: true });
	// The abort transition can land during spawn, before this listener was
	// registered — an already-aborted signal never delivers the event, so
	// recheck synchronously and kill or the child survives shutdown.
	if (composite.aborted) onAbort();
	let overflow: Error | undefined;
	const read = async (stream: ReadableStream<Uint8Array> | undefined, what: string): Promise<Uint8Array> => {
		if (!stream) return new Uint8Array();
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (overflow) continue; // draining until stream closure; discard the excess
			total += value.byteLength;
			if (total > options.maxBytes) {
				overflow = new Error(`git ${args[0]} ${what} exceeded the ${options.maxBytes} byte bound`);
				kill();
				continue;
			}
			chunks.push(value);
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	};
	try {
		const [stdout, stderr] = await Promise.all([
			read(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
			read(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
		]);
		const code = await proc.exited;
		if (overflow) throw overflow;
		return { code, stdout, stderr };
	} finally {
		composite.removeEventListener("abort", onAbort);
	}
}

/**
 * PSTACK-SEC-GIT-005: every committed read in the target repository runs
 * with a scrubbed credential-free environment and replacement refs disabled,
 * so refs/replace can never substitute behavior bytes after admission.
 */
function gitReadEnv(): Record<string, string> {
	return { ...gitIsolationEnv(), GIT_NO_REPLACE_OBJECTS: "1" };
}

/** Read only committed Git objects. The model never traverses the host worktree or its symlinks. */
function repoTool(target: string, revision: string, deadlineMs: number, signal?: AbortSignal): ToolDefinition {
	const params = Type.Object({
		op: Type.Union([Type.Literal("read"), Type.Literal("grep"), Type.Literal("list")]),
		path: Type.Optional(Type.String()),
		pattern: Type.Optional(Type.String()),
	});
	const safePath = (candidate: string): string | null => {
		const normalized = candidate.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
		if (!normalized || normalized === ".") return "";
		if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) return null;
		return normalized;
	};
	const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
	const git = (args: string[], maxBytes: number) => gitBounded(args, { cwd: target, deadlineMs, signal, maxBytes, env: gitReadEnv() });
	const readBlob = async (path: string): Promise<Uint8Array | null> => {
		const entry = await git(["ls-tree", revision, "--", path], 256 * 1024);
		if (entry.code !== 0) return null;
		const match = /^(\d+)\s+blob\s+([0-9a-f]{40,64})\t/.exec(decode(entry.stdout));
		if (!match || match[1] === "120000") return null;
		const size = await git(["cat-file", "-s", match[2]!], 1024);
		if (size.code !== 0 || Number(decode(size.stdout).trim()) > 256 * 1024) return null;
		const blob = await git(["cat-file", "blob", match[2]!], 256 * 1024);
		return blob.code === 0 ? blob.stdout : null;
	};
	return {
		name: "benny_repo",
		label: "Target repo (read-only)",
		description: "Read-only access to committed files in the target repository. Ops: read(path), grep(pattern, path?), list(path?).",
		parameters: params,
		async execute(_id, p: Static<typeof params>) {
			try {
				const path = safePath(p.path ?? ".");
				if (path === null) return textResult("path is outside the committed repository or missing");
				if (p.op === "list") {
					const treeish = path ? `${revision}:${path}` : revision;
					const listed = await git(["ls-tree", "--name-only", treeish], 256 * 1024);
					return textResult(listed.code === 0 ? decode(listed.stdout).split("\n").slice(0, 200).join("\n") : "path is outside the committed repository or missing");
				}
				if (p.op === "read") {
					if (!path) return textResult("path is outside the committed repository or missing");
					const data = await readBlob(path);
					if (!data) return textResult("path is outside the committed repository, is a symlink, is missing, or exceeds the 256 KiB cap");
					const images: ImageContent[] = path.match(/\.(png|jpe?g|webp|gif)$/i)
						? [{ type: "image", data: Buffer.from(data).toString("base64"), mimeType: path.endsWith(".png") ? "image/png" : "image/jpeg" }]
						: [];
					return { content: [{ type: "text", text: decode(data) }, ...images] };
				}
				const pattern = p.pattern ?? "";
				if (!pattern) return textResult("grep requires pattern");
				const args = ["grep", "-n", "--max-count=5", "-e", pattern, revision, "--"];
				if (path) args.push(path);
				const found = await git(args, 1024 * 1024);
				return textResult(decode(found.stdout).slice(0, 16_000) || "no matches");
			} catch (error) {
				return textResult(`repo read failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

function readCommittedText(target: string, revision: string, path: string, maxBytes = 1024 * 1024): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
		throw new Error(`committed path is invalid: ${path}`);
	}
	const entry = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "ls-tree", revision, "--", normalized]), { stdout: "pipe", stderr: "pipe", env: gitReadEnv() });
	const match = /^(\d+)\s+blob\s+([0-9a-f]{40,64})\t/.exec(entry.stdout.toString("utf8"));
	if (entry.exitCode !== 0 || !match || match[1] === "120000") throw new Error(`committed file is missing or a symlink: ${path}`);
	const size = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "cat-file", "-s", match[2]!]), { stdout: "pipe", stderr: "pipe", env: gitReadEnv() });
	if (size.exitCode !== 0 || Number(size.stdout.toString("utf8").trim()) > maxBytes) throw new Error(`committed file exceeds ${maxBytes} bytes: ${path}`);
	const blob = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "cat-file", "blob", match[2]!]), { stdout: "pipe", stderr: "pipe", env: gitReadEnv() });
	if (blob.exitCode !== 0) throw new Error(`cannot read committed file: ${path}`);
	return blob.stdout.toString("utf8");
}

/**
 * Supported existing-fix remotes normalize to an authenticated HTTPS fetch
 * URL: already-HTTPS passes through verbatim; GitHub-style scp and ssh form
 * remotes become their HTTPS endpoint. Anything else cannot be fetched
 * without engaging ssh transports or target-local config, and is refused.
 */
export function httpsRemoteUrl(url: string): string | null {
	const raw = url.trim();
	if (/^https:\/\//i.test(raw)) return raw;
	const scp = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?$/.exec(raw);
	if (scp) return `https://${scp[1]}/${scp[2]}.git`;
	const ssh = /^ssh:\/\/git@([^/:?#]+)(?::\d+)?\/(.+?)(?:\.git)?$/.exec(raw);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
	return null;
}
/**
 * The exact credential helper script the existing-fix fetch installs: the
 * approved credential protocol/host derives from the already-normalized HTTPS
 * GitHub URL through the shared structural parser (SEC-REMOTE-001) — never a
 * duplicated parse here. Only exact HTTPS github.com credential requests can
 * receive a token; any other normalized origin (or empty stdin) yields a
 * helper that emits nothing, so the token can never leave for another host.
 */
export function existingFixCredentialScript(url: string): string {
	const httpsUrl = httpsRemoteUrl(url);
	let origin: { protocol: string; host: string } | undefined;
	try {
		const ref = httpsUrl ? parseGitHubRepository(httpsUrl) : null;
		if (ref?.protocol && ref.host) origin = { protocol: ref.protocol, host: ref.host };
	} catch {
		// Not the exact HTTPS github.com authority: no credential origin.
	}
	return gitCredentialHelperScript(origin);
}

async function ensureGitCommit(target: string, url: string, ref: string, deadline: number, signal?: AbortSignal): Promise<string> {
	if (!/^[0-9a-f]{40,64}$/i.test(ref)) throw new WorkspaceBlockError(`fix revision is not an immutable commit OID: ${ref}`);
	const oid = ref.toLowerCase();
	// Replace refs must never substitute for the verified commit during
	// identity checks in either repository.
	const identityEnv = gitReadEnv();
	const hasCommit = () => Bun.spawnSync(["git", "-C", target, "cat-file", "-e", `${oid}^{commit}`], { stdout: "ignore", stderr: "ignore", env: identityEnv }).exitCode === 0;
	if (!hasCommit()) {
		// SEC-GIT-001 / REL-FETCH-001: the target checkout's local config
		// (url.insteadOf rewrites, sshCommand, credential helpers, clean/smudge
		// filters, hooks) is never loaded for the network fetch. The commit is
		// fetched over the NORMALIZED HTTPS remote into a runner-owned bare
		// repo under a sanitized environment, then transferred as a bundle
		// created from a scratch-private temp ref pinned to the VERIFIED OID
		// (a raw detached OID is not an advertised bundle ref) and unbundled
		// with index-pack only — no target hooks, filters, rewrites or
		// helpers engage.
		if (!url) throw new WorkspaceBlockError("configuration repository.url is empty; cannot fetch the fix commit");
		const httpsUrl = httpsRemoteUrl(url);
		if (!httpsUrl) {
			throw new WorkspaceBlockError(
				`configuration repository.url '${url}' is not an HTTPS or supported GitHub SSH remote; the fix commit cannot be fetched over an authenticated HTTPS transport`,
			);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new WorkspaceBlockError("deadline expired before fetching fix commit");
		const scratch = mkdtempSync(join(tmpdir(), "benny-fetch-"));
		const fetchEnv: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: scratch,
			LANG: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ALLOW_PROTOCOL: "https",
			GIT_NO_REPLACE_OBJECTS: "1",
		};
		for (const key of [
			"SSL_CERT_FILE",
			"SSL_CERT_DIR",
			"HTTPS_PROXY",
			"https_proxy",
			"HTTP_PROXY",
			"http_proxy",
			"NO_PROXY",
			"no_proxy",
			// The approved GitHub token environment feeds ONLY the runner-owned
			// credential helper below; it never appears in argv, config values
			// or logs. Anonymous public fetches keep working when unset.
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
		]) {
			const value = process.env[key];
			if (value !== undefined) fetchEnv[key] = value;
		}
		const git = async (args: readonly string[], cwd: string | undefined, maxBytes: number): Promise<{ code: number; stdout: string; stderr: string }> => {
			const result = await gitBounded(args, { cwd, deadlineMs: deadline, signal, maxBytes, env: fetchEnv });
			return {
				code: result.code,
				stdout: Buffer.from(result.stdout).toString("utf8"),
				stderr: Buffer.from(result.stderr).toString("utf8"),
			};
		};
		try {
			const init = await git(["init", "--quiet", "--bare", "--template="], scratch, 64 * 1024);
			if (init.code !== 0) throw new WorkspaceBlockError(`cannot prepare the isolated fetch repository: ${init.stderr.trim().slice(0, 200)}`);
			const helper = join(scratch, "git-credential.sh");
			// SEC-REMOTE-001: the only credential path is the shared helper
			// script derived from the normalized HTTPS GitHub URL. It emits a
			// token only for exact HTTPS github.com credential requests; any
			// other fetch origin (or empty stdin) gets nothing.
			writeFileSync(helper, existingFixCredentialScript(httpsUrl), { mode: 0o700 });
			const quoted = helper.replace(/'/g, "'\\''");
			appendFileSync(join(scratch, "config"), `[credential]\n\thelper = !/bin/sh '${quoted}'\n`);
			// Full history fetch (no --depth: a shallow repo cannot create bundles).
			const fetch = await git(["fetch", "--no-tags", httpsUrl, oid], scratch, 64 * 1024 * 1024);
			if (fetch.code !== 0) throw new WorkspaceBlockError(`cannot fetch fix commit ${oid}: ${fetch.stderr.trim().slice(0, 200)}`);
			const rev = await git(["rev-parse", "FETCH_HEAD^{commit}"], scratch, 4 * 1024);
			if (rev.code !== 0) throw new WorkspaceBlockError(`fetched fix revision is not a commit: ${rev.stderr.trim().slice(0, 200)}`);
			const fetched = rev.stdout.trim().toLowerCase();
			if (fetched !== oid) {
				throw new WorkspaceBlockError(`the repository resolved the fix request to ${fetched || "<unreadable>"}, not the verified commit ${oid}`);
			}
			const tempRef = `refs/benny-fetch/${oid}`;
			const pinned = await git(["update-ref", tempRef, oid], scratch, 4 * 1024);
			if (pinned.code !== 0) throw new WorkspaceBlockError(`cannot pin the fetched fix commit ${oid}: ${pinned.stderr.trim().slice(0, 200)}`);
			const bundlePath = join(scratch, "fix.bundle");
			const bundle = await git(["bundle", "create", bundlePath, tempRef], scratch, 1024 * 1024);
			if (bundle.code !== 0) throw new WorkspaceBlockError(`cannot bundle fix commit ${oid}: ${bundle.stderr.trim().slice(0, 200)}`);
			const unbundle = await git(["bundle", "unbundle", bundlePath], target, 64 * 1024 * 1024);
			if (unbundle.code !== 0) throw new WorkspaceBlockError(`cannot transfer fix commit ${oid} into the target repository: ${unbundle.stderr.trim().slice(0, 200)}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	if (!hasCommit()) throw new WorkspaceBlockError(`fix commit ${oid} is unavailable after fetch`);
	return oid;
}
/** Workspace access with a coordinator-fixed stage; the model cannot widen it. */
function workspaceTool(workspace: BennyWorkspace, fixedStage: "study" | "reproduce" | "fix" | "verify", allowWrite: boolean): ToolDefinition {
	const params = Type.Object({
		action: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("exec")]),
		path: Type.Optional(Type.String()),
		content: Type.Optional(Type.String()),
		command: Type.Optional(Type.Array(Type.String())),
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		maxBytes: Type.Optional(Type.Number()),
	});
	return {
		name: "benny_workspace",
		label: "Disposable workspace",
		description:
			"The isolated run workspace. read(path), write(path, content) (fix stage only), exec(command argv, cwd?, timeoutMs?) — argv arrays only, never shell strings.",
		parameters: params,
		async execute(_id, p: Static<typeof params>) {
			try {
				const result = await workspace.call(p.action, p as unknown as Record<string, unknown>, fixedStage);
				return textResult(JSON.stringify(result));
			} catch (error) {
				const denied = !allowWrite && p.action === "write";
				return textResult(`${denied ? "writes are not permitted in this stage" : "workspace call failed"}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Pack content + shared helpers
// ---------------------------------------------------------------------------
/**
 * The admitted revision is the sole behavior source: the installed pack body
 * is always read from the committed blob at the run's repo revision — never
 * from the live worktree (editable, possibly symlinked) and never from a
 * fallback copy on disk.
 */
export function readBody(target: string, revision: string, relative: string): string {
	return readCommittedText(target, revision, `.omp/automations/benny/${relative}`);
}

/**
 * Route-scoped mention authorization. Blanket route-owner pings are gone:
 * an owner mention passes only with a host-established purpose. The only
 * purpose this system establishes is the feature-owner ping gate (global and
 * route flag) AND a category=feature decision needing owner input; every
 * other category authorizes nobody. The confirmed-regression-author purpose
 * has no independent identity producer (see reproduceMentionSet) and also
 * authorizes nobody. An unknown route name fails closed to zero pings. The
 * sink strips everything outside this set; the model can only narrow it.
 */
export function routeMentionAllowlist(
	config: BennyConfig,
	routes: RoutingRoutes | null,
	selectedRoute: string | undefined,
	mentionIds: ReadonlySet<string>,
	category: TriageDecision["category"],
): ReadonlySet<string> {
	if (!routes) return new Set();
	const route = selectedRoute ? routes.routes.find((entry) => entry.name === selectedRoute) : undefined;
	if (selectedRoute && !route) return new Set();
	const owners = route ? route.owners : routes.fallbackOwners;
	const routeFlag = route ? route.allowFeatureOwnerPing : routes.fallbackAllowFeatureOwnerPing;
	if (!(config.routing.allow_feature_owner_ping && routeFlag && category === "feature")) return new Set();
	return new Set(owners.filter((owner) => mentionIds.has(owner)));
}

/**
 * The triage sibling row's persisted mention allowlist, from the verdict
 * continuation or the follow-up checkpoint; empty when neither is readable.
 * Reproduce-phase source posts may mention only these. The admitted report
 * author is never added: deps.root.user is the untrusted Slack reporter, and
 * no independent regression-author identity producer exists in this system.
 */
function siblingMentionAllowlist(db: Database, run: Pick<BennyRunRow, "team_id" | "event_id">): Set<string> {
	const row = db
		.query("SELECT state FROM benny_runs WHERE team_id = ? AND event_id = ? AND phase = 'triage'")
		.get(run.team_id, run.event_id) as { state: string | null } | undefined;
	if (!row?.state) return new Set();
	try {
		const value = JSON.parse(row.state) as {
			pstackContinuation?: boolean;
			data?: { allowedUserIds?: unknown };
			allowedUserIds?: unknown;
		};
		const raw = value.pstackContinuation === true ? value.data?.allowedUserIds : value.allowedUserIds;
		if (!Array.isArray(raw)) return new Set();
		return new Set(raw.filter((id): id is string => typeof id === "string" && /^[UW][A-Z0-9]{5,}$/.test(id)));
	} catch {
		return new Set();
	}
}

/**
 * Reproduce-phase source-post allowlist: the triage sibling's persisted set,
 * and nothing else. This system has no independent regression-author identity
 * producer, so the confirmed-regression-author gate safely authorizes nobody;
 * it must never invent an identity from the reporter or any other untrusted
 * source. Exported for the focused regression tests.
 */
export function reproduceMentionSet(deps: Pick<RunDeps, "db" | "run">): Set<string> {
	return siblingMentionAllowlist(deps.db, deps.run);
}

/** The immutable tree OID of a commit in the target repository. Replace refs never substitute for the revision under identity checks. */
export function gitTreeOid(target: string, revision: string): string {
	const out = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "rev-parse", `${revision}^{tree}`]), { stdout: "pipe", stderr: "pipe", env: gitReadEnv() });
	const oid = out.stdout.toString("utf8").trim();
	if (out.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) {
		throw new BennyError(1, `cannot read the tree of revision ${revision}: ${out.stderr.toString().trim().slice(0, 200)}`);
	}
	return oid;
}

/**
 * The admitted OID is the sole behavior source: the run's config hash must
 * still match the loaded configuration and the admitted commit object must
 * still exist locally. A live HEAD that advanced past admission never blocks
 * execution, and no worktree state is consulted. Returns the refusal reason
 * or null.
 */
export function bennyBindingProblem(
	config: BennyConfig,
	target: string,
	run: Pick<BennyRunRow, "config_hash" | "repo_revision" | "image_id">,
): string | null {
	const liveHash = bennyConfigHash(config);
	if (!run.config_hash || run.config_hash !== liveHash) {
		return `admitted config hash ${run.config_hash || "<missing>"} does not match the loaded configuration (${liveHash.slice(0, 12)}…); refusing to execute`;
	}
	if (!/^[0-9a-f]{40,64}$/.test(run.repo_revision)) {
		return `admitted revision ${run.repo_revision || "<missing>"} is not an immutable commit OID; refusing to execute`;
	}
	if (!run.image_id) {
		return "admitted row carries no workspace image binding (legacy unbound admission); refusing to execute";
	}
	const exists = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "cat-file", "-e", `${run.repo_revision}^{commit}`]), { stdout: "ignore", stderr: "ignore", env: gitReadEnv() });
	if (exists.exitCode !== 0) {
		return `admitted revision ${run.repo_revision} is not a locally available commit object; refusing to execute`;
	}
	return null;
}

function threadText(messages: SlackMessage[]): string {
	return messages
		.map((message) => `${message.ts} user=${message.user ?? "?"}${message.bot_id ? ` bot=${message.bot_id}` : ""}: ${(message.text ?? "").slice(0, 2000)}`)
		.join("\n");
}
/** [REVIEW] Slack timestamps are decimal identifiers; Number() loses microsecond ordering. */
function slackTimestampAfter(candidate: string, boundary: string): boolean {
	const left = /^(\d+)\.(\d+)$/.exec(candidate);
	const right = /^(\d+)\.(\d+)$/.exec(boundary);
	if (!left || !right) return false;
	const leftSeconds = BigInt(left[1]!);
	const rightSeconds = BigInt(right[1]!);
	if (leftSeconds !== rightSeconds) return leftSeconds > rightSeconds;
	const width = Math.max(left[2]!.length, right[2]!.length);
	return left[2]!.padEnd(width, "0") > right[2]!.padEnd(width, "0");
}

/** Exactly one configured marker line; the model never writes the marker itself. */
function buildVerdict(decision: TriageDecision, config: BennyConfig, trackerUrl?: string): { text: string; marker: "bug" | "performance" | "other" } {
	const marker: "bug" | "performance" | "other" = decision.category === "bug" || decision.category === "performance" ? decision.category : "other";
	let cleaned = decision.verdict_text
		.split("\n")
		.filter((line) => !Object.values(config.verdict_markers).some((needle) => needle && line.includes(needle)))
		.join("\n")
		.trim();
	if (!cleaned) cleaned = "Triage verdict follows.";
	const suffix = trackerUrl ? ` ${config.verdict_markers.tracker_attribute}=${trackerUrl}` : "";
	return { text: `${cleaned}\n${config.verdict_markers[marker]}${suffix}`, marker };
}


/**
 * Human replies strictly later than a Slack-ts boundary. Bots, our own status
 * messages and the triage identity never count; boundary-adjacent or older
 * replies are stale state from before the update, never follow-up input.
 */
export function freshOperationsReplies(thread: SlackMessage[], boundaryTs: string, triageUserId: string): SlackMessage[] {
	return thread.filter(
		(message) =>
			message.ts !== message.thread_ts &&
			slackTimestampAfter(message.ts, boundaryTs) &&
			!message.bot_id &&
			!!message.user &&
			message.user !== triageUserId,
	);
}
function messageMarkerUrl(message: SlackMessage, config: BennyConfig): string | undefined {
	const match = new RegExp(`${config.verdict_markers.tracker_attribute}=(\\S+)`).exec(message.text ?? "");
	return match?.[1];
}

interface OpsUpdate {
	/** The operations thread root ts. */
	root: string;
	/** Slack ts boundary of this update: operations replies strictly later than it postdate this status change. */
	ts: string;
}

interface OpsTracker {
	update(text: string): Promise<OpsUpdate | undefined>;
}

/**
 * Operations status updates carry a Slack-issued boundary timestamp from a
 * verified readback — never the host clock. The first update posts the
 * thread root; every later update posts a content-addressed reply whose
 * receipt id IS the Slack ts, so the operations follow-up boundary always
 * orders correctly against real replies even if the host clock drifts.
 *
 * Resume: the deterministic ops-root action id's DONE journal receipt is the
 * persisted thread root. It is restored before any resumed status update, so
 * the new status goes out as a deterministic reply under that root — never a
 * dropped status (a replayed ops-root would return the OLD text) and never a
 * second root. The new reply's receipt is the boundary the caller persists
 * for the subsequent publication/follow-up window.
 */
export function opsTracker(
	actions: BennyActions,
	config: BennyConfig,
	runId: number,
	diagnostics: string[],
	journal: BennyJournal,
	signal?: AbortSignal,
): OpsTracker {
	let rootId: string | undefined;
	return {
		async update(text: string): Promise<OpsUpdate | undefined> {
			if (!config.slack.operations_channel_id) return undefined;
			try {
				if (rootId === undefined) {
					const persisted = journal.peek(actionId(runId, "ops-root", 1));
					if (persisted?.state === "done" && persisted.receipt && /^\d+\.\d+$/.test(persisted.receipt.id)) {
						rootId = persisted.receipt.id;
					}
				}
				if (rootId === undefined) {
					const root = await actions.operationsUpdate(actionId(runId, "ops-root", 1), text);
					rootId = root.id;
					return { root: root.id, ts: root.id };
				}
				const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
				const reply = await actions.postOperationsReply(actionId(runId, `ops-${digest}`, 1), rootId, text);
				return { root: rootId, ts: reply.id };
			} catch (error) {
				// REL-SOCKET-001: shutdown must propagate out of this
				// best-effort catch so the owned row requeues instead of
				// terminalizing with an open/uncertain journal write.
				if (signal?.aborted) throw error;
				diagnostics.push(`operations update failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		},
	};
}

function remaining(deps: RunDeps): number {
	const left = deps.run.deadline_ms - Date.now();
	if (left <= 0) throw new BennyError(1, "run deadline expired");
	return left;
}

async function bringUpConfiguredApp(
	workspace: BennyWorkspace,
	config: BennyConfig,
	stage: "reproduce" | "verify",
	input: Record<string, unknown>,
): Promise<ControlReceipt> {
	const workerCommand = config.runtime.control_config.worker_command;
	const appUrl = config.runtime.control_config.app_url;
	if (!Array.isArray(workerCommand) || workerCommand.length === 0 || workerCommand.some((part) => typeof part !== "string" || part.length === 0)) {
		throw new WorkspaceBlockError("runtime.control_config.worker_command must be a nonempty argv array that starts the target app and exits");
	}
	if (typeof appUrl !== "string") throw new WorkspaceBlockError("runtime.control_config.app_url must name the target app inside the workspace network");
	let parsed: URL;
	try {
		parsed = new URL(appUrl);
	} catch {
		throw new WorkspaceBlockError("runtime.control_config.app_url is not a valid URL");
	}
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.hostname !== "benny-worker") {
		throw new WorkspaceBlockError("runtime.control_config.app_url must use http(s) and the isolated benny-worker host");
	}
	const started = await workspace.call("exec", { command: workerCommand }, stage);
	if (
		typeof started !== "object" || started === null
		|| !("exitCode" in started) || started.exitCode !== 0
	) {
		throw new WorkspaceBlockError(`configured target-app command failed: ${JSON.stringify(started).slice(0, 300)}`);
	}
	return workspace.control("bring-up", { ...input, appUrl });
}

// ---------------------------------------------------------------------------
// Run dependencies
// ---------------------------------------------------------------------------
interface RunDeps {
	db: Database;
	config: BennyConfig;
	target: string;
	run: BennyRunRow;
	source: SelectedEvent["source"];
	root: SlackMessage;
	signal?: AbortSignal;
	diagnostics: string[];
	ops: OpsTracker;
	actions: BennyActions;
	/** The run's durable action journal; continuation resume peeks verified receipts through it. */
	journal: BennyJournal;
}

function sessionOptions(deps: RunDeps, selector: string, budgetMs: number, tools: ToolDefinition[]): SessionOptions {
	return {
		cwd: deps.target,
		model: selector,
		deadline: Math.min(deps.run.deadline_ms, Date.now() + budgetMs),
		tools: tools as unknown as CustomTool[],
		signal: deps.signal,
	};
}

// ---------------------------------------------------------------------------
// Triage phase
// ---------------------------------------------------------------------------

export async function runTriage(deps: RunDeps): Promise<BennyRunResult> {
	const { run, config, actions } = deps;

	if (run.stage === "followup") return triageFollowup(deps);
	if (run.stage === "create" || run.stage === "verdict") return resumeTriageWrite(deps);
	// A requeued compensate-stage run is precisely a crash between the
	// compensation intent and its settlement: reconciliation already ran in
	// executeBennyRun, so the outcome is terminal. NEVER restart
	// preflight/analyze/create/verdict here — that would silently re-run the
	// whole triage and mutate tracker/Slack state a second time.
	if (run.stage === "compensate") return resumeTriageCompensate(deps);
	// Preflight: the admitted root must still exist with identical identity (digest-enforced).
	recordBennyStage(deps.db, run, "preflight");
	await deps.actions.readRoot();

	// The committed routing map and exact ping policy are behavior inputs:
	// both come from the admitted revision, never the live worktree. A map
	// missing from the admitted revision blocks (fail closed).
	let routingMap: string;
	try {
		routingMap = readCommittedText(deps.target, deps.run.repo_revision, config.routing.map_path);
	} catch (error) {
		const diagnostic = `routing map unreadable at the admitted revision: ${error instanceof Error ? error.message : String(error)}`;
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}

	const thread = await actions.readThread();
	const permalink = await actions.permalink();
	const attachments: Array<Record<string, unknown>> = [];
	for (const file of (deps.root.files ?? []).slice(0, 5)) {
		const fileId = typeof file.id === "string" ? file.id : null;
		if (!fileId) continue;
		try {
			attachments.push(await actions.download(fileId));
		} catch (error) {
			attachments.push({ id: fileId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	recordBennyStage(deps.db, run, "analyze");
	const session = await openBennySession(
		sessionOptions(deps, config.models.triage, Math.min(remaining(deps), config.budgets.triage_total_minutes * 60_000), [
			actionsTool(deps.actions),
			repoTool(deps.target, deps.run.repo_revision, deps.run.deadline_ms, deps.signal),
		]),
	);
	try {
		const decision = await askStructured(
			session,
			[
				readBody(deps.target, deps.run.repo_revision, "skills/triage-issue-reports/SKILL.md"),
				"",
				"---",
				"You are executing this workflow as the Benny coordinator's triage worker. The source coordinates are frozen and immutable:",
				`channel=${deps.source.channel} root_ts=${deps.source.rootTs} permalink=${permalink}`,
				"Read-only tools are available (benny_actions, benny_repo). You have NO Slack write capability; the coordinator posts your verdict.",
				"",
				"Report root:",
				JSON.stringify(deps.root, null, 2),
				"",
				"Thread so far:",
				threadText(thread),
				"",
				attachments.length ? `Attachments already downloaded:\n${JSON.stringify(attachments)}` : "No attachments.",
				"",
				'{"category": "bug"|"performance"|"feature"|"question"|"reroute", "verdict_text": string, "tracker_query": string?, "route": string?, "create": null | {"title": string, "description": string}}',
				"route is the EXACT name of the matching route from the routing map when one matches; omit it when none does (the fallback owners then apply).",
				"",
				"Routing map (committed at the admitted revision):",
				routingMap,
				"",
				`Exact ping policy: plain owner pings are never authorized; feature-owner pings ${config.routing.allow_feature_owner_ping ? "allowed" : "not allowed"}; confirmed-regression-author pings authorize nobody (the host establishes no regression-author identity).`,
			].join("\n"),
			TriageDecision,
		);

		const allowedUserIds = routeMentionAllowlist(config, parseRoutingRoutes(routingMap), decision.route, routingMentionIds(routingMap), decision.category);
		const tracker = await triageTracker(deps, session, decision, permalink, allowedUserIds);
		return deliverTriageVerdict(deps, {
			decision,
			trackerUrl: tracker.url,
			createdIssueId: tracker.createdIssueId,
			trackerVerified: tracker.verified,
			allowedUserIds: [...allowedUserIds],
		});
	} finally {
		await session.dispose();
	}
}

/**
 * Advance the stage AND write the continuation payload in ONE UPDATE before
 * any mutating dispatch: a crash mid-write can never leave a stage naming a
 * journal intent whose resume payload is missing.
 */
function persistContinuation(db: Database, run: BennyRunRow, stage: string, state: string): void {
	db.run("UPDATE benny_runs SET stage = ?, state = ?, updated_at = ? WHERE id = ?", [stage, state, Date.now(), run.id]);
}

/** The continuation payload persisted atomically with the verified tracker-create and verdict-post receipts. */
export interface TriageContinuation {
	decision: TriageDecision;
	trackerUrl?: string;
	createdIssueId?: string;
	trackerVerified: boolean;
	allowedUserIds: string[];
}

/** Build the verdict, post it once through the journal, then park or settle. Shared by the live path and both resume stages. */
async function deliverTriageVerdict(deps: RunDeps, saved: TriageContinuation): Promise<BennyRunResult> {
	const { run, config } = deps;
	const verdict = buildVerdict(saved.decision, config, saved.trackerUrl);
	persistContinuation(deps.db, run, "verdict", continuationState("verdict", saved));
	let verdictReceipt: RemoteReceipt;
	try {
		verdictReceipt = await deps.actions.postThread(actionId(run.id, "verdict", 1), verdict.text, {
			allowedUserIds: new Set(saved.allowedUserIds),
			continuation: { stage: "verdict", state: continuationState("verdict", saved) },
		});
	} catch (error) {
		// Shutdown propagation: an abort must reach executeBennyRun and
		// release the owned row to queued, never compensate or terminalize.
		if (deps.signal?.aborted) throw error;
		if (!(error instanceof ActionFailure)) throw error;
		return triageVerdictFailure(deps, saved.createdIssueId, error);
	}
	const canaryEvidence = saved.trackerVerified && verdictReceipt.verified ? ["slack.verdict.readback", "tracker.mutation.readback"] : [];

	const windowMs = config.budgets.triage_follow_up_minutes * 60_000;
	if (windowMs > 0 && remaining(deps) > windowMs + 30_000) {
		parkBennyRun(
			deps.db,
			run,
			"followup",
			Date.now() + windowMs,
			null,
			JSON.stringify({ canaryEvidence, verdictTs: verdictReceipt.id, verdictPostedAt: Date.now(), allowedUserIds: saved.allowedUserIds }),
		);
		return { phase: "triage", status: "queued", duplicate: false, stage: "followup", actions: deps.diagnostics };
	}
	settleBennyRun(deps.db, run, "succeeded", undefined, deps.diagnostics);
	return result(deps.db, run, "succeeded", undefined, deps.diagnostics, canaryEvidence);
}

/**
 * Resume a run parked at the tracker-create or verdict stage. The readable
 * continuation (committed atomically with the journal receipt) is the only
 * resume source: the idempotent action re-dispatch returns the verified
 * receipt. Without a readable continuation the verified create receipt — if
 * any — is compensated and the run blocks; a published issue must never be
 * silently duplicated or abandoned.
 */
export async function resumeTriageWrite(deps: RunDeps): Promise<BennyRunResult> {
	const { run } = deps;
	const cont = parseContinuation<TriageContinuation>(run);
	if (!cont || !cont.data?.decision) {
		const createEntry = deps.journal.peek?.(actionId(run.id, "tracker-create", 1));
		if (createEntry?.state === "done" && createEntry.receipt) {
			recordBennyStage(deps.db, run, "compensate");
			await deps.actions.trackerCompensate(actionId(run.id, "tracker-compensate", 1), createEntry.receipt.id);
			const diagnostic = `crash left stage '${run.stage}' without a readable continuation; verified issue ${createEntry.receipt.id} was compensated`;
			settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
			return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		}
		const diagnostic = `stage '${run.stage}' has no readable continuation and no verifiable create receipt; reconcile the action journal before any rerun`;
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	const saved = cont.data;
	if (cont.stage === "create") {
		if (!saved.decision.create) {
			const diagnostic = "create continuation lacks the create payload; reconcile the action journal";
			settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
			return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		}
		const category: TrackerCategory = saved.decision.category === "performance" ? "performance" : "bug";
		const receipt = await deps.actions.trackerCreate(
			actionId(run.id, "tracker-create", 1),
			{
				title: saved.decision.create.title,
				description: `${saved.decision.create.description}\n\nSource: ${await deps.actions.permalink()}`,
				category,
			},
			{ continuation: { stage: "create", state: continuationState("create", saved) } },
		);
		saved.trackerUrl = typeof receipt.url === "string" ? receipt.url : saved.trackerUrl;
		saved.createdIssueId = receipt.id;
		saved.trackerVerified = receipt.verified;
	}
	return deliverTriageVerdict(deps, saved);
}

/**
 * Resume a run requeued at the compensate stage. This is a crash between the
 * compensation intent and its settlement: the compensation's journal intent
 * was already reconciled (reconcilePendingWrites runs before every stage
 * dispatch), so the outcome is terminal. Settle blocked from the reconciled
 * journal outcome — never restart preflight/analyze/create/verdict, which
 * would re-run analysis and could create or post a second time.
 */
export async function resumeTriageCompensate(deps: RunDeps): Promise<BennyRunResult> {
	const { run } = deps;
	const compensateEntry = deps.journal.peek?.(actionId(run.id, "tracker-compensate", 1));
	const issueId = compensateEntry?.state === "done" && compensateEntry.receipt?.id ? compensateEntry.receipt.id : undefined;
	const diagnostic = issueId
		? `crash left stage 'compensate'; newly created issue ${issueId} was compensated; no analysis or creation rerun`
		: "crash left stage 'compensate'; the compensation outcome is not verifiable in the reconciled journal — reconcile the action journal before any rerun; no analysis or creation rerun";
	settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
}

interface TriageTrackerOutcome {
	url?: string;
	createdIssueId?: string;
	verified: boolean;
}

export async function triageTracker(deps: RunDeps, session: RestrictedSession, decision: TriageDecision, permalink: string, allowedUserIds: ReadonlySet<string> = new Set()): Promise<TriageTrackerOutcome> {
	if (decision.category !== "bug" && decision.category !== "performance") return { verified: false };
	try {
		await deps.actions.trackerResolve();
	} catch (error) {
		if (error instanceof CanceledStateMissingError) {
			deps.diagnostics.push("tracker creation blocked: canceled workflow state missing");
			return { verified: false };
		}
		throw error;
	}
	// The source permalink is always searched; an optional model query widens
	// the evidence. Receipts are unioned by ID; a recurrence may only touch an
	// issue that actually appeared in this verified search.
	const receipts = new Map<string, RemoteReceipt>();
	for (const receipt of await deps.actions.trackerSearch(permalink)) receipts.set(receipt.id, receipt);
	const query = (decision.tracker_query ?? "").trim();
	if (query && query !== permalink) {
		for (const receipt of await deps.actions.trackerSearch(query)) {
			if (!receipts.has(receipt.id)) receipts.set(receipt.id, receipt);
		}
	}
	const search = [...receipts.values()];
	recordBennyStage(deps.db, deps.run, "dedupe");
	const dedupe = await askStructured(
		session,
		[
			"Dedupe check. Tracker search results (each has id + observed data):",
			JSON.stringify(search, null, 2),
			"",
			"Source permalink:",
			permalink,
			"",
			'Respond with ONLY: {"outcome": "confident-duplicate"|"possible"|"net-new", "issue_id": string?}',
		].join("\n"),
		DedupeDecision,
	);
	if (dedupe.outcome === "confident-duplicate" && dedupe.issue_id) {
		if (!search.some((receipt) => receipt.id === dedupe.issue_id)) {
			deps.diagnostics.push(`recurrence refused: issue ${dedupe.issue_id} did not appear in the verified tracker search`);
			return { verified: false };
		}
		const read = await deps.actions.trackerRead(dedupe.issue_id);
		const receipt = await deps.actions.trackerRecurrence(
			actionId(deps.run.id, "tracker-recurrence", 1),
			dedupe.issue_id,
			`Recurrence reported from ${permalink}`,
		);
		return { url: typeof receipt.url === "string" ? receipt.url : typeof read.url === "string" ? read.url : undefined, verified: read.verified && receipt.verified };
	}
	if (dedupe.outcome === "net-new" && decision.create) {
		const continuationData: TriageContinuation = {
			decision,
			trackerVerified: true,
			allowedUserIds: [...allowedUserIds],
		};
		// Continuation durable BEFORE the create intent: a crash mid-create
		// leaves stage 'create' with the resume payload the resume path needs.
		persistContinuation(deps.db, deps.run, "create", continuationState("create", continuationData));
		const receipt = await deps.actions.trackerCreate(
			actionId(deps.run.id, "tracker-create", 1),
			{
				title: decision.create.title,
				description: `${decision.create.description}\n\nSource: ${permalink}`,
				category: decision.category,
			},
			{ continuation: { stage: "create", state: continuationState("create", continuationData) } },
		);
		deps.diagnostics.push(`tracker issue ${receipt.id} created`);
		return { url: typeof receipt.url === "string" ? receipt.url : undefined, createdIssueId: receipt.id, verified: receipt.verified };
	}
	return { verified: false };
}

/** Verdict delivery failed: compensate a definitely-undelivered new issue; never blind-retry or fall back. */
async function triageVerdictFailure(deps: RunDeps, createdIssueId: string | undefined, error: ActionFailure): Promise<BennyRunResult> {
	if (createdIssueId && error.certainty === "not-delivered") {
		recordBennyStage(deps.db, deps.run, "compensate");
		await deps.actions.trackerCompensate(actionId(deps.run.id, "tracker-compensate", 1), createdIssueId);
		const diagnostic = `verdict not delivered (${error.message}); newly created issue ${createdIssueId} was canceled`;
		settleBennyRun(deps.db, deps.run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, deps.run, "blocked", diagnostic, deps.diagnostics);
	}
	const diagnostic =
		error.certainty === "uncertain"
			? `verdict delivery uncertain (${error.message}); reconcile the action journal; no retry without reconciliation`
			: `verdict not delivered (${error.message}); no fallback posts`;
	settleBennyRun(deps.db, deps.run, "blocked", diagnostic, deps.diagnostics);
	return result(deps.db, deps.run, "blocked", diagnostic, deps.diagnostics);
}
/** One bounded follow-up reply at most, then settle. */
async function triageFollowup(deps: RunDeps): Promise<BennyRunResult> {
	const { run, config } = deps;
	const checkpoint = run.state ? (JSON.parse(run.state) as { canaryEvidence?: string[]; verdictTs?: string; allowedUserIds?: string[] }) : {};
	const canaryEvidence = checkpoint.canaryEvidence ?? [];
	const allowedUserIds = new Set((checkpoint.allowedUserIds ?? []).filter((id) => /^[UW][A-Z0-9]{5,}$/.test(id)));
	// Follow-up may only consider real human replies posted strictly after the
	// verdict receipt, compared with exact Slack decimal ordering.
	const verdictTs = checkpoint.verdictTs;
	if (!verdictTs || !/^\d+\.\d+$/.test(verdictTs)) {
		const diagnostic = "follow-up checkpoint is missing the verdict receipt timestamp; refusing to reply";
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	try {
		const thread = await deps.actions.readThread();
		const fresh = thread.filter(
			(message) =>
				message.ts !== message.thread_ts &&
				slackTimestampAfter(message.ts, verdictTs) &&
				!message.bot_id &&
				!!message.user &&
				message.user !== config.slack.triage_identity_user_id &&
				((message.text ?? "").includes(config.slack.triage_identity_user_id) || (message.text ?? "").includes("?")),
		);
		if (fresh.length > 0) {
			const session = await openBennySession(
				sessionOptions(deps, config.models.triage, Math.min(remaining(deps), 5 * 60_000), [actionsTool(deps.actions)]),
			);
			try {
				const answer = await askStructured(
					session,
					[
						"A reporter may have asked one direct follow-up question in the source thread. Answer only a direct question to the triage identity using evidence already gathered; otherwise reply with no_reply.",
						"",
						"Thread:",
						threadText(thread),
						"",
						'Respond with ONLY: {"reply": string}',
						'Use "no_reply" as the string when no direct question was asked. Never include a marker line.',
					].join("\n"),
					z.object({ reply: z.string().min(1).max(1500) }),
				);
				if (answer.reply && answer.reply !== "no_reply") {
					await deps.actions.postThread(actionId(run.id, "followup", 1), answer.reply, { allowedUserIds });
				}
			} finally {
				await session.dispose();
			}
		}
	} catch (error) {
		// REL-SOCKET-001: shutdown propagation — an abort during the
		// follow-up is never a best-effort skip; rethrow so the owned row
		// requeues instead of settling succeeded with an open write.
		if (deps.signal?.aborted) throw error;
		deps.diagnostics.push(`follow-up skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
	settleBennyRun(deps.db, run, "succeeded", deps.diagnostics.length ? deps.diagnostics.join("; ") : undefined, deps.diagnostics);
	return result(deps.db, run, "succeeded", deps.diagnostics.join("; ") || undefined, deps.diagnostics, canaryEvidence);
}

// ponytail: single-check follow-up window (one reply at window end) instead of a continuous watcher; add polling if misses matter

// ---------------------------------------------------------------------------
// Reproduce phase
// ---------------------------------------------------------------------------
async function runReproduce(deps: RunDeps, corrected = false): Promise<BennyRunResult> {
	const { run, config } = deps;
	if (run.stage === "operations-followup") return reproduceOperationsFollowup(deps);

	// Resume after the rejection window: the plan and baseline receipts were persisted at park time.
	if (run.stage === "rejection-wait") return resumePostWindow(deps);

	// Resume the publication path: the branch/PR continuation receipts are the only trust anchor.
	if (run.stage === "draft") return resumeDraft(deps);

	// Stage: marker wait (safe checkpoint; parks between polls). Every resume
	// rereads the admitted root and fails closed on any identity drift.
	await deps.actions.readRoot();
	recordBennyStage(deps.db, run, "marker-wait");
	const markerWait = await waitForMarker(deps);
	if (markerWait) return markerWait;

	const thread = await deps.actions.readThread();
	const markerKind = trustedVerdict(thread, config, deps.source);
	if (markerKind !== "bug" && markerKind !== "performance") {
		const diagnostic =
			markerKind === "conflict"
				? "conflicting triage markers; repro stopped silently"
				: markerKind === "other"
					? "triage verdict was not a reproducible defect; repro stopped silently"
					: "no trusted triage verdict within budget; repro stopped silently";
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
		return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
	}
	const markerMessage = trustedMarkerMessage(thread, config, deps.source);
	const trackerUrl = markerMessage ? messageMarkerUrl(markerMessage, config) : undefined;

	// Stage: ownership + existing-fix gates.
	recordBennyStage(deps.db, run, "gates");
	const gate = await gateDecision(deps, thread);
	if (gate.owned) {
		const diagnostic = `a person owns the fix (${gate.ownership_reason}); repro stopped without racing them`;
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
		return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
	}
	if (gate.existing_fix_ref) {
		return verifyExistingFix(deps, gate.existing_fix_ref, trackerUrl);
	}

	try {
		readCommittedText(deps.target, deps.run.repo_revision, config.control.feature_map_path);
	} catch (error) {
		const diagnostic = `feature map blocked: ${error instanceof Error ? error.message : String(error)}`;
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}

	// Stage: workspace + all seven control capabilities.
	recordBennyStage(deps.db, run, "workspace");
	const revision = deps.run.repo_revision;
	let workspace: BennyWorkspace | null = null;
	try {
		workspace = await createBennyWorkspace({
			config,
			cwd: deps.target,
			runId: String(run.id),
			logicalRunId: String(run.id),
			revision,
			artifactDir: config.control.artifact_directory,
			deadline: run.deadline_ms,
			imageId: run.image_id || undefined,
			signal: deps.signal,
		});
		await bringUpConfiguredApp(workspace, config, "reproduce", {
			probe: true,
			repository: config.repository.url,
			revision,
			environment: config.control.environment,
			feature_map: readCommittedText(deps.target, deps.run.repo_revision, config.control.feature_map_path),
		});
		await deps.ops.update(`${config.status_emoji.reproducing} Reproducing`);
		return reproduceProof(deps, workspace, revision, trackerUrl, corrected);
	} catch (error) {
		if (workspace) await workspace.cleanup();
		if (deps.signal?.aborted) throw error;
		const diagnostic = error instanceof WorkspaceBlockError ? error.message : null;
		if (diagnostic) {
			await deps.ops.update(`${config.status_emoji.blocked} Blocked: ${diagnostic}`);
			settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
			return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		}
		throw error;
	}
}

interface OperationsFollowupState {
	operationsRoot: string;
	/** Slack ts of the draft-publication boundary; only strictly later human replies are follow-up input. */
	publishedTs: string;
	plan: ReproPlan;
	revision: string;
	prUrl: string;
	canaryEvidence: string[];
}

/** One operations-window decision. A concrete setup correction reruns the real repro exactly once. */
async function reproduceOperationsFollowup(deps: RunDeps): Promise<BennyRunResult> {
	const { run, config } = deps;
	let saved: OperationsFollowupState;
	try {
		saved = JSON.parse(run.state ?? "") as OperationsFollowupState;
		const boundaryMissing = typeof saved.publishedTs !== "string" || !/^\d+\.\d+$/.test(saved.publishedTs);
		if (boundaryMissing || !saved.operationsRoot || !saved.plan?.steps?.length || !saved.revision || !Array.isArray(saved.canaryEvidence)) {
			throw new Error(boundaryMissing ? "boundary" : "invalid");
		}
	} catch (error) {
		const diagnostic =
			error instanceof Error && error.message === "boundary"
				? "operations follow-up checkpoint is missing the draft-publication timestamp boundary; refusing to process possibly stale replies"
				: "operations follow-up checkpoint is missing or invalid";
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	const thread = await deps.actions.readOperationsThread(saved.operationsRoot);
	const fresh = freshOperationsReplies(thread, saved.publishedTs, config.slack.triage_identity_user_id);
	if (fresh.length === 0) {
		settleBennyRun(deps.db, run, "succeeded", undefined, deps.diagnostics);
		return result(deps.db, run, "succeeded", undefined, deps.diagnostics, saved.canaryEvidence);
	}
	const session = await openBennySession(sessionOptions(deps, config.models.reproduce, Math.min(remaining(deps), 5 * 60_000), []));
	let decision: z.infer<typeof OperationsDecision>;
	try {
		decision = await askStructured(
			session,
			[
				"Classify one operations-thread follow-up after a draft PR. Stay out of coordination and side chatter.",
				`Draft: ${saved.prUrl}`,
				"Messages:",
				threadText(fresh),
				"",
				'Respond with ONLY {"kind":"none"|"question"|"correction"|"stop","reply":string,"correction":string}.',
				"For question, answer only from recorded evidence. For correction, name the one concrete repro-setup change. For stop, use a short acknowledgement.",
			].join("\n"),
			OperationsDecision,
		);
	} finally {
		await session.dispose();
	}
	let diagnostic: string | undefined;
	let reply = decision.reply;
	if (decision.kind === "correction") {
		const planner = await openBennySession(sessionOptions(deps, config.models.reproduce, Math.min(remaining(deps), 5 * 60_000), []));
		let correctedPlan: ReproPlan;
		try {
			correctedPlan = await askStructured(
				planner,
				[
					"Apply exactly one concrete human correction to this reproduction plan.",
					`Correction: ${decision.correction}`,
					`Prior plan: ${JSON.stringify(saved.plan)}`,
					'Respond with ONLY the same reproduction-plan JSON shape: {"feature":string,"steps":[{"id":string,"capability":"drive-ui"|"drive-features"|"inspect-state","input":object,"description":string}],"reset":{"input":object},"discriminating_state":string,"expected_state":string,"state_check":{"key":string,"broken":string,"correct":string}}',
				].join("\n"),
				ReproPlan,
			);
		} finally {
			await planner.dispose();
		}
		let workspace: BennyWorkspace | null = null;
		try {
			workspace = await createBennyWorkspace({
				config,
				cwd: deps.target,
				runId: `${run.id}-ops`,
				logicalRunId: String(run.id),
				revision: saved.revision,
				artifactDir: config.control.artifact_directory,
				deadline: run.deadline_ms,
				imageId: run.image_id || undefined,
				signal: deps.signal,
			});
			await bringUpConfiguredApp(workspace, config, "reproduce", { probe: true, revision: saved.revision, environment: config.control.environment });
			const artifacts: TrialOutcome["artifacts"] = [];
			let reproduced = true;
			for (let attempt = 1; attempt <= 2; attempt++) {
				const trial = await runTrial(deps, workspace, correctedPlan, { phase: "baseline", revision: saved.revision, attempt, expected: "broken" });
				artifacts.push(...trial.artifacts);
				reproduced &&= trial.receipt.observed === "broken";
			}
			const review = await reviewMedia({
				config,
				imageId: run.image_id,
				runId: String(run.id),
				artifacts,
				prompt: `Control receipts separately prove the corrected actions. Review only the visible final UI state: do the attached screenshots/frames still show ${correctedPlan.discriminating_state}?`,
				deadline: run.deadline_ms,
				cwd: deps.target,
				signal: deps.signal,
			});
			reproduced &&= review.confirmed;
			reply = reproduced
				? `Applied the correction and reran the reproduction twice; the defect remains confirmed. Draft remains ${saved.prUrl}`
				: `Applied the correction and reran the reproduction; it invalidated the setup. Draft ${saved.prUrl} remains open for human revision.`;
			if (!reproduced) diagnostic = "operations correction invalidated the reproduction setup; draft requires human revision";
		} finally {
			if (workspace) await workspace.cleanup();
		}
	}
	if (decision.kind !== "none" && reply.trim()) {
		await deps.actions.postOperationsReply(actionId(run.id, "operations-followup", 1), saved.operationsRoot, reply);
	}
	settleBennyRun(deps.db, run, diagnostic ? "blocked" : "succeeded", diagnostic, deps.diagnostics);
	return result(deps.db, run, diagnostic ? "blocked" : "succeeded", diagnostic, deps.diagnostics, diagnostic ? [] : saved.canaryEvidence);
}

function trustedMarkerMessage(messages: SlackMessage[], config: BennyConfig, source: SelectedEvent["source"]): SlackMessage | undefined {
	return messages.find(
		(message) =>
			message.user === config.slack.triage_identity_user_id &&
			message.thread_ts === source.rootTs &&
			message.ts !== message.thread_ts &&
			(config.verdict_markers.bug || config.verdict_markers.performance) &&
			((message.text ?? "").includes(config.verdict_markers.bug) || (message.text ?? "").includes(config.verdict_markers.performance)),
	);
}

/** Park between polls; resume is safe here. Returns a terminal result only when the wait ends without a verdict. */
async function waitForMarker(deps: RunDeps): Promise<BennyRunResult | null> {
	const { run, config } = deps;
	const waitUntil = run.wait_until_ms ?? run.created_at + config.budgets.verdict_wait_minutes * 60_000;
	const thread = await deps.actions.readThread();
	const verdict = trustedVerdict(thread, config, deps.source);
	if (verdict !== null) return null;
	if (Date.now() >= waitUntil) {
		const diagnostic = "no trusted triage verdict within budget; repro stopped silently";
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
		return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
	}
	parkBennyRun(deps.db, run, "marker-wait", Date.now() + config.budgets.poll_seconds * 1000, waitUntil);
	return { phase: "reproduce", status: "queued", duplicate: false, stage: "marker-wait", actions: deps.diagnostics };
}

async function gateDecision(deps: RunDeps, thread: SlackMessage[]): Promise<z.infer<typeof GateDecision>> {
	const session = await openBennySession(
		sessionOptions(deps, deps.config.models.reproduce, Math.min(remaining(deps), 10 * 60_000), [actionsTool(deps.actions), repoTool(deps.target, deps.run.repo_revision, deps.run.deadline_ms, deps.signal)]),
	);
	try {
		return await askStructured(
			session,
			[
				readBody(deps.target, deps.run.repo_revision, "skills/reproduce-and-fix-issues/SKILL.md").split("## 5. Load and check the control adapter")[0],
				"---",
				"Apply ONLY the ownership and fix-artifact gates (sections 1-3). Judge the requested action, not the presence of a bot. A claim without a pull request or commit is NOT a fix artifact.",
				"",
				"Thread:",
				threadText(thread),
				"",
				'Respond with ONLY: {"owned": boolean, "ownership_reason": string, "existing_fix_ref": string|null}',
				"existing_fix_ref is a pull request number like `123` or an immutable 40-64 character commit OID when a concrete artifact exists.",
			].join("\n"),
			GateDecision,
		);
	} finally {
		await session.dispose();
	}
}

/** Existing-fix verification: baseline vs patched, twice each, never authoring over the artifact. */
async function verifyExistingFix(deps: RunDeps, ref: string, trackerUrl: string | undefined): Promise<BennyRunResult> {
	const { run, config } = deps;
	await deps.ops.update(`${config.status_emoji.seen} Verifying existing fix`);
	let artifactId = ref;
	let baseOid = "";
	let headOid = "";
	try {
		if (/^[0-9a-f]{40,64}$/i.test(ref)) {
			headOid = await ensureGitCommit(deps.target, config.repository.url, ref, run.deadline_ms, deps.signal);
			const parent = Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", deps.target, "rev-parse", `${headOid}^`]), { stdout: "pipe", stderr: "pipe", env: gitReadEnv() });
			if (parent.exitCode !== 0) throw new WorkspaceBlockError(`fix commit ${headOid} has no verifiable parent`);
			baseOid = parent.stdout.toString("utf8").trim();
			artifactId = headOid;
		} else {
			if (!/^\d+$/.test(ref)) throw new WorkspaceBlockError(`fix artifact '${ref}' is neither a pull request number nor commit OID`);
			const receipt = await deps.actions.readPR(ref);
			artifactId = receipt.id;
			const observed = receipt.observed as Record<string, unknown>;
			if (typeof observed.baseOid !== "string" || typeof observed.headOid !== "string") {
				throw new WorkspaceBlockError("pull request readback did not identify immutable base/head commit OIDs");
			}
			baseOid = await ensureGitCommit(deps.target, config.repository.url, observed.baseOid, run.deadline_ms, deps.signal);
			headOid = await ensureGitCommit(deps.target, config.repository.url, observed.headOid, run.deadline_ms, deps.signal);
		}
		const outcome = await twoBuildProof(deps, { existingFix: artifactId, base: baseOid, head: headOid, trackerUrl });
		if (!outcome.verified) {
			await deps.ops.update(`${config.status_emoji.blocked} ${outcome.diagnostic}`);
			settleBennyRun(deps.db, run, "blocked", outcome.diagnostic, deps.diagnostics);
			return result(deps.db, run, "blocked", outcome.diagnostic, deps.diagnostics);
		}
		settleBennyRun(deps.db, run, "succeeded", outcome.diagnostic, deps.diagnostics);
		return result(deps.db, run, "succeeded", outcome.diagnostic, deps.diagnostics);
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		const diagnostic = error instanceof WorkspaceBlockError
			? error.message
			: `claimed fix artifact '${ref}' is not readable (${error instanceof Error ? error.message : String(error)})`;
		await deps.ops.update(`${config.status_emoji.blocked} Blocked: ${diagnostic}`);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
}

/**
 * Study → two baseline trials → media review → source reply → rejection window
 * → fresh gates → bounded fix → two patched trials → blast radius → draft gate.
 * Runs to the next park point or terminal state within one claim.
 */
async function reproduceProof(deps: RunDeps, workspace: BennyWorkspace, revision: string, trackerUrl: string | undefined, corrected: boolean): Promise<BennyRunResult> {
	const { run, config } = deps;
	try {
		recordBennyStage(deps.db, run, "study");
		const plan = await studyPlan(deps, workspace);

		recordBennyStage(deps.db, run, "reproduce");
		const baseline: TrialReceipt[] = [];
		const baselineArtifacts = [];
		for (let attempt = 1; attempt <= 2; attempt++) {
			const trial = await runTrial(deps, workspace, plan, { phase: "baseline", revision, attempt, expected: "broken" });
			baseline.push(trial.receipt);
			baselineArtifacts.push(...trial.artifacts);
			if (trial.receipt.observed !== "broken") return couldNotReproduce(deps, workspace, `baseline trial ${attempt} did not show the broken state`);
		}
		const baselineReview = await reviewMedia({
			config,
			imageId: run.image_id,
			runId: String(run.id),
			artifacts: baselineArtifacts,
			prompt: `Control receipts separately prove the ordered actions. Review only the visible final UI state: do the attached screenshots/frames show ${plan.discriminating_state}? Answer true when that broken state is visibly present; the correct state would be ${plan.expected_state}.`,
			deadline: run.deadline_ms,
			cwd: deps.target,
			signal: deps.signal,
		});
		if (!baselineReview.confirmed) return couldNotReproduce(deps, workspace, "independent media review did not confirm the broken state");

		// A verified source reply opens the only valid rejection window. The
		// window's checkpoint is supplied to the post as its continuation, so
		// the journal receipt AND the run's stage/state commit in one
		// transaction: a crash immediately after the post leaves a durable
		// rejection-wait checkpoint instead of an unrecoverable reproduce
		// stage that would re-post the "Reproduced" reply on resume.
		const wantWindow = !corrected && config.budgets.rejection_window_minutes > 0;
		const sourceReplyAt = Date.now();
		const rejectionEndsAt = sourceReplyAt + config.budgets.rejection_window_minutes * 60_000;
		const checkpoint: RejectionCheckpoint = {
			plan,
			baseline,
			evidence: baselineReview.evidence,
			reviewedHashes: baselineReview.reviewedHashes,
			sourceReplyAt,
			rejectionEndsAt,
			trackerUrl,
			revision,
		};
		const reproReply = await deps.actions.postThread(
			actionId(run.id, corrected ? "repro-correction" : "repro-reply", 1),
			[
				`${corrected ? "Corrected reproduction" : "Reproduced"}: ${plan.discriminating_state}`,
				trackerUrl ? `Tracker: ${trackerUrl}` : "",
				...(plan.state_check.key ? [`Cross-check: ${plan.state_check.key}`] : []),
			]
				.filter(Boolean)
				.join("\n"),
			{
				allowedUserIds: reproduceMentionSet(deps),
				...(wantWindow ? { continuation: { stage: "rejection-wait", state: JSON.stringify(checkpoint) } } : {}),
			},
		);
		await deps.ops.update(`${config.status_emoji.reproduced} Reproduced`);

		// Finish the checkpoint with the verified reply id (known only after
		// the post) and park. The immediate path (no window / correction
		// rerun) leaves the stage untouched, so it never advertises
		// resumability — only the rejection-wait branch commits a checkpoint.
		if (wantWindow) {
			parkBennyRun(
				deps.db,
				run,
				"rejection-wait",
				rejectionEndsAt,
				null,
				JSON.stringify({ ...checkpoint, sourceReplyId: reproReply.id } satisfies RejectionState),
			);
			await workspace.cleanup();
			return { phase: "reproduce", status: "queued", duplicate: false, stage: "rejection-wait", actions: deps.diagnostics };
		}
		return await postWindow(deps, workspace, plan, {
			revision,
			baseline,
			baselineReview,
			corrected,
			trackerUrl,
			sourceReplyAt,
			sourceReplyId: reproReply.id,
			rejectionEndsAt: null,
		});
	} catch (error) {
		await workspace.cleanup();
		if (deps.signal?.aborted) throw error;
		if (error instanceof WorkspaceBlockError) {
			await deps.ops.update(`${config.status_emoji.blocked} Blocked: ${error.message}`);
			settleBennyRun(deps.db, run, "blocked", error.message, deps.diagnostics);
			return result(deps.db, run, "blocked", error.message, deps.diagnostics);
		}
		throw error;
	}
}

async function couldNotReproduce(deps: RunDeps, workspace: BennyWorkspace, reason: string): Promise<BennyRunResult> {
	await workspace.cleanup();
	const diagnostic = `could not reproduce: ${reason}`;
	await deps.ops.update(`${deps.config.status_emoji.could_not_reproduce} ${diagnostic}`);
	settleBennyRun(deps.db, deps.run, "succeeded", diagnostic, deps.diagnostics);
	return result(deps.db, deps.run, "succeeded", diagnostic, deps.diagnostics);
}

/**
 * Resume a run parked at the rejection window. The persisted checkpoint carries
 * the plan and both baseline trial receipts; the workspace is rebuilt at the
 * recorded revision and the post-window path continues from there. A missing or
 * invalid checkpoint blocks instead of re-executing trials blindly.
 */
export async function resumePostWindow(deps: RunDeps): Promise<BennyRunResult> {
	const { run, config } = deps;
	let saved: RejectionState | null = null;
	try {
		saved = run.state ? (JSON.parse(run.state) as RejectionState) : null;
	} catch {
		saved = null;
	}
	// The reply id is committed atomically WITH the post journal receipt, so a
	// crash between the post and park leaves it recoverable from the journal
	// even when the checkpoint's sourceReplyId was not yet written.
	let sourceReplyId = saved?.sourceReplyId;
	if (typeof sourceReplyId !== "string" || !sourceReplyId) {
		const replyEntry = deps.journal.peek?.(actionId(run.id, "repro-reply", 1));
		if (replyEntry?.state === "done" && replyEntry.receipt?.id) sourceReplyId = replyEntry.receipt.id;
	}
	if (
		!saved?.plan?.steps?.length ||
		!Array.isArray(saved.baseline) ||
		saved.baseline.length !== 2 ||
		!Array.isArray(saved.reviewedHashes) ||
		typeof sourceReplyId !== "string" ||
		typeof saved.sourceReplyAt !== "number" ||
		typeof saved.rejectionEndsAt !== "number"
	) {
		const diagnostic = "rejection-window checkpoint state missing or invalid; refusing to re-execute trials blindly";
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	// The checkpoint revision must be the admitted revision, and the source
	// root must reread with its exact admitted identity before any resumed work.
	if (!run.repo_revision || saved.revision !== run.repo_revision) {
		const diagnostic = `rejection-window checkpoint revision ${saved.revision} does not match the admitted revision ${run.repo_revision ?? "<missing>"}`;
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	// A crash between the post and the park leaves the checkpoint committed but
	// not_before_ms unset: the window has not elapsed, so re-park at the exact
	// rejection deadline instead of proceeding early or settling interrupted.
	if (Date.now() < saved.rejectionEndsAt) {
		parkBennyRun(deps.db, run, "rejection-wait", saved.rejectionEndsAt, null, JSON.stringify({ ...saved, sourceReplyId }));
		return { phase: "reproduce", status: "queued", duplicate: false, stage: "rejection-wait", actions: deps.diagnostics };
	}
	await deps.actions.readRoot();
	const plan = ReproPlan.parse(saved.plan);
	run.stage = "workspace";
	recordBennyStage(deps.db, run, "workspace");
	let workspace: BennyWorkspace | null = null;
	try {
		workspace = await createBennyWorkspace({
			config,
			cwd: deps.target,
			runId: String(run.id),
			logicalRunId: String(run.id),
			revision: saved.revision,
			artifactDir: config.control.artifact_directory,
			deadline: run.deadline_ms,
			imageId: run.image_id || undefined,
			signal: deps.signal,
		});
		await bringUpConfiguredApp(workspace, config, "reproduce", {
			probe: true,
			revision: saved.revision,
			environment: config.control.environment,
		});
		return await postWindow(deps, workspace, plan, {
			revision: saved.revision,
			baseline: saved.baseline,
			baselineReview: { confirmed: true, evidence: saved.evidence, reviewedHashes: saved.reviewedHashes },
			corrected: false,
			trackerUrl: saved.trackerUrl,
			sourceReplyId,
			sourceReplyAt: saved.sourceReplyAt,
			rejectionEndsAt: saved.rejectionEndsAt,
		});
	} catch (error) {
		if (workspace) await workspace.cleanup();
		if (deps.signal?.aborted) throw error;
		if (error instanceof WorkspaceBlockError) {
			await deps.ops.update(`${config.status_emoji.blocked} Blocked: ${error.message}`);
			settleBennyRun(deps.db, run, "blocked", error.message, deps.diagnostics);
			return result(deps.db, run, "blocked", error.message, deps.diagnostics);
		}
		throw error;
	}
}

async function studyPlan(deps: RunDeps, workspace: BennyWorkspace): Promise<ReproPlan> {
	const session = await openBennySession(
		sessionOptions(deps, deps.config.models.reproduce, Math.min(remaining(deps), 20 * 60_000), [
			actionsTool(deps.actions),
			repoTool(deps.target, deps.run.repo_revision, deps.run.deadline_ms, deps.signal),
			workspaceTool(workspace, "study", false),
		]),
	);
	try {
		const featureMap = readCommittedText(deps.target, deps.run.repo_revision, deps.config.control.feature_map_path);
		return await askStructured(
			session,
			[
				readBody(deps.target, deps.run.repo_revision, "skills/reproduce-and-fix-issues/SKILL.md").split("## 6. Study the report")[1]?.split("## 8. Capture and review evidence")[0] ?? "",
				"---",
				"Produce a deterministic reproduction plan. The coordinator (not you) will execute every step through the real control adapter, twice, with independent resets.",
				"",
				"Feature map:",
				featureMap,
				"",
				"Report thread:",
				threadText(await deps.actions.readThread()),
				"",
				"Respond with ONLY JSON:",
				'{"feature": string, "steps": [{"id": string, "capability": "drive-ui"|"drive-features"|"inspect-state", "input": object, "description": string}], "reset": {"input": object}, "discriminating_state": string, "expected_state": string, "state_check": {"key": string, "broken": string, "correct": string}}',
				"steps must reproduce the exact reported user path through real UI actions; never inject or force the symptom.",
			].join("\n"),
			ReproPlan,
		);
	} finally {
		await session.dispose();
	}
}

/**
 * The trial media gate: a credited trial must return exactly one byte-verified
 * image from the screenshot call and exactly one byte-verified video from the
 * recording-stop call. Two images, two videos, a missing kind, or an extra
 * artifact on either call violates the contract; the caller must fail the
 * trial before any reproduction or existing-fix success can be credited.
 */
export function trialMediaViolation(
	shotArtifacts: ReadonlyArray<{ mimeType: string }>,
	stopArtifacts: ReadonlyArray<{ mimeType: string }>,
): string | null {
	const shotImages = shotArtifacts.filter((artifact) => artifact.mimeType.startsWith("image/"));
	const stopVideos = stopArtifacts.filter((artifact) => artifact.mimeType.startsWith("video/"));
	if (shotArtifacts.length === 1 && shotImages.length === 1 && stopArtifacts.length === 1 && stopVideos.length === 1) return null;
	return (
		`trial evidence rejected: the screenshot call must return exactly one byte-verified image ` +
		`(got ${shotArtifacts.length} artifact(s), ${shotImages.length} image) and recording-stop exactly one ` +
		`byte-verified video (got ${stopArtifacts.length} artifact(s), ${stopVideos.length} video)`
	);
}

interface TrialOutcome {
	receipt: TrialReceipt;
	artifacts: Array<{ path: string; sha256: string; mimeType: string; data: Uint8Array; timestampMs: number }>;
}

async function runTrial(
	deps: RunDeps,
	workspace: BennyWorkspace,
	plan: ReproPlan,
	options: { phase: "baseline" | "patched"; revision: string; attempt: number; expected: "broken" | "correct" },
): Promise<TrialOutcome> {
	const stage: "reproduce" | "verify" = options.phase === "baseline" ? "reproduce" : "verify";
	const controlIds: string[] = [];
	const stateChecks: Record<string, unknown> = {};
	const drive = async (capability: "drive-ui" | "drive-features" | "inspect-state", input: Record<string, unknown>): Promise<ControlReceipt> => {
		const receipt = await workspace.control(capability, input);
		controlIds.push(`${capability}@${receipt.at}`);
		return receipt;
	};

	const resetReceipt = await drive("drive-features", { ...plan.reset.input, reset: true, attempt: options.attempt });
	const resetId = typeof resetReceipt.result.resetId === "string" ? resetReceipt.result.resetId.trim() : "";
	if (!resetId) throw new WorkspaceBlockError("control adapter reset did not return a nonempty resetId");
	const recordingPath = `/artifacts/${options.phase}-${options.attempt}.webm`;
	await workspace.control("recording", { action: "start", path: recordingPath });
	for (const step of plan.steps) {
		const receipt = await drive(step.capability, { ...step.input, step_id: step.id });
		if (step.capability === "inspect-state") stateChecks[step.id] = receipt.result;
	}
	const screenshotPath = `/artifacts/${options.phase}-${options.attempt}.png`;
	const shot = await workspace.control("screenshot", { path: screenshotPath, description: plan.discriminating_state });
	const stopped = await workspace.control("recording", { action: "stop", path: recordingPath });
	if (Object.keys(stateChecks).length === 0 && plan.steps.some((step) => step.capability === "inspect-state") === false) {
		const inspect = await drive("inspect-state", { key: plan.state_check.key });
		stateChecks[plan.state_check.key] = inspect.result;
	}
	const shotArtifacts = await workspace.artifacts(shot.artifacts.map((artifact) => artifact.path));
	const stopArtifacts = await workspace.artifacts(stopped.artifacts.map((artifact) => artifact.path));
	// Byte-verified media gate: a credited trial must carry exactly one image
	// from the screenshot call and one video from recording-stop. Two images,
	// two videos, or a missing kind fails the trial before any reproduction or
	// existing-fix success can be credited from it.
	const mediaViolation = trialMediaViolation(shotArtifacts, stopArtifacts);
	if (mediaViolation) throw new WorkspaceBlockError(mediaViolation);
	const artifacts = [...shotArtifacts, ...stopArtifacts];

	const session = await openBennySession(sessionOptions(deps, deps.config.models.reproduce, Math.min(remaining(deps), 5 * 60_000), []));
	try {
		const observed = await askStructured(
			session,
			[
				"Judge one UI trial from its read-only state checks (you have no tools; judge only the recorded data).",
				`Expected correct state: ${plan.expected_state}`,
				`Broken state: ${plan.discriminating_state}`,
				`Cross-check: key=${plan.state_check.key} broken=${plan.state_check.broken} correct=${plan.state_check.correct}`,
				"",
				"Observed state checks:",
				JSON.stringify(stateChecks, null, 2),
				"",
				'Respond with ONLY: {"observed": "broken"|"correct"}',
			].join("\n"),
			ObservedDecision,
		);
		return {
			receipt: {
				runId: String(deps.run.id),
				phase: options.phase,
				revision: options.revision,
				at: Date.now(),
				stepIds: plan.steps.map((step) => step.id),
				resetId,
				observed: observed.observed,
				stateChecks,
				artifacts: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256, mimeType: artifact.mimeType })),
				controlIds,
			},
			artifacts,
		};
	} finally {
		await session.dispose();
	}
}

interface PostWindowInputs {
	revision: string;
	baseline: TrialReceipt[];
	baselineReview: { confirmed: boolean; evidence: string[]; reviewedHashes: string[] };
	corrected: boolean;
	trackerUrl?: string;
	sourceReplyId: string;
	sourceReplyAt: number;
	rejectionEndsAt: number | null;
}

/** Persisted state across the rejection-window park; a resumable safe checkpoint. */
interface RejectionState {
	plan: ReproPlan;
	baseline: TrialReceipt[];
	evidence: string[];
	reviewedHashes: string[];
	sourceReplyId: string;
	sourceReplyAt: number;
	rejectionEndsAt: number;
	trackerUrl?: string;
	revision: string;
}

/** The rejection-window checkpoint as it exists before the reply id is known: committed atomically with the source post, then completed at park. */
type RejectionCheckpoint = Omit<RejectionState, "sourceReplyId">;

/** After the rejection window: fresh gates, one bounded correction, then fix/verify/report. */
async function postWindow(deps: RunDeps, workspace: BennyWorkspace, plan: ReproPlan, inputs: PostWindowInputs): Promise<BennyRunResult> {
	const { run, config } = deps;
	// Publication binding: the workspace revision must be the admitted repo revision.
	if (!run.repo_revision || inputs.revision !== run.repo_revision) {
		const diagnostic = `workspace revision ${inputs.revision} does not match the admitted revision ${run.repo_revision ?? "<missing>"}; refusing to publish`;
		await workspace.cleanup();
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	const thread = await deps.actions.readThread();
	const freshGate = await gateDecision(deps, thread);
	if (freshGate.owned) {
		const diagnostic = `a person claimed the fix during the rejection window (${freshGate.ownership_reason}); no authored change`;
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		await workspace.cleanup();
		settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
		return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
	}
	if (freshGate.existing_fix_ref) {
		await workspace.cleanup();
		return verifyExistingFix(deps, freshGate.existing_fix_ref, inputs.trackerUrl);
	}
	const rejected = await rejectionCheck(deps, freshOperationsReplies(thread, inputs.sourceReplyId, config.slack.triage_identity_user_id));
	if (rejected.rejected) {
		if (inputs.corrected) {
			const diagnostic = `repro rejected by a person after one correction: ${rejected.reason}`;
			await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
			await workspace.cleanup();
			settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
			return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
		}
		// One bounded correction: rerun the full proof once with the feedback applied.
		await workspace.cleanup();
		run.stage = "post-window";
		recordBennyStage(deps.db, run, "post-window");
		return runReproduce(deps, true);
	}

	recordBennyStage(deps.db, run, "fix");
	await deps.ops.update(`${config.status_emoji.fixing} Attempting bounded fix`);
	const fix = await applyFix(deps, workspace, plan);

	recordBennyStage(deps.db, run, "verify");
	await bringUpConfiguredApp(workspace, config, "verify", {
		probe: true,
		revision: "patched-snapshot",
		restart: true,
		environment: config.control.environment,
	});
	const patchedRevision = await workspace.snapshotHash();
	// An empty fix never publishes: the patched tree must differ from the
	// admitted base commit's tree OID (the admitted OID is the sole source).
	const baseTree = gitTreeOid(deps.target, inputs.revision);
	if (patchedRevision === baseTree) {
		return fixFailed(deps, workspace, "fix produced no change: the patched tree equals the admitted base tree");
	}
	const patched: TrialReceipt[] = [];
	const patchedArtifacts: TrialOutcome["artifacts"] = [];
	for (let attempt = 1; attempt <= 2; attempt++) {
		const trial = await runTrial(deps, workspace, plan, { phase: "patched", revision: patchedRevision, attempt, expected: "correct" });
		patched.push(trial.receipt);
		patchedArtifacts.push(...trial.artifacts);
		if (trial.receipt.observed !== "correct") return fixFailed(deps, workspace, `patched trial ${attempt} still shows the broken state`);
	}
	const patchedReview = await reviewMedia({
		config,
		imageId: run.image_id,
		runId: String(run.id),
		artifacts: patchedArtifacts,
		prompt: `Control receipts separately prove the ordered actions. Review only the visible final UI state: do the attached screenshots/frames show ${plan.expected_state}? Answer true when that correct state is visibly present; the broken state would be ${plan.discriminating_state}.`,
		deadline: run.deadline_ms,
		cwd: deps.target,
		signal: deps.signal,
	});
	if (!patchedReview.confirmed) return fixFailed(deps, workspace, "independent media review did not confirm the patched state");

	recordBennyStage(deps.db, run, "blast-radius");
	const blast = await blastRadius(deps, workspace, fix);
	if (!blast.passed) return fixFailed(deps, workspace, `blast-radius check failed: ${blast.checks.join("; ")}`);

	recordBennyStage(deps.db, run, "fresh-gates");
	// Pre-draft freshness: rerun the REAL ownership/fix-artifact gate against a
	// fresh source read; the draft proof timestamps come from that read. Any
	// ambiguity fails closed (cleanup + blocked via the caller's error path).
	let freshFinalGate: z.infer<typeof GateDecision>;
	try {
		freshFinalGate = await gateDecision(deps, await deps.actions.readThread());
	} catch (error) {
		await workspace.cleanup();
		throw error;
	}
	const freshCheckedAt = Date.now();

	const proof: DraftProof = {
		runId: String(run.id),
		trials: [...inputs.baseline, ...patched],
		media: {
			confirmed: inputs.baselineReview.confirmed && patchedReview.confirmed,
			reviewedHashes: [...inputs.baselineReview.reviewedHashes, ...patchedReview.reviewedHashes],
			evidence: [...inputs.baselineReview.evidence, ...patchedReview.evidence],
		},
		sourceReply: { id: inputs.sourceReplyId, verified: true, at: inputs.sourceReplyAt },
		rejectionEndsAt: inputs.rejectionEndsAt ?? inputs.sourceReplyAt,
		ownershipCheckedAt: freshCheckedAt,
		artifactsCheckedAt: freshCheckedAt,
		owned: freshFinalGate.owned,
		existingFix: Boolean(freshFinalGate.existing_fix_ref),
		rejected: false,
		blastRadiusPassed: true,
		now: Date.now(),
		deadline: run.deadline_ms,
	};
	const gate = canCreateDraft(proof);
	if (!gate.allowed) {
		const diagnostic = `repro confirmed and fix verified, but the draft gate denied the pull request: ${gate.reason}`;
		await deps.ops.update(`${config.status_emoji.fix_failed} ${diagnostic}`);
		await workspace.cleanup();
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}

	const head = `benny/run-${run.id}-${patchedRevision.slice(0, 12)}`;
	return publishDraftAndReport(
		deps,
		workspace.workspacePath,
		() => workspace.cleanup(),
		{
			head,
			tree: patchedRevision,
			base: config.repository.default_branch,
			baseOid: inputs.revision,
			title: fix.commit_message,
			body: [
				fix.summary,
				"",
				`Root cause and repro: ${plan.discriminating_state}`,
				`Tests: ${fix.tests_run.join(", ") || "none"}`,
				`Blast radius: ${blast.checks.join("; ")}`,
				inputs.trackerUrl ? `Tracker: ${inputs.trackerUrl}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			plan,
			revision: inputs.revision,
			trackerUrl: inputs.trackerUrl,
			evidence: draftEvidenceReceipts([...inputs.baseline, ...patched]),
		},
		{ freshGate: false },
	);
}

/**
 * The draft publication path carries every trial artifact receipt it must
 * later re-prove: a live or resumed publication re-reads these content
 * addresses from the evidence store before the irreversible PR gate.
 */
export interface DraftPayload {
	head: string;
	/** The verified workspace snapshot tree OID the published branch must carry. */
	tree: string;
	base: string;
	baseOid: string;
	title: string;
	body: string;
	plan: ReproPlan;
	revision: string;
	trackerUrl?: string;
	evidence: Array<{ path: string; sha256: string }>;
	/**
	 * REL-DRAFT-001: host-side retained copy of the verified patched source,
	 * persisted before the pre-dispatch continuation so a crash in the
	 * pre-intent window (no publish-branch journal row, workspace already
	 * cleaned) can still re-dispatch the real publication after restart.
	 */
	sourceDir?: string;
}

/** Retain a host-side copy of the verified patched worktree under the private state root: built at a temp name, then renamed, so a partial snapshot never reads as complete. The path sits inside publishBranch's containment boundary. */
export function retainPublishSnapshot(target: string, runId: number, workspacePath: string, signal?: AbortSignal): string {
	// PSTACK-SEC-PATH-001: the state root and the benny-publish-source parent
	// are created component-wise non-symlink (securePrivateDir refuses a
	// planted link at any component), then the per-run child is created
	// exclusively and lstat/realpath-validated before any rm/copy — a
	// repo-planted symlink can never redirect the destructive operations.
	const parent = securePrivateDir(stateDir(target), "benny-publish-source");
	const canonicalParent = realpathSync(parent);
	if (canonicalParent !== resolve(parent)) throw new Error(`publish snapshot parent ${parent} resolves through a symlink to ${canonicalParent}`);
	const snapshotDir = resolve(join(parent, String(runId)));
	const tmp = `${snapshotDir}.tmp-${process.pid}-${Date.now()}`;
	// A resumed pre-intent dispatch re-uses the already-retained snapshot as
	// its source: copying it onto itself is a no-op, never a self-deletion.
	if (resolve(workspacePath) === snapshotDir) return snapshotDir;
	for (const path of [snapshotDir, tmp]) {
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (!st) continue;
		if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`publish snapshot path ${path} is not a real directory; refusing to remove`);
		const canonical = realpathSync(path);
		if (canonical !== resolve(path) || !canonical.startsWith(`${canonicalParent}${sep}`)) {
			throw new Error(`publish snapshot path ${path} escapes its private root; refusing to remove`);
		}
		rmSync(path, { recursive: true, force: true });
	}
	// ponytail: full worktree copy (ignored build artifacts included — publishBranch
	// staging's .gitignore still excludes them); per-file delta copy if size bites
	mkdirSync(tmp, { mode: 0o700 });
	try {
		if (signal?.aborted) throw new Error("publish snapshot copy aborted");
		cpSync(workspacePath, tmp, { recursive: true, verbatimSymlinks: true, filter: (src) => basename(src) !== ".git" });
		const staged = lstatSync(tmp);
		if (staged.isSymbolicLink() || !staged.isDirectory() || realpathSync(tmp) !== tmp) {
			throw new Error(`publish snapshot staging path ${tmp} is not a real private directory`);
		}
		renameSync(tmp, snapshotDir);
	} catch (error) {
		const st = lstatSync(tmp, { throwIfNoEntry: false });
		if (st && st.isDirectory() && realpathSync(tmp) === tmp) rmSync(tmp, { recursive: true, force: true });
		throw error;
	}
	return snapshotDir;
}

/** Deduplicated (path, sha256) artifact receipts across all trial receipts. */
function draftEvidenceReceipts(trials: TrialReceipt[]): Array<{ path: string; sha256: string }> {
	const byPath = new Map<string, string>();
	for (const trial of trials) {
		for (const artifact of trial.artifacts) byPath.set(artifact.path, artifact.sha256);
	}
	return [...byPath].map(([path, sha256]) => ({ path, sha256 }));
}

function draftContinuation(payload: DraftPayload): ActionContinuation {
	return { stage: "draft", state: continuationState("draft", payload) };
}

/**
 * Publish the verified tree, open the draft PR, report, and park. Shared by
 * the live post-window path (gates just proven, workspace present) and the
 * crash-resume path (no workspace; the branch comes from the journal
 * receipt). Replays are idempotent through the action journal; the verified
 * receipts and the draft continuation commit atomically.
 */
async function publishDraftAndReport(
	deps: RunDeps,
	workspacePath: string | null,
	cleanup: (() => Promise<unknown>) | null,
	payload: DraftPayload,
	options: { freshGate: boolean },
): Promise<BennyRunResult> {
	const { run, config } = deps;
	// Irreversible-gate evidence proof: the retained evidence bytes must still
	// exist and match their receipts BEFORE any publication write. Hashes
	// persisted in checkpoints are claims; readPublishedEvidence re-reads and
	// rehashes the actual content-addressed files outside any live workspace.
	let evidenceProblem: string | undefined;
	try {
		if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) {
			evidenceProblem = "draft continuation carries no evidence receipts; refusing to publish without provable evidence";
		} else {
			const receipts = new Map(payload.evidence.map((item) => [item.path, item.sha256]));
			const data = await readPublishedEvidence(deps.target, config.control.artifact_directory, [...receipts.keys()]);
			const mismatched = data.find((item) => receipts.get(item.path) !== item.sha256);
			if (mismatched) evidenceProblem = `published evidence ${mismatched.path} does not match its recorded receipt hash`;
		}
	} catch (error) {
		evidenceProblem = `retained evidence failed verification: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (evidenceProblem) {
		await cleanup?.();
		// A blocked settlement is terminal unless shutdown interrupted the
		// evidence check; an aborted run is requeued and may still resume the
		// pre-intent draft path from the retained snapshot (REL-DRAFT-001).
		if (!deps.signal?.aborted) discardPublishSnapshot(deps.target, payload.sourceDir, deps.diagnostics);
		const diagnostic = `${evidenceProblem}; branch and evidence retained, no pull request opened`;
		await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	}
	// REL-DRAFT-001: retain a host-side copy of the verified patched source
	// BEFORE the pre-dispatch continuation, so a crash in the pre-intent
	// window (no publish-branch journal row yet, workspace already cleaned)
	// can still re-dispatch the real publication after restart.
	let publishPayload = payload;
	let snapshotDir: string | undefined;
	if (workspacePath) {
		snapshotDir = retainPublishSnapshot(deps.target, run.id, workspacePath, deps.signal);
		publishPayload = { ...payload, sourceDir: snapshotDir };
	}
	// `cleanup` is disposable disposal only (the live workspace) and never
	// touches the retained snapshot. Snapshot deletion goes through
	// releasePublishSnapshot, allowed only after a done branch receipt or a
	// non-aborted terminal outcome: an abort between the persisted draft
	// continuation and publishBranch's journal.begin must keep the snapshot —
	// the requeued run's only publication source.
	const releasePublishSnapshot = (): void => {
		if (!snapshotDir) return;
		discardPublishSnapshot(deps.target, snapshotDir, deps.diagnostics);
		snapshotDir = undefined;
	};
	const cleanupAll = async (release: boolean): Promise<void> => {
		await cleanup?.();
		if (release && !deps.signal?.aborted) releasePublishSnapshot();
	};
	// Pre-dispatch continuation: stage 'draft' and the full payload commit
	// atomically BEFORE the branch write, so a crash mid-publish leaves a
	// readable continuation naming the journal intent (never a stage without
	// its resume payload).
	persistContinuation(deps.db, run, "draft", continuationState("draft", publishPayload));
	let pr: RemoteReceipt;
	try {
		const branch = await deps.actions.publishBranch(
			actionId(run.id, "publish-branch", 1),
			{
			sourceDir: workspacePath ?? "",
			sourceManifest: publishPayload.tree,
			head: publishPayload.head,
			base: publishPayload.base,
			baseOid: publishPayload.baseOid,
			message: publishPayload.title,
		},
		{ continuation: draftContinuation(publishPayload) },
		);
		const headOid = typeof branch.observed.oid === "string" ? branch.observed.oid : "";
		if (!branch.verified || !headOid || branch.observed.tree !== payload.tree) {
			throw new ActionFailure("uncertain", "published branch is not bound to the verified workspace snapshot");
		}
		const prActionId = actionId(run.id, "draft-pr", 1);
		// A resumed publication reruns the REAL ownership/fix-artifact gate
		// against a fresh source read unless the draft write already completed.
		if (options.freshGate && deps.journal.peek?.(prActionId)?.state !== "done") {
			const freshGate = await gateDecision(deps, await deps.actions.readThread());
			if (freshGate.owned) {
				const diagnostic = `a person claimed the fix before draft publication (${freshGate.ownership_reason}); branch ${payload.head} retained without a pull request`;
				await deps.ops.update(`${config.status_emoji.blocked} ${diagnostic}`);
				await cleanupAll(true);
				settleBennyRun(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
				return result(deps.db, run, "succeeded", diagnostic, deps.diagnostics);
			}
			if (freshGate.existing_fix_ref) {
				await cleanupAll(true);
				return verifyExistingFix(deps, freshGate.existing_fix_ref, payload.trackerUrl);
			}
		}
		pr = await deps.actions.createDraft(
			prActionId,
		{ head: publishPayload.head, headOid, base: publishPayload.base, baseOid: publishPayload.baseOid, title: publishPayload.title, body: publishPayload.body },
			{ continuation: draftContinuation(publishPayload) },
		);
	} catch (error) {
		// Preserve the retained snapshot first: an abort rethrows to the
		// driver's queued-row release and the requeued run resumes the
		// pre-intent draft path from the snapshot. Every non-aborted outcome
		// below is terminal, so the snapshot is released before settling.
		await cleanupAll(false);
		if (deps.signal?.aborted) throw error;
		releasePublishSnapshot();
		if (error instanceof ActionFailure) {
			const diagnostic = `draft pull request did not land (${error.message}); branch ${payload.head} and evidence retained; never reporting success`;
			await deps.ops.update(`${config.status_emoji.fix_failed} ${diagnostic}`);
			const status: BennyRunStatus = error.certainty === "uncertain" ? "blocked" : "failed";
			settleBennyRun(deps.db, run, status, diagnostic, deps.diagnostics);
			return result(deps.db, run, status, diagnostic, deps.diagnostics);
		}
		throw error;
	}
	if (pr.observed.isDraft !== true) {
		await cleanupAll(true);
		const diagnostic = "pull request readback is not a draft; refusing to report success";
		await deps.ops.update(`${config.status_emoji.fix_failed} ${diagnostic}`);
		settleBennyRun(deps.db, run, "failed", diagnostic, deps.diagnostics);
		return result(deps.db, run, "failed", diagnostic, deps.diagnostics);
	}

	const published = await deps.ops.update(`${config.status_emoji.pull_request_opened} Draft pull request opened: ${pr.url ?? pr.id}`);
	await cleanupAll(true);
	const canaryEvidence = pr.verified && typeof pr.observed.headOid === "string"
		? ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"]
		: [];
	const followupMs = config.budgets.operations_follow_up_minutes * 60_000;
	if (published && followupMs > 0 && remaining(deps) > followupMs + 30_000) {
		const notBefore = Date.now() + followupMs;
		parkBennyRun(
			deps.db,
			run,
			"operations-followup",
			notBefore,
			null,
			JSON.stringify({ operationsRoot: published.root, publishedTs: published.ts, plan: payload.plan, revision: payload.revision, prUrl: String(pr.url ?? pr.id), canaryEvidence } satisfies OperationsFollowupState),
		);
		return { phase: "reproduce", status: "queued", duplicate: false, stage: "operations-followup", actions: deps.diagnostics };
	}
	settleBennyRun(deps.db, run, "succeeded", undefined, deps.diagnostics);
	return result(deps.db, run, "succeeded", undefined, deps.diagnostics, canaryEvidence);
}


/** Containment-validated publish snapshot path: must be a real directory inside the run's benny-publish-source root. */
function containedPublishSnapshot(target: string, sourceDir: string): string {
	const parent = securePrivateDir(stateDir(target), "benny-publish-source");
	const canonical = realpathSync(sourceDir);
	const st = lstatSync(sourceDir);
	const canonicalParent = realpathSync(parent);
	if (st.isSymbolicLink() || !st.isDirectory() || canonical !== resolve(sourceDir) || !canonical.startsWith(`${canonicalParent}${sep}`)) {
		throw new Error(`${sourceDir} is not a real directory inside ${canonicalParent}`);
	}
	return resolve(sourceDir);
}

/**
 * REL-RETENTION-003: deletion only through the same containment validation
 * the resume path reads through — an invalid or escaping path is reported,
 * never deleted.
 */
function discardPublishSnapshot(target: string, sourceDir: string | undefined, diagnostics: string[]): void {
	if (!sourceDir) return;
	try {
		const snapshot = containedPublishSnapshot(target, sourceDir);
		if (lstatSync(snapshot, { throwIfNoEntry: false })) rmSync(snapshot, { recursive: true, force: true });
	} catch (error) {
		diagnostics.push(`retained publish snapshot not removed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
 * Resume a run parked at the draft stage. The workspace is gone, so the
 * branch must come from the journal receipt and the continuation payload is
 * the only resume source. A branch publication has no compensation action:
 * an unreadable continuation or an unverifiable branch receipt blocks the
 * run instead of retrying or claiming success.
 */
export async function resumeDraft(deps: RunDeps): Promise<BennyRunResult> {
	const { run } = deps;
	const cont = parseContinuation<DraftPayload>(run);
	const payload = cont?.data;
	const blocked = (diagnostic: string): BennyRunResult => {
		// Terminal blocked resume: a retained snapshot has no future resume
		// owner; delete it (containment-validated) instead of leaking it.
		discardPublishSnapshot(deps.target, payload?.sourceDir, deps.diagnostics);
		settleBennyRun(deps.db, run, "blocked", diagnostic, deps.diagnostics);
		return result(deps.db, run, "blocked", diagnostic, deps.diagnostics);
	};
	// Shared-contract reclaim: before the resumed draft path publishes OR
	// terminalizes, every crash-left workspace resource for this exact logical
	// run (and its derived suffixes) is reclaimed or proven absent. An
	// unprovable absence blocks fail-closed — never a remote write alongside
	// unowned live containers. An aborted resume neither publishes nor
	// terminalizes (the driver requeues it), so the reclaim is skipped there.
	if (!deps.signal?.aborted) {
		try {
			await reclaimBennyRunResources(deps.target, String(run.id));
		} catch (error) {
			return blocked(`run workspace resources could not be reclaimed or proven absent: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!cont || !payload?.head || !payload.tree || !payload.plan?.steps?.length) {
		return blocked("draft stage has no readable continuation; the branch publication cannot be re-verified or compensated — reconcile the action journal");
	}
	if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) {
		return blocked("draft continuation carries no evidence receipts; evidence bytes cannot be re-proven before publication");
	}
	if (payload.revision !== run.repo_revision) {
		return blocked(`draft continuation revision ${payload.revision} does not match the admitted revision ${run.repo_revision}`);
	}
	const branchEntry = deps.journal.peek?.(actionId(run.id, "publish-branch", 1));
	if (!branchEntry) {
		// REL-DRAFT-001 pre-intent window: the continuation persisted but the
		// publication never dispatched — NO journal row exists, so no push can
		// have landed and there is nothing to reconcile. A retained source
		// snapshot re-dispatches the REAL publication (journal.begin runs
		// fresh); without it the run blocks fail-closed.
		if (payload.sourceDir && lstatSync(payload.sourceDir, { throwIfNoEntry: false })) {
			// PSTACK-SEC-PATH-001: the persisted path is rm'd and re-dispatched —
			// revalidate canonical private containment before any filesystem
			// write through it.
			const snapshot = containedPublishSnapshot(deps.target, payload.sourceDir);
			return publishDraftAndReport(
				deps,
				snapshot,
				// The "workspace" IS the retained snapshot: no disposable
				// cleanup here. Its release is owned by publishDraftAndReport —
				// preserved on abort so the requeued run keeps its only
				// publication source, deleted only after a done branch receipt
				// or a non-aborted terminal outcome.
				null,
				payload,
				{ freshGate: true },
			);
		}
		return blocked("branch publication never began and no retained source snapshot exists; refusing to resume the draft path");
	}
	if (branchEntry.state !== "done" || !branchEntry.receipt) {
		return blocked("branch publication is not verifiably complete in the action journal; refusing to resume the draft path");
	}
	// REL-RETENTION-003: the branch journal is done — the persisted snapshot
	// has no resume role on ANY terminal outcome of this dispatch (the
	// reconcile-only replay uses only the persisted tree/commit receipts).
	// Remove it (containment-validated) before continuing.
	discardPublishSnapshot(deps.target, payload.sourceDir, deps.diagnostics);
	return publishDraftAndReport(deps, null, null, payload, { freshGate: true });
}

async function fixFailed(deps: RunDeps, workspace: BennyWorkspace, reason: string): Promise<BennyRunResult> {
	await workspace.cleanup();
	const diagnostic = `fix did not land: ${reason}`;
	await deps.ops.update(`${deps.config.status_emoji.fix_failed} ${diagnostic}`);
	settleBennyRun(deps.db, deps.run, "failed", diagnostic, deps.diagnostics);
	return result(deps.db, deps.run, "failed", diagnostic, deps.diagnostics);
}

async function rejectionCheck(deps: RunDeps, thread: SlackMessage[]): Promise<z.infer<typeof RejectionDecision>> {
	const session = await openBennySession(sessionOptions(deps, deps.config.models.reproduce, Math.min(remaining(deps), 5 * 60_000), [actionsTool(deps.actions)]));
	try {
		return await askStructured(
			session,
			[
				"Did a person (not a bot, not the triage identity) reject this repro's setup or interpretation during the window? Judge the thread only.",
				"",
				"Thread:",
				threadText(thread),
				"",
				'Respond with ONLY: {"rejected": boolean, "reason": string}',
			].join("\n"),
			RejectionDecision,
		);
	} finally {
		await session.dispose();
	}
}

async function applyFix(deps: RunDeps, workspace: BennyWorkspace, plan: ReproPlan): Promise<FixResult> {
	const session = await openBennySession(
		sessionOptions(deps, deps.config.models.code, Math.min(remaining(deps), deps.config.budgets.fix_minutes * 60_000), [
			workspaceTool(workspace, "fix", true),
			repoTool(deps.target, deps.run.repo_revision, deps.run.deadline_ms, deps.signal),
		]),
	);
	try {
		return await askStructured(
			session,
			[
				"You may edit the disposable workspace (write/exec tools; the patched app will be rebuilt from it). Fix the root cause with the smallest justified change; keep unrelated cleanup out; run focused tests via exec.",
				"",
				"Repro plan (discriminating state):",
				JSON.stringify(plan, null, 2),
				"",
				"Respond with ONLY JSON:",
				'{"summary": string, "changed_files": string[], "tests_run": string[], "commit_message": string}',
			].join("\n"),
			FixResult,
		);
	} finally {
		await session.dispose();
	}
}

async function blastRadius(deps: RunDeps, workspace: BennyWorkspace, fix: FixResult): Promise<z.infer<typeof BlastRadiusDecision>> {
	const session = await openBennySession(
		sessionOptions(deps, deps.config.models.code, Math.min(remaining(deps), 15 * 60_000), [workspaceTool(workspace, "verify", false), repoTool(deps.target, deps.run.repo_revision, deps.run.deadline_ms, deps.signal)]),
	);
	try {
		return await askStructured(
			session,
			[
				"Smoke the blast radius around the changed behavior (read-only). Cover nearby states, inputs, and failure paths the change could affect. Verify the changed files exist and the tests were actually run where possible.",
				"",
				"Changed files:",
				JSON.stringify(fix.changed_files),
				"",
				'Respond with ONLY: {"passed": boolean, "checks": string[]}',
			].join("\n"),
			BlastRadiusDecision,
		);
	} finally {
		await session.dispose();
	}
}

/**
 * Two-build verification for an existing fix: baseline (PR base) twice broken,
 * patched (PR head) twice correct. No authored replacement, ever. Returns a
 * typed result: only a fully verified proof is success; inconclusive trials,
 * an insufficient fix, and source-reply delivery failures are all failures the
 * caller must propagate — never an unconditional success.
 */
async function twoBuildProof(
	deps: RunDeps,
	options: { existingFix: string; base: string; head: string; trackerUrl?: string },
): Promise<{ verified: boolean; diagnostic: string }> {
	const { run, config } = deps;
	const studyWorkspace = await readOnlyWorkspace(deps);
	let plan: ReproPlan;
	try {
		plan = await studyPlan(deps, studyWorkspace);
	} finally {
		await studyWorkspace.cleanup();
	}
	await deps.ops.update(`${config.status_emoji.reproducing} Verifying existing fix #${options.existingFix}`);
	// A "fix" whose head tree equals the base tree changes nothing; two-build
	// proof cannot credit it. Compare immutable tree OIDs, never worktrees.
	if (gitTreeOid(deps.target, options.base) === gitTreeOid(deps.target, options.head)) {
		return { verified: false, diagnostic: "existing fix artifact changes nothing: its head tree equals the base tree" };
	}

	// Baseline build: the symptom must reproduce twice with independent resets.
	const baseline: TrialReceipt[] = [];
	const baselineArtifacts: TrialOutcome["artifacts"] = [];
	const baseWorkspace = await createBennyWorkspace({
		config,
		cwd: deps.target,
		runId: `${run.id}-base`,
		logicalRunId: String(run.id),
		revision: options.base,
		artifactDir: config.control.artifact_directory,
		deadline: run.deadline_ms,
		imageId: run.image_id || undefined,
		signal: deps.signal,
	});
	try {
		await bringUpConfiguredApp(baseWorkspace, config, "reproduce", {
			probe: true,
			revision: options.base,
			environment: config.control.environment,
		});
		for (let attempt = 1; attempt <= 2; attempt++) {
			const trial = await runTrial(deps, baseWorkspace, plan, { phase: "baseline", revision: options.base, attempt, expected: "broken" });
			baseline.push(trial.receipt);
			baselineArtifacts.push(...trial.artifacts);
			if (trial.receipt.observed !== "broken") {
				return { verified: false, diagnostic: "inconclusive: the symptom does not appear on the baseline; the existing fix cannot be credited" };
			}
		}
		const baselineReview = await reviewMedia({
			config,
			imageId: run.image_id,
			runId: String(run.id),
			artifacts: baselineArtifacts,
			prompt: `Does this evidence visibly show the discriminating broken final state: ${plan.discriminating_state}? The correct state would be: ${plan.expected_state}.`,
			deadline: run.deadline_ms,
			cwd: deps.target,
			signal: deps.signal,
		});
		if (!baselineReview.confirmed) return { verified: false, diagnostic: "inconclusive: media review did not confirm the baseline broken state" };
	} finally {
		await baseWorkspace.cleanup();
	}

	// Patched build: the symptom must be gone twice. The existing fix is never edited or replaced.
	const patchedArtifacts: TrialOutcome["artifacts"] = [];
	const headWorkspace = await createBennyWorkspace({
		config,
		cwd: deps.target,
		runId: `${run.id}-head`,
		logicalRunId: String(run.id),
		revision: options.head,
		artifactDir: config.control.artifact_directory,
		deadline: run.deadline_ms,
		imageId: run.image_id || undefined,
		signal: deps.signal,
	});
	try {
		await bringUpConfiguredApp(headWorkspace, config, "reproduce", {
			probe: true,
			revision: options.head,
			environment: config.control.environment,
		});
		for (let attempt = 1; attempt <= 2; attempt++) {
			const trial = await runTrial(deps, headWorkspace, plan, { phase: "patched", revision: options.head, attempt, expected: "correct" });
			patchedArtifacts.push(...trial.artifacts);
			if (trial.receipt.observed !== "correct") {
				return { verified: false, diagnostic: "existing fix insufficient: the symptom persists on the patched build; reporting, not editing" };
			}
		}
		const patchedReview = await reviewMedia({
			config,
			imageId: run.image_id,
			runId: String(run.id),
			artifacts: patchedArtifacts,
			prompt: `Does this evidence visibly show the expected correct final state: ${plan.expected_state}? The broken state would be: ${plan.discriminating_state}.`,
			deadline: run.deadline_ms,
			cwd: deps.target,
			signal: deps.signal,
		});
		if (!patchedReview.confirmed) return { verified: false, diagnostic: "inconclusive: media review did not confirm the patched correct state" };
	} finally {
		await headWorkspace.cleanup();
	}

	try {
		await deps.actions.postThread(
			actionId(run.id, "verify-existing", 1),
			[
				`Existing fix #${options.existingFix} verified against real builds:`,
				`- Baseline (${options.base}): symptom present twice, media-confirmed`,
				`- Patched (${options.head}): symptom absent twice, media-confirmed`,
				options.trackerUrl ? `Tracker: ${options.trackerUrl}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			{ allowedUserIds: reproduceMentionSet(deps) },
		);
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		return { verified: false, diagnostic: `existing fix verified against real builds, but the source reply failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	await deps.ops.update(`${config.status_emoji.reproduced} Verified existing fix #${options.existingFix}`);
	return { verified: true, diagnostic: `existing fix #${options.existingFix} verified against real builds` };
}

async function readOnlyWorkspace(deps: RunDeps): Promise<BennyWorkspace> {
	return createBennyWorkspace({
		config: deps.config,
		cwd: deps.target,
		runId: `${deps.run.id}-plan`,
		logicalRunId: String(deps.run.id),
		revision: deps.run.repo_revision,
		artifactDir: deps.config.control.artifact_directory,
		deadline: deps.run.deadline_ms,
		imageId: deps.run.image_id || undefined,
		signal: deps.signal,
	});
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function result(
	db: Database,
	run: BennyRunRow,
	status: BennyRunStatus,
	diagnostic: string | undefined,
	actions: string[],
	canaryEvidence: string[] = [],
): BennyRunResult {
	// Fresh terminal outcome: the persisted-row reload (the same seam the
	// duplicate path uses) supplies the committed phase and stage, so a
	// returned terminal stage always equals the stage in SQLite — the claimed
	// row snapshot this caller holds is never the authority. Only canary
	// evidence is ephemeral: merged from this invocation, never persisted.
	return { ...persistedRunResult(db, run), status, duplicate: false, diagnostic, actions, canaryEvidence };
}

/** Test seam for the terminal outcome builder (same fresh-read contract as persistedRunResult). */
export { result as freshTerminalResult };
/** The admission body persisted at first admission: frozen coordinates, admitted root, canonical config snapshot. */
interface AdmissionBody {
	source: SelectedEvent["source"];
	root: SlackMessage;
	config?: BennyConfig;
}

/** Parse and minimally shape-check an admission body; undefined when unreadable or shapeless. */
function parseAdmissionBody(raw: string): AdmissionBody | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!record(parsed)) return undefined;
		const source = parsed.source;
		const root = parsed.root;
		if (
			!record(source) || typeof source.teamId !== "string" || typeof source.channel !== "string" || typeof source.rootTs !== "string" ||
			!record(root) || typeof root.ts !== "string"
		) {
			return undefined;
		}
		if (parsed.config !== undefined && !record(parsed.config)) return undefined;
		return {
			source: { teamId: source.teamId, channel: source.channel, rootTs: source.rootTs },
			root: { ...root, ts: root.ts },
			config: parsed.config as BennyConfig | undefined,
		};
	} catch {
		return undefined;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Route ONE unresolved journal row back to the SAME action method it was
 * written for. The journaled input is the durable pre-dispatch continuation:
 * the action's journal.begin sees the existing open/uncertain intent and
 * mutate() runs its reconcile path only — never a blind re-dispatch. Any
 * failure (unknown kind, unreadable input, reconcile error) throws and the
 * caller blocks the run fail-closed.
 */
async function replayJournalIntent(actions: BennyActions, row: { action_id: string; kind: string; input: string }): Promise<RemoteReceipt> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.input);
	} catch {
		throw new Error("journal input is not readable JSON");
	}
	const data = record(parsed) ? parsed : {};
	const read = (key: string): string => {
		const value = data[key];
		if (typeof value !== "string") throw new Error(`journal input field '${key}' is missing`);
		return value;
	};
	const opt = (key: string): string => (typeof data[key] === "string" ? (data[key] as string) : "");
	switch (row.kind) {
		case "slack.postThread":
			return actions.postThread(row.action_id, read("text"));
		case "slack.operations.update":
			return actions.operationsUpdate(row.action_id, read("text"), read("rootTs"));
		case "slack.operations.post":
			return actions.operationsUpdate(row.action_id, read("text"));
		case "slack.operations.reply":
			return actions.postOperationsReply(row.action_id, read("rootTs"), read("text"));
		case "tracker.create":
			return actions.trackerCreate(row.action_id, { title: read("title"), description: opt("description"), category: read("category") as TrackerCategory });
		case "tracker.recurrence":
			return actions.trackerRecurrence(row.action_id, read("id"), read("description"));
		case "tracker.compensate":
			return actions.trackerCompensate(row.action_id, read("id"));
		// Validation precedes journal.begin in publishBranch and a resumed run
		// carries no workspace, so re-invocation can never reach the
		// begin->reconcile path: it throws and the run blocks fail-closed.
		case "git.publishBranch":
			// REL-GIT replay: sourceDir stays empty (a resumed run has no
			// workspace). The actions broker's publishBranch routes an
			// open/uncertain intent through its reconcile-only path using the
			// persisted tree/commit/head/base — no source validation, never a
			// push resend. Requires the broker's optional `commit` input.
			return actions.publishBranch(row.action_id, {
				sourceDir: "",
				sourceManifest: read("tree"),
				head: read("head"),
				base: read("base"),
				baseOid: read("baseOid"),
				commit: read("commit"),
				message: "",
			});
		case "github.createDraft":
			return actions.createDraft(row.action_id, {
				head: read("head"),
				headOid: read("headOid"),
				base: read("base"),
				baseOid: read("baseOid"),
				title: read("title"),
				body: opt("body"),
			});
		default:
			throw new Error(`unknown journal kind '${row.kind}'`);
	}
}

/**
 * Reconcile every open/uncertain journal write BEFORE stage dispatch: each
 * row is routed to the same action's reconcile-only path. Rows that settle
 * 'done' are resolved; anything else leaves the run blocked with the exact
 * ambiguity — never resent, never silently skipped.
 */
async function reconcilePendingWrites(deps: RunDeps): Promise<string[]> {
	const rows = deps.db
		.query("SELECT action_id, kind, input, state FROM benny_journal WHERE run_id = ? AND state != 'done' ORDER BY created_at, action_id")
		.all(deps.run.id) as Array<{ action_id: string; kind: string; input: string; state: string }>;
	const problems: string[] = [];
	for (const row of rows) {
		try {
			await replayJournalIntent(deps.actions, row);
		} catch (error) {
			// REL-SOCKET-001: shutdown must propagate out of reconciliation —
			// converting an abort into a problem string would terminally
			// settle an acknowledged row with an unresolved intent.
			if (deps.signal?.aborted) throw error;
			problems.push(`${row.action_id} (${row.kind}) reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const row of rows) {
		const current = deps.db.query("SELECT state FROM benny_journal WHERE action_id = ?").get(row.action_id) as { state: string } | undefined;
		if (current?.state !== "done") problems.push(`${row.action_id} (${row.kind}) is still ${current?.state ?? row.state}`);
	}
	return [...new Set(problems)];
}

async function executeBennyRun(db: Database, target: string, run: BennyRunRow, signal?: AbortSignal): Promise<BennyRunResult> {
	const block = (diagnostic: string): BennyRunResult => {
		settleBennyRun(db, run, "blocked", diagnostic, []);
		return { ...result(db, run, "blocked", diagnostic, []), duplicate: false };
	};
	const lockRow = db.query("SELECT body FROM runs WHERE id = ?").get(run.run_id) as { body: string } | undefined;
	if (!lockRow) return block("checkout row missing; refusing to execute");
	// The STORED canonical config snapshot is the sole execution source —
	// never the live configuration file, which may be disabled, corrupt or
	// edited since admission. Its hash is validated against the admitted
	// binding by bennyBindingProblem below.
	const admitted = parseAdmissionBody(lockRow.body);
	if (!admitted) return block("admission body is unreadable; refusing to execute");
	if (!admitted.config) return block("stored admission body carries no config snapshot; refusing to execute a pre-snapshot row");
	const config = admitted.config;
	if (admitted.source.rootTs !== run.root_ts || admitted.source.channel !== run.channel) {
		return block("admitted source coordinates do not match the run row; refusing to execute");
	}
	// Revalidate the admitted binding before EVERY execution, resumed or
	// fresh: the stored snapshot's hash must equal the admitted config hash
	// and the admitted commit object must exist. A live HEAD that advanced
	// past admission never blocks execution — the admitted revision is the
	// sole behavior source (see bennyBindingProblem).
	const bindingProblem = bennyBindingProblem(config, target, run);
	if (bindingProblem) return block(bindingProblem);
	const diagnostics: string[] = [];
	let outcome: BennyRunResult | undefined;
	let closeFailure: string | undefined;
	try {
		const journal = new BennyJournal(db, run.id);
		const actions = await createBennyActions({
			config,
			cwd: target,
			source: admitted.source,
			deadline: run.deadline_ms,
			journal,
			signal,
			expectedRootDigest: rootDigest(admitted.root),
			runId: run.id,
		});
		const deps: RunDeps = {
			db,
			config,
			target,
			run,
			source: admitted.source,
			root: admitted.root,
			signal,
			diagnostics,
			ops: opsTracker(actions, config, run.id, diagnostics, journal, signal),
			actions,
			journal,
		};
		try {
			// Reconcile unresolved journal writes BEFORE any stage dispatch: the
			// reconcile-only replay resolves verified writes or blocks the run.
			const pendingWrites = await reconcilePendingWrites(deps);
			if (pendingWrites.length > 0) {
				const diagnostic = `unresolved remote writes could not be reconciled: ${pendingWrites.join("; ")} — blocked fail-closed, never resent`;
				settleBennyRun(db, run, "blocked", diagnostic, diagnostics);
				outcome = result(deps.db, run, "blocked", diagnostic, diagnostics);
			} else if (run.phase === "triage") {
				outcome = await runTriage(deps);
			} else {
				outcome = await runReproduce(deps);
			}
		} finally {
			// REL-RETENTION-003: the run's publication scratch is cleaned on EVERY
			// outcome after action creation — the run barrier never leaves normal
			// runs owning scratch state (crash-left directories fall to the
			// workspace retention sweep). A close failure is aggregated honestly
			// into diagnostics and the returned diagnostic, never swallowed and
			// never allowed to mask the run's own outcome.
			try {
				await actions.close();
			} catch (closeError) {
				closeFailure = `publication scratch cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
				diagnostics.push(closeFailure);
			}
		}
	} catch (error) {
		// Shutdown is checked BEFORE ActionFailure classification: the Slack
		// and tracker brokers convert an external abort into an
		// ActionFailure("uncertain"), and a terminal `blocked` settlement here
		// would abandon an acknowledged admitted row with an unresolved
		// journal intent. Release the owned row to queued instead.
		if (signal?.aborted) {
			// REL-SOCKET-001: graceful shutdown never terminalizes acknowledged
			// admitted work — the owned row is released back to queued so
			// startup recovery re-claims it and reconciles open/uncertain
			// journal writes through the reconcile-only replay.
			releaseBennyRunForRecovery(db, run, "shutdown; run released for recovery before terminal settlement");
			outcome = { ...result(db, run, "queued", undefined, diagnostics), duplicate: false };
		} else if (error instanceof ActionFailure) {
			const diagnostic = `action failure (${error.certainty}): ${error.message}`;
			settleBennyRun(db, run, "blocked", diagnostic, diagnostics);
			outcome = result(db, run, "blocked", diagnostic, diagnostics);
		} else {
			const diagnostic = error instanceof Error ? error.message : String(error);
			settleBennyRun(db, run, "failed", diagnostic, diagnostics);
			outcome = result(db, run, "failed", diagnostic, diagnostics);
		}
	}
	if (!outcome) outcome = result(db, run, "failed", "run ended without an outcome", diagnostics);
	// Aggregate the close failure honestly: it never masks the run's own
	// outcome, but it is never silently dropped either.
	if (closeFailure) {
		outcome = { ...outcome, diagnostic: outcome.diagnostic ? `${outcome.diagnostic}; ${closeFailure}` : closeFailure };
	}
	return outcome;
}

export interface DrainOptions {
	configPath: string;
	event: unknown;
	phase?: "triage" | "reproduce" | "both";
	canary?: boolean;
	signal?: AbortSignal;
}

interface ClaimedOutcome {
	run: BennyRunRow;
	result: BennyRunResult;
}

/**
 * The full external-CLI path: enforce private enabled state, admit durably,
 * then drive claimed rows to terminal status. Shared admission semantics with
 * Socket Mode (same store, same dedupe, same lock).
 */
export async function runBenny(configPath: string, event: unknown, options: { phase?: "triage" | "reproduce" | "both"; canary?: boolean; signal?: AbortSignal; onAdmitted?: () => void } = {}): Promise<BennyOutcome> {
	if (options.canary && options.phase !== undefined && options.phase !== "both") {
		throw new BennyError(64, "a Benny canary must run both triage and reproduce phases");
	}
	// A pre-aborted signal admits nothing: the check runs before any config
	// load, store open, or admission.
	if (options.signal?.aborted) throw new BennyError(1, "shutdown; signal was already aborted before admission");
	const config = await loadBennyConfig(configPath);
	// Ignore/filter FIRST, before Docker image resolution, enabled/canary
	// checks, or retention: bot/reply/edit/wrong-channel envelopes are
	// harmlessly non-events and must be acknowledged as such even when no
	// operational prerequisite is available.
	const selected = selectBennyEvent(event, config);
	if (!selected) return { admitted: false, results: [] };
	const target = targetRootFor(configPath);
	const state = readBennyState(target);
	// Resolve the immutable workspace image id ONCE per invocation, before any
	// gate: admission, canary recording and execution all bind this exact id.
	const imageId = await resolveImageId(config.runtime.workspace_image);
	let enabledBinding: BennyBinding | undefined;
	if (options.canary) {
		if (state?.enabled) throw new BennyError(2, "Benny is enabled; disable background admission before running a canary");
		const drift = bennyWorktreeDrift(target, config);
		if (drift) throw new BennyError(2, `Benny canary requires a clean committed operational pack; ${drift}`);
	} else {
		// Normal admission binds to the EXACT EnableState returned by the
		// shared gate — the same config hash and repo revision the operator
		// enabled (and the canary passed) against.
		const enabled = assertBennyEnabled(target, config, imageId);
		if (!enabled.configHash || !enabled.repoRevision) {
			throw new BennyError(2, `Benny enable state is missing its config hash or repo revision binding; rerun \`${pstackCommand("benny", "enable")}\``);
		}
		enabledBinding = { configHash: enabled.configHash, repoRevision: enabled.repoRevision, canary: false, imageId };
	}
	// One binding captured once per invocation; never recaptured mid-run.
	const binding: BennyBinding = options.canary
		? { configHash: bennyConfigHash(config), repoRevision: bennyRepoRevision(target), canary: true, imageId }
		: enabledBinding!;
	// PSTACK-SEC-CONFIG-004: the loaded configuration must be the exact
	// regular blob committed at the admitted revision — mutable out-of-tree
	// bytes can never be admitted even when their YAML parses.
	const configBindingProblem = configBlobBindingProblem(configPath, target, binding.repoRevision);
	if (configBindingProblem) {
		throw new BennyError(2, `Benny configuration is not the committed bytes of revision ${binding.repoRevision.slice(0, 12)}…; ${configBindingProblem}`);
	}
	const phases: Phase[] = options.phase === "triage" ? ["triage"] : options.phase === "reproduce" ? ["reproduce"] : [...PHASES];

	const now = Date.now();
		const evidenceSweep = await sweepExpiredEvidence(target, config.control.artifact_retention_hours);
		if (evidenceSweep.storeUnreadable) console.error("pstack benny: evidence store unreadable; retention sweep skipped fail-closed");
	const slack = 60_000;
	const deadlines: Record<Phase, number> = {
		triage: now + (config.budgets.triage_total_minutes + config.budgets.triage_follow_up_minutes) * 60_000 + slack,
		reproduce:
			now +
			(config.budgets.verdict_wait_minutes +
				config.budgets.repro_minutes +
				config.budgets.rejection_window_minutes +
				config.budgets.fix_minutes +
				config.budgets.operations_follow_up_minutes) *
				60_000 +
			10 * slack,
	};

	const db = openRunStore(target);
	openBennyStore(db);
	try {
		reconcileBennyRuns(db);
		// Admit durably with the binding, the canonical parsed config snapshot
		// (the sole execution source for every resumed drain) and each phase's
		// FINAL absolute deadline persisted atomically in one transaction; a
		// duplicate returns the existing rows and never extends a deadline. A
		// duplicate whose stored binding differs throws BennyError fail-closed
		// instead of waiting on an unclaimable row.
		const admission = admitBennyEvent(db, selected, phases, deadlines, binding, config);
		// Durable admission is on disk; Socket Mode acks its envelope here so an
		// acknowledged event can never be lost, while redeliveries dedupe above.
		options.onAdmitted?.();
		const terminal = (status: string): status is BennyRunStatus => ["succeeded", "blocked", "failed", "interrupted"].includes(status);
		const outcomes = new Map<number, ClaimedOutcome>();
		const executedHere = new Set<number>();
		for (const { run } of admission.rows) {
			if (terminal(run.status)) outcomes.set(run.id, { run, result: persistedRunResult(db, run) });
		}

		for (;;) {
			if (options.signal?.aborted) break;
			// Only TERMINAL results enter outcomes; parked (queued) rows stay
			// pending so the drain keeps looping until they reach a terminal state.
			for (const { run } of admission.rows) {
				if (outcomes.has(run.id)) continue;
				const current = db.query("SELECT * FROM benny_runs WHERE id = ?").get(run.id) as BennyRunRow | undefined;
				if (current && terminal(current.status)) outcomes.set(run.id, { run: current, result: persistedRunResult(db, current) });
			}
			const pending = admission.rows.filter(({ run }) => !outcomes.has(run.id));
			if (pending.length === 0) break;
			// Every drain decision reloads the persisted row: deadlines are final
			// absolute values persisted at first admission (duplicates never
			// extend), and are judged from disk, never the admission snapshot.
			const now = Date.now();
			const reloaded = new Map<number, BennyRunRow | undefined>();
			for (const { run } of pending) {
				const current = db.query("SELECT * FROM benny_runs WHERE id = ?").get(run.id) as BennyRunRow | undefined;
				reloaded.set(run.id, current);
				if (current && !terminal(current.status) && current.deadline_ms <= now) {
					settleBennyRun(db, current, "blocked", "run deadline expired while queued; never executed", []);
				}
			}
			const claimable = pending.filter(({ run }) => (reloaded.get(run.id)?.deadline_ms ?? run.deadline_ms) > now);
			const claimed = claimBennyRun(db, binding);
			if (!claimed) {
				const nextWake = Math.min(
					...claimable.map(({ run }) => {
						const row = db.query("SELECT not_before_ms FROM benny_runs WHERE id = ?").get(run.id) as { not_before_ms: number } | undefined;
						return row ? row.not_before_ms : now;
					}),
					now + 1000,
				);
				await Bun.sleep(Math.max(Math.min(nextWake - Date.now(), 1000), 50));
				continue;
			}
			const outcome = await executeBennyRun(db, target, claimed, options.signal);
			executedHere.add(claimed.id);
			// A parked (queued) execution result keeps the row pending.
			if (terminal(outcome.status)) outcomes.set(claimed.id, { run: claimed, result: outcome });
		}

		// Explicit abort: this invocation releases ONLY what it owns. A
		// duplicate attachment never settles shared rows — the canonical
		// invocation's queued/parked rows keep their recovery state — and
		// even freshly admitted nonterminal rows are RELEASED back to queued
		// for startup recovery, never terminally interrupted (REL-SOCKET-001:
		// an acknowledged event stays resumable). The actively executed row
		// releases itself in executeBennyRun's abort path.
		if (options.signal?.aborted) {
			for (const { run, duplicate } of admission.rows) {
				if (duplicate || outcomes.has(run.id)) continue;
				const current = db.query("SELECT * FROM benny_runs WHERE id = ?").get(run.id) as BennyRunRow | undefined;
				if (current?.status === "running") {
					releaseBennyRunForRecovery(db, current, "shutdown; run released for recovery before terminal settlement");
				}
			}
		}

		// Outcomes rebuilt from the PERSISTED rows: an interrupted or settled row
		// must report its on-disk status and diagnostic, never a stale admission
		// snapshot claiming queued/success.
		const results = admission.rows.map(({ run }) => outcomes.get(run.id)?.result ?? persistedRunResult(db, run));
		const canary = options.canary
			? recordCanary(
					db,
					binding.configHash,
					selected,
					results,
					admission.rows.every((row) => !row.duplicate) && admission.rows.every(({ run }) => executedHere.has(run.id)),
					binding.repoRevision,
					binding.imageId ?? "",
				)
			: undefined;
		const diagnosticParts = results.every((item) => item.status === "succeeded") ? [] : results.map((item) => `${item.phase}: ${item.status}`);
		if (canary && !canary.passed) diagnosticParts.push(canary.reason ?? "canary did not pass");
		return {
			admitted: true,
			eventId: selected.eventId,
			results,
			diagnostic: diagnosticParts.length ? diagnosticParts.join("; ") : undefined,
			canary,
		};
	} finally {
		db.close();
	}
}

export interface BennyResumeOutcome {
	/** Rows reconciled out of dead-owner states. */
	reconciled: number;
	/** Persisted rows drained to terminal status in this invocation. */
	resumed: number;
	results: BennyRunResult[];
}

/**
 * Supervised recovery for long-lived hosts (Socket Mode startup and
 * reconnect): reconcile dead-owner rows, then drain every QUEUED row from the
 * private store to terminal status — WITHOUT admitting any new event and
 * INDEPENDENT of the live enable state or configuration file: execution uses
 * the trusted canonical config snapshot stored in each row's admission body
 * and validated against its recorded config hash and commit OID. Rows are
 * drained per exact binding so a claim never crosses identities. Every drain
 * decision reloads the persisted row, so stage, deadline and status are never
 * judged from a stale snapshot.
 */
export async function resumeBenny(configPath: string, options: { signal?: AbortSignal } = {}): Promise<BennyResumeOutcome> {
	if (options.signal?.aborted) return { reconciled: 0, resumed: 0, results: [] };
	const target = targetRootFor(configPath);
	const db = openRunStore(target);
	openBennyStore(db);
	try {
		const reconciled = reconcileBennyRuns(db).length;
		const results: BennyRunResult[] = [];
		const reload = (id: number): BennyRunRow | undefined => db.query("SELECT * FROM benny_runs WHERE id = ?").get(id) as BennyRunRow | undefined;
		// Group the queued background rows by exact (config hash, revision,
		// image id) binding; canary rows are explicit single-invocation traffic
		// and are only deadline-reconciled, never drained by a resumed host.
		const queued = db.query("SELECT * FROM benny_runs WHERE status = 'queued' AND canary = 0 ORDER BY id").all() as BennyRunRow[];
		const groups = new Map<string, BennyRunRow[]>();
		for (const row of queued) {
			const key = `${row.config_hash}:${row.repo_revision}:${row.image_id}`;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
		}
		for (const [key, rows] of groups) {
			if (options.signal?.aborted) break;
			const separator = key.indexOf(":");
			const second = key.indexOf(":", separator + 1);
			const binding: BennyBinding = {
				configHash: key.slice(0, separator),
				repoRevision: key.slice(separator + 1, second),
				canary: false,
				imageId: key.slice(second + 1) || undefined,
			};
			// The binding's stored snapshot and commit OID are the trust roots:
			// load the canonical config from the first row's admission body and
			// verify it hashes to the recorded config hash, and that the OID is
			// a locally available commit. An untrusted binding blocks its rows
			// with the exact reason instead of executing.
			const first = rows[0]!;
			const lockRow = db.query("SELECT body FROM runs WHERE id = ?").get(first.run_id) as { body: string } | undefined;
			const snapshot = lockRow ? parseAdmissionBody(lockRow.body)?.config : undefined;
			const trust = !snapshot
				? "stored admission body carries no config snapshot"
				: bennyConfigHash(snapshot) !== first.config_hash
					? `stored config snapshot hash ${bennyConfigHash(snapshot).slice(0, 12)}… does not match the admitted binding ${first.config_hash.slice(0, 12) || "(empty)"}…`
					: !/^[0-9a-f]{40,64}$/.test(first.repo_revision)
						? "admitted revision is not an immutable commit OID"
						: Bun.spawnSync(gitIsolatedArgv(["--no-replace-objects", "-C", target, "cat-file", "-e", `${first.repo_revision}^{commit}`]), { stdout: "ignore", stderr: "ignore", env: gitReadEnv() }).exitCode !== 0
							? "admitted revision is not a locally available commit object"
							: null;
			// A legacy row without an image binding is unclaimable under the
			// bound contract and must never drain on a resumed host either.
			const imageTrust = !first.image_id ? "admitted row carries no workspace image binding" : null;
			if (trust ?? imageTrust) {
				for (const row of rows) {
					const current = reload(row.id);
					if (current?.status === "queued") settleBennyRun(db, current, "blocked", `resume refuses this binding: ${trust ?? imageTrust}`, []);
				}
				continue;
			}
			// Durable retention enforcement on resumed hosts too: each trusted
			// binding sweeps evidence past its stored snapshot's window.
			const resumeSweep = await sweepExpiredEvidence(target, snapshot!.control.artifact_retention_hours); // trusted path: snapshot is defined past the refuse-gate
			if (resumeSweep.storeUnreadable) console.error("pstack benny: evidence store unreadable; retention sweep skipped fail-closed");
			for (;;) {
				if (options.signal?.aborted) break;
				const pendingIds = rows.map((row) => reload(row.id)).filter((row): row is BennyRunRow => row?.status === "queued").map((row) => row.id);
				if (pendingIds.length === 0) break;
				const now = Date.now();
				for (const id of pendingIds) {
					const current = reload(id);
					if (current && current.deadline_ms <= now) {
						settleBennyRun(db, current, "blocked", "persisted run deadline expired; never executed", []);
					}
				}
				const claimed = claimBennyRun(db, binding);
				if (!claimed) {
					const wakes = pendingIds
						.map(reload)
						.filter((row): row is BennyRunRow => row?.status === "queued" && row.deadline_ms > now)
						.map((row) => row.not_before_ms);
					if (wakes.length === 0) break;
					await Bun.sleep(Math.max(Math.min(Math.min(...wakes) - Date.now(), 1000), 50));
					continue;
				}
				results.push(await executeBennyRun(db, target, claimed, options.signal));
			}
		}
		return { reconciled, resumed: results.length, results };
	} finally {
		db.close();
	}
}

const CANARY_REQUIRED: Record<Phase, string[]> = {
	triage: ["slack.verdict.readback", "tracker.mutation.readback"],
	reproduce: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"],
};

/**
 * Record canary truth: success requires the event admitted fresh, every phase
 * freshly executed here, and each phase result succeeded with its exact
 * readback receipts and no diagnostic. Returns the truth for the CLI outcome;
 * the row binds the admitted revision and resolved immutable image id, never
 * end-of-run HEAD or a re-resolved image.
 */
export function recordCanary(
	db: Database,
	configHash: string,
	selected: SelectedEvent,
	results: BennyRunResult[],
	freshlyExecuted: boolean,
	admittedRevision: string,
	imageId: string,
): CanaryResult {
	const phasePassed = (phase: Phase) => results.some(
		(item) =>
			item.phase === phase &&
			item.status === "succeeded" &&
			item.diagnostic === undefined &&
			CANARY_REQUIRED[phase].every((receipt) => item.canaryEvidence?.includes(receipt)),
	);
	const failingPhase = (["triage", "reproduce"] as Phase[]).find((phase) => !phasePassed(phase));
	const reason = !freshlyExecuted
		? "canary rows were not all freshly executed in this invocation (duplicate admission or a parked drain)"
		: failingPhase
			? `canary ${failingPhase} phase lacks a succeeded, diagnostic-free result with the required readback receipts: ${CANARY_REQUIRED[failingPhase].join(", ")}`
			: undefined;
	const passed = freshlyExecuted && failingPhase === undefined;
	db.run("INSERT INTO benny_canary (event_id, config_hash, repo_revision, passed, observed, at, image_id) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		selected.eventId,
		configHash,
		admittedRevision,
		passed ? 1 : 0,
		JSON.stringify({ source: selected.source, freshlyExecuted, results }),
		Date.now(),
		imageId,
	]);
	return { passed, reason };
}

/** Rebuild a result from the persisted row: status, diagnostic and actions come from disk, never a stale snapshot. Exported as the outcome-assembly test seam. */
export function persistedRunResult(db: Database, run: BennyRunRow): BennyRunResult {
	const current = db.query("SELECT * FROM benny_runs WHERE id = ?").get(run.id) as BennyRunRow | undefined;
	const row = current ?? run;
	return {
		phase: row.phase,
		status: row.status,
		duplicate: true,
		stage: row.stage,
		diagnostic: row.diagnostic ?? undefined,
		actions: JSON.parse(row.actions || "[]") as string[],
	};
}

export { canaryEligible };
