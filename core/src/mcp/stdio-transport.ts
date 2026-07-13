import { Deferred, Effect, Queue, Ref, Scope } from "effect";

import type { McpTransportError } from "@lando/sdk/errors";
import type { McpCatalog } from "@lando/sdk/schema";

import { MAX_OUTSTANDING_REQUESTS, MAX_PENDING_CANCELLATIONS, stdioTransportError } from "./stdio-limits.ts";
import { runStdioReader, takeUntilTerminal } from "./stdio-reader.ts";
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
import { makeStdioWriter, makeStdoutLineWriter } from "./stdio-writer.ts";
import type {
  McpTransportNotification,
  McpTransportReply,
  McpTransportRequest,
  McpTransportShape,
} from "./transport.ts";

export interface StdioTransportOptions {
  readonly catalog: McpCatalog;
  readonly input?: ReadableStream<Uint8Array>;
  readonly write?: (line: string) => Effect.Effect<void, unknown>;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly protocolVersion?: string;
}

interface CorrelationEntry {
  readonly jsonrpcId: JsonRpcId;
  readonly progressToken?: ProgressToken;
  readonly progress?: number;
}

interface CorrelationState {
  readonly byInternalId: ReadonlyMap<string, CorrelationEntry>;
  readonly byJsonrpcId: ReadonlyMap<string, string>;
}

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_SERVER_INFO = { name: "lando", version: "4.0.0" } as const;

const progressTokenFromParams = (params: JsonObject | undefined): ProgressToken | undefined =>
  progressTokenFrom(objectField(params ?? {}, "_meta")?.progressToken);

export const makeStdioMcpTransport = (
  options: StdioTransportOptions,
): Effect.Effect<McpTransportShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const reader = (options.input ?? Bun.stdin.stream()).getReader();
    const requests = yield* Queue.unbounded<McpTransportRequest>();
    const cancellations = yield* Queue.dropping<string>(MAX_PENDING_CANCELLATIONS);
    const terminal = yield* Deferred.make<void, McpTransportError>();
    const counter = yield* Ref.make(0);
    const correlations = yield* Ref.make<CorrelationState>({
      byInternalId: new Map(),
      byJsonrpcId: new Map(),
    });
    const writeLine = options.write === undefined ? yield* makeStdoutLineWriter() : options.write;
    const writer = yield* makeStdioWriter({ writeLine, terminal });
    const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;

    const writeJson = (message: JsonObject): Effect.Effect<void, McpTransportError> =>
      writer.write(JSON.stringify(message));
    const writeError = (id: JsonRpcId, code: number, message: string, data?: unknown) =>
      writeJson(rpcError(id, code, message, data));

    const forgetCorrelation = (internalId: string, entry: CorrelationEntry): Effect.Effect<void> =>
      Ref.update(correlations, (current) => {
        const byInternalId = new Map(current.byInternalId);
        const byJsonrpcId = new Map(current.byJsonrpcId);
        byInternalId.delete(internalId);
        byJsonrpcId.delete(idKey(entry.jsonrpcId));
        return { byInternalId, byJsonrpcId };
      });

    const incrementProgress = (internalId: string, entry: CorrelationEntry): Effect.Effect<number> =>
      Ref.updateAndGet(correlations, (current) => {
        const progress = (entry.progress ?? 0) + 1;
        return {
          byInternalId: new Map(current.byInternalId).set(internalId, { ...entry, progress }),
          byJsonrpcId: current.byJsonrpcId,
        };
      }).pipe(Effect.map((current) => current.byInternalId.get(internalId)?.progress ?? 1));

    const enqueueToolCall = (id: JsonRpcId, params: JsonObject | undefined) => {
      const toolId = params === undefined ? undefined : stringField(params, "name");
      if (toolId === undefined) return writeError(id, -32602, "Invalid params");
      return Effect.gen(function* () {
        const internalId = `req-${yield* Ref.updateAndGet(counter, (value) => value + 1)}`;
        const progressToken = progressTokenFromParams(params);
        const entry: CorrelationEntry =
          progressToken === undefined ? { jsonrpcId: id } : { jsonrpcId: id, progressToken };
        const accepted = yield* Ref.modify(correlations, (current) => {
          if (current.byInternalId.size >= MAX_OUTSTANDING_REQUESTS) return [false, current];
          return [
            true,
            {
              byInternalId: new Map(current.byInternalId).set(internalId, entry),
              byJsonrpcId: new Map(current.byJsonrpcId).set(idKey(id), internalId),
            },
          ];
        });
        if (!accepted) return yield* writeError(id, -32000, "Server busy");
        const input = toolInputFrom(objectField(params ?? {}, "arguments"));
        yield* Queue.offer(requests, {
          id: internalId,
          request: {
            toolId,
            ...(input === undefined ? {} : { input }),
          },
        });
      });
    };

    const cancelToolCall = (params: JsonObject | undefined): Effect.Effect<void, McpTransportError> =>
      Effect.gen(function* () {
        const requestId = jsonRpcIdFrom(params?.requestId);
        if (requestId === undefined) return;
        const current = yield* Ref.get(correlations);
        const internalId = current.byJsonrpcId.get(idKey(requestId));
        if (internalId === undefined) return;
        if (yield* Queue.offer(cancellations, internalId)) return;
        const error = stdioTransportError("MCP stdio cancellation queue exceeded 256 pending entries.");
        yield* Deferred.fail(terminal, error);
        return yield* Effect.fail(error);
      });

    const handleMessage = (message: JsonObject): Effect.Effect<void, McpTransportError> => {
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

    const handleFrame = (line: string): Effect.Effect<void, McpTransportError> =>
      parseJsonLine(line.trim()).pipe(
        Effect.catchAll(() => {
          const error = stdioTransportError("MCP stdio received malformed JSON.");
          return writeError(null, -32700, "Parse error").pipe(Effect.zipRight(Effect.fail(error)));
        }),
        Effect.flatMap((parsed) => (isJsonObject(parsed) ? handleMessage(parsed) : Effect.void)),
      );

    yield* runStdioReader({
      reader: {
        read: async () => {
          const result = await reader.read();
          return { done: result.done, value: result.value };
        },
      },
      terminal,
      onFrame: handleFrame,
    }).pipe(Effect.forkScoped);
    yield* Scope.addFinalizer(
      yield* Effect.scope,
      Deferred.succeed(terminal, undefined).pipe(
        Effect.zipRight(Queue.shutdown(requests)),
        Effect.zipRight(Queue.shutdown(cancellations)),
        Effect.zipRight(Effect.promise(() => reader.cancel()).pipe(Effect.ignore)),
      ),
    );

    const reply = (replyMessage: McpTransportReply): Effect.Effect<void, McpTransportError> =>
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

    const notify = (notification: McpTransportNotification): Effect.Effect<void, McpTransportError> =>
      Ref.get(correlations).pipe(
        Effect.flatMap((current) => {
          const entry = current.byInternalId.get(notification.id);
          if (entry?.progressToken === undefined) return Effect.void;
          return incrementProgress(notification.id, entry).pipe(
            Effect.flatMap((progress) =>
              writeJson({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken: entry.progressToken,
                  progress,
                  message: JSON.stringify(notification.frame),
                  data: notification.frame,
                },
              }),
            ),
          );
        }),
      );

    return {
      receive: takeUntilTerminal(requests, terminal),
      receiveCancel: takeUntilTerminal(cancellations, terminal),
      reply,
      notify,
    };
  });
