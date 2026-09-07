
/**
 * Deterministic local transports for Benny action tests: a Slack Web API fixture,
 * a Linear GraphQL fixture, and a GitHub-compatible HTTPS fixture that the real
 * `gh` CLI talks to (GH_HOST + SSL_CERT_FILE; gh is never faked). All controls are
 * explicit and request-scoped; every request is logged for zero-write assertions.
 */

export interface FixtureRequest {
  at: number;
  method: string;
  path: string;
  body?: unknown;
  authorization?: string;
}

export interface FixtureMessage {
  ts: string;
  channel?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  client_msg_id?: string;
  reply_broadcast?: boolean;
  files?: Array<Record<string, unknown>>;
}

export interface FixtureIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: { id: string; name: string; type: string };
  url: string;
  project: { id: string; name: string };
  labels: { nodes: Array<{ id: string; name: string }> };
  comments: { nodes: Array<{ id: string; body: string }> };
}

export interface FixturePull {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  head: { ref: string; oid?: string };
  base: { ref: string; oid?: string };
  user: { login: string };
  created_at: string;
}

export interface BennyTransports {
  slackUrl: string;
  linearUrl: string;
  githubHost: string;
  /** Set these in the test process so createBennyActions' gh env allowlist picks them up. */
  githubEnv: Record<string, string>;
  requests: FixtureRequest[];
  close(): Promise<void>;
  slack: {
    authTeam: string;
    pageSize: number | null;
    historyLimit: number | null;
    failNextPost(message: string): void;
    /** One-shot: next chat.postMessage stores the message (if created) and then responds HTTP 500, so the client sees an ambiguous failure. */
    loseResponseNextPost(created?: boolean): void;
    /** Add an out-of-band workspace message for reconciliation security tests. */
    seedMessage(channel: string, message: { thread_ts?: string; user: string; text: string; client_msg_id?: string }): void;
    retryNextPostAfter(seconds: number): void;
    redirectNextDownloadOnce(): void;
    deleteRoot(): void;
    restoreRoot(): void;
    /** Rewrite the bound root's text in place, as an out-of-band Slack edit would. */
    editRootText(text: string): void;
    /** Register/replace a downloadable file and attach its metadata to a bound-thread reply. */
    addThreadFile(file: { id: string; bytes: Uint8Array; mimetype: string }): void;
    /** One-shot: the next download request answers 302 back to this fixture's own (allowlisted) URL. */
    redirectDownloadToSelfOnce(): void;
  };
  linear: {
    dropCanceledState(): void;
    dropTeam(): void;
    dropProject(): void;
    dropLabel(name: string): void;
    failNextCreate(message: string): void;
    /** One-shot: next issueCreate applies the mutation (if created) and then responds HTTP 500. */
    loseResponseNextCreate(created?: boolean): void;
    /** One-shot: next issueCreate applies the mutation and then responds 200 with a GraphQL partial error (no data). */
    partialErrorNextCreate(): void;
    /** Demote the canceled workflow state to a started type while keeping its display name, to prove type-only resolution. */
    demoteCanceledType(): void;
    issues(): FixtureIssue[];
  };
  github: {
    /** One-shot: next createPullRequest applies the mutation (if created) and then responds HTTP 500. */
    loseResponseNextCreate(created?: boolean): void;
    failReadback(): void;
    clearReadbackFailure(): void;
    setLastPrDraft(draft: boolean): void;
    pulls(): FixturePull[];
  };
}

const SLACK_TEAM = "T_TEAM";
const SLACK_BOT = "U_BENNY";
const SLACK_REPORTER = "U_REPORTER";
const SOURCE_CHANNEL = "C_SOURCE";
const OPS_CHANNEL = "C_OPS";
const ROOT_TS = "100.001";
/** Real 1x1 PNG and JPEG so byte-level media validation can pass; text bytes serve as forged/unsupported media. */
export const FIXTURE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC", "base64");
export const FIXTURE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==", "base64");
const FILE_BYTES = new Uint8Array(FIXTURE_PNG);

function json(response: unknown, init: number | ResponseInit = 200): Response {
  const status = typeof init === "number" ? init : init.status ?? 200;
  const headers = new Headers(typeof init === "number" ? {} : init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(response), { status, headers });
}


function paginate<T>(items: T[], limit: number, cursor: string | undefined, pageSize: number | null): { page: T[]; hasMore: boolean; nextCursor?: string } {
  const size = Math.max(1, Math.min(limit, pageSize ?? limit));
  const offset = Number(cursor ?? 0) || 0;
  const page = items.slice(offset, offset + size);
  const hasMore = offset + size < items.length;
  return { page, hasMore, nextCursor: hasMore ? String(offset + size) : undefined };
}
function oauthed(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") || header.startsWith("token ");
}
function ghPrSuperset(pull: FixturePull, host: string, slug: string): Record<string, unknown> {
  const iso = pull.created_at;
  return {
    id: `PR_kwDOFIX${pull.number}`,
    number: pull.number,
    url: `https://${host}/${slug}/pull/${pull.number}`,
    title: pull.title,
    body: pull.body,
    state: pull.state === "open" ? "OPEN" : pull.state.toUpperCase(),
    draft: pull.draft,
    isDraft: pull.draft,
    closed: pull.state !== "open",
    merged: false,
    mergeable: "MERGEABLE",
    createdAt: iso,
    updatedAt: iso,
    author: { login: pull.user.login },
    headRefName: pull.head.ref,
    headRefOid: pull.head.oid ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    baseRefName: pull.base.ref,
    baseRefOid: pull.base.oid ?? "feedfacefeedfacefeedfacefeedfacefeedface",
    head: { ref: pull.head.ref, sha: pull.head.oid ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    base: { ref: pull.base.ref, sha: pull.base.oid ?? "feedfacefeedfacefeedfacefeedfacefeedface" },
    headRepository: { name: slug.split("/")[1], owner: { login: slug.split("/")[0] } },
    headRepositoryOwner: { login: slug.split("/")[0] },
    baseRepository: { name: slug.split("/")[1], owner: { login: slug.split("/")[0] } },
    isCrossRepository: false,
    maintainerCanModify: false,
    viewerPermission: "WRITE",
  };
}

export async function startBennyTransports(opts?: {
  slackPort?: number;
  linearPort?: number;
  githubPort?: number;
  team?: string;
  project?: string;
  status?: string;
  labels?: { bug: string; performance: string; intake: string; needsRepro: string };
  rootText?: string;
  threadReplies?: string[];
  gitRepoPath?: string;
}): Promise<BennyTransports> {
  const requests: FixtureRequest[] = [];
  const team = opts?.team ?? "Benny Team";
  const project = opts?.project ?? "Benny Project";
  const status = opts?.status ?? "Intake";
  const labels = opts?.labels ?? { bug: "Bug", performance: "Performance", intake: "Intake", needsRepro: "Needs Repro" };
  const linearState = {
    states: [
      { id: "ST_INTAKE", name: status, type: "unstarted" },
      { id: "ST_CANCELED", name: "Canceled", type: "canceled" },
    ],
    teams: [{ id: "TEAM_BEN", key: "BEN", name: team }],
    projects: [{ id: "PROJ_BEN", name: project }],
    labelNodes: [
      { id: "LB_BUG", name: labels.bug },
      { id: "LB_PERF", name: labels.performance },
      { id: "LB_INTAKE", name: labels.intake },
      { id: "LB_REPRO", name: labels.needsRepro },
    ],
    issues: [] as FixtureIssue[],
    seq: 0,
  };
  const linearControls = { dropCanceled: false, dropTeam: false, dropProject: false, droppedLabels: new Set<string>(), failCreate: "", loseCreate: "" as "" | "created" | "dropped" | "partial", demoteCanceled: false };
  const linearLabelById = new Map(linearState.labelNodes.map((l) => [l.id, l.name]));
  const linearStateById = new Map(linearState.states.map((s) => [s.id, s]));

  let slackUrl = "";
  const channels: Record<string, FixtureMessage[]> = {
    [SOURCE_CHANNEL]: [
      { ts: ROOT_TS, user: SLACK_REPORTER, text: opts?.rootText ?? "App crashes when exporting", files: [] },
      ...(opts?.threadReplies ?? ["Steps: open export dialog, click PNG", "Same on 2.3.1"]).map((text, index) => ({
        ts: `${101 + index}.${String(index + 2).padStart(3, "0")}`,
        thread_ts: ROOT_TS,
        user: index === 0 ? SLACK_REPORTER : "U_TEAMMATE",
        text,
      })),
    ],
    [OPS_CHANNEL]: [],
  };
  const slackControls = { authTeam: SLACK_TEAM, pageSize: null as number | null, historyLimit: null as number | null, failPost: "", losePost: "" as "" | "created" | "dropped", retryAfterSeconds: -1, redirectDownload: false, redirectToSelf: false, rootDeleted: false };
  const savedRoot = JSON.parse(JSON.stringify(channels[SOURCE_CHANNEL][0]));
  const filesById = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimetype: string }>([["F001", { bytes: FILE_BYTES, mimetype: "image/png" }]]);
  let slackSeq = 1;

  function nextTs(): string {
    slackSeq += 1;
    return `17000000${String(slackSeq).padStart(3, "0")}.${String(slackSeq).padStart(3, "0")}`;
  }

  function storePost(body: Record<string, unknown>, channel: string): string {
    const message: FixtureMessage = {
      ts: nextTs(),
      channel,
      thread_ts: body.thread_ts === undefined ? undefined : String(body.thread_ts),
      user: SLACK_BOT,
      text: String(body.text ?? ""),
      client_msg_id: body.client_msg_id === undefined ? undefined : String(body.client_msg_id),
      reply_broadcast: body.reply_broadcast === true,
    };
    channels[channel].push(message);
    return message.ts;
  }

  const slackServer = Bun.serve({
    port: opts?.slackPort ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization") ?? undefined;
      const downloadPath = url.pathname.startsWith("/api/download/")
        ? "/api/download/"
        : "/download/";
      if (url.pathname === downloadPath.slice(0, -1)) {
        requests.push({ at: Date.now(), method: request.method, path: url.pathname, authorization: auth });
        return json({ ok: false, error: "file_not_found" }, 404);
      }
      if (url.pathname.startsWith(downloadPath)) {
        requests.push({ at: Date.now(), method: request.method, path: url.pathname, authorization: auth });
        if (!oauthed(request)) return new Response("forbidden", { status: 403 });
        if (slackControls.redirectDownload) {
          slackControls.redirectDownload = false;
          return new Response(null, { status: 302, headers: { location: "https://evil.example/file" } });
        }
        if (slackControls.redirectToSelf) {
          slackControls.redirectToSelf = false;
          return new Response(null, { status: 302, headers: { location: `${slackUrl}/download/${url.pathname.slice(downloadPath.length)}` } });
        }
        const file = filesById.get(url.pathname.slice(downloadPath.length));
        if (!file) return new Response("not found", { status: 404 });
        return new Response(file.bytes, { headers: { "content-type": file.mimetype } });
      }
      const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      requests.push({ at: Date.now(), method: request.method, path: url.pathname, body, authorization: auth });
      if (!oauthed(request)) return json({ ok: false, error: "not_authed" });
      const method = url.pathname.replace(/^\/api\//, "");
      const channel = String(body.channel ?? "");
      switch (method) {
        case "auth.test":
          return json({ ok: true, team_id: slackControls.authTeam, team: "Fixture", user_id: SLACK_BOT, user: "benny" });
        case "conversations.replies": {
          const list = channels[channel];
          if (!list) return json({ ok: false, error: "channel_not_found" });
          const threadTs = String(body.ts ?? "");
          const thread = list.filter((m) => m.ts === threadTs || m.thread_ts === threadTs);
          if (thread.length === 0) return json({ ok: false, error: "thread_not_found" });
          const { page, hasMore, nextCursor } = paginate(thread, Number(body.limit ?? 100), body.cursor as string | undefined, slackControls.pageSize);
          return json({ ok: true, messages: page, has_more: hasMore, response_metadata: { next_cursor: nextCursor ?? "" } });
        }
        case "conversations.history": {
          const list = channels[channel];
          if (!list) return json({ ok: false, error: "channel_not_found" });
          let filtered = list;
          const latest = body.latest;
          if (typeof latest === "string" && latest !== "") {
            const inclusive = body.inclusive === true;
            filtered = list.filter((m) => (inclusive ? m.ts <= latest : m.ts < latest));
            // Slack history with a latest marker returns the newest page, newest first.
            const size = Math.max(1, Math.min(Number(body.limit ?? 100), slackControls.historyLimit ?? Number(body.limit ?? 100)));
            return json({ ok: true, messages: filtered.slice(-size).reverse(), has_more: false, response_metadata: { next_cursor: "" } });
          }
          const { page, hasMore, nextCursor } = paginate(filtered, Number(body.limit ?? 100), body.cursor as string | undefined, slackControls.historyLimit);
          return json({ ok: true, messages: page, has_more: hasMore, response_metadata: { next_cursor: nextCursor ?? "" } });
        }
        case "chat.postMessage": {
          if (slackControls.losePost) {
            const lose = slackControls.losePost;
            slackControls.losePost = "";
            if (lose === "dropped") return new Response(null, { status: 500 });
            // Store the message first, then lose the response: client sees an ambiguous failure.
            const stored = storePost(body, channel);
            return new Response(null, { status: 500, headers: { "x-stored-ts": stored } });
          }
          if (slackControls.retryAfterSeconds >= 0) {
            const seconds = slackControls.retryAfterSeconds;
            slackControls.retryAfterSeconds = -1;
            return json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "retry-after": String(seconds) } });
          }
          if (slackControls.failPost) {
            const error = slackControls.failPost;
            slackControls.failPost = "";
            return json({ ok: false, error });
          }
          if (!channels[channel]) return json({ ok: false, error: "channel_not_found" });
          if (body.thread_ts !== undefined && !channels[channel].some((m) => m.ts === String(body.thread_ts))) {
            return json({ ok: false, error: "thread_not_found" });
          }
          const ts = storePost(body, channel);
          return json({ ok: true, ts, channel });
        }
        case "chat.update": {
          const list = channels[channel];
          const ts = String(body.ts ?? "");
          const target = list?.find((m) => m.ts === ts);
          if (!target) return json({ ok: false, error: "message_not_found" });
          target.text = String(body.text ?? "");
          return json({ ok: true, ts, channel, text: target.text });
        }
        case "chat.getPermalink": {
          const list = channels[String(body.channel ?? "")];
          const ts = String(body.message_ts ?? "");
          if (!list?.some((m) => m.ts === ts)) return json({ ok: false, error: "message_not_found" });
          return json({ ok: true, permalink: `${slackUrl}/archives/${body.channel}/p${ts.replace(".", "")}` });
        }
        default:
          return json({ ok: false, error: `fixture: unknown method ${method}` });
      }
    },
  });
  slackUrl = `http://localhost:${slackServer.port}/api`;
  channels[SOURCE_CHANNEL][0]!.files = [
    { id: "F001", mimetype: "image/png", size: FILE_BYTES.byteLength, url_private_download: `${slackUrl}/download/F001` },
  ];

  function createIssue(input: Record<string, unknown>): FixtureIssue | string {
    if (!linearState.teams.some((t) => t.id === input.teamId)) return "unknown team";
    if (!linearState.projects.some((p) => p.id === input.projectId)) return "unknown project";
    const state = linearStateById.get(String(input.stateId));
    if (!state) return "unknown state";
    linearState.seq += 1;
    const issue: FixtureIssue = {
      id: `ISS-${linearState.seq}`,
      identifier: `BEN-${linearState.seq}`,
      title: String(input.title ?? ""),
      description: String(input.description ?? ""),
      url: `http://localhost:${linearServer.port}/t/BEN-${linearState.seq}`,
      state,
      project: { id: String(input.projectId), name: linearState.projects.find((p) => p.id === input.projectId)?.name ?? "unknown" },
      labels: { nodes: (Array.isArray(input.labelIds) ? (input.labelIds as string[]) : []).map((id) => ({ id, name: linearLabelById.get(id) ?? id })) },
      comments: { nodes: [] },
    };
    linearState.issues.push(issue);
    return issue;
  }

  const linearServer = Bun.serve({
    port: opts?.linearPort ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json()) as { operationName?: string; variables?: Record<string, unknown> };
      const operation = body.operationName ?? "";
      const variables = body.variables ?? {};
      const states = linearControls.dropCanceled
        ? linearState.states.filter((s) => s.type !== "canceled")
        : linearState.states.map((s) => (linearControls.demoteCanceled && s.type === "canceled" ? { ...s, type: "started" } : s));
      const teams = linearControls.dropTeam ? [] : linearState.teams;
      const projects = linearControls.dropProject ? [] : linearState.projects;
      const labelNodes = linearState.labelNodes.filter((l) => !linearControls.droppedLabels.has(l.name));
      switch (operation) {
        case "BennyTeams":
          return json({ data: { teams: { nodes: teams } } });
        case "BennyProjects":
          return json({ data: { team: { projects: { nodes: projects } } } });
        case "BennyStates":
          return json({ data: { team: { states: { nodes: states } } } });
        case "BennyLabels":
          return json({ data: { team: { labels: { nodes: labelNodes } } } });
        case "BennyIssue": {
          const id = String(variables.id ?? "");
          const issue = linearState.issues.find((i) => i.id === id || i.identifier === id);
          if (!issue) return json({ errors: [{ message: `Issue not found: ${id}` }] });
          return json({ data: { issue } });
        }
        case "BennyIssueSearch": {
          const or = ((variables.filter as { or?: Array<Record<string, Record<string, string>>> } | undefined)?.or ?? []) as Array<Record<string, Record<string, string>>>;
          const needles: Array<{ field: "title" | "description"; value: string }> = [];
          for (const condition of or) {
            for (const field of ["title", "description"] as const) {
              const value = condition[field]?.containsIgnoreCase;
              if (value) needles.push({ field, value });
            }
          }
          const lowered = needles.map(({ field, value }) => ({ field, value: value.toLowerCase() }));
          const hits = linearState.issues.filter((issue) =>
            lowered.some(({ field, value }) => String(issue[field]).toLowerCase().includes(value)),
          );
          return json({ data: { issues: { nodes: hits } } });
        }
        case "BennyIssueCreate": {
          if (linearControls.loseCreate === "partial") {
            linearControls.loseCreate = "";
            createIssue(variables.input as Record<string, unknown>);
            // Real GraphQL partial failure: mutation landed, nested readback errored, no data.
            return json({ errors: [{ message: "Value: IssuePayload.issue readback failed (transient)" }] });
          }
          if (linearControls.loseCreate) {
            const lose = linearControls.loseCreate;
            linearControls.loseCreate = "";
            if (lose === "created") {
              createIssue(variables.input as Record<string, unknown>);
            }
            return new Response(null, { status: 500 });
          }
          if (linearControls.failCreate) {
            const message = linearControls.failCreate;
            linearControls.failCreate = "";
            return json({ errors: [{ message }] });
          }
          const issue = createIssue(variables.input as Record<string, unknown>);
          if (typeof issue === "string") return json({ errors: [{ message: issue }] });
          return json({ data: { issueCreate: { success: true, issue } } });
        }
        case "BennyCommentCreate": {
          const input = variables.input as { issueId: string; body: string };
          const issue = linearState.issues.find((i) => i.id === input.issueId || i.identifier === input.issueId);
          if (!issue) return json({ errors: [{ message: "issue not found" }] });
          linearState.seq += 1;
          const comment = { id: `COM-${linearState.seq}`, body: input.body };
          issue.comments.nodes.push(comment);
          return json({ data: { issueCommentCreate: { success: true, issueComment: { ...comment, issue: { id: issue.id, url: issue.url } } } } });
        }
        case "BennyIssueUpdate": {
          const id = String(variables.id ?? "");
          const input = variables.input as { stateId?: string };
          const issue = linearState.issues.find((i) => i.id === id || i.identifier === id);
          if (!issue) return json({ errors: [{ message: "issue not found" }] });
          const state = linearStateById.get(String(input.stateId));
          if (!state) return json({ errors: [{ message: "unknown state" }] });
          issue.state = state;
          return json({ data: { issueUpdate: { success: true, issue: { id: issue.id, state: issue.state } } } });
        }
        default:
          return json({ errors: [{ message: `fixture: unknown operation ${operation}` }] });
      }
    },
  });

  // GitHub-compatible fixture over TLS: real `gh` talks to it via GH_HOST + SSL_CERT_FILE.
  const pulls: FixturePull[] = [];
  const githubControls = { loseCreate: "" as "" | "created" | "dropped", failReadback: false };
  let githubSeq = 0;
  let githubHost = "";
  const ghSuperset = (pull: FixturePull) => ghPrSuperset(pull, githubHost, "example-org/example-repo");
  const ghError = () => json({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] });

  function createPull(input: Record<string, unknown>): FixturePull {
    githubSeq += 1;
    const oid = (ref: string): string | undefined => {
      if (!opts?.gitRepoPath || !ref) return undefined;
      const result = Bun.spawnSync(["git", "--git-dir", opts.gitRepoPath, "rev-parse", `refs/heads/${ref}`], { stdout: "pipe", stderr: "ignore" });
      return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : undefined;
    };
    const head = String(input.headRefName ?? "");
    const base = String(input.baseRefName ?? "");
    const pull: FixturePull = {
      number: githubSeq,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      state: "open",
      draft: input.draft === true,
      head: { ref: head, oid: oid(head) },
      base: { ref: base, oid: oid(base) },
      user: { login: "benny-fixture" },
      created_at: new Date().toISOString(),
    };
    pulls.push(pull);
    return pull;
  }

  const githubServer = Bun.serve({
    port: opts?.githubPort ?? 0,
    tls: {
      cert: Bun.file(new URL("./localhost-cert.pem", import.meta.url)),
      key: Bun.file(new URL("./localhost-key.pem", import.meta.url)),
    },
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
      requests.push({ at: Date.now(), method: request.method, path: url.pathname, body, authorization: request.headers.get("authorization") ?? undefined });
      if (!oauthed(request)) return json({ message: "Bad credentials" }, 401);

      if (url.pathname === "/api/graphql") {
        const query = String(body.query ?? "");
        const variables = (body.variables ?? {}) as Record<string, unknown>;
        if (query.includes("createPullRequest")) {
          const input = variables.input as Record<string, unknown>;
          if (githubControls.loseCreate) {
            const lose = githubControls.loseCreate;
            githubControls.loseCreate = "";
            if (lose === "created") createPull(input);
            return new Response(null, { status: 500 });
          }
          const pull = createPull(input);
          return json({ data: { createPullRequest: { pullRequest: ghSuperset(pull) } } });
        }

        if (githubControls.failReadback && (query.includes("pullRequest(number:") || query.includes("pullRequests(") || query.includes("search("))) {
          return ghError();
        }
        if (query.includes("pullRequests(")) {
          return json({ data: { repository: { id: "REPOID", pullRequests: { nodes: pulls.map(ghSuperset) }, defaultBranchRef: { name: "main" } } } });
        }
        if (query.includes("pullRequest(number:")) {
          const pull = pulls.find((p) => p.number === Number(variables.number ?? variables.pr_number));
          if (!pull) return ghError();
          return json({ data: { repository: { id: "REPOID", pullRequest: ghSuperset(pull) } } });
        }
        if (query.includes("search(")) {
          return json({ data: { search: { issueCount: pulls.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: pulls.map(ghSuperset) } } });
        }
        if (query.includes("repository(")) {
          return json({
            data: {
              repository: {
                id: "REPOID",
                name: "example-repo",
                nameWithOwner: "example-org/example-repo",
                owner: { login: "example-org" },
                viewerPermission: "WRITE",
                isPrivate: false,
                hasIssuesEnabled: true,
                hasWikiEnabled: true,
                description: "fixture",
                url: `https://${githubHost}/example-org/example-repo`,
                defaultBranchRef: { name: "main" },
                parent: null,
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
                squashMergeAllowed: true,
              },
            },
          });
        }
        if (query.includes("viewer")) return json({ data: { viewer: { login: "benny-fixture", id: "VID" } } });
        return json({ data: {} });
      }

      const rest = url.pathname.replace(/^\/api\/v3/, "");
      const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
      if (repoMatch) {
        const [, owner, repo, suffix] = repoMatch as unknown as [string, string, string, string];
        const slug = `${owner}/${repo}`;
        if (!suffix) {
          return json({ id: 1, node_id: "REPOID", name: repo, full_name: slug, owner: { login: owner }, private: false, default_branch: "main", url: `https://${githubHost}/api/v3/repos/${slug}` });
        }
        if (suffix === "/pulls" && request.method === "POST") {
          return json(ghSuperset(createPull(body as Record<string, unknown>)));
        }
        if (suffix === "/pulls") {
          const state = url.searchParams.get("state") ?? "open";
          const head = url.searchParams.get("head") ?? "";
          const list = pulls.filter((p) => p.state === state && (head === "" || p.head.ref === head.split(":").pop()));
          return json(list.map(ghSuperset));
        }
        const pullMatch = /^\/pulls\/(\d+)$/.exec(suffix);
        if (pullMatch) {
          const pull = pulls.find((p) => p.number === Number(pullMatch[1]));
          return pull ? json(ghSuperset(pull)) : json({ message: "Not Found" }, 404);
        }
        const branchMatch = /^\/branches\/(.+)$/.exec(suffix);
        if (branchMatch) return json({ name: branchMatch[1], commit: { sha: "deadbeef" } });
        return json({ message: "Not Found" }, 404);
      }
      if (rest === "/search/issues") {
        return json({ total_count: pulls.length, incomplete_results: false, items: pulls.map(ghSuperset) });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  githubHost = `localhost:${githubServer.port}`;

  return {
    slackUrl,
    linearUrl: `http://localhost:${linearServer.port}/graphql`,
    githubHost,
    githubEnv: {
      GH_HOST: githubHost,
      GH_ENTERPRISE_TOKEN: "fixture-gh-token",
      SSL_CERT_FILE: new URL("./localhost-cert.pem", import.meta.url).pathname,
    },
    requests,
    async close() {
      await Promise.all([slackServer.stop(true), linearServer.stop(true), githubServer.stop(true)]);
    },
    slack: {
      get authTeam() {
        return slackControls.authTeam;
      },
      set authTeam(value: string) {
        slackControls.authTeam = value;
      },
      get pageSize() {
        return slackControls.pageSize;
      },
      set pageSize(value: number | null) {
        slackControls.pageSize = value;
      },
      get historyLimit() {
        return slackControls.historyLimit;
      },
      set historyLimit(value: number | null) {
        slackControls.historyLimit = value;
      },
      failNextPost(message: string) {
        slackControls.failPost = message;
      },
      loseResponseNextPost(created = true) {
        slackControls.losePost = created ? "created" : "dropped";
      },
      seedMessage(channel: string, message: { thread_ts?: string; user: string; text: string; client_msg_id?: string }) {
        channels[channel].push({
          ts: nextTs(),
          channel,
          thread_ts: message.thread_ts,
          user: message.user,
          text: message.text,
          client_msg_id: message.client_msg_id,
          reply_broadcast: false,
        });
      },
      retryNextPostAfter(seconds: number) {
        slackControls.retryAfterSeconds = seconds;
      },
      redirectNextDownloadOnce() {
        slackControls.redirectDownload = true;
      },
      deleteRoot() {
        slackControls.rootDeleted = true;
        const root = channels[SOURCE_CHANNEL].find((m) => m.ts === ROOT_TS);
        if (root) {
          root.subtype = "tombstone";
          root.text = "This message was deleted.";
        }
      },
      restoreRoot() {
        slackControls.rootDeleted = false;
        const index = channels[SOURCE_CHANNEL].findIndex((m) => m.ts === ROOT_TS);
        if (index >= 0) channels[SOURCE_CHANNEL][index] = JSON.parse(JSON.stringify(savedRoot));
      },
      editRootText(text: string) {
        const root = channels[SOURCE_CHANNEL].find((m) => m.ts === ROOT_TS);
        if (root) root.text = text;
      },
      addThreadFile(file: { id: string; bytes: Uint8Array; mimetype: string }) {
        filesById.set(file.id, { bytes: file.bytes as Uint8Array<ArrayBuffer>, mimetype: file.mimetype });
        const reply = channels[SOURCE_CHANNEL][1];
        if (reply) reply.files = [...(reply.files ?? []), { id: file.id, mimetype: file.mimetype, size: file.bytes.byteLength, url_private_download: `${slackUrl}/download/${file.id}` }];
      },
      redirectDownloadToSelfOnce() {
        slackControls.redirectToSelf = true;
      },
    },
    linear: {
      dropCanceledState() {
        linearControls.dropCanceled = true;
      },
      dropTeam() {
        linearControls.dropTeam = true;
      },
      dropProject() {
        linearControls.dropProject = true;
      },
      dropLabel(name: string) {
        linearControls.droppedLabels.add(name);
      },
      failNextCreate(message: string) {
        linearControls.failCreate = message;
      },
      loseResponseNextCreate(created = true) {
        linearControls.loseCreate = created ? "created" : "dropped";
      },
      partialErrorNextCreate() {
        linearControls.loseCreate = "partial";
      },
      demoteCanceledType() {
        linearControls.demoteCanceled = true;
      },
      issues() {
        return JSON.parse(JSON.stringify(linearState.issues)) as FixtureIssue[];
      },
    },
    github: {
      loseResponseNextCreate(created = true) {
        githubControls.loseCreate = created ? "created" : "dropped";
      },
      clearReadbackFailure() {
        githubControls.failReadback = false;
      },
      failReadback() {
        githubControls.failReadback = true;
      },
      setLastPrDraft(draft: boolean) {
        const last = pulls[pulls.length - 1];
        if (last) last.draft = draft;
      },
      pulls() {
        return JSON.parse(JSON.stringify(pulls)) as FixturePull[];
      },
    },
  };

}
