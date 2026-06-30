import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { type Context, Effect, Exit, Layer, Queue, Stream } from "effect";

import type { AbsolutePath, DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Downloader, type DownloaderShape, EventService, type LandoEvent } from "@lando/sdk/services";
import { type DownloaderContractHarness, runDownloaderContract } from "@lando/sdk/test";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import type { HttpClientCapabilities } from "@lando/sdk/schema";

import { DownloaderLive } from "../../src/downloader/service.ts";
import { makeHttpClientLive } from "../../src/http-client/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../../src/http-client/network-trust.ts";
import { HttpClient, type HttpClientShape } from "../../src/http-client/service.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";

const CONTRACT_HTTP_CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http", "file"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-dl-contract-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fsHarnessHooks = (tempDir: string) => ({
  read: (filename: string) =>
    Effect.promise(async () => {
      try {
        return new Uint8Array(await readFile(join(tempDir, filename)));
      } catch {
        return null;
      }
    }),
  listDir: () => Effect.promise(() => readdir(tempDir)),
});

const captureEventService = () => {
  const captured: Array<LandoEvent> = [];
  const service: Context.Tag.Service<typeof EventService> = {
    publish: (event) => Effect.sync(() => void captured.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  };
  return { service, events: () => [...captured] };
};

describe("Downloader contract suite", () => {
  test("TestDownloader (in-memory) satisfies the contract", async () => {
    await withTempDir(async (dir) => {
      const td = await run(makeTestDownloader());
      const hooks = fsHarnessHooks(dir);
      const harness: DownloaderContractHarness = {
        name: "TestDownloader",
        service: td.service,
        tempDir: dir as AbsolutePath,
        serveSource: (url, bytes) => Effect.sync(() => td.serve(url, bytes)),
        read: hooks.read,
        listDir: hooks.listDir,
        events: () => Effect.sync(() => td.events()),
        egress: {
          streamCallCount: () => Effect.sync(() => td.streamCallCount()),
          bytesStreamed: () => Effect.sync(() => td.bytesStreamed()),
        },
      };

      const result = await run(runDownloaderContract(harness));
      expect(result).toBeUndefined();
    });
  });

  test("DownloaderLive (instrumented HttpClient) satisfies the contract and egress fence", async () => {
    await withTempDir(async (dir) => {
      const sources = new Map<string, Uint8Array>();
      let streamCalls = 0;
      let bytesStreamed = 0;
      const http: HttpClientShape = {
        id: "instrumented-http",
        capabilities: CONTRACT_HTTP_CAPABILITIES,
        request: (request) =>
          Effect.suspend(() => {
            const body = sources.get(request.url);
            if (body === undefined) {
              return Effect.fail(
                new HttpRequestError({ message: "no source", urlOrigin: request.url, status: 404 }),
              );
            }
            return Effect.succeed({ status: 200, headers: [], contentLength: body.length });
          }),
        stream: (request) =>
          Effect.suspend(() => {
            streamCalls += 1;
            const body = sources.get(request.url);
            if (body === undefined) {
              return Effect.fail(
                new HttpRequestError({ message: "no source", urlOrigin: request.url, status: 404 }),
              );
            }
            bytesStreamed += body.length;
            return Effect.succeed({
              status: 200,
              headers: [],
              body: Stream.fromIterable([body]),
            });
          }),
        upload: (request) =>
          Effect.fail(new HttpUploadError({ message: "upload unsupported", urlOrigin: request.url })),
      };
      const capture = captureEventService();
      const service = await run(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              return yield* Downloader;
            }),
            DownloaderLive.pipe(
              Layer.provide(
                Layer.mergeAll(Layer.succeed(HttpClient, http), Layer.succeed(EventService, capture.service)),
              ),
            ),
          ),
        ),
      );
      const hooks = fsHarnessHooks(dir);
      const harness: DownloaderContractHarness = {
        name: "DownloaderLive",
        service,
        tempDir: dir as AbsolutePath,
        serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
        read: hooks.read,
        listDir: hooks.listDir,
        events: () => Effect.sync(() => capture.events()),
        egress: {
          streamCallCount: () => Effect.sync(() => streamCalls),
          bytesStreamed: () => Effect.sync(() => bytesStreamed),
        },
      };

      const result = await run(runDownloaderContract(harness));
      expect(result).toBeUndefined();
    });
  });
});

const expectContractFails = async (
  effect: Effect.Effect<void, unknown>,
  assertionSubstring: string,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(JSON.stringify(exit)).toContain(assertionSubstring);
};

describe("Downloader contract rejects weakened contributed downloaders", () => {
  test("a downloader that swallows checksum mismatches fails the contract", async () => {
    await withTempDir(async (dir) => {
      const td = await run(makeTestDownloader());
      const rogue: DownloaderShape = {
        id: "rogue-checksum",
        capabilities: td.service.capabilities,
        download: (request) =>
          td.service.download(request).pipe(
            Effect.catchTag("DownloadChecksumError", () =>
              Effect.succeed({
                url: request.url,
                kind: "memory",
                sha256: "",
                sizeBytes: 0,
                fromCache: false,
              } satisfies DownloadResult),
            ),
          ),
      };
      const hooks = fsHarnessHooks(dir);
      const harness: DownloaderContractHarness = {
        service: rogue,
        tempDir: dir as AbsolutePath,
        serveSource: (url, bytes) => Effect.sync(() => td.serve(url, bytes)),
        read: hooks.read,
        listDir: hooks.listDir,
        events: () => Effect.sync(() => td.events()),
      };
      await expectContractFails(runDownloaderContract(harness), "checksum mismatch");
    });
  });

  test("a downloader that swallows destination-escape rejection fails the contract", async () => {
    await withTempDir(async (dir) => {
      const td = await run(makeTestDownloader());
      const rogue: DownloaderShape = {
        id: "rogue-path",
        capabilities: td.service.capabilities,
        download: (request) =>
          td.service.download(request).pipe(
            Effect.catchTag("DownloadSourceForbiddenError", (error) =>
              error.reason === "destination-escape"
                ? Effect.succeed({
                    url: request.url,
                    kind: "file",
                    path: join(dir, "leak"),
                    sha256: "",
                    sizeBytes: 0,
                    fromCache: false,
                  } satisfies DownloadResult)
                : Effect.fail(error),
            ),
          ),
      };
      const hooks = fsHarnessHooks(dir);
      const harness: DownloaderContractHarness = {
        service: rogue,
        tempDir: dir as AbsolutePath,
        serveSource: (url, bytes) => Effect.sync(() => td.serve(url, bytes)),
        read: hooks.read,
        listDir: hooks.listDir,
        events: () => Effect.sync(() => td.events()),
      };
      await expectContractFails(runDownloaderContract(harness), "escaping the directory");
    });
  });

  test("a downloader that leaks a secret into an event fails the contract", async () => {
    await withTempDir(async (dir) => {
      const td = await run(makeTestDownloader());
      const leaked: Array<LandoEvent> = [];
      const rogue: DownloaderShape = {
        id: "rogue-redaction",
        capabilities: td.service.capabilities,
        download: (request) =>
          Effect.gen(function* () {
            if (request.redactionTokens !== undefined && request.redactionTokens.length > 0) {
              leaked.push({
                _tag: "pre-download",
                eventName: "pre-download",
                urlOrigin: request.url,
                leaked: request.redactionTokens[0],
              } as unknown as LandoEvent);
            }
            return yield* td.service.download(request);
          }),
      };
      const hooks = fsHarnessHooks(dir);
      const harness: DownloaderContractHarness = {
        service: rogue,
        tempDir: dir as AbsolutePath,
        serveSource: (url, bytes) => Effect.sync(() => td.serve(url, bytes)),
        read: hooks.read,
        listDir: hooks.listDir,
        events: () => Effect.sync(() => [...td.events(), ...leaked]),
      };
      await expectContractFails(runDownloaderContract(harness), "never appears in an event");
    });
  });
});

describe("DownloaderLive threads network trust through HttpClient", () => {
  const payload = new TextEncoder().encode("trust canary payload");
  const expectedSha256 = sha256Hex(payload);

  const runCanary = async (
    url: string,
    trust: ResolvedNetworkTrust,
  ): Promise<{ proxy?: string; tls?: { ca?: ReadonlyArray<string> } }> => {
    const captured: Array<{ proxy?: string; tls?: { ca?: ReadonlyArray<string> } }> = [];
    const captureFetch = ((_input: string | URL | Request, init?: unknown) => {
      captured.push((init ?? {}) as { proxy?: string; tls?: { ca?: ReadonlyArray<string> } });
      return Promise.resolve(new Response(payload));
    }) as unknown as typeof fetch;

    const request: DownloadRequest = {
      url,
      destination: { kind: "memory" },
      expectedSha256,
    };
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const downloader = yield* Downloader;
          return yield* downloader.download(request);
        }),
      ).pipe(
        Effect.provideService(NetworkTrust, trust),
        Effect.provide(DownloaderLive.pipe(Layer.provide(makeHttpClientLive(captureFetch)))),
      ),
    );
    return captured[0] ?? {};
  };

  test("an https download applies the https proxy and configured CA", async () => {
    const init = await runCanary("https://canary.test/x", {
      proxy: { http: "http://proxy.http:8080", https: "http://proxy.https:8443", noProxy: [] },
      caPems: ["-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----"],
    });
    expect(init.proxy).toBe("http://proxy.https:8443");
    expect(init.tls?.ca).toContain("-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----");
  });

  test("a NO_PROXY host bypasses the proxy but keeps the CA", async () => {
    const init = await runCanary("https://canary.test/x", {
      proxy: { http: "http://proxy.http:8080", https: "http://proxy.https:8443", noProxy: ["canary.test"] },
      caPems: ["-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----"],
    });
    expect(init.proxy).toBeUndefined();
    expect(init.tls?.ca).toContain("-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----");
  });
});
