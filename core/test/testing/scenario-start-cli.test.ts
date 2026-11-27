import { expect, setDefaultTimeout, test } from "bun:test";
import { ScenarioContextFactory } from "@lando/core/testing";
import { Deferred, Effect, Fiber, Schema } from "effect";

setDefaultTimeout(30_000);

const runScenario = <A, E, R>(
  scenarioId: string,
  body: Parameters<typeof ScenarioContextFactory.scenario<A, E, R>>[1],
) => ScenarioContextFactory.scenario({ guideId: "background-cli", scenarioId, render: false }, body);

const initialize =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scenario-start-cli","version":"1"}}}\n';
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

test("exchanges MCP frames on the source CLI's pipes and records one result", async () => {
  await Effect.runPromise(
    runScenario("dialogue", (context) =>
      Effect.gen(function* () {
        const child = yield* context.startCli("lando mcp", { stdin: "pipe" });
        yield* child.write(initialize);
        const reply = yield* child.stdoutLine((line) => decode(line).id === 1);
        expect(decode(reply)).toMatchObject({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "lando" } },
        });
        yield* child.closeInput;
        yield* child.closeInput;
        const result = yield* child.result;
        expect(result).toMatchObject({ exitCode: 0, stderr: "", events: [] });
        expect(yield* child.result).toEqual(result);
        expect(context.transcript.frames).toEqual([
          expect.objectContaining({ kind: "run", command: ["mcp"], stdout: `${reply}\n`, exit: 0 }),
        ]);
      }),
    ),
  );
});

test("reaps an abandoned visible child, but does not record a child started while hidden", async () => {
  await Effect.runPromise(
    runScenario("abandon", (context) =>
      Effect.gen(function* () {
        const [visible, hidden] = yield* Effect.scoped(
          Effect.gen(function* () {
            const visible = yield* context.startCli("mcp", { stdin: "pipe" });
            const hidden = yield* context.hidden(context.startCli("mcp --tooling", { stdin: "pipe" }));
            return [visible, hidden] as const;
          }),
        );
        const result = yield* visible.result;
        expect(result.exitCode).not.toBe(0);
        if (process.platform !== "win32") expect(result.signal).toBe("SIGKILL");
        expect((yield* hidden.result).exitCode).not.toBe(0);
        expect(context.transcript.frames).toEqual([
          expect.objectContaining({ kind: "run", command: ["mcp"] }),
        ]);
      }),
    ),
  );
});

test("scope interruption terminates and reaps an open session", async () => {
  await Effect.runPromise(
    runScenario("cancel", (context) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const session = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* context.startCli("mcp", { stdin: "pipe" });
              yield* child.write(initialize);
              yield* child.stdoutLine((line) => decode(line).id === 1);
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(session);
        expect(context.transcript.frames).toEqual([
          expect.objectContaining({ kind: "run", command: ["mcp"] }),
        ]);
        const frame = context.transcript.frames[0];
        expect(frame?.kind === "run" ? frame.exit : 0).not.toBe(0);
      }),
    ),
  );
});

test("times out waiting for a line on an open pipe", async () => {
  await Effect.runPromise(
    runScenario("line-timeout", (context) =>
      Effect.gen(function* () {
        const child = yield* context.startCli("mcp", { stdin: "pipe" });
        const failure = yield* Effect.flip(child.stdoutLine(() => false, { timeoutMs: 200 }));
        expect(failure.reason).toBe("line-timeout");
      }),
    ),
  );
});

test("reports EOF instead of a timeout when no line matches", async () => {
  await Effect.runPromise(
    runScenario("stdout-eof", (context) =>
      Effect.gen(function* () {
        const child = yield* context.startCli("version");
        const failure = yield* Effect.flip(child.stdoutLine(() => false));
        expect(failure.reason).toBe("exited-before-match");
      }),
    ),
  );
});

test("rejects input after the caller sends EOF", async () => {
  await Effect.runPromise(
    runScenario("input-closed", (context) =>
      Effect.gen(function* () {
        const child = yield* context.startCli("mcp", { stdin: "pipe" });
        yield* child.closeInput;
        expect((yield* Effect.flip(child.write(initialize))).reason).toBe("input-closed");
      }),
    ),
  );
});

test("rejects input after the child exits without the caller sending EOF", async () => {
  await Effect.runPromise(
    runScenario("exited", (context) =>
      Effect.gen(function* () {
        const child = yield* context.startCli("version", { stdin: "pipe" });
        expect((yield* child.result).exitCode).toBe(0);
        expect((yield* Effect.flip(child.write(initialize))).reason).toBe("input-closed");
      }),
    ),
  );
});
