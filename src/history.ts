import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { migrateToCurrentVersion, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listAllSessions, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionFile, visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

export interface HistoryOptions {
	readonly workspace: string;
	readonly sessionsRoot: string;
	/** Current session file path; excluded from results. */
	readonly currentSessionFile?: string;
	/** Remove the seven-day window (keeps workspace isolation). */
	readonly all?: boolean;
	readonly query?: string;
	readonly since?: string;
	readonly until?: string;
	readonly sessionId?: string;
	/** Injectable clock for tests. */
	readonly now?: number;
}

export interface HistorySessionMeta {
	readonly id: string;
	readonly path: string;
	readonly title?: string;
	readonly created: string;
	readonly modified: string;
	readonly messageCount: number;
	readonly status: string;
	readonly firstMessage: string;
}

export interface ListHistoryResult {
	readonly workspace: string;
	readonly windowDays: number | null;
	readonly sessions: readonly HistorySessionMeta[];
	/** Workspace session files the native listing could not read, by name. */
	readonly skipped: readonly string[];
}

export interface HistoryEntryRecord {
	readonly id: string;
	readonly timestamp: string;
	readonly role: string;
	readonly text: string;
}

export interface ReadHistoryResult {
	readonly session: HistorySessionMeta | null;
	readonly entries: readonly HistoryEntryRecord[];
	readonly warnings: readonly string[];
}

const WINDOW_DAYS = 7;

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function parseTimeBound(value: string, endOfDay: boolean): number {
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (dateOnly) {
		const [, y, m, d] = dateOnly;
		return endOfDay
			? new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999).getTime()
			: new Date(Number(y), Number(m) - 1, Number(d)).getTime();
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`Invalid time bound "${value}"; use YYYY-MM-DD or an ISO timestamp.`);
	return ms;
}

export interface WorkspaceSelection {
	readonly sessions: readonly SessionInfo[];
	readonly skipped: readonly string[];
}

/**
 * All persisted sessions for `options.workspace`, newest first: not the current
 * session or a native task/eval child. Forked user conversations remain eligible.
 * Explicit time bounds replace the default seven-day window; all never relaxes
 * workspace isolation.
 */
export async function selectWorkspaceSessions(options: HistoryOptions): Promise<WorkspaceSelection> {
	const now = options.now ?? Date.now();
	const workspace = canonical(options.workspace);
	const current = options.currentSessionFile ? canonical(options.currentSessionFile) : undefined;

	const discovered = await listAllSessions(new FileSessionStorage(), options.sessionsRoot);
	const listed = discovered.filter((session) => canonical(session.cwd) === workspace);
	const listedPaths = new Set(discovered.map((session) => session.path));
	const skipped: string[] = [];
	const defaultBucket = join(options.sessionsRoot, basename(SessionManager.getDefaultSessionDir(options.workspace)));
	for (const dir of new Set([...listed.map((session) => dirname(session.path)), defaultBucket])) {
		for (const file of new FileSessionStorage().listFilesSync(dir, "*.jsonl")) {
			if (!listedPaths.has(file)) skipped.push(basename(file));
		}
	}
	const since = options.since ? parseTimeBound(options.since, false) : options.all ? -Infinity : now - WINDOW_DAYS * 86_400_000;
	const until = options.until ? parseTimeBound(options.until, true) : Infinity;
	const sessions: SessionInfo[] = [];
	for (const session of listed) {
		if (current && canonical(session.path) === current) continue;
		// A syntactically valid header can carry a missing/invalid timestamp
		// (session-listing stores `new Date("")`); such records crash ISO
		// rendering downstream, so name and exclude them during selection.
		if (!Number.isFinite(session.created.getTime()) || !Number.isFinite(session.modified.getTime())) {
			skipped.push(basename(session.path));
			continue;
		}
		if (session.modified.getTime() < since || session.modified.getTime() > until) continue;
		try {
			let child = false;
			await visitEntriesFromFileStream(session.path, (entry) => {
				if (entry.type === "session_init") { child = true; return false; }
				if (entry.type === "message") return false;
			});
			if (!child) sessions.push(session);
		} catch { skipped.push(basename(session.path)); }
	}
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return { sessions, skipped };
}

function toMeta(session: SessionInfo): HistorySessionMeta {
	return {
		id: session.id,
		path: session.path,
		title: session.title,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		status: session.status ?? "unknown",
		firstMessage: session.firstMessage,
	};
}

export async function listHistory(options: HistoryOptions): Promise<ListHistoryResult> {
	const { sessions, skipped } = await selectWorkspaceSessions(options);
	const skippedAll = [...skipped];
	const query = options.query?.toLowerCase();
	const matching: SessionInfo[] = [];
	for (const session of sessions) {
		if (!query) { matching.push(session); continue; }
		if (
			session.title?.toLowerCase().includes(query) ||
			session.firstMessage.toLowerCase().includes(query) ||
			session.allMessagesText.toLowerCase().includes(query)
		) {
			matching.push(session);
			continue;
		}
		// The listing's allMessagesText only covers a 4 KiB prefix; a query hit
		// in a later message needs the complete migrated active branch.
		try {
			const loaded = await loadSessionFile(session.path);
			if (loaded.invalidHeader) throw new Error("no valid session header");
			migrateToCurrentVersion(loaded.entries);
			const hit = activeBranchEntries(loaded.entries).some((entry) => {
				const rendered = entryText(entry);
				return rendered !== null && rendered.text.toLowerCase().includes(query);
			});
			if (hit) matching.push(session);
		} catch {
			skippedAll.push(basename(session.path));
		}
	}
	return {
		workspace: options.workspace,
		windowDays: options.all || options.since || options.until ? null : WINDOW_DAYS,
		sessions: matching.map(toMeta),
		skipped: skippedAll,
	};
}

function resolveSession(sessions: readonly SessionInfo[], sessionId: string | undefined): SessionInfo {
	if (!sessionId) return sessions[0];
	const wanted = sessionId.toLowerCase();
	const match = sessions.find(
		(session) =>
			session.id.toLowerCase() === wanted ||
			session.id.toLowerCase().startsWith(wanted) ||
			basename(session.path).toLowerCase().startsWith(wanted),
	);
	if (!match) {
		const ids = sessions.map((session) => session.id).join(", ");
		throw new Error(`No session matching "${sessionId}" in this workspace. Known sessions: ${ids || "(none)"}`);
	}
	return match;
}

/** Active branch of a session file: walk the leaf's parent chain to the root. */
export function activeBranchEntries(entries: readonly FileEntry[]): SessionEntry[] {
	const branchEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	const leaf = branchEntries.at(-1);
	if (!leaf) return [];
	const chain: SessionEntry[] = [];
	const seen = new Set<string>();
	for (let entry: SessionEntry | undefined = leaf; entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		seen.add(entry.id);
		chain.push(entry);
	}
	return chain.reverse();
}


function entryText(entry: FileEntry): { role: string; text: string } | null {
	if (entry.type === "custom_message") {
		const content = typeof entry.content === "string" ? entry.content : entry.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n");
		return { role: `custom:${entry.customType}`, text: content };
	}
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (!("content" in message)) return { role: message.role, text: JSON.stringify(message) };
	if (typeof message.content === "string") return { role: message.role, text: message.content };
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "toolCall") parts.push(`[tool ${block.name} ${JSON.stringify(block.arguments)}]`);
		else if (block.type === "image") parts.push("[image]");
	}
	return { role: message.role, text: parts.join("\n") };
}

export async function readHistory(options: HistoryOptions): Promise<ReadHistoryResult> {
	const { sessions, skipped } = await selectWorkspaceSessions(options);
	if (!sessions.length && !options.sessionId) return { session: null, entries: [], warnings: skipped.map((name) => `${name}: skipped (unreadable or malformed)`) };
	const session = resolveSession(sessions, options.sessionId);

	const warnings: string[] = [...skipped.map((name) => `${name}: skipped (unreadable or malformed)`)];
	const loaded = await loadSessionFile(session.path);
	if (loaded.invalidHeader) throw new Error(`${basename(session.path)}: no valid session header; cannot read`);
	if (loaded.malformedRecords > 0) {
		warnings.push(`${basename(session.path)}: ${loaded.malformedRecords} malformed record(s) skipped`);
	}

	// v1 entries carry no id/parentId; apply the native read-only migration
	// (in memory, never writing old files) before walking the branch.
	const legacy = new Set<FileEntry>(loaded.entries.filter((entry) => !("id" in entry) || entry.id === undefined));
	migrateToCurrentVersion(loaded.entries);

	const since = options.since ? parseTimeBound(options.since, false) : undefined;
	const until = options.until ? parseTimeBound(options.until, true) : undefined;
	const query = options.query?.toLowerCase();

	const records: HistoryEntryRecord[] = [];
	for (const [position, entry] of activeBranchEntries(loaded.entries).entries()) {
		const ts = Date.parse(entry.timestamp);
		if (since !== undefined && ts < since) continue;
		if (until !== undefined && ts > until) continue;
		const rendered = entryText(entry);
		if (!rendered) continue;
		if (query && !rendered.text.toLowerCase().includes(query)) continue;
		// Legacy id-less records get a stable positional citation instead of a
		// randomly generated migration id, so a citation resolves on every read.
		const id = legacy.has(entry) ? `${basename(session.path)}#${position}` : entry.id;
		records.push({ id, timestamp: entry.timestamp, role: rendered.role, text: rendered.text });
	}
	return { session: toMeta(session), entries: records, warnings };
}

export function registerHistory(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pstack_history",
		label: "P Stack history",
		description:
			"Read-only search over this workspace's past OMP chat sessions (last 7 days by default; all removes the time limit, never workspace isolation). " +
			"list returns session metadata; read returns the active branch's user/assistant/tool text with per-entry id citations. " +
			"Excludes the current session and subagent/eval/test sessions. Does not restore or mutate sessions.",
		approval: "read",
		parameters: pi.zod.object({
			action: pi.zod.enum(["list", "read"]),
			query: pi.zod.string().optional(),
			since: pi.zod.string().optional(),
			until: pi.zod.string().optional(),
			sessionId: pi.zod.string().optional(),
			all: pi.zod.boolean().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as {
				action: "list" | "read";
				query?: string;
				since?: string;
				until?: string;
				sessionId?: string;
				all?: boolean;
			};
			const options: HistoryOptions = {
				workspace: ctx.cwd,
				sessionsRoot: getSessionsDir(),
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				...input,
			};
			const result = input.action === "list" ? await listHistory(options) : await readHistory(options);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}

