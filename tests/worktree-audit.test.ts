import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { join } from "node:path";
import { auditWorktrees, HEADER, parseGithubSlug } from "../skills/poteto-mode/scripts/worktree-audit.ts";

let root: string;
let repo: string;
let sessions: string;
let cleanWt: string;
let wipWt: string;
let recentWt: string;
let shimDir: string;
let shimLog: string;

function git(args: string[], cwd = repo): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function marker(name: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(`${path}.fired`)}\n`);
	chmodSync(path, 0o700);
	return path;
}

/** Prepends the git/gh shims to PATH, sets canary env, restores everything afterwards. */
function runAuditWithCanaries(env: Record<string, string>): ReturnType<typeof auditWorktrees> {
	const saved: Array<[string, string | undefined]> = [["PATH", process.env.PATH], ...Object.keys(env).map((key) => [key, process.env[key]] as [string, string | undefined])];
	Object.assign(process.env, env);
	process.env.PATH = `${shimDir}:${process.env.PATH}`;
	try {
		return auditWorktrees({ repo, sessionsDir: sessions, now: Date.now() });
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function logLines(): string[] {
	return existsSync(shimLog) ? readFileSync(shimLog, "utf8").split("\n").filter(Boolean) : [];
}

function fetchArgLines(): string[] {
	return logLines().filter((line) => line.startsWith("GIT ARGS: ") && line.split(" ").includes("fetch"));
}

beforeAll(() => {
	root = mkdtempSync("/tmp/pstack-audit-");
	// Spaces in the repo path are part of the contract.
	repo = join(root, "spaced repo");
	sessions = join(root, "sessions");
	mkdirSync(repo, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	git(["init", "-q", "-b", "main", "."]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "f"), "one\n");
	git(["add", "f"]);
	git(["commit", "-qm", "init"]);
	// Fake a fetched origin/main at HEAD without any network.
	git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

	cleanWt = join(root, "wt clean");
	git(["worktree", "add", "-q", cleanWt, "-b", "feature-clean"]);
	wipWt = join(root, "wt wip");
	git(["worktree", "add", "-q", wipWt, "-b", "feature-wip"]);
	recentWt = join(root, "wt recent");
	git(["worktree", "add", "-q", recentWt, "-b", "feature-recent"]);
	writeFileSync(join(wipWt, "f"), "two\n");
	for (const branch of ["feature-clean", "feature-recent"]) {
		git(["update-ref", `refs/remotes/origin/${branch}`, git(["rev-parse", branch]).trim()]);
	}

	// Chat evidence: recent reference for feature-recent, six-day-old one for feature-clean.
	const now = Date.now();
	const recentFile = join(sessions, "bucket", "s-recent.jsonl");
	mkdirSync(join(sessions, "bucket"), { recursive: true });
	writeFileSync(recentFile, JSON.stringify({ cwd: recentWt }));
	utimesSync(recentFile, new Date(now), new Date(now));
	const oldFile = join(sessions, "bucket", "s-old.jsonl");
	writeFileSync(oldFile, JSON.stringify({ cwd: cleanWt }));
	utimesSync(oldFile, new Date(now - 6 * 86_400_000), new Date(now - 6 * 86_400_000));

	// Git/gh shims: the git shim records every invocation and intercepts
	// fetch (no network in tests) dumping the environment it received; the
	// gh shim records its argv, environment and cwd and returns no PRs.
	shimDir = join(root, "shims");
	mkdirSync(shimDir);
	shimLog = join(root, "shim.log");
	const realGit = Bun.which("git")!;
	writeFileSync(
		join(shimDir, "git"),
		`#!/bin/sh
		printf 'GIT ARGS: %s\\n' "$*" >> ${shimLog}
		printf 'GIT LOCKS: %s\\n' "\${GIT_OPTIONAL_LOCKS-unset}" >> ${shimLog}
for a in "$@"; do
	if [ "$a" = fetch ]; then
		printf 'GIT FETCH ENV: HOME=%s XDG=%s GH_TOKEN=%s GITHUB_TOKEN=%s GIT_ASKPASS=%s\\n' "$HOME" "\${XDG_CONFIG_HOME-unset}" "$([ -n "$GH_TOKEN" ] && echo set || echo no)" "$([ -n "$GITHUB_TOKEN" ] && echo set || echo no)" "$([ -n "$GIT_ASKPASS" ] && echo set || echo no)" >> ${shimLog}
		exit 93
	fi
done
exec ${realGit} "$@"
`,
	);
	writeFileSync(
		join(shimDir, "gh"),
		`#!/bin/sh
printf 'GH ARGS: %s\\n' "$*" >> ${shimLog}
printf 'GH ENV: HOME=%s XDG=%s GH_HOST=%s GH_ENTERPRISE_TOKEN=%s GITHUB_TOKEN=%s PWD=%s\\n' "$HOME" "\${XDG_CONFIG_HOME-unset}" "$GH_HOST" "$([ -n "$GH_ENTERPRISE_TOKEN" ] && echo set || echo no)" "$([ -n "$GITHUB_TOKEN" ] && echo set || echo no)" "$PWD" >> ${shimLog}
echo "[]"
`,
	);
	chmodSync(join(shimDir, "git"), 0o700);
	chmodSync(join(shimDir, "gh"), 0o700);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("worktree-audit", () => {
	test("classifies buckets with the upstream precedence and never deletes", () => {
		const { rows, warnings } = auditWorktrees({ repo, sessionsDir: sessions, now: Date.now() });

		// No remote is configured, so no canonical fetch is possible; the
		// documented stale warning must appear, never be fatal.
		expect(warnings.join("\n")).toContain("could not fetch origin/main");

		const byWorktree = new Map(rows.map((row) => [row.worktree, row]));
		const clean = byWorktree.get(cleanWt);
		const wip = byWorktree.get(wipWt);
		const recent = byWorktree.get(recentWt);

		expect(wip).toBeDefined();
		expect(wip!.dirty).toBe("wip:1");
		expect(wip!.bucket).toBe("hold-wip"); // wip outranks everything

		expect(clean).toBeDefined();
		expect(clean!.merged).toBe("YES");
		expect(clean!.remote).toBe("pushed"); // branch ref equals origin ref
		expect(clean!.lastChat).not.toBe("-");
		expect(clean!.bucket).toBe("safe"); // six-day-old chat is outside the four-day window

		expect(recent).toBeDefined();
		expect(recent!.merged).toBe("YES");
		expect(recent!.bucket).toBe("verify-recent-chat"); // fresh chat outranks merged/safe

		// Audit is read-only: every worktree still exists and is still listed.
		expect(existsSync(cleanWt)).toBe(true);
		expect(existsSync(wipWt)).toBe(true);
		expect(existsSync(recentWt)).toBe(true);
		expect(git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(4);
	});

	test("planted fsmonitor, credential helper and ambient GIT_* cannot execute or leak", () => {
		const markFsmonitor = marker("mark-fsmonitor");
		const markCred = marker("mark-cred");
		const markAskpass = marker("mark-askpass");
		const fired = (m: string) => existsSync(`${m}.fired`);

		// Hostile repository-local config: an fsmonitor helper `git status`
		// would launch and a credential helper any transport would run.
		git(["config", "core.fsmonitor", markFsmonitor]);
		git(["config", "credential.helper", `!${markCred}`]);
		// The local path remote is not a canonical github.com identity.
		git(["remote", "add", "origin", join(root, "origin-fixture")]);
		// Ambient Git variables: config injection (GIT_CONFIG_COUNT), askpass
		// and ssh command would all execute if inherited.
		const { rows, warnings } = runAuditWithCanaries({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.fsmonitor",
			GIT_CONFIG_VALUE_0: markAskpass,
			GIT_ASKPASS: markAskpass,
			GIT_SSH_COMMAND: markAskpass,
			GH_HOST: "attacker.example",
		});
		// The non-canonical remote is never fetched, so the documented
		// stale-fetch warning appears — degraded output, never execution.
		expect(warnings.join("\n")).toContain("could not fetch origin/main");
		// Normal output remains: every worktree is still classified.
		expect(rows.map((row) => row.worktree)).toEqual(expect.arrayContaining([cleanWt, wipWt, recentWt]));
		expect(rows.find((row) => row.worktree === wipWt)!.bucket).toBe("hold-wip");
		// gh never queries: a local path remote is not a valid repo identity
		// and the ambient GH_HOST redirect is dropped.
		for (const row of rows) expect(row.pr).toBe("-");
		// Nothing executed and nothing leaked through a helper.
		expect(fired(markFsmonitor)).toBe(false);
		expect(fired(markCred)).toBe(false);
		expect(fired(markAskpass)).toBe(false);

		git(["config", "--unset", "core.fsmonitor"]);
		git(["config", "--unset", "credential.helper"]);
	});

	test("hostile named-origin vectors cannot execute or redirect the scratch fetch", () => {
		rmSync(shimLog, { force: true });
		const markUploadpack = marker("mark-uploadpack");
		const markSsh = marker("mark-ssh");
		const markHome = marker("mark-home-cred");
		const markXdg = marker("mark-xdg-fsmonitor");
		const markInstead = join(root, "insteadof-redirect");
		const hostileHome = join(root, "hostile-home");
		const hostileXdg = join(root, "hostile-xdg");

		// Hostile repo-local config: uploadpack would run on a named-remote
		// fetch, sshCommand on any ssh invocation, and an insteadOf rewrite
		// would silently swap the canonical fetch URL for a local target.
		git(["config", "remote.origin.uploadpack", markUploadpack]);
		git(["config", "core.sshCommand", markSsh]);
		git(["config", "url.https://evil.example/.insteadOf", "https://github.com/"]);
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
		// Hostile HOME and XDG trees: a credential helper for github.com and
		// an fsmonitor helper, reachable only if git's config resolution
		// followed ambient HOME/XDG instead of the scratch dir.
		mkdirSync(hostileHome, { recursive: true });
		mkdirSync(join(hostileXdg, "git"), { recursive: true });
		writeFileSync(join(hostileHome, ".gitconfig"), `[credential "https://github.com"]\n\thelper = !${markHome}\n`);
		writeFileSync(join(hostileXdg, "git", "config"), `[core]\n\tfsmonitor = ${markXdg}\n`);

		const { rows, warnings } = runAuditWithCanaries({
			HOME: hostileHome,
			XDG_CONFIG_HOME: hostileXdg,
			GIT_ASKPASS: markSsh,
			GIT_SSH_COMMAND: markSsh,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.fsmonitor",
			GIT_CONFIG_VALUE_0: markUploadpack,
			GH_TOKEN: "ghp-git-must-not-see",
			GITHUB_TOKEN: "ghp-git-must-not-see",
			GH_HOST: "attacker.example",
			GH_ENTERPRISE_TOKEN: "ent-canary",
		});

		// The canonical remote triggers exactly one scratch fetch.
		const fetchLines = fetchArgLines();
		expect(fetchLines).toHaveLength(1);
		// The fetch URL is the constructed canonical HTTPS URL — never the
		// insteadOf-rewritten local target, never a hostile value, and the
		// remote-side program is pinned, so repo-local uploadpack is dead.
		expect(fetchLines[0]).toContain("--upload-pack=git-upload-pack");
		expect(fetchLines[0]).toContain("https://github.com/octo/repo");
		expect(fetchLines[0]).not.toContain("evil.example");
		expect(fetchLines[0]).not.toContain(markInstead);
		// The fetch environment: scratch HOME, no XDG redirect, no credential
		// material, no askpass, and nulled global/system config.
		const fetchEnv = logLines().find((line) => line.startsWith("GIT FETCH ENV:"));
		expect(fetchEnv).toBeDefined();
		expect(fetchEnv).toContain("HOME=/tmp/pstack-audit-env-");
		expect(fetchEnv).toContain("XDG=unset");
		expect(fetchEnv).toContain("GH_TOKEN=no");
		expect(fetchEnv).toContain("GITHUB_TOKEN=no");
		expect(fetchEnv).toContain("GIT_ASKPASS=no");

		// The shim-failed fetch is reported as degraded output, not fatal, and
		// the audit still classifies every worktree.
		expect(warnings.join("\n")).toContain("could not fetch origin/main");
		expect(rows.map((row) => row.bucket)).toContain("hold-wip");
		// Nothing planted anywhere — repo config, ambient env, hostile HOME or
		// XDG trees — executed.
		for (const m of [markUploadpack, markSsh, markHome, markXdg]) expect(existsSync(`${m}.fired`)).toBe(false);

		git(["config", "--unset", "remote.origin.uploadpack"]);
		git(["config", "--unset", "core.sshCommand"]);
		git(["config", "--remove-section", "url.https://evil.example/"]);
		git(["remote", "set-url", "origin", join(root, "origin-fixture")]);
	});

	test("a canonical remote fetches the literal URL and gh queries --repo in a narrow environment", () => {
		rmSync(shimLog, { force: true });
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);

		const { warnings } = runAuditWithCanaries({
			GH_HOST: "attacker.example",
			GH_ENTERPRISE_TOKEN: "ent-canary",
			GITHUB_TOKEN: "gh-token-canary",
			HOME: "/nonexistent-hostile-home",
			XDG_CONFIG_HOME: "/nonexistent-hostile-xdg",
		});

		// gh is asked for the validated slug with the exact upstream argv —
		// never GH_HOST, never the hostile remote's raw URL.
		const ghLine = logLines().find((line) => line.startsWith("GH ARGS:"));
		expect(ghLine).toBe("GH ARGS: pr list --repo octo/repo --author @me --state all --limit 1000 --json number,state,headRefName");
		const ghEnvLine = logLines().find((line) => line.startsWith("GH ENV:"));
		expect(ghEnvLine).toBeDefined();
		expect(ghEnvLine).toContain("HOME=/tmp/pstack-audit-env-"); // scratch, not /nonexistent-hostile-home
		expect(ghEnvLine).toContain("XDG=unset");
		expect(ghEnvLine).toContain("GH_HOST="); // dropped entirely
		expect(ghEnvLine).not.toContain("attacker.example");
		expect(ghEnvLine).toContain("GH_ENTERPRISE_TOKEN=no");
		expect(ghEnvLine).toContain("GITHUB_TOKEN=set"); // gh keeps its own auth
		// gh does not run inside the audited repository.
		const ghPwd = /PWD=(.*)$/.exec(ghEnvLine!)![1];
		expect(ghPwd.startsWith("/tmp/")).toBe(true);
		expect(ghPwd).not.toBe(repo);

		// The fetch stays pinned to the canonical URL with a fixed upload-pack.
		const fetchLines = fetchArgLines();
		expect(fetchLines).toHaveLength(1);
		expect(fetchLines[0]).toContain("--upload-pack=git-upload-pack");
		expect(fetchLines[0]).toContain("https://github.com/octo/repo");
		expect(fetchLines[0]).not.toContain("git@");
		// Shim-failed fetch still surfaces the stale warning.
		expect(warnings.join("\n")).toContain("could not fetch origin/main");

		git(["remote", "set-url", "origin", join(root, "origin-fixture")]);
	});

	test("non-canonical remotes neither fetch nor query gh", () => {
		rmSync(shimLog, { force: true });
		const { warnings, rows } = runAuditWithCanaries({ GH_HOST: "attacker.example" });
		expect(fetchArgLines()).toHaveLength(0);
		expect(logLines().some((line) => line.startsWith("GH ARGS:"))).toBe(false);
		expect(warnings.join("\n")).toContain("could not fetch origin/main");
		for (const row of rows) expect(row.pr).toBe("-");
	});

	/** Overwrite the gh shim with one failing/malformed behavior; tests restore the healthy echo. */

	test("every git invocation, target repository and scratch alike, runs with GIT_OPTIONAL_LOCKS=0", () => {
		rmSync(shimLog, { force: true });
		runAuditWithCanaries({});
		const locks = logLines().filter((line) => line.startsWith("GIT LOCKS:"));
		expect(locks.length).toBeGreaterThan(0);
		for (const line of locks) expect(line).toBe("GIT LOCKS: 0");
	});
	function setGhShim(script: string): void {
		writeFileSync(join(shimDir, "gh"), `#!/bin/sh\n${script}\n`);
		chmodSync(join(shimDir, "gh"), 0o700);
	}

	test("gh failure, malformed output and timeout render PR inventory unknown and never safe", () => {
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
		const cases: Array<[string, string]> = [
			["exit 1", "exit 1"],
			["non-array JSON", "echo '{\"oops\": true}'"],
			["malformed JSON", "echo '{oops'"],
			["timeout kill", "kill -TERM $$"],
		];
		try {
			for (const [, script] of cases) {
				setGhShim(script);
				const { rows, warnings } = runAuditWithCanaries({});
				for (const row of rows) expect(row.pr).toBe("unknown");
				const clean = rows.find((row) => row.worktree === cleanWt)!;
				expect(clean.merged).toBe("YES");
				// Unknown inventory can never classify a worktree safe/prunable.
				expect(clean.bucket).not.toBe("safe");
				expect(clean.bucket).toBe("review");
				expect(warnings.join("\n")).toContain("gh PR inventory unavailable");
			}
			// A successful empty query is a KNOWN inventory: safe stays reachable.
			setGhShim('echo "[]"');
			const { rows } = runAuditWithCanaries({});
			expect(rows.find((row) => row.worktree === cleanWt)!.bucket).toBe("safe");
			expect(rows.find((row) => row.worktree === cleanWt)!.pr).toBe("-");
		} finally {
			setGhShim('echo "[]"');
			git(["remote", "set-url", "origin", join(root, "origin-fixture")]);
		}
	});

	test("audit leaves target worktree and repo index files untouched under stale stats", () => {
		const wtIndex = git(["-C", cleanWt, "rev-parse", "--git-path", "index"]).trim();
		const repoIndex = join(repo, ".git", "index");
		const before = [wtIndex, repoIndex].map((path) => {
			const s = statSync(path);
			return { path, mtimeMs: s.mtimeMs, size: s.size };
		});
		// Stale stats: the tracked file changes after the index was written, so
		// an unguarded `git status` would opportunistically refresh the index.
		writeFileSync(join(cleanWt, "f"), "stale-stat-probe\n");
		try {
			const { rows } = auditWorktrees({ repo, sessionsDir: sessions, now: Date.now() });
			const clean = rows.find((row) => row.worktree === cleanWt)!;
			expect(clean.dirty).toBe("wip:1"); // the audit observed the change without writing the index
			for (const b of before) {
				const s = statSync(b.path);
				expect(s.mtimeMs).toBe(b.mtimeMs);
				expect(s.size).toBe(b.size);
			}
		} finally {
			writeFileSync(join(cleanWt, "f"), "one\n");
		}
	});

	test("only canonical github.com remotes resolve to a slug", () => {
		expect(parseGithubSlug("https://github.com/octo/repo")).toBe("octo/repo");
		expect(parseGithubSlug("https://github.com/octo/repo.git")).toBe("octo/repo");
		expect(parseGithubSlug("git@github.com:octo/repo.git")).toBe("octo/repo");
		for (const hostile of [
			"ext::sh -c touch /tmp/pwn",
			"/tmp/some/local/path",
			"file:///tmp/x",
			"https://enterprise.example/octo/repo",
			"https://gitlab.com/octo/repo",
			"git@enterprise.example:octo/repo",
			"https://github.com.evil.com/octo/repo",
			"ssh://git@github.com/octo/repo",
			"https://user@github.com/octo/repo",
			"https://github.com/octo/repo/extra",
		]) {
			expect(parseGithubSlug(hostile)).toBeUndefined();
		}
	});

	test("emits the tab-separated header and size-ordered rows", () => {
		const { rows } = auditWorktrees({ repo, sessionsDir: sessions });
		expect(HEADER.split("\t")).toEqual([
			"SIZE", "AGE", "MERGED", "DIRTY", "REMOTE", "PR", "LAST_CHAT", "BUCKET", "WORKTREE",
		]);
		for (const row of rows) {
			expect(row.size).toMatch(/^[\d.?]+[KMG]?$/);
			expect(row.pr).toBe("-"); // gh unavailable/unauthenticated stays best-effort
		}
	});
});
