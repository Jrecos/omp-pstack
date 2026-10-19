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
	if [ "$a" = ls-remote ]; then
		if [ -f ${join(root, "remote-head")} ]; then cat ${join(root, "remote-head")}; exit 0; fi
		exit 93
	fi
	if [ "$a" = fetch ]; then
		printf 'GIT FETCH ENV: HOME=%s XDG=%s GH_TOKEN=%s GITHUB_TOKEN=%s GIT_ASKPASS=%s\\n' "$HOME" "\${XDG_CONFIG_HOME-unset}" "$([ -n "$GH_TOKEN" ] && echo set || echo no)" "$([ -n "$GITHUB_TOKEN" ] && echo set || echo no)" "$([ -n "$GIT_ASKPASS" ] && echo set || echo no)" >> ${shimLog}
		if [ -f ${join(root, "fetch-fixture")} ]; then
			dir=
			prev=
			for arg in "$@"; do
				if [ "$prev" = -C ]; then dir="$arg"; fi
				prev="$arg"
			done
			exec ${realGit} -c protocol.file.allow=always -C "$dir" fetch --quiet "$(cat ${join(root, "fetch-fixture")})" "$prev"
		fi
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
	writeFileSync(join(shimDir, "origin"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(shimDir, "origin"), 0o700);
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

	test("Origin inventory holds open and draft PRs without trusting repository configuration", () => {
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
		writeFileSync(join(shimDir, "origin"), `#!/bin/sh
printf '%s\\n' "$PWD" > ${join(root, "origin-query-cwd")}
echo '[{"number":21,"status":"draft","headRef":"feature-clean"},{"number":22,"status":"open","headRef":"feature-recent"},{"number":23,"status":"closed","headRef":"feature-wip"}]'
`);
		chmodSync(join(shimDir, "origin"), 0o700);
		setGhShim("exit 1");
		try {
			const { rows } = runAuditWithCanaries({ GH_HOST: "attacker.example", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "false" });
			const clean = rows.find((row) => row.worktree === cleanWt)!;
			expect(clean.pr).toBe("#21/DRAFT");
			expect(clean.bucket).toBe("hold-open-pr");
			expect(rows.find((row) => row.worktree === recentWt)!.bucket).toBe("hold-open-pr");
			expect(rows.find((row) => row.worktree === wipWt)!.bucket).toBe("hold-wip");
			const queryCwd = readFileSync(join(root, "origin-query-cwd"), "utf8").trim();
			expect(queryCwd).toMatch(/^\/tmp\/pstack-audit-env-[^/]+\/origin-query$/);
			expect(existsSync(queryCwd)).toBe(false);
		} finally {
			writeFileSync(join(shimDir, "origin"), "#!/bin/sh\nexit 1\n");
			setGhShim('echo "[]"');
			git(["remote", "set-url", "origin", join(root, "origin-fixture")]);
		}
	});

	test("failed Origin falls back to gh, while malformed successful Origin stays unknown", () => {
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
		setGhShim(`echo '[{"number":24,"state":"OPEN","headRefName":"feature-clean"}]'`);
		try {
			const fallback = runAuditWithCanaries({});
			expect(fallback.rows.find((row) => row.worktree === cleanWt)!.pr).toBe("#24/OPEN");
			expect(fallback.rows.find((row) => row.worktree === cleanWt)!.bucket).toBe("hold-open-pr");
			for (const output of ['{oops', '{}', '[{"number":25,"status":"unknown","headRef":"feature-clean"}]']) {
				writeFileSync(join(shimDir, "origin"), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
				const malformed = runAuditWithCanaries({});
				expect(malformed.rows.find((row) => row.worktree === cleanWt)!.pr).toBe("unknown");
				expect(malformed.rows.find((row) => row.worktree === cleanWt)!.bucket).toBe("review");
			}
		} finally {
			writeFileSync(join(shimDir, "origin"), "#!/bin/sh\nexit 1\n");
			setGhShim('echo "[]"');
			git(["remote", "set-url", "origin", join(root, "origin-fixture")]);
		}
	});

	test("gh failure, malformed output and signal termination render PR inventory unknown and never safe", () => {
		git(["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
		const cases: Array<[string, string]> = [
			["exit 1", "exit 1"],
			["non-array JSON", "echo '{\"oops\": true}'"],
			["malformed JSON", "echo '{oops'"],
			["signal termination", "kill -TERM $$"],
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
				expect(warnings.join("\n")).toContain("forge PR inventory unavailable");
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

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function auditFixture(branch: string): { repo: string; worktree: string } {
	const directory = mkdtempSync(join(root, "base-case-"));
	const fixtureRepo = join(directory, "repo");
	const worktree = join(directory, "worktree");
	mkdirSync(fixtureRepo);
	git(["init", "-q", "-b", branch], fixtureRepo);
	git(["config", "user.email", "t@t"], fixtureRepo);
	git(["config", "user.name", "t"], fixtureRepo);
	writeFileSync(join(fixtureRepo, "f"), "one\n");
	git(["add", "f"], fixtureRepo);
	git(["commit", "-qm", "init"], fixtureRepo);
	git(["worktree", "add", "-q", "-b", "feature", worktree], fixtureRepo);
	return { repo: fixtureRepo, worktree };
}

function repositoryBytes(directory: string): Array<[string, string]> {
	return Array.from(new Bun.Glob("**/*").scanSync({ cwd: directory, dot: true, onlyFiles: true }))
		.sort().map((path): [string, string] => [path, readFileSync(join(directory, path)).toString("base64")]);
}

function runAuditCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
	const before = repositoryBytes(cwd);
	const worktree = join(cwd, "..", "worktree");
	const worktreeBefore = existsSync(worktree) ? repositoryBytes(worktree) : undefined;
	const child = Bun.spawnSync([process.execPath, CLI, "worktree-audit", ...args], {
		cwd,
		env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, PSTACK_SESSIONS_DIR: sessions, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10_000,
	});
	expect(repositoryBytes(cwd)).toEqual(before);
	if (worktreeBefore) expect(repositoryBytes(worktree)).toEqual(worktreeBefore);
	return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function worktreeColumns(stdout: string, worktree: string): string[] {
	const lines = stdout.trim().split("\n");
	expect(lines.filter((line) => line.endsWith(`\t${worktree}`))).toHaveLength(1);
	return lines.find((line) => line.endsWith(`\t${worktree}`))!.split("\t");
}

describe("worktree-audit CLI base selection", () => {
	test("main and master fallback select only existing refs", () => {
		for (const branch of ["main", "master"]) {
			const fixture = auditFixture(branch);
			git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"], fixture.repo);
			const result = runAuditCli([fixture.repo], fixture.repo);
			expect(result.code).toBe(0);
			expect(result.stdout.split("\n")[0]).toBe(`BASE\torigin/${branch}`);
			expect(result.stderr).toContain(`could not fetch origin/${branch}`);
			expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe("YES");
		}
	});

	test("origin HEAD selects a custom default before main", () => {
		const fixture = auditFixture("release/stable");
		git(["update-ref", "refs/remotes/origin/release/stable", "HEAD"], fixture.repo);
		git(["update-ref", "refs/remotes/origin/main", "HEAD"], fixture.repo);
		git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/stable"], fixture.repo);
		const result = runAuditCli([], fixture.repo);
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n")[0]).toBe("BASE\torigin/release/stable");
		expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe("YES");
	});

	test("explicit base flags and local commit-ish refs reach the real CLI", () => {
		const fixture = auditFixture("topic");
		const initial = git(["rev-parse", "HEAD"], fixture.repo).trim();
		writeFileSync(join(fixture.worktree, "f"), "two\n");
		git(["commit", "-qam", "feature"], fixture.worktree);
		git(["branch", "selected", "feature"], fixture.repo);
		git(["update-ref", "refs/remotes/origin/selected", "feature"], fixture.repo);
		for (const [flag, base, merged] of [
			["-b", "selected", "YES"],
			["--base", "refs/heads/selected", "YES"],
			["-b", "refs/remotes/origin/selected", "YES"],
			["--base", initial, "no"],
			["-b", "selected~1", "no"],
		]) {
			const result = runAuditCli([fixture.repo, flag, base], fixture.repo);
			expect(result.code).toBe(0);
			expect(result.stdout.split("\n")[0]).toBe(`BASE\t${base}`);
			expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe(merged);
		}
	}, 20_000);

	test("unknown implicit base stays unknown and cannot be safe", () => {
		const fixture = auditFixture("topic");
		const result = runAuditCli([fixture.repo], fixture.repo);
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n")[0]).toBe("BASE\tunknown");
		const row = worktreeColumns(result.stdout, fixture.worktree);
		expect(row[2]).toBe("unknown");
		expect(row[7]).toBe("review");
		expect(result.stderr).toContain("base is unknown");
	});

	for (const args of [
		["-b"], ["--base", "--help"], ["--wat"], ["-b", "missing"],
		["--base", "origin/bad..ref"], ["-b", "topic\nHEAD"],
		["-b", "topic", "--base", "topic"],
	]) {
		test(`invalid arguments ${JSON.stringify(args)} fail without a report`, () => {
			const fixture = auditFixture("topic");
			const result = runAuditCli(args, fixture.repo);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
		});
	}

	test("multiple repository paths fail without a report", () => {
		const fixture = auditFixture("topic");
		const result = runAuditCli([fixture.repo, fixture.repo], fixture.repo);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
	});

	test("a non-repository fails without a report", () => {
		const nonRepo = mkdtempSync(join(root, "non-repo-"));
		const result = runAuditCli([nonRepo], nonRepo);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
	});

	test("help forwards through pstack without repository or network access", () => {
		const directory = mkdtempSync(join(root, "help-"));
		for (const flag of ["-h", "--help"]) {
			rmSync(shimLog, { force: true });
			const result = runAuditCli([flag], directory);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("--base <ref>");
			expect(result.stderr).toBe("");
			expect(logLines()).toEqual([]);
		}
	});

	test("canonical symref discovery fetches a custom default without mutating the audited repo", () => {
		const fixture = auditFixture("release/stable");
		git(["remote", "add", "origin", "https://github.com/octo/repo.git"], fixture.repo);
		writeFileSync(join(root, "remote-head"), "ref: refs/heads/release/stable\tHEAD\n");
		writeFileSync(join(root, "fetch-fixture"), fixture.repo);
		rmSync(shimLog, { force: true });
		try {
			const result = runAuditCli([fixture.repo], fixture.repo);
			expect(result.code).toBe(0);
			expect(result.stdout.split("\n")[0]).toBe("BASE\torigin/release/stable");
			expect(result.stderr).toBe("");
			expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe("YES");
			const discovery = logLines().find((line) => line.includes(" ls-remote "));
			expect(discovery).toContain("--symref --upload-pack=git-upload-pack https://github.com/octo/repo HEAD");
			expect(discovery).toContain("protocol.allow=never");
			expect(discovery).toContain("protocol.https.allow=always");
			expect(fetchArgLines()).toHaveLength(1);
			expect(fetchArgLines()[0]).toEndWith("refs/heads/release/stable");
		} finally {
			rmSync(join(root, "remote-head"), { force: true });
			rmSync(join(root, "fetch-fixture"), { force: true });
		}
	});

	test("fresh selected remote tip overrides stale local ancestry", () => {
		const fixture = auditFixture("main");
		git(["update-ref", "refs/remotes/origin/main", "HEAD"], fixture.repo);
		writeFileSync(join(fixture.worktree, "f"), "two\n");
		git(["commit", "-qam", "new tip"], fixture.worktree);
		git(["update-ref", "refs/heads/main", "feature"], fixture.repo);
		git(["remote", "add", "origin", "https://github.com/octo/repo.git"], fixture.repo);
		writeFileSync(join(root, "fetch-fixture"), fixture.repo);
		try {
			const result = runAuditCli(["-b", "origin/main", fixture.repo], fixture.repo);
			expect(result.code).toBe(0);
			expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe("YES");
			expect(result.stderr).toBe("");
		} finally {
			rmSync(join(root, "fetch-fixture"), { force: true });
		}
		const stale = runAuditCli(["--base", "origin/main", fixture.repo], fixture.repo);
		expect(stale.code).toBe(0);
		expect(worktreeColumns(stale.stdout, fixture.worktree)[2]).toBe("no");
		expect(stale.stderr).toContain("merged column may be stale");
	});

	test.each(["refs/tags/topic", "refs/heads/bad..ref", "refs/heads/bad name"])("invalid canonical branch %s never reaches fetch or merge-safe output", (ref) => {
		const fixture = auditFixture("topic");
		git(["remote", "add", "origin", "https://github.com/octo/repo.git"], fixture.repo);
		try {
			writeFileSync(join(root, "remote-head"), `ref: ${ref}\tHEAD\n`);
			rmSync(shimLog, { force: true });
			const result = runAuditCli([fixture.repo], fixture.repo);
			expect(result.code).toBe(0);
			expect(result.stdout.split("\n")[0]).toBe("BASE\tunknown");
			expect(worktreeColumns(result.stdout, fixture.worktree)[7]).toBe("review");
			expect(fetchArgLines()).toHaveLength(0);
		} finally {
			rmSync(join(root, "remote-head"), { force: true });
		}
	});

	test("user config cannot supply a remote or redirect default branch discovery", () => {
		const fixture = auditFixture("main");
		const home = join(root, "global-only-origin");
		const xdg = join(root, "global-only-xdg");
		mkdirSync(home);
		mkdirSync(join(xdg, "git"), { recursive: true });
		const config = '[remote "origin"]\n\turl = https://github.com/attacker/redirect.git\n';
		writeFileSync(join(home, ".gitconfig"), config);
		writeFileSync(join(xdg, "git", "config"), config);
		rmSync(shimLog, { force: true });
		const result = runAuditCli([fixture.repo], fixture.repo, { HOME: home, XDG_CONFIG_HOME: xdg });
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n")[0]).toBe("BASE\tmain");
		expect(worktreeColumns(result.stdout, fixture.worktree)[2]).toBe("YES");
		expect(fetchArgLines()).toHaveLength(0);
		expect(logLines().some((line) => line.includes(" ls-remote ") || line.startsWith("GH ARGS:"))).toBe(false);
	});

	test("native session resolver honors the active profile without a test override", () => {
		const fixture = auditFixture("main");
		const profile = join(root, "native-profile");
		const storage = join(profile, "sessions", "fixture");
		mkdirSync(storage, { recursive: true });
		writeFileSync(join(storage, "recent.jsonl"), JSON.stringify({ cwd: fixture.worktree }));
		const before = repositoryBytes(fixture.repo);
		const child = Bun.spawnSync([process.execPath, CLI, "worktree-audit", "-b", "main", fixture.repo], {
			cwd: fixture.repo,
			env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: profile, PI_PROFILE: undefined, PSTACK_SESSIONS_DIR: undefined },
			stdout: "pipe", stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		const row = worktreeColumns(child.stdout.toString(), fixture.worktree);
		expect(row[6]).not.toBe("-");
		expect(row[7]).toBe("verify-recent-chat");
		expect(repositoryBytes(fixture.repo)).toEqual(before);
	});
});
