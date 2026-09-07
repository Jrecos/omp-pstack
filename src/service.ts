import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	admitRun,
	assertRoutineEnabled,
	clearRoutineEnableRecord,
	DEFAULT_RUN_TIMEOUT_MS,
	openRunStore,
	ensureStateGitExcluded,
	profileWorkspaceDir,
	type RoutineDef,
	type RoutineEvent,
	PstackError,
	readRoutine,
	routineDefinitionDigest,
	RoutineRunner,
	routinesDir,
	securePrivateDir,
	secretEqual,
	stateDir,
	validateEvent,
	validateRoutineTools,
	writeRoutineEnableRecord,
} from "./runner.ts";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Sender keys are namespaced by canonical workspace identity plus slug and
 * stored outside the repo, in the agent profile: two workspaces reusing a
 * slug never share a key, and a hostile workspace can neither read nor plant
 * the key file. File path only — the key value never leaves the server process.
 */
export function secretsPath(cwd: string, slug: string): string {
	return join(profileWorkspaceDir(cwd, "secrets"), `${slug}.key`);
}

function ensureDirs(cwd: string): void {
	securePrivateDir(cwd, ".omp", "pstack", "routines");
}

export interface CreatedRoutine {
	path: string;
	keyPath: string;
}

export interface CreateRoutineOptions {
	/** Explicit tool allowlist for the routine's model sessions; default is no tools at all. */
	tools?: string[];
}

/**
 * Reads the operator-supplied prompt file. Refuses symlinked or special
 * files, and requires the canonical target to stay inside the workspace so a
 * routine definition can never point the model at host secrets outside the
 * repo.
 */
function readPromptFile(cwd: string, promptFile: string): string {
	const target = resolve(cwd, promptFile);
	let st: Stats | undefined;
	try {
		st = lstatSync(target);
	} catch (error) {
		throw new PstackError(64, `cannot read prompt file '${promptFile}': ${error instanceof Error ? error.message : String(error)}`);
	}
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new PstackError(64, `prompt file '${promptFile}' must be a regular non-symlink file`);
	}
	const root = realpathSync(cwd);
	const canonical = realpathSync(target);
	if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
		throw new PstackError(64, `prompt file '${promptFile}' must live inside the workspace`);
	}
	try {
		return readFileSync(target, "utf8");
	} catch (error) {
		throw new PstackError(64, `cannot read prompt file '${promptFile}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Creates `<cwd>/.omp/pstack/routines/<slug>.json` (no overwrite) plus a
 * mode-0600 random sender key under the workspace-namespaced profile
 * directory. Enablement is NOT stored here: it lives in private profile state
 * (setRoutineEnabled). The prompt file is trusted operator content stored
 * verbatim.
 */
export function createRoutine(cwd: string, slug: string, promptFile: string, model: string, options: CreateRoutineOptions = {}): CreatedRoutine {
	if (!SLUG_RE.test(slug)) throw new PstackError(64, `invalid slug '${slug}': must match ${SLUG_RE.source}`);
	const tools = validateRoutineTools(options.tools);
	ensureDirs(cwd);
	const path = join(routinesDir(cwd), `${slug}.json`);
	if (readRoutine(cwd, slug)) throw new PstackError(64, `routine '${slug}' already exists`);
	const prompt = readPromptFile(cwd, promptFile);
	if (typeof model !== "string" || model.trim().length === 0) throw new PstackError(64, "model selector must be a nonempty string");
	// Private runtime state (sender-log, sessions) must never leak into a
	// commit, whatever the repo's own .gitignore says.
	ensureStateGitExcluded(cwd);
	const def: RoutineDef = { version: 1, name: slug, prompt, model: model.trim(), tools };
	const keyPath = secretsPath(cwd, slug);
	writeFileSync(keyPath, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
	try {
		writeFileSync(path, `${JSON.stringify(def, null, 2)}\n`, { flag: "wx" });
	} catch (error) {
		unlinkSync(keyPath);
		throw error;
	}
	return { path, keyPath };
}

export function listRoutines(cwd: string): RoutineDef[] {
	ensureDirs(cwd);
	const out: RoutineDef[] = [];
	for (const entry of new Bun.Glob("*.json").scanSync({ cwd: routinesDir(cwd) })) {
		out.push(readRoutine(cwd, entry.replace(/\.json$/, ""))!);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Enablement lives only in profile-private state bound to the definition
 * digest: enabling records it, disabling clears it. A committed
 * `enabled:true` in the routine JSON can never enable.
 */
export function setRoutineEnabled(cwd: string, slug: string, enabled: boolean): RoutineDef {
	// The enable path precedes all later state writes; anchor the exclusion
	// here too so an enable in a fresh clone cannot precede the anchor.
	ensureStateGitExcluded(cwd);
	const def = readRoutine(cwd, slug);
	if (!def) throw new PstackError(64, `unknown routine '${slug}'`);
	if (enabled) writeRoutineEnableRecord(cwd, slug, routineDefinitionDigest(cwd, slug));
	else clearRoutineEnableRecord(cwd, slug);
	return def;
}

export interface SenderLogEntry {
	at: number;
	slug: string;
	event_id: string;
	ok: boolean;
	error?: string;
}

function senderLogPath(cwd: string): string {
	return join(stateDir(cwd), "sender-log.jsonl");
}

function logSender(cwd: string, entry: SenderLogEntry): void {
	try {
		writeFileSync(senderLogPath(cwd), `${JSON.stringify(entry)}\n`, { flag: "a" });
	} catch {
		// best-effort failure log
	}
}

function readKey(cwd: string, slug: string): string {
	return readFileSync(secretsPath(cwd, slug), "utf8").trim();
}

export interface ServeHandle {
	host: string;
	port: number;
	stop(): Promise<void>;
}

export interface ServeOptions {
	/** Start the SDK runner (default true). Tests may disable it to keep admission storage-only. */
	runner?: boolean;
}

/**
 * Combined serve shutdown (routine listener + optional Benny socket): every
 * owned close is attempted even when an earlier one rejects, and all failures
 * surface — one directly, several aggregated. A failing socket.close can
 * never leak the listener (or vice versa).
 */
export async function stopServeStack(socket: { close(): Promise<void> } | undefined, handle: { stop(): Promise<void> }): Promise<void> {
	const errors: unknown[] = [];
	try {
		await socket?.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await handle.stop();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "serve shutdown failed for one or more owned resources");
}

/**
 * Local automation listener (server-to-server only):
 *  - GET  /healthz                  readiness, secret-free
 *  - GET  /routines/:slug/send      button page; key never reaches the browser
 *  - POST /routines/:slug/send      server-side one-try sender (8s), fresh UUID per action
 *  - POST /routines/:slug           authenticated durable admission
 * Duplicates on the same event id return the same run. Sender routes accept
 * only same-origin Host/Origin for the explicitly bound address; forwarded
 * host headers are never honored. Admission itself rejects any Origin header.
 * HTTP 200 is returned only after durable admission; the routine is woken
 * afterwards.
 */
export async function serve(cwd: string, host = "127.0.0.1", port = 8787, options: ServeOptions = {}): Promise<ServeHandle> {
	// A wildcard bind cannot support meaningful same-origin Host validation for
	// the sender; require an explicit loopback or host address.
	if (["0.0.0.0", "::", "*", ""].includes(host)) {
		throw new PstackError(64, `refusing wildcard bind '${host}': pass an explicit loopback or host address so sender same-origin checks are meaningful`);
	}
	// Private runtime state must be uncommitable before the run store and
	// sender log exist.
	ensureStateGitExcluded(cwd);
	const db = openRunStore(cwd);
	const runner = new RoutineRunner(cwd, db);
	const runnerActive = options.runner !== false;
	// Declared before startup so a partial-start failure can stop a bound
	// server; fetch closures read it only after Bun.serve has returned.
	let server: Bun.Server<undefined> | undefined;
	// Set before the listener stops accepting: any request that already
	// entered the fetch handler is rejected before its durable admission, so
	// no authenticated request can be admitted — or receive 200 — after
	// closing starts. Work admitted before close drains via runner.close().
	let closing = false;
	/**
	 * Attempts EVERY owned resource even when an earlier cleanup rejects, so a
	 * failing runner.close() never leaks the bound server or the sqlite
	 * handle. Returns each cleanup failure; the caller decides how to surface
	 * them.
	 */
	async function closeOwned(): Promise<unknown[]> {
		const errors: unknown[] = [];
		// Quiesce FIRST: mark closing and stop the listener (gracefully —
		// already-entered requests may finish, but the closing gate below
		// rejects them before durable admission), then drain/close the runner
		// and the store. Every owned resource is attempted even when an
		// earlier cleanup rejects.
		closing = true;
		if (server) {
			try {
				server.stop();
			} catch (error) {
				errors.push(error);
			}
			server = undefined;
		}
		try {
			await runner.close();
		} catch (error) {
			errors.push(error);
		}
		try {
			db.close();
		} catch (error) {
			errors.push(error);
		}
		return errors;
	}
	try {
		if (runnerActive) await runner.start();
		runner.recover();
	} catch (error) {
		// Partial-start failure: close what startup already owns (the store and
		// the runner's partial state) before surfacing the primary error.
		const cleanup = await closeOwned();
		if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], "serve startup failed; cleanup errors attached");
		throw error;
	}
	let base = "";

	async function sendToSelf(slug: string, eventId?: string): Promise<{ ok: boolean; event_id: string; error?: string }> {
		const id = eventId ?? crypto.randomUUID();
		logSender(cwd, { at: Date.now(), slug, event_id: id, ok: false, error: "pending" });
		// harmless probe: reachability only, never admits anything
		try {
			await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
		} catch (error) {
			const message = `probe failed: ${error instanceof Error ? error.message : String(error)}`;
			logSender(cwd, { at: Date.now(), slug, event_id: id, ok: false, error: message });
			return { ok: false, event_id: id, error: message };
		}
		try {
			const key = readKey(cwd, slug);
			const response = await fetch(`${base}/routines/${slug}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
					"x-automation-key": key,
					"x-pstack-event-id": id,
				},
				body: "{}",
				signal: AbortSignal.timeout(8000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			logSender(cwd, { at: Date.now(), slug, event_id: id, ok: true });
			return { ok: true, event_id: id };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logSender(cwd, { at: Date.now(), slug, event_id: id, ok: false, error: message });
			return { ok: false, event_id: id, error: message };
		}
	}

	function sendPage(slug: string): Response {
		return new Response(
			`<!doctype html><html><body>
<button id="go">Send routine event</button>
<input id="replay" placeholder="event id to replay">
<button id="re">Replay</button>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
async function post(id) {
  const r = await fetch("/routines/${slug}/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { event_id: id } : {}) });
  out.textContent = JSON.stringify(await r.json());
}
document.getElementById("go").onclick = () => post(null);
document.getElementById("re").onclick = () => post(document.getElementById("replay").value.trim());
</script></body></html>`,
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	}

	// Bun types hostname as possibly undefined; the wildcard bind was already
	// rejected, so coalesce to the requested host for all same-origin math.
	let boundHostname = host;
	// Bind inside the guarded startup: a busy port must release the runner
	// and the sqlite store exactly like a failed runner.start, never leak
	// them past an unguarded Bun.serve throw.
	try {
		server = Bun.serve({
		port,
		hostname: host,
		maxRequestBodySize: 1024 * 1024,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			const parts = url.pathname.split("/").filter(Boolean);
			if (url.pathname === "/healthz" && request.method === "GET") {
				return Response.json({ ok: true, port: server!.port });
			}
			if (parts[0] !== "routines" || typeof parts[1] !== "string") return new Response("not found", { status: 404 });
			const slug = parts[1];
			if (!SLUG_RE.test(slug)) return new Response("not found", { status: 404 });
			// Browsers never receive the sender key; they may only ask this
			// server to send. Same-origin only: the Host header must name the
			// bound address (localhost convenience for loopback binds), and
			// forwarded-host headers are rejected outright so a proxy trick
			if (parts[2] === "send") {
				// The browser-facing sender relay is a same-origin privilege, not
				// an authenticated API; on a non-loopback bind it would let any
				// local page relay routine wake events unauthenticated. The
				// routine endpoint below stays key-protected everywhere.
				if (!["127.0.0.1", "::1", "localhost"].includes(boundHostname.toLowerCase())) {
					return new Response("sender relay requires a loopback bind; the routine endpoint remains available with its keys", { status: 403 });
				}
				for (const header of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-port"]) {
					if (request.headers.has(header)) return new Response("forwarded headers are not honored", { status: 403 });
				}
				const selfPort = server!.port!;
				const hostToken = boundHostname.includes(":") ? `[${boundHostname}]` : boundHostname;
				const allowedHosts = [`${hostToken}:${selfPort}`.toLowerCase()];
				if (["127.0.0.1", "::1"].includes(boundHostname)) {
					allowedHosts.push(`localhost:${selfPort}`, `127.0.0.1:${selfPort}`, `[::1]:${selfPort}`);
				}
				const hostHeader = (request.headers.get("host") ?? "").trim().toLowerCase();
				if (!allowedHosts.includes(hostHeader)) return new Response("host mismatch", { status: 403 });
				const origin = request.headers.get("origin");
				if (origin && origin !== url.origin) return new Response("cross-origin sender request denied", { status: 403 });
				if (request.method === "GET") return sendPage(slug);
				if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
				if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return new Response("JSON required", { status: 415 });
				let payload: unknown;
				try { payload = await request.json(); } catch { return new Response("invalid JSON", { status: 400 }); }
				if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Response("JSON object required", { status: 400 });
				const replay = "event_id" in payload ? payload.event_id : undefined;
				if (replay !== undefined && (typeof replay !== "string" || !replay.length || replay.length > 128)) return new Response("invalid event_id", { status: 400 });
				const result = await sendToSelf(slug, replay);
				return Response.json(result, { status: result.ok ? 200 : 502 });
			}
			if (parts.length !== 2 || request.method !== "POST") return new Response("not found", { status: 404 });
			// Admission gate: no browsers, no unauthenticated or unknown traffic.
			if (request.headers.has("origin")) {
				return Response.json({ ok: false, error: "origin header not allowed; server-to-server only" }, { status: 403 });
			}
			const def = readRoutine(cwd, slug);
			if (!def) return Response.json({ ok: false, error: "unknown routine" }, { status: 404 });
			// Enablement is private profile state bound to the definition
			// digest; a committed `enabled:true` cannot enable and drift after
			// enablement fails closed.
			try {
				assertRoutineEnabled(cwd, slug, def);
			} catch (error) {
				return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 409 });
			}
			const expected = readKey(cwd, slug);
			const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
			const automation = request.headers.get("x-automation-key") ?? "";
			if (!secretEqual(bearer, expected) || !secretEqual(automation, expected)) {
				return Response.json({ ok: false, error: "authentication failed" }, { status: 401 });
			}
			const raw = new Uint8Array(await request.arrayBuffer());
			if (raw.byteLength > 1024 * 1024) {
				return Response.json({ ok: false, error: "body exceeds 1 MiB" }, { status: 413 });
			}
			let body: unknown;
			try {
				body = JSON.parse(new TextDecoder().decode(raw));
			} catch {
				return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 });
			}
			if (body === null || typeof body !== "object" || Array.isArray(body)) {
				return Response.json({ ok: false, error: "body must be a JSON object" }, { status: 400 });
			}
			const eventId = request.headers.get("x-pstack-event-id") ?? "";
			// Persisted with the event so the documented wake envelope
			// reconstructs identically after a restart. Only the documented
			// non-secret headers are kept: the two key headers never leave
			// this gate into run state or the session.
			const headers: Record<string, string> = {};
			for (const name of ["content-type", "user-agent"]) {
				const value = request.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			const event: RoutineEvent = { event_id: eventId, body, headers, timestamp_ms: Date.now() };
			try {
				validateEvent(event);
			} catch (error) {
				return Response.json(
					{ ok: false, error: error instanceof Error ? error.message : String(error) },
					{ status: 400 },
				);
			}
			if (closing) {
				// An already-entered request is rejected before its durable
				// admission; replays with the same event id after a restart
				// dedupe against nothing — nothing was admitted here.
				return Response.json({ ok: false, error: "server is shutting down; event not admitted" }, { status: 503 });
			}
			const { runId, duplicate } = admitRun(db, slug, event, def.prompt, def.model, DEFAULT_RUN_TIMEOUT_MS, "routine", def.tools);
			if (runnerActive) runner.wake();
			return Response.json({ ok: true, run_id: runId, duplicate }, { status: 200 });
		},
	});
	} catch (error) {
		const cleanup = await closeOwned();
		if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], "serve startup failed; cleanup errors attached");
		throw error;
	}
	boundHostname = server.hostname ?? host;
	const selfHost = boundHostname.includes(":") ? `[${boundHostname}]` : boundHostname;
	base = `http://${selfHost}:${server.port}`;
	if (runnerActive) runner.wake();
	process.stderr.write(`${JSON.stringify({ event: "listening", host: boundHostname, port: server.port })}\n`);
	return {
		host: boundHostname,
		port: server.port!,
		async stop() {
			// Every owned resource is attempted even if an earlier cleanup
			// rejects; all failures surface — one directly, several aggregated.
			const errors = await closeOwned();
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "serve stop failed for one or more owned resources");
		},
	};
}
