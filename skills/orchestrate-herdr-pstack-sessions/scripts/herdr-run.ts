#!/usr/bin/env bun
// herdr-run is the only writer of a Herdr run's tab, panes, agents, and
// run.json. launch validates every input before the first mutating Herdr
// call and claims $RUN/run.json exclusively, so a brief is never sent twice
// and a relaunch is refused before touching Herdr at all. wait is read-only
// and pins the agent by the name recorded at launch, because Herdr clears a
// name once its agent exits.
// Usage: herdr-run launch <RUN> | herdr-run wait <RUN> <n>

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isThinkingSuffix } from "../../../src/models.ts";

type Startup = "working" | "blocked" | "unknown";

interface WorkerBase {
	n: number;
	name: string;
	cwd: string;
	brief: string;
	report: string;
	model?: string;
	pane: string;
}
type WorkerSpec = Omit<WorkerBase, "pane">;
type Worker =
	| (WorkerBase & { stage: "pane" })
	| (WorkerBase & { stage: "agent" })
	| (WorkerBase & { stage: "prompted"; startup: Startup; session?: string });

/** `tab` is absent only when the launch failed before Herdr created the tab. */
interface RunRecord {
	run: string;
	tab?: string;
	workers: Worker[];
}

const USAGE = "usage: herdr-run launch <RUN> | herdr-run wait <RUN> <n>";
const RUN_ID = /^[a-z][a-z0-9_-]{0,29}$/;
const STARTUP_TIMEOUT_MS = "60000";

function die(payload: Record<string, unknown>): never {
	console.error(JSON.stringify(payload));
	process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluck(value: unknown, ...keys: string[]): unknown {
	let current: unknown = value;
	for (const key of keys) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function pluckString(value: unknown, ...keys: string[]): string | undefined {
	const found = pluck(value, ...keys);
	return typeof found === "string" && found !== "" ? found : undefined;
}

interface HerdrReply {
	ok: boolean;
	result?: unknown;
	errorCode?: string;
	message: string;
}

/** Runs herdr with an argv array (never a shell string) and parses its JSON envelope. */
function herdr(args: readonly string[]): HerdrReply {
	const proc = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
	const exit = proc.exitCode ?? -1;
	const stderr = proc.stderr.toString();
	const op = `herdr ${args[0]} ${args[1] ?? ""}`;
	if (exit !== 0) {
		let code: string | undefined;
		let detail = stderr.trim() || `exit ${exit}`;
		try {
			const error = pluck(JSON.parse(stderr), "error");
			code = pluckString(error, "code");
			detail = pluckString(error, "message") ?? detail;
		} catch {
			// herdr may print plain text instead of its JSON error envelope
		}
		return { ok: false, errorCode: code, message: `${op} failed: ${code !== undefined ? `${code}: ` : ""}${detail}` };
	}
	// Exit 0 is Herdr's success contract; a missing field surfaces where the caller demands it.
	try {
		return { ok: true, result: pluck(JSON.parse(proc.stdout.toString()), "result"), message: "" };
	} catch {
		return { ok: true, result: undefined, message: "" };
	}
}

/** Splits a trailing thinking level (`litellm/glm-5.3:max`); any other suffix (`ollama/qwen3:30b`) keeps the id whole. */
function splitThinking(model: string): { base: string; level: string } | undefined {
	const colon = model.lastIndexOf(":");
	if (colon <= 0) return undefined;
	const level = model.slice(colon + 1).toLowerCase();
	return isThinkingSuffix(level) ? { base: model.slice(0, colon), level } : undefined;
}

function readWorkerSpecs(runDir: string, run: string): WorkerSpec[] {
	const path = join(runDir, "workers.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		die({ error: `${path} is missing or not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
	}
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
		die({ error: `${path} must be a JSON array of 1 to 4 worker entries` });
	}
	const specs: WorkerSpec[] = [];
	raw.forEach((entry: unknown, index: number) => {
		const n = index + 1;
		if (!isRecord(entry)) die({ error: `${path} entry ${n} is not an object` });
		for (const key of Object.keys(entry)) {
			if (key !== "cwd" && key !== "model") die({ error: `${path} entry ${n} has unexpected key "${key}"; only cwd and model are allowed` });
		}
		const cwd = entry.cwd;
		if (typeof cwd !== "string" || !isAbsolute(cwd)) die({ error: `${path} entry ${n} cwd must be an absolute path` });
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) die({ error: `${path} entry ${n} cwd is not an existing directory: ${cwd}` });
		const model = entry.model;
		if (model !== undefined && (typeof model !== "string" || model === "")) {
			die({ error: `${path} entry ${n} model must be a non-empty string` });
		}
		const brief = join(runDir, String(n), "brief.md");
		if (!existsSync(brief)) die({ error: `missing brief: ${brief}` });
		const report = join(runDir, String(n), "report.md");
		if (existsSync(report)) die({ error: `report already exists: ${report}` });
		// `wait` points the orchestrator at this path, so a brief that names another one strands the report.
		if (!readFileSync(brief, "utf8").includes(report)) die({ error: `brief ${brief} does not name its report path ${report}` });
		specs.push({ n, name: `${run}-${n}`, cwd, model: typeof model === "string" ? model : undefined, brief, report });
	});
	return specs;
}

function launch(runArg: string): void {
	if (process.env.HERDR_ENV !== "1") {
		die({ error: `HERDR_ENV=${JSON.stringify(process.env.HERDR_ENV ?? "")}; herdr-run runs only inside a Herdr orchestrator session` });
	}
	if (process.env.PSTACK_HERDR_RUN !== undefined) {
		die({ error: `PSTACK_HERDR_RUN=${process.env.PSTACK_HERDR_RUN}; this session is a worker pane, not an orchestrator` });
	}
	const workspace = process.env.HERDR_WORKSPACE_ID;
	if (workspace === undefined || workspace === "") die({ error: "HERDR_WORKSPACE_ID is not set" });

	const runDir = resolve(runArg);
	if (!existsSync(runDir) || !statSync(runDir).isDirectory()) die({ error: `run directory ${runDir} does not exist` });
	const run = basename(runDir);
	if (!RUN_ID.test(run)) die({ error: `run id ${JSON.stringify(run)} must match ^[a-z][a-z0-9_-]{0,29}$` });

	const specs = readWorkerSpecs(runDir, run);
	const recordPath = join(runDir, "run.json");
	// Checked before any Herdr call so a relaunch of a launched run touches nothing.
	if (existsSync(recordPath)) die({ error: `run already launched: ${recordPath} exists`, record: recordPath });

	const listed = herdr(["agent", "list"]);
	if (!listed.ok) die({ error: listed.message });
	const agents = pluck(listed.result, "agents");
	if (!Array.isArray(agents)) die({ error: "herdr agent list reply is missing .result.agents" });
	const live = new Set<string>();
	for (const entry of agents) {
		const name = pluckString(entry, "name");
		if (name !== undefined) live.add(name);
	}
	for (const spec of specs) {
		if (live.has(spec.name)) die({ error: `a live Herdr agent is already named ${spec.name}` });
	}

	let tab: string | undefined;
	const workers: Worker[] = [];
	const save = (flag?: "wx"): void => {
		const bytes = `${JSON.stringify({ run, tab, workers }, null, "\t")}\n`;
		if (flag !== undefined) return writeFileSync(recordPath, bytes, { flag });
		const tmp = `${recordPath}.tmp`;
		writeFileSync(tmp, bytes);
		renameSync(tmp, recordPath);
	};
	// Exclusive claim: once set, this run directory never launches again, even after a failed launch.
	try {
		save("wx");
	} catch {
		die({ error: `run already launched: ${recordPath} exists`, record: recordPath });
	}

	const paneOf = (n: number): string => workers[n - 1]!.pane;
	const base = (spec: WorkerSpec, pane: string): WorkerBase => ({ ...spec, pane });
	const abort = (message: string): never => {
		save();
		die({ error: message, record: recordPath });
	};
	const demand = (value: string | undefined, op: string, field: string): string =>
		value ?? abort(`herdr ${op} reply is missing ${field}`);

	const tabReply = herdr([
		"tab", "create", "--workspace", workspace, "--cwd", specs[0]!.cwd, "--label", `pstack ${run}`,
		"--env", `PSTACK_HERDR_RUN=${run}`, "--no-focus",
	]);
	if (!tabReply.ok) abort(tabReply.message);
	tab = demand(pluckString(tabReply.result, "tab", "tab_id"), "tab create", ".result.tab.tab_id");
	const pane1 = demand(pluckString(tabReply.result, "root_pane", "pane_id"), "tab create", ".result.root_pane.pane_id");
	workers.push({ ...base(specs[0]!, pane1), stage: "pane" });
	save();

	// Splits address explicit parent panes; --current would target the orchestrator's own pane.
	const splitFrom: Record<number, { parent: number; direction: "right" | "down" }> = {
		2: { parent: 1, direction: "right" },
		3: { parent: 1, direction: "down" },
		4: { parent: 2, direction: "down" },
	};
	for (const spec of specs.slice(1)) {
		const plan = splitFrom[spec.n]!;
		const reply = herdr(["pane", "split", paneOf(plan.parent), "--direction", plan.direction, "--cwd", spec.cwd, "--env", `PSTACK_HERDR_RUN=${run}`, "--no-focus"]);
		if (!reply.ok) abort(reply.message);
		const pane = demand(pluckString(reply.result, "pane", "pane_id"), "pane split", ".result.pane.pane_id");
		workers.push({ ...base(spec, pane), stage: "pane" });
		save();
	}

	for (const spec of specs) {
		const reply = herdr(["pane", "rename", paneOf(spec.n), spec.name]);
		if (!reply.ok) abort(reply.message);
		save();
	}

	for (const spec of specs) {
		const startArgs: string[] = ["agent", "start", spec.name, "--kind", "omp", "--pane", paneOf(spec.n)];
		const thinking = spec.model === undefined ? undefined : splitThinking(spec.model);
		if (thinking !== undefined) startArgs.push("--", "--model", thinking.base, "--thinking", thinking.level);
		else if (spec.model !== undefined) startArgs.push("--", "--model", spec.model);
		const started = herdr(startArgs);
		if (!started.ok) abort(started.message);
		workers[spec.n - 1] = { ...base(spec, paneOf(spec.n)), stage: "agent" };
		save();

		// --wait would block this launch for the whole worker turn; the prompt call only sends it.
		const prompted = herdr(["agent", "prompt", spec.name, `/poteto-mode Read ${spec.brief} in full and execute it. It is your whole task.`]);
		if (!prompted.ok) abort(prompted.message);
		workers[spec.n - 1] = { ...base(spec, paneOf(spec.n)), stage: "prompted", startup: "unknown" };
		save();

		const waited = herdr(["agent", "wait", spec.name, "--until", "working", "--until", "blocked", "--timeout", STARTUP_TIMEOUT_MS]);
		const status = pluckString(waited.result, "agent", "agent_status");
		const startup: Startup = status === "working" || status === "blocked" ? status : "unknown";
		// OMP's Herdr integration publishes the session asynchronously, so `agent start` can reply without one.
		const session = pluckString(waited.result, "agent", "agent_session", "value")
			?? pluckString(herdr(["agent", "get", spec.name]).result, "agent", "agent_session", "value");
		workers[spec.n - 1] = { ...base(spec, paneOf(spec.n)), stage: "prompted", startup, ...(session === undefined ? {} : { session }) };
		save();
		// A timeout means 60 s without working or blocked: unread state, not a failed launch.
		if (!waited.ok && waited.errorCode !== "timeout") abort(waited.message);
	}

	const record: RunRecord = { run, tab, workers };
	process.stdout.write(`${JSON.stringify(record, null, "\t")}\n`);
}

function waitCmd(runArg: string, nArg: string): void {
	if (process.env.HERDR_ENV !== "1") {
		die({ error: `HERDR_ENV=${JSON.stringify(process.env.HERDR_ENV ?? "")}; herdr-run runs only inside a Herdr session` });
	}
	if (!/^[1-9]\d*$/.test(nArg)) die({ error: `worker number must be a positive integer, got ${JSON.stringify(nArg)}` });
	const n = Number(nArg);
	const runDir = resolve(runArg);
	const recordPath = join(runDir, "run.json");
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(recordPath, "utf8"));
	} catch (error) {
		die({ error: `cannot read run record ${recordPath}: ${error instanceof Error ? error.message : String(error)}` });
	}
	const listed = pluck(record, "workers");
	if (!Array.isArray(listed)) die({ error: `run record ${recordPath} has no workers array` });
	const worker = listed.find((entry): entry is Worker =>
		isRecord(entry) && entry.n === n && (entry.stage === "pane" || entry.stage === "agent" || entry.stage === "prompted"));
	if (worker === undefined || worker.stage !== "prompted") {
		die({ error: `worker ${n} is not a wait target: run record shows ${worker === undefined ? "no such worker" : `stage ${worker.stage}`}` });
	}
	const reply = herdr(["agent", "wait", worker.name]);
	if (!reply.ok) die({ error: reply.message });
	const state = pluckString(reply.result, "agent", "agent_status") ?? die({ error: "herdr agent wait reply is missing .result.agent.agent_status" });
	console.log(JSON.stringify({ n, name: worker.name, pane: worker.pane, state, report: worker.report }));
}

const argv = process.argv.slice(2);
const usageFail = (): never => {
	console.error(USAGE);
	process.exit(2);
};
const verb = argv[0];
if (verb === undefined || argv.slice(1).some((arg) => arg.startsWith("-"))) usageFail();
if (verb === "launch") {
	if (argv.length !== 2) usageFail();
	launch(argv[1]!);
} else if (verb === "wait") {
	if (argv.length !== 3) usageFail();
	waitCmd(argv[1]!, argv[2]!);
} else {
	usageFail();
}
