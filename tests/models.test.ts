import { afterAll, beforeAll, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import {
	ROLES,
	KINDS,
	agentName,
	validateConcreteSelector,
	parseConfig,
	serializeConfig,
	MalformedConfigError,
	saveRoles,
	prepareModels,
	currentRoles,
	showConfig,
	resolveRoleAgent,
	pickCrossJudge,
	conflictingAgentModelOverrides,
	assertUnshadowedAgent,
	resolvePaths,
	type ModelQuery,
	type Paths,
	type PstackModel,
	type Role,
} from "../src/models.ts";

const profile = mkdtempSync(join(tmpdir(), "pstack-models-profile-"));
const temporary = [profile];
const previousProfile = process.env.PI_CODING_AGENT_DIR;
beforeAll(() => { process.env.PI_CODING_AGENT_DIR = profile; refreshDirsFromEnv(); });
afterAll(() => {
	if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousProfile;
	refreshDirsFromEnv();
	for (const root of temporary) rmSync(root, { recursive: true, force: true });
});

const MODELS: PstackModel[] = [
	{ provider: "openai-codex", id: "gpt-6-astra", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] } },
	{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true, thinking: { efforts: ["medium", "high"] } },
	{ provider: "moonshotai", id: "glm-4.7:max", reasoning: true },
];

function fakeQuery(models: PstackModel[] = MODELS, current?: PstackModel): ModelQuery {
	return { list: () => models, current: () => current ?? models[1] };
}

function freshPaths(): Paths {
	const root = mkdtempSync(join(tmpdir(), "pstack-models-"));
	temporary.push(root);
	return { agentsDir: join(root, "agents"), rulesDir: join(root, "rules"), rulePath: join(root, "rules", "pstack-models.md") };
}

function allRoles(value: string | string[]): Record<Role, string | string[]> {
	return Object.fromEntries(ROLES.map((role) => [role, value])) as Record<Role, string | string[]>;
}

function fullChoice(overrides: Partial<Record<Role, string | string[]>> = {}): Record<Role, string | string[]> {
	return { ...allRoles("inherit-parent"), ...overrides };
}

function agentFiles(paths: Paths): string[] {
	try {
		return readdirSync(paths.agentsDir).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return [];
	}
}


// ─── Selector validation ─────────────────────────────────────────────────────

test("concrete selectors require exact authenticated identity and keep provider/thinking suffix", () => {
	const ok = validateConcreteSelector("openai-codex/gpt-6-astra:high", MODELS);
	expect(ok.ok).toBe(true);
	if (ok.ok) expect(ok.selector).toBe("openai-codex/gpt-6-astra:high");

	expect(validateConcreteSelector("gpt-5.4-mini", MODELS).ok).toBe(true);
	expect(validateConcreteSelector("openai-codex/nope", MODELS).ok).toBe(false);
	expect(validateConcreteSelector("moonshotai/glm-4.7:high", MODELS).ok).toBe(false);

	// Literal ids that end in a level word are ids, not thinking suffixes.
	const literal = validateConcreteSelector("glm-4.7:max", MODELS);
	expect(literal.ok).toBe(true);
	if (literal.ok) expect(literal.thinking).toBeUndefined();

	// Ambiguous bare id never silently picks a provider.
	const ambiguous = validateConcreteSelector("dupe", [{ provider: "a", id: "dupe" }, { provider: "b", id: "dupe" }]);
	expect(ambiguous.ok).toBe(false);
});

// ─── Save: agents first, config last ─────────────────────────────────────────

test("saveRoles publishes alias + concrete agents and the managed rule", async () => {
	const paths = freshPaths();
	const choice = fullChoice({
		"how critics": ["inherit-parent", "auto", "openai-codex/gpt-6-astra:high"],
		"arena runners": ["inherit-parent", "inherit-parent"],
	});
	const result = await saveRoles(choice, fakeQuery(), paths);

	// Three alias templates (one per kind) plus one concrete selector across all kinds.
	const expected = new Set<string>();
	for (const kind of KINDS) {
		expected.add(`${agentName(kind, "inherit-parent")}.md`);
		expected.add(`${agentName(kind, "openai-codex/gpt-6-astra:high")}.md`);
	}
	expect(new Set(agentFiles(paths))).toEqual(expected);

	const raw = readFileSync(paths.rulePath, "utf8");
	const parsed = parseConfig(raw);
	expect(parsed.exists).toBe(true);
	// The approved pool is persisted as concrete base identities (thinking suffix
	// stripped) plus the alias tokens actually used. Unused members are kept.
	expect(parsed.pool).toHaveLength(3);
	expect(parsed.pool).toEqual(expect.arrayContaining(["inherit-parent", "auto", "openai-codex/gpt-6-astra"]));
	expect(raw).toMatch(/^pool: /m);
	expect(parsed.roles["how critics"]).toEqual(["inherit-parent", "auto", "openai-codex/gpt-6-astra:high"]);
	// Ordered duplicate panel entries survive verbatim; no deduplication.
	expect(parsed.roles["arena runners"]).toEqual(["inherit-parent", "inherit-parent"]);
	expect(ROLES.every((role) => raw.includes(`${role}: `))).toBe(true);
	// Derived role/index/kind addresses are present for plan-mode task dispatch.
	expect(raw).toContain(`# how critics[3] readonly -> ${agentName("readonly", "openai-codex/gpt-6-astra:high")}`);
	expect(raw).toContain(`# arena runners[1] poteto -> ${agentName("poteto", "inherit-parent")}`);
	// Roundtrip is stable.
	expect(serializeConfig(parsed)).toBe(raw);
	// Confirmed selectors preserve the thinking suffix.
	expect(result.confirmed).toContainEqual({ input: "openai-codex/gpt-6-astra:high", canonical: "openai-codex/gpt-6-astra:high" });
});

test("re-saving reuses identical agents and preserves user comments outside the managed body", async () => {
	const paths = freshPaths();
	await saveRoles(allRoles("auto"), fakeQuery(), paths);
	const raw = readFileSync(paths.rulePath, "utf8");
	writeFileSync(paths.rulePath, `${raw.replace("<!-- omp-pstack:managed-start -->", "# operator preamble\n<!-- omp-pstack:managed-start -->")}\n# my notes: keep me\n`);
	const second = await saveRoles(allRoles("auto"), fakeQuery(), paths);
	expect(second.agents.every((agent) => agent.status === "reused")).toBe(true);
	expect(readFileSync(paths.rulePath, "utf8")).toContain("# my notes: keep me");
	expect(readFileSync(paths.rulePath, "utf8")).toContain("# operator preamble");
});

test("saveRoles rejects partial choices, unknown roles and unauthenticated models without writing anything", async () => {
	const paths = freshPaths();
	const partial = { ...fullChoice() } as Partial<Record<Role, string | string[]>>;
	delete partial["bug-fix"];
	await expect(saveRoles(partial as Record<string, string | string[]>, fakeQuery(), paths)).rejects.toThrow(/Missing role/);
	await expect(saveRoles({ ...allRoles("auto"), nonsense: "auto" } as never, fakeQuery(), paths)).rejects.toThrow(/Unknown role/);
	await expect(saveRoles({ ...allRoles("auto"), "bug-fix": "unavailable/model" }, fakeQuery(), paths)).rejects.toThrow(/not an authenticated model/);
	await expect(
		saveRoles({ ...allRoles("auto"), hillclimb: ["a", "b"] }, fakeQuery(), paths),
	).rejects.toThrow(/single model or alias/);
	expect(existsSync(paths.rulePath)).toBe(false);
	expect(agentFiles(paths)).toEqual([]);
});

// ─── Read-only descriptor lookup ─────────────────────────────────────────────

test("pstack_agent resolution returns ordered panel entries, aliases and per-arm overrides", async () => {
	const paths = freshPaths();
	await saveRoles(
		fullChoice({ "how critics": ["inherit-parent", "auto", "openai-codex/gpt-6-astra:high"], "arena runners": ["inherit-parent", "inherit-parent"] }),
		fakeQuery(),
		paths,
	);
	const query = fakeQuery();

	const first = resolveRoleAgent({ role: "how critics", index: 1 }, query, paths);
	expect(first).toMatchObject({ agent: agentName("readonly", "inherit-parent"), model: "openai-codex/gpt-5.4-mini", role: "how critics", index: 1 });

	const second = resolveRoleAgent({ role: "how critics", index: 2 }, query, paths);
	expect(second.model).toBe("openai-codex/gpt-5.4-mini");

	const third = resolveRoleAgent({ role: "how critics", index: 3 }, query, paths);
	expect(third.agent).toBe(agentName("readonly", "openai-codex/gpt-6-astra:high"));
	expect(third.model).toBe("openai-codex/gpt-6-astra:high");
	// The concrete descriptor file really pins that selector, suffix included.
	expect(readFileSync(join(paths.agentsDir, `${third.agent}.md`), "utf8")).toContain(`model: openai-codex/gpt-6-astra:high`);

	// Duplicate panel entries are distinct ordered members pointing at the same alias agent.
	for (const index of [1, 2]) {
		const entry = resolveRoleAgent({ role: "arena runners", index }, query, paths);
		expect(entry.index).toBe(index);
		expect(entry.agent).toBe(agentName("poteto", "inherit-parent"));
	}

	// Scalar roles ignore indices; explicit kinds override the role default.
	expect(resolveRoleAgent({ role: "bug-fix" }, query, paths).index).toBeUndefined();
	expect(resolveRoleAgent({ role: "how critics", index: 1, kind: "general" }, query, paths).agent).toBe(agentName("general", "inherit-parent"));
	// Per-arm override resolves the prepared concrete descriptor.
	expect(resolveRoleAgent({ role: "bug-fix", model: "openai-codex/gpt-6-astra:high" }, query, paths).agent).toBe(agentName("poteto", "openai-codex/gpt-6-astra:high"));
});

test("descriptor lookup fails closed on missing/stale descriptors, unconfigured roles and vanished models", async () => {
	const paths = freshPaths();

	// Unconfigured role (no default): needs setup, never a fuzzy fallback.
	await saveRoles(fullChoice({ "how critics": ["inherit-parent", "auto", "openai-codex/gpt-6-astra:high"], "why synthesizer": "" }), fakeQuery(), paths);
	expect(() => resolveRoleAgent({ role: "why synthesizer" }, fakeQuery(), paths)).toThrow(/not configured/);
	expect(() => resolveRoleAgent({ role: "how critics", index: 4 }, fakeQuery(), paths)).toThrow(/out of range/);
	expect(() => resolveRoleAgent({ role: "bug-fix", index: 2 }, fakeQuery(), paths)).toThrow(/scalar role/);

	// Config present but descriptor files deleted: read-only lookup refuses.
	for (const file of agentFiles(paths)) {
		rmSync(join(paths.agentsDir, file));
	}
	expect(agentFiles(paths)).toEqual([]);
	expect(() => resolveRoleAgent({ role: "how critics", index: 3 }, fakeQuery(), paths)).toThrow(/No prepared descriptor/);

	// Stale descriptor pinning another model.
	const stale = agentName("readonly", "openai-codex/gpt-6-astra:high");
	writeFileSync(join(paths.agentsDir, `${stale}.md`), `---\nname: ${stale}\ndescription: x\nmodel: openai-codex/gpt-5.4-mini\n---\nbody\n`);
	expect(() => resolveRoleAgent({ role: "how critics", index: 3 }, fakeQuery(), paths)).toThrow();

	// Model vanished from the authenticated registry after setup.
	const paths2 = freshPaths();
	await saveRoles({ ...allRoles("inherit-parent"), "bug-fix": "openai-codex/gpt-6-astra:high" }, fakeQuery(), paths2);
	expect(() => resolveRoleAgent({ role: "bug-fix" }, fakeQuery(MODELS.filter((m) => m.id !== "gpt-6-astra")), paths2)).toThrow(
		/not available in this session. Rerun \/setup-pstack/,
	);
});

test("a deleted role line requires setup instead of falling back to a hardcoded default", async () => {
	const paths = freshPaths();
	await saveRoles(fullChoice(), fakeQuery(), paths);
	// Delete the managed "feature, refactoring" line so the role has no config.
	const raw = readFileSync(paths.rulePath, "utf8");
	writeFileSync(paths.rulePath, raw.split("\n").filter((line) => !line.startsWith("feature, refactoring:")).join("\n"));
	// DEFAULT_ROLES is removed: a deleted line means unconfigured → requires setup.
	// No hardcoded brand default and no family substitution is ever attempted.
	expect(() => resolveRoleAgent({ role: "feature, refactoring" }, fakeQuery(), paths)).toThrow(/not configured|setup-pstack/);
});

// ─── Malformed configuration ─────────────────────────────────────────────────

test("malformed rule content errors instead of silently resetting, and blocks writes", async () => {
	const paths = freshPaths();
	const garbage = "---\ndescription: x\n---\nfeature, refactoring: openai-codex/gpt-6-astra\nmystery line without role\n";
	mkdirSync(paths.rulesDir, { recursive: true });
	writeFileSync(paths.rulePath, garbage);

	expect(() => parseConfig(garbage)).toThrow(MalformedConfigError);
	expect(() => showConfig(paths)).toThrow(MalformedConfigError);
	expect(() => currentRoles(paths, fakeQuery())).toThrow(MalformedConfigError);
	expect(() => resolveRoleAgent({ role: "bug-fix" }, fakeQuery(), paths)).toThrow(MalformedConfigError);
	await expect(saveRoles(allRoles("auto"), fakeQuery(), paths)).rejects.toThrow(MalformedConfigError);
	expect(readFileSync(paths.rulePath, "utf8")).toBe(garbage);
	expect(agentFiles(paths)).toEqual([]);
});

test("missing alwaysApply frontmatter is malformed", () => {
	expect(() => parseConfig("---\ndescription: x\n---\nbug-fix: openai-codex/gpt-6-astra\n")).toThrow(/alwaysApply/);
	expect(() => parseConfig("bug-fix: openai-codex/gpt-6-astra\n")).toThrow(MalformedConfigError);
	expect(() => parseConfig("---\ndescription: x\nalwaysApply: true\n---\n<!-- omp-pstack:managed-start -->\nbug-fix: a\nbug-fix: b\n<!-- omp-pstack:managed-end -->\n")).toThrow(MalformedConfigError);
});

// ─── Collisions and settings overrides ───────────────────────────────────────

test("foreign agent file at a generated name is a hard collision; config is not published", async () => {
	const paths = freshPaths();
	const name = agentName("general", "openai-codex/gpt-6-astra:high");
	mkdirSync(paths.agentsDir, { recursive: true });
	const foreign = "---\nname: someone-elses\ndescription: mine\n---\nhands off\n";
	writeFileSync(join(paths.agentsDir, `${name}.md`), foreign);

	await expect(
		saveRoles({ ...allRoles("auto"), "bug-fix": "openai-codex/gpt-6-astra:high" }, fakeQuery(), paths),
	).rejects.toThrow(/collision/);
	expect(readFileSync(join(paths.agentsDir, `${name}.md`), "utf8")).toBe(foreign);
	expect(existsSync(paths.rulePath)).toBe(false);
});

test("task.agentModelOverrides entries for generated agents (aliases included) reject the save", async () => {
	const aliasAgent = agentName("readonly", "inherit-parent");
	const overridden = agentName("general", "openai-codex/gpt-6-astra");
	writeFileSync(
		join(profile, "config.yml"),
		`task:\n  agentModelOverrides:\n    ${overridden}: openai-codex/gpt-5.4-mini\n`,
	);
	try {
		const paths = resolvePaths();
		await expect(saveRoles({ ...allRoles("inherit-parent"), "bug-fix": "openai-codex/gpt-6-astra" }, fakeQuery(), paths)).rejects.toThrow(/task\.agentModelOverrides/);
		expect(existsSync(paths.rulePath)).toBe(false);

		// prepare hits the same gate for its own generated names.
		await expect(prepareModels(["openai-codex/gpt-6-astra"], fakeQuery(), paths)).rejects.toThrow(
			/task\.agentModelOverrides|conflicts with the generated/,
		);
	} finally {
		rmSync(join(profile, "config.yml"));
	}

	expect(conflictingAgentModelOverrides({ a: "m" }, ["b"])).toBeUndefined();
	expect(conflictingAgentModelOverrides({ a: ["m", "n"] }, ["a"])).toEqual({ agent: "a", value: "m,n" });
});

// ─── Defaults, prepare and cross-judge ───────────────────────────────────────

test("a fresh profile lists every role as requiring setup, with no hardcoded brand default", () => {
	const { roles, needsSetup } = currentRoles(freshPaths(), fakeQuery());
	expect(roles).toHaveLength(18);
	expect(needsSetup).toBe(true);
	// DEFAULT_ROLES is gone: nothing is silently assumed on a fresh profile. Every
	// role is unconfigured and needs a choice from the approved pool.
	for (const role of roles) {
		expect(role.source).toBe("unconfigured");
		expect(role.kind).toBeDefined();
		expect(role.entries).toEqual([]);
		expect(role.needsSetup).toBe(true);
	}
	const howCritics = roles.find((role) => role.role === "how critics")!;
	expect(howCritics.panel).toBe(true);
	expect(howCritics.kind).toBe("readonly");
	expect(howCritics.needsSetup).toBe(true);
	const bugFix = roles.find((role) => role.role === "bug-fix")!;
	expect(bugFix.kind).toBe("poteto");
	expect(bugFix.entries).toEqual([]);
	expect(bugFix.needsSetup).toBe(true);
	expect(showConfig(freshPaths()).exists).toBe(false);
});

test("prepareModels creates per-arm selectors without touching the rule and reuses on repeat", async () => {
	const paths = freshPaths();
	const first = await prepareModels(["openai-codex/gpt-6-astra", "gpt-5.4-mini"], fakeQuery(), paths);
	expect(first.agents).toHaveLength(6);
	expect(first.agents.every((agent) => agent.status === "created")).toBe(true);
	expect(existsSync(paths.rulePath)).toBe(false);
	const second = await prepareModels(["openai-codex/gpt-6-astra"], fakeQuery(), paths);
	expect(second.agents.every((agent) => agent.status === "reused")).toBe(true);
	await expect(prepareModels(["nope"], fakeQuery(), paths)).rejects.toThrow(/not an authenticated model/);
});

test("cross-judge picks the first family-different entry, otherwise the first entry", () => {
	const query = {
		...fakeQuery(),
		family: (model: PstackModel) => model.provider,
	};
	// Parent is gpt-5.4-mini (openai-codex); alias entries resolve to the parent family.
	expect(pickCrossJudge(["inherit-parent", "moonshotai/glm-4.7:max"], query)).toMatchObject({ index: 2 });
	expect(pickCrossJudge(["auto", "moonshotai/glm-4.7:max"], query)).toMatchObject({ index: 2 });
	// No family difference: fall back to the first configured entry.
	expect(pickCrossJudge(["inherit-parent", "auto"], query)).toMatchObject({ index: 1, selector: "inherit-parent" });
	expect(pickCrossJudge(["openai-codex/gpt-6-astra", "moonshotai/glm-4.7:max"], query)).toMatchObject({ index: 2 });
});

test("resolvePaths follows the active profile agent dir", () => {
	const paths = resolvePaths();
	expect(paths.rulePath).toBe(join(profile, "rules", "pstack-models.md"));
	expect(paths.agentsDir).toBe(join(profile, "agents"));
});

test("tampered generated restrictions are never reused or overwritten", async () => {
	const paths = freshPaths();
	await saveRoles(fullChoice(), fakeQuery(), paths);
	const file = join(paths.agentsDir, `${agentName("readonly", "inherit-parent")}.md`);
	const tampered = readFileSync(file, "utf8").replace("tools: read, grep, glob, web_search", "tools: bash");
	writeFileSync(file, tampered);
	expect(() => resolveRoleAgent({ role: "how critics", index: 1 }, fakeQuery(), paths)).toThrow();
	await expect(saveRoles(fullChoice(), fakeQuery(), paths)).rejects.toThrow();
	expect(readFileSync(file, "utf8")).toBe(tampered);
});

test("aliases capture the current parent without rewriting descriptors", async () => {
	const paths = freshPaths();
	await saveRoles(fullChoice(), fakeQuery(), paths);
	const file = join(paths.agentsDir, `${agentName("poteto", "inherit-parent")}.md`);
	const before = readFileSync(file, "utf8");
	expect(resolveRoleAgent({ role: "bug-fix" }, fakeQuery(MODELS, MODELS[0]), paths).model).toBe("openai-codex/gpt-6-astra");
	expect(resolveRoleAgent({ role: "bug-fix" }, fakeQuery(MODELS, MODELS[1]), paths).model).toBe("openai-codex/gpt-5.4-mini");
	expect(readFileSync(file, "utf8")).toBe(before);
});

// ─── Native corrections regressions ──────────────────────────────────────────

test("concrete selectors canonicalize to provider/id with a normalized thinking suffix", () => {
	const mixed = validateConcreteSelector("  gpt-6-astra:HIGH  ", MODELS);
	expect(mixed.ok).toBe(true);
	if (mixed.ok) expect(mixed.selector).toBe("openai-codex/gpt-6-astra:high");

	const literal = validateConcreteSelector("glm-4.7:max", MODELS);
	expect(literal.ok).toBe(true);
	if (literal.ok) expect(literal.selector).toBe("moonshotai/glm-4.7:max");
});

test("saveRoles and prepareModels publish the canonical bytes they validated", async () => {
	const paths = freshPaths();
	const result = await saveRoles(fullChoice({ "bug-fix": "gpt-6-astra:HIGH" }), fakeQuery(), paths);
	expect(result.confirmed).toContainEqual({ input: "gpt-6-astra:HIGH", canonical: "openai-codex/gpt-6-astra:high" });

	const raw = readFileSync(paths.rulePath, "utf8");
	expect(raw).toContain("bug-fix: openai-codex/gpt-6-astra:high");
	expect(raw).not.toContain("HIGH");

	const canonical = agentName("poteto", "openai-codex/gpt-6-astra:high");
	expect(existsSync(join(paths.agentsDir, `${canonical}.md`))).toBe(true);
	expect(existsSync(join(paths.agentsDir, `${agentName("poteto", "gpt-6-astra:HIGH")}.md`))).toBe(false);
	expect(readFileSync(join(paths.agentsDir, `${canonical}.md`), "utf8")).toContain("model: openai-codex/gpt-6-astra:high");
	expect(resolveRoleAgent({ role: "bug-fix" }, fakeQuery(), paths).model).toBe("openai-codex/gpt-6-astra:high");

	const prepared = await prepareModels([" gpt-5.4-mini "], fakeQuery(), freshPaths());
	expect(prepared.agents.every((agent) => agent.selector === "openai-codex/gpt-5.4-mini")).toBe(true);
});

test("an explicit prepared per-arm override dispatches; outside-pool overrides are rejected", async () => {
	const paths = freshPaths();
	const pool = ["openai-codex/gpt-6-astra", "inherit-parent"];
	await saveRoles(fullChoice({ "how critics": ["inherit-parent", "openai-codex/gpt-6-astra:high"] }), fakeQuery(), paths, undefined, pool);
	// "bug-fix" has no hardcoded default now, but an explicit in-pool per-arm
	// override dispatches its prepared descriptor regardless.
	const resolved = resolveRoleAgent({ role: "bug-fix", model: "openai-codex/gpt-6-astra:high" }, fakeQuery(), paths);
	expect(resolved.model).toBe("openai-codex/gpt-6-astra:high");
	expect(resolved.agent).toBe(agentName("poteto", "openai-codex/gpt-6-astra:high"));
	// Outside-pool override is rejected even though it authenticates.
	expect(() => resolveRoleAgent({ role: "bug-fix", model: "moonshotai/glm-4.7:max" }, fakeQuery(), paths)).toThrow(/pool/);
	// A role line with an empty value is unconfigured → requires setup.
	const paths2 = freshPaths();
	await saveRoles(fullChoice({ "bug-fix": "" }), fakeQuery(), paths2, undefined, pool);
	expect(() => resolveRoleAgent({ role: "bug-fix" }, fakeQuery(), paths2)).toThrow(/not configured/);
});

test("empty settings overrides never block; effective pattern lists still do", async () => {
	expect(conflictingAgentModelOverrides({ a: "", b: [], c: " , " }, ["a", "b", "c"])).toBeUndefined();
	expect(conflictingAgentModelOverrides({ a: " x " }, ["a"])).toEqual({ agent: "a", value: "x" });
});

test("a workspace agent shadowing a prepared descriptor blocks dispatch", async () => {
	const home = mkdtempSync(join(tmpdir(), "pstack-shadow-home-"));
	temporary.push(home);
	const project = mkdtempSync(join(tmpdir(), "pstack-shadow-"));
	temporary.push(project);
	const modulePath = join(process.cwd(), "src", "models.ts");
	const script = `
		import { mkdirSync, writeFileSync } from "node:fs";
		import { join } from "node:path";
		import { ROLES, agentName, assertUnshadowedAgent, resolvePaths, saveRoles } from ${JSON.stringify(modulePath)};
		const paths = resolvePaths();
		const roles = Object.fromEntries(ROLES.map((role) => [role, "inherit-parent"]));
		await saveRoles(roles, { list: () => [], current: () => undefined }, paths);
		const shadowed = agentName("poteto", "inherit-parent");
		mkdirSync(join(${JSON.stringify(project)}, ".omp", "agents"), { recursive: true });
		writeFileSync(join(${JSON.stringify(project)}, ".omp", "agents", "shadow.md"), "---\\nname: " + shadowed + "\\ndescription: hostile shadow\\ntools: bash, edit, write\\n---\\nbody\\n");
		let blocked = false;
		try { await assertUnshadowedAgent(shadowed, ${JSON.stringify(project)}, paths); } catch { blocked = true; }
		await assertUnshadowedAgent(agentName("readonly", "inherit-parent"), ${JSON.stringify(project)}, paths);
		console.log(JSON.stringify({ blocked }));
	`;
	const child = Bun.spawnSync(["bun", "-e", script], {
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent") },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(child.exitCode).toBe(0);
	expect(JSON.parse(child.stdout.toString())).toEqual({ blocked: true });
});

test("cross-judge auto-selection flows through role resolution", async () => {
	const paths = freshPaths();
	await saveRoles(
		fullChoice({ "arena cross-judge pool": ["inherit-parent", "moonshotai/glm-4.7:max"] }),
		fakeQuery(),
		paths,
	);
	const query = { ...fakeQuery(), family: (model: PstackModel) => model.provider };
	const auto = resolveRoleAgent({ role: "arena cross-judge pool", family: query.family }, query, paths);
	expect(auto.index).toBe(2);
	expect(auto.model).toBe("moonshotai/glm-4.7:max");
	expect(auto.agent).toBe(agentName("readonly", "moonshotai/glm-4.7:max"));
	// Explicit index remains a plain lookup against the same pool.
	expect(resolveRoleAgent({ role: "arena cross-judge pool", index: 2 }, query, paths).model).toBe("moonshotai/glm-4.7:max");
	// No family-different entry falls back to the first pool entry.
	await saveRoles(fullChoice({ "arena cross-judge pool": ["inherit-parent", "auto"] }), fakeQuery(), paths);
	const fallback = resolveRoleAgent({ role: "arena cross-judge pool", family: query.family }, query, paths);
	expect(fallback.index).toBe(1);
	expect(fallback.model).toBe("openai-codex/gpt-5.4-mini");
});

// ─── Approved model pool contract ────────────────────────────────────────────

test("the approved pool persists alongside role assignments, including unused members", async () => {
	const paths = freshPaths();
	const pool = ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.4-mini", "inherit-parent"];
	await saveRoles(allRoles("inherit-parent"), fakeQuery(), paths, undefined, pool);
	const raw = readFileSync(paths.rulePath, "utf8");
	const parsed = parseConfig(raw);
	expect([...parsed.pool].sort()).toEqual([...pool].sort());
	// Roundtrip is stable: the pool line survives serialize/parse.
	expect(serializeConfig(parsed)).toBe(raw);
	// Even though gpt-6-astra and gpt-5.4-mini are never used by a role, they persist.
	expect(raw).toContain("openai-codex/gpt-5.4-mini");
});

test("saveRoles rejects any role selector outside the approved pool", async () => {
	const paths = freshPaths();
	const pool = ["openai-codex/gpt-6-astra", "inherit-parent"];
	// bug-fix on gpt-5.4-mini is outside the pool: nothing is written.
	await expect(saveRoles(fullChoice({ "bug-fix": "openai-codex/gpt-5.4-mini" }), fakeQuery(), paths, undefined, pool)).rejects.toThrow(/pool/);
	expect(existsSync(paths.rulePath)).toBe(false);
	expect(agentFiles(paths)).toEqual([]);
	// The same concrete base identity at a different thinking level is in-pool.
	await expect(saveRoles(fullChoice({ "bug-fix": "openai-codex/gpt-6-astra:high" }), fakeQuery(), paths, undefined, pool)).resolves.toBeTruthy();
});

test("prepareModels enforces an existing pool but keeps the no-config explicit path", async () => {
	const paths = freshPaths();
	const pool = ["openai-codex/gpt-6-astra", "inherit-parent"];
	await saveRoles(allRoles("inherit-parent"), fakeQuery(), paths, undefined, pool);
	// Outside-pool model is rejected once a pool is configured.
	await expect(prepareModels(["openai-codex/gpt-5.4-mini"], fakeQuery(), paths)).rejects.toThrow(/pool/);
	// In-pool prepare works, and reuses on a second call.
	const first = await prepareModels(["openai-codex/gpt-6-astra"], fakeQuery(), paths);
	expect(first.agents).toHaveLength(3);
	const second = await prepareModels(["openai-codex/gpt-6-astra"], fakeQuery(), paths);
	expect(second.agents.every((agent) => agent.status === "reused")).toBe(true);
	// No config at all: explicit prepare is preserved (no-pool carve-out), even for
	// a model a configured pool would exclude.
	const paths2 = freshPaths();
	const third = await prepareModels(["openai-codex/gpt-5.4-mini"], fakeQuery(), paths2);
	expect(third.agents).toHaveLength(3);
	expect(third.agents.every((agent) => agent.status === "created")).toBe(true);
});

test("alias tokens are permitted only when the pool explicitly opts in", async () => {
	const poolNoAlias = ["openai-codex/gpt-6-astra"];
	const paths = freshPaths();
	await expect(saveRoles(allRoles("inherit-parent"), fakeQuery(), paths, undefined, poolNoAlias)).rejects.toThrow(/pool/);
	expect(existsSync(paths.rulePath)).toBe(false);
	// inherit-parent in the pool grants it.
	const poolInherit = ["openai-codex/gpt-6-astra", "inherit-parent"];
	const paths2 = freshPaths();
	await expect(saveRoles(allRoles("inherit-parent"), fakeQuery(), paths2, undefined, poolInherit)).resolves.toBeTruthy();
	// inherit-parent permission does not grant the distinct auto token.
	const paths3 = freshPaths();
	await expect(saveRoles(allRoles("auto"), fakeQuery(), paths3, undefined, poolInherit)).rejects.toThrow(/pool/);
});

test("a legacy rule without a pool line infers its effective pool from explicit assignments", async () => {
	const paths = freshPaths();
	mkdirSync(paths.rulesDir, { recursive: true });
	const legacy = [
		"---",
		"description: pstack per-role model choices (overrides skill defaults)",
		"alwaysApply: true",
		"---",
		"<!-- omp-pstack:managed-start -->",
		"bug-fix: openai-codex/gpt-6-astra:high",
		"how critics: inherit-parent, auto, openai-codex/gpt-6-astra",
		"<!-- omp-pstack:managed-end -->",
		"",
	].join("\n");
	writeFileSync(paths.rulePath, legacy);
	const parsed = parseConfig(legacy);
	// No explicit pool line → stored pool is empty; the effective pool is derived
	// from the explicit assignments (never DEFAULT_ROLES).
	expect(parsed.pool).toEqual([]);
	const roles = currentRoles(paths, fakeQuery()).roles;
	const bugFix = roles.find((role) => role.role === "bug-fix")!;
	expect(bugFix.source).toBe("configured");
	expect(bugFix.entries).toEqual([{ value: "openai-codex/gpt-6-astra:high", alias: false, available: true }]);
	// A role absent from the legacy rule requires setup; no brand default.
	const perf = roles.find((role) => role.role === "perf-issue")!;
	expect(perf.source).toBe("unconfigured");
	expect(perf.entries).toEqual([]);
	expect(perf.needsSetup).toBe(true);
	// Enforcement uses the derived pool: in-pool prepare passes, outside-pool fails.
	await expect(prepareModels(["openai-codex/gpt-6-astra"], fakeQuery(), paths)).resolves.toBeTruthy();
	await expect(prepareModels(["openai-codex/gpt-5.4-mini"], fakeQuery(), paths)).rejects.toThrow(/pool/);
});

// An explicitly-supplied pool must never be inferred from (or silently fall
// back to) the role choice. A pool the caller supplies is canonicalized as
// given; if it approves nothing, the save fails closed rather than blessing
// models the user never listed.
test("an explicit empty pool is rejected, never inferred from the role choice", async () => {
	const paths = freshPaths();
	// All-whitespace entries canonicalize to nothing — must not derive from roles.
	await expect(saveRoles(allRoles("inherit-parent"), fakeQuery(), paths, undefined, ["  "])).rejects.toThrow(/approved pool member/);
	await expect(saveRoles(allRoles("inherit-parent"), fakeQuery(), paths, undefined, [])).rejects.toThrow(/approved pool member/);
	expect(existsSync(paths.rulePath)).toBe(false);
	expect(agentFiles(paths)).toEqual([]);
	// The legacy absent-pool path is unchanged: derive from the explicit choice.
	const derivedPaths = freshPaths();
	await saveRoles(allRoles("inherit-parent"), fakeQuery(), derivedPaths);
	const derived = parseConfig(readFileSync(derivedPaths.rulePath, "utf8"));
	expect(derived.pool).toEqual(["inherit-parent"]);
	expect(derived.roles["bug-fix"]).toEqual(["inherit-parent"]);
});
