#!/usr/bin/env bun
// Read-only worktree prune audit (OMP port of upstream worktree-audit.sh).
// Classifies every git worktree by size, merge state, uncommitted work,
// remote/PR state, and the most recent OMP chat that operated in it. Emits a
// tab-separated table sorted by size with a suggested bucket. Never deletes
// anything and never writes into the audited repository; deletion stays a
// human-gated step in the playbook.
// Usage: worktree-audit.ts [repo-path]   (defaults to the current repo)
//
// Recent-chat source is OMP session storage (~/.omp/agent/sessions, override
// with PSTACK_SESSIONS_DIR for tests). A chat counts for a worktree when its
// session file references the worktree path followed by "/" or a quote, so
// glint-482 does not match glint-482-r37.
//
// Hostile-repository isolation: every Git invocation runs with default-deny
// transports, a scrubbed environment and an empty scratch HOME, and
// origin/main is refreshed by fetching the canonical GitHub HTTPS URL inside
// a throwaway repository with a pinned upload-pack — the audited repo's
// remote configuration (named remotes, uploadpack overrides, insteadOf
// rewrites, local/ext transports) is never consulted, so nothing planted
// there can execute or redirect the fetch.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface PrRecord {
	number: number;
	state: string;
	headRefName: string;
}

export interface AuditRow {
	readonly size: string;
	readonly age: string;
	readonly merged: "YES" | "no";
	readonly dirty: string;
	readonly remote: string;
	readonly pr: string;
	readonly lastChat: string;
	readonly bucket: string;
	readonly worktree: string;
	/** Sort key: size in bytes, -1 when unknown (sorts last, like sort -rh). */
	readonly sizeBytes: number;
}

export interface AuditOptions {
	readonly repo: string;
	readonly sessionsDir?: string;
	readonly now?: number;
}

export interface AuditReport {
	readonly rows: readonly AuditRow[];
	readonly warnings: readonly string[];
}

const DAY_MS = 86_400_000;
const RECENT_CHAT_DAYS = 4;

/**
 * Command-scoped Git protections against hostile repository-local config:
 * no fsmonitor helper, no hooks path (ref updates would otherwise invoke the
 * reference-transaction hook), credential helpers cleared (the empty value
 * resets the helper list, so system/global/local helpers never run), no
 * askpass program, ssh pinned to plain ssh, and every transport
 * default-denied — `protocol.allow=never` covers ext::, git://, file:// and
 * ssh in one entry; none of the audit's read-only plumbing fetches anything.
 * The audit runs only plumbing (status, rev-parse, log, merge-base,
 * show-ref, rev-list, config, worktree, update-ref), so diff external
 * drivers, clean/smudge filters and hooks have no triggering command.
 */
const AUDIT_GIT_ARGS = [
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "credential.helper=",
	"-c", "core.askPass=",
	"-c", "core.sshCommand=ssh",
	"-c", "protocol.allow=never",
];

/**
 * Fetch hardening: the read commands' protections plus exactly one re-allowed
 * transport (https) and a pinned remote-side program, applied inside the
 * throwaway scratch repository only.
 */
const FETCH_GIT_ARGS = [...AUDIT_GIT_ARGS, "-c", "protocol.https.allow=always"];

/**
 * Environment for Git: everything outside a small allowlist is dropped —
 * all ambient GIT_* injection (GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n), and with
 * it GIT_SSH_COMMAND, GIT_ASKPASS, GIT_PROXY_COMMAND and GIT_TRACE targets —
 * plus every GH_x/GITHUB_x credential (Git's https transport never sees
 * tokens; anonymous github.com fetches need none) and every XDG override.
 * System/global config is nulled and HOME points at an empty scratch
 * directory, so neither ambient nor user config can execute a helper, reach
 * a credential store, or redirect an operation.
 */
function gitEnv(scratchHome: string): Record<string, string> {
	const out: Record<string, string> = {
		NO_COLOR: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		// Never take optional locks (opportunistic index refreshes) in any
		// target repository: the audit must not write — not even a stat-cache
		// index update — so the target index's mtime/bytes stay untouched.
		GIT_OPTIONAL_LOCKS: "0",
		HOME: scratchHome,
	};
	for (const key of [
		"PATH", "LANG", "LC_ALL", "TERM",
		"SSL_CERT_FILE", "SSL_CERT_DIR",
		"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
	]) {
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * Environment for gh: PATH/locale/TLS/proxy basics plus gh's own token
 * variables and nothing else. GH_HOST is never inherited (it would redirect
 * every query and its token to an arbitrary host) and GH_ENTERPRISE_TOKEN
 * only applies to enterprise hosts, which are never queried — only canonical
 * github.com identities are. HOME is the empty scratch dir, so no user gh
 * config or hosts file applies and gh's own cache writes stay in the scratch.
 */
function ghEnv(scratchHome: string): Record<string, string> {
	const out: Record<string, string> = { NO_COLOR: "1", HOME: scratchHome };
	for (const key of [
		"PATH", "LANG", "LC_ALL", "TERM",
		"SSL_CERT_FILE", "SSL_CERT_DIR",
		"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
		"GH_TOKEN", "GITHUB_TOKEN",
	]) {
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function git(args: string[], cwd: string, env: Record<string, string>): { code: number; stdout: string } {
	const result = Bun.spawnSync(["git", ...AUDIT_GIT_ARGS, ...args], { cwd, env, stdout: "pipe", stderr: "ignore" });
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
}

function humanSize(kib: number): string {
	const bytes = kib * 1024;
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
	return `${Math.max(1, bytes / 1024).toFixed(1)}K`;
}

function listWorktrees(repo: string, env: Record<string, string>): string[] {
	// Null-delimited so worktree paths containing spaces survive parsing.
	const { code, stdout } = git(["worktree", "list", "--porcelain", "-z"], repo, env);
	if (code !== 0) return [];
	return stdout
		.split("\0")
		.filter((record) => record.startsWith("worktree "))
		.map((record) => record.slice("worktree ".length).split("\n")[0])
		.filter(Boolean);
}

/** RAW remote.origin.url; `git config --get` never applies insteadOf rewrites. */
function remoteOriginUrl(repo: string, env: Record<string, string>): string | undefined {
	const { code, stdout } = git(["config", "--get", "remote.origin.url"], repo, env);
	if (code !== 0) return undefined;
	const url = stdout.trim();
	return url || undefined;
}

/**
 * Canonical github.com identity only: HTTPS `https://github.com/owner/repo`
 * or SCP `git@github.com:owner/repo` (optional .git). Every other form —
 * other hosts, enterprise or spoofed hosts, ssh:// URLs, userinfo, local
 * paths, ext:: — is refused, so it can never select a gh query target or a
 * fetch URL.
 */
export function parseGithubSlug(url: string): string | undefined {
	const https = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
	if (https) return `${https[1]}/${https[2]}`;
	const scp = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
	if (scp) return `${scp[1]}/${scp[2]}`;
	return undefined;
}

/**
 * PR inventory for the canonical slug. Returns the record list, or null when
 * the inventory is UNKNOWN: gh failed, timed out, or returned a malformed or
 * non-array response. Unknown is never an empty list — an empty inventory is
 * only ever the result of a successful gh query, so a worktree can never be
 * classified safe/prunable on missing evidence.
 */
function fetchPrs(repo: string, gitE: Record<string, string>, ghE: Record<string, string>, scratch: string): PrRecord[] | null {
	// Explicit validated repo identity: gh never resolves the audited repo's
	// remotes (or follows their rewrites) itself, and it runs in the scratch
	// dir, not the audited repo, so nothing hostile is in its working
	// context. A remote whose URL is not a canonical github.com owner/repo
	// yields no gh query at all: no GitHub identity means no PR inventory to
	// consult, and the audit degrades exactly as before.
	const url = remoteOriginUrl(repo, gitE);
	const slug = url ? parseGithubSlug(url) : undefined;
	if (!slug) return [];
	const result = Bun.spawnSync(
		["gh", "pr", "list", "--repo", slug, "--author", "@me", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName"],
		{ cwd: scratch, env: ghE, stdout: "pipe", stderr: "ignore", timeout: 60_000 },
	);
	if ((result.exitCode ?? 1) !== 0) return null; // failure or timeout: inventory unknown
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout.toString());
	} catch {
		return null; // malformed JSON: inventory unknown
	}
	if (!Array.isArray(parsed)) return null; // non-array response: inventory unknown
	const prs: PrRecord[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) return null;
		const { number, state, headRefName } = entry as Record<string, unknown>;
		if (typeof number !== "number" || !Number.isFinite(number)) return null;
		if (typeof state !== "string" || typeof headRefName !== "string") return null;
		prs.push({ number, state, headRefName });
	}
	return prs;
}

/**
 * Fetch main from the canonical GitHub HTTPS URL inside a throwaway repo
 * with default-denied transports (only https re-allowed) and a fixed
 * upload-pack, in the scrubbed Git environment. The audited repository's
 * remote configuration is never read, and nothing planted there can execute
 * or redirect. Returns the fetched tip SHA (format-validated before it is
 * consumed by the alternates-based ancestry check) or undefined on any
 * failure. Bounded in time per network command.
 */
function fetchOriginMain(slug: string, scratch: string, env: Record<string, string>): string | undefined {
	const dir = join(scratch, "fetch");
	const init = Bun.spawnSync(["git", ...AUDIT_GIT_ARGS, "init", "-q", dir], { cwd: scratch, env, stdout: "ignore", stderr: "ignore" });
	if ((init.exitCode ?? 1) !== 0) return undefined;
	const fetch = Bun.spawnSync(
		["git", ...FETCH_GIT_ARGS, "-C", dir, "fetch", "--quiet", "--upload-pack=git-upload-pack", `https://github.com/${slug}`, "main"],
		{ cwd: scratch, env, stdout: "ignore", stderr: "ignore", timeout: 60_000 },
	);
	if ((fetch.exitCode ?? 1) !== 0) return undefined;
	const sha = Bun.spawnSync(["git", ...AUDIT_GIT_ARGS, "-C", dir, "rev-parse", "FETCH_HEAD"], { cwd: scratch, env, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
	return /^[0-9a-f]{40}$/.test(sha) || /^[0-9a-f]{64}$/.test(sha) ? sha : undefined;
}

/** Most recent OMP session mtime (ms) per worktree whose file references its path. */
function lastChatTimestamps(worktrees: string[], sessionsDir: string): Map<string, number> {
	const last = new Map(worktrees.map((wt) => [wt, 0]));
	const markers = worktrees.map((wt) => [`${wt}/`, `${wt}"`]);
	let files: string[];
	try {
		files = Array.from(new Bun.Glob("*/*.jsonl").scanSync({ cwd: sessionsDir }));
	} catch {
		return last;
	}
	const dated: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of files) {
		const path = `${sessionsDir}/${name}`;
		try {
			dated.push({ path, mtimeMs: statSync(path).mtimeMs });
		} catch {
			// Vanished between glob and stat; skip.
		}
	}
	// Newest first: once every worktree's newest match is newer than this file,
	// scanning older files cannot improve any column.
	dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { path, mtimeMs } of dated) {
		if (worktrees.every((wt) => (last.get(wt) ?? 0) >= mtimeMs)) continue;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue; // Unreadable session files are never evidence.
		}
		worktrees.forEach((wt, i) => {
			if (mtimeMs > (last.get(wt) ?? 0) && markers[i].some((marker) => text.includes(marker))) {
				last.set(wt, mtimeMs);
			}
		});
	}
	return last;
}

function localDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}

export function auditWorktrees(options: AuditOptions): AuditReport {
	const { repo } = options;
	const now = options.now ?? Date.now();
	const sessionsDir = options.sessionsDir ?? process.env.PSTACK_SESSIONS_DIR ?? `${homedir()}/.omp/agent/sessions`;
	// One scratch dir per audit: empty HOME for Git and gh, and the host of
	// the throwaway fetch repository. Everything inside is discarded.
	const scratch = mkdtempSync(join(tmpdir(), "pstack-audit-env-"));
	try {
		const gitE = gitEnv(scratch);
		const ghE = ghEnv(scratch);
		const warnings: string[] = [];

		// First entry is the main worktree; everything else is a candidate.
		const worktrees = listWorktrees(repo, gitE).slice(1);
		// Unknown inventory (null) is never an empty list: pr renders
		// "unknown" and no worktree can be classified safe/prunable on
		// missing evidence.
		const prs = fetchPrs(repo, gitE, ghE, scratch);
		if (prs === null) warnings.push("warn: gh PR inventory unavailable; PR column is unknown and no worktree is marked safe");
		const url = remoteOriginUrl(repo, gitE);
		const slug = url ? parseGithubSlug(url) : undefined;
		let mainTip = slug ? fetchOriginMain(slug, scratch, gitE) : undefined;
		let mergeCwd = repo;
		let mergeTarget = "origin/main";
		if (mainTip) {
			const objectsDir = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], repo, gitE).stdout.trim();
			try {
				if (objectsDir && !objectsDir.includes("\n")) {
					mkdirSync(join(scratch, "fetch", ".git", "objects", "info"), { recursive: true });
					writeFileSync(join(scratch, "fetch", ".git", "objects", "info", "alternates"), `${objectsDir}\n`);
					mergeCwd = join(scratch, "fetch");
					mergeTarget = mainTip;
				} else {
					mainTip = undefined;
				}
			} catch {
				mainTip = undefined;
			}
		}
		if (!mainTip) {
			warnings.push("warn: could not fetch origin/main; merged column may be stale");
		}

		const chats = lastChatTimestamps(worktrees, sessionsDir);
		const rows: AuditRow[] = worktrees.map((wt) => {
			const head = git(["-C", wt, "rev-parse", "HEAD"], repo, gitE).stdout.trim();
			const headTs = Number(git(["-C", wt, "log", "-1", "--format=%ct", "HEAD"], repo, gitE).stdout.trim()) * 1000;
			const age = headTs > 0 ? `${Math.floor((now - headTs) / DAY_MS)}d` : "?";

			// Squash-merged branches are not ancestors of main, so PR state is the
			// real signal; merge-base only catches fast-forward/rebase merges.
			const merged: AuditRow["merged"] = head && git(["merge-base", "--is-ancestor", head, mergeTarget], mergeCwd, gitE).code === 0 ? "YES" : "no";

			// Distinguish real WIP (tracked edits) from disposable untracked scratch.
			const entries = git(["-C", wt, "status", "--porcelain=v1", "-z"], repo, gitE).stdout.split("\0").filter(Boolean);
			const untracked = entries.filter((e) => e.startsWith("??")).length;
			const tracked = entries.length - untracked;
			const dirty = entries.length === 0 ? "clean" : tracked > 0 ? `wip:${tracked}` : `scratch:${untracked}`;

			const branch = git(["-C", wt, "symbolic-ref", "--quiet", "--short", "HEAD"], repo, gitE).stdout.trim();
			let remote: string;
			if (!branch) {
				remote = "detached";
			} else if (git(["-C", wt, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repo, gitE).code === 0) {
				if (head && git(["-C", wt, "rev-parse", `origin/${branch}`], repo, gitE).stdout.trim() === head) {
					remote = "pushed";
				} else {
					remote = `ahead${git(["-C", wt, "rev-list", "--count", `origin/${branch}..HEAD`], repo, gitE).stdout.trim()}`;
				}
			} else {
				remote = "no-remote";
			}


			const match = branch && prs !== null ? prs.find((pr) => pr.headRefName === branch) : undefined;
			const pr = match ? `#${match.number}/${match.state}` : prs === null ? "unknown" : "-";

			const chat = chats.get(wt) ?? 0;
			const lastChat = chat > 0 ? localDate(chat) : "-";
			const recent = chat > 0 && (now - chat) / DAY_MS <= RECENT_CHAT_DAYS;

			let bucket: string;
			if (dirty.startsWith("wip:")) bucket = "hold-wip";
			else if (pr.includes("OPEN")) bucket = "hold-open-pr";
			else if (recent) bucket = "verify-recent-chat";
			// Unknown PR inventory can never be safe/prunable: the human reviews.
			else if (pr === "unknown") bucket = "review";
			else if (merged === "YES" || pr !== "-") bucket = "safe";
			else bucket = "review";

			// ponytail: du runs with ambient env — no git semantics, nothing to leak.
			const du = Bun.spawnSync(["du", "-sk", wt], { stdout: "pipe", stderr: "ignore" });
			const kib = (du.exitCode ?? 1) === 0 ? Number(du.stdout.toString().split("\t")[0]) : NaN;
			const sizeBytes = Number.isFinite(kib) ? kib * 1024 : -1;

			return {
				size: Number.isFinite(kib) ? humanSize(kib) : "?",
				age,
				merged,
				dirty,
				remote,
				pr,
				lastChat,
				bucket,
				worktree: wt,
				sizeBytes,
			};
		});

		rows.sort((a, b) => b.sizeBytes - a.sizeBytes);
		return { rows, warnings };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export const HEADER = "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE";

export function formatRow(row: AuditRow): string {
	return [row.size, row.age, row.merged, row.dirty, row.remote, row.pr, row.lastChat, row.bucket, row.worktree].join("\t");
}

if (import.meta.main) {
	const repoArg = process.argv[2];
	const scratch = mkdtempSync(join(tmpdir(), "pstack-audit-env-"));
	try {
		const repo =
			repoArg ||
			Bun.spawnSync(["git", ...AUDIT_GIT_ARGS, "rev-parse", "--show-toplevel"], { env: gitEnv(scratch), stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
		if (!repo) {
			console.error("not in a git repo; pass a repo path");
			process.exit(1);
		}
		const { rows, warnings } = auditWorktrees({ repo });
		console.log(HEADER);
		for (const row of rows) console.log(formatRow(row));
		for (const warning of warnings) console.error(warning);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
