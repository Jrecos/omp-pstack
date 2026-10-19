#!/usr/bin/env bun
// Read-only worktree prune audit (OMP port of upstream worktree-audit.sh).
// Classifies every git worktree by size, merge state, uncommitted work,
// remote/PR state, and the most recent OMP chat that operated in it. Emits a
// tab-separated table sorted by size with a suggested bucket. Never deletes
// anything and never writes into the audited repository; deletion stays a
// human-gated step in the playbook.
// Usage: worktree-audit.ts [-b <base-ref>] [repo-path]
//
// Recent-chat source is native OMP session storage, overridden by
// PSTACK_SESSIONS_DIR for tests. A chat counts for a worktree when its
// session file references the worktree path followed by "/" or a quote, so
// glint-482 does not match glint-482-r37.
//
// Hostile-repository isolation: every Git invocation runs with default-deny
// transports, a scrubbed environment and an empty scratch HOME, and
// the selected remote base is refreshed from canonical GitHub HTTPS inside
// a throwaway repository with a pinned upload-pack. The audited repo's
// remote configuration (named remotes, uploadpack overrides, insteadOf
// rewrites, local/ext transports) is never consulted, so nothing planted
// there can execute or redirect the fetch.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

export interface PrRecord {
	number: number;
	state: string;
	headRefName: string;
}

export interface AuditRow {
	readonly size: string;
	readonly age: string;
	readonly merged: "YES" | "no" | "unknown";
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
	readonly base?: string;
	readonly sessionsDir?: string;
	readonly now?: number;
}

export interface AuditReport {
	readonly base: string | null;
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

/** Unknown inventory is never an empty successful query. */
function fetchPrs(repo: string, gitE: Record<string, string>, ghE: Record<string, string>, scratch: string): PrRecord[] | null {
	const url = remoteOriginUrl(repo, gitE);
	const slug = url ? parseGithubSlug(url) : undefined;
	if (!slug) return [];
	const originRepo = join(scratch, "origin-query");
	mkdirSync(originRepo);
	const originReady = git(["init", "-q"], originRepo, gitE).code === 0
		&& git(["config", "remote.origin.url", `https://github.com/${slug}.git`], originRepo, gitE).code === 0;
	const queries = [
		{ command: "origin", fields: "number,status,headRef", stateField: "status", headField: "headRef", args: [], cwd: originRepo },
		{ command: "gh", fields: "number,state,headRefName", stateField: "state", headField: "headRefName", args: ["--repo", slug], cwd: scratch },
	];
	for (const query of queries) {
		if (query.command === "origin" && !originReady) continue;
		if (!Bun.which(query.command, { PATH: ghE.PATH })) continue;
		const result = Bun.spawnSync(
			[query.command, "pr", "list", ...query.args, "--author", "@me", "--state", "all", "--limit", "1000", "--json", query.fields],
			{ cwd: query.cwd, env: { ...gitE, ...ghE }, stdout: "pipe", stderr: "ignore", timeout: 60_000 },
		);
		if ((result.exitCode ?? 1) !== 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout.toString());
		} catch {
			return null;
		}
		if (!Array.isArray(parsed)) return null;
		const prs: PrRecord[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null) return null;
			const row = entry as Record<string, unknown>;
			const number = row.number;
			const state = row[query.stateField];
			const headRefName = row[query.headField];
			if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
			if (typeof state !== "string" || typeof headRefName !== "string" || !headRefName) return null;
			const normalized = state.toUpperCase();
			if (!["OPEN", "DRAFT", "MERGED", "CLOSED"].includes(normalized)) return null;
			prs.push({ number, state: normalized, headRefName });
		}
		return prs;
	}
	return null;
}

type SelectedBase = { name: string; tip: string | undefined; remoteRef: string | undefined };

function commitTip(ref: string, repo: string, env: Record<string, string>): string | undefined {
	const result = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo, env);
	const sha = result.stdout.trim();
	return result.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : undefined;
}

function validBranch(ref: string, repo: string, env: Record<string, string>): boolean {
	return ref.startsWith("refs/heads/") && git(["check-ref-format", ref], repo, env).code === 0;
}

function selectBase(explicit: string | undefined, repo: string, slug: string | undefined, scratch: string, env: Record<string, string>): SelectedBase | undefined {
	const dir = join(scratch, "fetch");
	if (slug) git(["init", "-q", dir], scratch, env);
	const originHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo, env).stdout.trim();
	let name = explicit;
	if (explicit !== undefined && (!explicit || explicit.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(explicit))) {
		throw new Error(`invalid base ref ${JSON.stringify(explicit)}`);
	}
	if (!name || name === "origin/HEAD" || name === "refs/remotes/origin/HEAD") {
		if (originHead.startsWith("refs/remotes/origin/") && validBranch(`refs/heads/${originHead.slice("refs/remotes/origin/".length)}`, repo, env)) {
			name = originHead.replace("refs/remotes/", "");
		} else if (slug) {
			const result = Bun.spawnSync(
				["git", ...FETCH_GIT_ARGS, "-C", dir, "ls-remote", "--symref", "--upload-pack=git-upload-pack", `https://github.com/${slug}`, "HEAD"],
				{ cwd: scratch, env, stdout: "pipe", stderr: "ignore", timeout: 60_000 },
			);
			const ref = result.exitCode === 0 ? /^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/m.exec(result.stdout.toString())?.[1] : undefined;
			if (ref && validBranch(ref, repo, env)) name = `origin/${ref.slice("refs/heads/".length)}`;
		}
		if (!name && explicit === undefined) {
			name = ["origin/main", "origin/master", "main", "master"].find((ref) => commitTip(ref, repo, env));
		}
	}
	if (!name) return undefined;
	const remoteBranch = name.startsWith("refs/remotes/origin/") ? name.slice("refs/remotes/origin/".length)
		: name.startsWith("origin/") ? name.slice("origin/".length) : undefined;
	const remoteRef = remoteBranch === undefined ? undefined : `refs/heads/${remoteBranch}`;
	if (remoteRef && !validBranch(remoteRef, repo, env)) throw new Error(`invalid base ref ${JSON.stringify(name)}`);
	const tip = commitTip(name, repo, env);
	if (!tip && !(remoteRef && slug)) {
		if (explicit !== undefined) throw new Error(`cannot resolve base ref ${JSON.stringify(explicit)}`);
		return undefined;
	}
	return { name, tip, remoteRef };
}

function fetchBase(slug: string, ref: string, scratch: string, env: Record<string, string>): string | undefined {
	const dir = join(scratch, "fetch");
	const fetch = Bun.spawnSync(
		["git", ...FETCH_GIT_ARGS, "-C", dir, "fetch", "--quiet", "--upload-pack=git-upload-pack", `https://github.com/${slug}`, ref],
		{ cwd: scratch, env, stdout: "ignore", stderr: "ignore", timeout: 60_000 },
	);
	return fetch.exitCode === 0 ? commitTip("FETCH_HEAD", dir, env) : undefined;
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
	const sessionsDir = options.sessionsDir ?? process.env.PSTACK_SESSIONS_DIR ?? getSessionsDir();
	// One scratch dir per audit: empty HOME for Git and gh, and the host of
	// the throwaway fetch repository. Everything inside is discarded.
	const scratch = mkdtempSync(join(tmpdir(), "pstack-audit-env-"));
	try {
		const gitE = gitEnv(scratch);
		const ghE = ghEnv(scratch);
		const warnings: string[] = [];
		if (git(["rev-parse", "--git-dir"], repo, gitE).code !== 0) throw new Error("not in a git repo; pass a repo path");

		// First entry is the main worktree; everything else is a candidate.
		const worktrees = listWorktrees(repo, gitE).slice(1);
		// Unknown inventory (null) is never an empty list: pr renders
		// "unknown" and no worktree can be classified safe/prunable on
		// missing evidence.
		const prs = fetchPrs(repo, gitE, ghE, scratch);
		if (prs === null) warnings.push("warn: forge PR inventory unavailable; PR column is unknown and no worktree is marked safe");
		const url = remoteOriginUrl(repo, gitE);
		const slug = url ? parseGithubSlug(url) : undefined;
		const selected = selectBase(options.base, repo, slug, scratch, gitE);
		let fetchedTip = selected?.remoteRef && slug ? fetchBase(slug, selected.remoteRef, scratch, gitE) : undefined;
		let mergeCwd = repo;
		let mergeTarget = selected?.tip;
		if (fetchedTip) {
			const objectsDir = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], repo, gitE).stdout.trim();
			try {
				if (objectsDir && !objectsDir.includes("\n")) {
					mkdirSync(join(scratch, "fetch", ".git", "objects", "info"), { recursive: true });
					writeFileSync(join(scratch, "fetch", ".git", "objects", "info", "alternates"), `${objectsDir}\n`);
					mergeCwd = join(scratch, "fetch");
					mergeTarget = fetchedTip;
				} else {
					fetchedTip = undefined;
				}
			} catch {
				fetchedTip = undefined;
			}
		}
		if (!selected) {
			warnings.push("warn: base is unknown; no worktree is marked merge-safe");
		} else if (selected.remoteRef && !fetchedTip) {
			warnings.push(`warn: could not fetch ${selected.name}; merged column ${mergeTarget ? "may be stale" : "is unknown"}`);
		}
		if (options.base !== undefined && !mergeTarget) throw new Error(`cannot resolve base ref ${JSON.stringify(options.base)}`);

		const chats = lastChatTimestamps(worktrees, sessionsDir);
		const rows: AuditRow[] = worktrees.map((wt) => {
			const head = git(["-C", wt, "rev-parse", "HEAD"], repo, gitE).stdout.trim();
			const headTs = Number(git(["-C", wt, "log", "-1", "--format=%ct", "HEAD"], repo, gitE).stdout.trim()) * 1000;
			const age = headTs > 0 ? `${Math.floor((now - headTs) / DAY_MS)}d` : "?";

			// PR state also covers squash merges, which ancestry cannot establish.
			const merged: AuditRow["merged"] = !mergeTarget ? "unknown"
				: head && git(["merge-base", "--is-ancestor", head, mergeTarget], mergeCwd, gitE).code === 0 ? "YES" : "no";

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
			else if (/\/(OPEN|DRAFT)$/.test(pr)) bucket = "hold-open-pr";
			else if (recent) bucket = "verify-recent-chat";
			// Unknown PR inventory can never be safe/prunable: the human reviews.
			else if (pr === "unknown" || merged === "unknown") bucket = "review";
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
		return { base: selected?.name ?? null, rows, warnings };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export const HEADER = "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE";

export function formatRow(row: AuditRow): string {
	return [row.size, row.age, row.merged, row.dirty, row.remote, row.pr, row.lastChat, row.bucket, row.worktree].join("\t");
}

if (import.meta.main) {
	const scratch = mkdtempSync(join(tmpdir(), "pstack-audit-env-"));
	try {
		let base: string | undefined;
		let repoArg: string | undefined;
		let help = false;
		const args = process.argv.slice(2);
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") {
				console.log("Usage: worktree-audit [-b <base-ref>] [repo-path]\n\n-b, --base <ref>  Compare against an explicit base ref.\n-h, --help        Show this help.\n\nDefault base uses origin/HEAD, canonical remote HEAD, then existing main/master refs.\nUnknown bases never authorize pruning. The audited repository is never modified.");
				help = true;
				break;
			}
			if (arg === "-b" || arg === "--base") {
				if (base !== undefined || !args[i + 1] || args[i + 1].startsWith("-")) throw new Error(`${arg} requires one base ref`);
				base = args[++i];
			} else if (arg === "--") {
				if (repoArg !== undefined || args.length !== i + 2) throw new Error("expected one repo path after --");
				repoArg = args[++i];
			} else if (arg.startsWith("-")) {
				throw new Error(`unknown option ${arg}`);
			} else {
				if (repoArg !== undefined) throw new Error("expected at most one repo path");
				repoArg = arg;
			}
		}
		if (!help) {
			const repo = repoArg || git(["rev-parse", "--show-toplevel"], process.cwd(), gitEnv(scratch)).stdout.trim();
			if (!repo) throw new Error("not in a git repo; pass a repo path");
			const { base: selectedBase, rows, warnings } = auditWorktrees({ repo, base });
			console.log(`BASE\t${selectedBase ?? "unknown"}`);
			console.log(HEADER);
			for (const row of rows) console.log(formatRow(row));
			for (const warning of warnings) console.error(warning);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
