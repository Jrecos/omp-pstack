import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { expandSlashCommand, loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

export const SPECKIT_CLI_VERSION = "1.0.12";
export const SPECKIT_PHASES = ["specify", "clarify", "plan", "tasks", "analyze", "checklist", "implement"] as const;
export type SpecKitPhase = typeof SPECKIT_PHASES[number];

export const OFFICIAL_ASSETS: Readonly<Record<string, string>> = {
  ".omp/commands/speckit.analyze.md": "91fe16257ededdea9cc21d3cb27d539fcdd12d93ddcea52332cd4b68176b6a8d",
  ".omp/commands/speckit.checklist.md": "fa58b19e2604ce56ff5f5427061f6ee94fd44d7194e740b874824d9bf21ee15b",
  ".omp/commands/speckit.clarify.md": "dd11eb5b9759f7d3cd18c9d7f23a0ae2fe7973fc6ca2486dbfaf53a5569224b1",
  ".omp/commands/speckit.constitution.md": "9a7e9296f0878cdf4ed011b0de74cfb3656938680b64e43e808553fdfd054efc",
  ".omp/commands/speckit.converge.md": "3cb55244c9dc5b9bf52ee3127ba177c52cabd5e5e5197e1312497b3eaeb8b9a4",
  ".omp/commands/speckit.implement.md": "e036ce63702db93e656e1c91ee6c02a8dc3d4a4f8624f8ba4adc69027fe68983",
  ".omp/commands/speckit.plan.md": "3be8b011db9c6bb1cc77037f7d90756a6dbcbda1995cda2192818385732b27ff",
  ".omp/commands/speckit.specify.md": "21634a45dfcf642fddb1645f4ad2980f98c89778442e47663df8a6c3a1eaf8bc",
  ".omp/commands/speckit.tasks.md": "6754ae39649c8e73a5ed376ad5cfcf04422e321a10e07c5ccd92fd1b9bccf776",
  ".omp/commands/speckit.taskstoissues.md": "3c7520a0294a435fa678520b695b11bd7575f0c15da89c418e50abd763677345",
  ".specify/scripts/bash/check-prerequisites.sh": "39419d0d7100adee3eea8d6d578caea3617633013803b6b3872731c3af8f98b1",
  ".specify/scripts/bash/common.sh": "adaec9a43ecaa52609eeb9661d5f9c36a41d3160aa2bd714be9973082d0dc2d2",
  ".specify/scripts/bash/create-new-feature.sh": "7f85da63527be6464b08e79578b35b33d0b259fa7653a61ae64da626a26207e2",
  ".specify/scripts/bash/resolve-template.sh": "829e227096abc8bf0889889ec9f792f503ca5d395b7836a8a7eb739ee75214e7",
  ".specify/scripts/bash/setup-plan.sh": "d0bd298c026446f3c63167130d65e49e4aa4485de6bef18bcdfd57b19aa0de96",
  ".specify/scripts/bash/setup-tasks.sh": "cf6e99575a24b64ac01ffa3a50a40971ba95e3c1ec269b9a6dc3e35bbbb09191",
  ".specify/templates/checklist-template.md": "3f4124a13ffbc0c2d8e979d9a08248f29ce53cc6c324a8303a6ae0d231b78836",
  ".specify/templates/constitution-template.md": "ce7549540fa45543cca797a150201d868e64495fdff39dc38246fb17bd4024b3",
  ".specify/templates/plan-template.md": "5ef0e4c97b36e9f91372dc6eb8e5a7e515af8958cf1a9286e43a1ebd9bd48540",
  ".specify/templates/spec-template.md": "3945437fc35cd30a5b2bf7beea680337c3516826d3efa5a6b92c4a7eca1ba28e",
  ".specify/templates/tasks-template.md": "c731575d8099b3f871861186fbd1a592b51b2ba57fb99e1a0dab439ff6d5608f",
};

export interface PhaseHandoff {
  readonly phase: SpecKitPhase;
  readonly body: string;
  readonly featureDirectory: string;
  readonly cliVersion: typeof SPECKIT_CLI_VERSION;
}

export interface PhaseRequest {
  readonly phase: SpecKitPhase;
  readonly argument: string;
  readonly featureDirectory: string;
}

function run(cwd: string, ...args: string[]): string {
  try {
    return execFileSync(args[0]!, args.slice(1), { cwd, env: process.env, encoding: "utf8", timeout: 20_000 });
  } catch (cause) {
    throw new Error(`Official Spec Kit gate failed running ${args[0]} ${args.slice(1).join(" ")}. Install specify-cli ${SPECKIT_CLI_VERSION} and initialize this worktree with specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force. ${cause instanceof Error ? cause.message : cause}`);
  }
}

function regularInside(root: string, name: string): string {
  if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error(`Spec Kit path escapes the checkout: ${name}`);
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw new Error(`Spec Kit path escapes the checkout: ${name}`);
  let cursor = root;
  for (const component of relative(root, path).split(sep)) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Spec Kit symlink is not trusted: ${cursor}`);
    if (cursor === path ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Spec Kit asset is not a regular file: ${cursor}`);
  }
  if (!realpathSync(path).startsWith(root + sep)) throw new Error(`Spec Kit path escapes the checkout: ${path}`);
  return path;
}

function verifyAssets(root: string): void {
  for (const [name, digest] of Object.entries(OFFICIAL_ASSETS)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(regularInside(root, name));
    } catch (cause) {
      throw new Error(`Missing or unsafe official Spec Kit asset ${name}. Run the official specify init in this worktree. ${cause}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error(`Official Spec Kit asset changed: ${name}. Restore the pinned ${SPECKIT_CLI_VERSION} CLI-generated bytes; repository manifests cannot authorize changes.`);
    }
  }
}

function checkStatus(root: string): void {
  const version = run(root, "specify", "--version").trim();
  if (version !== `specify ${SPECKIT_CLI_VERSION}`) throw new Error(`Expected specify ${SPECKIT_CLI_VERSION}, got ${version}. Install the pinned CLI.`);
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(run(root, "specify", "integration", "status", "--json"));
  } catch (cause) {
    throw new Error(`Cannot read official Spec Kit integration status JSON: ${cause}. Initialize this isolated worktree with specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force.`);
  }
  if (status.status !== "ok" || !Array.isArray(status.findings) || status.findings.length !== 0 ||
      status.default_integration !== "omp" || !Array.isArray(status.installed_integrations) || !status.installed_integrations.includes("omp") ||
      ["missing_managed_files", "modified_managed_files", "invalid_manifest_paths", "unchecked_manifests"].some((key) => status[key] !== 0)) {
    throw new Error(`Official Spec Kit integration is not clean for OMP: ${JSON.stringify(status)}. Repair it with specify init . --integration omp --non-interactive --ignore-agent-tools --script sh --force before using this lane.`);
  }
}

function checkCustomLayers(root: string): void {
  for (const name of [".specify/templates/overrides", ".specify/presets", ".specify/extensions"]) {
    if (lstatSync(join(root, name), { throwIfNoEntry: false })) {
      throw new Error(`Custom Spec Kit layer ${name} is not reviewed for the official-only lane.`);
    }
  }
}

function checkHooks(root: string): void {
  let text: string;
  try {
    text = readFileSync(regularInside(root, ".specify/extensions.yml"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Cannot safely read .specify/extensions.yml: ${cause}`);
  }
  let data: unknown;
  try { data = Bun.YAML.parse(text); } catch (cause) { throw new Error(`Invalid .specify/extensions.yml: ${cause}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid .specify/extensions.yml root.");
  const config = data as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!["installed", "settings", "hooks"].includes(key)) throw new Error(`Unknown .specify/extensions.yml key: ${key}`);
  }
  if (config.installed !== undefined) {
    if (!Array.isArray(config.installed)) throw new Error("Invalid .specify/extensions.yml installed list.");
    if (config.installed.length !== 0) throw new Error("Installed Spec Kit extensions are not reviewed for the official-only lane.");
  }
  if (config.settings !== undefined && (!config.settings || typeof config.settings !== "object" || Array.isArray(config.settings))) {
    throw new Error("Invalid .specify/extensions.yml settings.");
  }
  const hooks = config.hooks;
  if (hooks === undefined) return;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("Invalid .specify/extensions.yml hooks.");
  for (const [event, records] of Object.entries(hooks)) {
    if (!Array.isArray(records)) throw new Error(`Invalid .specify/extensions.yml hooks.${event}: expected a list.`);
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          ("enabled" in record && typeof record.enabled !== "boolean")) {
        throw new Error(`Invalid .specify/extensions.yml hooks.${event} record.`);
      }
      if (record.enabled !== false) throw new Error(`Active Spec Kit hook hooks.${event} is not reviewed for this lane.`);
    }
  }
}

function checkoutRoot(cwd: string): string {
  const root = realpathSync(cwd);
  const top = realpathSync(run(root, "git", "rev-parse", "--show-toplevel").trim());
  if (top !== root) throw new Error("Use the Spec Kit lane from the root of its isolated Git worktree.");
  const gitFile = lstatSync(join(root, ".git"));
  if (!gitFile.isFile()) throw new Error("Create a separate Git worktree before running official Spec Kit phases; the shared checkout is not isolated.");
  if (process.env.SPECIFY_INIT_DIR && realpathSync(resolve(root, process.env.SPECIFY_INIT_DIR)) !== root) {
    throw new Error("SPECIFY_INIT_DIR must name this isolated worktree.");
  }
  return root;
}

function featurePath(root: string, value: string, existing: boolean, reviewed: boolean): string {
  if (!value.trim() || (!reviewed && isAbsolute(value)) || value.split(/[\\/]/).includes("..")) throw new Error(`Feature directory must be relative and inside specs/: ${value}`);
  const path = resolve(root, value);
  const specs = resolve(root, "specs");
  if (path === specs || !path.startsWith(specs + sep) || relative(specs, path).includes(sep)) {
    throw new Error(`Feature directory must name one direct child of this worktree's specs/: ${value}`);
  }
  let cursor = root;
  for (const segment of relative(root, path).split(sep)) {
    cursor = join(cursor, segment);
    let stat;
    try { stat = lstatSync(cursor); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" && !existing) break;
      throw new Error(`Feature directory is missing or unsafe: ${cursor}: ${cause}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Feature directory has a symlink or non-directory component: ${cursor}`);
  }
  const inspect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Feature directory contains an unsafe symlink: ${child}`);
      if (entry.isDirectory()) inspect(child);
      else if (!entry.isFile()) throw new Error(`Feature directory contains an unsafe file type: ${child}`);
    }
  };
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) inspect(path);
  return path;
}

function featureBinding(root: string, request: PhaseRequest): string {
  const specs = join(root, "specs");
  try {
    const stat = lstatSync(specs);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("specs/ must be a real directory, not a symlink.");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const envValue = process.env.SPECIFY_FEATURE_DIRECTORY;
  let stored: string | undefined;
  try {
    const data = JSON.parse(readFileSync(regularInside(root, ".specify/feature.json"), "utf8"));
    if (!data || typeof data.feature_directory !== "string") throw new Error("missing feature_directory string");
    stored = data.feature_directory;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Unsafe or invalid .specify/feature.json: ${cause}`);
  }
  const existing = request.phase !== "specify";
  if (existing && (!stored || !request.featureDirectory)) throw new Error("Later Spec Kit phases require .specify/feature.json and the exact featureDirectory reviewed after specify.");
  if (request.phase === "specify" && stored) throw new Error("This worktree already has a feature binding. Use a fresh separate worktree for a new feature.");
  const paths = [
    ...(envValue === undefined ? [] : [featurePath(root, envValue, existing, true)]),
    ...(stored === undefined ? [] : [featurePath(root, stored, existing, true)]),
    featurePath(root, request.featureDirectory, existing, true),
  ];
  if (paths.some((path) => path !== paths[0])) throw new Error("Spec Kit feature directory disagrees across the env, persisted binding, and reviewed featureDirectory.");
  if (request.phase === "specify" && paths[0] && lstatSync(paths[0], { throwIfNoEntry: false })) {
    throw new Error("The requested feature directory already exists. Use a fresh directory for this worktree's new feature.");
  }
  return paths[0]!;
}

export async function readPhase(cwd: string, request: PhaseRequest): Promise<PhaseHandoff> {
  if (!SPECKIT_PHASES.includes(request.phase)) throw new Error(`Unknown Spec Kit phase: ${request.phase}`);
  if (typeof request.argument !== "string") throw new Error("Pass an explicit argument string, including an empty string for optional phase input.");
  if (request.phase === "specify" && !request.argument.trim()) throw new Error("The specify phase requires the original nonempty feature request.");
  if (/\bSPECIFY_FEATURE_DIRECTORY\b/i.test(request.argument)) {
    throw new Error("Put the feature directory in the validated featureDirectory field, not inside a phase argument.");
  }
  const root = checkoutRoot(cwd);
  checkStatus(root);
  verifyAssets(root);
  checkCustomLayers(root);
  checkHooks(root);
  const bound = featureBinding(root, request);
  const name = `speckit.${request.phase}`;
  const commands = await loadSlashCommands({ cwd: root });
  const selected = commands.filter((command) => command.name === name);
  if (selected.length !== 1 || selected[0]!.source !== "via OMP Project" || selected[0]!._source?.providerName !== "OMP" || selected[0]!._source?.level !== "project") {
    throw new Error(`Expected exactly one official /${name} via OMP Project. Refusing a foreign or missing command.`);
  }
  const official = readFileSync(regularInside(root, `.omp/commands/${name}.md`), "utf8");
  if (selected[0]!.content !== parseFrontmatter(official, { source: name, level: "warn" }).body) {
    throw new Error(`OMP selected a different /${name} body than the pinned project command.`);
  }
  const marker = "PSTACK_SPEC_KIT_ARGUMENT";
  const rendered = expandSlashCommand(`/${name} ${marker}`, [selected[0]!]);
  if (rendered.startsWith(`/${name}`) || rendered.startsWith("---") || rendered.includes("$ARGUMENTS") || !rendered.includes(marker)) {
    throw new Error(`Official /${name} was not rendered as an OMP project command.`);
  }
  const body = rendered.replaceAll(marker, () => request.argument);
  return { phase: request.phase, body, featureDirectory: bound, cliVersion: SPECKIT_CLI_VERSION };
}

export function registerSpecKit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_speckit",
    label: "Official Spec Kit phase",
    description: "Read-only, fail-closed official Spec Kit 1.0.12 phase handoff. Explicit opt-in only. Never invokes a phase, hook, or repo script. Provide a new featureDirectory before specify and the same reviewed directory on later calls.",
    approval: "read",
    parameters: pi.zod.object({
      phase: pi.zod.enum(SPECKIT_PHASES),
      argument: pi.zod.string(),
      featureDirectory: pi.zod.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const handoff = await readPhase(ctx.cwd, params as PhaseRequest);
      return { content: [{ type: "text", text: JSON.stringify(handoff) }], details: handoff };
    },
  });
}
