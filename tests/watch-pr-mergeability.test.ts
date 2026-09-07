import { expect, test } from "bun:test";
import { classifyPr, readSnapshot } from "../skills/poteto-mode/scripts/watch-pr/policy.ts";
import { fakeReader } from "../skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts";
import { parsePrNumber } from "../skills/poteto-mode/scripts/watch-pr/types.ts";
import type { PullRequestFacts } from "../skills/poteto-mode/scripts/watch-pr/types.ts";

const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };

async function classify(mergeable: PullRequestFacts["mergeable"]) {
  const snapshot = await readSnapshot({
    reader: fakeReader({ facts: { mergeable, mergeStateStatus: "CLEAN" } }),
    context,
    pendingHistory: "include",
    allowDraft: false,
  });
  return classifyPr(snapshot);
}

test("watch-pr waits until GitHub confirms mergeability", async () => {
  expect(await classify("UNKNOWN")).toEqual({ kind: "waiting", frontier: context, pending: null });
  expect(await classify("MERGEABLE")).toMatchObject({
    kind: "ready",
    pr: { kind: "ready-pr", proof: { mergeability: "clear" } },
  });
  expect(await classify("CONFLICTING")).toMatchObject({
    kind: "blocker",
    blocker: { kind: "merge-conflicts" },
  });
});
