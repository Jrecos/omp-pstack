import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryEligible, runBenny, type BennyConfig } from "../src/benny.ts";
import { bennyProofDigest, bennyProofInputs } from "./check-content.ts";
import { FIXTURE_PNG, startBennyTransports } from "./fixtures/benny-transports.ts";
import { ensureImage } from "./fixtures/benny-workspace/proof.ts";

// Exact per-phase receipt arrays; mirrors src/benny-run.ts CANARY_REQUIRED and
// the checker's BENNY_PROOF_PHASE_RECEIPTS. Update all three together.
const CANARY_PHASE_RECEIPTS: Record<string, string[]> = {
  triage: ["slack.verdict.readback", "tracker.mutation.readback"],
  reproduce: ["control.all-seven", "media.every-artifact", "git.remote-head", "github.draft-oid", "control.cleanup"],
};

const packageRoot = join(import.meta.dir, "..");
const workspaceImage = await ensureImage();
const temporary = await mkdtemp(join(tmpdir(), "pstack-benny-smoke-"));
const target = join(temporary, "repo");
const configPath = join(target, ".omp", "benny", "configuration.yaml");
const remote = join(temporary, "remote.git");
const initializedRemote = Bun.spawnSync(["git", "init", "--bare", "-q", remote], { stdout: "pipe", stderr: "pipe" });
assert.equal(initializedRemote.exitCode, 0, initializedRemote.stderr.toString());
const rootText = "Regression: clicking Increment leaves the visible counter at 0 instead of 1. Reset, click Increment once, and observe the count.";
const fixture = await startBennyTransports({
  rootText,
  threadReplies: ["Reproduces from a clean reset every time; nobody is working on a fix."],
  gitRepoPath: remote,
});
const envNames = ["BENNY_SMOKE_APP", "BENNY_SMOKE_SLACK_READ", "BENNY_SMOKE_SLACK_WRITE", "BENNY_SMOKE_TRACKER", "GH_HOST", "GH_ENTERPRISE_TOKEN", "SSL_CERT_FILE", "PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES"];
process.env.PSTACK_BENNY_ALLOW_LOOPBACK_FIXTURES = "1";
const savedEnv = new Map(envNames.map(name => [name, process.env[name]]));

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", target, ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
}

try {
  await mkdir(join(target, ".omp", "benny"), { recursive: true });
  await mkdir(join(target, "app"), { recursive: true });
  await cp(join(packageRoot, "automations", "benny"), join(target, ".omp", "automations", "benny"), { recursive: true });
  await cp(join(import.meta.dir, "fixtures", "benny-workspace", "app"), join(target, "app"), { recursive: true });
  await writeFile(join(target, ".omp", "benny", "feature-map.md"), `### counter\n\n- Reset with drive-features {"feature":"counter","action":"reset"}.\n- Reproduce with drive-features {"feature":"counter","action":"increment"}.\n- Inspect with inspect-state {"query":"counter"}.\n- Broken: visible count remains "0" after one increment.\n- Correct: visible count becomes "1" after one increment.\n`);
  await writeFile(join(target, ".omp", "benny", "routing.md"), "# Routing\n\nCounter reports stay with the configured repository.\n");

  const template = Bun.YAML.parse(await Bun.file(join(packageRoot, "automations", "benny", "templates", "configuration.example.yaml")).text()) as BennyConfig;
  const model = "openai-codex/gpt-6-astra:high";
  template.slack = {
    ...template.slack,
    source_channel_id: "C_SOURCE",
    operations_channel_id: "C_OPS",
    triage_identity_user_id: "U_BENNY",
    optional_bot_token_env: "BENNY_SMOKE_SLACK_WRITE",
  };
  template.repository = {
    ...template.repository,
    url: remote,
    default_branch: "main",
  };
  template.tracker = {
    ...template.tracker,
    team: "Benny Team",
    project: "Benny Project",
    labels: { bug: "Bug", performance: "Performance", intake: "Intake", needs_repro: "Needs Repro" },
    status: "Intake",
  };
  template.routing.map_path = ".omp/benny/routing.md";
  template.control = {
    ...template.control,
    skill_name: "benny-fixture-control",
    feature_map_path: ".omp/benny/feature-map.md",
    environment: "isolated-local-fixture",
    artifact_directory: ".omp/pstack/state/benny-evidence",
  };
  template.budgets = {
    ...template.budgets,
    triage_follow_up_minutes: 0,
    rejection_window_minutes: 0,
    operations_follow_up_minutes: 0,
  };
  template.models = { triage: model, reproduce: model, code: model, media_review: model };
  template.runtime = {
    trigger: "external",
    slack_app_token_env: "BENNY_SMOKE_APP",
    slack_read_token_env: "BENNY_SMOKE_SLACK_READ",
    slack_write_token_env: "BENNY_SMOKE_SLACK_WRITE",
    tracker_token_env: "BENNY_SMOKE_TRACKER",
    workspace_image: workspaceImage,
    control_command: ["bun", "/opt/benny-control/control.mjs"],
    control_config: {
      worker_command: ["sh", "-c", "nohup bun /workspace/app/server.ts 8791 >/artifacts/app.log 2>&1 &"],
      app_url: "http://benny-worker:8791/",
    },
    environment: { APP_ENV: "benny-smoke" },
    allowed_endpoints: [],
    slack_api_url: fixture.slackUrl,
    linear_api_url: fixture.linearUrl,
  };
  await writeFile(configPath, `${JSON.stringify(template, null, 2)}\n`);

  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Benny Smoke", "-c", "user.email=benny-smoke@localhost", "commit", "-q", "-m", "counter regression fixture");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");

  process.env.BENNY_SMOKE_APP = "fixture-app-token";
  process.env.BENNY_SMOKE_SLACK_READ = "fixture-read-token";
  process.env.BENNY_SMOKE_SLACK_WRITE = "fixture-write-token";
  process.env.BENNY_SMOKE_TRACKER = "fixture-tracker-token";
  Object.assign(process.env, fixture.githubEnv);

  const event = {
    event_id: "Ev-benny-smoke",
    team_id: "T_TEAM",
    event: { type: "message", channel: "C_SOURCE", ts: "100.001", user: "U_REPORTER", text: rootText, files: [{ id: "F001", mimetype: "image/png", size: FIXTURE_PNG.byteLength }] },
  };
  const outcome = await runBenny(configPath, event, { canary: true });
  assert.equal(outcome.admitted, true);
  assert.deepEqual(outcome.results.map(result => [result.phase, result.status, result.diagnostic]), [
    ["triage", "succeeded", undefined],
    ["reproduce", "succeeded", undefined],
  ]);
  for (const result of outcome.results) {
    assert.deepEqual(result.canaryEvidence, CANARY_PHASE_RECEIPTS[result.phase], `phase ${result.phase} receipt array must be exact`);
  }
  assert.equal(fixture.linear.issues().length, 1, "triage must create exactly one reconciled tracker issue");
  const pulls = fixture.github.pulls();
  assert.equal(pulls.length, 1, "reproduce must create exactly one draft pull request");
  assert.equal(pulls[0]?.draft, true);
  assert.match(pulls[0]?.head.oid ?? "", /^[0-9a-f]{40,64}$/, "published head OID must be a 40-64 hex commit OID");
  assert.equal(canaryEligible(target, template).eligible, true);
  const sourcePosts = fixture.requests.filter(request => request.path === "/api/chat.postMessage" && (request.body as Record<string, unknown> | undefined)?.channel === "C_SOURCE");
  assert(sourcePosts.length >= 2);
  assert(sourcePosts.every(request => (request.body as Record<string, unknown>).thread_ts === "100.001" && (request.body as Record<string, unknown>).reply_broadcast === false));
  // Fixture-only freshness evidence: every transport here is a local fixture,
  // the wait windows are deliberately zeroed, and no authorized live
  // Slack/tracker/GitHub readback took place. This artifact must never be
  // presented as live-deployment parity evidence, and the committed JSON is
  // deterministic freshness evidence only — this command's execution is the
  // runtime proof, live readback is the deployment proof.
  const effectiveZeroWaitWindows = Object.entries(template.budgets)
    .filter(([, minutes]) => minutes === 0)
    .map(([window]) => window);
  const proof = {
    fixture: true,
    capturedAt: new Date().toISOString(),
    actualModel: model,
    fixtureTransports: {
      slack: fixture.slackUrl,
      tracker: fixture.linearUrl,
      github: fixture.githubEnv.GH_HOST,
    },
    effectiveBudgets: template.budgets,
    effectiveZeroWaitWindows,
    liveReadback: false,
    phases: outcome.results.map(({ phase, status, diagnostic, canaryEvidence }) => ({ phase, status, diagnostic, canaryEvidence })),
    trackerIssues: fixture.linear.issues().length,
    draftPulls: pulls.length,
    publishedHeadOid: pulls[0]?.head.oid,
    sourceThreadPosts: sourcePosts.length,
    canaryEligible: true,
    // Deterministic binding to the exact producer + transitive behavior-bearing
    // source, pack, lock and fixture bytes this evidence was generated
    // against; the canonical content check recomputes it.
    producerInputs: await bennyProofInputs(packageRoot),
    producerDigest: await bennyProofDigest(packageRoot),
  };
  await mkdir(join(packageRoot, "proofs"), { recursive: true });
  await writeFile(join(packageRoot, "proofs", "benny-runtime.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, actualModel: model, phases: outcome.results, issues: fixture.linear.issues().length, draftPulls: pulls.length, sourceThreadPosts: sourcePosts.length, canaryEligible: true }));
} finally {
  await fixture.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}
