#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { BennyError, checkBenny, loadBennyConfig, runBenny, setBennyEnabled, setupBenny, startBennySocket, targetRootFor, type BennyOutcome } from "./benny.ts";
import { sweepExpiredEvidence } from "./benny-workspace.ts";
import { PstackError, runRoutine, validateEvent } from "./runner.ts";
import { createRoutine, listRoutines, serve, setRoutineEnabled, stopServeStack } from "./service.ts";
/**
 * Packaged-helper subcommands. The CLI lives inside the installed package, so
 * it always resolves its own helpers via import.meta.dir — no plugin-scope
 * guesswork, no hard-coded project paths. Dispatched before commander so
 * helper flags pass through untouched.
 */
const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const HELPERS: Record<string, { argv: string[]; exec?: string }> = {
	orch: { argv: ["skills/poteto-mode/scripts/orch/orch.ts"] },
	"watch-pr": { argv: ["skills/poteto-mode/scripts/watch-pr/watch-pr"] },
	"check-plan": { argv: ["skills/poteto-mode/scripts/check-plan.mjs"] },
	"worktree-audit": { argv: ["skills/poteto-mode/scripts/worktree-audit.ts"] },
	log: { argv: ["skills/show-me-your-work/scripts/log.sh"], exec: "bash" },
};
const helperName = process.argv[2];
if (import.meta.main && helperName !== undefined && helperName in HELPERS) {
	const helper = HELPERS[helperName]!;
	const rest = process.argv.slice(3);
	const argv = helper.exec === undefined
		? [process.execPath, resolve(PACKAGE_ROOT, ...helper.argv), ...rest]
		: [helper.exec, resolve(PACKAGE_ROOT, ...helper.argv), ...rest];
	const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	process.exit(await child.exited);
}

const program = new Command("pstack").description("OMP-native P Stack").option("--cwd <path>", "project directory", process.cwd());
program.exitOverride().configureOutput({ writeErr: () => {} });
const cwd = () => resolve(program.opts<{ cwd: string }>().cwd);
const emit = (result: unknown) => console.log(JSON.stringify(result));

/** Operator-supplied event input is bounded before materialization: regular files are rejected from stat size, stdin is streamed and abandoned at cap+1. */
export const MAX_EVENT_BYTES = 1 * 1024 * 1024;

/** Reads a byte stream up to maxBytes; the first chunk crossing the cap cancels the stream and throws, so the tail is never materialized. UTF-8 decoding happens after the byte bound. */
async function readBoundedStream(stream: ReadableStream<Uint8Array>, label: string, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maxBytes}-byte event bound`);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readEvent(path: string): Promise<unknown> {
  try {
    let bytes: Uint8Array;
    if (path === "-") {
      bytes = await readBoundedStream(Bun.stdin.stream(), "stdin event", MAX_EVENT_BYTES);
    } else {
      const target = resolve(cwd(), path);
      // A regular file advertises its size: reject an over-cap event from stat before reading any byte.
      const info = await stat(target);
      if (info.isFile() && info.size > MAX_EVENT_BYTES) {
        throw new Error(`event file is ${info.size} bytes; exceeds the ${MAX_EVENT_BYTES}-byte event bound`);
      }
      bytes = await readBoundedStream(Bun.file(target).stream(), "event file", MAX_EVENT_BYTES);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  catch (error) { throw new PstackError(64, `Cannot read JSON event: ${error instanceof Error ? error.message : String(error)}`); }
}
export function bennyExit(outcome: BennyOutcome, requireTerminal = false): 0 | 1 | 2 {
  if (outcome.results.some((result) => result.status === "blocked")) return 2;
  if (outcome.results.some((result) => result.status === "failed" || result.status === "interrupted")) return 1;
  // Every ordinary nonterminal result (queued or running, including
  // shutdown-requeued rows released for recovery) is never a successful
  // exit: the caller must know the operation did not settle. A canary keeps
  // its stricter blocked-prerequisite exit 2.
  if (outcome.results.some((result) => result.status === "queued" || result.status === "running")) return requireTerminal ? 2 : 1;
  // A canary succeeds only when admitted, freshly executed, and recordCanary
  // persisted a receipt-complete pass; anything else is a failed operation.
  if (requireTerminal && outcome.canary?.passed !== true) return 1;
  return 0;
}

async function runBennyWithSignals(config: string, event: unknown, options: { phase?: "triage" | "reproduce" | "both"; canary?: boolean }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { return await runBenny(config, event, { ...options, signal: controller.signal }); }
  finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

program.command("run").requiredOption("--routine <slug>").requiredOption("--event <path>", "JSON event file or - for stdin")
  .action(async (options: { routine: string; event: string }) => {
    const event = await readEvent(options.event);
    validateEvent(event);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await runRoutine(cwd(), options.routine, event, controller.signal);
      process.exitCode = result.status === "blocked" ? 2 : ["succeeded", "queued", "running"].includes(result.status) ? 0 : 1;
      emit({ ok: process.exitCode === 0, ...result });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });

const routine = program.command("routine").description("Manage trusted routine definitions");
routine.command("create").requiredOption("--name <slug>").requiredOption("--prompt <file>").requiredOption("--model <selector>")
  .option("--tool <name...>", "explicit routine tool allowlist", [])
  .action((options: { name: string; prompt: string; model: string; tool: string[] }) =>
    emit({ ok: true, ...createRoutine(cwd(), options.name, resolve(cwd(), options.prompt), options.model, { tools: options.tool }) }));
routine.command("list").action(() => emit({ ok: true, routines: listRoutines(cwd()) }));
for (const action of ["enable", "disable"] as const) {
  routine.command(`${action} <slug>`).action((slug: string) => emit({ ok: true, routine: setRoutineEnabled(cwd(), slug, action === "enable") }));
}

const benny = program.command("benny").description("Run the installed Benny automation pack");
benny.command("setup").requiredOption("--target <repo>")
  .action(async (options: { target: string }) => {
    const result = await setupBenny(resolve(cwd(), options.target));
    // A printed ok:false must never exit 0: pack conflicts block on a
    // reviewed resolution (2), any other failed verification is a failed
    // operation (1).
    process.exitCode = result.ok ? 0 : result.conflicts.length > 0 ? 2 : 1;
    emit(result);
  });
benny.command("check").requiredOption("--config <path>")
  .action(async (options: { config: string }) => {
    const checks = await checkBenny(resolve(cwd(), options.config));
    process.exitCode = checks.every((check) => check.ok) ? 0 : 2;
    emit({ ok: process.exitCode === 0, checks });
  });
benny.command("run").requiredOption("--config <path>").requiredOption("--event <path>").option("--phase <phase>", "triage, reproduce, or both", "both")
  .action(async (options: { config: string; event: string; phase: string }) => {
    if (!["triage", "reproduce", "both"].includes(options.phase)) throw new PstackError(64, "phase must be triage, reproduce, or both");
    const outcome = await runBennyWithSignals(resolve(cwd(), options.config), await readEvent(options.event), { phase: options.phase as "triage" | "reproduce" | "both" });
    process.exitCode = bennyExit(outcome);
    emit({ ok: process.exitCode === 0, ...outcome });
  });
for (const action of ["enable", "disable"] as const) {
  benny.command(action).requiredOption("--config <path>")
    .action(async (options: { config: string }) => emit({ ok: true, state: await setBennyEnabled(resolve(cwd(), options.config), action === "enable") }));
}
benny.command("sweep").requiredOption("--config <path>")
  .action(async (options: { config: string }) => {
    // One-shot retention sweep for external durable schedulers (cron,
    // systemd timer): identical shared sweep to the socket host's periodic
    // pass — configured retention, active-run evidence retained, and a
    // fail-closed read of the run store. Stable JSON on stdout.
    const configPath = resolve(cwd(), options.config);
    const config = await loadBennyConfig(configPath);
    const sweep = await sweepExpiredEvidence(targetRootFor(configPath), config.control.artifact_retention_hours);
    process.exitCode = sweep.storeUnreadable ? 1 : 0;
    emit({ ok: !sweep.storeUnreadable, removed: sweep.removed, retained: sweep.retained, storeUnreadable: sweep.storeUnreadable });
  });
benny.command("canary").requiredOption("--config <path>").requiredOption("--event <path>")
  .action(async (options: { config: string; event: string }) => {
    const outcome = await runBennyWithSignals(resolve(cwd(), options.config), await readEvent(options.event), { canary: true });
    process.exitCode = bennyExit(outcome, true);
    emit({ ok: process.exitCode === 0, ...outcome });
  });
program.command("serve").option("--host <address>", "listener address", "127.0.0.1").option("--port <number>", "listener port", "8787").option("--benny-config <path>", "also run Benny Socket Mode admission with this configuration")
  .action(async (options: { host: string; port: string; bennyConfig?: string }) => {
    const port = Number(options.port);
    if (!/^\d+$/.test(options.port) || !Number.isInteger(port) || port < 1 || port > 65535) throw new PstackError(64, "port must be between 1 and 65535");
    // Routine service first, then Benny socket; on socket startup failure the
    // service is stopped again before the error propagates.
    const handle = await serve(cwd(), options.host, port);
    let socket: { ready: Promise<void>; close(): Promise<void> } | undefined;
    try {
      socket = options.bennyConfig ? await startBennySocket(resolve(cwd(), options.bennyConfig)) : undefined;
      await socket?.ready;
      emit({ ok: true, event: "listening", host: handle.host, port: handle.port, benny: socket ? "socket-mode" : "off" });
      await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
    } finally {
      await stopServeStack(socket, handle);
    }
  });

if (import.meta.main) {
  try { await program.parseAsync(process.argv); }
  catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
    else {
      process.exitCode = error instanceof PstackError || error instanceof BennyError ? error.exitCode : error instanceof CommanderError ? 64 : 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      emit({ ok: false, error: message });
    }
  }
}
