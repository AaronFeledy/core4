import { describe, expect, test } from "bun:test";
import { supervisedExecFixtureOptions } from "@lando/container-runtime/testing/exec-supervision";
import { exec, execStream } from "@lando/provider-lando";
import { Effect, Fiber, Stream } from "effect";
import { appId, decodeChunks, makeFakeApi, node, plan, textEncoder } from "./support/exec-fixture.ts";

describe("provider-lando exec", () => {
  test("streams stdout chunks and completes with exit code", async () => {
    const fake = makeFakeApi(0, "hi\n");

    const chunks = await Effect.runPromise(
      execStream(
        plan,
        { app: appId, service: node.name },
        { command: ["node", "-e", "console.log('hi')"] },
        { api: fake.api, ...supervisedExecFixtureOptions(fake.api) },
      ).pipe(Stream.runCollect, Effect.scoped),
    );
    const decoded = decodeChunks(chunks);

    expect(decoded).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(fake.calls.some((call) => call.path === "/exec/exec-1/start" && call.method === "POST")).toBe(
      true,
    );
  });

  test("passes TTY and inherited stdin settings into exec create/start", async () => {
    const fake = makeFakeApi(0, "");

    await Effect.runPromise(
      execStream(
        plan,
        { app: appId, service: node.name },
        { command: ["sh", "-l"], stdin: "inherit", tty: true },
        { api: fake.api, ...supervisedExecFixtureOptions(fake.api) },
      ).pipe(Stream.runCollect, Effect.scoped),
    );

    const create = fake.calls.find((call) => call.path === "/containers/lando-execapp--node/exec");
    const start = fake.calls.find((call) => call.path === "/exec/exec-1/start");
    expect(create?.body).toMatchObject({ AttachStdin: true, Tty: true });
    expect(start?.body).toMatchObject({ Tty: true });
  });

  test("emits raw stdout chunks for TTY exec streams and forwards stdin and terminal resize events", async () => {
    const fake = makeFakeApi(0, "ignored", "", () => Stream.fromIterable([textEncoder.encode("raw-tty\n")]));
    const stdinStream = (async function* () {
      yield textEncoder.encode("typed\n");
    })();

    const chunks = await Effect.runPromise(
      execStream(
        plan,
        { app: appId, service: node.name },
        {
          command: ["sh", "-l"],
          stdin: "inherit",
          stdinStream,
          tty: true,
          terminalSize: { columns: 132, rows: 43 },
          terminalResize: Stream.fromIterable([{ columns: 100, rows: 20 }]),
        },
        { api: fake.api, ...supervisedExecFixtureOptions(fake.api) },
      ).pipe(Stream.runCollect, Effect.scoped),
    );
    const decoded = decodeChunks(chunks);

    expect(decoded).toEqual({ exitCode: 0, stdout: "raw-tty\n", stderr: "" });
    expect(fake.calls.find((call) => call.path === "/exec/exec-1/start")?.stdin).toBe(stdinStream);
    expect(fake.calls.some((call) => call.path === "/exec/exec-1/resize?h=43&w=132")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/exec/exec-1/resize?h=20&w=100")).toBe(true);
  });

  test("interrupts provider exec streams when the abort signal fires", async () => {
    const fake = makeFakeApi(0, "ignored", "", () => Stream.never);
    const controller = new AbortController();

    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* execStream(
            plan,
            { app: appId, service: node.name },
            { command: ["sh", "-l"], stdin: "inherit", tty: true, signal: controller.signal },
            { api: fake.api, ...supervisedExecFixtureOptions(fake.api) },
          ).pipe(Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("10 millis");
          controller.abort();
          return yield* Fiber.join(fiber);
        }),
      ),
    );

    expect(Array.from(chunks)).toEqual([]);
    const attachSignal = fake.calls.find((call) => call.path === "/exec/exec-1/start")?.signal;
    expect(attachSignal).toBeInstanceOf(AbortSignal);
    expect(attachSignal?.aborted).toBe(true);
  });

  test("resolves nonzero exit as an exit code without stderr", async () => {
    const fake = makeFakeApi(1, "");

    const result = await Effect.runPromise(
      exec(
        plan,
        { app: appId, service: node.name },
        { command: ["false"] },
        { api: fake.api, ...supervisedExecFixtureOptions(fake.api) },
      ),
    );

    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "" });
  });
});
