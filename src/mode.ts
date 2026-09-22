import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { sameMarketplaceSkill } from "./install.ts";
import type { CacheIdentity } from "./install.ts";

export const MODE_ENTRY = "omp-pstack.mode";

export interface ModeAnchor {
	/** Canonical loaded skill path; the primary ownership test. */
	readonly loadedSkillPath: string;
	/** Lexical runtime-link skill directory, used as the injected mode block source. */
	readonly stableSkillDir: string;
	/** Marketplace identity, armed only when a matching stable runtime link was selected. */
	readonly cacheIdentity: CacheIdentity | null;
}

type ModeDecision =
	| { readonly active: false; readonly source: "default" | "marker" }
	| { readonly active: true; readonly source: "marker" | "native" };

/**
 * Ownership test for a recorded invocation. Live paths must resolve to the
 * loaded skill or the current stable-link target. Marketplace identity is used
 * only after the host has deleted the recorded version.
 */
function ownsInvocation(
	recordedPath: string,
	anchor: ModeAnchor,
	entryId: string,
	diagnose: (message: string) => void,
): boolean {
	let resolved: string | null = null;
	try {
		resolved = realpathSync(recordedPath);
	} catch {
		resolved = null;
	}
	if (resolved === anchor.loadedSkillPath) return true;
	if (resolved !== null) {
		let currentStableSkill: string | null = null;
		try {
			currentStableSkill = realpathSync(join(anchor.stableSkillDir, "SKILL.md"));
		} catch {
			currentStableSkill = null;
		}
		return resolved === currentStableSkill && sameMarketplaceSkill(resolved, anchor.cacheIdentity);
	}
	if (sameMarketplaceSkill(recordedPath, anchor.cacheIdentity)) return true;
	diagnose(`Cannot resolve poteto-mode invocation path in entry ${entryId}; invocation ignored.`);
	return false;
}

function decideMode(
	entries: readonly SessionEntry[],
	anchor: ModeAnchor,
	diagnose: (message: string) => void,
): ModeDecision {
	let decision: ModeDecision = { active: false, source: "default" };
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
			const data = entry.data;
			if (data && typeof data === "object" && "version" in data && data.version === 1 && "active" in data && typeof data.active === "boolean") {
				decision = data.active ? { active: true, source: "marker" } : { active: false, source: "marker" };
			} else {
				diagnose(`Ignoring malformed or unsupported ${MODE_ENTRY} entry ${entry.id}; last known mode state is preserved.`);
			}
		} else if (entry.type === "custom_message" && entry.customType === "skill-prompt" && entry.attribution === "user") {
			const details = entry.details;
			if (!details || typeof details !== "object" || !("name" in details) || details.name !== "poteto-mode" || !("path" in details) || typeof details.path !== "string") continue;
			if (ownsInvocation(details.path, anchor, entry.id, diagnose)) decision = { active: true, source: "native" };
		}
	}
	return decision;
}

export function replayMode(
	entries: readonly SessionEntry[],
	anchor: ModeAnchor,
	diagnose: (message: string) => void,
): boolean {
	return decideMode(entries, anchor, diagnose).active;
}

export function registerMode(pi: ExtensionAPI, anchorFor: (ctx: ExtensionContext) => ModeAnchor, body: string) {
	let decision: ModeDecision = { active: false, source: "default" };
	const diagnostics = new Set<string>();
	const replay = (ctx: ExtensionContext) => {
		decision = decideMode(ctx.sessionManager.getBranch(), anchorFor(ctx), (message) => {
			if (!diagnostics.has(message)) {
				diagnostics.add(message);
				ctx.ui.notify(message, "warning");
				pi.logger.warn(message);
			}
		});
		return decision;
	};
	const status = (ctx: ExtensionContext) => replay(ctx).active;
	const set = (next: boolean, ctx: ExtensionContext) => {
		if (status(ctx) !== next) {
			pi.appendEntry(MODE_ENTRY, { version: 1, active: next });
			decision = next ? { active: true, source: "marker" } : { active: false, source: "marker" };
		}
		return decision.active;
	};
	const refresh = (_event: unknown, ctx: ExtensionContext) => { diagnostics.clear(); replay(ctx); };
	pi.on("session_start", refresh);
	pi.on("session_switch", refresh);
	pi.on("session_branch", refresh);
	pi.on("session_tree", refresh);
	pi.on("before_agent_start", (event, ctx) => {
		if (!status(ctx)) return;
		const anchor = anchorFor(ctx);
		return { systemPrompt: [...event.systemPrompt, `<omp-pstack-mode source=${JSON.stringify(anchor.stableSkillDir)}>\n${body}\n</omp-pstack-mode>`] };
	});
	// Native skill messages enter history after before_agent_start; their body supplies the first turn's rules.
	pi.on("context", (_event, ctx) => {
		const current = replay(ctx);
		if (current.active && current.source === "native") pi.appendEntry(MODE_ENTRY, { version: 1, active: true });
	});
	pi.registerTool({
		name: "pstack_mode",
		label: "P Stack mode",
		description: "Turn persistent Poteto mode on or off, or inspect this session branch's state. Clear natural-language opt-out requires action off.",
		parameters: pi.zod.object({ action: pi.zod.enum(["on", "off", "status"]) }),
		async execute(_id, { action }, _signal, _update, ctx) {
			const value = action === "status" ? status(ctx) : set(action === "on", ctx);
			return { content: [{ type: "text", text: `Poteto mode ${value ? "active" : "inactive"}.` }], details: { active: value } };
		},
	});
	return { set, status };
}
