import { test, expect } from "bun:test";
import { DIRECT_SKILLS, planCommandRegistrations, syncSkillCommands, type CommandRegistrar, type ConflictReporter, type ExistingCommand } from "../src/extension.ts";

const ourDescription = (id: string) => `P Stack /${id} (native alternative /skill:${id})`;

function makeRegistrar(existing: ExistingCommand[], notifyMessages: string[] = []): CommandRegistrar & ConflictReporter & { commands: ExistingCommand[]; registered: string[] } {
	const commands = [...existing];
	return {
		commands,
		registered: [],
		getCommands: () => commands,
		registerCommand(name: string) {
			this.registered.push(name);
			commands.push({ name, description: ourDescription(name), source: "plugin:omp-pstack" });
		},
		notify(message: string, level?: "info" | "warning") {
			notifyMessages.push(`${level ?? "info"}: ${message}`);
		},
	};
}

test("planCommandRegistrations skips foreign owners and reclaims our own commands", () => {
	const foreignHow: ExistingCommand = { name: "how", description: "Someone else's how command", source: "plugin:other", path: "/x/other.ts" };
	const oursHow: ExistingCommand = { name: "how", description: ourDescription("how"), source: "plugin:omp-pstack" };
	const plans = planCommandRegistrations([foreignHow, oursHow], ["how", "tdd"]);
	expect(plans).toEqual([
		{ id: "how", action: "skip", foreign: [foreignHow] },
		{ id: "tdd", action: "register", foreign: [] },
	]);
});

test("syncSkillCommands leaves a foreign /how intact and points at /skill:how", () => {
	const foreignHow: ExistingCommand = { name: "how", description: "Different tool's how", source: "plugin:competitor" };
	const messages: string[] = [];
	const registrar = makeRegistrar([foreignHow], messages);
	syncSkillCommands(registrar, DIRECT_SKILLS.map((id) => ({ id })), registrar);
	expect(registrar.registered).not.toContain("how");
	expect(registrar.registered).toHaveLength(DIRECT_SKILLS.length - 1);
	// The foreign command object survives untouched.
	expect(registrar.getCommands()).toContainEqual(foreignHow);
	const warning = messages.find((message) => message.includes("Command /how belongs to"));
	{
		const withPath: ExistingCommand = { ...foreignHow, path: "/somewhere/else.ts" };
		const messages2: string[] = [];
		const registrar2 = makeRegistrar([withPath], messages2);
		syncSkillCommands(registrar2, [{ id: "how" }], registrar2);
		expect(messages2[0]).toContain("plugin:competitor (/somewhere/else.ts)");
	}
});

test("syncSkillCommands registers the full clean set with no warnings", () => {
	const messages: string[] = [];
	const registrar = makeRegistrar([], messages);
	syncSkillCommands(registrar, DIRECT_SKILLS.map((id) => ({ id })), registrar);
	expect(registrar.registered).toEqual([...DIRECT_SKILLS]);
	expect(messages).toEqual([]);
});

test("syncSkillCommands warns when a built-in still owns the name after registration", () => {
	// Built-ins never appear in getCommands() and registration is a host no-op.
	const builtInOnly = makeRegistrar([], []);
	builtInOnly.registerCommand = (name: string) => {
		builtInOnly.registered.push(name);
		// simulate the host: built-ins are invisible in the snapshot
	};
	const messages: string[] = [];
	syncSkillCommands(builtInOnly, [{ id: "how" }], {
		notify: (message, level) => messages.push(`${level}: ${message}`),
	});
	expect(builtInOnly.registered).toEqual(["how"]);
	expect(messages).toEqual(["warning: Command /how was not registered; a built-in command owns that name. Use /skill:how for P Stack."]);
});

test("syncSkillCommands is idempotent when commands carry our own description", () => {
	const ours: ExistingCommand[] = DIRECT_SKILLS.map((id) => ({ name: id, description: ourDescription(id), source: "plugin:omp-pstack" }));
	const messages: string[] = [];
	const registrar = makeRegistrar(ours, messages);
	syncSkillCommands(registrar, DIRECT_SKILLS.map((id) => ({ id })), registrar);
	expect(registrar.registered).toEqual([...DIRECT_SKILLS]);
	expect(messages).toEqual([]);
});
