import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import * as RendererStdio from "@lando/renderer/stdio";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { TestMcpCommandExecutor } from "../executor";

// Diagnostics are a test-only side channel; stdout belongs exclusively to MCP.
const record = (value: Schema.JsonObject) =>
  Effect.sync(() => {
    process.stderr.write(`${JSON.stringify(value)}\n`);
  });

const follow = (kind: "tool" | "resource") =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.yieldNow.pipe(Effect.andThen(record({ event: "finalized", kind }))),
      );
      yield* record({ event: "started", kind });
      return yield* Effect.never;
    }),
  );

const services = McpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestMcpCommandExecutor,
      Layer.succeed(RedactionService, makeRedactionService()),
      Layer.succeed(McpRuntimeConfig, {
        commandEntries: [
          {
            spec: {
              id: "app:logs",
              summary: "Follow until abandoned",
              resultSchema: Schema.Struct({}),
              run: () => follow("tool"),
            },
          },
          {
            spec: {
              id: "app:info",
              summary: "Return a deterministic payload",
              resultSchema: Schema.Struct({ value: Schema.String, items: Schema.Array(Schema.Number) }),
              run: () => Effect.succeed({ value: "real-pipe", items: [2, 7] }),
            },
          },
          {
            spec: {
              id: "app:exec",
              summary: "Must stay queued behind the follow call",
              resultSchema: Schema.Struct({}),
              run: () => record({ event: "queuedExecuted" }).pipe(Effect.as({})),
            },
          },
        ],
        defaultAllowlist: ["app:logs", "app:info", "app:exec"],
        runtimeLayer: Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Effect.yieldNow.pipe(Effect.andThen(record({ event: "finalized", kind: "runtime" }))),
          ),
        ),
        resources: [
          {
            uri: "lando://real-pipe/follow",
            name: "Follow",
            description: "Resource with yielding cleanup",
            resultSchema: Schema.Struct({}),
            read: follow("resource"),
          },
        ],
      }),
    ),
  ),
);

const sigterm = Effect.callback<never>((resume) => {
  const signals: NodeJS.EventEmitter = process;
  const onSignal = () => resume(Effect.interrupt);
  signals.once("SIGTERM", onSignal);
  return Effect.sync(() => signals.removeListener("SIGTERM", onSignal));
});
const serve = Effect.scoped(
  Effect.gen(function* () {
    const service = yield* McpService;
    yield* service.serve({ transport: "stdio", maxConcurrent: 1 });
  }),
).pipe(Effect.provide(services), Effect.provide(RendererStdio.layer));

// Effect.never alone need not hold Bun's event loop open after stdin closes.
// A broken shutdown must time out in the parent, not masquerade as a clean exit.
const keepalive = setInterval(() => {}, 1_000);
Effect.runPromiseExit(Effect.raceFirst(sigterm, serve))
  .then((exit) =>
    Effect.runPromise(
      record(
        Exit.isFailure(exit)
          ? {
              event: "serverExit",
              exit: exit._tag,
              interruptedOnly: Cause.hasInterruptsOnly(exit.cause),
              cause: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(exit.cause))),
            }
          : { event: "serverExit", exit: exit._tag },
      ),
    ),
  )
  .finally(() => clearInterval(keepalive));
