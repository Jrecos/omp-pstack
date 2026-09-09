import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "pstack-install-"));
const cwd = join(temporary, "project");
await mkdir(cwd);
const env = { ...process.env, HOME: join(temporary, "home"), PI_CODING_AGENT_DIR: join(temporary, "profile"), PI_PROFILE: "" };
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
  // Real installed-root CLI proof via the EXACT documented resolver: the
  // `PSTACK_ROOT=` line is extracted verbatim from the README's "running the
  // `pstack` CLI after install" block and executed against the isolated
  // install — never a direct realpath of the package link.
  const installedLink = join(cwd, ".omp", "plugins", "node_modules", "omp-pstack");
  assert(existsSync(installedLink), `project-scoped plugin install missing at ${installedLink}`);
  const readme = await Bun.file(join(root, "README.md")).text();
  const section = readme.split("### running the `pstack` CLI after install")[1];
  const block = section && /```bash\n([\s\S]*?)```/.exec(section);
  assert(block, "README install-resolver block not found");
  const resolverLine = block[1].split("\n").find((line) => line.startsWith("PSTACK_ROOT="));
  assert(resolverLine, "README resolver line not found");
  const installedRoot = run(["bash", "-c", `${resolverLine}\nprintf '%s' "$PSTACK_ROOT"`]).trim();
  assert(installedRoot.length > 0, "documented resolver produced an empty PSTACK_ROOT");
  assert(installedRoot.startsWith(temporary), `documented resolver resolved ${installedRoot}, not the isolated project installation`);
  const routineList = JSON.parse(run([process.execPath, join(installedRoot, "src", "cli.ts"), "routine", "list"]));
  const discovered = JSON.parse(run([process.execPath, "-e", `
    const sdk = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent", ${JSON.stringify(root)}));
    const task = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent/task", ${JSON.stringify(root)}));
    const {skills} = await sdk.discoverSkills(process.cwd());
    const {agents} = await task.discoverAgents(process.cwd());
    console.log(JSON.stringify({skills, agents}));
  `]));
  assert.equal(discovered.skills.length, 47);
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
  console.log(JSON.stringify({ ok: true, projectInstallation: true, bennyPackInstalled: true, destinationOnlyFilePreserved: true, skills: 47, upstreamAgents: 2, bennyDiscovered: false, modelInvocationDisabledPreserved: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
