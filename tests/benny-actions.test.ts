import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBennyActions, ActionFailure, CanceledStateMissingError, gitCredentialHelperScript, readBoundedJsonObject, rootDigest, spawnBoundedChild, type BennyActions } from "../src/benny-actions.ts";
import { parseBennyConfig } from "../src/benny.ts";
import { opsTracker, reproduceMentionSet, resumeDraft, resumePostWindow, resumeTriageWrite, routeMentionAllowlist, runTriage, triageTracker } from "../src/benny-run.ts";
import { actionId, admitBennyEvent, BennyJournal, claimBennyRun, continuationState, openBennyStore, settleBennyRun } from "../src/benny.ts";
import { LinearTracker } from "../src/trackers/linear.ts";
import { openRunStore } from "../src/runner.ts";
import { stripDisallowedMentions, type BennyConfig, type ActionJournal, type RemoteReceipt } from "../src/benny-policy.ts";
import { FIXTURE_JPEG, FIXTURE_PNG, startBennyTransports } from "../scripts/fixtures/benny-transports.ts";
import type { BennyTransports } from "../scripts/fixtures/benny-transports.ts";

const yamlConfig = Bun.YAML.parse(await Bun.file(`${import.meta.dir}/../automations/benny/templates/configuration.example.yaml`).text()) as BennyConfig;
yamlConfig.slack.prefer_configured_actions = false;

const source = { teamId: "T_TEAM", channel: "C_SOURCE", rootTs: "100.001" };
// The exact root message the fixture serves; the admitted digest binds every action to it.
const fixtureRoot = { ts: "100.001", user: "U_REPORTER", text: "App crashes when exporting", files: [{ id: "F001", mimetype: "image/png", size: FIXTURE_PNG.byteLength }] };
const fixtureRootDigest = rootDigest(fixtureRoot);
const slackClientId = (actionId: string) =>
  `benny-${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;

/** Durable journal equivalent backed by real SQLite, mirroring the coordinator's begin/complete/uncertain semantics. */
function sqliteJournal(): ActionJournal {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE journal (id TEXT PRIMARY KEY, kind TEXT, input TEXT, state TEXT, receipt TEXT)");
  const get = db.prepare("SELECT state, receipt FROM journal WHERE id = ?");
  const insert = db.prepare("INSERT INTO journal (id, kind, input, state) VALUES (?, ?, ?, 'new')");
  const update = db.prepare("UPDATE journal SET state = ?, receipt = ? WHERE id = ?");
  return {
    begin(id: string, kind: string, input: unknown) {
      const row = get.get(id) as { state: string; receipt: string | null } | null;
      if (!row) {
        insert.run(id, kind, JSON.stringify(input) ?? "");
        return { state: "new" as const };
      }
      if (row.state === "done" && row.receipt) return { state: "done" as const, receipt: JSON.parse(row.receipt) as RemoteReceipt };
      return { state: "uncertain" as const };
    },
    complete(id: string, receipt: RemoteReceipt) {
      update.run("done", JSON.stringify(receipt), id);
    },
    uncertain(id: string, reason: string) {
      update.run("uncertain", reason, id);
    },
  };
}

function fixtureConfig(fx: BennyTransports): BennyConfig {
  const config = structuredClone(yamlConfig);
  config.slack = {
    ...config.slack,
    prefer_configured_actions: false,
    source_channel_id: source.channel,
    operations_channel_id: "C_OPS",
    triage_identity_user_id: "U_BENNY",
  };
  config.tracker = {
    ...config.tracker,
    type: "linear",
    team: "Benny Team",
    project: "Benny Project",
    labels: { bug: "Bug", performance: "Performance", intake: "Intake", needs_repro: "Needs Repro" },
    status: "Intake",
  };
  config.runtime = {
    trigger: "external",
    slack_app_token_env: "BENNY_TEST_APP_TOKEN",
    slack_read_token_env: "BENNY_TEST_SLACK_READ",
    slack_write_token_env: "BENNY_TEST_SLACK_WRITE",
    tracker_token_env: "BENNY_TEST_TRACKER",
    workspace_image: "benny-workspace-test",
    control_command: [],
    control_config: {},
    environment: {},
    allowed_endpoints: [],
    slack_api_url: fx.slackUrl,
    linear_api_url: fx.linearUrl,
  };
  return config;
}

async function makeActions(
  fx: BennyTransports,
  overrides?: { source?: typeof source; deadlineMs?: number; journal?: ActionJournal; cwd?: string; signal?: AbortSignal; runId?: number },
) {
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  return createBennyActions({
    config: fixtureConfig(fx),
    cwd: overrides?.cwd ?? await mkdtemp(join(tmpdir(), "benny-actions-")),
    source: overrides?.source ?? source,
    deadline: Date.now() + (overrides?.deadlineMs ?? 10_000),
    journal: overrides?.journal ?? sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
    signal: overrides?.signal,
    runId: overrides?.runId,
  });
}

let fx: BennyTransports;
let cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const undo of cleanupStack.reverse()) await undo();
  cleanupStack = [];
  if (fx) await fx.close();
  delete process.env.GH_HOST;
  delete process.env.GH_ENTERPRISE_TOKEN;
  delete process.env.SSL_CERT_FILE;
  delete process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES;
});

async function start(): Promise<BennyTransports> {
  fx = await startBennyTransports();
  return fx;
}

/**
 * Spawn interception for the draft-resume resource reclaim: an empty listing
 * proves absence; a container name on `ps` makes every ownership probe
 * unprovable. Bun.spawn resolves executables against its startup PATH
 * snapshot, so the interception replaces Bun.spawn instead of editing PATH.
 */
function installDockerShim(listOutput = ""): void {
  const dir = mkdtempSync(join(tmpdir(), "benny-docker-shim-"));
  const script = listOutput
    ? `#!/bin/sh\nif [ "$1" = "ps" ]; then printf '%s\\n' '${listOutput}'; fi\nexit 0\n`
    : "#!/bin/sh\nexit 0\n";
  writeFileSync(join(dir, "docker"), script);
  chmodSync(join(dir, "docker"), 0o755);
  const realSpawn = Bun.spawn;
  const shim = join(dir, "docker");
  Bun.spawn = ((argv: string[], options?: Parameters<typeof Bun.spawn>[1]) =>
    realSpawn(typeof argv === "string" ? argv : argv[0] === "docker" ? [shim, ...argv.slice(1)] : argv, options)) as typeof Bun.spawn;
  cleanupStack.push(() => {
    Bun.spawn = realSpawn;
    rmSync(dir, { recursive: true, force: true });
  });
}
test("construction binds both Slack tokens to the admitted team and the configured source channel", async () => {
  const fx = await start();
  fx.slack.authTeam = "T_OTHER";
  const wrongTeam = makeActions(fx);
  await expect(wrongTeam).rejects.toThrow(/team T_OTHER/);
  fx.slack.authTeam = "T_TEAM";
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const wrongChannel = createBennyActions({
    config: { ...fixtureConfig(fx), slack: { ...fixtureConfig(fx).slack, source_channel_id: "C_OTHER" } },
    cwd: ".",
    source,
    deadline: Date.now() + 10_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  await expect(wrongChannel).rejects.toThrow(/does not match configured source channel/);
  const ok = await makeActions(fx);
  expect(await ok.readRoot()).toMatchObject({ ts: "100.001", user: "U_REPORTER" });
});

test("construction refuses a same-team write token whose user is not the configured triage identity, before any write is exposed", async () => {
  const fx = await start();
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  const config = fixtureConfig(fx);
  // Same team, different user: the team binding alone must not authorize writes.
  config.slack.triage_identity_user_id = "U_HUMAN";
  await expect(
    createBennyActions({
      config,
      cwd: await mkdtemp(join(tmpdir(), "benny-identity-")),
      source,
      deadline: Date.now() + 10_000,
      journal: sqliteJournal(),
      expectedRootDigest: fixtureRootDigest,
    }),
  ).rejects.toThrow(/write token identity .* is not the configured triage identity U_HUMAN/);
  // No write reached Slack during construction: only reads (auth.test) happened.
  expect(fx.requests.filter((request) => request.path.includes("chat.postMessage"))).toHaveLength(0);
});

test("owner mentions ride the route allowlist only for feature-category decisions under the feature-owner gate", () => {
  const config = structuredClone(yamlConfig) as BennyConfig;
  // The blanket flag alone authorizes nobody on any category.
  config.routing.owner_pings_default = true;
  config.routing.allow_feature_owner_ping = false;
  const routes = {
    routes: [{ name: "exporters", owners: ["U_FEATURE_OWNER"], allowFeatureOwnerPing: true }],
    fallbackOwners: ["U_FALLBACK_OWNER"],
    fallbackAllowFeatureOwnerPing: true,
  };
  const mentionIds = new Set(["U_FEATURE_OWNER", "U_FALLBACK_OWNER"]);
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "bug")).toEqual(new Set());
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "question")).toEqual(new Set());
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "performance")).toEqual(new Set());
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "reroute")).toEqual(new Set());
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "feature")).toEqual(new Set());
  // The feature-owner gate (global and route flag) AND a feature decision is
  // the only host-established purpose that authorizes route owners.
  config.routing.allow_feature_owner_ping = true;
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "feature")).toEqual(new Set(["U_FEATURE_OWNER"]));
  expect(routeMentionAllowlist(config, routes, "exporters", mentionIds, "bug")).toEqual(new Set());
  // Fallback owners go through the same gate.
  expect(routeMentionAllowlist(config, routes, undefined, new Set(["U_FALLBACK_OWNER"]), "feature")).toEqual(new Set(["U_FALLBACK_OWNER"]));
  // Outside the routing map's written IDs: never pinged.
  expect(routeMentionAllowlist(config, routes, "exporters", new Set(["U_FEATURE_OWNER", "U_UNKNOWN"]), "feature")).toEqual(new Set(["U_FEATURE_OWNER"]));
});

test("the confirmed-regression-author gate authorizes nobody: the reporter is never a regression author and is stripped from reproduction text", () => {
  const db = new Database(":memory:");
  openBennyStore(db);
  db.run(
    "INSERT INTO benny_runs (run_id, team_id, event_id, phase, channel, root_ts, status, deadline_ms, created_at, updated_at, state) VALUES (1, 'T_TEAM', 'EvPing', 'triage', 'C_SOURCE', '100.001', 'succeeded', 0, 0, 0, ?)",
    [JSON.stringify({ allowedUserIds: ["UWTRIAGE1"] })],
  );
  const config = structuredClone(yamlConfig) as BennyConfig;
  config.routing.allow_confirmed_regression_author_ping = true;
  const deps = {
    db,
    run: { team_id: "T_TEAM", event_id: "EvPing" },
    config,
    root: { user: "U_REPORTER" },
  } as unknown as Parameters<typeof reproduceMentionSet>[0];
  // Only the triage sibling's persisted set survives; the reporter identity
  // is never added despite the policy flag being on.
  const allowed = reproduceMentionSet(deps);
  expect(allowed).toEqual(new Set(["UWTRIAGE1"]));
  // The reproduction source post strips the reporter-authored mention.
  const finalText = stripDisallowedMentions("Cause analysis <@UWTRIAGE1> ping the author <@U_REPORTER>", true, allowed);
  expect(finalText).toContain("<@UWTRIAGE1>");
  expect(finalText).not.toContain("<@U_REPORTER>");
});

test("opsTracker restores the persisted ops root from its journal receipt and sends a resumed status as a deterministic reply", async () => {
  const db = new Database(":memory:");
  openBennyStore(db);
  const journal = new BennyJournal(db, 7);
  const config = structuredClone(yamlConfig) as BennyConfig;
  config.slack.operations_channel_id = "C_OPS";
  const rootReceipt: RemoteReceipt = { id: "500.001", verified: true, observed: { channel: "C_OPS", text: "old status", root: true } };
  const rootAction = actionId(7, "ops-root", 1);
  journal.begin(rootAction, "slack.operations.post", { text: "old status" });
  journal.complete(rootAction, rootReceipt);

  const calls: Array<{ kind: "root" | "reply"; rootTs?: string; text: string }> = [];
  const actions = {
    operationsUpdate: async (_actionId: string, text: string) => {
      calls.push({ kind: "root", text });
      return { id: "900.009", verified: true, observed: { channel: "C_OPS", text, root: true } } as RemoteReceipt;
    },
    postOperationsReply: async (_actionId: string, rootTs: string, text: string) => {
      calls.push({ kind: "reply", rootTs, text });
      return { id: "600.002", verified: true, observed: { channel: "C_OPS", thread_ts: rootTs, text, reply_broadcast: false } } as RemoteReceipt;
    },
  } as unknown as BennyActions;

  const diagnostics: string[] = [];
  const ops = opsTracker(actions, config, 7, diagnostics, journal);
  // A persisted done ops-root receipt IS the root: the resumed status rides
  // it as a deterministic reply and the new reply ts is the boundary.
  const update = await ops.update("New status after resume");
  expect(calls).toEqual([{ kind: "reply", rootTs: "500.001", text: "New status after resume" }]);
  expect(update).toEqual({ root: "500.001", ts: "600.002" });

  // Fresh run: no ops-root journal row exists, so the first update posts the root.
  const freshOps = opsTracker(actions, config, 8, diagnostics, journal);
  const fresh = await freshOps.update("First status");
  expect(calls[1]).toEqual({ kind: "root", text: "First status" });
  expect(fresh).toEqual({ root: "900.009", ts: "900.009" });
  db.close();
});

test("a missing designated write token never falls back to the optional bot token", async () => {
  const fx = await start();
  const savedWrite = process.env.BENNY_TEST_SLACK_WRITE;
  delete process.env.BENNY_TEST_SLACK_WRITE;
  // The optional bot token is present and team-valid; it must still never
  // authorize source/operations posts or edits.
  process.env.BENNY_TEST_BOT = "tok-bot";
  const config = fixtureConfig(fx);
  config.slack = { ...config.slack, optional_bot_token_env: "BENNY_TEST_BOT" };
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  try {
    await expect(
      createBennyActions({
        config,
        cwd: await mkdtemp(join(tmpdir(), "benny-actions-")),
        source,
        deadline: Date.now() + 10_000,
        journal: sqliteJournal(),
        expectedRootDigest: fixtureRootDigest,
      }),
    ).rejects.toThrow(/Slack write token env BENNY_TEST_SLACK_WRITE is not set/);
  } finally {
    delete process.env.BENNY_TEST_BOT;
    if (savedWrite !== undefined) process.env.BENNY_TEST_SLACK_WRITE = savedWrite;
  }
});
test("thread reads paginate every page and permalink resolves the bound root", async () => {
  const fx = await start();
  fx.slack.pageSize = 2;
  const actions = await makeActions(fx);
  const thread = await actions.readThread();
  expect(thread[0]).toMatchObject({ ts: "100.001" });
  expect(thread.length).toBeGreaterThanOrEqual(3);
  expect(await actions.permalink()).toContain("/archives/C_SOURCE/");
});

test("wrong, deleted and missing roots gate every write with zero remote effects", async () => {
  const fx = await start();
  const actions = await makeActions(fx, { source: { ...source, rootTs: "999.999" } });
  await expect(actions.trackerCreate("a-wrong-root", { title: "t", description: "d", category: "bug" })).rejects.toThrow(/source gate/);
  const deleted = await makeActions(fx);
  fx.slack.deleteRoot();
  await expect(deleted.trackerCreate("a-deleted-root", { title: "t", description: "d", category: "bug" })).rejects.toThrow(ActionFailure);
  await expect(deleted.postThread("a-deleted-post", "verdict [benny:bug]")).rejects.toThrow(/source gate/);
  fx.slack.restoreRoot();
  const writes = fx.requests.filter((request) => String(request.path).includes("chat.postMessage") || String(request.path).includes("postMessage"));
  expect(writes).toEqual([]);
  expect(fx.linear.issues()).toEqual([]);
  const trackerWrites = fx.requests.filter((request) => request.path.includes("issueCreate"));
  expect(trackerWrites).toEqual([]);
});

test("postThread verifies readback coordinates, forbids broadcast, and replays the journal receipt idempotently", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const receipt = await actions.postThread("post-1", "verdict [benny:bug]");
  expect(receipt.verified).toBe(true);
  expect(receipt.observed).toMatchObject({ channel: "C_SOURCE", thread_ts: "100.001", reply_broadcast: false });
  const posts = fx.requests.filter((request) => request.path === "/api/chat.postMessage");
  expect(posts).toHaveLength(1);
  expect((posts[0]!.body as Record<string, unknown>).reply_broadcast).toBe(false);
  expect((posts[0]!.body as Record<string, unknown>).thread_ts).toBe("100.001");
  const replay = await actions.postThread("post-1", "verdict [benny:bug]");
  expect(replay).toEqual(receipt);
  expect(fx.requests.filter((request) => request.path === "/api/chat.postMessage")).toHaveLength(1);
});

test("Retry-After is honored and the post still lands exactly once", async () => {
  const fx = await start();
  const actions = await makeActions(fx, { deadlineMs: 30_000 });
  fx.slack.retryNextPostAfter(0);
  const receipt = await actions.postThread("post-retry", "verdict [benny:performance]");
  expect(receipt.verified).toBe(true);
  expect(fx.requests.filter((request) => request.path === "/api/chat.postMessage")).toHaveLength(2);
});

test("ambiguous transport failure reconciles by client_msg_id and never resends", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.slack.loseResponseNextPost(true);
  const receipt = await actions.postThread("post-amb", "ambiguous verdict [benny:bug]");
  expect(receipt.verified).toBe(true);
  expect(receipt.observed.recovered).toBe(true);
  const stored = fx.requests.filter((request) => request.path === "/api/chat.postMessage");
  expect(stored).toHaveLength(1);
  // A retry after the journal recorded uncertainty reconciles again instead of resending.
  const again = await actions.postThread("post-amb", "ambiguous verdict [benny:bug]");
  expect(again).toEqual(receipt);
  expect(fx.requests.filter((request) => request.path === "/api/chat.postMessage")).toHaveLength(1);
});
test("Slack reconciliation rejects foreign writers and mismatched text", async () => {
  const fx = await start();
  const actions = await makeActions(fx);

  fx.slack.seedMessage("C_SOURCE", {
    thread_ts: source.rootTs,
    user: "U_ATTACKER",
    text: "foreign verdict",
    client_msg_id: slackClientId("post-foreign"),
  });
  fx.slack.loseResponseNextPost(false);
  await expect(actions.postThread("post-foreign", "foreign verdict")).rejects.toMatchObject({ certainty: "uncertain" });

  fx.slack.seedMessage("C_SOURCE", {
    thread_ts: source.rootTs,
    user: "U_BENNY",
    text: "wrong text",
    client_msg_id: slackClientId("post-wrong-text"),
  });
  fx.slack.loseResponseNextPost(false);
  await expect(actions.postThread("post-wrong-text", "expected text")).rejects.toMatchObject({ certainty: "uncertain" });
});
test("operations reconciliation requires the authenticated writer and exact text", async () => {
  const fx = await start();
  const actions = await makeActions(fx);

  fx.slack.seedMessage("C_OPS", {
    user: "U_ATTACKER",
    text: "foreign root",
    client_msg_id: slackClientId("ops-foreign-root"),
  });
  fx.slack.loseResponseNextPost(false);
  await expect(actions.operationsUpdate("ops-foreign-root", "foreign root")).rejects.toMatchObject({ certainty: "uncertain" });

  const root = await actions.operationsUpdate("ops-real-root", "real root");
  fx.slack.seedMessage("C_OPS", {
    thread_ts: String(root.id),
    user: "U_ATTACKER",
    text: "foreign reply",
    client_msg_id: slackClientId("ops-foreign-reply"),
  });
  fx.slack.loseResponseNextPost(false);
  await expect(actions.postOperationsReply("ops-foreign-reply", String(root.id), "foreign reply")).rejects.toMatchObject({ certainty: "uncertain" });
});

test("a response lost without creation stays uncertain and blocks instead of resending", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.slack.loseResponseNextPost(false);
  await expect(actions.postThread("post-lost", "verdict [benny:bug]")).rejects.toMatchObject({ certainty: "uncertain" });
  await expect(actions.postThread("post-lost", "verdict [benny:bug]")).rejects.toThrow(/refusing to resend/);
  expect(fx.requests.filter((request) => request.path === "/api/chat.postMessage")).toHaveLength(1);
});

test("definite Slack rejection is not-delivered and the caller compensates a created issue", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const issue = await actions.trackerCreate("issue-1", { title: "Crash on export", description: "Repro: open export", category: "bug" });
  expect(issue.verified).toBe(true);
  expect(issue.observed.state).toBe("Intake");
  fx.slack.failNextPost("is_archived");
  const verdict = actions.postThread("verdict-1", "tracked [benny:bug]");
  await expect(verdict).rejects.toMatchObject({ certainty: "not-delivered" });
  const compensation = await actions.trackerCompensate("comp-1", String(issue.id));
  expect(compensation.verified).toBe(true);
  expect(compensation.observed).toMatchObject({ canceled: true });
  expect(fx.linear.issues()[0]!.state.name).toBe("Canceled");
});

test("Linear resolution, dedupe search, recurrence-only updates and canceled-state gating", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const target = await actions.trackerResolve();
  expect(target.observed).toMatchObject({ teamId: "TEAM_BEN", projectId: "PROJ_BEN", canceledStateId: "ST_CANCELED" });
  const created = await actions.trackerCreate("lin-1", { title: "Bug: bad math", description: "sums are wrong", category: "performance" });
  expect(String(created.observed.labels)).toContain("Performance");
  expect(created.observed.state).toBe("Intake");
  const permalink = await actions.permalink();
  const dupes = await actions.trackerSearch(permalink);
  expect(dupes.map((hit) => hit.id)).toContain(created.id);
  const before = fx.linear.issues()[0]!;
  await actions.trackerRecurrence("lin-2", String(created.id), "Recurred 3x today");
  const after = fx.linear.issues()[0]!;
  expect(after.comments.nodes.some((comment) => comment.body === "Recurred 3x today")).toBe(true);
  expect(after.labels).toEqual(before.labels);
  expect(after.state).toEqual(before.state);
  fx.linear.dropCanceledState();
  await expect(actions.trackerResolve()).rejects.toBeInstanceOf(CanceledStateMissingError);
  await expect(actions.trackerCreate("lin-3", { title: "no cancel state", description: "x", category: "bug" })).rejects.toBeInstanceOf(CanceledStateMissingError);
  expect(fx.linear.issues()).toHaveLength(1);
});

test("Linear uncertain create reconciles through the permalink search without double-creating", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.linear.loseResponseNextCreate(true);
  const receipt = await actions.trackerCreate("lin-amb", { title: "Ambiguous", description: "Ambiguous defect", category: "bug" });
  expect(receipt.observed.recovered).toBe(true);
  expect(fx.linear.issues()).toHaveLength(1);
  fx.linear.loseResponseNextCreate(false);
  await expect(actions.trackerCreate("lin-lost", { title: "Lost", description: "Lost defect", category: "bug" })).rejects.toMatchObject({ certainty: "uncertain" });
  expect(fx.linear.issues()).toHaveLength(1);
});

test("GraphQL partial errors stay uncertain and reconcile by the action marker", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.linear.partialErrorNextCreate();
  const receipt = await actions.trackerCreate("lin-partial", { title: "Partial", description: "Partial defect", category: "bug" });
  expect(receipt.observed.recovered).toBe(true);
  expect(fx.linear.issues()).toHaveLength(1);
});

test("canceled-state capability is resolved strictly by semantic type, not display name", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.linear.demoteCanceledType();
  await expect(actions.trackerCreate("lin-demote", { title: "T", description: "D", category: "bug" })).rejects.toBeInstanceOf(CanceledStateMissingError);
  expect(fx.linear.issues()).toHaveLength(0);
});

test("ordinary non-draft pull requests are reportable by read-only inspection", async () => {
  const fx = await start();
  process.env.GH_HOST = fx.githubEnv.GH_HOST;
  process.env.GH_ENTERPRISE_TOKEN = fx.githubEnv.GH_ENTERPRISE_TOKEN;
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const actions = await makeActions(fx);
  const created = await actions.createDraft("gh-nd", { head: "benny-fix-nd", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "t", body: "b" });
  fx.github.setLastPrDraft(false);
  const read = await actions.readPR(created.id);
  expect(read.observed.isDraft).toBe(false);
});

test("downloads are allowlisted, hash-verified and redirect-checked on the host", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const download = await actions.download("F001");
  expect(download.sha256).toHaveLength(64);
  expect(download.mimeType).toBe("image/png");
  expect(download.path).toContain(".omp/pstack/state/benny-downloads/F001");
  fx.slack.redirectNextDownloadOnce();
  await expect(actions.download("F001")).rejects.toMatchObject({ certainty: "not-delivered" });
});

test("download MIME comes from bytes: valid PNG/JPEG pass, forged or mismatched declared MIME is rejected", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.slack.addThreadFile({ id: "F002", bytes: FIXTURE_JPEG, mimetype: "image/jpeg" });
  expect((await actions.download("F002")).mimeType).toBe("image/jpeg");
  // Declared image/* whose bytes are not supported media: rejected outright.
  const text = new TextEncoder().encode("definitely not an image");
  fx.slack.addThreadFile({ id: "F003", bytes: text, mimetype: "image/png" });
  await expect(actions.download("F003")).rejects.toMatchObject({ certainty: "not-delivered", message: expect.stringContaining("declares image/png") });
  // Declared video/* with text bytes: rejected too.
  fx.slack.addThreadFile({ id: "F004", bytes: text, mimetype: "video/mp4" });
  await expect(actions.download("F004")).rejects.toMatchObject({ certainty: "not-delivered", message: expect.stringContaining("declares video/mp4") });
  // Declared and detected types disagree: rejected.
  fx.slack.addThreadFile({ id: "F005", bytes: FIXTURE_PNG, mimetype: "image/jpeg" });
  await expect(actions.download("F005")).rejects.toMatchObject({ certainty: "not-delivered", message: expect.stringContaining("its bytes are image/png") });
  // Positively detected media is returned even when Slack metadata is non-media.
  fx.slack.addThreadFile({ id: "F006", bytes: FIXTURE_PNG, mimetype: "application/octet-stream" });
  expect((await actions.download("F006")).mimeType).toBe("image/png");
  // Plain text without a media declaration is delivered as non-media, never as an image.
  fx.slack.addThreadFile({ id: "F007", bytes: text, mimetype: "text/plain" });
  expect((await actions.download("F007")).mimeType).toBe("application/octet-stream");
});

test("redirected download validates the FINAL body bytes, not the redirect target's claim", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.slack.redirectDownloadToSelfOnce();
  const download = await actions.download("F001");
  expect(download.mimeType).toBe("image/png");
  // Same redirect path with forged bytes on the final body: rejected.
  fx.slack.addThreadFile({ id: "F008", bytes: new TextEncoder().encode("forged through a redirect"), mimetype: "image/png" });
  fx.slack.redirectDownloadToSelfOnce();
  await expect(actions.download("F008")).rejects.toMatchObject({ certainty: "not-delivered", message: expect.stringContaining("declares image/png") });
});

test("operations updates edit their thread and root posts only outside the source channel", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const root = await actions.operationsUpdate("ops-root", "Reproducing");
  expect(root.observed).toMatchObject({ channel: "C_OPS", root: true });
  const edited = await actions.operationsUpdate("ops-edit", "Reproduced", String(root.id));
  expect(edited.observed).toMatchObject({ channel: "C_OPS", ts: root.id });
  const sourceRootAttempts = fx.requests.filter((request) => request.path === "/api/chat.postMessage" && (request.body as Record<string, unknown>).channel === "C_SOURCE" && (request.body as Record<string, unknown>).thread_ts === undefined);
  expect(sourceRootAttempts).toHaveLength(0);
});

test("custom tracker adapters are refused at parse and at the action boundary", async () => {
  const refused = structuredClone(yamlConfig) as BennyConfig & { runtime: BennyConfig["runtime"] & { tracker_adapter: string } };
  refused.runtime.tracker_adapter = "adapter.ts";
  expect(() => parseBennyConfig(refused)).toThrow(/runtime\.tracker_adapter is not supported/);
  await expect(
    createBennyActions({ config: refused, cwd: ".", source, deadline: Date.now() + 10_000, journal: sqliteJournal(), expectedRootDigest: fixtureRootDigest }),
  ).rejects.toThrow(/runtime\.tracker_adapter is not supported/);
  const nonLinear = structuredClone(yamlConfig) as unknown as { tracker: { type: string } };
  nonLinear.tracker.type = "jira";
  expect(() => parseBennyConfig(nonLinear)).toThrow(/tracker\.type/);
});

test("legacy MCP action mappings fail closed", async () => {
  const fx = await start();
  const config = fixtureConfig(fx) as BennyConfig & { runtime: BennyConfig["runtime"] & { mcp_actions: Record<string, unknown> } };
  config.runtime.mcp_actions = { [config.slack.thread_post_action]: { server: "slack", tool: "post" } };
  await expect(
    createBennyActions({ config, cwd: ".", source, deadline: Date.now() + 10_000, journal: sqliteJournal(), expectedRootDigest: fixtureRootDigest }),
  ).rejects.toThrow(/runtime\.mcp_actions is not supported/);
});

test("real gh creates a draft PR and verifies isDraft/head/base/url by readback", async () => {
  const fx = await start();
  process.env.GH_HOST = fx.githubEnv.GH_HOST;
  process.env.GH_ENTERPRISE_TOKEN = fx.githubEnv.GH_ENTERPRISE_TOKEN;
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const actions = await makeActions(fx);
  const receipt = await actions.createDraft("gh-1", { head: "benny-fix", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "Fix export crash", body: "before/after proof attached" });
  expect(receipt.verified).toBe(true);
  expect(receipt.observed).toMatchObject({ isDraft: true, head: "benny-fix", base: "main" });
  expect(receipt.url).toContain("/pull/");
  const stored = fx.github.pulls();
  expect(stored).toHaveLength(1);
  expect(stored[0]!.draft).toBe(true);
  const read = await actions.readPR(String(receipt.id));
  expect(read.observed).toMatchObject({ isDraft: true, head: "benny-fix", base: "main" });
  const inspect = await actions.inspectArtifact("benny-fix");
  expect(inspect.id).toBe(receipt.id);
});

test("real gh readback failure never claims success; ambiguous create reconciles to one PR", async () => {
  const fx = await start();
  process.env.GH_HOST = fx.githubEnv.GH_HOST;
  process.env.GH_ENTERPRISE_TOKEN = fx.githubEnv.GH_ENTERPRISE_TOKEN;
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const actions = await makeActions(fx, { deadlineMs: 60_000 });
  // Response lost after the mutation landed: reconcile via gh pr list, exactly one PR.
  fx.github.loseResponseNextCreate(true);
  const recovered = await actions.createDraft("gh-amb", { head: "benny-fix", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "t", body: "b" });
  expect(recovered.observed.recovered).toBe(true);
  expect(fx.github.pulls()).toHaveLength(1);
  // Response lost without the mutation landing: stays uncertain, blocks, no PR.
  fx.github.loseResponseNextCreate(false);
  await expect(actions.createDraft("gh-lost", { head: "benny-fix2", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "t", body: "b" })).rejects.toMatchObject({ certainty: "uncertain" });
  expect(fx.github.pulls()).toHaveLength(1);
  // Sticky readback failure after a successful create: no success claim, uncertain blocked.
  fx.github.failReadback();
  await expect(actions.createDraft("gh-readback", { head: "benny-fix3", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "t", body: "b" })).rejects.toMatchObject({ certainty: "uncertain" });
  expect(fx.requests.filter((request) => request.path.includes("merge") || request.path.includes("deploy"))).toHaveLength(0);
});

test("merged-PR-style artifacts are only read, never written by merge or deploy calls", async () => {
  const fx = await start();
  process.env.GH_HOST = fx.githubEnv.GH_HOST;
  process.env.GH_ENTERPRISE_TOKEN = fx.githubEnv.GH_ENTERPRISE_TOKEN;
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const actions = await makeActions(fx);
  await actions.createDraft("gh-2", { head: "benny-fix", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "feedfacefeedfacefeedfacefeedfacefeedface", title: "t", body: "b" });
  const mutating = fx.requests.filter((request) => /merge|deploy|status/i.test(request.path) && request.method === "POST");
  expect(mutating).toHaveLength(0);
  expect(fx.github.pulls().every((pull) => pull.draft)).toBe(true);
});
test("an edited source root blocks every source-gated write with zero remote effects", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  fx.slack.editRootText("Money-stealing edit by an attacker");
  await expect(actions.readRoot()).rejects.toMatchObject({ certainty: "not-delivered" });
  await expect(actions.postThread("edit-1", "verdict")).rejects.toMatchObject({ certainty: "not-delivered" });
  await expect(actions.trackerCreate("edit-2", { title: "t", description: "d", category: "bug" })).rejects.toMatchObject({ certainty: "not-delivered" });
  await expect(actions.trackerRecurrence("edit-3", "ISSUE-1", "d")).rejects.toMatchObject({ certainty: "not-delivered" });
  await expect(actions.trackerCompensate("edit-4", "ISSUE-1")).rejects.toMatchObject({ certainty: "not-delivered" });
  // Zero write effects: no source post and no tracker mutation request at all.
  const writes = fx.requests.filter(
    (request) =>
      (request.path.includes("chat.postMessage") && (request.body as Record<string, unknown>).channel === "C_SOURCE") ||
      (request.path.includes("graphql") && JSON.stringify(request.body).includes("recurrenceAdd")) ||
      (request.path.includes("graphql") && JSON.stringify(request.body).includes("issueCreate")),
  );
  expect(writes).toHaveLength(0);
});

/** Minimal git repo with a bare origin: the real push/ls-remote path publishBranch exercises. */
async function gitPublishRepo(): Promise<{ repo: string; bare: string; baseOid: string }> {
  const root = await mkdtemp(join(tmpdir(), "benny-publish-"));
  cleanupStack.push(() => rm(root, { recursive: true, force: true }));
  // A GitHub-slug-shaped local path: canonicalRemoteUrl keeps plain paths
  // verbatim, so origin and the configured repository URL compare equal,
  // while parseGitHubSlug still resolves the owner/repo for the gh surface.
  const bare = join(root, "github.com", "example-org", "example-repo.git");
  const repo = join(root, "work");
  const run = (...argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  run("git", "init", "--bare", "--initial-branch=main", bare);
  run("git", "clone", bare, repo);
  const write = (name: string, content: string) => rmSyncWrite(join(repo, name), content);
  write("app.txt", "v1\n");
  run("git", "-C", repo, "add", "app.txt");
  run("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-m", "base");
  run("git", "-C", repo, "push", "origin", "HEAD:refs/heads/main");
  const baseOid = run("git", "-C", repo, "rev-parse", "HEAD");
  return { repo, bare, baseOid };
}

function rmSyncWrite(path: string, content: string): void {
  writeFileSync(path, content);
}

/** Stages dir exactly like the workspace snapshot: temp index from base, add -A, write-tree. */
function stageTree(repo: string, dir: string, baseOid: string): string {
  const index = join(repo, ".git", "benny-test-index");
  const env = { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: dir, GIT_INDEX_FILE: index };
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(["git", ...argv], { cwd: repo, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  try {
    run(["read-tree", baseOid]);
    run(["add", "-A", "--", "."]);
    return run(["write-tree"]);
  } finally {
    rmSync(index, { force: true });
  }
}

test("publishBranch pushes the verified tree at the admitted base and fails closed on tree mismatch, base race and source edits", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const actions = await createBennyActions({
    config: publishConfig,
    cwd: repo,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  const branch = await actions.publishBranch("pub-1", {
    sourceDir: workspace,
    sourceManifest: tree,
    head: "benny/run-7-aaaaaaaaaaaa",
    base: "main",
    baseOid,
    message: "fix",
  });
  expect(branch.verified).toBe(true);
  expect(branch.observed).toMatchObject({ head: "benny/run-7-aaaaaaaaaaaa", tree });
  const remoteHead = Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-7-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim();
  expect(remoteHead.startsWith(branch.observed.oid as string)).toBe(true);

  // Tree mismatch: an unverified snapshot never reaches the remote.
  await expect(
    actions.publishBranch("pub-2", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-8-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);

  // Base race: the remote base moved off the admitted revision — refuse before any push.
  Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "unrelated", "-q"], { stderr: "ignore" });
  const moved = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  Bun.spawnSync(["git", "-C", repo, "push", "-q", "origin", `${moved}:refs/heads/main`], { stderr: "ignore" });
  await expect(
    actions.publishBranch("pub-3", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-9-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toMatchObject({ certainty: "not-delivered" });
  const raced = Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-9-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim();
  expect(raced).toBe("");

  // Publication binding: an origin that does not canonicalize to the
  // configured repository URL is refused before any push, with zero remote effects.
  const mismatchRoot = join(tmpdir(), `benny-mismatch-${Date.now()}`);
  const mismatchConfig = fixtureConfig(fx);
  mismatchConfig.repository = { ...mismatchConfig.repository, url: join(mismatchRoot, "github.com", "example-org", "other-repo.git") };
  const mismatchActions = await createBennyActions({
    config: mismatchConfig,
    cwd: repo,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  await expect(
    mismatchActions.publishBranch("pub-5", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-11-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toMatchObject({ certainty: "not-delivered", message: expect.stringContaining("does not canonicalize") });
  expect(Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-11-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim()).toBe("");

  // Source digest gate: an edited root blocks publication too.
  fx.slack.editRootText("edited after admission");
  await expect(
    actions.publishBranch("pub-4", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-10-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toMatchObject({ certainty: "not-delivered" });
  fx.slack.restoreRoot();
});

test("publication never loads target local config: insteadOf rewrites, hooks, credential helper and clean filters cannot run", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const root = join(bare, "..", "..");
  // Git probes run outside the checkout: the hostile insteadOf rewrites the
  // origin URL for any process that loads the target's local config, and the
  // assertion must observe the real configured repository.
  const g = (...argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  // The workspace carries a filter attribute that only the TARGET's local
  // config would define; the expected snapshot is staged before the hostile
  // config exists so the test helper itself stays innocent.
  writeFileSync(join(workspace, ".gitattributes"), "* filter=boom\n");
  const tree = stageTree(repo, workspace, baseOid);

  const canary = join(root, "canary");
  const hookPath = join(canary, "hooks");
  mkdirSync(hookPath, { recursive: true });
  const canaryScript = (name: string, body: string) => {
    const path = join(canary, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const prePush = canaryScript(join("hooks", "pre-push"), 'echo ran >> "$0.canary"; exit 1');
  const cred = canaryScript("cred.sh", 'echo cred >> "$0.canary"');
  const clean = canaryScript("clean.sh", 'echo clean >> "$0.canary"; cat');
  const evilTarget = join(root, "evil-target");
  // Every entry below only bites if the publication processes load the
  // target checkout's local config: URL rewrites, hooks, credentials, filters.
  appendFileSync(
    join(repo, ".git", "config"),
    [
      `[url "${evilTarget}"]`,
      `\tinsteadOf = ${bare}`,
      `\tpushInsteadOf = ${bare}`,
      "[core]",
      `\thooksPath = ${hookPath}`,
      "[credential]",
      `\thelper = !${cred}`,
      '[filter "boom"]',
      `\tclean = sh ${clean}`,
      `\trequired = true`,
      "",
    ].join("\n"),
  );

  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const actions = await createBennyActions({
    config: publishConfig,
    cwd: repo,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  const branch = await actions.publishBranch("pub-hostile", {
    sourceDir: workspace,
    sourceManifest: tree,
    head: "benny/run-13-aaaaaaaaaaaa",
    base: "main",
    baseOid,
    message: "fix",
  });
  expect(branch.verified).toBe(true);
  // The push landed at the configured repository, not the insteadOf target.
  const remoteHead = g("git", "ls-remote", bare, "refs/heads/benny/run-13-aaaaaaaaaaaa");
  expect(remoteHead.startsWith(branch.observed.oid as string)).toBe(true);
  expect(existsSync(evilTarget)).toBe(false);
  // No canary anywhere: hooks, credential helper and clean filter never ran.
  expect(Bun.spawnSync(["find", canary, "-name", "*.canary"], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
});

test("publishBranch resolves the shared object store when the target checkout is a linked worktree", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const linked = join(repo, "linked-wt");
  Bun.spawnSync(["git", "-C", repo, "worktree", "add", linked, "HEAD"], { stderr: "ignore" });
  const workspace = join(linked, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const actions = await createBennyActions({
    config: publishConfig,
    cwd: linked,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  const branch = await actions.publishBranch("pub-wt", {
    sourceDir: workspace,
    sourceManifest: tree,
    head: "benny/run-14-aaaaaaaaaaaa",
    base: "main",
    baseOid,
    message: "fix from worktree",
  });
  expect(branch.verified).toBe(true);
  const remoteHead = Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-14-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim();
  expect(remoteHead.startsWith(branch.observed.oid as string)).toBe(true);
});

test("reconcile-only publishBranch resume completes an uncertain journal by exact head match and never resends", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const g = (...argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const branch = "benny/run-15-aaaaaaaaaaaa";
  g("git", "-C", repo, "commit", "--allow-empty", "-q", "-m", "published before the workspace was lost");
  const commitOid = g("git", "-C", repo, "rev-parse", "HEAD");
  const treeOid = g("git", "-C", repo, "rev-parse", "HEAD^{tree}");
  g("git", "-C", repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const journal = sqliteJournal();
  const id = "pub-resume";
  journal.begin(id, "git.publishBranch", { head: branch, base: "main", baseOid, commit: commitOid, sourceManifest: treeOid });
  journal.uncertain(id, "push transport lost");
  // cwd is a fresh temp dir with no git repository: the reconcile-only path
  // must complete from the remote alone, touching neither the target
  // checkout nor the (no longer existing) workspace or source.
  const actions = await createBennyActions({
    config: publishConfig,
    cwd: await mkdtemp(join(tmpdir(), "benny-resume-")),
    source,
    deadline: Date.now() + 30_000,
    journal,
    expectedRootDigest: fixtureRootDigest,
  });
  const receipt = await actions.publishBranch(id, { sourceDir: "", head: branch, base: "main", baseOid, commit: commitOid, sourceManifest: treeOid });
  expect(receipt.verified).toBe(true);
  expect(receipt.observed).toMatchObject({ head: branch, oid: commitOid, tree: treeOid, recovered: true });
  // A different persisted commit cannot complete: mismatch stays uncertain.
  await expect(
    actions.publishBranch("pub-resume-2", { sourceDir: "", head: branch, base: "main", baseOid, commit: "1".repeat(40), sourceManifest: treeOid }),
  ).rejects.toMatchObject({ certainty: "uncertain" });
  // Without the persisted commit OID there is nothing safe to reconcile against.
  await expect(actions.publishBranch("pub-resume-3", { sourceDir: "", head: branch, base: "main", baseOid })).rejects.toThrow(/persisted commit OID/);
  // The persisted verified tree is mandatory: a recovered receipt without
  // observed.tree could never satisfy the draft transition's tree binding.
  await expect(
    actions.publishBranch("pub-resume-4", { sourceDir: "", head: branch, base: "main", baseOid, commit: commitOid, sourceManifest: "zzz" }),
  ).rejects.toThrow(/persisted verified workspace tree/);
  await expect(
    actions.publishBranch("pub-resume-5", { sourceDir: "", head: branch, base: "main", baseOid, commit: commitOid }),
  ).rejects.toThrow(/persisted verified workspace tree/);
});

test("createDraft readback rejects a PR whose base is not the admitted revision", async () => {
  const fx = await start();
  process.env.GH_HOST = fx.githubEnv.GH_HOST;
  process.env.GH_ENTERPRISE_TOKEN = fx.githubEnv.GH_ENTERPRISE_TOKEN;
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const actions = await makeActions(fx);
  await expect(
    actions.createDraft("gh-base", { head: "benny-fix", headOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base: "main", baseOid: "0".repeat(40), title: "t", body: "b" }),
  ).rejects.toMatchObject({ certainty: "not-delivered" });
});

test("recurrence only touches an issue that actually appeared in the verified search", async () => {
  const fx = await start();
  const actions = await makeActions(fx);
  const created = await actions.trackerCreate("seed-1", { title: "First occurrence", description: "original", category: "bug" });
  const db = new Database(":memory:");
  openBennyStore(db);
  db.run(
    "INSERT INTO benny_runs (id, run_id, team_id, event_id, phase, channel, root_ts, status, deadline_ms, created_at, updated_at) VALUES (1, 1, 'T_TEAM', 'E1', 'triage', 'C_SOURCE', '100.001', 'queued', 1, 1, 1)",
  );
  const run = { id: 1, run_id: 1, phase: "triage", status: "queued", deadline_ms: Date.now() + 60_000 } as unknown as Parameters<typeof triageTracker>[0]["run"];
  const deps = {
    db,
    config: fixtureConfig(fx),
    target: ".",
    run,
    source,
    root: fixtureRoot,
    signal: undefined,
    diagnostics: [] as string[],
    ops: { update: async () => undefined },
    actions,
  } as unknown as Parameters<typeof triageTracker>[0];
  const stubSession = (answer: unknown) =>
    ({
      prompt: async () => JSON.stringify(answer),
      session: null,
      dispose: async () => {},
    }) as unknown as Parameters<typeof triageTracker>[1];
  const decision = { category: "bug" as const, verdict_text: "v", create: null };
  // The issue was seeded with the source permalink in its description, so the permalink search verifies it.
  const hit = await triageTracker(deps, stubSession({ outcome: "confident-duplicate", issue_id: created.id }), decision, await actions.permalink());
  expect(hit.verified).toBe(true);
  expect(fx.linear.issues()[0]!.comments.nodes).toEqual([
    expect.objectContaining({ body: expect.stringContaining("Recurrence reported from") }),
  ]);
  // An issue ID outside the verified search is refused with zero tracker writes.
  const refused = await triageTracker(deps, stubSession({ outcome: "confident-duplicate", issue_id: "ISSUE-NOT-IN-SEARCH" }), decision, await actions.permalink());
  expect(refused.verified).toBe(false);
  expect(fx.linear.issues()[0]!.comments.nodes).toHaveLength(1);
});

test("admission persists the binding and only exact bindings claim and execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "benny-binding-"));
  cleanupStack.push(() => rm(root, { recursive: true, force: true }));
  const db = openRunStore(root);
  openBennyStore(db);
  const bindingA = { configHash: "AAAA", repoRevision: "R1", canary: false };
  const bindingB = { configHash: "BBBB", repoRevision: "R2", canary: true };
  const admitted = admitBennyEvent(db, { eventId: "E1", source, root: fixtureRoot }, ["triage"], Date.now() + 60_000, bindingA);
  admitBennyEvent(db, { eventId: "E2", source: { teamId: "T_TEAM", channel: "C_SOURCE", rootTs: "200.001" }, root: fixtureRoot }, ["triage"], Date.now() + 60_000, bindingB);
  const persisted = db.query("SELECT config_hash, repo_revision, canary FROM benny_runs WHERE event_id = 'E1'").get() as Record<string, unknown>;
  expect(persisted).toMatchObject({ config_hash: "AAAA", repo_revision: "R1", canary: 0 });
  // A foreign binding claims nothing — never a null or other identity row.
  expect(claimBennyRun(db, { configHash: "CCCC", repoRevision: "R1", canary: false })).toBeNull();
  expect(claimBennyRun(db, { ...bindingA, canary: true })).toBeNull();
  // An exact binding claim runs that identity only.
  const claimedB = claimBennyRun(db, bindingB);
  expect(claimedB?.event_id).toBe("E2");
  expect(claimedB?.canary).toBe(1);
  settleBennyRun(db, claimedB!, "succeeded");
  const claimedA = claimBennyRun(db, bindingA);
  expect(claimedA?.event_id).toBe("E1");
  expect(admitted.rows[0]!.duplicate).toBe(false);
  settleBennyRun(db, claimedA!, "succeeded");
  db.close();
});

test("configured-action preference is refused at parse time and at the action boundary", async () => {
  const refused = structuredClone(yamlConfig) as BennyConfig;
  refused.slack.prefer_configured_actions = true;
  expect(() => parseBennyConfig(refused)).toThrow(/prefer_configured_actions=true is not supported/);
  await expect(
    createBennyActions({
      config: refused,
      cwd: await mkdtemp(join(tmpdir(), "benny-refusal-")),
      source,
      deadline: Date.now() + 10_000,
      journal: sqliteJournal(),
      expectedRootDigest: fixtureRootDigest,
    }),
  ).rejects.toThrow(/prefer_configured_actions=true is not supported/);
});

/** A claimed triage row on a fresh in-memory store, with its journal bound. */
function resumeDeps(fx: BennyTransports, eventId: string) {
  const root = mkdtempSync(join(tmpdir(), "benny-resume-"));
  const db = openRunStore(root);
  openBennyStore(db);
  admitBennyEvent(db, { eventId, source, root: fixtureRoot }, ["triage"], Date.now() + 600_000, { configHash: "h", repoRevision: "r", canary: false });
  const claimed = claimBennyRun(db, { configHash: "h", repoRevision: "r", canary: false })!;
  const run = db.query("SELECT * FROM benny_runs WHERE id = ?").get(claimed.id) as Record<string, unknown> & { id: number };
  cleanupStack.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = fixtureConfig(fx);
  config.budgets.triage_follow_up_minutes = 1;
  return {
    db,
    config,
    target: ".",
    run,
    source,
    root: fixtureRoot,
    signal: undefined,
    diagnostics: [] as string[],
    ops: { update: async () => undefined },
    actions: null,
    journal: new BennyJournal(db, claimed.id),
  } as unknown as Parameters<typeof resumeTriageWrite>[0];
}

/** A realistic rejection-window checkpoint; omits sourceReplyId to model the pre-park crash gap. */
function rejectionCheckpoint(revision: string, rejectionEndsAt: number) {
  return {
    plan: {
      feature: "export",
      steps: [{ id: "s1", capability: "inspect-state", input: {}, description: "open export" }],
      reset: { input: {} },
      discriminating_state: "crash",
      expected_state: "ok",
      state_check: { key: "k", broken: "b", correct: "c" },
    },
    baseline: [
      { runId: "1", phase: "baseline", revision, at: Date.now(), stepIds: ["s1"], resetId: "r1", observed: "broken", stateChecks: {}, artifacts: [], controlIds: [] },
      { runId: "1", phase: "baseline", revision, at: Date.now(), stepIds: ["s1"], resetId: "r2", observed: "broken", stateChecks: {}, artifacts: [], controlIds: [] },
    ],
    evidence: ["e1"],
    reviewedHashes: ["h1"],
    sourceReplyAt: Date.now(),
    rejectionEndsAt,
    revision,
  };
}

test("triage resume replays the verified create receipt, posts the verdict once with the route allowlist, and parks the allowlist checkpoint", async () => {
  const fx = await start();
  const deps = resumeDeps(fx, "E-resume-ok");
  const actions = await makeActions(fx, { journal: deps.journal });
  const journal = deps.journal as BennyJournal;
  const createReceipt: RemoteReceipt = { id: "ISS-77", url: "http://linear.test/ISS-77", verified: true, observed: {} };
  journal.begin(actionId(deps.run.id as number, "tracker-create", 1), "tracker.create", {});
  journal.complete(actionId(deps.run.id as number, "tracker-create", 1), createReceipt, {
    stage: "create",
    state: continuationState("create", {
      decision: { category: "bug", verdict_text: "Owned analysis <@U_OWNER> <@U_EVIL>", create: { title: "t", description: "d" } },
      trackerVerified: true,
      createdIssueId: "ISS-77",
      trackerUrl: createReceipt.url,
      allowedUserIds: ["U_OWNER"],
    }),
  });
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  expect((deps.run as unknown as Record<string, unknown>).stage).toBe("create");
  deps.actions = actions;
  const outcome = await resumeTriageWrite(deps);
  expect(outcome.status).toBe("queued");
  expect(outcome.stage).toBe("followup");
  // The verdict posted exactly once; the sink kept only the route-allowed mention.
  const posts = fx.requests.filter((request) => request.path.includes("chat.postMessage") && (request.body as Record<string, unknown>).channel === "C_SOURCE");
  expect(posts).toHaveLength(1);
  const text = String((posts[0]!.body as Record<string, unknown>).text);
  expect(text).toContain("<@U_OWNER>");
  expect(text).not.toContain("<@U_EVIL>");
  expect(text).toContain("[benny:bug]");
  expect(text).toContain("tracker=http://linear.test/ISS-77");
  // The follow-up checkpoint carries the route allowlist for the reproduce sibling.
  const parked = (deps.db as Database).query("SELECT state FROM benny_runs WHERE id = ?").get(deps.run.id) as { state: string | null };
  expect(JSON.parse(parked.state!).allowedUserIds).toEqual(["U_OWNER"]);
});

test("triage resume without a readable continuation compensates the verified issue and blocks", async () => {
  const fx = await start();
  const deps = resumeDeps(fx, "E-resume-lost");
  const actions = await makeActions(fx, { journal: deps.journal });
  const seeded = await actions.trackerCreate("seed-lost", { title: "Lost continuation", description: "x", category: "bug" });
  const journal = deps.journal as BennyJournal;
  journal.begin(actionId(deps.run.id as number, "tracker-create", 1), "tracker.create", {});
  journal.complete(actionId(deps.run.id as number, "tracker-create", 1), { id: seeded.id, verified: true, observed: {} } as RemoteReceipt);
  // The row claims stage 'create' but carries no matching continuation marker.
  (deps.db as Database).run("UPDATE benny_runs SET stage = 'create', state = ? WHERE id = ?", [JSON.stringify({ unrelated: true }), deps.run.id]);
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  deps.actions = actions;
  const outcome = await resumeTriageWrite(deps);
  expect(outcome.status).toBe("blocked");
  expect(outcome.diagnostic).toContain("compensated");
  const lost = fx.linear.issues().find((issue) => issue.id === seeded.id);
  expect(lost?.state.type).toBe("canceled");
});

test("a requeued compensate-stage run settles blocked without analysis or new mutations", async () => {
  const fx = await start();
  const deps = resumeDeps(fx, "E-compensate-requeue");
  const actions = await makeActions(fx, { journal: deps.journal });
  const journal = deps.journal as BennyJournal;
  // The reconciled journal outcome: a verified compensation receipt for the
  // created issue. It is the ONLY truth the resume may draw on.
  journal.begin(actionId(deps.run.id as number, "tracker-compensate", 1), "tracker.compensate", { id: "ISS-9" });
  journal.complete(actionId(deps.run.id as number, "tracker-compensate", 1), { id: "ISS-9", verified: true, observed: {} } as RemoteReceipt);
  // A crash between the compensation intent and its settlement leaves stage
  // 'compensate' with no readable continuation marker.
  (deps.db as Database).run("UPDATE benny_runs SET stage = 'compensate', state = ? WHERE id = ?", [JSON.stringify({ unrelated: true }), deps.run.id]);
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  deps.actions = actions;
  // The run is requeued: executeTriage must route 'compensate' to terminal
  // settlement and NEVER restart preflight/analyze/create/verdict.
  const outcome = await runTriage(deps);
  expect(outcome.status).toBe("blocked");
  expect(outcome.stage).toBe("compensate");
  expect(outcome.diagnostic).toContain("compensate");
  expect(outcome.diagnostic).toContain("ISS-9");
  // No analysis/model session and no new mutation: no verdict post, no new issue.
  const posts = fx.requests.filter((request) => String(request.path).includes("chat.postMessage"));
  expect(posts).toHaveLength(0);
  expect(fx.linear.issues()).toHaveLength(0);
  // The row is terminal-blocked and the checkout ownership is fully released.
  const persisted = (deps.db as Database).query("SELECT status FROM benny_runs WHERE id = ?").get(deps.run.id) as { status: string };
  expect(persisted.status).toBe("blocked");
  const checkout = (deps.db as Database).query("SELECT owner_pid, owner_boot FROM runs WHERE id = ?").get(deps.run.run_id as number) as { owner_pid: number | null; owner_boot: string | null };
  expect(checkout.owner_pid).toBeNull();
  expect(checkout.owner_boot).toBeNull();
});

test("a crash after source-post completion resumes waiting on a durable rejection window, not interrupted", async () => {
  const fx = await start();
  const deps = resumeDeps(fx, "E-rejection-crash");
  const actions = await makeActions(fx, { journal: deps.journal });
  const journal = deps.journal as BennyJournal;
  // The reply id is committed atomically WITH the post journal receipt, so a
  // crash before the park leaves it recoverable from the journal.
  journal.begin(actionId(deps.run.id as number, "repro-reply", 1), "slack.postThread", { text: "Reproduced" });
  journal.complete(actionId(deps.run.id as number, "repro-reply", 1), { id: "123.456", verified: true, observed: {} } as RemoteReceipt);
  const revision = String((deps.run as unknown as Record<string, unknown>).repo_revision ?? "");
  const rejectionEndsAt = Date.now() + 60 * 60_000;
  // Crash-gap state: the atomic continuation committed stage 'rejection-wait'
  // but the park did not run, so the checkpoint has NO sourceReplyId yet —
  // exactly the post-to-park crash window the continuation closes.
  const state = rejectionCheckpoint(revision, rejectionEndsAt);
  (deps.db as Database).run("UPDATE benny_runs SET stage = 'rejection-wait', state = ? WHERE id = ?", [JSON.stringify(state), deps.run.id]);
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  deps.actions = actions;
  const outcome = await resumePostWindow(deps);
  // It resumes WAITING (queued at the rejection window), never interrupted.
  expect(outcome.status).toBe("queued");
  expect(outcome.stage).toBe("rejection-wait");
  const persisted = (deps.db as Database).query("SELECT stage, status, state, not_before_ms FROM benny_runs WHERE id = ?").get(deps.run.id) as { stage: string; status: string; state: string; not_before_ms: number };
  expect(persisted.status).toBe("queued");
  expect(persisted.stage).toBe("rejection-wait");
  expect(persisted.not_before_ms).toBe(rejectionEndsAt);
  // The durable rejection window now carries the recovered reply id/timestamps.
  const stateJson = JSON.parse(persisted.state) as Record<string, unknown>;
  expect(stateJson.sourceReplyId).toBe("123.456");
  expect(typeof stateJson.sourceReplyAt).toBe("number");
  expect(stateJson.rejectionEndsAt).toBe(rejectionEndsAt);
});

test("the rejection-wait checkpoint commits atomically with the confirmed-repro source post", async () => {
  const fx = await start();
  const deps = resumeDeps(fx, "E-rejection-atomic");
  const actions = await makeActions(fx, { journal: deps.journal });
  deps.actions = actions;
  const revision = String((deps.run as unknown as Record<string, unknown>).repo_revision ?? "");
  const rejectionEndsAt = Date.now() + 60 * 60_000;
  const checkpoint = rejectionCheckpoint(revision, rejectionEndsAt);
  // The checkpoint is supplied as the post continuation, so the journal
  // receipt AND the run row (stage 'rejection-wait' + checkpoint) commit in
  // one transaction when the source post completes.
  const receipt = await actions.postThread(
    actionId(deps.run.id as number, "repro-reply", 1),
    "Reproduced: crash on export",
    { allowedUserIds: new Set(), continuation: { stage: "rejection-wait", state: JSON.stringify(checkpoint) } },
  );
  expect(receipt.verified).toBe(true);
  const persisted = (deps.db as Database).query("SELECT stage, status, state FROM benny_runs WHERE id = ?").get(deps.run.id) as { stage: string; status: string; state: string };
  // A crash right after this post leaves a durable rejection window: the stage
  // is already 'rejection-wait' (a safe checkpoint) with the reply's journal
  // receipt in hand, so recovery resumes waiting instead of re-posting.
  expect(persisted.status).toBe("running");
  expect(persisted.stage).toBe("rejection-wait");
  const stateJson = JSON.parse(persisted.state) as Record<string, unknown>;
  expect(stateJson.rejectionEndsAt).toBe(rejectionEndsAt);
  expect(stateJson.plan).toBeTruthy();
  expect(Array.isArray(stateJson.baseline)).toBe(true);
});

test("draft resume replays both journal receipts and settles without re-dispatching git or gh", async () => {
  const fx = await start();
  installDockerShim(); // proven-absence reclaim before the resumed publication
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const deps = resumeDeps(fx, "E-draft-ok");
  const tree = "a".repeat(40);
  // The evidence gate re-reads published bytes under deps.target before any
  // resumed publication: seed one content-addressed receipt in a temp target.
  const evidenceRoot = await mkdtemp(join(tmpdir(), "benny-evidence-"));
  mkdirSync(join(evidenceRoot, ".omp", "pstack", "state", "benny-evidence"), { recursive: true, mode: 0o700 });
  const shot = new Uint8Array([1, 2, 3]);
  const shotSha = createHash("sha256").update(shot).digest("hex");
  await writeFile(join(evidenceRoot, ".omp", "pstack", "state", "benny-evidence", `${shotSha}.png`), shot);
  deps.target = evidenceRoot;
  const payload = {
    head: "benny/run-9-aaaaaaaaaaaa",
    tree,
    base: "main",
    baseOid: "b".repeat(40),
    title: "fix",
    body: "b",
    plan: {
      feature: "f",
      steps: [{ id: "s", capability: "drive-ui" as const, input: {}, description: "d" }],
      reset: { input: {} },
      discriminating_state: "d",
      expected_state: "e",
      state_check: { key: "k", broken: "b", correct: "c" },
    },
    revision: "r",
    evidence: [{ path: `${shotSha}.png`, sha256: shotSha }],
  };
  const journal = deps.journal as BennyJournal;
  journal.begin(actionId(deps.run.id as number, "publish-branch", 1), "git.publishBranch", {});
  journal.complete(
    actionId(deps.run.id as number, "publish-branch", 1),
    { id: payload.head, verified: true, observed: { head: payload.head, oid: "c".repeat(40), tree, baseOid: payload.baseOid } } as RemoteReceipt,
    { stage: "draft", state: continuationState("draft", payload) },
  );
  journal.begin(actionId(deps.run.id as number, "draft-pr", 1), "github.createDraft", {});
  journal.complete(actionId(deps.run.id as number, "draft-pr", 1), {
    id: "12",
    url: "https://github.com/example-org/example-repo/pull/12",
    verified: true,
    observed: { isDraft: true, headOid: "c".repeat(40), head: payload.head, base: "main", baseOid: payload.baseOid, state: "open" },
  } as RemoteReceipt);
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  expect((deps.run as unknown as Record<string, unknown>).stage).toBe("draft");
  const actions = await makeActions(fx, { journal: deps.journal, cwd: evidenceRoot });
  deps.actions = actions;
  const outcome = await resumeDraft(deps as unknown as Parameters<typeof resumeDraft>[0]);
  expect(outcome.status).toBe("succeeded");
  expect(outcome.diagnostic).toBeUndefined();
  // Nothing re-dispatched: no source post, no Slack write beyond nothing, no tracker mutation.
  const writes = fx.requests.filter((request) => request.path.includes("chat.postMessage"));
  expect(writes).toHaveLength(0);
  await rm(evidenceRoot, { recursive: true, force: true });
});

test("draft resume blocks without a readable continuation or an unverifiable branch receipt", async () => {
  const fx = await start();
  installDockerShim(); // proven-absence reclaim before any resumed settlement
  const actions = await makeActions(fx);
  // Unreadable continuation at the draft stage: blocked, never retried.
  const lost = resumeDeps(fx, "E-draft-lost");
  (lost.db as Database).run("UPDATE benny_runs SET stage = 'draft', state = ? WHERE id = ?", [JSON.stringify({ unrelated: true }), lost.run.id]);
  lost.run = (lost.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(lost.run.id) as typeof lost.run;
  lost.actions = actions;
  const lostOutcome = await resumeDraft(lost as unknown as Parameters<typeof resumeDraft>[0]);
  expect(lostOutcome.status).toBe("blocked");
  expect(lostOutcome.diagnostic).toContain("no readable continuation");

  // Readable continuation but the branch publication is not verifiably done: blocked.
  const noBranch = resumeDeps(fx, "E-draft-nobranch");
  const payload = {
    head: "benny/run-12-aaaaaaaaaaaa",
    tree: "a".repeat(40),
    base: "main",
    baseOid: "b".repeat(40),
    title: "fix",
    body: "b",
    plan: {
      feature: "f",
      steps: [{ id: "s", capability: "drive-ui" as const, input: {}, description: "d" }],
      reset: { input: {} },
      discriminating_state: "d",
      expected_state: "e",
      state_check: { key: "k", broken: "b", correct: "c" },
    },
    revision: "r",
    evidence: [{ path: `${"0".repeat(64)}.png`, sha256: "0".repeat(64) }],
  };
  (noBranch.db as Database).run("UPDATE benny_runs SET stage = 'draft', state = ? WHERE id = ?", [continuationState("draft", payload), noBranch.run.id]);
  noBranch.run = (noBranch.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(noBranch.run.id) as typeof noBranch.run;
  noBranch.actions = actions;
  const noBranchOutcome = await resumeDraft(noBranch as unknown as Parameters<typeof resumeDraft>[0]);
  expect(noBranchOutcome.status).toBe("blocked");
  expect(noBranchOutcome.diagnostic).toContain("no retained source snapshot");
});

test("draft resume blocks when the run's workspace resources cannot be proven absent", async () => {
  const fx = await start();
  // The shim lists a leftover container; ownership probes on it are
  // unprovable, so the reclaim must refuse and the resume must block
  // fail-closed before any remote write or terminal settlement claim.
  installDockerShim("benny-ws-42-0123456789abcdef");
  const deps = resumeDeps(fx, "E-draft-unreclaimed");
  const payload = {
    head: "benny/run-42-aaaaaaaaaaaa",
    tree: "a".repeat(40),
    base: "main",
    baseOid: "b".repeat(40),
    title: "fix",
    body: "b",
    plan: { feature: "f", steps: [{ id: "s", capability: "drive-ui" as const, input: {}, description: "d" }], reset: { input: {} }, discriminating_state: "d", expected_state: "e", state_check: { key: "k", broken: "b", correct: "c" } },
    revision: "r",
    evidence: [{ path: `${"0".repeat(64)}.png`, sha256: "0".repeat(64) }],
  };
  (deps.db as Database).run("UPDATE benny_runs SET stage = 'draft', state = ? WHERE id = ?", [continuationState("draft", payload), deps.run.id]);
  deps.run = (deps.db as Database).query("SELECT * FROM benny_runs WHERE id = ?").get(deps.run.id) as typeof deps.run;
  const outcome = await resumeDraft(deps as unknown as Parameters<typeof resumeDraft>[0]);
  expect(outcome.status).toBe("blocked");
  expect(outcome.diagnostic).toContain("could not be reclaimed or proven absent");
});

test("Linear 429 backoff retries immediately on zero Retry-After and throws on deadline expiry or abort", async () => {
  let requests = 0;
  let mode: "recover" | "deadline" | "abort" = "recover";
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests += 1;
      const retryAfter = mode === "deadline" ? "30" : mode === "abort" ? "5" : "0";
      if (mode === "recover" ? requests === 1 : true) {
        return new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
      }
      return Response.json({ data: { issues: { nodes: [] } } });
    },
  });
  const options = {
    apiUrl: `http://localhost:${server.port}/graphql`,
    token: "t",
    team: "T",
    project: "P",
    labels: { bug: "Bug", performance: "Performance", intake: "Intake", needsRepro: "Needs Repro" },
    status: "Intake",
  };
  const openCtx = (deadline: number) => ({ signal: new AbortController().signal, deadline });
  // Zero-length Retry-After: immediate retry, no artificial wait.
  const tracker = new LinearTracker(options);
  expect(await tracker.search("probe", openCtx(Date.now() + 10_000))).toEqual([]);
  expect(requests).toBe(2);
  // A large Retry-After cannot outlive the workflow deadline.
  mode = "deadline";
  requests = 0;
  const deadlineTracker = new LinearTracker(options);
  await expect(deadlineTracker.search("probe", openCtx(Date.now() + 400))).rejects.toThrow(/workflow deadline/);
  expect(requests).toBe(1);
  // An aborted shutdown signal cuts the backoff short with an explicit error.
  mode = "abort";
  requests = 0;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const abortTracker = new LinearTracker(options);
  await expect(abortTracker.search("probe", { signal: controller.signal, deadline: Date.now() + 60_000 })).rejects.toThrow(/aborted by the shutdown signal/);
  expect(requests).toBe(1);
});

test("pre-aborted shutdown blocks Linear tracker mutations before any transport", async () => {
  let linearRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      linearRequests += 1;
      return Response.json({ data: {} });
    },
  });
  cleanupStack.push(() => server.stop(true));
  // A run that already settled: every tracker method must refuse BEFORE its
  // transport is touched, without re-aborting registration races.
  const preAborted = { signal: AbortSignal.abort(), deadline: Date.now() + 10_000 };
  const tracker = new LinearTracker({
    apiUrl: `http://localhost:${server.port}/graphql`,
    token: "t",
    team: "T",
    project: "P",
    labels: { bug: "Bug", performance: "Performance", intake: "Intake", needsRepro: "Needs Repro" },
    status: "Intake",
  });
  await expect(tracker.create("pre-1", { title: "t", description: "d", category: "bug" }, preAborted)).rejects.toThrow(/aborted before transport/);
  await expect(tracker.search("probe", preAborted)).rejects.toThrow(/aborted before transport/);
  expect(linearRequests).toBe(0);
  const expired = { signal: new AbortController().signal, deadline: Date.now() - 1 };
  await expect(tracker.create("pre-2", { title: "t", description: "d", category: "bug" }, expired)).rejects.toThrow(/deadline expired before transport/);
  expect(linearRequests).toBe(0);
});

test("shutdown kills children and classifies the loss as uncertain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "benny-child-"));
  cleanupStack.push(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  // Pre-aborted signal: the program never spawns at all.
  const marker0 = join(dir, "never");
  await expect(
    spawnBoundedChild({ label: "git", program: "sh", argv: ["-c", `touch ${JSON.stringify(marker0)}`], env, deadline: Date.now() + 10_000, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ certainty: "uncertain", message: expect.stringContaining("aborted by shutdown before spawn") });
  // A killed child cannot finish its work; real process timing, no fake timer can drive this.
  await Bun.sleep(100);
  expect(existsSync(marker0)).toBe(false);
  const controller = new AbortController();
  const marker = join(dir, "late");
  const pending = spawnBoundedChild({ label: "git", program: "sh", argv: ["-c", `sleep 30; touch ${JSON.stringify(marker)}`], env, deadline: Date.now() + 60_000, signal: controller.signal });
  await Bun.sleep(150); // real child must be mid-flight before shutdown
  controller.abort();
  await expect(pending).rejects.toMatchObject({ certainty: "uncertain", message: expect.stringContaining("git aborted by shutdown") });
  await Bun.sleep(200); // a surviving child would have created the marker long before this
  expect(existsSync(marker)).toBe(false);
  // A real git child hung on a git:// transport is killed too: its socket closes.
  let socketClosed = false;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      close: () => {
        socketClosed = true;
      },
    },
  });
  cleanupStack.push(() => listener.stop(true));
  const childController = new AbortController();
  const gitChild = spawnBoundedChild({ label: "git", program: "git", argv: ["ls-remote", `git://127.0.0.1:${listener.port}/hang.git`], env, deadline: Date.now() + 60_000, signal: childController.signal });
  await Bun.sleep(300); // git must be connected and hung before shutdown
  childController.abort();
  await expect(gitChild).rejects.toMatchObject({ certainty: "uncertain", message: expect.stringContaining("git aborted by shutdown") });
  await Bun.sleep(150);
  expect(socketClosed).toBe(true);
  // Timeouts still resolve with timedOut so callers keep their classification.
  const timed = await spawnBoundedChild({ label: "git", program: "sh", argv: ["-c", "sleep 30"], env, deadline: Date.now() + 60_000, signal: new AbortController().signal, timeoutMs: 150 });
  expect(timed.timedOut).toBe(true);
});

test("a shutdown abort kills a hung gh child and reports the loss uncertain", async () => {
  const fx = await start();
  // A test-owned TLS GitHub that never answers pins the real gh child.
  let release: () => void = () => {};
  const hang = new Promise<void>((resolve) => (release = resolve));
  const hangServer = Bun.serve({
    port: 0,
    tls: {
      cert: Bun.file(new URL("../scripts/fixtures/localhost-cert.pem", import.meta.url)),
      key: Bun.file(new URL("../scripts/fixtures/localhost-key.pem", import.meta.url)),
    },
    fetch: async () => {
      await hang;
      return new Response("", { status: 500 });
    },
  });
  cleanupStack.push(() => {
    release();
    hangServer.stop(true);
  });
  process.env.GH_HOST = `localhost:${hangServer.port}`;
  process.env.GH_ENTERPRISE_TOKEN = "t";
  process.env.SSL_CERT_FILE = fx.githubEnv.SSL_CERT_FILE!;
  const controller = new AbortController();
  const actions = await makeActions(fx, { signal: controller.signal });
  const pending = actions.readPR("1");
  await Bun.sleep(400); // real child: gh must be started and hung on the TLS request
  controller.abort();
  await expect(pending).rejects.toMatchObject({ certainty: "uncertain", message: expect.stringContaining("gh aborted by shutdown") });
});

test("a shutdown abort kills the publication git push and reports the loss uncertain", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  // The remote blocks while the push client lives and refuses once it dies:
  // killing the child can never complete the ref update.
  writeFileSync(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nread -r line\nsleep 30\nexit 1\n", { mode: 0o755 });
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const controller = new AbortController();
  const actions = await createBennyActions({ config: publishConfig, cwd: repo, source, deadline: Date.now() + 30_000, journal: sqliteJournal(), expectedRootDigest: fixtureRootDigest, signal: controller.signal });
  const pending = actions.publishBranch("pub-abort", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-12-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" });
  await Bun.sleep(300); // real child: the push must be hung in the remote hook
  controller.abort();
  await expect(pending).rejects.toMatchObject({ certainty: "uncertain", message: expect.stringContaining("git aborted by shutdown") });
  const ref = Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-12-aaaaaaaaaaaa"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  expect(ref).toBe("");
});

test("hostile repository URLs are rejected structurally and never reach a transport", async () => {
  const fx = await start();
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const hostile = [
    "https://attacker.example/github.com/org/repo",
    "https://github.com.evil.example/org/repo",
    "https://user:pass@github.com/org/repo",
    "https://github.com:8443/org/repo",
    "https://github.com/org/repo?ref=x",
    "https://github.com/org/repo#readme",
    "https://github.com/org/repo/extra",
  ];
  for (const url of hostile) {
    const config = fixtureConfig(fx);
    config.repository = { ...config.repository, url };
    await expect(
      createBennyActions({
        config,
        cwd: await mkdtemp(join(tmpdir(), "benny-url-")),
        source,
        deadline: Date.now() + 10_000,
        journal: sqliteJournal(),
        expectedRootDigest: fixtureRootDigest,
      }),
    ).rejects.toThrow(/repository\.url/);
  }
  // The fixture gate never rescues a remote origin — only plain local paths.
  const config = fixtureConfig(fx);
  config.repository = { ...config.repository, url: "https://attacker.example/github.com/org/repo" };
  await expect(
    createBennyActions({
      config,
      cwd: await mkdtemp(join(tmpdir(), "benny-url-gate-")),
      source,
      deadline: Date.now() + 10_000,
      journal: sqliteJournal(),
      expectedRootDigest: fixtureRootDigest,
    }),
  ).rejects.toThrow(/exact HTTPS github\.com authority/);
  // Zero effects: no request ever reached a hostile origin.
  expect(fx.requests.every((request) => !JSON.stringify(request).includes("attacker"))).toBe(true);
});

test("the publication credential helper emits a token only for the approved protocol and host", async () => {
  const runHelper = async (origin?: { protocol: string; host: string }, stdin = ""): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "benny-cred-"));
    cleanupStack.push(() => rm(dir, { recursive: true, force: true }));
    const helper = join(dir, "git-credential.sh");
    await writeFile(helper, gitCredentialHelperScript(origin), { mode: 0o700 });
    const proc = Bun.spawn(["/bin/sh", helper], {
      env: { ...process.env, GH_TOKEN: "secret-token" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
    await proc.exited;
    return await new Response(proc.stdout).text();
  };
  // Approved origin: the runner env token is emitted exactly once.
  expect(await runHelper({ protocol: "https", host: "github.com" }, "protocol=https\nhost=github.com\n\n")).toBe(
    "username=x-access-token\npassword=secret-token\n",
  );
  // Any other requested host/protocol (or empty stdin) receives nothing.
  expect(await runHelper({ protocol: "https", host: "github.com" }, "protocol=https\nhost=attacker.example\n\n")).toBe("");
  expect(await runHelper({ protocol: "https", host: "github.com" }, "protocol=http\nhost=github.com\n\n")).toBe("");
  expect(await runHelper({ protocol: "https", host: "github.com" }, "")).toBe("");
  // No approved origin (local-path fixture): never emits a token at all.
  expect(await runHelper(undefined, "protocol=https\nhost=github.com\n\n")).toBe("");
});

test("a symlinked publication source component is refused before staging or any git access", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const stateRoot = join(repo, ".omp", "pstack", "state");
  const workspace = join(stateRoot, "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  // Planted escape: state/evil-link -> outside the state root, shaped like
  // the workspace the coordinator would hand to publishBranch.
  const escapeTarget = join(repo, "escape-target");
  mkdirSync(join(escapeTarget, "ws"), { recursive: true });
  cpSync(join(repo, "app.txt"), join(escapeTarget, "ws", "app.txt"));
  symlinkSync(escapeTarget, join(stateRoot, "evil-link"));
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: bare };
  const actions = await createBennyActions({
    config: publishConfig,
    cwd: repo,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
  });
  // An intermediate symlink component is an escape: refused before staging.
  await expect(
    actions.publishBranch("pub-symlink", {
      sourceDir: join(stateRoot, "evil-link", "ws"),
      sourceManifest: tree,
      head: "benny/run-16-aaaaaaaaaaaa",
      base: "main",
      baseOid,
      message: "fix",
    }),
  ).rejects.toThrow(/symlinked publication source component/);
  // Out-of-root containment is still refused verbatim.
  await expect(
    actions.publishBranch("pub-outside", {
      sourceDir: join(escapeTarget, "ws"),
      sourceManifest: tree,
      head: "benny/run-17-aaaaaaaaaaaa",
      base: "main",
      baseOid,
      message: "fix",
    }),
  ).rejects.toThrow(/outside the private Benny state root/);
  // Zero remote effects from either refusal.
  expect(
    Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-16-aaaaaaaaaaaa", "refs/heads/benny/run-17-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim(),
  ).toBe("");
});

// ---------------------------------------------------------------------------
// Run-owned publication scratch lifecycle (BennyActions.close)
// ---------------------------------------------------------------------------

/** Forces the lazy publication scratch repository to exist: staging runs before the tree-mismatch refusal. */
async function createScratch(
  fx: BennyTransports,
  options: { repo: string; bare: string; baseOid: string; workspace: string; tree: string; runId?: number; signal?: AbortSignal },
) {
  process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
  process.env.BENNY_TEST_SLACK_READ = "tok-read";
  process.env.BENNY_TEST_SLACK_WRITE = "tok-write";
  process.env.BENNY_TEST_TRACKER = "tok-tracker";
  const publishConfig = fixtureConfig(fx);
  publishConfig.repository = { ...publishConfig.repository, url: options.bare };
  return createBennyActions({
    config: publishConfig,
    cwd: options.repo,
    source,
    deadline: Date.now() + 30_000,
    journal: sqliteJournal(),
    expectedRootDigest: fixtureRootDigest,
    runId: options.runId,
    signal: options.signal,
  });
}

test("close removes exactly the run-owned publication scratch and is idempotent", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 42 });
  const scratchRoot = join(repo, ".omp", "pstack", "state", "benny-publication");
  const scratchDir = join(scratchRoot, "42");

  // Close before any publication is a no-op.
  await actions.close();
  expect(existsSync(scratchRoot)).toBe(false);

  // Tree mismatch: staging creates the run-owned scratch, then the publish fails.
  await expect(
    actions.publishBranch("pub-close-1", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-71-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);
  expect(existsSync(scratchDir)).toBe(true);

  await actions.close();
  expect(existsSync(scratchDir)).toBe(false);
  // Only the exact run-owned directory is removed; the store root stays.
  expect(existsSync(scratchRoot)).toBe(true);
  // Idempotent: a second close is a no-op.
  await actions.close();
  expect(existsSync(scratchDir)).toBe(false);
  // Zero remote effects: the mismatched publish never reached the remote.
  expect(Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-71-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
});

test("close without a run id removes the UUID fallback scratch used by direct tests", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree });
  const scratchRoot = join(repo, ".omp", "pstack", "state", "benny-publication");
  await expect(
    actions.publishBranch("pub-close-2", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-72-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);
  const entries = readdirSync(scratchRoot);
  expect(entries).toHaveLength(1);
  // Direct constructions without a run get a UUID-named scratch, never a guessed numeric name.
  expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entries[0]!)).toBe(true);
  await actions.close();
  expect(existsSync(join(scratchRoot, entries[0]!))).toBe(false);
});

test("close refuses an unvalidated publication scratch and never deletes through it", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 7 });
  const scratchRoot = join(repo, ".omp", "pstack", "state", "benny-publication");
  const scratchDir = join(scratchRoot, "7");
  await expect(
    actions.publishBranch("pub-close-3", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-73-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);
  expect(existsSync(scratchDir)).toBe(true);

  // Exact containment refusal: the scratch path was swapped for a symlink to
  // a victim directory outside the boundary. Close must refuse and leave the
  // victim's bytes untouched.
  rmSync(scratchDir, { recursive: true });
  const victim = await mkdtemp(join(tmpdir(), "benny-victim-"));
  cleanupStack.push(() => rm(victim, { recursive: true, force: true }));
  writeFileSync(join(victim, "keep.txt"), "survivor\n");
  symlinkSync(victim, scratchDir);
  await expect(actions.close()).rejects.toThrow(/refusing to remove publication scratch/);
  expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("survivor\n");
  rmSync(scratchDir);

  // A swapped regular file at the scratch path is equally refused.
  writeFileSync(scratchDir, "not a directory\n");
  await expect(actions.close()).rejects.toThrow(/refusing to remove publication scratch/);
  rmSync(scratchDir);
});

test("close cleans the publication scratch even after the run aborts", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const controller = new AbortController();
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 9, signal: controller.signal });
  const scratchDir = join(repo, ".omp", "pstack", "state", "benny-publication", "9");
  await expect(
    actions.publishBranch("pub-close-4", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-74-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);
  expect(existsSync(scratchDir)).toBe(true);
  controller.abort();
  await actions.close();
  expect(existsSync(scratchDir)).toBe(false);
});

test("a bounded child's stdout cap kills the process group and reports honest uncertainty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "benny-child-cap-"));
  cleanupStack.push(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, "late-marker");
  const pidfile = join(dir, "child-pid");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PIDFILE: pidfile, LATE_MARKER: marker };
  const startedAt = Date.now();
  // The flood trips the fixed per-stream cap; a descendant armed one second
  // later proves the whole process group was killed, not just the direct child.
  const over = spawnBoundedChild({
    label: "git",
    program: "sh",
    argv: ["-c", 'echo $$ > "$PIDFILE"; sh -c \'sleep 1; touch "$LATE_MARKER"\' & head -c 8388609 /dev/zero; sleep 30'],
    env,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
  await expect(over).rejects.toMatchObject({
    certainty: "uncertain",
    message: expect.stringContaining("git stdout output exceeded the fixed 8388608 byte per-stream cap"),
  });
  // The kill fired at the first over-cap chunk: the call never waits out the child's 30s sleep.
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  // The rejection settles only after the exit acknowledgement: the direct child is gone.
  const pid = Number(readFileSync(pidfile, "utf8").trim());
  expect(() => process.kill(pid, 0)).toThrow();
  // Real-clock proof: the descendant is a separate OS process on the platform
  // clock, so the only deterministic proof of its death is time passing beyond
  // its marker timer (no fake clock can drive or observe it).
  await Bun.sleep(1400);
  expect(existsSync(marker)).toBe(false);
  // Exactly at the cap is not over the cap: no kill, a normal result.
  const exact = await spawnBoundedChild({
    label: "git",
    program: "sh",
    argv: ["-c", "head -c 8388608 /dev/zero"],
    env,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
  expect(exact.code).toBe(0);
  expect(exact.timedOut).toBe(false);
  expect(exact.stdout).toHaveLength(8388608);
}, 15_000);

test("a bounded child's stderr cap kills the child and reports honest uncertainty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "benny-child-cap-"));
  cleanupStack.push(() => rm(dir, { recursive: true, force: true }));
  const pidfile = join(dir, "child-pid");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PIDFILE: pidfile };
  const startedAt = Date.now();
  const over = spawnBoundedChild({
    label: "git",
    program: "sh",
    argv: ["-c", 'echo $$ > "$PIDFILE"; head -c 8388609 /dev/zero >&2; sleep 30'],
    env,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
  await expect(over).rejects.toMatchObject({
    certainty: "uncertain",
    message: expect.stringContaining("git stderr output exceeded the fixed 8388608 byte per-stream cap"),
  });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  const pid = Number(readFileSync(pidfile, "utf8").trim());
  expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

test("readBoundedJsonObject refuses an advertised over-cap body before reading a single byte", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulled += 1; } });
  const response = new Response(body, { headers: { "content-length": "65" } });
  await expect(readBoundedJsonObject(response, "Slack chat.postMessage", 64)).rejects.toMatchObject({
    certainty: "uncertain",
    message: expect.stringContaining("advertises 65 bytes over the 64 byte cap"),
  });
  // The advertised cap rejects before any byte is read or buffered.
  expect(pulled).toBe(0);
});

test("readBoundedJsonObject cancels a chunked over-cap body mid-stream instead of draining it", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65).fill(0x78)); // cap+1 in the first chunk
      // Never closes: draining instead of cancelling would hang forever.
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  await expect(readBoundedJsonObject(response, "Slack chat.postMessage", 64)).rejects.toMatchObject({
    certainty: "uncertain",
    message: expect.stringContaining("exceeded the 64 byte cap"),
  });
  // The transport was cancelled, not drained past the bound.
  expect(cancelled).toBe(true);
});

// ---------------------------------------------------------------------------
// Publication scratch first-use hardening (SEC-GIT-002)
// ---------------------------------------------------------------------------

test("a planted symlink at the predictable publication scratch child is refused before any write", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 11 });
  const scratchRoot = join(repo, ".omp", "pstack", "state", "benny-publication");
  const scratchDir = join(scratchRoot, "11");
  // Pre-plant the predictable run-owned child as a symlink to a victim the
  // first publication git access would otherwise write into.
  const victim = await mkdtemp(join(tmpdir(), "benny-victim-"));
  cleanupStack.push(() => rm(victim, { recursive: true, force: true }));
  writeFileSync(join(victim, "keep.txt"), "survivor\n");
  mkdirSync(scratchRoot, { recursive: true });
  symlinkSync(victim, scratchDir);
  await expect(
    actions.publishBranch("pub-planted-1", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-80-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/not a real directory/);
  expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("survivor\n");
  // Nothing was created inside the victim (no .git, no helper script).
  expect(readdirSync(victim)).toEqual(["keep.txt"]);
  expect(Bun.spawnSync(["git", "ls-remote", bare, "refs/heads/benny/run-80-aaaaaaaaaaaa"], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
  rmSync(scratchDir);
});

test("a planted regular file at the publication scratch child is refused", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 12 });
  const scratchDir = join(repo, ".omp", "pstack", "state", "benny-publication", "12");
  mkdirSync(join(repo, ".omp", "pstack", "state", "benny-publication"), { recursive: true });
  writeFileSync(scratchDir, "not a directory\n");
  await expect(
    actions.publishBranch("pub-planted-2", { sourceDir: workspace, sourceManifest: tree, head: "benny/run-81-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/not a real directory/);
});

test("a pre-existing malicious scratch repository is replaced before use, never appended to or executed through", async () => {
  const fx = await start();
  const { repo, bare, baseOid } = await gitPublishRepo();
  const workspace = join(repo, ".omp", "pstack", "state", "benny", "ws");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repo, "app.txt"), join(workspace, "app.txt"));
  writeFileSync(join(workspace, "fix.txt"), "fixed\n");
  const tree = stageTree(repo, workspace, baseOid);
  const actions = await createScratch(fx, { repo, bare, baseOid, workspace, tree, runId: 13 });
  const scratchDir = join(repo, ".omp", "pstack", "state", "benny-publication", "13");
  // Pre-plant a real exactly-contained scratch child whose .git/config would
  // run a marker credential helper if it were ever read, appended to or used.
  const marker = join(repo, "cred-marker.fired");
  const markerHelper = join(repo, "cred-marker.sh");
  writeFileSync(markerHelper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(markerHelper, 0o700);
  mkdirSync(join(scratchDir, ".git"), { recursive: true });
  writeFileSync(
    join(scratchDir, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[credential]\n\thelper = !/bin/sh '${markerHelper}'\n`,
  );

  // Normal scratch publication still works: staging runs in the recreated
  // sanitized repository and reaches the usual tree-mismatch refusal.
  await expect(
    actions.publishBranch("pub-planted-3", { sourceDir: workspace, sourceManifest: "0".repeat(40), head: "benny/run-82-aaaaaaaaaaaa", base: "main", baseOid, message: "fix" }),
  ).rejects.toThrow(/does not match the verified workspace snapshot/);
  // The planted config bytes are gone: the scratch was removed and recreated.
  const config = readFileSync(join(scratchDir, ".git", "config"), "utf8");
  expect(config).not.toContain("cred-marker");
  expect(config).toContain("helper = !/bin/sh '");
  // Exclusive 0700 recreation.
  expect(statSync(scratchDir).mode & 0o777).toBe(0o700);
  // The planted credential helper never executed.
  expect(existsSync(marker)).toBe(false);
  await actions.close();
  expect(existsSync(scratchDir)).toBe(false);
});

test("readBoundedJsonObject accepts a body of exactly the cap delivered in chunks", async () => {
  const payload = JSON.stringify({ ok: true, pad: "x".repeat(20) });
  const bytes = new TextEncoder().encode(payload);
  const half = Math.ceil(bytes.byteLength / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, half));
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
  const parsed = await readBoundedJsonObject(new Response(body), "Slack chat.postMessage", bytes.byteLength);
  expect(parsed.ok).toBe(true);
});

test("Slack Retry-After backoff aborts with shutdown and never retries the post", async () => {
  const fx = await start();
  const controller = new AbortController();
  const actions = await makeActions(fx, { deadlineMs: 60_000, signal: controller.signal });
  fx.slack.retryNextPostAfter(30); // a demanded 30-second backoff
  const pending = actions.postThread("post-abort-retry", "verdict [benny:bug]");
  // Await the real 429 arrival before shutdown; a fixed guess of the transport
  // delay would race the abort past the backoff entry.
  const at = Date.now();
  while (!fx.requests.some((request) => request.path === "/api/chat.postMessage")) {
    if (Date.now() - at > 5_000) throw new Error("the 429 request never arrived");
    await Bun.sleep(25);
  }
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    certainty: "uncertain",
    message: expect.stringContaining("aborted during Slack chat.postMessage Retry-After backoff"),
  });
  // Only the rejected 429 request: no retry dispatch, no post, no verdict delivered.
  expect(fx.requests.filter((request) => request.path === "/api/chat.postMessage")).toHaveLength(1);
});
