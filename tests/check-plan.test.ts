/**
 * Focused regressions for the shipped check-plan helper and the pstack CLI's
 * bounded event-input handling: a complete program plan passes with zero
 * problems, a plan whose "Verify, live" block drops the ten-lane sentence
 * fails naming the configured `swarm workers` role (the host adaptation that
 * replaced the upstream Cursor model slug), and event inputs — file or stdin
 * — are byte-bounded before materialization.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EVENT_BYTES } from "../src/cli.ts";

const CHECK_PLAN = join(import.meta.dir, "..", "skills", "poteto-mode", "scripts", "check-plan.mjs");
const RULE = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const LANES = "Ten lanes on the configured `swarm workers` role at the PR head";

function plan(liveHeader: string): string {
	const lanes = Array.from({ length: 10 }, (_, i) =>
		`- [x] Lane ${i + 1}. Save \`lane${i + 1}.png\`. Pass when the settings page shows the saved value.`,
	).join("\n");
	return `# Ship the settings page

One PR, one program.

## How to read this

- One box is one unit of work
- Every box names the evidence
- Check a box only when its evidence exists
- Workflow playbooks/orchestrate.md
- ${RULE}

## Program checklist

### Arm the program

- [x] /goal is posted with the 30-minute status message cadence
- [x] Baseline captured with git show origin/main:

### Spawn owners

- [x] Owners spawn per PR with the status message template

### PR mechanics

- [x] Each PR opens from a worktree at the PR head

### Verdict and merge

- [x] Verdict posts after both PRs settle

### Boot recipe

- [x] Recipe recorded for the next session

## PR 1 settings page

**Depends on.** PR #0 lands first

**Files.**
- [x] src/settings.ts

**Build.**
- [x] bun run build passes

**You see.**
- [x] Settings page renders

**Verify, unit.** ${RULE}
- [x] bun test settings

**Verify, live.** ${liveHeader}
${lanes}

**Verify, perf.** ${RULE}
- [x] Metric. p95 render time.
- [x] Probe. repeated render loop.
- [x] Baseline. main branch numbers.
- [x] Rule. no regression beyond five percent.

**Review gate.**
- [x] screenshot and video evidence attached; operator confirmed

**Merge.**
- [x] Squash merged

## Close the program

- [x] Report posted

## Appendix A Prototype evidence

Screenshots archived.
`;
}

function runPlan(markdown: string): { exitCode: number; stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "check-plan-"));
	try {
		const file = join(dir, "plan.md");
		writeFileSync(file, markdown);
		const result = Bun.spawnSync(["bun", CHECK_PLAN, file], { stdout: "pipe", stderr: "pipe" });
		return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("check-plan.mjs", () => {
	test("complete program plan passes with zero problems", () => {
		const result = runPlan(plan(`${RULE} ${LANES}`));
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("1 PR sections, 0 problems");
	});

	test("missing ten-lane sentence fails naming the swarm workers role", () => {
		const result = runPlan(plan(RULE));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`Verify, live lacks "${LANES}"`);
	});
});

const PSTACK_CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A valid routine event padded with multibyte UTF-8 to exactly the CLI's byte cap. */
function cappedEventJson(): string {
	const head = '{"event_id":"e","body":{"pad":"';
	const tail = '"}}';
	const multibyte = "é".repeat(1024); // 2048 UTF-8 bytes of the pad
	const ascii = "a".repeat(MAX_EVENT_BYTES - Buffer.byteLength(head) - Buffer.byteLength(tail) - 2 * multibyte.length);
	const json = head + ascii + multibyte + tail;
	expect(Buffer.byteLength(json, "utf8")).toBe(MAX_EVENT_BYTES);
	return json;
}

/** Runs the real CLI entrypoint in a subprocess (the only way to exercise its file/stdin readers end to end). */
function runPstack(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", PSTACK_CLI, ...args], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("pstack CLI event input bounds", () => {
	test("an event file advertised over the byte cap is rejected from stat size before reading", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-cli-event-"));
		try {
			const file = join(dir, "oversized.json");
			writeFileSync(file, "");
			truncateSync(file, MAX_EVENT_BYTES * 8); // advertised 8 MiB sparse file
			const result = runPstack(["--cwd", dir, "run", "--routine", "no-such-routine", "--event", file]);
			expect(result.exitCode).toBe(64);
			expect(result.stderr).toMatch(new RegExp(`exceeds the ${MAX_EVENT_BYTES}-byte event bound`));
			expect(result.stderr).toMatch(/8388608 bytes/); // the advertised stat size names the file
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an event file of exactly the cap bytes with multibyte UTF-8 parses and proceeds", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-cli-event-"));
		try {
			const file = join(dir, "exact.json");
			writeFileSync(file, cappedEventJson(), "utf8");
			const result = runPstack(["--cwd", dir, "run", "--routine", "no-such-routine", "--event", file]);
			// The bound passed: the failure is the (expected) unknown routine, not reading.
			expect(result.exitCode).toBe(64);
			expect(result.stderr).toMatch(/unknown routine 'no-such-routine'/);
			expect(result.stderr).not.toMatch(/exceeds/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a stdin event of exactly the cap bytes parses and proceeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-cli-event-"));
		const proc = Bun.spawn(["bun", PSTACK_CLI, "--cwd", dir, "run", "--routine", "no-such-routine", "--event", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		try {
			proc.stdin.write(new TextEncoder().encode(cappedEventJson()));
			proc.stdin.end();
			expect(await proc.exited).toBe(64);
			expect(await new Response(proc.stderr).text()).toMatch(/unknown routine 'no-such-routine'/);
		} finally {
			proc.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	}, { timeout: 30_000 });

	test("chunked stdin past the cap is abandoned at cap+1 without waiting for the sender's EOF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-cli-event-"));
		const proc = Bun.spawn(["bun", PSTACK_CLI, "--cwd", dir, "run", "--routine", "no-such-routine", "--event", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		try {
			// 16 × 64 KiB chunks land exactly on the cap; one more byte crosses it.
			// The pipe is never closed: bounded reading must stop (cancel) at
			// cap+1 instead of draining until EOF, so the process exits while
			// the sender is still attached.
			const chunk = new Uint8Array(64 * 1024).fill(0x30);
			for (let i = 0; i < MAX_EVENT_BYTES / chunk.byteLength; i++) proc.stdin.write(chunk);
			proc.stdin.write(new Uint8Array([0x31]));
			await proc.stdin.flush();
			const exitCode = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => null)]);
			expect(exitCode).not.toBeNull(); // unbounded reading drains stdin to EOF and hangs here
			expect(exitCode).toBe(64);
			const stderr = await new Response(proc.stderr).text();
			expect(stderr).toMatch(new RegExp(`stdin event exceeds the ${MAX_EVENT_BYTES}-byte event bound`));
		} finally {
			proc.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	}, { timeout: 30_000 });
});
