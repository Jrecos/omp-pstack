/**
 * Integration regressions for the Benny coordinator: SQLite store admission
 * dedupe and the shared checkout lease, the private enabled-state gate with
 * its canary/hash/revision binding, pack setup destination preservation, and
 * Socket Mode framing against a local fake Slack. Real temp files, real
 * SQLite, real HTTP/WebSocket — no fs/db/network mocks, no model calls.
 */
import { test, expect } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	actionId,
	admitBennyEvent,
	assertBennyEnabled,
	BennyJournal,
	bennyConfigHash,
	bennyRepoRevision,
	canaryEligible,
	checkBenny,
	claimBennyRun,
	loadBennyConfig,
	parkBennyRun,
	openBennyStore,
	continuationState,
	gitCommittedFileBytes,
	gitIsolationEnv,
	controlChecks,
	readBennyState,
	reconcileBennyRuns,
	runBenny,
	recordBennyStage,
	settleBennyRun,
	setBennyEnabled,
	setupBenny,
	startBennySocket,
	writeBennyState,
	type BennyBinding,
	type BennyRunRow,
	type SelectedEvent,
	type SetupResult,
} from "../src/benny.ts";
import { assertBennyEndpointPolicy } from "../src/benny.ts";
import { createBennyWorkspace, resolveImageId, WorkspaceBlockError } from "../src/benny-workspace.ts";
import { createProofRepo, proofConfig } from "../scripts/fixtures/benny-workspace/proof.ts";
import { BennyError, freshOperationsReplies, gitBounded, persistedRunResult, recordCanary, existingFixCredentialScript, retainPublishSnapshot, resumeDraft, freshTerminalResult, trialMediaViolation } from "../src/benny-run.ts";
import { MAX_SOCKET_FRAME_BYTES, oversizedFrame, type BennySocket } from "../src/benny-socket.ts";
import type { BennyRunResult, BennyOutcome } from "../src/benny-run.ts";
import { bennyExit } from "../src/cli.ts";
import { ActionFailure, type BennyConfig } from "../src/benny.ts";
import type { BennyActions } from "../src/benny-actions.ts";
import { admitRun, claimNextRun, finishRun, openRunStore, OS_BOOT_ID, processStartTicks, profileWorkspaceDir, stateDir } from "../src/runner.ts";
import type { RemoteReceipt, SlackMessage } from "../src/benny-policy.ts";

const TOKEN_ENVS = [
	"PSTACK_TEST_SLACK_READ_TOKEN",
	"PSTACK_TEST_SLACK_WRITE_TOKEN",
	"PSTACK_TEST_TRACKER_TOKEN",
	"PSTACK_TEST_APP_TOKEN",
	"PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES",
];

/** Exact coordinator binding used by admission/claim fixtures. */
function bind(configHash = "cfg-hash-0000", repoRevision = "rev-hash-0000", canary = false): BennyBinding {
	return { configHash, repoRevision, canary };
}

/** Minimal tracked operational-pack content for runtime-gate fixtures. */
function installMinimalPack(target: string): void {
	mkdirSync(join(target, ".omp", "automations", "benny"), { recursive: true });
	writeFileSync(join(target, ".omp", "automations", "benny", "README.md"), "# benny pack fixture\n");
}

interface FakeSlackSocket {
	send(data: string): void;
	close(): void;
}

interface FakeSlack {
	port: number;
	state: { openRequests: number; hellos: number; closes: number; acks: string[]; sockets: FakeSlackSocket[] };
	setFatal(): void;
	close(): void;
}

/** Snapshot every env key these tests touch so a failing assertion never leaks HOME/PATH/token changes. */
function saveEnv(): Array<readonly [string, string | undefined]> {
	return ["HOME", "PI_CODING_AGENT_DIR", "PI_PROFILE", "PATH", ...TOKEN_ENVS].map(
		(name) => [name, process.env[name]] as const,
	);
}

function restoreEnv(saved: Array<readonly [string, string | undefined]>): void {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/** Redirect OMP's profile writes into a temp home so setupBenny's plugin install cannot touch the user profile. */
function isolateOmpProfile(): { restore(): void } {
	const saved = saveEnv();
	const home = mkdtempSync(join(tmpdir(), "benny-omp-home-"));
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, "profile");
	process.env.PI_PROFILE = "";
	return {
		restore() {
			restoreEnv(saved);
			rmSync(home, { recursive: true, force: true });
		},
	};
}

function tempRoot(label: string): string {
	return mkdtempSync(join(tmpdir(), `benny-${label}-`));
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function commitAll(cwd: string, message: string): void {
	git(cwd, "add", "-A");
	git(cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", message);
}

/** Hermetic stand-in for the authenticated model registry: exactly the four fixture selectors (minus `omit`). */
function fakeRegistry(omit: Array<"triage" | "reproduce" | "code" | "media"> = []): ModelRegistry {
	const available = (["triage", "reproduce", "code", "media"] as const)
		.filter((role) => !omit.includes(role))
		.map((role) => ({ provider: "pstack", id: `test-${role}` }));
	return {
		getAvailable: () => available as unknown as Model[],
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}
/** Full canary evidence satisfying canaryEligible: fresh execution plus both phases' exact readback receipts. */
function canaryObservedJson(): string {
	return JSON.stringify({
		freshlyExecuted: true,
		results: [
			{ phase: "triage", status: "succeeded", duplicate: false, actions: [], canaryEvidence: ["slack.verdict.readback", "tracker.mutation.readback"] },
			{ phase: "reproduce", status: "succeeded", duplicate: false, actions: [], canaryEvidence: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"] },
		],
	});
}

/** Socket startup admits only an enabled state bound to the exact config hash and repo revision of a committed target. */
async function enableSocketFixture(target: string, configPath: string): Promise<void> {
	// The drift gate requires every behavior-bearing path (including the
	// operational pack) to be exactly tracked, so the fixture commits the
	// configured maps and a minimal pack file.
	writeFileSync(join(target, ".omp", "benny", "feature-map.md"), "### login form\nsteps here\n");
	writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
	writeFileSync(join(target, ".gitignore"), ".omp/pstack/\n");
	installMinimalPack(target);
	git(target, "init", "-b", "main");
	commitAll(target, "init");
	const config = await loadBennyConfig(configPath);
	const imageId = await resolveImageId(config.runtime.workspace_image);
	writeBennyState(target, { enabled: true, configHash: bennyConfigHash(config), repoRevision: bennyRepoRevision(target), imageId });
}

function report(eventId: string, ts = "100.001"): SelectedEvent {
	return {
		eventId,
		source: { teamId: "T_TEAM", channel: "C_SOURCE", rootTs: ts },
		root: { ts, channel: "C_SOURCE", user: "U_REPORTER", text: "upload crashes on save" },
	};
}

/** Recursive directory walk; the name carries the shape better than an inline closure. */
function countFiles(root: string): number {
	let count = 0;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) count += countFiles(join(root, entry.name));
		else count += 1;
	}
	return count;
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitFor(ready: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(25);
	}
}

type RunStateRow = { status: string; diagnostic: string | null; owner_pid: number | null };
type CountRow = { c: number };

/**
 * Minimal but strict-schema-valid Benny config; parses through
 * parseBennyConfigYaml (placeholders and secrets refused).
 */
function writeBennyConfig(target: string, options: { socketUrl?: string } = {}): string {
	const dir = join(target, ".omp", "benny");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "configuration.yaml");
	const runtime = [
		"runtime:",
		`  trigger: ${options.socketUrl ? "socket-mode" : "external"}`,
		...(options.socketUrl ? [`  slack_api_url: "${options.socketUrl}"`] : []),
		"  slack_app_token_env: PSTACK_TEST_APP_TOKEN",
		"  slack_read_token_env: PSTACK_TEST_SLACK_READ_TOKEN",
		"  slack_write_token_env: PSTACK_TEST_SLACK_WRITE_TOKEN",
		"  tracker_token_env: PSTACK_TEST_TRACKER_TOKEN",
		"  workspace_image: omp-pstack/benny-workspace:0",
		'  control_command: ["bun", "/opt/benny-control/control.mjs"]',
		'  control_config: { worker_command: ["sh", "-c", "true"], app_url: "http://benny-worker:8791/" }',
		"  environment: {}",
		"  allowed_endpoints: []",
	].join("\n");
	writeFileSync(
		path,
		`schema_version: 1
automations:
  triage_name: triage-benny-test
  reproduce_name: reproduce-benny-test
slack:
  source_channel_id: C_SOURCE
  operations_channel_id: C_OPERATIONS
  triage_identity_user_id: U_TRIAGE
  read_action: benny-test-read
  thread_post_action: benny-test-thread-post
  file_download_action: benny-test-file-download
  operations_edit_action: benny-test-operations-edit
  prefer_configured_actions: false
  optional_bot_token_env: PSTACK_TEST_BOT_TOKEN
  allow_source_root_posts: false
  allow_worker_slack_writes: false
repository:
  url: "https://git.internal.local/test/repo.git"
  default_branch: main
  pull_request_action: benny-test-draft-pr
  pull_request_url_format: "https://git.internal.local/test/repo/pull/{id}"
  draft_only: true
tracker:
  type: linear
  team: TEST
  project: PSTACK
  labels:
    bug: bug
    performance: performance
    intake: intake
    needs_repro: needs-repro
  status: backlog
  source_link_title: source thread
  require_compensation_action: true
routing:
  map_path: .omp/benny/routing.md
  owner_pings_default: false
  allow_feature_owner_ping: false
  allow_confirmed_regression_author_ping: false
control:
  skill_name: benny-test-control
  feature_map_path: .omp/benny/feature-map.md
  environment: staging
  artifact_directory: ".omp/pstack/state/benny-evidence"
  artifact_retention_hours: 24
verdict_markers:
  bug: "[benny:bug]"
  performance: "[benny:performance]"
  other: "[benny:other]"
  tracker_attribute: benny-tracker
status_emoji:
  seen: eyes
  reproducing: gears
  reproduced: white_check_mark
  could_not_reproduce: shrug
  blocked: warning
  fixing: hammer
  fix_failed: x
  pull_request_opened: rocket
budgets:
  poll_seconds: 45
  verdict_wait_minutes: 45
  triage_follow_up_minutes: 10
  triage_total_minutes: 30
  repro_minutes: 60
  rejection_window_minutes: 10
  fix_minutes: 90
  operations_follow_up_minutes: 45
models:
  triage: pstack/test-triage
  reproduce: pstack/test-reproduce
  code: pstack/test-code
  media_review: pstack/test-media
${runtime}
`,
	);
	return path;
}

/** Local Slack Socket Mode stand-in: apps.connections.open plus a WebSocket endpoint. */
function startFakeSlack(): FakeSlack {
	const state = { openRequests: 0, hellos: 0, closes: 0, acks: [] as string[], sockets: [] as FakeSlackSocket[] };
	let fatal = false;
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/api/apps.connections.open") {
				state.openRequests += 1;
				if (fatal) return Response.json({ ok: false, error: "invalid_auth" });
				return Response.json({ ok: true, url: `ws://127.0.0.1:${srv.port}/ws` });
			}
			if (url.pathname === "/ws") {
				srv.upgrade(req);
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				state.hellos += 1;
				state.sockets.push(ws);
				ws.send(JSON.stringify({ type: "hello" }));
			},
			message(_ws, data) {
				const parsed = JSON.parse(String(data)) as { envelope_id?: string };
				if (parsed.envelope_id) state.acks.push(parsed.envelope_id);
			},
			close() {
				state.closes += 1;
			},
		},
	});
	return {
		port: server.port!,
		state,
		setFatal: () => {
			fatal = true;
		},
		close: () => server.stop(true),
	};
}

test("canary admission requires both phases before reading configuration", async () => {
	await expect(runBenny("missing.yaml", {}, { canary: true, phase: "triage" })).rejects.toMatchObject({
		exitCode: 64,
		message: "a Benny canary must run both triage and reproduce phases",
	});
});

test("benny store: phase admission, cross-id dedupe, shared checkout lease, parked checkpoint, dead-owner reconciliation", async () => {
	const root = tempRoot("store");
	const db = openRunStore(root);
	try {
		openBennyStore(db);

		// One queued row per phase for the same report.
		const first = admitBennyEvent(db, report("Ev1"), ["triage", "reproduce"], Date.now() + 60_000, bind());
		expect(first.duplicate).toBe(false);
		expect(first.rows.map((entry) => entry.run.phase).sort()).toEqual(["reproduce", "triage"]);

		// Identical envelope replay dedupes both phases onto the same rows.
		const replay = admitBennyEvent(db, report("Ev1"), ["triage", "reproduce"], Date.now() + 60_000, bind());
		expect(replay.duplicate).toBe(true);
		expect(replay.rows.map((entry) => entry.run.id)).toEqual(first.rows.map((entry) => entry.run.id));

		// Alternate Slack delivery id with identical (team, channel, root, phase) dedupes too.
		const alternate = admitBennyEvent(db, report("Ev1-alt"), ["triage", "reproduce"], Date.now() + 60_000, bind());
		expect(alternate.duplicate).toBe(true);
		const admittedCount = db.query("SELECT COUNT(*) AS c FROM benny_runs").get() as CountRow;
		expect(admittedCount.c).toBe(2);

		// Global checkout lease: one running run of any kind blocks every claim.
		const triageRow = first.rows.find((entry) => entry.run.phase === "triage")!.run;
		const triageClaim = claimBennyRun(db, bind());
		expect(triageClaim?.id).toBe(triageRow.id);
		expect(claimBennyRun(db, bind())).toBeNull();
		const routine = admitRun(db, "worker", { event_id: "r1", body: { n: 1 } }, "prompt", "model", 60_000);
		expect(claimNextRun(db)).toBeNull();

		// Parking releases the checkout but keeps stage, state, and wake time.
		const checkpoint = JSON.stringify({ plan: ["open-form", "submit"] });
		parkBennyRun(db, triageClaim!, "marker-wait-verdict", Date.now() + 250, Date.now() + 5_000, checkpoint);
		const reproduceRow = first.rows.find((entry) => entry.run.phase === "reproduce")!.run;
		const reproduceClaimToPark = claimBennyRun(db, bind());
		expect(reproduceClaimToPark?.id).toBe(reproduceRow.id);
		parkBennyRun(db, reproduceClaimToPark!, "marker-wait-poll", Date.now() + 250, Date.now() + 5_000);
		const routineClaim = claimNextRun(db);
		expect(routineClaim?.id).toBe(routine.runId);
		finishRun(db, routineClaim!.id, "succeeded");

		// The store's wake time uses Date.now(); the 250ms not-before is not injectable — real settle window.
		expect(claimBennyRun(db, bind())).toBeNull();
		await Bun.sleep(300);

		// FIFO reclaim preserves the safe checkpoint exactly.
		const resumed = claimBennyRun(db, bind());
		expect(resumed?.id).toBe(triageRow.id);
		expect(resumed?.stage).toBe("marker-wait-verdict");
		expect(resumed?.state).toBe(checkpoint);
		settleBennyRun(db, resumed!, "succeeded", "delivered", ["thread-post"]);
		const reproduceClaim = claimBennyRun(db, bind());
		expect(reproduceClaim?.id).toBe(reproduceRow.id);
		settleBennyRun(db, reproduceClaim!, "succeeded");

		// Dead-owner reconciliation: interrupt a real process, hand it the rows.
		const sleeper = Bun.spawn(["sleep", "30"]);
		const deadPid = sleeper.pid;
		sleeper.kill(9);
		await sleeper.exited;

		const abandon = (event: SelectedEvent, stage: string, ownerPid: number, boot: string): BennyRunRow => {
			admitBennyEvent(db, event, ["triage"], Date.now() + 60_000, bind());
			const claimed = claimBennyRun(db, bind());
			if (!claimed) {
				const active = db.query("SELECT id, kind, status, owner_pid, owner_boot FROM runs WHERE status = 'running'").all();
				throw new Error(`could not claim abandoned Benny row; active checkout: ${JSON.stringify(active)}`);
			}
			db.run("UPDATE benny_runs SET stage = ?, owner_pid = ?, owner_boot = ? WHERE id = ?", [stage, ownerPid, boot, claimed.id]);
			db.run("UPDATE runs SET owner_pid = ?, owner_boot = ? WHERE id = ?", [ownerPid, boot, claimed.run_id]);
			return claimed;
		};

		// An unresolved write intent is a durable pre-dispatch continuation:
		// the dead-owner run REQUEUES for reconcile-only replay instead of
		// blocking, with the exact ambiguity carried in the diagnostic.
		const ambiguous = abandon(report("Ev2", "200.002"), "triage-tracker", deadPid, "dead-boot");
		new BennyJournal(db, ambiguous.id).begin("act-1", "thread-post", { text: "verdict" });
		new BennyJournal(db, ambiguous.id).uncertain("act-1", "no receipt after dispatch timeout");
		expect(reconcileBennyRuns(db)).toEqual([ambiguous.id]);
		const requeuedRow = db.query("SELECT status, diagnostic, owner_pid FROM benny_runs WHERE id = ?").get(ambiguous.id) as RunStateRow;
		expect(requeuedRow.status).toBe("queued");
		expect(requeuedRow.owner_pid).toBeNull();
		expect(requeuedRow.diagnostic).toContain("act-1");
		expect(requeuedRow.diagnostic).toContain("no receipt after dispatch timeout");
		expect(requeuedRow.diagnostic).toContain("reconcile-only replay");
		settleBennyRun(db, ambiguous, "interrupted", "test cleanup after reconcile-only assertion");

		// Ambiguous stage without uncertain writes is interrupted, never rerun.
		const interrupted = abandon(report("Ev3", "300.003"), "triage-tracker", deadPid, "dead-boot");
		expect(reconcileBennyRuns(db)).toEqual([interrupted.id]);
		const interruptedRow = db.query("SELECT status, diagnostic FROM benny_runs WHERE id = ?").get(interrupted.id) as RunStateRow;
		expect(interruptedRow.status).toBe("interrupted");
		expect(interruptedRow.diagnostic).toContain("reconcile the action journal");

		// Safe checkpoints (admitted / marker-wait*) requeue with no owner.
		const safeAdmitted = abandon(report("Ev4", "400.004"), "admitted", deadPid, "dead-boot");
		expect(reconcileBennyRuns(db)).toEqual([safeAdmitted.id]);
		const admittedRow = db.query("SELECT status, owner_pid FROM benny_runs WHERE id = ?").get(safeAdmitted.id) as RunStateRow;
		expect(admittedRow.status).toBe("queued");
		expect(admittedRow.owner_pid).toBeNull();
		settleBennyRun(db, safeAdmitted, "succeeded");
		const safeWait = abandon(report("Ev5", "500.005"), "marker-wait-verdict", deadPid, "dead-boot");
		expect(reconcileBennyRuns(db)).toEqual([safeWait.id]);
		const safeWaitRow = db.query("SELECT status, owner_pid FROM benny_runs WHERE id = ?").get(safeWait.id) as RunStateRow;
		expect(safeWaitRow.status).toBe("queued");
		expect(safeWaitRow.owner_pid).toBeNull();
		settleBennyRun(db, safeWait, "succeeded");

		// A live foreign owner's run is left alone when its recorded incarnation
		// verifies; a reused pid (same pid, wrong start ticks) must release the
		// lease instead of stalling recovery forever.
		const liveProc = Bun.spawn(["sleep", "30"]);
		try {
			const liveTicks = OS_BOOT_ID === null ? null : processStartTicks(liveProc.pid);
			if (liveTicks !== null) {
				// Plant running rows directly: no claim, so a still-held checkout
				// by the live owner cannot block the second plant.
				const plant = (event: SelectedEvent, ownerPid: number, boot: string): BennyRunRow => {
					admitBennyEvent(db, event, ["triage"], Date.now() + 60_000, bind());
					const row = db.query("SELECT * FROM benny_runs WHERE event_id = ?").get(event.eventId) as BennyRunRow;
					db.run("UPDATE benny_runs SET status = 'running', stage = 'triage-tracker', owner_pid = ?, owner_boot = ? WHERE id = ?", [ownerPid, boot, row.id]);
					db.run("UPDATE runs SET status = 'running', owner_pid = ?, owner_boot = ? WHERE id = ?", [ownerPid, boot, row.run_id]);
					return { ...row, status: "running", owner_pid: ownerPid, owner_boot: boot };
				};
				const live = plant(report("Ev6", "600.006"), liveProc.pid, `${OS_BOOT_ID}:${liveTicks}`);
				expect(reconcileBennyRuns(db)).toEqual([]);
				const reused = plant(report("Ev7", "700.007"), liveProc.pid, `${OS_BOOT_ID}:${Number(BigInt(liveTicks) + 1n)}`);
				expect(reconcileBennyRuns(db)).toEqual([reused.id]);
				expect((db.query("SELECT status FROM benny_runs WHERE id = ?").get(reused.id) as RunStateRow).status).toBe("interrupted");
				// A live foreign owner is never cancelled by another process's settle.
				expect(() => settleBennyRun(db, live, "succeeded")).toThrow(/live foreign owner/);
				expect((db.query("SELECT status FROM benny_runs WHERE id = ?").get(live.id) as RunStateRow).status).toBe("running");
			} else {
				// Portable fallback: pid liveness only.
				const live = abandon(report("Ev6", "600.006"), "triage-tracker", liveProc.pid, "other-boot");
				expect(reconcileBennyRuns(db)).toEqual([]);
			}
		} finally {
			liveProc.kill();
		}
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("benny enabled gate: default-disabled 0600 state, canary bound to exact config hash and repo revision", async () => {
	const saved = saveEnv();
	const shimDir = mkdtempSync(join(tmpdir(), "benny-shim-"));
	const root = tempRoot("enable");
	try {
		const target = join(root, "repo");
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		mkdirSync(join(target, ".omp", "plugins"), { recursive: true });
		writeFileSync(join(target, ".gitignore"), ".omp/pstack/\n");
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		writeFileSync(join(target, ".omp", "benny", "feature-map.md"), "### login form\nsteps here\n");
		writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
		writeFileSync(join(target, ".omp", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {} }));
		writeFileSync(join(target, ".omp", "plugins", "omp-plugins.lock.json"), JSON.stringify({}));
		writeFileSync(join(target, "tracker-adapter.ts"), 'export default { name: "test-adapter" };\n');
		writeFileSync(join(target, "control-adapter.mjs"), "export default {};\n");

		// Copy the real pack with OMP writes isolated from the user profile.
		const isolation = isolateOmpProfile();
		try {
			await setupBenny(target);
		} finally {
			isolation.restore();
		}
		commitAll(target, "init");

		// Fake `docker` gate: preflight needs an inspectable workspace image
		// that resolves to an immutable sha256 id (preflight binds the id, not
		// the mutable reference).
		const docker = join(shimDir, "docker");
		writeFileSync(docker, '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then printf \'sha256:%064d\\n\' 0; exit 0; fi\nexit 0\n');
		chmodSync(docker, 0o755);
		process.env.PATH = `${shimDir}:${process.env.PATH}`;
		for (const name of TOKEN_ENVS) process.env[name] = "pstack-test-token-1";

		// Default-disabled: no state file exists before any enable.
		expect(readBennyState(target)).toBeUndefined();

		// A failing preflight blocks enable before the canary is even consulted.
		const trackerToken = process.env.PSTACK_TEST_TRACKER_TOKEN;
		delete process.env.PSTACK_TEST_TRACKER_TOKEN;
		await expect(setBennyEnabled(configPath, true, { registry: fakeRegistry() })).rejects.toThrow(/preflight failed/);
		if (trackerToken !== undefined) process.env.PSTACK_TEST_TRACKER_TOKEN = trackerToken;

		// No passing canary: refusal with exit code 2.
		let caught: unknown;
		try {
			await setBennyEnabled(configPath, true, { registry: fakeRegistry() });
		} catch (error) {
			caught = error;
		}
		const refusal = caught as BennyError;
		expect(caught).toBeInstanceOf(BennyError);
		expect(refusal.exitCode).toBe(2);
		expect(refusal.message).toMatch(/no passing canary/);

		// Record a passing canary through the public store for the exact hash+revision.
		const config = await loadBennyConfig(configPath);
		const hash = bennyConfigHash(config);
		const revision = bennyRepoRevision(target);
		const db = openRunStore(target);
		openBennyStore(db);
		const imageId = await resolveImageId(config.runtime.workspace_image);
		db.run(
			"INSERT INTO benny_canary (event_id, config_hash, repo_revision, passed, observed, at, image_id) VALUES (?, ?, ?, 1, ?, ?, ?)",
			["Ev-canary", hash, revision, canaryObservedJson(), Date.now(), imageId],
		);
		db.close();

		const state = await setBennyEnabled(configPath, true, { registry: fakeRegistry() });
		expect(state.enabled).toBe(true);
		expect(state.configHash).toBe(hash);
		expect(state.repoRevision).toBe(revision);
		// Enable state is profile-private (workspace-namespaced): a repo-local
		// path would let committed or planted repo content carry enable authority.
		const statePath = join(profileWorkspaceDir(target, "benny-state"), "benny-state.json");
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(statePath)).mode & 0o777).toBe(0o700);
		expect(existsSync(join(target, ".omp", "pstack", "state", "benny-state.json"))).toBe(false);

		// A repo revision bump invalidates the canary.
		await setBennyEnabled(configPath, false);
		git(target, "commit", "--allow-empty", "-m", "bump");
		await expect(setBennyEnabled(configPath, true, { registry: fakeRegistry() })).rejects.toThrow(/no passing canary/);
		git(target, "reset", "--hard", "HEAD^");

		// A passed=1 flag with empty evidence is not trust: eligibility demands
		// fresh execution and both phases' exact readback receipts.
		const db2 = openRunStore(target);
		openBennyStore(db2);
		db2.run("DELETE FROM benny_canary");
		db2.run(
			"INSERT INTO benny_canary (event_id, config_hash, repo_revision, passed, observed, at) VALUES ('Ev-empty', ?, ?, 1, '{}', ?)",
			[hash, bennyRepoRevision(target), Date.now()],
		);
		db2.close();
		const empty = canaryEligible(target, config);
		expect(empty.eligible).toBe(false);
		expect(empty.reason).toContain("not freshly executed");
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("poll_seconds: 45", "poll_seconds: 46"));
		commitAll(target, "retighten poll");
		await expect(setBennyEnabled(configPath, true, { registry: fakeRegistry() })).rejects.toThrow(/no passing canary/);
	} finally {
		restoreEnv(saved);
		rmSync(shimDir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 120_000 });


test("benny disable is unconditional: flips enabled state before any config load, Docker resolution or preflight", async () => {
	const root = tempRoot("disable");
	const isolation = isolateOmpProfile();
	try {
		const target = join(root, "repo");
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		git(target, "init", "-b", "main");
		// The config file does not even exist: disable must not parse anything.
		const missing = join(target, ".omp", "benny", "configuration.yaml");
		expect(existsSync(missing)).toBe(false);

		writeBennyState(target, { enabled: true, configHash: "h", repoRevision: "r", enabledAt: Date.now() });
		expect(readBennyState(target)?.enabled).toBe(true);

		const off = await setBennyEnabled(missing, false);
		expect(off.enabled).toBe(false);
		expect(off.configHash).toBeUndefined();
		expect(readBennyState(target)?.enabled).toBe(false);
	} finally {
		isolation.restore();
		rmSync(root, { recursive: true, force: true });
	}
});


test("benny setup: preserves destination-only files, reports differing managed files, never enables", async () => {
	const saved = saveEnv();
	const root = tempRoot("setup");
	try {
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		git(target, "init", "-b", "main");
		const dest = join(target, ".omp", "automations", "benny");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "README.md"), "# local destination override\n");
		writeFileSync(join(dest, "EXTRA-local-only.md"), "destination-only file\n");

		const isolation = isolateOmpProfile();
		let result: SetupResult;
		try {
			result = await setupBenny(target);
		} finally {
			isolation.restore();
		}

		const packCount = countFiles(join(import.meta.dir, "..", "automations", "benny"));
		expect(result.copied.length).toBe(packCount - 1);
		expect(result.copied).not.toContain("README.md");
		expect(result.copied).toContain("skills/setup-benny/SKILL.md");
		expect(result.conflicts).toEqual(["README.md"]);
		expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("# local destination override\n");
		expect(existsSync(join(dest, "EXTRA-local-only.md"))).toBe(true);
		expect(result.verification.find((check) => check.check === "pack files")?.ok).toBe(true);

		// Re-run: previously copied files are identical, the conflict persists.
		const again = await setupBenny(target);
		expect(again.copied).toEqual([]);
		expect(again.identical.length).toBe(packCount - 1);
		expect(again.conflicts).toEqual(["README.md"]);

		// Setup never flips the private enabled state.
		expect(readBennyState(target)).toBeUndefined();
	} finally {
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("checkBenny pack integrity and captured binding refuse symlinked pack entries, drifted bytes and a revision changed during gating", async () => {
	const saved = saveEnv();
	const root = tempRoot("packintegrity");
	try {
		const target = join(root, "repo");
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		writeFileSync(join(target, ".gitignore"), ".omp/pstack/\n");
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		writeFileSync(join(target, ".omp", "benny", "feature-map.md"), "### login form\nsteps here\n");
		writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
		const isolation = isolateOmpProfile();
		try {
			await setupBenny(target);
		} finally {
			isolation.restore();
		}
		commitAll(target, "init");
		const config = await loadBennyConfig(configPath);
		const captured = { configHash: bennyConfigHash(config), repoRevision: bennyRepoRevision(target) };
		const packFile = join(target, ".omp", "automations", "benny", "templates", "configuration.example.yaml");

		// Committed, regular, byte-identical pack passes for the captured pair.
		const clean = await checkBenny(configPath, { registry: fakeRegistry(), captured });
		const packCheck = clean.find((check) => check.check === "pack files");
		expect(packCheck?.ok).toBe(true);
		expect(packCheck?.detail).toContain(captured.repoRevision.slice(0, 12));
		expect(clean.find((check) => check.check === "captured binding")?.ok).toBe(true);

		// A symlinked required pack entry is refused: never a regular blob.
		const savedBytes = readFileSync(packFile);
		rmSync(packFile);
		symlinkSync(join(root, "outside-payload.md"), packFile);
		const linked = await checkBenny(configPath, { registry: fakeRegistry(), captured });
		const linkedCheck = linked.find((check) => check.check === "pack files");
		expect(linkedCheck?.ok).toBe(false);
		expect(linkedCheck?.detail).toContain("symlink");
		rmSync(packFile);
		writeFileSync(packFile, savedBytes);

		// Worktree bytes that differ from the captured revision's blob are
		// refused even before any commit records them.
		writeFileSync(packFile, `${savedBytes.toString("utf8")}# drifted\n`);
		const drifted = await checkBenny(configPath, { registry: fakeRegistry(), captured });
		const driftedCheck = drifted.find((check) => check.check === "pack files");
		expect(driftedCheck?.ok).toBe(false);
		expect(driftedCheck?.detail).toContain("worktree bytes differ");
		writeFileSync(packFile, savedBytes);

		// A repository revision changed after the gate captured its pair: the
		// captured binding fails, so enable can never gate on (or persist) a
		// pair the preflight and canary did not both exercise.
		git(target, "commit", "--allow-empty", "-m", "bump during gating");
		const stale = await checkBenny(configPath, { registry: fakeRegistry(), captured });
		const binding = stale.find((check) => check.check === "captured binding");
		expect(binding?.ok).toBe(false);
		expect(binding?.detail).toMatch(/changed since the enable gate captured/);
	} finally {
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 60_000 });

test("socket mode: hello readies, ignored events ack once with no durable row, policy rejection stays unacked, disconnect reconnects", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");
		expect(fake.state.hellos).toBe(1);
		expect(fake.state.openRequests).toBe(1);

		// Non-report events are intentionally ignored: replies, bots, other channels.
		const ignored = [
			{
				type: "event_callback",
				event_id: "Ev-ignore-1",
				team_id: "T_TEAM",
				event: { type: "message", channel: "C_SOURCE", ts: "200.002", thread_ts: "200.001", user: "U_HUMAN", text: "thread reply" },
			},
			{
				type: "event_callback",
				event_id: "Ev-ignore-2",
				team_id: "T_TEAM",
				event: { type: "message", channel: "C_SOURCE", ts: "201.001", user: "U_HUMAN", bot_id: "B_BOT", text: "bot noise" },
			},
			{
				type: "event_callback",
				event_id: "Ev-ignore-3",
				team_id: "T_TEAM",
				event: { type: "message", channel: "C_OTHER", ts: "202.001", user: "U_HUMAN", text: "wrong channel" },
			},
		];
		const ws = fake.state.sockets[0]!;
		ignored.forEach((payload, index) => {
			ws.send(JSON.stringify({ type: "events_api", envelope_id: `env-${index + 1}`, payload }));
		});
		await waitFor(() => fake.state.acks.length >= 3, 5_000, "envelope acks");
		// Settle window to prove exactly-once; there is no signal for "no more acks will arrive".
		await Bun.sleep(300);
		expect(fake.state.acks.slice().sort()).toEqual(["env-1", "env-2", "env-3"]);
		const ackCounts: Record<string, number> = {};
		for (const envelopeId of fake.state.acks) ackCounts[envelopeId] = (ackCounts[envelopeId] ?? 0) + 1;
		expect(Object.values(ackCounts)).toEqual([1, 1, 1]);

		// Deliberate policy rejection (disabled mid-flight) stays unacked:
		// nothing was durably admitted, so Slack must redeliver after
		// re-enabling rather than consider the event delivered.
		writeBennyState(target, { enabled: false });
		const reportEnvelope = {
			type: "event_callback",
			event_id: "Ev-report",
			team_id: "T_TEAM",
			event: { type: "message", channel: "C_SOURCE", ts: "210.001", user: "U_HUMAN", text: "real report shape" },
		};
		ws.send(JSON.stringify({ type: "events_api", envelope_id: "env-reject", payload: reportEnvelope }));
		// No signal exists for "will never be acked"; settle window instead.
		await Bun.sleep(500);
		expect(fake.state.acks).not.toContain("env-reject");

		// …and neither ignored events nor the rejection created any durable admission row.
		const db = openRunStore(target);
		openBennyStore(db);
		const bennyCount = db.query("SELECT COUNT(*) AS c FROM benny_runs").get() as CountRow;
		expect(bennyCount.c).toBe(0);
		const runCount = db.query("SELECT COUNT(*) AS c FROM runs").get() as CountRow;
		expect(runCount.c).toBe(0);
		db.close();

		// Server-side disconnect: bounded reconnect requests a fresh URL and hello.
		ws.close();
		await waitFor(
			() => fake.state.sockets.length >= 2 && fake.state.openRequests >= 2 && fake.state.hellos >= 2,
			8_000,
			"reconnect after disconnect",
		);
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("ignored Socket events ack with unavailable image and disabled state; a real report stays unacked", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-ignored");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");

		// After hello, make every operational prerequisite unavailable:
		// background admission disabled AND the workspace image gone. The
		// per-event runBenny reloads the config, so both gates would reject a
		// real report — but ignored events must never depend on either.
		writeBennyState(target, { enabled: false });
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("omp-pstack/benny-workspace:0", "omp-pstack/benny-image-missing:0"));

		// Bot, thread reply, edit subtype, wrong channel: all filtered events.
		const ignored = [
			{ type: "event_callback", event_id: "Ev-ign-1", team_id: "T_TEAM", event: { type: "message", channel: "C_SOURCE", ts: "300.002", thread_ts: "300.001", user: "U_HUMAN", text: "thread reply" } },
			{ type: "event_callback", event_id: "Ev-ign-2", team_id: "T_TEAM", event: { type: "message", channel: "C_SOURCE", ts: "301.001", user: "U_HUMAN", bot_id: "B_BOT", text: "bot noise" } },
			{ type: "event_callback", event_id: "Ev-ign-3", team_id: "T_TEAM", event: { type: "message", channel: "C_SOURCE", ts: "302.001", user: "U_HUMAN", subtype: "message_changed", text: "an edit" } },
			{ type: "event_callback", event_id: "Ev-ign-4", team_id: "T_TEAM", event: { type: "message", channel: "C_OTHER", ts: "303.001", user: "U_HUMAN", text: "wrong channel" } },
		];
		const ws = fake.state.sockets[0]!;
		ignored.forEach((payload, index) => {
			ws.send(JSON.stringify({ type: "events_api", envelope_id: `env-ign-${index + 1}`, payload }));
		});
		// Each ignored event settles harmlessly acked exactly once: the ack is
		// durable truth (Slack never redelivers an acked envelope) reached with
		// zero operational prerequisites.
		await waitFor(() => fake.state.acks.length >= 4, 5_000, "ignored envelope acks");
		await Bun.sleep(300);
		expect(fake.state.acks.slice().sort()).toEqual(["env-ign-1", "env-ign-2", "env-ign-3", "env-ign-4"]);

		// A real report under the same unavailable prerequisites is a policy
		// rejection, not an ack: nothing was durably admitted.
		ws.send(JSON.stringify({
			type: "events_api",
			envelope_id: "env-report",
			payload: { type: "event_callback", event_id: "Ev-report", team_id: "T_TEAM", event: { type: "message", channel: "C_SOURCE", ts: "310.001", user: "U_HUMAN", text: "real report shape" } },
		}));
		await Bun.sleep(500);
		expect(fake.state.acks).not.toContain("env-report");

		// And no durable admission row of any kind exists.
		const db = openRunStore(target);
		openBennyStore(db);
		expect((db.query("SELECT COUNT(*) AS c FROM benny_runs").get() as CountRow).c).toBe(0);
		expect((db.query("SELECT COUNT(*) AS c FROM runs").get() as CountRow).c).toBe(0);
		db.close();
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("socket mode: pre-admission infrastructure failure keeps the envelope unacked", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-infra");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");

		// Corrupt the config after hello so the per-event runBenny load fails with a
		// non-BennyError infrastructure fault. Unacked so Slack redelivers later.
		writeFileSync(configPath, "::::not valid yaml::::");
		const reportEnvelope = {
			type: "event_callback",
			event_id: "Ev-infra",
			team_id: "T_TEAM",
			event: { type: "message", channel: "C_SOURCE", ts: "220.001", user: "U_HUMAN", text: "report during outage" },
		};
		fake.state.sockets[0]!.send(JSON.stringify({ type: "events_api", envelope_id: "env-infra", payload: reportEnvelope }));
		// No signal exists for "will never be acked"; settle window instead.
		await Bun.sleep(800);
		expect(fake.state.acks).toEqual([]);
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("socket mode: fatal invalid_auth rejects ready and never reconnects", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-fatal");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		fake.setFatal();
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		let caught: unknown;
		try {
			await within(socket.ready, 5_000, "ready");
		} catch (error) {
			caught = error;
		}
		const refusal = caught as BennyError;
		expect(caught).toBeInstanceOf(BennyError);
		expect(refusal.exitCode).toBe(2);
		expect(refusal.message).toContain("invalid_auth");

		// Past the first reconnect delay: still exactly one attempt, no hammering.
		await Bun.sleep(1_500);
		expect(fake.state.openRequests).toBe(1);
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("socket mode: malformed JSON frame does not crash the link", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-garbage");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");

		const ws = fake.state.sockets[0]!;
		ws.send("}{ not json at all");
		// A valid ignored event right after proves the link survived the garbage frame.
		ws.send(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-after-garbage",
				payload: {
					type: "event_callback",
					event_id: "Ev-after-garbage",
					team_id: "T_TEAM",
					event: { type: "message", channel: "C_SOURCE", ts: "230.002", thread_ts: "230.001", user: "U_HUMAN", text: "reply" },
				},
			}),
		);
		await waitFor(() => fake.state.acks.includes("env-after-garbage"), 5_000, "ack after malformed frame");
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("valid unsupported Socket frames ack immediately with no admission; malformed and policy-rejected frames stay unacked", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-unsupported");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");
		const ws = fake.state.sockets[0]!;

		// Valid frames of deliberately unsupported trigger types (a button
		// click, a slash command) are acknowledged at once — Slack must never
		// redeliver them — and admit no work.
		ws.send(JSON.stringify({ type: "interactive", envelope_id: "env-int", payload: { type: "block_actions", actions: [] } }));
		ws.send(JSON.stringify({ type: "slash_commands", envelope_id: "env-slash", payload: { command: "/pstack", text: "hi" } }));
		await waitFor(() => fake.state.acks.includes("env-int") && fake.state.acks.includes("env-slash"), 5_000, "unsupported envelope acks");

		// A frame that parses as JSON but violates the frame schema is malformed: never acked.
		ws.send(JSON.stringify({ envelope_id: "env-malformed" }));
		// A policy-rejected events_api report (enabled state flipped off mid-flight) stays unacked too.
		writeBennyState(target, { enabled: false });
		ws.send(JSON.stringify({
			type: "events_api",
			envelope_id: "env-policy",
			payload: { type: "event_callback", event_id: "Ev-policy", team_id: "T_TEAM", event: { type: "message", channel: "C_SOURCE", ts: "240.001", user: "U_HUMAN", text: "report shape" } },
		}));
		// Both are negative assertions: no deterministic signal exists for "no ack will
		// ever arrive", so a settle window is the only honest check (same as the
		// pre-existing rejection tests below).

		// Neither the acked unsupported frames nor the rejected frame admitted anything.
		const db = openRunStore(target);
		openBennyStore(db);
		expect((db.query("SELECT COUNT(*) AS c FROM benny_runs").get() as CountRow).c).toBe(0);
		db.close();

		// The link survived everything: a valid, filtered (ignored) events_api
		// event is still processed and acked, even under the disabled state.
		ws.send(JSON.stringify({
			type: "events_api",
			envelope_id: "env-ignored",
			payload: { type: "event_callback", event_id: "Ev-ignored", team_id: "T_TEAM", event: { type: "message", channel: "C_OTHER", ts: "241.001", user: "U_HUMAN", text: "wrong channel" } },
		}));
		await waitFor(() => fake.state.acks.includes("env-ignored"), 5_000, "ack after unsupported frames");
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("oversizedFrame binds the exact cap for strings, Blobs, ArrayBuffers and typed arrays", () => {
	const cap = MAX_SOCKET_FRAME_BYTES;
	// Exactly the cap is never over; one byte past it always is, for every
	// transport type the earliest check covers.
	expect(oversizedFrame("x".repeat(cap), cap)).toBe(false);
	expect(oversizedFrame("x".repeat(cap + 1), cap)).toBe(true);
	expect(oversizedFrame(new Blob([new Uint8Array(cap)]), cap)).toBe(false);
	expect(oversizedFrame(new Blob([new Uint8Array(cap + 1)]), cap)).toBe(true);
	expect(oversizedFrame(new ArrayBuffer(cap), cap)).toBe(false);
	expect(oversizedFrame(new ArrayBuffer(cap + 1), cap)).toBe(true);
	expect(oversizedFrame(new Uint8Array(cap), cap)).toBe(false);
	expect(oversizedFrame(new Uint8Array(cap + 1), cap)).toBe(true);
	// Non-frame data is not size-bounded here; the parse path owns it.
	expect(oversizedFrame(undefined, cap)).toBe(false);
	expect(oversizedFrame({ big: true }, cap)).toBe(false);
});

test("oversizedFrame binds string frames by UTF-8 byte length, not UTF-16 code units", () => {
	const cap = MAX_SOCKET_FRAME_BYTES;
	// "é" is one UTF-16 code unit but two UTF-8 bytes: a string whose .length
	// sits well under the cap can still exceed it on the wire.
	const exact = "é".repeat(cap / 2);
	expect(exact.length).toBe(cap / 2);
	expect(oversizedFrame(exact, cap)).toBe(false);
	const over = "é".repeat(cap / 2 + 1);
	expect(over.length).toBeLessThanOrEqual(cap);
	expect(oversizedFrame(over, cap)).toBe(true);
});

test("an oversized apps.connections.open body is refused, never becomes a session, and the loop retries", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-oversize-open");
	let oversized: { port: number; state: { openRequests: number }; close(): void } | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		// Chunked open response past the 1 MiB cap that never closes: only a
		// mid-body cap check can settle the acquisition; draining or awaiting
		// the end would hang forever.
		const server = Bun.serve({
			port: 0,
			fetch() {
				oversized!.state.openRequests += 1;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(MAX_SOCKET_FRAME_BYTES + 1).fill(0x7b));
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		oversized = { port: server.port!, state: { openRequests: 0 }, close: () => server.stop(true) };
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${oversized.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		let readySettled = false;
		socket.ready.then(() => (readySettled = true), () => (readySettled = true));
		// Two attempts fit inside the first reconnect delay: refused (t=0),
		// retried (t≈1s). Readiness never settles: an oversized acquisition is
		// a transient fault, never a session.
		await Bun.sleep(2_500);
		expect(readySettled).toBe(false);
		expect(oversized.state.openRequests).toBeGreaterThanOrEqual(2);
	} finally {
		await socket?.close();
		oversized?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 15_000 });

test("an oversized live Socket frame closes the link and reconnects with a fresh URL", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-oversize-frame");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");
		expect(fake.state.hellos).toBe(1);

		// One byte past the fixed frame cap: the link is closed before any
		// conversion or JSON parse, and the reconnect loop takes a fresh URL.
		fake.state.sockets[0]!.send("x".repeat(MAX_SOCKET_FRAME_BYTES + 1));
		await waitFor(
			() => fake.state.sockets.length >= 2 && fake.state.hellos >= 2 && fake.state.openRequests >= 2,
			8_000,
			"reconnect after an oversized frame",
		);
		expect(fake.state.closes).toBeGreaterThanOrEqual(1);
		// The surviving link still works: a fresh ignored thread-reply event
		// acks exactly once without admitting anything.
		fake.state.sockets[fake.state.sockets.length - 1]!.send(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-after-oversize",
				payload: {
					type: "event_callback",
					event_id: "Ev-after-oversize",
					team_id: "T_TEAM",
					event: { type: "message", channel: "C_SOURCE", ts: "240.001", thread_ts: "240.000", user: "U_HUMAN", text: "after oversize" },
				},
			}),
		);
		await waitFor(() => fake.state.acks.includes("env-after-oversize"), 5_000, "ack on the reconnected link");
	} finally {
		await socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("enabled admission validator rejects disabled, config-hash, revision and dirty-worktree drift", async () => {
	const saved = saveEnv();
	const root = tempRoot("validator");
	try {
		const target = join(root, "repo");
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		writeFileSync(join(target, ".gitignore"), ".omp/pstack/\n");
		const configPath = writeBennyConfig(target);
		writeFileSync(join(target, ".omp", "benny", "feature-map.md"), "### login form\nsteps here\n");
		writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
		installMinimalPack(target); // the drift gate binds the whole operational pack
		git(target, "init", "-b", "main");
		commitAll(target, "init");
		const config = await loadBennyConfig(configPath);

		// Missing or disabled private state refuses admission with exit code 2.
		expect(() => assertBennyEnabled(target, config)).toThrow(BennyError);
		writeBennyState(target, { enabled: false });
		expect(() => assertBennyEnabled(target, config)).toThrow(/not enabled/);

		// A clean, exactly-bound state passes.
		writeBennyState(target, { enabled: true, configHash: bennyConfigHash(config), repoRevision: bennyRepoRevision(target) });
		expect(assertBennyEnabled(target, config).enabled).toBe(true);

		// Config-hash drift: current config bytes no longer match the enabled binding.
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("poll_seconds: 45", "poll_seconds: 46"));
		const drifted = await loadBennyConfig(configPath);
		let caught: unknown;
		try {
			assertBennyEnabled(target, drifted);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(BennyError);
		expect((caught as BennyError).exitCode).toBe(2);
		expect((caught as BennyError).message).toMatch(/current configuration hashes/);
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("poll_seconds: 46", "poll_seconds: 45"));

		// Revision drift: HEAD moved after enable. A harmless tracked file
		// makes the bump a real commit; resetting restores the bound revision.
		const boundRevision = bennyRepoRevision(target);
		writeFileSync(join(target, "NOTES.md"), "harmless\n");
		commitAll(target, "bump");
		expect(() => assertBennyEnabled(target, config)).toThrow(/HEAD is now/);
		git(target, "reset", "--hard", "HEAD^");
		expect(bennyRepoRevision(target)).toBe(boundRevision);
		writeFileSync(join(target, ".omp", "benny", "feature-map.md"), `${readFileSync(join(target, ".omp", "benny", "feature-map.md"), "utf8")}### extra feature\nmore steps\n`);
		expect(() => assertBennyEnabled(target, config)).toThrow(/clean tracked worktree/);

		// Socket startup rejects non-socket configs through the same API, before any network I/O.
		await expect(startBennySocket(configPath)).rejects.toMatchObject({
			exitCode: 2,
			message: expect.stringContaining("Socket Mode requires 'socket-mode'"),
		});
	} finally {
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("journal begin distinguishes fresh intent; recovery blocks on any non-done row and requeues safe checkpoints", async () => {
	const root = tempRoot("journal");
	const db = openRunStore(root);
	try {
		openBennyStore(db);
		const journal = new BennyJournal(db, 999);
		expect(journal.begin("act-1", "thread-post", { text: "v" })).toEqual({ state: "new" });
		// A pre-existing open row is a durable intent with unknown outcome:
		// reconcile-only, never a blind re-dispatch.
		expect(journal.begin("act-1", "thread-post", { text: "v" })).toEqual({ state: "uncertain" });
		journal.uncertain("act-1", "no receipt");
		expect(journal.begin("act-1", "thread-post", { text: "v" })).toEqual({ state: "uncertain" });
		journal.complete("act-1", { id: "remote-1", verified: true, observed: {} } as RemoteReceipt);
		const replay = journal.begin("act-1", "thread-post", { text: "v" });
		expect(replay.state).toBe("done");
		expect(replay.receipt).toMatchObject({ id: "remote-1", verified: true });

		const sleeper = Bun.spawn(["sleep", "30"]);
		const deadPid = sleeper.pid;
		sleeper.kill(9);
		await sleeper.exited;
		let abandonSeq = 0;
		const abandon = (eventId: string, stage: string): BennyRunRow => {
			// Distinct root timestamps: the (team,channel,root,phase) UNIQUE index
			// must not fold these into one admission.
			admitBennyEvent(db, report(eventId, `${(abandonSeq += 1) * 10}.001`), ["triage"], Date.now() + 60_000, bind());
			const claimed = claimBennyRun(db, bind());
			if (!claimed) {
				const active = db.query("SELECT id, status, owner_pid FROM runs WHERE status = 'running'").all();
				throw new Error(`could not claim abandoned row ${eventId}; active checkout: ${JSON.stringify(active)}`);
			}
			db.run("UPDATE benny_runs SET stage = ?, owner_pid = ?, owner_boot = ? WHERE id = ?", [stage, deadPid, "dead-boot", claimed.id]);
			db.run("UPDATE runs SET owner_pid = ?, owner_boot = ? WHERE id = ?", [deadPid, "dead-boot", claimed.run_id]);
			return claimed;
		};
		const status = (id: number): RunStateRow =>
			db.query("SELECT status, diagnostic, owner_pid FROM benny_runs WHERE id = ?").get(id) as RunStateRow;

		// An open (not just uncertain) journal row is a durable pre-dispatch
		// continuation even at a safe stage: the run requeues for
		// reconcile-only replay, never blocks and never blindly reruns.
		const withOpenIntent = abandon("EvJ1", "followup");
		new BennyJournal(db, withOpenIntent.id).begin("act-open", "tracker-create", { title: "x" });
		expect(reconcileBennyRuns(db)).toEqual([withOpenIntent.id]);
		expect(status(withOpenIntent.id).status).toBe("queued");
		expect(status(withOpenIntent.id).owner_pid).toBeNull();
		expect(status(withOpenIntent.id).diagnostic).toContain("act-open");
		expect(status(withOpenIntent.id).diagnostic).toContain("reconcile-only replay");

		// Triage followup with a clean journal is an explicitly safe requeue.
		const followup = abandon("EvJ2", "followup");
		expect(reconcileBennyRuns(db)).toEqual([followup.id]);
		expect(status(followup.id).status).toBe("queued");
		expect(status(followup.id).owner_pid).toBeNull();

		// rejection-wait, operations-followup and marker-wait* requeue too.
		for (const [eventId, stage] of [["EvJ3", "rejection-wait"], ["EvJ4", "operations-followup"], ["EvJ5", "marker-wait-poll"]] as const) {
			const row = abandon(eventId, stage);
			expect(reconcileBennyRuns(db)).toEqual([row.id]);
			expect(status(row.id).status).toBe("queued");
			expect(status(row.id).owner_pid).toBeNull();
		}
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("checkBenny model preflight fails closed on unavailable or unauthenticated selectors", async () => {
	const saved = saveEnv();
	const root = tempRoot("models");
	const isolation = isolateOmpProfile();
	try {
		const target = join(root, "repo");
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		writeFileSync(join(target, ".omp", "benny", "feature-map.md"), "### login form\nsteps here\n");
		writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
		commitAll(target, "init");

		// Real registry against a hermetic empty profile: the fixture
		// pstack/* selectors resolve to no available model at all.
		const checks = await within(checkBenny(configPath), 30_000, "preflight");
		const modelCheck = checks.find((check) => check.check === "model selectors");
		expect(modelCheck?.ok).toBe(false);
		expect(modelCheck?.detail).toContain("triage");
		expect(modelCheck?.detail).toContain("unavailable");

		// An injected authenticated registry with every role passes.
		const passing = await checkBenny(configPath, { registry: fakeRegistry() });
		expect(passing.find((check) => check.check === "model selectors")?.ok).toBe(true);

		// A registry missing one role fails with that exact role named.
		const missing = await checkBenny(configPath, { registry: fakeRegistry(["media"]) });
		const missingCheck = missing.find((check) => check.check === "model selectors");
		expect(missingCheck?.ok).toBe(false);
		expect(missingCheck?.detail).toContain("media_review");
		expect(missingCheck?.detail).toContain("unavailable");
	} finally {
		isolation.restore();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 60_000 });

test("binding identity: legacy migration, exact-claim filter, fail-closed conflicts", () => {
	const root = tempRoot("binding");
	const db = openRunStore(root);
	try {
		// Pre-binding schema: openBennyStore must migrate it, backfilling ''
		// — an identity that is never claimable and never re-admittable.
		db.run(`CREATE TABLE benny_runs (
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
		db.run(
			`INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, stage, canary, deadline_ms, created_at, updated_at)
			 VALUES (0, 'T_TEAM', 'Ev-legacy', 'triage', 'C_SOURCE', '900.001', 'queued', 'admitted', 0, 0, 0, 0)`,
		);
		openBennyStore(db);
		const names = (db.query("PRAGMA table_info(benny_runs)").all() as Array<{ name: string }>).map((column) => column.name);
		expect(names).toContain("config_hash");
		expect(names).toContain("repo_revision");
		const legacy = db.query("SELECT config_hash, repo_revision FROM benny_runs").get() as { config_hash: string; repo_revision: string };
		expect(legacy.config_hash).toBe("");
		expect(legacy.repo_revision).toBe("");

		// Null identity: never claimable, and a real binding conflicts fail-closed.
		expect(claimBennyRun(db, bind())).toBeNull();
		expect(() => admitBennyEvent(db, report("Ev-legacy"), ["triage"], Date.now() + 60_000, bind())).toThrow(/binding .* differs/);

		// Fresh admits persist the exact binding; only the exact binding claims.
		const first = admitBennyEvent(db, report("EvB1", "910.001"), ["triage", "reproduce"], Date.now() + 60_000, bind("cfg-a", "rev-a"));
		expect(first.rows.every((row) => row.run.config_hash === "cfg-a" && row.run.repo_revision === "rev-a")).toBe(true);
		expect(claimBennyRun(db, bind("cfg-b", "rev-a"))).toBeNull();
		expect(claimBennyRun(db, bind("cfg-a", "rev-a", true))).toBeNull();
		const claimed = claimBennyRun(db, bind("cfg-a", "rev-a"));
		expect(claimed?.phase).toBe("triage");

		// Replay under a different config hash, revision, or canary flag fails
		// closed on BOTH dedupe keys — never an unclaimable duplicate row the
		// driver would loop on.
		expect(() => admitBennyEvent(db, report("EvB1", "910.001"), ["triage"], Date.now() + 60_000, bind("cfg-b", "rev-a"))).toThrow(/binding .* differs/);
		expect(() => admitBennyEvent(db, report("EvB1-alt", "910.001"), ["triage"], Date.now() + 60_000, bind("cfg-b", "rev-a"))).toThrow(/binding .* differs/);
		expect(() => admitBennyEvent(db, report("EvB1", "910.001"), ["triage"], Date.now() + 60_000, bind("cfg-a", "rev-a", true))).toThrow(/binding .* differs/);
		// Same binding replay still dedupes onto the same row.
		const replay = admitBennyEvent(db, report("EvB1", "910.001"), ["reproduce"], Date.now() + 60_000, bind("cfg-a", "rev-a"));
		expect(replay.duplicate).toBe(true);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("park releases the checkout atomically: both rows agree and the checkout is free", () => {
	const root = tempRoot("park");
	const db = openRunStore(root);
	try {
		openBennyStore(db);
		admitBennyEvent(db, report("EvP1", "920.001"), ["triage"], Date.now() + 60_000, bind());
		const claimed = claimBennyRun(db, bind());
		expect(claimed).not.toBeNull();
		parkBennyRun(db, claimed!, "marker-wait-verdict", Date.now() + 60_000, Date.now() + 120_000, '{"p":1}');
		const row = db.query("SELECT status, stage, state, not_before_ms, wait_until_ms FROM benny_runs WHERE id = ?").get(claimed!.id) as {
			status: string;
			stage: string;
			state: string | null;
			not_before_ms: number;
			wait_until_ms: number | null;
		};
		const checkout = db.query("SELECT status FROM runs WHERE id = ?").get(claimed!.run_id) as { status: string };
		// One committed transaction: the benny row is queued with its exact
		// wake checkpoint at the same observable moment the checkout shows
		// queued — no intermediate state is visible.
		expect(row.status).toBe("queued");
		expect(row.stage).toBe("marker-wait-verdict");
		expect(JSON.parse(row.state ?? "null")).toEqual({ p: 1 });
		expect(row.wait_until_ms).toBeGreaterThan(0);
		expect(checkout.status).toBe("queued");
		// The checkout is genuinely free: a routine worker claims while benny waits.
		const routine = admitRun(db, "worker", { event_id: "rp1", body: {} }, "prompt", "model", 60_000);
		expect(claimNextRun(db)?.id).toBe(routine.runId);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("endpoint policy guard: official origins pass, loopback needs opt-in, foreign hosts refuse", async () => {
	const saved = saveEnv();
	const root = tempRoot("endpoints");
	try {
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		const config = await loadBennyConfig(configPath);
		// No overrides: official origins by default.
		expect(() => assertBennyEndpointPolicy(config)).not.toThrow();

		const looped = { ...config, runtime: { ...config.runtime, slack_api_url: "http://127.0.0.1:8081" } };
		delete process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES;
		expect(() => assertBennyEndpointPolicy(looped)).toThrow(/PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES/);
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		expect(() => assertBennyEndpointPolicy(looped)).not.toThrow();
		expect(() =>
			assertBennyEndpointPolicy({ ...looped, runtime: { ...looped.runtime, slack_api_url: "https://slack.com" } }),
		).not.toThrow();
		// A foreign host is refused even with the fixture opt-in set.
		expect(() =>
			assertBennyEndpointPolicy({ ...looped, runtime: { ...looped.runtime, slack_api_url: "https://slack.evil.example" } }),
		).toThrow(/official origin/);
		expect(() => assertBennyEndpointPolicy({ ...looped, runtime: { ...looped.runtime, slack_api_url: "::::" } })).toThrow(/not a valid URL/);
	} finally {
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("artifact root is fixed: config literal enforced and workspace refuses other paths", async () => {
	const root = tempRoot("artifact-root");
	const { cwd, revision } = await createProofRepo();
	try {
		git(root, "init", "-b", "main");
		const configPath = writeBennyConfig(root);
		await loadBennyConfig(configPath); // the pinned literal parses
		for (const evil of ["/tmp/evil-artifacts", "../evil", ".omp/other-evidence"]) {
			const evilPath = join(root, `evil-${evil.replace(/[^a-z0-9]+/gi, "-")}.yaml`);
			writeFileSync(evilPath, readFileSync(configPath, "utf8").replace('artifact_directory: ".omp/pstack/state/benny-evidence"', `artifact_directory: "${evil}"`));
			await expect(loadBennyConfig(evilPath)).rejects.toThrow(/artifact_directory/);
		}
		// Workspace level: even a caller that bypassed parsing cannot point
		// evidence elsewhere; the refusal happens before any docker call.
		await expect(
			createBennyWorkspace({
				config: proofConfig("fixture-image"),
				cwd,
				runId: `evil-${Date.now()}`,
				revision,
				artifactDir: "/tmp/evil-artifacts",
				deadline: Date.now() + 60_000,
			}),
		).rejects.toThrow(WorkspaceBlockError);
		await expect(
			createBennyWorkspace({
				config: proofConfig("fixture-image"),
				cwd,
				runId: `evil2-${Date.now()}`,
				revision,
				artifactDir: "/tmp/evil-artifacts",
				deadline: Date.now() + 60_000,
			}),
		).rejects.toThrow(/artifact storage is fixed to/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup refuses symlinked pack components and destination entries", async () => {
	const saved = saveEnv();
	const root = tempRoot("symlink");
	try {
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		git(target, "init", "-b", "main");
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "payload.txt"), "outside bytes\n");

		// Symlinked pack component: setup refuses instead of writing through it.
		mkdirSync(join(target, ".omp"), { recursive: true });
		symlinkSync(outside, join(target, ".omp", "automations"));
		await expect(setupBenny(target)).rejects.toThrow(/symlinked path component/);

		// Symlinked destination entry: conflict, never written through.
		rmSync(join(target, ".omp", "automations"));
		mkdirSync(join(target, ".omp", "automations", "benny"), { recursive: true });
		writeFileSync(join(outside, "readme.md"), "do not clobber\n");
		symlinkSync(join(outside, "readme.md"), join(target, ".omp", "automations", "benny", "README.md"));
		const isolation = isolateOmpProfile();
		let result: SetupResult;
		try {
			result = await setupBenny(target);
		} finally {
			isolation.restore();
		}
		expect(result.conflicts).toContain("README.md");
		expect(result.diagnostics.join("\n")).toMatch(/symlink/);
		expect(readFileSync(join(outside, "readme.md"), "utf8")).toBe("do not clobber\n");
	} finally {
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("external abort invokes the idempotent stop and admits nothing", async () => {
	const saved = saveEnv();
	const root = tempRoot("abort");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);
		const controller = new AbortController();
		socket = await startBennySocket(configPath, { signal: controller.signal });
		await within(socket.ready, 5_000, "hello");
		// The external abort path runs the same idempotent stop as close():
		// the transport closes instead of reconnecting.
		controller.abort();
		await waitFor(() => fake.state.closes >= 1, 5_000, "transport close after external abort");
		await socket.close();
		// Idempotent: a second close resolves cleanly.
		await socket.close();
		// No admission row exists or can be created after the abort.
		const db = openRunStore(target);
		openBennyStore(db);
		const count = db.query("SELECT COUNT(*) AS c FROM benny_runs").get() as CountRow;
		expect(count.c).toBe(0);
		db.close();
	} finally {
		socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("canary truth: only a fresh, receipt-complete, diagnostic-free run records a passing canary", () => {
	const root = tempRoot("canary-truth");
	try {
		const db = openRunStore(root);
		openBennyStore(db);
		const selected: SelectedEvent = { eventId: "Ev-canary", source: { teamId: "T", channel: "C", rootTs: "1.1" }, root: { ts: "1.1" } };
		const passing = [
			{ phase: "triage", status: "succeeded", duplicate: false, actions: [], canaryEvidence: ["slack.verdict.readback", "tracker.mutation.readback"] },
			{ phase: "reproduce", status: "succeeded", duplicate: false, actions: [], canaryEvidence: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"] },
		] as BennyRunResult[];
		const good = recordCanary(db, "hash", selected, passing, true, "a".repeat(40), "sha256:" + "1".repeat(64));
		expect(good).toEqual({ passed: true });
		const row = db.query("SELECT passed, repo_revision FROM benny_canary WHERE event_id = 'Ev-canary'").get() as { passed: number; repo_revision: string };
		expect(row.passed).toBe(1);
		// The recorded row binds the admitted revision, never end-of-run HEAD.
		expect(row.repo_revision).toBe("a".repeat(40));

		// A stale (non-fresh) canary never passes even with perfect results.
		const stale = recordCanary(db, "hash", selected, passing, false, "a".repeat(40), "sha256:" + "1".repeat(64));
		expect(stale.passed).toBe(false);
		expect(stale.reason).toContain("not all freshly executed");

		// Missing readback receipts name the failing phase.
		const noEvidence = recordCanary(db, "hash", selected, [{ ...passing[0]!, canaryEvidence: [] }, passing[1]!], true, "a".repeat(40), "sha256:" + "1".repeat(64));
		expect(noEvidence.passed).toBe(false);
		expect(noEvidence.reason).toContain("triage phase");

		// A diagnostic-carrying "succeeded" phase is not a canary pass.
		const diagnosed = recordCanary(db, "hash", selected, [{ ...passing[0]!, diagnostic: "could not reproduce" }, passing[1]!], true, "a".repeat(40), "sha256:" + "1".repeat(64));
		expect(diagnosed.passed).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("outcome assembly reloads persisted rows: an interrupted settle never reads as queued", () => {
	const root = tempRoot("persisted-result");
	try {
		const db = openRunStore(root);
		openBennyStore(db);
		const selected: SelectedEvent = { eventId: "Ev-reload", source: { teamId: "T", channel: "C", rootTs: "2.2" }, root: { ts: "2.2" } };
		const admission = admitBennyEvent(db, selected, ["triage"], Date.now() + 60_000, { configHash: "H", repoRevision: "R", canary: false });
		const run = admission.rows[0]!.run;
		// An external abort settles the row on disk after the in-memory snapshot was taken.
		settleBennyRun(db, run, "interrupted", "shutdown; run aborted before terminal settlement", ["step-1"]);
		// The stale snapshot still claims queued; the persisted reload must not.
		expect(run.status).toBe("queued");
		const rebuilt = persistedRunResult(db, run);
		expect(rebuilt.status).toBe("interrupted");
		expect(rebuilt.diagnostic).toContain("aborted");
		expect(rebuilt.actions).toEqual(["step-1"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary CLI exits nonzero for nonterminal queued/running results; terminal semantics unchanged", () => {
	// The shutdown-requeued shape runBenny produces when it releases an owned
	// row for recovery: an ordinary invocation must never report exit 0.
	const outcome = (status: BennyRunResult["status"], stage?: string): BennyOutcome => ({
		admitted: true,
		results: [{ phase: "triage", status, duplicate: false, stage, actions: [] }],
	});
	expect(bennyExit(outcome("queued", "followup"))).not.toBe(0);
	expect(bennyExit(outcome("running"))).not.toBe(0);
	// Terminal semantics are exactly what they were.
	expect(bennyExit(outcome("succeeded"))).toBe(0);
	expect(bennyExit(outcome("failed"))).toBe(1);
	expect(bennyExit(outcome("interrupted"))).toBe(1);
	expect(bennyExit(outcome("blocked"))).toBe(2);
	// A canary invocation keeps its stricter blocked-prerequisite exit for
	// nonterminal rows, and its receipt-gated success otherwise.
	expect(bennyExit(outcome("queued"), true)).toBe(2);
	expect(bennyExit(outcome("succeeded"), true)).toBe(1);
	expect(bennyExit({ admitted: true, results: outcome("succeeded").results, canary: { passed: true } }, true)).toBe(0);
});

test("operations follow-up processes only strictly later human replies", () => {
	const thread: SlackMessage[] = [
		{ ts: "100.000", thread_ts: "100.000", bot_id: "B1", user: "U_BOT", text: "Reproducing" },
		{ ts: "100.500", thread_ts: "100.000", user: "U_HUMAN", text: "stale chatter from before the draft existed" },
		{ ts: "200.000", thread_ts: "100.000", bot_id: "B1", user: "U_BOT", text: "Draft pull request opened: https://example.test/pr/1" },
		{ ts: "300.000", thread_ts: "100.000", user: "U_HUMAN", text: "does the draft handle X?" },
		{ ts: "300.500", thread_ts: "100.000", user: "U_TRIAGE", text: "triage identity note" },
	];
	const fresh = freshOperationsReplies(thread, "200.000000", "U_TRIAGE");
	expect(fresh.map((message) => message.ts)).toEqual(["300.000"]);
});

test("dead owner at a continuation stage requeues with a readable continuation; a mismatched one interrupts", async () => {
	const root = tempRoot("continuation");
	const db = openRunStore(root);
	try {
		openBennyStore(db);
		const sleeper = Bun.spawn(["sleep", "30"]);
		const deadPid = sleeper.pid;
		sleeper.kill(9);
		await sleeper.exited;
		let seq = 0;
		const plant = (stage: string, state: string | null, journal?: (row: BennyRunRow) => void): BennyRunRow => {
			const event = report(`EvK${(seq += 1)}`, `${seq * 10}.001`);
			admitBennyEvent(db, event, ["triage"], Date.now() + 60_000, bind());
			const row = db.query("SELECT * FROM benny_runs WHERE event_id = ?").get(event.eventId) as BennyRunRow;
			db.run("UPDATE benny_runs SET status = 'running', stage = ?, state = ?, owner_pid = ?, owner_boot = ? WHERE id = ?", [stage, state, deadPid, "dead-boot", row.id]);
			db.run("UPDATE runs SET status = 'running', owner_pid = ?, owner_boot = ? WHERE id = ?", [deadPid, "dead-boot", row.run_id]);
			journal?.(row);
			return row;
		};
		const status = (id: number): RunStateRow =>
			db.query("SELECT status, diagnostic, owner_pid FROM benny_runs WHERE id = ?").get(id) as RunStateRow;

		// Done create journal + readable create continuation: requeued to resume idempotently.
		const resumable = plant("create", continuationState("create", { decision: { category: "bug" }, trackerVerified: true, allowedUserIds: [] }), (row) => {
			const journal = new BennyJournal(db, row.id);
			const id = actionId(row.id, "tracker-create", 1);
			journal.begin(id, "tracker.create", {});
			journal.complete(id, { id: "ISS-1", verified: true, observed: {} } as RemoteReceipt);
		});
		expect(reconcileBennyRuns(db)).toEqual([resumable.id]);
		expect(status(resumable.id).status).toBe("queued");
		expect(status(resumable.id).owner_pid).toBeNull();
		settleBennyRun(db, resumable, "succeeded");

		// Done journal but a continuation whose stage does not match the row: interrupted.
		const mismatched = plant("create", continuationState("verdict", { decision: { category: "bug" }, trackerVerified: true, allowedUserIds: [] }), (row) => {
			const journal = new BennyJournal(db, row.id);
			const id = actionId(row.id, "tracker-create", 1);
			journal.begin(id, "tracker.create", {});
			journal.complete(id, { id: "ISS-2", verified: true, observed: {} } as RemoteReceipt);
		});
		expect(reconcileBennyRuns(db)).toEqual([mismatched.id]);
		expect(status(mismatched.id).status).toBe("interrupted");

		// Continuation stage with no journal row at all: the pre-dispatch
		// continuation is durable (stage + payload committed before the intent),
		// so the run requeues to dispatch the intent once — a crash between the
		// pre-persist and the action's journal.begin is a fresh, safe dispatch.
		const bare = plant("draft", continuationState("draft", { head: "benny/run-1-aaaaaaaaaaaa", tree: "a".repeat(40), base: "main", baseOid: "b".repeat(40), title: "t", body: "b", plan: {}, revision: "b".repeat(40) }));
		expect(reconcileBennyRuns(db)).toEqual([bare.id]);
		expect(status(bare.id).status).toBe("queued");
		expect(status(bare.id).owner_pid).toBeNull();
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
test("socket mode: resume runs on every hello; an untrusted queued row blocks after reconnect", async () => {
	const saved = saveEnv();
	const root = tempRoot("socket-resume");
	let slack: FakeSlack | undefined;
	let socket: BennySocket | undefined;
	try {
		process.env.PSTACK_TEST_APP_TOKEN = "pstack-test-app-token";
		process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
		const fake = startFakeSlack();
		slack = fake;
		const target = join(root, "repo");
		mkdirSync(target, { recursive: true });
		const configPath = writeBennyConfig(target, { socketUrl: `http://127.0.0.1:${fake.port}` });
		await enableSocketFixture(target, configPath);

		socket = await startBennySocket(configPath);
		await within(socket.ready, 5_000, "hello");
		expect(fake.state.hellos).toBe(1);

		// A queued row bound to a foreign (untrusted) binding: its admission
		// body carries no config snapshot, so resume must refuse it.
		const db = openRunStore(target);
		openBennyStore(db);
		admitBennyEvent(db, report("Ev-untrusted", "240.001"), ["triage"], Date.now() + 60_000, bind("cfg-foreign", "rev-foreign"));
		db.close();

		// Server-side disconnect: the reconnect hello reruns resume.
		fake.state.sockets[0]!.close();
		await waitFor(
			() => fake.state.sockets.length >= 2 && fake.state.hellos >= 2,
			8_000,
			"reconnect after disconnect",
		);
		const blocked = openRunStore(target);
		openBennyStore(blocked);
		try {
			await waitFor(() => {
				const row = blocked.query("SELECT status, diagnostic FROM benny_runs WHERE event_id = 'Ev-untrusted'").get() as RunStateRow | undefined;
				return row?.status === "blocked" && (row.diagnostic ?? "").includes("resume refuses this binding");
			}, 8_000, "untrusted row blocked by reconnect resume");
		} finally {
			blocked.close();
		}
	} finally {
		socket?.close();
		slack?.close();
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });

test("draft resume: abort before publishBranch journal.begin preserves the retained snapshot for the requeued run", async () => {
	const root = tempRoot("draft-abort");
	const db = openRunStore(root);
	const target = join(root, "target");
	mkdirSync(target, { recursive: true });
	// resumeDraft proves the run's workspace resources absent before any
	// non-aborted settlement; an empty-listing docker shim proves absence
	// deterministically (Bun.spawn resolves against its startup PATH, so the
	// interception replaces Bun.spawn itself).
	const shimDir = mkdtempSync(join(tmpdir(), "benny-resume-shim-"));
	const shim = join(shimDir, "docker");
	writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	chmodSync(shim, 0o755);
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv: string[], options?: Parameters<typeof Bun.spawn>[1]) =>
		realSpawn(typeof argv === "string" ? argv : argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv, options)) as typeof Bun.spawn;
	try {
		openBennyStore(db);
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		commitAll(target, "draft fixture");
		const config = await loadBennyConfig(configPath);
		const evidenceFor = (runId: number): Array<{ path: string; sha256: string }> => {
			const dir = join(target, ".omp", "pstack", "state", "benny-evidence", `run-${runId}`);
			mkdirSync(dir, { recursive: true });
			const bytes = Buffer.from(`baseline screenshot ${runId}\n`);
			const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
			writeFileSync(join(dir, sha), bytes);
			return [{ path: `run-${runId}/${sha}`, sha256: sha }];
		};
		const payloadFor = (runId: number, snapshot?: string) => ({
			head: `benny/run-${runId}-${"c".repeat(12)}`,
			tree: "d".repeat(64),
			base: "main",
			baseOid: "b".repeat(40),
			title: "t",
			body: "b",
			plan: { steps: [{ id: "s1" }] },
			revision: "rev-hash-0000",
			evidence: evidenceFor(runId),
			...(snapshot ? { sourceDir: snapshot } : {}),
		});
		const deps = (row: BennyRunRow, signal: AbortSignal | undefined, publish: (actionId: string, input: unknown) => Promise<unknown>) =>
			({
				db,
				config,
				target,
				run: db.query("SELECT * FROM benny_runs WHERE id = ?").get(row.id) as BennyRunRow,
				source: report("EvDraft", "900.001").source,
				root: { ts: "900.001", channel: "C_SOURCE", user: "U_REPORTER", text: "upload crashes on save" },
				signal,
				diagnostics: [],
				ops: { update: async () => undefined },
				actions: {
					publishBranch: publish,
					createDraft: async () => {
						throw new Error("createDraft must not run in this fixture");
					},
					readThread: async () => [],
				} as unknown as BennyActions,
				journal: new BennyJournal(db, row.id),
			}) as unknown as Parameters<typeof resumeDraft>[0];
		const parkDraft = (row: BennyRunRow, payload: unknown): void => {
			db.run("UPDATE benny_runs SET stage = 'draft', state = ? WHERE id = ?", [continuationState("draft", payload), row.id]);
		};
		const persist = (row: BennyRunRow): BennyRunRow => db.query("SELECT * FROM benny_runs WHERE id = ?").get(row.id) as BennyRunRow;

		// Act 1: the live dispatch is shut down between the persisted draft
		// continuation and publishBranch's journal.begin. The retained snapshot
		// is the requeued run's ONLY publication source and must survive.
		admitBennyEvent(db, report("EvDraft1", "900.001"), ["reproduce"], Date.now() + 3_600_000, bind());
		const row1 = persist(db.query("SELECT * FROM benny_runs WHERE event_id = ?").get("EvDraft1") as BennyRunRow);
		const workspace = mkdtempSync(join(tmpdir(), "benny-draft-ws-"));
		const snapshot1 = retainPublishSnapshot(target, row1.id, workspace);
		expect(existsSync(snapshot1)).toBe(true);
		parkDraft(row1, payloadFor(row1.id, snapshot1));
		const shutdown = new AbortController();
		shutdown.abort();
		const dispatches: Array<Record<string, unknown>> = [];
		await expect(
			resumeDraft(
				deps(
					row1,
					shutdown.signal,
					async (_actionId, input) => {
						dispatches.push(input as Record<string, unknown>);
						throw new Error("shutdown during publish dispatch");
					},
				),
			),
		).rejects.toThrow(/shutdown during publish dispatch/);
		const parked = persist(row1);
		expect(parked.stage).toBe("draft");
		expect((JSON.parse(parked.state!) as { data: { sourceDir: string } }).data.sourceDir).toBe(snapshot1);
		expect(new BennyJournal(db, row1.id).peek(actionId(row1.id, "publish-branch", 1))).toBeUndefined();
		expect(existsSync(snapshot1)).toBe(true);

		// Act 2: the requeued run (no abort) re-dispatches the REAL publication
		// from the retained snapshot; a non-aborted terminal outcome releases it.
		const outcome = await resumeDraft(
			deps(
				row1,
				undefined,
				async (_actionId, input) => {
					dispatches.push(input as Record<string, unknown>);
					throw new ActionFailure("uncertain", "fixture stop after re-dispatch");
				},
			),
		);
		expect(outcome).toMatchObject({ status: "blocked" });
		expect(dispatches.at(-1)?.sourceDir).toBe(snapshot1);
		expect(existsSync(snapshot1)).toBe(false);

		// Act 3: a done publish-branch journal receipt releases the snapshot even
		// under abort — past the verified branch write it has no resume role.
		admitBennyEvent(db, report("EvDraft2", "910.001"), ["reproduce"], Date.now() + 3_600_000, bind());
		const row2 = persist(db.query("SELECT * FROM benny_runs WHERE event_id = ?").get("EvDraft2") as BennyRunRow);
		const snapshot2 = retainPublishSnapshot(target, row2.id, workspace);
		parkDraft(row2, payloadFor(row2.id, snapshot2));
		const branchAction = actionId(row2.id, "publish-branch", 1);
		const journal2 = new BennyJournal(db, row2.id);
		journal2.begin(branchAction, "publish.branch", {});
		journal2.complete(branchAction, { id: "br-1", verified: true, observed: { oid: "e".repeat(40), tree: "f".repeat(64) } } as RemoteReceipt);
		let snapshotGoneAtDispatch: boolean | undefined;
		const shutdown2 = new AbortController();
		shutdown2.abort();
		await expect(
			resumeDraft(
				deps(
					row2,
					shutdown2.signal,
					async () => {
						snapshotGoneAtDispatch = !existsSync(snapshot2);
						return { id: "br-1", verified: true, observed: { oid: "e".repeat(40), tree: "f".repeat(64) } } as RemoteReceipt;
					},
				),
			),
		).rejects.toThrow();
		expect(snapshotGoneAtDispatch).toBe(true);
		expect(existsSync(snapshot2)).toBe(false);
	} finally {
		Bun.spawn = realSpawn;
		db.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(shimDir, { recursive: true, force: true });
	}
});

test("retainPublishSnapshot removes the staged tmp tree on copy failure and on abort", () => {
	const target = tempRoot("snapshot-fail");
	const workspace = mkdtempSync(join(tmpdir(), "benny-snapshot-src-"));
	try {
		writeFileSync(join(workspace, "fix.txt"), "fixed\n");
		// A mode-000 source file makes cpSync fail mid-copy: the partially
		// staged tree must never survive as a `.tmp-*` sibling.
		const unreadable = join(workspace, "secret.bin");
		writeFileSync(unreadable, "bytes\n");
		chmodSync(unreadable, 0o000);
		const parent = join(target, ".omp", "pstack", "state", "benny-publish-source");
		expect(() => retainPublishSnapshot(target, 1, workspace)).toThrow();
		expect(readdirSync(parent).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(existsSync(join(parent, "1"))).toBe(false);

		// A signal that is already aborted throws before any copy — the staged
		// directory is still created first, so the cleanup guarantee applies.
		expect(() => retainPublishSnapshot(target, 2, workspace, AbortSignal.abort())).toThrow(/aborted/);
		expect(readdirSync(parent).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(existsSync(join(parent, "2"))).toBe(false);

		// With the source readable again the same call succeeds and, on the
		// rename, leaves no `.tmp-*` behind (the previous snapshot contract).
		chmodSync(unreadable, 0o644);
		const snapshot = retainPublishSnapshot(target, 3, workspace);
		expect(readFileSync(join(snapshot, "fix.txt"), "utf8")).toBe("fixed\n");
		expect(readdirSync(parent).filter((name) => name.includes(".tmp-"))).toEqual([]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("installed package identity fails when the installed source Benny pack is tampered or missing a file", async () => {
	const target = tempRoot("identity");
	try {
		mkdirSync(join(target, ".omp", "benny"), { recursive: true });
		git(target, "init", "-b", "main");
		const configPath = writeBennyConfig(target);
		// A faithful full copy of this package plays the OMP plugin cache: the
		commitAll(target, "init");
		const packageRoot = realpathSync(join(import.meta.dir, ".."));
		const copy = join(target, "..", "cache", "omp-pstack");
		mkdirSync(dirname(copy), { recursive: true });
		cpSync(packageRoot, copy, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
		const link = join(target, ".omp", "plugins", "node_modules", "omp-pstack");
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(copy, link);
		const identity = async () =>
			(await checkBenny(configPath, { registry: fakeRegistry() })).find((check) => check.check === "installed package identity");
		// Refresh the copy right before the faithful assertion: a sibling
		// editing package sources between cpSync and the check must not read
		// as installed drift.
		cpSync(packageRoot, copy, { recursive: true, force: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
		expect((await identity())?.ok).toBe(true);

		// Tampered source-pack bytes in the installed package: refused.
		const packDoc = join(copy, "automations", "benny", "FOR_AGENTS.md");
		writeFileSync(packDoc, "tampered\n");
		const tampered = await identity();
		expect(tampered?.ok).toBe(false);
		expect(tampered?.detail).toContain("automations/benny/FOR_AGENTS.md");

		// A missing source-pack file in the installed package: refused.
		rmSync(packDoc);
		const missing = await identity();
		expect(missing?.ok).toBe(false);
		expect(missing?.detail).toContain("installed package lacks automations/benny/FOR_AGENTS.md");
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
}, { timeout: 60_000 });

test("existing-fix fetch credentials emit only for the exact HTTPS github.com credential request", () => {
	// The approved origin is shared across every supported remote spelling:
	// one normalized HTTPS GitHub URL, parsed once through the shared parser.
	const https = existingFixCredentialScript("https://github.com/org/repo.git");
	expect(existingFixCredentialScript("git@github.com:org/repo.git")).toBe(https);
	expect(existingFixCredentialScript("ssh://git@github.com/org/repo.git")).toBe(https);
	const request = (script: string, stdin: string): string => {
		const home = mkdtempSync(join(tmpdir(), "benny-cred-"));
		try {
			const helper = join(home, "git-credential.sh");
			writeFileSync(helper, script, { mode: 0o700 });
			const cfg = join(home, "gitconfig");
			const quoted = helper.replace(/'/g, "'\\''");
			writeFileSync(cfg, `[credential]\n\thelper = !/bin/sh '${quoted}'\n`);
			const proc = Bun.spawnSync(["git", "credential", "fill"], {
				stdin: Buffer.from(stdin),
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					GIT_CONFIG_GLOBAL: cfg,
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
					GH_TOKEN: "benny-test-token",
				},
			});
			return proc.stdout.toString();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	};
	const runHelperDirect = (script: string, stdin: string): string => {
		const dir = mkdtempSync(join(tmpdir(), "benny-cred2-"));
		try {
			const path = join(dir, "helper.sh");
			writeFileSync(path, script, { mode: 0o700 });
			return Bun.spawnSync(["sh", path], {
				stdin: Buffer.from(stdin),
				env: { PATH: process.env.PATH ?? "", GH_TOKEN: "benny-test-token" },
			}).stdout.toString();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	// The exact approved credential request receives the token.
	expect(request(https, "protocol=https\nhost=github.com\n\n")).toContain("password=benny-test-token");
	// Mismatched host, subdomain lookalike, or protocol: never a token.
	for (const hostile of ["protocol=https\nhost=github.com.evil.com\n\n", "protocol=http\nhost=github.com\n\n", "protocol=https\nhost=evil.example\n\n"]) {
		expect(request(https, hostile)).not.toContain("password=");
	}
	// A non-GitHub configured repository (the loopback fixture shape) gets a
	// helper with no approved origin: it emits nothing even when the request
	// names github.com; an http-only remote normalizes to the same no-origin
	// helper. Empty stdin is the no-op request path.
	const noOrigin = existingFixCredentialScript("https://git.internal.local/test/repo.git");
	expect(existingFixCredentialScript("http://github.com/org/repo.git")).toBe(noOrigin);
	expect(request(noOrigin, "protocol=https\nhost=github.com\n\n")).not.toContain("password=");
	expect(runHelperDirect(noOrigin, "")).toBe("");
	expect(runHelperDirect(https, "")).toBe("");
});

// ---------------------------------------------------------------------------
// Git binding regressions: hostile ambient controls, replacement refs,
// process-group teardown, tracked behavior-path symlinks
// ---------------------------------------------------------------------------

test("gitIsolationEnv drops hostile ambient GIT_* controls; committed reads stay bound", () => {
	const target = tempRoot("git-isolation");
	writeFileSync(join(target, "feature.txt"), "committed bytes\n");
	git(target, "init", "-b", "main");
	commitAll(target, "init");
	const revision = bennyRepoRevision(target);
	const hostile: Record<string, string> = {
		GIT_DIR: join(target, "nowhere"),
		GIT_WORK_TREE: "/nonexistent-hostile-worktree",
		GIT_INDEX_FILE: "/nonexistent-hostile-index",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.fsmonitor",
		GIT_CONFIG_VALUE_0: "/nonexistent-hostile-fsmonitor",
	};
	const saved: Array<readonly [string, string | undefined]> = Object.keys(hostile).map(
		(name) => [name, process.env[name]] as const,
	);
	try {
		for (const [name, value] of Object.entries(hostile)) process.env[name] = value;
		const env = gitIsolationEnv();
		for (const name of Object.keys(process.env)) {
			if (name.startsWith("GIT_")) expect(env[name]).toBeUndefined();
		}
		// Ordinary environment values the tooling needs are preserved.
		for (const name of ["PATH", "HOME", "LANG"]) {
			if (process.env[name] !== undefined) expect(env[name]).toBe(process.env[name]);
		}
		// An unscrubbed git would honor GIT_DIR/GIT_WORK_TREE/config injection;
		// the isolated readers must still bind the intended repository and
		// immutable revision.
		const bytes = gitCommittedFileBytes(target, revision, "feature.txt");
		expect(bytes.bytes?.toString("utf8")).toBe("committed bytes\n");
		expect(bennyRepoRevision(target)).toBe(revision);
	} finally {
		restoreEnv(saved);
		rmSync(target, { recursive: true, force: true });
	}
});

test("replacement refs cannot substitute committed bytes for the admitted revision", () => {
	const target = tempRoot("git-replace");
	writeFileSync(join(target, "behavior.txt"), "one\n");
	git(target, "init", "-b", "main");
	commitAll(target, "init");
	const admitted = bennyRepoRevision(target);
	writeFileSync(join(target, "behavior.txt"), "two\n");
	commitAll(target, "evil");
	const forged = bennyRepoRevision(target);
	git(target, "replace", admitted, forged);

	// Fixture teeth: an unscrubbed lookup really serves the replacement.
	const raw = Bun.spawnSync(["git", "-C", target, "cat-file", "-p", `${admitted}:behavior.txt`], { stdout: "pipe", stderr: "pipe" });
	expect(raw.stdout.toString()).toBe("two\n");

	// The committed reader refuses the substitution.
	const bytes = gitCommittedFileBytes(target, admitted, "behavior.txt");
	expect(bytes.bytes?.toString("utf8")).toBe("one\n");
	rmSync(target, { recursive: true, force: true });
});

test("gitBounded group-kills descendants on deadline; a late marker never appears", async () => {
	const root = tempRoot("git-group-kill");
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const marker = join(root, "late-marker");
	// Fake git: arms a descendant that touches the marker one second later,
	// then idles. A pid-only kill of the direct child would leave the
	// descendant alive; the process-group kill must not.
	writeFileSync(
		join(bin, "git"),
		'#!/bin/sh\nsh -c \'sleep 1; touch "$1"\' sh "$LATE_MARKER" &\necho armed\nsleep 30\n',
		{ mode: 0o755 },
	);
	try {
		const start = Date.now();
		const result = await gitBounded(["status"], {
			cwd: root,
			deadlineMs: start + 250,
			maxBytes: 64 * 1024,
			env: { PATH: `${bin}:${process.env.PATH ?? ""}`, LATE_MARKER: marker, HOME: root },
		});
		expect(Date.now() - start).toBeLessThan(5000);
		expect(result.code).not.toBe(0);
		// Real-clock wait by necessity: the descendant is a separate OS shell
		// process on the platform clock; fake timers cannot advance or observe
		// it, so the only proof of its death is time passing beyond its marker
		// timer.
		await Bun.sleep(1400); // past the descendant's one-second marker timer
		expect(existsSync(marker)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gitBounded kills an already-aborted composite at listener registration (no missed abort window)", async () => {
	const root = tempRoot("git-registration-race");
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	// Real git idles far past the test budget: the only way this call returns
	// promptly is the synchronous aborted-recheck killing the child, because
	// an already-aborted signal never delivers the "abort" event to a later
	// listener.
	writeFileSync(join(bin, "git"), "#!/bin/sh\necho armed\nsleep 30\n", { mode: 0o755 });
	const originalTimeout = AbortSignal.timeout;
	// Test seam: monkey-patch the global timeout factory so the composite is
	// constructed already aborted, exactly as when the deadline or shutdown
	// fires during spawn, before listener registration runs.
	const patchableSignal = AbortSignal as { timeout: typeof AbortSignal.timeout };
	patchableSignal.timeout = () => AbortSignal.abort("registration-race");
	try {
		const start = Date.now();
		const result = await gitBounded(["status"], {
			cwd: root,
			deadlineMs: start + 10_000,
			maxBytes: 64 * 1024,
			env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root },
		});
		expect(Date.now() - start).toBeLessThan(5000);
		expect(result.code).not.toBe(0);
	} finally {
		patchableSignal.timeout = originalTimeout;
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);

test("controlChecks refuses a clean tracked behavior-path symlink", async () => {
	const target = tempRoot("symlink-refusal");
	const outside = tempRoot("symlink-target");
	try {
		writeFileSync(join(outside, "feature-map.md"), "### login form\nsteps here\n");
		const configPath = writeBennyConfig(target);
		symlinkSync(join(outside, "feature-map.md"), join(target, ".omp", "benny", "feature-map.md"));
		writeFileSync(join(target, ".omp", "benny", "routing.md"), "# routing\n");
		git(target, "init", "-b", "main");
		commitAll(target, "init");

		const config = await loadBennyConfig(configPath);
		const revision = bennyRepoRevision(target);
		const checks = controlChecks(config, target, revision);
		const feature = checks.find((check) => check.check === "feature map");
		expect(feature?.ok).toBe(false);
		// The symlink (mode 120000) is refused without ever reading through it.
		expect(feature?.detail).toContain("not a regular tracked file");
		expect(feature?.detail).not.toContain("steps here");
		// A regular committed file at the same revision passes: the refusal is
		// specific to the symlink, not a general read failure.
		const routing = checks.find((check) => check.check === "routing map");
		expect(routing?.ok).toBe(true);
	} finally {
		rmSync(target, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

// --- Workspace/Outcome owner: run-outcome freshness + trial-media gate ----

test("terminal outcomes report the committed stage; canary evidence stays invocation-local", () => {
	const root = tempRoot("fresh-terminal");
	try {
		const db = openRunStore(root);
		openBennyStore(db);
		const selected: SelectedEvent = { eventId: "Ev-fresh", source: { teamId: "T", channel: "C", rootTs: "3.3" }, root: { ts: "3.3" } };
		const admission = admitBennyEvent(db, selected, ["reproduce"], Date.now() + 60_000, { configHash: "H", repoRevision: "R", canary: false });
		const run = admission.rows[0]!.run;
		// The coordinator commits stage transitions and settlement to SQLite
		// AFTER the claimed row snapshot was taken; the returned outcome must
		// carry the committed terminal stage, never the stale snapshot's
		// 'admitted' stage.
		expect(run.stage).toBe("admitted");
		recordBennyStage(db, run, "blast-radius");
		settleBennyRun(db, run, "succeeded", "verified", ["step-1"]);
		expect(run.stage).toBe("admitted"); // the snapshot is stale by construction
		const outcome = freshTerminalResult(db, run, "succeeded", "verified", ["step-1"], ["control.all-seven"]);
		expect(outcome.stage).toBe("blast-radius");
		expect(outcome.phase).toBe("reproduce");
		expect(outcome.status).toBe("succeeded");
		expect(outcome.duplicate).toBe(false);
		// Canary evidence is ephemeral: merged into the invocation result only.
		expect(outcome.canaryEvidence).toEqual(["control.all-seven"]);
		// The duplicate-path seam reads the same committed stage and carries no
		// invocation-local evidence.
		const duplicate = persistedRunResult(db, run);
		expect(duplicate.stage).toBe("blast-radius");
		expect(duplicate.duplicate).toBe(true);
		expect(duplicate.canaryEvidence).toBeUndefined();
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the trial media gate demands exactly one image from screenshot and one video from recording-stop", () => {
	const media = (mimeType: string) => ({ mimeType });
	expect(trialMediaViolation([media("image/png")], [media("video/webm")])).toBeNull();
	// Two images, two videos, a missing kind, and extra artifacts all violate.
	expect(trialMediaViolation([media("image/png"), media("image/png")], [media("video/webm")])).toMatch(/screenshot call/);
	expect(trialMediaViolation([media("image/png")], [media("video/webm"), media("video/webm")])).toMatch(/recording-stop/);
	expect(trialMediaViolation([media("image/png")], [])).toMatch(/recording-stop/);
	expect(trialMediaViolation([], [media("video/webm")])).toMatch(/screenshot call/);
	expect(trialMediaViolation([media("application/octet-stream")], [media("video/webm")])).toMatch(/screenshot call/);
});
