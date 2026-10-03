import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { CORE_VERSION } from "@lando/engine/version";
import type { McpTransportError } from "@lando/sdk/errors";
import type { McpCatalog, McpServeOptions } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Context, Deferred, Effect, Fiber, Layer, Option, Semaphore, Stdio } from "effect";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import { stringifyBoundedJson } from "./bounded-json";
import { confirmationPrompt } from "./confirmation";
import type { McpDispatchDeps, McpNotify } from "./dispatch";
import { dispatchTool } from "./dispatch";
import { makeNestedExecute } from "./execute";
import { type MemoryPressureLevel, attachMemoryPressureListener } from "./memory-pressure";
import type { McpCommandExecutorShape } from "./port";
import { makeStreamFrameSink } from "./progress";
import { registerResources } from "./resources";
import type { McpRuntimeConfigShape } from "./service";
import { guardStdio } from "./stdio-guard";
import { DEFAULT_MCP_MAX_CONCURRENT, MAX_OUTSTANDING_REQUESTS, stdioTransportError } from "./stdio-limits";
import { commandResult, rejectionResult, toolOutputSchema } from "./tool-result";

export interface McpSession {
  readonly config: McpRuntimeConfigShape;
  readonly catalog: McpCatalog;
  readonly options: McpServeOptions;
  readonly deps: Omit<McpDispatchDeps, "execute" | "notify">;
  readonly executor: McpCommandExecutorShape;
  readonly redactor: Redactor;
  readonly handleMemoryPressure: (level: MemoryPressureLevel) => void;
}

export const serveSession = Effect.fn("McpService.serve")(
  function* (session: McpSession) {
    const terminal = yield* Deferred.make<void, McpTransportError>();
    const guarded = yield* guardStdio(yield* Stdio.Stdio, terminal);
    const runtime = Context.makeUnsafe<unknown>((yield* Layer.build(session.config.runtimeLayer)).mapUnsafe);
    const runtimeContext =
      session.options.cwd === undefined ? runtime : Context.add(runtime, RuntimeCwd, session.options.cwd);
    const semaphore = yield* Semaphore.make(session.options.maxConcurrent ?? DEFAULT_MCP_MAX_CONCURRENT);
    let outstanding = 0;
    const detach = attachMemoryPressureListener(session.handleMemoryPressure);
    yield* Effect.addFinalizer(() => Effect.sync(detach));
    const context = yield* Layer.build(
      McpServer.layerStdio({
        name: "lando",
        version: session.config.version ?? CORE_VERSION,
        protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
      }).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, guarded))),
    ).pipe(Effect.forkScoped, Effect.flatMap(Fiber.join));
    const server = Context.get(context, McpServer.McpServer);
    for (const descriptor of session.catalog.tools) {
      const entry = session.deps.registry.get(descriptor.toolId);
      if (entry === undefined) continue;
      const handle = Effect.fn("McpService.callTool")(
        function* (input: unknown) {
          const busy = outstanding >= MAX_OUTSTANDING_REQUESTS;
          outstanding++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              outstanding--;
            }),
          );
          const request = yield* McpSchema.McpRequestContext;
          let progress = 0;
          const notify: McpNotify = Effect.fnUntraced(function* (frame) {
            const token = request.requestMetadata?.progressToken;
            if (typeof token !== "string" && typeof token !== "number") return;
            const message = yield* stringifyBoundedJson(frame, "MCP progress payload");
            yield* server.notifications["notifications/progress"]({
              progressToken: token,
              progress: ++progress,
              message,
            });
          });
          const prompt = yield* confirmationPrompt();
          const callContext = Option.isSome(prompt)
            ? Context.add(runtimeContext, ConfirmationPrompt, prompt.value)
            : runtimeContext;
          const nested = makeNestedExecute(
            callContext,
            makeStreamFrameSink(notify, session.redactor),
            session.executor,
          );
          const execute: McpDispatchDeps["execute"] = (entry, runInput) =>
            semaphore.withPermits(1)(nested(entry, runInput));
          const decodedInput = yield* Effect.try({
            try: () => SchemaInput(input),
            catch: () => stdioTransportError("MCP tool arguments must be an object."),
          });
          return yield* dispatchTool(
            { toolId: descriptor.toolId, input: decodedInput },
            {
              ...session.deps,
              execute,
              notify,
              ...(busy ? { rejection: stdioTransportError("Server busy") } : {}),
            },
          ).pipe(Effect.flatMap(commandResult));
        },
        Effect.catch((error) => rejectionResult(error, session.redactor).pipe(Effect.orDie)),
        Effect.scoped,
      );
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: descriptor.toolId,
          title: descriptor.title,
          description: descriptor.description,
          inputSchema: SchemaToolInput(descriptor.inputSchema),
          outputSchema: toolOutputSchema(entry.spec.resultSchema),
        }),
        annotations: Context.empty(),
        handle,
      });
    }
    yield* registerResources(session.config.resources ?? [], runtimeContext, session.redactor).pipe(
      Effect.provideService(McpServer.McpServer, server),
    );
    yield* Deferred.await(terminal);
  },
  Effect.scoped,
  Effect.catchTag("IllegalArgumentError", (error) => Effect.fail(stdioTransportError(error.message))),
);

import { Schema } from "effect";
import type { McpToolInput } from "./registry";
const SchemaInput = (input: unknown): McpToolInput =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(input ?? {});
const SchemaToolInput = Schema.decodeUnknownSync(McpSchema.ToolJson);
