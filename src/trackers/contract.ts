import type { RemoteReceipt } from "../benny-policy.ts";

export type TrackerCategory = "bug" | "performance";

export interface TrackerTarget {
  teamId: string;
  projectId: string;
  statusId: string;
  canceledStateId: string;
  labelIds: Record<TrackerCategory | "intake" | "needsRepro", string>;
}

export interface TrackerCreateInput {
  title: string;
  description: string;
  category: TrackerCategory;
}

/**
 * Operation context every tracker adapter method receives: the owning run's
 * shutdown signal and its absolute epoch-ms deadline. Adapters must preflight
 * both before transport and honor the signal during it.
 */
export interface TrackerOperationContext {
  signal: AbortSignal;
  deadline: number;
}

/**
 * The bundled Linear tracker implements this bounded contract. Every method
 * takes the operation context as its final argument; every mutation returns
 * a receipt issued only after a readback.
 */
export interface TrackerAdapter {
  /** Resolve configured team/project/labels/status AND the canceled workflow state. Missing canceled state blocks creation. */
  resolve(ctx: TrackerOperationContext): Promise<TrackerTarget>;
  search(query: string, ctx: TrackerOperationContext): Promise<RemoteReceipt[]>;
  read(id: string, ctx: TrackerOperationContext): Promise<RemoteReceipt>;
  create(actionId: string, input: TrackerCreateInput, ctx: TrackerOperationContext): Promise<RemoteReceipt>;
  /** Append a recurrence note. Never relabels or reassigns. */
  recurrence(actionId: string, id: string, description: string, ctx: TrackerOperationContext): Promise<RemoteReceipt>;
  /** Move an issue created by this run to the canceled state; verified readback. */
  compensate(actionId: string, id: string, ctx: TrackerOperationContext): Promise<RemoteReceipt>;
}

export function receiptFrom(value: unknown, what: string): RemoteReceipt {
  if (typeof value !== "object" || value === null) throw new Error(`${what}: receipt is not an object`);
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") throw new Error(`${what}: receipt.id missing`);
  if (r.verified !== true) throw new Error(`${what}: receipt.verified must be true (readback required)`);
  if (typeof r.observed !== "object" || r.observed === null || Array.isArray(r.observed)) throw new Error(`${what}: receipt.observed missing`);
  const out: RemoteReceipt = { id: r.id, verified: true, observed: r.observed as Record<string, unknown> };
  if (typeof r.url === "string") out.url = r.url;
  return out;
}

/**
 * Begin one adapter transport bound to the operation context. The run
 * signal's listener is attached BEFORE the returned signal can reach any
 * transport and the aborted state is re-checked synchronously afterwards,
 * closing the registration race; the absolute deadline becomes a bounded
 * abort. `done()` removes the listener and the timer exactly once and MUST
 * be called when the transport settles.
 */
export function beginTrackerTransport(ctx: TrackerOperationContext, label: string): { signal: AbortSignal; done(): void } {
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new Error(`tracker ${label}: workflow deadline expired before transport`);
  if (ctx.signal.aborted) throw new Error(`tracker ${label}: aborted before transport`);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(onAbort, remaining);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort(); // registration race: the run settled between check and listener
  let settled = false;
  return {
    signal: controller.signal,
    done: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    },
  };
}