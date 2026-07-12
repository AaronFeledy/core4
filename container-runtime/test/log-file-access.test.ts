import { describe, expect, test } from "bun:test";
import { Effect, Exit, Option, Stream } from "effect";

import type { DataPlaneApiClient, DataPlaneHttpRequest } from "@lando/container-runtime/data-plane";
import { makeDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import { ProviderInternalError } from "@lando/sdk/errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);

const collectAsyncBytes = async (
  input: AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array<ArrayBufferLike>> => {
  const chunks: Uint8Array[] = [];
  if (input !== undefined) for await (const chunk of input) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

async function* inputLines(input: AsyncIterable<Uint8Array> | undefined): AsyncGenerator<string> {
  if (input === undefined) return;
  let buffered = "";
  for await (const chunk of input) {
    buffered += text(chunk);
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
    }
  }
  if (buffered.length > 0) yield buffered;
}

const helperLine = (value: unknown): Uint8Array => bytes(`${JSON.stringify(value)}\n`);

const dockerFrame = (stream: 1 | 2, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = stream;
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
};

const parsedOp = (line: string): string | undefined => {
  const decoded: unknown = JSON.parse(line);
  return typeof decoded === "object" && decoded !== null && "op" in decoded && typeof decoded.op === "string"
    ? decoded.op
    : undefined;
};

const objectField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;

interface FakeExec {
  readonly id: string;
  readonly command: ReadonlyArray<string>;
}

const makeFakeApi = () => {
  const requests: DataPlaneHttpRequest[] = [];
  const execs: FakeExec[] = [];
  let uploaded: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let uploadBodyCarriesBytes = false;
  let uploadContentType: string | undefined;
  let archived = false;
  let closed = false;
  let aborted = false;
  let nextExec = 0;
  let markClosed = () => {};
  const closeSeen = new Promise<"closed">((resolve) => {
    markClosed = () => resolve("closed");
  });
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.promise(async () => {
        requests.push(request);
        if (request.method === "PUT" && request.path.startsWith("/containers/service/archive?")) {
          archived = true;
          uploadBodyCarriesBytes = request.body instanceof Uint8Array;
          uploadContentType = request.headers?.["Content-Type"];
          uploaded = await collectAsyncBytes(request.stdin);
          return { status: 200, body: "{}" };
        }
        if (request.method === "POST" && request.path === "/containers/service/exec") {
          const id = `exec-${nextExec}`;
          nextExec += 1;
          const body = request.body;
          const command =
            typeof body === "object" && body !== null && "Cmd" in body && Array.isArray(body.Cmd)
              ? body.Cmd.filter((item): item is string => typeof item === "string")
              : [];
          execs.push({ id, command });
          return { status: 201, body: JSON.stringify({ Id: id }) };
        }
        return { status: 500, body: JSON.stringify({ message: "unexpected request" }) };
      }),
    stream: (request) =>
      Stream.fromAsyncIterable(
        (async function* () {
          requests.push(request);
          for await (const line of inputLines(request.stdin)) {
            aborted = request.signal?.aborted === true;
            if (line.length === 0) continue;
            const op = parsedOp(line);
            if (op === "open" || op === "stat" || op === "fstat")
              yield helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "11" } });
            if (op === "read")
              yield helperLine({
                ok: true,
                bytes: Buffer.from("hello").toString("base64"),
                nextOffset: "5",
                eof: false,
              });
            if (op === "close") {
              closed = true;
              markClosed();
              yield helperLine({ ok: true });
              return;
            }
          }
          aborted = request.signal?.aborted === true;
        })(),
        (cause) =>
          new ProviderInternalError({
            providerId: "test",
            operation: "log-file-access.test",
            message: "fake stream failed",
            cause,
          }),
      ),
  };
  return {
    api,
    closeSeen,
    execs,
    requests,
    state: () => ({ archived, closed, aborted, uploaded, uploadBodyCarriesBytes, uploadContentType }),
  };
};

const waitClosed = async (closed: Promise<"closed">): Promise<string> => {
  const result = await Promise.race([
    closed,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
  ]);
  return result;
};

const makeProtocolApi = (line: Uint8Array): DataPlaneApiClient => ({
  request: (request) =>
    request.path === "/containers/service/exec"
      ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "stat" }) })
      : Effect.succeed({ status: 200, body: "{}" }),
  stream: () => Stream.make(line),
});

const makeSplitProtocolApi = (payload: Uint8Array, splitAt: number): DataPlaneApiClient => ({
  request: (request) =>
    request.path === "/containers/service/exec"
      ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "stat" }) })
      : Effect.succeed({ status: 200, body: "{}" }),
  stream: () => Stream.make(payload.slice(0, splitAt), payload.slice(splitAt)),
});

const makeChunkedProtocolApi = (chunks: ReadonlyArray<Uint8Array>): DataPlaneApiClient => ({
  request: (request) =>
    request.path === "/containers/service/exec"
      ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "stat" }) })
      : Effect.succeed({ status: 200, body: "{}" }),
  stream: () => Stream.make(...chunks),
});

const makeReadEchoApi = (): DataPlaneApiClient => ({
  request: (request) =>
    request.path === "/containers/service/exec"
      ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "read" }) })
      : Effect.succeed({ status: 200, body: "{}" }),
  stream: (request) =>
    Stream.fromAsyncIterable(
      (async function* () {
        for await (const line of inputLines(request.stdin)) {
          const decoded: unknown = JSON.parse(line);
          const op = objectField(decoded, "op");
          if (op === "open") yield helperLine({ ok: true, stat: { dev: "1", ino: "2", size: "0" } });
          if (op === "read") {
            const requested = objectField(decoded, "maxBytes");
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
          operation: "log-file-access.test",
          message: "fake stream failed",
          cause,
        }),
    ),
});

describe("Docker-compatible log file access", () => {
  test("installs a static helper and keeps reads bounded on an open exec session", async () => {
    const fake = makeFakeApi();
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api: fake.api,
      container: "service",
      helperPayload: bytes("helper binary"),
    });

    const handle = await Effect.runPromise(access.open("/var/log/app.log"));
    await Effect.runPromise(handle.close);
    await Effect.runPromise(handle.close);
    const closeResult = await waitClosed(fake.closeSeen);

    expect(fake.state()).toMatchObject({
      archived: true,
      closed: true,
      uploadBodyCarriesBytes: false,
      uploadContentType: "application/x-tar",
    });
    expect(closeResult).toBe("closed");
    expect(fake.state().uploaded.byteLength).toBeGreaterThan(bytes("helper binary").byteLength);
    expect(
      fake.requests.some((request) => request.method === "GET" && request.path.includes("/archive")),
    ).toBe(false);
    expect(fake.execs[0]?.command).toEqual(["/tmp/lando-log-file-helper"]);
  });

  test("decodes helper frames split across UTF-8 byte boundaries", async () => {
    const frame = helperLine({ ok: true, stat: { dev: "dé", ino: "2", size: "0" } });
    const splitAt = text(frame).indexOf("é");
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api: makeSplitProtocolApi(frame, splitAt + 1),
      container: "service",
      helperPayload: bytes("helper"),
    });

    const stat = await Effect.runPromise(access.stat("/var/log/app.log"));

    expect(Option.getOrUndefined(stat)?.dev).toBe("dé");
  });

  test("closes one-shot stat helper sessions gracefully", async () => {
    const fake = makeFakeApi();
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api: fake.api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const stat = await Effect.runPromise(access.stat("/var/log/app.log"));
    const closeResult = await waitClosed(fake.closeSeen);

    expect(Option.getOrUndefined(stat)?.dev).toBe("1");
    expect(closeResult).toBe("closed");
    expect(fake.state()).toMatchObject({ closed: true, aborted: false });
  });

  test("decodes Docker stdout attach frames split across arbitrary chunks", async () => {
    const frame = dockerFrame(1, helperLine({ ok: true, stat: { dev: "docker", ino: "2", size: "0" } }));
    const api = makeChunkedProtocolApi([
      frame.slice(0, 2),
      frame.slice(2, 8),
      frame.slice(8, 13),
      frame.slice(13),
    ]);
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const stat = await Effect.runPromise(access.stat("/var/log/app.log"));

    expect(Option.getOrUndefined(stat)?.dev).toBe("docker");
  });

  test("decodes raw Podman helper JSON output", async () => {
    const api = makeChunkedProtocolApi([
      helperLine({ ok: true, stat: { dev: "podman", ino: "2", size: "0" } }),
    ]);
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const stat = await Effect.runPromise(access.stat("/var/log/app.log"));

    expect(Option.getOrUndefined(stat)?.dev).toBe("podman");
  });

  test("maps Docker stderr attach frames to typed provider failure", async () => {
    const api = makeChunkedProtocolApi([dockerFrame(2, bytes("helper exploded\n"))]);
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const exit = await Effect.runPromiseExit(access.stat("/var/log/app.log"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ProviderInternalError);
    }
  });

  test("clamps maximum reads so base64 frames fit within protocol bounds", async () => {
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api: makeReadEchoApi(),
      container: "service",
      helperPayload: bytes("helper"),
    });
    const handle = await Effect.runPromise(access.open("/var/log/app.log"));

    const read = await Effect.runPromise(handle.read(0n, 1_000_000));
    await Effect.runPromise(handle.close);

    expect(read.bytes.byteLength).toBe(65_536);
    expect(read.nextOffset).toBe(65_536n);
  });

  test("maps missing stat responses to Option.none", async () => {
    const api = makeProtocolApi(helperLine({ ok: true, missing: true }));
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const stat = await Effect.runPromise(access.stat("/missing.log"));

    expect(Option.isNone(stat)).toBe(true);
  });

  test("maps corrupted helper protocol to ProviderInternalError", async () => {
    const api = makeProtocolApi(bytes("not-json\n"));
    const access = makeDockerLogFileAccess({
      providerId: "test",
      api,
      container: "service",
      helperPayload: bytes("helper"),
    });

    const exit = await Effect.runPromiseExit(access.stat("/var/log/app.log"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ProviderInternalError);
    }
  });
});
