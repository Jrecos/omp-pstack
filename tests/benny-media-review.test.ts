/**
 * Media-review session lifecycle regressions (no Docker, no real model):
 * the SDK session factory is mocked so the run-shutdown binding — pre/post
 * creation abort checks, listener-driven disposal, listener removal, and
 * cwd removal strictly after disposal settles — is observable end to end.
 */
import { test, expect, mock, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BennyConfig } from "../src/benny-policy.ts";

interface FakeSession {
	cwd: string;
	prompt: (text: string, options?: { images?: unknown[] }) => Promise<void>;
	waitForIdle: () => Promise<void>;
	messages: Array<Record<string, unknown>>;
	dispose: () => Promise<void>;
}

const state = {
	promptMode: "hang" as "hang" | "respond",
	disposeMode: "resolve" as "resolve" | "reject",
	created: [] as FakeSession[],
	disposeCount: 0,
	/** Whether the review cwd still existed at the moment each disposal began. */
	cwdAtDisposal: [] as boolean[],
	pendingPrompts: [] as Array<() => void>,
};

const VERDICT = JSON.stringify({ confirmed: true, evidence: ["imageIndex 0 shows the broken counter state"] });

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	discoverAuthStorage: async () => ({}),
	getAgentDir: () => "/tmp/mock-agent-dir",
	loadSkillsFromDir: async () => [],
	ModelRegistry: class {
		async refresh() {}
		getAvailable() {
			// A provider/id pair the REAL resolveModelFromString resolves exactly,
			// so the resolver module stays unmocked for the SDK's internal graph.
			return [{ provider: "mock", id: "reviewer" }];
		}
		hasConfiguredAuth() {
			return true;
		}
	},
	Settings: class {
		static isolated() {
			return {};
		}
	},
	SessionManager: class {
		static create() {
			return {};
		}
	},
	AgentRegistry: class {},
	createAgentSession: async (options: { cwd: string }) => {
		const session: FakeSession = {
			cwd: options.cwd,
			prompt: () =>
				new Promise<void>((resolvePrompt) => {
					if (state.promptMode === "respond") {
						session.messages.push({ role: "assistant", content: [{ type: "text", text: VERDICT }] });
						resolvePrompt();
						return;
					}
					state.pendingPrompts.push(resolvePrompt);
				}),
			waitForIdle: async () => {},
			messages: [],
			dispose: async () => {
				state.disposeCount += 1;
				state.cwdAtDisposal.push(existsSync(options.cwd));
				if (state.disposeMode === "reject") throw new Error("dispose exploded");
				for (const resolvePrompt of state.pendingPrompts.splice(0)) resolvePrompt();
			},
		};
		state.created.push(session);
		return { session };
	},
}));

// Static import cannot work here: mock.module must be registered BEFORE the
// module graph loads, so benny-workspace.ts binds the mocked SDK factories.
const { reviewMedia, WorkspaceBlockError } = await import("../src/benny-workspace.ts");

function reviewConfig(): BennyConfig {
	return {
		runtime: { workspace_image: "mock/image:0" },
		models: { media_review: "mock/reviewer" },
	} as unknown as BennyConfig;
}

function imageArtifact() {
	// Byte-real PNG: reviewMedia consumes the caller-declared mimeType, and a
	// real signature keeps the fixture honest about what "byte-verified" means.
	return {
		path: "evidence/shot.png",
		sha256: "0".repeat(64),
		mimeType: "image/png",
		data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	};
}

async function resetState() {
	state.promptMode = "hang";
	state.disposeMode = "resolve";
	state.created = [];
	state.disposeCount = 0;
	state.cwdAtDisposal = [];
	state.pendingPrompts = [];
}

async function leftoverReviewCwds(): Promise<string[]> {
	const entries = await readdir(tmpdir()).catch(() => [] as string[]);
	return entries.filter((entry) => entry.startsWith("benny-media-review-")).map((entry) => join(tmpdir(), entry));
}

// No exposed promise exists for "the mocked factory created the session", so
// poll the observable state flag with early exit — never a fixed wait.
async function waitFor(condition: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
		await Bun.sleep(10);
	}
	if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

test("an already-aborted signal stops media review before the reviewer session is created", async () => {
	await resetState();
	const controller = new AbortController();
	controller.abort();
	const outcome = await reviewMedia({
		config: reviewConfig(),
		imageId: `sha256:${"0".repeat(64)}`,
		artifacts: [imageArtifact()],
		prompt: "is it broken?",
		deadline: Date.now() + 60_000,
		signal: controller.signal,
	}).then(
		() => null,
		(error: unknown) => error,
	);
	expect(outcome).toBeInstanceOf(WorkspaceBlockError);
	expect((outcome as Error).message).toMatch(/before the reviewer session was created/);
	expect(state.created).toHaveLength(0);
	expect(await leftoverReviewCwds()).toEqual([]);
});

test("a mid-flight abort disposes the reviewer session promptly and removes the cwd only after disposal settles", async () => {
	await resetState();
	const controller = new AbortController();
	let outcome: unknown;
	const settled = reviewMedia({
		config: reviewConfig(),
		imageId: `sha256:${"0".repeat(64)}`,
		artifacts: [imageArtifact()],
		prompt: "is it broken?",
		deadline: Date.now() + 60_000,
		signal: controller.signal,
	}).then(
		(value) => (outcome = value),
		(error: unknown) => (outcome = error),
	);
	await waitFor(() => state.created.length > 0, "reviewer session creation");
	const started = Date.now();
	controller.abort();
	await settled;
	// The hung prompt settles via the listener-driven disposal, and the abort
	// check fails the review immediately after — no second prompt is attempted.
	expect(outcome).toBeInstanceOf(WorkspaceBlockError);
	expect((outcome as Error).message).toMatch(/aborted/);
	expect(Date.now() - started).toBeLessThan(5_000);
	// The evidence cwd still existed when each disposal began: cwd removal
	// happens strictly AFTER disposal settles.
	// The listener fired dispose AND the finally's settled cleanup disposed
	// again — the real SDK dispose is idempotent, so two attempts are expected.
	expect(state.disposeCount).toBe(2);
	expect(await leftoverReviewCwds()).toEqual([]);
});

test("a completed review removes its abort listener: a later signal cannot dispose again", async () => {
	await resetState();
	state.promptMode = "respond";
	const controller = new AbortController();
	const verdict = await reviewMedia({
		config: reviewConfig(),
		imageId: `sha256:${"0".repeat(64)}`,
		artifacts: [imageArtifact()],
		prompt: "is it broken?",
		deadline: Date.now() + 60_000,
		signal: controller.signal,
	});
	expect(verdict).toEqual({ confirmed: true, evidence: ["imageIndex 0 shows the broken counter state"], reviewedHashes: ["0".repeat(64)] });
	// The settled review disposed exactly once; firing the signal afterwards
	// proves the listener was removed rather than left attached.
	expect(state.disposeCount).toBe(1);
	controller.abort();
	expect(state.disposeCount).toBe(1);
	expect(await leftoverReviewCwds()).toEqual([]);
});

test("cleanup is all-settled: a disposal failure never masks the verdict and the cwd is still removed", async () => {
	await resetState();
	state.promptMode = "respond";
	state.disposeMode = "reject";
	const verdict = await reviewMedia({
		config: reviewConfig(),
		imageId: `sha256:${"0".repeat(64)}`,
		artifacts: [imageArtifact()],
		prompt: "is it broken?",
		deadline: Date.now() + 60_000,
	});
	expect(verdict.confirmed).toBe(true);
	expect(state.disposeCount).toBe(1);
	expect(await leftoverReviewCwds()).toEqual([]);
});

afterAll(async () => {
	for (const leftover of await leftoverReviewCwds()) {
		await rm(leftover, { recursive: true, force: true });
	}
});
