import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE_SCRIPT = join(import.meta.dir, "..", "..", "scripts", "release.ts");

export interface PullFixture {
	number: number;
	title: string;
	body?: string;
}

export interface ReleaseFixture {
	readonly root: string;
	readonly repo: string;
	mergePullRequest(pull: PullFixture): string;
	pushAnnotatedTag(tag: string, message: string): void;
	pushUnmanagedTag(tag: string): void;
	tags(): string[];
	tagCommit(tag: string): string;
	tagMessage(tag: string): string;
	releases(): string[];
	release(tag: string): Record<string, unknown>;
	packageVersionAt(ref: string): string;
	failReleaseCreation(enabled: boolean): void;
	raceMainOnPullFetch(message?: string): void;
	clearPullFetchHook(): void;
	run(env?: Record<string, string>): { status: number; stdout: string; stderr: string };
	cleanup(): void;
}

const GH_SHIM = `#!/usr/bin/env bash
set -euo pipefail
state="$RELEASE_FIXTURE_STATE"
case "\${1:-}" in
  api)
    shift
    method="GET"
    path=""
    input=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --method|-X) method="$2"; shift 2 ;;
        --input) input="$2"; shift 2 ;;
        -*) echo "gh: unsupported flag $1" >&2; exit 1 ;;
        *) path="$1"; shift ;;
      esac
    done
    if [ "$method" = "POST" ]; then
      if [ -f "$state/fail-release" ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
      tag="$(grep -o '"tag_name": *"[^"]*"' "$input" | head -n 1 | cut -d'"' -f4)"
      if [ -z "$tag" ] || [ -z "$(git ls-remote "$RELEASE_FIXTURE_ORIGIN" "refs/tags/$tag")" ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
      cp "$input" "$state/releases/$tag"
      exit 0
    fi
    case "$path" in
      repos/*/pulls/*)
        number="\${path##*/}"
        if [ "$(cat "$state/pull.number")" != "$number" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
        if [ -f "$state/on-pull-fetch" ]; then bash "$state/on-pull-fetch"; fi
        cat "$state/pull.json"
        ;;
      repos/*/releases/tags/*)
        tag="\${path##*/}"
        if [ -f "$state/releases/$tag" ]; then printf '{"tag_name":"%s","draft":false}\\n' "$tag"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
        ;;
      *)
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "gh: unsupported command \${1:-}" >&2
    exit 1
    ;;
esac
`;

export function createReleaseFixture(options: { version?: string } = {}): ReleaseFixture {
	const root = mkdtempSync(join(tmpdir(), "omp-pstack-release-"));
	const origin = join(root, "origin.git");
	const seed = join(root, "seed");
	const checkout = join(root, "checkout");
	const bin = join(root, "bin");
	const state = join(root, "state");
	const raceScript = join(state, "race-main.sh");
	const repo = "example/omp-pstack";

	mkdirSync(bin);
	mkdirSync(join(state, "releases"), { recursive: true });

	const git = (cwd: string, ...args: string[]): string => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
		return result.stdout.toString().trim();
	};

	git(root, "init", "-q", "--bare", "-b", "main", origin);
	git(root, "init", "-q", "-b", "main", seed);
	git(seed, "config", "user.name", "release fixture");
	git(seed, "config", "user.email", "fixture@example.com");
	writeFileSync(join(seed, "package.json"), [
		"{",
		'  "name": "omp-pstack",',
		`  "version": "${options.version ?? "1.0.0"}",`,
		'  "type": "module",',
		'  "engines": { "bun": ">=1.3.14" },',
		'  "dependencies": {}',
		"}",
		"",
	].join("\n"));
	git(seed, "add", "-A");
	git(seed, "commit", "-q", "-m", "chore: seed the release fixture");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "-q", "origin", "main");
	git(root, "clone", "-q", origin, checkout);
	git(checkout, "remote", "set-url", "origin", `https://github.com/${repo}.git`);
	git(checkout, "config", `url.${origin}.insteadOf`, `https://github.com/${repo}.git`);

	writeFileSync(join(bin, "gh"), GH_SHIM);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(raceScript, [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		'message="${1:-concurrent merge}"',
		`git -C '${seed}' fetch -q origin main`,
		`git -C '${seed}' checkout -q -B main FETCH_HEAD`,
		`echo "$message" >> '${seed}/race.txt'`,
		`git -C '${seed}' add -A`,
		`git -C '${seed}' commit -q -m "$message"`,
		`git -C '${seed}' push -q origin main`,
		"",
	].join("\n"));
	chmodSync(raceScript, 0o755);

	let merges = 0;

	return {
		root,
		repo,

		mergePullRequest(pull) {
			merges += 1;
			git(seed, "fetch", "-q", "origin", "main");
			git(seed, "checkout", "-q", "-B", "main", "FETCH_HEAD");
			const branch = `pr-${pull.number}-${merges}`;
			git(seed, "checkout", "-q", "-b", branch);
			writeFileSync(join(seed, `change-${merges}.txt`), `${pull.title}\n`);
			git(seed, "add", "-A");
			git(seed, "commit", "-q", "-m", `work for pull request #${pull.number}`);
			git(seed, "checkout", "-q", "main");
			git(seed, "merge", "-q", "--no-ff", "-m", `Merge pull request #${pull.number} from ${branch}`, branch);
			git(seed, "push", "-q", "origin", "main");
			const mergeCommitSha = git(seed, "rev-parse", "HEAD");
			writeFileSync(join(state, "pull.json"), `${JSON.stringify({
				number: pull.number,
				title: pull.title,
				body: pull.body ?? "",
				state: "closed",
				merged: true,
				base: { ref: "main" },
				merge_commit_sha: mergeCommitSha,
			}, null, 2)}\n`);
			writeFileSync(join(state, "pull.number"), String(pull.number));
			return mergeCommitSha;
		},

		pushAnnotatedTag(tag, message) {
			git(seed, "fetch", "-q", "origin", "main");
			const messageFile = join(state, `message-${tag}`);
			writeFileSync(messageFile, message);
			git(seed, "tag", "-a", "-f", tag, "FETCH_HEAD", "-F", messageFile);
			git(seed, "push", "-q", "origin", `refs/tags/${tag}`);
		},

		pushUnmanagedTag(tag) {
			git(seed, "fetch", "-q", "origin", "main");
			git(seed, "tag", "-f", tag, "FETCH_HEAD");
			git(seed, "push", "-q", "origin", `refs/tags/${tag}`);
		},

		tags() {
			return git(origin, "tag", "-l").split("\n").filter(Boolean);
		},

		tagCommit(tag) {
			return git(origin, "rev-parse", `${tag}^{commit}`);
		},

		tagMessage(tag) {
			const dump = git(origin, "cat-file", "-p", `refs/tags/${tag}`);
			const separator = dump.indexOf("\n\n");
			return separator === -1 ? "" : dump.slice(separator + 2);
		},

		releases() {
			return readdirSync(join(state, "releases")).sort();
		},

		release(tag) {
			return JSON.parse(readFileSync(join(state, "releases", tag), "utf8")) as Record<string, unknown>;
		},

		packageVersionAt(ref) {
			const manifest = JSON.parse(git(origin, "show", `${ref}:package.json`)) as { version?: unknown };
			return String(manifest.version);
		},

		failReleaseCreation(enabled) {
			const marker = join(state, "fail-release");
			if (enabled) writeFileSync(marker, "");
			else rmSync(marker, { force: true });
		},

		raceMainOnPullFetch(message = "concurrent merge") {
			const hook = join(state, "on-pull-fetch");
			writeFileSync(hook, `#!/usr/bin/env bash\nset -euo pipefail\nbash '${raceScript}' '${message}'\n`);
			chmodSync(hook, 0o755);
		},

		clearPullFetchHook() {
			rmSync(join(state, "on-pull-fetch"), { force: true });
		},

		run(env = {}) {
			const result = Bun.spawnSync(["bun", RELEASE_SCRIPT], {
				cwd: checkout,
				env: {
					...process.env,
					HOME: root,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					RELEASE_FIXTURE_STATE: state,
					RELEASE_FIXTURE_ORIGIN: origin,
					GITHUB_REPOSITORY: repo,
					GH_TOKEN: "fixture-token",
					...env,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		},

		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

if (import.meta.main) {
	const fixture = createReleaseFixture();
	const mergeCommit = fixture.mergePullRequest({ number: 1, title: "feat: smoke the release path" });
	const run = fixture.run({ PR_NUMBER: "1" });
	if (run.stdout.trim()) console.log(run.stdout.trim());
	if (run.status !== 0) {
		console.error(run.stderr.trim());
		console.error(`sandbox kept for inspection: ${fixture.root}`);
		process.exit(run.status);
	}
	console.log(JSON.stringify({
		sandbox: fixture.root,
		mergeCommit,
		tags: fixture.tags(),
		releases: fixture.releases(),
		packageVersion: fixture.packageVersionAt("v1.0.0"),
	}, null, 2));
	console.log(`inspect with: git -C ${fixture.root}/origin.git log --oneline --decorate main && rm -rf ${fixture.root}`);
}
