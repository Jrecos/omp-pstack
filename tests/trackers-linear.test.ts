import { test, expect } from "bun:test";
import { LinearTracker, LinearError } from "../src/trackers/linear.ts";
import type { TrackerOperationContext } from "../src/trackers/contract.ts";

/**
 * GraphQL fixture with per-test response control; `served` resolves each time
 * the client's request lands, so abort timing awaits the real event instead of
 * a guessed wall-clock delay. One test needs a short real delay (commented
 * there): the backoff wait is internal state with no observable entry event.
 */
function gqlServer(handler: () => Response): { url: string; calls: () => number; served: Promise<void>; close: () => Promise<void> } {
  let calls = 0;
  const { promise: served, resolve: markServed } = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      markServed();
      return handler();
    },
  });
  return { url: `http://localhost:${server.port}/graphql`, calls: () => calls, served, close: () => server.stop(true) };
}

function makeTracker(url: string): LinearTracker {
  return new LinearTracker({
    apiUrl: url,
    token: "tok-tracker",
    team: "T",
    project: "P",
    labels: { bug: "Bug", performance: "Performance", intake: "Intake", needsRepro: "Repro" },
    status: "Intake",
  });
}

const successBody = Response.json({
  data: {
    issue: {
      id: "ISS-1",
      identifier: "BEN-1",
      title: "t",
      url: "u",
      state: { id: "S", name: "Intake", type: "unstarted" },
      labels: { nodes: [] },
      comments: { nodes: [] },
    },
  },
});

/** Body that sends headers plus one chunk and then stalls forever. */
function stalledBody(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        // Never completes: only an abort or the deadline may unstick the client.
      },
      cancel() {},
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function asError(result: "settled" | unknown): Error {
  return result instanceof Error ? result : new Error(`expected an error, got ${String(result)}`);
}

test("a stalled GraphQL body rejects when the run shutdown signal fires instead of hanging past it", async () => {
  const fx = gqlServer(() => stalledBody());
  const controller = new AbortController();
  const ctx: TrackerOperationContext = { signal: controller.signal, deadline: Date.now() + 30_000 };
  const settled = makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (error: unknown) => error,
  );
  await fx.served; // the client is past transport: any abort now must reject the body read, not hang it
  const startedAt = Date.now();
  controller.abort();
  const error = asError(await settled);
  expect(Date.now() - startedAt).toBeLessThan(2000);
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/uncertain/);
  await fx.close();
}, 10_000);

test("a stalled GraphQL body is rejected by the workflow deadline even without shutdown", async () => {
  const fx = gqlServer(() => stalledBody());
  const ctx: TrackerOperationContext = { signal: new AbortController().signal, deadline: Date.now() + 400 };
  const startedAt = Date.now();
  const error = asError(await makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (caught: unknown) => caught,
  ));
  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/uncertain/);
  await fx.close();
}, 10_000);

/** Raw HTTP response fixture for headers Bun's Response construction would normalize away (e.g. a lying content-length). */
function rawHttpServer(raw: string): { url: string; close: () => Promise<void> } {
  let sent = false;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        if (sent) return;
        sent = true;
        socket.write(raw);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}/graphql`,
    close: async () => {
      listener.stop(true);
    },
  };
}

test("an oversized GraphQL body is cancelled at the fixed byte cap", async () => {
  const fx = gqlServer(() => {
    // 5 MiB streamed: exceeds the 4 MiB cap mid-stream with no content-length hint.
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const ctx: TrackerOperationContext = { signal: new AbortController().signal, deadline: Date.now() + 10_000 };
  const error = asError(await makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (caught: unknown) => caught,
  ));
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/byte cap/);
  await fx.close();
}, 10_000);

test("an advertised oversized GraphQL body is rejected before any body consumption", async () => {
  // A proxy-rewritten lying content-length: 16 MiB advertised, 21 bytes sent, connection closed.
  const fx = rawHttpServer("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 16777216\r\n\r\n{\"data\":{\"issue\":null}}");
  const ctx: TrackerOperationContext = { signal: new AbortController().signal, deadline: Date.now() + 10_000 };
  const error = asError(await makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (caught: unknown) => caught,
  ));
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/byte cap/);
  await fx.close();
}, 10_000);
test("a 429 honors a bounded Retry-After and retries on a fresh transport", async () => {
  const fx = gqlServer(() => (fx.calls() === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : successBody));
  const ctx: TrackerOperationContext = { signal: new AbortController().signal, deadline: Date.now() + 10_000 };
  const receipt = await makeTracker(fx.url).read("ISS-1", ctx);
  expect(receipt.id).toBe("ISS-1");
  expect(fx.calls()).toBe(2);
  await fx.close();
}, 10_000);

test("shutdown during a Retry-After wait aborts the backoff instead of sleeping past the run", async () => {
  const fx = gqlServer(() => new Response(null, { status: 429, headers: { "retry-after": "5" } }));
  const controller = new AbortController();
  const ctx: TrackerOperationContext = { signal: controller.signal, deadline: Date.now() + 30_000 };
  const settled = makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (error: unknown) => error,
  );
  await fx.served;
  // The backoff wait is internal state; a short real delay is the only way to
  // land the abort inside the wait rather than during the fetch (platform-clock integration case).
  await Bun.sleep(50);
  const startedAt = Date.now();
  controller.abort();
  const error = asError(await settled);
  expect(Date.now() - startedAt).toBeLessThan(2000);
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/backoff aborted/);
  await fx.close();
}, 10_000);

/**
 * Body whose stream reports cancel acknowledgement asynchronously: the flag
 * flips only when the stream's cancel() resolves, so the client rejection can
 * be ordered against the acknowledgement.
 */
function gatedCancelBody(): { response: Response; cancelled: Promise<void> } {
  let acknowledgeCancel: () => void;
  const cancelled = new Promise<void>((resolve) => {
    acknowledgeCancel = resolve;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
      },
      cancel() {
        // Real fetch bodies settle their cancel asynchronously; a macrotask
        // gap is enough to prove the client AWAITS the acknowledgement.
        return Bun.sleep(40).then(() => acknowledgeCancel());
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, cancelled };
}

test("an abort rejects only after the live body stream acknowledges its cancel", async () => {
  let cancelled: Promise<void> | undefined;
  const fx = gqlServer(() => {
    const gated = gatedCancelBody();
    cancelled = gated.cancelled;
    return gated.response;
  });
  const controller = new AbortController();
  const ctx: TrackerOperationContext = { signal: controller.signal, deadline: Date.now() + 30_000 };
  const settled = makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (error: unknown) => error,
  );
  await fx.served;
  controller.abort();
  const error = asError(await settled);
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/uncertain/);
  // The rejection surfaces only after the stream's cancel was awaited: the
  // transport is never released with a live body left uncancelled.
  await cancelled;
  await fx.close();
}, 10_000);

test("a persistently rate-limiting server is capped at the fixed attempt budget with bounded nonzero backoff", async () => {
  const fx = gqlServer(() => new Response(null, { status: 429, headers: { "retry-after": "0" } }));
  const ctx: TrackerOperationContext = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
  const startedAt = Date.now();
  const error = asError(await makeTracker(fx.url).read("ISS-1", ctx).then(
    () => "settled" as const,
    (caught: unknown) => caught,
  ));
  const elapsed = Date.now() - startedAt;
  expect(error).toBeInstanceOf(LinearError);
  expect(error.message).toMatch(/bounded attempts/);
  // Five attempts total — not an unbounded retry spin — each honoring the
  // nonzero minimum backoff (a zero Retry-After must not retry immediately).
  expect(fx.calls()).toBe(5);
  expect(elapsed).toBeGreaterThanOrEqual(4 * 400);
  expect(elapsed).toBeLessThan(4 * 2000);
  await fx.close();
}, 30_000);

/**
 * Operation-keyed GraphQL fixture for the independent create verification:
 * serves canned data per GraphQL operation, and records every body so tests
 * can prove the verification issue query was issued independently.
 */
function opServer(
  respond: (operation: string) => unknown,
): { url: string; operations: string[]; close: () => Promise<void> } {
  const operations: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { operationName?: string };
      const operation = body.operationName ?? "";
      operations.push(operation);
      return Response.json(respond(operation));
    },
  });
  return { url: `http://localhost:${server.port}/graphql`, operations, close: () => server.stop(true) };
}

const RESOLVE_RESPONSES: Record<string, unknown> = {
  BennyTeams: { data: { teams: { nodes: [{ id: "TM", name: "T", key: "t" }] } } },
  BennyProjects: { data: { team: { projects: { nodes: [{ id: "PR", name: "P" }] } } } },
  BennyStates: { data: { team: { states: { nodes: [{ id: "S", name: "Intake", type: "unstarted" }, { id: "CX", name: "Done", type: "canceled" }] } } } },
  BennyLabels: { data: { team: { labels: { nodes: [{ id: "L1", name: "Bug" }, { id: "L2", name: "Performance" }, { id: "L3", name: "Intake" }, { id: "L4", name: "Repro" }] } } } },
};

function issueRead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ISS-1",
    identifier: "BEN-1",
    title: "t",
    description: "d",
    url: "u",
    state: { id: "S", name: "Intake", type: "unstarted" },
    project: { id: "PR", name: "P" },
    labels: { nodes: [{ id: "L1", name: "Bug" }, { id: "L3", name: "Intake" }, { id: "L4", name: "Repro" }] },
    comments: { nodes: [] },
    ...overrides,
  };
}

function trackerCtx(): TrackerOperationContext {
  return { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
}

test("create issues an independent readback and returns the read's receipt, never the mutation echo", async () => {
  // The create echo LIES about the title; verification must re-query and
  // trust only the independent issue read.
  const fx = opServer((operation) => {
    if (operation === "BennyIssueCreate") {
      return { data: { issueCreate: { success: true, issue: { ...issueRead(), title: "OTHER TITLE" } } } };
    }
    if (operation === "BennyIssue") return { data: { issue: issueRead() } };
    return RESOLVE_RESPONSES[operation] ?? { errors: [{ message: `unknown op ${operation}` }] };
  });
  try {
    const tracker = makeTracker(fx.url);
    const receipt = await tracker.create("act-1", { title: "t", description: "d", category: "bug" }, trackerCtx());
    expect(receipt.verified).toBe(true);
    // The receipt reflects the independent read, not the echo.
    expect(receipt.observed).toMatchObject({ title: "t", state: "Intake", labels: ["Bug", "Intake", "Repro"], project: "P" });
    expect(fx.operations).toContain("BennyIssue");
  } finally {
    await fx.close();
  }
});

test("create fails closed when the independent read does not match the exact title", async () => {
  const fx = opServer((operation) => {
    if (operation === "BennyIssueCreate") return { data: { issueCreate: { success: true, issue: issueRead() } } };
    if (operation === "BennyIssue") return { data: { issue: issueRead({ title: "DRIFTED" }) } };
    return RESOLVE_RESPONSES[operation] ?? { errors: [{ message: `unknown op ${operation}` }] };
  });
  try {
    const tracker = makeTracker(fx.url);
    await expect(tracker.create("act-1", { title: "t", description: "d", category: "bug" }, trackerCtx())).rejects.toThrow(/readback mismatch/);
  } finally {
    await fx.close();
  }
});

test("verifyCreated (the create-reconcile readback) rejects any omission of title, state, project or a required label", async () => {
  for (const [what, override] of [
    ["title", { title: "OTHER" }],
    ["state", { state: { id: "S2", name: "Started", type: "started" } }],
    ["project", { project: { id: "OTHER", name: "OTHER" } }],
    ["missing project", { project: null }],
    ["intake label", { labels: { nodes: [{ id: "L1", name: "Bug" }, { id: "L4", name: "Repro" }] } }],
    ["needs-repro label", { labels: { nodes: [{ id: "L1", name: "Bug" }, { id: "L3", name: "Intake" }] } }],
    ["category label", { labels: { nodes: [{ id: "L3", name: "Intake" }, { id: "L4", name: "Repro" }] } }],
  ] as Array<[string, Record<string, unknown>]>) {
    const fx = opServer((operation) => {
      if (operation === "BennyIssue") return { data: { issue: issueRead(override) } };
      return RESOLVE_RESPONSES[operation] ?? { errors: [{ message: `unknown op ${operation}` }] };
    });
    try {
      const tracker = makeTracker(fx.url);
      const error = await tracker
        .verifyCreated("ISS-1", { title: "t", category: "bug" }, trackerCtx())
        .then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(LinearError);
      expect((error as Error).message).toMatch(/readback mismatch/);
      expect((error as Error).message.length).toBeGreaterThan(0);
    } finally {
      await fx.close();
    }
  }
});

test("verifyCreated returns the verified receipt when the independent read matches every requirement", async () => {
  const fx = opServer((operation) => {
    if (operation === "BennyIssue") return { data: { issue: issueRead() } };
    return RESOLVE_RESPONSES[operation] ?? { errors: [{ message: `unknown op ${operation}` }] };
  });
  try {
    const tracker = makeTracker(fx.url);
    const receipt = await tracker.verifyCreated("ISS-1", { title: "t", category: "bug" }, trackerCtx());
    expect(receipt.verified).toBe(true);
    expect(receipt.id).toBe("ISS-1");
    expect(receipt.observed).toMatchObject({ title: "t", state: "Intake", stateType: "unstarted", project: "P" });
  } finally {
    await fx.close();
  }
});
