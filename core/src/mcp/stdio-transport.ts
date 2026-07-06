import { Deferred, Effect, Option, Queue, Ref, Scope } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";

import type { McpToolInput } from "./registry.ts";
import {
  type JsonObject,
  type JsonRpcId,
  type ProgressToken,
  errorData,
  errorMessage,
  hasOwn,
  idKey,
  isJsonObject,
  jsonRpcIdFrom,
  objectField,
  parseJsonLine,
  progressTokenFrom,
  rpcError,
  rpcResult,
  stringField,
  toolInputFrom,
} from "./stdio-rpc.ts";
import type {
  McpTransportNotification,
  McpTransportReply,
  McpTransportRequest,
  McpTransportShape,
} from "./transport.ts";

export interface StdioTransportOptions {
  readonly catalog: McpCatalog;
  readonly input?: ReadableStream<Uint8Array>;
  readonly write?: (line: string) => Effect.Effect<void>;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly protocolVersion?: string;
}

interface CorrelationEntry {
  readonly jsonrpcId: JsonRpcId;
  readonly progressToken?: ProgressToken;
}

interface CorrelationState {
  readonly byInternalId: ReadonlyMap<string, CorrelationEntry>;
  readonly byJsonrpcId: ReadonlyMap<string, string>;
}

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_SERVER_INFO = { name: "lando", version: "4.0.0" } as const;

const stdoutWrite = (): ((line: string) => Effect.Effect<void>) => {
  const writer = Bun.stdout.writer();
  return (line) =>
    Effect.promise(async () => {
      writer.write(`${line}\n`);
      await writer.flush();
    });
};

const progressTokenFromParams = (params: JsonObject | undefined): ProgressToken | undefined =>
  progressTokenFrom(objectField(params ?? {}, "_meta")?.progressToken);

const callRequestFromParams = (params: JsonObject | undefined): McpToolInput | undefined =>
  toolInputFrom(objectField(params ?? {}, "arguments"));

export const makeStdioMcpTransport = (
  options: StdioTransportOptions,
): Effect.Effect<McpTransportShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const input = options.input ?? Bun.stdin.stream();
    const writeLine = options.write ?? stdoutWrite();
    const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
    const reader = input.getReader();
    const decoder = new TextDecoder();
    const requests = yield* Queue.unbounded<McpTransportRequest>();
    const cancellations = yield* Queue.unbounded<string>();
    const closed = yield* Deferred.make<void>();
    const counter = yield* Ref.make(0);
    const correlations = yield* Ref.make<CorrelationState>({
      byInternalId: new Map(),
      byJsonrpcId: new Map(),
    });
    const scope = yield* Effect.scope;

    const close = Deferred.succeed(closed, undefined).pipe(Effect.asVoid);
    const writeJson = (message: JsonObject): Effect.Effect<void> => writeLine(JSON.stringify(message));
    const writeError = (id: JsonRpcId, code: number, message: string, data?: unknown): Effect.Effect<void> =>
      writeJson(rpcError(id, code, message, data));

    yield* Scope.addFinalizer(
      scope,
      close.pipe(
        Effect.zipRight(Queue.shutdown(requests)),
        Effect.zipRight(Queue.shutdown(cancellations)),
        Effect.zipRight(Effect.promise(() => reader.cancel()).pipe(Effect.ignore)),
      ),
    );

    const rememberCorrelation = (internalId: string, entry: CorrelationEntry): Effect.Effect<void> =>
      Ref.update(correlations, (current) => ({
        byInternalId: new Map(current.byInternalId).set(internalId, entry),
        byJsonrpcId: new Map(current.byJsonrpcId).set(idKey(entry.jsonrpcId), internalId),
      }));

    const forgetCorrelation = (internalId: string, entry: CorrelationEntry): Effect.Effect<void> =>
      Ref.update(correlations, (current) => {
        const byInternalId = new Map(current.byInternalId);
        const byJsonrpcId = new Map(current.byJsonrpcId);
        byInternalId.delete(internalId);
        byJsonrpcId.delete(idKey(entry.jsonrpcId));
        return { byInternalId, byJsonrpcId };
      });

    const enqueueToolCall = (id: JsonRpcId, params: JsonObject | undefined): Effect.Effect<void> => {
      const toolId = params === undefined ? undefined : stringField(params, "name");
      if (toolId === undefined) return writeError(id, -32602, "Invalid params");
      const inputPayload = callRequestFromParams(params);
      return Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(counter, (value) => value + 1);
        const internalId = `req-${next}`;
        const progressToken = progressTokenFromParams(params);
        const entry: CorrelationEntry =
          progressToken === undefined ? { jsonrpcId: id } : { jsonrpcId: id, progressToken };
        yield* rememberCorrelation(internalId, entry);
        yield* Queue.offer(requests, {
          id: internalId,
          request: { toolId, ...(inputPayload === undefined ? {} : { input: inputPayload }) },
        });
      });
    };

    const cancelToolCall = (params: JsonObject | undefined): Effect.Effect<void> => {
      const requestId = jsonRpcIdFrom(params?.requestId);
      if (requestId === undefined) return Effect.void;
      return Ref.get(correlations).pipe(
        Effect.flatMap((current) => {
          const internalId = current.byJsonrpcId.get(idKey(requestId));
          return internalId === undefined
            ? Effect.void
            : Queue.offer(cancellations, internalId).pipe(Effect.asVoid);
        }),
      );
    };

    const handleMessage = (message: JsonObject): Effect.Effect<void> => {
      const method = stringField(message, "method");
      if (method === undefined) return Effect.void;
      const hasId = hasOwn(message, "id");
      const id = hasId ? jsonRpcIdFrom(message.id) : undefined;
      const params = objectField(message, "params");
      if (hasId && id === undefined) return writeError(null, -32600, "Invalid Request");
      if (method === "notifications/initialized") return Effect.void;
      if (method === "notifications/cancelled") return cancelToolCall(params);
      if (id === undefined) return writeError(null, -32600, "Invalid Request");
      switch (method) {
        case "initialize":
          return writeJson(
            rpcResult(id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
            }),
          );
        case "ping":
          return writeJson(rpcResult(id, {}));
        case "tools/list":
          return writeJson(
            rpcResult(id, {
              tools: options.catalog.tools.map((tool) => ({
                name: tool.toolId,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            }),
          );
        case "tools/call":
          return enqueueToolCall(id, params);
        default:
          return writeError(id, -32601, "Method not found");
      }
    };

    const handleLine = (line: string): Effect.Effect<void> => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return Effect.void;
      return parseJsonLine(trimmed).pipe(
        Effect.flatMap((parsed) => (isJsonObject(parsed) ? handleMessage(parsed) : Effect.void)),
        Effect.catchAll(() =>
          trimmed.startsWith("{") ? writeError(null, -32700, "Parse error") : Effect.void,
        ),
      );
    };

    const readLoop = Effect.gen(function* () {
      let buffered = "";
      while (true) {
        const chunk = yield* Effect.tryPromise(() => reader.read()).pipe(
          Effect.catchAll(() => Effect.succeed({ done: true, value: undefined })),
        );
        if (chunk.done === true) {
          if (buffered.trim().length > 0) yield* handleLine(buffered);
          yield* close;
          return;
        }
        buffered += decoder.decode(chunk.value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          yield* handleLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
    });

    yield* readLoop.pipe(Effect.forkScoped);

    const receive: McpTransportShape["receive"] = Effect.raceFirst(
      Queue.take(requests).pipe(Effect.map(Option.some)),
      Deferred.await(closed).pipe(Effect.as(Option.none<McpTransportRequest>())),
    );
    const receiveCancel: McpTransportShape["receiveCancel"] = Effect.raceFirst(
      Queue.take(cancellations).pipe(Effect.map(Option.some)),
      Deferred.await(closed).pipe(Effect.as(Option.none<string>())),
    );

    const reply = (replyMessage: McpTransportReply): Effect.Effect<void> =>
      Ref.get(correlations).pipe(
        Effect.flatMap((current) => {
          const entry = current.byInternalId.get(replyMessage.id);
          if (entry === undefined) return Effect.void;
          const output = replyMessage.ok
            ? rpcResult(entry.jsonrpcId, {
                content: [{ type: "text", text: JSON.stringify(replyMessage.result.envelope) }],
                isError: replyMessage.result.ok === false,
              })
            : rpcError(entry.jsonrpcId, -32603, errorMessage(replyMessage), errorData(replyMessage));
          return writeJson(output).pipe(Effect.zipRight(forgetCorrelation(replyMessage.id, entry)));
        }),
      );

    const notify = (notification: McpTransportNotification): Effect.Effect<void> =>
      Ref.get(correlations).pipe(
        Effect.flatMap((current) => {
          const entry = current.byInternalId.get(notification.id);
          if (entry?.progressToken === undefined) return Effect.void;
          return writeJson({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: entry.progressToken, data: notification.frame },
          });
        }),
      );

    return { receive, receiveCancel, reply, notify };
  });
