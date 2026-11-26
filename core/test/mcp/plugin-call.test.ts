import { expect, test } from "bun:test";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient, testAppGenerations } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { StreamFrameSink } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { mcpRegistryWithPlugins } from "../../src/cli/commands/meta/mcp-plugins";
import { serviceLayer } from "../../src/mcp-command-executor";
import { pluginFixtureGraph } from "./plugin-fixture";

const fixture = (spec: ExecutableCommandSpec) =>
  Layer.unwrap(
    mcpRegistryWithPlugins({ commandEntries: [] }).pipe(
      Effect.provideService(PluginContributionGraph, pluginFixtureGraph(spec)),
      Effect.map((registry) =>
        serviceLayer.pipe(
          Layer.provide(
            Layer.succeed(McpRuntimeConfig, {
              cwd: process.cwd(),
              env: { ...process.env },
              commandEntries: registry.commandEntries,
              defaultAllowlist: [],
              apps: testAppGenerations(),
            }),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide(RedactionService.layer));

const base: ExecutableCommandSpec = {
  id: "fixture:inspect",
  namespace: "fixture",
  bootstrap: "app",
  resultSchema: Schema.Unknown,
  run: () => Effect.succeed({}),
};

test("plugin tools/call binds once, preserves parsedArgv, completion and redaction without render", async () => {
  let parses = 0;
  let renders = 0;
  const spec: ExecutableCommandSpec = {
    ...base,
    flags: {
      label: {
        type: "string",
        parse: (value) => {
          parses++;
          return value.toUpperCase();
        },
      },
    },
    args: { target: { type: "string", default: "default-target" } },
    run: (input) =>
      Effect.succeed({
        parsedArgv: input.parsedArgv,
        label: input.flags.label,
        secret: "fixture-secret-value",
      }),
    completion: (_result, input) => ({
      ok: input.flags.label === "BOUND",
      exitCode: input.flags.label === "BOUND" ? 0 : 7,
    }),
    redactionTokens: () => ["fixture-secret-value"],
    render: () =>
      Effect.sync(() => {
        renders++;
      }),
  };
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [spec.id] }));
        return yield* client.request("tools/call", {
          name: spec.id,
          arguments: { flags: { label: "bound" } },
        });
      }),
    ).pipe(Effect.provide(fixture(spec))),
  );
  expect(response).toMatchObject({
    result: {
      isError: false,
      structuredContent: {
        ok: true,
        result: { parsedArgv: ["default-target"], label: "BOUND", secret: "[redacted]" },
      },
    },
  });
  expect(JSON.stringify(response)).not.toContain("fixture-secret-value");
  expect(parses).toBe(1);
  expect(renders).toBe(0);
});

test.each([false, true])("plugin confirmation without elicitation refuses unless yes=%s", async (yes) => {
  let executions = 0;
  const spec: ExecutableCommandSpec = {
    ...base,
    flags: { yes: { type: "boolean" } },
    run: () => Effect.sync(() => ({ executions: ++executions })),
  };
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [spec.id] }));
        return yield* client.request("tools/call", {
          name: spec.id,
          arguments: { flags: yes ? { yes } : {} },
        });
      }),
    ).pipe(Effect.provide(fixture(spec))),
  );
  expect(response).toMatchObject({
    result: {
      structuredContent: yes
        ? { ok: true, result: { executions: 1 } }
        : { ok: false, error: { _tag: "CommandConfirmationError", reason: "non-interactive" } },
    },
  });
  expect(executions).toBe(yes ? 1 : 0);
});

test("a live plugin command delivers its output as progress before the final envelope", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given: a live command that streams a line, then waits until the client has seen it.
        const seen = yield* Deferred.make<void>();
        const spec: ExecutableCommandSpec = {
          ...base,
          streamingMode: "live",
          resultSchema: Schema.Struct({ done: Schema.Boolean }),
          run: () =>
            Effect.gen(function* () {
              const sink = yield* StreamFrameSink;
              yield* sink.emit({ _tag: "stdout", kind: "bytes", chunk: "first line\n" });
              yield* Deferred.await(seen);
              return { done: true };
            }),
        };
        return yield* Effect.gen(function* () {
          const service = yield* McpService;
          const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [spec.id] }));

          // When: the call runs with a progress token.
          const call = yield* client.sendRequest("tools/call", {
            name: spec.id,
            _meta: { progressToken: "live" },
          });
          let message = yield* client.next;
          while (message.method !== "notifications/progress") message = yield* client.next;
          yield* Deferred.succeed(seen, undefined);
          return { progress: message, response: yield* call.response };
        }).pipe(Effect.provide(fixture(spec)));
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  // Then: the line arrived as progress while the command ran, and the final envelope is the
  // ordinary command result that also retains the streamed output.
  expect(observed.progress).toMatchObject({
    params: { progressToken: "live", message: JSON.stringify({ _tag: "stdout", chunk: "first line\n" }) },
  });
  expect(observed.response).toMatchObject({
    result: {
      isError: false,
      structuredContent: {
        ok: true,
        result: { done: true },
        output: { chunks: [{ _tag: "stdout", chunk: "first line\n" }], truncated: false },
      },
    },
  });
});

test("plugin tools/call accepts elicitation confirmation", async () => {
  const spec: ExecutableCommandSpec = { ...base, flags: { yes: { type: "boolean" } } };
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [spec.id] }), {
          elicitation: {},
        });
        const call = yield* client.sendRequest("tools/call", { name: spec.id });
        let reverse = yield* client.next;
        while (reverse.method !== "elicitation/create") reverse = yield* client.next;
        if (typeof reverse.id !== "string" && typeof reverse.id !== "number")
          throw new Error("Missing elicitation id");
        yield* client.send({
          jsonrpc: "2.0",
          id: reverse.id,
          result: { action: "accept", content: { confirm: true } },
        });
        return yield* call.response;
      }),
    ).pipe(Effect.provide(fixture(spec))),
  );
  expect(response).toMatchObject({ result: { structuredContent: { ok: true } } });
});

test("cancelling a plugin call interrupts its retained-runtime work and finalizes it", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const spec: ExecutableCommandSpec = {
          ...base,
          run: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        };
        yield* Effect.gen(function* () {
          const service = yield* McpService;
          const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [spec.id] }));
          const call = yield* client.sendRequest("tools/call", { name: spec.id });
          yield* Deferred.await(entered);
          yield* client.cancel(call.id);
          yield* Deferred.await(finalized);
          const next = yield* client.request("ping");
          expect(next).toMatchObject({ result: {} });
          yield* client.close;
          yield* Fiber.await(client.fiber);
        }).pipe(Effect.provide(fixture(spec)));
      }),
    ),
  );
});
