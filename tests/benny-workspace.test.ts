import { test, expect, beforeAll } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, access, lstat, utimes, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createBennyWorkspace,
	materializeAdmittedTree,
	ownershipLabels,
	ownershipRefusal,
	parseMediaVerdict,
	decodeVideoFrames,
	detectMediaMime,
	reviewMedia,
	resolveImageId,
	reclaimBennyRunResources,
	reclaimPriorIncarnations,
	sweepExpiredEvidence,
	unverifiedAbsent,
	volumeDefinitionRefusal,
	WorkspaceBlockError,
	run,
	workspaceIdentity,
	WORKSPACE_LIMITS,
} from "../src/benny-workspace.ts";
import type { BennyWorkspace, DecodedFrame } from "../src/benny-workspace.ts";
import { openBennyStore } from "../src/benny.ts";
import { openRunStore, profileWorkspaceDir } from "../src/runner.ts";
import { createProofRepo, ensureImage, proofConfig, runProof, PROOF_IMAGE } from "../scripts/fixtures/benny-workspace/proof.ts";

/**
 * Real-container tests: skipped when the Docker daemon is unavailable. There is
 * deliberately no fake Docker binary or stubbed adapter — the boundary tests
 * exercise the actual container.
 */
const hasDocker = await Bun.$`docker info`.quiet().nothrow().then(result => result.exitCode === 0);
const dockerTest = test.skipIf(!hasDocker);

let image = PROOF_IMAGE;

beforeAll(async () => {
	if (hasDocker) image = await ensureImage();
});

function isExecShape(value: unknown): value is { exitCode: number; stdout: string; stderr: string } {
	return typeof value === "object" && value !== null
		&& "exitCode" in value && typeof value.exitCode === "number"
		&& "stdout" in value && typeof value.stdout === "string"
		&& "stderr" in value && typeof value.stderr === "string";
}

test("structured media verdict validation rejects generic prose, out-of-range citations, and partial coverage without a model call", () => {
	// Valid: one attached image, evidence cites imageIndex 0.
	expect(parseMediaVerdict('{"confirmed":true,"evidence":["imageIndex 0 shows count 0 after one increment"]}', 1)).toEqual({
		confirmed: true,
		evidence: ["imageIndex 0 shows count 0 after one increment"],
	});
	expect(parseMediaVerdict('The verdict is:\n{"confirmed":false,"evidence":["imageIndex 0: frames only show a loading screen","imageIndex 1: counter stuck"]}', 2)).toEqual({
		confirmed: false,
		evidence: ["imageIndex 0: frames only show a loading screen", "imageIndex 1: counter stuck"],
	});
	expect(parseMediaVerdict("no json here", 1)).toBeNull();
	expect(parseMediaVerdict('{"confirmed":"yes","evidence":["x"]}', 1)).toBeNull();
	expect(parseMediaVerdict('{"confirmed":true,"evidence":[]}', 1)).toBeNull();
	expect(parseMediaVerdict('{"confirmed":true}', 1)).toBeNull();
	// Generic prose without a structural imageIndex citation is blocked.
	expect(parseMediaVerdict('{"confirmed":true,"evidence":["the screenshot shows count 0"]}', 1)).toBeNull();
	// Out-of-range citations are blocked.
	expect(parseMediaVerdict('{"confirmed":true,"evidence":["imageIndex 3 shows the bug"]}', 2)).toBeNull();
	// Every attached image index must be covered.
	expect(parseMediaVerdict('{"confirmed":true,"evidence":["imageIndex 0 shows the bug"]}', 2)).toBeNull();
	expect(parseMediaVerdict('{"confirmed":true,"evidence":["imageIndex 0 shows the bug","imageIndex 1 shows the fix"]}', 2)).toEqual({
		confirmed: true,
		evidence: ["imageIndex 0 shows the bug", "imageIndex 1 shows the fix"],
	});
});

test("detectMediaMime rejects malformed JPEG bytes; only a full SOI signature is trustworthy media", () => {
	// Truncated SOI (2 bytes) and a wrong marker byte are NOT JPEG.
	expect(detectMediaMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
	expect(detectMediaMime(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull();
	expect(detectMediaMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
	// A declared .jpg extension can never promote non-JPEG bytes: garbage and
	// foreign magic are rejected — this is the gate publishArtifact enforces.
	expect(detectMediaMime(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
	expect(detectMediaMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
});

test("workspace identity binds the stable namespace to a 16-hex per-run incarnation", () => {
	const identity = workspaceIdentity("run-1", "0123456789abcdef");
	expect(identity.namespace).toBe("benny-ws-run-1");
	expect(identity.worker).toBe("benny-ws-run-1-0123456789abcdef");
	expect(identity.controller).toBe("benny-ws-run-1-0123456789abcdef-ctl");
	expect(identity.network).toBe("benny-ws-run-1-0123456789abcdef-net");
	expect(identity.controlVolume).toBe("benny-ws-run-1-0123456789abcdef-ctlstore");
	expect(() => workspaceIdentity("run-1", "not-hex")).toThrow(WorkspaceBlockError);
	expect(() => workspaceIdentity("bad id!", "0123456789abcdef")).toThrow(WorkspaceBlockError);
});

test("ownership refusal allows exact matches and absent resources; missing, differing, or extra labels refuse", () => {
	const expected = ownershipLabels(workspaceIdentity("r", "f".repeat(16)), "worker");
	expect(ownershipRefusal({ ...expected }, expected, "container", "c", "stop/remove")).toBeUndefined();
	expect(ownershipRefusal(undefined, expected, "container", "c", "stop/remove")).toBeUndefined();
	const missing = { ...expected };
	delete missing["pstack.benny.incarnation"];
	expect(ownershipRefusal(missing, expected, "container", "c", "stop/remove")).toMatch(/refusing to stop\/remove/);
	expect(ownershipRefusal({ ...expected, "pstack.benny.incarnation": "0000000000000000" }, expected, "container", "c", "adopt")).toMatch(/refusing to adopt/);
	expect(ownershipRefusal({ ...expected, "pstack.benny.role": "controller" }, expected, "network", "n", "remove")).toMatch(/refusing to remove/);
	// An EXTRA label beyond the exact identity key set makes a resource foreign.
	expect(ownershipRefusal({ ...expected, "pstack.benny.evil": "1" }, expected, "container", "c", "adopt")).toMatch(/refusing to adopt/);
	expect(ownershipRefusal({ ...expected, "pstack.benny.evil": "1" }, expected, "network", "n", "remove")).toMatch(/not part of this workspace identity's exact label set/);
});

dockerTest("a pre-existing foreign network with the exact target name is neither adopted nor torn down", async () => {
	const { cwd, revision } = await createProofRepo();
	const incarnation = "1234567890abcdef";
	const identity = workspaceIdentity("adoption-probe", incarnation);
	await Bun.$`docker network create ${identity.network}`.quiet().nothrow();
	try {
		const error = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: "adoption-probe",
			incarnation,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect((error as Error).message).toMatch(/refusing to adopt/);
		expect((await Bun.$`docker network inspect ${identity.network}`.quiet().nothrow()).exitCode).toBe(0);
		const adopted = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.run-id=adoption-probe`.quiet().nothrow();
		expect(adopted.stdout.toString().trim()).toBe("");
	} finally {
		await Bun.$`docker network rm ${identity.network}`.quiet().nothrow();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

test("volume definition refusal accepts only the exact bounded tmpfs definition; labels alone never suffice", () => {
	const identity = workspaceIdentity("vd", "9".repeat(16));
	const labels = ownershipLabels(identity, "fix-storage");
	const opts = "rw,noexec,nosuid,size=1073741824,nr_inodes=262144,uid=1000,gid=1000";
	const ok = { labels, driver: "local", options: { type: "tmpfs", device: "tmpfs", o: opts } };
	expect(volumeDefinitionRefusal(ok, labels, opts)).toBeUndefined();
	// A plain disk-backed volume is unbounded no matter whose labels it wears.
	expect(volumeDefinitionRefusal({ labels, driver: "local", options: {} }, labels, opts)).toMatch(/tmpfs options/);
	expect(volumeDefinitionRefusal({ labels, driver: "local", options: { type: "tmpfs", device: "tmpfs", o: "rw,size=999999999" } }, labels, opts)).toMatch(/must be exactly/);
	expect(volumeDefinitionRefusal({ ...ok, driver: "overlay2" }, labels, opts)).toMatch(/driver/);
	expect(volumeDefinitionRefusal({ ...ok, options: { type: "tmpfs", device: "ext4", o: opts } }, labels, opts)).toMatch(/type\/device/);
	expect(volumeDefinitionRefusal(ok, { ...labels, "pstack.benny.role": "worker" }, opts)).toMatch(/label 'pstack\.benny\.role'/);
	// Extra labels beyond the exact set make a volume foreign for adoption.
	expect(volumeDefinitionRefusal({ ...ok, labels: { ...labels, "pstack.benny.evil": "1" } }, labels, opts)).toMatch(/not part of this volume's exact label set/);
});

dockerTest("a pre-existing plain volume under the bounded name is never adopted, mounted, or torn down", async () => {
	const { cwd, revision } = await createProofRepo();
	const incarnation = "2345678901abcdef";
	const identity = workspaceIdentity("volume-adoption", incarnation);
	await Bun.$`docker volume create ${identity.fixVolume}`.quiet().nothrow();
	try {
		const error = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: "volume-adoption",
			incarnation,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect((error as Error).message).toMatch(/refusing to adopt preexisting volume/);
		// The foreign volume is untouched by bring-up or teardown: still
		// present, still provably unlabeled and unbounded.
		expect((await Bun.$`docker volume inspect ${identity.fixVolume}`.quiet().nothrow()).exitCode).toBe(0);
		const labels = JSON.parse((await Bun.$`docker volume inspect -f '{{json .Labels}}' ${identity.fixVolume}`.quiet().nothrow()).stdout.toString());
		expect(labels).toBeNull();
		// Bring-up failed before any container existed.
		const containers = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.run-id=volume-adoption`.quiet().nothrow();
		expect(containers.stdout.toString().trim()).toBe("");
	} finally {
		await Bun.$`docker volume rm ${identity.fixVolume}`.quiet().nothrow();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

dockerTest("reclaim removes prior-incarnation storage volumes but refuses unknown roles", async () => {
	const removable = "benny-reclaim-vol-ok";
	const refused = "benny-reclaim-vol-bad";
	const labels = (role: string) => [
		"--label", "pstack.benny.managed=true",
		"--label", "pstack.benny.run-id=reclaim-volumes",
		"--label", "pstack.benny.incarnation=0000000000000042",
		"--label", `pstack.benny.role=${role}`,
	];
	await Bun.$`docker volume create ${labels("fix-storage")} ${removable}`.quiet().nothrow();
	await Bun.$`docker volume create ${labels("some-other-role")} ${refused}`.quiet().nothrow();
	try {
		const result = await reclaimPriorIncarnations("reclaim-volumes");
		expect(result.removed).toContain(removable);
		expect((await Bun.$`docker volume inspect ${removable}`.quiet().nothrow()).exitCode).not.toBe(0);
		expect(result.refused.some(message => message.includes(refused))).toBe(true);
		expect((await Bun.$`docker volume inspect ${refused}`.quiet().nothrow()).exitCode).toBe(0);
	} finally {
		await Bun.$`docker volume rm ${removable} ${refused}`.quiet().nothrow();
	}
});

dockerTest("sibling runs with distinct incarnations never cross teardown and carry exact ownership labels", async () => {
	const { cwd, revision } = await createProofRepo();
	const incarnationA = "aaaaaaaaaaaaaaaa";
	const incarnationB = "bbbbbbbbbbbbbbbb";
	const idA = workspaceIdentity("cross-a", incarnationA);
	const idB = workspaceIdentity("cross-b", incarnationB);
	const base = { config: proofConfig(image), cwd, artifactDir: ".omp/pstack/state/benny-evidence", deadline: Date.now() + 5 * 60_000 };
	let first: BennyWorkspace | undefined;
	let second: BennyWorkspace | undefined;
	try {
		first = await createBennyWorkspace({ ...base, runId: "cross-a", incarnation: incarnationA, revision });
		second = await createBennyWorkspace({ ...base, runId: "cross-b", incarnation: incarnationB, revision });
		expect(idA.worker).not.toBe(idB.worker);
		expect(idA.network).not.toBe(idB.network);
		const networkLabels = JSON.parse(
			(await Bun.$`docker network inspect -f ${"{{json .Labels}}"} ${idB.network}`.quiet()).stdout.toString(),
		);
		expect(networkLabels).toMatchObject(ownershipLabels(idB, "network"));
		const workerLabels = JSON.parse(
			(await Bun.$`docker container inspect -f ${"{{json .Config.Labels}}"} ${idB.worker}`.quiet()).stdout.toString(),
		);
		expect(workerLabels).toMatchObject(ownershipLabels(idB, "worker"));
		await first.cleanup();
		expect((await Bun.$`docker inspect -f ${"{{.State.Running}}"} ${idB.worker}`.quiet()).stdout.toString().trim()).toBe("true");
		expect((await Bun.$`docker inspect -f ${"{{.State.Running}}"} ${idB.controller}`.quiet()).stdout.toString().trim()).toBe("true");
		expect((await Bun.$`docker network inspect ${idB.network}`.quiet().nothrow()).exitCode).toBe(0);
	} finally {
		if (first) await first.cleanup().catch(() => undefined);
		if (second) await second.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

dockerTest("stale evidence is retained while a run-id-labeled container still exists", async () => {
	const { cwd, revision } = await createProofRepo();
	// Retention is owner-qualified by benny_runs.id in the profile-private run
	// store; without an established active row the sweep fails closed and
	// retains everything. Seed one queued row whose generic runs.id foreign key
	// (424242) deliberately differs from the Benny row's own primary key.
	const store = openRunStore(cwd);
	openBennyStore(store);
	const now = Date.now();
	const inserted = store.run(
		"INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, deadline_ms, created_at, updated_at) VALUES (424242, 'T-sweep', 'evt-sweep-1', 'triage', 'C-sweep', '1770000000.000100', 'queued', ?, ?, ?)",
		[now + 3_600_000, now, now],
	);
	const activeId = String(Number(inserted.lastInsertRowid));
	store.close();
	const evidenceRoot = join(cwd, ".omp", "pstack", "state", "benny-evidence");
	const staleDir = join(evidenceRoot, "stale-run");
	const foreignDir = join(evidenceRoot, "424242");
	const activeDir = join(evidenceRoot, `${activeId}-ops`);
	const staleName = "benny-ws-stale-run-cccccccccccccccc";
	await Bun.$`docker run -d --name ${staleName} --label pstack.benny.managed=true --label pstack.benny.run-id=stale-run --label pstack.benny.incarnation=cccccccccccccccc --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
	try {
		await mkdir(staleDir, { recursive: true });
		await writeFile(join(staleDir, "evidence.bin"), "stale");
		await mkdir(foreignDir, { recursive: true });
		await mkdir(activeDir, { recursive: true });
		const old = new Date(Date.now() - 25 * 60 * 60_000);
		for (const dir of [staleDir, foreignDir, activeDir]) await utimes(dir, old, old);
		const workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: "sweeper",
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		try {
			await workspace.cleanup();
			// The labeled container keeps its run's evidence alive past the cutoff,
			// and so does the active benny_runs.id row.
			await access(staleDir);
			await access(activeDir);
			// The generic runs.id foreign key alone never retains evidence.
			await access(foreignDir).then(
				() => expect.unreachable("runs.id is not an evidence retention key"),
				() => undefined,
			);
		} finally {
			await Bun.$`docker rm -f ${staleName}`.quiet().nothrow();
		}
		// With the container gone, the next sweep reclaims the stale evidence:
		// only the active benny_runs.id row keeps owner-qualified evidence. The
		// generic runs.id foreign key is NOT a retention key.
		await workspace.cleanup();
		await access(activeDir);
		for (const dir of [staleDir, foreignDir]) {
			await access(dir).then(
				() => expect.unreachable("inactive evidence should have been reclaimed"),
				() => undefined,
			);
		}
	} finally {
		await Bun.$`docker rm -f ${staleName}`.quiet().nothrow();
		await rm(profileWorkspaceDir(cwd, "run-state"), { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

test("sweepExpiredEvidence fails closed when the run store is unreadable", async () => {
	const { cwd } = await createProofRepo();
	const stale = join(cwd, ".omp", "pstack", "state", "benny-evidence", "stale-run");
	await mkdir(stale, { recursive: true });
	await writeFile(join(stale, "evidence.bin"), "stale");
	const staleDownloads = join(cwd, ".omp", "pstack", "state", "benny-downloads", "424242");
	await mkdir(staleDownloads, { recursive: true });
	await writeFile(join(staleDownloads, "F001"), "stale");
	const stalePublication = join(cwd, ".omp", "pstack", "state", "benny-publication", "424242");
	await mkdir(stalePublication, { recursive: true });
	await writeFile(join(stalePublication, "scratch.bin"), "stale");
	await utimes(stale, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
	await utimes(staleDownloads, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
	await utimes(stalePublication, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
	try {
		const sweep = await sweepExpiredEvidence(cwd, 24);
		// No established active row → unreadable store → retain everything.
		expect(sweep.storeUnreadable).toBe(true);
		expect(sweep.retained).toContain("stale-run");
		expect(sweep.retained).toContain("benny-downloads/424242");
		await access(stale);
		await access(staleDownloads);
		await access(stalePublication);
		expect(sweep.retained).toContain("benny-publication/424242");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("run rejects an already-aborted signal before spawning", async () => {
	const dir = await mkdtemp(join(tmpdir(), "benny-run-preabort-"));
	const marker = join(dir, "spawned");
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(run(["sh", "-c", `echo started > '${marker}'`], { signal: controller.signal })).rejects.toThrow(WorkspaceBlockError);
		// A wrongly spawned process would have written the marker within this grace window.
		await Bun.sleep(200);
		await access(marker).then(
			() => expect.unreachable("pre-aborted command must never spawn"),
			() => undefined,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an abort racing the spawn is synchronously rechecked and kills the child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "benny-run-race-"));
	const marker = join(dir, "late");
	const controller = new AbortController();
	try {
		const startedAt = Date.now();
		const settled = run(["sh", "-c", `sleep 30; echo done > '${marker}'`], { signal: controller.signal, timeoutMs: 60_000 }).then(
			() => "settled" as const,
			(error: unknown) => error,
		);
		// Abort lands after the call started: the listener is registered and
		// the aborted state rechecked synchronously, so the kill fires without
		// waiting out the 30s sleep or the timeout.
		controller.abort();
		await settled;
		expect(Date.now() - startedAt).toBeLessThan(2000);
		await access(marker).then(
			() => expect.unreachable("aborted child must have been killed before its marker"),
			() => undefined,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a killed command's process-group descendants cannot outlive the call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "benny-run-group-"));
	const marker = join(dir, "late-marker");
	try {
		const startedAt = Date.now();
		// The grandchild inherits the POSIX process group; killing only the
		// direct child would leave it alive to write the late marker.
		await run(["sh", "-c", `sh -c "sleep 1; echo late > '${marker}'" & sleep 60`], { timeoutMs: 300 });
		// Real-clock integration: the grandchild's 1s write deadline must pass
		// while it is dead; no deterministic clock can prove a negative write.
		await Bun.sleep(2000);
		await access(marker).then(
			() => expect.unreachable("descendant of a killed command must not survive"),
			() => undefined,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("over-cap output kills the process group and the rejection settles only after the exit acknowledgement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "benny-run-cap-"));
	const marker = join(dir, "late-marker");
	const pidfile = join(dir, "child-pid");
	try {
		const startedAt = Date.now();
		// The flood trips the per-stream cap; a descendant armed one second
		// later proves the whole process group was killed before the rejection
		// settled — no transport, child, or descendant outlives the call.
		const pending = run(
			["sh", "-c", 'echo $$ > "$PIDFILE"; sh -c \'sleep 1; echo late > "$LATE_MARKER"\' & head -c 8192 /dev/zero; sleep 30'],
			{ maxBytes: 4096, timeoutMs: 60_000, env: { PIDFILE: pidfile, LATE_MARKER: marker } },
		);
		await expect(pending).rejects.toThrow(WorkspaceBlockError);
		await expect(pending).rejects.toThrow(/exceeded 4096 bytes/);
		// The kill fired at the first over-cap chunk: the call never waits out
		// the child's 30s sleep or the timeout.
		expect(Date.now() - startedAt).toBeLessThan(10_000);
		// The exit was acknowledged before the rejection surfaced: the direct
		// child is reaped, not merely signaled.
		const pid = Number((await readFile(pidfile, "utf8")).trim());
		expect(() => process.kill(pid, 0)).toThrow();
		// Real-clock proof: the descendant is a separate OS process on the
		// platform clock; no fake timer can drive or observe its marker write,
		// so the only deterministic proof of its death is time passing beyond
		// its marker timer.
		await Bun.sleep(1400);
		await access(marker).then(
			() => expect.unreachable("descendant of an over-cap command must not survive"),
			() => undefined,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, { timeout: 15_000 });

dockerTest("sweepExpiredEvidence reclaims expired evidence without creating a workspace", async () => {
	const { cwd } = await createProofRepo();
	const store = openRunStore(cwd);
	openBennyStore(store);
	const now = Date.now();
	const inserted = store.run(
		"INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, deadline_ms, created_at, updated_at) VALUES (424242, 'T-sweep2', 'evt-sweep-2', 'triage', 'C-sweep', '1770000000.000100', 'queued', ?, ?, ?)",
		[now + 3_600_000, now, now],
	);
	const activeId = String(Number(inserted.lastInsertRowid));
	store.close();
	const evidenceRoot = join(cwd, ".omp", "pstack", "state", "benny-evidence");
	const foreignDir = join(evidenceRoot, "stale-run");
	const activeDir = join(evidenceRoot, `${activeId}-ops`);
	try {
		await mkdir(foreignDir, { recursive: true });
		await mkdir(activeDir, { recursive: true });
		const old = new Date(Date.now() - 25 * 3_600_000);
		for (const dir of [foreignDir, activeDir]) await utimes(dir, old, old);
		const sweep = await sweepExpiredEvidence(cwd, 24);
		expect(sweep.removed).toContain("stale-run");
		expect(sweep.retained).toContain(`${activeId}-ops`);
		expect(sweep.storeUnreadable).toBe(false);
		await access(activeDir);
		await access(foreignDir).then(
			() => expect.unreachable("unowned expired evidence should have been reclaimed without a later workspace"),
			() => undefined,
		);
	} finally {
		await rm(profileWorkspaceDir(cwd, "run-state"), { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

test("sweepExpiredEvidence expires run-owned downloads, publication snapshots, and publication scratch only when inactive", async () => {
	const { cwd } = await createProofRepo();
	const store = openRunStore(cwd);
	openBennyStore(store);
	const now = Date.now();
	const inserted = store.run(
		"INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, deadline_ms, created_at, updated_at) VALUES (424242, 'T-aux', 'evt-aux-1', 'triage', 'C-aux', '1770000000.000100', 'queued', ?, ?, ?)",
		[now + 3_600_000, now, now],
	);
	const activeId = String(Number(inserted.lastInsertRowid));
	store.close();
	const state = join(cwd, ".omp", "pstack", "state");
	const old = new Date(Date.now() - 25 * 3_600_000);
	const activeDownloads = join(state, "benny-downloads", activeId);
	const activeSnapshot = join(state, "benny-publish-source", activeId);
	const activePublication = join(state, "benny-publication", activeId);
	const staleDownloads = join(state, "benny-downloads", "999999");
	const staleSnapshot = join(state, "benny-publish-source", "999999");
	const stalePublication = join(state, "benny-publication", "999999");
	const freshDownloads = join(state, "benny-downloads", "888888");
	const legacyFile = join(state, "benny-downloads", "F001");
	const planted = join(state, "benny-downloads", "777777");
	const plantedTarget = join(state, "benny-downloads", "planted-target");
	for (const dir of [activeDownloads, activeSnapshot, activePublication, staleDownloads, staleSnapshot, stalePublication, freshDownloads, plantedTarget]) {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "blob.bin"), "x");
	}
	await writeFile(legacyFile, "legacy");
	for (const dir of [activeDownloads, activeSnapshot, activePublication, staleDownloads, staleSnapshot, stalePublication]) await utimes(dir, old, old);
	await utimes(legacyFile, old, old);
	await symlink(plantedTarget, planted);
	try {
		const sweep = await sweepExpiredEvidence(cwd, 24);
		expect(sweep.storeUnreadable).toBe(false);
		expect(sweep.removed).toEqual(expect.arrayContaining(["benny-downloads/999999", "benny-publish-source/999999", "benny-publication/999999"]));
		expect(sweep.retained).toEqual(expect.arrayContaining([`benny-downloads/${activeId}`, `benny-publish-source/${activeId}`, `benny-publication/${activeId}`]));
		await access(activeDownloads);
		await access(activeSnapshot);
		await access(activePublication);
		await access(freshDownloads);
		await access(legacyFile);
		await access(plantedTarget);
		await access(staleDownloads).then(
			() => expect.unreachable("inactive expired downloads should have been reclaimed"),
			() => undefined,
		);
		await access(staleSnapshot).then(
			() => expect.unreachable("inactive expired publication snapshot should have been reclaimed"),
			() => undefined,
		);
		await access(stalePublication).then(
			() => expect.unreachable("inactive expired publication scratch should have been reclaimed"),
			() => undefined,
		);
	} finally {
		await rm(profileWorkspaceDir(cwd, "run-state"), { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

dockerTest("reclaimPriorIncarnations removes exactly the labeled prior incarnations of one run and refuses unprovable ones", async () => {
	await Bun.$`docker run -d --name reclaim-unit-prior --label pstack.benny.managed=true --label pstack.benny.run-id=reclaim-unit --label pstack.benny.incarnation=aaaaaaaaaaaaaaaa --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker run -d --name reclaim-unit-unlabeled --label pstack.benny.managed=true --label pstack.benny.run-id=reclaim-unit ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker run -d --name reclaim-unit-foreign --label pstack.benny.managed=true --label pstack.benny.run-id=other-run --label pstack.benny.incarnation=cccccccccccccccc --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker network create --label pstack.benny.managed=true --label pstack.benny.run-id=reclaim-unit --label pstack.benny.incarnation=aaaaaaaaaaaaaaaa --label pstack.benny.role=network reclaim-unit-prior-net`.quiet().nothrow();
	try {
		const reclaim = await reclaimPriorIncarnations("reclaim-unit");
		expect(reclaim.removed).toEqual(expect.arrayContaining(["reclaim-unit-prior", "reclaim-unit-prior-net"]));
		expect(reclaim.refused.join("; ")).toMatch(/reclaim-unit-unlabeled.*incarnation/);
		expect((await Bun.$`docker inspect reclaim-unit-prior`.quiet().nothrow()).exitCode).not.toBe(0);
		expect((await Bun.$`docker network inspect reclaim-unit-prior-net`.quiet().nothrow()).exitCode).not.toBe(0);
		// The unprovable leftover and the foreign run's container are untouched.
		expect((await Bun.$`docker inspect reclaim-unit-unlabeled`.quiet().nothrow()).exitCode).toBe(0);
		expect((await Bun.$`docker inspect reclaim-unit-foreign`.quiet().nothrow()).exitCode).toBe(0);
	} finally {
		await Bun.$`docker rm -f reclaim-unit-prior reclaim-unit-unlabeled reclaim-unit-foreign`.quiet().nothrow();
		await Bun.$`docker network rm reclaim-unit-prior-net`.quiet().nothrow();
	}
}, { timeout: 120_000 });

dockerTest("crash-left prior incarnations are reclaimed before any bring-up mutation; an unprovable leftover fails the run closed", async () => {
	const { cwd, revision } = await createProofRepo();
	await Bun.$`docker run -d --name crash-left-prior --label pstack.benny.managed=true --label pstack.benny.run-id=crash-left --label pstack.benny.incarnation=deadbeefdeadbeef --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker network create --label pstack.benny.managed=true --label pstack.benny.run-id=crash-left --label pstack.benny.incarnation=deadbeefdeadbeef --label pstack.benny.role=network crash-left-prior-net`.quiet().nothrow();
	await Bun.$`docker run -d --name crash-left-unlabeled --label pstack.benny.managed=true --label pstack.benny.run-id=crash-left ${image} sleep 600`.quiet().nothrow();
	try {
		const error = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: "crash-left",
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect((error as Error).message).toMatch(/could not be reclaimed/);
		expect((error as Error).message).toMatch(/crash-left-unlabeled/);
		// Provable prior incarnations were already reclaimed before the refusal.
		expect((await Bun.$`docker inspect crash-left-prior`.quiet().nothrow()).exitCode).not.toBe(0);
		expect((await Bun.$`docker network inspect crash-left-prior-net`.quiet().nothrow()).exitCode).not.toBe(0);
		// The unprovable leftover was never touched.
		expect((await Bun.$`docker inspect crash-left-unlabeled`.quiet().nothrow()).exitCode).toBe(0);
	} finally {
		await Bun.$`docker rm -f crash-left-prior crash-left-unlabeled`.quiet().nothrow();
		await Bun.$`docker network rm crash-left-prior-net`.quiet().nothrow();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

dockerTest("failed bring-up stops both containers before removing the network and proves absence", async () => {
	const { cwd, revision } = await createProofRepo();
	const config = proofConfig(image);
	config.runtime.control_config = { ...config.runtime.control_config, bootstrap_command: ["sh", "-c", "exit 3"] };
	const error = await createBennyWorkspace({
		config,
		cwd,
		runId: "teardown-order",
		revision,
		artifactDir: ".omp/pstack/state/benny-evidence",
		deadline: Date.now() + 5 * 60_000,
	}).catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(WorkspaceBlockError);
	expect((error as Error).message).toMatch(/dependency bootstrap failed/);
	// Containers-first ordering: the network removal succeeds after both
	// containers detach, so no teardown failure is appended and the final
	// probe proved every tracked resource absent.
	expect((error as Error).message).not.toMatch(/teardown/);
	const leftContainers = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.run-id=teardown-order`.quiet().nothrow();
	expect(leftContainers.stdout.toString().trim()).toBe("");
	const leftNetworks = await Bun.$`docker network ls --format {{.Names}} --filter label=pstack.benny.run-id=teardown-order`.quiet().nothrow();
	expect(leftNetworks.stdout.toString().trim()).toBe("");
	await rm(cwd, { recursive: true, force: true });
}, { timeout: 5 * 60_000 });

dockerTest("cleanup fails closed when the final inspect is unprovable and retains the run root", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-docker-shim-"));
	const realDocker = (await Bun.$`which docker`.quiet()).stdout.toString().trim();
	if (!realDocker) throw new Error("no docker binary on PATH to shim");
	const poison = join(shimDir, "poison");
	// Injected Docker: a proxy shim that forwards every call to the real
	// daemon unchanged — bring-up and the teardown mutations all succeed —
	// but after the cleanup path's network rm succeeds, every subsequent
	// container/raw/network inspect degrades to a daemon-style failure
	// (timeout/permission class: nonzero exit, "cannot connect" stderr).
	await writeFile(
		join(shimDir, "docker"),
		[
			"#!/bin/sh",
			`DOCKER='${realDocker}'`,
			`POISON='${poison}'`,
			`COUNT='${shimDir}/netrm-count'`,
			`if [ "$1" = "network" ] && [ "$2" = "rm" ]; then`,
			`	"$DOCKER" "$@"`,
			`	code=$?`,
			`	n=$((n+$(cat "$COUNT" 2>/dev/null || echo 0)))`,
			`	n=$((n+1)); echo "$n" > "$COUNT"`,
			`	[ "$n" -ge 2 ] && : > "$POISON"`,
			`	exit "$code"`,
			`fi`,
			`case "$1-$2" in`,
			`container-inspect|inspect-*)`,
			`	if [ -f "$POISON" ]; then`,
			`		echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2`,
			`		exit 1`,
			`	fi`,
			`	;;`,
			`esac`,
			`exec "$DOCKER" "$@"`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const runId = "unprovable-final";
	// Bun.spawn resolves executables against its startup PATH snapshot, so a
	// PATH edit never reaches the workspace's docker calls; intercept the
	// spawn itself and route every `docker` invocation through the shim.
	const realSpawn = Bun.spawn;
	const shim = join(shimDir, "docker");
	Bun.spawn = ((argv, options) => realSpawn(typeof argv === "string" ? argv : argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv, options)) as typeof Bun.spawn;
	let error: unknown;
	try {
		const workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		error = await workspace.cleanup().catch((failure: unknown) => failure);
	} finally {
		Bun.spawn = realSpawn;
	}
	expect(error).toBeInstanceOf(WorkspaceBlockError);
	const message = (error as Error).message;
	// The daemon-style container-inspect failure is NOT accepted as absence:
	// cleanup fails and names each unproven container with the probe detail.
	// The network inspect stayed live, so its proven absence must NOT be
	// named as unverified.
	expect(message).toMatch(/workspace cleanup did not prove absence/);
	expect(message).toMatch(new RegExp(`benny-ws-${runId}-[0-9a-f]+-ctl \\(ownership unprovable: Cannot connect to the Docker daemon`));
	expect(message).toMatch(new RegExp(`benny-ws-${runId}-[0-9a-f]+ \\(ownership unprovable: Cannot connect`));
	expect(message).not.toMatch(new RegExp(`benny-ws-${runId}-[0-9a-f]+-net`));
	// The disposable run root survives a cleanup that could not prove absence.
	expect((await lstat(join(cwd, ".omp", "pstack", "state", "benny", runId))).isDirectory()).toBe(true);
	// The teardown mutations themselves already succeeded: nothing is left
	// behind for the failed final probe round to hide.
	expect((await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.run-id=${runId}`.quiet().nothrow()).stdout.toString().trim()).toBe("");
	expect((await Bun.$`docker network ls --format {{.Names}} --filter label=pstack.benny.run-id=${runId}`.quiet().nothrow()).stdout.toString().trim()).toBe("");
	await rm(shimDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
}, { timeout: 10 * 60_000 });

// ---------------------------------------------------------------------------
// Construction failure boundary: any failure after the first run-root
// mutation removes the exact contained non-symlink run root and every
// acquired Docker resource, proves absence, and aggregates cleanup failures
// into the rejection — no caller cleanup handle exists. Daemon-free: a
// docker shim resolves the image reference, proves resource absence by
// inspect, and refuses every mutation like a down daemon.
// ---------------------------------------------------------------------------

const FAKE_IMAGE_ID = `sha256:${"ab".repeat(32)}`;

async function writeConstructionShim(dir: string, mode: "absent" | "daemon-down"): Promise<string> {
	const lines = [
		"#!/bin/sh",
		`if [ "$1 $2" = "image inspect" ]; then echo '${FAKE_IMAGE_ID}'; exit 0; fi`,
	];
	if (mode === "absent") {
		lines.push(
			`case "$1" in`,
			`	container|network|volume)`,
			`		if [ "$2" = "inspect" ]; then echo "Error: No such $1: never-created" >&2; exit 1; fi`,
			`		;;`,
			`esac`,
			`if [ "$1" = "ps" ] || [ "$2" = "ls" ]; then exit 0; fi`,
		);
	}
	lines.push(
		'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2',
		"exit 1",
		"",
	);
	const shim = join(dir, "docker");
	await writeFile(shim, lines.join("\n"), { mode: 0o755 });
	return shim;
}

async function failScript(dir: string, name: string, message: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
	return path;
}

function interceptSpawn(redirect: (argv: string[]) => string[]): () => void {
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv: string | string[], options?: Parameters<typeof Bun.spawn>[1]) => {
		const command = Array.isArray(argv) ? redirect(argv) : [argv];
		return realSpawn(command, options);
	}) as typeof Bun.spawn;
	return () => {
		Bun.spawn = realSpawn;
	};
}

interface BoundaryOptions {
	runId: string;
	revision: string;
	cwd: string;
}

async function boundaryCall({ cwd, runId, revision }: BoundaryOptions): Promise<Error> {
	try {
		const workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		await workspace.cleanup();
		return new Error("workspace construction unexpectedly succeeded");
	} catch (failure) {
		return failure instanceof Error ? failure : new Error(String(failure));
	}
}

async function expectRunRootGone(cwd: string, runId: string): Promise<void> {
	await expect(lstat(join(cwd, ".omp", "pstack", "state", "benny", runId))).rejects.toMatchObject({ code: "ENOENT" });
}

test("construction failure boundary: a git init failure removes the run root and proves the intended Docker names absent", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-boundary-git-"));
	const shim = await writeConstructionShim(shimDir, "absent");
	const failGit = await failScript(shimDir, "fail-git", "injected git failure");
	const runId = "git-fail";
	// Inject: every git invocation inside the run's private state tree fails;
	// docker goes through the absence shim.
	const restore = interceptSpawn(argv =>
		argv[0] === "git" && argv.some(part => part.includes(".omp/pstack/state/benny/"))
			? [failGit, ...argv.slice(1)]
			: argv[0] === "docker"
				? [shim, ...argv.slice(1)]
				: argv,
	);
	try {
		const error = await boundaryCall({ cwd, runId, revision });
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect(error.message).toMatch(/cannot initialize the isolated snapshot Git directory/);
		// Teardown proved the tracked names absent and the run root was
		// removed: nothing is aggregated into the rejection.
		expect(error.message).not.toMatch(/failure cleanup/);
		await expectRunRootGone(cwd, runId);
	} finally {
		restore();
		await rm(shimDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("construction failure boundary: a materialization failure removes the run root", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-boundary-mat-"));
	const shim = await writeConstructionShim(shimDir, "absent");
	const runId = "materialize-fail";
	const restore = interceptSpawn(argv => (argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv));
	try {
		const error = await boundaryCall({ cwd, runId, revision: "does-not-exist" });
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect(error.message).toMatch(/revision 'does-not-exist' is not resolvable/);
		expect(error.message).not.toMatch(/failure cleanup/);
		await expectRunRootGone(cwd, runId);
	} finally {
		restore();
		await rm(shimDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("construction failure boundary: a manifest computation failure removes the run root", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-boundary-man-"));
	const shim = await writeConstructionShim(shimDir, "absent");
	const failSh = await failScript(shimDir, "fail-sh", "injected manifest failure");
	const runId = "manifest-fail";
	// Inject: the host manifest pipeline over the run's worktree fails.
	const restore = interceptSpawn(argv =>
		argv[0] === "sh" && typeof argv[1] === "string" && argv.slice(1).some(part => part.includes(".omp/pstack/state/benny/"))
			? [failSh]
			: argv[0] === "docker"
				? [shim, ...argv.slice(1)]
				: argv,
	);
	try {
		const error = await boundaryCall({ cwd, runId, revision });
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect(error.message).toMatch(/manifest computation failed/);
		expect(error.message).not.toMatch(/failure cleanup/);
		await expectRunRootGone(cwd, runId);
	} finally {
		restore();
		await rm(shimDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("construction failure boundary: a pre-volume listing failure removes the run root and aggregates unproven absences", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-boundary-pre-"));
	// The daemon-down shim resolves the image reference but refuses every
	// other call: the pre-volume reclaim listing cannot prove its state.
	const shim = await writeConstructionShim(shimDir, "daemon-down");
	const runId = "pre-volume-fail";
	const restore = interceptSpawn(argv => (argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv));
	try {
		const error = await boundaryCall({ cwd, runId, revision });
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect(error.message).toMatch(/could not be reclaimed/);
		// Cleanup could not prove the tracked names absent (the daemon is
		// down), so those probe failures are aggregated into the rejection.
		expect(error.message).toMatch(/failure cleanup/);
		expect(error.message).toMatch(/ownership unprovable/);
		// The run root itself was still removed and its absence proven.
		await expectRunRootGone(cwd, runId);
	} finally {
		restore();
		await rm(shimDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("construction failure boundary: a symlinked run root is never followed or removed and fails closed", async () => {
	const { cwd, revision } = await createProofRepo();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-boundary-link-"));
	const shim = await writeConstructionShim(shimDir, "absent");
	const runId = "symlink-root";
	const victim = await mkdtemp(join(tmpdir(), "benny-victim-"));
	await writeFile(join(victim, "keep.txt"), "keep");
	await mkdir(join(cwd, ".omp", "pstack", "state", "benny"), { recursive: true });
	await symlink(victim, join(cwd, ".omp", "pstack", "state", "benny", runId));
	const restore = interceptSpawn(argv => (argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv));
	try {
		const error = await boundaryCall({ cwd, runId, revision });
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect(error.message).toMatch(/private run directory must not be a symlink/);
		// The cleanup refused to remove the symlinked root — recorded, never
		// silent, never followed.
		expect(error.message).toMatch(/is a symlink; refusing to remove it/);
		expect((await lstat(join(cwd, ".omp", "pstack", "state", "benny", runId))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("keep");
	} finally {
		restore();
		await rm(shimDir, { recursive: true, force: true });
		await rm(victim, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

test("reviewMedia blocks on an unavailable media review model with the exact prerequisite", async () => {
	const config = proofConfig(image);
	config.models.media_review = "absent-provider/absent-model";
	// Bind to the real immutable image id when the daemon is available; the
	// model-prerequisite check fires before any decode, so a well-formed id
	// suffices when Docker is absent.
	const imageId = hasDocker ? await resolveImageId(image) : `sha256:${"0".repeat(64)}`;
	const error = await reviewMedia({ config, artifacts: [], prompt: "q", deadline: Date.now() + 60_000, imageId }).catch(
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(WorkspaceBlockError);
	expect((error as Error).message).toMatch(/unavailable|credentials/i);
});

dockerTest("clean checkout has no .git in the container view and matches the pinned revision", async () => {
	let workspace: BennyWorkspace | undefined;
	const { cwd, revision } = await createProofRepo();
	try {
		workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: `checkout-${Date.now()}`,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		expect(workspace.revision).toBe(revision);
		expect(workspace.baselineHash).toMatch(/^[0-9a-f]{40}$/);
		// isExecResult narrowing is re-exported shape-checking for call() results.
		const gitProbe = await workspace.call("exec", { command: ["test", "-e", "/workspace/.git"] }, "study");
		const gitAbsent = typeof gitProbe === "object" && gitProbe !== null && "exitCode" in gitProbe && gitProbe.exitCode === 1;
		expect(gitAbsent).toBe(true);
		const listProbe = await workspace.call("read", { path: "app/index.html" }, "study");
		const html =
			typeof listProbe === "object" && listProbe !== null && "base64" in listProbe && typeof listProbe.base64 === "string"
				? Buffer.from(listProbe.base64, "base64").toString("utf8")
				: "";
		expect(html).toContain("benny-fixture-counter");
	} finally {
		if (workspace) await workspace.cleanup();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

dockerTest(
	"real container proof: broken twice with independent resets, patched twice, every boundary attempt denied",
	async () => {
		const proof = await runProof({ deadlineMs: 15 * 60_000 });
		expect(proof.baseline).toHaveLength(2);
		expect(proof.patched).toHaveLength(2);
		for (const trial of proof.baseline) {
			expect(trial.observed).toBe("broken");
			expect(trial.observedValue).toBe("0");
			expect(trial.recordingFrames).toBeGreaterThanOrEqual(1);
			for (const artifact of trial.artifacts) expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(trial.artifacts.map(artifact => artifact.mimeType)).toEqual(expect.arrayContaining(["image/png", "video/webm"]));
		}
		for (const trial of proof.patched) expect(trial.observed).toBe("correct");
		expect(proof.baseline[0]!.resetId).not.toBe(proof.baseline[1]!.resetId);
		expect(proof.patched[0]!.resetId).not.toBe(proof.patched[1]!.resetId);
		// Every control receipt is host-stamped with run/revision.
		expect(proof.controlIds.length).toBeGreaterThanOrEqual(11);
		// All adversarial boundary attempts were denied.
		expect(proof.allBlocked).toBe(true);
		expect(proof.blockedProbes).toEqual([]);
		expect(proof.cleanup.removed).toContain(proof.cleanup.stopped[0]);
	},
	{ timeout: 15 * 60_000 },
);

test("absence proof accepts only proven absence; still-present and unprovable resources are named", () => {
	expect(unverifiedAbsent([
		{ resource: "gone", probe: { present: false } },
		{ resource: "stuck", probe: { present: true, labels: {} } },
		{ resource: "dim", probe: { present: "unknown", detail: "docker exit 1" } },
	])).toEqual(["stuck", "dim (ownership unprovable: docker exit 1)"]);
});

/**
 * Fixture repo whose `.gitattributes` declares `excluded/ export-ignore` and
 * whose HEAD is hidden behind a `git replace` decoy commit with a different
 * tree. A resolver honoring replacements, or `git archive`, must never see
 * the admitted content.
 */
async function createAdmittedRepo(): Promise<{ cwd: string; revision: string; admittedTree: string; replacedTree: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "benny-admitted-"));
	await mkdir(join(cwd, "excluded"), { recursive: true });
	await Bun.write(join(cwd, "app.txt"), "app\n");
	await Bun.write(join(cwd, "excluded/hidden.txt"), "secret\n");
	await Bun.write(join(cwd, ".gitattributes"), "excluded/ export-ignore\n");
	await Bun.$`git -C ${cwd} init -q -b main`.quiet();
	await Bun.$`git -C ${cwd} add -A`.quiet();
	await Bun.$`git -C ${cwd} -c user.email=t@t -c user.name=t commit -qm one`.quiet();
	const revision = (await Bun.$`git --no-replace-objects -C ${cwd} rev-parse HEAD`.quiet()).stdout.toString().trim();
	const admittedTree = (await Bun.$`git --no-replace-objects -C ${cwd} rev-parse HEAD^{tree}`.quiet()).stdout.toString().trim();
	await Bun.$`git -C ${cwd} checkout -qb decoy`.quiet();
	await Bun.$`rm ${join(cwd, "excluded/hidden.txt")}`.quiet();
	await Bun.$`git -C ${cwd} add -A`.quiet();
	await Bun.$`git -C ${cwd} -c user.email=t@t -c user.name=t commit -qm decoy`.quiet();
	const decoyCommit = (await Bun.$`git -C ${cwd} rev-parse HEAD`.quiet()).stdout.toString().trim();
	await Bun.$`git -C ${cwd} checkout -q main`.quiet();
	await Bun.$`git -C ${cwd} replace ${revision} ${decoyCommit}`.quiet();
	const replacedTree = (await Bun.$`git -C ${cwd} rev-parse HEAD^{tree}`.quiet()).stdout.toString().trim();
	expect(replacedTree).not.toBe(admittedTree); // the decoy actually bites naive resolvers
	return { cwd, revision, admittedTree, replacedTree };
}

test("materialization is the admitted non-replaced tree: export-ignore cannot omit tracked files and git replace cannot swap the audited tree", async () => {
	const repo = await createAdmittedRepo();
	const runRoot = await mkdtemp(join(tmpdir(), "benny-materialize-"));
	try {
		const workspacePath = join(runRoot, "worktree");
		await mkdir(workspacePath, { recursive: true });
		const snapshotGitDir = join(runRoot, "snapshot", ".git");
		await Bun.$`git init -q ${join(runRoot, "snapshot")}`.quiet();
		const materialized = await materializeAdmittedTree(repo.cwd, repo.revision, workspacePath, snapshotGitDir, {
			PATH: "/usr/bin:/bin",
			HOME: runRoot,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
		});
		expect(materialized.tree).toBe(repo.admittedTree);
		// `git archive` (export-ignore) omits this tracked file; the materialization must not:
		const archive = await Bun.$`git -C ${repo.cwd} archive ${repo.revision} | tar -tf -`.quiet();
		expect(archive.stdout.toString()).not.toContain("excluded/hidden.txt");
		expect(await Bun.file(join(workspacePath, "excluded/hidden.txt")).text()).toBe("secret\n");
	} finally {
		await rm(repo.cwd, { recursive: true, force: true });
		await rm(runRoot, { recursive: true, force: true });
	}
});

dockerTest("workspace bring-up materializes the admitted tree: export-ignore and replace refs cannot drop or swap tracked files", async () => {
	const repo = await createAdmittedRepo();
	try {
		const workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd: repo.cwd,
			runId: "admitted-tree",
			revision: repo.revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		try {
			expect(workspace.baselineHash).toBe(repo.admittedTree);
			// The export-ignored tracked file reached the container view:
			const read = await workspace.call("read", { path: "excluded/hidden.txt" }, "study");
			const record = read as { size: number; sha256: string; base64: string };
			expect(record.size).toBe("secret\n".length);
			expect(Buffer.from(record.base64, "base64").toString("utf8")).toBe("secret\n");
		} finally {
			await workspace.cleanup();
		}
	} finally {
		await rm(repo.cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

dockerTest("decodeVideoFrames runs a uniquely named hardened decoder whose input/output staging is a bounded volume and proves both absent", async () => {
	const videoDir = await mkdtemp(join(tmpdir(), "benny-decode-"));
	const generated = await Bun.$`docker run --rm -v ${videoDir}:/out ${image} ffmpeg -v error -f lavfi -i testsrc=duration=2:size=128x96:rate=4 -c:v libvpx -an /out/clip.webm`.quiet().nothrow();
	expect(generated.exitCode).toBe(0);
	const video = await readFile(join(videoDir, "clip.webm"));
	const captured: string[][] = [];
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv, options) => {
		if (Array.isArray(argv) && argv[0] === "docker") captured.push([...argv]);
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	let frames: DecodedFrame[] = [];
	try {
		frames = await decodeVideoFrames(image, video, { maxFrames: 3 });
	} finally {
		Bun.spawn = realSpawn;
	}
	expect(frames).toHaveLength(3);
	for (const frame of frames) {
		expect(detectMediaMime(frame.data)).toBe("image/png");
		expect(frame.timestampMs).toBeGreaterThanOrEqual(0);
	}
	expect(frames[0]!.timestampMs).toBe(0);
	expect(frames[2]!.timestampMs).toBeGreaterThan(0);
	const runArgv = captured.find((argv) => argv[1] === "run");
	expect(runArgv).toBeDefined();
	const a = runArgv!;
	// No --rm: an ambiguous run outcome must stay reconcilable by name+labels.
	expect(a).not.toContain("--rm");
	const decoderName = a[a.indexOf("--name") + 1]!;
	expect(decoderName).toMatch(/^benny-media-[0-9a-f]{16}$/);
	expect(a).toContain("-d");
	expect(a[a.indexOf("--network") + 1]).toBe("none");
	expect(a[a.indexOf("--user") + 1]).toBe("1000:1000");
	expect(a[a.indexOf("--cap-drop") + 1]).toBe("ALL");
	expect(a[a.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
	expect(a).toContain("--read-only");
	// /tmp and /dev/shm: explicit byte AND inode tmpfs bounds.
	expect(a[a.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,noexec,nosuid,size=536870912,nr_inodes=65536");
	expect(a[a.indexOf("--tmpfs", a.indexOf("--tmpfs") + 1) + 1]).toBe("/dev/shm:rw,noexec,nosuid,size=268435456,nr_inodes=65536");
	expect(a[a.indexOf("--memory") + 1]).toBe(WORKSPACE_LIMITS.decoderMemory);
	expect(a[a.indexOf("--memory-swap") + 1]).toBe(WORKSPACE_LIMITS.decoderMemory);
	expect(a[a.indexOf("--pids-limit") + 1]).toBe("256");
	expect(a[a.indexOf("--cpus") + 1]).toBe("2");
	// I/O staging is a bounded volume mount, never an ordinary host bind.
	const volumeName = `${decoderName}-work`;
	expect(a).toContain(`-v`);
	expect(a[a.indexOf("-v") + 1]).toBe(`${volumeName}:/work:rw`);
	expect(a.slice(-2)).toEqual(["sleep", "infinity"]);
	const labels = a.flatMap((arg, index) => (arg === "--label" ? [a[index + 1]!] : []));
	expect(labels).toContain("pstack.benny.managed=true");
	expect(labels).toContain("pstack.benny.run-id=media");
	expect(labels).toContain("pstack.benny.role=media");
	expect(labels).toContain(`pstack.benny.incarnation=${decoderName.slice("benny-media-".length)}`);
	// The staging volume is created with the exact bounded tmpfs definition.
	const volumeArgv = captured.find((argv) => argv[1] === "volume" && argv[2] === "create");
	expect(volumeArgv).toBeDefined();
	const v = volumeArgv!;
	expect(v[v.indexOf("--driver") + 1]).toBe("local");
	expect(v[v.indexOf("--opt", v.indexOf("device=tmpfs") + 1) + 1]).toBe(`o=rw,noexec,nosuid,size=805306368,nr_inodes=8192,uid=1000,gid=1000`);
	const volumeLabels = v.flatMap((arg, index) => (arg === "--label" ? [v[index + 1]!] : []));
	expect(volumeLabels).toContain("pstack.benny.role=media-storage");
	expect(volumeLabels).toContain("pstack.benny.run-id=media");
	// The decode itself ran as one ffmpeg exec inside the hardened container.
	const execArgv = captured.find((argv) => argv[1] === "exec" && argv.includes("ffmpeg"));
	expect(execArgv).toBeDefined();
	expect(execArgv!.includes(decoderName)).toBe(true);
	expect(execArgv).toContain("-vf");
	// The exited decoder AND its staging volume were removed with proven absence.
	expect((await Bun.$`docker inspect ${decoderName}`.quiet().nothrow()).exitCode).not.toBe(0);
	expect((await Bun.$`docker volume inspect ${volumeName}`.quiet().nothrow()).exitCode).not.toBe(0);
	await rm(videoDir, { recursive: true, force: true });
}, { timeout: 5 * 60_000 });

dockerTest("a failed decode reconciles its decoder container AND staging volume by exact labels and proves absence", async () => {
	// EBML magic wrapping garbage: ffmpeg fails, the container and volume
	// linger, and the decode must still reconcile both by exact ownership labels.
	const error = await decodeVideoFrames(image, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), {}).catch(
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(WorkspaceBlockError);
	expect((error as Error).message).toMatch(/video decode failed/);
	const left = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.role=media`.quiet().nothrow();
	expect(left.stdout.toString().trim()).toBe("");
	const leftVolumes = await Bun.$`docker volume ls --format {{.Name}} --filter label=pstack.benny.role=media-storage`.quiet().nothrow();
	expect(leftVolumes.stdout.toString().trim()).toBe("");
}, { timeout: 5 * 60_000 });

dockerTest("an aborted decode reconciles its running decoder container and staging volume by exact labels and proves absence", async () => {
	const realSpawn = Bun.spawn;
	// The decode EXEC is replaced with `sleep 30` so the abort lands while
	// the daemon container is deterministically still RUNNING — no ffmpeg
	// speed racing. The run itself keeps its real shape (hardened sleep).
	Bun.spawn = ((argv, options) => {
		if (Array.isArray(argv) && argv[0] === "docker" && argv[1] === "exec" && argv.includes("ffmpeg")) {
			const head = argv.slice(1, argv.indexOf("ffmpeg"));
			return realSpawn(["docker", ...head, "sleep", "30"], options);
		}
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	const controller = new AbortController();
	try {
		const decodePromise = decodeVideoFrames(image, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { maxFrames: 2, signal: controller.signal });
		// Poll the real daemon until the decoder container exists; the awaited
		// condition is external Docker state, which fake timers cannot drive.
		let decoderName = "";
		for (let attempt = 0; attempt < 100 && !decoderName; attempt++) {
			const listed = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.role=media`.quiet().nothrow();
			decoderName = listed.stdout.toString().trim();
			if (!decoderName) await Bun.sleep(100);
		}
		expect(decoderName).toMatch(/^benny-media-[0-9a-f]{16}$/);
		const running = await Bun.$`docker inspect -f {{.State.Running}} ${decoderName}`.quiet().nothrow();
		expect(running.stdout.toString().trim()).toBe("true");
		controller.abort();
		const error = await decodePromise.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		// The abort can land anywhere between container readiness and the
		// decode exec; the exact message varies but the failure is API-level.
		expect((error as Error).message.length).toBeGreaterThan(0);
		// The interrupted decoder container AND its staging volume were
		// reconciled by their exact ownership labels; absence is proven.
		const left = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.role=media`.quiet().nothrow();
		expect(left.stdout.toString().trim()).toBe("");
		const leftVolumes = await Bun.$`docker volume ls --format {{.Name}} --filter label=pstack.benny.role=media-storage`.quiet().nothrow();
		expect(leftVolumes.stdout.toString().trim()).toBe("");
	} finally {
		Bun.spawn = realSpawn;
		await Bun.$`docker ps -aq --filter label=pstack.benny.role=media | xargs -r docker rm -f`.quiet().nothrow();
		await Bun.$`docker volume ls -q --filter label=pstack.benny.role=media-storage | xargs -r docker volume rm`.quiet().nothrow();
	}
}, { timeout: 2 * 60_000 });

dockerTest("a failed controller stop still attempts the worker, the network, and every final probe while retaining the run root", async () => {
	const { cwd, revision } = await createProofRepo();
	const realDocker = (await Bun.$`which docker`.quiet()).stdout.toString().trim();
	const shimDir = await mkdtemp(join(tmpdir(), "benny-stop-shim-"));
	// Poison ONLY container stops of the controller (`benny-ws-*-ctl`): the
	// adapter cleanup, the outer controller stop, and (via the attached
	// endpoint) the network removal all fail, while the worker stop hits the
	// real daemon and succeeds.
	await writeFile(
		join(shimDir, "docker"),
		[
			"#!/bin/sh",
			`REAL='${realDocker}'`,
			`if [ "$1" = "stop" ] || { [ "$1" = "container" ] && [ "$2" = "stop" ]; }; then`,
			`	for arg in "$@"; do`,
			`		case "$arg" in benny-ws-*-ctl)`,
			`			echo "simulated controller stop failure" >&2`,
			`			exit 1;;`,
			`		esac`,
			`	done`,
			`fi`,
			`exec "$REAL" "$@"`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const runId = `stopfail-${Date.now()}`;
	const realSpawn = Bun.spawn;
	const shim = join(shimDir, "docker");
	Bun.spawn = ((argv, options) => realSpawn(typeof argv === "string" ? argv : argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv, options)) as typeof Bun.spawn;
	let error: unknown;
	try {
		const workspace = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		});
		error = await workspace.cleanup().catch((failure: unknown) => failure);
	} finally {
		Bun.spawn = realSpawn;
	}
	expect(error).toBeInstanceOf(WorkspaceBlockError);
	const message = (error as Error).message;
	// The adapter cleanup ran but its controller stop hit the same poison and
	// was captured, not fatal.
	expect(message).toMatch(/control adapter cleanup failed/);
	// The outer controller stop was still attempted and its exact failure kept.
	expect(message).toMatch(/container 'benny-ws-.*-ctl' stop\/remove failed/);
	expect(message.match(/stop\/remove failed/g)).toHaveLength(1);
	// The worker stop was attempted despite the sibling failure: no worker
	// stop failure is reported and its absence is proven below.
	// The network removal was attempted (twice) despite both stop failures.
	expect(message).toMatch(/network 'benny-ws-.*-net' removal failed/);
	// Every final probe ran: the controller and network are named unproven,
	// the worker is NOT (its absence was proven).
	expect(message).toMatch(/did not prove absence of benny-ws-.*-ctl/);
	expect(message).toMatch(/did not prove absence of benny-ws-.*-net/);
	const incarnation = message.match(new RegExp(`benny-ws-${runId}-([0-9a-f]{16})-ctl`))?.[1];
	expect(incarnation).toMatch(/^[0-9a-f]{16}$/);
	expect(message).not.toContain(`did not prove absence of benny-ws-${runId}-${incarnation} `);
	// Unproven absence retains the disposable run root.
	expect((await lstat(join(cwd, ".omp", "pstack", "state", "benny", runId))).isDirectory()).toBe(true);
	// The worker was actually removed by the attempted teardown.
	expect(
		(await Bun.$`docker inspect benny-ws-${runId}-${incarnation}`.quiet().nothrow()).exitCode,
	).not.toBe(0);
	// Leftovers of the poisoned controller/network are cleaned with real docker.
	await Bun.$`docker rm -f benny-ws-${runId}-${incarnation} benny-ws-${runId}-${incarnation}-ctl`.quiet().nothrow();
	await Bun.$`docker network rm benny-ws-${runId}-${incarnation}-net`.quiet().nothrow();
	await rm(shimDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
}, { timeout: 10 * 60_000 });

dockerTest("a pre-existing network carrying our labels plus an EXTRA label is foreign: adoption and removal are refused", async () => {
	const { cwd, revision } = await createProofRepo();
	const incarnation = "4567890123abcdef";
	const identity = workspaceIdentity("extra-label", incarnation);
	const owned = ownershipLabels(identity, "network");
	const labelsArgv = Object.entries({ ...owned, "pstack.benny.evil": "1" }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
	await Bun.$`docker network create ${labelsArgv} ${identity.network}`.quiet().nothrow();
	try {
		const error = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId: "extra-label",
			incarnation,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		// The extra ownership-namespace label is refused — during reclaim
		// (fail-closed) or at the adopt probe, whichever runs first.
		expect((error as Error).message).toMatch(/refusing to (adopt|stop\/remove)/);
		expect((error as Error).message).toMatch(/exact label set/);
		// The foreign resource was untouched, and nothing was created for this run.
		expect((await Bun.$`docker network inspect ${identity.network}`.quiet().nothrow()).exitCode).toBe(0);
		const created = await Bun.$`docker ps -a --format {{.Names}} --filter label=pstack.benny.run-id=extra-label`.quiet().nothrow();
		expect(created.stdout.toString().trim()).toBe("");
	} finally {
		await Bun.$`docker network rm ${identity.network}`.quiet().nothrow();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

dockerTest("partial volume bring-up is all-settled cleaned and absence-proven: a failing first or second volume create leaves no resource", async () => {
	for (const failAt of [1, 2]) {
		const { cwd, revision } = await createProofRepo();
		const runId = "volfail";
		const incarnation = `000000000000000${failAt}`;
		const realSpawn = Bun.spawn;
		let volumeCreates = 0;
		Bun.spawn = ((argv, options) => {
			if (Array.isArray(argv) && argv[0] === "docker" && argv[1] === "volume" && argv[2] === "create") {
				volumeCreates += 1;
				if (volumeCreates === failAt) {
					return realSpawn(["sh", "-c", "echo 'simulated volume create failure' >&2; exit 1"], options);
				}
			}
			return realSpawn(argv, options);
		}) as typeof Bun.spawn;
		try {
			const error = await createBennyWorkspace({
				config: proofConfig(image),
				cwd,
				runId,
				incarnation,
				revision,
				artifactDir: ".omp/pstack/state/benny-evidence",
				deadline: Date.now() + 5 * 60_000,
			}).catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(WorkspaceBlockError);
			expect((error as Error).message).toMatch(/workspace volume create failed/);
			expect((error as Error).message).not.toMatch(/teardown/);
			// The failure guard cleaned EVERY partially created resource.
			for (const [argv, filter] of [
				[["ps", "-a"], "containers"],
				[["network", "ls"], "networks"],
				[["volume", "ls"], "volumes"],
			] as const) {
				const left = await Bun.$`docker ${argv} --format {{.Names}} --filter label=pstack.benny.run-id=volfail`.quiet().nothrow();
				expect(left.stdout.toString().trim(), `leftover ${filter} after volume failure ${failAt}`).toBe("");
			}
		} finally {
			Bun.spawn = realSpawn;
			await rm(cwd, { recursive: true, force: true });
		}
	}
}, { timeout: 10 * 60_000 });

dockerTest("a container whose actual mounts are unprovable fails closed before any command and leaves no resource", async () => {
	const { cwd, revision } = await createProofRepo();
	const runId = "mountgate";
	const realSpawn = Bun.spawn;
	// The mount inspection of any mountgate workspace container reports an
	// EMPTY mount list: the verification must fail closed before seed,
	// bootstrap, or any model/exec action, and the guard must clean up.
	Bun.spawn = ((argv, options) => {
		if (
			Array.isArray(argv) && argv[0] === "docker" && argv[1] === "inspect"
			&& argv[2] === "-f" && argv[3] === "{{json .Mounts}}"
			&& /^benny-ws-mountgate-/.test(argv[4] ?? "")
		) {
			return realSpawn(["sh", "-c", "echo '[]'"], options);
		}
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	try {
		const error = await createBennyWorkspace({
			config: proofConfig(image),
			cwd,
			runId,
			revision,
			artifactDir: ".omp/pstack/state/benny-evidence",
			deadline: Date.now() + 5 * 60_000,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect((error as Error).message).toMatch(/mount verification failed/);
		for (const argv of [["ps", "-a"], ["network", "ls"], ["volume", "ls"]] as const) {
			const left = await Bun.$`docker ${argv} --format {{.Names}} --filter label=pstack.benny.run-id=mountgate`.quiet().nothrow();
			expect(left.stdout.toString().trim()).toBe("");
		}
	} finally {
		Bun.spawn = realSpawn;
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 10 * 60_000 });

dockerTest("fix copy-back freezes the worker first and lands a Git-tree-faithful copy: exec bits, symlinks, racing writer", async () => {
	const incarnation = "8765432109abcdef";
	const identity = workspaceIdentity("copyback", incarnation);
	const { cwd, revision } = await createProofRepo();
	const workspace = await createBennyWorkspace({
		config: proofConfig(image),
		cwd,
		runId: "copyback",
		incarnation,
		revision,
		artifactDir: ".omp/pstack/state/benny-evidence",
		deadline: Date.now() + 10 * 60_000,
	});
	const captured: string[][] = [];
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv, options) => {
		if (Array.isArray(argv) && argv[0] === "docker") captured.push([...argv]);
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	try {
		await workspace.call("read", { path: "app/index.html" }, "study");
		await workspace.call("write", { path: "patch-marker.txt", content: "patched\n" }, "fix");
		// Fix-stage artifacts the manifest must carry faithfully: an
		// executable bit, a symlink (whose target must never be followed),
		// and a still-running background writer that a live copy could race.
		await workspace.call(
			"exec",
			{ command: ["sh", "-c", "printf '#!/bin/sh\\necho ok\\n' > /workspace/exec-bit.sh; chmod 755 /workspace/exec-bit.sh; ln -s app/index.html /workspace/link-to-app; nohup sh -c 'while :; do echo x >> /workspace/race.bin 2>/dev/null || break; done' >/dev/null 2>&1 &"] },
			"fix",
		);
		await workspace.call("read", { path: "app/index.html" }, "verify");
		// Host worktree: the write, the exec bit, the symlink target, and the
		// frozen prefix of the race file all landed; nothing followed links.
		expect(await Bun.file(join(workspace.workspacePath, "patch-marker.txt")).text()).toBe("patched\n");
		const execBit = await lstat(join(workspace.workspacePath, "exec-bit.sh"));
		expect(execBit.isFile()).toBe(true);
		expect(execBit.mode & 0o111).toBe(0o111);
		const link = await lstat(join(workspace.workspacePath, "link-to-app"));
		expect(link.isSymbolicLink()).toBe(true);
		expect(await Bun.file(join(workspace.workspacePath, "app/index.html")).text()).not.toBe("");
		const raced = await lstat(join(workspace.workspacePath, "race.bin"));
		expect(raced.isFile()).toBe(true);
		// Ordering: the worker was FROZEN by an in-container process sweep
		// (the tmpfs-backed fix volume would be WIPED by a stop/start cycle)
		// BEFORE the authoritative in-container manifest and BEFORE the
		// copy-back; no cp from the worker touched the host between the
		// freeze and the manifest.
		const indexLast = (match: (argv: string[]) => boolean, before: number) => {
			for (let index = before - 1; index >= 0; index--) if (match(captured[index]!)) return index;
			return -1;
		};
		const isCpFromWorker = (argv: string[]) => argv[1] === "cp" && argv.some(arg => arg.startsWith(`${identity.worker}:`));
		const isManifestExec = (argv: string[]) => argv[1] === "exec" && argv.some(arg => typeof arg === "string" && arg.includes("sha256sum"));
		const cpBackAt = indexLast(isCpFromWorker, captured.length);
		const manifestAt = indexLast(isManifestExec, cpBackAt);
		const freezeAt = indexLast(argv => argv[1] === "exec" && argv.some(arg => typeof arg === "string" && arg.includes("kill -9")), manifestAt);
		expect(cpBackAt).toBeGreaterThan(-1);
		expect(freezeAt).toBeGreaterThan(-1);
		expect(freezeAt).toBeLessThan(manifestAt);
		expect(manifestAt).toBeLessThan(cpBackAt);
		const racedCps = captured.slice(freezeAt, manifestAt).filter(isCpFromWorker);
		expect(racedCps).toEqual([]);
	} finally {
		Bun.spawn = realSpawn;
		await workspace.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

dockerTest("fix-to-verify swaps the writable fix worker for a read-only worker before any verify tool call", async () => {
	const incarnation = "0badc0ffee001122";
	const identity = workspaceIdentity("verify-ro", incarnation);
	const { cwd, revision } = await createProofRepo();
	const workspace = await createBennyWorkspace({
		config: proofConfig(image),
		cwd,
		runId: "verify-ro",
		incarnation,
		revision,
		artifactDir: ".omp/pstack/state/benny-evidence",
		deadline: Date.now() + 10 * 60_000,
	});
	const captured: string[][] = [];
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv, options) => {
		if (Array.isArray(argv) && argv[0] === "docker") captured.push([...argv]);
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	try {
		await workspace.call("read", { path: "app/index.html" }, "study");
		// Fix stage runs on the writable tmpfs-backed fix volume.
		await workspace.call("write", { path: "patch-marker.txt", content: "patched\n" }, "fix");
		// This verify call is the first tool call after leaving fix; the worker
		// must already be restarted read-only (never a writable /workspace).
		const verifyWrite = await workspace.call(
			"exec",
			{ command: ["sh", "-c", "printf x > /workspace/verify-must-not-write.txt"] },
			"verify",
		);
		if (!isExecShape(verifyWrite)) throw new Error("verify exec did not return an exec shape");
		expect(verifyWrite.exitCode).not.toBe(0);

		// Mount-mode ordering proof: the writable fix worker run (tmpfs fix
		// volume at /workspace) precedes the copy-back, and a read-only worker
		// run (host worktree bind :ro) follows the copy-back.
		const indexLast = (match: (argv: string[]) => boolean, before: number) => {
			for (let index = before - 1; index >= 0; index--) if (match(captured[index]!)) return index;
			return -1;
		};
		const isFixWorkerRun = (argv: string[]) => argv[1] === "run" && argv.includes(`${identity.fixVolume}:/workspace`);
		const isRoWorkerRun = (argv: string[]) => argv[1] === "run" && argv.includes(`${workspace.workspacePath}:/workspace:ro`);
		const isCpFromWorker = (argv: string[]) => argv[1] === "cp" && argv.some(arg => arg.startsWith(`${identity.worker}:`));
		const cpBackAt = indexLast(isCpFromWorker, captured.length);
		const fixRunAt = indexLast(isFixWorkerRun, captured.length);
		const roRunAt = indexLast(isRoWorkerRun, captured.length);
		expect(fixRunAt).toBeGreaterThan(-1);
		expect(roRunAt).toBeGreaterThan(-1);
		expect(fixRunAt).toBeLessThan(cpBackAt);
		expect(cpBackAt).toBeLessThan(roRunAt);
	} finally {
		Bun.spawn = realSpawn;
		await workspace.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

dockerTest("retained evidence growth stops at the fixed aggregate byte budget and the refused publish materializes no copy", async () => {
	const { cwd, revision } = await createProofRepo();
	const workspace = await createBennyWorkspace({
		config: proofConfig(image),
		cwd,
		runId: "budget",
		revision,
		artifactDir: ".omp/pstack/state/benny-evidence",
		deadline: Date.now() + 10 * 60_000,
	});
	const copiedArgs: string[][] = [];
	const realSpawn = Bun.spawn;
	Bun.spawn = ((argv, options) => {
		if (Array.isArray(argv) && argv[0] === "docker" && argv[1] === "cp") copiedArgs.push([...argv]);
		return realSpawn(argv, options);
	}) as typeof Bun.spawn;
	const evidenceDir = join(cwd, ".omp", "pstack", "state", "benny-evidence", "budget");
	try {
		await workspace.call("read", { path: "app/index.html" }, "reproduce");
		// Two distinct ~350 MiB artifacts fit under the 1 GiB aggregate
		// budget; the store is content-addressed, so the two must differ.
		for (const [name, megabytes] of [["a.bin", 350], ["b.bin", 349]] as const) {
			const written = await workspace.call("exec", { command: ["sh", "-c", `dd if=/dev/zero of=/artifacts/${name} bs=1048576 count=${megabytes} 2>/dev/null`] }, "reproduce");
			if (!isExecShape(written) || written.exitCode !== 0) throw new Error("staging write failed");
			await workspace.artifacts([`/artifacts/${name}`]);
			await workspace.call("exec", { command: ["rm", "-f", `/artifacts/${name}`] }, "reproduce");
		}
		const before = (await readdir(evidenceDir)).length;
		expect(before).toBe(2);
		// ...a third would exceed the aggregate byte budget: the publish must
		// be refused BEFORE any byte is copied out of the bounded source.
		const copiesBefore = copiedArgs.length;
		const written = await workspace.call("exec", { command: ["sh", "-c", "dd if=/dev/zero of=/artifacts/c.bin bs=1048576 count=350 2>/dev/null"] }, "reproduce");
		if (!isExecShape(written) || written.exitCode !== 0) throw new Error("staging write failed");
		const refused = await workspace.artifacts(["/artifacts/c.bin"]).then(() => null, (failure: unknown) => failure);
		expect(refused).toBeInstanceOf(WorkspaceBlockError);
		expect((refused as Error).message).toMatch(/evidence budget/);
		expect(copiedArgs.length).toBe(copiesBefore);
		const after = (await readdir(evidenceDir)).length;
		expect(after).toBe(2);
	} finally {
		Bun.spawn = realSpawn;
		await workspace.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 15 * 60_000 });

/** One derived workspace of a logical run, on the shared proof repo cwd. */
function logicalWorkspace(cwd: string, revision: string, runId: string, logicalRunId: string) {
	return createBennyWorkspace({
		config: proofConfig(image),
		cwd,
		runId,
		logicalRunId,
		revision,
		artifactDir: ".omp/pstack/state/benny-evidence",
		deadline: Date.now() + 10 * 60_000,
	});
}

async function stageArtifact(workspace: BennyWorkspace, name: string, megabytes: number, source = "/dev/zero"): Promise<void> {
	const written = await workspace.call("exec", { command: ["sh", "-c", `dd if=${source} of=/artifacts/${name} bs=1048576 count=${megabytes} 2>/dev/null`] }, "reproduce");
	if (!isExecShape(written) || written.exitCode !== 0) throw new Error(`staging write failed for ${name}`);
}

async function publishStaged(workspace: BennyWorkspace, name: string): Promise<void> {
	await workspace.artifacts([`/artifacts/${name}`]);
	const removed = await workspace.call("exec", { command: ["rm", "-f", `/artifacts/${name}`] }, "reproduce");
	if (!isExecShape(removed) || removed.exitCode !== 0) throw new Error(`staging cleanup failed for ${name}`);
}

async function evidenceBytes(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(dir)) total += (await lstat(join(dir, entry))).size;
	return total;
}

dockerTest("base, head, and ops workspaces share one logical-run evidence budget; concurrent reservations cannot race over it", async () => {
	const { cwd, revision } = await createProofRepo();
	const base = await logicalWorkspace(cwd, revision, "950-base", "950");
	const head = await logicalWorkspace(cwd, revision, "950-head", "950");
	const ops = await logicalWorkspace(cwd, revision, "950-ops", "950");
	const evidenceDir = join(cwd, ".omp", "pstack", "state", "benny-evidence", "950");
	try {
		// Collective budget: 300 MiB from base plus 299 MiB from head are
		// retained in the SHARED logical directory (one content store, one
		// budget — three workspaces, not three budgets).
		await stageArtifact(base, "a.bin", 300);
		await publishStaged(base, "a.bin");
		await stageArtifact(head, "b.bin", 299);
		await publishStaged(head, "b.bin");
		expect((await readdir(evidenceDir)).length).toBe(2);
		// ops' 430 MiB would push the SHARED budget past 1 GiB: refused
		// before any retained byte grows.
		await stageArtifact(ops, "c.bin", 430);
		const refused = await publishStaged(ops, "c.bin").then(() => null, (failure: unknown) => failure);
		expect(refused).toBeInstanceOf(WorkspaceBlockError);
		expect((refused as Error).message).toMatch(/evidence budget/);
		expect((await readdir(evidenceDir)).length).toBe(2);

		// Concurrent reservations: both race files are 400 MiB of distinct
		// (random) bytes, and a STALE usage scan would admit both (599 + 400
		// <= 1024 seen twice). Serialization must admit exactly one and
		// refuse the other before its bytes are retained.
		await stageArtifact(base, "x.bin", 400, "/dev/urandom");
		await stageArtifact(head, "y.bin", 400, "/dev/urandom");
		const settled = await Promise.allSettled([publishStaged(base, "x.bin"), publishStaged(head, "y.bin")]);
		expect(settled.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		for (const outcome of settled) {
			if (outcome.status === "rejected") {
				expect(outcome.reason).toBeInstanceOf(WorkspaceBlockError);
				expect((outcome.reason as Error).message).toMatch(/evidence budget/);
			}
		}
		// Exactly one race file was retained and the shared store never
		// exceeded the fixed aggregate byte budget.
		expect((await readdir(evidenceDir)).length).toBe(3);
		const total = await evidenceBytes(evidenceDir);
		expect(total).toBeLessThanOrEqual(1024 * 1024 * 1024);
		expect(total).toBeGreaterThan(998 * 1024 * 1024);
	} finally {
		for (const workspace of [base, head, ops]) await workspace.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 30 * 60_000 });

dockerTest("two logical runs keep isolated evidence budgets in the same target", async () => {
	const { cwd, revision } = await createProofRepo();
	const runA = await logicalWorkspace(cwd, revision, "970-base", "970");
	const runB = await logicalWorkspace(cwd, revision, "980-base", "980");
	try {
		// Run 970 retains 900 MiB (3 × 300); run 980 — a DIFFERENT logical
		// budget — still retains 400 MiB, which a single shared 1 GiB budget
		// would refuse (1300 MiB). 970 alone still refuses past its own
		// 1 GiB, while 980's store is untouched.
		// Distinct content: the store is content-addressed, so identical
		// bytes would dedupe into one retained blob.
		await stageArtifact(runA, "a1.bin", 300);
		await publishStaged(runA, "a1.bin");
		await stageArtifact(runA, "a2.bin", 300, "/dev/urandom");
		await publishStaged(runA, "a2.bin");
		await stageArtifact(runA, "a3.bin", 300, "/dev/urandom");
		await publishStaged(runA, "a3.bin");
		await stageArtifact(runB, "b.bin", 400);
		await publishStaged(runB, "b.bin");
		expect((await readdir(join(cwd, ".omp", "pstack", "state", "benny-evidence", "970"))).length).toBe(3);
		expect((await readdir(join(cwd, ".omp", "pstack", "state", "benny-evidence", "980"))).length).toBe(1);
		await stageArtifact(runA, "c.bin", 150);
		const refused = await publishStaged(runA, "c.bin").then(() => null, (failure: unknown) => failure);
		expect(refused).toBeInstanceOf(WorkspaceBlockError);
		expect((refused as Error).message).toMatch(/evidence budget/);
	} finally {
		for (const workspace of [runA, runB]) await workspace.cleanup().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 30 * 60_000 });

dockerTest("a run-scoped decode reclaims crash-left decoder resources of the same logical run and never another run's", async () => {
	const videoDir = await mkdtemp(join(tmpdir(), "benny-decode-"));
	const generated = await Bun.$`docker run --rm -v ${videoDir}:/out ${image} ffmpeg -v error -f lavfi -i testsrc=duration=2:size=128x96:rate=4 -c:v libvpx -an /out/clip.webm`.quiet().nothrow();
	expect(generated.exitCode).toBe(0);
	const video = await readFile(join(videoDir, "clip.webm"));
	// Crash-left decoder container + staging volume of logical run 771
	// (still RUNNING — a SIGKILLed host leaves them alive), another run's
	// live decoder, and a workspace resource of the same logical run.
	const dead = "benny-media-1111111111111111";
	const other = "benny-media-3333333333333333";
	const worker = "benny-ws-771-worker";
	await Bun.$`docker run -d --name ${dead} --label pstack.benny.managed=true --label pstack.benny.run-id=771 --label pstack.benny.incarnation=1111111111111111 --label pstack.benny.role=media ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker volume create --name ${dead}-work --label pstack.benny.managed=true --label pstack.benny.run-id=771 --label pstack.benny.incarnation=1111111111111111 --label pstack.benny.role=media-storage`.quiet().nothrow();
	await Bun.$`docker run -d --name ${other} --label pstack.benny.managed=true --label pstack.benny.run-id=432 --label pstack.benny.incarnation=3333333333333333 --label pstack.benny.role=media ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker run -d --name ${worker} --label pstack.benny.managed=true --label pstack.benny.run-id=771 --label pstack.benny.incarnation=aaaaaaaaaaaaaaaa --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
	try {
		// The decode proceeds after the same-run reclaim; its own resources
		// are reconciled away at the end.
		const frames = await decodeVideoFrames(image, video, { maxFrames: 2, runId: "771" });
		expect(frames).toHaveLength(2);
		// The crash-left container AND its staging volume of run 771 are
		// gone; another run's decoder and the same run's workspace container
		// are untouched and still running.
		expect((await Bun.$`docker inspect ${dead}`.quiet().nothrow()).exitCode).not.toBe(0);
		expect((await Bun.$`docker volume inspect ${dead}-work`.quiet().nothrow()).exitCode).not.toBe(0);
		expect((await Bun.$`docker inspect -f {{.State.Running}} ${other}`.quiet().nothrow()).stdout.toString().trim()).toBe("true");
		expect((await Bun.$`docker inspect -f {{.State.Running}} ${worker}`.quiet().nothrow()).stdout.toString().trim()).toBe("true");
	} finally {
		await rm(videoDir, { recursive: true, force: true });
		await Bun.$`docker rm -f ${other} ${worker}`.quiet().nothrow();
		await Bun.$`docker ps -aq --filter label=pstack.benny.role=media --filter label=pstack.benny.run-id=771 | xargs -r docker rm -f`.quiet().nothrow();
		await Bun.$`docker volume ls -q --filter label=pstack.benny.role=media-storage --filter label=pstack.benny.run-id=771 | xargs -r docker volume rm`.quiet().nothrow();
	}
}, { timeout: 10 * 60_000 });

dockerTest("a run-scoped decode refuses to reclaim an unprovable crash-left decoder and touches nothing", async () => {
	// Role says media but the incarnation label is missing: the reclaim can
	// never prove ownership, so the decode fails closed and the leftover
	// stays exactly as it was.
	const bad = "benny-media-4444444444444444";
	await Bun.$`docker run -d --name ${bad} --label pstack.benny.managed=true --label pstack.benny.run-id=772 --label pstack.benny.role=media ${image} sleep 600`.quiet().nothrow();
	try {
		const error = await decodeVideoFrames(image, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { runId: "772" }).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WorkspaceBlockError);
		expect((error as Error).message).toMatch(/could not be reclaimed/);
		expect((await Bun.$`docker inspect -f {{.State.Running}} ${bad}`.quiet().nothrow()).stdout.toString().trim()).toBe("true");
	} finally {
		await Bun.$`docker rm -f ${bad}`.quiet().nothrow();
	}
}, { timeout: 2 * 60_000 });

dockerTest("reclaimBennyRunResources removes every exact derived resource of a logical run and blocks foreign or unprovable state", async () => {
	const { cwd, revision } = await createProofRepo();
	const labelArgs = (runId: string, role: string) => [
		"--label", "pstack.benny.managed=true",
		"--label", `pstack.benny.run-id=${runId}`,
		"--label", "pstack.benny.incarnation=aaaaaaaaaaaaaaaa",
		"--label", `pstack.benny.role=${role}`,
	];
	// Workspace resources across the logical id and its derived suffixes.
	await Bun.$`docker run -d --name r777 ${labelArgs("777", "worker")} ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker run -d --name r777-base ${labelArgs("777-base", "worker")} ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker run -d --name r777-ops ${labelArgs("777-ops", "controller")} ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker network create --internal ${labelArgs("777", "network")} r777-net`.quiet().nothrow();
	await Bun.$`docker volume create --name r777-ops-fixwork ${labelArgs("777-ops", "fix-storage")}`.quiet().nothrow();
	await Bun.$`docker volume create --name r777-head-stage ${labelArgs("777-head", "artifact-storage")}`.quiet().nothrow();
	// Media decoder resources of the logical run.
	await Bun.$`docker run -d --name benny-media-2222222222222222 ${labelArgs("777", "media")} ${image} sleep 600`.quiet().nothrow();
	await Bun.$`docker volume create --name benny-media-2222222222222222-work ${labelArgs("777", "media-storage")}`.quiet().nothrow();
	// Another logical run's resource, and this run's host-side state.
	await Bun.$`docker run -d --name r888 ${labelArgs("888", "worker")} ${image} sleep 600`.quiet().nothrow();
	const stateRoot = join(cwd, ".omp", "pstack", "state");
	for (const derived of ["777", "777-head", "777-plan"]) {
		await mkdir(join(stateRoot, "benny", derived, "worktree"), { recursive: true });
	}
	const evidenceDir = join(stateRoot, "benny-evidence", "777");
	await mkdir(evidenceDir, { recursive: true });
	await writeFile(join(evidenceDir, "0".repeat(64) + ".bin"), "retained");
	try {
		await reclaimBennyRunResources(cwd, "777");
		for (const resource of ["r777", "r777-base", "r777-ops", "r777-net", "r777-ops-fixwork", "r777-head-stage", "benny-media-2222222222222222", "benny-media-2222222222222222-work"]) {
			const kind = resource.includes("net") ? "network" : resource.includes("-fixwork") || resource.includes("-stage") || resource.includes("-work") ? "volume" : "container";
			const argv = kind === "volume" ? ["volume", "inspect", resource] : kind === "network" ? ["network", "inspect", resource] : ["inspect", resource];
			expect((await Bun.$`docker ${argv}`.quiet().nothrow()).exitCode, resource).not.toBe(0);
		}
		for (const derived of ["777", "777-base", "777-head", "777-ops", "777-plan"]) {
			expect(await lstat(join(stateRoot, "benny", derived)).catch(() => null), derived).toBeNull();
		}
		// Retained evidence is sweep-owned and survives the reclamation;
		// another logical run's resource is untouched.
		expect(await readFile(join(evidenceDir, "0".repeat(64) + ".bin"), "utf8")).toBe("retained");
		expect((await Bun.$`docker inspect -f {{.State.Running}} r888`.quiet().nothrow()).stdout.toString().trim()).toBe("true");

		// Unprovable state blocks the reclamation: a run-id match without a
		// well-formed incarnation is never touched, and the call fails.
		await Bun.$`docker run -d --name r779 --label pstack.benny.managed=true --label pstack.benny.run-id=779 --label pstack.benny.role=worker ${image} sleep 600`.quiet().nothrow();
		const refused = await reclaimBennyRunResources(cwd, "779").then(() => null, (failure: unknown) => failure);
		expect(refused).toBeInstanceOf(WorkspaceBlockError);
		expect((refused as Error).message).toMatch(/incarnation/);
		expect((await Bun.$`docker inspect -f {{.State.Running}} r779`.quiet().nothrow()).stdout.toString().trim()).toBe("true");

		// A symlinked run root is never removed; the reclamation blocks.
		await mkdir(join(stateRoot, "benny-real"), { recursive: true });
		await symlink(join(stateRoot, "benny-real"), join(stateRoot, "benny", "780"));
		const linkRefused = await reclaimBennyRunResources(cwd, "780").then(() => null, (failure: unknown) => failure);
		expect(linkRefused).toBeInstanceOf(WorkspaceBlockError);
		expect((linkRefused as Error).message).toMatch(/symlink/);
		expect((await lstat(join(stateRoot, "benny", "780"))).isSymbolicLink()).toBe(true);

		// Unsafe logical ids are rejected outright.
		await expect(reclaimBennyRunResources(cwd, "../escape")).rejects.toThrow(/not a safe container name fragment/);
	} finally {
		await Bun.$`docker rm -f r888 r779`.quiet().nothrow();
		await Bun.$`docker ps -aq --filter label=pstack.benny.run-id=777 | xargs -r docker rm -f`.quiet().nothrow();
		await Bun.$`docker volume ls -q --filter label=pstack.benny.run-id=777 | xargs -r docker volume rm`.quiet().nothrow();
		await Bun.$`docker network ls -q --filter label=pstack.benny.run-id=777 | xargs -r docker network rm`.quiet().nothrow();
		await rm(cwd, { recursive: true, force: true });
	}
}, { timeout: 10 * 60_000 });
