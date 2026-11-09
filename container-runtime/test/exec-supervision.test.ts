import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { execDataFrames, execEofFrame, execSignalFrame } from "../src/exec-control.ts";
import { supervisedExecStream } from "../src/exec-supervision.ts";
import { execStream as plainExecStream } from "../src/podman/exec-transport.ts";
import { rememberContainerHasShell, rememberExecUmask } from "../src/podman/exec-umask.ts";
import { execStream as dispatchExecStream } from "../src/podman/exec.ts";

const ctx = { providerId: "docker", remediation: "Reconnect the provider.", env: {} };
const service = ServiceName.make("web");
const provider = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
  source: "exec-supervision.test.ts",
  runtime: 4 as const,
};
const plan = {
  id: AppId.make("exec-supervision"),
  name: "Exec",
  slug: "exec-supervision",
  root: AbsolutePath.make("/tmp/exec-supervision"),
  provider,
  services: {
    [service]: {
      name: service,
      type: "node",
      provider,
      primary: true,
      artifact: { kind: "ref" as const, ref: "node:22" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const target = { app: plan.id, service };
const helperTarget = { os: "linux", arch: "x64" } as const;
const helper = {
  path: AbsolutePath.make("/fixture/linux-x64/lando-container-helper"),
  digest: "a".repeat(64),
  target: helperTarget,
};
const frame = (text: string, stream = 1) => {
  const bytes = new TextEncoder().encode(text);
  const result = new Uint8Array(8 + bytes.length);
  result[0] = stream;
  new DataView(result.buffer).setUint32(4, bytes.length);
  result.set(bytes, 8);
  return result;
};
const fixture = (mounted = true) => {
  const requests: EngineHttpRequest[] = [];
  const input: Uint8Array[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        const control =
          Schema.is(Schema.Struct({ Cmd: Schema.Array(Schema.String) }))(request.body) &&
          request.body.Cmd[1] === "exec-signal";
        return {
          status: 200,
          body: JSON.stringify(
            request.path.startsWith("/containers/") && request.method === "GET"
              ? {
                  Id: "container",
                  Mounts: mounted
                    ? [{ Source: "/fixture/linux-x64", Destination: "/run/lando/helper", RW: false }]
                    : [],
                }
              : request.method === "POST"
                ? { Id: control ? "control" : "exec" }
                : { Running: false, ExitCode: request.path === "/exec/control/json" ? 3 : 7 },
          ),
        };
      }),
    stream: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          requests.push(request);
          request.onResponseHead?.();
          if (request.stdin !== undefined) {
            const stdin = request.stdin;
            yield* Effect.promise(async () => {
              for await (const bytes of stdin) {
                input.push(bytes);
                if (bytes[0] === 1) break;
              }
            });
          }
          return Stream.make(frame("out\0\n"), frame("err\n", 2));
        }),
      ),
  };
  return {
    api,
    requests,
    input,
    options: { api, ctx, helperTarget, resolveContainerHelper: () => Effect.succeed(helper) },
  };
};

test("encodes bounded DATA frames and distinct logical EOF and signal frames", () => {
  const bytes = Uint8Array.from({ length: 65_537 }, (_, index) => index % 256);
  const frames = [...execDataFrames(bytes)];
  expect(frames.map((frame) => new DataView(frame.buffer).getUint32(1))).toEqual([65_536, 1]);
  expect(Buffer.concat(frames.map((frame) => frame.subarray(5)))).toEqual(Buffer.from(bytes));
  expect([...execEofFrame()]).toEqual([1, 0, 0, 0, 0]);
  const signal = new AbortController();
  signal.abort("SIGINT");
  expect([...execSignalFrame(signal.signal)]).toEqual([2, 0, 0, 0, 1, 2]);
  expect([...execSignalFrame(undefined)]).toEqual([2, 0, 0, 0, 1, 15]);
});

test("preserves exact output and exit status with no stdin", async () => {
  const f = fixture();
  const chunks = await Effect.runPromise(
    Stream.runCollect(supervisedExecStream(plan, target, { command: ["payload"] }, f.options)),
  );
  expect(chunks).toEqual([
    { kind: "stdout", chunk: new TextEncoder().encode("out\0\n") },
    { kind: "stderr", chunk: new TextEncoder().encode("err\n") },
    { exitCode: 7 },
  ]);
  expect(f.input).toEqual([execEofFrame()]);
});

test("fails before payload creation when the mounted helper is absent", async () => {
  const f = fixture(false);
  const result = await Effect.runPromise(
    Stream.runCollect(supervisedExecStream(plan, target, { command: ["payload"] }, f.options)).pipe(
      Effect.flip,
    ),
  );
  expect(result._tag).toBe("ServiceExecError");
  expect(result.remediation).toContain("lando start");
  expect(f.requests.map((request) => request.method)).toEqual(["GET"]);
});

test("preserves provider failure tags and remediation", async () => {
  const f = fixture();
  const failure = new ProviderUnavailableError({ ...ctx, operation: "exec", message: "Offline" });
  const result = await Effect.runPromise(
    Stream.runCollect(
      supervisedExecStream(
        plan,
        target,
        { command: ["payload"] },
        {
          ...f.options,
          api: { ...f.api, request: () => Effect.fail(failure) },
        },
      ),
    ).pipe(Effect.flip),
  );
  expect(result).toBe(failure);
});

test("sends byte-exact DATA followed by logical EOF while retaining control attachment", async () => {
  const f = fixture();
  const payload = new Uint8Array([0, 255, 10, 13, 1, 2]);
  const stdinStream = {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
  await Effect.runPromise(
    Stream.runDrain(supervisedExecStream(plan, target, { command: ["payload"], stdinStream }, f.options)),
  );
  expect(f.input).toEqual([...execDataFrames(payload), execEofFrame()]);
});

test("a disconnected attach preserves its provider error and confirms the same exec stopped", async () => {
  const f = fixture();
  const failure = new ProviderUnavailableError({ ...ctx, operation: "exec", message: "Disconnected" });
  const api = {
    ...f.api,
    stream: (request: EngineHttpRequest) => {
      if (request.path === "/exec/control/start") {
        f.requests.push(request);
        request.onResponseHead?.();
        return Stream.empty;
      }
      return Stream.fail(failure);
    },
  };
  const result = await Effect.runPromise(
    Stream.runDrain(supervisedExecStream(plan, target, { command: ["payload"] }, { ...f.options, api })).pipe(
      Effect.flip,
    ),
  );
  expect(result).toBe(failure);
  expect(f.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /containers/lando-exec-supervision--web/json",
    "POST /containers/container/exec",
    "POST /containers/container/exec",
    "POST /exec/control/start",
    "GET /exec/control/json",
    "GET /exec/exec/json",
  ]);
});

test("warm supervision uses exactly the plain transport engine request set", async () => {
  const supervised = fixture();
  const plain = fixture();
  rememberExecUmask(supervised.api, "container", { status: "ok", umask: "0022" });
  rememberExecUmask(plain.api, "container", { status: "ok", umask: "0022" });
  await Effect.runPromise(
    Effect.scoped(
      Stream.runDrain(dispatchExecStream(plan, target, { command: ["payload"] }, supervised.options)),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Stream.runDrain(plainExecStream(plan, target, { command: ["payload"] }, { api: plain.api, ctx })),
    ),
  );
  const execRequests = (requests: readonly EngineHttpRequest[]) =>
    requests.map(
      (request) =>
        `${request.method} ${request.path.replace("/container/", "/lando-exec-supervision--web/")}`,
    );
  expect(execRequests(supervised.requests)).toEqual(execRequests(plain.requests));
  expect(execRequests(supervised.requests)).toEqual([
    "GET /containers/lando-exec-supervision--web/json",
    "POST /containers/lando-exec-supervision--web/exec",
    "POST /exec/exec/start",
    "GET /exec/exec/json",
  ]);
});

test.each([true, false])("supervised umask compensation requires no shell (shell=%s)", async (shell) => {
  const f = fixture();
  rememberExecUmask(f.api, "container", { status: "ok", umask: "0000" });
  rememberContainerHasShell(f.api, "container", shell);
  await Effect.runPromise(
    Effect.scoped(
      Stream.runDrain(dispatchExecStream(plan, target, { command: ["payload", "a b"] }, f.options)),
    ),
  );
  expect(
    f.requests.filter((request) => request.path.endsWith("/exec")).map((request) => request.body),
  ).toEqual([
    expect.objectContaining({
      Cmd: [
        "/run/lando/helper/lando-container-helper",
        "exec-run",
        "--nonce",
        expect.stringMatching(/^[a-f0-9]{32}$/u),
        "--umask",
        "0022",
        "--",
        "payload",
        "a b",
      ],
    }),
  ]);
});

test.each(["SIGINT", "SIGTERM"])(
  "cancellation sends %s and joins the same exec before interruption",
  async (signal) => {
    const f = fixture();
    const started = Deferred.makeUnsafe<void>();
    const cancelled = Deferred.makeUnsafe<void>();
    const controller = new AbortController();
    const api: EngineHttpApi = {
      ...f.api,
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            request.onResponseHead?.();
            yield* Deferred.succeed(started, undefined);
            if (request.stdin === undefined) throw new TypeError("Missing control input");
            const stdin = request.stdin;
            yield* Effect.promise(async () => {
              for await (const bytes of stdin) {
                f.input.push(bytes);
                if (bytes[0] === 2) break;
              }
            });
            yield* Deferred.succeed(cancelled, undefined);
            return Stream.empty;
          }),
        ),
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const child = yield* Stream.runDrain(
          supervisedExecStream(
            plan,
            target,
            { command: ["payload"], signal: controller.signal },
            { ...f.options, api },
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        controller.abort(signal);
        return yield* Fiber.await(child);
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(await Effect.runPromise(Deferred.isDone(cancelled))).toBe(true);
    expect(f.input.at(-1)).toEqual(execSignalFrame(controller.signal));
  },
);
