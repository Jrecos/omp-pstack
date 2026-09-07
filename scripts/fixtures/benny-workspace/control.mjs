#!/usr/bin/env bun
/**
 * Trusted Benny control adapter (fixture) — controller side.
 *
 * Runs ONLY in the controller container, which never mounts the worktree. The
 * adapter binary is root-owned at /opt/benny-control and is invoked from that
 * config-free cwd with a scrubbed environment, so worker-controlled bunfig
 * preload or ambient env can never precede trusted code. Chromium's CDP
 * endpoint binds 127.0.0.1 inside the controller; arbitrary worker processes
 * on the shared internal network cannot reach it, and all captures/state live
 * on controller-private staging/tmpfs.
 *
 * The target app is started by the coordinator in the WORKER container
 * (operator-configured command/port) and passed to bring-up as input.appUrl.
 *
 * Protocol: one JSON request on stdin -> one JSON response on stdout.
 * Request:  { capability, input, runId, revision, artifactDir, config, deadlineAt }
 * Response: { ok: true, result, artifacts } | { ok: false, error }
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const STATE_DIR = "/tmp/benny-control";
const STATE_FILE = join(STATE_DIR, "state.json");
const CDP_PORT = 9222;
const APP_MARKER_DEFAULT = "benny-fixture-counter";
const CAPABILITIES = ["bring-up", "drive-ui", "drive-features", "inspect-state", "screenshot", "recording", "cleanup"];

function request() {
	return JSON.parse(readFileSync("/dev/stdin", "utf8"));
}

function respond(response) {
	process.stdout.write(JSON.stringify(response) + "\n");
}

function ok(result, artifacts = []) {
	respond({ ok: true, result, artifacts });
}

function failure(error) {
	respond({ ok: false, error });
}

function readState() {
	return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}

function writeState(state) {
	writeFileSync(STATE_FILE, JSON.stringify(state));
}

function killIfAlive(pid, signal = "SIGTERM") {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM with SIGKILL escalation: no stale recording worker survives the run. */
async function killHard(pid) {
	if (!killIfAlive(pid, "SIGTERM")) return false;
	await Bun.sleep(2000);
	killIfAlive(pid, "SIGKILL");
	return true;
}

async function waitHttp(url, timeoutMs, { put = false } = {}) {
	const started = Date.now();
	for (;;) {
		try {
			const response = await fetch(url, put ? { method: "PUT" } : undefined);
			if (response.ok) return response;
		} catch {
			// retry until the timeout expires
		}
		if (Date.now() - started > timeoutMs) return null;
		await Bun.sleep(200);
	}
}

function stopBrowser(state) {
	const stopped = [];
	if (state.recording?.pid && killIfAlive(state.recording.pid)) stopped.push("recording-worker");
	if (state.chromePid && killIfAlive(state.chromePid)) stopped.push("chromium");
	return stopped;
}

// --- Minimal CDP client over Bun WebSocket ---------------------------------

function connectCdp(wsUrl) {
	const socket = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();
	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data));
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(`CDP ${message.error.message ?? "error"}`));
			else resolve(message.result);
		}
	});
	const ready = new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
	});
	const call = (method, params = {}) => {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	};
	return { ready, call, close: () => socket.close() };
}

async function cdpSession() {
	const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
	const page = targets.find(target => target.type === "page" && target.url !== "about:blank") ?? targets.find(target => target.type === "page");
	if (!page) throw new Error("no CDP page target");
	const session = connectCdp(page.webSocketDebuggerUrl);
	await session.ready;
	await session.call("Page.enable");
	await session.call("Runtime.enable");
	return session;
}

async function evaluate(session, expression) {
	const result = await session.call("Runtime.evaluate", { expression, returnByValue: true });
	if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
	return result.result?.value;
}

async function centerOf(session, selector) {
	const rect = await evaluate(
		session,
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element " + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
	);
	return rect;
}

async function mouseClick(session, x, y) {
	await session.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await session.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// --- Capabilities -----------------------------------------------------------

const READ_ONLY_QUERIES = {
	counter: "document.querySelector('[data-testid=count]')?.textContent ?? null",
	items: "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=item]')).map(el => el.textContent))",
	input: "document.querySelector('[data-testid=item-input]')?.value ?? null",
	url: "location.href",
	marker: "document.body?.dataset?.bennyApp ?? null",
	viewport: "JSON.stringify({ width: innerWidth, height: innerHeight })",
};

/**
 * Bring up the target app (already running in the worker at input.appUrl) in
 * the controller's private Chromium. The adapter never launches worktree code.
 */
async function bringUp(input) {
	const appUrl = typeof input.appUrl === "string" ? input.appUrl : "";
	let parsedUrl;
	try {
		parsedUrl = new URL(appUrl);
	} catch {
		failInput("bring-up requires input.appUrl (http:// URL of the app inside the workspace network)");
	}
	if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "benny-worker" || parsedUrl.port !== String(8791)) {
		failInput("bring-up appUrl must target the fixture worker on its fixed internal port");
	}
	const marker = typeof input.marker === "string" ? input.marker : APP_MARKER_DEFAULT;
	const state = readState();
	const stopped = stopBrowser(state);
	rmSync(STATE_DIR, { recursive: true, force: true });
	mkdirSync(STATE_DIR, { recursive: true });
	mkdirSync(join(STATE_DIR, "home"), { recursive: true });
	mkdirSync(join(STATE_DIR, "profile"), { recursive: true });

	// App reachability is verified through the page itself, not a side channel.
	const chrome = Bun.spawn(
		[
			"chromium", "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
			"--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${join(STATE_DIR, "profile")}`, "about:blank",
		],
		{ stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: join(STATE_DIR, "home") } },
	);
	chrome.unref();
	const version = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 15_000);
	if (!version) {
		killIfAlive(chrome.pid);
		throw new Error("chromium DevTools endpoint did not become ready");
	}
	const created = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(appUrl)}`, 10_000, { put: true });
	if (!created) {
		killIfAlive(chrome.pid);
		throw new Error(`could not open a page for ${appUrl}`);
	}
	const target = await created.json();
	writeState({ chromePid: chrome.pid, marker, appUrl, targetId: target.id ?? null });

	// Stable app marker: prove the correct app/environment is under test.
	// The page may still be loading; poll until the marker appears.
	const session = await cdpSession();
	let observedMarker = null;
	const markerDeadline = Date.now() + 15_000;
	while (Date.now() < markerDeadline) {
		observedMarker = await evaluate(session, "document.body?.dataset?.bennyApp ?? null");
		if (observedMarker === marker) break;
		await Bun.sleep(250);
	}
	await session.close();
	if (observedMarker !== marker) throw new Error(`stable app marker mismatch: expected '${marker}', observed '${JSON.stringify(observedMarker)}'`);
	return { sessionId: `benny-${target.id ?? "page"}`, marker, appUrl, capabilities: CAPABILITIES, stopped };
}

function failInput(message) {
	throw new Error(message);
}

async function driveUi(input) {
	const session = await cdpSession();
	const performed = [];
	for (const action of Array.isArray(input.actions) ? input.actions : []) {
		if (action.kind === "click") {
			const center = await centerOf(session, action.selector);
			await mouseClick(session, center.x, center.y);
			performed.push({ kind: "click", selector: action.selector });
		} else if (action.kind === "type") {
			if (action.selector) {
				const center = await centerOf(session, action.selector);
				await mouseClick(session, center.x, center.y);
			}
			await session.call("Input.insertText", { text: String(action.text ?? "") });
			performed.push({ kind: "type", text: String(action.text ?? "") });
		} else if (action.kind === "key") {
			await session.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: action.key, code: action.code ?? action.key });
			await session.call("Input.dispatchKeyEvent", { type: "keyUp", key: action.key, code: action.code ?? action.key });
			performed.push({ kind: "key", key: action.key });
		} else if (action.kind === "scroll") {
			const center = action.selector ? await centerOf(session, action.selector) : { x: 400, y: 300 };
			await session.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: action.dy ?? 120 });
			performed.push({ kind: "scroll", dy: action.dy ?? 120 });
		} else if (action.kind === "resize") {
			await session.call("Emulation.setDeviceMetricsOverride", { width: action.width ?? 1280, height: action.height ?? 720, deviceScaleFactor: 1, mobile: false });
			performed.push({ kind: "resize", width: action.width ?? 1280, height: action.height ?? 720 });
		} else {
			await session.close();
			throw new Error(`unsupported drive-ui action kind '${action.kind}'`);
		}
		if (action.observe) {
			performed[performed.length - 1].observed = await evaluate(session, READ_ONLY_QUERIES[action.observe] ?? throwUnavailable(action.observe));
		}
	}
	await session.close();
	return { actions: performed };
}

function throwUnavailable(query) {
	throw new Error(`unsupported drive-ui observe query '${query}'`);
}

// Mapped feature actions are implemented through the same real-UI primitives,
// never by direct state injection. Unknown features/actions fail closed.
const FEATURE_ACTIONS = {
	counter: {
		increment: [{ kind: "click", selector: "[data-testid=increment]" }],
		decrement: [{ kind: "click", selector: "[data-testid=decrement]" }],
		reset: [{ kind: "click", selector: "[data-testid=reset]" }],
		addItem: [
			{ kind: "click", selector: "[data-testid=item-input]" },
			{ kind: "type", text: "{value}" },
			{ kind: "click", selector: "[data-testid=add]" },
		],
	},
};

async function driveFeatures(input) {
	const actions = FEATURE_ACTIONS[input.feature];
	if (!actions || !actions[input.action]) {
		throw new Error(`feature '${input.feature}' action '${input.action}' is not mapped in the control adapter`);
	}
	const expanded = actions[input.action].map(step => ({ ...step, text: step.text === "{value}" ? String(input.value ?? "") : step.text }));
	const receipt = await driveUi({ actions: expanded.map(step => ({ ...step, observe: step.kind === "click" ? "counter" : undefined })) });
	return input.action === "reset" ? { ...receipt, resetId: crypto.randomUUID() } : receipt;
}

async function inspectState(input) {
	const expression = READ_ONLY_QUERIES[input.query];
	if (!expression) throw new Error(`unsupported read-only state query '${input.query}'`);
	const session = await cdpSession();
	const value = await evaluate(session, expression);
	await session.close();
	return { query: input.query, value };
}

async function screenshot(input) {
	const path = input.path;
	if (typeof path !== "string" || !path.startsWith("/artifacts/")) throw new Error("screenshot path must be under /artifacts");
	const session = await cdpSession();
	const capture = await session.call("Page.captureScreenshot", { format: "png" });
	await session.close();
	mkdirSync("/artifacts", { recursive: true });
	writeFileSync(path, Buffer.from(capture.data, "base64"));
	return { path, at: Date.now(), marker: readState().marker ?? null, description: input.description ?? "current app state", window: "page viewport" };
}

// Real screen recording: live Chromium screencast frames with true capture
// timestamps, muxed by ffmpeg into a real video container.
async function recording(input) {
	const path = input.path;
	if (typeof path !== "string" || !path.startsWith("/artifacts/")) throw new Error("recording path must be under /artifacts");
	const state = readState();
	if (input.action === "start") {
		if (state.recording) {
			await killHard(state.recording.pid);
			state.recording = null;
		}
		const framesDir = join(STATE_DIR, `frames-${Date.now()}`);
		mkdirSync(framesDir, { recursive: true });
		const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
		const page = targets.find(target => target.type === "page" && target.url !== "about:blank");
		if (!page) throw new Error("no app page target for recording");
		const worker = Bun.spawn(["bun", "/opt/benny-control/control.mjs", "__record", page.webSocketDebuggerUrl, framesDir], {
			stdout: "ignore", stderr: "ignore",
		});
		worker.unref();
		state.recording = { pid: worker.pid, framesDir, startedAt: Date.now(), path };
		writeState(state);
		return { recordingPath: path, startedAt: state.recording.startedAt, region: "page viewport", audio: false };
	}
	if (input.action === "stop") {
		if (!state.recording) throw new Error("no recording in progress");
		const recordingPid = state.recording.pid;
		try {
			killIfAlive(recordingPid, "SIGTERM");
			const deadline = Date.now() + 10_000;
			while (existsSync(join(state.recording.framesDir, "done")) === false && Date.now() < deadline) await Bun.sleep(200);
			const files = existsSync(state.recording.framesDir) ? Array.from(new Bun.Glob("frame-*.png").scanSync({ cwd: state.recording.framesDir })).sort() : [];
			if (files.length === 0) throw new Error("recording captured no frames");
			// Per-frame real durations from the screencast capture timestamps.
			let lines = "";
			for (let index = 0; index < files.length; index++) {
				const stamp = Number(basename(files[index]).match(/frame-(\d+)/)?.[1]);
				const next = index + 1 < files.length ? Number(basename(files[index + 1]).match(/frame-(\d+)/)?.[1]) : stamp + 100;
				lines += `file '${files[index]}'\nduration ${Math.max(0.04, (next - stamp) / 1000)}\n`;
			}
			lines += `file '${files[files.length - 1]}'\n`;
			writeFileSync(join(state.recording.framesDir, "concat.txt"), lines);
			mkdirSync("/artifacts", { recursive: true });
			const mux = Bun.spawn(
				["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(state.recording.framesDir, "concat.txt"), "-c:v", "libvpx", "-b:v", "1M", "-auto-alt-ref", "0", path],
				{ stderr: "pipe" },
			);
			const muxError = await new Response(mux.stderr).text();
			const muxCode = await mux.exited;
			const stoppedAt = Date.now();
			const result = { recordingPath: path, startedAt: state.recording.startedAt, stoppedAt, region: "page viewport", audio: false, frames: files.length };
			if (muxCode !== 0) throw new Error(`ffmpeg mux failed: ${muxError.slice(0, 300)}`);
			return result;
		} finally {
			// No stale worker or frames dir survives a failed stop; the next
			// recording start or cleanup begins from a clean slate.
			await killHard(recordingPid);
			rmSync(state.recording.framesDir, { recursive: true, force: true });
			state.recording = null;
			writeState(state);
		}
	}
	throw new Error("recording input.action must be 'start' or 'stop'");
}

// Recording worker: holds a live CDP screencast between two docker exec calls.
// Frames carry their real capture timestamps in the filename.
if (process.argv[2] === "__record") {
	const [wsUrl, framesDir] = process.argv.slice(3);
	const raw = new WebSocket(wsUrl);
	let screencastId = 0;
	raw.addEventListener("message", event => {
		const message = JSON.parse(String(event.data));
		if (message.method === "Page.screencastFrame") {
			const timestamp = message.params?.metadata?.timestamp ?? Date.now() / 1000;
			const name = `frame-${String(Math.round(timestamp * 1000)).padStart(15, "0")}.png`;
			if (!existsSync(join(framesDir, name))) writeFileSync(join(framesDir, name), Buffer.from(message.params.data, "base64"));
			raw.send(JSON.stringify({ id: ++screencastId, method: "Page.screencastFrameAck", params: { sessionId: message.params.sessionId } }));
		}
	});
	raw.addEventListener("open", () => {
		raw.send(JSON.stringify({ id: ++screencastId, method: "Page.enable", params: {} }));
		raw.send(JSON.stringify({ id: ++screencastId, method: "Page.startScreencast", params: { format: "png", everyNthFrame: 1 } }));
	});
	process.on("SIGTERM", () => {
		try {
			raw.send(JSON.stringify({ id: ++screencastId, method: "Page.stopScreencast", params: {} }));
		} catch {
			// socket may already be closed
		}
		writeFileSync(join(framesDir, "done"), "1");
		setTimeout(() => process.exit(0), 300);
	});
} else {
	const input = request();
	try {
		if (input.capability === "bring-up") ok(await bringUp(input.input ?? {}));
		else if (input.capability === "drive-ui") ok(await driveUi(input.input ?? {}));
		else if (input.capability === "drive-features") ok(await driveFeatures(input.input ?? {}));
		else if (input.capability === "inspect-state") ok(await inspectState(input.input ?? {}));
		else if (input.capability === "screenshot") {
			const shotPath = typeof input.input?.path === "string" ? input.input.path : "/artifacts/screenshot.png";
			ok(await screenshot(input.input ?? {}), [shotPath]);
		} else if (input.capability === "recording") {
			const result = await recording(input.input ?? {});
			ok(result, input.input?.action === "stop" ? [result.recordingPath] : []);
		} else if (input.capability === "cleanup") ok(await cleanup());
		else failure(`unknown capability '${input.capability}'`);
	} catch (error) {
		failure(error instanceof Error ? error.message : String(error));
	}
}

async function cleanup() {
	const state = readState();
	const stopped = stopBrowser(state);
	rmSync(STATE_DIR, { recursive: true, force: true });
	mkdirSync(STATE_DIR, { recursive: true });
	return { stopped, removed: [STATE_DIR], retained: ["/artifacts"], note: "controller-private state removed; artifact evidence retained; never touches user work" };
}
