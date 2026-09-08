import { linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, Settings, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveConfiguredModelPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

// ─── Role vocabulary (exact upstream setup-pstack step-5 table) ─────────────

export const ROLES = [
	"feature, refactoring",
	"bug-fix",
	"perf-issue",
	"hillclimb",
	"judgment and prose",
	"hardest tasks",
	"how explorer",
	"how explainer",
	"how critics",
	"why investigators",
	"why synthesizer",
	"reflect tooling",
	"reflect judgment, divergent, synthesizer",
	"arena runners",
	"arena cross-judge pool",
	"swarm workers",
	"architect runners",
	"interrogate reviewers",
] as const;

export type Role = (typeof ROLES)[number];
export type PanelRole =
	| "how critics"
	| "arena runners"
	| "arena cross-judge pool"
	| "architect runners"
	| "interrogate reviewers";
export type AgentKind = "poteto" | "general" | "readonly";

export const PANEL_ROLES: readonly Role[] = [
	"how critics",
	"arena runners",
	"arena cross-judge pool",
	"architect runners",
	"interrogate reviewers",
];

export const ALIASES = ["inherit-parent", "auto"] as const;
export const KINDS: readonly AgentKind[] = ["poteto", "general", "readonly"];

/**
 * Alias agents dispatch on the live parent model, so both alias tokens share
 * the same per-kind template (three alias templates total, no model field);
 * "inherit-parent" is the canonical naming token.
 */
const ALIAS_TOKEN = "inherit-parent";

/** Which generated-agent kind each role dispatches by default. */
const ROLE_KIND: Record<Role, AgentKind> = {
	"feature, refactoring": "poteto",
	"bug-fix": "poteto",
	"perf-issue": "poteto",
	hillclimb: "poteto",
	"judgment and prose": "general",
	"hardest tasks": "poteto",
	"how explorer": "general",
	"how explainer": "general",
	"how critics": "readonly",
	"why investigators": "poteto",
	"why synthesizer": "general",
	"reflect tooling": "general",
	"reflect judgment, divergent, synthesizer": "general",
	"arena runners": "poteto",
	"arena cross-judge pool": "readonly",
	"swarm workers": "poteto",
	"architect runners": "poteto",
	"interrogate reviewers": "readonly",
};

// ─── Config file layout ──────────────────────────────────────────────────────

export const RULE_REL_PATH = join("rules", "pstack-models.md");
const MANAGED_START = "<!-- omp-pstack:managed-start -->";
const MANAGED_END = "<!-- omp-pstack:managed-end -->";
const FRONTMATTER = [
	"---",
	"description: pstack per-role model choices backed by an explicit approved pool",
	"alwaysApply: true",
	"---",
];
const HEADER_LINES = [
	"# pstack model configuration. `pool:` lists the only approved selectors (concrete provider/id base identities plus `inherit-parent`/`auto` alias permission). A role line lists that role's ordered entries; a missing or empty role line is unconfigured and requires /setup-pstack.",
	"# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (dispatch without a model override). An alias is only granted when the pool contains the same token. Alias entries in a panel list still count toward its fan-out.",
	"# The addresses below map role[index] kind to prepared native task agents; dispatch with task agent=<name>.",
];

export interface Paths {
	agentsDir: string;
	rulesDir: string;
	rulePath: string;
}

export function resolvePaths(agentDir: string = getAgentDir()): Paths {
	return {
		agentsDir: join(agentDir, "agents"),
		rulesDir: join(agentDir, "rules"),
		rulePath: join(agentDir, RULE_REL_PATH),
	};
}

// ─── Model facade (structural subset of ctx.models) ─────────────────────────

export interface PstackModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinking?: { efforts?: readonly string[] } | undefined;
}

export interface ModelQuery {
	list(): PstackModel[];
	current(): PstackModel | undefined;
}

// ─── Concrete selector validation ────────────────────────────────────────────

const THINKING_LEVELS: Record<string, true> = {
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};

/** Exact identity only — full `provider/id`, or a bare `id` that is unambiguous. No glob, no fuzzy. */
function exactModel(spec: string, available: readonly PstackModel[]): PstackModel | undefined {
	const full = available.find((m) => `${m.provider}/${m.id}` === spec);
	if (full) return full;
	const byId = available.filter((m) => m.id === spec);
	return byId.length === 1 ? byId[0] : undefined;
}

export type SelectorVerdict =
	| { ok: true; selector: string; provider: string; id: string; thinking?: string }
	| { ok: false; error: string };

/**
 * Strictly validate a concrete model selector against an authenticated model
 * list. Exact identity only — no glob, no fuzzy, no unrelated-family
 * substitution. The returned `selector` is the canonical identity
 * (`provider/id[:thinking]`, thinking suffix lowercased) — the same bytes must
 * flow into config, hashes, descriptors and records. Ids that themselves end
 * in `:max`/`:auto` win over suffix interpretation (SDK literal-id guard).
 */
export function validateConcreteSelector(selector: string, available: readonly PstackModel[]): SelectorVerdict {
	const trimmed = selector.trim();
	const exact = exactModel(trimmed, available);
	if (exact) {
		return { ok: true, selector: `${exact.provider}/${exact.id}`, provider: exact.provider, id: exact.id };
	}

	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1).toLowerCase();
		const base = trimmed.slice(0, colon);
		if (THINKING_LEVELS[suffix]) {
			const baseModel = exactModel(base, available);
			if (baseModel) {
				if (suffix === "auto") {
					return { ok: true, selector: `${baseModel.provider}/${baseModel.id}:auto`, provider: baseModel.provider, id: baseModel.id, thinking: "auto" };
				}
				const efforts = baseModel.thinking?.efforts;
				if (efforts && !efforts.includes(suffix)) {
					return {
						ok: false,
						error: `Thinking level "${suffix}" is not supported by ${baseModel.provider}/${baseModel.id} (supports: ${efforts.join(", ")}).`,
					};
				}
				if (!efforts && baseModel.reasoning === false) {
					return { ok: false, error: `${baseModel.provider}/${baseModel.id} does not support thinking; drop the ":${suffix}" suffix.` };
				}
				return { ok: true, selector: `${baseModel.provider}/${baseModel.id}:${suffix}`, provider: baseModel.provider, id: baseModel.id, thinking: suffix };
			}
		}
	}
	return {
		ok: false,
		error: `Model "${selector}" is not an authenticated model in this session. Pick one of the detected models; never substitute another family.`,
	};
}

export function isAlias(value: string): boolean {
	return (ALIASES as readonly string[]).includes(value);
}

// Funny deterministic names: same (kind, selector) always maps to the same
// adjective-noun pair, with a short hash tail so distinct pairs never collide
// and the omp-pstack- dispatch prefix (task guard) is preserved.
const NAME_ADJECTIVES = [
	"grumpy", "sleepy", "feral", "chaotic", "paranoid", "drunken", "sarcastic", "stubborn",
	"caffeinated", "unhinged", "bald", "spicy", "moody", "naked", "clueless", "menacing",
] as const;
const NAME_NOUNS = [
	"llama", "gremlin", "potato", "goblin", "ferret", "walrus", "pigeon", "badger",
	"tortoise", "hamster", "raccoon", "penguin", "goose", "toad", "weasel", "axolotl",
] as const;

export function agentName(kind: AgentKind, selector: string): string {
	const digest = createHash("sha256").update(`${kind}\0${selector.trim()}`).digest();
	const adjective = NAME_ADJECTIVES[digest[0]! % NAME_ADJECTIVES.length];
	const noun = NAME_NOUNS[digest[1]! % NAME_NOUNS.length];
	const tail = digest.toString("hex").slice(2, 8);
	return `omp-pstack-${adjective}-${noun}-${tail}`;
}

// ─── Approved pool (concrete base identities plus explicit alias permission) ──

/**
 * Base model identity for a canonical selector. A validated thinking suffix is
 * stripped (`openai-codex/gpt-6-astra:high` → `openai-codex/gpt-6-astra`);
 * a literal id whose own trailing `:max`/`:auto` is the wire id keeps it
 * (`moonshotai/glm-4.7:max` stays whole), matching the SDK literal-id guard.
 */
function baseIdentity(selector: string, thinking: string | undefined): string {
	return thinking !== undefined ? selector.slice(0, selector.lastIndexOf(":")) : selector;
}

/** Raw base identity for an unvalidated string: strip any recognized thinking suffix. */
function baseIdentityRaw(selector: string): string {
	const colon = selector.lastIndexOf(":");
	if (colon > 0 && THINKING_LEVELS[selector.slice(colon + 1).toLowerCase()]) return selector.slice(0, colon);
	return selector;
}

function isPoolMember(selector: string, thinking: string | undefined, pool: readonly string[]): boolean {
	if (isAlias(selector)) return pool.includes(selector);
	return pool.includes(baseIdentity(selector, thinking));
}

/**
 * Affirm a selector against the approved pool. An empty pool is the legacy
 * no-config carve-out: nothing is approved yet, so an explicit selector the
 * caller supplied (prepare / per-arm override / task dispatch) is assumed
 * intentional. Never silently swaps a family; it fails closed with the pool.
 */
function assertInApprovedPool(selector: string, thinking: string | undefined, pool: readonly string[], context: string): void {
	if (pool.length === 0) return;
	if (isPoolMember(selector, thinking, pool)) return;
	if (isAlias(selector)) {
		throw new Error(`${context}: alias "${selector}" is not granted by the approved pool (${pool.join(", ")}). Add "${selector}" to the pool or pick a pool model.`);
	}
	throw new Error(`${context}: model "${selector}" is not in the approved pool (${pool.join(", ")}). Reconfigure the pool or pick one of its models; no other family is substituted.`);
}

/** Canonicalize an explicit pool: concrete entries must be authenticated; thinking suffix collapses to the base identity; alias tokens pass through. */
function canonicalizePool(pool: readonly string[], available: readonly PstackModel[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of pool) {
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		if (isAlias(trimmed)) {
			if (!seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
			continue;
		}
		const verdict = validateConcreteSelector(trimmed, available);
		if (!verdict.ok) throw new Error(`pool: ${verdict.error}`);
		const base = baseIdentity(verdict.selector, verdict.thinking);
		if (!seen.has(base)) { seen.add(base); out.push(base); }
	}
	return out;
}

/** Derive a legacy/back-compat pool from already-canonical assignment entries (never DEFAULT_ROLES). */
function derivePoolFromCanonical(canonicalRoles: Partial<Record<Role, string[]>>, thinking: Map<string, string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const role of ROLES) {
		for (const entry of canonicalRoles[role] ?? []) {
			const key = isAlias(entry) ? entry : baseIdentity(entry, thinking.get(entry));
			if (!seen.has(key)) { seen.add(key); out.push(key); }
		}
	}
	return out;
}

/** Derive a legacy pool from a parsed rule's explicit role lines (never DEFAULT_ROLES). */
function derivePoolFromConfig(roles: Partial<Record<Role, string[]>>, available: readonly PstackModel[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const role of ROLES) {
		for (const entry of roles[role] ?? []) {
			let key: string;
			if (isAlias(entry)) key = entry;
			else {
				const verdict = validateConcreteSelector(entry, available);
				key = verdict.ok ? baseIdentity(verdict.selector, verdict.thinking) : baseIdentityRaw(entry);
			}
			if (!seen.has(key)) { seen.add(key); out.push(key); }
		}
	}
	return out;
}

/** The effective approved pool for a parsed rule: the explicit pool, else derived from its explicit assignments (legacy). */
function effectivePool(parsed: ParsedConfig, available: readonly PstackModel[]): string[] {
	if (parsed.pool.length > 0) return parsed.pool;
	return derivePoolFromConfig(parsed.roles, available);
}

// ─── Config parsing / serialization ──────────────────────────────────────────

export class MalformedConfigError extends Error {}

export interface ParsedConfig {
	exists: boolean;
	roles: Partial<Record<Role, string[]>>;
	/** Approved pool: concrete base identities plus alias tokens. Empty for a legacy rule without a `pool:` line. */
	pool: string[];
	postamble: string;
	preamble?: string;
}

function splitEntries(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseRoleLine(line: string): { role: Role; entries: string[] } | null {
	const colon = line.indexOf(": ");
	const colonEnd = line.endsWith(":") ? line.length - 1 : -1;
	const cut = colon >= 0 ? colon : colonEnd;
	if (cut <= 0) return null;
	const label = line.slice(0, cut).trim();
	if (!(ROLES as readonly string[]).includes(label)) return null;
	return { role: label as Role, entries: splitEntries(line.slice(cut + 1).trim()) };
}

/**
 * Parse the plugin-managed rule. Comments after the managed end marker are
 * preserved as `postamble`; anything unrecognized inside the managed region
 * (or a broken frontmatter) is a hard error, never a silent reset.
 */
export function parseConfig(text: string): ParsedConfig {
	if (text.trim() === "") return { exists: false, roles: {}, pool: [], postamble: "" };
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines[0] !== "---") {
		throw new MalformedConfigError(`${RULE_REL_PATH}: content must start with the managed frontmatter. Fix or delete the file, then save again.`);
	}
	const closing = lines.indexOf("---", 1);
	if (closing < 0) {
		throw new MalformedConfigError(`${RULE_REL_PATH}: frontmatter is not terminated. Fix or delete the file, then save again.`);
	}
	if (!lines.slice(1, closing).includes("alwaysApply: true")) {
		throw new MalformedConfigError(`${RULE_REL_PATH}: frontmatter must contain "alwaysApply: true". Fix the file, then save again.`);
	}
	const startIndex = lines.indexOf(MANAGED_START);
	const endIndex = lines.indexOf(MANAGED_END);
	if (startIndex <= closing || endIndex <= startIndex || lines.lastIndexOf(MANAGED_START) !== startIndex || lines.lastIndexOf(MANAGED_END) !== endIndex) {
		throw new MalformedConfigError(`${RULE_REL_PATH}: missing, duplicate, or reversed managed markers; repair the file before saving.`);
	}
	const managed = lines.slice(startIndex + 1, endIndex);
	const preamble = lines.slice(0, startIndex).join("\n");
	const postamble = lines.slice(endIndex + 1).join("\n").replace(/^\n+/, "");
	const roles: Partial<Record<Role, string[]>> = {};
	const pool: string[] = [];
	let poolSeen = false;
	for (const [index, line] of managed.entries()) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		if (line.startsWith("pool:")) {
			if (poolSeen) throw new MalformedConfigError(`${RULE_REL_PATH}: the pool appears more than once. Keep one pool line.`);
			poolSeen = true;
			pool.push(...splitEntries(line.slice("pool:".length).trim()));
			continue;
		}
		const parsed = parseRoleLine(line);
		if (!parsed) {
			throw new MalformedConfigError(`${RULE_REL_PATH}: line ${closing + 2 + index} ("${line.trim()}") is not a known pstack role. Fix or delete the file, then save again.`);
		}
		if (roles[parsed.role] !== undefined) {
			throw new MalformedConfigError(`${RULE_REL_PATH}: role "${parsed.role}" appears more than once. Keep one line per role.`);
		}
		roles[parsed.role] = parsed.entries;
	}
	return { exists: true, roles, pool, preamble, postamble };
}

function entriesFor(parsed: ParsedConfig, role: Role): string[] {
	return parsed.roles[role] ?? [];
}

/** Address comments derive only from roles that have an explicit line; a missing/empty role is unconfigured. */
function addressLines(parsed: ParsedConfig): string[] {
	const lines: string[] = [];
	for (const role of ROLES) {
		const entries = parsed.roles[role];
		if (entries === undefined) continue;
		const kind = ROLE_KIND[role];
		for (const [index, entry] of entries.entries()) {
			const name = agentName(kind, isAlias(entry) ? ALIAS_TOKEN : entry);
			lines.push(`# ${role}[${index + 1}] ${kind} -> ${name} (${entry})`);
		}
	}
	return lines;
}

export function serializeConfig(parsed: ParsedConfig): string {
	const out: string[] = [...(parsed.preamble === undefined ? [...FRONTMATTER, "", ...HEADER_LINES] : [parsed.preamble]), MANAGED_START];
	// The pool line is emitted only when approved selectors exist; a legacy rule
	// without one is preserved verbatim rather than gaining an empty pool line.
	if (parsed.pool.length > 0) out.push(`pool: ${parsed.pool.join(", ")}`);
	for (const role of ROLES) {
		if (parsed.roles[role] === undefined) continue;
		out.push(`${role}: ${parsed.roles[role].join(", ")}`);
	}
	out.push("", ...addressLines(parsed), MANAGED_END);
	if (parsed.postamble) out.push("", parsed.postamble);
	return `${out.join("\n")}\n`;
}

// ─── Agent templates ─────────────────────────────────────────────────────────

const KIND_PROMPTS: Record<AgentKind, string> = {
	poteto:
		"You are a P Stack poteto worker dispatched by the parent session. The poteto-mode skill rules are autoloaded into your context; follow its non-negotiables, playbook discipline and ordered steps. Work autonomously and never block on the human. Keep your ordered checklist in the task result; the parent owns native todo updates. Report failed or skipped steps with reasons instead of inventing output.",
	general:
		"You are a P Stack worker dispatched by the parent session. Complete the assigned task with concrete, verifiable output and report failures honestly.",
	readonly:
		"You are a read-only P Stack reviewer. You never edit or write files. Read the supplied diff or source, report findings (including MUST KILL items) with file and line evidence, and leave every application edit to the parent.",
};

function agentFile(kind: AgentKind, selector: string | undefined): string {
	const front = [
		"---",
		`name: ${agentName(kind, selector ?? ALIAS_TOKEN)}`,
		`description: P Stack ${kind} agent${selector ? ` for ${selector}` : ` on the live parent model (${ALIASES.join("/")}).`}`,
	];
	if (selector) front.push(`model: ${selector}`);
	if (kind === "poteto") front.push("autoloadSkills: poteto-mode", "read-summarize: false", 'spawns: "*"');
	if (kind === "readonly") front.push("tools: read, grep, glob, web_search", 'spawns: ""');
	front.push("---", "", KIND_PROMPTS[kind], "");
	return `${front.join("\n")}\n`;
}

function readAgentFile(paths: Paths, name: string): string | undefined {
	try {
		return readFileSync(join(paths.agentsDir, `${name}.md`), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

/** Stage immutable native descriptors; a changed existing file is a collision. */
function stageAgent(paths: Paths, kind: AgentKind, selector: string | undefined, staged: Map<string, string>): "created" | "reused" {
	const name = `${agentName(kind, selector ?? ALIAS_TOKEN)}.md`;
	const content = agentFile(kind, selector);
	const prior = staged.get(name);
	if (prior !== undefined && prior !== content) {
		throw new Error(`Conflicting staged content for generated agent ${name}. Aborting without publishing anything.`);
	}
	staged.set(name, content);

	let existing: string | undefined;
	try {
		existing = readFileSync(join(paths.agentsDir, name), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existing = undefined;
	}
	if (existing === undefined) return "created";
	if (existing === content) return "reused";
	throw new Error(`Agent name collision: ${join(paths.agentsDir, name)} already exists with different content. Inspect that file before saving; it will not be overwritten.`);
}


/** A hard link publishes complete bytes without replacing a concurrent writer. */
function commitStaged(paths: Paths, staged: Map<string, string>): void {
	mkdirSync(paths.agentsDir, { recursive: true });
	for (const [name, content] of staged) {
		const tmp = join(paths.agentsDir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
		writeFileSync(tmp, content, { flag: "wx" });
		try {
			try { linkSync(tmp, join(paths.agentsDir, name)); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(join(paths.agentsDir, name), "utf8") !== content) throw error;
			}
		} finally { unlinkSync(tmp); }
	}
	// The staged map is the complete desired set; sweep profiles this plugin
	// owns (prefix match) but no longer stages. Foreign agent files never match
	// the prefix and are never touched.
	let stale: string[] = [];
	try {
		stale = readdirSync(paths.agentsDir).filter((name) => name.startsWith("omp-pstack-") && name.endsWith(".md"));
	} catch { /* agentsDir vanished or unreadable; nothing to prune */ }
	for (const file of stale) {
		if (staged.has(file)) continue;
		try { unlinkSync(join(paths.agentsDir, file)); } catch { /* raced or read-only; harmless */ }
	}
}


function writeRuleAtomic(paths: Paths, content: string): void {
	mkdirSync(paths.rulesDir, { recursive: true });
	const tmp = join(paths.rulesDir, `.${randomBytes(6).toString("hex")}.pstack-models.tmp`);
	writeFileSync(tmp, content);
	renameSync(tmp, paths.rulePath);
}

function readRuleFile(paths: Paths): string {
	try {
		return readFileSync(paths.rulePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return "";
	}
}
// ─── Settings override conflict check ────────────────────────────────────────
export function conflictingAgentModelOverrides(
	overrides: Record<string, string | string[]> | undefined,
	names: Iterable<string>,
	settings?: { getModelRole(role: string): string | undefined },
): { agent: string; value: string } | undefined {
	if (!overrides) return undefined;
	for (const name of names) {
		const value = overrides[name];
		if (value === undefined) continue;
		// Native semantics (config/model-resolver.ts): settings take precedence
		// only when normalization/expansion yields at least one pattern — an
		// empty string, empty array or whitespace-only value is legal and falls
		// through to the agent descriptor.
		const patterns = resolveConfiguredModelPatterns(value, settings);
		if (patterns.length > 0) return { agent: name, value: patterns.join(",") };
	}
	return undefined;
}

async function assertNoOverrides(paths: Paths, cwd: string | undefined, names: Iterable<string>): Promise<void> {
	const settings = await Settings.loadReadOnly(cwd ? { cwd } : {});
	const overrides = settings.get("task.agentModelOverrides");
	const conflict = conflictingAgentModelOverrides(overrides, names, settings);
	if (conflict) {
		throw new Error(`Settings task.agentModelOverrides["${conflict.agent}"] = "${conflict.value}" conflicts with the generated P Stack agent template. Remove that override (it would silently diverge from the role configuration), then save again.`);
	}
}

// ─── Core operations ─────────────────────────────────────────────────────────

export type RoleInput = string | string[];

function normalizeRoleInput(roles: Record<string, RoleInput>): Record<Role, string[]> {
	const unknown = Object.keys(roles).filter((key) => !(ROLES as readonly string[]).includes(key));
	if (unknown.length > 0) throw new Error(`Unknown role(s): ${unknown.join("; ")}. Use exactly the upstream role labels.`);
	const missing = ROLES.filter((role) => roles[role] === undefined);
	if (missing.length > 0) {
		throw new Error(`Missing role(s): ${missing.join("; ")}. Save replaces the full choice — all ${ROLES.length} roles must be present; no partial merges.`);
	}
	const out = {} as Record<Role, string[]>;
	for (const role of ROLES) {
		const entries = splitEntries(typeof roles[role] === "string" ? (roles[role] as string) : (roles[role] as string[]).join(","));
		if (!PANEL_ROLES.includes(role) && entries.length > 1) {
			throw new Error(`Role "${role}" takes a single model or alias, not a list.`);
		}
		out[role] = entries;
	}
	return out;
}

export interface AgentRecord {
	name: string;
	kind: AgentKind;
	selector: string;
	status: "created" | "reused";
}

export interface SaveResult {
	rulePath: string;
	agents: AgentRecord[];
	confirmed: { input: string; canonical: string }[];
}

/** Validate and persist a full explicit role choice: agents publish first, config last. */
export async function saveRoles(
	roles: Record<string, RoleInput>,
	query: ModelQuery,
	paths: Paths,
	cwd?: string,
	pool?: string[],
): Promise<SaveResult> {
	const normalized = normalizeRoleInput(roles);
	const existing = parseConfig(readRuleFile(paths));
	const available = query.list();

	const confirmed: { input: string; canonical: string }[] = [];
	const concrete = new Set<string>();
	const selectorThinking = new Map<string, string | undefined>();
	const canonicalRoles: Partial<Record<Role, string[]>> = {};
	for (const role of ROLES) {
		const canonical: string[] = [];
		for (const entry of normalized[role]) {
			if (isAlias(entry)) {
				canonical.push(entry);
				continue;
			}
			const verdict = validateConcreteSelector(entry, available);
			if (!verdict.ok) throw new Error(`${role}: ${verdict.error}`);
			confirmed.push({ input: entry, canonical: verdict.selector });
			canonical.push(verdict.selector);
			concrete.add(verdict.selector);
			selectorThinking.set(verdict.selector, verdict.thinking);
		}
		canonicalRoles[role] = canonical;
	}

	// Approved pool: explicit if supplied (canonicalized + authenticated), else
	// derived from the explicit choice for legacy callers. Every concrete
	// selector must be in the pool; an alias must be granted by a pool token.
	// An explicitly-supplied pool that canonicalizes to nothing is a hard error:
	// it must never fall back to inferring a pool from the role choice (that
	// would approve models the user did not list).
	let approvedPool: string[];
	if (pool !== undefined) {
		approvedPool = canonicalizePool(pool, available);
		if (approvedPool.length === 0) {
			throw new Error("save requires at least one approved pool member; an explicit pool that approves nothing is a misconfiguration, not a fallback to the role choice.");
		}
	} else {
		approvedPool = derivePoolFromCanonical(canonicalRoles, selectorThinking);
	}
	for (const role of ROLES) {
		// The prior loop assigns every role, but a Partial<Record> index is
		// not provably assigned to TS; iterate the entries we wrote.
		for (const entry of canonicalRoles[role] ?? []) {
			assertInApprovedPool(entry, isAlias(entry) ? undefined : selectorThinking.get(entry), approvedPool, role);
		}
	}

	// Three alias templates (one per kind, both alias tokens) plus concrete selectors actually used.
	const staged = new Map<string, string>();
	const agents: AgentRecord[] = [];
	const names: string[] = [];
	for (const kind of KINDS) {
		const status = stageAgent(paths, kind, undefined, staged);
		names.push(agentName(kind, ALIAS_TOKEN));
		agents.push({ name: agentName(kind, ALIAS_TOKEN), kind, selector: "inherit-parent/auto", status });
	}
	for (const entry of concrete) {
		for (const kind of KINDS) {
			const status = stageAgent(paths, kind, entry, staged);
			names.push(agentName(kind, entry));
			agents.push({ name: agentName(kind, entry), kind, selector: entry, status });
		}
	}

	await assertNoOverrides(paths, cwd, names);
	commitStaged(paths, staged);
	writeRuleAtomic(paths, serializeConfig({ exists: true, roles: canonicalRoles, pool: approvedPool, preamble: existing.preamble, postamble: existing.postamble }));
	return { rulePath: paths.rulePath, agents, confirmed };
}

/** Prepare extra concrete per-arm selectors (all three kinds) without touching the rule. */
export async function prepareModels(
	models: string[],
	query: ModelQuery,
	paths: Paths,
	cwd?: string,
): Promise<{ agents: AgentRecord[] }> {
	const available = query.list();
	// Enforce the approved pool; an empty pool (no rule yet) is the explicit-prepare carve-out.
	const pool = effectivePool(parseConfig(readRuleFile(paths)), available);
	const canonical = models.map((model) => {
		const verdict = validateConcreteSelector(model, available);
		if (!verdict.ok) throw new Error(`prepare: ${verdict.error}`);
		assertInApprovedPool(verdict.selector, verdict.thinking, pool, "prepare");
		return verdict.selector;
	});
	const staged = new Map<string, string>();
	const agents: AgentRecord[] = [];
	const names: string[] = [];
	for (const model of canonical) {
		for (const kind of KINDS) {
			const status = stageAgent(paths, kind, model, staged);
			names.push(agentName(kind, model));
			agents.push({ name: agentName(kind, model), kind, selector: model, status });
		}
	}
	await assertNoOverrides(paths, cwd, names);
	commitStaged(paths, staged);
	return { agents };
}

export interface RoleStatus {
	role: Role;
	panel: boolean;
	kind: AgentKind;
	source: "configured" | "unconfigured";
	entries: { value: string; alias: boolean; available: boolean }[];
	needsSetup: boolean;
}

export function currentRoles(paths: Paths, query: ModelQuery): { roles: RoleStatus[]; needsSetup: boolean } {
	const parsed = parseConfig(readRuleFile(paths));
	const available = query.list();
	const pool = effectivePool(parsed, available);
	const roles: RoleStatus[] = ROLES.map((role) => {
		const configuredEntries = parsed.roles[role];
		const entries = (configuredEntries ?? []).map((value) => {
			const alias = isAlias(value);
			let availableEntry: boolean;
			if (alias) {
				availableEntry = pool.includes(value);
			} else {
				const verdict = validateConcreteSelector(value, available);
				availableEntry = verdict.ok && isPoolMember(verdict.selector, verdict.thinking, pool);
			}
			return { value, alias, available: availableEntry };
		});
		const configured = configuredEntries !== undefined && entries.length > 0;
		return {
			role,
			panel: PANEL_ROLES.includes(role),
			kind: ROLE_KIND[role],
			source: configured ? "configured" : "unconfigured",
			entries,
			needsSetup: entries.length === 0 || entries.some((entry) => !entry.available),
		};
	});
	return { roles, needsSetup: roles.some((role) => role.needsSetup) };
}

export function showConfig(paths: Paths): { path: string; exists: boolean; raw: string; parsed: ParsedConfig } {
	const raw = readRuleFile(paths);
	return { path: paths.rulePath, exists: raw.trim() !== "", raw, parsed: parseConfig(raw) };
}

// ─── Read-only descriptor lookup ─────────────────────────────────────────────

export interface AgentDescriptor {
	agent: string;
	model: string;
	role: Role;
	index: number | undefined;
	kind: AgentKind;
}

function frontmatterField(content: string, field: string): string | undefined {
	return content.match(new RegExp(`^${field}: (.*)$`, "m"))?.[1]?.trim();
}

/**
 * Resolve the prepared native task agent for a role entry. Read-only: missing
 * or stale descriptors error with the fix; unavailable concrete models fail
 * the dispatch instead of substituting another family.
 */
export function resolveRoleAgent(
	params: {
		role: string;
		index?: number;
		kind?: AgentKind;
		model?: string;
		/** Cross-judge auto-selection: first pool entry whose model family differs from the live parent. */
		family?: (model: { provider: string; id: string }) => string;
	},
	query: ModelQuery,
	paths: Paths,
): AgentDescriptor {
	if (!(ROLES as readonly string[]).includes(params.role)) {
		throw new Error(`Unknown role "${params.role}". Roles: ${ROLES.join("; ")}.`);
	}
	const role = params.role as Role;
	const kind = params.kind ?? ROLE_KIND[role];
	const panel = PANEL_ROLES.includes(role);
	const available = query.list();
	const parsed = parseConfig(readRuleFile(paths));
	const pool = effectivePool(parsed, available);
	const entries = entriesFor(parsed, role);

	let selector: string;
	let index: number | undefined;
	if (params.model !== undefined) {
		// Explicit per-arm override: works even when the role line is missing/empty.
		selector = params.model.trim();
	} else {
		if (entries.length === 0) {
			throw new Error(`Role "${role}" is not configured. Run /setup-pstack or pstack_models save to choose a model for it.`);
		}
		if (panel) {
			if (params.index === undefined) {
				if (role === "arena cross-judge pool" && params.family) {
					index = pickCrossJudge(entries, { list: () => available, current: () => query.current(), family: params.family }).index;
				} else {
					throw new Error(`Role "${role}" is a panel role with ${entries.length} entries; pass index (1-based).`);
				}
			} else if (params.index < 1 || params.index > entries.length) {
				throw new Error(`Role "${role}" index ${params.index} is out of range; the panel has ${entries.length} ordered entries (duplicates included).`);
			} else {
				index = params.index;
			}
			selector = entries[index! - 1]!;
		} else {
			if (params.index !== undefined && params.index !== 1) throw new Error(`Role "${role}" is a scalar role; it takes no index.`);
			selector = entries[0]!;
		}
	}

	const alias = isAlias(selector);
	let thinking: string | undefined;
	if (!alias) {
		const verdict = validateConcreteSelector(selector, available);
		if (!verdict.ok) {
			throw new Error(`${role}: configured model ${selector} is not available in this session. Rerun /setup-pstack; no other family is substituted.`);
		}
		selector = verdict.selector;
		thinking = verdict.thinking;
	}
	assertInApprovedPool(selector, thinking, pool, `${role}${panel && index !== undefined ? `[${index}]` : ""}`);
	const name = agentName(kind, alias ? ALIAS_TOKEN : selector);
	const file = readAgentFile(paths, name);
	if (file === undefined) {
		throw new Error(`No prepared descriptor for ${role} (kind ${kind}${alias ? ", alias" : `, selector ${selector}`}). Run /setup-pstack or pstack_models prepare; descriptors are never generated inside a read-only planning dispatch.`);
	}
	if (file !== agentFile(kind, alias ? undefined : selector)) {
		throw new Error(`Prepared descriptor ${name} differs from its immutable template; inspect the collision before rerunning /setup-pstack.`);
	}
	if (alias) {
		const parent = query.current();
		if (!parent) throw new Error(`${role}: no live parent model is selected.`);
		return { agent: name, model: `${parent.provider}/${parent.id}`, role, index: panel ? index : undefined, kind };
	}
	return { agent: name, model: selector, role, index: panel ? index : undefined, kind };
}

/**
 * The descriptor bytes live in the profile, but native task discovery resolves
 * project `.omp/agents` before user agents (task/discovery.ts), so a workspace
 * file can shadow a known `omp-pstack-*` name. Dispatch must require the
 * effective agent for the current cwd to be exactly the prepared profile file.
 */
export async function assertUnshadowedAgent(name: string, cwd: string | undefined, paths: Paths): Promise<void> {
	const { agents } = await discoverAgents(cwd ?? process.cwd());
	const effective = agents.find((agent) => agent.name === name);
	const prepared = join(paths.agentsDir, `${name}.md`);
	const effectivePath = effective?.filePath;
	const sameFile = effectivePath !== undefined && (() => {
		try { return realpathSync(effectivePath) === realpathSync(prepared); } catch { return effectivePath === prepared; }
	})();
	if (!sameFile) {
		throw new Error(`Effective native agent "${name}" for ${cwd ?? process.cwd()} is not the prepared P Stack descriptor (${prepared}); it resolves to ${effectivePath ?? "nothing"}. A project or package agent is shadowing the profile descriptor — remove or rename that agent before dispatching.`);
	}
}

/**
 * Arena cross-judge: resolve pool entries against the live parent and pick the
 * first entry whose model family differs from the parent's; otherwise the
 * first configured entry. Alias entries resolve to the parent, so they can
 * never satisfy the family difference.
 */
export function pickCrossJudge(
	pool: string[],
	query: ModelQuery & { family(model: PstackModel): string },
): { selector: string; index: number; model?: PstackModel } {
	const parent = query.current();
	const parentFamily = parent ? query.family(parent) : undefined;
	const resolve = (selector: string): PstackModel | undefined => {
		if (isAlias(selector)) return parent;
		const verdict = validateConcreteSelector(selector, query.list());
		return verdict.ok ? exactModel(`${verdict.provider}/${verdict.id}`, query.list()) : undefined;
	};
	for (const [index, selector] of pool.entries()) {
		const model = resolve(selector);
		if (model && parentFamily && query.family(model) !== parentFamily) {
			return { selector, index: index + 1, model };
		}
	}
	const first = pool[0];
	return { selector: first ?? "", index: 1, model: first ? resolve(first) : undefined };
}

// ─── Extension registration ──────────────────────────────────────────────────

function errorResult(error: unknown): { content: { type: "text"; text: string }[]; isError: true; details: { error: string } } {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: message }], isError: true, details: { error: message } };
}

export function registerModels(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "task") return;
		const tasks = "tasks" in event.input ? event.input.tasks : undefined;
		const candidates: unknown[] = [event.input, ...(Array.isArray(tasks) ? tasks : [])];
		const names = candidates.flatMap((task) => task && typeof task === "object" && "agent" in task && typeof task.agent === "string" && task.agent.startsWith("omp-pstack-") ? [task.agent] : []);
		if (!names.length) return;
		try {
			const paths = resolvePaths();
			await assertNoOverrides(paths, ctx.cwd, names);
			const pool = effectivePool(parseConfig(readRuleFile(paths)), ctx.models.list());
			for (const name of names) {
				const content = readAgentFile(paths, name);
				if (!content) throw new Error(`Prepared P Stack descriptor ${name} is missing.`);
				const selector = frontmatterField(content, "model");
				if (!KINDS.some((kind) => name === agentName(kind, selector ?? ALIAS_TOKEN) && content === agentFile(kind, selector))) {
					throw new Error(`Prepared P Stack descriptor ${name} was changed; inspect it before dispatch.`);
				}
				if (selector) {
					const verdict = validateConcreteSelector(selector, ctx.models.list());
					if (!verdict.ok) throw new Error(verdict.error);
					assertInApprovedPool(verdict.selector, verdict.thinking, pool, `agent ${name}`);
				} else {
					assertInApprovedPool(ALIAS_TOKEN, undefined, pool, `agent ${name}`);
					if (!ctx.models.current()) throw new Error("P Stack alias dispatch requires a live parent model.");
				}
			}
			// Project/package agents resolve before the profile in native discovery;
			// byte-checking the profile file alone would let a workspace shadow win.
			for (const name of names) {
				await assertUnshadowedAgent(name, ctx.cwd, paths);
			}
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
	});
	const z = pi.zod;
	pi.registerTool({
		name: "pstack_models",
		label: "P Stack models",
		description:
			"Inspect authenticated model identities and configure all P Stack role mappings against an explicit approved pool. list: available models with selector/name/family/reasoning/efforts, the approved pool, per-role configuration and availability. show: raw rule and parsed roles. save: validate the full 18-role choice against an explicit pool, publish immutable native descriptors, then atomically publish the managed rule. prepare: extra concrete per-arm selectors constrained to the pool. Failed publication never points the role configuration at incomplete descriptors.",
		parameters: z.object({
			action: z.enum(["list", "show", "save", "prepare"]),
			roles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
			models: z.array(z.string()).optional(),
			pool: z.array(z.string()).describe("Approved selectors (concrete provider/id base identities plus `inherit-parent`/`auto` alias permission). Required for save.").optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as {
				action: "list" | "show" | "save" | "prepare";
				roles?: Record<string, RoleInput>;
				models?: string[];
				pool?: string[];
			};
			const paths = resolvePaths();
			try {
				if (input.action === "list") {
					const current = ctx.models.current();
					const result = {
						...currentRoles(paths, ctx.models),
						pool: effectivePool(parseConfig(readRuleFile(paths)), ctx.models.list()),
						models: ctx.models.list().map((model) => ({
							selector: `${model.provider}/${model.id}`,
							name: model.name,
							family: ctx.models.family(model),
							reasoning: model.reasoning,
							efforts: model.thinking?.efforts,
						})),
						current: current && `${current.provider}/${current.id}`,
					};
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result),
							},
						],
						details: result,
					};
				}
				if (input.action === "show") {
					const result = showConfig(paths);
					return { content: [{ type: "text", text: result.raw || "(no configuration saved yet)" }], details: result };
				}
				if (input.action === "save") {
					if (!input.roles || Object.keys(input.roles).length === 0) {
						return errorResult("save requires the full explicit roles choice; an absent choice writes nothing.");
					}
					if (!input.pool || input.pool.some((p) => p.trim() !== "") === false) {
						return errorResult("save requires an explicit pool of approved model selectors; an absent pool writes nothing.");
					}
					const result = await saveRoles(input.roles, ctx.models, paths, ctx.cwd, input.pool);
					const created = result.agents.filter((a) => a.status === "created").length;
					return {
						content: [{ type: "text", text: `Saved ${result.rulePath} and ${created} newly generated agents (${result.agents.length} total prepared).` }],
						details: result,
					};
				}
				if (!input.models || input.models.length === 0) {
					return errorResult("prepare requires an explicit models array of concrete selectors.");
				}
				const result = await prepareModels(input.models, ctx.models, paths, ctx.cwd);
				return {
					content: [{ type: "text", text: `Prepared ${result.agents.length} agents for per-arm overrides.` }],
					details: result,
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "pstack_agent",
		label: "P Stack agent",
		description:
			"Read-only lookup of the prepared native task agent for a P Stack role. Returns {agent, model, role, index} for the next ordinary task call. Panel roles need a 1-based index; duplicate selectors are separate ordered entries. Arena cross-judge pool: an explicit index stays a lookup; omitting index auto-selects the first pool entry whose model family differs from the live parent (otherwise the first entry). Never launches anything; missing descriptors must be fixed by /setup-pstack outside plan mode.",
		parameters: z.object({
			role: z.string(),
			index: z.number().int().nullable().describe("1-based panel index; null for a scalar role. Omit it on 'arena cross-judge pool' to auto-select by model family.").optional(),
			kind: z.enum(["poteto", "general", "readonly"]).nullable().describe("Null selects the configured role's agent kind. Set only for an explicit kind override.").optional(),
			model: z.string().min(1).nullable().describe("Null selects the saved role/index, including ordered panel members. Set a selector only for an explicit, already-prepared per-arm override that is also a member of the approved pool; never invent one.").optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as { role: string; index?: number | null; kind?: AgentKind | null; model?: string | null };
			try {
				const paths = resolvePaths();
				const descriptor = resolveRoleAgent(
					{
						role: input.role,
						index: input.index ?? undefined,
						kind: input.kind ?? undefined,
						model: input.model ?? undefined,
						family: (model) => ctx.models.family(model as never),
					},
					ctx.models,
					paths,
				);
				await assertNoOverrides(paths, ctx.cwd, [descriptor.agent]);
				await assertUnshadowedAgent(descriptor.agent, ctx.cwd, paths);
				const position = descriptor.index ? `, entry ${descriptor.index}` : "";
				return {
					content: [{ type: "text", text: `Dispatch native task with agent: ${descriptor.agent} (role ${descriptor.role}${position}, model ${descriptor.model}).` }],
					details: descriptor,
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
