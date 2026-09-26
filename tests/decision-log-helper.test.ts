import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "..", "skills", "show-me-your-work", "scripts", "log.sh");
const header = "ts\tphase\tdecision\twhy\tevidence\tresult";

function append(path: string): void {
	const result = Bun.spawnSync(["bash", helper, path, "verify", "append", "because", "fixture", "passed"]);
	expect(result.exitCode).toBe(0);
}

test("decision log helper preserves rows and initializes empty files once", () => {
	const root = mkdtempSync(join(tmpdir(), "decision-log-helper-"));
	try {
		const seeded = join(root, "seeded.tsv");
		writeFileSync(seeded, `${header}\nseed\tbaseline\tkept\tproof\tfixture\tgreen\n`);
		append(seeded);
		const seededLines = readFileSync(seeded, "utf8").trimEnd().split("\n");
		expect(seededLines[0]).toBe(header);
		expect(seededLines[1]).toBe("seed\tbaseline\tkept\tproof\tfixture\tgreen");
		expect(seededLines.filter((line) => line === header)).toHaveLength(1);
		expect(seededLines).toHaveLength(3);

		const empty = join(root, "empty.tsv");
		writeFileSync(empty, "");
		append(empty);
		append(empty);
		const emptyLines = readFileSync(empty, "utf8").trimEnd().split("\n");
		expect(emptyLines[0]).toBe(header);
		expect(emptyLines.filter((line) => line === header)).toHaveLength(1);
		expect(emptyLines).toHaveLength(3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
