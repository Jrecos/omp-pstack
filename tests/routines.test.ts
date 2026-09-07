import { afterAll, beforeAll, test, expect } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import * as R from "../src/runner.ts";
import * as S from "../src/service.ts";

const previousProfile = process.env.PI_CODING_AGENT_DIR;
const profile = mkdtempSync(join(tmpdir(), "pstack-agent-"));
const temporary = [profile];
beforeAll(() => { process.env.PI_CODING_AGENT_DIR = profile; refreshDirsFromEnv(); });
afterAll(() => {
	if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousProfile;
	refreshDirsFromEnv();
	for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

let seq = 0;
function makeCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), `pstack-cwd-${seq++}-`));
	temporary.push(cwd);
	return cwd;
}

function makeRoutine(cwd: string, slug = "test-rt", model = "openai/gpt-5"): void {
	const promptFile = join(cwd, "prompt.txt");
	writeFileSync(promptFile, "Inspect the event data and report what you find.");
	S.createRoutine(cwd, slug, promptFile, model);
	S.setRoutineEnabled(cwd, slug, true);
}

function insertRunning(
	db: Database,
	overrides: Partial<{ owner_pid: number | null; owner_boot: string | null; deadline_ms: number; routine: string; status: string }> = {},
): number {
	const row = {
		routine: "test-rt",
		owner_pid: 999_999_999 as number | null,
		owner_boot: "dead-boot" as string | null,
		deadline_ms: Date.now() + 600_000,
		status: "running",
		...overrides,
	};
	const result = db.run(
		`INSERT INTO runs (routine, event_id, body, body_digest, timestamp_ms, status, deadline_ms, prompt, model, owner_pid, owner_boot, created_at)
		 VALUES (?, ?, '{}', 'd', 0, ?, ?, 'p', 'm', ?, ?, ?)`,
		[
			row.routine,
			`ev-${crypto.randomUUID()}`,
			row.status,
			row.deadline_ms,
			row.owner_pid,
			row.owner_boot,
			Date.now(),
		],
	);
	return Number(result.lastInsertRowid);
}

test("routine lifecycle: create, no overwrite, slug rules, enable/disable, secret handling", () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "life-rt");
	const routines = S.listRoutines(cwd);
	expect(routines).toHaveLength(1);
	expect(routines[0]!.name).toBe("life-rt");
	expect(routines[0]!.tools).toEqual([]);
	expect(routines[0]!.model).toBe("openai/gpt-5");
	expect(routines[0]!.prompt).toContain("Inspect the event data");

	expect(() => S.createRoutine(cwd, "life-rt", join(cwd, "prompt.txt"), "openai/gpt-5")).toThrow(/already exists/);
	expect(() => S.createRoutine(cwd, "Bad_Slug", join(cwd, "prompt.txt"), "m")).toThrow(/invalid slug/);

	const keyPath = S.secretsPath(cwd, "life-rt");
	const key = readFileSync(keyPath, "utf8").trim();
	expect(key).toMatch(/^[0-9a-f]{64}$/);
	expect(statSync(keyPath).mode & 0o777).toBe(0o600);

	// Routine JSON is secret-free and carries no enablement: that lives only
	// in profile-private state bound to the definition digest.
	const defText = readFileSync(join(cwd, ".omp/pstack/routines/life-rt.json"), "utf8");
	expect(defText).not.toContain(key);
	expect(defText).not.toContain("enabled");
	expect(() => R.assertRoutineEnabled(cwd, "life-rt", R.readRoutine(cwd, "life-rt")!)).not.toThrow();

	S.setRoutineEnabled(cwd, "life-rt", false);
	expect(() => R.assertRoutineEnabled(cwd, "life-rt", R.readRoutine(cwd, "life-rt")!)).toThrow(/disabled/);
	S.setRoutineEnabled(cwd, "life-rt", true);
	expect(() => R.assertRoutineEnabled(cwd, "life-rt", R.readRoutine(cwd, "life-rt")!)).not.toThrow();

	const missing = S.listRoutines(makeCwd());
	expect(missing).toHaveLength(0);
	expect(() => S.setRoutineEnabled(cwd, "nope", true)).toThrow(/unknown routine/);
});

test("event validation rejects hostile input", () => {
	const ok: R.RoutineEvent = { event_id: "e", body: { a: 1 } };
	expect(() => R.validateEvent(ok)).not.toThrow();
	expect(() => R.validateEvent({ ...ok, event_id: "" })).toThrow();
	expect(() => R.validateEvent({ ...ok, event_id: "x".repeat(R.MAX_EVENT_ID + 1) })).toThrow();
	expect(() => R.validateEvent({ ...ok, body: "string" })).toThrow(/JSON object/);
	expect(() => R.validateEvent({ ...ok, body: [1, 2] })).toThrow(/JSON object/);
	expect(() => R.validateEvent({ ...ok, body: { blob: "x".repeat(R.MAX_BODY_BYTES + 1) } })).toThrow(/1MiB|bytes|exceeds/);
	expect(() => R.validateEvent({ ...ok, timestamp_ms: 1.5 })).toThrow(/timestamp_ms/);
	expect(() => R.validateEvent({ ...ok, timestamp_ms: -1 })).toThrow(/timestamp_ms/);
});

test("admission dedupes on (routine, event_id) and stores body digest", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const event: R.RoutineEvent = { event_id: "same-id", body: { n: 1 }, timestamp_ms: 123 };
	const first = R.admitRun(db, "rt", event, "prompt", "model", R.DEFAULT_RUN_TIMEOUT_MS);
	const second = R.admitRun(db, "rt", event, "prompt", "model", R.DEFAULT_RUN_TIMEOUT_MS);
	expect(first.duplicate).toBe(false);
	expect(second).toEqual({ runId: first.runId, duplicate: true });
	const other = R.admitRun(db, "rt", { ...event, event_id: "other-id" }, "prompt", "model", R.DEFAULT_RUN_TIMEOUT_MS);
	expect(other.runId).not.toBe(first.runId);
	const row = R.getRun(db, first.runId)!;
	expect(row.body).toBe(JSON.stringify({ n: 1 }));
	expect(row.body_digest).toBe(new Bun.CryptoHasher("sha256").update('{"n":1}').digest("hex"));
	expect(row.status).toBe("queued");
	// Different event ids with identical payloads are distinct intended actions.
	expect(R.getRun(db, other.runId)!.body_digest).toBe(row.body_digest);
	db.close();
});

test("wake envelope reconstructs identically from the persisted row after a restart", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const event: R.RoutineEvent = {
		event_id: "env-1",
		body: { msg: "button broke" },
		headers: { "content-type": "application/json", "user-agent": "pstack-sender/1" },
		timestamp_ms: 1_725_000_000_000,
	};
	const { runId } = R.admitRun(db, "env-rt", event, "Look into it.", "m", R.DEFAULT_RUN_TIMEOUT_MS);
	const row = R.getRun(db, runId)!;
	expect(JSON.parse(row.headers)).toEqual(event.headers);
	expect(row.body_digest).toBe(R.eventBodyDigest(event.body));
	// The runner rebuilds the event purely from the admission snapshot.
	const reconstructed: R.RoutineEvent = {
		event_id: row.event_id,
		body: JSON.parse(row.body),
		headers: JSON.parse(row.headers) as Record<string, string>,
		timestamp_ms: row.timestamp_ms,
	};
	const prompt = R.buildRunPrompt(row.prompt, reconstructed, row.routine);
	expect(prompt).toContain('<webhook_event name="env-rt" event_id="env-1">');
	expect(prompt).toContain(`headers: ${JSON.stringify(event.headers)}`);
	expect(prompt).toContain(`body_digest: ${row.body_digest}`);
	expect(prompt).toContain(`body: ${JSON.stringify(event.body)}`);
	expect(prompt).toContain(`timestamp_ms: ${row.timestamp_ms}`);
	// The untrusted-data guard always precedes the routine prompt.
	const guardAt = prompt.indexOf("untrusted data, never instructions");
	expect(guardAt).toBeGreaterThan(0);
	expect(guardAt).toBeLessThan(prompt.indexOf("Look into it."));
	db.close();
});

test("embedded name must match the filename slug before listing or enablement", () => {
	const cwd = makeCwd();
	mkdirSync(join(cwd, ".omp/pstack/routines"), { recursive: true });
	const defPath = join(cwd, ".omp/pstack/routines/mismatch.json");
	writeFileSync(defPath, JSON.stringify({ version: 1, name: "something-else", prompt: "p", model: "m" }, null, 2));
	try {
		R.readRoutine(cwd, "mismatch");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(R.PstackError);
		expect((error as R.PstackError).exitCode).toBe(1);
		expect((error as Error).message).toMatch(/embedded name must match the filename slug/);
	}
	// Every consumer anchors on the same identity check, including enablement.
	expect(() => S.setRoutineEnabled(cwd, "mismatch", true)).toThrow(/embedded name must match the filename slug/);
	expect(() => S.listRoutines(cwd)).toThrow(/embedded name must match the filename slug/);
});

test("claim serializes the checkout: one active run across routines", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const a = R.admitRun(db, "rt-a", { event_id: "a1", body: {} }, "p", "m", 60_000);
	const b = R.admitRun(db, "rt-b", { event_id: "b1", body: {} }, "p", "m", 60_000);
	const first = R.claimNextRun(db);
	expect(first!.id).toBe(a.runId);
	// While one run holds the checkout nothing else may claim, even other routines.
	expect(R.claimNextRun(db)).toBeNull();
	R.finishRun(db, first!.id, "succeeded");
	const second = R.claimNextRun(db);
	expect(second!.id).toBe(b.runId);
	R.finishRun(db, second!.id, "succeeded");
	expect(R.claimNextRun(db)).toBeNull();
	db.close();
});

test("recovery releases reused PIDs but preserves live owners even after their deadlines", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const dead = insertRunning(db, { owner_pid: 999_999_999, owner_boot: "gone" });
	const aliveForeign = insertRunning(db, { owner_pid: process.ppid, owner_boot: "other-boot", deadline_ms: Date.now() - 1000 });
	const reusedPid = insertRunning(db, { owner_pid: process.pid, owner_boot: "other-boot" });
	const ours = insertRunning(db, { owner_pid: process.pid, owner_boot: R.BOOT_ID, deadline_ms: Date.now() - 1000 });

	const recovered = R.recoverStaleRuns(db);
	expect(recovered.sort()).toEqual([dead, reusedPid].sort());

	const deadRow = R.getRun(db, dead)!;
	expect(deadRow.status).toBe("interrupted");
	const aliveRow = R.getRun(db, aliveForeign)!;
	expect(aliveRow.status).toBe("running");
	const oursRow = R.getRun(db, ours)!;
	expect(oursRow.status).toBe("running");
	expect(R.getRun(db, reusedPid)?.status).toBe("interrupted");
	expect(R.claimNextRun(db)).toBeNull();
	db.close();
});

test("process-incarnation verification: reused pids release the lease, verified live owners keep it", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const foreign = Bun.spawn(["sleep", "30"]);
	try {
		const ticks = R.OS_BOOT_ID === null ? null : R.processStartTicks(foreign.pid);
		if (ticks === null) return; // portable fallback keeps pidAlive semantics off Linux
		// A correctly recorded incarnation of a live foreign owner is preserved
		// even though its owner_boot differs from this process's identity.
		const verified = insertRunning(db, { owner_pid: foreign.pid, owner_boot: `${R.OS_BOOT_ID}:${ticks}` });
		// Same live pid, wrong start ticks: the recorded owner is a dead
		// predecessor and the pid was reused — the lease must release.
		const reused = insertRunning(db, { owner_pid: foreign.pid, owner_boot: `${R.OS_BOOT_ID}:${Number(BigInt(ticks) + 1n)}` });
		// An owner from a previous boot is dead regardless of current pid liveness.
		const previousBoot = insertRunning(db, { owner_pid: foreign.pid, owner_boot: `00000000-0000-0000-0000-000000000009:${ticks}` });

		const recovered = R.recoverStaleRuns(db);
		expect(recovered).toContain(reused);
		expect(recovered).toContain(previousBoot);
		expect(recovered).not.toContain(verified);
		expect(R.getRun(db, verified)!.status).toBe("running");
		expect(R.getRun(db, reused)!.status).toBe("interrupted");
		expect(R.getRun(db, previousBoot)!.status).toBe("interrupted");
	} finally {
		foreign.kill();
		db.close();
	}
});

test("finishRun cannot overwrite a row lost to interruption elsewhere", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const id = insertRunning(db);
	db.run("UPDATE runs SET status = 'interrupted', diagnostic = 'recovered' WHERE id = ?", [id]);
	R.finishRun(db, id, "succeeded", "late owner");
	const row = R.getRun(db, id)!;
	expect(row.status).toBe("interrupted");
	expect(row.diagnostic).toBe("recovered");
	db.close();
});

test("routine workers cannot claim Benny jobs or overlap their checkout lease", () => {
	const db = R.openRunStore(makeCwd());
	try {
		const event = { event_id: "same", body: {} };
		const benny = R.admitRun(db, "shared", event, "p", "m", 60_000, "benny");
		expect(R.claimNextRun(db)).toBeNull();
		const routine = R.admitRun(db, "shared", event, "p", "m", 60_000);
		expect(R.claimNextRun(db, "benny")?.id).toBe(benny.runId);
		expect(R.claimNextRun(db)).toBeNull();
		R.finishRun(db, benny.runId, "succeeded");
		expect(R.claimNextRun(db)?.id).toBe(routine.runId);
	} finally { db.close(); }
});

test("admitted snapshots settle without a live enable/definition recheck; tampered tool snapshots block", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "gate-rt");
	const db = R.openRunStore(cwd);
	const def = R.readRoutine(cwd, "gate-rt")!;
	const admitted = R.admitRun(db, "gate-rt", { event_id: "snap", body: {} }, def.prompt, def.model, 60_000, "routine", def.tools);
	// Disablement and definition drift AFTER admission must not cancel the
	// accepted row: the queue DB is profile-private, so the snapshot settles
	// on what was admitted, not on repo state that moved underneath it.
	S.setRoutineEnabled(cwd, "gate-rt", false);
	const defPath = join(cwd, ".omp/pstack/routines/gate-rt.json");
	const defJson = JSON.parse(readFileSync(defPath, "utf8")) as Record<string, unknown>;
	defJson.prompt = "rewritten after admission";
	writeFileSync(defPath, JSON.stringify(defJson, null, 2));
	const runner = new R.RoutineRunner(cwd, db);
	await runner.start();
	try {
		const settled = (await runner.runUntil(admitted.runId))!;
		// openai/gpt-5 has no credentials in the test profile: blocked on the
		// model gate, never cancelled by the removed enable/definition recheck.
		expect(R.isTerminalRun(settled.status)).toBe(true);
		expect(settled.diagnostic ?? "").not.toMatch(/disabled|no longer exists|snapshot differs/);
		// A tampered tool snapshot can never reach a session: revalidated
		// read-only before any session is created.
		const tampered = R.admitRun(db, "gate-rt", { event_id: "tampered", body: {} }, def.prompt, def.model, 60_000, "routine", def.tools);
		db.run("UPDATE runs SET tools = ? WHERE id = ?", ['["bash"]', tampered.runId]);
		expect((await runner.runUntil(tampered.runId))!.status).toBe("blocked");
		expect(R.getRun(db, tampered.runId)!.diagnostic).toMatch(/allowlist must be empty/);
	} finally {
		await runner.close();
		db.close();
	}
});

test("HTTP admission gate: hostile and duplicate traffic against a live server", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "http-rt");
	makeRoutine(cwd, "off-rt");
	S.setRoutineEnabled(cwd, "off-rt", false);
	const handle = await S.serve(cwd, "127.0.0.1", 0, { runner: false });
	const key = readFileSync(S.secretsPath(cwd, "http-rt"), "utf8").trim();
	const url = `http://127.0.0.1:${handle.port}`;
	const db = R.openRunStore(cwd);

	async function post(
		path: string,
		init: { body?: unknown; key?: string; eventId?: string; origin?: string; automationKey?: string; raw?: string } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (init.key !== undefined) headers.authorization = `Bearer ${init.key}`;
		if (init.automationKey !== undefined) headers["x-automation-key"] = init.automationKey;
		if (init.eventId !== undefined) headers["x-pstack-event-id"] = init.eventId;
		if (init.origin !== undefined) headers.origin = init.origin;
		return fetch(`${url}${path}`, {
			method: "POST",
			headers,
			body: init.raw ?? JSON.stringify(init.body ?? {}),
		});
	}

	const health = await fetch(`${url}/healthz`);
	expect(health.status).toBe(200);
	expect(await health.json()).toEqual({ ok: true, port: handle.port });

	const rowCount = () => (db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;

	// Browsers are never admitted.
	const browser = await post("/routines/http-rt", { body: {}, key, eventId: "ev-origin", origin: "https://evil.example" });
	expect(browser.status).toBe(403);
	expect(rowCount()).toBe(0);

	// Both key headers are required and must match.
	expect((await post("/routines/http-rt", { body: {}, eventId: "ev-noauth" })).status).toBe(401);
	expect((await post("/routines/http-rt", { body: {}, key, eventId: "ev-half" })).status).toBe(401);
	expect((await post("/routines/http-rt", { body: {}, key: "wrong", automationKey: key, eventId: "ev-bad" })).status).toBe(401);
	expect((await post("/routines/http-rt", { body: {}, key, automationKey: "wrong", eventId: "ev-bad2" })).status).toBe(401);
	expect(rowCount()).toBe(0);

	expect((await post("/routines/nope", { body: {}, key, eventId: "ev-unknown" })).status).toBe(404);
	expect((await post("/routines/off-rt", { body: {}, key: readFileSync(S.secretsPath(cwd, "off-rt"), "utf8").trim(), eventId: "ev-off" })).status).toBe(409);
	expect(rowCount()).toBe(0);

	// Malformed bodies.
	const big = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 10) });
	expect((await post("/routines/http-rt", { raw: big, key, automationKey: key, eventId: "ev-big" })).status).toBe(413);
	expect((await post("/routines/http-rt", { raw: "[1,2]", key, automationKey: key, eventId: "ev-arr" })).status).toBe(400);
	expect((await post("/routines/http-rt", { raw: "not json", key, automationKey: key, eventId: "ev-badjson" })).status).toBe(400);
	expect((await post("/routines/http-rt", { body: {}, key, automationKey: key, eventId: undefined })).status).toBe(400);
	expect(rowCount()).toBe(0);

	// Valid admission is durable and idempotent on the event id.
	const good = await post("/routines/http-rt", { body: { hi: "there" }, key, automationKey: key, eventId: "ev-good" });
	expect(good.status).toBe(200);
	const goodJson = (await good.json()) as { run_id: number; duplicate: boolean };
	expect(goodJson.duplicate).toBe(false);
	const replay = await post("/routines/http-rt", { body: { hi: "there" }, key, automationKey: key, eventId: "ev-good" });
	const replayJson = (await replay.json()) as { run_id: number; duplicate: boolean };
	expect(replayJson.run_id).toBe(goodJson.run_id);
	expect(replayJson.duplicate).toBe(true);
	expect(rowCount()).toBe(1);
	const stored = R.getRun(db, goodJson.run_id)!;
	expect(stored.status).toBe("queued");
	expect(stored.prompt).toContain("Inspect the event data");
	expect(stored.model).toBe("openai/gpt-5");
	// Documented non-secret wake headers persist with the run; the sender
	// keys never do.
	const storedHeaders = JSON.parse(stored.headers) as Record<string, string>;
	expect(storedHeaders["content-type"]).toBe("application/json");
	expect(stored.headers).not.toContain(key);

	// The sender page exposes no key material.
	const page = await fetch(`${url}/routines/http-rt/send`);
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("Send routine event");
	expect(html).not.toContain(key);

	// The server-side sender path: probes, authenticates, admits once.
	const sent = await post("/routines/http-rt/send", { body: {} });
	expect(sent.status).toBe(200);
	const sentJson = (await sent.json()) as { ok: boolean; event_id: string };
	expect(sentJson.ok).toBe(true);
	const replayed = await post("/routines/http-rt/send", { body: { event_id: sentJson.event_id } });
	const replayedJson = (await replayed.json()) as { ok: boolean; event_id: string };
	expect(replayedJson.event_id).toBe(sentJson.event_id);
	const senderRows = db
		.query("SELECT COUNT(*) AS n FROM runs WHERE event_id = ?")
		.get(sentJson.event_id) as { n: number };
	expect(senderRows.n).toBe(1);

	// Same-origin only on the sender: foreign origins and forwarded-host
	// tricks are rejected without adding runs to the store.
	const rowsBeforeHostile = rowCount();
	expect((await post("/routines/http-rt/send", { body: {}, origin: "http://evil.example" })).status).toBe(403);
	expect((await post("/routines/http-rt/send", { body: {}, origin: "null" })).status).toBe(403);
	const spoofed = await fetch(`${url}/routines/http-rt/send`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-host": "evil.example" },
		body: "{}",
	});
	expect(spoofed.status).toBe(403);
	expect(rowCount()).toBe(rowsBeforeHostile);

	// Failure log records event ids, never keys.
	const log = readFileSync(join(cwd, ".omp/pstack/state/sender-log.jsonl"), "utf8");
	expect(log).toContain(sentJson.event_id);
	expect(log).not.toContain(key);

	await handle.stop();
	db.close();
});

test("sender keys are namespaced per canonical workspace plus slug", () => {
	const a = makeCwd();
	const b = makeCwd();
	for (const cwd of [a, b]) writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(a, "shared-slug", join(a, "prompt.txt"), "m");
	S.createRoutine(b, "shared-slug", join(b, "prompt.txt"), "m");
	expect(S.secretsPath(a, "shared-slug")).not.toBe(S.secretsPath(b, "shared-slug"));
	expect(readFileSync(S.secretsPath(a, "shared-slug"), "utf8")).not.toBe(readFileSync(S.secretsPath(b, "shared-slug"), "utf8"));
	// Same workspace + slug resolves to the same key file deterministically.
	expect(S.secretsPath(makeCwd(), "other")).not.toBe(S.secretsPath(makeCwd(), "other"));
});

test("a committed enabled:true cannot enable a routine", async () => {
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(cwd, "evil-rt", join(cwd, "prompt.txt"), "m");
	const path = join(cwd, ".omp/pstack/routines/evil-rt.json");
	const def = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	def.enabled = true;
	writeFileSync(path, JSON.stringify(def, null, 2));
	const parsed = R.readRoutine(cwd, "evil-rt")!;
	expect("enabled" in parsed).toBe(false);
	expect(() => R.assertRoutineEnabled(cwd, "evil-rt", parsed)).toThrow(/disabled/);
	await expect(R.runRoutine(cwd, "evil-rt", { event_id: "x", body: {} })).rejects.toMatchObject({ exitCode: 2 });
});

test("definition drift after enablement fails closed", () => {
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(cwd, "drift-rt", join(cwd, "prompt.txt"), "m");
	S.setRoutineEnabled(cwd, "drift-rt", true);
	const path = join(cwd, ".omp/pstack/routines/drift-rt.json");
	const def = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	def.prompt = "hostile rewrite after enablement";
	writeFileSync(path, JSON.stringify(def, null, 2));
	expect(() => R.assertRoutineEnabled(cwd, "drift-rt", R.readRoutine(cwd, "drift-rt")!)).toThrow(/routine enable drift-rt/);
});

test("routine tool allowlists are empty-only: no ambient tool is safe for untrusted webhook data", () => {
	expect(R.validateRoutineTools(undefined)).toEqual([]);
	expect(R.validateRoutineTools([])).toEqual([]);
	for (const tools of [["read"], ["grep"], ["read", "grep"], ["bash"], ["write"], ["recall"], ["reflect"], ["read", "bash"], ["x".repeat(65)]]) {
		expect(() => R.validateRoutineTools(tools)).toThrow(/allowlist must be empty/);
	}
	expect(() => R.validateRoutineTools("read")).toThrow(/array/);
	// Persisted definitions carry an empty allowlist; the enable record binds it.
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(cwd, "empty-rt", join(cwd, "prompt.txt"), "m", { tools: [] });
	expect(R.readRoutine(cwd, "empty-rt")!.tools).toEqual([]);
	const db = R.openRunStore(cwd);
	const admitted = R.admitRun(db, "empty-rt", { event_id: "t1", body: {} }, "p", "m", 60_000, "routine", []);
	expect(R.getRun(db, admitted.runId)!.tools).toBe("[]");
	db.close();
});

test("routine sessions run tool-less with ambient discovery off", () => {
	const options = R.restrictedSessionOptions([]);
	expect(options.toolNames).toEqual([]);
	expect(options.restrictToolNames).toBe(true);
	expect(options.enableMCP).toBe(false);
	expect(options.enableLsp).toBe(false);
	expect(options.enableIrc).toBe(false);
	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.rules).toEqual([]);
	expect(options.contextFiles).toEqual([]);
	expect(options.promptTemplates).toEqual([]);
	expect(options.slashCommands).toEqual([]);
	// Even a read-only allowlist is refused: validateRoutineTools runs again
	// at session-option construction, so no nonempty list reaches a session.
	expect(() => R.restrictedSessionOptions(["read", "grep"])).toThrow(/allowlist must be empty/);
});

test("prompt files must be regular, non-symlink, inside the workspace", () => {
	const cwd = makeCwd();
	const prompt = join(cwd, "prompt.txt");
	writeFileSync(prompt, "p");
	S.createRoutine(cwd, "ok-rt", prompt, "m");
	S.createRoutine(cwd, "rel-rt", "prompt.txt", "m");

	const outsideDir = mkdtempSync(join(tmpdir(), "pstack-outside-"));
	temporary.push(outsideDir);
	const outside = join(outsideDir, "secret.txt");
	writeFileSync(outside, "host secret");
	expect(() => S.createRoutine(cwd, "escape-rt", outside, "m")).toThrow(/inside the workspace/);

	symlinkSync(outside, join(cwd, "linked-prompt.txt"));
	expect(() => S.createRoutine(cwd, "link-rt", join(cwd, "linked-prompt.txt"), "m")).toThrow(/regular non-symlink/);
});

test("wildcard binds are refused so sender origins stay meaningful", async () => {
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(cwd, "bind-rt", join(cwd, "prompt.txt"), "m");
	await expect(S.serve(cwd, "0.0.0.0", 0, { runner: false })).rejects.toMatchObject({ exitCode: 64 });
	await expect(S.serve(cwd, "::", 0, { runner: false })).rejects.toMatchObject({ exitCode: 64 });
});


function externalIPv4(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

test("browser sender is loopback-only; direct authenticated admission works on non-loopback binds", async () => {
	const address = externalIPv4();
	if (!address) return; // no non-loopback interface in this environment
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	S.createRoutine(cwd, "tailnet-rt", join(cwd, "prompt.txt"), "m");
	S.setRoutineEnabled(cwd, "tailnet-rt", true);
	const handle = await S.serve(cwd, address, 0, { runner: false });
	const url = `http://${address}:${handle.port}`;
	const db = R.openRunStore(cwd);
	const key = readFileSync(S.secretsPath(cwd, "tailnet-rt"), "utf8").trim();
	try {
		// The browser-facing relay is a same-origin loopback privilege: on a
		// non-loopback bind both the button page and the sender POST are
		// refused, even with a matching Origin claim.
		expect((await fetch(`${url}/routines/tailnet-rt/send`)).status).toBe(403);
		expect((
			await fetch(`${url}/routines/tailnet-rt/send`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: url },
				body: "{}",
			})
		).status).toBe(403);
		// The routine admission endpoint remains key-protected on any bind.
		const direct = await fetch(`${url}/routines/tailnet-rt`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
				"x-automation-key": key,
				"x-pstack-event-id": "ev-tailnet",
			},
			body: "{}",
		});
		expect(direct.status).toBe(200);
		const rows = db.query("SELECT COUNT(*) AS n FROM runs WHERE routine = 'tailnet-rt'").get() as { n: number };
		expect(rows.n).toBe(1);
	} finally {
		await handle.stop();
		db.close();
	}
});
test("state directories are git-ignored", () => {
	const ignore = readFileSync(join(import.meta.dir, "..", ".gitignore"), "utf8");
	expect(ignore).toContain(".omp/pstack/state/");
});

test("routine creation anchors .omp/pstack/state/ in .git/info/exclude and refuses planted symlinks", () => {
	const cwd = makeCwd();
	writeFileSync(join(cwd, "prompt.txt"), "p");
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	};
	git("init", "-b", "main");
	S.createRoutine(cwd, "excl-rt", join(cwd, "prompt.txt"), "m");
	const excludePath = join(cwd, ".git", "info", "exclude");
	const exclude = readFileSync(excludePath, "utf8");
	// The anchor must be present and actually effective for git.
	expect(exclude.split("\n").filter((line) => line.trim() === ".omp/pstack/state/")).toHaveLength(1);
	expect(Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", "--", ".omp/pstack/state/"]).exitCode).toBe(0);
	// Idempotent: a re-run adds no duplicate entry.
	R.ensureStateGitExcluded(cwd);
	expect(readFileSync(excludePath, "utf8").split("\n").filter((line) => line.trim() === ".omp/pstack/state/")).toHaveLength(1);
	// A non-git workspace is a no-op, never an error.
	R.ensureStateGitExcluded(makeCwd());
	// A symlinked exclude file (or .git) fails closed instead of writing through.
	rmSync(excludePath);
	symlinkSync(join(tmpdir(), `pstack-evil-exclude-${Date.now()}`), excludePath);
	expect(() => R.ensureStateGitExcluded(cwd)).toThrow(/symlink/);
	const linkCwd = makeCwd();
	symlinkSync(tmpdir(), join(linkCwd, ".git"));
	expect(() => R.ensureStateGitExcluded(linkCwd)).toThrow(/symlink/);
});

test("exclusion anchor is anchored even when a tracked .gitignore already ignores the state path", () => {
	const cwd = makeCwd();
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	};
	git("init", "-b", "main");
	// A tracked ignore rule satisfies check-ignore before any anchor exists:
	// a committed rule can be reverted in a later checkout, so the local
	// anchor must exist regardless of it.
	writeFileSync(join(cwd, ".gitignore"), ".omp/pstack/state/\n");
	expect(Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", "--", ".omp/pstack/state/"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
	R.ensureStateGitExcluded(cwd);
	const excludePath = join(cwd, ".git", "info", "exclude");
	const countEntries = (): number => readFileSync(excludePath, "utf8").split("\n").filter((line) => line.trim() === ".omp/pstack/state/").length;
	expect(countEntries()).toBe(1);
	// Idempotent across re-runs.
	R.ensureStateGitExcluded(cwd);
	expect(countEntries()).toBe(1);
	// The anchor alone now carries the exclusion: removing the tracked rule
	// does not un-exclude private state.
	rmSync(join(cwd, ".gitignore"));
	expect(Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", "--", ".omp/pstack/state/"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
});

test("git exclusion is immune to hostile inherited GIT_* environment", () => {
	const cwd = makeCwd();
	const evil = makeCwd();
	for (const repo of [cwd, evil]) {
		const result = Bun.spawnSync(["git", "-C", repo, "init", "-q", "-b", "main"], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	// A hostile caller export points git at another repository and injects
	// config: pre-hardening, the anchor and its check-ignore proof applied to
	// the EVIL repo while this workspace stayed unexcluded.
	const hostile: Record<string, string> = {
		GIT_DIR: join(evil, ".git"),
		GIT_WORK_TREE: evil,
		GIT_INDEX_FILE: join(evil, ".git", "index"),
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "core.worktree",
		GIT_CONFIG_VALUE_0: evil,
		GIT_CONFIG_KEY_1: "core.excludesFile",
		GIT_CONFIG_VALUE_1: join(evil, "evil.ignore"),
	};
	Object.assign(process.env, hostile);
	try {
		R.ensureStateGitExcluded(cwd);
	} finally {
		for (const key of Object.keys(hostile)) delete process.env[key];
	}
	const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
	expect(exclude.split("\n").filter((line) => line.trim() === ".omp/pstack/state/")).toHaveLength(1);
	// The other repository's exclude file is untouched: exclusion cannot
	// target another repo.
	const evilExclude = readFileSync(join(evil, ".git", "info", "exclude"), "utf8");
	expect(evilExclude).not.toContain(".omp/pstack/state/");
	// And the proof is for THIS repo, evaluated with a clean environment.
	expect(Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", "--", ".omp/pstack/state/"]).exitCode).toBe(0);
});

function patchRunnerMethod(name: "start" | "close", implementation: unknown): () => void {
	const proto = R.RoutineRunner.prototype as unknown as Record<string, unknown>;
	const original = proto[name];
	proto[name] = implementation;
	return () => {
		proto[name] = original;
	};
}

test("serve startup failure closes already-owned resources", async () => {
	const cwd = makeCwd();
	let closed = false;
	const restoreStart = patchRunnerMethod("start", async () => {
		throw new Error("injected startup failure");
	});
	const restoreClose = patchRunnerMethod("close", async () => {
		closed = true;
	});
	try {
		await expect(S.serve(cwd, "127.0.0.1", 0)).rejects.toThrow(/injected startup failure/);
	} finally {
		restoreStart();
		restoreClose();
	}
	// The runner got its close attempt even though start() never completed.
	expect(closed).toBe(true);
	// The sqlite handle does not leak: the WAL file exists only while a
	// connection to the store is open.
	expect(existsSync(join(R.profileWorkspaceDir(cwd, "run-state"), "runs.sqlite-wal"))).toBe(false);
});

test("serve stop attempts every owned resource after an earlier cleanup rejection", async () => {
	const cwd = makeCwd();
	const handle = await S.serve(cwd, "127.0.0.1", 0, { runner: false });
	const restoreClose = patchRunnerMethod("close", async () => {
		throw new Error("injected close failure");
	});
	let stopError: unknown;
	try {
		await handle.stop();
	} catch (error) {
		stopError = error;
	} finally {
		restoreClose();
	}
	expect(String(stopError)).toContain("injected close failure");
	// The bound server is stopped even though runner.close rejected first.
	await expect(fetch(`http://127.0.0.1:${handle.port}/healthz`)).rejects.toThrow();
	// And the sqlite handle is closed too: the WAL file exists only while a
	// connection to the store is open.
	expect(existsSync(join(R.profileWorkspaceDir(cwd, "run-state"), "runs.sqlite-wal"))).toBe(false);
});

test("a real busy port fails serve startup and releases the runner and the store", async () => {
	const cwd = makeCwd();
	const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
	try {
		let failure: unknown;
		try {
			await S.serve(cwd, "127.0.0.1", blocker.port);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		// The guarded startup released what serve already owned: the runner and
		// the sqlite handle are closed (a WAL file exists only while a
		// connection to the store is open).
		expect(existsSync(join(R.profileWorkspaceDir(cwd, "run-state"), "runs.sqlite-wal"))).toBe(false);
	} finally {
		blocker.stop(true);
	}
});

test("combined serve finalizer attempts socket close and listener stop independently, then aggregates", async () => {
	const calls: string[] = [];
	const socketFailure = new Error("injected socket close failure");
	const stopFailure = new Error("injected listener stop failure");
	// First close fails: the listener stop is STILL attempted, and the single
	// failure surfaces directly.
	let first: unknown;
	try {
		await S.stopServeStack(
			{ close: async () => { calls.push("socket"); throw socketFailure; } },
			{ stop: async () => { calls.push("handle"); } },
		);
	} catch (error) {
		first = error;
	}
	expect(first).toBe(socketFailure);
	expect(calls).toEqual(["socket", "handle"]);
	// Both fail: each attempted, then aggregated after both settle.
	let both: unknown;
	try {
		await S.stopServeStack(
			{ close: async () => { throw socketFailure; } },
			{ stop: async () => { throw stopFailure; } },
		);
	} catch (error) {
		both = error;
	}
	expect(both).toBeInstanceOf(AggregateError);
	expect((both as AggregateError).errors).toEqual([socketFailure, stopFailure]);
	// No socket (benny off): the routine handle still stops, cleanly.
	await S.stopServeStack(undefined, { stop: async () => { calls.push("bare"); } });
	expect(calls).toEqual(["socket", "handle", "bare"]);
});

// These runner tests exercise real poll-timer behavior against the platform
// clock (RUN_POLL_MS in the drain loop); fake timers cannot drive it.
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

test("a wake landing after the drain's final empty claim is retained (no lost wake)", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "wake-rt");
	const db = R.openRunStore(cwd);
	const runner = new R.RoutineRunner(cwd, db);
	await runner.start();
	try {
		// Model has no credentials in the test profile, so execution fails
		// synchronously to a terminal status — the drain then makes its exit
		// decision within one microtask of the claim.
		const first = R.admitRun(db, "wake-rt", { event_id: "wake-a", body: {} }, "p", "openai/gpt-5", 60_000);
		runner.wake();
		// This lands in the exact window between the drain's final empty claim
		// and the looping flag clearing: a wake here used to be lost and the
		// admitted row stayed queued forever.
		let secondId = 0;
		queueMicrotask(() => {
			const second = R.admitRun(db, "wake-rt", { event_id: "wake-b", body: {} }, "p", "openai/gpt-5", 60_000);
			secondId = second.runId;
			runner.wake();
		});
		await waitFor(() => R.getRun(db, first.runId)!.status !== "queued", "first run to settle");
		await waitFor(() => R.isTerminalRun(R.getRun(db, secondId)!.status), "late wake to drain");
		expect(R.getRun(db, secondId)!.status).not.toBe("queued");
	} finally {
		await runner.close();
		db.close();
	}
});

test("runUntil waits through global-lease contention and returns only a terminal row", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "contend-rt");
	const db = R.openRunStore(cwd);
	const runner = new R.RoutineRunner(cwd, db);
	const lease = Bun.spawn(["sleep", "30"]);
	try {
		await runner.start();
		const leaseId = insertRunning(db, { owner_pid: lease.pid, owner_boot: "other-boot" });
		const target = R.admitRun(db, "contend-rt", { event_id: "contended", body: {} }, "p", "openai/gpt-5", 60_000);
		let settled: R.RunRow | undefined;
		const waiting = runner.runUntil(target.runId).then(row => {
			settled = row;
			return row;
		});
		// A live foreign lease holds the checkout: the wait must continue, and
		// the admitted row must not be reported as a CLI success meanwhile.
		// Negative assertion needs a real delay: pre-fix code resolved here
		// within one microtask, so 150ms cleanly separates the behaviors.
		await sleep(150);
		expect(settled).toBeUndefined();
		expect(R.getRun(db, target.runId)!.status).toBe("queued");
	} finally {
		lease.kill();
		await runner.close();
		db.close();
	}
});


test("runUntil returns the terminal row when the admitted run executes under a foreign lease", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "foreign-rt");
	const db = R.openRunStore(cwd);
	const runner = new R.RoutineRunner(cwd, db);
	const worker = Bun.spawn(["sleep", "30"]);
	try {
		await runner.start();
		const target = insertRunning(db, { owner_pid: worker.pid, owner_boot: "other-boot" });
		const waiting = runner.runUntil(target);
		// Real-clock negative assertion: pre-fix code returned immediately here.
		await sleep(150);
		expect(R.getRun(db, target)!.status).toBe("running");
		db.run("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?", [Date.now(), target]);
		const row = await waiting;
		expect(row!.status).toBe("succeeded");
	} finally {
		worker.kill();
		await runner.close();
		db.close();
	}
});

test("recovery diagnostic states the exact side-effect contract of the run's tool snapshot", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const toolLess = insertRunning(db);
	const legacy = insertRunning(db);
	db.run("UPDATE runs SET tools = ? WHERE id = ?", ['["bash","write"]', legacy]);
	expect(R.recoverStaleRuns(db).sort()).toEqual([toolLess, legacy].sort());
	const readRow = R.getRun(db, toolLess)!;
	// Empty-allowlist sessions could not mutate: the diagnostic says exactly
	// that, and never implies an action journal enumerates side effects.
	expect(readRow.diagnostic).toMatch(/empty tool allowlist/);
	expect(readRow.diagnostic).toMatch(/no external side effect was reachable/);
	expect(readRow.diagnostic).not.toMatch(/action journal/i);
	// A legacy snapshot that could receive tools keeps the conservative
	// contract: effects unenumerable, never blindly rerun.
	const legacyRow = R.getRun(db, legacy)!;
	expect(legacyRow.diagnostic).toMatch(/bash, write/);
	expect(legacyRow.diagnostic).toMatch(/cannot be enumerated/);
	db.close();
});

test("generic recovery never touches Benny rows: their reconciliation belongs to the coordinator", () => {
	const cwd = makeCwd();
	const db = R.openRunStore(cwd);
	const bennyDead = insertRunning(db, { routine: "benny", owner_pid: 999_999_999, owner_boot: "gone" });
	// admitRun writes the runs row with kind 'benny'; force the column on the
	// hand-inserted row the same way.
	db.run("UPDATE runs SET kind = 'benny' WHERE id = ?", [bennyDead]);
	expect(R.recoverStaleRuns(db)).toEqual([]);
	expect(R.getRun(db, bennyDead)!.status).toBe("running");
	const routineDead = insertRunning(db, { owner_pid: 999_999_999, owner_boot: "gone" });
	expect(R.recoverStaleRuns(db)).toEqual([routineDead]);
	db.close();
});

test("private state and routine roots refuse symlinked components", () => {
	const viaParent = makeCwd();
	mkdirSync(join(viaParent, ".omp"));
	symlinkSync(tmpdir(), join(viaParent, ".omp", "pstack"));
	expect(() => R.stateDir(viaParent)).toThrow(/symlink/);

	const viaState = makeCwd();
	mkdirSync(join(viaState, ".omp", "pstack"), { recursive: true });
	symlinkSync(tmpdir(), join(viaState, ".omp", "pstack", "state"));
	expect(() => R.stateDir(viaState)).toThrow(/symlink/);

	const viaStore = makeCwd();
	symlinkSync(join(tmpdir(), "pstack-escape.sqlite"), join(R.profileWorkspaceDir(viaStore, "run-state"), "runs.sqlite"));
	expect(() => R.openRunStore(viaStore)).toThrow(/symlink/);

	const viaRoutines = makeCwd();
	mkdirSync(join(viaRoutines, ".omp", "pstack"), { recursive: true });
	symlinkSync(tmpdir(), join(viaRoutines, ".omp", "pstack", "routines"));
	expect(() => S.createRoutine(viaRoutines, "link-rt", join(viaRoutines, "p.txt"), "m")).toThrow(/symlink/);
});

test("runRoutine cleanup attempts every resource and surfaces aggregate failures", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "cleanup-rt");
	const restoreClose = patchRunnerMethod("close", async () => {
		throw new Error("injected close failure");
	});
	const originalDbClose = Database.prototype.close;
	let dbClosed = false;
	(Database.prototype as unknown as Record<string, unknown>).close = function () {
		dbClosed = true;
		throw new Error("injected db close failure");
	};
	let caught: unknown;
	try {
		await R.runRoutine(cwd, "cleanup-rt", { event_id: "cleanup", body: {} });
	} catch (error) {
		caught = error;
	} finally {
		restoreClose();
		Database.prototype.close = originalDbClose;
	}
	// Both owned resources were attempted even though the first rejected,
	// and every cleanup failure surfaced — aggregated, not dropped.
	const aggregate = caught as AggregateError; // exact thrown type, asserted below
	expect(caught).toBeInstanceOf(AggregateError);
	const messages = aggregate.errors.map(String).join();
	expect(messages).toContain("injected close failure");
	expect(messages).toContain("injected db close failure");
	expect(dbClosed).toBe(true);
});

test("root pstack:watch-pr script uses the hardened wrapper with an actionable no-network failure", () => {
	const packageRoot = join(import.meta.dir, "..");
	// package.json is a known local file; its shape is fixed by this repo.
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
	const script = pkg.scripts["pstack:watch-pr"];
	// The root script must invoke the hardened wrapper, never cli.ts
	// directly: only the wrapper preflights resolution so a missing
	// dependency fails with a hint instead of Bun's raw module error.
	expect(script).toContain("watch-pr/watch-pr");
	// Exact root-script run with commander unavailable: a mirror of the real
	// package (current package.json + shipped wrapper) without node_modules.
	const mirror = mkdtempSync(join(tmpdir(), "pstack-wpr-mirror-"));
	temporary.push(mirror);
	mkdirSync(join(mirror, "skills", "poteto-mode", "scripts"), { recursive: true });
	copyFileSync(join(packageRoot, "package.json"), join(mirror, "package.json"));
	cpSync(join(packageRoot, "skills", "poteto-mode", "scripts", "watch-pr"), join(mirror, "skills", "poteto-mode", "scripts", "watch-pr"), { recursive: true });
	const run = Bun.spawnSync(["bun", "run", "pstack:watch-pr"], { cwd: mirror, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	// Actionable, local failure: the wrapper's own hint and exit code, not a
	// resolution stack trace and never a network auto-install attempt.
	expect(run.exitCode).toBe(1);
	const output = `${run.stderr.toString()}${run.stdout.toString()}`;
	expect(output).toContain("requires commander");
	expect(output).toContain("bun install");
});

test("closing quiesces admission: an in-flight authenticated request is rejected before durable admission; pre-close work stays recoverable", async () => {
	const cwd = makeCwd();
	makeRoutine(cwd, "closing-rt");
	const handle = await S.serve(cwd, "127.0.0.1", 0, { runner: false });
	const key = readFileSync(S.secretsPath(cwd, "closing-rt"), "utf8").trim();
	const url = `http://127.0.0.1:${handle.port}`;
	const db = R.openRunStore(cwd);
	try {
		// Pre-close admission is durable; with no driver it stays queued —
		// recoverable, never lost.
		const pre = await fetch(`${url}/routines/closing-rt`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
				"x-automation-key": key,
				"x-pstack-event-id": "ev-pre-close",
			},
			body: "{}",
		});
		expect(pre.status).toBe(200);
		// An already-entered request parks on its body; closing begins while
		// it is in flight.
		const gate = Promise.withResolvers<void>();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("{}"));
			},
			async pull(controller) {
				await gate.promise;
				controller.close();
			},
		});
		const inflight = fetch(
			`${url}/routines/closing-rt`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
					"x-automation-key": key,
					"x-pstack-event-id": "ev-inflight",
				},
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" },
		);
		// Real-timer exception: the awaited condition (the handler parked
		// mid-body inside the server) is not observable from the client, so
		// no deterministic signal exists; a short bounded delay orders the
		// race, and both outcomes are asserted safe below.
		await Bun.sleep(150);
		await handle.stop();
		gate.resolve();
		// The in-flight request must never be admitted: non-200, always.
		const response = await inflight;
		expect(response.ok).toBe(false);
		expect(response.status).toBe(503);

		// Exactly the pre-close row exists — no new admission after close.
		const rows = db.query("SELECT event_id, status FROM runs ORDER BY id").all() as Array<{ event_id: string; status: string }>;
		expect(rows).toEqual([{ event_id: "ev-pre-close", status: "queued" }]);

		// After closing, new connections are refused outright and any request
		// that still reaches the handler over a lingering keep-alive
		// connection is rejected by the closing gate — never admitted, never
		// 200.
		const post = await fetch(`${url}/routines/closing-rt`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
				"x-automation-key": key,
				"x-pstack-event-id": "ev-post-close",
			},
			body: "{}",
		}).catch(() => undefined);
		expect(post === undefined || post.status !== 200).toBe(true);
		const rowsAfter = db.query("SELECT event_id FROM runs ORDER BY id").all() as Array<{ event_id: string }>;
		expect(rowsAfter).toEqual([{ event_id: "ev-pre-close" }]);
	} finally {
		db.close();
	}
});
