/**
 * Focused regressions for the inventory target-presence gate in
 * scripts/check-content.ts: an absent adapted target must fail unless its
 * verification mapping is the repository's explicit removal schema, and a
 * present adapted target must still validate normally.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFileEntry } from "../scripts/check-content.ts";

const PRESENT_TARGET = "skills/poteto-mode/SKILL.md"; // mode-skill class, non-removal
const REMOVAL_TARGET = "skills/poteto-mode/scripts/bootstrap.ts"; // helper-bootstrap-removal, authorizes absence

function adaptedEntry(source: string, target: string, verification: { kind: string; artifacts: string[] }) {
	return {
		source,
		target,
		blob: "0".repeat(40),
		mode: "100644",
		adaptation: {
			reason: "host translation documented in the inventory",
			verification,
		},
	};
}

describe("check-content inventory target presence", () => {
	test("an absent adapted target outside the removal schema fails deterministically", async () => {
		const root = await mkdtemp(join(tmpdir(), "check-content-absent-"));
		try {
			const source = `pstack/${PRESENT_TARGET}`;
			const found = await checkFileEntry(
				root,
				adaptedEntry(source, PRESENT_TARGET, { kind: "omp/cli scenario", artifacts: ["scripts/smoke.ts"] }),
			);
			expect(found).toEqual([
				`${source}: upstream file missing at target ${PRESENT_TARGET} and no removal schema authorizes an adapted row's absence`,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an absent adapted target listed in the removal schema still validates normally", async () => {
		const root = await mkdtemp(join(tmpdir(), "check-content-removed-"));
		try {
			const source = `pstack/${REMOVAL_TARGET}`;
			const found = await checkFileEntry(
				root,
				adaptedEntry(source, REMOVAL_TARGET, { kind: "omp/cli scenario", artifacts: ["scripts/smoke-install.ts"] }),
			);
			expect(found).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a present adapted target validates normally", async () => {
		const root = await mkdtemp(join(tmpdir(), "check-content-present-"));
		try {
			// The target file and its canonical verification artifact both exist.
			await mkdir(join(root, "skills", "poteto-mode"), { recursive: true });
			await writeFile(join(root, PRESENT_TARGET), "# adapted\n");
			await mkdir(join(root, "scripts"), { recursive: true });
			await writeFile(join(root, "scripts", "smoke.ts"), "// scenario\n");
			const source = `pstack/${PRESENT_TARGET}`;
			const found = await checkFileEntry(
				root,
				adaptedEntry(source, PRESENT_TARGET, { kind: "omp/cli scenario", artifacts: ["scripts/smoke.ts"] }),
			);
			expect(found).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
