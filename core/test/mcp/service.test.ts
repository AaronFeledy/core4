import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Schema } from "effect";

import type { McpServeOptions } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import { StreamFrameSink } from "../../src/cli/stream-frame-sink.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { MAX_OUTBOUND_QUEUED_BYTES } from "../../src/mcp/stdio-limits.ts";
import { McpTransport, makeInMemoryTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { RuntimeCwd } from "../../src/runtime/cwd.ts";

const spec = (
  id: string,
  run: LandoCommandSpec["run"],
  extra: Partial<LandoCommandSpec> = {},
): LandoCommandSpec => ({
  id,
  summary: `${id} summary`,
  namespace: id.split(":")[0] as LandoCommandSpec["namespace"],
  bootstrap: "app",
  resultSchema: EmptyResultSchema,
  run,
  ...extra,
});

const redactionLayer = (values: ReadonlyArray<string> = []) =>
  Layer.succeed(RedactionService, {
    forProfile: () => Effect.succeed(createRedactor("secrets", { values })),
  });

const configLayer = (config: McpRuntimeConfigShape) => Layer.succeed(McpRuntimeConfig, config);

const serviceLayer = (config: McpRuntimeConfigShape, redactedValues: ReadonlyArray<string> = []) =>
  McpServiceLive.pipe(Layer.provide(Layer.mergeAll(configLayer(config), redactionLayer(redactedValues))));

const dispatchAndCollectReplies = ({
  config,
  options,
  toolId,
  redactedValues = [],
}: {
  readonly config: McpRuntimeConfigShape;
  readonly options: McpServeOptions;
  readonly toolId: string;
  readonly redactedValues?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const inmem = yield* makeInMemoryTransport();
    const service = yield* McpService;
    const fiber = yield* service
      .serve(options)
      .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
    yield* inmem.push({ toolId });
    while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
    const replies = yield* inmem.replies;
    yield* inmem.close;
    yield* Fiber.join(fiber);
    return replies;
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(config, redactedValues)));

describe("McpService.catalog", () => {
  test("lists the effective allowlist as tools", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        { spec: spec("app:info", () => Effect.succeed({})) },
        { spec: spec("app:destroy", () => Effect.succeed({})) },
      ],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };
    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpService;
        return yield* service.catalog();
      }).pipe(Effect.provide(serviceLayer(config))),
    );
    expect(catalog.tools.map((tool) => tool.toolId)).toEqual(["app:info"]);
  });

  test("lists tooling entries only when tooling is enabled and not denied", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: spec("app:info", () => Effect.succeed({})) }],
      toolingEntries: [{ spec: spec("app:php", () => Effect.succeed({})) } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpService;
        return yield* service.catalog({ tooling: true, deny: ["app:php"] });
      }).pipe(Effect.provide(serviceLayer(config))),
    );

    expect(catalog.tools.map((tool) => tool.toolId)).toEqual(["app:info"]);
  });
});

describe("McpService.serve", () => {
  test("dispatches tooling entries when tooling is enabled", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [],
      toolingEntries: [{ spec: spec("app:php", () => Effect.succeed({})) } satisfies McpCommandEntry],
      defaultAllowlist: [],
      runtimeLayer: Layer.empty,
    };

    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({
        config,
        options: { transport: "stdio", tooling: true },
        toolId: "app:php",
      }),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true });
  });

  test("rejects a denied tooling entry when tooling is enabled", async () => {
    let executed = false;
    const config: McpRuntimeConfigShape = {
      commandEntries: [],
      toolingEntries: [
        {
          spec: spec("app:php", () =>
            Effect.sync(() => {
              executed = true;
              return {};
            }),
          ),
        },
      ],
      defaultAllowlist: [],
      runtimeLayer: Layer.empty,
    };

    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({
        config,
        options: { transport: "stdio", tooling: true, deny: ["app:php"] },
        toolId: "app:php",
      }),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(executed).toBe(false);
  });

  test("forwards live StreamFrameSink output as MCP notifications", async () => {
    const secret = "stream-secret";
    const streaming = spec("app:logs", () =>
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: `line-one ${secret}`, service: "web" });
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: streaming } satisfies McpCommandEntry],
      defaultAllowlist: ["app:logs"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      yield* inmem.push({ toolId: "app:logs" });
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      const notifications = yield* inmem.notifications;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return notifications;
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config, [secret])));

    const notifications = await Effect.runPromise(program);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications[0])).toContain("[redacted]");
    expect(JSON.stringify(notifications[0])).not.toContain(secret);
  });

  test("propagates an oversized live frame as a tagged command failure", async () => {
    // Given
    const streaming = spec("app:logs", () =>
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1) });
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: streaming } satisfies McpCommandEntry],
      defaultAllowlist: ["app:logs"],
      runtimeLayer: Layer.empty,
    };

    // When
    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({ config, options: { transport: "stdio" }, toolId: "app:logs" }),
    );

    // Then
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      ok: true,
      result: { ok: false, envelope: { error: { _tag: "McpTransportError" } } },
    });
  });

  test("fails an aggregate oversized result and accepts the follow-up request", async () => {
    // Given
    let calls = 0;
    const command = spec(
      "app:info",
      () =>
        Effect.sync(() => {
          calls += 1;
          return { chunks: calls === 1 ? Array.from({ length: 1_100_000 }, () => 1_000_000) : [1] };
        }),
      { resultSchema: Schema.Struct({ chunks: Schema.Array(Schema.Number) }) },
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: command } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    // When
    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const inmem = yield* makeInMemoryTransport();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
        yield* inmem.push({ toolId: "app:info" });
        while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
        yield* inmem.push({ toolId: "app:info" });
        while ((yield* inmem.replies).length < 2) yield* Effect.sleep("10 millis");
        const observed = yield* inmem.replies;
        yield* inmem.close;
        yield* Fiber.join(fiber);
        return observed;
      }).pipe(Effect.scoped, Effect.provide(serviceLayer(config))),
    );

    // Then
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ ok: false, error: { _tag: "McpTransportError" } });
    expect(replies[1]).toMatchObject({ ok: true, result: { envelope: { result: { chunks: [1] } } } });
  });

  test("fails before retaining a canonical one-character secret expansion", async () => {
    // Given
    const command = spec("app:info", () => Effect.succeed({ note: "a".repeat(900_000) }), {
      resultSchema: Schema.Struct({ note: Schema.String }),
    });
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: command } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    // When
    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({
        config,
        options: { transport: "stdio" },
        toolId: "app:info",
        redactedValues: ["a"],
      }),
    );

    // Then
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: false, error: { _tag: "McpTransportError" } });
  });

  test("rejects exotic result hooks without executing them", async () => {
    // Given
    let getterCalls = 0;
    let toJsonCalls = 0;
    const command = spec(
      "app:info",
      () =>
        Effect.succeed({
          get value(): string {
            getterCalls += 1;
            return "not-read";
          },
          toJSON: () => {
            toJsonCalls += 1;
            return { unsafe: true };
          },
        }),
      { resultSchema: Schema.Unknown },
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: command } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    // When
    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({ config, options: { transport: "stdio" }, toolId: "app:info" }),
    );

    // Then
    expect(replies[0]).toMatchObject({ ok: false, error: { _tag: "McpTransportError" } });
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  test("returns a failure envelope when a command dies", async () => {
    const dying = spec("app:info", () => Effect.die(new Error("boom")));
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: dying } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    const replies = await Effect.runPromise(
      dispatchAndCollectReplies({ config, options: { transport: "stdio" }, toolId: "app:info" }),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, result: { ok: false } });
  });

  test("resolves command runtime cwd from per-call appPath", async () => {
    const command = spec("app:info", () => RuntimeCwd.pipe(Effect.map((cwd) => ({ cwd }))));
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: command } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.succeed(RuntimeCwd, "/session-root"),
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      yield* inmem.push({ toolId: "app:info", input: { appPath: "/per-call-root" } });
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return replies;
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const replies = await Effect.runPromise(program);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      ok: true,
      result: { envelope: { ok: true, result: { cwd: "/per-call-root" } } },
    });
  });

  test("caps concurrency at mcp.maxConcurrent", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = spec("app:exec", () =>
      Effect.gen(function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.promise(() => gate);
        active -= 1;
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: blocking } satisfies McpCommandEntry],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio", maxConcurrent: 2 })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      for (let index = 0; index < 5; index += 1) yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("80 millis");
      const observedMax = maxActive;
      const observedActive = active;
      release();
      while ((yield* inmem.replies).length < 5) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { observedMax, observedActive, replies: replies.length };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const outcome = await Effect.runPromise(program);
    expect(outcome.observedMax).toBe(2);
    expect(outcome.observedActive).toBe(2);
    expect(outcome.replies).toBe(5);
  });

  test("interrupts and finalizes in-flight calls when the transport closes", async () => {
    let finalized = false;
    const hanging = spec("app:exec", () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: hanging } satisfies McpCommandEntry],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("50 millis");
      yield* inmem.close;
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    await Effect.runPromise(program);
    expect(finalized).toBe(true);
  });
});
