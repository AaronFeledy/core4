import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, type Scope, Stream } from "effect";

import { HttpClientBasicLive, makeHttpClientBasicLive } from "../../src/http-client/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../../src/http-client/network-trust.ts";
import {
  HttpClient,
  HttpStreamError,
  type HttpStreamRequest,
  type HttpStreamResponse,
} from "../../src/http-client/service.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-http-client-"));
  tempDirs.push(dir);
  return dir;
};

const run = <A, E>(program: Effect.Effect<A, E, HttpClient | Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(HttpClientBasicLive))));

const runExit = <A, E>(program: Effect.Effect<A, E, HttpClient | Scope.Scope>) =>
  Effect.runPromiseExit(Effect.scoped(program.pipe(Effect.provide(HttpClientBasicLive))));

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array =>
  new Uint8Array(Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))));

const collectBody = (response: HttpStreamResponse) =>
  Stream.runCollect(response.body).pipe(Effect.map(concatBytes));

const streamAndCollect = (request: HttpStreamRequest) =>
  Effect.flatMap(HttpClient, (client) =>
    Effect.flatMap(client.stream(request), (response) =>
      Effect.map(collectBody(response), (body) => ({
        body,
        headers: response.headers,
        status: response.status,
      })),
    ),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("HttpClientBasicLive", () => {
  test("streams allowed file:// sources from disk", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.bin");
    const expected = new Uint8Array([0, 1, 2, 3, 254, 255]);
    await writeFile(file, expected);

    const result = await run(streamAndCollect({ url: pathToFileURL(file).href, allowFileSource: true }));

    expect(result.status).toBe(200);
    expect(Array.from(result.headers.entries())).toEqual([]);
    expect(result.body).toEqual(expected);
  });

  test("rejects file:// sources without reading when not explicitly allowed", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.txt");
    await writeFile(file, "not read\n");

    const exit = await runExit(
      Effect.flatMap(HttpClient, (client) => client.stream({ url: pathToFileURL(file).href })),
    );
    const error = failureOf(exit);

    expect(error).toBeInstanceOf(HttpStreamError);
    expect((error as HttpStreamError)._tag).toBe("HttpStreamError");
    expect((error as HttpStreamError).message).toBe("file:// source not permitted");
    await expect(readFile(file, "utf8")).resolves.toBe("not read\n");
  });

  test("rejects unsupported schemes", async () => {
    const exit = await runExit(Effect.flatMap(HttpClient, (client) => client.stream({ url: "ftp://x" })));
    const error = failureOf(exit);

    expect(error).toBeInstanceOf(HttpStreamError);
    expect((error as HttpStreamError)._tag).toBe("HttpStreamError");
    expect((error as HttpStreamError).message).toBe("unsupported scheme");
  });

  test("exposes a stable service id", async () => {
    const id = await run(Effect.map(HttpClient, (client) => client.id));

    expect(id).toBe("core-http-client-basic");
  });

  test("streams http:// response bodies from loopback fetch", async () => {
    const expected = new TextEncoder().encode("hello from loopback\n");
    const server = Bun.serve({
      fetch: () => new Response(expected, { headers: { "x-lando-test": "yes" }, status: 200 }),
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const result = await run(streamAndCollect({ url: `http://127.0.0.1:${server.port}/artifact` }));

      expect(result.status).toBe(200);
      expect(result.headers.get("x-lando-test")).toBe("yes");
      expect(result.body).toEqual(expected);
    } finally {
      server.stop(true);
    }
  });
});

describe("HttpClientBasicLive network trust", () => {
  const CA_PEM = "-----BEGIN CERTIFICATE-----\nMOCKCA\n-----END CERTIFICATE-----";

  const captureFetch = (): {
    readonly fetchImpl: typeof fetch;
    readonly init: () => BunFetchRequestInit | undefined;
  } => {
    let captured: BunFetchRequestInit | undefined;
    const fetchImpl = ((_input: unknown, requestInit?: BunFetchRequestInit) => {
      captured = requestInit;
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as typeof fetch;
    return { fetchImpl, init: () => captured };
  };

  const drive = (
    fetchImpl: typeof fetch,
    request: HttpStreamRequest,
    trust?: ResolvedNetworkTrust,
  ): Promise<void> => {
    const base = streamAndCollect(request).pipe(
      Effect.asVoid,
      Effect.provide(makeHttpClientBasicLive(fetchImpl)),
    );
    const program = trust === undefined ? base : base.pipe(Effect.provideService(NetworkTrust, trust));
    return Effect.runPromise(Effect.scoped(program));
  };

  test("applies resolved proxy and CA trust to the fetch init", async () => {
    const capture = captureFetch();
    await drive(
      capture.fetchImpl,
      { url: "https://example.com/artifact" },
      {
        proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: [] },
        caPems: [CA_PEM],
      },
    );

    expect(capture.init()?.proxy).toBe("http://proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("bypasses the proxy for NO_PROXY hosts while still applying the CA", async () => {
    const capture = captureFetch();
    await drive(
      capture.fetchImpl,
      { url: "https://example.com/artifact" },
      {
        proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: ["example.com"] },
        caPems: [CA_PEM],
      },
    );

    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("leaves the fetch init free of proxy/tls when no NetworkTrust is provided", async () => {
    const capture = captureFetch();
    await drive(capture.fetchImpl, { url: "https://example.com/artifact" });

    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toBeUndefined();
  });
});
