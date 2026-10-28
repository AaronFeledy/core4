import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Queue, Schema, Stdio, Stream } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import type { McpServeOptions } from "@lando/sdk/schema";
import { EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";

import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import type { McpCommandEntry, McpToolInput } from "@lando/mcp/registry";
import { McpRuntimeConfig, type McpRuntimeConfigShape, McpService } from "@lando/mcp/service";
import { MAX_OUTBOUND_QUEUED_BYTES } from "@lando/mcp/stdio-limits";
import { makeStdioClient } from "@lando/mcp/testing";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { PluginRegistry } from "@lando/sdk/services";
import { runCommandLifecycle } from "../../src/cli/command-lifecycle.ts";
import { versionSpec } from "../../src/cli/command-specs/meta/version.ts";
import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/spec/command-base.ts";
import { serviceLayer as mcpServiceLayer } from "../../src/mcp-command-executor.ts";
import { mcpAppCommandEntries, mcpAppContextForCwd } from "../../src/mcp/mcp-app-context.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

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
  Layer.effect(
    RedactionService,
    Effect.gen(function* () {
      const service = makeRedactionService();
      yield* service.registerValues(values);
      return service;
    }),
  );

const configLayer = (config: McpRuntimeConfigShape) =>
  Layer.succeed(McpRuntimeConfig, McpRuntimeConfig.of(config));

const serviceLayer = (config: McpRuntimeConfigShape, redactedValues: ReadonlyArray<string> = []) =>
  mcpServiceLayer.pipe(Layer.provide(Layer.mergeAll(configLayer(config), redactionLayer(redactedValues))));

const recordingEventLayer = (events: LandoEvent[]) => {
  const service: EventServiceShape = EventService.of({
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.gen(function* () {
      return yield* Queue.unbounded<LandoEvent>();
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
  return Layer.succeed(EventService, service);
};

const dispatchAndCollectReplies = Effect.fnUntraced(
  function* ({
    options,
    toolId,
    input,
  }: {
    readonly config: McpRuntimeConfigShape;
    readonly options: McpServeOptions;
    readonly toolId: string;
    readonly input?: McpToolInput;
    readonly redactedValues?: ReadonlyArray<string>;
  }) {
    const inmem = yield* makeStdioClient();
    const service = yield* McpService;
    const fiber = yield* service
      .serve(options)
      .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
    yield* inmem.push({ toolId, ...(input === undefined ? {} : { input }) });
    while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
    const replies = yield* inmem.replies;
    yield* inmem.close;
    yield* Fiber.join(fiber);
    return replies;
  },
  Effect.scoped,
  (effect, { config, redactedValues = [] }) => Effect.provide(effect, serviceLayer(config, redactedValues)),
);

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

  test("app command wrappers appear in the catalog and respect deny", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [],
      defaultAllowlist: [],
      runtimeLayer: Layer.empty,
      appContextForCwd: (base) => Effect.succeed(base),
      appCommandEntries: () => Effect.succeed([]),
    };
    const catalogs = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpService;
        return [yield* service.catalog(), yield* service.catalog({ deny: ["app:commands:call"] })];
      }).pipe(Effect.provide(serviceLayer(config))),
    );
    expect(catalogs[0]?.tools.map((tool) => tool.toolId)).toEqual(["app:commands:call", "app:commands:list"]);
    expect(catalogs[1]?.tools.map((tool) => tool.toolId)).toEqual(["app:commands:list"]);
  });

  test("app command calls enforce inner deny, wrapper input, and forbidden self-allow", async () => {
    const safe = spec("example:safe", () => Effect.succeed({ safe: true }), {
      mcpAllowed: true,
      resultSchema: Schema.Unknown,
    });
    const configFor = (command: LandoCommandSpec): McpRuntimeConfigShape => ({
      commandEntries: [],
      defaultAllowlist: [],
      runtimeLayer: Layer.empty,
      appContextForCwd: (base) => Effect.succeed(base),
      appCommandEntries: () => Effect.succeed([{ spec: command }]),
    });
    const call = (config: McpRuntimeConfigShape, options: McpServeOptions, input: McpToolInput) =>
      Effect.runPromise(
        dispatchAndCollectReplies({
          config,
          options,
          toolId: "app:commands:call",
          input,
        }),
      );
    const target = { appPath: "/fixture", commandId: safe.id };

    const denied = await call(configFor(safe), { transport: "stdio", deny: [safe.id] }, target);
    expect(denied[0]).toMatchObject({ ok: false, error: { _tag: "McpToolNotAllowedError" } });

    const optedOut = await call(configFor({ ...safe, mcpAllowed: false }), { transport: "stdio" }, target);
    expect(optedOut[0]).toMatchObject({ ok: false, error: { _tag: "McpToolNotAllowedError" } });

    for (const input of [
      { ...target, flags: 3 },
      { ...target, args: [] },
      { ...target, extraneous: true },
    ]) {
      const rejected = await call(configFor(safe), { transport: "stdio" }, input as McpToolInput);
      expect(rejected[0]).toMatchObject({ ok: false, error: { _tag: "McpToolInputError" } });
    }

    const forbidden = spec("meta:plugin:unsafe", () => Effect.succeed({}), { mcpAllowed: true });
    const unsafe = await call(
      configFor(forbidden),
      { transport: "stdio" },
      {
        appPath: "/fixture",
        commandId: forbidden.id,
      },
    );
    expect(unsafe[0]).toMatchObject({ ok: false, error: { _tag: "McpToolInputError" } });
  });

  test("an in-flight app command keeps its selected spec while another app changes", async () => {
    let releaseLeft: () => void = () => {};
    let signalLeftStarted: () => void = () => {};
    const leftStarted = new Promise<void>((resolve) => {
      signalLeftStarted = resolve;
    });
    const leftGate = new Promise<void>((resolve) => {
      releaseLeft = resolve;
    });
    let rightLabel = "right-before";
    const config: McpRuntimeConfigShape = {
      commandEntries: [],
      defaultAllowlist: [],
      runtimeLayer: Layer.empty,
      appContextForCwd: (base) => Effect.succeed(base),
      appCommandEntries: (_context) => {
        const label = rightLabel;
        const command = spec(
          "example:held",
          () =>
            label === "left"
              ? Effect.promise(async () => {
                  signalLeftStarted();
                  await leftGate;
                  return { label };
                })
              : Effect.succeed({ label }),
          { mcpAllowed: true, resultSchema: Schema.Unknown },
        );
        return Effect.succeed([{ spec: command }]);
      },
    };

    try {
      const replies = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const inmem = yield* makeStdioClient();
            const service = yield* McpService;
            const fiber = yield* service
              .serve({ transport: "stdio", maxConcurrent: 2 })
              .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
            rightLabel = "left";
            const leftId = yield* inmem.push({
              toolId: "app:commands:call",
              input: { appPath: "/left", commandId: "example:held" },
            });
            yield* Effect.promise(() => leftStarted);
            rightLabel = "right-after";
            const rightId = yield* inmem.push({
              toolId: "app:commands:call",
              input: { appPath: "/right", commandId: "example:held" },
            });
            while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
            releaseLeft();
            while ((yield* inmem.replies).length < 2) yield* Effect.sleep("10 millis");
            const observed = yield* inmem.replies;
            yield* inmem.close;
            yield* Fiber.join(fiber);
            return {
              left: observed.find((reply) => reply.id === leftId),
              right: observed.find((reply) => reply.id === rightId),
            };
          }).pipe(Effect.provide(serviceLayer(config))),
        ),
      );
      expect(replies.left).toMatchObject({ result: { envelope: { result: { label: "left" } } } });
      expect(replies.right).toMatchObject({ result: { envelope: { result: { label: "right-after" } } } });
    } finally {
      releaseLeft();
    }
  });
});

describe("McpService.serve", () => {
  test("dispatches real meta:version with stable nested lifecycle correlation", async () => {
    // Given: the production meta:version spec served beneath one outer meta:mcp invocation.
    const events: LandoEvent[] = [];
    const eventLayer = recordingEventLayer(events);
    const runtimeLayer = Layer.mergeAll(eventLayer, redactionLayer());
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: versionSpec }],
      defaultAllowlist: [versionSpec.id],
      runtimeLayer,
    };
    const layer = Layer.mergeAll(eventLayer, redactionLayer(), serviceLayer(config));

    // When: MCP dispatches the real canonical program and the transport closes.
    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const inmem = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* runCommandLifecycle(
          service.serve({ transport: "stdio" }).pipe(Effect.provideService(Stdio.Stdio, inmem.stdio)),
          {
            invocation: {
              commandId: "meta:mcp",
              argv: [],
              args: {},
              flags: {},
              cwd: "/workspace",
              invocationId: "outer-id",
            },
          },
        ).pipe(Effect.forkScoped);
        yield* inmem.push({ toolId: versionSpec.id });
        while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
        const observed = yield* inmem.replies;
        yield* inmem.close;
        yield* Fiber.join(fiber);
        return observed;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // Then: the inner lifecycle has one fresh id correlated to the stable outer id.
    expect(replies[0]).toMatchObject({ ok: true, result: { ok: true } });
    const lifecycle = events.filter((event) => event._tag.startsWith("cli-"));
    expect(lifecycle.map((event) => event._tag)).toEqual([
      "cli-meta:mcp-init",
      "cli-meta:version-init",
      "cli-meta:version-run",
      "cli-meta:mcp-run",
    ]);
    expect(lifecycle[0]).toMatchObject({ invocationId: "outer-id" });
    expect(lifecycle[0]?.parentInvocationId).toBeUndefined();
    expect(lifecycle[3]).toMatchObject({ invocationId: "outer-id" });
    expect(lifecycle[3]?.parentInvocationId).toBeUndefined();
    const nestedId = lifecycle[1]?.invocationId;
    expect(nestedId).toBeDefined();
    expect(nestedId).not.toBe("outer-id");
    expect(lifecycle[1]).toMatchObject({ invocationId: nestedId, parentInvocationId: "outer-id" });
    expect(lifecycle[2]).toMatchObject({ invocationId: nestedId, parentInvocationId: "outer-id" });
  });

  test("keeps nested init and error correlation stable when MCP canonical execution fails", async () => {
    // Given: a registered canonical program that fails with an existing tagged error.
    const events: LandoEvent[] = [];
    const eventLayer = recordingEventLayer(events);
    const runtimeLayer = Layer.mergeAll(eventLayer, redactionLayer());
    const failing = spec("app:info", () =>
      Effect.fail(
        new NotImplementedError({
          commandId: "app:info",
          message: "Fixture command failed.",
          remediation: "Use the successful fixture command.",
        }),
      ),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: failing }],
      defaultAllowlist: [failing.id],
      runtimeLayer,
    };
    const layer = Layer.mergeAll(eventLayer, redactionLayer(), serviceLayer(config));

    // When: MCP executes the failing program beneath the outer invocation.
    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const inmem = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* runCommandLifecycle(
          service.serve({ transport: "stdio" }).pipe(Effect.provideService(Stdio.Stdio, inmem.stdio)),
          {
            invocation: {
              commandId: "meta:mcp",
              argv: [],
              args: {},
              flags: {},
              cwd: "/workspace",
              invocationId: "outer-id",
            },
          },
        ).pipe(Effect.forkScoped);
        yield* inmem.push({ toolId: failing.id });
        while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
        const observed = yield* inmem.replies;
        yield* inmem.close;
        yield* Fiber.join(fiber);
        return observed;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // Then: the command failure is observable and correlated without failing the MCP transport.
    expect(replies[0]).toMatchObject({ ok: true, result: { ok: false } });
    const lifecycle = events.filter((event) => event._tag.startsWith("cli-"));
    expect(lifecycle.map((event) => event._tag)).toEqual([
      "cli-meta:mcp-init",
      "cli-app:info-init",
      "cli-app:info-error",
      "cli-meta:mcp-run",
    ]);
    const nestedId = lifecycle[1]?.invocationId;
    expect(nestedId).toBeDefined();
    expect(lifecycle[1]).toMatchObject({ invocationId: nestedId, parentInvocationId: "outer-id" });
    expect(lifecycle[2]).toMatchObject({ invocationId: nestedId, parentInvocationId: "outer-id" });
  });

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
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: `line-one ${secret}`, service: "web" });
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: streaming } satisfies McpCommandEntry],
      defaultAllowlist: ["app:logs"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeStdioClient();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
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

  test("segments an oversized record and retains a bounded truncated final tail", async () => {
    // Given
    const streaming = spec("app:logs", () =>
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stdout",
          chunk: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1),
        });
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
      result: { ok: true, envelope: { output: { truncated: true } } },
    });
    expect(Buffer.byteLength(JSON.stringify(replies))).toBeLessThan(128 * 1024);
  });

  test("rejects a hostile live frame without invoking its getter", async () => {
    // Given
    let getterCalls = 0;
    const streaming = spec("app:logs", () =>
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stdout",
          get chunk(): string {
            getterCalls += 1;
            return "not-read";
          },
        });
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
    expect(getterCalls).toBe(0);
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
        const inmem = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
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
      const inmem = yield* makeStdioClient();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
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

  test("resolves app-local command, service type, and app feature contributions for each appPath", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-mcp-app-contributions-"));
    const sessionRoot = join(root, "session");
    const appRoot = (name: string) => join(root, name);
    const writeApp = async (name: string) => {
      const app = appRoot(name);
      const pluginsRoot = join(app, ".lando", "plugins");
      const packageRoot = join(pluginsRoot, name);
      const pluginName = `@example/${name}`;
      const typeId = `example:${name}-type`;
      const featureId = `example:${name}-feature`;
      const commandId = "example:shared-command";
      const extraCommandId = name === "right" ? "example:right-only" : undefined;
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(app, ".lando.yml"), `name: ${name}\n`);
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: pluginName,
          version: "1.0.0",
          landoPlugin: {
            name: pluginName,
            version: "1.0.0",
            api: 4,
            entry: "./entry.mjs",
            contributes: {
              commands: extraCommandId === undefined ? [commandId] : [commandId, extraCommandId],
              serviceTypes: [typeId],
              appFeatures: [featureId],
            },
          },
        }),
      );
      await writeFile(
        join(packageRoot, "entry.mjs"),
        [
          `import { Effect, Schema } from ${JSON.stringify(import.meta.resolve("effect"))};`,
          `export const commands = new Map([[${JSON.stringify(commandId)}, async () => ({`,
          `  id: ${JSON.stringify(commandId)}, summary: ${JSON.stringify(name)}, namespace: "example", bootstrap: "plugins", mcpAllowed: true,`,
          `  flags: { ${name}: { type: "string", required: true } },`,
          `  resultSchema: Schema.Struct({ ${name}: Schema.String }),`,
          `  run: (input) => Effect.succeed({ ${name}: input.flags.${name} }),`,
          "})]]);",
          ...(extraCommandId === undefined
            ? []
            : [
                `commands.set(${JSON.stringify(extraCommandId)}, async () => ({`,
                `  id: ${JSON.stringify(extraCommandId)}, summary: "Right only", namespace: "example", bootstrap: "plugins", mcpAllowed: true,`,
                `  flags: { label: { type: "string", required: true, default: "fallback", parse: (value) => value.toUpperCase() } },`,
                "  resultSchema: Schema.Struct({ label: Schema.String }),",
                "  run: (input) => Effect.succeed({ label: input.flags.label }),",
                `  completion: (_value, input) => ({ ok: input.flags.label === "FALLBACK", exitCode: input.flags.label === "FALLBACK" ? 0 : 1 }),`,
                "}));",
              ]),
          `export const serviceTypes = new Map([[${JSON.stringify(typeId)}, { id: ${JSON.stringify(typeId)}, resolve: () => undefined }]]);`,
          `export const appFeatures = new Map([[${JSON.stringify(featureId)}, { id: ${JSON.stringify(featureId)}, priority: 0, activatedBy: [], apply: () => undefined }]]);`,
        ].join("\n"),
      );
      await writeFile(
        join(pluginsRoot, "registry.json"),
        JSON.stringify({ [pluginName]: { name: pluginName, version: "1.0.0", path: packageRoot } }),
      );
      return {
        app,
        pluginName,
        typeId,
        featureId,
        commandId,
        commandIds: extraCommandId === undefined ? [commandId] : [commandId, extraCommandId],
        extraCommandId,
      };
    };

    try {
      await mkdir(sessionRoot);
      const left = await writeApp("left");
      const right = await writeApp("right");
      const rightOnly = right.extraCommandId;
      if (rightOnly === undefined) throw new Error("Expected a right-only plugin command.");
      const command = spec(
        "app:info",
        () =>
          Effect.gen(function* () {
            const graph = yield* PluginContributionGraph;
            const registry = yield* PluginRegistry;
            const appPlugin = graph.plugins.find((plugin) => plugin.source === "app");
            const typeId = appPlugin?.manifest.contributes?.serviceTypes?.[0];
            const featureId = appPlugin?.manifest.contributes?.appFeatures?.[0];
            return {
              pluginName: appPlugin?.manifest.name,
              commands: graph.commands
                .filter((candidate) => candidate.source === "app")
                .map((candidate) => candidate.id),
              typeId: typeof typeId === "string" ? (yield* registry.loadServiceType(typeId)).id : undefined,
              featureId:
                typeof featureId === "string" ? (yield* registry.loadAppFeature(featureId)).id : undefined,
            };
          }),
        { resultSchema: Schema.Unknown },
      );
      const config: McpRuntimeConfigShape = {
        commandEntries: [{ spec: command }],
        defaultAllowlist: ["app:info"],
        appContextForCwd: (base, cwd) => mcpAppContextForCwd(base, cwd, { app: true, disable: [] }),
        appCommandEntries: mcpAppCommandEntries,
        runtimeLayer: makeLandoRuntime({
          bootstrap: "plugins",
          cwd: sessionRoot,
          plugins: {
            policy: "discovery",
            discovery: { bundled: false, system: false, user: false, app: true },
          },
        }).pipe(Layer.orDie) as Layer.Layer<unknown>,
      };
      const replies = await Effect.runPromise(
        Effect.gen(function* () {
          const inmem = yield* makeStdioClient();
          const service = yield* McpService;
          const fiber = yield* service
            .serve({ transport: "stdio" })
            .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
          for (const [index, app] of [left, right, left].entries()) {
            yield* inmem.push({ toolId: "app:info", input: { appPath: app.app } });
            while ((yield* inmem.replies).length < index + 1) {
              yield* Effect.sleep("10 millis");
            }
          }
          yield* inmem.push({ toolId: "app:commands:list", input: { appPath: right.app } });
          while ((yield* inmem.replies).length < 4) yield* Effect.sleep("10 millis");
          yield* inmem.push({
            toolId: "app:commands:call",
            input: { appPath: left.app, commandId: left.commandId, flags: { left: "A" } },
          });
          while ((yield* inmem.replies).length < 5) yield* Effect.sleep("10 millis");
          yield* inmem.push({
            toolId: "app:commands:call",
            input: { appPath: right.app, commandId: right.commandId, flags: { right: "B" } },
          });
          while ((yield* inmem.replies).length < 6) yield* Effect.sleep("10 millis");
          yield* inmem.push({
            toolId: "app:commands:call",
            input: { appPath: right.app, commandId: right.commandId, flags: { left: "wrong-app" } },
          });
          while ((yield* inmem.replies).length < 7) yield* Effect.sleep("10 millis");
          yield* inmem.push({
            toolId: "app:commands:call",
            input: { appPath: right.app, commandId: rightOnly },
          });
          while ((yield* inmem.replies).length < 8) yield* Effect.sleep("10 millis");
          yield* inmem.push({
            toolId: "app:commands:call",
            input: { appPath: left.app, commandId: rightOnly },
          });
          while ((yield* inmem.replies).length < 9) yield* Effect.sleep("10 millis");
          const observed = yield* inmem.replies;
          yield* inmem.close;
          yield* Fiber.join(fiber);
          return observed;
        }).pipe(Effect.scoped, Effect.provide(serviceLayer(config))),
      );

      for (const [index, app] of [left, right, left].entries()) {
        expect(replies[index]).toMatchObject({
          ok: true,
          result: {
            envelope: {
              ok: true,
              result: {
                pluginName: app.pluginName,
                commands: app.commandIds,
                typeId: app.typeId,
                featureId: app.featureId,
              },
            },
          },
        });
      }
      expect(replies[3]).toMatchObject({ ok: true });
      expect(replies[3]).toMatchObject({
        result: {
          envelope: { result: { tools: [{ toolId: right.extraCommandId }, { toolId: right.commandId }] } },
        },
      });
      expect(replies[4]).toMatchObject({
        ok: true,
        result: { envelope: { command: left.commandId, result: { left: "A" } } },
      });
      expect(replies[5]).toMatchObject({
        ok: true,
        result: { envelope: { command: right.commandId, result: { right: "B" } } },
      });
      expect(replies[6]).toMatchObject({
        ok: false,
        error: { _tag: "McpToolInputError", path: "flags.left" },
      });
      expect(replies[7]).toMatchObject({
        ok: true,
        result: { envelope: { command: right.extraCommandId, result: { label: "FALLBACK" }, ok: true } },
      });
      expect(replies[8]).toMatchObject({ ok: false, error: { _tag: "McpToolNotAllowedError" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      const inmem = yield* makeStdioClient();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio", maxConcurrent: 2 })
        .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
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
      const inmem = yield* makeStdioClient();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(Stdio.Stdio, inmem.stdio), Effect.forkScoped);
      yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("50 millis");
      yield* inmem.close;
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    await Effect.runPromise(program);
    expect(finalized).toBe(true);
  });
});
