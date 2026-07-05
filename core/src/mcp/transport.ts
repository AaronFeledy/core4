/**
 * MCP transport seam.
 *
 * `McpService.serve` is transport-agnostic: it pulls tool-call requests from an
 * `McpTransport`, dispatches them, and pushes replies/notifications back. The
 * stdio transport that backs `lando mcp` is wired by the `meta:mcp` command;
 * this module ships the seam plus an in-memory transport used by tests and the
 * MCP contract suite.
 */
import { Context, Deferred, Effect, Option, Queue, Ref, Scope } from "effect";

import type { McpDispatchError, McpDispatchResult, McpToolCallRequest } from "./dispatch.ts";

export interface McpTransportRequest {
  readonly id: string;
  readonly request: McpToolCallRequest;
}

export type McpTransportReply =
  | { readonly id: string; readonly ok: true; readonly result: McpDispatchResult }
  | { readonly id: string; readonly ok: false; readonly error: McpDispatchError };

export interface McpTransportNotification {
  readonly id: string;
  readonly frame: unknown;
}

export interface McpTransportShape {
  /** Next inbound request, or `None` once the transport is closed. */
  readonly receive: Effect.Effect<Option.Option<McpTransportRequest>>;
  /** Next request id cancelled by the MCP client, or `None` once the transport is closed. */
  readonly receiveCancel: Effect.Effect<Option.Option<string>>;
  readonly reply: (reply: McpTransportReply) => Effect.Effect<void>;
  readonly notify: (notification: McpTransportNotification) => Effect.Effect<void>;
}

export class McpTransport extends Context.Tag("@lando/core/McpTransport")<
  McpTransport,
  McpTransportShape
>() {}

export interface InMemoryTransport {
  readonly transport: McpTransportShape;
  /** Enqueue a request; resolves to the assigned request id. */
  readonly push: (request: McpToolCallRequest) => Effect.Effect<string>;
  /** Cancel a request by id, interrupting the matching in-flight call if present. */
  readonly cancel: (id: string) => Effect.Effect<void>;
  /** Close the transport so `serve` drains and returns. */
  readonly close: Effect.Effect<void>;
  /** Every reply pushed back through the transport, in order. */
  readonly replies: Effect.Effect<ReadonlyArray<McpTransportReply>>;
  readonly notifications: Effect.Effect<ReadonlyArray<McpTransportNotification>>;
}

/**
 * A scoped in-memory transport. Requests enqueued via `push` are delivered to
 * `serve`; `close` unblocks a pending `receive` with `None`.
 */
export const makeInMemoryTransport = (): Effect.Effect<InMemoryTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<McpTransportRequest>();
    const cancellations = yield* Queue.unbounded<string>();
    const closed = yield* Deferred.make<void>();
    const replies = yield* Ref.make<ReadonlyArray<McpTransportReply>>([]);
    const notifications = yield* Ref.make<ReadonlyArray<McpTransportNotification>>([]);
    const counter = yield* Ref.make(0);
    yield* Scope.addFinalizer(yield* Effect.scope, Queue.shutdown(queue));

    const receive: McpTransportShape["receive"] = Effect.raceFirst(
      Queue.take(queue).pipe(Effect.map(Option.some)),
      Deferred.await(closed).pipe(Effect.as(Option.none<McpTransportRequest>())),
    );
    const receiveCancel: McpTransportShape["receiveCancel"] = Effect.raceFirst(
      Queue.take(cancellations).pipe(Effect.map(Option.some)),
      Deferred.await(closed).pipe(Effect.as(Option.none<string>())),
    );

    const transport: McpTransportShape = {
      receive,
      receiveCancel,
      reply: (reply) => Ref.update(replies, (current) => [...current, reply]),
      notify: (notification) => Ref.update(notifications, (current) => [...current, notification]),
    };

    return {
      transport,
      push: (request) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(counter, (value) => value + 1);
          const id = `req-${next}`;
          yield* Queue.offer(queue, { id, request });
          return id;
        }),
      cancel: (id) => Queue.offer(cancellations, id).pipe(Effect.asVoid),
      close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
      replies: Ref.get(replies),
      notifications: Ref.get(notifications),
    };
  });
