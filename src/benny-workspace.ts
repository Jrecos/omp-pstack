/**
 * Benny disposable workspace: clean host checkout + split Docker boundary.
 * Two containers on a per-run internal Docker network, same trusted image:
 *   - worker: the ONLY container that mounts the run worktree and a staging
 *     volume; arbitrary exec runs here. Every model-writable filesystem is a
 *     size- and inode-bounded tmpfs with no host backing: read-only stages
 *     see the host worktree through a read-only bind, while the fix stage
 *     and artifact staging run on kernel-bounded tmpfs — a writer past the
 *     quota is kernel-stopped (ENOSPC) and no host directory can grow. /tmp
 *     and /dev/shm carry explicit byte + inode bounds too, and each memory
 *     cgroup sits above the sum of its attached tmpfs ceilings plus
 *     headroom. Fix-stage writes are seeded from the trusted host tree and
 *     copied back only after the worker is FROZEN (stopped and restarted so
 *     no background writer can race) through a Git-tree-faithful manifest
 *     gate: content, executable bits, symlink targets, and paths — links
 *     are never followed.
 *   - controller: never mounts the worktree; runs the root-owned trusted
 *     control adapter from a config-free cwd with a scrubbed environment on
 *     its own kernel-bounded control-storage tmpfs volume. The browser, its
 *     CDP endpoint (127.0.0.1 only), and all captures live on that bounded
 *     volume, unreachable from the worker except through the bound
 *     capability interface.
 *
 * Neither container ever mounts the host evidence store. Artifact bytes are
 * pulled to a host temp dir, validated (regular file, no symlink, magic,
 * size), and published content-addressed with exclusive no-overwrite into a
 * mode-0700 host-only directory, so worker-side symlinks cannot touch host
 * files or rewrite retained evidence.
 *
 * External allowed endpoints: the bundled boundary cannot enforce a per-FQDN
 * egress allowlist, so a nonempty runtime.allowed_endpoints fails closed with
 * an exact prerequisite instead of pretending to filter.
 *
 * Docker identity: names are the stable workspace namespace (`benny-ws-<run>`)
 * plus an unguessable per-run incarnation (crypto.randomBytes), and every
 * network/container carries ownership labels for that exact identity. Nothing
 * pre-existing is adopted, and nothing is stopped or removed, unless its label
 * set matches exactly — one run can never adopt or tear down another's
 * resources.
 */
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
// Re-exported for run/coordinator callers; canonical declaration lives in benny-policy.ts.
export type { ControlReceipt, ArtifactReceipt, BennyConfig } from "./benny-policy.ts";
import { resolveModelFromString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { BennyConfig, ControlReceipt, ArtifactReceipt } from "./benny-policy.ts";
import { openRunStore, securePrivateDir } from "./runner.ts";

/**
 * Artifact storage is fixed beneath the secure private root. The config field
 * must be exactly this relative literal (enforced by the schema); the
 * workspace independently re-derives the canonical location with
 * securePrivateDir and refuses any other value, so even a config that bypassed
 * parsing cannot point evidence (or its validation) elsewhere.
 */
const ARTIFACT_ROOT_SEGMENTS = [".omp", "pstack", "state", "benny-evidence"] as const;
const ARTIFACT_ROOT = ARTIFACT_ROOT_SEGMENTS.join("/");

export const CONTROL_CAPABILITIES = [
	"bring-up",
	"drive-ui",
	"drive-features",
	"inspect-state",
	"screenshot",
	"recording",
	"cleanup",
] as const;
export type ControlCapability = (typeof CONTROL_CAPABILITIES)[number];
export type WorkspaceStage = "study" | "reproduce" | "fix" | "verify";
const STAGE_ORDER: WorkspaceStage[] = ["study", "reproduce", "fix", "verify"];
const READ_ONLY_STAGES: WorkspaceStage[] = ["study", "reproduce", "verify"];

/** Blocked exact prerequisite or rejected boundary violation. Never degrades to host execution. */
export class WorkspaceBlockError extends Error {}

export interface WorkspaceOptions {
	config: BennyConfig;
	cwd: string;
	runId: string;
	/**
	 * The immutable logical run id shared by every derived workspace of one
	 * Benny run (exact, `-base`, `-head`, `-ops`, `-plan`). It derives the
	 * RETAINED-EVIDENCE directory and its aggregate byte/file budget, so
	 * sibling workspaces share one 1 GiB/256-file budget with race-safe
	 * publication. Worker resource/run names (containers, volumes, networks,
	 * the disposable run root) stay keyed to the unique `runId`. Unsafe ids
	 * are rejected. Defaults to `runId`.
	 */
	logicalRunId?: string;
	revision: string;
	artifactDir: string;
	deadline: number;
	signal?: AbortSignal;
	/**
	 * Immutable image identity (docker `sha256:...` id) resolved when the run
	 * was authorized (canary/enable state) and sourced from the coordinator's
	 * persisted binding. When provided, the live resolution must match exactly:
	 * a retagged or repulled reference fails closed instead of running
	 * uncanaried bytes. Production callers that do not yet persist image
	 * identity omit it and get the fresh per-run resolution.
	 */
	imageId?: string;
	incarnation?: string;
}

export interface ArtifactData {
	path: string;
	sha256: string;
	mimeType: string;
	data: Uint8Array;
	timestampMs: number;
}

export interface BennyWorkspace {
	workspacePath: string;
	revision: string;
	baselineHash: string;
	call(action: "read" | "write" | "exec", input: Record<string, unknown>, stage: WorkspaceStage): Promise<unknown>;
	control(capability: ControlCapability, input: Record<string, unknown>): Promise<ControlReceipt>;
	artifacts(paths: string[]): Promise<ArtifactData[]>;
	snapshotHash(): Promise<string>;
	cleanup(): Promise<unknown>;
}

const WORKSPACE_MOUNT = "/workspace";
const STAGING_MOUNT = "/artifacts";
const EXEC_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 300_000;

/**
 * Race-safe serialization for a SHARED per-logical-run evidence store: the
 * derived workspaces of one logical run (base/head/ops/plan) publish into
 * the same directory against one aggregate budget, so the usage scan, the
 * budget check, and the exclusive publish are serialized behind this
 * per-directory in-process mutex. The published name itself is exclusive
 * via the no-overwrite `wx` create.
 * ponytail: in-process lock only; a same-logical-run publisher in a second
 * process cannot exist (one runner process owns a run). If that ever
 * changes, upgrade this to a lock file next to the evidence directory.
 */
const evidenceLocks: Map<string, Promise<unknown>> = new Map();

async function withEvidenceLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
	const tail = evidenceLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const chain = tail.catch(() => undefined).then(() => gate);
	evidenceLocks.set(key, chain);
	await tail.catch(() => undefined);
	try {
		return await critical();
	} finally {
		release();
		if (evidenceLocks.get(key) === chain) evidenceLocks.delete(key);
	}
}
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/**
 * Fixed aggregate budget for HOST-RETAINED evidence per run, enforced
 * BEFORE any retained growth: an untrusted source can publish at most this
 * many bytes and files into the evidence store, no matter how many
 * artifacts it produces.
 */
const EVIDENCE_BUDGET_BYTES = 1024 * 1024 * 1024;
const EVIDENCE_BUDGET_FILES = 256;

/**
 * Kernel-enforced storage bounds for EVERY model-writable filesystem. The
 * three run volumes (fix worktree, worker staging, controller staging) are
 * size- AND inode-bounded tmpfs mounts with no host backing, and /tmp and
 * /dev/shm carry explicit byte + inode bounds on every container. A writer
 * that exceeds either bound is stopped by the kernel (ENOSPC) at write
 * time, so background writers cannot race a post-command scan, and nothing
 * a model writes can grow a host directory. Each memory cgroup is sized
 * ABOVE the sum of its attached tmpfs ceilings plus fixed headroom (tmpfs
 * pages are charged to the cgroup): a quota-equal cgroup would let one
 * full surface OOM-kill every new exec — including the `rm` that would
 * free it — instead of letting the per-surface kernel quota be the
 * binding, recoverable bound.
 */
const WORKSPACE_TMPFS_BYTES = 1024 * 1024 * 1024;
const WORKSPACE_TMPFS_INODES = 262_144;
const STAGING_TMPFS_BYTES = 512 * 1024 * 1024;
const STAGING_TMPFS_INODES = 65_536;
const CONTROL_TMPFS_BYTES = 512 * 1024 * 1024;
const CONTROL_TMPFS_INODES = 65_536;
const DECODER_TMPFS_BYTES = 768 * 1024 * 1024;
const DECODER_TMPFS_INODES = 8_192;
const TMP_TMPFS_BYTES = 512 * 1024 * 1024;
const TMP_TMPFS_INODES = 65_536;
const SHM_TMPFS_BYTES = 256 * 1024 * 1024;
const SHM_TMPFS_INODES = 65_536;
const PROCESS_HEADROOM_BYTES = 256 * 1024 * 1024;
const WORKSPACE_TMPFS_OPTS = `rw,noexec,nosuid,size=${WORKSPACE_TMPFS_BYTES},nr_inodes=${WORKSPACE_TMPFS_INODES},uid=1000,gid=1000`;
const STAGING_TMPFS_OPTS = `rw,noexec,nosuid,size=${STAGING_TMPFS_BYTES},nr_inodes=${STAGING_TMPFS_INODES},uid=1000,gid=1000`;
const CONTROL_TMPFS_OPTS = `rw,noexec,nosuid,size=${CONTROL_TMPFS_BYTES},nr_inodes=${CONTROL_TMPFS_INODES},uid=1000,gid=1000`;
const DECODER_TMPFS_OPTS = `rw,noexec,nosuid,size=${DECODER_TMPFS_BYTES},nr_inodes=${DECODER_TMPFS_INODES},uid=1000,gid=1000`;
const TMP_TMPFS_OPTS = `rw,noexec,nosuid,size=${TMP_TMPFS_BYTES},nr_inodes=${TMP_TMPFS_INODES}`;
const SHM_TMPFS_OPTS = `rw,noexec,nosuid,size=${SHM_TMPFS_BYTES},nr_inodes=${SHM_TMPFS_INODES}`;
const WORKER_MEMORY = memoryBound(WORKSPACE_TMPFS_BYTES + STAGING_TMPFS_BYTES + TMP_TMPFS_BYTES + SHM_TMPFS_BYTES + PROCESS_HEADROOM_BYTES);
const CONTROL_MEMORY = memoryBound(CONTROL_TMPFS_BYTES + TMP_TMPFS_BYTES + SHM_TMPFS_BYTES + PROCESS_HEADROOM_BYTES);
const DECODER_MEMORY = memoryBound(DECODER_TMPFS_BYTES + TMP_TMPFS_BYTES + SHM_TMPFS_BYTES + PROCESS_HEADROOM_BYTES);

function memoryBound(bytes: number): string {
	return `${Math.ceil(bytes / (1024 * 1024))}m`;
}

/** The exact kernel and aggregate bounds this boundary enforces. */
export const WORKSPACE_LIMITS = {
	workspaceTmpfs: { bytes: WORKSPACE_TMPFS_BYTES, inodes: WORKSPACE_TMPFS_INODES },
	stagingTmpfs: { bytes: STAGING_TMPFS_BYTES, inodes: STAGING_TMPFS_INODES },
	controlTmpfs: { bytes: CONTROL_TMPFS_BYTES, inodes: CONTROL_TMPFS_INODES },
	decoderTmpfs: { bytes: DECODER_TMPFS_BYTES, inodes: DECODER_TMPFS_INODES },
	tmpTmpfs: { bytes: TMP_TMPFS_BYTES, inodes: TMP_TMPFS_INODES },
	shmTmpfs: { bytes: SHM_TMPFS_BYTES, inodes: SHM_TMPFS_INODES },
	workerMemory: WORKER_MEMORY,
	controlMemory: CONTROL_MEMORY,
	decoderMemory: DECODER_MEMORY,
	evidenceBudget: { bytes: EVIDENCE_BUDGET_BYTES, files: EVIDENCE_BUDGET_FILES },
	maxArtifactBytes: MAX_ARTIFACT_BYTES,
} as const;

/**
 * Identical Git-tree-faithful manifest pipeline host-side and in-container:
 * one record per path in LC_ALL=C order — regular files contribute their
 * content hash plus the executable mode bit, symlinks contribute their
 * target, links are NEVER followed — folded into one digest. A path or
 * symlink target containing a newline would let crafted records alias two
 * different trees, so the pipeline fails closed instead of hashing an
 * ambiguous manifest.
 */
function manifestScript(dir: string): string {
	return [
		`cd '${dir.replaceAll("'", `'\\''`)}' || exit 90`,
		`records=$(find . \\( -type f -o -type l \\) -print0 | LC_ALL=C sort -z | xargs -0 -r sh -c '`,
		`nl=$(printf "\\nx"); nl=\${nl%x}`,
		`for p do`,
		`case "$p" in *"$nl"*) echo "newline in path: $p" >&2; exit 91;; esac`,
		`if [ -L "$p" ]; then`,
		`t=$(readlink -- "$p") || exit 92`,
		`case "$t" in *"$nl"*) echo "newline in symlink target: $p" >&2; exit 91;; esac`,
		`printf "l - %s %s\\n" "$t" "$p"`,
		`else`,
		`h=$(sha256sum -- "$p" 2>/dev/null | cut -d" " -f1)`,
		`[ "\${#h}" -eq 64 ] || exit 92`,
		`perm=$(stat -c %a -- "$p") || exit 92`,
		`if [ "$((0\${perm} & 0111))" -ne 0 ]; then m=x; else m=-; fi`,
		`printf "f %s %s %s\\n" "$m" "$h" "$p"`,
		`fi`,
		`done`,
		`' _) || exit $?`,
		`printf "%s\\n" "$records" | sha256sum | cut -d" " -f1`,
	].join("\n");
}

function fail(message: string): never {
	throw new WorkspaceBlockError(message);
}

function failDocker(result: { code: number; stderr: string }, what: string): never {
	fail(`${what} failed (docker exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
}
/** The errno code of a filesystem error, when it carries one. */
function errnoOf(error: unknown): string | undefined {
	// Node's fs errors are the known shape (Error + string `code`).
	return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
		? (error as NodeJS.ErrnoException).code
		: undefined;
}
function sha256(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webm": "video/webm",
	".mp4": "video/mp4",
	".json": "application/json",
	".txt": "text/plain",
	".md": "text/plain",
	".log": "text/plain",
};

/**
 * The one shared media signature detector. Returns the byte-verified MIME type
 * for a full PNG signature, a JPEG SOI (with its first marker byte), a WebM
 * EBML header, or an MP4 ftyp box; null for everything else. Every consumer
 * (publish validation, evidence sniffing, Slack download media gating in
 * benny-actions) must treat a non-null value as the ONLY trustworthy media
 * type: a declared extension or an upstream-declared mimetype is never
 * sufficient on its own, and mismatched bytes are rejected, not re-sniffed.
 */
export function detectMediaMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "video/webm" | "video/mp4" | null {
	if (
		bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
		bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
	) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
	if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
	return null;
}

function magicMatches(mimeType: string, data: Uint8Array): boolean {
	return detectMediaMime(data) === mimeType;
}

function sniffMime(path: string, data: Uint8Array): string {
	const byExtension = MIME_BY_EXTENSION[extensionOf(path)];
	if (byExtension && magicMatches(byExtension, data)) return byExtension;
	const text = Buffer.from(data).toString("utf8");
	if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
		try {
			JSON.parse(text);
			return "application/json";
		} catch {
			return "text/plain";
		}
	}
	return "application/octet-stream";
}

function sanitizeRunId(runId: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) fail(`runId '${runId}' is not a safe container name fragment`);
	return runId;
}

// ---------------------------------------------------------------------------
// Docker identity: stable workspace namespace + unguessable per-run incarnation.
// Every created network/container carries ownership labels binding it to this
// identity; nothing pre-existing is adopted (and nothing is stopped or removed)
// unless the exact label set matches, so one run can never adopt or tear down
// another run's — or anyone else's — Docker resources.
/** Every ownership-bearing label lives in this namespace. */
export const LABEL_NAMESPACE = "pstack.benny.";
// ---------------------------------------------------------------------------

export const LABEL_MANAGED = "pstack.benny.managed";
export const LABEL_RUN_ID = "pstack.benny.run-id";
export const LABEL_INCARNATION = "pstack.benny.incarnation";
export const LABEL_ROLE = "pstack.benny.role";

export type WorkspaceRole =
	| "worker"
	| "controller"
	| "network"
	| "fix-storage"
	| "artifact-storage"
	| "control-storage"
	| "media-storage";

const KNOWN_ROLES: readonly WorkspaceRole[] = [
	"worker", "controller", "network", "fix-storage", "artifact-storage", "control-storage", "media-storage",
];

export interface WorkspaceIdentity {
	runId: string;
	incarnation: string;
	namespace: string;
	worker: string;
	controller: string;
	network: string;
	/** Kernel-bounded tmpfs-backed volumes; every writable surface is one. */
	fixVolume: string;
	stageVolume: string;
	controlVolume: string;
}


export function workspaceIdentity(runId: string, incarnation: string): WorkspaceIdentity {
	const run = sanitizeRunId(runId);
	if (!/^[0-9a-f]{16}$/.test(incarnation)) fail(`incarnation '${incarnation}' must be 16 hex characters`);
	const namespace = `benny-ws-${run}`;
	return {
		runId: run,
		incarnation,
		namespace,
		worker: `${namespace}-${incarnation}`,
		controller: `${namespace}-${incarnation}-ctl`,
		network: `${namespace}-${incarnation}-net`,
		fixVolume: `${namespace}-${incarnation}-fixwork`,
		stageVolume: `${namespace}-${incarnation}-stage`,
		controlVolume: `${namespace}-${incarnation}-ctlstore`,
	};
}

export function ownershipLabels(identity: WorkspaceIdentity, role: WorkspaceRole): Record<string, string> {
	return {
		[LABEL_MANAGED]: "true",
		[LABEL_RUN_ID]: identity.runId,
		[LABEL_INCARNATION]: identity.incarnation,
		[LABEL_ROLE]: role,
	};
}

/**
 * The exact refusal reason for touching `resource`, or undefined when the
 * touch is allowed: an absent resource is a no-op for stop/remove and
 * unobstructed for create; an existing resource must carry the EXACT expected
 * ownership label set — every `pstack.benny.*` key must be one of ours with
 * exactly equal values, and any OTHER ownership-namespace key makes the
 * resource foreign. Labels outside the ownership namespace (Docker propagates
 * image OCI annotations into container labels) are not ownership-bearing and
 * never decide adoption or teardown.
 */
export function ownershipRefusal(
	found: Record<string, string> | undefined,
	expected: Record<string, string>,
	kind: "container" | "network" | "volume",
	resource: string,
	action: string,
): string | undefined {
	if (found === undefined) return undefined;
	const violations: string[] = [];
	for (const [key, value] of Object.entries(expected)) {
		if (found[key] !== value) {
			violations.push(`label '${key}' is '${found[key] ?? "<absent>"}' but this workspace identity requires '${value}'`);
		}
	}
	for (const key of Object.keys(found)) {
		if (!(key in expected) && key.startsWith(LABEL_NAMESPACE)) {
			violations.push(`label '${key}' is '${found[key]}' but is not part of this workspace identity's exact label set`);
		}
	}
	if (violations.length === 0) return undefined;
	return `refusing to ${action} ${kind} '${resource}': not owned by this workspace identity (${violations.join("; ")})`;
}
async function secureDirectory(path: string): Promise<string> {
	const expected = resolve(path);
	const before = await lstat(expected).catch(() => null);
	if (before?.isSymbolicLink()) fail(`private directory must not be a symlink: ${expected}`);
	await mkdir(expected, { recursive: true, mode: 0o700 });
	const after = await lstat(expected);
	const canonical = await realpath(expected);
	if (!after.isDirectory() || after.isSymbolicLink() || canonical !== expected) {
		fail(`private directory contains a symlinked path component: ${expected}`);
	}
	await chmod(expected, 0o700);
	return expected;
}

/** Workspace env is an explicit nonsecret allowlist; credential-looking keys are refused outright. */
function nonsecretEnv(environment: Record<string, string> | undefined): Array<[string, string]> {
	return Object.entries(environment ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`workspace env key '${key}' is not a valid identifier`);
		if (/secret|token|password|credential|api[-_]?key/i.test(key)) {
			fail(`workspace env key '${key}' looks like a credential; the workspace env allowlist is nonsecret only`);
		}
		if (typeof value !== "string") fail(`workspace env value for '${key}' must be a string`);
		return [key, value];
	});
}

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

async function boundedOutput(stream: ReadableStream<Uint8Array>, maxBytes: number, kill: () => void): Promise<Buffer> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		length += chunk.value.byteLength;
		if (length > maxBytes) {
			kill();
			await reader.cancel().catch(() => undefined);
			fail(`process output exceeded ${maxBytes} bytes`);
		}
		chunks.push(chunk.value);
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}
/**
 * One bounded, abortable subprocess. The call preflights an already-aborted
 * signal BEFORE spawning, launches the child in its own POSIX process group
 * (Bun's detached spawn), and synchronously rechecks the signal right after
 * registering the abort listener so an abort racing the spawn still kills.
 * Every kill is a group kill (negative PID) with a direct-child fallback for
 * platforms/groups where the group signal is unsupported, so no descendant
 * can outlive the call; timeout, shutdown, and output overflow all route
 * through the same kill. The process exit and both output streams are always
 * awaited before returning, so no orphaned transport can outlive the call
 * while holding this run's pipes or the shutdown path.
 */
export async function run(
	argv: string[],
	options: { input?: Uint8Array | string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; env?: Record<string, string>; scrubEnv?: boolean; cwd?: string } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
	if (options.signal?.aborted) fail(`command ${argv[0]} aborted before spawn`);
	const proc = Bun.spawn(argv, {
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: options.cwd,
		env: options.env === undefined ? undefined : options.scrubEnv ? { ...options.env } : { ...process.env, ...options.env },
		detached: true,
	});
	const kill = (): void => {
		// Negative PID signals the whole process group; the fallback covers
		// platforms/groups where the group signal is unsupported or already gone.
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
	options.signal?.addEventListener("abort", kill, { once: true });
	if (options.signal?.aborted) kill(); // registration race: the signal settled between the preflight and the listener
	const timer = setTimeout(kill, options.timeoutMs ?? EXEC_TIMEOUT_MS);
	timer.unref?.();
	try {
		if (options.input !== undefined) {
			const stdin = proc.stdin;
			if (!stdin) throw new Error("spawned process did not open a stdin pipe");
			stdin.write(options.input);
			await stdin.end();
		}
		const maxBytes = options.maxBytes ?? MAX_COMMAND_OUTPUT_BYTES;
		// All-settled: a cap failure on one stream must not abandon the other
		// stream or the child exit — every owned transport settles before any
		// error surfaces, so nothing outlives the call holding these pipes.
		const [stdoutSettled, stderrSettled, exitSettled] = await Promise.allSettled([
			boundedOutput(proc.stdout as ReadableStream<Uint8Array>, maxBytes, kill),
			boundedOutput(proc.stderr as ReadableStream<Uint8Array>, maxBytes, kill),
			proc.exited,
		]);
		if (stdoutSettled.status === "rejected") fail(stdoutSettled.reason instanceof Error ? stdoutSettled.reason.message : String(stdoutSettled.reason));
		if (stderrSettled.status === "rejected") fail(stderrSettled.reason instanceof Error ? stderrSettled.reason.message : String(stderrSettled.reason));
		const code = exitSettled.status === "fulfilled" ? exitSettled.value : -1; // proc.exited never rejects
		return { code, stdout: stdoutSettled.value, stderr: stderrSettled.value.toString("utf8") };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", kill);
	}
}

function docker(argv: string[], options?: { input?: Uint8Array | string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }) {
	return run(["docker", ...argv], options);
}

/**
 * Immutable runtime identity: resolve the configured workspace image
 * reference to its local image id. Containers and probes run by this id, so
 * a retagged or repulled tag can never substitute different bytes after the
 * canary/preflight saw the reference.
 */
export async function resolveImageId(reference: string, signal?: AbortSignal): Promise<string> {
	const result = await docker(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: 30_000, signal });
	if (result.code !== 0) fail(`workspace image ${reference} is not inspectable: ${result.stderr.trim().slice(0, 200)}`);
	const id = result.stdout.toString().trim();
	if (!/^sha256:[0-9a-f]{64}$/.test(id)) fail(`workspace image ${reference} has no immutable sha256 id (got ${JSON.stringify(id)})`);
	return id;
}

/**
 * IDs of benny rows currently queued or running in the profile-private run
 * store for this workspace, or null when the store cannot be consulted —
 * cleanup must then retain all evidence instead of guessing. Evidence
 * directories are named from benny_runs.id (the Benny row's own primary
 * key), so this queries that column — never runs.id, the unrelated generic
 * checkout row keyed by benny_runs.run_id; the two autoincrement sequences
 * diverge as soon as ordinary routine admissions interleave.
 */
function activeBennyRunIds(cwd: string): Set<string> | null {
	try {
		const db = openRunStore(cwd);
		try {
			const rows = db.query("SELECT id FROM benny_runs WHERE status IN ('queued','running')").all() as Array<{ id: number | bigint }>;
			return new Set(rows.map((row) => String(row.id)));
		} finally {
			db.close();
		}
	} catch {
		// A missing benny_runs table (no Benny run ever admitted) and every
		// other unreadable store both fail closed: retain all evidence.
		return null;
	}
}
function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Docker-label probe with a three-state result. Only a PROVEN absence (docker
 * exits nonzero and names the missing resource) is distinguishable from an
 * inspect failure: timeouts, a down daemon, or permission errors leave
 * ownership unprovable, and every destructive decision must then fail closed
 * instead of treating the resource as absent.
 */
export type DockerLabelProbe =
	| { present: false }
	| { present: true; labels: Record<string, string> }
	| { present: "unknown"; detail: string };
async function dockerLabels(kind: "container" | "network" | "volume", resource: string): Promise<DockerLabelProbe> {
	const argv =
		kind === "container"
			? ["container", "inspect", "-f", "{{json .Config.Labels}}", resource]
			: [kind, "inspect", "-f", "{{json .Labels}}", resource];
	const result = await docker(argv, { timeoutMs: 30_000 });
	if (result.code === 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout.toString("utf8"));
		} catch {
			fail(`docker returned unparseable labels for ${kind} '${resource}'`);
		}
		// An unlabeled resource renders as JSON `null`: present, provably
		// empty — never "unprovable".
		if (parsed === null) return { present: true, labels: {} };
		if (!plainObject(parsed)) fail(`docker returned non-object labels for ${kind} '${resource}'`);
		return { present: true, labels: Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])) };
	}
	if (/\b(?:no such (?:object|network|container|volume)|(?:network|container|volume) .+ not found)\b/i.test(result.stderr)) return { present: false };
	return { present: "unknown", detail: result.stderr.trim().slice(0, 200) || `docker exit ${result.code}` };
}

export type VolumeDefinitionProbe =
	| { present: false }
	| { present: true; labels: Record<string, string>; driver: string; options: Record<string, string> }
	| { present: "unknown"; detail: string };

/**
 * One required container mount: either exactly the named, exactly-owned,
 * kernel-bounded volume, or exactly the named host bind in the required
 * mode. verifyMounts compares these against the container's actual Mounts.
 */
type MountExpectation =
	| { destination: string; volume: string; labels: Record<string, string>; opts: string }
	| { destination: string; bind: string; readonly?: boolean };

const VOLUME_INSPECT_SEPARATOR = "\u001f";

async function volumeInspect(resource: string): Promise<VolumeDefinitionProbe> {
	const result = await docker(
		["volume", "inspect", "--format", `{{json .Labels}}${VOLUME_INSPECT_SEPARATOR}{{.Driver}}${VOLUME_INSPECT_SEPARATOR}{{json .Options}}`, resource],
		{ timeoutMs: 30_000 },
	);
	if (result.code !== 0) {
		if (/\b(?:no such (?:object|volume)|volume .+ not found)\b/i.test(result.stderr)) return { present: false };
		return { present: "unknown", detail: result.stderr.trim().slice(0, 200) || `docker exit ${result.code}` };
	}
	const parts = result.stdout.toString("utf8").trim().split(VOLUME_INSPECT_SEPARATOR);
	if (parts.length !== 3) return { present: "unknown", detail: "docker volume inspect returned an unexpected format" };
	const parseJson = (raw: string): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	};
	// JSON `null` renders for an empty labels/options map: present and
	// provably empty, never a probe failure.
	const labels = parseJson(parts[0]) ?? {};
	const options = parseJson(parts[2]) ?? {};
	if (!plainObject(labels) || !plainObject(options)) return { present: "unknown", detail: "docker volume inspect returned non-object labels/options" };
	return {
		present: true,
		labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])),
		driver: parts[1],
		options: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)])),
	};
}

/**
 * The refusal reason for MOUNTING a volume as one of this workspace's
 * bounded model-writable surfaces, or undefined when the volume exactly
 * matches the required definition: the exact ownership labels, the local
 * driver, and the exact tmpfs type/device/o bounds. A plain or differently
 * bounded volume can grow host-visible disk without a kernel stop, so a
 * matching label set alone is never acceptance.
 */
export function volumeDefinitionRefusal(
	found: { labels: Record<string, string>; driver: string; options: Record<string, string> },
	expectedLabels: Record<string, string>,
	opts: string,
): string | undefined {
	const problems: string[] = [];
	if (found.driver !== "local") problems.push(`driver is '${found.driver}' but must be 'local'`);
	if (found.options.type !== "tmpfs" || found.options.device !== "tmpfs") {
		problems.push(`type/device is '${found.options.type ?? "<absent>"}/${found.options.device ?? "<absent>"}' but must be 'tmpfs/tmpfs'`);
	}
	if (found.options.o !== opts) problems.push(`tmpfs options are '${found.options.o ?? "<absent>"}' but must be exactly '${opts}'`);
	for (const [key, value] of Object.entries(expectedLabels)) {
		if (found.labels[key] !== value) problems.push(`label '${key}' is '${found.labels[key] ?? "<absent>"}' but this workspace identity requires '${value}'`);
	}
	for (const key of Object.keys(found.labels)) {
		if (!(key in expectedLabels) && key.startsWith(LABEL_NAMESPACE)) problems.push(`label '${key}' is '${found.labels[key]}' but is not part of this volume's exact label set`);
	}
	if (problems.length === 0) return undefined;
	return `unbounded or foreign volume: ${problems.join("; ")}`;
}

/**
 * The exact refusal reason for a probe-qualified ownership check. A proven
 * absence is a no-op for stop/remove and unobstructed for create; an
 * unprovable state (inspect failure) refuses; an existing resource must carry
 * the EXACT expected ownership label set.
 */
function ownershipProbeRefusal(
	probe: DockerLabelProbe,
	expected: Record<string, string>,
	kind: "container" | "network" | "volume",
	resource: string,
	action: string,
): string | undefined {
	if (!probe.present) return undefined;
	if (probe.present === "unknown") {
		return `refusing to ${action} ${kind} '${resource}': ownership cannot be proven (docker inspect failed: ${probe.detail})`;
	}
	return ownershipRefusal(probe.labels, expected, kind, resource, action);
}

function labelArgv(labels: Record<string, string>): string[] {
	return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

async function destroyOwnedResource(
	kind: "container" | "network" | "volume",
	resource: string,
	expected: Record<string, string>,
	signal?: AbortSignal,
): Promise<void> {
	const refusal = ownershipProbeRefusal(await dockerLabels(kind, resource), expected, kind, resource, "stop/remove");
	if (refusal) fail(refusal);
	const steps = kind === "container"
		? [["stop", "-t", "5", resource], ["rm", resource]]
		: kind === "volume"
			? [["volume", "rm", resource]]
			: [["network", "rm", resource]];
	for (const argv of steps) {
		const result = await docker(argv, { signal, timeoutMs: 60_000 }).catch((error: unknown): { code: number; stderr: string } => ({
			code: -1,
			stderr: error instanceof Error ? error.message : String(error),
		}));
		if (result.code === 0) continue;
		const probe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
		if (probe.present === false) continue;
		const why = probe.present === "unknown" ? ` (ownership unprovable: ${probe.detail})` : " (resource still present)";
		fail(`${kind} '${resource}' ${argv[0]} failed (docker exit ${result.code}): ${result.stderr.trim().slice(0, 400)}${why}`);
	}
}

/**
 * The refusal reason for treating a listed resource as a prior incarnation of
 * `run`: the managed + run-id identity is guaranteed by the listing filter,
 * so the per-resource check is a well-formed incarnation label and a known
 * role. Anything else is never touched.
 */
function priorIncarnationRefusal(labels: Record<string, string>, run: string, resource: string): string | undefined {
	if (labels[LABEL_RUN_ID] !== run) return `refusing to reclaim ${resource}: run-id label mismatch`;
	if (!/^[0-9a-f]{16}$/.test(labels[LABEL_INCARNATION] ?? "")) return `refusing to reclaim ${resource}: missing or malformed incarnation label`;
	if (!KNOWN_ROLES.includes(labels[LABEL_ROLE] as WorkspaceRole)) return `refusing to reclaim ${resource}: missing or unknown role label`;
	return undefined;
}

/**
 * Crash recovery: find every managed container/network labeled with this
 * exact run id (any incarnation — a SIGKILLed prior incarnation leaves its
 * `sleep infinity` containers, internal network, and tmpfs volumes alive) and
 * tear them down with proven absence. Containers are reclaimed before the
 * volumes they mount and before the network, so a leftover endpoint or mount
 * can never block a removal. Ownership is verified
 * per resource from its own labels; anything the labels cannot prove is
 * refused, never touched. Callers must treat any refusal as fail-closed:
 * unremovable leftovers of the same run must not run alongside a new
 * workspace.
 */
export async function reclaimPriorIncarnations(
	runId: string,
	signal?: AbortSignal,
): Promise<{ removed: string[]; refused: string[] }> {
	const run = sanitizeRunId(runId);
	const removed: string[] = [];
	const refused: string[] = [];
	const listings: Array<{ kind: "container" | "network" | "volume"; argv: string[] }> = [
		{ kind: "container", argv: ["ps", "-a", "--format", "{{.Names}}"] },
		// Volumes are reclaimed between containers and networks: a volume that
		// still backs a container cannot be removed, and a network whose
		// endpoints are still attached cannot be removed either.
		{ kind: "volume", argv: ["volume", "ls", "--format", "{{.Name}}"] },
		{ kind: "network", argv: ["network", "ls", "--format", "{{.Name}}"] },
	];
	for (const { kind, argv } of listings) {
		const listed = await docker(
			[...argv, "--filter", `label=${LABEL_MANAGED}=true`, "--filter", `label=${LABEL_RUN_ID}=${run}`],
			{ signal, timeoutMs: 30_000 },
		);
		if (listed.code !== 0) {
			refused.push(`${kind} listing failed (docker exit ${listed.code}): ${listed.stderr.trim().slice(0, 200)}`);
			continue;
		}
		for (const resource of listed.stdout.toString().split("\n").map(name => name.trim()).filter(Boolean)) {
			const probe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
			if (probe.present !== true) {
				refused.push(`${kind} '${resource}' ownership is unprovable (${probe.present === "unknown" ? probe.detail : "reported present then gone"})`);
				continue;
			}
			// Media decoder resources carrying this run id belong to the media
			// decoder reclaim path (decodeVideoFrames / reclaimMediaDecoders),
			// never to workspace reclaim: a crash-left decoder must not block
			// a workspace bring-up or a draft-recovery reclaim of the same
			// logical run. Exactly-well-formed media resources are skipped
			// here; a malformed one is still refused, never silently adopted.
			if (
				MEDIA_DECODER_ROLES[probe.labels[LABEL_ROLE]] === true
				&& /^[0-9a-f]{16}$/.test(probe.labels[LABEL_INCARNATION] ?? "")
			) continue;
			const refusal = priorIncarnationRefusal(probe.labels, run, resource);
			if (refusal) {
				refused.push(refusal);
				continue;
			}
			const expected = {
				[LABEL_MANAGED]: "true",
				[LABEL_RUN_ID]: run,
				[LABEL_INCARNATION]: probe.labels[LABEL_INCARNATION],
				[LABEL_ROLE]: probe.labels[LABEL_ROLE],
			};
			try {
				await destroyOwnedResource(kind, resource, expected, signal);
				removed.push(resource);
			} catch (error) {
				refused.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	return { removed, refused };
}
/** The only roles the run-scoped media decoder reclaim may ever touch. */
const MEDIA_DECODER_ROLES: Record<string, true> = { media: true, "media-storage": true };

/**
 * Reclaim every crash-left decoder container/volume of ONE logical run:
 * listing is filtered to managed resources carrying exactly this run-id and
 * a media role, every candidate is re-probed for the exact four-label set
 * (well-formed incarnation, one of the two media roles), containers go
 * before their volumes, and every removal ends in a tri-state PROVEN
 * absence. Workspace-role resources of the same run and any other run id
 * are outside this listing and are never touched.
 */
async function reclaimMediaDecoders(
	run: string,
	signal?: AbortSignal,
): Promise<{ removed: string[]; refused: string[] }> {
	const removed: string[] = [];
	const refused: string[] = [];
	const listings: Array<{ kind: "container" | "volume"; role: string; argv: string[] }> = [
		{ kind: "container", role: "media", argv: ["ps", "-a", "--format", "{{.Names}}"] },
		{ kind: "volume", role: "media-storage", argv: ["volume", "ls", "--format", "{{.Name}}"] },
	];
	for (const { kind, role, argv } of listings) {
		const listed = await docker(
			[
				...argv,
				"--filter", `label=${LABEL_MANAGED}=true`,
				"--filter", `label=${LABEL_RUN_ID}=${run}`,
				"--filter", `label=${LABEL_ROLE}=${role}`,
			],
			{ signal, timeoutMs: 30_000 },
		);
		if (listed.code !== 0) {
			refused.push(`media ${kind} listing failed (docker exit ${listed.code}): ${listed.stderr.trim().slice(0, 200)}`);
			continue;
		}
		for (const resource of listed.stdout.toString().split("\n").map(entry => entry.trim()).filter(Boolean)) {
			const probe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
			if (probe.present !== true) {
				refused.push(`media ${kind} '${resource}' ownership is unprovable (${probe.present === "unknown" ? probe.detail : "reported present then gone"})`);
				continue;
			}
			const labels = probe.labels;
			const problems: string[] = [];
			if (labels[LABEL_RUN_ID] !== run) problems.push("run-id label mismatch");
			if (!/^[0-9a-f]{16}$/.test(labels[LABEL_INCARNATION] ?? "")) problems.push("missing or malformed incarnation label");
			if (MEDIA_DECODER_ROLES[labels[LABEL_ROLE]] !== true) problems.push("not a supported media decoder role");
			const extra = Object.keys(labels).filter(
				key => key.startsWith(LABEL_NAMESPACE) && !(key in { [LABEL_MANAGED]: true, [LABEL_RUN_ID]: true, [LABEL_INCARNATION]: true, [LABEL_ROLE]: true }),
			);
			if (extra.length > 0) problems.push(`extra ownership labels ${extra.join(", ")}`);
			if (problems.length > 0) {
				refused.push(`refusing to reclaim media ${kind} '${resource}': ${problems.join("; ")}`);
				continue;
			}
			try {
				await destroyOwnedResource(kind, resource, labels, signal);
				removed.push(resource);
			} catch (error) {
				refused.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	return { removed, refused };
}

/** Derived workspace run ids of one logical Benny run: the exact id plus these suffixes. */
export const BENNY_RUN_SUFFIXES = ["", "-base", "-head", "-ops", "-plan"] as const;

/**
 * Draft-recovery reclamation: tear down EVERY exactly-managed resource of
 * one logical Benny run — the workspace containers, volumes, and networks of
 * the exact logical id and its supported derived suffixes (`-base`, `-head`,
 * `-ops`, `-plan`), the crash-left media decoder resources of the logical
 * run, and the disposable host run roots — and PROVE their absence. Foreign,
 * unknown, or unprovable resources are never touched and block the
 * reclamation. The retained evidence store is sweep-owned (24h retention)
 * and is deliberately NOT removed: resume paths still re-read published
 * evidence bytes through it.
 */
export async function reclaimBennyRunResources(cwd: string, logicalRunId: string): Promise<void> {
	const logical = sanitizeRunId(logicalRunId);
	const failures: string[] = [];
	for (const suffix of BENNY_RUN_SUFFIXES) {
		const derived = `${logical}${suffix}`;
		const reclaim = await reclaimPriorIncarnations(derived).catch((error: unknown) => {
			failures.push(`reclaim of '${derived}' failed: ${error instanceof Error ? error.message : String(error)}`);
			return { removed: [], refused: [] };
		});
		failures.push(...reclaim.refused);
		// The disposable host run root (worktree + snapshot) of this derived
		// workspace. Never a symlink, and its absence is proven after removal.
		const runRoot = join(securePrivateDir(cwd, ".omp", "pstack", "state", "benny"), derived);
		const link = await lstat(runRoot).catch(() => undefined);
		if (link?.isSymbolicLink()) {
			failures.push(`private run directory '${runRoot}' is a symlink; refusing to reclaim it`);
		} else if (link !== undefined) {
			await rm(runRoot, { recursive: true, force: true }).catch((error: unknown): void => {
				failures.push(`run root '${runRoot}' removal failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			if (await lstat(runRoot).catch(() => undefined) !== undefined) {
				failures.push(`run root '${runRoot}' is still present after removal`);
			}
		}
	}
	const media = await reclaimMediaDecoders(logical);
	failures.push(...media.refused);
	if (failures.length > 0) {
		fail(`reclaimBennyRunResources('${logical}') could not prove every derived resource reclaimed: ${failures.join("; ")}`);
	}
}


/**
 * Resolved admitted state for a revision: the tree OID with replacement refs
 * disabled, and the common object directory that serves its objects.
 */
export interface AdmittedTree {
	tree: string;
	objects: string;
}

/**
 * The admitted Git tree for `revision`, resolved with replacement refs
 * disabled (`git replace` grafts can never substitute the audited tree) and
 * materialized into `workspacePath` WITHOUT `git archive`: archive honors
 * committed `export-ignore` attributes, so ordinary repositories could
 * silently lose tracked files before any model work. Everything runs in the
 * caller's scratch Git directory (explicit GIT_DIR, no repository discovery,
 * no target configuration — a committed smudge filter is refused, not
 * executed) with the target's common object directory as read-only
 * alternates. Callers verify the result with a pristine round trip through
 * the same scratch context.
 */
export async function materializeAdmittedTree(
	cwd: string,
	revision: string,
	workspacePath: string,
	scratchGitDir: string,
	scratchEnv: Record<string, string>,
): Promise<AdmittedTree> {
	const revEnv = { ...scratchEnv, GIT_NO_REPLACE_OBJECTS: "1" };
	const tree = await run(["git", "--no-replace-objects", "-C", cwd, "rev-parse", `${revision}^{tree}`], { env: revEnv, scrubEnv: true, timeoutMs: 30_000 });
	if (tree.code !== 0) fail(`revision '${revision}' is not resolvable in ${cwd}: ${tree.stderr.trim().slice(0, 200)}`);
	const admittedTree = tree.stdout.toString().trim();
	const commonDir = await run(["git", "--no-replace-objects", "-C", cwd, "rev-parse", "--git-common-dir"], { env: revEnv, scrubEnv: true, timeoutMs: 30_000 });
	if (commonDir.code !== 0) fail(`cannot resolve the target Git common directory: ${commonDir.stderr.trim().slice(0, 200)}`);
	const common = commonDir.stdout.toString().trim();
	const objects = join(isAbsolute(common) ? common : resolve(cwd, common), "objects");
	const treeEnv = {
		...revEnv,
		GIT_DIR: scratchGitDir,
		GIT_WORK_TREE: workspacePath,
		GIT_INDEX_FILE: join(scratchGitDir, "..", "tree-index-materialize"),
		GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
	};
	const seeded = await run(["git", "read-tree", admittedTree], { env: treeEnv, scrubEnv: true, timeoutMs: 30_000 });
	if (seeded.code !== 0) fail(`cannot seed the workspace index from the admitted tree: ${seeded.stderr.trim().slice(0, 200)}`);
	const checked = await run(["git", "checkout-index", "-a", "-f"], { cwd: workspacePath, env: treeEnv, scrubEnv: true, timeoutMs: 300_000 });
	if (checked.code !== 0) fail(`cannot check out the admitted tree into the workspace: ${checked.stderr.trim().slice(0, 200)}`);
	return { tree: admittedTree, objects };
}

/**
 * Resources whose final state is NOT a proven absence, phrased for teardown
 * reports: only a proven absence (inspect exit nonzero naming the missing
 * resource) passes; still-present resources and unprovable inspect failures
 * are both named, so exceptional teardown never declares success on a guess.
 */
export function unverifiedAbsent(probes: Array<{ resource: string; probe: DockerLabelProbe }>): string[] {
	return probes
		.filter(({ probe }) => probe.present !== false)
		.map(({ resource, probe }) => (probe.present === "unknown" ? `${resource} (ownership unprovable: ${probe.detail})` : resource));
}

export async function createBennyWorkspace(options: WorkspaceOptions): Promise<BennyWorkspace> {
	const { config, cwd, runId, revision, artifactDir, deadline, signal } = options;
	const identity = workspaceIdentity(runId, options.incarnation ?? randomBytes(8).toString("hex"));
	const name = identity.worker;
	const controllerName = identity.controller;
	const workerOwned = ownershipLabels(identity, "worker");
	const controllerOwned = ownershipLabels(identity, "controller");
	const networkOwned = ownershipLabels(identity, "network");
	const runtime = config.runtime;
	if (!runtime?.workspace_image) fail("runtime.workspace_image is required for a Benny run workspace");
	if (!Array.isArray(runtime.control_command) || runtime.control_command.length === 0) {
		fail("runtime.control_command is required and must name the trusted adapter inside the workspace image");
	}
	if ((runtime.allowed_endpoints ?? []).filter(Boolean).length > 0) {
		fail(
			"runtime.allowed_endpoints is nonempty but the bundled workspace boundary has no enforceable per-FQDN egress filter; " +
				"provide a proxy-based network boundary or run with an empty allowlist (fail-closed)",
		);
	}
	// Host-only evidence store, fixed beneath the secure private root. The
	// configured artifactDir must resolve to exactly this location — the schema
	// pins the literal, and this check makes a malicious or drifted value
	// impossible even when a caller bypasses parsing.
	const evidenceRootPath = securePrivateDir(cwd, ...ARTIFACT_ROOT_SEGMENTS);
	const configuredArtifactRoot = resolve(cwd, artifactDir);
	if (configuredArtifactRoot !== evidenceRootPath) {
		fail(`artifact storage is fixed to ${ARTIFACT_ROOT} beneath the secure private root; refusing '${artifactDir}'`);
	}
	const workerEnv = nonsecretEnv(runtime.environment);
	// The controller gets a scrubbed environment: nothing from the operator
	// allowlist, nothing from the host — the adapter is configuration-free.
	const controllerEnv: Array<[string, string]> = [];
	// Immutable runtime identity: resolve the configured reference to its
	// local image id and run every container/probe by that id, so a retagged
	// or repulled tag can never substitute different bytes after
	// preflight/canary saw the reference. An authorized id (from the
	// coordinator's persisted binding) must match exactly.
	const workspaceImageId = await resolveImageId(runtime.workspace_image, signal);
	if (options.imageId !== undefined && options.imageId !== workspaceImageId) {
		fail(
			`workspace image '${runtime.workspace_image}' resolved to ${workspaceImageId}, but this run is authorized for immutable image ${options.imageId}; ` +
				"the reference was retagged or repulled since authorization and must re-pass the canary",
		);
	}

	// 1. Runner-owned scratch Git context, then the admitted (non-replaced)
	//    tree. Not `git archive`: archive honors committed `export-ignore`
	//    attributes and replacement refs, so ordinary repositories could
	//    lose tracked files or swap the audited tree before any model work.
	//    The admitted tree is resolved with replacement refs disabled and
	//    materialized through the isolated scratch Git directory below, and
	//    a pristine round trip must reproduce its OID exactly before any
	//    container or model runs.
	const bennyRoot = securePrivateDir(cwd, ".omp", "pstack", "state", "benny");
	const runRoot = join(bennyRoot, sanitizeRunId(runId));
	// Docker identity targets: every intended container/network/volume name
	// is tracked BEFORE the first run-root or Docker mutation, so a failure
	// at ANY construction phase — pre-volume included — tears down everything
	// this bring-up created or intended, proves absence, and removes the run
	// root. A pre-existing resource with an exact name is adopted only when
	// its ownership labels match this identity exactly; anything else fails
	// closed instead of binding a run to a foreign resource.
	const networkName = identity.network;
	const trackedResources = new Map<string, "container" | "network" | "volume">([
		[name, "container"],
		[controllerName, "container"],
		[networkName, "network"],
	]);
	const stageVolume = identity.stageVolume;
	const fixVolume = identity.fixVolume;
	const controlVolume = identity.controlVolume;
	const fixVolumeOwned = ownershipLabels(identity, "fix-storage");
	const stageVolumeOwned = ownershipLabels(identity, "artifact-storage");
	const controlVolumeOwned = ownershipLabels(identity, "control-storage");
	const volumeOwnership: Record<string, Record<string, string>> = {
		[fixVolume]: fixVolumeOwned,
		[stageVolume]: stageVolumeOwned,
		[controlVolume]: controlVolumeOwned,
	};

	/**
	 * Removes the disposable run root after a failed construction. Only the
	 * exact, contained, non-symlink directory built below is removed: a
	 * symlinked or non-directory root is never followed and never removed,
	 * absence is proven after removal, and every refusal or failure is
	 * returned for aggregation into the rejection — never dropped, never
	 * left to a caller (no cleanup handle exists before construction
	 * completes).
	 */
	async function removeFailedRunRoot(): Promise<string[]> {
		const failures: string[] = [];
		let link: Stats;
		try {
			link = await lstat(runRoot);
		} catch (error) {
			if (errnoOf(error) !== "ENOENT") {
				failures.push(`run root '${runRoot}' could not be probed for cleanup: ${error instanceof Error ? error.message : String(error)}`);
			}
			// ENOENT proves absence; anything else is recorded as unprovable.
			return failures;
		}
		if (link.isSymbolicLink() || !link.isDirectory()) {
			failures.push(`private run directory '${runRoot}' is ${link.isSymbolicLink() ? "a symlink" : "not a directory"}; refusing to remove it`);
			return failures;
		}
		try {
			await rm(runRoot, { recursive: true, force: true });
		} catch (error) {
			failures.push(`run root '${runRoot}' removal failed: ${error instanceof Error ? error.message : String(error)}`);
			return failures;
		}
		try {
			await lstat(runRoot);
			failures.push(`run root '${runRoot}' is still present after removal`);
		} catch (error) {
			if (errnoOf(error) !== "ENOENT") {
				failures.push(`run root '${runRoot}' absence could not be proven after removal: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failures;
	}

	/**
	 * Failure-cleanup boundary for ANY construction failure after the first
	 * run-root mutation: every acquired (tracked) Docker resource is torn
	 * down and its absence proven, the exact contained non-symlink run root
	 * is removed and its absence proven, and every cleanup failure is
	 * aggregated INTO the rejection alongside the original error — never
	 * silently dropped.
	 */
	async function discardFailedConstruction(phase: string, error: unknown): Promise<never> {
		const failures = await teardownAfterFailure().catch(
			(cleanupError: unknown): string[] => [cleanupError instanceof Error ? cleanupError.message : String(cleanupError)],
		);
		failures.push(...await removeFailedRunRoot());
		const message = error instanceof Error ? error.message : String(error);
		fail(
			failures.length > 0
				? `${message}; ${phase} failure cleanup: ${failures.join("; ")}`
				: message,
		);
	}

	// Bindings read by the stage/cleanup closures after bring-up; assigned
	// inside the guarded construction phases below.
	let workspacePath: string;
	let snapshotGitDir: string;
	let isolatedGitEnv: Record<string, string>;
	let baselineHash: string;
	let admittedObjects: string;
	try {
		const priorRunRoot = await lstat(runRoot).catch(() => null);
		if (priorRunRoot?.isSymbolicLink()) fail(`private run directory must not be a symlink: ${runRoot}`);
		await rm(runRoot, { recursive: true, force: true });
		await secureDirectory(runRoot);
		workspacePath = await secureDirectory(join(runRoot, "worktree"));
		const snapshotDir = await secureDirectory(join(runRoot, "snapshot"));
		snapshotGitDir = join(snapshotDir, ".git");
		// Isolation: explicit GIT_DIR/GIT_WORK_TREE per call (no repository
		// discovery), no system/global config, no replace objects, scrubbed
		// environment. Never the target checkout's Git directory — whose local
		// clean filters could otherwise execute on the host over model-written
		// bytes before any later tree comparison rejects — only the target's
		// COMMON object directory as read-only alternates (a linked worktree
		// keeps objects outside its per-worktree gitdir).
		isolatedGitEnv = {
			PATH: process.env.PATH ?? "",
			HOME: runRoot,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
		};
		const initialized = await run(["git", "init", "-q", snapshotDir], { env: isolatedGitEnv, scrubEnv: true, timeoutMs: 30_000 });
		if (initialized.code !== 0) fail(`cannot initialize the isolated snapshot Git directory: ${initialized.stderr.trim().slice(0, 200)}`);
		const materialized = await materializeAdmittedTree(cwd, revision, workspacePath, snapshotGitDir, isolatedGitEnv);
		baselineHash = materialized.tree;
		admittedObjects = materialized.objects;
	} catch (error) {
		throw await discardFailedConstruction("workspace tree construction", error);
	}

	let evidenceDir: string;
	let evidenceDirName: string;
	try {
		const evidenceRoot = await secureDirectory(evidenceRootPath);
		// Receipt identity: every published evidence reference names its owning
		// directory (`<run>/<content-address>`), so retained-byte lookups later
		// resolve directly without scanning the evidence root.
		evidenceDirName = sanitizeRunId(options.logicalRunId ?? runId);
		// The shared logical evidence dir is the aggregate ledger for EVERY
		// derived workspace of this logical run: base/head/ops/plan publish into
		// the same content-addressed store against ONE byte/file budget, and the
		// usage scan below IS the ledger — no second accounting source exists.
		evidenceDir = await secureDirectory(join(evidenceRoot, evidenceDirName));
	} catch (error) {
		throw await discardFailedConstruction("evidence store construction", error);
	}
	// Canonical snapshot identity: a real Git tree OID. A temp index is seeded
	// from the admitted base tree, the workspace is staged WITHOUT -f (the
	// repo's .gitignore applies, so ignored build/test artifacts never enter
	// the verified or published tree), and write-tree emits the canonical OID.
	// The content manifest stays the host↔container mount-immutability check;
	// a tree OID is never compared to a manifest digest.
	async function canonicalTreeHash(): Promise<string> {
		const indexFile = join(runRoot, `tree-index-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
		const env = {
			...isolatedGitEnv,
			GIT_DIR: snapshotGitDir,
			GIT_WORK_TREE: workspacePath,
			GIT_INDEX_FILE: indexFile,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: admittedObjects,
		};
		const seeded = await run(["git", "read-tree", baselineHash], { env, scrubEnv: true, timeoutMs: 30_000 });
		if (seeded.code !== 0) fail(`cannot seed snapshot index from the admitted base tree: ${seeded.stderr.trim().slice(0, 200)}`);
		const staged = await run(["git", "add", "-A", "--", "."], { cwd: workspacePath, env, scrubEnv: true, timeoutMs: 300_000 });
		if (staged.code !== 0) fail(`cannot stage the workspace snapshot: ${staged.stderr.trim().slice(0, 200)}`);
		const written = await run(["git", "write-tree"], { env, scrubEnv: true, timeoutMs: 30_000 });
		if (written.code !== 0) fail(`cannot write the workspace snapshot tree: ${written.stderr.trim().slice(0, 200)}`);
		return written.stdout.toString().trim();
	}

	// Pristine pre-fix round trip: the freshly materialized workspace, staged
	// back through the same scratch context, must equal the admitted tree OID
	// exactly. Export-ignore omissions, replacement substitutions, or
	// attribute-driven byte drift all fail closed here — before bootstrap or
	// any model execution.
	try {
		const pristineTree = await canonicalTreeHash();
		if (pristineTree !== baselineHash) {
			fail(`materialized workspace does not round-trip to the admitted tree (got ${pristineTree}, admitted ${baselineHash})`);
		}
	} catch (error) {
		throw await discardFailedConstruction("pristine round trip", error);
	}

	const baseArgs = (container: string, memory: string) => [
		"run", "-d",
		"--name", container,
		"--network", `${networkName}`,
		"--network-alias", container === name ? "benny-worker" : "benny-controller",
		"--user", "1000:1000",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--read-only",
		// /tmp and /dev/shm are explicitly byte- AND inode-bounded tmpfs on
		// every container; the memory cgroup sits above the sum of all its
		// attached tmpfs ceilings plus headroom (see the bounds comment).
		"--tmpfs", `/tmp:${TMP_TMPFS_OPTS}`,
		"--tmpfs", `/dev/shm:${SHM_TMPFS_OPTS}`,
		"--memory", memory,
		"--memory-swap", memory,
		"--pids-limit", "256",
		"--cpus", "2",
	];

	const controllerArgs = () => [
		...baseArgs(controllerName, CONTROL_MEMORY),
		...labelArgv(controllerOwned),
		// No worktree mount. Controller staging is the exact-owned, kernel-
		// bounded control-storage volume — never a host bind.
		"-v", `${controlVolume}:${STAGING_MOUNT}:rw`,
		"--workdir", "/opt/benny-control",
		...controllerEnv.flatMap(([key, value]) => [`-e${key}=${value}`]),
		workspaceImageId,
		"sleep", "infinity",
	];

	const workerArgs = (mode: "ro" | "bootstrap" | "fix") => [
		...baseArgs(name, WORKER_MEMORY),
		...labelArgv(workerOwned),
		// Model-writable storage is NEVER a host bind. Read-only stages see the
		// host worktree through a read-only bind; the fix stage runs on a
		// tmpfs-backed volume seeded from the trusted host tree, and artifact
		// staging is always a tmpfs-backed volume. Kernel ENOSPC stops a
		// writer past either bound, so background writers cannot race a
		// post-command scan and no host directory can grow. The bootstrap mode
		// is trusted operator config (not model exec) and keeps the writable
		// host bind.
		...(mode === "fix"
			? ["-v", `${fixVolume}:${WORKSPACE_MOUNT}`]
			: ["-v", `${workspacePath}:${WORKSPACE_MOUNT}:${mode === "bootstrap" ? "rw" : "ro"}`]),
		"-v", `${stageVolume}:${STAGING_MOUNT}:rw`,
		"--workdir", WORKSPACE_MOUNT,
		...workerEnv.flatMap(([key, value]) => [`-e${key}=${value}`]),
		workspaceImageId,
		"sleep", "infinity",
	];
	const bootstrapCommand = runtime.control_config?.bootstrap_command;
	let containerMode: "ro" | "bootstrap" | "fix" = Array.isArray(bootstrapCommand) && bootstrapCommand.length > 0 ? "bootstrap" : "ro";

	/**
	 * The mounts a container of this boundary is REQUIRED to carry. Verified
	 * against the container's actual Mounts after every start and restart,
	 * before seed/bootstrap/model action: a missing, replaced, or plain
	 * (unbounded) surface fails closed here.
	 */
	function workerMounts(mode: "ro" | "bootstrap" | "fix"): MountExpectation[] {
		return mode === "fix"
			? [
				{ destination: WORKSPACE_MOUNT, volume: fixVolume, labels: fixVolumeOwned, opts: WORKSPACE_TMPFS_OPTS },
				{ destination: STAGING_MOUNT, volume: stageVolume, labels: stageVolumeOwned, opts: STAGING_TMPFS_OPTS },
			]
			: [
				{ destination: WORKSPACE_MOUNT, bind: workspacePath, readonly: mode === "ro" },
				{ destination: STAGING_MOUNT, volume: stageVolume, labels: stageVolumeOwned, opts: STAGING_TMPFS_OPTS },
			];
	}

	const controllerMounts: MountExpectation[] = [
		{ destination: STAGING_MOUNT, volume: controlVolume, labels: controlVolumeOwned, opts: CONTROL_TMPFS_OPTS },
	];

	/**
	 * Prove the container's ACTUAL mounts match the expected boundary: each
	 * expected destination is exactly the owned, kernel-bounded volume
	 * (re-inspected: driver/options/labels against the exact definition, so a
	 * remove/replace race after creation is caught before any command) or
	 * exactly the named host bind with the required read-only mode.
	 */
	async function verifyMounts(container: string, expected: MountExpectation[]): Promise<void> {
		const inspected = await docker(["inspect", "-f", "{{json .Mounts}}", container], { signal, timeoutMs: 30_000 });
		if (inspected.code !== 0) fail(`cannot inspect mounts of '${container}': ${inspected.stderr.trim().slice(0, 200)}`);
		let mounts: unknown;
		try {
			mounts = JSON.parse(inspected.stdout.toString("utf8"));
		} catch {
			fail(`unparseable mount inspection for '${container}'`);
		}
		if (!Array.isArray(mounts)) fail(`mount inspection for '${container}' is not a list`);
		const byDestination = new Map<string, Record<string, unknown>>();
		for (const mount of mounts) {
			if (!plainObject(mount) || typeof mount.Destination !== "string") fail(`mount entry for '${container}' is malformed`);
			byDestination.set(mount.Destination, mount);
		}
		const problems: string[] = [];
		for (const want of expected) {
			const mount = byDestination.get(want.destination);
			if (!mount) {
				problems.push(`mount '${want.destination}' is missing`);
				continue;
			}
			if ("volume" in want) {
				if (mount.Type !== "volume" || mount.Name !== want.volume) {
					problems.push(`mount '${want.destination}' is ${String(mount.Type)} '${String(mount.Name)}' but must be exactly the owned volume '${want.volume}'`);
					continue;
				}
				const probe = await volumeInspect(want.volume);
				if (probe.present !== true) {
					problems.push(`volume '${want.volume}' behind '${want.destination}' is ${probe.present === false ? "absent while mounted" : `unprovable (${probe.detail})`}`);
					continue;
				}
				const refusal = volumeDefinitionRefusal(probe, want.labels, want.opts);
				if (refusal) problems.push(`volume '${want.volume}' behind '${want.destination}' no longer matches the bounded definition: ${refusal}`);
			} else {
				if (mount.Type !== "bind" || mount.Source !== want.bind) {
					problems.push(`mount '${want.destination}' is ${String(mount.Type)} '${String(mount.Source)}' but must be the bind '${want.bind}'`);
				}
				if (want.readonly === true && mount.RW !== false) problems.push(`bind '${want.destination}' must be read-only`);
			}
		}
		if (problems.length > 0) fail(`container '${container}' mount verification failed: ${problems.join("; ")}`);
	}
	/** Seed the bounded fix volume from the trusted host tree; the model never writes a host bind. */
	async function seedFixWorkspace(): Promise<void> {
		// docker cp preserves the trusted host uid/gid (1000:1000, the worker
		// user). The container runs with cap-drop ALL, so root cannot chown —
		// ownership is verified instead, and any foreign-owned byte fails
		// closed rather than being rewritten.
		const copied = await docker(["cp", "-a", `${workspacePath}/.`, `${name}:${WORKSPACE_MOUNT}/`], { signal, timeoutMs: 600_000 });
		if (copied.code !== 0) fail(`fix worktree seed failed: ${copied.stderr.toString().trim().slice(0, 200)}`);
		const stray = await execIn(
			name,
			["sh", "-c", `find ${WORKSPACE_MOUNT} -xdev \\( ! -uid 1000 -o ! -gid 1000 \\) -print | head -n 8`],
			{ timeoutMs: 300_000 },
		);
		if (stray.code !== 0) fail(`fix worktree seed ownership probe failed: ${stray.stderr.toString().trim().slice(0, 200)}`);
		const strayPaths = stray.stdout.toString().trim();
		if (strayPaths.length > 0) {
			fail(`fix worktree seed contains files not owned by the worker user (uid/gid 1000): ${strayPaths.split("\n").slice(0, 8).join(", ")}`);
		}
	}

	async function startWorker(mode: "ro" | "bootstrap" | "fix") {
		trackedResources.set(name, "container");
		const started = await docker(workerArgs(mode), { signal, timeoutMs: 120_000 });
		if (started.code !== 0) await reconcileResource("container", name, workerOwned, "workspace worker container start", started);
		const adopted = ownershipProbeRefusal(await dockerLabels("container", name), workerOwned, "container", name, "adopt");
		if (adopted) fail(adopted);
		for (let attempt = 0; attempt < 20; attempt++) {
			const inspect = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], { signal, timeoutMs: 30_000 });
			const state = inspect.stdout.toString().trim();
			if (state.startsWith("false")) fail("workspace worker container exited immediately; check the image CMD and mounts");
			if (state.startsWith("true")) {
				// Mount/ownership verification gates BEFORE seed and before the
				// manifest probe: no trusted or model action ever runs against a
				// container whose surfaces are missing, replaced, or plain.
				await verifyMounts(name, workerMounts(mode));
				if (mode === "fix") await seedFixWorkspace();
				const inside = await containerManifest(name);
				if (inside !== expectedManifestHash) fail("phase manifest mismatch between host checkout and worker mount");
				return;
			}
			await Bun.sleep(250);
		}
		fail("workspace worker container did not become ready within 5s");
	}
	let baselineManifestHash = "";
	let expectedManifestHash = "";
	let bringUpError: unknown;

	async function containerManifest(container: string): Promise<string> {
		const inside = await execIn(container, ["sh", "-c", manifestScript(WORKSPACE_MOUNT)], { timeoutMs: 300_000, workdir: WORKSPACE_MOUNT });
		if (inside.code !== 0) fail(`manifest probe failed in ${container}: exit ${inside.code}; stderr='${inside.stderr.toString().trim().slice(0, 300)}' stdout='${inside.stdout.toString().trim().slice(0, 120)}'`);
		return inside.stdout.toString().trim();
	}

	async function startController() {
		trackedResources.set(controllerName, "container");
		const started = await docker(controllerArgs(), { signal, timeoutMs: 120_000 });
		if (started.code !== 0) await reconcileResource("container", controllerName, controllerOwned, "workspace controller container start", started);
		const adopted = ownershipProbeRefusal(await dockerLabels("container", controllerName), controllerOwned, "container", controllerName, "adopt");
		if (adopted) fail(adopted);
		for (let attempt = 0; attempt < 20; attempt++) {
			const inspect = await docker(["inspect", "-f", "{{.State.Running}}", controllerName], { signal, timeoutMs: 30_000 });
			if (inspect.stdout.toString().trim().startsWith("false")) fail("workspace controller container exited immediately");
			if (inspect.stdout.toString().trim().startsWith("true")) {
				await verifyMounts(controllerName, controllerMounts);
				return;
			}
			await Bun.sleep(250);
		}
		fail("workspace controller container did not become ready within 5s");
	}

	/**
	 * An ambiguous create/run outcome (nonzero docker exit — a killed or
	 * timed-out client cannot prove the daemon did not create the named
	 * resource): reconcile by exact name and ownership labels. Proven absent
	 * is a clean failure; present with this identity's exact labels stays
	 * tracked for teardown; foreign or unprovable ownership also stays
	 * tracked so teardown records the refusal. The original error always
	 * surfaces.
	 */
	async function reconcileResource(
		kind: "container" | "network" | "volume",
		resource: string,
		expected: Record<string, string>,
		what: string,
		result: { code: number; stderr: string },
	): Promise<never> {
		const probe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
		let note = "";
		if (probe.present === true) {
			note = ownershipRefusal(probe.labels, expected, kind, resource, "own") === undefined
				? `; '${resource}' exists with this run's exact ownership labels and remains tracked for teardown`
				: `; '${resource}' exists with foreign labels and remains tracked (teardown will refuse it)`;
		} else if (probe.present === "unknown") {
			note = `; '${resource}' ownership is unprovable (${probe.detail}) and remains tracked for teardown`;
		}
		fail(`${what} failed (docker exit ${result.code}): ${result.stderr.trim().slice(0, 400)}${note}`);
	}

	/** One destructive Docker mutation with checked exit status; see destroyOwnedResource. */
	async function destroyResource(
		kind: "container" | "network" | "volume",
		resource: string,
		expected: Record<string, string>,
		honorSignal = true,
	): Promise<void> {
		await destroyOwnedResource(kind, resource, expected, honorSignal ? signal : undefined);
	}

	/** Label-verified stop+remove: refuses to touch a container not owned by this exact identity. */
	async function stopContainer(container: string, honorSignal = true): Promise<void> {
		await destroyResource("container", container, container === controllerName ? controllerOwned : workerOwned, honorSignal);
	}

	/** Label-verified network removal: never tears down a foreign network even on an exact name match. */
	async function removeNetwork(): Promise<void> {
		await destroyResource("network", networkName, networkOwned, false);
	}

	/** Network removal retried once: containers detach asynchronously after a stop. */
	async function removeNetworkWithRetry(collect: (message: string) => void): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				await removeNetwork();
				return;
			} catch (error) {
				if (attempt > 0) {
					collect(error instanceof Error ? error.message : String(error));
					return;
				}
			}
		}
	}

	/** Tri-state final probe of EVERY tracked resource; names those whose absence is not proven. */
	async function probeAllTracked(): Promise<string[]> {
		const probes: Array<{ resource: string; probe: DockerLabelProbe }> = [];
		for (const [resource, kind] of trackedResources) {
			const probe = await dockerLabels(kind, resource).catch(
				(): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }),
			);
			probes.push({ resource, probe });
		}
		return unverifiedAbsent(probes);
	}

	/**
	 * Teardown after failed bring-up: every intended resource (names tracked
	 * before dispatch, so an ambiguous create/run is never skipped), then a
	 * final inspect that must PROVE every tracked resource absent. Containers
	 * are always torn down before the volumes they mount and before the
	 * network — an attached endpoint makes network removal fail, so
	 * network-first ordering can only leak it — each resource is attempted
	 * even after a sibling failure, the network removal
	 * is retried once after the containers detach, and refusals and unproven
	 * absences surface alongside the original error, never instead of it.
	 */
	async function teardownAfterFailure(): Promise<string[]> {
		const failures: string[] = [];
		const tracked = [...trackedResources.entries()];
		// Containers (any tracked one, including the frozen probe) are torn
		// down before the volumes they mount; the network comes last because
		// a still-attached endpoint makes its removal fail. Each sibling is
		// attempted even after an earlier failure, and refusals are recorded,
		// never silent.
		for (const [resource] of tracked.filter(([, k]) => k === "container")) {
			try {
				await stopContainer(resource, false);
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
		for (const [resource] of tracked.filter(([, k]) => k === "volume")) {
			try {
				const owned = volumeOwnership[resource];
				if (!owned) fail(`teardown has no ownership labels for volume '${resource}'`);
				await destroyResource("volume", resource, owned, false);
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
		await removeNetworkWithRetry((message) => failures.push(message));
		for (const resource of await probeAllTracked()) failures.push(`teardown did not prove absence of ${resource}`);
		return failures;
	}

	/** Mount-mode swaps restart the worker; every swap invalidates control capability state. */
	async function swapWorker(mode: "ro" | "bootstrap" | "fix"): Promise<void> {
		if (mode === containerMode) return;
		await stopContainer(name);
		containerMode = mode;
		await startWorker(mode);
		capabilitiesValidated = false;
	}

	/**
	 * Freeze the fix worker: kill EVERY process in the container except PID 1
	 * (`sleep infinity`) and the sweep shell itself, looping until /proc shows
	 * no other task, then PROVE the quiescent state with an independent check.
	 * The container keeps running on purpose — a tmpfs-backed named volume is
	 * wiped by a stop/start cycle (the local driver unmounts and re-creates
	 * the tmpfs) — but with no process left alive, no writer can mutate the
	 * frozen tree: only `sleep infinity` remains and it never forks.
	 */
	async function freezeWorker(): Promise<void> {
		const refusal = ownershipProbeRefusal(await dockerLabels("container", name), workerOwned, "container", name, "freeze");
		if (refusal) fail(refusal);
		// Zombie entries are inert (they can neither fork nor write) and can
		// never be reaped here — the container's PID 1 is `sleep infinity` —
		// so the sweep and the proof both skip them explicitly.
		const sweep = [
			`me=$$; n=0`,
			`while :; do`,
			`any=0`,
			`for p in /proc/[0-9]*; do`,
			`[ -d "$p" ] || continue`,
			`pid=\${p#/proc/}`,
			`[ "$pid" = "1" ] && continue`,
			`[ "$pid" = "$me" ] && continue`,
			`st=$(awk "/^State:/{print \\\$2; exit}" "$p/status" 2>/dev/null)`,
			`[ "$st" = "Z" ] && continue`,
			`if kill -9 "$pid" 2>/dev/null; then any=1; fi`,
			`done`,
			`[ "$any" -eq 0 ] && break`,
			`n=$((n+1)); [ "$n" -gt 50 ] && exit 1`,
			`done`,
			`exit 0`,
		].join("\n");
		const swept = await execIn(name, ["sh", "-c", sweep], { timeoutMs: 120_000 });
		if (swept.code !== 0) fail(`cannot freeze the fix worker container (process sweep failed, exit ${swept.code})`);
		const check = [
			`me=$$; others=0`,
			`for p in /proc/[0-9]*; do`,
			`[ -d "$p" ] || continue`,
			`pid=\${p#/proc/}`,
			`[ "$pid" = "1" ] && continue`,
			`[ "$pid" = "$me" ] && continue`,
			`st=$(awk "/^State:/{print \\\$2; exit}" "$p/status" 2>/dev/null)`,
			`[ "$st" = "Z" ] && continue`,
			`others=$((others+1))`,
			`done`,
			`[ "$others" -eq 0 ]`,
		].join("\n");
		const verified = await execIn(name, ["sh", "-c", check], { timeoutMs: 30_000 });
		if (verified.code !== 0) fail("fix worker container is not frozen: processes remain after the sweep");
	}

	try {
		baselineManifestHash = await hostManifestHash(workspacePath);
		expectedManifestHash = baselineManifestHash;
		// PSTACK-REL-DOCKER-005: a SIGKILLed prior incarnation leaves its labeled
		// containers and internal network alive. Before the first Docker mutation,
		// reclaim every resource carrying this run's exact managed+run-id labels;
		// a leftover that cannot be proven ours fails the bring-up closed instead
		// of running alongside unowned containers.
		const reclaim = await reclaimPriorIncarnations(runId, signal);
		if (reclaim.refused.length > 0) {
			fail(`prior incarnation resources for run '${runId}' could not be reclaimed: ${reclaim.refused.join("; ")}`);
		}
	} catch (error) {
		throw await discardFailedConstruction("pre-volume construction", error);
	}
	// The three model-adjacent writable surfaces (fix worktree, worker
	// staging, controller staging) live on kernel-bounded tmpfs-backed
	// volumes created before any container: no host directory backs them, so
	// nothing the model or adapter writes can grow host storage, and the
	// kernel (not a post-command scan) stops a writer past the byte or inode
	// quota. The local-driver tmpfs opts are what bound the volume — a plain
	// named volume is disk-backed and unbounded — and docker cp works into a
	// tmpfs-backed volume on a read-only-rootfs container where a --tmpfs
	// mount does not.
	//
	// `docker volume create` on an EXISTING name succeeds while silently
	// ignoring the requested labels and options, so a preexisting name can
	// never be created into: the exact name is probed first — an exactly-ours
	// leftover (labels + driver + tmpfs bounds) is reclaimed and created
	// fresh; anything else is foreign and bring-up fails closed without
	// touching it. After create, the mounted definition is verified exactly
	// (driver, type/device/o bounds, labels) before any container uses it.
	//
	// The lifecycle failure guard opens BEFORE the first volume/resource
	// mutation: every intended name is tracked before dispatch, and any
	// partial bring-up (e.g. the first volume created, the second failing)
	// is all-settled cleaned and absence-proven below.
	try {
		for (const [volumeName, volumeOwned, opts] of [
			[fixVolume, fixVolumeOwned, WORKSPACE_TMPFS_OPTS],
			[stageVolume, stageVolumeOwned, STAGING_TMPFS_OPTS],
			[controlVolume, controlVolumeOwned, CONTROL_TMPFS_OPTS],
		] as const) {
			trackedResources.set(volumeName, "volume");
			const preexisting = await volumeInspect(volumeName);
			if (preexisting.present === true) {
				const adopt = volumeDefinitionRefusal(preexisting, volumeOwned, opts);
				if (adopt) fail(`refusing to adopt preexisting volume '${volumeName}': ${adopt}`);
				await destroyResource("volume", volumeName, volumeOwned, false);
			} else if (preexisting.present === "unknown") {
				fail(`refusing to create volume '${volumeName}': pre-create probe failed (${preexisting.detail})`);
			}
			const created = await docker(
				["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=${opts}`, ...labelArgv(volumeOwned), volumeName],
				{ signal, timeoutMs: 60_000 },
			);
			if (created.code !== 0 && !created.stderr.includes("already exists")) {
				await reconcileResource("volume", volumeName, volumeOwned, "workspace volume create", created);
			}
			const mounted = await volumeInspect(volumeName);
			if (mounted.present === false) fail(`volume '${volumeName}' create reported success but the volume is absent`);
			const mismatch = mounted.present === "unknown"
				? `post-create probe failed (${mounted.detail})`
				: volumeDefinitionRefusal(mounted, volumeOwned, opts);
			if (mismatch) fail(`volume '${volumeName}' does not match the bounded definition and is never mounted: ${mismatch}`);
		}
		const adoptRefusal = ownershipProbeRefusal(await dockerLabels("network", networkName), networkOwned, "network", networkName, "adopt");
		if (adoptRefusal) fail(adoptRefusal);
		const created = await docker(["network", "create", "--internal", ...labelArgv(networkOwned), networkName], { timeoutMs: 60_000 });
		if (created.code !== 0 && !created.stderr.includes("already exists")) {
			await reconcileResource("network", networkName, networkOwned, "workspace network create", created);
		}
		// Post-create ownership probe: a race between the adopt probe and the
		// create can never bind this run to a foreign network.
		const createdOwned = ownershipProbeRefusal(await dockerLabels("network", networkName), networkOwned, "network", networkName, "adopt");
		if (createdOwned) fail(createdOwned);
		const settled = await Promise.allSettled([startWorker(containerMode), startController()]);
		for (const outcome of settled) {
			if (outcome.status === "rejected" && bringUpError === undefined) bringUpError = outcome.reason;
		}
		if (bringUpError === undefined && Array.isArray(bootstrapCommand) && bootstrapCommand.length > 0) {
			const prepared = await execIn(name, bootstrapCommand, { timeoutMs: 600_000, workdir: WORKSPACE_MOUNT });
			if (prepared.code !== 0) fail(`dependency bootstrap failed: ${prepared.stderr.trim().slice(0, 200)}`);
			baselineManifestHash = await hostManifestHash(workspacePath);
			expectedManifestHash = baselineManifestHash;
			await swapWorker("ro");
		}
	} catch (error) {
		if (bringUpError === undefined) bringUpError = error;
	}
	if (bringUpError !== undefined) {
		const refused = await teardownAfterFailure();
		// The failure boundary covers the whole construction: the disposable
		// run root is removed too, and every cleanup failure is aggregated.
		refused.push(...await removeFailedRunRoot());
		const message = bringUpError instanceof Error ? bringUpError.message : String(bringUpError);
		fail(refused.length > 0 ? `${message}; teardown: ${refused.join("; ")}` : message);
	}

	async function execIn(
		container: string,
		argv: string[],
		execOptions: { timeoutMs?: number; input?: Uint8Array | string; workdir?: string; env?: Array<[string, string]> } = {},
	): Promise<{ code: number; stdout: Buffer; stderr: string }> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) fail("workspace deadline expired");
		return docker(
			[
				"exec", "-i",
				...(execOptions.workdir ? ["--workdir", execOptions.workdir] : []),
				...(execOptions.env ?? []).flatMap(([key, value]) => [`-e${key}=${value}`]),
				container, ...argv,
			],
			{ timeoutMs: Math.min(execOptions.timeoutMs ?? EXEC_TIMEOUT_MS, remaining), input: execOptions.input, signal },
		);
	}

	/** Trusted adapter call: config-free cwd, scrubbed env, separate container. */
	async function adapterCall(capability: ControlCapability, input: Record<string, unknown>): Promise<{ result: Record<string, unknown>; artifacts: unknown[] }> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) fail("workspace deadline expired");
		const response = await execIn(controllerName, [...runtime.control_command], {
			input: JSON.stringify({
				capability,
				input: plainObject(input) ? input : {},
				runId,
				revision,
				artifactDir: STAGING_MOUNT,
				config: runtime.control_config ?? {},
				deadlineAt: deadline,
			}),
			timeoutMs: Math.min(CONTROL_TIMEOUT_MS, remaining),
			// Root-owned adapter code from a config-free cwd; Bun reads bunfig
			// from the cwd, so /opt/benny-control cannot be influenced by workers.
			workdir: "/opt/benny-control",
			env: [["HOME", "/tmp/benny-control/home"]],
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.stdout.toString("utf8"));
		} catch {
			fail(`control adapter returned unparseable output for '${capability}': ${response.stderr.slice(0, 200)}`);
		}
		if (!plainObject(parsed)) fail(`control adapter returned a non-object response for '${capability}'`);
		if (parsed.ok !== true) fail(`control capability '${capability}' failed: ${String(parsed.error ?? "adapter reported failure")}`);
		if (!plainObject(parsed.result)) fail(`control adapter returned a non-object result for '${capability}'`);
		return { result: parsed.result, artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [] };
	}

	/** Resolve a path inside a container and prove it stays under an allowed root; symlinks are resolved and checked. */
	async function safeContainerPath(
		container: string,
		path: unknown,
		roots: string[],
		mustExist: boolean,
	): Promise<string> {
		if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("path must be a nonempty string");
		const normalized = isAbsolute(path) ? path : `${roots[0]}/${path}`;
		if (normalized.split("/").includes("..")) fail(`path '${path}' escapes the workspace boundary`);
		if (!roots.some(root => normalized === root || normalized.startsWith(`${root}/`))) {
			fail(`path '${path}' resolves outside the allowed roots ${roots.join(", ")}`);
		}
		if (!mustExist) {
			const parent = normalized.slice(0, normalized.lastIndexOf("/")) || "/";
			if (parent !== roots[0]) await safeContainerPath(container, parent, roots, true);
			return normalized;
		}
		const real = await execIn(container, ["realpath", "-e", "--", normalized], { timeoutMs: 30_000 });
		if (real.code !== 0) fail(`path '${path}' does not exist in the workspace`);
		const resolved = real.stdout.toString().trim();
		if (!roots.some(root => resolved === root || resolved.startsWith(`${root}/`))) {
			fail(`path '${path}' escapes the workspace boundary via symlink`);
		}
		return resolved;
	}

	/**
	 * Current retained evidence usage for this run's host-only directory.
	 * Non-regular entries (a tampered or symlinked store) fail closed.
	 */
	async function evidenceUsage(): Promise<{ bytes: number; files: number }> {
		let bytes = 0;
		let files = 0;
		for (const entry of await readdir(evidenceDir)) {
			const link = await lstat(join(evidenceDir, entry)).catch(() => null);
			if (!link?.isFile()) fail(`retained evidence store contains a non-regular entry: ${entry}`);
			bytes += link.size;
			files += 1;
		}
		return { bytes, files };
	}

	/**
	 * Pull container bytes to a host temp dir, validate them (regular file, no
	 * symlink, declared type, size), and publish content-addressed with
	 * exclusive no-overwrite into the host-only evidence store.
	 *
	 * Every copy is source-bound: the artifact size is proven in the
	 * container BEFORE any byte is materialized on the host (a racing writer
	 * cannot exceed the kernel tmpfs bound of its source volume, and a
	 * diverged post-copy size is rejected), the per-artifact cap applies, and
	 * the fixed aggregate byte/inode budget is checked BEFORE retained host
	 * evidence grows.
	 */
	async function publishArtifact(container: string, containerPath: string, roots: string[]): Promise<ArtifactReceipt> {
		// The budget check and the exclusive publish share one critical
		// section: concurrent reservations by sibling workspaces of the same
		// logical run can never both pass a stale usage scan.
		return withEvidenceLock(evidenceDir, () => publishArtifactChecked(container, containerPath, roots));
	}

	async function publishArtifactChecked(container: string, containerPath: string, roots: string[]): Promise<ArtifactReceipt> {
		const safe = await safeContainerPath(container, containerPath, roots, true);
		const sizeProbe = await execIn(container, ["stat", "-c", "%s", "--", safe], { timeoutMs: 30_000 });
		if (sizeProbe.code !== 0) fail(`cannot stat artifact ${containerPath}: ${sizeProbe.stderr.toString().trim().slice(0, 200)}`);
		const declaredSize = Number(sizeProbe.stdout.toString().trim());
		if (!Number.isInteger(declaredSize) || declaredSize <= 0) fail(`artifact ${containerPath} is empty or has an unusable size`);
		if (declaredSize > MAX_ARTIFACT_BYTES) fail(`artifact ${containerPath} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
		const usage = await evidenceUsage();
		if (usage.files + 1 > EVIDENCE_BUDGET_FILES) {
			fail(`per-run evidence budget of ${EVIDENCE_BUDGET_FILES} retained files is exhausted (${usage.files} retained); refusing to retain ${containerPath}`);
		}
		if (usage.bytes + declaredSize > EVIDENCE_BUDGET_BYTES) {
			fail(`per-run evidence budget of ${EVIDENCE_BUDGET_BYTES} bytes would be exceeded (${usage.bytes} retained, artifact ${containerPath} needs ${declaredSize}); refusing to grow retained evidence`);
		}
		const temp = await mkdtemp(join(tmpdir(), "benny-artifact-"));
		try {
			const copied = await docker(["cp", "-a", `${container}:${safe}`, `${temp}/`], { signal, timeoutMs: 120_000 });
			if (copied.code !== 0) fail(`artifact copy failed for ${containerPath}: ${copied.stderr.slice(0, 200)}`);
			const files = await readdir(temp);
			const local = join(temp, files[0] ?? "");
			const link = await lstat(local).catch(() => null);
			if (!link || !link.isFile() || link.isSymbolicLink()) fail(`artifact ${containerPath} is not a regular file`);
			if (link.size !== declaredSize) fail(`artifact ${containerPath} changed between its size proof and its copy (${declaredSize} -> ${link.size} bytes); refusing raced bytes`);
			if (link.size > MAX_ARTIFACT_BYTES) fail(`artifact ${containerPath} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
			const data = await readFile(local);
			const expectedMime = MIME_BY_EXTENSION[extensionOf(safe)];
			if (expectedMime && (expectedMime.startsWith("image/") || expectedMime.startsWith("video/")) && !magicMatches(expectedMime, data)) {
				fail(`artifact ${containerPath} is malformed for its declared type ${expectedMime}`);
			}
			const digest = sha256(data);
			const published = join(evidenceDir, `${digest}${extensionOf(safe) || ".bin"}`);
			try {
				await writeFile(published, data, { flag: "wx", mode: 0o600 });
			} catch {
				const existing = await readFile(published).catch(() => null);
				if (!existing || sha256(existing) !== digest) fail(`evidence collision for ${published}`);
			}
			return { path: `${evidenceDirName}/${basename(published)}`, sha256: digest, mimeType: sniffMime(safe, data) };
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}

	let currentStage: WorkspaceStage | null = null;
	let capabilitiesValidated = false;
	let cleanedUp = false;

	async function call(action: "read" | "write" | "exec", input: Record<string, unknown>, stage: WorkspaceStage): Promise<unknown> {
		if (cleanedUp) fail("workspace already cleaned up");
		if (!plainObject(input)) fail("call input must be an object");
		if (!STAGE_ORDER.includes(stage)) fail(`unknown stage '${stage}'`);
		// Monotonic stages: study -> reproduce -> fix -> verify.
		if (currentStage !== null && STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(currentStage)) {
			fail(`stage regression from '${currentStage}' to '${stage}' is not permitted`);
		}
		const enteringFix = stage === "fix" && currentStage !== "fix";
		const leavingFix = currentStage === "fix" && READ_ONLY_STAGES.includes(stage);
		if (enteringFix) {
			// The worktree must still be pristine when the fix stage opens.
			const hostNow = await hostManifestHash(workspacePath);
			if (hostNow !== baselineManifestHash) fail("worktree diverged from the baseline snapshot before the fix stage");
			expectedManifestHash = baselineManifestHash;
			await swapWorker("fix");
		}
		if (leavingFix) {
			// FREEZE first: every process in the fix container EXCEPT PID 1 is
			// killed and the quiescent state is proven, so no model-spawned
			// background writer can race the authoritative manifest or the
			// copy-back. The container KEEPS RUNNING on purpose — a tmpfs
			// volume's content is destroyed by a stop/start cycle (the driver
			// unmounts and re-creates the tmpfs) — but with no process left
			// alive, nothing can mutate the frozen tree.
			await freezeWorker();
			// Authoritative manifest of the FROZEN tree, then the copy; the
			// copied host staging bytes must reproduce it exactly (content,
			// exec bits, symlink targets, paths — never following links)
			// before anything lands in the host worktree. Only after this
			// manifest-verified copy-back does the host snapshot freeze.
			const insideManifest = await containerManifest(name);
			const temp = await mkdtemp(join(tmpdir(), "benny-copyback-"));
			try {
				const copied = await docker(["cp", `${name}:${WORKSPACE_MOUNT}/.`, `${temp}/`], { signal, timeoutMs: 600_000 });
				if (copied.code !== 0) fail(`fix copy-back failed: ${copied.stderr.toString().trim().slice(0, 200)}`);
				const hostHash = await hostManifestHash(temp);
				if (hostHash !== insideManifest) {
					fail("fix copy-back diverged from the frozen in-container manifest; refusing to publish raced or partial changes");
				}
				for (const entry of await readdir(workspacePath)) {
					await rm(join(workspacePath, entry), { recursive: true, force: true });
				}
				// verbatimSymlinks: a relative symlink target must survive the
				// copy EXACTLY; Node's default re-resolves it against the new
				// location, which would rewrite the frozen tree's links.
				await cp(temp, workspacePath, { recursive: true, verbatimSymlinks: true });
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
			expectedManifestHash = insideManifest;
			const hostNow = await hostManifestHash(workspacePath);
			if (hostNow !== expectedManifestHash) fail("fix copy-back did not reproduce the container manifest on the host");
			// Freeze the canonical tree OID alongside the content manifest: the
			// publisher compares its independently staged tree against this OID.
			await canonicalTreeHash();
			// The frozen tree is safely copied back to the host worktree and its
			// canonical OID is frozen, so verify runs in a read-only worker.
			// Replace the writable fix worker before any verify-stage tool call so
			// a verify role can never retain a writable /workspace; a failed swap
			// propagates and stays covered by the run-level fail-closed cleanup.
			await swapWorker("ro");
		}
		currentStage = stage;

		if (action === "write") {
			if (stage !== "fix") fail(`code writes are only permitted in the fix stage; stage is '${stage}'`);
			const encoding = typeof input.encoding === "string" ? input.encoding : "utf8";
			if (encoding !== "utf8" && encoding !== "base64") fail(`unsupported write encoding '${encoding}'`);
			const raw = encoding === "base64" ? input.base64 : input.content;
			if (typeof raw !== "string") fail("write requires 'content' (utf8) or 'base64' string");
			const content = encoding === "base64" ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
			const target = await safeContainerPath(name, input.path, [WORKSPACE_MOUNT], false);
			const made = await execIn(name, ["mkdir", "-p", "--", target.slice(0, target.lastIndexOf("/")) || "/"], { timeoutMs: 30_000, workdir: WORKSPACE_MOUNT });
			if (made.code !== 0) fail(`cannot create parent directory for ${target}: ${made.stderr.toString().slice(0, 200)}`);
			const temp = await mkdtemp(join(tmpdir(), "benny-write-"));
			try {
				const hostFile = join(temp, "payload");
				await writeFile(hostFile, content);
				const copied = await docker(["cp", hostFile, `${name}:${target}`], { signal, timeoutMs: 60_000 });
				if (copied.code !== 0) fail(`write failed for ${target}: ${copied.stderr.toString().slice(0, 200)}`);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
			return { path: target, size: content.length, sha256: sha256(content) };
		}
		if (action === "read") {
			const target = await safeContainerPath(name, input.path, [WORKSPACE_MOUNT], true);
			const maxBytes = typeof input.maxBytes === "number" && input.maxBytes > 0 ? Math.min(input.maxBytes, 32 * 1024 * 1024) : 8 * 1024 * 1024;
			const sizeProbe = await execIn(name, ["stat", "-c", "%s", "--", target], { timeoutMs: 30_000, workdir: WORKSPACE_MOUNT });
			if (sizeProbe.code !== 0) fail(`cannot stat ${target}`);
			const size = Number(sizeProbe.stdout.toString().trim());
			if (size > maxBytes) fail(`read of ${target} exceeds maxBytes (${size} > ${maxBytes})`);
			const read = await execIn(name, ["cat", "--", target], { timeoutMs: 120_000, workdir: WORKSPACE_MOUNT });
			if (read.code !== 0) fail(`read failed for ${target}: ${read.stderr.toString().slice(0, 200)}`);
			return { path: target, size, sha256: sha256(read.stdout), base64: read.stdout.toString("base64") };
		}
		if (action === "exec") {
			const rawCommand = input.command;
			if (!Array.isArray(rawCommand) || rawCommand.length === 0) {
				fail("exec requires a nonempty argv array of strings (no shell strings)");
			}
			const argv: string[] = [];
			for (const part of rawCommand) {
				if (typeof part !== "string" || part.length === 0 || part.includes("\0")) {
					fail("exec requires a nonempty argv array of strings (no shell strings)");
				}
				argv.push(part);
			}
			let workdir = WORKSPACE_MOUNT;
			if (typeof input.cwd === "string") workdir = await safeContainerPath(name, input.cwd, [WORKSPACE_MOUNT, "/tmp"], true);
			const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? Math.min(input.timeoutMs, 600_000) : EXEC_TIMEOUT_MS;
			const result = await execIn(name, argv, { timeoutMs, workdir });
			return { exitCode: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
		}
		fail(`unknown action '${String(action)}'`);
	}

	/**
	 * Capability gate: the adapter must declare all seven capabilities and prove
	 * a real screenshot and a real recording (a decodable frame) before any
	 * repro work. Only bring-up may run before this passes.
	 */
	async function validateCapabilities(bringUpResult: Record<string, unknown>): Promise<void> {
		const declared = bringUpResult.capabilities;
		if (!Array.isArray(declared) || !CONTROL_CAPABILITIES.every(capability => declared.includes(capability))) {
			fail(`control adapter did not declare all seven capabilities (declared: ${JSON.stringify(declared)})`);
		}
		const probeShot = await adapterCall("screenshot", { path: `${STAGING_MOUNT}/capability-probe.png`, description: "capability probe" });
		const recordingPath = typeof probeShot.result.recordingPath === "string" ? probeShot.result.recordingPath : `${STAGING_MOUNT}/capability-probe.webm`;
		await adapterCall("recording", { action: "start", path: recordingPath });
		const stopped = await adapterCall("recording", { action: "stop", path: recordingPath });
		if (typeof stopped.result.frames !== "number" || stopped.result.frames < 1) {
			fail("recording capability produced no frames during the capability probe");
		}
		const frame = await execIn(
			controllerName,
			["ffmpeg", "-v", "error", "-i", recordingPath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
			{ timeoutMs: 120_000, workdir: "/opt/benny-control" },
		);
		if (frame.code !== 0 || frame.stdout.length === 0 || !magicMatches("image/png", frame.stdout)) {
			fail("recording probe produced no decodable video frame");
		}
		if (typeof probeShot.result.path === "string") await publishArtifact(controllerName, probeShot.result.path, [STAGING_MOUNT]);
		for (const rawPath of stopped.artifacts) {
			if (typeof rawPath === "string") await publishArtifact(controllerName, rawPath, [STAGING_MOUNT]);
		}
		capabilitiesValidated = true;
	}

	async function control(capability: ControlCapability, input: Record<string, unknown>): Promise<ControlReceipt> {
		if (cleanedUp) fail("workspace already cleaned up");
		if (!CONTROL_CAPABILITIES.includes(capability)) {
			fail(`unknown control capability '${String(capability)}'; required: ${CONTROL_CAPABILITIES.join(", ")}`);
		}
		// Control is unavailable in the fix stage (code editing only); cleanup is
		// always allowed so an interrupted fix can release adapter state.
		if (currentStage === null && capability !== "cleanup") fail("enter a workspace stage with call() before using control capabilities");
		if (currentStage === "fix" && capability !== "cleanup") fail("control capabilities are unavailable during the fix stage");
		if (capability !== "bring-up" && capability !== "cleanup" && !capabilitiesValidated) {
			fail("bring-up must succeed (with the capability probe) before any other control capability");
		}
		const { result, artifacts } = await adapterCall(capability, plainObject(input) ? input : {});
		if (capability === "bring-up") await validateCapabilities(result);
		const at = Date.now();
		const receipts: ArtifactReceipt[] = [];
		for (const rawPath of artifacts) {
			if (typeof rawPath !== "string" || rawPath.length === 0) fail("adapter artifact paths must be nonempty strings");
			receipts.push(await publishArtifact(controllerName, rawPath, [STAGING_MOUNT]));
		}
		if (capability === "cleanup") {
			await stopContainer(controllerName);
			await stopContainer(name);
			await removeNetwork();
			cleanedUp = true;
		}
		return { runId, capability, at, revision, result, artifacts: receipts };
	}

	async function artifacts(paths: string[]): Promise<ArtifactData[]> {
		if (!Array.isArray(paths) || paths.length === 0) fail("artifacts requires a nonempty path array");
		const results: ArtifactData[] = [];
		for (const rawPath of paths) {
			// A content-addressed reference — either this run's own published
			// receipt (`<evidenceDirName>/<blob>`), a bare blob from before the
			// receipt carried its owner, or a root-level legacy layout — is read
			// straight from the evidence store. Anything else is a live
			// container path and is published fresh.
			const owned = rawPath.startsWith(`${evidenceDirName}/`) ? rawPath.slice(evidenceDirName.length + 1) : rawPath;
			if (owned === basename(owned) && /^[0-9a-f]{64}(?:\.[A-Za-z0-9]+)?$/.test(owned)) {
				const published = join(evidenceDir, owned);
				const link = await lstat(published).catch(() => null);
				if (!link || !link.isFile() || link.isSymbolicLink()) fail(`published evidence ${rawPath} is not a regular file`);
				const data = await readFile(published);
				const digest = sha256(data);
				if (digest !== owned.slice(0, 64)) fail(`published evidence ${rawPath} does not match its content address`);
				results.push({ path: `${evidenceDirName}/${owned}`, sha256: digest, mimeType: sniffMime(owned, data), data, timestampMs: Date.now() });
				continue;
			}
			// Worker staging or worktree views only; the evidence store is host-only.
			const safe = await safeContainerPath(name, rawPath, [STAGING_MOUNT, WORKSPACE_MOUNT], true);
			const receipt = await publishArtifact(name, safe, [STAGING_MOUNT, WORKSPACE_MOUNT]);
			const published = join(evidenceDir, basename(receipt.path));
			const link = await lstat(published).catch(() => null);
			if (!link || !link.isFile() || link.isSymbolicLink()) fail(`published evidence ${receipt.path} is not a regular file`);
			const data = await readFile(published);
			if (sha256(data) !== receipt.sha256) fail(`published evidence ${receipt.path} does not match its receipt digest`);
			results.push({ path: receipt.path, sha256: receipt.sha256, mimeType: receipt.mimeType, data, timestampMs: Date.now() });
		}
		return results;
	}

	async function snapshotHash(): Promise<string> {
		const current = await hostManifestHash(workspacePath);
		if (current !== expectedManifestHash) fail("workspace snapshot changed after it was frozen");
		// Canonical identity is the Git tree OID (modes and symlink targets
		// included), recomputed deterministically after the manifest check.
		return canonicalTreeHash();
}

	async function cleanup(): Promise<unknown> {
		const failures: string[] = [];
		let adapterReceipt: ControlReceipt | undefined;
		// The evidence retention sweep runs first and NEVER aborts teardown:
		// its failure is captured and aggregated like every other step.
		let sweep: EvidenceSweepResult | undefined;
		try {
			sweep = await sweepExpiredEvidence(cwd, config.control.artifact_retention_hours, { ownDir: evidenceDirName });
		} catch (error) {
			failures.push(`evidence retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!cleanedUp) {
			try {
				adapterReceipt = await control("cleanup", {});
			} catch (error) {
				failures.push(`control adapter cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Both containers are attempted before the network and the volumes,
		// each regardless of a sibling failure; a mounted volume can only be
		// removed after its container is gone, and the network removal is
		// retried once after the containers detach. No teardown sibling is
		// skipped after an earlier failure.
		for (const container of [controllerName, name]) {
			try {
				await stopContainer(container, false);
			} catch (error) {
				failures.push(`container '${container}' stop/remove failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const [volumeName, volumeOwned] of [[fixVolume, fixVolumeOwned], [stageVolume, stageVolumeOwned], [controlVolume, controlVolumeOwned]] as const) {
			try {
				await destroyResource("volume", volumeName, volumeOwned, false);
			} catch (error) {
				failures.push(`volume '${volumeName}' removal failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await removeNetworkWithRetry((message) => failures.push(`network '${networkName}' removal failed: ${message}`));
		// Every tracked resource is probed regardless of earlier failures: only
		// a probe-proven absence completes cleanup. A still-present resource or
		// an unprovable inspect (timeout, down daemon, permissions) fails
		// cleanup, retains the run root, and names the exact resource and probe
		// failure — a nonzero inspect exit alone proves nothing about the
		// daemon's state.
		for (const resource of await probeAllTracked()) {
			failures.push(`workspace cleanup did not prove absence of ${resource}`);
		}
		if (failures.length > 0) fail(failures.join("; "));
		cleanedUp = true;
		// The disposable run root (worktree + staging) is removed only after
		// every step succeeded and every container has stopped and the network
		// is gone; the evidence store is separate and retained for active runs.
		await rm(runRoot, { recursive: true, force: true });
		return {
			adapterReceipt,
			stopped: [controllerName, name],
			removed: [controllerName, name, networkName, runRoot],
			retained: [evidenceDir],
			...(sweep && (sweep.retained.length > 0 || sweep.storeUnreadable)
				? { evidenceRetention: "some expired evidence retained: it belongs to queued/running runs or the run store was unreadable" }
				: {}),
		};
	}

	return { workspacePath, revision, baselineHash, call, control, artifacts, snapshotHash, cleanup };
}

async function hostManifestHash(dir: string): Promise<string> {
	const manifest = await run(["sh", "-c", manifestScript(dir)], { timeoutMs: 300_000 });
	if (manifest.code !== 0) fail(`manifest computation failed for ${dir}: ${manifest.stderr.trim().slice(0, 200)}`);
	return manifest.stdout.toString().trim();
}

/**
 * Re-read published evidence by content address and rehash it, with no live
 * workspace required. A resumed run must prove the retained bytes still exist
 * and match every recorded receipt before an irreversible gate (draft PR)
 * consumes them — hashes alone in the checkpoint are claims, not bytes.
 */
export async function readPublishedEvidence(cwd: string, artifactDir: string, paths: string[]): Promise<ArtifactData[]> {
	if (!Array.isArray(paths) || paths.length === 0) fail("readPublishedEvidence requires a nonempty path array");
	const evidenceRootPath = securePrivateDir(cwd, ...ARTIFACT_ROOT_SEGMENTS);
	if (resolve(cwd, artifactDir) !== evidenceRootPath) {
		fail(`artifact storage is fixed to ${ARTIFACT_ROOT} beneath the secure private root; refusing '${artifactDir}'`);
	}
	const results: ArtifactData[] = [];
	for (const rawPath of paths) {
		// Receipts carry their owning evidence directory (`<run>/<blob>`): the
		// lookup is one direct stat, so no unordered directory scan — and no
		// arbitrary entry cap — can ever hide a valid retained artifact. Bare
		// content addresses are legacy receipts and fall back to an uncapped
		// scan of the evidence root.
		const match = /^(?:([A-Za-z0-9_-]{1,64})\/)?([0-9a-f]{64}(?:\.[A-Za-z0-9]+)?)$/.exec(rawPath);
		if (!match) fail(`published evidence must be '<run-dir>/<content-address>' or a content address, got '${rawPath}'`);
		const [, owner, name] = match;
		const candidates: string[] = [];
		if (owner !== undefined) {
			candidates.push(join(evidenceRootPath, owner, name));
		} else {
			candidates.push(join(evidenceRootPath, name));
			for (const entry of await readdir(evidenceRootPath, { withFileTypes: true })) {
				if (entry.isDirectory() && !entry.isSymbolicLink() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) {
					candidates.push(join(evidenceRootPath, entry.name, name));
				}
			}
		}
		let data: Uint8Array | undefined;
		for (const candidate of candidates) {
			const metadata = await lstat(candidate).catch(() => undefined);
			if (metadata === undefined) continue;
			// Worker-side symlinks must never route a host read; only regular
			// files are candidates, and the digest check below binds the bytes.
			if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
			data = await readFile(candidate);
			break;
		}
		if (data === undefined) fail(`published evidence ${rawPath} is missing or unreadable`);
		const digest = sha256(data);
		if (digest !== name.slice(0, 64)) fail(`published evidence ${rawPath} does not match its content address`);
		results.push({ path: rawPath, sha256: digest, mimeType: sniffMime(name, data), data, timestampMs: Date.now() });
	}
	return results;
}

export interface EvidenceSweepResult {
	/** Expired evidence directories removed by this sweep. */
	removed: string[];
	/** Expired directories retained because they are still owned (queued/running rows, live containers, or the caller's own run). */
	retained: string[];
	/** True when the run store could not be read; the sweep then fails closed and retains everything expired. */
	storeUnreadable: boolean;
}

/**
 * Retention sweep for published Benny evidence and run-owned auxiliary
 * state, runnable from any durable path — runner startup, terminal
 * settlement, or a workspace cleanup — never dependent on another workspace
 * being created later. Expired state (mtime older than the configured
 * cutoff) is removed unless it is still owned: a queued/running row in the
 * profile-private run store, a run-id-labeled container, or the calling
 * workspace's own directory. The same expiry + active-run fail-closed policy
 * applies to the run-owned `benny-downloads/<row-id>` Slack download caches,
 * `benny-publish-source/<row-id>` retained publication snapshots, and
 * `benny-publication/<row-id>` run-owned publication scratch. The
 * sweep never deletes when ownership cannot be established.
 */
export async function sweepExpiredEvidence(
	cwd: string,
	retentionHours: number,
	options: { ownDir?: string } = {},
): Promise<EvidenceSweepResult> {
	const stateRoot = securePrivateDir(cwd, ".omp", "pstack", "state");
	const evidenceRoot = await secureDirectory(join(stateRoot, "benny-evidence"));
	const activeRunIds = activeBennyRunIds(cwd);
	const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
	const removed: string[] = [];
	const retained: string[] = [];
	for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
		if (entry.name === options.ownDir || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
		const path = join(evidenceRoot, entry.name);
		const metadata = await lstat(path);
		if (metadata.mtimeMs >= cutoff) continue;
		// Active-run detection by ownership label, never by name reconstruction:
		// container names embed an unguessable per-run incarnation, so the
		// run-id label is the only way to find a run's containers. A failed
		// listing cannot prove absence — retain rather than destroy.
		const stillRunning = await docker(
			["ps", "-a", "--format", "{{.Names}}", "--filter", `label=${LABEL_RUN_ID}=${entry.name}`],
			{ timeoutMs: 30_000 },
		);
		if (stillRunning.code !== 0 || stillRunning.stdout.toString().trim().length > 0) {
			retained.push(entry.name);
			continue;
		}
		// queued/running run rows keep every evidence dir they own,
		// including suffixed workspaces (<id>-ops, <id>-base, <id>-head,
		// <id>-plan); the parked rejection-wait run is queued by design.
		const runKey = /^(\d+)(?:-|$)/.exec(entry.name)?.[1];
		if (activeRunIds === null || (runKey !== undefined && activeRunIds.has(runKey))) {
			retained.push(entry.name);
			continue;
		}
		await rm(path, { recursive: true, force: true });
		removed.push(entry.name);
	}
	// Run-owned auxiliary stores: Slack download caches and retained
	// publication snapshots live under `<store>/<benny row id>`. The same
	// expiry + active-run fail-closed policy applies — an entry whose numeric
	// row id is queued/running is never touched, and an unreadable store,
	// non-numeric entry (legacy flat download files), symlink, or non-directory
	// is retained rather than guessed at. A missing store has nothing to sweep.
	for (const store of ["benny-downloads", "benny-publish-source", "benny-publication"] as const) {
		const root = join(stateRoot, store);
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!/^\d{1,18}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
			const path = join(root, entry.name);
			const metadata = await lstat(path);
			if (metadata.mtimeMs >= cutoff) continue;
			if (activeRunIds === null || activeRunIds.has(entry.name)) {
				retained.push(`${store}/${entry.name}`);
				continue;
			}
			await rm(path, { recursive: true, force: true });
			removed.push(`${store}/${entry.name}`);
		}
	}
	return { removed, retained, storeUnreadable: activeRunIds === null };
}

// ---------------------------------------------------------------------------
// Media review: separate tool-free SDK session over the actual evidence bytes.
// ---------------------------------------------------------------------------

const MAX_REVIEW_IMAGES = 12;
const MAX_REVIEW_FRAMES = 12;
const MAX_REVIEW_FRAME_BYTES = 32 * 1024 * 1024;

export interface MediaArtifact {
	path: string;
	sha256: string;
	mimeType: string;
	data: Uint8Array;
}

export interface ReviewMediaOptions {
	config: BennyConfig;
	/**
	 * The admitted immutable workspace image id (`sha256:<64 hex>`) the run is
	 * authorized for. Recording frames are decoded only by this identity after
	 * the live tag reference re-resolves to exactly it — a retag or repull
	 * between admission and review can never substitute image bytes.
	 */
	imageId: string;
	artifacts: MediaArtifact[];
	/**
	 * The logical run id this review serves. When present, decoder
	 * containers/volumes/staging carry the exact per-run identity (run-id
	 * label = sanitized `runId`) and crash-left decoder resources of that
	 * SAME logical run (media/media-storage roles only) are reclaimed with
	 * exact label checks and proven absence before any byte is staged —
	 * another run's resources are never touched. Absent decoders keep the
	 * legacy unscoped `media` run-id label and reclaim only their own
	 * exact-name leftovers.
	 */
	runId?: string;
	prompt: string;
	deadline: number;
	cwd?: string;
	signal?: AbortSignal;
}

/**
 * Validates the structured verdict against the EXACT attached attachments;
 * returns null when the model output is unusable. Every evidence entry must
 * STRUCTURALLY cite at least one attached imageIndex (`imageIndex <n>`),
 * every cited index must be in range, and every attached image index
 * (0..imageCount-1) must be covered by at least one entry — generic prose,
 * out-of-range citations, or partial coverage all block the verdict.
 */
export function parseMediaVerdict(text: string, imageCount: number): { confirmed: boolean; evidence: string[] } | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const parsed: unknown = JSON.parse(match[0]);
		if (!plainObject(parsed)) return null;
		const confirmed = parsed.confirmed;
		const evidence = parsed.evidence;
		if (typeof confirmed !== "boolean" || !Array.isArray(evidence) || evidence.length === 0) return null;
		if (!Number.isInteger(imageCount) || imageCount < 1) return null;
		const covered = new Set<number>();
		const items: string[] = [];
		for (const item of evidence) {
			if (typeof item !== "string" || item.length === 0) return null;
			let cited = false;
			for (const citation of item.matchAll(/imageIndex\s*[:=]?\s*(\d+)/g)) {
				const index = Number(citation[1]);
				if (index >= imageCount) return null;
				covered.add(index);
				cited = true;
			}
			if (!cited) return null;
			items.push(item);
		}
		if (covered.size !== imageCount) return null;
		return { confirmed, evidence: items };
	} catch {
		return null;
	}
}

export interface DecodedFrame {
	data: Uint8Array;
	/** Actual presentation timestamp of this frame in milliseconds. */
	timestampMs: number;
	index: number;
	sourceSha256: string;
}

/**
 * Decode selected frames and their presentation timestamps in ONE ffmpeg
 * invocation: the showinfo filter prints the pts of exactly the frames that
 * are written, so frames and PTS come from the same population.
 *
 * The decoder runs as a uniquely named, exactly-owned hardened container —
 * the same boundary flags as the workspace containers (non-root, no
 * capabilities, no-new-privileges, read-only root, explicit /tmp and /dev/shm
 * byte+inode tmpfs bounds, memory cgroup above all attached tmpfs ceilings,
 * bounded PIDs/CPUs) with network none — carrying the exact Benny
 * managed/run/incarnation/media ownership labels. Its input and output
 * staging is NEVER an ordinary host bind: input and decoded frames live on
 * the per-decode exact-owned, kernel-bounded decoder tmpfs volume, and the
 * mounted volume's exact definition is verified before any byte is staged or
 * pulled. The run is never `--rm`: an ambiguous outcome is reconciled by
 * exact ownership labels, only the exactly-owned container AND volume are
 * removed, and a tri-state PROVEN absence is required on every exit path —
 * success, decode failure, timeout, and abort.
 * When a logical run id is supplied (`options.runId`), the decoder resources
 * carry that run's exact run-id label and every crash-left decoder resource
 * of the SAME logical run (media roles only) is reclaimed with exact label
 * checks and proven absence before any byte is staged; other runs are never
 * touched.
 */
export async function decodeVideoFrames(
	image: string,
	data: Uint8Array,
	options: { maxFrames?: number; signal?: AbortSignal; runId?: string } = {},
): Promise<DecodedFrame[]> {
	const signal = options.signal;
	const maxFrames = options.maxFrames ?? MAX_REVIEW_FRAMES;
	if (data.length === 0) fail("decoder input is empty");
	if (data.length > MAX_ARTIFACT_BYTES) fail(`decoder input exceeds ${MAX_ARTIFACT_BYTES} bytes`);
	const incarnation = randomBytes(8).toString("hex");
	const name = `benny-media-${incarnation}`;
	const volumeName = `${name}-work`;
	const owned: Record<string, string> = {
		[LABEL_MANAGED]: "true",
		[LABEL_RUN_ID]: options.runId === undefined ? "media" : sanitizeRunId(options.runId),
		[LABEL_INCARNATION]: incarnation,
		[LABEL_ROLE]: "media",
	};
	const volumeOwned: Record<string, string> = { ...owned, [LABEL_ROLE]: "media-storage" };
	// Run-scoped identity: when the review carries a logical run id, the
	// decoder resources are exactly-owned BY THAT RUN and every crash-left
	// decoder resource of the same logical run (media roles only) is
	// reclaimed before any byte is staged. The listing filter pins run-id +
	// managed, and every candidate is re-probed for the EXACT label set —
	// another run's, a foreign, or an unprovable resource is never touched.
	if (options.runId !== undefined) {
		const reclaim = await reclaimMediaDecoders(sanitizeRunId(options.runId), signal);
		if (reclaim.refused.length > 0) {
			fail(`crash-left decoder resources for run '${options.runId}' could not be reclaimed: ${reclaim.refused.join("; ")}`);
		}
	}
	const sourceSha256 = sha256(data);
	const temp = await mkdtemp(join(tmpdir(), "benny-video-"));
	let frames: DecodedFrame[] | undefined;
	let failure: string | undefined;
	try {
		// Pre-probe both intended names: an exactly-ours leftover is destroyed
		// first; anything else is foreign and refuses the decode outright.
		for (const [kind, resource, expected] of [
			["container", name, owned],
			["volume", volumeName, volumeOwned],
		] as const) {
			const probe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
			if (probe.present === true) {
				if (ownershipRefusal(probe.labels, expected, kind, resource, "remove") !== undefined) {
					fail(`refusing to run the decoder: pre-existing ${kind} '${resource}' is not owned by this decoder identity`);
				}
				await destroyOwnedResource(kind, resource, expected, signal);
			} else if (probe.present === "unknown") {
				fail(`cannot run the decoder: pre-existing ${kind} '${resource}' ownership is unprovable (${probe.detail})`);
			}
		}
		// Quota-backed I/O staging: input artifact plus decoded frames on a
		// byte- AND inode-bounded tmpfs volume with no host directory behind it.
		const created = await docker(
			["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=${DECODER_TMPFS_OPTS}`, ...labelArgv(volumeOwned), volumeName],
			{ signal, timeoutMs: 60_000 },
		);
		if (created.code !== 0) fail(`decoder staging volume create failed: ${created.stderr.trim().slice(0, 200)}`);
		const definition = await volumeInspect(volumeName);
		if (definition.present !== true) {
			fail(`decoder staging volume '${volumeName}' is ${definition.present === false ? "absent after create" : `unprovable (${definition.detail})`}`);
		}
		const definitionMismatch = volumeDefinitionRefusal(definition, volumeOwned, DECODER_TMPFS_OPTS);
		if (definitionMismatch) fail(`decoder staging volume '${volumeName}' does not match the bounded definition: ${definitionMismatch}`);
		// Hardened container holding the volume at /work; ffmpeg runs via exec
		// so the I/O staging can be verified before and after the decode.
		const started = await docker(
			[
				"run", "-d", "--name", name,
				"--network", "none",
				"--user", "1000:1000",
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--read-only",
				"--tmpfs", `/tmp:${TMP_TMPFS_OPTS}`,
				"--tmpfs", `/dev/shm:${SHM_TMPFS_OPTS}`,
				"--memory", DECODER_MEMORY,
				"--memory-swap", DECODER_MEMORY,
				"--pids-limit", "256",
				"--cpus", "2",
				...labelArgv(owned),
				"-v", `${volumeName}:/work:rw`,
				image, "sleep", "infinity",
			],
			{ signal, timeoutMs: 120_000 },
		);
		if (started.code !== 0) fail(`decoder container start failed: ${started.stderr.trim().slice(0, 200)}`);
		for (let attempt = 0; ; attempt++) {
			const inspect = await docker(["inspect", "-f", "{{.State.Running}}", name], { signal, timeoutMs: 30_000 });
			const state = inspect.stdout.toString().trim();
			if (state.startsWith("false")) fail("decoder container exited immediately; check the image CMD");
			if (state.startsWith("true")) break;
			if (attempt >= 20) fail("decoder container did not become ready within 5s");
			await Bun.sleep(250);
		}
		const adopted = ownershipProbeRefusal(await dockerLabels("container", name), owned, "container", name, "adopt");
		if (adopted) fail(adopted);
		const mountInspect = await docker(["inspect", "-f", "{{json .Mounts}}", name], { signal, timeoutMs: 30_000 });
		if (mountInspect.code !== 0) fail(`cannot inspect decoder mounts: ${mountInspect.stderr.trim().slice(0, 200)}`);
		let decoderMounts: unknown;
		try {
			decoderMounts = JSON.parse(mountInspect.stdout.toString("utf8"));
		} catch {
			fail("unparseable decoder mount inspection");
		}
		if (!Array.isArray(decoderMounts)) fail("decoder mount inspection is not a list");
		const workMount = decoderMounts.find((mount: unknown): mount is Record<string, unknown> => plainObject(mount) && mount.Destination === "/work");
		if (!workMount || workMount.Type !== "volume" || workMount.Name !== volumeName) {
			fail(`decoder container '/work' is ${JSON.stringify(workMount ?? null)} but must be exactly the bounded volume '${volumeName}'`);
		}
		const mountedDefinition = await volumeInspect(volumeName);
		if (mountedDefinition.present !== true || volumeDefinitionRefusal(mountedDefinition, volumeOwned, DECODER_TMPFS_OPTS)) {
			fail(`decoder staging volume '${volumeName}' no longer matches the bounded definition while mounted`);
		}
		// Stage the input INTO the bounded volume — never an ordinary host bind.
		await writeFile(join(temp, "input"), data);
		const staged = await docker(["cp", join(temp, "input"), `${name}:/work/input`], { signal, timeoutMs: 120_000 });
		if (staged.code !== 0) fail(`decoder input staging failed: ${staged.stderr.trim().slice(0, 200)}`);
		const decode = await docker(
			[
				"exec", name, "ffmpeg",
				"-v", "info", "-i", "/work/input",
				"-vf", "fps=2,showinfo", "-frames:v", String(maxFrames),
				"-f", "image2", "/work/frame-%03d.png",
			],
			{ signal, timeoutMs: 180_000 },
		);
		if (decode.code !== 0) fail(`video decode failed (docker exit ${decode.code}): ${decode.stderr.trim().slice(0, 400)}`);
		// showinfo lines appear in output order: one per written frame.
		const timestamps: number[] = [];
		for (const match of decode.stderr.matchAll(/pts_time:([0-9.]+)/g)) {
			timestamps.push(Math.round(Number(match[1]) * 1000));
		}
		const listing = await docker(["exec", name, "sh", "-c", "ls -1 /work"], { signal, timeoutMs: 30_000 });
		if (listing.code !== 0) fail(`cannot list decoder staging volume: ${listing.stderr.trim().slice(0, 200)}`);
		const frameNames = listing.stdout.toString().split("\n").map(name2 => name2.trim()).filter(entry => /^frame-[0-9]{3}\.png$/.test(entry)).sort();
		if (frameNames.length > maxFrames) fail(`decoder produced ${frameNames.length} frames but only ${maxFrames} were requested`);
		const out: DecodedFrame[] = [];
		for (const frameName of frameNames) {
			const pulled = await docker(["cp", `${name}:/work/${frameName}`, `${temp}/`], { signal, timeoutMs: 120_000 });
			if (pulled.code !== 0) fail(`frame pull failed for ${frameName}: ${pulled.stderr.trim().slice(0, 200)}`);
			const bytes = await readFile(join(temp, frameName));
			if (bytes.length === 0 || bytes.length > MAX_REVIEW_FRAME_BYTES) fail(`decoded frame ${frameName} has an unusable size (${bytes.length} bytes)`);
			if (!magicMatches("image/png", bytes)) fail(`decoded frame ${frameName} is not PNG bytes`);
			const frameIndex = Number(frameName.slice(6, 9)) - 1;
			out.push({ data: new Uint8Array(bytes), timestampMs: timestamps[frameIndex] ?? 0, index: frameIndex, sourceSha256 });
		}
		frames = out;
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		await rm(temp, { recursive: true, force: true });
		// Reconcile BOTH the decoder container and its staging volume by exact
		// ownership labels; a tri-state PROVEN absence is required on every
		// exit path — success, decode failure, timeout, and abort. Foreign or
		// unprovable resources are never touched; they fail the decode instead.
		const problems: string[] = [];
		for (const [kind, resource, expected] of [
			["container", name, owned],
			["volume", volumeName, volumeOwned],
		] as const) {
			let removalFailure: string | undefined;
			const preProbe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
			if (preProbe.present === true && ownershipRefusal(preProbe.labels, expected, kind, resource, "remove") === undefined) {
				try {
					// Teardown deliberately IGNORES the abort signal: an aborted
					// decode must still reconcile its container and volume.
					await destroyOwnedResource(kind, resource, expected);
				} catch (error) {
					removalFailure = error instanceof Error ? error.message : String(error);
				}
			}
			const postProbe = await dockerLabels(kind, resource).catch((): DockerLabelProbe => ({ present: "unknown", detail: "ownership probe failed" }));
			if (removalFailure !== undefined) problems.push(removalFailure);
			if (postProbe.present === true) {
				problems.push(
					ownershipRefusal(postProbe.labels, expected, kind, resource, "remove") === undefined
						? `decoder ${kind} '${resource}' survived removal`
						: `decoder ${kind} '${resource}' carries foreign ownership labels and was left untouched`,
				);
			} else if (postProbe.present === "unknown") {
				problems.push(`decoder ${kind} '${resource}' absence is unprovable (${postProbe.detail})`);
			}
		}
		const messages = failure ? [failure, ...problems] : problems;
		if (messages.length > 0) fail(messages.join("; "));
	}
	return frames ?? fail("decoder settled without producing frames");
}

/**
 * Independent media review. A tool-free, credential-free SDK session on a
 * neutral temp cwd with no context files, rules, or ambient instructions
 * receives the actual screenshot bytes, decoded timestamped video frames, and
 * an ordered evidence manifest — never file paths alone, never source
 * coordinates, never credentials. Video decoding is bound to the admitted
 * immutable workspace image id (`input.imageId`): the live tag must resolve
 * to exactly that identity immediately before any decode, and only that
 * identity runs the decoder container.
 */
export async function reviewMedia(input: ReviewMediaOptions): Promise<{ confirmed: boolean; evidence: string[]; reviewedHashes: string[] }> {
	const { config, artifacts, prompt, deadline, signal } = input;
	const manifest: Array<Record<string, unknown>> = [];
	const reviewedHashes = new Set<string>();
	if (!/^sha256:[0-9a-f]{64}$/.test(input.imageId)) {
		fail(`media review requires the admitted immutable workspace image id (sha256:<64 hex>), got ${JSON.stringify(input.imageId)}`);
	}
	if (!config.runtime?.workspace_image) fail("runtime.workspace_image is required for media review");
	if (!config.models?.media_review) fail("models.media_review is required for media review");
	const authStorage = await discoverAuthStorage();
	const registry = new ModelRegistry(authStorage);
	await registry.refresh();
	const available = registry.getAvailable();
	const bareSelector = config.models.media_review.split(":")[0];
	const model = resolveModelFromString(config.models.media_review, available);
	if (!model || `${model.provider}/${model.id}` !== bareSelector) {
		fail(`media review model '${config.models.media_review}' is unavailable; rerun /setup-pstack`);
	}
	if (!registry.hasConfiguredAuth(model)) {
		fail(`no credentials for media review model '${config.models.media_review}'`);
	}

	const imageArtifacts = artifacts.filter((artifact) => artifact.mimeType.startsWith("image/"));
	const videoArtifacts = artifacts.filter((artifact) => artifact.mimeType.startsWith("video/"));
	if (imageArtifacts.length > MAX_REVIEW_IMAGES) fail(`media review received more than ${MAX_REVIEW_IMAGES} screenshots`);
	const frameBudget = MAX_REVIEW_IMAGES + MAX_REVIEW_FRAMES - imageArtifacts.length;
	const framesPerVideo = videoArtifacts.length === 0 ? 0 : Math.floor(frameBudget / videoArtifacts.length);
	if (videoArtifacts.length > 0 && framesPerVideo < 1) fail("media review cannot attach at least one decoded frame per recording");

	const images: ImageContent[] = [];
	let workspaceImageId: string | undefined;
	for (const artifact of artifacts) {
		if (artifact.mimeType.startsWith("image/")) {
			images.push({ type: "image", data: Buffer.from(artifact.data).toString("base64"), mimeType: artifact.mimeType });
			manifest.push({ kind: "screenshot", source: artifact.path, sha256: artifact.sha256, imageIndex: images.length - 1 });
			reviewedHashes.add(artifact.sha256);
		} else if (artifact.mimeType.startsWith("video/")) {
			// Immutable-image trust root: re-resolve the configured reference
			// immediately before decoding and refuse any substitution. Only the
			// admitted id ever runs the decoder container.
			workspaceImageId ??= await resolveImageId(config.runtime.workspace_image, signal);
			if (workspaceImageId !== input.imageId) {
				fail(
					`workspace image '${config.runtime.workspace_image}' resolved to ${workspaceImageId}, but this run is admitted for immutable image ${input.imageId}; ` +
						"the reference was retagged or repulled since admission, so media review refuses to decode evidence with substituted bytes",
				);
			}
			const frames = await decodeVideoFrames(workspaceImageId, artifact.data, { maxFrames: framesPerVideo, signal, runId: input.runId });
			if (frames.length === 0) fail(`media review could not decode required recording ${artifact.path}`);
			for (const frame of frames) {
				images.push({ type: "image", data: Buffer.from(frame.data).toString("base64"), mimeType: "image/png" });
				manifest.push({
					kind: "video-frame", source: artifact.path, sourceSha256: frame.sourceSha256,
					frameIndex: frame.index, ptsMs: frame.timestampMs, imageIndex: images.length - 1,
				});
			}
			reviewedHashes.add(artifact.sha256);
		} else {
			fail(`media review received unsupported artifact type ${artifact.mimeType}`);
		}
	}
	if (images.length === 0 || !artifacts.every((artifact) => reviewedHashes.has(artifact.sha256))) fail("media review did not inspect every required artifact");

	// Neutral temp cwd: no project discovery, no profile rules, no ambient
	// instructions leak into the supposedly evidence-only reviewer.
	if (signal?.aborted) fail("shutdown; media review aborted before the reviewer session was created");
	const reviewCwd = await mkdtemp(join(tmpdir(), "benny-media-review-"));
	const settings = Settings.isolated({ "memory.backend": "off", "autolearn.enabled": false });
	let session:
		| {
				prompt(text: string, options: { images: ImageContent[] }): Promise<unknown>;
				waitForIdle(): Promise<unknown>;
				messages: unknown[];
				dispose(): Promise<unknown>;
			}
		| undefined;
	let onAbort: (() => void) | undefined;
	try {
		const sessionManager = SessionManager.create(reviewCwd, join(reviewCwd, "sessions"));
		const created = await createAgentSession({
			cwd: reviewCwd,
			authStorage,
			modelRegistry: registry,
			model,
			settings,
			sessionManager,
			deadline,
			toolNames: [],
			restrictToolNames: true,
			disableExtensionDiscovery: true,
			enableLsp: false,
			enableIrc: false,
			hasUI: false,
			skills: [],
			contextFiles: [],
			rules: [],
			systemPrompt: [
				"You are an independent media reviewer. You have no tools and no credentials.",
				"You judge only what is visibly present in the attached evidence images.",
				"An ordered manifest maps each attached image to its source artifact hash, frame index, and presentation timestamp.",
				"You know nothing about Slack, trackers, repositories, or run internals; never speculate about them.",
				"Answer the review question and nothing else.",
			].join(" "),
			agentRegistry: new AgentRegistry(),
		});
		session = created.session;
		// Post-creation abort check: a signal that fired during creation is
		// honored before any prompt reaches the model.
		if (signal?.aborted) fail("shutdown; media review aborted while the reviewer session was created");
		// Listener-driven disposal: a run-shutdown signal tears the reviewer
		// session down immediately, including mid-prompt.
		onAbort = () => {
			void session?.dispose().catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const reviewPrompt = [
			"Evidence manifest (ordered; imageIndex refers to the attached images in order):",
			JSON.stringify(manifest, null, 2),
			"",
			"Question:",
			prompt,
			"",
			'Respond with ONLY a JSON object: {"confirmed": boolean, "evidence": string[]}.',
			"Each evidence entry must structurally cite at least one attached imageIndex (literally 'imageIndex <n>') and name what you actually saw there.",
			"Every attached imageIndex from 0 to " + (manifest.length - 1) + " must be cited at least once across your evidence entries.",
		].join("\n");
		let verdict: { confirmed: boolean; evidence: string[] } | null = null;
		for (let attempt = 0; attempt < 2 && !verdict && Date.now() + 30_000 < deadline; attempt++) {
			if (signal?.aborted) fail("shutdown; media review aborted before a reviewer prompt");
			const text = attempt === 0 ? reviewPrompt : `${reviewPrompt}\n\nYour previous reply was not valid JSON. Respond with ONLY the JSON object.`;
			await session.prompt(text, { images });
			await session.waitForIdle();
			if (signal?.aborted) fail("shutdown; media review aborted during a reviewer prompt");
			const messages: unknown[] = [...session.messages];
			let lastAssistant: { content?: unknown } | null = null;
			for (let index = messages.length - 1; index >= 0; index--) {
				const message: unknown = messages[index];
				if (plainObject(message) && message.role === "assistant") {
					lastAssistant = message;
					break;
				}
			}
			const content = lastAssistant?.content;
			const text2 = Array.isArray(content)
				? content.map(block => (plainObject(block) && block.type === "text" && typeof block.text === "string") ? block.text : "").join("\n")
				: "";
			verdict = parseMediaVerdict(text2, images.length);
		}
		if (!verdict) fail("media reviewer did not return a valid structured verdict");
		return { ...verdict, reviewedHashes: [...reviewedHashes] };
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// All-settled cleanup: disposal settles first; the evidence-bearing
		// review cwd is removed only after disposal settles, so no temp
		// directory outlives the session. A disposal failure never masks the
		// verdict or the abort.
		await Promise.allSettled(session ? [session.dispose()] : []);
		await rm(reviewCwd, { recursive: true, force: true }).catch(() => undefined);
	}
}
