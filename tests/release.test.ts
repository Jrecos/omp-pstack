import { afterEach, describe, expect, test } from "bun:test";
import type { ReleaseRecord } from "../scripts/release.ts";
import { classifyBump, latestVersion, nextVersion, parseReleaseRecord, serializeReleaseRecord } from "../scripts/release.ts";
import { createReleaseFixture, type ReleaseFixture } from "./fixtures/release-fixture.ts";

const open: ReleaseFixture[] = [];

function fixture(options?: { version?: string }): ReleaseFixture {
	const created = createReleaseFixture(options);
	open.push(created);
	return created;
}

function pull(title: string, body = "") {
	return { number: 1, title, body, mergeCommitSha: "0".repeat(40) };
}

afterEach(() => {
	for (const created of open.splice(0)) created.cleanup();
});

describe("release version selection", () => {
	test("a breaking change outranks feat", () => {
		expect(classifyBump(pull("feat!: drop the legacy flag"))).toBe("major");
		expect(classifyBump(pull("fix(cli)!: rename the mode flag"))).toBe("major");
		expect(classifyBump(pull("feat: add a flag", "BREAKING CHANGE: the mode flag is renamed"))).toBe("major");
		expect(classifyBump(pull("chore: tidy the flags", "BREAKING-CHANGE: configuration keys move"))).toBe("major");
	});

	test("feat is minor and every other pull request is patch", () => {
		expect(classifyBump(pull("feat(setup): add a flag"))).toBe("minor");
		expect(classifyBump(pull("fix: repair the flag"))).toBe("patch");
		expect(classifyBump(pull("docs: describe the flag"))).toBe("patch");
		expect(classifyBump(pull("update the flag handling"))).toBe("patch");
		expect(classifyBump(pull("fix: mention BREAKING CHANGE: in prose"))).toBe("patch");
	});

	test("versions start at 1.0.0 and follow the bump", () => {
		expect(nextVersion(null, "major")).toBe("1.0.0");
		expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
		expect(nextVersion("1.4.2", "minor")).toBe("1.5.0");
		expect(nextVersion("1.4.2", "patch")).toBe("1.4.3");
		expect(latestVersion(["1.9.0", "1.10.0", "1.2.9"])).toBe("1.10.0");
	});

});

describe("releasing a merged pull request", () => {
	test("the first release is 1.0.0 whatever the pull request type", () => {
		const fx = fixture();
		const mergeCommit = fx.mergePullRequest({ number: 1, title: "chore: wire the release automation" });
		const run = fx.run({ PR_NUMBER: "1" });
		expect(run.status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.releases()).toEqual(["v1.0.0"]);
		expect(fx.packageVersionAt("v1.0.0")).toBe("1.0.0");
		expect(String(fx.release("v1.0.0").body)).toContain("chore: wire the release automation");
		expect(parseReleaseRecord(fx.tagMessage("v1.0.0"))).toMatchObject({
			version: "1.0.0",
			tag: "v1.0.0",
			bump: "patch",
			pr: { number: 1, title: "chore: wire the release automation", mergeCommitSha: mergeCommit },
		});
	});

	test("each merge bumps by its pull request type", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 1, title: "feat: bootstrap the release automation" });
		expect(fx.run({ PR_NUMBER: "1" }).status).toBe(0);
		fx.mergePullRequest({ number: 2, title: "feat!: drop the legacy mode", body: "BREAKING CHANGE: the legacy mode is gone" });
		expect(fx.run({ PR_NUMBER: "2" }).status).toBe(0);
		fx.mergePullRequest({ number: 3, title: "fix: keep the release queue ordered" });
		expect(fx.run({ PR_NUMBER: "3" }).status).toBe(0);
		fx.mergePullRequest({ number: 4, title: "docs: explain the release policy" });
		expect(fx.run({ PR_NUMBER: "4" }).status).toBe(0);

		expect(fx.tags()).toEqual(["v1.0.0", "v2.0.0", "v2.0.1", "v2.0.2"]);
		expect(fx.releases()).toEqual(["v1.0.0", "v2.0.0", "v2.0.1", "v2.0.2"]);
		expect(fx.packageVersionAt("v1.0.0")).toBe("1.0.0");
		expect(fx.packageVersionAt("v2.0.0")).toBe("2.0.0");
		expect(fx.packageVersionAt("v2.0.2")).toBe("2.0.2");
		expect(fx.packageVersionAt("main")).toBe("2.0.2");
	});

	test("a rerun of a released pull request reuses its tag without a bump", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 2, title: "feat: add the release workflow" });
		expect(fx.run({ PR_NUMBER: "2" }).status).toBe(0);
		const commit = fx.tagCommit("v1.0.0");

		const rerun = fx.run({ PR_NUMBER: "2" });
		expect(rerun.status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.tagCommit("v1.0.0")).toBe(commit);
		expect(fx.releases()).toEqual(["v1.0.0"]);
	});

	test("a rerun after a failed publication publishes the existing tag only", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 5, title: "feat: recover the release" });
		fx.failReleaseCreation(true);
		expect(fx.run({ PR_NUMBER: "5" }).status).not.toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.releases()).toEqual([]);

		fx.failReleaseCreation(false);
		const resumed = fx.run({ PR_NUMBER: "5" });
		expect(resumed.status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.releases()).toEqual(["v1.0.0"]);
		expect(String(fx.release("v1.0.0").body)).toContain("feat: recover the release");
		expect(fx.packageVersionAt("main")).toBe("1.0.0");
	});

	test("a missing earlier release is repaired before the next version is allocated", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 1, title: "feat: add the release workflow" });
		fx.failReleaseCreation(true);
		expect(fx.run({ PR_NUMBER: "1" }).status).not.toBe(0);
		fx.failReleaseCreation(false);

		fx.mergePullRequest({ number: 2, title: "feat: add the second entry" });
		const run = fx.run({ PR_NUMBER: "2" });
		expect(run.status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0", "v1.1.0"]);
		expect(fx.releases()).toEqual(["v1.0.0", "v1.1.0"]);
		expect(fx.packageVersionAt("v1.1.0")).toBe("1.1.0");
	});

	test("a version tag the release does not manage blocks it", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 1, title: "feat: add the release workflow" });
		fx.pushUnmanagedTag("v0.9.0");

		const run = fx.run({ PR_NUMBER: "1" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("v0.9.0");
		expect(fx.tags()).toEqual(["v0.9.0"]);
		expect(fx.releases()).toEqual([]);
	});

	test("two release records naming one pull request are refused", () => {
		const fx = fixture();
		const mergeCommit = fx.mergePullRequest({ number: 3, title: "feat: add the release workflow" });
		const first: ReleaseRecord = {
			schema: "omp-pstack.release/1",
			version: "1.0.0",
			tag: "v1.0.0",
			bump: "minor",
			pr: { number: 3, title: "feat: add the release workflow", mergeCommitSha: mergeCommit },
			notes: "first record\n",
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		fx.pushAnnotatedTag("v1.0.0", serializeReleaseRecord(first));
		fx.pushAnnotatedTag("v1.1.0", serializeReleaseRecord({ ...first, version: "1.1.0", tag: "v1.1.0" }));

		const run = fx.run({ PR_NUMBER: "3" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("multiple release records");
		expect(fx.tags()).toEqual(["v1.0.0", "v1.1.0"]);
		expect(fx.releases()).toEqual([]);
	});

	test("a newer main cannot be released using checks from an older commit", () => {
		const fx = fixture();
		const checkedSha = fx.mergePullRequest({ number: 1, title: "feat: add releases" });
		const currentSha = fx.mergePullRequest({ number: 2, title: "fix: change after checks" });
		expect(fx.run({ PR_NUMBER: "2", RELEASE_SHA: checkedSha }).status).not.toBe(0);
		expect(fx.tags()).toEqual([]);
		expect(fx.releases()).toEqual([]);
		expect(fx.run({ PR_NUMBER: "2", RELEASE_SHA: currentSha }).status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.releases()).toEqual(["v1.0.0"]);
	});

	test("a main that moved mid-run fails the push with nothing published", () => {
		const fx = fixture();
		fx.mergePullRequest({ number: 1, title: "feat: add the release workflow" });
		fx.raceMainOnPullFetch();

		const run = fx.run({ PR_NUMBER: "1" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("Re-run the release workflow for pull request #1");
		expect(fx.tags()).toEqual([]);
		expect(fx.releases()).toEqual([]);
		expect(fx.packageVersionAt("main")).toBe("1.0.0");

		fx.clearPullFetchHook();
		const rerun = fx.run({ PR_NUMBER: "1" });
		expect(rerun.status).toBe(0);
		expect(fx.tags()).toEqual(["v1.0.0"]);
		expect(fx.releases()).toEqual(["v1.0.0"]);
		expect(fx.packageVersionAt("v1.0.0")).toBe("1.0.0");
	});
});
