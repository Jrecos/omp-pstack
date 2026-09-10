import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Bump = "major" | "minor" | "patch";

export interface MergedPullRequest {
	number: number;
	title: string;
	body: string;
	mergeCommitSha: string;
}

export interface ReleaseRecord {
	schema: "omp-pstack.release/1";
	version: string;
	tag: string;
	bump: Bump;
	pr: { number: number; title: string; mergeCommitSha: string };
	notes: string;
	createdAt: string;
}

const RECORD_SCHEMA = "omp-pstack.release/1";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
const VERSION_FIELD = /^([ \t]*"version"[ \t]*:[ \t]*)"([^"]*)"/m;
const BREAKING_TITLE = /^[A-Za-z][A-Za-z0-9-]*(?:\([^)\n]*\))?!:/;
const FEAT_TITLE = /^feat(?:\([^)\n]*\))?:/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_NUMBER = /^[1-9]\d*$/;
const RELEASE_BOT = {
	GIT_AUTHOR_NAME: "github-actions[bot]",
	GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
	GIT_COMMITTER_NAME: "github-actions[bot]",
	GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

interface GitOptions {
	env?: Record<string, string | undefined>;
	input?: string;
}

interface TagRelease {
	tag: string;
	commit: string;
	record: ReleaseRecord;
}

interface ReleaseScan {
	releases: TagRelease[];
	conflicts: string[];
}

export function classifyBump(pr: MergedPullRequest): Bump {
	if (BREAKING_TITLE.test(pr.title) || BREAKING_FOOTER.test(pr.body)) return "major";
	if (FEAT_TITLE.test(pr.title)) return "minor";
	return "patch";
}

export function nextVersion(latest: string | null, bump: Bump): string {
	if (latest === null) return "1.0.0";
	const match = SEMVER.exec(latest);
	if (!match) throw new Error(`${latest} is not a semantic version`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

export function latestVersion(versions: string[]): string | null {
	let latest: string | null = null;
	for (const version of versions) {
		if (latest === null || compareVersions(version, latest) > 0) latest = version;
	}
	return latest;
}

export function serializeReleaseRecord(record: ReleaseRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

export function parseReleaseRecord(text: string): ReleaseRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	if (source.schema !== RECORD_SCHEMA) return null;
	const bump = asBump(source.bump);
	const pr = source.pr;
	if (bump === null || typeof source.version !== "string" || typeof source.tag !== "string" || typeof source.notes !== "string" || typeof source.createdAt !== "string") return null;
	if (source.tag !== `v${source.version}` || !VERSION_TAG.test(source.tag)) return null;
	if (typeof pr !== "object" || pr === null || Array.isArray(pr)) return null;
	const identity = pr as Record<string, unknown>;
	const number = identity.number;
	if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
	if (typeof identity.title !== "string" || typeof identity.mergeCommitSha !== "string") return null;
	return {
		schema: RECORD_SCHEMA,
		version: source.version,
		tag: source.tag,
		bump,
		pr: { number, title: identity.title, mergeCommitSha: identity.mergeCommitSha },
		notes: source.notes,
		createdAt: source.createdAt,
	};
}

/** Rewrites only the top-level version, leaving the rest of the manifest byte-identical. */
export function withPackageVersion(manifest: string, version: string): string {
	if (!VERSION_FIELD.test(manifest)) throw new Error('package.json has no top-level "version" field');
	const updated = manifest.replace(VERSION_FIELD, `$1"${version}"`);
	const before = JSON.parse(manifest) as Record<string, unknown>;
	const after = JSON.parse(updated) as Record<string, unknown>;
	if (after.version !== version || JSON.stringify(after) !== JSON.stringify({ ...before, version })) {
		throw new Error("package.json rewrite changed more than the top-level version");
	}
	return updated;
}

export function runRelease(options: { cwd: string; repo: string; prNumber: number }): void {
	const { cwd, repo, prNumber } = options;
	const scratch = mkdtempSync(join(tmpdir(), "omp-pstack-release-"));
	try {
		assertOriginMatches(cwd, repo);
		// Read origin's release receipts without trusting or changing user-owned local tags.
		git(cwd, ["fetch", "--prune", "origin", "+refs/tags/*:refs/omp-pstack-release/tags/*", "main"]);
		const mainSha = git(cwd, ["rev-parse", "origin/main^{commit}"]);
		if (process.env.RELEASE_SHA && process.env.RELEASE_SHA !== mainSha) {
			throw new Error("main changed after verification; rerun the workflow to check the new commit before releasing");
		}
		const pr = fetchPullRequest(cwd, repo, prNumber);

		const scan = scanReleaseTags(cwd);
		if (scan.conflicts.length > 0) {
			throw new Error(`${scan.conflicts.join(", ")} are not managed release tags; delete or convert them before releasing`);
		}
		const recorded = scan.releases.filter(release => release.record.pr.number === prNumber);
		if (recorded.length > 1) {
			throw new Error(`multiple release records name pull request #${prNumber} (${recorded.map(release => release.tag).join(", ")})`);
		}
		for (const release of scan.releases) publishRelease(cwd, repo, release.record, scratch);
		if (recorded.length === 1) {
			console.log(`pull request #${prNumber} is already released as ${recorded[0]!.tag}; no version allocated`);
			return;
		}

		const previousVersion = latestVersion(scan.releases.map(release => release.record.version));
		const bump = classifyBump(pr);
		const version = nextVersion(previousVersion, bump);
		const tag = `v${version}`;
		const commit = createVersionCommit(cwd, mainSha, version, tag, pr, scratch);
		if (!isAncestor(cwd, pr.mergeCommitSha, commit)) {
			throw new Error(`merge commit ${pr.mergeCommitSha} of pull request #${prNumber} is not in the released history of main`);
		}
		const record: ReleaseRecord = {
			schema: RECORD_SCHEMA,
			version,
			tag,
			bump,
			pr: { number: pr.number, title: pr.title, mergeCommitSha: pr.mergeCommitSha },
			notes: releaseNotes(repo, tag, previousVersion, bump, pr),
			createdAt: new Date().toISOString(),
		};
		const tagObject = createTag(cwd, tag, commit, record);
		pushAtomically(cwd, tag, tagObject, commit, prNumber);
		publishRelease(cwd, repo, record, scratch);
		console.log(`released ${tag} for pull request #${prNumber}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function releaseNotes(repo: string, tag: string, previousVersion: string | null, bump: Bump, pr: MergedPullRequest): string {
	const lines = [pr.title, "", `${bump} release for #${pr.number} (merge commit ${pr.mergeCommitSha}).`];
	if (previousVersion !== null) lines.push("", `Full changelog: https://github.com/${repo}/compare/v${previousVersion}...${tag}`);
	return `${lines.join("\n")}\n`;
}

function createVersionCommit(cwd: string, mainSha: string, version: string, tag: string, pr: MergedPullRequest, scratch: string): string {
	const manifest = gitResult(cwd, ["show", `${mainSha}:package.json`]).stdout;
	const updated = withPackageVersion(manifest, version);
	const tree = updated === manifest ? git(cwd, ["rev-parse", `${mainSha}^{tree}`]) : writeManifestTree(cwd, mainSha, updated, scratch);
	const messageFile = join(scratch, "commit-message");
	writeFileSync(messageFile, [
		`chore(release): ${tag}`,
		"",
		`Cut from the merge of pull request #${pr.number} "${pr.title}" (${pr.mergeCommitSha}).`,
		"Snapshots main at release time, so it can carry changes merged after that pull request.",
		"",
	].join("\n"));
	const commit = git(cwd, ["commit-tree", tree, "-p", mainSha, "-F", messageFile], { env: RELEASE_BOT });
	const committed = JSON.parse(gitResult(cwd, ["show", `${commit}:package.json`]).stdout) as { version?: unknown };
	if (committed.version !== version) throw new Error(`package.json at ${tag} reads ${String(committed.version)}, expected ${version}`);
	return commit;
}

function writeManifestTree(cwd: string, mainSha: string, manifest: string, scratch: string): string {
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	git(cwd, ["read-tree", mainSha], { env });
	const blob = git(cwd, ["hash-object", "-w", "--stdin"], { env, input: manifest });
	git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},package.json`], { env });
	return git(cwd, ["write-tree"], { env });
}

function createTag(cwd: string, tag: string, commit: string, record: ReleaseRecord): string {
	const tagger = git(cwd, ["var", "GIT_COMMITTER_IDENT"], { env: RELEASE_BOT });
	return git(cwd, ["mktag"], {
		input: `object ${commit}\ntype commit\ntag ${tag}\ntagger ${tagger}\n\n${serializeReleaseRecord(record)}`,
	});
}

function pushAtomically(cwd: string, tag: string, tagObject: string, commit: string, prNumber: number): void {
	const result = run(["git", "push", "--atomic", "origin", `${commit}:refs/heads/main`, `${tagObject}:refs/tags/${tag}`], { cwd });
	if (result.status !== 0) {
		throw new Error(`git push --atomic was rejected (exit ${result.status}): ${firstLine(result.stderr || result.stdout)}\nMain moved while the release ran, so nothing was pushed. Re-run the release workflow for pull request #${prNumber} once main is stable.`);
	}
}

function publishRelease(cwd: string, repo: string, record: ReleaseRecord, scratch: string): void {
	const path = `repos/${repo}/releases/tags/${record.tag}`;
	if (ghApiExists(cwd, path)) {
		console.log(`release ${record.tag} is already published`);
		return;
	}
	if (git(cwd, ["ls-remote", "--tags", "origin", `refs/tags/${record.tag}`]) === "") {
		throw new Error(`tag ${record.tag} is not on origin; refusing to let GitHub mint it from the default branch`);
	}
	// `gh release create --latest` is a boolean flag, so the legacy ordering
	// that keeps an older repaired release from becoming latest is set on the
	// API request itself.
	const bodyFile = join(scratch, `release-${record.tag}.json`);
	writeFileSync(bodyFile, `${JSON.stringify({
		tag_name: record.tag,
		name: record.tag,
		body: record.notes,
		draft: false,
		prerelease: false,
		make_latest: "legacy",
	}, null, 2)}\n`);
	const result = run(["gh", "api", "--method", "POST", `repos/${repo}/releases`, "--input", bodyFile], { cwd });
	if (result.status !== 0) {
		throw new Error(`creating the release for ${record.tag} failed (exit ${result.status}): ${firstLine(result.stderr || result.stdout)}`);
	}
	console.log(`published release ${record.tag}`);
}

function scanReleaseTags(cwd: string): ReleaseScan {
	const releases: TagRelease[] = [];
	const conflicts: string[] = [];
	const prefix = "refs/omp-pstack-release/tags/";
	for (const line of git(cwd, ["for-each-ref", "--format=%(refname) %(objecttype) %(objectname)", "refs/omp-pstack-release/tags"]).split("\n")) {
		const [ref, objectType, oid] = line.trim().split(" ");
		if (!ref || !ref.startsWith(prefix) || !oid) continue;
		const tag = ref.slice(prefix.length);
		if (!VERSION_TAG.test(tag)) continue;
		if (objectType !== "tag") {
			conflicts.push(tag);
			continue;
		}
		const dump = gitResult(cwd, ["cat-file", "tag", oid]).stdout;
		const separator = dump.indexOf("\n\n");
		const record = parseReleaseRecord(separator === -1 ? "" : dump.slice(separator + 2));
		if (record === null || record.tag !== tag) {
			conflicts.push(tag);
			continue;
		}
		releases.push({ tag, commit: git(cwd, ["rev-parse", `${oid}^{commit}`]), record });
	}
	return { releases, conflicts };
}

function fetchPullRequest(cwd: string, repo: string, number: number): MergedPullRequest {
	const path = `repos/${repo}/pulls/${number}`;
	const result = run(["gh", "api", path], { cwd });
	if (result.status !== 0) throw new Error(`cannot read pull request #${number} of ${repo}: ${firstLine(result.stderr || result.stdout)}`);
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		throw new Error(`pull request #${number} of ${repo} did not answer with JSON`);
	}
	if (typeof value !== "object" || value === null) throw new Error(`pull request #${number} of ${repo} answered with an unexpected shape`);
	const source = value as Record<string, unknown>;
	const base = source.base;
	const baseRef = typeof base === "object" && base !== null ? (base as Record<string, unknown>).ref : undefined;
	if (source.number !== number || source.state !== "closed" || source.merged !== true || baseRef !== "main") {
		throw new Error(`pull request #${number} of ${repo} is not a merged pull request against main`);
	}
	if (typeof source.title !== "string" || typeof source.merge_commit_sha !== "string" || !/^[0-9a-f]{40}$/.test(source.merge_commit_sha)) {
		throw new Error(`pull request #${number} of ${repo} has no usable title or merge commit`);
	}
	return { number, title: source.title, body: typeof source.body === "string" ? source.body : "", mergeCommitSha: source.merge_commit_sha };
}

function assertOriginMatches(cwd: string, repo: string): void {
	const url = git(cwd, ["config", "--get", "remote.origin.url"]);
	const slug = repoFromRemote(url);
	if (slug === null || slug.toLowerCase() !== repo.toLowerCase()) {
		throw new Error(`origin ${url} is not ${repo}; refusing to release from another repository`);
	}
}

function repoFromRemote(url: string): string | null {
	const match = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/[^/]+\/)(.+?)(?:\.git)?$/.exec(url.trim());
	return match?.[1] ?? null;
}

function ghApiExists(cwd: string, path: string): boolean {
	const result = run(["gh", "api", path], { cwd });
	if (result.status === 0) return true;
	if (`${result.stderr}${result.stdout}`.includes("HTTP 404")) return false;
	throw new Error(`gh api ${path} failed (exit ${result.status}): ${firstLine(result.stderr || result.stdout)}`);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
	const result = run(["git", "merge-base", "--is-ancestor", ancestor, descendant], { cwd });
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`git merge-base failed (exit ${result.status}): ${firstLine(result.stderr)}`);
}

function compareVersions(left: string, right: string): number {
	const a = SEMVER.exec(left);
	const b = SEMVER.exec(right);
	if (!a || !b) throw new Error(`${!a ? left : right} is not a semantic version`);
	for (let index = 1; index <= 3; index += 1) {
		const delta = Number(a[index]) - Number(b[index]);
		if (delta !== 0) return delta;
	}
	return 0;
}

function asBump(value: unknown): Bump | null {
	return value === "major" || value === "minor" || value === "patch" ? value : null;
}

function git(cwd: string, args: string[], options: GitOptions = {}): string {
	return gitResult(cwd, args, options).stdout.trim();
}

function gitResult(cwd: string, args: string[], options: GitOptions = {}): CommandResult {
	const result = run(["git", ...args], { cwd, env: options.env, input: options.input });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed (exit ${result.status}): ${firstLine(result.stderr || result.stdout)}`);
	return result;
}

function run(argv: string[], options: { cwd: string; env?: Record<string, string | undefined>; input?: string }): CommandResult {
	const result = Bun.spawnSync(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

function main(): void {
	const repo = process.env.GITHUB_REPOSITORY ?? "";
	const number = process.env.PR_NUMBER ?? "";
	if (!REPOSITORY.test(repo)) throw new Error("GITHUB_REPOSITORY must be set to <owner>/<name>");
	if (!PR_NUMBER.test(number)) throw new Error("PR_NUMBER must be the number of a merged pull request");
	runRelease({ cwd: process.cwd(), repo, prNumber: Number(number) });
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(`release failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
