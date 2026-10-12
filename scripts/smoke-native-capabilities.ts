#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

type Measurement = {
  name: string;
  evidence: "native-cli" | "native-sdk-schema" | "native-sdk-runtime";
  raw: Record<string, unknown>;
  checks: Record<string, boolean>;
  errors: string[];
  limits: string[];
  unavailable?: string;
};
type Deferred = { name: string; evidence: "unexercised"; reason: string; limits: string[] };
type Proposal = { id: number; name: string; subcapabilities: (Measurement | Deferred)[] };
type CommandResult = {
  argv: string[];
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflow: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
};
type TaskSchemaObservation = {
  isolationEnabled: boolean;
  planMode: boolean;
  isolatedPresent: boolean;
  outputSchemaPresent: boolean;
  schemaModePresent: boolean;
  modelOverridePresent: boolean;
  solutionSpaceRequired: boolean;
  schema: unknown;
};
type GuardObservation = {
  enabled: boolean;
  command: string;
  result: AgentToolResult<unknown>;
  before: string;
  after: string;
  rejected: boolean;
  nativeGuardDiagnostic: boolean;
};

const root = resolve(import.meta.dir, "..");
const outputFile = join(root, "proofs", "native-capabilities.json");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a native object result");
  return value as Record<string, unknown>;
};
const packageMetadata = object(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
const expectedVersion = object(packageMetadata.dependencies)["@oh-my-pi/pi-coding-agent"];
assert(typeof expectedVersion === "string" && /^\d+\.\d+\.\d+$/.test(expectedVersion), "The SDK must have an exact version pin");
const measurement = (name: string, evidence: Measurement["evidence"], limits: string[]): Measurement =>
  ({ name, evidence, raw: {}, checks: {}, errors: [], limits });
const deferred = (name: string, reason: string): Deferred =>
  ({ name, evidence: "unexercised", reason, limits: ["No runtime success is claimed."] });
const fail = (sample: Measurement, error: unknown) => sample.errors.push(error instanceof Error ? error.message : String(error));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error("Unexpected non-file fixture member");
  }
  return files.sort();
}

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 45_000, ownGroup = false): Promise<CommandResult> {
  const started = performance.now();
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: ownGroup, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, overflow = false;
  const kill = () => {
    if (ownGroup && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill("SIGKILL");
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  if (ownGroup) {
    process.once("SIGINT", kill);
    process.once("SIGTERM", kill);
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    stdout += text;
    if (stdout.length + stderr.length > 1_048_576) { overflow = true; kill(); }
  });
  child.stderr.on("data", (text: string) => {
    stderr += text;
    if (stdout.length + stderr.length > 1_048_576) { overflow = true; kill(); }
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    return { argv, cwd, ...exit, timedOut, overflow, stdout, stderr, durationMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
    if (ownGroup) {
      process.removeListener("SIGINT", kill);
      process.removeListener("SIGTERM", kill);
    }
    if (ownGroup) kill();
  }
}

function successful(result: CommandResult): void {
  assert(!result.timedOut && !result.overflow && result.code === 0,
    `Command failed (${result.code ?? result.signal}) ${result.argv.join(" ")}\n${result.stderr}\n${result.stdout}`);
}

async function isolatedEnvironment(home: string, temporary: string): Promise<NodeJS.ProcessEnv> {
  const profile = join(home, ".omp", "agent");
  for (const directory of [home, profile, join(temporary, "tmp"), join(home, ".config"), join(home, ".cache"), join(home, ".local", "share")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return {
    PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: profile,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(temporary, "tmp"), TMP: join(temporary, "tmp"), TEMP: join(temporary, "tmp"),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", CI: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Native capability fixture", GIT_AUTHOR_EMAIL: "native-proof@example.invalid",
    GIT_COMMITTER_NAME: "Native capability fixture", GIT_COMMITTER_EMAIL: "native-proof@example.invalid",
  };
}

if (!process.env.PSTACK_NATIVE_PROOF_CHILD) {
  const temporary = await mkdtemp(join(tmpdir(), "pstack-native-capabilities-"));
  try {
    const binary = Bun.which(process.env.PSTACK_NATIVE_PROOF_OMP ?? "omp");
    const env = await isolatedEnvironment(join(temporary, "home"), temporary);
    const result = await run([process.execPath, import.meta.path], temporary, {
      ...env, PSTACK_NATIVE_PROOF_CHILD: temporary,
      PSTACK_NATIVE_PROOF_OMP: binary ? await realpath(binary) : "",
    }, 240_000, true);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.timedOut || result.overflow) console.error("Native capability producer exceeded its process deadline or output bound.");
    process.exitCode = result.timedOut || result.overflow ? 1 : (result.code ?? 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  await produce(process.env.PSTACK_NATIVE_PROOF_CHILD, process.env.PSTACK_NATIVE_PROOF_OMP ?? "");
  process.exit(process.exitCode ?? 0);
}

async function produce(temporary: string, omp: string): Promise<void> {
  process.umask(0o077);
  const worktree = measurement("explicit CLI worktree creation", "native-cli", [
    "This is omp worktree add, not automatic interactive main-session startup.",
    "Checkout separation is not a process, network, or Docker security boundary.",
  ]);
  const ignoredArtifact = measurement("ignored artifact preservation", "native-cli", [
    "A documented plain-checkout fallback can omit ignored build artifacts.",
    "Availability is measured on this filesystem. No cloning speedup is inferred.",
  ]);
  const schema = measurement("session-bound TaskTool isolation gates", "native-sdk-schema", [
    "Schema observations do not exercise a worker, its filesystem, or integration of its changes.",
  ]);
  const plainSchema = measurement("default plain task schema", "native-sdk-schema", [
    "No generated agent is dispatched here. Plain completion behavior needs fresh smoke-models evidence.",
  ]);
  const fork = measurement("persisted transcript fork", "native-sdk-runtime", [
    "SessionManager.fork is exercised headlessly. The /fork command and terminal launch are not.",
    "A transcript fork retains its cwd and provides no checkout isolation.",
  ]);
  const jobs = measurement("native bash job inspection and cancellation", "native-sdk-runtime", [
    "An independent SDK root is used for the foreign-job check. Shared-manager subagent ownership is not exercised.",
    "Rendered job cards and human cancellation controls are not exercised.",
  ]);
  const anonymize = measurement("fixture transcript anonymization and refusals", "native-cli", [
    "Seeded-canary absence is not general anonymization accuracy. Manually review any diagnostic export before sharing.",
    "Only generated private fixtures are opened. No real session history is read.",
  ]);
  const transfer = measurement("session pack, unpack, divergence and moved marker", "native-cli", [
    "The two machines are simulated by disjoint private profiles and working directories.",
    "No credentials, checkout, external referenced files, or model-generated handoff summary are transferred.",
  ]);
  const notes = measurement("initialized extension annotation submission", "native-sdk-runtime", [
    "Only explicit text and diff sources with deliver none are exercised. No annotation overlay or composer interaction is claimed.",
  ]);
  const guard = measurement("native BashTool gitGuard on and off", "native-sdk-runtime", [
    "The embedded-shell git builtin is exercised. External shells, absolute git paths, and arbitrary processes bypass this guard.",
    "This does not replace the existing destructive-command prohibition or Docker sandbox.",
  ]);
  const proposals: Proposal[] = [
    { id: 1, name: "Main-session worktrees", subcapabilities: [worktree, ignoredArtifact, deferred("automatic main-session worktree", "Requires a fresh interactive launch with worktree.onStart create, plus resume and linked-worktree negative cases.")] },
    { id: 2, name: "Isolated task workers", subcapabilities: [schema, deferred("actual isolated worker execution", "Requires an authenticated generated worker, with separate apply-off and apply-on filesystem observations.")] },
    { id: 3, name: "Plain task results", subcapabilities: [plainSchema, deferred("generated-agent plain completion", "Parent-owned scripts/smoke-models.ts must produce fresh literal-output and native task receipts after the SDK migration. No historical result is imported.")] },
    { id: 4, name: "Forks and terminal launch", subcapabilities: [fork, deferred("terminal fork and openTerminal", "Requires a persisted interactive session and a supported live multiplexer. Verify parent usability, child session identity and shared cwd.")] },
    { id: 5, name: "Job metadata and cancellation", subcapabilities: [jobs] },
    { id: 6, name: "Browser target adoption", subcapabilities: [deferred("Tern or relay targets", "Requires an attached Tern pane or omp browser relay with two known pages. Ordinary headless browser availability is not target-adoption proof.")] },
    { id: 7, name: "Diagnostic anonymization", subcapabilities: [anonymize] },
    { id: 8, name: "Session transfer", subcapabilities: [transfer] },
    { id: 9, name: "Annotations", subcapabilities: [notes, deferred("annotation overlay", "Requires live TUI collection and paste observation. Headless submit is not UI proof.")] },
    { id: 10, name: "gitGuard", subcapabilities: [guard] },
  ];
  const measured = proposals.flatMap(proposal => proposal.subcapabilities).filter((part): part is Measurement => part.evidence !== "unexercised");
  const canaries = [
    `PRIVATE_BODY_${randomUUID()}`, `sk-private-${randomUUID()}`,
    `/private/native-canary-${randomUUID()}/secret.txt`, `PRIVATE_ARTIFACT_${randomUUID()}`,
  ];
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];
  const cleanupErrors: string[] = [];
  const producerInputs: Record<string, string> = {};
  const packages: Record<string, { version: string; entry: string; manifest: string }> = {};
  let host: Record<string, unknown> = { resolvedBinary: omp || null, expectedVersion };
  let attemptedModelDispatches = 0, credentialRequests = 0, blockedFetches = 0, blockedPreconnects = 0;
  const savedFetch = globalThis.fetch;
  const denyFetch = Object.assign(async (): Promise<Response> => {
    blockedFetches++;
    throw new Error("Network fetch is disabled in the auth-free native capability producer");
  }, { preconnect: () => { blockedPreconnects++; } });
  const sessions: AgentSession[] = [];
  let closeAuth: (() => void) | undefined;
  try {
    if (omp) {
      const version = await run([omp, "--version"], temporary);
      host = { ...host, versionCommand: version, binarySha256: await hashFile(omp),
        actualVersion: /(?:omp\/|\b)(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(version.stdout)?.[1] ?? null };
      checks.hostVersion = version.code === 0 && !version.timedOut && !version.overflow && host.actualVersion === expectedVersion;
    } else checks.hostVersion = false;
    for (const path of ["scripts/smoke-native-capabilities.ts", "package.json", "bun.lock"]) {
      producerInputs[path] = await hashFile(join(root, path));
    }
    for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-catalog", "pi-tui", "pi-utils", "pi-natives"]) {
      const entry = await realpath(fileURLToPath(import.meta.resolve(`@oh-my-pi/${name}`)));
      const manifest = join(dirname(dirname(entry)), "package.json");
      const metadata = object(JSON.parse(await readFile(manifest, "utf8")));
      assert.equal(metadata.name, `@oh-my-pi/${name}`, "Resolved package manifest must match its import");
      assert.equal(typeof metadata.version, "string");
      packages[name] = { version: metadata.version as string, entry, manifest };
      producerInputs[`sdk/${name}/package.json`] = await hashFile(manifest);
    }
    checks.sdkVersion = Object.values(packages).every(pkg => pkg.version === expectedVersion);
    assert(checks.sdkVersion, `SDK packages must all be ${expectedVersion}; observed ${JSON.stringify(packages)}`);
    for (const path of [
      "sdk.ts", "session/agent-session.ts", "session/session-manager.ts", "session/session-loader.ts",
      "session/session-anonymizer.ts", "session/session-transfer.ts", "session/sub-sessions.ts",
      "task/index.ts", "task/types.ts", "task/settings.ts", "tools/bash.ts", "exec/bash-executor.ts",
      "async/job-manager.ts", "cli/worktree-cli.ts", "cli/anonymize-cli.ts", "commands/session.ts",
      "modes/runtime-init.ts", "extensibility/extensions/runner.ts",
      "extensibility/custom-commands/bundled/annotate/api.ts",
    ]) producerInputs[`sdk/pi-coding-agent/src/${path}`] = await hashFile(join(dirname(packages["pi-coding-agent"]!.entry), path));
    globalThis.fetch = denyFetch;
    // Loading the SDK only here keeps cached paths and HTTP clients inside the isolated child's deny boundary.
    const { AgentRegistry, AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
    const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
    const { loadSessionFile } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
    const { sessionTransferDetails } = await import("@oh-my-pi/pi-coding-agent/session/session-transfer");
    const { readArchiveEntries } = await import("@oh-my-pi/pi-utils/ar");
    const profile = process.env.PI_CODING_AGENT_DIR!;
    const cwd = join(temporary, "repository");
    await mkdir(cwd);
    const cliConfig = { worktree: { clone: true }, isolation: { backend: "reflink" }, startup: { checkUpdate: false, setupWizard: false }, memory: { backend: "off" }, autolearn: { enabled: false } };
    await writeFile(join(profile, "config.yml"), `${JSON.stringify(cliConfig)}\n`);
    successful(await run(["git", "init", "--initial-branch=main", cwd], temporary));
    await writeFile(join(cwd, "tracked.txt"), "committed\n");
    await writeFile(join(cwd, ".gitignore"), "required-build-artifact.bin\n");
    successful(await run(["git", "add", "."], cwd));
    successful(await run(["git", "commit", "-m", "fixture"], cwd));

    async function seed(directory: string, body: string) {
      const manager = SessionManager.create(cwd, directory);
      try {
        manager.appendMessage({ role: "user", content: body, timestamp: Date.now() });
        manager.appendCustomEntry("native-proof-fixture", { synthetic: true, body });
        await manager.ensureOnDisk();
        await manager.flush();
        return { file: manager.getSessionFile()!, id: manager.getSessionId(), artifacts: manager.getArtifactsDir()!, cwd: manager.getCwd() };
      } finally { await manager.close(); }
    }

    async function observeWorktree() {
      try {
        assert(checks.hostVersion, `The resolved omp must report ${expectedVersion}`);
        const destination = join(temporary, "worktree");
        const tracked = join(cwd, "tracked.txt");
        const artifactName = "required-build-artifact.bin";
        await writeFile(tracked, "source-only dirty edit\n");
        await writeFile(join(cwd, artifactName), canaries[3]!);
        const before = { tracked: await hashFile(tracked), artifact: await hashFile(join(cwd, artifactName)), head: (await run(["git", "rev-parse", "HEAD"], cwd)).stdout.trim() };
        const command = await run([omp, "worktree", "add", "-b", "native-proof", destination, "HEAD"], cwd);
        worktree.raw = { command, before, settings: cliConfig };
        ignoredArtifact.raw = { command, sourceSha256: before.artifact, settings: cliConfig };
        successful(command);
        const branch = await run(["git", "symbolic-ref", "--short", "HEAD"], destination);
        successful(branch);
        const initialChild = await readFile(join(destination, "tracked.txt"), "utf8");
        await writeFile(join(destination, "tracked.txt"), "child-only edit\n");
        const sourceAfterChildEdit = await hashFile(tracked);
        const childHash = await hashFile(join(destination, "tracked.txt"));
        const sourceHead = await run(["git", "rev-parse", "HEAD"], cwd);
        successful(sourceHead);
        Object.assign(worktree.raw, { branch: branch.stdout.trim(), initialChildSha256: sha256(initialChild), childSha256: childHash, sourceAfterChildEdit, sourceHead: sourceHead.stdout.trim() });
        worktree.checks = {
          branchCreated: branch.stdout.trim() === "native-proof",
          trackedEditIndependent: sourceAfterChildEdit === before.tracked && childHash !== sourceAfterChildEdit,
          originalTrackedFileUnchanged: sourceAfterChildEdit === before.tracked,
          originalHeadUnchanged: sourceHead.stdout.trim() === before.head,
          originalIgnoredArtifactUnchanged: await hashFile(join(cwd, artifactName)) === before.artifact,
        };
        const childArtifact = Bun.file(join(destination, artifactName));
        const present = await childArtifact.exists();
        const childArtifactSha256 = present ? await hashFile(join(destination, artifactName)) : null;
        const cloneReported = command.stdout.includes("Cloned from ");
        const fallbackReported = command.stderr.includes("worktree clone fell back to plain checkout:");
        const preserved = present && childArtifactSha256 === before.artifact;
        Object.assign(ignoredArtifact.raw, { ignoredArtifactPresent: present, ignoredArtifactPreserved: preserved, childArtifactSha256, cloneReported, fallbackReported, ficloneMentioned: /FICLONE|reflink/i.test(command.stderr) });
        ignoredArtifact.checks = { cloneOutcomeReported: cloneReported !== fallbackReported, clonedArtifactMatches: !cloneReported || preserved, presentArtifactMatches: !present || preserved };
        if (fallbackReported && !preserved) ignoredArtifact.unavailable = "Native clone fallback was observed. The required ignored artifact is absent from the plain checkout, so artifact preservation is unavailable on this run.";
      } catch (error) { fail(worktree, error); fail(ignoredArtifact, error); }
    }

    async function observeAnonymize() {
      try {
        assert(checks.hostVersion, `The resolved omp must report ${expectedVersion}`);
        const parent = await seed(join(temporary, "anonymous-source"), canaries.slice(0, 3).join("\n"));
        const child = await seed(parent.artifacts, canaries[0]!);
        await appendFile(child.file, "{malformed fixture record}\n");
        await writeFile(join(parent.artifacts, "Unreadable.jsonl"), "{broken fixture}\n");
        const originals = await filesBelow(dirname(parent.file));
        const before = Object.fromEntries(await Promise.all(originals.map(async path => [path, await hashFile(path)])));
        const exported = join(temporary, "anonymized");
        const command = await run([omp, "anonymize", parent.file, "--out", exported], cwd);
        anonymize.raw.command = command;
        successful(command);
        const members = await filesBelow(exported);
        const exportedText = (await Promise.all(members.map(path => readFile(path, "utf8")))).join("\n");
        const leaks = canaries.slice(0, 3).map((canary, index) => ({ seed: index + 1, occurrences: exportedText.split(canary).length - 1 }));
        const sourceRecords = (await loadSessionFile(parent.file)).entries;
        const exportRecords = (await loadSessionFile(join(exported, "session.jsonl"))).entries;
        const metadata = (records: typeof sourceRecords) => records.map(entry => ({ id: entry.id, type: entry.type, ...(entry.type === "message" ? { role: entry.message.role } : {}) }));
        const sourceChildRecords = (await loadSessionFile(child.file)).entries;
        const exportedChild = members.find(path => path.endsWith(".jsonl") && path !== join(exported, "session.jsonl"));
        const exportedChildRecords = exportedChild ? (await loadSessionFile(exportedChild)).entries : [];
        const refusals = [];
        const nonempty = join(temporary, "nonempty-export");
        await mkdir(nonempty);
        await writeFile(join(nonempty, "retain.txt"), "retain\n");
        for (const destination of [dirname(parent.file), parent.artifacts, nonempty]) refusals.push(await run([omp, "anonymize", parent.file, "--out", destination], cwd));
        const after = Object.fromEntries(await Promise.all(originals.map(async path => [path, await hashFile(path)])));
        Object.assign(anonymize.raw, { syntheticFixture: true, exportedMembers: members.map(path => path.slice(exported.length + 1)), seededLeaks: leaks, sourceMetadata: metadata(sourceRecords), exportMetadata: metadata(exportRecords), sourceChildMetadata: metadata(sourceChildRecords), exportChildMetadata: metadata(exportedChildRecords), sourceHashesBefore: before, sourceHashesAfter: after, refusals });
        anonymize.checks = {
          parentAndChildExported: members.filter(path => path.endsWith(".jsonl")).length === 2,
          noSeededLeaks: leaks.every(result => result.occurrences === 0),
          eventIdsTypesAndRolesRetained: JSON.stringify(metadata(sourceRecords)) === JSON.stringify(metadata(exportRecords)),
          childEventIdsTypesAndRolesRetained: JSON.stringify(metadata(sourceChildRecords)) === JSON.stringify(metadata(exportedChildRecords)),
          malformedRecordReported: /Skipped 1 malformed record/.test(command.stdout),
          unreadableChildReported: /Not exported \(no readable session header\)/.test(command.stdout),
          rawDirectoryRefused: refusals[0]!.code === 2 && /mix.*raw session transcripts/.test(refusals[0]!.stderr),
          childDirectoryRefused: refusals[1]!.code === 2 && /mix.*raw session transcripts/.test(refusals[1]!.stderr),
          nonemptyDirectoryRefused: refusals[2]!.code === 2 && /not empty/.test(refusals[2]!.stderr),
          sourceBytesUnchanged: JSON.stringify(before) === JSON.stringify(after),
          sourceMemberSetUnchanged: JSON.stringify(originals) === JSON.stringify(await filesBelow(dirname(parent.file))),
          refusalContentsUnchanged: await readFile(join(nonempty, "retain.txt"), "utf8") === "retain\n",
        };
      } catch (error) { fail(anonymize, error); }
    }

    async function observeTransferAndFork() {
      try {
        const source = await seed(join(temporary, "transfer-source"), canaries[0]!);
        await mkdir(source.artifacts, { recursive: true });
        await writeFile(join(source.artifacts, "payload.txt"), canaries[3]!);
        const before = { transcript: await hashFile(source.file), artifact: await hashFile(join(source.artifacts, "payload.txt")) };
        const manager = await SessionManager.open(source.file, dirname(source.file));
        try {
          const result = await manager.fork();
          assert(result, "Native persisted fork must return old and new paths");
          await manager.flush();
          fork.raw = { oldFile: result.oldSessionFile, newFile: result.newSessionFile, oldId: source.id, newId: manager.getSessionId(), oldCwd: source.cwd, newCwd: manager.getCwd(), parentSession: manager.getHeader()?.parentSession, sourceSha256Before: before.transcript, sourceSha256After: await hashFile(source.file) };
          fork.checks = { newIdentity: manager.getSessionId() !== source.id, newFile: result.oldSessionFile !== result.newSessionFile, cwdUnchanged: manager.getCwd() === source.cwd, parentIdentityRecorded: manager.getHeader()?.parentSession === source.id, originalBytesUnchanged: await hashFile(source.file) === before.transcript };
        } finally { await manager.close(); }
        assert(checks.hostVersion, `The resolved omp must report ${expectedVersion}`);
        const archive = join(temporary, "transfer.tar");
        const packed = await run([omp, "session", "pack", source.file, archive], cwd);
        transfer.raw.pack = packed;
        successful(packed);
        const archiveMembers = await readArchiveEntries({ path: archive, format: "tar" }, { limits: { maxInMemorySize: 8_388_608, maxMemberSize: 4_194_304 } });
        const manifest = object(JSON.parse(new TextDecoder().decode(archiveMembers.get("manifest.json"))));
        const receiver = await isolatedEnvironment(join(temporary, "receiver-home"), temporary);
        const destination = join(temporary, "receiver-checkout");
        await mkdir(destination);
        const unpacked = await run([omp, "session", "unpack", archive, "--cwd", destination], destination, receiver);
        transfer.raw.unpack = unpacked;
        successful(unpacked);
        const receivedFile = unpacked.stdout.trim();
        assert(receivedFile.startsWith(`${receiver.PI_CODING_AGENT_DIR}/`), "Unpacked transcript must stay in the receiver profile");
        const received = (await loadSessionFile(receivedFile)).entries;
        const receivedHeader = received.find(entry => entry.type === "session");
        assert(receivedHeader?.type === "session", "Unpacked session must have a native header");
        const receivedArtifact = join(receivedFile.slice(0, -6), "payload.txt");
        const receivedArtifactHash = await hashFile(receivedArtifact);
        const arrived = received.map(sessionTransferDetails).find(details => details?.kind === "arrived");
        const diverged = await SessionManager.open(receivedFile, dirname(receivedFile));
        try { diverged.appendCustomEntry("native-proof-divergence", { synthetic: true }); await diverged.flush(); }
        finally { await diverged.close(); }
        const divergentHash = await hashFile(receivedFile);
        const reimport = await run([omp, "session", "unpack", archive, "--cwd", destination], destination, receiver);
        transfer.raw.divergentUnpack = reimport;
        successful(reimport);
        const reimportFile = reimport.stdout.trim();
        assert(reimportFile.startsWith(`${receiver.PI_CODING_AGENT_DIR}/`), "Forked import must stay in the receiver profile");
        const reimportHeader = (await loadSessionFile(reimportFile)).entries.find(entry => entry.type === "session");
        assert(reimportHeader?.type === "session", "Divergent import must have a native header");
        const movedFile = join(temporary, "moved-copy.jsonl");
        await copyFile(source.file, movedFile);
        const moved = await run([omp, "session", "moved", movedFile, "--to", "fixture-recipient"], cwd);
        transfer.raw.moved = moved;
        successful(moved);
        const movedRecords = (await loadSessionFile(movedFile)).entries;
        const movedHeader = movedRecords.find(entry => entry.type === "session");
        const departed = movedRecords.map(sessionTransferDetails).find(details => details?.kind === "departed");
        const originalRecords = (await loadSessionFile(source.file)).entries.filter(entry => entry.type !== "session");
        const receivedOriginalRecords = received.filter(entry => entry.type !== "session" && originalRecords.some(original => original.id === entry.id));
        const movedOriginalRecords = movedRecords.filter(entry => entry.type !== "session" && originalRecords.some(original => original.id === entry.id));
        const after = { transcript: await hashFile(source.file), artifact: await hashFile(join(source.artifacts, "payload.txt")) };
        Object.assign(transfer.raw, { syntheticFixture: true, manifest, archiveMembers: [...archiveMembers.keys()].sort(), archiveSha256: await hashFile(archive), before, after,
          sourceId: source.id, sourceCwd: source.cwd, receivedId: receivedHeader.id, receivedCwd: receivedHeader.cwd, receivedArtifactSha256: receivedArtifactHash, arrived,
          divergentId: reimportHeader.id, divergentParent: reimportHeader.parentSession, divergentOriginalSha256Before: divergentHash, divergentOriginalSha256After: await hashFile(receivedFile), departed,
          originalEntryIds: originalRecords.map(entry => entry.id), receivedOriginalEntryIds: receivedOriginalRecords.map(entry => entry.id) });
        Object.assign(transfer.raw, { movedId: movedHeader?.id, movedCwd: movedHeader?.type === "session" ? movedHeader.cwd : null });
        transfer.checks = {
          packedIdCwdAndHost: manifest.id === source.id && manifest.cwd === source.cwd && manifest.omp === expectedVersion,
          packedOriginalBytes: sha256(archiveMembers.get("session.jsonl") ?? new Uint8Array()) === before.transcript,
          packedArtifactHash: sha256(archiveMembers.get("artifacts/payload.txt") ?? new Uint8Array()) === before.artifact,
          onlySessionAndArtifactMembers: [...archiveMembers.keys()].sort().join("\n") === ["artifacts/payload.txt", "manifest.json", "session.jsonl"].join("\n"),
          unpackedIdentityRetained: receivedHeader.id === source.id,
          unpackedCwdRewritten: receivedHeader.cwd === destination,
          unpackedOriginalEntriesRetained: JSON.stringify(originalRecords) === JSON.stringify(receivedOriginalRecords),
          unpackedArtifactRetained: receivedArtifactHash === before.artifact,
          arrivalRecorded: arrived?.kind === "arrived" && arrived.cwd === destination && arrived.fromCwd === source.cwd,
          divergenceForks: reimportHeader.id !== source.id && reimportHeader.parentSession === source.id && reimportFile !== receivedFile,
          divergentCopyUnchanged: await hashFile(receivedFile) === divergentHash,
          divergentArtifactRetained: await hashFile(join(reimportFile.slice(0, -6), "payload.txt")) === before.artifact,
          movedMarkerRecorded: departed?.kind === "departed" && departed.to === "fixture-recipient",
          movedIdentityAndCwdRetained: movedHeader?.type === "session" && movedHeader.id === source.id && movedHeader.cwd === source.cwd,
          movedOriginalEntriesRetained: JSON.stringify(originalRecords) === JSON.stringify(movedOriginalRecords),
          movedChangesOnlyTheCopy: await hashFile(movedFile) !== before.transcript && JSON.stringify(before) === JSON.stringify(after),
        };
      } catch (error) { fail(transfer, error); if (Object.keys(fork.checks).length === 0) fail(fork, error); }
    }

    await observeWorktree();
    await observeAnonymize();
    await observeTransferAndFork();

    const authStorage = await AuthStorage.create(":memory:");
    closeAuth = () => authStorage.close();
    const modelRegistry = new ModelRegistry(authStorage, join(profile, "models.yml"), { ignoreLocalModelConfig: true, fetch: denyFetch });
    const model = modelRegistry.getAll().find(candidate => candidate.provider === "anthropic" && candidate.id === "claude-sonnet-4-5");
    assert(model, "Bundled catalog metadata for the auth-free session must be present");
    const modelIdentity = `${model.provider}/${model.id}`;
    const settingsBase = {
      "memory.backend": "off", "autolearn.enabled": false, "compaction.enabled": false,
      "async.enabled": true, "task.batch": true, "task.isolation.apply": false,
      "bash.autoBackground.enabled": false, "bash.direnv": "off", "bashInterceptor.enabled": false,
      "startup.checkUpdate": false, "startup.setupWizard": false,
    };
    for (const enabled of [false, true]) {
      const settings = Settings.isolated({ ...settingsBase, "task.isolation.enabled": enabled, "bash.gitGuard": enabled });
      const { session } = await createAgentSession({
        cwd, agentDir: profile, authStorage, modelRegistry, model, settings,
        sessionManager: SessionManager.create(cwd, join(temporary, enabled ? "guarded-session" : "unguarded-session")),
        agentRegistry: new AgentRegistry(), extensions: [], disableExtensionDiscovery: true,
        preloadedCustomToolPaths: [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
        toolNames: ["task", "bash"], enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
        cacheWarming: false, autoTitle: false, hasUI: false,
        getApiKey: async () => { credentialRequests++; throw new Error("Model credential resolution is forbidden in this producer"); },
        onFirstChatDispatch: () => { attemptedModelDispatches++; throw new Error("Model dispatch is forbidden in this producer"); },
      });
      sessions.push(session);
      await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
    }
    const primary = sessions[0]!, guarded = sessions[1]!;
    async function observeTaskSchemas() {
      try {
        const rows: TaskSchemaObservation[] = [];
        schema.raw.rows = rows;
        for (const [index, session] of sessions.entries()) {
          for (const plan of [false, true]) {
            session.setPlanModeState(plan ? { enabled: true, planFilePath: join(temporary, "fixture-plan.md") } : undefined);
            const task = session.getToolByName("task");
            assert(task && session.hasBuiltInTool("task"), "Native TaskTool must be registered");
            const parameters = task.parameters;
            assert("toJsonSchema" in parameters && typeof parameters.toJsonSchema === "function", "Native TaskTool schema must expose toJsonSchema");
            const wire: unknown = parameters.toJsonSchema();
            const item = object(object(object(object(wire).properties).tasks).items);
            const properties = object(item.properties);
            const required = item.required;
            rows.push({ isolationEnabled: index === 1, planMode: plan, isolatedPresent: Object.hasOwn(properties, "isolated"),
              outputSchemaPresent: Object.hasOwn(properties, "outputSchema"), schemaModePresent: Object.hasOwn(properties, "schemaMode"),
              modelOverridePresent: Object.hasOwn(properties, "model"), solutionSpaceRequired: Array.isArray(required) && required.includes("solutionSpace"), schema: wire });
          }
          session.setPlanModeState(undefined);
        }
        schema.raw = { rows, actualModelMetadata: modelIdentity, observedModelDispatches: attemptedModelDispatches };
        schema.checks = { fourSessionBoundGates: rows.length === 4, isolatedOnlyEnabledNormal: rows.every(row => row.isolatedPresent === (row.isolationEnabled && !row.planMode)), solutionSpaceRequired: rows.every(row => row.solutionSpaceRequired), noPerCallModelOverride: rows.every(row => !row.modelOverridePresent) };
        plainSchema.raw = { rows: rows.map(({ schema: wire, ...row }) => ({ ...row, schemaSha256: sha256(JSON.stringify(wire)) })), taskStructuredExplicitlyOverridden: false };
        plainSchema.checks = { fourNativeSchemas: rows.length === 4, noStructuredFieldsByDefault: rows.every(row => !row.outputSchemaPresent && !row.schemaModePresent) };
      } catch (error) { fail(schema, error); fail(plainSchema, error); }
      finally { for (const session of sessions) session.setPlanModeState(undefined); }
    }

    async function observeGitGuard() {
      try {
        const samples: GuardObservation[] = [];
        guard.raw.samples = samples;
        for (const [enabled, session] of [[false, primary], [true, guarded]] as const) {
          const bash = session.getToolByName("bash");
          assert(bash && session.hasBuiltInTool("bash"), "Native BashTool must be registered");
          for (const command of ["git stash push -m native-proof", "git reset --hard HEAD", "git restore tracked.txt", "f() { git reset --hard HEAD; }; f", "result=$(git reset --hard HEAD)", "cd ..; cd repository; git reset --hard HEAD"]) {
            await writeFile(join(cwd, "tracked.txt"), "guarded dirty bytes\n");
            const before = await hashFile(join(cwd, "tracked.txt"));
            const result: AgentToolResult<unknown> = await bash.execute(`guard-${samples.length}`, { command, cwd, timeout: 5 });
            const after = await hashFile(join(cwd, "tracked.txt"));
            const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            const details = object(result.details);
            const rejected = result.isError === true || (typeof details.exitCode === "number" && details.exitCode !== 0);
            samples.push({ enabled, command, result, before, after, rejected, nativeGuardDiagnostic: /blocked|not in one/i.test(text) });
          }
        }
        await writeFile(join(cwd, "tracked.txt"), "staged dirty bytes\n");
        successful(await run(["git", "add", "tracked.txt"], cwd));
        const beforeUnstage = await hashFile(join(cwd, "tracked.txt"));
        const unstage = await guarded.getToolByName("bash")!.execute("safe-unstage", { command: "git restore --staged tracked.txt", cwd, timeout: 5 });
        const cached = await run(["git", "diff", "--cached", "--name-only"], cwd);
        successful(cached);
        guard.raw = { samples, unstage, cached, beforeUnstage, afterUnstage: await hashFile(join(cwd, "tracked.txt")) };
        guard.checks = { onOffPairsExercised: samples.length === 12, guardOnRefusesAndPreserves: samples.filter(sample => sample.enabled).every(sample => sample.rejected && sample.nativeGuardDiagnostic && sample.before === sample.after), guardOffExecutesAndChanges: samples.filter(sample => !sample.enabled).every(sample => !sample.rejected && sample.before !== sample.after), safeUnstageAllowed: unstage.isError !== true && cached.stdout.trim() === "" && await hashFile(join(cwd, "tracked.txt")) === beforeUnstage };
      } catch (error) { fail(guard, error); }
    }

    async function observeJobs() {
      let jobId: string | undefined;
      try {
        const bash = primary.getToolByName("bash");
        assert(bash, "Native BashTool must be registered");
        const ready = join(temporary, "job-ready");
        const finished = join(temporary, "job-finished");
        const command = `${quote(process.execPath)} -e ${quote(`await Bun.write(${JSON.stringify(ready)}, String(process.pid)); console.log("NATIVE_JOB_READY"); await Bun.sleep(15000); await Bun.write(${JSON.stringify(finished)}, "unexpected completion");`)}`;
        const started = performance.now();
        const result = await bash.execute("native-job", { command, cwd, timeout: 20, async: true });
        jobs.raw.start = result;
        const nativeJobId = object(object(result.details).async).jobId;
        assert(typeof nativeJobId === "string", "Native async result must contain a job id");
        jobId = nativeJobId;
        const readyDeadline = performance.now() + 5_000;
        while (!(await Bun.file(ready).exists()) && performance.now() < readyDeadline) await Bun.sleep(25);
        assert(await Bun.file(ready).exists(), "Native job must reach its readiness marker before cancellation");
        const pid = Number(await readFile(ready, "utf8"));
        assert(Number.isSafeInteger(pid) && pid > 1, "Fixture process must report a valid pid");
        const readyMs = performance.now() - started;
        const snapshot = primary.getAsyncJobSnapshot();
        const inspection = primary.inspectAsyncJob(jobId);
        const foreignInspection = guarded.inspectAsyncJob(jobId);
        const foreignCancellation = guarded.cancelAsyncJob(jobId);
        const cancelStarted = performance.now();
        const accepted = primary.cancelAsyncJob(jobId);
        const alive = () => {
          try { process.kill(pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
        };
        const settlementDeadline = performance.now() + 5_000;
        while (performance.now() < settlementDeadline) {
          const current = primary.getAsyncJobSnapshot()?.recent.find(job => job.id === jobId);
          if (!alive() && current?.endTime !== undefined) break;
          await Bun.sleep(25);
        }
        const settled = primary.getAsyncJobSnapshot();
        const terminal = settled?.recent.find(job => job.id === jobId);
        const pidAliveAfter = alive();
        const completionMarkerPresent = await Bun.file(finished).exists();
        jobs.raw = { ...jobs.raw, command, jobId, pid, readyMs, cancelToSettlementMs: performance.now() - cancelStarted, snapshot, inspection, foreignInspection: foreignInspection ?? null, foreignCancellation, accepted, settled, terminal: terminal ?? null, finalInspection: primary.inspectAsyncJob(jobId), pidAliveAfter, completionMarkerPresent };
        jobs.checks = { runningMetadata: snapshot?.running.some(job => job.id === jobId && job.type === "bash" && job.status === "running") === true, inspectCommandAndCwd: inspection?.command === command && inspection.cwd === cwd, foreignRootCannotInspectOrCancel: foreignInspection === undefined && !foreignCancellation, cancellationAccepted: accepted, cancellationSettled: terminal?.status === "cancelled" && terminal.endTime !== undefined, processExited: !pidAliveAfter, completionMarkerAbsent: !completionMarkerPresent };
      } catch (error) { fail(jobs, error); }
      finally { if (jobId) primary.cancelAsyncJob(jobId); }
    }

    async function observeAnnotations() {
      try {
        assert(primary.extensionRunner, "Real SDK extension runner must exist");
        const ctx = primary.extensionRunner.createCommandContext();
        const beforeEntries = primary.sessionManager.getEntries().length;
        const textSource = { kind: "text" as const, text: "first\nsecond\n", label: "fixture.txt" };
        const diffSource = { kind: "diff" as const, diff: "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n", label: "fixture patch" };
        const text = await ctx.annotations.submit({ source: textSource, notes: [{ line: 2, quote: "second", note: "Keep this line." }], deliver: "none" });
        const diff = await ctx.annotations.submit({ source: diffSource, notes: [{ path: "fixture.txt", line: 1, side: "new", rawLine: "+after", note: "Review this addition." }], deliver: "none" });
        let textMismatch: string | null = null, diffMismatch: string | null = null;
        try { await ctx.annotations.submit({ source: textSource, notes: [{ line: 2, quote: "wrong", note: "Mismatch." }], deliver: "none" }); }
        catch (error) { textMismatch = error instanceof Error ? error.message : String(error); }
        try { await ctx.annotations.submit({ source: diffSource, notes: [{ path: "fixture.txt", line: 1, rawLine: "+wrong", note: "Mismatch." }], deliver: "none" }); }
        catch (error) { diffMismatch = error instanceof Error ? error.message : String(error); }
        notes.raw = { mode: ctx.mode, hasUI: ctx.hasUI, text, diff, textMismatch, diffMismatch, beforeEntries, afterEntries: primary.sessionManager.getEntries().length };
        notes.checks = { headlessContext: !ctx.hasUI, textNormalized: text.kind === "text" && text.delivered === "none" && text.annotations.length === 1 && text.annotations[0]?.scope === "line" && text.annotations[0].quote === "second" && text.text?.includes("Keep this line.") === true, diffNormalized: diff.kind === "diff" && diff.delivered === "none" && diff.annotations.length === 1 && diff.annotations[0]?.scope === "line" && diff.annotations[0].rawLine === "+after" && diff.text?.includes("Review this addition.") === true, textMismatchRejected: textMismatch?.includes("no longer matches its quote") === true, diffMismatchRejected: diffMismatch?.includes("no longer matches its rawLine") === true, noTranscriptDelivery: primary.sessionManager.getEntries().length === beforeEntries };
      } catch (error) { fail(notes, error); }
    }

    await observeTaskSchemas();
    await observeGitGuard();
    await observeJobs();
    await observeAnnotations();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    for (const sample of measured) if (Object.keys(sample.checks).length === 0 && sample.errors.length === 0) fail(sample, error);
  } finally {
    for (const session of [...sessions].reverse()) {
      try { await session.dispose(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    try { closeAuth?.(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    globalThis.fetch = savedFetch;
  }
  checks.noModelDispatch = attemptedModelDispatches === 0 && credentialRequests === 0;
  checks.noHttpFetchAttempt = blockedFetches === 0;
  checks.sdkResourcesDisposed = cleanupErrors.length === 0;
  const rows = proposals.map(proposal => {
    const subcapabilities = proposal.subcapabilities.map(part => part.evidence === "unexercised" ? { ...part, status: "deferred" as const } : {
      ...part,
      status: part.errors.length > 0 || Object.keys(part.checks).length === 0 || Object.values(part.checks).some(ok => !ok) ? "failed" as const : part.unavailable ? "unavailable" as const : "passed" as const,
    });
    const status = subcapabilities.some(part => part.status === "failed") ? "failed" : subcapabilities.some(part => part.status === "deferred" || part.status === "unavailable") ? "deferred" : "passed";
    return { id: proposal.id, name: proposal.name, status, subcapabilities };
  });
  const inputs = Object.fromEntries(Object.entries(producerInputs).sort(([left], [right]) => left.localeCompare(right)));
  const proof = {
    version: 1, capturedAt: new Date().toISOString(), fixtureOnly: true, expectedVersion,
    host, sdkPackages: packages, runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    producerInputs: inputs, producerDigest: sha256(Object.entries(inputs).map(([path, hash]) => `${path}\0${hash}\n`).join("")),
    privacy: { realHistoriesRead: false, authImportedOrExported: false, isolatedChildHome: true },
    requestGuards: { attemptedModelDispatches, credentialRequests, blockedFetches, blockedPreconnects },
    checks, errors, cleanupErrors, proposals: rows,
    limits: ["These source hashes cover the listed producer and SDK inputs, not a complete transitive-source release gate.", "The content gate recomputes the listed input hashes and checks the exact SDK pin. producerDigest, SDK package metadata and host binary details are captured observations, not separately authenticated fields.", "No external model, automatic worktree startup, terminal fork UI, browser target, or annotation-overlay request is made.", "SDK session creation emits best-effort preconnect hints even with cache warming off. The producer blocks and counts those hints separately from HTTP fetches.", "The HTTP guard and empty credential store are not an OS-level network sandbox.", "Raw fixture contents are excluded. Known private canaries are replaced in unexpected error output before publication.", "The supervising process bounds the run at 240 seconds, kills its process group, and removes both private profiles and all fixture files."],
    ok: errors.length === 0 && cleanupErrors.length === 0 && Object.values(checks).every(Boolean) && rows.every(row => row.status !== "failed"),
  };
  let serialized = JSON.stringify(proof, null, 2);
  for (const canary of canaries) serialized = serialized.replaceAll(canary, "[private fixture content removed]");
  assert(canaries.every(canary => !serialized.includes(canary)), "Published proof must exclude source canaries");
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${serialized}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: proof.ok, artifact: outputFile, proposals: rows.map(({ id, status }) => ({ id, status })) }));
  process.exitCode = proof.ok ? 0 : 1;
}
