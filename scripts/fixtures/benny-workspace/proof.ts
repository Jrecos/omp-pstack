/**
 * Benny workspace proof driver.
 *
 * Real end-to-end proof on the actual split-container boundary:
 *   - rebuilds/uses the fixture image (Bun + Chromium + ffmpeg + trusted adapter),
 *   - creates a clean checkout of a real git repo with a demonstrable UI bug,
 *   - starts the app in the WORKER container, brings it up in the CONTROLLER's
 *     private Chromium, drives it with real CDP input events,
 *   - captures real screenshots and a real screencast recording, decodes them,
 *   - proves the broken state twice with independent resets (baseline),
 *   - applies the one-line fix in the fix stage, freezes the patched snapshot,
 *     restarts, proves the correct state twice (patched),
 *   - runs adversarial boundary probes that must all be denied: host
 *     auth/config, env/proc secrets (real random canary), docker socket,
 *     controller CDP reachability, root-owned adapter writes, path traversal,
 *     symlink artifact escape, malformed artifacts, stage gates.
 *
 * Run directly: `bun scripts/fixtures/benny-workspace/proof.ts`
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBennyWorkspace, CONTROL_CAPABILITIES, WorkspaceBlockError } from "../../../src/benny-workspace.ts";
import type { BennyConfig } from "../../../src/benny-policy.ts";

export const PROOF_IMAGE = process.env.BENNY_WORKSPACE_IMAGE ?? "omp-pstack/benny-workspace:0";
const APP_PORT = 8791;
const APP_URL = `http://benny-worker:${APP_PORT}/`;
const APP_MARKER = "benny-fixture-counter";

/** Always rebuilds from current source; a stale tag never masks fixture changes. */
export async function ensureImage(tag: string = PROOF_IMAGE): Promise<string> {
	const fixturesDir = new URL(".", import.meta.url).pathname;
	const build = await Bun.$`docker build -t ${tag} ${fixturesDir}`.quiet().nothrow();
	if (build.exitCode !== 0) {
		throw new WorkspaceBlockError(`fixture image '${tag}' build failed: ${build.stderr.toString().slice(0, 500)}`);
	}
	return tag;
}

const BUGGY_HTML = await readFile(new URL("./app/index.html", import.meta.url), "utf8");
const FIXED_HTML = BUGGY_HTML.replace("/* benny-fix */", "render();");
if (FIXED_HTML === BUGGY_HTML) throw new Error("fixture app is missing the /* benny-fix */ marker");

/** Creates a disposable git repository containing the buggy fixture app. */
export async function createProofRepo(): Promise<{ cwd: string; revision: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "benny-proof-repo-"));
	const appDir = join(cwd, "app");
	await mkdir(appDir, { recursive: true });
	await writeFile(join(appDir, "index.html"), BUGGY_HTML);
	await writeFile(join(appDir, "server.ts"), await readFile(new URL("./app/server.ts", import.meta.url), "utf8"));
	await Bun.$`git -C ${cwd} init -q -b main`.quiet();
	await Bun.$`git -C ${cwd} add -A`.quiet();
	await Bun.$`git -C ${cwd} -c user.email=proof@benny.local -c user.name="Benny Proof" commit -q -m "fixture app with counter render bug"`.quiet();
	const revision = (await Bun.$`git -C ${cwd} rev-parse HEAD`.quiet()).stdout.toString().trim();
	return { cwd, revision };
}

export function proofConfig(image: string): BennyConfig {
	return {
		schema_version: 1,
		automations: { triage_name: "triage", reproduce_name: "reproduce" },
		slack: {
			source_channel_id: "C_TEST", operations_channel_id: "C_OPS", triage_identity_user_id: "U_TRIAGE",
			read_action: "read", thread_post_action: "post", file_download_action: "download", operations_edit_action: "edit",
			prefer_configured_actions: false, optional_bot_token_env: "BENNY_SLACK_BOT_TOKEN",
			allow_source_root_posts: false, allow_worker_slack_writes: false,
		},
		repository: { url: "", default_branch: "main", pull_request_action: "gh", pull_request_url_format: "https://github.com/{owner}/{repo}/pull/{number}", draft_only: true },
		tracker: { type: "linear", team: "", project: "", labels: { bug: "bug", performance: "performance", intake: "intake", needs_repro: "needs-repro" }, status: "", source_link_title: "", require_compensation_action: true },
		routing: { map_path: "", owner_pings_default: false, allow_feature_owner_ping: false, allow_confirmed_regression_author_ping: false },
		control: { skill_name: "", feature_map_path: "", environment: "fixture", artifact_directory: ".omp/pstack/state/benny-evidence", artifact_retention_hours: 24 },
		verdict_markers: { bug: "[benny:bug]", performance: "[benny:performance]", other: "[benny:other]", tracker_attribute: "tracker=" },
		status_emoji: { seen: "", reproducing: "", reproduced: "", could_not_reproduce: "", blocked: "", fixing: "", fix_failed: "", pull_request_opened: "" },
		budgets: { poll_seconds: 45, verdict_wait_minutes: 45, triage_follow_up_minutes: 10, triage_total_minutes: 30, repro_minutes: 60, rejection_window_minutes: 10, fix_minutes: 90, operations_follow_up_minutes: 45 },
		models: { triage: "inherit-parent", reproduce: "inherit-parent", code: "inherit-parent", media_review: "inherit-parent" },
		runtime: {
			trigger: "external",
			slack_app_token_env: "SLACK_APP_TOKEN", slack_read_token_env: "SLACK_READ_TOKEN", slack_write_token_env: "SLACK_WRITE_TOKEN", tracker_token_env: "TRACKER_TOKEN",
			workspace_image: image,
			control_command: ["bun", "/opt/benny-control/control.mjs"],
			control_config: {
				worker_command: ["sh", "-c", `nohup bun /workspace/app/server.ts ${APP_PORT} >/artifacts/app.log 2>&1 &`],
				app_url: APP_URL,
			},
			environment: { APP_ENV: "benny-fixture" },
			allowed_endpoints: [],
		},
	} as BennyConfig;
}

/** Raised by a probe when the boundary is observably violated; fails the proof. */
class ProbeViolated extends Error {}

interface AdversarialEntry {
	probe: string;
	blocked: boolean;
	detail?: string;
}

function isExecResult(value: unknown): value is { exitCode: number; stdout: string; stderr: string } {
	return typeof value === "object" && value !== null
		&& "exitCode" in value && typeof value.exitCode === "number"
		&& "stdout" in value && typeof value.stdout === "string"
		&& "stderr" in value && typeof value.stderr === "string";
}
export interface ProofTrial {
	phase: "baseline" | "patched";
	resetId: string;
	observedValue: unknown;
	observed: string;
	artifacts: Array<{ path: string; sha256: string; mimeType: string }>;
	recordingFrames: unknown;
	controlIds: string[];
}

export interface ProofResult {
	image: string;
	revision: string;
	runId: string;
	workspacePath: string;
	baselineHash: string;
	bringUp: { marker: unknown; capabilities: unknown; sessionId: unknown };
	baseline: ProofTrial[];
	patched: ProofTrial[];
	adversarial: AdversarialEntry[];
	allBlocked: boolean;
	blockedProbes: string[];
	controlIds: string[];
	capabilities: readonly string[];
	cleanup: { stopped: string[]; removed: string[]; retained: string[] };
}

export async function runProof(options: { image?: string; runId?: string; deadlineMs?: number; keepRepo?: boolean } = {}) {
	if ((await Bun.$`docker info`.quiet().nothrow()).exitCode !== 0) {
		throw new WorkspaceBlockError("docker daemon unavailable; workspace proof requires a real container boundary");
	}
	// A real random host-side canary secret: if the container inherited broad
	// host environment, this exact value would be visible. Value is random so a
	// stale echo cannot pass the probe.
	const canaryName = `BENNY_CANARY_${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
	const canaryValue = crypto.randomUUID();
	const previousCanary = process.env[canaryName];
	process.env[canaryName] = canaryValue;
	const image = await ensureImage(options.image);
	const repo = await createProofRepo();
	const { cwd, revision } = repo;
	const runId = options.runId ?? `proof-${Date.now()}`;
	const artifactDir = ".omp/pstack/state/benny-evidence";
	const deadline = Date.now() + (options.deadlineMs ?? 20 * 60_000);
	const config = proofConfig(image);

	const controlIds: string[] = [];
	const track = (receipt: { capability: string; at: number }) => controlIds.push(`${receipt.capability}@${receipt.at}`);
	const adversarial: Array<AdversarialEntry> = [];

	/**
	 * Adversarial probe: `attempt` resolves ONLY when the denial is confirmed.
	 * A thrown WorkspaceBlockError is the API rejecting the boundary attempt.
	 * ProbeViolated marks an observable violation; any other error is an
	 * infrastructure/assertion failure. Both fail the proof.
	 */
	async function expectDenied(probe: string, attempt: () => Promise<void>) {
		try {
			await attempt();
			adversarial.push({ probe, blocked: true });
		} catch (error) {
			if (error instanceof WorkspaceBlockError) {
				adversarial.push({ probe, blocked: true, detail: error.message });
				return;
			}
			adversarial.push({
				probe,
				blocked: false,
				detail: error instanceof ProbeViolated ? `VIOLATED: ${error.message}` : `probe failure: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	function isCleanupResult(value: unknown): value is { stopped: string[]; removed: string[]; retained: string[] } {
		return (
			typeof value === "object" && value !== null
			&& "stopped" in value && "removed" in value && "retained" in value
			&& Array.isArray(value.stopped) && Array.isArray(value.removed) && Array.isArray(value.retained)
		);
	}


	const workspace = await createBennyWorkspace({ config, cwd, runId, revision, artifactDir, deadline });
	let proof: ProofResult | undefined;
	let proofFailed: unknown = null;
	try {
		function execWorker(
			command: string[],
			stage: "reproduce" | "fix" | "verify" = "reproduce",
		): Promise<{ exitCode: number; stdout: string; stderr: string }> {
			return workspace.call("exec", { command }, stage).then(value => {
				if (!isExecResult(value)) throw new Error(`exec returned unexpected shape: ${JSON.stringify(value).slice(0, 100)}`);
				return value;
			});
		}
		/** Asserts an API boundary rejection; infrastructure errors propagate. */
		async function mustRejectApi(attempt: () => Promise<unknown>) {
			try {
				await attempt();
			} catch (error) {
				if (error instanceof WorkspaceBlockError) return;
				throw error;
			}
			throw new ProbeViolated("operation unexpectedly succeeded");
		}
		async function startApp(stage: "reproduce" | "verify") {
			await workspace.call(
				"exec",
				{ command: ["sh", "-c", `nohup bun /workspace/app/server.ts ${APP_PORT} >/artifacts/app.log 2>&1 & sleep 0.5`] },
				stage,
			);
			const probe = await workspace.call(
				"exec",
				{ command: ["bun", "-e", `fetch("http://127.0.0.1:${APP_PORT}/").then(r => console.log("up", r.status)).catch(() => console.log("down"))`] },
				stage,
			);
			if (!isExecResult(probe) || !probe.stdout.includes("up")) {
				throw new Error(`app server did not start in the worker: ${JSON.stringify(probe).slice(0, 200)}`);
			}
		}

		async function trial(phase: "baseline" | "patched", name: string) {
			const resetId = crypto.randomUUID();
			track(await workspace.control("drive-features", { feature: "counter", action: "reset" }));
			await workspace.control("recording", { action: "start", path: `/artifacts/${name}.webm` });
			track(await workspace.control("drive-ui", { actions: [{ kind: "click", selector: "[data-testid=increment]" }] }));
			const state = await workspace.control("inspect-state", { query: "counter" });
			const shot = await workspace.control("screenshot", { path: `/artifacts/${name}.png`, description: `${phase} final state` });
			track(shot);
			const stopped = await workspace.control("recording", { action: "stop", path: `/artifacts/${name}.webm` });
			track(stopped);
			const collected = await workspace.artifacts([...shot.artifacts, ...stopped.artifacts].map(artifact => artifact.path));
			const observedValue = state.result.value;
			return {
				phase,
				resetId,
				observedValue,
				observed: observedValue === "0" ? "broken" : observedValue === "1" ? "correct" : "unexpected",
				artifacts: collected.map(artifact => ({ path: artifact.path, sha256: artifact.sha256, mimeType: artifact.mimeType })),
				recordingFrames: stopped.result.frames,
				controlIds: controlIds.slice(),
			};
		}

		// Control is blocked before any stage has been explicitly entered.
		await expectDenied("control before any stage", () => mustRejectApi(() => workspace.control("inspect-state", { query: "counter" })));

		// Study stage entered with a read: opens the read-only phase.
		const studyRead = await workspace.call("read", { path: "app/index.html" }, "study");
		if (!(typeof studyRead === "object" && studyRead !== null && "base64" in studyRead)) {
			throw new Error("study read returned unexpected shape");
		}

		// Start the operator app in the worker (reproduce stage entered below).
		await workspace.call("read", { path: "app/server.ts" }, "reproduce");
		await startApp("reproduce");

		// Bring-up runs the capability probe: all seven capabilities, a real
		// screenshot, a real recording with a decodable frame, clean baseline.
		const bringUp = await workspace.control("bring-up", { appUrl: APP_URL, marker: APP_MARKER });
		track(bringUp);
		if (bringUp.result.marker !== APP_MARKER) throw new Error("bring-up did not confirm the stable app marker");

		// Baseline: the broken state must appear twice with independent resets.
		const baseline = [await trial("baseline", "baseline-1"), await trial("baseline", "baseline-2")];

		// --- Adversarial probes: every attempt must be DENIED. -----------------
		await expectDenied("write in reproduce stage", () => mustRejectApi(() => workspace.call("write", { path: "app/index.html", content: "x" }, "reproduce")));
		await expectDenied("path traversal read", () => mustRejectApi(() => workspace.call("read", { path: "../../etc/passwd" }, "reproduce")));
		await expectDenied("absolute traversal read", () => mustRejectApi(() => workspace.call("read", { path: "/etc/shadow" }, "reproduce")));
		await expectDenied("host auth/config read", async () => {
			const result = await execWorker(["sh", "-c", "for p in /root/.omp/agent/credentials.json /root/.git-credentials; do test ! -e \"$p\" || echo \"exposed:$p\"; done"]);
			if (result.stdout.includes("exposed:")) throw new ProbeViolated("host auth/config surface reachable");
		});
		await expectDenied("docker socket access", async () => {
			const result = await execWorker(["sh", "-c", "test -S /var/run/docker.sock && echo socket-present || echo absent"]);
			if (result.stdout.includes("socket-present")) throw new ProbeViolated("docker socket reachable from worker");
		});
		await expectDenied("docker CLI absent", async () => {
			const result = await execWorker(["which", "docker"]);
			if (result.exitCode === 0) throw new ProbeViolated("docker binary present in worker");
		});
		await expectDenied("container env canary/secret-free", async () => {
			const dump = await execWorker(["sh", "-c", "env; cat /proc/self/environ"]);
			if (dump.stdout.includes(canaryValue) || dump.stdout.includes(canaryName)) {
				throw new ProbeViolated("host canary secret leaked into container environment");
			}
			if (/slack|token|secret|password|credential/i.test(dump.stdout.replace(canaryName, ""))) {
				throw new ProbeViolated("secret-like value present in container environment");
			}
		});
		await expectDenied("no host home/socket mounts", async () => {
			const mounts = await execWorker(["sh", "-c", "cat /proc/mounts"]);
			if (/docker\.sock|\/root\s|\/home\/[a-z_]+\s/.test(mounts.stdout)) {
				throw new ProbeViolated("host home/root/docker-socket mount visible in worker");
			}
		});
		await expectDenied("controller CDP unreachable from worker", async () => {
			const result = await execWorker([
				"bun", "-e",
				`const controller = new AbortController(); setTimeout(() => controller.abort(), 3000);
				 try { const response = await fetch("http://benny-controller:9222/json/version", { signal: controller.signal }); console.log("cdp-reachable:" + response.status); } catch { console.log("cdp-unreachable"); }`,
			]);
			if (!result.stdout.includes("cdp-unreachable")) throw new ProbeViolated("controller CDP reachable from worker");
		});
		await expectDenied("root-owned adapter not writable", async () => {
			const result = await execWorker(["test", "-w", "/opt/benny-control/control.mjs"]);
			if (result.exitCode === 0) throw new ProbeViolated("worker can write the root-owned adapter path");
		});
		await expectDenied("worker bunfig preload cannot reach control receipts", async () => {
			// Demonstrate the threat exists in the worker cwd (bun reads bunfig
			// from cwd) while the host control channel always execs the adapter
			// in the controller from /opt/benny-control, so worker output can
			// never be stamped as a control receipt.
			await execWorker(["sh", "-c", "printf 'preload = [\"./evil.js\"]\\n' > /artifacts/bunfig.toml; printf 'console.log(\"PRELOAD_RAN\")' > /artifacts/evil.js"]);
			const result = await execWorker(["sh", "-c", "cd /artifacts && bun -e 'process.exit(0)'"]);
			if (!result.stdout.includes("PRELOAD_RAN")) throw new ProbeViolated("expected worker-cwd preload demo did not run");
		});
		await expectDenied("slack credential theft", async () => {
			const result = await execWorker(["sh", "-c", "env | grep -i slack; cat /*token* /*secret* 2>/dev/null; grep -ril slack_ /workspace 2>/dev/null | head -1; exit 4"]);
			if (result.exitCode === 0 || /xox[bp]|SLACK_/.test(result.stdout)) throw new ProbeViolated("slack credential surface found");
		});
		await expectDenied("symlink artifact escape", async () => {
			const linked = await execWorker(["ln", "-s", "/etc/passwd", "/artifacts/evil.png"]);
			if (linked.exitCode !== 0) throw new Error("could not create escape symlink inside worker");
			await mustRejectApi(() => workspace.artifacts(["/artifacts/evil.png"]));
		});
		await expectDenied("malformed artifact rejected", async () => {
			const written = await execWorker(["sh", "-c", "echo definitely-not-a-video > /artifacts/fake.webm"]);
			if (written.exitCode !== 0) throw new Error("could not write fake artifact inside worker");
			await mustRejectApi(() => workspace.artifacts(["/artifacts/fake.webm"]));
		});

		// --- Fix stage: the only stage where code writes are permitted. --------
		await workspace.call("write", { path: "app/index.html", content: FIXED_HTML }, "fix");
		await expectDenied("control during fix stage", () => mustRejectApi(() => workspace.control("inspect-state", { query: "counter" })));
		await execWorker(["sh", "-c", "pkill -f 'app/server.ts' || true; sleep 0.3"], "fix");

		// --- Storage boundary: every model-writable filesystem is a bounded
		// tmpfs with no host backing. Probes run INSIDE the fix stage. -------
		await expectDenied("fix worktree is kernel-bounded tmpfs, not a host bind", async () => {
			const mounts = await execWorker(["sh", "-c", "grep ' /workspace ' /proc/mounts; grep ' /artifacts ' /proc/mounts"], "fix");
			// /proc/mounts columns are source, mountpoint, fstype, options; a
			// tmpfs surface renders with the literal source 'tmpfs'.
			if (!/^\S+ \/workspace tmpfs /m.test(mounts.stdout) || !/^\S+ \/artifacts tmpfs /m.test(mounts.stdout)) {
				throw new ProbeViolated(`model-writable surfaces are not bounded tmpfs: ${mounts.stdout.slice(0, 200)}`);
			}
			if (/^tmpfs \/workspace .*?(benny|host|home|dev)/m.test(mounts.stdout)) throw new ProbeViolated("unexpected host bind on /workspace");
		});
		async function hostDirBytes(dir: string): Promise<number> {
			const du = await Bun.$`du -sb ${dir}`.quiet().nothrow();
			if (du.exitCode !== 0) throw new Error(`cannot measure host directory ${dir}`);
			return Number(du.stdout.toString().split("\t")[0]);
		}
		await expectDenied("a writer past the quota is kernel-stopped without host growth", async () => {
			const before = await hostDirBytes(workspace.workspacePath);
			// Far more than the 1 GiB tmpfs (and the container's 1 GiB memory
			// cgroup): the kernel must stop the writer, never the host scan.
			const filled = await execWorker(["sh", "-c", "dd if=/dev/zero of=/workspace/quota-probe.bin bs=1M count=4096"], "fix");
			const after = await hostDirBytes(workspace.workspacePath);
			const removed = await execWorker(["sh", "-c", "rm -f /workspace/quota-probe.bin"], "fix");
			if (removed.exitCode !== 0) throw new Error(`quota probe cleanup failed (exit ${removed.exitCode}); the fix volume is not recoverable after ENOSPC`);
			if (filled.exitCode === 0) throw new ProbeViolated("worktree writer exceeded the quota without ENOSPC");
			if (!/No space left on device|exited/.test(`${filled.stderr} ${String(filled.exitCode)}`) && filled.exitCode !== 137) {
				throw new Error(`unexpected quota failure mode: ${filled.stderr.slice(0, 200)}`);
			}
			if (after !== before) throw new ProbeViolated(`host worktree grew ${after - before} bytes under a tmpfs writer`);
		});
		await expectDenied("artifact staging quota is kernel-enforced", async () => {
			const filled = await execWorker(["sh", "-c", "dd if=/dev/zero of=/artifacts/staging-probe.bin bs=1M count=2048"], "fix");
			const removedStaging = await execWorker(["sh", "-c", "rm -f /artifacts/staging-probe.bin"], "fix");
			if (removedStaging.exitCode !== 0) throw new Error(`staging probe cleanup failed (exit ${removedStaging.exitCode})`);
			if (filled.exitCode === 0) throw new ProbeViolated("staging writer exceeded the quota without ENOSPC");
		});
		await expectDenied("a background writer cannot bypass the storage boundary", async () => {
			const before = await hostDirBytes(workspace.workspacePath);
			await execWorker(["sh", "-c", "nohup sh -c 'until :; do dd if=/dev/zero bs=1M count=1 >> /workspace/grow.bin 2>/dev/null || break; done' >/dev/null 2>&1 & sleep 4"], "fix");
			const after = await hostDirBytes(workspace.workspacePath);
			// The tmpfs-resident file may have grown up to the quota, but the
			// HOST worktree is untouched: no bind exists to grow.
			// Two separate execs: a combined `pkill -f grow.bin; rm ...` shell
			// matches its own cmdline and is killed before rm runs, leaving the
			// ~1 GiB tmpfs file charged against the container's memory cgroup —
			// every later exec is then OOM-killed at runc setns (exit 128).
			const killed = await execWorker(["sh", "-c", "pkill -f grow.bin || true; sleep 0.3"], "fix");
			const removedGrow = await execWorker(["sh", "-c", "rm -f /workspace/grow.bin"], "fix");
			if (removedGrow.exitCode !== 0) throw new Error(`writer cleanup failed (exit ${removedGrow.exitCode})`);
			if (after !== before) throw new ProbeViolated(`background writer grew the host worktree by ${after - before} bytes`);
		});
		// Leaving fix freezes the patched snapshot and remounts read-only.
		await workspace.call("read", { path: "app/index.html" }, "verify");
		await startApp("verify");

		// Fresh bring-up after the swap (capability state was reset).
		const patchedUp = await workspace.control("bring-up", { appUrl: APP_URL, marker: APP_MARKER });
		track(patchedUp);

		// Patched: the correct state must appear twice with independent resets.
		const patched = [await trial("patched", "patched-1"), await trial("patched", "patched-2")];
		await expectDenied("write in verify stage", () => mustRejectApi(() => workspace.call("write", { path: "app/index.html", content: "x" }, "verify")));
		await expectDenied("stage regression rejected", () => mustRejectApi(() => workspace.call("read", { path: "app/index.html" }, "study")));

		proof = {
			image,
			revision,
			runId,
			workspacePath: workspace.workspacePath,
			baselineHash: workspace.baselineHash,
			bringUp: { marker: bringUp.result.marker, capabilities: bringUp.result.capabilities, sessionId: bringUp.result.sessionId },
			baseline,
			patched,
			adversarial,
			allBlocked: adversarial.every(entry => entry.blocked),
			blockedProbes: adversarial.filter(entry => !entry.blocked).map(entry => `${entry.probe}: ${entry.detail ?? ""}`),
			controlIds,
			capabilities: CONTROL_CAPABILITIES,
			cleanup: { stopped: [], removed: [], retained: [] },
		};
	} catch (error) {
		proofFailed = error;
	} finally {
		try {
			const cleanup = await workspace.cleanup();
			if (!isCleanupResult(cleanup)) throw new Error("workspace cleanup returned an unexpected result");
			if (proof) proof.cleanup = cleanup;
		} catch (error) {
			proofFailed ??= error;
		}
		if (previousCanary === undefined) delete process.env[canaryName];
		else process.env[canaryName] = previousCanary;
		if (!options.keepRepo) await rm(cwd, { recursive: true, force: true });
	}
	if (proofFailed) throw proofFailed;
	if (!proof) throw new Error("proof ended without a result");
	return proof;
}

if (import.meta.main) {
	await runProof()
		.then(proof => {
			console.log(JSON.stringify(proof, null, 2));
			const failed = !proof.allBlocked
				|| proof.baseline.some(entry => entry.observed !== "broken")
				|| proof.patched.some(entry => entry.observed !== "correct");
			process.exit(failed ? 1 : 0);
		})
		.catch(error => {
			console.error(String(error));
			process.exit(1);
		});
}

