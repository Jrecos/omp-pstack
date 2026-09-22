import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveInstallAnchor } from "./install.ts";
import { registerMode } from "./mode.ts";
import type { ModeAnchor } from "./mode.ts";
import { registerHistory } from "./history.ts";
import { registerModels } from "./models.ts";

export const DIRECT_SKILLS = [
  "architect", "arena", "automate-me", "blast-radius", "bro", "create-verification-skill",
  "figure-it-out", "how", "interrogate", "maintain-verification-skill", "make-bot-ui", "no-comments",
  "poteto-mode", "recall", "reflect", "setup-pstack", "show-me-your-work", "swarm", "tdd", "teach",
  "technical-writing", "typescript-best-practices", "unslop", "why",
] as const;

/** Structural subset of the host's slash-command info; matches SlashCommandInfo. */
export interface ExistingCommand {
  name: string;
  description?: string;
  source: string;
  path?: string;
}

export interface CommandPlan {
  id: string;
  action: "register" | "skip";
  foreign: ExistingCommand[];
}

const commandDescription = (id: string) => `P Stack /${id} (native alternative /skill:${id})`;

/**
 * Decides, per P Stack skill id, whether the bare slash command may be claimed
 * in the current command set. Extension command folding is last-write-wins, so
 * registering over a foreign owner (another plugin's extension command, or a
 * same-name prompt command) silently replaces it. A same-name entry that is
 * not ours — identified by our exact description — is foreign: leave it intact
 * and point the session at the namespaced /skill:<id> form instead. Entries
 * with our own description are ours (idempotent re-registration).
 */
export function planCommandRegistrations(commands: readonly ExistingCommand[], ids: readonly string[]): CommandPlan[] {
  return ids.map((id) => {
    const foreign = commands.filter((command) => command.name === id && command.description !== commandDescription(id));
    return foreign.length > 0 ? { id, action: "skip" as const, foreign } : { id, action: "register" as const, foreign: [] };
  });
}

/** Minimal registrar seam so the collision logic is testable without the live runtime. */
export interface CommandRegistrar {
  getCommands(): ExistingCommand[];
  registerCommand(name: string): void;
}

export interface ConflictReporter {
  notify(message: string, level?: "info" | "warning"): void;
}

/**
 * Snapshot the live command set, claim every unowned P Stack name, and report
 * each foreign owner with the /skill:<id> alternative. Names still absent
 * after registration are owned by built-ins, which never appear in the
 * snapshot and which the host skips with its own diagnostic. Idempotent: safe
 * to run on every session_start/session_switch.
 */
export function syncSkillCommands(
  registrar: CommandRegistrar,
  skills: readonly { id: string }[],
  ui: ConflictReporter,
): void {
  for (const plan of planCommandRegistrations(registrar.getCommands(), skills.map((skill) => skill.id))) {
    if (plan.action === "skip") {
      const owners = plan.foreign
        .map((command) => `${command.source}${command.path ? ` (${command.path})` : ""}`)
        .join(", ");
      ui.notify(`Command /${plan.id} belongs to ${owners}; P Stack left it intact. Use /skill:${plan.id} for P Stack.`, "warning");
      continue;
    }
    const skill = skills.find((entry) => entry.id === plan.id)!;
    registrar.registerCommand(skill.id);
  }
  const present = new Set(registrar.getCommands().map((command) => command.name));
  for (const { id } of skills) {
    if (!present.has(id)) {
      ui.notify(`Command /${id} was not registered; a built-in command owns that name. Use /skill:${id} for P Stack.`, "warning");
    }
  }
}

/**
 * Bodies and the loaded skill identity are captured while this version still
 * exists. Runtime-link paths are selected per factory from the session cwd.
 */
const loadedRoot = realpathSync(join(import.meta.dir, ".."));
const skillBodies = DIRECT_SKILLS.map((id) => ({
  id,
  body: readFileSync(join(loadedRoot, "skills", id, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
}));
const modeBody = skillBodies.find((skill) => skill.id === "poteto-mode")!.body;
const loadedModeSkillPath = realpathSync(join(loadedRoot, "skills", "poteto-mode", "SKILL.md"));

interface SessionAssets {
  readonly cwd: string;
  readonly stableRoot: string;
  readonly skills: ReadonlyArray<{ readonly id: string; readonly path: string; readonly body: string }>;
  readonly modeAnchor: ModeAnchor;
}

export default function pstack(pi: ExtensionAPI) {
  pi.setLabel("OMP P Stack");
  let currentAssets: SessionAssets | null = null;
  const assetsFor = (cwd: string): SessionAssets => {
    const normalizedCwd = resolve(cwd);
    const anchor = resolveInstallAnchor(loadedRoot, normalizedCwd);
    if (currentAssets?.cwd === normalizedCwd && currentAssets.stableRoot === anchor.stableRoot) return currentAssets;
    const skills = skillBodies.map((skill) => ({
      ...skill,
      path: join(anchor.stableRoot, "skills", skill.id, "SKILL.md"),
    }));
    currentAssets = {
      cwd: normalizedCwd,
      stableRoot: anchor.stableRoot,
      skills,
      modeAnchor: {
        loadedSkillPath: loadedModeSkillPath,
        stableSkillDir: dirname(skills.find((skill) => skill.id === "poteto-mode")!.path),
        cacheIdentity: anchor.cacheIdentity,
      },
    };
    return currentAssets;
  };
  const mode = registerMode(pi, (ctx) => assetsFor(ctx.cwd).modeAnchor, modeBody);
  registerHistory(pi);
  registerModels(pi);

  // Bare commands register at session_start, the first moment the host exposes
  // the live command set. Registering during load is blind: extension command
  // folding is last-write-wins by load order and no load-time API can observe a
  // foreign extension's commands, so a pre-existing user/plugin /how would be
  // silently replaced. Snapshot first; leave every foreign owner intact and
  // report the namespaced /skill:<id> alternative.
  const registerSkillCommand = (id: string) => {
    pi.registerCommand(id, {
      description: commandDescription(id),
      async handler(args, ctx) {
        if (id === "poteto-mode") {
          if (args.trim() === "off" || args.trim() === "status") {
            const active = args.trim() === "off" ? mode.set(false, ctx) : mode.status(ctx);
            ctx.ui.notify(`Poteto mode ${active ? "active" : "inactive"}.`, "info");
            return;
          }
          mode.set(true, ctx);
        }
        const skill = assetsFor(ctx.cwd).skills.find((entry) => entry.id === id)!;
        pi.sendUserMessage(`<pstack-skill name=${JSON.stringify(id)} source=${JSON.stringify(skill.path)}>\n${skill.body}\n</pstack-skill>\n\nUser arguments:\n${args}`);
      },
    });
  };

  const syncCommands = (ctx: ExtensionContext) => {
    const assets = assetsFor(ctx.cwd);
    syncSkillCommands(
      {
        getCommands: () => pi.getCommands(),
        registerCommand: registerSkillCommand,
      },
      assets.skills,
      ctx.ui,
    );
  };

  pi.on("session_start", (_event, ctx) => syncCommands(ctx));
  pi.on("session_switch", (_event, ctx) => syncCommands(ctx));
}
