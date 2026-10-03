import { McpCommandExecutor } from "@lando/mcp/port";
import { McpRuntimeConfig, type McpRuntimeConfigShape, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

export const serverLayer = (
  config: Partial<McpRuntimeConfigShape> = {},
  secrets: ReadonlyArray<string> = [],
) =>
  McpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          McpRuntimeConfig,
          McpRuntimeConfig.of({
            commandEntries: [],
            defaultAllowlist: [],
            runtimeLayer: Layer.empty,
            ...config,
          }),
        ),
        Layer.succeed(
          McpCommandExecutor,
          McpCommandExecutor.of({ execute: (command) => Effect.exit(command) }),
        ),
        Layer.succeed(
          RedactionService,
          RedactionService.of({
            registerValues: registerRedactionValues,
            forProfile: () => Effect.succeed(createRedactor("secrets", { values: secrets })),
          }),
        ),
      ),
    ),
  );

export const startServer = Effect.fnUntraced(function* (
  capabilities: Schema.JsonObject = {},
  maxConcurrent?: number,
) {
  const service = yield* McpService;
  return yield* startStdioClient(
    service.serve({ transport: "stdio", ...(maxConcurrent === undefined ? {} : { maxConcurrent }) }),
    capabilities,
  );
});

export const eventLayer = (events: LandoEvent[]) =>
  Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.make<LandoEvent>(),
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );

export const resultObject = (message: Schema.JsonObject) =>
  Schema.decodeUnknownSync(Schema.JsonObject)(message.result);
export const toolErrorObject = (message: Schema.JsonObject) => {
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      isError: Schema.Literal(true),
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    }),
  )(message.result);
  const first = result.content[0];
  if (first === undefined) throw new Error("Expected tool error content.");
  return Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(first.text));
};
