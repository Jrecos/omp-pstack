import type { RemoteReceipt } from "../benny-policy.ts";
import type { TrackerAdapter, TrackerCategory, TrackerCreateInput, TrackerOperationContext, TrackerTarget } from "./contract.ts";
import { beginTrackerTransport, receiptFrom } from "./contract.ts";

export interface LinearOptions {
  apiUrl: string;
  token: string;
  team: string;
  project: string;
  labels: { bug: string; performance: string; intake: string; needsRepro: string };
  status: string;
  deadline?: number;
  signal?: AbortSignal;
}

export class LinearError extends Error {}

const TEAMS_QUERY = `query BennyTeams { teams(first: 100) { nodes { id name key } } }`;
const PROJECTS_QUERY = `query BennyProjects($teamId: String!) { team(id: $teamId) { projects(first: 100) { nodes { id name } } } }`;
const STATES_QUERY = `query BennyStates($teamId: String!) { team(id: $teamId) { states(first: 100) { nodes { id name type } } } }`;
const LABELS_QUERY = `query BennyLabels($teamId: String!) { team(id: $teamId) { labels(first: 100) { nodes { id name } } } }`;
const ISSUE_QUERY = `query BennyIssue($id: String!) { issue(id: $id) { id identifier title description url state { id name type } project { id name } labels { nodes { id name } } comments { nodes { id body } } } }`;
const SEARCH_QUERY = `query BennyIssueSearch($filter: IssueFilter) { issues(first: 50, filter: $filter) { nodes { id identifier title url state { id name } description } } }`;
const CREATE_MUTATION = `mutation BennyIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { id name type } labels { nodes { id name } } } } }`;
const COMMENT_MUTATION = `mutation BennyCommentCreate($input: IssueCommentCreateInput!) { issueCommentCreate(input: $input) { success issueComment { id body issue { id url } } } }`;
const UPDATE_MUTATION = `mutation BennyIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id state { id name type } } } }`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state: { id: string; name: string; type: string };
  project?: { id: string; name: string } | null;
  labels?: { nodes: Array<{ id: string; name: string }> };
  comments?: { nodes: Array<{ id: string; body: string }> };
}

function pickByName(nodes: Array<{ id: string; name: string }>, name: string, what: string): string {
  const hit = nodes.find((node) => node.name === name);
  if (!hit) throw new LinearError(`Linear ${what} "${name}" not found; resolved: ${nodes.map((n) => n.name).join(", ")}`);
  return hit.id;
}

/** Fixed byte cap for every Linear GraphQL response body. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 429 retry budget: a fixed attempt cap with a nonzero, deadline-bounded backoff. */
const MAX_RATE_LIMIT_ATTEMPTS = 5;
const MIN_RATE_LIMIT_DELAY_MS = 500;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;

/**
 * Read a JSON response under the fixed byte cap. The transport signal races
 * every body read, so shutdown/deadline expiry rejects even when the runtime
 * does not propagate fetch-signal aborts into the body stream. EVERY
 * exceptional exit — abort, deadline, byte cap (streamed or advertised),
 * unreadable and unparseable bodies — cancels the live body reader BEFORE
 * the lock is released, so the transport is never dropped with an open
 * response. Oversized, unreadable and unparseable bodies are classified
 * uncertain: a mutation whose body we cannot read may or may not have
 * applied upstream.
 */
async function readBoundedJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LinearError(`Linear response body exceeds the ${MAX_RESPONSE_BYTES} byte cap`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LinearError("Linear transport uncertain: response has no body");
  const { promise: abortPromise, reject: abortReject } = Promise.withResolvers<never>();
  const onAbort = () => abortReject(new LinearError("Linear transport uncertain: response body read aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort(); // registration race: the run settled before the listener attached
  // Cancel the race promise on abandonment: without a consumer, a late abort
  // rejection would surface as an unhandled rejection.
  abortPromise.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), abortPromise]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        throw new LinearError(`Linear response body exceeds the ${MAX_RESPONSE_BYTES} byte cap`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    // Every exceptional exit — abort, deadline, byte cap, unreadable stream —
    // cancels the live body BEFORE releaseLock, so the transport is never
    // released with an unconsumed response still open.
    await reader.cancel().catch(() => undefined);
    if (error instanceof LinearError) throw error;
    throw new LinearError(`Linear transport uncertain: response body unreadable (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LinearError("Linear transport uncertain: response body is not valid JSON");
  }
}

export class LinearTracker implements TrackerAdapter {
  constructor(private readonly options: LinearOptions) {}

  private async gql<T>(query: string, variables: Record<string, unknown> | undefined, ctx: TrackerOperationContext): Promise<T> {
    // beginTrackerTransport preflights an already-aborted run signal and an
    // expired deadline, attaches the run listener before any transport can
    // start (closing the registration race with a synchronous re-check) and
    // bounds the request by the absolute deadline. The transport stays bound
    // through body consumption and JSON classification: abort or deadline
    // expiry rejects the read instead of hanging past the run's shutdown
    // barrier, and done() runs only after every body task settles. Each 429
    // retry loops with a FRESH transport — the wait never spans a live
    // transport — and attempts are capped, so a persistently rate-limiting
    // server can never spin.
    for (let attempt = 1; ; attempt += 1) {
      const transport = beginTrackerTransport(ctx, "linear request");
      try {
        let response: Response;
        try {
          response = await fetch(this.options.apiUrl, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: this.options.token },
            body: JSON.stringify({ query, variables: variables ?? {}, operationName: /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] }),
            redirect: "error",
            signal: transport.signal,
          });
        } catch (error) {
          throw new LinearError(`Linear transport uncertain: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.status === 429) {
          // The wait must honor the operation context: a detached full
          // Retry-After sleep lets the outer coordinator classify the mutation
          // as uncertain while this call later wakes and sends it after the
          // run has settled. Abort or deadline expiry throws BEFORE the retry
          // instead. The 429 body is never consumed; this transport is
          // released before the wait and the next-attempt transport.
          await response.body?.cancel().catch(() => undefined);
          transport.done();
          if (attempt >= MAX_RATE_LIMIT_ATTEMPTS) {
            throw new LinearError(`Linear rate limit (429) persisted across ${attempt} bounded attempts; giving up without exceeding the retry budget`);
          }
          const retryAfter = Number(response.headers.get("retry-after") ?? "1");
          const requestedMs = (Number.isFinite(retryAfter) ? Math.max(retryAfter, 0) : 1) * 1000;
          const remainingAfter = ctx.deadline - Date.now();
          if (remainingAfter <= 0) {
            throw new LinearError("Linear rate limit (429) cannot be honored: the workflow deadline expired before the Retry-After wait");
          }
          // Nonzero bounded delay: a zero Retry-After must not retry
          // immediately (that is the spin), and the wait is bounded both by
          // the Retry-After request and the remaining workflow deadline.
          const waitMs = Math.min(Math.max(requestedMs, MIN_RATE_LIMIT_DELAY_MS), remainingAfter, MAX_RATE_LIMIT_DELAY_MS);
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const timer = setTimeout(resolve, waitMs);
          const onAbort = () => reject(new LinearError("Linear rate-limit backoff aborted by the shutdown signal"));
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          if (ctx.signal.aborted) onAbort(); // registration race: the run settled before the listener attached
          try {
            await promise;
          } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
          }
          if (ctx.signal.aborted) throw new LinearError("Linear rate-limit backoff aborted by the shutdown signal");
          const left = ctx.deadline - Date.now();
          if (left <= 0) throw new LinearError("Linear rate-limit backoff would exceed the workflow deadline");
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new LinearError(`Linear transport uncertain: HTTP ${response.status}`);
        }
        const body = (await readBoundedJsonBody(response, transport.signal)) as { data?: T; errors?: Array<{ message: string }> };
        if (body.errors?.length) {
          const messages = body.errors.map((e) => e.message).join("; ");
          // Validation/auth/not-found errors are rejected before any mutation executes;
          // anything else may have partially applied, so treat it as uncertain upstream.
          const preExecution = body.errors.every((e) =>
            /validation|auth|permission|forbidden|not found|unknown (team|state|project|issue)|required/i.test(e.message),
          );
          throw new LinearError(`Linear rejected request (${preExecution ? "definite" : "possibly applied"}): ${messages}`);
        }
        if (body.data === undefined) throw new LinearError("Linear response missing data");
        return body.data;
      } finally {
        transport.done();
      }
    }
  }
  private issue(issue: unknown, what: string): LinearIssue {
    if (typeof issue !== "object" || issue === null) throw new LinearError(`${what}: no issue returned`);
    return issue as LinearIssue;
  }

  /** Required labels on every created issue: the category label plus intake and needs-repro. */
  private requiredLabels(category: TrackerCategory): string[] {
    return [this.options.labels[category], this.options.labels.intake, this.options.labels.needsRepro];
  }

  /**
   * Independent create verification, shared by `create` and the coordinator's
   * create reconcile. The mutation or search echo is NEVER trusted: the issue
   * is re-queried by id and must match the exact title, the configured intake
   * state, the configured project and EVERY required label (including intake
   * and needs-repro) before a verified receipt is issued. Any omission or
   * mismatch in the echo/search result fails instead of being papered over.
   */
  async verifyCreated(
    id: string,
    input: { title: string; category: TrackerCategory },
    ctx: TrackerOperationContext,
  ): Promise<RemoteReceipt> {
    const target = await this.resolve(ctx);
    const issue = this.issue((await this.gql<{ issue: unknown }>(ISSUE_QUERY, { id }, ctx)).issue, `verifyCreated(${id})`);
    const labels = issue.labels?.nodes.map((l) => l.name) ?? [];
    if (issue.title !== input.title) {
      throw new LinearError(`Linear create readback mismatch: title ${JSON.stringify(issue.title)} does not exactly match ${JSON.stringify(input.title)}`);
    }
    if (issue.state?.id !== target.statusId || issue.state?.name !== this.options.status) {
      throw new LinearError(`Linear create readback mismatch: state ${issue.state?.name ?? "missing"} is not the configured intake state "${this.options.status}"`);
    }
    if (issue.project?.id !== target.projectId) {
      throw new LinearError(`Linear create readback mismatch: project ${issue.project?.name ?? "missing"} is not the configured project "${this.options.project}"`);
    }
    for (const required of this.requiredLabels(input.category)) {
      if (!labels.includes(required)) {
        throw new LinearError(`Linear create readback mismatch: required label "${required}" is missing (found: ${labels.join(", ") || "none"})`);
      }
    }
    return {
      id: issue.id,
      url: issue.url,
      verified: true,
      observed: {
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state.name,
        stateType: issue.state.type,
        labels,
        project: issue.project?.name,
      },
    };
  }

  async resolve(ctx: TrackerOperationContext): Promise<TrackerTarget> {
    const { team, project, status, labels } = this.options;
    const teams = (await this.gql<{ teams: { nodes: Array<{ id: string; name: string; key: string }> } }>(TEAMS_QUERY, undefined, ctx)).teams.nodes;
    const matched = teams.find((t) => t.name === team || t.key === team);
    if (!matched) throw new LinearError(`Linear team "${team}" not found; resolved: ${teams.map((t) => t.key).join(", ")}`);
    const teamId = matched.id;
    const projects = (await this.gql<{ team: { projects: { nodes: Array<{ id: string; name: string }> } } }>(PROJECTS_QUERY, { teamId }, ctx)).team.projects.nodes;
    const projectId = pickByName(projects, project, "project");
    const states = (await this.gql<{ team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } }>(STATES_QUERY, { teamId }, ctx)).team.states.nodes;
    const statusId = pickByName(states, status, "status");
    const canceled = states.find((s) => s.type === "canceled");
    if (!canceled) throw new LinearError(`Linear canceled workflow state missing for team "${team}"; issue creation blocked`);
    const labelNodes = (await this.gql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(LABELS_QUERY, { teamId }, ctx)).team.labels.nodes;
    const labelIds = {
      bug: pickByName(labelNodes, labels.bug, "bug label"),
      performance: pickByName(labelNodes, labels.performance, "performance label"),
      intake: pickByName(labelNodes, labels.intake, "intake label"),
      needsRepro: pickByName(labelNodes, labels.needsRepro, "needs-repro label"),
    };
    return { teamId, projectId, statusId, canceledStateId: canceled.id, labelIds };
  }

  async search(query: string, ctx: TrackerOperationContext): Promise<RemoteReceipt[]> {
    const terms = query.split(/\s+/).filter((term) => term.length > 2).slice(0, 4);
    const filter = {
      or: [
        { description: { containsIgnoreCase: query } },
        ...terms.map((term) => ({ title: { containsIgnoreCase: term } })),
      ],
    };
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(SEARCH_QUERY, { filter }, ctx);
    return data.issues.nodes.map((issue) => ({
      id: issue.id,
      url: issue.url,
      verified: true,
      observed: { identifier: issue.identifier, title: issue.title, state: issue.state?.name, stateType: issue.state?.type, description: issue.description ?? "" },
    }));
  }

  async read(id: string, ctx: TrackerOperationContext): Promise<RemoteReceipt> {
    const issue = this.issue((await this.gql<{ issue: unknown }>(ISSUE_QUERY, { id }, ctx)).issue, `read(${id})`);
    return {
      id: issue.id,
      url: issue.url,
      verified: true,
      observed: {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? "",
        state: issue.state?.name,
        stateType: issue.state?.type,
        labels: issue.labels?.nodes.map((l) => l.name) ?? [],
        comments: issue.comments?.nodes.map((c) => c.body) ?? [],
        project: issue.project?.name,
      },
    };
  }

  async create(actionId: string, input: TrackerCreateInput, ctx: TrackerOperationContext): Promise<RemoteReceipt> {
    const target = await this.resolve(ctx);
    const data = await this.gql<{ issueCreate: { success: boolean; issue: unknown } }>(CREATE_MUTATION, {
      input: {
        teamId: target.teamId,
        projectId: target.projectId,
        stateId: target.statusId,
        labelIds: [target.labelIds[input.category], target.labelIds.intake, target.labelIds.needsRepro],
        title: input.title,
        description: input.description,
        clientMutationId: actionId,
      },
    }, ctx);
    if (!data.issueCreate.success) throw new LinearError("Linear issueCreate reported failure");
    // Never trust the mutation echo: the issue is re-read by id and verified
    // against the exact title, configured intake state, configured project
    // and every required label before a verified receipt is issued.
    const echo = this.issue(data.issueCreate.issue, "create echo");
    if (!echo.id) throw new LinearError("Linear create echo carries no issue id; independent verification is impossible");
    return this.verifyCreated(echo.id, input, ctx);
  }

  async recurrence(actionId: string, id: string, description: string, ctx: TrackerOperationContext): Promise<RemoteReceipt> {
    const data = await this.gql<{ issueCommentCreate: { success: boolean; issueComment: { id: string; body: string; issue: { id: string; url: string } } } }>(
      COMMENT_MUTATION,
      { input: { issueId: id, body: description, clientMutationId: actionId } },
      ctx,
    );
    const comment = data.issueCommentCreate.issueComment;
    const issue = this.issue((await this.gql<{ issue: unknown }>(ISSUE_QUERY, { id }, ctx)).issue, "recurrence readback");
    const commentBack = issue.comments?.nodes.find((c) => c.id === comment.id);
    if (!commentBack || commentBack.body !== description) throw new LinearError("Linear recurrence readback mismatch");
    return { id: comment.id, url: issue.url, verified: true, observed: { issueId: issue.id, body: commentBack.body } };
  }

  async compensate(actionId: string, id: string, ctx: TrackerOperationContext): Promise<RemoteReceipt> {
    const target = await this.resolve(ctx);
    const data = await this.gql<{ issueUpdate: { success: boolean; issue: { id: string; state: { id: string; name: string; type: string } } } }>(
      UPDATE_MUTATION,
      { id, input: { stateId: target.canceledStateId, clientMutationId: actionId } },
      ctx,
    );
    const issue = this.issue((await this.gql<{ issue: unknown }>(ISSUE_QUERY, { id }, ctx)).issue, "compensate readback");
    if (issue.state?.type !== "canceled") throw new LinearError(`Linear compensation readback mismatch: state ${issue.state?.name}`);
    return receiptFrom({ id: issue.id, url: issue.url, verified: true, observed: { state: issue.state.name, canceled: true } }, "linear.compensate");
  }
}

/** Search a Linear receipt list for the issue whose description links the source permalink. */
export function findCreatedIssue(receipts: RemoteReceipt[], permalink: string): RemoteReceipt | undefined {
  return receipts.find((receipt) => String(receipt.observed.description ?? "").includes(permalink));
}
