/**
 * Benny setup, preflight, and the private enabled-state gate.
 *
 * Setup copies the dormant pack with conservative merge semantics (destination
 * files preserved, differing managed files reported, never blind-overwritten)
 * and installs the shared pstack skills at project scope. Preflight runs real
 * checks: committed declarations, environment tokens, tracker adapter, control
 * image and command, feature map. Pack integrity validates every required
 * file as a non-symlink regular file whose worktree bytes exactly match the
 * captured revision's blob. Enabling requires a passing canary recorded for
 * the exact captured config hash and repository revision, re-verified
 * unchanged immediately before the pair is persisted.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { ensureStateGitExcluded } from "./runner.ts";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { BennyError } from "./benny-run.ts";
import { resolveImageId } from "./benny-workspace.ts";
import {
	assertBennyEndpointPolicy,
	bennyConfigHash,
	bennyRepoRevision,
	bennyWorktreeDrift,
	canaryEligible,
	configBlobBindingProblem,
	gitCommittedFileBytes,
	loadBennyConfig,
	readBennyState,
	sharedModelRegistry,
	targetRootFor,
	validateBennyModels,
	writeBennyState,
	gitIsolatedArgv,
	gitIsolationEnv,
	type BennyConfig,
	type EnableState,
} from "./benny.ts";
import { pstackCommand } from "./cli-launch.ts";

export interface SetupResult {
	ok: boolean;
	target: string;
	destination: string;
	copied: string[];
	identical: string[];
	conflicts: string[];
	verification: PreflightCheck[];
	diagnostics: string[];
}

export interface PreflightCheck {
	check: string;
	ok: boolean;
	detail: string;
}

const PACK_ROOT = join(import.meta.dir, "..", "automations", "benny");
const PACK_DEST = (target: string): string => join(target, ".omp", "automations", "benny");

const REQUIRED_PACK_FILES = [
	"FOR_AGENTS.md",
	"README.md",
	"skills/setup-benny/SKILL.md",
	"skills/triage-issue-reports/SKILL.md",
	"skills/reproduce-and-fix-issues/SKILL.md",
	"skills/triage-issue-reports/references/routing.example.md",
	"skills/reproduce-and-fix-issues/references/control-adapter.md",
	"skills/reproduce-and-fix-issues/references/feature-map.example.md",
	"skills/reproduce-and-fix-issues/references/verify-existing-fix.md",
	"templates/configuration.example.yaml",
	"templates/triage-automation-prompt.md",
	"templates/reproduce-automation-prompt.md",
];

export const SHARED_SKILL_IDS = [
	"how",
	"why",
	"tdd",
	"unslop",
	"principle-separate-before-serializing-shared-state",
	"principle-minimize-reader-load",
	"principle-guard-the-context-window",
	"principle-sequence-verifiable-units",
	"principle-fix-root-causes",
	"principle-prove-it-works",
];

const PLUGIN_PACKAGE = "omp-pstack";
const PLUGIN_DECLARATION_KEY = `${PLUGIN_PACKAGE}@${PLUGIN_PACKAGE}`;

/**
 * Structural proof of the project-scope plugin install. Both durable
 * declarations must be regular non-symlink files naming exactly
 * omp-pstack@omp-pstack: installed_plugins.json needs a version-2
 * project-scope entry with installPath and version; omp-plugins.lock.json
 * needs the enabled runtime state. The node_modules package link OMP creates
 * must be a symlink resolving outside the repository at exactly the declared
 * installPath — a planted real directory, a repo-internal escape, a dangling
 * link or a divergent declaration/link pair is refused. A substring mention
 * of the plugin name anywhere in the JSON is never evidence.
 */
export function validatePluginDeclarations(target: string): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const pluginsDir = join(target, ".omp", "plugins");
	const readObject = (rel: string, label: string): Record<string, unknown> | undefined => {
		const path = join(pluginsDir, rel);
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (!st) {
			problems.push(`${rel}: ${label} missing`);
			return undefined;
		}
		if (st.isSymbolicLink() || !st.isFile()) {
			problems.push(`${rel}: ${label} must be a regular non-symlink file`);
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
			return parsed as Record<string, unknown>;
		} catch (error) {
			problems.push(`${rel}: unparseable (${error instanceof Error ? error.message : String(error)})`);
			return undefined;
		}
	};
	const installed = readObject("installed_plugins.json", "plugin install declaration");
	let projectInstallPath: string | undefined;
	if (installed) {
		const plugins = installed.plugins;
		if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
			problems.push("installed_plugins.json: 'plugins' must be an object");
		} else {
			const entries = (plugins as Record<string, unknown>)[PLUGIN_DECLARATION_KEY];
			if (!Array.isArray(entries) || entries.length === 0) {
				problems.push(`installed_plugins.json: no exact '${PLUGIN_DECLARATION_KEY}' declaration`);
			} else {
				const project = entries.find(
					(entry): entry is Record<string, unknown> =>
						!!entry &&
						typeof entry === "object" &&
						!Array.isArray(entry) &&
						(entry as Record<string, unknown>).scope === "project" &&
						typeof (entry as Record<string, unknown>).installPath === "string" &&
						((entry as Record<string, unknown>).installPath as string).length > 0 &&
						typeof (entry as Record<string, unknown>).version === "string",
				);
				if (!project) {
					problems.push("installed_plugins.json: declaration lacks a project-scope entry with installPath and version");
				} else {
					projectInstallPath = project.installPath as string;
				}
			}
		}
	}
	const lock = readObject("omp-plugins.lock.json", "plugin lock");
	if (lock) {
		const plugins = lock.plugins;
		if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
			problems.push("omp-plugins.lock.json: 'plugins' must be an object");
		} else {
			const state = (plugins as Record<string, unknown>)[PLUGIN_PACKAGE];
			if (!state || typeof state !== "object" || Array.isArray(state)) {
				problems.push(`omp-plugins.lock.json: no '${PLUGIN_PACKAGE}' entry`);
			} else if ((state as Record<string, unknown>).enabled !== true) {
				problems.push(`omp-plugins.lock.json: '${PLUGIN_PACKAGE}' is not enabled`);
			}
		}
	}
	const link = join(pluginsDir, "node_modules", PLUGIN_PACKAGE);
	const linkStat = lstatSync(link, { throwIfNoEntry: false });
	if (!linkStat) {
		problems.push(`node_modules/omp-pstack package link is missing; rerun ${pstackCommand("benny", "setup")}`);
	} else if (!linkStat.isSymbolicLink()) {
		problems.push("node_modules/omp-pstack must be the plugin cache symlink OMP creates, not a real file");
	} else {
		let resolved: string | undefined;
		try {
			resolved = realpathSync(link);
		} catch {
			problems.push("node_modules/omp-pstack is a dangling symlink");
		}
		if (resolved) {
			const realTarget = realpathSync(target);
			if (resolved === realTarget || resolved.startsWith(`${realTarget}${sep}`)) {
				problems.push(`node_modules/omp-pstack escapes into the repository (${resolved})`);
			}
			if (projectInstallPath !== undefined) {
				let declaredReal: string | undefined;
				try {
					declaredReal = realpathSync(projectInstallPath);
				} catch {
					problems.push(`declared installPath '${projectInstallPath}' does not exist`);
				}
				if (declaredReal !== undefined && declaredReal !== resolved) {
					problems.push(`node_modules/omp-pstack resolves to '${resolved}' but the declaration says '${projectInstallPath}'; the pair diverges`);
				}
			}
		}
	}
	return { ok: problems.length === 0, problems };
}

function listFiles(root: string, base: string = root): string[] {
	const entries: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) entries.push(...listFiles(full, base));
		else entries.push(relative(base, full));
	}
	return entries.sort();
}

/**
 * Proof that the already-configured `omp-pstack` marketplace resolves to this
 * canonical package root. `omp plugin marketplace` lists name + source-path
 * pairs; the entry named omp-pstack must realpath to exactly this checkout.
 * Without this proof, a failed marketplace add would let
 * `omp-pstack@omp-pstack` install from a foreign source that merely owns the
 * same marketplace name.
 */
function canonicalMarketplaceProof(packageRoot: string, cwd: string): { ok: boolean; detail: string } {
	const listing = spawn(["omp", "plugin", "marketplace"], cwd);
	const expected = realpathSync(packageRoot);
	for (const match of listing.stdout.matchAll(/^  (\S+)\s{2,}(.+)$/gm)) {
		if (match[1] !== PLUGIN_PACKAGE) continue;
		const source = match[2].trim();
		try {
			return realpathSync(source) === expected
				? { ok: true, detail: `configured omp-pstack marketplace resolves to this package root (${source})` }
				: { ok: false, detail: `configured omp-pstack marketplace resolves to ${source}, not this package root` };
		} catch {
			return { ok: false, detail: `configured omp-pstack marketplace path '${source}' is unreadable` };
		}
	}
	return { ok: false, detail: "no configured omp-pstack marketplace entry" };
}

/**
 * Deterministic runtime-manifest identity for an installed plugin package:
 * everything OMP executes or serves — package.json with its omp extension
 * entrypoints, .omp-plugin marketplace metadata, src, skills, agents, and the
 * source Benny pack under automations/benny — must be regular non-symlink
 * files byte-exact to this canonical package, with no extra runtime content.
 * A foreign same-name package (matching metadata but different entrypoints,
 * bytes or content set) or a tampered/missing source Benny pack can never
 * pass.
 */
function packageManifestProblems(packageRoot: string, installedRoot: string): string[] {
	const problems: string[] = [];
	const manifestRoots = ["package.json", ".omp-plugin", "src", "skills", "agents", "automations/benny"];
	const walk = (root: string, prefix: string, into: Map<string, Buffer>): void => {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = join(root, entry.name);
			if (entry.isDirectory()) walk(full, rel, into);
			else if (entry.isFile()) into.set(rel, readFileSync(full));
			else problems.push(`${rel} is not a regular non-symlink file`);
		}
	};
	// A manifest root may be one file (package.json) or a directory tree:
	// either way the bytes are read directly; symlinks and other node types
	// are refused rather than followed. A missing installed entry is left out
	// so the canonical-vs-installed diff reports it as "lacks".
	const collect = (root: string, rel: string, into: Map<string, Buffer>, label: string): void => {
		const st = lstatSync(root, { throwIfNoEntry: false });
		if (!st) return;
		if (st.isFile()) into.set(rel, readFileSync(root));
		else if (st.isDirectory()) walk(root, rel, into);
		else problems.push(`${label} ${rel} is not a regular non-symlink file or directory`);
	};
	const canonical = new Map<string, Buffer>();
	for (const rel of manifestRoots) {
		const st = lstatSync(join(packageRoot, rel), { throwIfNoEntry: false });
		if (!st) problems.push(`canonical package is missing ${rel}`);
		else if (!st.isFile() && !st.isDirectory()) problems.push(`canonical ${rel} is not a regular file or directory`);
	}
	if (problems.length === 0) {
		for (const rel of manifestRoots) collect(join(packageRoot, rel), rel, canonical, "canonical");
		const installed = new Map<string, Buffer>();
		try {
			for (const rel of manifestRoots) collect(join(installedRoot, rel), rel, installed, "installed");
		} catch (error) {
			problems.push(`installed package is unreadable: ${error instanceof Error ? error.message : String(error)}`);
			return problems;
		}
		for (const [rel, bytes] of canonical) {
			const got = installed.get(rel);
			if (!got) problems.push(`installed package lacks ${rel}`);
			else if (!got.equals(bytes)) problems.push(`installed ${rel} differs byte-wise from this package`);
		}
		for (const rel of installed.keys()) {
			if (!canonical.has(rel)) problems.push(`installed package carries extra runtime file ${rel}`);
		}
		// The extension entrypoints OMP will execute must exist inside the
		// verified manifest as regular files.
		const pkg = JSON.parse((canonical.get("package.json") ?? Buffer.alloc(0)).toString("utf8")) as { omp?: { extensions?: readonly string[] } };
		for (const entry of pkg.omp?.extensions ?? []) {
			if (typeof entry !== "string" || !canonical.has(normalize(entry))) problems.push(`package.json omp extension entrypoint ${String(entry)} is not a verified runtime file`);
		}
	}
	return problems;
}

/**
 * Identity and content proof for the installed plugin package: the cache
 * link must resolve, and the package behind it must be THIS plugin — either
 * the canonical checkout itself, or byte-exact across the full runtime
 * manifest — before setup reports the shared skills installed.
 */
function installedPackageIdentityCheck(target: string, packageRoot: string): PreflightCheck {
	const check = "installed package identity";
	let installedRoot: string;
	try {
		installedRoot = realpathSync(join(target, ".omp", "plugins", "node_modules", PLUGIN_PACKAGE));
	} catch {
		return { check, ok: false, detail: `plugin package link is missing or dangling; rerun ${pstackCommand("benny", "setup")}` };
	}
	if (installedRoot === realpathSync(packageRoot)) {
		return { check, ok: true, detail: `installed package link resolves to this plugin checkout (${installedRoot})` };
	}
	const problems = packageManifestProblems(packageRoot, installedRoot);
	return {
		check,
		ok: problems.length === 0,
		detail: problems.length === 0
			? `installed package at ${installedRoot} is byte-exact to this package across its full runtime manifest`
			: problems.join("; "),
	};
}

function spawn(argv: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		ok: proc.exitCode === 0,
		stdout: proc.stdout.toString().trim(),
		stderr: proc.stderr.toString().trim(),
	};
}

// ---------------------------------------------------------------------------
// Pack installation
// ---------------------------------------------------------------------------

/**
 * Merge the source pack into `<target>/.omp/automations/benny/`: copy new
 * files, no-op identical files, report differing managed files as conflicts,
 * and never touch destination-only files. Config/map/secrets live outside the
 * pack and are not part of this copy.
 */
export async function setupBenny(target: string): Promise<SetupResult> {
	// Canonical target: files are created exclusively under the real location
	// the operator named; a symlinked target would redirect the whole pack.
	mkdirSync(target, { recursive: true });
	const canonicalTarget = realpathSync(resolve(target));
	// Private runtime state under `.omp/pstack/state/` must never leak into a
	// commit, whatever the target's own .gitignore says.
	ensureStateGitExcluded(canonicalTarget);
	/** Refuse a planted symlink at any component between the target and `.omp/plugins`: OMP setup must not write through a redirect. */
	const assertPluginsComponentsReal = (): void => {
		assertRealComponents(join(canonicalTarget, ".omp", "plugins"));
	};
	/**
	 * Pre/post-OMP hardening of the `.omp/plugins` install surface. The omp
	 * CLI writes declarations, a lock file, temp files and a node_modules
	 * tree here; any planted symlink or irregular entry would redirect those
	 * writes outside the repository. The single legitimate link is
	 * node_modules/omp-pstack — OMP's own cache link — and even that must
	 * resolve outside the repository.
	 */
	const assertInstallSurfaceReal = (): void => {
		assertPluginsComponentsReal();
		const pluginsDir = join(canonicalTarget, ".omp", "plugins");
		let entries;
		try {
			entries = readdirSync(pluginsDir, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return; // nothing installed yet
			throw error;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new BennyError(2, `refusing symlinked '${entry.name}' under .omp/plugins before plugin install`);
			if (entry.name === "node_modules") {
				if (!entry.isDirectory()) throw new BennyError(2, `'.omp/plugins/node_modules' must be a real directory for the plugin install`);
				const packagesDir = join(pluginsDir, "node_modules");
				for (const child of readdirSync(packagesDir, { withFileTypes: true })) {
					if (child.isSymbolicLink()) {
						if (child.name !== PLUGIN_PACKAGE) throw new BennyError(2, `refusing symlinked package '${child.name}' under .omp/plugins/node_modules`);
						const resolved = realpathSync(join(packagesDir, child.name));
						if (resolved === canonicalTarget || resolved.startsWith(`${canonicalTarget}${sep}`)) {
							throw new BennyError(2, `refusing plugin package link into the repository: ${resolved}`);
						}
					} else if (child.name === PLUGIN_PACKAGE) {
						throw new BennyError(2, `'.omp/plugins/node_modules/${child.name}' must be the plugin cache symlink OMP creates; remove it and rerun setup`);
					} else if (!child.isDirectory() && !child.isFile()) {
						throw new BennyError(2, `refusing irregular entry '${child.name}' under .omp/plugins/node_modules`);
					}
				}
				continue;
			}
			if (!entry.isFile() && !entry.isDirectory()) throw new BennyError(2, `refusing irregular entry '${entry.name}' under .omp/plugins`);
		}
	};
	const destination = join(canonicalTarget, ".omp", "automations", "benny");
	const copied: string[] = [];
	const identical: string[] = [];
	const conflicts: string[] = [];
	const diagnostics: string[] = [];

	/**
	 * Reject every symlink between the canonical target and a destination
	 * entry: a planted link at any component redirects writes outside the
	 * repo, and a symlinked final entry must never be written through.
	 */
	const assertRealComponents = (dest: string): void => {
		let current = canonicalTarget;
		for (const part of relative(canonicalTarget, dest).split("/")) {
			current = join(current, part);
			const st = lstatSync(current, { throwIfNoEntry: false });
			if (!st) continue; // not created yet
			if (st.isSymbolicLink()) throw new BennyError(2, `refusing symlinked path component in the Benny pack destination: ${current}`);
		}
	};

	for (const rel of listFiles(PACK_ROOT)) {
		const source = join(PACK_ROOT, rel);
		const dest = join(destination, rel);
		assertRealComponents(dirname(dest));
		const existing = lstatSync(dest, { throwIfNoEntry: false });
		if (!existing) {
			mkdirSync(dirname(dest), { recursive: true });
			const sourceMode = statSync(source).mode;
			const data = readFileSync(source);
			await Bun.write(dest, data, { mode: sourceMode & 0o777 });
			copied.push(rel);
			continue;
		}
		if (existing.isSymbolicLink()) {
			conflicts.push(rel);
			diagnostics.push(`${rel}: destination entry is a symlink; refusing to write through it — remove it and rerun setup`);
			continue;
		}
		try {
			if (readFileSync(dest).equals(readFileSync(source))) {
				identical.push(rel);
				continue;
			}
		} catch {
			// unreadable destination entry (special file): conflict, never overwrite
		}
		conflicts.push(rel);
	}

	const verification: PreflightCheck[] = [];
	const missing = REQUIRED_PACK_FILES.filter((rel) => !existsSync(join(destination, rel)));
	verification.push({
		check: "pack files",
		ok: missing.length === 0,
		detail:
			missing.length === 0
				? `all ${REQUIRED_PACK_FILES.length} required files present at ${relative(resolve(target), destination)}`
				: `missing: ${missing.join(", ")}`,
	});

	// Shared pstack skills at project scope via the OMP CLI, then the durable
	// install declaration as evidence for a fresh target-rooted session.
	const packageRoot = resolve(import.meta.dir, "..");
	if (Bun.spawnSync(gitIsolatedArgv(["rev-parse", "--git-dir"]), { cwd: target, stdout: "pipe", stderr: "pipe", env: gitIsolationEnv() }).exitCode === 0) {
		assertInstallSurfaceReal();
		const add = spawn(["omp", "plugin", "marketplace", "add", packageRoot], target);
		let marketplaceProven: boolean;
		if (add.ok) {
			marketplaceProven = true;
		} else {
			diagnostics.push(`omp plugin marketplace add failed: ${add.stderr || add.stdout || "no output"}`);
			// Fatal unless the already-configured omp-pstack marketplace is
			// proven to resolve to this canonical package root: installing
			// omp-pstack@omp-pstack from whatever source currently owns that
			// name would deploy a foreign package and call it installed.
			const canonical = canonicalMarketplaceProof(packageRoot, target);
			verification.push({
				check: "marketplace source",
				ok: canonical.ok,
				detail: canonical.ok
					? `marketplace add failed; ${canonical.detail}`
					: `marketplace add failed and is unprovable (${canonical.detail}); refusing to install omp-pstack@omp-pstack from an unproven source`,
			});
			marketplaceProven = canonical.ok;
		}
		if (marketplaceProven) {
		const install = spawn(["omp", "plugin", "install", "--scope", "project", "omp-pstack@omp-pstack"], target);
		if (!install.ok) {
			// A failed install is fatal unless the CLI's nonzero exit still
			// produced a package that is byte-exact to this plugin across the
			// full runtime manifest — only that proves no foreign package
			// masquerades as the installed omp-pstack.
			let byteExact = false;
			try {
				const installedRoot = realpathSync(join(canonicalTarget, ".omp", "plugins", "node_modules", PLUGIN_PACKAGE));
				byteExact = installedRoot === realpathSync(packageRoot) || packageManifestProblems(packageRoot, installedRoot).length === 0;
			} catch {
				byteExact = false;
			}
			if (!byteExact) throw new BennyError(2, `omp plugin install failed: ${install.stderr || install.stdout || "no output"}`);
			diagnostics.push(`omp plugin install exited nonzero but the installed package is byte-exact to this plugin; continuing: ${install.stderr || install.stdout || "no output"}`);
		}
		// Recheck AFTER the CLI wrote: the surface must still be link-free
		// beyond OMP's own cache link and every write target a regular file —
		// the install must never have been redirected.
		assertInstallSurfaceReal();
		}
	} else {
		diagnostics.push(`${target} is not a git repository; skipping project marketplace install`);
	}
	// Structural proof, not a substring mention: both durable declarations
	// must name exactly omp-pstack@omp-pstack at project scope with the lock
	// enabled and a contained package link.
	const declaration = validatePluginDeclarations(canonicalTarget);
	const installed = declaration.ok;
	if (!installed) diagnostics.push(...declaration.problems);
	verification.push({
		check: "project plugin install",
		ok: installed,
		detail: installed
			? `omp-pstack installed at project scope; fresh target sessions must resolve ${SHARED_SKILL_IDS.join(", ")}`
			: diagnostics.join("; "),
	});
	// The declaration proves the install exists; identity proof verifies the
	// package behind the link is this plugin with its shared skills, not a
	// same-named foreign package.
	verification.push(installedPackageIdentityCheck(canonicalTarget, packageRoot));

	return {
		ok: conflicts.length === 0 && verification.every((check) => check.ok),
		target: resolve(target),
		destination,
		copied,
		identical,
		conflicts,
		verification,
		diagnostics,
	};
}

// ponytail: setup verifies the durable install declaration instead of spawning a full fresh OMP session; Main's integrated proof covers live discovery of the ten shared skills

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function gitCheck(argv: string[], cwd: string): { ok: boolean; output: string } {
	// PSTACK-SEC-GIT-002: the target's local Git configuration may name
	// executable helpers; run it with a scrubbed nonsecret environment and
	// fsmonitor/hook/external-helper overrides (shared with the runner).
	const proc = Bun.spawnSync(gitIsolatedArgv(argv.slice(1)), {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: gitIsolationEnv(),
	});
	return { ok: proc.exitCode === 0, output: `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim() };
}


/**
 * Pack integrity: every REQUIRED_PACK_FILES path under the installed pack
 * must be a non-symlink regular file whose worktree bytes exactly equal the
 * blob recorded at one captured revision. Any symlinked component (final
 * entry or intermediate directory) would redirect reads/writes outside the
 * repo; byte mismatch means the installed pack is not the committed pack.
 */
function packIntegrityCheck(target: string, revision: string): PreflightCheck {
	const dest = PACK_DEST(target);
	const relRoot = relative(target, dest);
	const realTarget = realpathSync(target);
	const problems: string[] = [];
	for (const rel of REQUIRED_PACK_FILES) {
		const full = join(dest, rel);
		const st = lstatSync(full, { throwIfNoEntry: false });
		if (!st) {
			problems.push(`${rel}: missing; run ${pstackCommand("benny", "setup")}`);
			continue;
		}
		if (st.isSymbolicLink()) {
			problems.push(`${rel}: symlink; a regular file is required`);
			continue;
		}
		if (!st.isFile()) {
			problems.push(`${rel}: not a regular file`);
			continue;
		}
		// A symlinked intermediate component redirects the whole path; the
		// canonical destination must be target-relative without any link.
		if (realpathSync(full) !== join(realTarget, relRoot, rel)) {
			problems.push(`${rel}: path traverses a symlink`);
			continue;
		}
		const blob = gitCommittedFileBytes(target, revision, join(relRoot, rel));
		if (!blob.bytes) {
			problems.push(`${rel}: absent from revision ${revision.slice(0, 12)}… (${blob.error ?? "unreadable"})`);
			continue;
		}
		if (!blob.bytes.equals(readFileSync(full))) {
			problems.push(`${rel}: worktree bytes differ from revision ${revision.slice(0, 12)}…; rerun ${pstackCommand("benny", "setup")} and commit`);
		}
	}
	return {
		check: "pack files",
		ok: problems.length === 0,
		detail:
			problems.length === 0
				? `all ${REQUIRED_PACK_FILES.length} required files are regular tracked bytes matching revision ${revision.slice(0, 12)}…`
				: problems.join("; "),
	};
}


function committedCheck(target: string, paths: string[]): PreflightCheck {
	const absent = paths.filter((rel) => !existsSync(join(target, rel)));
	if (absent.length > 0) {
		return { check: "committed declarations", ok: false, detail: `missing required declarations: ${absent.join(", ")}` };
	}
	// PSTACK-SEC-CONFIG-004: a clean tracked SYMLINK passes status/ls-files,
	// so every declared path must also be a real filesystem entry.
	const symlinked = paths.filter((rel) => lstatSync(join(target, rel), { throwIfNoEntry: false })?.isSymbolicLink());
	if (symlinked.length > 0) {
		return { check: "committed declarations", ok: false, detail: `symlinked declaration(s) are not committed content: ${symlinked.join(", ")}` };
	}
	const present = paths;
	const status = gitCheck(["git", "status", "--porcelain", "--", ...present], target);
	if (!status.ok) return { check: "committed declarations", ok: false, detail: "git status failed; is the target a git repository?" };
	if (status.output.length > 0) {
		return {
			check: "committed declarations",
			ok: false,
			detail: `uncommitted changes block enabling; commit pack/config/plugin declarations first:\n${status.output}`,
		};
	}
	const tracked = gitCheck(["git", "ls-files", "--", ...present], target);
	const trackedPaths = tracked.output.split("\n").filter(Boolean);
	const missing = present.filter((rel) => !trackedPaths.some((path) => path === rel || path.startsWith(`${rel}/`)));
	return {
		check: "committed declarations",
		ok: tracked.ok && missing.length === 0,
		detail: tracked.ok && missing.length === 0 ? `${present.length} file(s) committed and clean` : `not committed: ${missing.join(", ")}`,
	};
}

function envTokenCheck(config: BennyConfig): PreflightCheck[] {
	const tokens: Array<[string, string]> = [
		["slack read token", config.runtime.slack_read_token_env],
		["slack write token", config.runtime.slack_write_token_env],
		["tracker token", config.runtime.tracker_token_env],
	];
	const checks: PreflightCheck[] = [];
	for (const [label, envName] of tokens) {
		const value = process.env[envName];
		const present = typeof value === "string" && value.length >= 8;
		checks.push({
			check: `env token ${envName}`,
			ok: present,
			detail: present ? "present (value never logged)" : `missing or implausibly short; export ${envName} for the runner process`,
		});
	}
	if (config.runtime.trigger === "socket-mode") {
		const appEnv = config.runtime.slack_app_token_env;
		const value = process.env[appEnv];
		const present = typeof value === "string" && value.length >= 8;
		checks.push({
			check: `env token ${appEnv}`,
			ok: present,
			detail: present ? "present (socket mode)" : `missing; export ${appEnv} for socket-mode admission`,
		});
	}
	return checks;
}

function adapterCheck(config: BennyConfig): PreflightCheck {
	return {
		check: "tracker adapter",
		ok: config.tracker.type === "linear",
		detail: config.tracker.type === "linear"
			? "bundled bounded linear adapter"
			: `tracker.type "${config.tracker.type}" has no bundled adapter; only the bundled bounded linear adapter is supported`,
	};
}

function imageCommandCheck(image: string, command: unknown, target: string): boolean {
	if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) return false;
	return spawn([
		"docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", image,
		"-c",
		'command -v "$1" >/dev/null || exit 1; shift; for arg do case "$arg" in /*) test -e "$arg" || exit 1;; esac; done',
		"sh",
		...command,
	], target).ok;
}

export function controlChecks(config: BennyConfig, target: string, revision: string): PreflightCheck[] {
	const checks: PreflightCheck[] = [];
	// Preflight binds the immutable image ID, not the mutable reference: the
	// reference text alone lets a retagged or repulled tag swap uncanaried
	// bytes into the trusted control adapter after the canary passed.
	const imageRef = config.runtime.workspace_image;
	const inspect = spawn(["docker", "image", "inspect", "--format", "{{.Id}}", imageRef], target);
	const imageId = inspect.stdout.trim();
	const immutable = inspect.ok && /^sha256:[0-9a-f]{64}$/.test(imageId);
	checks.push({
		check: "control workspace image",
		ok: immutable,
		detail: immutable
			? `${imageRef} resolved to immutable image id ${imageId}; containers run by this id, never the mutable reference`
			: inspect.ok
				? `image ${imageRef} is inspectable but its id ${JSON.stringify(imageId)} is not an immutable sha256 identity`
				: `image ${imageRef} not inspectable; is the docker daemon reachable and the trusted image pulled?`,
	});
	const command = config.runtime.control_command;
	const commandOk = immutable && imageCommandCheck(imageId, command, target);
	checks.push({
		check: "control adapter command",
		ok: commandOk,
		detail: commandOk ? command.join(" ") : `control_command is not executable in the resolved image: ${command.join(" ") || "(unset)"}`,
	});
	const workerCommand = config.runtime.control_config.worker_command;
	const appUrl = config.runtime.control_config.app_url;
	let appUrlOk = false;
	try {
		const parsed = new URL(typeof appUrl === "string" ? appUrl : "");
		appUrlOk = ["http:", "https:"].includes(parsed.protocol) && parsed.hostname === "benny-worker";
	} catch {
		appUrlOk = false;
	}
	const workerOk = immutable && imageCommandCheck(imageId, workerCommand, target);
	checks.push({
		check: "target app bootstrap",
		ok: workerOk && appUrlOk,
		detail: workerOk && appUrlOk
			? `${Array.isArray(workerCommand) ? workerCommand.join(" ") : ""} → ${String(appUrl)}`
			: "runtime.control_config requires an executable worker_command argv and an http(s) app_url on host benny-worker",
	});
	const bootstrapCommand = config.runtime.control_config.bootstrap_command;
	if (bootstrapCommand !== undefined) {
		// Optional pre-baseline bootstrap argv; validated for nonempty string
		// parts and executability inside the trusted image when present.
		const bootstrapOk = immutable && imageCommandCheck(imageId, bootstrapCommand, target);
		checks.push({
			check: "control bootstrap command",
			ok: bootstrapOk,
			detail: bootstrapOk
				? (Array.isArray(bootstrapCommand) ? bootstrapCommand.join(" ") : "")
				: "runtime.control_config.bootstrap_command, when set, must be a nonempty argv array of strings executable in the workspace image",
		});
	}
	// Feature map and routing are behavior-bearing: they are validated as
	// regular committed blobs at the captured revision — the same immutable
	// reader the run uses — never via live readFileSync/existsSync, which a
	// tracked symlink or untracked worktree file could satisfy without the
	// committed bytes existing. gitCommittedFileBytes refuses mode 120000.
	const featureMap = gitCommittedFileBytes(target, revision, config.control.feature_map_path);
	const sections = featureMap.bytes
		? featureMap.bytes.toString("utf8").split("\n").filter((line) => line.startsWith("### ")).length
		: 0;
	checks.push({
		check: "feature map",
		ok: sections > 0,
		detail:
			sections > 0
				? `${config.control.feature_map_path} covers ${sections} feature section(s) at ${revision.slice(0, 12)}…`
				: `feature map is not a regular committed file at revision ${revision.slice(0, 12)}… (${featureMap.error ?? "no '### ' feature sections"}); every reproducible feature needs a committed '### ' section`,
	});
	// The routing map is a REQUIRED committed file; the schema rejects an empty
	// map_path. Its CONTENT may be an empty map (no routes, empty fallback),
	// which is the documented way to run with no owner routing.
	const routing = gitCommittedFileBytes(target, revision, config.routing.map_path);
	checks.push({
		check: "routing map",
		ok: routing.bytes !== undefined,
		detail: routing.bytes !== undefined
			? `${config.routing.map_path} committed at ${revision.slice(0, 12)}…`
			: `routing map is not a regular committed file at revision ${revision.slice(0, 12)}… (${routing.error ?? "unreadable"}); routing.map_path is required even when the map itself is empty`,
	});
	return checks;
}

function endpointCheck(config: BennyConfig): PreflightCheck {
	try {
		assertBennyEndpointPolicy(config);
	} catch (error) {
		return { check: "allowed endpoints", ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
	const serviceEndpoints = [config.runtime.slack_api_url, config.runtime.linear_api_url].filter(Boolean) as string[];
	if (config.runtime.allowed_endpoints.length > 0) {
		return {
			check: "allowed endpoints",
			ok: false,
			detail: "workspace allowed_endpoints requires an operator-provided proxy boundary; the bundled boundary supports no network egress only",
		};
	}
	return {
		check: "allowed endpoints",
		ok: true,
		detail: `workspace egress disabled; endpoint policy passed (${serviceEndpoints.length} host-side service endpoint override(s) official or opted-in loopback)`,
	};
}
function commitPathsFor(config: BennyConfig): string[] {
	const paths = [".omp/plugins/installed_plugins.json", ".omp/plugins/omp-plugins.lock.json", ".omp/automations/benny"];
	for (const candidate of [config.control.feature_map_path, config.routing.map_path]) {
		if (candidate && candidate.startsWith(".omp/")) paths.push(candidate);
	}
	return paths;
}
/**
 * Exact authenticated resolution of all four configured model roles: no
 * fuzzy matching, no substitution. Unavailable or unauthenticated selectors
 * fail the check with the role and remediation.
 */
async function modelCheck(config: BennyConfig, registry?: ModelRegistry): Promise<PreflightCheck> {
	try {
		validateBennyModels(config, registry ?? (await sharedModelRegistry()));
		return { check: "model selectors", ok: true, detail: "triage, reproduce, code and media_review resolve to authenticated, available models" };
	} catch (error) {
		return { check: "model selectors", ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export interface CapturedBinding {
	configHash: string;
	repoRevision: string;
	/** Resolved immutable workspace image id (`sha256:…`) the preflight/enable ran against. */
	imageId?: string;
}

/**
 * Real preflight for live deployment: every check exercises the actual
 * filesystem, git state, environment, docker image and adapter eligibility.
 * `captured` pins the preflight to one config-hash/repository-revision pair:
 * pack bytes are compared against that exact revision and any live drift
 * from the pair fails the check, so enable never gates on a pair other than
 * the one it will persist.
 */
export async function checkBenny(configPath: string, options: { registry?: ModelRegistry; captured?: CapturedBinding } = {}): Promise<PreflightCheck[]> {
	const checks: PreflightCheck[] = [];
	let config: BennyConfig;
	let target: string;
	try {
		config = await loadBennyConfig(configPath);
		target = targetRootFor(configPath);
		checks.push({ check: "configuration", ok: true, detail: `${configPath} parsed (hash ${bennyConfigHash(config).slice(0, 12)}…)` });
	} catch (error) {
		return [
			{
				check: "configuration",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			},
		];
	}

	const revision = bennyRepoRevision(target);
	if (options.captured) {
		const intact = bennyConfigHash(config) === options.captured.configHash && revision === options.captured.repoRevision;
		checks.push({
			check: "captured binding",
			ok: intact,
			detail: intact
				? `config hash ${options.captured.configHash.slice(0, 12)}… at revision ${options.captured.repoRevision.slice(0, 12)}… unchanged since capture`
				: `configuration hash or repository revision changed since the enable gate captured them (captured ${options.captured.repoRevision.slice(0, 12)}…, live ${revision.slice(0, 12)}…); rerun enable`,
		});
	}
	checks.push(packIntegrityCheck(target, revision));
	const configBinding = configBlobBindingProblem(configPath, target, revision);
	checks.push({
		check: "configuration binding",
		ok: configBinding === null,
		detail:
			configBinding ??
			`configuration bytes are the exact regular blob of revision ${revision.slice(0, 12)}… inside the target root`,
	});
	const configRelative = relative(target, resolve(configPath));
	checks.push(
		configRelative.startsWith("..")
			? { check: "committed declarations", ok: false, detail: `configuration must live inside the target repository: ${configPath}` }
			: committedCheck(target, [...commitPathsFor(config), configRelative]),
	);
	const drift = bennyWorktreeDrift(target, config);
	checks.push({
		check: "tracked worktree",
		ok: drift === null,
		detail: drift ?? `operational pack, feature map and routing map are exactly tracked and unmodified at ${revision.slice(0, 12)}…`,
	});
	// The exclusion anchor is verified live, not assumed from setup: private
	// runtime state must be uncommitable at enable time.
	const exclusion = gitCheck(["git", "check-ignore", "-q", "--", ".omp/pstack/state/"], target);
	checks.push({
		check: "state exclusion",
		ok: exclusion.ok,
		detail: exclusion.ok
			? ".omp/pstack/state/ is git-ignored; private runtime state cannot be committed"
			: `.omp/pstack/state/ is not git-ignored; run \`${pstackCommand("benny", "setup")}\` to anchor the exclusion in .git/info/exclude`,
	});
	// The install declaration is behavior-bearing evidence: it must name
	// exactly omp-pstack@omp-pstack at project scope with a contained package
	// link, or the shared-skill dependency of the operational pack is fiction.
	const declarations = validatePluginDeclarations(target);
	checks.push({
		check: "project plugin declaration",
		ok: declarations.ok,
		detail: declarations.ok
			? "exact omp-pstack@omp-pstack project declaration, enabled lock entry and contained package link verified"
			: declarations.problems.join("; "),
	});
	// Repeat the setup identity proof at enable time: the declared link must
	// still resolve to this byte-exact plugin, not a same-named foreign
	// package swapped in after setup.
	checks.push(installedPackageIdentityCheck(target, resolve(import.meta.dir, "..")));
	checks.push(...envTokenCheck(config));
	checks.push(await modelCheck(config, options.registry));
	checks.push(adapterCheck(config));
	checks.push(...controlChecks(config, target, revision));
	checks.push(endpointCheck(config));
	const eligibility = canaryEligible(target, config, options.captured?.imageId);
	checks.push({
		check: "canary",
		ok: eligibility.eligible,
		detail: eligibility.eligible ? "a passing canary is recorded for the current config hash and revision" : (eligibility.reason ?? "no passing canary"),
	});
	const state = readBennyState(target);
	checks.push({
		check: "enabled state",
		ok: true,
		detail: state?.enabled ? `enabled since ${new Date(state.enabledAt ?? 0).toISOString()}` : "disabled (default)",
	});
	return checks;
}

// ---------------------------------------------------------------------------
// Enabled state gate
// ---------------------------------------------------------------------------

/**
 * Enable is the last gate before live traffic: the config hash, repository
 * revision and resolved immutable workspace image id are captured once, full
 * preflight and the canary are checked for that exact captured triple, and it
 * is re-verified unchanged (same HEAD, still-clean tracked worktree, same
 * image resolution) immediately before persisting exactly the captured
 * binding — never freshly recomputed values. Disable rejects new work without
 * pretending to undo completed writes. State lives in private 0600 runtime
 * storage, never in the config.
 */
export async function setBennyEnabled(configPath: string, enabled: boolean, options: { registry?: ModelRegistry } = {}): Promise<EnableState> {
	const target = targetRootFor(configPath);
	// Disable is unconditional and side-effect-free: it must never require a
	// loadable config, a resolvable Docker image or preflight to pass — an
	// operator turning traffic off cannot be blocked by the very machinery
	// being turned off.
	if (!enabled) {
		writeBennyState(target, { enabled: false });
		return { enabled: false };
	}
	const config = await loadBennyConfig(configPath);
	const captured: CapturedBinding = {
		configHash: bennyConfigHash(config),
		repoRevision: bennyRepoRevision(target),
		imageId: await resolveImageId(config.runtime.workspace_image),
	};
	if (enabled) {
		const failures = (await checkBenny(configPath, { ...options, captured })).filter(
			(check) => !check.ok && check.check !== "canary" && check.check !== "enabled state",
		);
		if (failures.length > 0) {
			throw new BennyError(2, `cannot enable Benny; preflight failed:\n${failures.map((check) => `${check.check}: ${check.detail}`).join("\n")}`);
		}
		const eligibility = canaryEligible(target, config, captured.imageId);
		if (!eligibility.eligible) {
			throw new BennyError(
				2,
				`cannot enable Benny; ${eligibility.reason}. Run \`${pstackCommand("benny", "canary", "--config <path>", "--event <file>")}\` for this exact configuration and revision.`,
			);
		}
		// Close the enable TOCTOU: HEAD or tracked bytes may have moved while
		// gating ran. Nothing is persisted for a pair other than the captured
		// one — the state file must never bind enablement to a revision the
		// canary never exercised.
		if (bennyRepoRevision(target) !== captured.repoRevision || bennyWorktreeDrift(target, config) !== null) {
			throw new BennyError(
				2,
				`cannot enable Benny; the repository revision or tracked worktree changed while gating ran (captured ${captured.repoRevision.slice(0, 12)}…); rerun the canary and enable for the new state`,
			);
		}
		// Close the image TOCTOU the same way: a retag or repull mid-gating
		// means the canary exercised different image bytes than enable would
		// persist.
		const capturedImageId = captured.imageId;
		if (!capturedImageId) throw new BennyError(2, "cannot enable Benny without a captured immutable workspace image; rerun the canary and enable");
		if ((await resolveImageId(config.runtime.workspace_image)) !== capturedImageId) {
			throw new BennyError(
				2,
				`cannot enable Benny; the workspace image resolution changed while gating ran (captured ${capturedImageId.slice(0, 16)}…); rerun the canary and enable`,
			);
		}
		// Close the config TOCTOU too: re-read the configuration BYTES and
		// re-hash them against the captured hash. Nothing is persisted for a
		// configuration the gating and canary never saw.
		const live = await loadBennyConfig(configPath);
		if (bennyConfigHash(live) !== captured.configHash) {
			throw new BennyError(
				2,
				`cannot enable Benny; the configuration bytes changed while gating ran (captured ${captured.configHash.slice(0, 12)}…); rerun the canary and enable for the new state`,
			);
		}
	}
	const state: EnableState = { enabled: true, configHash: captured.configHash, repoRevision: captured.repoRevision, imageId: captured.imageId, enabledAt: Date.now() };
	writeBennyState(target, state);
	return state;
}
