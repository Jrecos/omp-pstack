import { spawn } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ActionContinuation, ActionJournal, BennyConfig, RemoteReceipt, SlackMessage, SourceCoordinates } from "./benny-policy.ts";
import { stripDisallowedMentions } from "./benny-policy.ts";
import { assertBennyEndpointPolicy } from "./benny.ts";
import type { TrackerAdapter, TrackerCategory, TrackerOperationContext } from "./trackers/contract.ts";
import { LinearTracker, findCreatedIssue } from "./trackers/linear.ts";
import { securePrivateDir, stateDir } from "./runner.ts";
import { detectMediaMime } from "./benny-workspace.ts";

/** Definite non-delivery vs honest uncertainty drive the coordinator's compensation decision; models cannot set this. */
export class ActionFailure extends Error {
  constructor(
    readonly certainty: "not-delivered" | "uncertain",
    message: string,
    readonly actionId?: string,
  ) {
    super(message);
  }
}
export class CanceledStateMissingError extends Error {}

/** Deterministic marker: the tracker cannot compensate a creation, so issue creation must be blocked. */
export interface BennyActionsOptions {
  config: BennyConfig;
  cwd: string;
  source: SourceCoordinates;
  /** Epoch ms; every transport honors it and Slack Retry-After never sleeps past it. */
  deadline: number;
  journal: ActionJournal;
  signal?: AbortSignal;
  /** Digest of the admitted root message; every source-gated reread must match it exactly. */
  expectedRootDigest: string;
  /**
   * Explicit per-route user IDs a SOURCE-thread mutation may mention. The
   * broker strips every broadcast/channel/group token and every user mention
   * outside this set on the post path; operations-channel mutations never
   * ping unless the individual call passes its own explicit set.
   */
  allowedMentionUserIds?: ReadonlySet<string>;
  /**
   * Optional numeric Benny run row id. When supplied, Slack downloads are
   * stored run-owned under state/benny-downloads/<runId>/ so the retention
   * sweep can expire them with the run's evidence; absent (tests) keeps the
   * legacy flat cache.
   */
  runId?: number;
}

/** Per-mutation options for mutating broker actions. */
export interface MutationOptions {
  /** Explicit allowed user IDs for THIS mutation; overrides the run-level source allowlist. */
  allowedUserIds?: ReadonlySet<string>;
  /** Checkpoint persisted atomically with the journal receipt on completion. */
  continuation?: ActionContinuation;
}

/**
 * Canonical admitted-root identity: text, author and file identities. Any
 * edit, redaction or attachment change on the bound source message produces a
 * different digest and blocks every downstream write.
 */
export function rootDigest(root: SlackMessage): string {
  const files = (root.files ?? [])
    .filter(record)
    .map((file) => ({
      id: str(file.id),
      mimetype: str(file.mimetype),
      size: typeof file.size === "number" ? file.size : null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ text: root.text ?? "", user: root.user ?? "", files }))
    .digest("hex");
}

export interface BennyActions {
  readRoot(): Promise<SlackMessage>;
  readThread(): Promise<SlackMessage[]>;
  readOperationsThread(rootTs: string): Promise<SlackMessage[]>;
  permalink(): Promise<string>;
  download(fileId: string): Promise<{ path: string; sha256: string; mimeType: string }>;
  postThread(actionId: string, text: string, opts?: MutationOptions): Promise<RemoteReceipt>;
  postOperationsReply(actionId: string, rootTs: string, text: string, opts?: MutationOptions): Promise<RemoteReceipt>;
  operationsUpdate(actionId: string, text: string, rootTs?: string): Promise<RemoteReceipt>;
  trackerResolve(): Promise<RemoteReceipt>;
  trackerSearch(query: string): Promise<RemoteReceipt[]>;
  trackerRead(id: string): Promise<RemoteReceipt>;
  trackerCreate(actionId: string, input: { title: string; description: string; category: TrackerCategory }, opts?: MutationOptions): Promise<RemoteReceipt>;
  createDraft(actionId: string, input: { head: string; headOid: string; base: string; baseOid: string; title: string; body: string }, opts?: MutationOptions): Promise<RemoteReceipt>;
  publishBranch(actionId: string, input: { sourceDir?: string; sourceManifest?: string; head: string; base: string; baseOid: string; message?: string; commit?: string }, opts?: MutationOptions): Promise<RemoteReceipt>;
  trackerRecurrence(actionId: string, id: string, description: string): Promise<RemoteReceipt>;
  trackerCompensate(actionId: string, id: string): Promise<RemoteReceipt>;
  inspectArtifact(ref: string): Promise<RemoteReceipt>;
  readPR(ref: string): Promise<RemoteReceipt>;
  /**
   * Idempotent cleanup of this run's publication scratch directory. Every
   * outcome calls it; a second call (or a call before any publication) is a
   * no-op. A failure leaves the directory in place for the next attempt and
   * the retention sweep, never deleting an unvalidated path.
   */
  close(): Promise<void>;
}

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_SLACK_PAGES = 100;
/** Slack Web API JSON responses are small; a remote-controlled larger body is refused, never drained. */
const MAX_SLACK_JSON_BYTES = 1 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clientId(actionId: string): string {
  return `benny-${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
}

/** Sleep that wakes early on shutdown: a Retry-After backoff never sleeps past the run. */
function sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "aborted"> {
  const { promise, resolve } = Promise.withResolvers<"elapsed" | "aborted">();
  if (ms <= 0) {
    resolve(signal?.aborted ? "aborted" : "elapsed");
    return promise;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve("elapsed");
  }, ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    resolve("aborted");
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  return promise;
}

/** Cancel an unread response body so no rejected response's transport outlives the decision. */
export async function releaseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * The one bounded, abort-raced JSON object reader for remote API responses.
 * The advertised content-length cap rejects before a single byte is read; the
 * streamed cap rejects mid-body; both cancel the transport instead of
 * draining it. The fetch's abort signal (deadline + shutdown) races every
 * read, so an aborted run never finishes reading a remote-controlled body.
 */
export async function readBoundedJsonObject(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await releaseBody(response);
    throw new ActionFailure("uncertain", `${label} response advertises ${advertised} bytes over the ${maxBytes} byte cap`);
  }
  const body = response.body;
  if (!body) throw new ActionFailure("uncertain", `${label} returned an empty body`);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ActionFailure("uncertain", `${label} response exceeded the ${maxBytes} byte cap`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ActionFailure) throw error;
    throw new ActionFailure("uncertain", `${label} response read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionFailure("uncertain", `${label} returned an unreadable body`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ActionFailure("uncertain", `${label} returned a non-object JSON body`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * SEC-REMOTE-001: structural GitHub repository identity. Only the exact
 * `github.com` authority (or its canonical scp form) with a canonical
 * `owner/repo` path is accepted; userinfo, an explicit port, query strings,
 * fragments and extra path segments are rejected, so a URL such as
 * `https://attacker.example/github.com/org/repo` can never pose as GitHub.
 */
export function parseGitHubRepository(url: string): { owner: string; repo: string; protocol?: string; host?: string } {
  const raw = url.trim();
  const scp = /^[^@/]+@([^:/]+):([^/]+\/[^/]+)$/.exec(raw);
  const asUrl = scp ? `https://${scp[1]}/${scp[2]}` : raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(asUrl)) {
    throw new Error(`repository.url is not a github.com URL: ${url}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(asUrl);
  } catch {
    throw new Error(`repository.url is not a valid URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error(`repository.url carries userinfo, an explicit port, a query string or a fragment: ${url}`);
  }
  if (host !== "github.com" || parsed.protocol !== "https:") {
    // SEC-REMOTE-004: HTTPS only — an approved `http` credential origin lets a
    // network attacker answer the plaintext request and harvest the token.
    throw new Error(`repository.url is not the exact HTTPS github.com authority: ${url}`);
  }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(parsed.pathname.replace(/\/+$/, ""));
  if (!match) {
    throw new Error(`repository.url is not a canonical github.com owner/repo path: ${url}`);
  }
  // Clone URLs (`.../repo.git`) resolve to the bare repository slug; strip
  // exactly one terminal suffix so gh `--repo owner/repo` targets the real repo.
  const repo = match[2]!.replace(/\.git$/, "");
  if (!repo) throw new Error(`repository.url has an empty repository slug: ${url}`);
  return { owner: match[1]!, repo, protocol: "https", host };
}

function parseGitHubSlug(url: string, fixtureUrlFormat?: string): { owner: string; repo: string } {
  try {
    const { owner, repo } = parseGitHubRepository(url);
    return { owner, repo };
  } catch (error) {
    // The explicit loopback-fixture gate is the only route to a non-GitHub
    // repository, and only for plain local paths — never a remote origin.
    if (fixtureUrlFormat && url.trim().startsWith("/")) {
      return { owner: "example-org", repo: "example-repo" };
    }
    throw error;
  }
}
/**
 * Canonical remote identity: scp form becomes HTTPS, the transport is
 * normalized to the canonical `https://host/owner/repo.git` shape, and the
 * host is lowercased — so an http or scp origin can never compare equal to a
 * different transport than the one credentials are approved for. Plain local
 * paths compare verbatim.
 */
export function canonicalRemoteUrl(value: string): string {
  const raw = value.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(raw);
  const asUrl = scp ? `https://${scp[1]}/${scp[2]}` : raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(asUrl)) {
    try {
      const parsed = new URL(asUrl);
      const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "") + ".git";
      return `https://${parsed.host.toLowerCase()}${path}`;
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * SEC-PATH-001: the publication source must sit inside the runner-owned
 * private state root with no symlinked path component. Lexical containment
 * alone lets a planted intermediate symlink (e.g. `benny-publish-source`)
 * redirect staging and any deletion-adjacent cleanup outside the boundary.
 * Every component below the private root is lstat'ed (a real directory,
 * never a link) and the fully resolved source must stay inside the fully
 * resolved root. Returns the resolved real path to stage from.
 */
export function securePublicationSource(privateRoot: string, sourceDir: string): string {
  const rel = relative(privateRoot, resolve(sourceDir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("patched source directory is outside the private Benny state root");
  }
  let current = privateRoot;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) throw new Error(`publication source component '${current}' is missing`);
    if (st.isSymbolicLink()) throw new Error(`refusing symlinked publication source component '${current}'`);
    if (!st.isDirectory()) throw new Error(`publication source component '${current}' is not a directory`);
  }
  const realRoot = realpathSync(privateRoot);
  const realSource = realpathSync(join(privateRoot, rel));
  const realRel = relative(realRoot, realSource);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error("patched source directory escapes the private Benny state root through a symlink");
  }
  return realSource;
}

/**
 * SEC-REMOTE-001: the only credential path for publication git processes.
 * The script parses Git's credential-protocol stdin and emits a token only
 * when the requested protocol/host exactly matches the approved origin;
 * without an approved origin (local-path fixtures) it never emits anything.
 */
export function gitCredentialHelperScript(origin?: { protocol: string; host: string }): string {
  const guard = origin
    ? `[ "$protocol" = "${origin.protocol}" ] && [ "$host" = "${origin.host}" ] || exit 0`
    : "exit 0";
  return [
    "#!/bin/sh",
    "# SEC-REMOTE-001: emit a token only for the approved credential protocol/host.",
    "protocol=",
    "host=",
    "while read -r line; do",
    '  case "$line" in',
    "    protocol=*) protocol=${line#protocol=} ;;",
    "    host=*) host=${line#host=} ;;",
    "  esac",
    "done",
    guard,
    "for name in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN; do",
    '  value=$(printenv "$name") || continue',
    '  [ -n "$value" ] || continue',
    '  printf "username=x-access-token\\n"',
    '  printf "password=%s\\n" "$value"',
    "  exit 0",
    "done",
    "",
  ].join("\n");
}

/** Host-side git config isolation applied to every publication git process. */
const PUBLICATION_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};

function envAllowlist(): Record<string, string> {
  const out: Record<string, string> = { NO_COLOR: "1" };
  // SEC-REMOTE-004: GH_HOST is never inherited — a caller-set enterprise host
  // would redirect every `gh --repo owner/repo` operation (and its
  // credentials). gh is pinned to the parsed authority via resolveGhHost().
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Fixed per-stream cap for every bounded child (gh, git, publication git). */
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface BoundedChildSpec {
  /** Human label used in diagnostics ("gh", "git"). */
  label: string;
  program: string;
  argv: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  /** Absolute epoch-ms deadline of the owning run. */
  deadline: number;
  /** The run's shutdown signal; an abort kills the child immediately. */
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Single bounded subprocess runner shared by gh, target git and publication
 * git. The shutdown listener is attached before the child can do work and the
 * aborted state is re-checked synchronously after registration to close the
 * listener race; an abort kills the child and rejects as
 * ActionFailure("uncertain") so the journal reconciliation path runs. The
 * timer and listener are removed exactly once; timeouts still resolve with
 * `timedOut` so callers keep their existing classification.
 */
export function spawnBoundedChild(spec: BoundedChildSpec): Promise<GhResult> {
  const remaining = Math.min(spec.deadline - Date.now(), spec.timeoutMs ?? Number.POSITIVE_INFINITY);
  if (remaining <= 0) return Promise.reject(new ActionFailure("uncertain", `deadline expired before ${spec.label} invocation`));
  if (spec.signal.aborted) return Promise.reject(new ActionFailure("uncertain", `${spec.label} invocation aborted by shutdown before spawn`));
  return new Promise<GhResult>((resolvePromise, rejectPromise) => {
    const child = spawn(spec.program, spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: "stdout" | "stderr" | undefined;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      spec.signal.removeEventListener("abort", onAbort);
      return true;
    }
    function killTree(): void {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The process may have exited between the event and the kill.
        }
      }
      child.kill("SIGKILL");
    }
    function onAbort(): void {
      aborted = true;
      killTree();
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, remaining);
    spec.signal.addEventListener("abort", onAbort, { once: true });
    if (spec.signal.aborted) onAbort();
    // Fixed per-stream cap: on either stream's first over-cap chunk the whole
    // process group is killed and accumulation stops, so a hostile child
    // cannot balloon the parent's memory; the close event (which fires only
    // after BOTH stdio pipes drain and the child exits) then rejects with
    // honest uncertainty — the run never sees a truncated success.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) {
        if (!overflow) {
          overflow = "stdout";
          killTree();
        }
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
        if (!overflow) {
          overflow = "stderr";
          killTree();
        }
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!finish()) return;
      rejectPromise(new ActionFailure("uncertain", `${spec.label} spawn failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (!finish()) return;
      if (overflow) {
        rejectPromise(new ActionFailure("uncertain", `${spec.label} ${overflow} output exceeded the fixed ${MAX_CHILD_OUTPUT_BYTES} byte per-stream cap`));
        return;
      }
      if (aborted) {
        rejectPromise(new ActionFailure("uncertain", `${spec.label} aborted by shutdown`));
        return;
      }
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/**
 * SEC-REMOTE-004: every gh call targets the parsed github.com authority. A
 * caller-exported GH_HOST is rejected outright — it would redirect PR
 * operations (and their credentials) to an arbitrary host — except under the
 * explicit loopback fixture gate, which may pin a loopback host only.
 */
function resolveGhHost(): string {
  const override = process.env.GH_HOST?.trim();
  if (!override || override === "github.com") return "github.com";
  const host = override.split(":", 1)[0]!;
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(host);
  if (!loopback || process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES !== "1") {
    throw new Error(`GH_HOST=${override} is not permitted: Benny gh operations are locked to github.com (a loopback GH_HOST requires PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES=1)`);
  }
  return override;
}

export async function createBennyActions(options: BennyActionsOptions): Promise<BennyActions> {
  const { config, cwd, source, deadline, journal, signal, expectedRootDigest, runId } = options;
  // Tracker operations and child processes carry the run's shutdown signal;
  // without an explicit one (direct construction) a never-aborting signal
  // keeps the operation context total.
  const opSignal = signal ?? AbortSignal.any([]);
  const ghHost = resolveGhHost();
  // MCP mappings were withdrawn: OMP supplies no narrow host broker for
  // coordinator actions, so a configured mapping is unusable — refuse it
  // outright instead of accepting a config that can never execute.
  if ("mcp_actions" in config.runtime && config.runtime.mcp_actions) {
    throw new Error("runtime.mcp_actions is not supported: OMP supplies no narrow host MCP broker for Benny actions; remove it from configuration");
  }
  // Custom tracker modules were withdrawn: in-process operator JavaScript
  // cannot be forcibly cancelled, so only the bundled bounded Linear adapter
  // executes. parseBennyConfig rejects it, but a caller that constructed a
  // config object directly must hit the same explicit refusal here.
  if ("tracker_adapter" in config.runtime && config.runtime.tracker_adapter) {
    throw new Error("runtime.tracker_adapter is not supported: only the bundled bounded Linear tracker adapter executes; remove it from configuration");
  }
  // The configured-action preference is refused here too: parseBennyConfig
  // rejects it, but a caller that constructed a config object directly must
  // hit the same explicit refusal at the action boundary, never a silent
  // fallback to the bundled transports.
  if (config.slack.prefer_configured_actions) {
    throw new Error("slack.prefer_configured_actions=true is not supported: OMP supplies no host broker for configured actions; set it to false to use the bundled Slack/Linear/gh transports");
  }
  // Endpoint policy gates every credential-bearing transport (Slack/Linear/gh).
  assertBennyEndpointPolicy(config);
  const runtime = config.runtime;
  const slackBase = (runtime.slack_api_url ?? "https://slack.com/api").replace(/\/+$/, "");
  const readToken = process.env[runtime.slack_read_token_env] ?? "";
  const writeToken = process.env[runtime.slack_write_token_env] ?? "";
  if (!readToken) throw new Error(`Slack read token env ${runtime.slack_read_token_env} is not set`);
  if (!writeToken) throw new Error(`Slack write token env ${runtime.slack_write_token_env} is not set`);
  if (source.channel !== config.slack.source_channel_id) {
    throw new Error(`bound source channel ${source.channel} does not match configured source channel ${config.slack.source_channel_id}`);
  }
  const operationsChannel = config.slack.operations_channel_id;
  if (operationsChannel && operationsChannel === source.channel) {
    throw new Error("operations channel must differ from the source channel");
  }
  // Credential-safe download targets: Slack file hosts, plus the operator's configured API host (local fixture).
  const fileHosts = new Set(["files.slack.com", "files-origin.slack.com"]);
  let fixtureScheme: "http" | "https" = "https";
  if (runtime.slack_api_url) {
    const api = new URL(runtime.slack_api_url);
    fileHosts.add(api.hostname);
    fixtureScheme = api.protocol === "http:" ? "http" : "https";
  }

  // Team binding: both tokens must authenticate against the admitted team.
  const auth = await slackCall("auth.test", {}, { token: readToken });
  if (str(auth.team_id) !== source.teamId) throw new Error(`read token is bound to team ${str(auth.team_id)}, expected ${source.teamId}`);
  const writeAuth = await slackCall("auth.test", {}, { token: writeToken });
  if (str(writeAuth.team_id) !== source.teamId) throw new Error(`write token is bound to team ${str(writeAuth.team_id)}, expected ${source.teamId}`);
  // Identity binding: same-team is insufficient. Every Slack write (verdicts,
  // replies, operations statuses) is emitted by the configured triage
  // identity; a write token authenticating any other same-team user is
  // refused before a single write action is exposed.
  const writeUserId = str(writeAuth.user_id);
  if (writeUserId !== config.slack.triage_identity_user_id) {
    throw new Error(`write token identity ${writeUserId || "unknown"} is not the configured triage identity ${config.slack.triage_identity_user_id}`);
  }

  function checkDeadline(): void {
    if (Date.now() >= deadline) throw new ActionFailure("uncertain", "workflow deadline expired", undefined);
  }

  async function readBounded(response: Response): Promise<Uint8Array> {
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new ActionFailure("not-delivered", `download exceeds ${MAX_DOWNLOAD_BYTES} byte bound`);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new ActionFailure("not-delivered", `download exceeds ${MAX_DOWNLOAD_BYTES} byte bound`);
      }
      chunks.push(chunk.value);
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async function saveDownload(fileId: string, buffer: Uint8Array): Promise<string> {
    // REL-RETENTION-003: run-owned download storage — the retention sweep can
    // expire state/benny-downloads/<runId>/ with the run's evidence. Tests
    // without a run id keep the legacy flat cache.
    const dir = typeof runId === "number" && Number.isInteger(runId) && runId > 0
      ? securePrivateDir(cwd, ".omp", "pstack", "state", "benny-downloads", String(runId))
      : securePrivateDir(cwd, ".omp", "pstack", "state", "benny-downloads");
    const path = join(dir, fileId);
    try {
      await writeFile(path, buffer, { mode: 0o600, flag: "wx" });
    } catch (error) {
      const existing = await lstat(path).catch(() => undefined);
      if (!existing?.isFile() || existing.isSymbolicLink()) throw error;
      const prior = await readFile(path);
      if (!Buffer.from(prior).equals(Buffer.from(buffer))) throw new Error(`download path ${path} already contains different bytes`);
    }
    return path;
  }

  async function slackCall(
    method: string,
    body: Record<string, unknown>,
    opts: { token: string },
  ): Promise<Record<string, unknown>> {
    checkDeadline();
    let retryBudget = 10;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ActionFailure("uncertain", `deadline expired before Slack ${method}`);
      const signals: AbortSignal[] = [AbortSignal.timeout(remaining)];
      if (signal) signals.push(signal);
      let response: Response;
      try {
        response = await fetch(`${slackBase}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.token}` },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (signal?.aborted) throw new ActionFailure("uncertain", `aborted during Slack ${method}`);
        throw new ActionFailure("uncertain", `Slack ${method} transport uncertain: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 429) {
        // Release the rejected response's body before backoff — an unread
        // body must never outlive the retry decision or hold the connection.
        await releaseBody(response);
        if (--retryBudget <= 0) throw new ActionFailure("uncertain", `Slack ${method}: too many 429 retries`);
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        const wait = Math.min(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1, 30) * 1000;
        // The backoff races the run's shutdown signal and the absolute
        // deadline: shutdown wakes immediately, and the sleep never extends
        // the run past its deadline.
        const waited = await sleep(Math.min(wait, Math.max(0, deadline - Date.now())), signal);
        if (waited === "aborted") throw new ActionFailure("uncertain", `aborted during Slack ${method} Retry-After backoff`);
        continue;
      }
      if (!response.ok) {
        await releaseBody(response);
        throw new ActionFailure("uncertain", `Slack ${method} transport uncertain: HTTP ${response.status}`);
      }
      const data = await readBoundedJsonObject(response, `Slack ${method}`, MAX_SLACK_JSON_BYTES);
      if (data.ok !== true) {
        // A Slack API error response means the call definitively did not take effect.
        throw new ActionFailure("not-delivered", `Slack ${method} rejected: ${str(data.error)}`);
      }
      return data;
    }
  }

  function normalizeMessage(value: unknown): SlackMessage {
    if (!record(value)) throw new Error("Slack message is not an object");
    const message: SlackMessage = { ts: str(value.ts) };
    for (const field of ["type", "channel", "thread_ts", "user", "bot_id", "subtype", "text", "client_msg_id"] as const) {
      const v = value[field];
      if (typeof v === "string" && v !== "") Object.assign(message, { [field]: v });
    }
    if (Array.isArray(value.files)) message.files = value.files.filter(record);
    return message;
  }

  async function fetchReplies(channel: string, ts: string, limit: number): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SLACK_PAGES; page++) {
      const body: Record<string, unknown> = { channel, ts, limit, inclusive: true };
      if (cursor) body.cursor = cursor;
      const data = await slackCall("conversations.replies", body, { token: readToken });
      for (const m of data.messages as unknown[]) messages.push(normalizeMessage(m));
      const meta = record(data.response_metadata) ? data.response_metadata : {};
      const next = str(meta.next_cursor);
      if (data.has_more === true && next) {
        cursor = next;
        continue;
      }
      if (data.has_more === true) throw new ActionFailure("uncertain", `thread ${ts} reports has_more without a pagination cursor`);
      return messages;
    }
    throw new ActionFailure("uncertain", `thread ${ts} pagination did not terminate`);
  }

  async function fetchHistory(channel: string, extra: Record<string, unknown> = {}): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SLACK_PAGES; page++) {
      const body: Record<string, unknown> = { channel, limit: 200, ...extra };
      if (cursor) body.cursor = cursor;
      const data = await slackCall("conversations.history", body, { token: readToken });
      for (const m of data.messages as unknown[]) messages.push(normalizeMessage(m));
      const meta = record(data.response_metadata) ? data.response_metadata : {};
      const next = str(meta.next_cursor);
      if (data.has_more === true && next) {
        cursor = next;
        continue;
      }
      return messages;
    }
    throw new ActionFailure("uncertain", `history for ${channel} pagination did not terminate`);
  }

  /** Source gate: the bound parent must still exist, be undeleted, and keep its exact coordinates before any write. */
  async function preflight(): Promise<SlackMessage> {
    let data: SlackMessage[];
    try {
      data = await fetchReplies(source.channel, source.rootTs, 1);
    } catch (error) {
      if (error instanceof ActionFailure && error.certainty === "uncertain") throw error;
      throw new ActionFailure("not-delivered", `source gate: root ${source.rootTs} unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const root = data.find((m) => m.ts === source.rootTs);
    if (!root) {
      throw new ActionFailure("not-delivered", `source gate: root ${source.rootTs} missing in ${source.channel}`);
    }
    if (root.subtype === "tombstone" || root.subtype === "message_deleted") {
      throw new ActionFailure("not-delivered", `source gate: root ${source.rootTs} was deleted`);
    }
    const digest = rootDigest(root);
    if (digest !== expectedRootDigest) {
      throw new ActionFailure("not-delivered", `source gate: root ${source.rootTs} changed since admission (digest mismatch); no write performed`);
    }
    return root;
  }

  async function threadReceipt(ts: string, observed: Record<string, unknown>): Promise<RemoteReceipt> {
    let url: string | undefined;
    try {
      const p = await slackCall("chat.getPermalink", { channel: source.channel, message_ts: ts }, { token: readToken });
      url = str(p.permalink) || undefined;
    } catch {
      // Permalink is cosmetic; the verified readback is the thread membership check.
    }
    return { id: ts, url, verified: true, observed };
  }

  async function verifyPostedReply(ts: string, expectedClientMsgId: string, expectedText: string): Promise<RemoteReceipt> {
    const thread = await fetchReplies(source.channel, source.rootTs, 200);
    const posted = thread.find((m) => m.ts === ts);
    const confirmed =
      posted !== undefined &&
      posted.thread_ts === source.rootTs &&
      posted.client_msg_id === expectedClientMsgId &&
      posted.user === writeUserId &&
      posted.text === expectedText;
    if (!confirmed) {
      throw new ActionFailure("uncertain", `posted message ${ts} not yet visible in source thread`);
    }
    return threadReceipt(ts, {
      channel: source.channel,
      thread_ts: source.rootTs,
      client_msg_id: posted.client_msg_id,
      user: posted.user,
      text: posted.text,
      reply_broadcast: false,
    });
  }

  /** Deterministic mutation frame: journal intent first, source gate, idempotent replay, reconcile on uncertainty. The verified receipt and the resume checkpoint commit in one transaction. */
  async function mutate(
    actionId: string,
    kind: string,
    input: unknown,
    opts: { sourceGate: boolean },
    dispatch: () => Promise<RemoteReceipt>,
    reconcile: () => Promise<RemoteReceipt | null>,
    continuation?: ActionContinuation,
  ): Promise<RemoteReceipt> {
    const begun = journal.begin(actionId, kind, input);
    if (begun.state === "done" && begun.receipt) return begun.receipt;
    if (opts.sourceGate) await preflight();
    if (begun.state === "uncertain") {
      const recovered = await reconcile();
      if (recovered) {
        journal.complete(actionId, recovered, continuation);
        return recovered;
      }
      throw new ActionFailure("uncertain", `action ${kind} ${actionId} is unresolved from a previous attempt; refusing to resend`, actionId);
    }
    try {
      const receipt = await dispatch();
      journal.complete(actionId, receipt, continuation);
      return receipt;
    } catch (error) {
      if (error instanceof ActionFailure && error.certainty === "uncertain") {
        journal.uncertain(actionId, error.message);
        const recovered = await reconcile().catch(() => null);
        if (recovered) {
          journal.complete(actionId, recovered, continuation);
          return recovered;
        }
      }
      throw error;
    }
  }

  // Tracker calls no longer race a detached adapter promise: every adapter
  // method receives the operation context (signal + absolute deadline) and
  // settles with the transport, so awaiting the action IS awaiting the
  // adapter's acknowledgement — the run/socket barrier cannot leave a
  // tracker mutation running past a settled shutdown.
  /** Tracker adapter errors carry certainty: definite GraphQL rejections are not-delivered; anything else is honest uncertainty. */
  function wrapTrackerError(error: unknown, actionId: string): unknown {
    if (error instanceof ActionFailure) return error;
    if (!(error instanceof Error)) return error;
    if (error.message.includes("canceled workflow state missing")) return new CanceledStateMissingError(error.message);
    if (error.message.startsWith("Linear rejected request (definite)") || error.message.startsWith("Linear rejected request:")) {
      return new ActionFailure("not-delivered", error.message, actionId);
    }
    return new ActionFailure("uncertain", error.message, actionId);
  }

  // ---- tracker ----

  const trackerToken = process.env[runtime.tracker_token_env];
  if (!trackerToken) throw new Error(`tracker token env ${runtime.tracker_token_env} is not set`);
  const trackerCtx: TrackerOperationContext = { signal: opSignal, deadline };
  const linear = new LinearTracker({
    apiUrl: runtime.linear_api_url ?? "https://api.linear.app/graphql",
    token: trackerToken,
    team: config.tracker.team,
    project: config.tracker.project,
    labels: {
      bug: config.tracker.labels.bug,
      performance: config.tracker.labels.performance,
      intake: config.tracker.labels.intake,
      needsRepro: config.tracker.labels.needs_repro,
    },
    status: config.tracker.status,
  });
  const tracker: TrackerAdapter = linear;

  const sourcePermalink = async (): Promise<string> => {
    const p = await slackCall("chat.getPermalink", { channel: source.channel, message_ts: source.rootTs }, { token: readToken });
    const url = str(p.permalink);
    if (!url) throw new Error("Slack returned no permalink for the source thread");
    return url;
  };

  const { owner, repo } = parseGitHubSlug(
    config.repository.url,
    process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES === "1" ? config.repository.pull_request_url_format : undefined,
  );
  const slug = `${owner}/${repo}`;
  // SEC-REMOTE-001: the approved credential origin derived from the
  // structurally parsed configured repository; a local-path fixture has
  // none, so the publication credential helper never emits a token.
  const credentialOrigin = (() => {
    try {
      const ref = parseGitHubRepository(config.repository.url);
      if (!ref.protocol || !ref.host || !/^[a-z0-9.-]+$/.test(ref.host)) return undefined;
      return { protocol: ref.protocol, host: ref.host };
    } catch {
      return undefined;
    }
  })();

  function gh(argv: readonly string[], timeoutMs?: number): Promise<GhResult> {
    return spawnBoundedChild({ label: "gh", program: "gh", argv, env: { ...envAllowlist(), GH_HOST: ghHost }, deadline, signal: opSignal, timeoutMs });
  }

  function git(argv: readonly string[], extraEnv: Record<string, string> = {}, timeoutMs = 120_000): Promise<GhResult> {
    return spawnBoundedChild({ label: "git", program: "git", argv, cwd, env: { ...envAllowlist(), ...extraEnv }, deadline, signal: opSignal, timeoutMs });
  }

  // SEC-GIT-001: a runner-owned scratch repository for all staging and
  // network publication. Its config is freshly initialized and empty — the
  // target checkout's local url.*.insteadOf/pushInsteadOf rewrites,
  // core.sshCommand, credential helpers, hooks and clean filters can never
  // redirect or execute during publication. GIT_DIR is pinned to the scratch
  // repo on every invocation, so Git never rediscovers the target checkout's
  // .git (including when -C enters the staging worktree). Target objects are
  // read through GIT_ALTERNATE_OBJECT_DIRECTORIES resolved with
  // `git rev-parse --git-path objects`, which yields the shared common
  // objects directory for linked worktrees; the exact configured URL is the
  // only remote and the runner-owned credential helper script the only
  // explicit credential path (it reads the runner env's GitHub token and
  // emits nothing when absent, so anonymous loopback fixtures keep working).
  let publicationDir: string | undefined;
  let targetObjects: string | undefined;

  /**
   * SEC-GIT-002: the run-owned publication scratch child is predictable (the
   * numeric run id), so a local attacker can pre-plant it before first use.
   * First use trusts nothing already at that path: the exact child is
   * lstat'ed without following (symlinks and non-directories are refused),
   * an existing exactly-contained real scratch child left by a previous
   * attempt is removed, and the directory is recreated exclusively with mode
   * 0700. Canonical direct-child containment and an absent .git are then
   * verified, so git init and the credential-helper append always operate on
   * a freshly created, runner-owned repository — pre-existing config is
   * never read, executed or appended to.
   */
  async function preparePublicationScratch(root: string, name: string): Promise<string> {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes(sep)) {
      throw new Error(`publication scratch '${name}' is not a single direct-child segment of the publication root`);
    }
    const dir = join(root, name);
    const planted = await lstat(dir).catch(() => undefined);
    if (planted) {
      if (planted.isSymbolicLink() || !planted.isDirectory()) {
        throw new Error(`refusing planted publication scratch ${dir}: not a real directory`);
      }
      const realRoot = realpathSync(root);
      const realDir = realpathSync(dir);
      if (dirname(realDir) !== realRoot || basename(realDir) !== name) {
        throw new Error(`refusing to reuse publication scratch ${dir}: resolves outside the run-owned publication root`);
      }
      // rm removes tree entries without following symlinks.
      await rm(dir, { recursive: true, force: true });
    }
    // Exclusive recreation: a racer that recreates the path first loses with
    // EEXIST, and the mode is re-enforced against a hostile umask.
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dir);
    if (dirname(realDir) !== realRoot || basename(realDir) !== name) {
      throw new Error(`publication scratch ${dir} does not resolve to a direct child of the run-owned publication root`);
    }
    if (await lstat(join(dir, ".git")).catch(() => undefined)) {
      throw new Error(`publication scratch ${dir} unexpectedly contains .git before init`);
    }
    return dir;
  }

  async function publicationGit(
    argv: readonly string[],
    extraEnv: Record<string, string> = {},
    timeoutMs = 120_000,
    needsTargetObjects = true,
  ): Promise<GhResult> {
    if (!publicationDir) {
      const root = securePrivateDir(cwd, ".omp", "pstack", "state", "benny-publication");
      // Run-owned scratch: the numeric run id when the run supplies one, so
      // the workspace retention sweep expires crash-left directories under
      // the same active-run policy as downloads/snapshots. A random name is
      // only for direct constructions without a run (tests).
      const name = typeof runId === "number" && Number.isInteger(runId) && runId > 0 ? String(runId) : randomUUID();
      const dir = await preparePublicationScratch(root, name);
      const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...envAllowlist(), ...PUBLICATION_GIT_ENV }, stdout: "pipe", stderr: "pipe" });
      if (init.exitCode !== 0) throw new Error(`cannot create sanitized publication repository: ${init.stderr.toString().trim().split("\n", 1)[0] ?? ""}`);
      // The repository receiving the credential helper must be the one git
      // just created: a real .git directory, never a pre-existing or
      // planted one.
      const gitDir = lstatSync(join(dir, ".git"));
      if (gitDir.isSymbolicLink() || !gitDir.isDirectory()) {
        throw new Error(`refusing publication scratch ${dir}: git init did not create a real .git directory`);
      }
      // The only credential mechanism: a runner-owned helper under the
      // private state root (0700 dir, 0700 script), never the target repo's
      // local config. It answers Git's credential-protocol request and emits
      // a token only for the approved protocol/host; credentials travel via
      // the child environment only.
      const helper = join(dir, "git-credential.sh");
      await writeFile(helper, gitCredentialHelperScript(credentialOrigin), { mode: 0o700 });
      const quoted = helper.replace(/'/g, "'\\''");
      await appendFile(join(dir, ".git", "config"), `[credential]\n\thelper = !/bin/sh '${quoted}'\n`);
      publicationDir = dir;
    }
    if (needsTargetObjects && !targetObjects) {
      // --git-path objects resolves the shared object store even from a
      // linked worktree (whose per-worktree git dir has no objects/); ask
      // for an absolute path when the installed git supports it.
      let probe = await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], PUBLICATION_GIT_ENV);
      if (probe.code !== 0 || probe.timedOut || !probe.stdout.trim()) {
        probe = await git(["rev-parse", "--git-path", "objects"], PUBLICATION_GIT_ENV);
      }
      if (probe.code !== 0 || probe.timedOut || !probe.stdout.trim()) {
        throw new ActionFailure("uncertain", `target git directory is unreadable: ${probe.stderr.trim().split("\n", 1)[0] ?? ""}`);
      }
      targetObjects = resolve(cwd, probe.stdout.trim());
    }
    const env = {
      ...envAllowlist(),
      ...PUBLICATION_GIT_ENV,
      GIT_DIR: join(publicationDir, ".git"),
      ...(targetObjects ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: targetObjects } : {}),
      ...extraEnv,
    };
    return spawnBoundedChild({ label: "git", program: "git", argv, cwd: publicationDir, env, deadline, signal: opSignal, timeoutMs });
  }

  /** Reconcile a published branch: the exact head ref must sit at the verified commit on the configured remote. */
  function reconcileHeadAt(configuredUrl: string, head: string, oid: string, baseOid: string, tree?: string): () => Promise<RemoteReceipt | null> {
    return async () => {
      const remote = await publicationGit(["ls-remote", "--exit-code", configuredUrl, `refs/heads/${head}`], {}, 60_000, false);
      const found = remote.stdout.trim().split(/\s+/, 1)[0];
      if (remote.code !== 0 || remote.timedOut || found !== oid) return null;
      return { id: head, verified: true, observed: { head, oid, tree, baseOid, recovered: true } };
    };
  }
  /**
   * Idempotent close: removes ONLY this run's exact publication scratch
   * directory, and only through the same containment/non-symlink validation
   * the resume path reads through. Until removal succeeds the directory
   * stays recorded, so a failed close is retried (or left to the retention
   * sweep) rather than silently dropped.
   */
  async function close(): Promise<void> {
    const dir = publicationDir;
    if (!dir) return;
    const root = securePrivateDir(cwd, ".omp", "pstack", "state", "benny-publication");
    const name = basename(dir);
    if (resolve(dir) !== resolve(join(root, name))) {
      throw new Error(`publication scratch ${dir} is not a direct child of the private publication root`);
    }
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return; // already gone; still idempotent
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to remove publication scratch ${dir}: not a real directory`);
    }
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dir);
    if (dirname(realDir) !== realRoot || basename(realDir) !== name) {
      throw new Error(`refusing to remove publication scratch ${dir}: resolves outside the run-owned publication root`);
    }
    await rm(dir, { recursive: true, force: true });
    publicationDir = undefined;
  }

  async function ghJson<T>(argv: readonly string[], label: string): Promise<T> {
    const result = await gh(argv);
    if (result.timedOut) throw new ActionFailure("uncertain", `gh ${label} timed out`);
    if (result.code !== 0) {
      throw new ActionFailure("not-delivered", `gh ${label} failed: ${(result.stderr.trim().split("\n", 1)[0] ?? "").slice(0, 240)}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new ActionFailure("uncertain", `gh ${label} returned unparseable JSON`);
    }
  }

  interface GhPr {
    number: number;
    url: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid?: string;
    baseRefName: string;
    baseRefOid?: string;
    state?: string;
    title?: string;
  }

  /** Generic PR readback: any state is reportable (verify-existing-fix reads ordinary PRs); head/base must match when a create is reconciled. */
  function prReceipt(
    pr: GhPr,
    input?: { head: string; headOid: string; base: string; baseOid: string },
  ): RemoteReceipt {
    if (typeof pr.number !== "number" || typeof pr.url !== "string") {
      throw new ActionFailure("not-delivered", `gh readback is not a pull request: ${JSON.stringify({ number: pr.number, isDraft: pr.isDraft })}`);
    }
    if (input && (pr.headRefName !== input.head || pr.baseRefName !== input.base)) {
      throw new ActionFailure("not-delivered", `gh readback head/base mismatch: ${pr.headRefName} -> ${pr.baseRefName}`);
    }
    if (input && pr.headRefOid !== input.headOid) {
      throw new ActionFailure("not-delivered", `gh readback head OID mismatch: ${pr.headRefOid ?? "missing"} != ${input.headOid}`);
    }
    if (input && pr.baseRefOid !== input.baseOid) {
      throw new ActionFailure("not-delivered", `gh readback base OID mismatch: ${pr.baseRefOid ?? "missing"} != ${input.baseOid}`);
    }
    if (input && pr.isDraft !== true) {
      throw new ActionFailure("not-delivered", `created pull request is not a draft: ${JSON.stringify({ number: pr.number, isDraft: pr.isDraft })}`);
    }
    return {
      id: String(pr.number),
      url: pr.url,
      verified: true,
      observed: { isDraft: pr.isDraft, head: pr.headRefName, headOid: pr.headRefOid, base: pr.baseRefName, baseOid: pr.baseRefOid, state: pr.state ?? "unknown" },
    };
  }

  /** REST readback of immutable head/base OIDs; gh pr list alone does not carry the base SHA. */
  async function restPrOids(number: number): Promise<{ headSha?: string; baseSha?: string }> {
    const rest = await ghJson<{ head?: { sha?: string }; base?: { sha?: string } }>(["api", `repos/${slug}/pulls/${number}`], `api pull ${number}`);
    return { headSha: rest.head?.sha, baseSha: rest.base?.sha };
  }

  async function reconcileGhCreate(input: { head: string; headOid: string; base: string; baseOid: string }): Promise<RemoteReceipt | null> {
    const list = await ghJson<GhPr[]>(["pr", "list", "--repo", slug, "--state", "open", "--head", input.head, "--json", "number,url,isDraft,headRefName,headRefOid,baseRefName"], "pr list");
    const match = list.find((pr) => pr.headRefName === input.head && pr.headRefOid === input.headOid && pr.baseRefName === input.base);
    if (!match) return null;
    const oids = await restPrOids(match.number);
    match.headRefOid = oids.headSha ?? match.headRefOid;
    match.baseRefOid = oids.baseSha;
    const receipt = prReceipt(match, input);
    return { ...receipt, observed: { ...receipt.observed, recovered: true } };
  }

  return {
    async readRoot() {
      checkDeadline();
      const thread = await fetchReplies(source.channel, source.rootTs, 1);
      const root = thread.find((m) => m.ts === source.rootTs);
      if (!root) throw new ActionFailure("not-delivered", `root ${source.rootTs} missing in ${source.channel}`);
      const digest = rootDigest(root);
      if (digest !== expectedRootDigest) {
        throw new ActionFailure("not-delivered", `root ${source.rootTs} changed since admission (digest mismatch)`);
      }
      return root;
    },

    async readThread() {
      checkDeadline();
      return fetchReplies(source.channel, source.rootTs, 200);
    },

    async readOperationsThread(rootTs: string) {
      checkDeadline();
      if (!operationsChannel) throw new Error("slack.operations_channel_id is not configured");
      if (!/^\d+\.\d+$/.test(rootTs)) throw new Error("operations root timestamp is invalid");
      return fetchReplies(operationsChannel, rootTs, 200);
    },

    async permalink() {
      checkDeadline();
      return sourcePermalink();
    },

    async download(fileId: string) {
      checkDeadline();
      if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new Error(`invalid file id: ${fileId}`);
      const thread = await fetchReplies(source.channel, source.rootTs, 200);
      let file: Record<string, unknown> | undefined;
      for (const message of thread) {
        for (const candidate of message.files ?? []) {
          if (record(candidate) && candidate.id === fileId) file = candidate;
        }
      }
      if (!file) throw new Error(`file ${fileId} is not attached to the bound source thread`);
      const rawUrl = str(file.url_private_download) || str(file.url_private);
      if (!rawUrl) throw new Error(`file ${fileId} has no downloadable URL`);
      const validateUrl = (value: string): URL => {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new ActionFailure("not-delivered", `download URL is not a valid URL`);
        }
        const scheme = parsed.protocol === "http:" ? "http" : parsed.protocol === "https:" ? "https" : null;
        const fixtureHost = runtime.slack_api_url ? new URL(runtime.slack_api_url).hostname : null;
        // Plain http is only tolerated for the operator's configured (fixture) API host; real Slack files are https.
        const httpAllowed = scheme === "http" && fixtureHost !== null && parsed.hostname === fixtureHost;
        if (!scheme || !fileHosts.has(parsed.hostname) || (scheme === "http" && !httpAllowed) || parsed.username || parsed.password) {
          throw new ActionFailure("not-delivered", `download URL host ${parsed.hostname} is not an allowed Slack file host`);
        }
        return parsed;
      };
      let target = validateUrl(rawUrl);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await fetch(target, {
          headers: { authorization: `Bearer ${readToken}` },
          redirect: "manual",
          signal: AbortSignal.any(signal ? [AbortSignal.timeout(deadline - Date.now()), signal] : [AbortSignal.timeout(deadline - Date.now())]),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new ActionFailure("not-delivered", `download redirect without location`);
          target = validateUrl(new URL(location, target).toString());
          continue;
        }
        break;
      }
      if (!response || response.status !== 200) throw new ActionFailure("not-delivered", `download failed with HTTP ${response?.status ?? 0}`);
      const buffer = await readBounded(response);
      // Media type is derived from bytes only. Declared image/video MIME from
      // Slack metadata or response headers is never trusted: any declared
      // image/video that mismatches the byte-detected type — or whose bytes
      // have no valid supported magic — is rejected, so the model image path
      // only ever sees positively validated PNG/JPEG bytes.
      const detected = detectMediaMime(buffer);
      const declared = (str(file.mimetype) || response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (/^(image|video)\//.test(declared) && detected !== declared) {
        throw new ActionFailure("not-delivered", `attachment declares ${declared || "no MIME"} but its bytes are ${detected ?? "not a supported media format"}; refusing the declared MIME`);
      }
      const path = await saveDownload(fileId, buffer);
      return {
        path,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        mimeType: detected ?? "application/octet-stream",
      };
    },

    async postThread(actionId: string, text: string, opts?: MutationOptions) {
      // Central mention policy: every source post strips broadcast tokens and
      // user mentions outside the explicitly supplied per-route allowlist.
      const finalText = stripDisallowedMentions(text, true, opts?.allowedUserIds ?? options.allowedMentionUserIds ?? new Set<string>());
      if (!finalText.trim()) throw new Error("refusing to post an empty source reply");
      const expectedClientMsgId = clientId(actionId);
      const dispatch = async (): Promise<RemoteReceipt> => {
        const result = await slackCall(
          "chat.postMessage",
          { channel: source.channel, thread_ts: source.rootTs, text: finalText, reply_broadcast: false, client_msg_id: expectedClientMsgId },
          { token: writeToken },
        );
        const ts = str(result.ts);
        if (!ts) throw new ActionFailure("uncertain", "Slack accepted the post but returned no ts");
        return verifyPostedReply(ts, expectedClientMsgId, finalText);
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const thread = await fetchReplies(source.channel, source.rootTs, 200);
        const posted = thread.find((m) =>
          m.ts !== source.rootTs &&
          m.thread_ts === source.rootTs &&
          m.client_msg_id === expectedClientMsgId &&
          m.user === writeUserId &&
          m.text === finalText,
        );
        if (!posted) return null;
        return threadReceipt(posted.ts, {
          channel: source.channel,
          thread_ts: source.rootTs,
          client_msg_id: expectedClientMsgId,
          user: posted.user,
          reply_broadcast: false,
          recovered: true,
        });
      };
      return mutate(actionId, "slack.postThread", { text: finalText }, { sourceGate: true }, dispatch, reconcile, opts?.continuation);
    },
    async operationsUpdate(actionId: string, text: string, rootTs?: string) {
      // Central mention policy: operations-channel STATUS text never pings —
      // broadcast tokens and every user mention are stripped before dispatch,
      // so model-derived ownership reasons cannot induce pings.
      const finalText = stripDisallowedMentions(text, false);
      if (!operationsChannel) throw new Error("slack.operations_channel_id is not configured; detailed status stays in run output");
      if (rootTs) {
        const dispatch = async (): Promise<RemoteReceipt> => {
          await slackCall("chat.update", { channel: operationsChannel, ts: rootTs, text: finalText }, { token: writeToken });
          const history = await fetchHistory(operationsChannel, { latest: rootTs, inclusive: true, limit: 1 });
          const updated = history.find((m) => m.ts === rootTs);
          if (!updated || updated.user !== writeUserId || updated.text !== finalText) throw new ActionFailure("uncertain", "operations status update not visible after edit");
          return { id: rootTs, verified: true, observed: { channel: operationsChannel, ts: rootTs, text: finalText } };
        };
        const reconcile = async (): Promise<RemoteReceipt | null> => {
          const history = await fetchHistory(operationsChannel, { latest: rootTs, inclusive: true, limit: 1 });
          const updated = history.find((m) => m.ts === rootTs);
          if (updated?.user !== writeUserId || updated.text !== finalText) return null;
          return { id: rootTs, verified: true, observed: { channel: operationsChannel, ts: rootTs, user: updated.user, text: finalText, recovered: true } };
        };
        return mutate(actionId, "slack.operations.update", { text: finalText, rootTs }, { sourceGate: false }, dispatch, reconcile);
      }
      // The only allowed root post outside the source thread: one status root in the operations channel.
      const expectedClientMsgId = clientId(actionId);
      const dispatch = async (): Promise<RemoteReceipt> => {
        let ts: string;
        const result = await slackCall(
          "chat.postMessage",
          { channel: operationsChannel, text: finalText, client_msg_id: expectedClientMsgId },
          { token: writeToken },
        );
        ts = str(result.ts);
        if (!ts) throw new ActionFailure("uncertain", "operations root post accepted without ts");
        const history = await fetchHistory(operationsChannel, { latest: ts, inclusive: true, limit: 1 });
        const posted = history.find((m) =>
          m.ts === ts &&
          m.client_msg_id === expectedClientMsgId &&
          m.user === writeUserId &&
          m.text === finalText,
        );
        if (!posted) throw new ActionFailure("uncertain", `operations root ${ts} not visible after post`);
        return { id: ts, verified: true, observed: { channel: operationsChannel, ts, user: posted.user, text: finalText, root: true } };
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const history = await fetchHistory(operationsChannel, {});
        const posted = history.find((m) =>
          m.client_msg_id === expectedClientMsgId &&
          m.user === writeUserId &&
          m.text === finalText,
        );
        if (!posted) return null;
        return { id: posted.ts, verified: true, observed: { channel: operationsChannel, ts: posted.ts, user: posted.user, text: finalText, root: true, recovered: true } };
      };
      return mutate(actionId, "slack.operations.post", { text: finalText }, { sourceGate: false }, dispatch, reconcile);
    },


    async postOperationsReply(actionId: string, rootTs: string, text: string, opts?: MutationOptions) {
      // Central mention policy: operations replies default to NO user
      // mentions; only an explicitly supplied per-call allowlist can keep one.
      const finalText = stripDisallowedMentions(text, true, opts?.allowedUserIds ?? new Set<string>());
      if (!operationsChannel) throw new Error("slack.operations_channel_id is not configured");
      if (!finalText.trim()) throw new Error("refusing to post an empty operations reply");
      const expectedClientMsgId = clientId(actionId);
      const dispatch = async (): Promise<RemoteReceipt> => {
        const posted = await slackCall(
          "chat.postMessage",
          { channel: operationsChannel, thread_ts: rootTs, text: finalText, reply_broadcast: false, client_msg_id: expectedClientMsgId },
          { token: writeToken },
        );
        const ts = str(posted.ts);
        if (!ts) throw new ActionFailure("uncertain", "operations reply accepted without ts");
        const thread = await fetchReplies(operationsChannel, rootTs, 200);
        const readback = thread.find((message) =>
          message.ts === ts &&
          message.thread_ts === rootTs &&
          message.client_msg_id === expectedClientMsgId &&
          message.user === writeUserId &&
          message.text === finalText,
        );
        if (!readback) throw new ActionFailure("uncertain", `operations reply ${ts} not visible after post`);
        return { id: ts, verified: true, observed: { channel: operationsChannel, thread_ts: rootTs, user: readback.user, text: finalText, reply_broadcast: false } };
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const thread = await fetchReplies(operationsChannel, rootTs, 200);
        const readback = thread.find((message) =>
          message.thread_ts === rootTs &&
          message.client_msg_id === expectedClientMsgId &&
          message.user === writeUserId &&
          message.text === finalText,
        );
        return readback ? { id: readback.ts, verified: true, observed: { channel: operationsChannel, thread_ts: rootTs, user: readback.user, text: finalText, reply_broadcast: false, recovered: true } } : null;
      };
      return mutate(actionId, "slack.operations.reply", { rootTs, text: finalText }, { sourceGate: false }, dispatch, reconcile, opts?.continuation);
    },

    async trackerResolve() {
      checkDeadline();
      try {
        const target = await tracker.resolve(trackerCtx);
        return { id: `${config.tracker.type}:${target.teamId}`, verified: true, observed: { ...target } };
      } catch (error) {
        if (error instanceof Error && error.message.includes("canceled workflow state missing")) {
          throw new CanceledStateMissingError(error.message);
        }
        throw error;
      }
    },

    async trackerSearch(query: string) {
      checkDeadline();
      if (!query.trim()) throw new Error("tracker search query is empty");
      return tracker.search(query, trackerCtx);
    },

    async trackerRead(id: string) {
      checkDeadline();
      return tracker.read(id, trackerCtx);
    },

    async trackerCreate(actionId: string, input, opts?: MutationOptions) {
      // Per-action marker in the description makes reconcile unique even when several
      // creates share one source-thread permalink.
      const marker = `benny-run-action: ${actionId}`;
      const dispatch = async (): Promise<RemoteReceipt> => {
        const permalink = await sourcePermalink();
        const description = `${input.description}\n\n${config.tracker.source_link_title}: ${permalink}\n${marker}`;
        try {
          return await tracker.create(actionId, { ...input, description }, trackerCtx);
        } catch (error) {
          throw wrapTrackerError(error, actionId);
        }
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const hits = await tracker.search(marker, trackerCtx);
        const existing = findCreatedIssue(hits, marker);
        if (!existing) return null;
        // Never trust the search echo: the found issue is re-read by id and
        // must match the exact title, configured intake state, configured
        // project and every required label before a recovered receipt is
        // issued. A mismatch stays unresolved for the coordinator to block on.
        const verified = await linear
          .verifyCreated(existing.id, { title: input.title, category: input.category }, trackerCtx)
          .catch((error: unknown) => wrapTrackerError(error, actionId) as never);
        return { ...verified, observed: { ...verified.observed, recovered: true } };
      };
      return mutate(actionId, "tracker.create", { title: input.title, category: input.category }, { sourceGate: true }, dispatch, reconcile, opts?.continuation);
    },

    async trackerRecurrence(actionId: string, id: string, description: string) {
      const dispatch = async (): Promise<RemoteReceipt> => {
        try {
          return await tracker.recurrence(actionId, id, description, trackerCtx);
        } catch (error) {
          throw wrapTrackerError(error, actionId);
        }
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const read = await tracker.read(id, trackerCtx);
        const comments = read.observed.comments;
        if (Array.isArray(comments) && comments.includes(description)) {
          return { id: read.id, url: read.url, verified: true, observed: { issueId: read.id, recurrence: description, recovered: true } };
        }
        return null;
      };
      return mutate(actionId, "tracker.recurrence", { id, description }, { sourceGate: true }, dispatch, reconcile);
    },

    async trackerCompensate(actionId: string, id: string) {
      const dispatch = async (): Promise<RemoteReceipt> => {
        try {
          return await tracker.compensate(actionId, id, trackerCtx);
        } catch (error) {
          throw wrapTrackerError(error, actionId);
        }
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => {
        const read = await tracker.read(id, trackerCtx);
        if (String(read.observed.stateType ?? "").toLowerCase() === "canceled") {
          return { id: read.id, url: read.url, verified: true, observed: { state: read.observed.state, canceled: true, recovered: true } };
        }
        return null;
      };
      // Compensation acts on an issue this run verified as created (the
      // coordinator passes only verified create receipts). It must work after
      // the source is lost or deleted — never gated on reading the source again.
      return mutate(actionId, "tracker.compensate", { id }, { sourceGate: false }, dispatch, reconcile);
    },

    async publishBranch(actionId: string, input: { sourceDir?: string; sourceManifest?: string; head: string; base: string; baseOid: string; message?: string; commit?: string }, opts?: MutationOptions) {
      // Replay safety: a resumed dispatch carries no workspace (sourceDir is
      // empty and staging cannot rerun). When the journal already holds the
      // verified receipt, return it before any validation or git access.
      const replayed = journal.peek?.(actionId);
      if (replayed?.state === "done" && replayed.receipt) return replayed.receipt;
      if (!input.sourceDir) {
        // Reconcile-only resume: without a workspace nothing can be restaged
        // or resent. The persisted commit OID from the journal input is the
        // only acceptable head; an exact ls-remote match at the configured
        // remote completes through mutate's reconcile, any mismatch or
        // transport failure stays uncertain for the coordinator to resolve.
        if (!/^benny\/run-\d+-[0-9a-f]{12}$/.test(input.head)) throw new Error(`refusing unsafe Benny branch name: ${input.head}`);
        if (!/^[0-9a-f]{40,64}$/.test(input.commit ?? "")) throw new Error("reconcile-only publication requires the persisted commit OID");
        // REL: the persisted verified tree binds the recovered receipt so
        // draft publication stays bound to the exact journaled snapshot —
        // a receipt without observed.tree would block the draft transition.
        if (!/^[0-9a-f]{40,64}$/.test(input.sourceManifest ?? "")) {
          throw new Error("reconcile-only publication requires the persisted verified workspace tree OID");
        }
        const configuredUrl = canonicalRemoteUrl(config.repository.url);
        return mutate(
          actionId,
          "git.publishBranch",
          { head: input.head, base: input.base, baseOid: input.baseOid, tree: input.sourceManifest, commit: input.commit },
          { sourceGate: false },
          async () => {
            throw new ActionFailure("uncertain", "resumed publication carries no workspace; staging cannot rerun and nothing is resent", actionId);
          },
          reconcileHeadAt(configuredUrl, input.head, input.commit!, input.baseOid, input.sourceManifest),
          opts?.continuation,
        );
      }
      if (!/^benny\/run-\d+-[0-9a-f]{12}$/.test(input.head)) throw new Error(`refusing unsafe Benny branch name: ${input.head}`);
      const sourceManifest = input.sourceManifest;
      const message = input.message;
      if (!sourceManifest || !/^[0-9a-f]{40,64}$/.test(sourceManifest)) throw new Error(`workspace snapshot is not a git tree OID: ${sourceManifest ?? "missing"}`);
      if (!message) throw new Error("publication commit message is missing");
      if (!/^[0-9a-f]{40,64}$/.test(input.baseOid)) throw new Error(`admitted base revision is not a commit OID: ${input.baseOid}`);
      // SEC-PATH-001: lstat/realpath component containment — a planted
      // symlink at any intermediate component (e.g. benny-publish-source)
      // must never redirect staging or deletion-adjacent cleanup.
      const privateRoot = resolve(stateDir(cwd));
      const sourceDir = securePublicationSource(privateRoot, input.sourceDir);
      // Publication binding: the checkout's origin (read as the raw config
      // value, so no insteadOf rewrite can fake the match) must canonicalize
      // to the configured repository URL.
      const remoteProbe = await git(["config", "--get", "remote.origin.url"], PUBLICATION_GIT_ENV);
      if (remoteProbe.code !== 0 || !remoteProbe.stdout.trim()) {
        throw new ActionFailure("not-delivered", `origin remote is unreadable: ${remoteProbe.stderr.trim().split("\n", 1)[0] ?? ""}`, actionId);
      }
      const configuredUrl = canonicalRemoteUrl(config.repository.url);
      if (canonicalRemoteUrl(remoteProbe.stdout.trim()) !== configuredUrl) {
        throw new ActionFailure(
          "not-delivered",
          `origin remote ${remoteProbe.stdout.trim()} does not canonicalize to the configured repository ${config.repository.url}; refusing to publish`,
          actionId,
        );
      }
      // SEC-GIT-001: staging and every network operation (ls-remote/push) run
      // in the runner-owned scratch publication repo above — the target
      // checkout's local config (url rewrites, sshCommand, credential
      // helpers, clean filters, hooks) is never loaded for them.
      const mustPub = async (argv: readonly string[], env: Record<string, string> = {}): Promise<string> => {
        const value = await publicationGit(argv, env);
        if (value.code !== 0 || value.timedOut) throw new Error(`git ${argv[argv[0] === "-C" ? 2 : 0]} failed: ${value.stderr.trim().split("\n", 1)[0] ?? ""}`);
        return value.stdout.trim();
      };
      // The admitted base revision must exist in the target object database
      // (read through alternates) and be the remote base branch tip.
      await mustPub(["cat-file", "-e", `${input.baseOid}^{commit}`]);
      const remoteBaseOid = async (): Promise<string> => {
        const remote = await publicationGit(["ls-remote", configuredUrl, `refs/heads/${input.base}`], {}, 60_000);
        const oid = remote.stdout.trim().split(/\s+/, 1)[0] ?? "";
        if (remote.code !== 0 || remote.timedOut || !/^[0-9a-f]{40,64}$/.test(oid)) {
          throw new ActionFailure("uncertain", `remote base ref ${input.base} is unreadable`, actionId);
        }
        return oid;
      };
      if ((await remoteBaseOid()) !== input.baseOid) {
        throw new ActionFailure("not-delivered", `remote base ${input.base} is not at the admitted revision ${input.baseOid}; refusing to publish`, actionId);
      }
      const baseDate = await mustPub(["show", "-s", "--format=%aI", input.baseOid]);
      const indexDir = securePrivateDir(cwd, ".omp", "pstack", "state", "benny-indexes");
      const index = join(indexDir, createHash("sha256").update(actionId).digest("hex"));
      await rm(index, { force: true });
      const stagingEnv = {
        GIT_WORK_TREE: sourceDir,
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: "Benny",
        GIT_AUTHOR_EMAIL: "benny@localhost",
        GIT_COMMITTER_NAME: "Benny",
        GIT_COMMITTER_EMAIL: "benny@localhost",
        GIT_AUTHOR_DATE: baseDate,
        GIT_COMMITTER_DATE: baseDate,
      };
      // Stage the exact canonical tree the workspace snapshotHash() computed.
      let tree = "";
      try {
        await mustPub(["read-tree", input.baseOid], stagingEnv);
        // -C enters the worktree only for pathspec resolution; GIT_DIR is
        // pinned to the scratch repo, so target config is never rediscovered
        // or read and its clean filters/hooks cannot run.
        await mustPub(["-C", sourceDir, "add", "-A", "--", "."], stagingEnv);
        tree = await mustPub(["write-tree"], stagingEnv);
      } finally {
        await rm(index, { force: true });
      }
      if (tree !== sourceManifest) {
        throw new Error(`staged tree ${tree} does not match the verified workspace snapshot ${sourceManifest}`);
      }
      const commit = await mustPub(["commit-tree", tree, "-p", input.baseOid, "-m", message], stagingEnv);
      const reconcile = reconcileHeadAt(configuredUrl, input.head, commit, input.baseOid, tree);
      const dispatch = async (): Promise<RemoteReceipt> => {
        if ((await remoteBaseOid()) !== input.baseOid) {
          throw new ActionFailure("not-delivered", `remote base ${input.base} moved off the admitted revision before push; refusing to publish`, actionId);
        }
        // The exact configured URL and the scratch repo's runner-owned
        // credential helper are the only destination and auth path; no
        // repository-local rewrite can redirect the push.
        const pushed = await publicationGit(["push", "--no-verify", configuredUrl, `${commit}:refs/heads/${input.head}`], {}, 300_000);
        if (pushed.code !== 0 || pushed.timedOut) throw new ActionFailure("uncertain", `git push failed: ${pushed.stderr.trim().split("\n", 1)[0] ?? ""}`, actionId);
        const receipt = await reconcile();
        if (!receipt) throw new ActionFailure("uncertain", "pushed branch head is not visible at the verified commit", actionId);
        return receipt;
      };
      return mutate(
        actionId,
        "git.publishBranch",
        { head: input.head, base: input.base, baseOid: input.baseOid, tree, commit },
        { sourceGate: true },
        dispatch,
        reconcile,
        opts?.continuation,
      );
    },
    async createDraft(actionId: string, input: { head: string; headOid: string; base: string; baseOid: string; title: string; body: string }, opts?: MutationOptions) {
      const dispatch = async (): Promise<RemoteReceipt> => {
        const result = await gh(
          ["pr", "create", "--repo", slug, "--draft", "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body],
          5_000,
        );
        const url = result.stdout.trim().split("\n").findLast((line) => line.startsWith("http"));
        // gh failures are ambiguous (the mutation may have landed before the error), so mutate() reconciles via pr list.
        if (result.code !== 0) {
          throw new ActionFailure("uncertain", `gh pr create failed: ${(result.stderr.trim().split("\n", 1)[0] ?? "").slice(0, 240)}`);
        }
        if (!url) throw new ActionFailure("uncertain", "gh pr create returned no pull request URL");
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        if (!Number.isInteger(number)) throw new ActionFailure("uncertain", `gh pr create URL is not a pull request: ${url}`);
        try {
          const pr = await ghJson<GhPr>(["pr", "view", String(number), "--repo", slug, "--json", "number,url,isDraft,headRefName,headRefOid,baseRefName,state"], `pr view ${number}`);
          // REST readback carries the immutable base SHA; the PR must point head and base at the verified OIDs.
          const oids = await restPrOids(number);
          pr.headRefOid = oids.headSha ?? pr.headRefOid;
          pr.baseRefOid = oids.baseSha;
          return prReceipt(pr, input);
        } catch (error) {
          if (error instanceof ActionFailure) throw error;
          throw new ActionFailure("uncertain", `draft PR ${number} readback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const reconcile = async (): Promise<RemoteReceipt | null> => reconcileGhCreate(input);
      return mutate(actionId, "github.createDraft", { head: input.head, headOid: input.headOid, base: input.base, baseOid: input.baseOid, title: input.title }, { sourceGate: true }, dispatch, reconcile, opts?.continuation);
    },
    async inspectArtifact(ref: string) {
      checkDeadline();
      const pr = await ghJson<GhPr>(["pr", "view", ref, "--repo", slug, "--json", "number,url,isDraft,headRefName,headRefOid,baseRefName,state"], `pr view ${ref}`);
      if (/^\d+$/.test(ref)) {
        const rest = await ghJson<{ head?: { sha?: string }; base?: { sha?: string } }>(["api", `repos/${slug}/pulls/${ref}`], `api pull ${ref}`);
        pr.headRefOid = rest.head?.sha ?? pr.headRefOid;
        pr.baseRefOid = rest.base?.sha;
      }
      return prReceipt(pr);
    },
    async readPR(ref: string) {
      checkDeadline();
      const pr = await ghJson<GhPr>(["pr", "view", ref, "--repo", slug, "--json", "number,url,isDraft,headRefName,headRefOid,baseRefName,state"], `pr view ${ref}`);
      if (/^\d+$/.test(ref)) {
        const rest = await ghJson<{ head?: { sha?: string }; base?: { sha?: string } }>(["api", `repos/${slug}/pulls/${ref}`], `api pull ${ref}`);
        pr.headRefOid = rest.head?.sha ?? pr.headRefOid;
        pr.baseRefOid = rest.base?.sha;
      }
      return prReceipt(pr);
    },
    close,
  };
}
