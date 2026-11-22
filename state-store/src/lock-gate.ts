import type { StateLockOptions } from "@lando/sdk/services";
import { Deferred, Effect } from "effect";

type Mode = NonNullable<StateLockOptions["mode"]>;
type Ticket = { readonly mode: Mode; readonly ready: Deferred.Deferred<void> };
type Gate = { readonly queue: Set<Ticket>; holders: number; mode: Mode };

const grantReady = (gate: Gate) => {
  // Only admit a contiguous batch of readers, never readers behind a writer.
  for (const ticket of gate.queue) {
    if (gate.holders > 0 && (gate.mode === "exclusive" || ticket.mode === "exclusive")) break;
    gate.queue.delete(ticket);
    gate.mode = ticket.mode;
    gate.holders++;
    Deferred.doneUnsafe(ticket.ready, Effect.void);
  }
};

/**
 * A FIFO, writer-preferring in-process gate per path. Register the ticket and its cleanup
 * atomically; wait for readiness outside the mask. The pending deferred is undefined when granted.
 */
export const makeLockGate = () => {
  const gates = new Map<string, Gate>();
  return (path: string, mode: Mode) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const gate = gates.get(path) ?? { queue: new Set<Ticket>(), holders: 0, mode };
        gates.set(path, gate);
        const ticket = { mode, ready: Deferred.makeUnsafe<void>() };
        gate.queue.add(ticket);
        grantReady(gate);
        return { gate, ticket, pending: gate.queue.has(ticket) ? ticket.ready : undefined };
      }),
      ({ gate, ticket }) =>
        Effect.sync(() => {
          // A ticket absent from the queue has already been granted, even if its fiber has not resumed.
          if (!gate.queue.delete(ticket)) gate.holders--;
          grantReady(gate);
          if (gate.holders === 0) gates.delete(path);
        }),
    ).pipe(Effect.map(({ pending }) => pending));
};

export const enqueueLock = makeLockGate();
