import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

let tmp: string;
let bin: string;
let log: string;

const FAKE_HERDR = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const logPath = process.env.FAKE_HERDR_LOG!;
appendFileSync(logPath, JSON.stringify(argv) + "\\n");
const sub = argv.length > 1 && ["agent", "pane", "tab"].includes(argv[0]) ? argv[0] + " " + argv[1] : argv[0] ?? "";
const ok = (id: string, result: unknown): never => {
	process.stdout.write(JSON.stringify({ id, result }) + "\\n");
	process.exit(0);
};
const fail = (id: string, code: string, message: string): never => {
	process.stderr.write(JSON.stringify({ error: { code, message }, id }) + "\\n");
	process.exit(1);
};
if (sub === "agent list") {
	const agents: unknown[] = [{ agent: "omp", agent_status: "idle", pane_id: "wC:p1S", tab_id: "wC:t1" }];
	if (process.env.FAKE_HERDR_LIVE) agents.push({ agent: "omp", name: process.env.FAKE_HERDR_LIVE, agent_status: "idle", pane_id: "wX:p9" });
	ok("cli:agent:list", { agents });
} else if (sub === "tab create") {
	ok("cli:tab:create", {
		root_pane: { pane_id: "wH:p6", tab_id: "wH:t2", workspace_id: "wH", cwd: argv[5] ?? "" },
		tab: { label: argv[7] ?? "", tab_id: "wH:t2", workspace_id: "wH" },
		type: "tab_created",
	});
} else if (sub === "pane split") {
	const prior = readFileSync(logPath, "utf8").split("\\n").filter((line) => line.startsWith('["pane","split"')).length;
	ok("cli:pane:split", { pane: { pane_id: "wH:p" + (6 + prior), tab_id: "wH:t2", workspace_id: "wH" }, type: "pane_info" });
} else if (sub === "pane rename") {
	ok("cli:pane:rename", { pane: { label: argv[3] ?? "", pane_id: argv[2] ?? "" }, type: "pane_info" });
} else if (sub === "agent start") {
	const name = argv[2] ?? "";
	if (process.env.FAKE_HERDR_START_FAIL === name) fail("cli:agent:start", "start_failed", "agent start " + name + " refused");
	ok("cli:agent:start", {
		agent: { agent: "omp", agent_status: "idle", name, pane_id: argv[6] ?? "", tab_id: "wH:t2" },
		argv: ["omp", "--no-session"],
	});
} else if (sub === "agent get") {
	const name = argv[2] ?? "";
	const session = process.env.FAKE_HERDR_NO_SESSION ? {} : { agent_session: { agent: "omp", kind: "path", value: "sess-" + name } };
	ok("cli:agent:get", { agent: { agent: "omp", agent_status: "idle", name, ...session } });
} else if (sub === "agent prompt") {
	if (process.env.FAKE_HERDR_PROMPT_FAIL === argv[2]) fail("cli:agent:prompt", "agent_blocked", "agent " + argv[2] + " is blocked");
	ok("cli:agent:prompt", { agent: { agent_status: "idle", name: argv[2] ?? "", pane_id: "wH:p2" } });
} else if (sub === "agent wait") {
	if (argv.includes("--until") && process.env.FAKE_HERDR_STARTUP_TIMEOUT === "1") {
		fail("cli:agent:wait", "timeout", "timed out waiting for agent status");
	}
	const state = argv.includes("--until") ? "working" : process.env.FAKE_HERDR_WAIT_STATE ?? "idle";
	ok("cli:agent:wait", { agent: { agent_status: state, name: argv[2] ?? "", pane_id: "wH:p6", agent_session: { kind: "path", value: "sess-" + (argv[2] ?? "") } } });
} else {
	fail("cli:" + sub.replace(" ", ":"), "unimplemented", "fake herdr cannot handle: " + argv.join(" "));
}
`;

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(args: readonly string[], env: Record<string, string | undefined> = {}): RunResult {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) base[key] = value;
	}
	base.PATH = `${bin}:${base.PATH ?? ""}`;
	base.HERDR_ENV = "1";
	base.HERDR_WORKSPACE_ID = "wH";
	base.FAKE_HERDR_LOG = log;
	delete base.PSTACK_HERDR_RUN;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete base[key];
		else base[key] = value;
	}
	const result = Bun.spawnSync([process.execPath, CLI, "herdr-run", ...args], { env: base, stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function calls(): string[][] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function resetLog(): void {
	writeFileSync(log, "");
}

interface MakeOptions {
	skipBrief?: number[];
	reports?: number[];
}

/** Creates $tmp/<id> with workers.json (entries verbatim), per-worker dirs, briefs, and the cwds themselves. */
function makeRun(id: string, entries: Record<string, unknown>[], options: MakeOptions = {}): string {
	const runDir = join(tmp, id);
	mkdirSync(runDir, { recursive: true });
	entries.forEach((entry, index) => {
		const n = index + 1;
		if (typeof entry.cwd === "string" && isAbsolute(entry.cwd)) mkdirSync(entry.cwd, { recursive: true });
		mkdirSync(join(runDir, String(n)), { recursive: true });
		if (!(options.skipBrief ?? []).includes(n)) writeFileSync(join(runDir, String(n), "brief.md"), `# brief ${n}\n`);
		if ((options.reports ?? []).includes(n)) writeFileSync(join(runDir, String(n), "report.md"), "Status: DONE\n");
	});
	writeFileSync(join(runDir, "workers.json"), `${JSON.stringify(entries, null, "\t")}\n`);
	return runDir;
}

beforeAll(() => {
	tmp = mkdtempSync("/tmp/herdr-run-");
	bin = join(tmp, "bin");
	mkdirSync(bin);
	log = join(tmp, "herdr.log");
	writeFileSync(join(bin, "herdr"), FAKE_HERDR);
	chmodSync(join(bin, "herdr"), 0o755);
	resetLog();
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("herdr-run launch", () => {
	test("4-worker launch: one tab, explicit-parent splits, model flags, complete record", () => {
		const w1 = join(tmp, "auth-1430-w1");
		const w2 = join(tmp, "auth-1430-w2");
		const w3 = join(tmp, "auth-1430-w3");
		const w4 = join(tmp, "auth-1430-w4");
		const runDir = makeRun("auth-1430", [
			{ cwd: w1, model: "litellm/glm-5.3:max" },
			{ cwd: w2, model: "ollama/qwen3:30b" },
			{ cwd: w3 },
			{ cwd: w4 },
		]);
		const brief = (n: number) => join(runDir, String(n), "brief.md");
		const report = (n: number) => join(runDir, String(n), "report.md");
		const prompt = (n: number) => `/poteto-mode Read ${brief(n)} in full and execute it. It is your whole task.`;

		const result = run(["launch", runDir]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");

		const expected: string[][] = [
			["agent", "list"],
			["tab", "create", "--workspace", "wH", "--cwd", w1, "--label", "pstack auth-1430", "--env", "PSTACK_HERDR_RUN=auth-1430", "--no-focus"],
			["pane", "split", "wH:p6", "--direction", "right", "--cwd", w2, "--env", "PSTACK_HERDR_RUN=auth-1430", "--no-focus"],
			["pane", "split", "wH:p6", "--direction", "down", "--cwd", w3, "--env", "PSTACK_HERDR_RUN=auth-1430", "--no-focus"],
			["pane", "split", "wH:p7", "--direction", "down", "--cwd", w4, "--env", "PSTACK_HERDR_RUN=auth-1430", "--no-focus"],
			["pane", "rename", "wH:p6", "auth-1430-1"],
			["pane", "rename", "wH:p7", "auth-1430-2"],
			["pane", "rename", "wH:p8", "auth-1430-3"],
			["pane", "rename", "wH:p9", "auth-1430-4"],
			["agent", "start", "auth-1430-1", "--kind", "omp", "--pane", "wH:p6", "--", "--model", "litellm/glm-5.3", "--thinking", "max"],
			["agent", "prompt", "auth-1430-1", prompt(1)],
			["agent", "wait", "auth-1430-1", "--until", "working", "--until", "blocked", "--timeout", "60000"],
			["agent", "start", "auth-1430-2", "--kind", "omp", "--pane", "wH:p7", "--", "--model", "ollama/qwen3:30b"],
			["agent", "prompt", "auth-1430-2", prompt(2)],
			["agent", "wait", "auth-1430-2", "--until", "working", "--until", "blocked", "--timeout", "60000"],
			["agent", "start", "auth-1430-3", "--kind", "omp", "--pane", "wH:p8"],
			["agent", "prompt", "auth-1430-3", prompt(3)],
			["agent", "wait", "auth-1430-3", "--until", "working", "--until", "blocked", "--timeout", "60000"],
			["agent", "start", "auth-1430-4", "--kind", "omp", "--pane", "wH:p9"],
			["agent", "prompt", "auth-1430-4", prompt(4)],
			["agent", "wait", "auth-1430-4", "--until", "working", "--until", "blocked", "--timeout", "60000"],
		];
		expect(calls()).toEqual(expected);
		const flat = JSON.stringify(calls());
		expect(flat.includes("--current")).toBe(false);
		expect(flat.includes("--wait")).toBe(false);

		const recordPath = join(runDir, "run.json");
		expect(result.stdout).toBe(readFileSync(recordPath, "utf8"));
		expect(JSON.parse(result.stdout)).toEqual({
			run: "auth-1430",
			tab: "wH:t2",
			workers: [
				{ n: 1, name: "auth-1430-1", cwd: w1, brief: brief(1), report: report(1), model: "litellm/glm-5.3:max", pane: "wH:p6", stage: "prompted", session: "sess-auth-1430-1", startup: "working" },
				{ n: 2, name: "auth-1430-2", cwd: w2, brief: brief(2), report: report(2), model: "ollama/qwen3:30b", pane: "wH:p7", stage: "prompted", session: "sess-auth-1430-2", startup: "working" },
				{ n: 3, name: "auth-1430-3", cwd: w3, brief: brief(3), report: report(3), pane: "wH:p8", stage: "prompted", session: "sess-auth-1430-3", startup: "working" },
				{ n: 4, name: "auth-1430-4", cwd: w4, brief: brief(4), report: report(4), pane: "wH:p9", stage: "prompted", session: "sess-auth-1430-4", startup: "working" },
			],
		});
	}, 60000);

	test("a failed prompt leaves the worker at stage agent, which wait refuses", () => {
		const runDir = makeRun("auth-12", [{ cwd: join(tmp, "auth-12-w1") }, { cwd: join(tmp, "auth-12-w2") }]);

		const result = run(["launch", runDir], { FAKE_HERDR_PROMPT_FAIL: "auth-12-1" });
		expect(result.code).toBe(1);
		const all = calls();
		expect(all[all.length - 1]?.slice(0, 3)).toEqual(["agent", "prompt", "auth-12-1"]);
		const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
		expect(record.workers.map((worker: { stage: string }) => worker.stage)).toEqual(["agent", "pane"]);

		resetLog();
		expect(run(["wait", runDir, "1"]).code).toBe(1);
		expect(calls()).toEqual([]);
	}, 60000);

	test("second launch of the same run is refused before any herdr call", () => {
		const runDir = makeRun("again-2", [{ cwd: join(tmp, "again-2-w1") }]);
		expect(run(["launch", runDir]).code).toBe(0);
		resetLog();

		const result = run(["launch", runDir]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr).error).toContain(join(runDir, "run.json"));
		expect(calls()).toEqual([]);
	}, 60000);

	test("validation failures exit 1 with no mutating herdr call and no run.json", () => {
		const cases: { name: string; id: string; entries: Record<string, unknown>[]; options?: MakeOptions; env?: Record<string, string | undefined>; listCalls?: number }[] = [
			{ name: "five workers", id: "auth-5", entries: [1, 2, 3, 4, 5].map((n) => ({ cwd: join(tmp, `auth-5-w${n}`) })) },
			{ name: "missing brief", id: "auth-6", entries: [{ cwd: join(tmp, "auth-6-w1") }, { cwd: join(tmp, "auth-6-w2") }], options: { skipBrief: [2] } },
			{ name: "existing report", id: "auth-7", entries: [{ cwd: join(tmp, "auth-7-w1") }], options: { reports: [1] } },
			{ name: "live name collision", id: "auth-4", entries: [{ cwd: join(tmp, "auth-4-w1") }], env: { FAKE_HERDR_LIVE: "auth-4-1" }, listCalls: 1 },
			{ name: "worker session guard", id: "auth-3", entries: [{ cwd: join(tmp, "auth-3-w1") }], env: { PSTACK_HERDR_RUN: "auth-3" } },
			{ name: "HERDR_ENV unset", id: "auth-2", entries: [{ cwd: join(tmp, "auth-2-w1") }], env: { HERDR_ENV: undefined } },
			{ name: "relative cwd", id: "auth-1", entries: [{ cwd: "relative/w1" }] },
			{ name: "run id charset", id: "AUTH-9", entries: [{ cwd: join(tmp, "AUTH-9-w1") }] },
			{ name: "unexpected worker key", id: "auth-10", entries: [{ cwd: join(tmp, "auth-10-w1"), model: "litellm/glm-5.3:max", role: "x" }] },
			{ name: "HERDR_WORKSPACE_ID unset", id: "auth-11", entries: [{ cwd: join(tmp, "auth-11-w1") }], env: { HERDR_WORKSPACE_ID: undefined } },
		];
		for (const testCase of cases) {
			resetLog();
			const runDir = makeRun(testCase.id, testCase.entries, testCase.options);
			const result = run(["launch", runDir], testCase.env);
			expect(result.code).toBe(1);
			expect(typeof JSON.parse(result.stderr).error).toBe("string");
			expect(existsSync(join(runDir, "run.json"))).toBe(false);
			expect(calls()).toHaveLength(testCase.listCalls ?? 0);
		}
	}, 60000);

	test("startup timeout records startup unknown and still exits 0", () => {
		const w1 = join(tmp, "solo-7-w1");
		const runDir = makeRun("solo-7", [{ cwd: w1 }]);

		const result = run(["launch", runDir], { FAKE_HERDR_STARTUP_TIMEOUT: "1" });
		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).workers).toEqual([
			{ n: 1, name: "solo-7-1", cwd: w1, brief: join(runDir, "1", "brief.md"), report: join(runDir, "1", "report.md"), pane: "wH:p6", stage: "prompted", session: "sess-solo-7-1", startup: "unknown" },
		]);

		const w2 = join(tmp, "solo-8-w1");
		const silent = makeRun("solo-8", [{ cwd: w2 }]);
		expect(run(["launch", silent], { FAKE_HERDR_STARTUP_TIMEOUT: "1", FAKE_HERDR_NO_SESSION: "1" }).code).toBe(0);
		expect(JSON.parse(readFileSync(join(silent, "run.json"), "utf8")).workers).toEqual([
			{ n: 1, name: "solo-8-1", cwd: w2, brief: join(silent, "1", "brief.md"), report: join(silent, "1", "report.md"), pane: "wH:p6", stage: "prompted", startup: "unknown" },
		]);
	}, 60000);

	test("agent start failure for worker 2 exits 1 with a partial record and no further calls", () => {
		const w1 = join(tmp, "auth-8-w1");
		const w2 = join(tmp, "auth-8-w2");
		const runDir = makeRun("auth-8", [{ cwd: w1 }, { cwd: w2 }]);

		const result = run(["launch", runDir], { FAKE_HERDR_START_FAIL: "auth-8-2" });
		expect(result.code).toBe(1);
		const all = calls();
		expect(all[all.length - 1]).toEqual(["agent", "start", "auth-8-2", "--kind", "omp", "--pane", "wH:p7"]);
		const diagnostic = JSON.parse(result.stderr);
		expect(diagnostic.error).toContain("start_failed");
		expect(diagnostic.record).toBe(join(runDir, "run.json"));
		const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
		expect(record.workers[0].stage).toBe("prompted");
		expect(record.workers[1]).toEqual({
			n: 2,
			name: "auth-8-2",
			cwd: w2,
			brief: join(runDir, "2", "brief.md"),
			report: join(runDir, "2", "report.md"),
			pane: "wH:p7",
			stage: "pane",
		});
	}, 60000);
});

describe("herdr-run wait", () => {
	test("wait runs a bare agent wait, prints the state, and writes nothing", () => {
		const runDir = makeRun("wait-3", [{ cwd: join(tmp, "wait-3-w1") }, { cwd: join(tmp, "wait-3-w2") }]);
		expect(run(["launch", runDir]).code).toBe(0);
		const before = readFileSync(join(runDir, "run.json"), "utf8");
		resetLog();

		const result = run(["wait", runDir, "1"], { FAKE_HERDR_WAIT_STATE: "idle" });
		expect(result.code).toBe(0);
		expect(calls()).toEqual([["agent", "wait", "wait-3-1"]]);
		expect(JSON.parse(result.stdout)).toEqual({ n: 1, name: "wait-3-1", pane: "wH:p6", state: "idle", report: join(runDir, "1", "report.md") });
		expect(readFileSync(join(runDir, "run.json"), "utf8")).toBe(before);

		resetLog();
		const missing = run(["wait", runDir, "9"]);
		expect(missing.code).toBe(1);
		expect(calls()).toEqual([]);

		const noEnv = run(["wait", runDir, "1"], { HERDR_ENV: undefined });
		expect(noEnv.code).toBe(1);
		expect(calls()).toEqual([]);
	}, 60000);
});

describe("herdr-run usage", () => {
	test("unknown verb, wrong arg count, and flags exit 2 with a usage line", () => {
		for (const args of [["frobnicate"], ["launch"], ["wait", join(tmp, "x")], ["launch", join(tmp, "x"), "extra"], ["launch", "-x", join(tmp, "x")], []]) {
			const result = run(args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("usage:");
			expect(calls()).toEqual([]);
			resetLog();
		}
	}, 60000);
});
