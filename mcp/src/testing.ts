import { type Cause, Deferred, Effect, Layer, Predicate, Queue, Schema, Sink, Stdio, Stream } from "effect";
import type { McpToolCallRequest } from "./dispatch";

export type JsonRpcMessage = Schema.JsonObject;

export const startStdioClient = Effect.fnUntraced(function* (
  serve: Effect.Effect<void, import("@lando/sdk/errors").McpTransportError, Stdio.Stdio>,
  capabilities: Schema.JsonObject = {},
) {
  const client = yield* makeStdioClient();
  const fiber = yield* serve.pipe(Effect.provideService(Stdio.Stdio, client.stdio), Effect.forkScoped);
  yield* client.initialize(capabilities);
  return { ...client, fiber };
});

export const makeStdioClient = Effect.fnUntraced(function* () {
  const input = yield* Queue.make<Uint8Array, Cause.Done>();
  const output = yield* Queue.make<JsonRpcMessage>();
  const pending = new Map<string | number, Deferred.Deferred<JsonRpcMessage>>();
  const messages: JsonRpcMessage[] = [];
  let sequence = 0;
  let buffer = "";
  let initialized = false;
  const decoder = new TextDecoder();
  const write = Effect.fnUntraced(function* (chunk: string | Uint8Array) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length === 0) continue;
      const message = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line));
      messages.push(message);
      yield* Queue.offer(output, message);
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        const response = pending.get(id);
        if (response !== undefined && message.method === undefined)
          yield* Deferred.succeed(response, message);
      }
    }
  });
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout: () => Sink.forEach(write),
    stderr: () => Sink.drain,
  });
  const send = (message: JsonRpcMessage) =>
    Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid);
  const sendRequest = Effect.fnUntraced(function* (
    method: string,
    params: Schema.JsonObject = {},
    id: string | number = ++sequence,
  ) {
    const response = yield* Deferred.make<JsonRpcMessage>();
    pending.set(id, response);
    yield* send({ jsonrpc: "2.0", id, method, params });
    return { id, response: Deferred.await(response) };
  });
  const request = Effect.fnUntraced(function* (method: string, params: Schema.JsonObject = {}) {
    return yield* (yield* sendRequest(method, params)).response;
  });
  const initialize = Effect.fnUntraced(function* (
    capabilities: Schema.JsonObject = {},
    protocolVersion = "2025-06-18",
  ) {
    const result = yield* request("initialize", {
      protocolVersion,
      capabilities,
      clientInfo: { name: "lando-test", version: "1" },
    });
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    initialized = true;
    return result;
  });
  const push = Effect.fnUntraced(function* (call: McpToolCallRequest, id = `req-${++sequence}`) {
    if (!initialized) yield* initialize();
    const args = Schema.decodeUnknownSync(Schema.JsonObject)(call.input ?? {});
    yield* sendRequest(
      "tools/call",
      { name: call.toolId, arguments: args, _meta: { progressToken: id } },
      id,
    );
    return id;
  });
  const replies = Effect.sync(() =>
    messages
      .filter(
        (message) =>
          message.method === undefined && typeof message.id === "string" && message.id.startsWith("req-"),
      )
      .map((message) => {
        const result = message.result;
        if (!Predicate.isObject(result)) return { id: message.id, ok: false, error: message.error };
        const envelope = result.structuredContent;
        if (envelope !== undefined)
          return {
            id: message.id,
            ok: true,
            result: { ok: Predicate.isObject(envelope) && envelope.ok === true, envelope },
          };
        const content = result.content;
        const first = Array.isArray(content) ? content[0] : undefined;
        const error: unknown =
          Predicate.isObject(first) && typeof first.text === "string" ? JSON.parse(first.text) : undefined;
        return { id: message.id, ok: false, error };
      }),
  );
  return {
    stdio,
    layer: Layer.succeed(Stdio.Stdio, stdio),
    send,
    sendRequest,
    request,
    initialize,
    push,
    replies,
    cancel: (id: string | number) =>
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }),
    close: Queue.end(input),
    raw: (bytes: Uint8Array) => Queue.offer(input, bytes),
    next: Queue.take(output),
    messages: Effect.sync(() => [...messages]),
    notifications: Effect.sync(() =>
      messages
        .filter((message) => message.method === "notifications/progress")
        .map((message) => {
          const params = message.params;
          const frame: unknown =
            Predicate.isObject(params) && typeof params.message === "string"
              ? JSON.parse(params.message)
              : undefined;
          return { frame };
        }),
    ),
  };
});
