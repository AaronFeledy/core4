import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { serverLayer, startServer } from "./server";

describe("MCP trustworthy completion and final output", () => {
  test.each([false, 0, { exitCode: 7 }])("retains completed failure value %j", async (value) => {
    const spec = {
      id: "app:exec",
      summary: "Failed value",
      resultSchema: Schema.Unknown,
      completion: () => commandCompletionFromExitCode(7),
      run: () => Effect.succeed(value),
    };
    const reply = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startServer();
          const reply = yield* client.request("tools/call", { name: spec.id });
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return reply;
        }),
      ).pipe(
        Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] })),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(reply).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          result: value,
          error: { _tag: "LandoCommandError", exitCode: 7 },
          output: { chunks: [], truncated: false },
        },
      },
    });
  });
  test("keeps report findings successful independently of their nonzero shell status", async () => {
    const spec = {
      id: "app:info",
      summary: "Report",
      resultSchema: Schema.Boolean,
      completion: () => ({ ok: true as const, exitCode: 1 }),
      run: () => Effect.succeed(false),
    };
    const reply = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startServer();
          const reply = yield* client.request("tools/call", { name: spec.id });
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return reply;
        }),
      ).pipe(
        Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] })),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(reply).toMatchObject({
      result: {
        isError: false,
        structuredContent: { ok: true, result: false, output: { chunks: [], truncated: false } },
      },
    });
  });
  test("isolates final captures for overlapping invocations", async () => {
    const replies = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const left = yield* Deferred.make<void>();
          const right = yield* Deferred.make<void>();
          const entries = ["left", "right"].map((name) => ({
            spec: {
              id: `app:${name}`,
              summary: name,
              resultSchema: Schema.Struct({ name: Schema.String }),
              run: () =>
                Effect.gen(function* () {
                  const sink = yield* StreamFrameSink;
                  yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: name });
                  yield* Deferred.succeed(name === "left" ? left : right, undefined);
                  yield* Deferred.await(name === "left" ? right : left);
                  return { name };
                }),
            },
          }));
          const client = yield* startServer().pipe(
            Effect.provide(
              serverLayer({ commandEntries: entries, defaultAllowlist: entries.map(({ spec }) => spec.id) }),
            ),
          );
          const replies = yield* Effect.all(
            entries.map(({ spec }) => client.request("tools/call", { name: spec.id })),
            { concurrency: 2 },
          );
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return replies;
        }),
      ).pipe(Effect.timeout("5 seconds")),
    );
    for (const [index, name] of ["left", "right"].entries())
      expect(replies[index]).toMatchObject({
        result: {
          structuredContent: {
            result: { name },
            output: { chunks: [{ _tag: "stdout", chunk: name }], truncated: false },
          },
        },
      });
  });
  test("redacts result-discovered tokens on a completed failure", async () => {
    const secret = "completion-discovered-value";
    const spec = {
      id: "app:exec",
      summary: "Process token",
      resultSchema: Schema.Struct({ exitCode: Schema.Number, detail: Schema.String }),
      completion: () => commandCompletionFromExitCode(7),
      redactionTokens: () => [secret],
      run: () =>
        Effect.gen(function* () {
          const sink = yield* StreamFrameSink;
          yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: `${secret}\n` });
          return { exitCode: 7, detail: secret };
        }),
    };
    const reply = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startServer();
          const reply = yield* client.request("tools/call", { name: spec.id });
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return reply;
        }),
      ).pipe(
        Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] })),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(JSON.stringify(reply)).not.toContain(secret);
    expect(reply).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          result: { exitCode: 7, detail: "[redacted]" },
          output: { chunks: [{ _tag: "stdout", chunk: "[redacted]\n" }], truncated: false },
        },
      },
    });
  });
  test.each([false, true])("retains output and process failure with progress token %j", async (token) => {
    const spec = {
      id: "app:exec",
      summary: "Process",
      resultSchema: Schema.Struct({ exitCode: Schema.Number }),
      completion: (value: unknown) =>
        commandCompletionFromExitCode(
          Schema.decodeUnknownSync(Schema.Struct({ exitCode: Schema.Number }))(value).exitCode,
        ),
      run: () =>
        Effect.gen(function* () {
          const sink = yield* StreamFrameSink;
          yield* sink.emit({
            kind: "bytes",
            _tag: "stdout",
            chunk: Buffer.from("hello"),
            service: "app",
            source: "build",
          });
          yield* sink.emit({ kind: "record", _tag: "stderr", chunk: "warning", service: "app" });
          yield* Effect.addFinalizer(() =>
            sink.emit({ kind: "bytes", _tag: "stdout", chunk: " tail", service: "app", source: "build" }),
          );
          return { exitCode: 7 };
        }),
    };
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startServer();
          const reply = yield* client.request("tools/call", {
            name: spec.id,
            ...(token ? { _meta: { progressToken: "output" } } : {}),
          });
          const notifications = yield* client.notifications;
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return { reply, notifications };
        }),
      ).pipe(
        Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] })),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(observed.reply).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          result: { exitCode: 7 },
          error: { _tag: "LandoCommandError", exitCode: 7 },
          output: {
            truncated: false,
            chunks: [
              { _tag: "stderr", chunk: "warning\n", service: "app" },
              { _tag: "stdout", chunk: "hello tail", service: "app", source: "build" },
            ],
          },
        },
      },
    });
    expect(observed.notifications.length).toBe(token ? 2 : 0);
  });
});
