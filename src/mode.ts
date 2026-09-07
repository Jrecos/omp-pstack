import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";

export const MODE_ENTRY = "omp-pstack.mode";

export function replayMode(entries: readonly SessionEntry[], skillPath: string, diagnose: (message: string) => void): boolean {
  let active = false;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
      const data = entry.data;
      if (data && typeof data === "object" && "version" in data && data.version === 1 && "active" in data && typeof data.active === "boolean") {
        active = data.active;
      } else {
        diagnose(`Ignoring malformed or unsupported ${MODE_ENTRY} entry ${entry.id}; last known mode state is preserved.`);
      }
    } else if (entry.type === "custom_message" && entry.customType === "skill-prompt" && entry.attribution === "user") {
      const details = entry.details;
      if (!details || typeof details !== "object" || !("name" in details) || details.name !== "poteto-mode" || !("path" in details) || typeof details.path !== "string") continue;
      try {
        if (realpathSync(details.path) === skillPath) active = true;
      } catch {
        diagnose(`Cannot resolve poteto-mode invocation path in entry ${entry.id}; invocation ignored.`);
      }
    }
  }
  return active;
}

export function registerMode(pi: ExtensionAPI, skillPath: string, body: string) {
  const installedPath = realpathSync(skillPath);
  let active = false;
  const diagnostics = new Set<string>();
  const replay = (ctx: ExtensionContext) => {
    active = replayMode(ctx.sessionManager.getBranch(), installedPath, (message) => {
      if (!diagnostics.has(message)) {
        diagnostics.add(message);
        ctx.ui.notify(message, "warning");
        pi.logger.warn(message);
      }
    });
    return active;
  };
  const set = (next: boolean, ctx: ExtensionContext) => {
    replay(ctx);
    if (active !== next) {
      pi.appendEntry(MODE_ENTRY, { version: 1, active: next });
      active = next;
    }
    return active;
  };
  const refresh = (_event: unknown, ctx: ExtensionContext) => { diagnostics.clear(); replay(ctx); };
  pi.on("session_start", refresh);
  pi.on("session_switch", refresh);
  pi.on("session_branch", refresh);
  pi.on("session_tree", refresh);
  pi.on("before_agent_start", (event, ctx) => {
    if (replay(ctx)) return { systemPrompt: [...event.systemPrompt, `<omp-pstack-mode source=${JSON.stringify(dirname(installedPath))}>\n${body}\n</omp-pstack-mode>`] };
  });
  // Native skill messages enter history after before_agent_start; their body supplies the first turn's rules.
  pi.on("context", (_event, ctx) => { replay(ctx); });
  pi.registerTool({
    name: "pstack_mode",
    label: "P Stack mode",
    description: "Turn persistent Poteto mode on or off, or inspect this session branch's state. Clear natural-language opt-out requires action off.",
    parameters: pi.zod.object({ action: pi.zod.enum(["on", "off", "status"]) }),
    async execute(_id, { action }, _signal, _update, ctx) {
      const value = action === "status" ? replay(ctx) : set(action === "on", ctx);
      return { content: [{ type: "text", text: `Poteto mode ${value ? "active" : "inactive"}.` }], details: { active: value } };
    },
  });
  return { set, status: replay };
}
