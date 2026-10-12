import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkNativeFixtureProofs } from "../scripts/check-content.ts";

type Name = "capabilities" | "models";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-proof-"));
  temporary.push(directory);
  const root = join(directory, "repo");
  const sources: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { "@oh-my-pi/pi-coding-agent": "18.10.2" } }),
    "bun.lock": "fixture dependency lock\n",
    "scripts/smoke-native-capabilities.ts": "export const capabilities = true;\n",
    "scripts/smoke-models.ts": "export const models = true;\n",
    "src/extension.ts": "export const extension = true;\n",
    "src/models.ts": "export const model = true;\n",
    "src/mode.ts": "export const mode = true;\n",
    "node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts": "export const sdk = true;\n",
  };
  for (const [path, contents] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const sdkPath = "sdk/pi-coding-agent/src/sdk.ts";
  const sdkHash = hash(sources["node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts"]!);
  const proofs: Record<Name, Record<string, unknown>> = {
    capabilities: {
      ok: true, fixtureOnly: true, expectedVersion: "18.10.2",
      measurements: [{ name: "UI", status: "withheld" }], deferred: [{ status: "deferred" }],
      producerInputs: Object.fromEntries([
        ...["package.json", "bun.lock", "scripts/smoke-native-capabilities.ts"].map(path => [path, hash(sources[path]!)]),
        [sdkPath, sdkHash],
      ]),
    },
    models: {
      ok: true, fixtureOnly: true, sdkVersion: "18.10.2",
      producerInputs: ["package.json", "bun.lock", "scripts/smoke-models.ts", "src/extension.ts", "src/models.ts", "src/mode.ts"]
        .map(path => ({ path, sha256: hash(sources[path]!) })),
    },
  };
  await mkdir(join(root, "proofs"));
  const save = async (name: Name) => writeFile(join(root, `proofs/native-${name}.json`), JSON.stringify(proofs[name]));
  await save("capabilities");
  await save("models");
  const outside = join(directory, "private.ts");
  await writeFile(outside, sources["node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts"]!);
  return { root, proofs, save, outside, sdkPath, sdkHash };
}

describe("native fixture listed-input freshness", () => {
  test("current inputs pass without a host binary, credentials, or a full SDK tree, then a changed SDK input fails", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    await writeFile(join(fx.root, "node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts"), "changed SDK source\n");
    const errors = await checkNativeFixtureProofs(fx.root);
    expect(errors.some(error => error.includes("native-capabilities.json") && error.includes("[hash]"))).toBe(true);
    expect(errors.some(error => error.includes("native-models.json"))).toBe(false);
  });

  test.each(["capabilities", "models"] as const)("%s binds the lock and its own producer", async name => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    const producer = name === "models" ? "scripts/smoke-models.ts" : "scripts/smoke-native-capabilities.ts";
    await writeFile(join(fx.root, producer), "changed producer\n");
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[hash]"))).toBe(true);
    await writeFile(join(fx.root, "bun.lock"), "changed lock\n");
    const errors = await checkNativeFixtureProofs(fx.root);
    for (const proof of ["capabilities", "models"]) {
      expect(errors.some(error => error.includes(`native-${proof}.json`) && error.includes("bun.lock") && error.includes("[hash]"))).toBe(true);
    }
  });

  test.each(["src/extension.ts", "src/models.ts", "src/mode.ts"])("models binds %s", async path => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    await writeFile(join(fx.root, path), "changed plugin source\n");
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes("native-models.json") && error.includes("[hash]"))).toBe(true);
  });

  test("missing required entries and duplicate array entries fail before hashing", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    delete (fx.proofs.capabilities.producerInputs as Record<string, string>)["bun.lock"];
    const inputs = fx.proofs.models.producerInputs as { path: string; sha256: string }[];
    inputs.push({ ...inputs[0]! });
    await fx.save("capabilities");
    await fx.save("models");
    const errors = await checkNativeFixtureProofs(fx.root);
    for (const name of ["capabilities", "models"]) {
      expect(errors.some(error => error.includes(`native-${name}.json`) && error.includes("[inputs]"))).toBe(true);
    }
    expect(errors.some(error => error.includes("[hash]"))).toBe(false);
  });

  test.each(["capabilities", "models"] as const)("%s rejects malformed SHA256", async name => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    if (name === "capabilities") (fx.proofs[name].producerInputs as Record<string, string>)["bun.lock"] = "not-a-sha";
    else (fx.proofs[name].producerInputs as { path: string; sha256: string }[])[0]!.sha256 = "not-a-sha";
    await fx.save(name);
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[inputs]"))).toBe(true);
  });

  test.each(["/tmp/private.ts", "../private.ts", "sdk/pi-coding-agent/../../private.ts", "sdk/pi-coding-agent//src/sdk.ts", "sdk/pi-coding-agent/src/../sdk.ts", "sdk/pi-coding-agent/src\\sdk.ts", "sdk/unexpected/src/sdk.ts", "sdk/pi-coding-agent/auth.json", "src/private.ts"])("rejects an unsafe or outside-source label %s", async path => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    (fx.proofs.capabilities.producerInputs as Record<string, string>)[path] = fx.sdkHash;
    (fx.proofs.models.producerInputs as { path: string; sha256: string }[]).push({ path, sha256: fx.sdkHash });
    await fx.save("capabilities");
    await fx.save("models");
    const errors = await checkNativeFixtureProofs(fx.root);
    for (const name of ["capabilities", "models"]) {
      expect(errors.some(error => error.includes(`native-${name}.json`) && error.includes("[path]"))).toBe(true);
    }
    expect(errors.some(error => error.includes("[hash]") || error.includes("[input]"))).toBe(false);
  });

  test("allowed SDK labels cannot read a symlink outside the package", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    const source = join(fx.root, "node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts");
    await rm(source);
    await symlink(fx.outside, source);
    const errors = await checkNativeFixtureProofs(fx.root);
    expect(errors.some(error => error.includes("[path]"))).toBe(true);
    expect(errors.some(error => error.includes("[hash]") || error.includes("[input]"))).toBe(false);
  });

  test("a listed source missing on disk fails", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    await rm(join(fx.root, "src/mode.ts"));
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes("native-models.json") && error.includes("[input]"))).toBe(true);
  });

  test("local required inputs cannot read a symlink outside the repository", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    const source = join(fx.root, "src/mode.ts");
    await rm(source);
    await symlink(fx.outside, source);
    const errors = await checkNativeFixtureProofs(fx.root);
    expect(errors.some(error => error.includes("native-models.json") && error.includes("[path]"))).toBe(true);
    expect(errors.some(error => error.includes("[hash]") || error.includes("[input]"))).toBe(false);
  });

  test("a current package hash does not allow a non-exact SDK pin", async () => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    const contents = JSON.stringify({ dependencies: { "@oh-my-pi/pi-coding-agent": "^18.10.2" } });
    await writeFile(join(fx.root, "package.json"), contents);
    (fx.proofs.capabilities.producerInputs as Record<string, string>)["package.json"] = hash(contents);
    const inputs = fx.proofs.models.producerInputs as { path: string; sha256: string }[];
    inputs.find(input => input.path === "package.json")!.sha256 = hash(contents);
    await fx.save("capabilities");
    await fx.save("models");
    const errors = await checkNativeFixtureProofs(fx.root);
    for (const name of ["capabilities", "models"]) {
      expect(errors.some(error => error.includes(`native-${name}.json`) && error.includes("[version]"))).toBe(true);
    }
    expect(errors.some(error => error.includes("[hash]"))).toBe(false);
  });

  test.each(["capabilities", "models"] as const)("%s rejects non-success, non-fixture, wrong-version, and wrong-format reports", async name => {
    const fx = await fixture();
    expect(await checkNativeFixtureProofs(fx.root)).toEqual([]);
    for (const field of ["ok", "fixtureOnly"]) {
      fx.proofs[name][field] = false;
      await fx.save(name);
      expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[status]"))).toBe(true);
      fx.proofs[name][field] = true;
    }
    const version = name === "models" ? "sdkVersion" : "expectedVersion";
    fx.proofs[name][version] = "18.10.1";
    await fx.save(name);
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[version]"))).toBe(true);
    fx.proofs[name][version] = "18.10.2";
    fx.proofs[name].producerInputs = name === "models" ? {} : [];
    await fx.save(name);
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[inputs]"))).toBe(true);
    for (const contents of ["null", "[]", "{broken"]) {
      await writeFile(join(fx.root, `proofs/native-${name}.json`), contents);
      expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[shape]"))).toBe(true);
    }
    await rm(join(fx.root, `proofs/native-${name}.json`));
    expect((await checkNativeFixtureProofs(fx.root)).some(error => error.includes(`native-${name}.json`) && error.includes("[shape]"))).toBe(true);
  });
});
