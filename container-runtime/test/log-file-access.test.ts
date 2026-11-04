// allow: SIZE_OK - Protocol fixtures and lifecycle regressions stay together in this test-only port.
import { beforeEach, describe, expect, test } from "bun:test";
import type { DataPlaneApiClient, DataPlaneHttpRequest } from "@lando/container-runtime/data-plane";
import { scopedDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type LogFileHandle,
  followLogSources,
  logFollowLineChunks,
  makeMemoryLogFileAccess,
} from "@lando/sdk/log-follow";
import { AbsolutePath, LogSource, ServiceName } from "@lando/sdk/schema";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";

let fixtureRedaction = makeRedactionService();
beforeEach(() => {
  fixtureRedaction = makeRedactionService();
});

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const helperLine = (value: unknown): Uint8Array => bytes(`${JSON.stringify(value)}\n`);
const resolveHelper = Effect.succeed({
  target: { os: "linux", arch: "x64" } as const,
  path: AbsolutePath.make(import.meta.filename),
  digest: "1".repeat(64),
});
const accessFor = (api: DataPlaneApiClient) =>
  scopedDockerLogFileAccess({ providerId: "test", container: "service", api, resolveHelper, sourceEnv: {} });

async function* inputLines(input: AsyncIterable<Uint8Array> | undefined): AsyncGenerator<string> {
  if (input === undefined) return;
  let buffered = "";
  for await (const chunk of input) {
    buffered += text(chunk);
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
    }
  }
}

const objectField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;

const dockerFrame = (stream: 1 | 2, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = stream;
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
};

const tarEntryNames = (archive: Uint8Array): readonly string[] => {
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= archive.byteLength; offset += 512) {
    const header = archive.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    names.push(text(header.slice(0, 100)).split("\0")[0] ?? "");
    const size = Number.parseInt(text(header.slice(124, 136)).replaceAll("\0", "").trim(), 8);
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
};

interface FakeExec {
  readonly command: readonly string[];
  readonly user: unknown;
}

const makeFakeApi = () => {
  const requests: DataPlaneHttpRequest[] = [];
  const execs: FakeExec[] = [];
  const commands: string[] = [];
  const archives: Uint8Array[] = [];
  const events: string[] = [];
  let signal: AbortSignal | undefined;
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.promise(async () => {
        requests.push(request);
        if (request.method === "PUT") {
          const chunks: Uint8Array[] = [];
          if (request.stdin !== undefined) for await (const chunk of request.stdin) chunks.push(chunk);
          archives.push(Buffer.concat(chunks));
          events.push("upload");
          return { status: 200, body: "{}" };
        }
        if (request.path === "/containers/service/exec") {
          const command = objectField(request.body, "Cmd");
          const user = objectField(request.body, "User");
          // Podman refuses to start an exec with no attached stream.
          if (
            !["AttachStdin", "AttachStdout", "AttachStderr"].some(
              (key) => objectField(request.body, key) === true,
            )
          )
            return { status: 500, body: "must provide at least one stream to attach to" };
          execs.push({
            command: Array.isArray(command) ? command.filter((v): v is string => typeof v === "string") : [],
            user,
          });
          if (user === "0") events.push("cleanup");
          return { status: 201, body: JSON.stringify({ Id: user === "0" ? "cleanup" : "helper" }) };
        }
        return { status: 500, body: "unexpected request" };
      }),
    stream: (request) =>
      Stream.fromAsyncIterable(
        (async function* () {
          requests.push(request);
          if (request.stdin === undefined) return;
          signal = request.signal;
          request.signal?.addEventListener("abort", () => events.push("abort"), { once: true });
          for await (const line of inputLines(request.stdin)) {
            const decoded: unknown = JSON.parse(line);
            const op = objectField(decoded, "op");
            if (typeof op === "string") commands.push(op);
            if (op === "stat" || op === "open" || op === "fstat")
              yield helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "11" } });
            if (op === "read")
              yield helperLine({
                ok: true,
                bytes: Buffer.from("hello").toString("base64"),
                nextOffset: "5",
                eof: false,
              });
            if (op === "close") yield helperLine({ ok: true });
          }
        })(),
        (cause) =>
          new ProviderInternalError({
            providerId: "test",
            operation: "fixture",
            message: "fake stream failed",
            cause,
            remediation:
              "Re-run the command after checking `test` logs for the `fixture` failure; if it persists, report the error with that operation name.",
          }),
      ),
  };
  return { api, requests, execs, commands, archives, events, signal: () => signal };
};

const protocolApi = (chunks: readonly Uint8Array[]): DataPlaneApiClient => ({
  request: (request) =>
    Effect.succeed(
      request.path === "/containers/service/exec"
        ? { status: 201, body: '{"Id":"protocol"}' }
        : { status: 200, body: "{}" },
    ),
  stream: () => Stream.make(...chunks),
});

describe("Docker-compatible scoped log file access", () => {
  test("uploads one archive and creates one reader exec across many stat/open/read calls in a scope", async () => {
    // Given
    const fake = makeFakeApi();
    let resolutions = 0;
    // When
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const access = yield* scopedDockerLogFileAccess({
            providerId: "test",
            sourceEnv: {},
            container: "service",
            api: fake.api,
            resolveHelper: Effect.tap(resolveHelper, () =>
              Effect.sync(() => {
                resolutions++;
              }),
            ),
          });
          for (let i = 0; i < 5; i++) {
            expect(Option.getOrThrow(yield* access.stat(`/app-${i}.log`)).size).toBe(11n);
            const handle = yield* access.open(`/app-${i}.log`);
            expect((yield* handle.stat).ino).toBe("2");
            expect(text((yield* handle.read(0n, 3)).bytes)).toBe("hel");
            yield* handle.close;
          }
          expect(fake.execs).toHaveLength(1);
          expect(fake.signal()?.aborted).toBe(false);
        }),
      ),
    );
    // Then
    expect(resolutions).toBe(1);
    expect(fake.archives).toHaveLength(1);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    const upload = fake.requests.find((r) => r.method === "PUT");
    expect(upload?.path).toBe("/containers/service/archive?path=/tmp");
    expect(upload?.body instanceof Uint8Array).toBe(false);
    expect(upload?.headers?.["Content-Type"]).toBe("application/x-tar");
    expect(fake.requests.some((r) => r.method === "GET" && r.path.includes("archive"))).toBe(false);
    expect(fake.execs).toHaveLength(2);
    const path = fake.execs[0]?.command[0];
    if (path === undefined) throw new TypeError("Expected helper executable");
    expect(path).toMatch(/^\/tmp\/lando-log-file-helper-[0-9a-f]{32}\/lando-container-helper$/);
    expect(fake.execs[0]).toEqual({ command: [path, "log-file"], user: undefined });
    const directory = path.slice(0, -"/lando-container-helper".length);
    expect(tarEntryNames(fake.archives[0] ?? new Uint8Array())).toEqual([
      `${directory.slice(5)}/`,
      path.slice(5),
    ]);
    expect(fake.execs[1]).toEqual({ command: [path, "log-file-cleanup", directory], user: "0" });
    expect(fake.events).toEqual(["upload", "abort", "cleanup"]);
    expect(fake.commands.filter((op) => op === "close")).toHaveLength(6);
  });

  test("uses distinct installation directories for separate scopes", async () => {
    const fake = makeFakeApi();
    for (let i = 0; i < 2; i++) {
      await Effect.runPromise(
        Effect.scoped(Effect.flatMap(accessFor(fake.api), (access) => access.stat("/app.log"))),
      );
    }
    expect(fake.archives).toHaveLength(2);
    expect(fake.execs.filter((exec) => exec.user === "0")).toHaveLength(2);
    expect(fake.execs[0]?.command[0]).not.toBe(fake.execs[2]?.command[0]);
  });

  test("keeps stat sessions open until their scope ends", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const access = yield* accessFor(fake.api);
          expect(Option.getOrThrow(yield* access.stat("/app.log")).dev).toBe("1");
          expect(fake.commands).toEqual(["stat"]);
          expect(fake.execs).toHaveLength(1);
        }),
      ),
    );
    expect(fake.commands).toEqual(["stat", "close"]);
    expect(fake.signal()?.aborted).toBe(true);
    expect(fake.execs.filter((exec) => exec.user === "0")).toHaveLength(1);
  });

  const utf8 = helperLine({ ok: true, stat: { dev: "dé", ino: "2", size: "0" } });
  const utf8Split = text(utf8).indexOf("é") + 1;
  const docker = dockerFrame(1, helperLine({ ok: true, stat: { dev: "docker", ino: "2", size: "0" } }));
  test.each([
    ["UTF-8 byte boundaries", [utf8.slice(0, utf8Split), utf8.slice(utf8Split)], "dé"],
    [
      "Docker stdout attach chunks",
      [docker.slice(0, 2), docker.slice(2, 8), docker.slice(8, 13), docker.slice(13)],
      "docker",
    ],
    ["raw Podman JSON", [helperLine({ ok: true, stat: { dev: "podman", ino: "2", size: "0" } })], "podman"],
  ] as const)("decodes %s", async (_label, chunks, expected) => {
    const stat = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(accessFor(protocolApi(chunks)), (access) => access.stat("/app.log"))),
    );
    expect(Option.getOrThrow(stat).dev).toBe(expected);
  });

  test("maps Docker stderr attach frames to typed provider failure", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.flatMap(accessFor(protocolApi([dockerFrame(2, bytes("helper exploded\n"))])), (access) =>
            access.stat("/app.log"),
          ),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });

  test("redacts runtime-registered values in helper stderr", async () => {
    const canary = "opaque-log-helper-canary-1261";
    Effect.runSync(fixtureRedaction.registerValues([canary]));
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.flatMap(
            accessFor(protocolApi([dockerFrame(2, bytes(`helper said ${canary}\n`))])).pipe(
              Effect.provideService(RedactionService, fixtureRedaction),
            ),
            (access) => access.stat("/app.log"),
          ),
        ),
      ),
    );
    if (!(failure instanceof ProviderInternalError)) throw new TypeError("Expected ProviderInternalError");
    expect(failure.details).toBe("helper said [redacted]\n");
    expect(failure.message).not.toContain(canary);
    expect(failure.providerId).toBe("test");
    expect(failure.operation).toBe("logFileAccess");
  });

  test("clamps read requests so base64 frames fit within protocol bounds", async () => {
    let requested: unknown;
    const api: DataPlaneApiClient = {
      ...protocolApi([]),
      stream: (request) =>
        Stream.fromAsyncIterable(
          (async function* () {
            for await (const line of inputLines(request.stdin)) {
              const command: unknown = JSON.parse(line);
              const op = objectField(command, "op");
              if (op === "open") yield helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "0" } });
              if (op === "read") {
                requested = objectField(command, "maxBytes");
                const length = typeof requested === "number" ? requested : 0;
                yield helperLine({
                  ok: true,
                  bytes: Buffer.alloc(length).toString("base64"),
                  nextOffset: String(length),
                  eof: false,
                });
              }
              if (op === "close") yield helperLine({ ok: true });
            }
          })(),
          (cause) =>
            new ProviderInternalError({
              providerId: "test",
              operation: "fixture",
              message: "stream failed",
              cause,
              remediation:
                "Re-run the command after checking `test` logs for the `fixture` failure; if it persists, report the error with that operation name.",
            }),
        ),
    };
    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const access = yield* accessFor(api);
          const handle = yield* access.open("/app.log");
          return yield* handle.read(0n, 1_000_000);
        }),
      ),
    );
    expect(requested).toBe(65_536);
    expect(read.bytes.byteLength).toBe(65_536);
    expect(read.nextOffset).toBe(65_536n);
  });

  test("closes and aborts the session even when root cleanup hangs", async () => {
    const fake = makeFakeApi();
    let cleanups = 0;
    const api: DataPlaneApiClient = {
      ...fake.api,
      stream: (request) => {
        if (request.path === "/exec/cleanup/start") {
          cleanups++;
          return Stream.fromEffect(Effect.never);
        }
        return fake.api.stream?.(request) ?? Stream.die("Missing fixture stream");
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(accessFor(api), (access) => access.open("/app.log"))).pipe(
        Effect.timeoutOption("3 seconds"),
      ),
    );
    expect(Option.isSome(result)).toBe(true);
    expect(cleanups).toBe(1);
    expect(fake.commands).toContain("close");
    expect(fake.signal()?.aborted).toBe(true);
    expect(fake.events).toEqual(["upload", "abort", "cleanup"]);
  });

  test("attempts root cleanup exactly once when startup fails after upload", async () => {
    const fake = makeFakeApi();
    const api: DataPlaneApiClient = {
      ...fake.api,
      request: (request) =>
        request.path === "/containers/service/exec" && objectField(request.body, "User") !== "0"
          ? Effect.succeed({ status: 500, body: "create failed" })
          : (fake.api.request?.(request) ?? Effect.die("Missing fixture request")),
    };
    const exit = await Effect.runPromiseExit(Effect.scoped(accessFor(api)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.archives[0]?.byteLength).toBeGreaterThan(0);
    expect(fake.execs).toHaveLength(1);
    expect(fake.execs[0]?.user).toBe("0");
    expect(fake.execs[0]?.command[1]).toBe("log-file-cleanup");
    expect(fake.execs[0]?.command[2]).toMatch(/^\/tmp\/lando-log-file-helper-[0-9a-f]{32}$/);
  });

  test("aborts an unresponsive session close before running root cleanup", async () => {
    const fake = makeFakeApi();
    let signal: AbortSignal | undefined;
    let closes = 0;
    const api: DataPlaneApiClient = {
      ...fake.api,
      stream: (request) =>
        Stream.fromAsyncIterable(
          (async function* () {
            if (request.stdin === undefined) return;
            signal = request.signal;
            for await (const line of inputLines(request.stdin)) {
              const command: unknown = JSON.parse(line);
              if (objectField(command, "op") === "close") closes++;
              else yield helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "0" } });
            }
          })(),
          (cause) =>
            new ProviderInternalError({
              providerId: "test",
              operation: "fixture",
              message: "stream failed",
              cause,
              remediation:
                "Re-run the command after checking `test` logs for the `fixture` failure; if it persists, report the error with that operation name.",
            }),
        ),
    };
    const result = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(accessFor(api), (access) => access.stat("/app.log"))).pipe(
        Effect.timeoutOption("3 seconds"),
      ),
    );
    expect(Option.isSome(result)).toBe(true);
    expect(closes).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(fake.execs.filter((exec) => exec.user === "0")).toHaveLength(1);
  });

  test("cleans up once when the scope is interrupted after upload", async () => {
    const fake = makeFakeApi();
    const ready = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const access = yield* accessFor(fake.api);
          yield* access.stat("/app.log");
          yield* Deferred.succeed(ready, undefined);
          yield* Effect.never;
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(ready));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(fake.archives).toHaveLength(1);
    expect(fake.execs.filter((exec) => exec.user === "0")).toHaveLength(1);
    expect(fake.signal()?.aborted).toBe(true);
  });

  test("names the container, installed helper path, and exit code when exec ends before responding", async () => {
    const fake = makeFakeApi();
    const api: DataPlaneApiClient = {
      request: (request) =>
        request.path === "/exec/helper/json"
          ? Effect.succeed({ status: 200, body: '{"ExitCode":127}' })
          : (fake.api.request?.(request) ?? Effect.die("Missing fixture request")),
      stream: () => Stream.empty,
    };
    const failure = await Effect.runPromise(
      Effect.flip(Effect.scoped(Effect.flatMap(accessFor(api), (access) => access.stat("/app.log")))),
    );
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toContain("service");
    expect(failure.message).toContain(fake.execs[0]?.command[0] ?? "missing-helper-path");
    expect(failure.message).toContain("exit code 127");
  });

  test.each([
    ["unsigned decimal stat size", helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "01" } })],
    ["corrupted protocol", bytes("not-json\n")],
  ] as const)("rejects %s with ProviderInternalError", async (_label, frame) => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(Effect.flatMap(accessFor(protocolApi([frame])), (access) => access.stat("/app.log"))),
      ),
    );
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });

  test("rejects malformed unsigned decimal read offsets", async () => {
    const api = protocolApi([
      helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "0" } }),
      helperLine({ ok: true, bytes: "", nextOffset: "1n", eof: true }),
    ]);
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const access = yield* accessFor(api);
            const handle = yield* access.open("/app.log");
            return yield* handle.read(0n, 1);
          }),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });

  test("maps missing stat responses to Option.none", async () => {
    const stat = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(accessFor(protocolApi([helperLine({ ok: true, missing: true })])), (access) =>
          access.stat("/missing.log"),
        ),
      ),
    );
    expect(Option.isNone(stat)).toBe(true);
  });
});

test("one scoped helper survives missing-file readiness, rotation, and truncation", async () => {
  // Given: a protocol adapter backed by real in-memory file handles.
  const memory = makeMemoryLogFileAccess();
  const fake = makeFakeApi();
  let stats = 0;
  let handle: LogFileHandle | undefined;
  const requestSchema = Schema.Struct({
    op: Schema.Literals(["stat", "open", "fstat", "read", "close"]),
    path: Schema.optionalKey(Schema.String),
    offset: Schema.optionalKey(Schema.String),
    maxBytes: Schema.optionalKey(Schema.Number),
  });
  const statValue = (value: { dev: string; ino: string; size: bigint }) => ({
    ...value,
    size: String(value.size),
  });
  const api: DataPlaneApiClient = {
    ...fake.api,
    stream: (request) =>
      Stream.fromAsyncIterable(
        (async function* () {
          for await (const line of inputLines(request.stdin)) {
            const command = Schema.decodeUnknownSync(requestSchema)(JSON.parse(line));
            let response: unknown = { ok: true };
            switch (command.op) {
              case "stat": {
                stats++;
                if (stats === 1) {
                  memory.writeFile("/app.log", "initial-long-line\n");
                  response = { ok: true, missing: true };
                  break;
                }
                if (stats === 3) memory.rotateRenameCreate("/app.log", "rotated-long-line\n");
                if (stats === 4) memory.copyTruncate("/app.log", "x\n");
                const stat = await Effect.runPromise(memory.access.stat("/app.log"));
                response = Option.isSome(stat)
                  ? { ok: true, stat: statValue(stat.value) }
                  : { ok: true, missing: true };
                break;
              }
              case "open":
                handle = await Effect.runPromise(memory.access.open(command.path ?? ""));
                response = { ok: true, stat: statValue(await Effect.runPromise(handle.stat)) };
                break;
              case "fstat":
                if (handle === undefined) throw new TypeError("Missing fixture handle");
                response = { ok: true, stat: statValue(await Effect.runPromise(handle.stat)) };
                break;
              case "read": {
                if (handle === undefined) throw new TypeError("Missing fixture handle");
                const read = await Effect.runPromise(
                  handle.read(BigInt(command.offset ?? "0"), command.maxBytes ?? 65_536),
                );
                response = {
                  ok: true,
                  bytes: Buffer.from(read.bytes).toString("base64"),
                  nextOffset: String(read.nextOffset),
                  eof: read.eof,
                };
                break;
              }
              case "close":
                if (handle !== undefined) await Effect.runPromise(handle.close);
                handle = undefined;
                break;
              default: {
                const exhaustive: never = command.op;
                throw new TypeError(`Unexpected fixture operation ${exhaustive}`);
              }
            }
            yield helperLine(response);
          }
        })(),
        (cause) =>
          new ProviderInternalError({
            providerId: "test",
            operation: "fixture",
            message: "protocol failed",
            cause,
            remediation:
              "Re-run the command after checking `test` logs for the `fixture` failure; if it persists, report the error with that operation name.",
          }),
      ),
  };
  const source = Schema.decodeUnknownSync(LogSource)({
    id: "app",
    path: "/app.log",
    strategy: "follow",
    stream: "stdout",
  });
  // When: readiness, rotation, and truncation run through the public follower surface.
  const lines = await Effect.runPromise(
    Stream.runCollect(
      logFollowLineChunks(
        followLogSources({
          service: ServiceName.make("web"),
          sources: [source],
          follow: true,
          pollIntervalMillis: 1,
          access: accessFor(api),
        }),
      ).pipe(Stream.take(3)),
    ),
  );
  // Then: all lines came through one installed reader and its scope cleaned up once.
  expect(lines.map((line) => line.line)).toEqual(["initial-long-line", "rotated-long-line", "x"]);
  expect(fake.archives).toHaveLength(1);
  expect(fake.execs.filter((exec) => exec.user === undefined)).toHaveLength(1);
  expect(fake.execs.filter((exec) => exec.user === "0")).toHaveLength(1);
});
