import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "pstack-install-"));
const cwd = join(temporary, "project");
await mkdir(cwd);
const env = { ...process.env, NODE_PATH: "", HOME: join(temporary, "home"), PI_CODING_AGENT_DIR: join(temporary, "profile"), PI_PROFILE: "" };
function run(argv: string[]) {
  const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `${argv.slice(0, 4).join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
try {
  run(["git", "init", "-b", "main"]);
  const customDir = join(cwd, ".omp", "automations", "benny");
  await mkdir(customDir, { recursive: true });
  await Bun.write(join(customDir, "local-owner-note.txt"), "preserve me\n");
  const setup = JSON.parse(run([process.execPath, join(root, "src", "cli.ts"), "benny", "setup", "--target", cwd]));
  assert.equal(setup.ok, true, JSON.stringify(setup));
  assert.equal(await Bun.file(join(customDir, "local-owner-note.txt")).text(), "preserve me\n");
  const installedLink = join(cwd, ".omp", "plugins", "node_modules", "omp-pstack");
  assert(existsSync(installedLink), `project-scoped plugin install missing at ${installedLink}`);
  const readme = await Bun.file(join(root, "README.md")).text();
  const section = readme.split("### running the `pstack` CLI after install")[1];
  const block = section && /```bash\n([\s\S]*?)```/.exec(section);
  assert(block, "README install-resolver block not found");
  const resolverLine = block[1].split("\n").find((line) => line.startsWith("PSTACK_ROOT="));
  assert(resolverLine, "README resolver line not found");
  const installLine = block[1].split("\n").find((line) => line.startsWith("bun install --production --frozen-lockfile --cwd "));
  assert(installLine, "README installed dependency setup not found");
  const installedRoot = run(["bash", "-c", `${resolverLine}\nprintf '%s' "$PSTACK_ROOT"`]).trim();
  assert(installedRoot.length > 0, "documented resolver produced an empty PSTACK_ROOT");
  assert(installedRoot.startsWith(`${temporary}${sep}`), `documented resolver resolved ${installedRoot}, not the isolated installation`);
  await rm(join(installedRoot, "node_modules"), { recursive: true, force: true });
  assert(!existsSync(join(installedRoot, "node_modules")), "copied checkout dependencies remain in the installed root");
  run(["bash", "-c", `${resolverLine}\n${installLine}`]);
  assert(existsSync(join(installedRoot, "node_modules", "commander", "package.json")), "production CLI dependencies missing from installed root");
  const cli = join(installedRoot, "src", "cli.ts");
  assert.match(run([process.execPath, cli, "--help"]), /Usage: pstack/);
  const routineList = JSON.parse(run([process.execPath, cli, "routine", "list"]));
  assert.deepEqual(routineList, { ok: true, routines: [] });
  const logPath = join(temporary, "decisions.tsv");
  const header = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
  const original = Buffer.from(`${header}2000-01-01T00:00:00Z\tlegacy\tkept\twhy\tpath\topen\n`);
  await Bun.write(logPath, original);
  run([process.execPath, cli, "log", logPath, "=phase", "decision\tone\nline\rnext", "+why", "@evidence", "-result"]);
  run([process.execPath, cli, "log", logPath, "phase2", "decision2", "why2", "evidence2", "result2"]);
  const logged = Buffer.from(await Bun.file(logPath).arrayBuffer());
  assert.deepEqual(logged.subarray(0, original.length), original, "original decision log bytes changed");
  const rows = logged.toString().trimEnd().split("\n");
  assert.equal(rows.length, 4, "decision log must contain the existing row and two appended rows");
  assert.equal(rows.filter((row) => row === header.trimEnd()).length, 1, "decision log must contain exactly one header");
  assert.match(rows[2]!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\t'=phase\tdecision one line next\t'\+why\t'@evidence\t'-result$/);
  assert.match(rows[3]!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tphase2\tdecision2\twhy2\tevidence2\tresult2$/);
  const discovered = JSON.parse(run([process.execPath, "-e", `
    const sdk = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent", ${JSON.stringify(root)}));
    const task = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent/task", ${JSON.stringify(root)}));
    const {skills} = await sdk.discoverSkills(process.cwd());
    const {agents} = await task.discoverAgents(process.cwd());
    console.log(JSON.stringify({skills, agents}));
  `]));
  for (const name of ["principle-attack-the-premise", "principle-test-behavior-not-implementation"]) {
    const skill = discovered.skills.find((entry: { name: string }) => entry.name === name);
    assert(skill?.filePath.startsWith(temporary), `${name} missing from project installation`);
  }
  for (const skill of discovered.skills) {
    assert(skill.filePath.startsWith(temporary), `${skill.name} did not resolve from the isolated project installation`);
    assert(!skill.filePath.includes("automations/benny"));
  }
  for (const name of ["poteto-agent", "Comment Sicko"]) {
    const agent = discovered.agents.find((entry: { name: string }) => entry.name === name);
    assert(agent?.filePath.startsWith(temporary), `${name} missing from project installation`);
  }
  assert(discovered.skills.find((skill: { name: string; hide: boolean }) => skill.name === "poteto-mode")?.hide);
  assert(discovered.skills.find((skill: { name: string; hide: boolean }) => skill.name === "session-review")?.hide, "session-review must be discovered without model invocation");
  console.log(JSON.stringify({ ok: true, projectInstallation: true, bennyPackInstalled: true, destinationOnlyFilePreserved: true, cliDependenciesInstalled: true, sanitizedLogPreserved: true, skills: discovered.skills.length, upstreamAgents: 2, bennyDiscovered: false, modelInvocationDisabledPreserved: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
