/**
 * Slack Socket Mode transport for Benny: `apps.connections.open` over a Bun
 * WebSocket with bounded exponential reconnect, feeding the SAME durable
 * admission (runBenny) as the external CLI. events_api envelopes are
 * acknowledged only after durable admission (or a deliberate rejection), so
 * an acknowledged event can never be lost and redeliveries dedupe in the
 * store; valid frames of deliberately unsupported trigger types
 * (interactive, slash_commands) are acknowledged immediately without any
 * admission, while malformed and policy-rejected frames stay unacknowledged.
 * A fixed capacity of MAX_SOCKET_CONCURRENT_RUNS long-lived run drivers
 * bounds concurrency: frames beyond it allocate nothing and stay
 * unacknowledged so Slack retries after a slot frees.
 */
import { z } from "zod";
import { assertBennyEndpointPolicy, assertBennyEnabled, BennyError, loadBennyConfig, targetRootFor } from "./benny.ts";
import { resolveImageId, sweepExpiredEvidence } from "./benny-workspace.ts";
import { resumeBenny, runBenny } from "./benny-run.ts";
import { readBoundedJsonObject } from "./benny-actions.ts";
import { selectBennyEvent } from "./benny-policy.ts";
/** Bounded exponential reconnect; the index resets on `hello`. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const OPEN_TIMEOUT_MS = 10_000;
/** Remote-controlled inbound sizes are bounded: no response or frame is ever drained past these caps. */
const MAX_OPEN_RESPONSE_BYTES = 1 * 1024 * 1024;
export const MAX_SOCKET_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * Fixed capacity for long-lived runBenny drivers on one socket link. Beyond
 * this many concurrent distinct admissions, frames are left unacknowledged
 * so Slack retries after a slot frees; duplicate deliveries of an in-flight
 * event never consume a second slot.
 */
export const MAX_SOCKET_CONCURRENT_RUNS = 4;

export interface SocketRunGateDeps {
	/** Start one driver; onAdmitted fires exactly once after durable admission. */
	run(event: unknown, onAdmitted: () => void): Promise<unknown>;
	/** Acknowledge one envelope on the link that delivered its frame. */
	ack(envelopeId: string, link: WebSocket): void;
	/** Diagnostic for a frame refused by capacity (it stays unacknowledged). */
	refused(envelopeId: string): void;
}

/**
 * Fixed-capacity gate for long-lived Benny run drivers. Distinct events
 * beyond `maxDrivers` allocate no driver at all (no store, no timer) and
 * stay unacknowledged — Slack redelivers them once a slot frees. A
 * redelivery of an already-tracked event is a dedupe, never a new slot: it
 * is acknowledged only once the original driver is durably admitted (acking
 * earlier could mark an event delivered that was later rejected before
 * admission). A driver that resolves without admission is a deliberately
 * ignored valid event: it is acknowledged on settlement. Drains at most
 * `maxDrivers` promises on close.
 */
export class SocketRunGate {
	#drivers = new Map<string, { settled: Promise<unknown>; admitted: boolean }>();
	#unkeyed = 0;
	constructor(
		readonly maxDrivers: number,
		private readonly deps: SocketRunGateDeps,
	) {}

	get size(): number {
		return this.#drivers.size;
	}

	handle(envelopeId: string, identity: { eventId: string } | null, event: unknown, link: WebSocket): void {
		const active = identity === null ? undefined : this.#drivers.get(identity.eventId);
		if (active) {
			if (active.admitted) this.deps.ack(envelopeId, link);
			// Not yet admitted: stay silent; Slack redelivers until the
			// original admission lands. Never a second driver.
			return;
		}
		if (this.#drivers.size >= this.maxDrivers) {
			this.deps.refused(envelopeId);
			return;
		}
		const key = identity?.eventId ?? `\u0000#${this.#unkeyed++}`;
		const driver: { settled: Promise<unknown>; admitted: boolean } = { settled: undefined as unknown as Promise<unknown>, admitted: false };
		driver.settled = this.deps.run(event, () => {
			driver.admitted = true;
			this.deps.ack(envelopeId, link);
		});
		this.#drivers.set(key, driver);
		void driver.settled.then(
			() => {
				// Resolved without durable admission: a deliberately ignored
				// valid event (no work, no row) is still acknowledged exactly
				// once so Slack never redelivers it; admitted drivers already
				// acked via onAdmitted.
				if (!driver.admitted) this.deps.ack(envelopeId, link);
			},
			() => {
				// Pre-admission failure (including a deliberate policy
				// rejection) stays unacknowledged so Slack retries; a driver
				// admitted before throwing already acked via onAdmitted.
			},
		).finally(() => {
			if (this.#drivers.get(key) === driver) this.#drivers.delete(key);
		});
	}

	/** Resolves once every active driver has settled: the close barrier. */
	async drain(): Promise<void> {
		while (this.#drivers.size > 0) {
			await Promise.allSettled([...this.#drivers.values()].map((driver) => driver.settled));
		}
	}
}

export interface BennySocket {
	close(): Promise<void>;
	ready: Promise<void>;
}

/** Slack errors that are configuration faults, never transient. */
const FATAL_OPEN_ERRORS: Record<string, true> = {
	invalid_auth: true,
	missing_scope: true,
	fatal_error: true,
	token_revoked: true,
	account_inactive: true,
};

const OpenResponse = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	url: z.string().url().optional(),
});
const SocketFrame = z.object({
	type: z.string(),
	envelope_id: z.string().optional(),
	payload: z.unknown().optional(),
	reason: z.string().optional(),
});
/** Valid Socket Mode frames of deliberately unsupported trigger types: acknowledged immediately so Slack never redelivers, with no work admitted. */
const UNSUPPORTED_ACK_TYPES: Record<string, true> = {
	interactive: true,
	slash_commands: true,
};

/**
 * Earliest type-specific size check for an inbound frame, before any
 * stringification, Blob-to-text conversion, or JSON parse. A remote peer can
 * never make the host allocate a converted payload past this bound; the
 * caller closes the link instead of reading the frame.
 */
export function oversizedFrame(data: unknown, maxBytes: number): boolean {
	// A string frame is bound by its on-wire UTF-8 byte length, never its
	// UTF-16 code-unit count: multibyte content can double the wire size.
	if (typeof data === "string") return Buffer.byteLength(data, "utf8") > maxBytes;
	if (data instanceof Blob) return data.size > maxBytes;
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
		return (data as ArrayBufferView).byteLength > maxBytes;
	}
	return false;
}
export async function startBennySocket(configPath: string, options: { signal?: AbortSignal } = {}): Promise<BennySocket> {
	const config = await loadBennyConfig(configPath);
	if (config.runtime.trigger !== "socket-mode") {
		throw new BennyError(2, `configuration sets runtime.trigger '${config.runtime.trigger}'; Socket Mode requires 'socket-mode'`);
	}
	// Readiness must fail on a retagged workspace image here, not per event
	// after pre-admission: resolve the live id once and gate enablement on it.
	const imageId = await resolveImageId(config.runtime.workspace_image);
	assertBennyEnabled(targetRootFor(configPath), config, imageId);
	assertBennyEndpointPolicy(config);
	const appToken = process.env[config.runtime.slack_app_token_env];

	let closed = false;
	let socket: WebSocket | undefined;
	let reconnectAttempt = 0;
	let readySettled = false;
	// The socket owns the run signals: close() aborts in-flight runs and the
	// reconnect loop waits on this controller too. An external abort invokes
	// the SAME idempotent stop as an internal close, and the listener is
	// removed on close so a shared signal never fires after disposal.
	const shutdown = new AbortController();
	const onExternalAbort = (): void => stop();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	// Fixed-capacity gate: at most MAX_SOCKET_CONCURRENT_RUNS long-lived
	// runBenny drivers exist. Frames beyond capacity allocate no driver,
	// store or timer and stay unacknowledged so Slack retries after a slot
	// frees; redeliveries of an in-flight event never take a second slot.
	const gate = new SocketRunGate(MAX_SOCKET_CONCURRENT_RUNS, {
		run: (event, onAdmitted) =>
			// The rejection propagates: the gate must distinguish a rejected
			// driver (stays unacked so Slack retries) from a deliberately
			// ignored resolved event (acked on settlement). Acknowledge ONLY a
			// durable admission (done via onAdmitted): an event can never be
			// marked delivered while its run was never admitted.
			runBenny(configPath, event, { signal: shutdown.signal, onAdmitted }).then((outcome) => {
				if (outcome.admitted) console.error(`pstack benny socket: event ${outcome.eventId} settled (${outcome.results.map((r) => `${r.phase}:${r.status}`).join(", ")})`);
				return outcome;
			}),
		ack: (envelopeId, link) => {
			if (closed || link.readyState !== WebSocket.OPEN) return;
			link.send(JSON.stringify({ envelope_id: envelopeId }));
		},
		refused: (envelopeId) => console.error(`pstack benny socket: at driver capacity (${gate.size}/${MAX_SOCKET_CONCURRENT_RUNS}); event left unacknowledged for Slack retry`),
	});
	// Interrupts the reconnect backoff sleep so close() returns promptly.
	let wakeLoop: (() => void) | undefined;
	const loopInterrupt = new Promise<void>((resolve) => {
		wakeLoop = resolve;
	});
	let readyResolve!: () => void;
	let readyReject!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const stop = (): void => {
		if (closed) return;
		closed = true;
		socket?.close(1000, "shutdown");
		// Every terminal path (caller close, external abort, fatal error,
		// link_disabled) must cancel in-flight work and backoff, not just
		// close the transport; a shared caller signal must not fire again.
		shutdown.abort();
		options.signal?.removeEventListener("abort", onExternalAbort);
		clearInterval(sweepTimer);
		wakeLoop?.();
		if (!readySettled) {
			readySettled = true;
			readyReject(new BennyError(1, "Benny socket closed before hello"));
		}
	};

	const settleReady = (): void => {
		if (readySettled) return;
		readySettled = true;
		readyResolve();
	};

	const connectionsUrl = `${(config.runtime.slack_api_url ?? "https://slack.com").replace(/\/+$/, "")}/api/apps.connections.open`;

	async function requestSocketUrl(): Promise<string> {
		const response = await fetch(connectionsUrl, {
			method: "POST",
			headers: { Authorization: `Bearer ${appToken}` },
			// The URL acquisition shares the socket's shutdown signal: close()
			// (or an external abort) cancels a pending acquisition instead of
			// leaving the reconnect loop stuck on a dead request.
			signal: AbortSignal.any([AbortSignal.timeout(OPEN_TIMEOUT_MS), shutdown.signal]),
		});
		let body: Record<string, unknown>;
		try {
			// Bounded, abort-raced read: an oversized or slow remote response is
			// cancelled, never drained, and never parsed past the cap.
			body = await readBoundedJsonObject(response, "apps.connections.open", MAX_OPEN_RESPONSE_BYTES);
		} catch (error) {
			throw new Error(`apps.connections.open returned an unreadable response (HTTP ${response.status}): ${error instanceof Error ? error.message : String(error)}`);
		}
		const parsed = OpenResponse.safeParse(body);
		if (!parsed.success) throw new Error(`apps.connections.open returned an unreadable response (HTTP ${response.status})`);
		const data = parsed.data;
		if (data.ok && data.url) return data.url;
		const error = data.error ?? `HTTP ${response.status}`;
		if (FATAL_OPEN_ERRORS[error] === true) {
			throw new BennyError(2, `apps.connections.open failed permanently: ${error}; check ${config.runtime.slack_app_token_env} and the connections:write scope`);
		}
		throw new Error(`apps.connections.open failed: ${error}`);
	}

	/**
	 * Supervised recovery: reconcile and drain persisted safe checkpoints for
	 * this binding — never an admission. Runs at startup AND on every hello
	 * (including reconnects), serialized and coalesced: a hello arriving while
	 * a drain is running schedules exactly one follow-up pass instead of
	 * overlapping runs, so a queued row can never be drained twice
	 * concurrently. Shares the shutdown signal so close() cancels in-flight
	 * drains.
	 */
	let resumeRunning = false;
	let resumePending = false;
	let resumePromise: Promise<void> | undefined;
	function resumePersisted(): void {
		if (resumeRunning) {
			resumePending = true;
			return;
		}
		resumeRunning = true;
		resumePromise = resumeBenny(configPath, { signal: shutdown.signal }).then(
			(outcome) => {
				if (outcome.resumed > 0 || outcome.reconciled > 0) {
					console.error(`pstack benny socket: recovered ${outcome.reconciled}, drained ${outcome.resumed} persisted run(s)`);
				}
			},
			(error: unknown) => console.error(`pstack benny socket: startup resume failed: ${error instanceof Error ? error.message : String(error)}`),
		).finally(() => {
			resumeRunning = false;
			if (resumePending && !closed) {
				resumePending = false;
				resumePersisted();
			}
		});
	}

	/** Resolves once no recovery pass is active or scheduled (coalesced chain included). */
	async function resumeSettled(): Promise<void> {
		while (resumePromise) {
			const current = resumePromise;
			await current;
			if (resumePromise === current) return;
		}
	}

	// REL-RETENTION-002: evidence expiry must run on the durable service
	// lifecycle, not only when a later event is admitted. A supervised,
	// coalesced periodic sweep reuses the shared sweep's active-row fail-closed
	// logic (retain everything when the run store is unreadable).
	let sweepPromise: Promise<void> | undefined;
	const sweepIntervalMs = Math.max(60_000, Math.min(config.control.artifact_retention_hours * 3_600_000, 3_600_000));
	function sweepPeriodically(): void {
		if (sweepPromise) return;
		sweepPromise = sweepExpiredEvidence(targetRootFor(configPath), config.control.artifact_retention_hours)
			.then(
				(sweep) => {
					if (sweep.storeUnreadable) console.error("pstack benny socket: retention sweep could not read the run store; retained everything (fail closed)");
					else if (sweep.removed.length > 0) console.error(`pstack benny socket: retention sweep removed ${sweep.removed.length} expired evidence director(y/ies)`);
				},
				(error: unknown) => console.error(`pstack benny socket: retention sweep failed: ${error instanceof Error ? error.message : String(error)}`),
			)
			.finally(() => {
				sweepPromise = undefined;
			});
	}
	sweepPeriodically();
	const sweepTimer = setInterval(sweepPeriodically, sweepIntervalMs);
	sweepTimer.unref?.();


	function open(url: string): Promise<void> {
		return new Promise<void>((resolve) => {
			const ws = new WebSocket(url);
			socket = ws;
			// stop() may have run between URL acquisition and socket creation:
			// close the fresh link immediately instead of listening on a dead
			// session. onclose resolves the promise.
			if (closed) ws.close(1000, "shutdown");
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			ws.onmessage = (event: MessageEvent) => {
				if (closed) return;
				// Earliest type-specific size check, before any conversion or
				// JSON parse: an oversized string/Blob/ArrayBuffer frame closes
				// the link (1009) and the reconnect loop takes a fresh URL.
				if (oversizedFrame(event.data, MAX_SOCKET_FRAME_BYTES)) {
					console.error("pstack benny socket: frame exceeded the size bound; closing link");
					ws.close(1009, "frame too large");
					return;
				}
				let decoded: unknown;
				try {
					decoded = JSON.parse(String(event.data));
				} catch {
					return;
				}
				const parsed = SocketFrame.safeParse(decoded);
				if (!parsed.success) return;
				const frame = parsed.data;
				if (frame.type === "hello") {
					reconnectAttempt = 0; // backoff resets ONLY after hello, never after connections.open
					// Every hello (first or reconnect) re-drains persisted
					// checkpoints: startup recovery may have failed transiently
					// or a safe row may have appeared while the link was down.
					resumePersisted();
					settleReady();
					return;
				}
				if (frame.type === "events_api" && frame.envelope_id !== undefined) {
					// Identity comes from a pure parse of the untrusted payload
					// before any driver exists: capacity and duplicate decisions
					// allocate nothing beyond this. A malformed envelope has no
					// identity (runBenny re-derives and rejects it pre-admission,
					// staying unacked); the parse must never break the link loop.
					let identity: { eventId: string } | null = null;
					try {
						identity = selectBennyEvent(frame.payload, config);
					} catch {
						identity = null;
					}
					gate.handle(frame.envelope_id, identity, frame.payload, ws);
					return;
				}
				if (frame.type === "disconnect") {
					const reason = frame.reason ?? "unknown";
					console.error(`pstack benny socket: disconnect (${reason})`);
					if (reason === "link_disabled") stop(); // Slack disabled the link; reconnecting cannot help
					return;
				}
				if (UNSUPPORTED_ACK_TYPES[frame.type] === true) {
					// Valid but deliberately unsupported trigger type (button
					// click, slash command): acknowledge at once so Slack
					// never redelivers, and admit no work.
					if (frame.envelope_id !== undefined && !closed && ws.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
					}
					return;
				}
				// Remaining frame types (rate_limited, unknown) are not Benny triggers; rate_limited carries no envelope to acknowledge.
			};
			ws.onclose = () => done();
			ws.onerror = () => done(); // onclose always follows
		});
	}

	async function run(): Promise<void> {
		for (;;) {
			if (closed) return;
			try {
				const url = await requestSocketUrl();
				if (closed) return; // closed during URL acquisition: never open a post-shutdown link
				await open(url);
			} catch (error) {
				if (closed) return;
				if (error instanceof BennyError) {
					if (!readySettled) {
						readySettled = true;
						readyReject(error);
					}
					stop();
					return;
				}
				console.error(`pstack benny socket: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (closed) return;
			const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
			reconnectAttempt++;
			await Promise.race([Bun.sleep(delay), loopInterrupt]);
		}
	}
	// Track the loop promise so close() can await a clean stop; a ready
	// rejection after the caller stopped awaiting must not become unhandled.
	if (options.signal?.aborted) stop();
	const loopPromise = run();
	ready.catch(() => undefined);
	// Supervised startup recovery: drain acknowledged persisted safe
	// checkpoints before/alongside live traffic; never an admission.
	resumePersisted();
	return {
		async close(): Promise<void> {
			stop(); // aborts transport, in-flight runs, backoff, and the sweep timer
			// The close barrier includes the tracked startup/reconnect recovery
			// promise, any in-flight retention sweep, and every long-lived run
			// driver (at most MAX_SOCKET_CONCURRENT_RUNS): close() must not
			// return while a drain still owns a SQLite claim, SDK session or
			// Docker workspace.
			await Promise.allSettled([loopPromise, resumeSettled(), gate.drain(), ...(sweepPromise ? [sweepPromise] : [])]);
		},
		ready,
	};
}
