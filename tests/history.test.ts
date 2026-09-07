import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listHistory, readHistory, type HistoryOptions } from "../src/history.ts";

const DAY = 86_400_000;

let root: string;
let workspace: string;
let otherWorkspace: string;
let currentFile: string;

const created: string[] = [];
function writeSession(bucket: string, id: string, cwd: string, extra: Record<string, unknown>, messages: Array<{ role: string; text: string }>, mtimeMs: number, child = false): string {
	const dir = join(root, bucket);
	mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(mtimeMs - 60_000).toISOString(), cwd, title: `session ${id}`, ...extra }),
		...(child ? [JSON.stringify({ type: "session_init", id: `init-${id}`, parentId: null, timestamp: new Date(mtimeMs - 40_000).toISOString(), systemPrompt: "", task: "child task", tools: [], agent: "task" })] : []),
		...messages.map((m, i) =>
			JSON.stringify({
				type: "message",
				id: `e${i}${id.slice(0, 6)}`,
				parentId: i === 0 ? null : `e${i - 1}${id.slice(0, 6)}`,
				timestamp: new Date(mtimeMs - 30_000 + i).toISOString(),
				message: { role: m.role, content: m.text, timestamp: mtimeMs - 30_000 + i },
			}),
		),
	];
	const path = join(dir, `20260905T000000_${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
	created.push(path);
	return path;
}

function options(extra: Partial<HistoryOptions> = {}): HistoryOptions {
	return {
		workspace,
		sessionsRoot: root,
		currentSessionFile: currentFile,
		now: Date.parse("2026-09-05T12:00:00Z"),
		...extra,
	};
}

beforeAll(() => {
	root = mkdtempSync("/tmp/pstack-history-");
	workspace = mkdtempSync("/tmp/pstack-ws-");
	otherWorkspace = mkdtempSync("/tmp/pstack-other-");
	const old = Date.parse("2026-09-05T12:00:00Z") - 20 * DAY;
	const recent = Date.parse("2026-09-05T12:00:00Z") - 1 * DAY;
	writeSession("ws-bucket", "aaaa0001old", workspace, {}, [{ role: "user", text: "old work" }], old);
	writeSession("ws-bucket", "bbbb0002new", workspace, {}, [
		{ role: "user", text: "fix the parser" },
		{ role: "assistant", text: "done" },
	], recent);
	writeSession("ws-bucket", "cccc0003child", workspace, { parentSession: join(root, "ws-bucket", "20260905T000000_bbbb0002new.jsonl") }, [
		{ role: "user", text: "child work" },
	], recent, true);
	currentFile = writeSession("ws-bucket", "dddd0004cur", workspace, {}, [{ role: "user", text: "current session" }], recent);
	writeSession("other-bucket", "eeee0005other", otherWorkspace, {}, [{ role: "user", text: "other workspace" }], recent);
	// Unparseable file in the workspace bucket must be named as skipped.
	const junk = join(root, "ws-bucket", "20260905T000000_garbage.jsonl");
	writeFileSync(junk, "{not json\n");
	created.push(junk);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
	rmSync(otherWorkspace, { recursive: true, force: true });
});

describe("pstack_history list", () => {
	test("default window reads only the workspace's last seven days", async () => {
		const result = await listHistory(options());
		expect(result.windowDays).toBe(7);
		expect(result.sessions.map((s) => s.id)).toEqual(["bbbb0002new"]);
	});

	test("all removes the time limit but keeps workspace isolation", async () => {
		const result = await listHistory(options({ all: true }));
		const ids = result.sessions.map((s) => s.id);
		expect(ids).toContain("aaaa0001old");
		expect(ids).toContain("bbbb0002new");
		expect(ids).not.toContain("cccc0003child");
		expect(ids).not.toContain("dddd0004cur");
		expect(ids).not.toContain("eeee0005other");
	});

	test("query matches session text", async () => {
		const result = await listHistory(options({ query: "PARSER" }));
		expect(result.sessions.map((s) => s.id)).toEqual(["bbbb0002new"]);
	});

	test("malformed workspace files are named and skipped", async () => {
		const result = await listHistory(options());
		expect(result.skipped).toContain("20260905T000000_garbage.jsonl");
	});

	test("empty history is a valid explicit result", async () => {
		const result = await listHistory(options({ workspace: mkdtempSync("/tmp/pstack-empty-") }));
		expect(result.sessions).toEqual([]);
	});
});

describe("pstack_history read", () => {
	test("read returns the newest session's branch with entry citations", async () => {
		const result = await readHistory(options());
		expect(result.session?.id).toBe("bbbb0002new");
		expect(result.entries.map((e) => [e.role, e.text])).toEqual([
			["user", "fix the parser"],
			["assistant", "done"],
		]);
		expect(result.entries[0].id).toBe("e0bbbb00");
	});

	test("since excludes entries after the bound", async () => {
		const result = await readHistory(options({ since: "2026-09-06" }));
		expect(result.entries).toEqual([]);
	});

	test("sessionId prefix resolves within the workspace only", async () => {
		const result = await readHistory(options({ sessionId: "bbbb", all: true }));
		expect(result.session?.id).toBe("bbbb0002new");
		expect(readHistory(options({ sessionId: "eeee0005other" }))).rejects.toThrow(/No session matching/);
	});

	test("forked user sessions and long tool evidence remain readable", async () => {
		const evidence = "evidence ".repeat(200);
		const file = writeSession("ws-bucket", "ffff0006fork", workspace, { parentSession: currentFile }, [{ role: "toolResult", text: evidence }], Date.parse("2026-09-05T10:00:00Z"));
		try {
			const result = await readHistory(options({ sessionId: "ffff0006fork" }));
			expect(result.entries[0]?.text).toBe(evidence);
		} finally { rmSync(file); }
	});

	test("explicit listing time bounds include older same-workspace work", async () => {
		const result = await listHistory(options({ since: "2026-08-01", until: "2026-08-31" }));
		expect(result.sessions.map((session) => session.id)).toEqual(["aaaa0001old"]);
	});
});

describe("pstack_history native corrections", () => {
	test("legacy v1 sessions migrate in memory and cite every entry stably", async () => {
		const dir = join(root, "ws-bucket");
		const path = join(dir, "20260905T000000_gggg0007v1.jsonl");
		const recent = Date.parse("2026-09-05T12:00:00Z") - 2 * DAY;
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: "gggg0007v1", timestamp: new Date(recent).toISOString(), cwd: workspace }),
			JSON.stringify({ type: "message", timestamp: new Date(recent + 1).toISOString(), message: { role: "user", content: "legacy first", timestamp: recent + 1 } }),
			JSON.stringify({ type: "message", timestamp: new Date(recent + 2).toISOString(), message: { role: "assistant", content: "legacy second", timestamp: recent + 2 } }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`);
		created.push(path);
		try {
			const first = await readHistory(options({ sessionId: "gggg0007v1" }));
			expect(first.entries.map((entry) => entry.text)).toEqual(["legacy first", "legacy second"]);
			expect(first.entries.every((entry) => entry.id.length > 0)).toBe(true);
			const second = await readHistory(options({ sessionId: "gggg0007v1" }));
			expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
			expect(readFileSync(path, "utf8")).toBe(`${lines.join("\n")}\n`);
		} finally { rmSync(path); }
	});

	test("queries search complete branches, not just the 4KiB listing prefix", async () => {
		const file = writeSession("ws-bucket", "hhhh0008deep", workspace, {}, [
			{ role: "user", text: "filler ".repeat(1200) },
			{ role: "assistant", text: "the zebra-needle hides here" },
		], Date.parse("2026-09-05T11:00:00Z"));
		try {
			const result = await listHistory(options({ query: "zebra-needle" }));
			expect(result.sessions.map((session) => session.id)).toEqual(["hhhh0008deep"]);
			const none = await listHistory(options({ query: "absent-marker" }));
			expect(none.sessions.some((session) => session.id === "hhhh0008deep")).toBe(false);
		} finally { rmSync(file); }
	});

	test("invalid header timestamps are named and skipped, never crash the listing", async () => {
		const dir = join(root, "ws-bucket");
		const path = join(dir, "20260905T000000_iiii0009bad.jsonl");
		const recent = Date.parse("2026-09-05T12:00:00Z") - 3 * DAY;
		writeFileSync(path, `${[
			JSON.stringify({ type: "session", version: 3, id: "iiii0009bad", timestamp: "not-a-date", cwd: workspace }),
			JSON.stringify({ type: "message", id: "e0", parentId: null, timestamp: new Date(recent).toISOString(), message: { role: "user", content: "broken clock", timestamp: recent } }),
		].join("\n")}\n`);
		created.push(path);
		try {
			const listing = await listHistory(options());
			expect(listing.skipped).toContain("20260905T000000_iiii0009bad.jsonl");
			expect(listing.sessions.some((session) => session.id === "iiii0009bad")).toBe(false);
		} finally { rmSync(path); }
	});
});
