import { parseBennyConfig } from "../src/benny.ts";
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { canCreateDraft, parseRoutingRoutes, routingMentionIds, selectBennyEvent, trustedVerdict } from "../src/benny-policy.ts";
import type { BennyConfig, DraftProof, SlackMessage, TrialReceipt } from "../src/benny-policy.ts";

const config = Bun.YAML.parse(await Bun.file(`${import.meta.dir}/../automations/benny/templates/configuration.example.yaml`).text()) as BennyConfig;
config.slack.source_channel_id = "C_SOURCE";
config.slack.triage_identity_user_id = "U_TRIAGE";
const source = { teamId: "T_TEAM", channel: "C_SOURCE", rootTs: "100.001" };
const moduleConfig = config;

test("admission binds human root coordinates and ignores replies, bots, edits and other channels", () => {
  const event = { event_id: "Ev1", team_id: source.teamId, event: { type: "message", channel: source.channel, ts: source.rootTs, user: "U_REPORTER", text: "report" } };
  expect(selectBennyEvent(event, config)?.source).toEqual(source);
  for (const mutation of [{ thread_ts: source.rootTs, ts: "101.002" }, { bot_id: "B_BOT" }, { subtype: "message_changed" }, { channel: "C_OTHER" }, { user: "U_TRIAGE" }]) {
    expect(selectBennyEvent({ ...event, event: { ...event.event, ...mutation } }, config)).toBeNull();
  }
  expect(() => selectBennyEvent({ ...event, event_id: "" }, config)).toThrow();
});

test("only the configured identity in the bound thread supplies a single trusted marker", () => {
  const message: SlackMessage = { ts: "101.002", thread_ts: source.rootTs, channel: source.channel, user: "U_TRIAGE", text: "Confirmed\n[benny:bug]" };
  expect(trustedVerdict([message], config, source)).toBe("bug");
  expect(trustedVerdict([{ ...message, user: "U_ATTACKER" }], config, source)).toBeNull();
  expect(trustedVerdict([{ ...message, thread_ts: "999.999" }], config, source)).toBeNull();
  expect(trustedVerdict([{ ...message, text: "[benny:bug] [benny:other]" }], config, source)).toBe("conflict");
  expect(trustedVerdict([message, { ...message, ts: "102.003", text: "[benny:performance]" }], config, source)).toBe("conflict");
});

function proof(): DraftProof {
  const trials: TrialReceipt[] = Array.from({ length: 4 }, (_, index) => ({
    runId: "run-one", phase: index < 2 ? "baseline" : "patched", revision: index < 2 ? "baseline-sha" : "patched-sha",
    at: 10 + index, stepIds: ["open-form", "enter-value", "submit"], resetId: `reset-${index}`,
    observed: index < 2 ? "broken" : "correct", stateChecks: { displayedValue: index < 2 ? "wrong" : "expected" },
    controlIds: [`control-${index}`], artifacts: ["image/png", "video/webm"].map((mimeType) => ({
      path: `trial-${index}-${mimeType.replace("/", ".")}`, mimeType,
      sha256: createHash("sha256").update(`${index}-${mimeType}`).digest("hex"),
    })),
  }));
  return { runId: "run-one", trials, media: { confirmed: true, evidence: ["Discriminating before/after states visible"], reviewedHashes: trials.flatMap((trial) => trial.artifacts.map((artifact) => artifact.sha256)) }, sourceReply: { id: "101.001", verified: true, at: 70 }, rejectionEndsAt: 80, ownershipCheckedAt: 90, artifactsCheckedAt: 90, owned: false, existingFix: false, rejected: false, blastRadiusPassed: true, now: 100, deadline: 200 };
}

test("draft gate requires independent before/after receipts and review of those exact artifacts", () => {
  expect(canCreateDraft(proof()).allowed).toBe(true);
  const reusedReset = proof(); reusedReset.trials[1]!.resetId = reusedReset.trials[0]!.resetId;
  expect(canCreateDraft(reusedReset).allowed).toBe(false);
  const differentPath = proof(); differentPath.trials[3]!.stepIds = ["shortcut"];
  expect(canCreateDraft(differentPath).allowed).toBe(false);
  const missingVideo = proof(); missingVideo.trials[3]!.artifacts = missingVideo.trials[3]!.artifacts.filter((artifact) => artifact.mimeType.startsWith("image/"));
  expect(canCreateDraft(missingVideo).allowed).toBe(false);
  const unreviewed = proof(); unreviewed.media.reviewedHashes.pop();
  expect(canCreateDraft(unreviewed).allowed).toBe(false);
  expect(canCreateDraft({ ...proof(), sourceReply: { id: "", verified: false, at: 70 } }).allowed).toBe(false);
});

test("ownership, existing fixes, rejection, stale reads and deadlines block authored PRs", () => {
  for (const change of [{ owned: true }, { existingFix: true }, { rejected: true }, { rejectionEndsAt: 101 }, { ownershipCheckedAt: 20 }, { artifactsCheckedAt: 20 }, { deadline: 100 }, { deadline: NaN }, { blastRadiusPassed: false }]) {
    expect(canCreateDraft({ ...proof(), ...change }).allowed).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Config secrets: raw credential values and credential-shaped keys are
// rejected at parse time, derived from the shipped example configuration.
// ---------------------------------------------------------------------------

/** The example configuration with every placeholder filled, so parsing reaches the secret checks. */
function sanitizedExample(): BennyConfig {
  const config = structuredClone(moduleConfig) as BennyConfig;
  const fill = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      if (/placeholder/i.test(value)) return `filled-${path.replaceAll(".", "-")}`;
      if (value === "SOURCE_CHANNEL_ID") return "C_SOURCE";
      if (value === "TRIAGE_IDENTITY_USER_ID") return "U_TRIAGE";
      if (value === "choose-an-available-public-model-slug") return "acme/example-model";
      if (/example-org/i.test(value)) return value.replace(/example-org/g, "acme-org");
    }
    if (Array.isArray(value)) return value.map((item, index) => fill(item, `${path}[${index}]`));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, `${path}.${key}`)]));
    }
    return value;
  };
  const filled = fill(config, "config") as BennyConfig;
  filled.slack.source_channel_id = "C_SOURCE";
  filled.slack.triage_identity_user_id = "U_TRIAGE";
  return filled;
}

test("raw committed credential values fail parsing across every supported prefix", () => {
  const secrets = [
    "xoxb-123456-1234567-abcdefghij",
    "xoxp-123456-1234567-abcdefghij",
    "xoxc-123456789012-abcdef",
    "xoxd-1234567890123456789012345678901234567890",
    "xapp-1-ABCDEF-1234567890123456789012",
    "sk-proj-abcdefghijklmnopqrstuvwx",
    `ghp_${"a".repeat(36)}`,
    `github_pat_${"A1b2c3d4e5".repeat(6)}`,
    `lin_api_${"a".repeat(40)}`,
    `AIza${"a".repeat(35)}`,
    `hf_${"a".repeat(30)}`,
    `gsk_${"a".repeat(30)}`,
    `xai-${"a".repeat(30)}`,
    `glpat-${"a".repeat(25)}`,
    "AKIAIOSFODNN7EXAMPLE",
  ];
  for (const secret of secrets) {
    const config = sanitizedExample();
    config.runtime.control_config.app_url = secret;
    expect(() => parseBennyConfig(config)).toThrow(/looks like a secret/);
  }
});

test("ordinary prose and documented prefixes are not flagged", () => {
  const config = sanitizedExample();
  config.runtime.control_config = {
    worker_command: ["sh", "-c", "true"],
    app_url: "http://benny-worker:8791/",
    notes: "Slack bot tokens begin with xoxb- and app tokens with xapp-. OpenAI keys begin with sk-. Fine-grained GitHub PATs begin with github_pat_.",
  };
  config.runtime.environment = { NODE_ENV: "test", FEATURE_FLAGS: "beta" };
  expect(() => parseBennyConfig(config)).not.toThrow();
});

test("credential-shaped keys in runtime maps are rejected recursively", () => {
  const nested = sanitizedExample();
  nested.runtime.control_config = {
    worker_command: ["sh", "-c", "true"],
    app_url: "http://benny-worker:8791/",
    bootstrap: { steps: [{ secret_key: "even-inside-arrays" }] },
  };
  expect(() => parseBennyConfig(nested)).toThrow(/config\.runtime\.control_config\.bootstrap\.steps\[0\]\.secret_key.*credential-shaped/);
  const env = sanitizedExample();
  env.runtime.environment = { DB_HOST: "localhost", GITHUB_TOKEN: "provided-at-runtime" };
  expect(() => parseBennyConfig(env)).toThrow(/config\.runtime\.environment\.GITHUB_TOKEN.*credential-shaped/);
});

test("typed *_token_env fields remain the only credential references", () => {
  const config = sanitizedExample();
  config.runtime.environment = { APP_ENV: "safe-test" };
  config.runtime.control_config = { worker_command: ["sh", "-c", "true"], app_url: "http://benny-worker:8791/" };
  expect(config.runtime.slack_write_token_env).toMatch(/TOKEN/);
  expect(() => parseBennyConfig(config)).not.toThrow();
});

test("a raw secret nested in a template control map fails parsing", () => {
  const config = sanitizedExample();
  config.runtime.control_config = {
    worker_command: ["sh", "-c", "true"],
    app_url: "http://benny-worker:8791/",
    diagnostics: "session cookie: xoxd-1234567890123456789012345678901234567890",
  };
  expect(() => parseBennyConfig(config)).toThrow(/looks like a secret/);
});

test("an empty routing map is a valid committed map with no routes and no pings", () => {
	const emptyMap = [
		"# routing",
		"",
		"```yaml",
		"routes: []",
		"fallback:",
		"  owners: []",
		"  allow_feature_owner_ping: false",
		"```",
	].join("\n");
	const routes = parseRoutingRoutes(emptyMap);
	expect(routes).toEqual({ routes: [], fallbackOwners: [], fallbackAllowFeatureOwnerPing: false });
	expect(routingMentionIds(emptyMap).size).toBe(0);
});

test("the routing map path is required: an empty map_path fails config parsing while an empty map content parses", () => {
	const emptyPath = sanitizedExample();
	emptyPath.routing.map_path = "";
	expect(() => parseBennyConfig(emptyPath)).toThrow(/map_path/);
	// A committed but empty map file is exactly what the schema accepts.
	const emptyMapPath = sanitizedExample();
	expect(emptyMapPath.routing.map_path).toMatch(/routing\.md$/);
	expect(() => parseBennyConfig(emptyMapPath)).not.toThrow();
});
