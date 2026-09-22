import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveInstallAnchor, sameMarketplaceSkill } from "../src/install.ts";

const packageRoot = join(import.meta.dir, "..");

type Handler = (event: unknown, context: ExtensionContext) => unknown;
type Command = { description?: string; handler: (args: string, context: ExtensionContext) => unknown };

function extensionHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const messages: string[] = [];
	const api = {
		setLabel() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool() {},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		getCommands: () => [...commands].map(([name, command]) => ({ name, description: command.description, source: "plugin:omp-pstack" })),
		sendUserMessage(message: string) {
			messages.push(message);
		},
		appendEntry() {},
		logger: { warn() {} },
		zod,
	} as unknown as ExtensionAPI;
	return { api, handlers, commands, messages };
}

test("a prepared extension factory survives its installed version being replaced", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pstack-plugin-update-"));
	const project = join(temporary, "project");
	const sessionCwd = join(project, "packages", "app");
	const pluginsRoot = join(temporary, "shared-plugins");
	const oldRoot = join(pluginsRoot, "cache", "plugins", "omp-pstack___omp-pstack___1.1.6");
	const newRoot = join(pluginsRoot, "cache", "plugins", "omp-pstack___omp-pstack___1.1.7");
	const foreignRoot = join(temporary, "foreign-plugins", "cache", "plugins", "omp-pstack___omp-pstack___9.0.0");
	const runtimeLink = join(project, ".omp", "plugins", "node_modules", "omp-pstack");
	try {
		await mkdir(join(oldRoot, "src"), { recursive: true });
		await mkdir(newRoot, { recursive: true });
		await mkdir(sessionCwd, { recursive: true });
		await mkdir(dirname(runtimeLink), { recursive: true });
		await cp(join(packageRoot, "skills"), join(oldRoot, "skills"), { recursive: true });
		await cp(join(packageRoot, "skills"), join(newRoot, "skills"), { recursive: true });
		await cp(join(packageRoot, "src", "extension.ts"), join(oldRoot, "src", "extension.ts"));
		for (const name of ["install.ts", "mode.ts", "history.ts", "models.ts"]) {
			await symlink(join(packageRoot, "src", name), join(oldRoot, "src", name));
		}
		await symlink(oldRoot, runtimeLink, "dir");
		const factory = (await import(`${runtimeLink}/src/extension.ts?plugin-update=${Date.now()}`)).default;
		const harness = extensionHarness();
		factory(harness.api);
		const context = {
			cwd: sessionCwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		for (const handler of harness.handlers.get("session_start") ?? []) await handler({}, context);
		await unlink(runtimeLink);
		await rm(oldRoot, { recursive: true, force: true });
		await symlink(newRoot, runtimeLink, "dir");

		await harness.commands.get("how")?.handler("", context);

		expect(harness.messages).toHaveLength(1);
		for (const [name, command] of harness.commands) {
			if (name !== "how") await command.handler("", context);
		}
		expect(harness.messages).toHaveLength(harness.commands.size);
		const sources = harness.messages.map((message) => {
			const encodedSource = /^<pstack-skill name="[^"]+" source=("[^"]+")>/.exec(message)?.[1];
			expect(encodedSource).toBeDefined();
			return JSON.parse(encodedSource!) as string;
		});
		expect(new Set(sources).size).toBe(harness.commands.size);
		for (const source of sources) {
			expect(source).not.toContain("/cache/plugins/");
			expect(source.startsWith(join(runtimeLink, "skills"))).toBe(true);
			expect(await Bun.file(source).exists()).toBe(true);
		}

		await cp(join(packageRoot, "skills"), join(foreignRoot, "skills"), { recursive: true });
		await unlink(runtimeLink);
		await symlink(foreignRoot, runtimeLink, "dir");
		await harness.commands.get("how")!.handler("", context);
		const encodedForeignSource = /^<pstack-skill name="how" source=("[^"]+")>/.exec(harness.messages.at(-1)!)?.[1];
		expect(encodedForeignSource).toBeDefined();
		expect(JSON.parse(encodedForeignSource!) as string).toBe(join(oldRoot, "skills", "how", "SKILL.md"));
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("project scope anchors a globally cached install through the project runtime link", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pstack-install-anchor-"));
	try {
		const project = join(realpathSync(temporary), "project");
		const pluginsDir = join(realpathSync(temporary), "plugins");
		const loadedRoot = join(pluginsDir, "cache", "plugins", "omp-pstack___omp-pstack___1.1.6");
		const runtimeLink = join(project, ".omp", "plugins", "node_modules", "omp-pstack");
		await mkdir(join(loadedRoot, "skills", "poteto-mode"), { recursive: true });
		await writeFile(join(loadedRoot, "skills", "poteto-mode", "SKILL.md"), "loaded body");
		await mkdir(dirname(runtimeLink), { recursive: true });
		await symlink(loadedRoot, runtimeLink, "dir");

		const anchor = resolveInstallAnchor(loadedRoot, join(project, "packages", "app", "src"));
		expect(anchor).toEqual({
			loadedRoot,
			stableRoot: runtimeLink,
			cacheIdentity: { cacheParent: dirname(loadedRoot), marketplace: "omp-pstack", plugin: "omp-pstack" },
		});
		expect(sameMarketplaceSkill(join(loadedRoot, "skills", "poteto-mode", "SKILL.md"), anchor.cacheIdentity)).toBe(true);
		expect(sameMarketplaceSkill(join(dirname(loadedRoot), "omp-pstack___omp-pstack___1.1.7", "skills", "poteto-mode", "SKILL.md"), anchor.cacheIdentity)).toBe(true);
		expect(sameMarketplaceSkill(join(runtimeLink, "skills", "poteto-mode", "SKILL.md"), anchor.cacheIdentity)).toBe(false);
		expect(sameMarketplaceSkill("/elsewhere/plugins/cache/plugins/omp-pstack___omp-pstack___1.1.6/skills/poteto-mode/SKILL.md", anchor.cacheIdentity)).toBe(false);
		expect(sameMarketplaceSkill("/elsewhere/skills/poteto-mode/SKILL.md", anchor.cacheIdentity)).toBe(false);

		const cacheAlias = join(realpathSync(temporary), "cache-alias");
		await symlink(join(pluginsDir, "cache"), cacheAlias, "dir");
		expect(sameMarketplaceSkill(join(cacheAlias, "plugins", "omp-pstack___omp-pstack___1.1.5", "skills", "poteto-mode", "SKILL.md"), anchor.cacheIdentity)).toBe(true);

		const globalLink = join(pluginsDir, "node_modules", "omp-pstack");
		const nestedProject = join(project, "packages", "app");
		await mkdir(dirname(globalLink), { recursive: true });
		await symlink(loadedRoot, globalLink, "dir");
		await mkdir(join(nestedProject, ".omp"), { recursive: true });
		const nestedAnchor = resolveInstallAnchor(loadedRoot, join(nestedProject, "src"));
		expect(nestedAnchor.stableRoot).toBe(globalLink);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("a checkout root keeps its own paths and disables the marketplace fallback", () => {
	const anchor = resolveInstallAnchor("/opt/pstack", import.meta.dir);
	expect(anchor).toEqual({ loadedRoot: "/opt/pstack", stableRoot: "/opt/pstack", cacheIdentity: null });
	expect(sameMarketplaceSkill("/opt/pstack/skills/poteto-mode/SKILL.md", anchor.cacheIdentity)).toBe(false);
});
