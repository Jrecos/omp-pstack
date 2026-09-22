import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getConfigDirName } from "@oh-my-pi/pi-utils";

/** Host cache layout: `<pluginsDir>/cache/plugins/<marketplace>___<plugin>___<version>`. */
const CACHE_ROOT_NAME = "cache";
const CACHE_PARENT_NAME = "plugins";
const SEGMENT_SEPARATOR = "___";
/** The host links an installed plugin as `<runtimeRoot>/node_modules/<package name>`. */
const PACKAGE_NAME = "omp-pstack";
const MODE_SKILL_SUFFIX = `${sep}${join("skills", "poteto-mode", "SKILL.md")}`;

/**
 * Marketplace fields of the install the module was loaded from. Present only for
 * the host's exact cache shape, so the ownership fallback below can never arm
 * from a directory that merely happens to contain separators.
 */
export interface CacheIdentity {
	readonly cacheParent: string;
	readonly marketplace: string;
	readonly plugin: string;
}

export interface InstallAnchor {
	/** Canonical version root the host loaded this module from. */
	readonly loadedRoot: string;
	/** Session-selected lexical runtime-link root; equals loadedRoot for a checkout. */
	readonly stableRoot: string;
	readonly cacheIdentity: CacheIdentity | null;
}

/**
 * Identity of a cache install root, or null when the root is not the host's
 * `<cache>/<plugins>/<marketplace>___<plugin>___<version>` layout. Marketplace and
 * plugin names cannot contain the separator, so the first two fields are exact
 * and a version that itself contains separators stays part of the remainder.
 */
function cacheIdentityOf(loadedRoot: string): CacheIdentity | null {
	const cacheParent = dirname(loadedRoot);
	const segment = parseCacheSegment(basename(loadedRoot));
	if (!segment) return null;
	if (basename(cacheParent) !== CACHE_PARENT_NAME) return null;
	if (basename(dirname(cacheParent)) !== CACHE_ROOT_NAME) return null;
	return { cacheParent, marketplace: segment.marketplace, plugin: segment.plugin };
}

function parseCacheSegment(name: string): { marketplace: string; plugin: string } | null {
	const first = name.indexOf(SEGMENT_SEPARATOR);
	if (first < 1) return null;
	const second = name.indexOf(SEGMENT_SEPARATOR, first + SEGMENT_SEPARATOR.length);
	if (second <= first + SEGMENT_SEPARATOR.length) return null;
	if (second + SEGMENT_SEPARATOR.length >= name.length) return null;
	return { marketplace: name.slice(0, first), plugin: name.slice(first + SEGMENT_SEPARATOR.length, second) };
}

/** Active project runtime root, using the host's nearest `.omp` then nearest Git-root rule. */
function projectRuntimeLink(cwd: string): string | null {
	const start = resolve(cwd);
	const home = homedir();
	const configDir = getConfigDirName();
	for (const [marker, directoryOnly] of [[configDir, true], [".git", false]] as const) {
		for (let dir = start; dir !== home; ) {
			let found = false;
			try {
				const stat = statSync(join(dir, marker));
				found = !directoryOnly || stat.isDirectory();
			} catch {
				found = false;
			}
			if (found) return join(dir, configDir, "plugins", "node_modules", PACKAGE_NAME);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/**
 * The runtime link for this session. Exact loaded-root equality wins. A
 * repointed link is accepted only when its current target has the same strict
 * cache identity, which keeps a prepared factory usable after an upgrade.
 */
function findStableRoot(loadedRoot: string, cwd: string, identity: CacheIdentity | null): string | null {
	const candidates: string[] = [];
	const projectLink = projectRuntimeLink(cwd);
	if (projectLink) candidates.push(projectLink);
	if (identity) candidates.push(join(dirname(dirname(identity.cacheParent)), "node_modules", PACKAGE_NAME));
	for (const candidate of candidates) {
		try {
			const target = realpathSync(candidate);
			if (target === loadedRoot) return candidate;
			const currentIdentity = cacheIdentityOf(target);
			if (
				identity &&
				currentIdentity &&
				currentIdentity.cacheParent === identity.cacheParent &&
				currentIdentity.marketplace === identity.marketplace &&
				currentIdentity.plugin === identity.plugin
			) return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

/** Resolve the source-path anchor for one session cwd. A checkout without a proven runtime link disables identity fallback. */
export function resolveInstallAnchor(loadedRoot: string, cwd: string): InstallAnchor {
	const cacheIdentity = cacheIdentityOf(loadedRoot);
	const stableRoot = findStableRoot(loadedRoot, cwd, cacheIdentity);
	return stableRoot === null
		? { loadedRoot, stableRoot: loadedRoot, cacheIdentity: null }
		: { loadedRoot, stableRoot, cacheIdentity };
}

/**
 * Fallback ownership test for a recorded invocation whose file no longer
 * resolves because the host repointed the runtime link at a new version. The
 * same canonical cache parent plus exact marketplace and plugin fields prove the
 * path names this plugin's install; a same-named foreign skill, another cache,
 * and another marketplace's plugin are never claimed.
 */
export function sameMarketplaceSkill(recordedPath: string, identity: CacheIdentity | null): boolean {
	if (!identity || !isAbsolute(recordedPath)) return false;
	const normalized = normalize(recordedPath);
	if (!normalized.endsWith(MODE_SKILL_SUFFIX)) return false;
	const installRoot = normalized.slice(0, -MODE_SKILL_SUFFIX.length);
	const segment = parseCacheSegment(basename(installRoot));
	if (!segment) return false;
	let cacheParent: string;
	try {
		cacheParent = realpathSync(dirname(installRoot));
	} catch {
		return false;
	}
	return cacheParent === identity.cacheParent && segment.marketplace === identity.marketplace && segment.plugin === identity.plugin;
}
