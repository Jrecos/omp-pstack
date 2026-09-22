import { test, expect } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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
	const pluginsRoot = join(temporary, "plugins");
	const oldRoot = join(pluginsRoot, "cache", "plugins", "omp-pstack___omp-pstack___1.1.6");
	const newRoot = join(pluginsRoot, "cache", "plugins", "omp-pstack___omp-pstack___1.1.7");
	const runtimeLink = join(pluginsRoot, "node_modules", "omp-pstack");
	try {
		await mkdir(join(oldRoot, "src"), { recursive: true });
		await mkdir(newRoot, { recursive: true });
		await mkdir(join(pluginsRoot, "node_modules"), { recursive: true });
		await cp(join(packageRoot, "skills"), join(oldRoot, "skills"), { recursive: true });
		await cp(join(packageRoot, "skills"), join(newRoot, "skills"), { recursive: true });
		await cp(join(packageRoot, "src", "extension.ts"), join(oldRoot, "src", "extension.ts"));
		for (const name of ["mode.ts", "history.ts", "models.ts"]) {
			await symlink(join(packageRoot, "src", name), join(oldRoot, "src", name));
		}
		await symlink(oldRoot, runtimeLink, "dir");
		// A static import cannot model a prepared module whose runtime-selected install path later disappears.
		const factory = (await import(`${runtimeLink}/src/extension.ts?plugin-update=${Date.now()}`)).default;
		await unlink(runtimeLink);
		await rm(oldRoot, { recursive: true, force: true });
		await symlink(newRoot, runtimeLink, "dir");

		const harness = extensionHarness();
		factory(harness.api);
		const context = {
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		for (const handler of harness.handlers.get("session_start") ?? []) await handler({}, context);
		await harness.commands.get("how")?.handler("", context);

		expect(harness.messages).toHaveLength(1);
		const encodedSource = / source=("[^"]+")>/.exec(harness.messages[0]!)?.[1];
		expect(encodedSource).toBeDefined();
		const source = JSON.parse(encodedSource!);
		expect(source).not.toContain("/cache/plugins/");
		expect(await Bun.file(source).exists()).toBe(true);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
