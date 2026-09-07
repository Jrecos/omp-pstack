import { describe, expect, test } from "bun:test";
import { MAX_SOCKET_CONCURRENT_RUNS, SocketRunGate } from "../src/benny-socket.ts";

// Focused regression for the fixed Socket driver capacity: the fifth
// concurrent distinct report must get no driver and no ACK, must succeed
// once a slot frees, duplicate frames must never inflate capacity, and the
// close barrier drains at most MAX_SOCKET_CONCURRENT_RUNS drivers.

interface Deferred {
	promise: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface Run {
	event: unknown;
	onAdmitted: () => void;
	deferred: Deferred;
}

function makeGate(max: number) {
	const acked: string[] = [];
	const refused: string[] = [];
	const runs: Run[] = [];
	const gate = new SocketRunGate(max, {
		run: (event, onAdmitted) => {
			const d = deferred();
			runs.push({ event, onAdmitted, deferred: d });
			return d.promise;
		},
		ack: (envelopeId) => acked.push(envelopeId),
		refused: (envelopeId) => refused.push(envelopeId),
	});
	const link = {} as WebSocket;
	const handle = (eventId: string, envelopeId = `env-${eventId}`): void => gate.handle(envelopeId, { eventId }, { event_id: eventId }, link);
	const settle = async (): Promise<void> => {
		// Deterministic microtask flush: the gate's cleanup (catch → finally →
		// map delete) is pure microtask work; no wall-clock wait involved.
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	return { gate, acked, refused, runs, handle, settle, link };
}

describe("socket run capacity", () => {
	test("capacity constant is four", () => {
		expect(MAX_SOCKET_CONCURRENT_RUNS).toBe(4);
	});

	test("fifth concurrent distinct report gets no driver and no ACK, succeeds after a slot frees", async () => {
		const { gate, acked, refused, runs, handle, settle } = makeGate(MAX_SOCKET_CONCURRENT_RUNS);
		for (const id of ["e1", "e2", "e3", "e4"]) handle(id);
		expect(runs).toHaveLength(4);
		expect(gate.size).toBe(4);

		// Each driver reaches durable admission: exactly its own envelope acks.
		for (const run of runs) run.onAdmitted();
		expect(acked).toEqual(["env-e1", "env-e2", "env-e3", "env-e4"]);

		// The fifth distinct report at full capacity: no driver, no ACK.
		handle("e5");
		expect(runs).toHaveLength(4);
		expect(gate.size).toBe(4);
		expect(refused).toEqual(["env-e5"]);
		expect(acked).not.toContain("env-e5");

		// A slot frees (driver e1 settles); the Slack retry of e5 now runs.
		runs[0]!.deferred.resolve({});
		await settle();
		expect(gate.size).toBe(3);
		handle("e5");
		expect(runs).toHaveLength(5);
		runs[4]!.onAdmitted();
		expect(acked).toContain("env-e5");
	});

	test("duplicate frames do not inflate capacity", async () => {
		const { gate, acked, runs, handle, link } = makeGate(MAX_SOCKET_CONCURRENT_RUNS);
		for (const id of ["e1", "e2", "e3", "e4"]) handle(id);
		expect(runs).toHaveLength(4);

		// Redelivery of an in-flight event before its admission lands: no
		// second driver, no ACK (acking would mark an event delivered that
		// could still be rejected pre-admission).
		gate.handle("env-e1-retry", { eventId: "e1" }, { event_id: "e1" }, link);
		expect(runs).toHaveLength(4);
		expect(gate.size).toBe(4);
		expect(acked).toEqual([]);

		// After durable admission the redelivery acks — still no new driver.
		runs[0]!.onAdmitted();
		gate.handle("env-e1-retry2", { eventId: "e1" }, { event_id: "e1" }, link);
		expect(runs).toHaveLength(4);
		expect(acked).toEqual(["env-e1", "env-e1-retry2"]);
	});

	test("a rejected driver releases its slot without an ACK", async () => {
		const { gate, acked, refused, runs, handle, settle } = makeGate(1);
		handle("e1");
		expect(runs).toHaveLength(1);
		// Pre-admission failure (e.g. policy rejection): unacked, slot freed.
		runs[0]!.deferred.reject(new Error("rejected before admission"));
		await settle();
		expect(acked).toEqual([]);
		expect(gate.size).toBe(0);
		handle("e2");
		expect(runs).toHaveLength(2);
		expect(refused).toEqual([]);
	});

	test("a driver that resolves without admission (deliberately ignored event) acks exactly once", async () => {
		const { gate, acked, runs, handle, settle } = makeGate(2);
		handle("ign");
		expect(acked).toEqual([]); // nothing acked before settlement
		runs[0]!.deferred.resolve({ admitted: false, results: [] });
		await settle();
		// Ignored valid events ack on settlement so Slack never redelivers.
		expect(acked).toEqual(["env-ign"]);
		expect(gate.size).toBe(0);
		// An admitted driver never double-acks its own envelope.
		handle("adm");
		runs[1]!.onAdmitted();
		runs[1]!.deferred.resolve({ admitted: true, results: [] });
		await settle();
		expect(acked).toEqual(["env-ign", "env-adm"]);
	});

	test("drain is a barrier over at most four live drivers", async () => {
		const { gate, runs, handle, settle } = makeGate(MAX_SOCKET_CONCURRENT_RUNS);
		for (const id of ["e1", "e2", "e3", "e4"]) handle(id);
		let settled = false;
		const drained = gate.drain().then(() => {
			settled = true;
		});
		await settle();
		// Drain must not resolve while any driver is live.
		expect(settled).toBe(false);
		for (const run of runs) run.deferred.resolve({});
		await drained;
		expect(gate.size).toBe(0);
	});

	test("drain with no drivers resolves immediately", async () => {
		const { gate } = makeGate(MAX_SOCKET_CONCURRENT_RUNS);
		await gate.drain();
		expect(gate.size).toBe(0);
	});
});
