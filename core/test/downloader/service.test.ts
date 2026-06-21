import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Either, Fiber, Layer, Stream } from "effect";

import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Downloader } from "@lando/sdk/services";

import { DownloaderLive } from "../../src/downloader/service.ts";
import {
  HttpClient,
  type HttpClientShape,
  HttpStreamError,
  type HttpStreamRequest,
} from "../../src/http-client/service.ts";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface FakeOptions {
  readonly bodies?: Record<string, () => Stream.Stream<Uint8Array, HttpStreamError>>;
  readonly status?: number;
}

const makeFakeHttpClient = (options: FakeOptions = {}) => {
  const calls: HttpStreamRequest[] = [];
  const service: HttpClientShape = {
    id: "fake-http",
    stream: (request) =>
      Effect.suspend(() => {
        calls.push(request);
        const factory = options.bodies?.[request.url];
        if (factory === undefined) {
          return Effect.fail(
            new HttpStreamError({ message: "no fake response", url: request.url, status: 404 }),
          );
        }
        return Effect.succeed({
          status: options.status ?? 200,
          headers: new Map<string, string>(),
          body: factory(),
        });
      }),
  };
  return { layer: Layer.succeed(HttpClient, service), calls };
};

const download = (
  request: DownloadRequest,
  fake: Layer.Layer<HttpClient>,
): Promise<Either.Either<DownloadResult, unknown>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const downloader = yield* Downloader;
        return yield* downloader.download(request);
      }),
    ).pipe(Effect.either, Effect.provide(DownloaderLive.pipe(Layer.provide(fake)))),
  );

const expectRight = <A>(either: Either.Either<A, unknown>): A => {
  if (Either.isLeft(either)) throw new Error(`expected success, got error: ${JSON.stringify(either.left)}`);
  return either.right;
};

const expectLeft = (either: Either.Either<unknown, unknown>): { _tag?: string; reason?: string } => {
  if (Either.isRight(either)) throw new Error(`expected error, got success: ${JSON.stringify(either.right)}`);
  return either.left as { _tag?: string; reason?: string };
};

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-downloader-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("DownloaderLive", () => {
  test("S1 file success: streams to destination, returns sha256+size, fromCache:false, no temp", async () => {
    await withTempDir(async (dir) => {
      const payload = bytes("verified artifact contents");
      const url = "https://example.test/artifact.bin";
      const fake = makeFakeHttpClient({ bodies: { [url]: () => Stream.fromIterable([payload]) } });

      const result = expectRight(
        await download(
          {
            url,
            destination: { kind: "file", directory: dir, filename: "artifact.bin" },
            expectedSha256: sha256Hex(payload),
            expectedSizeBytes: payload.length,
          },
          fake.layer,
        ),
      );

      expect(result.kind).toBe("file");
      expect(result.fromCache).toBe(false);
      expect(result.sha256).toBe(sha256Hex(payload));
      expect(result.sizeBytes).toBe(payload.length);
      expect(result.path).toBe(join(dir, "artifact.bin"));
      expect(fake.calls.length).toBe(1);
      expect(new Uint8Array(await readFile(join(dir, "artifact.bin")))).toEqual(payload);
      expect((await readdir(dir)).filter((e) => e.includes(".tmp-"))).toEqual([]);
    });
  });

  test("S2 cache hit: verified existing destination short-circuits with zero network", async () => {
    await withTempDir(async (dir) => {
      const payload = bytes("already on disk");
      await writeFile(join(dir, "cached.bin"), payload);
      const url = "https://example.test/cached.bin";
      const fake = makeFakeHttpClient({
        bodies: { [url]: () => Stream.fromIterable([bytes("SHOULD NOT FETCH")]) },
      });

      const result = expectRight(
        await download(
          {
            url,
            destination: { kind: "file", directory: dir, filename: "cached.bin" },
            expectedSha256: sha256Hex(payload),
          },
          fake.layer,
        ),
      );

      expect(result.fromCache).toBe(true);
      expect(result.sha256).toBe(sha256Hex(payload));
      expect(result.sizeBytes).toBe(payload.length);
      expect(fake.calls.length).toBe(0);
    });
  });

  test("S3 offline cache miss: fails before opening a connection", async () => {
    await withTempDir(async (dir) => {
      const url = "https://example.test/missing.bin";
      const fake = makeFakeHttpClient({ bodies: { [url]: () => Stream.fromIterable([bytes("x")]) } });

      const error = expectLeft(
        await download(
          {
            url,
            destination: { kind: "file", directory: dir, filename: "missing.bin" },
            expectedSha256: sha256Hex(bytes("x")),
            offline: true,
          },
          fake.layer,
        ),
      );

      expect(error._tag).toBe("DownloadOfflineError");
      expect(fake.calls.length).toBe(0);
    });
  });

  test("S4 scheme gating: http rejected, file gated, allowed file flows through", async () => {
    await withTempDir(async (dir) => {
      // http:// rejected (reason: scheme), no network
      const httpUrl = "http://example.test/insecure.bin";
      const fakeHttp = makeFakeHttpClient({ bodies: { [httpUrl]: () => Stream.fromIterable([bytes("x")]) } });
      const httpError = expectLeft(
        await download(
          { url: httpUrl, destination: { kind: "file", directory: dir, filename: "insecure.bin" } },
          fakeHttp.layer,
        ),
      );
      expect(httpError._tag).toBe("DownloadSourceForbiddenError");
      expect(httpError.reason).toBe("scheme");
      expect(fakeHttp.calls.length).toBe(0);

      // file:// without allowFileSource (reason: file-source), no network
      const fileUrl = "file:///tmp/local-artifact.bin";
      const fakeFile = makeFakeHttpClient({ bodies: { [fileUrl]: () => Stream.fromIterable([bytes("x")]) } });
      const fileError = expectLeft(
        await download(
          { url: fileUrl, destination: { kind: "file", directory: dir, filename: "local.bin" } },
          fakeFile.layer,
        ),
      );
      expect(fileError._tag).toBe("DownloadSourceForbiddenError");
      expect(fileError.reason).toBe("file-source");
      expect(fakeFile.calls.length).toBe(0);

      // file:// with allowFileSource flows through HttpClient.stream
      const payload = bytes("local allowed bytes");
      const fakeAllowed = makeFakeHttpClient({ bodies: { [fileUrl]: () => Stream.fromIterable([payload]) } });
      const result = expectRight(
        await download(
          {
            url: fileUrl,
            destination: { kind: "file", directory: dir, filename: "allowed.bin" },
            allowFileSource: true,
            expectedSha256: sha256Hex(payload),
          },
          fakeAllowed.layer,
        ),
      );
      expect(result.fromCache).toBe(false);
      expect(fakeAllowed.calls.length).toBe(1);
      expect(fakeAllowed.calls[0]?.allowFileSource).toBe(true);
      expect(new Uint8Array(await readFile(join(dir, "allowed.bin")))).toEqual(payload);
    });
  });

  test("S5 checksum mismatch: error, no temp, destination not clobbered", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "out.bin"), bytes("pre-existing"));
      const url = "https://example.test/out.bin";
      const fake = makeFakeHttpClient({
        bodies: { [url]: () => Stream.fromIterable([bytes("wrong bytes")]) },
      });

      const error = expectLeft(
        await download(
          {
            url,
            destination: { kind: "file", directory: dir, filename: "out.bin" },
            expectedSha256: "c".repeat(64),
          },
          fake.layer,
        ),
      );

      expect(error._tag).toBe("DownloadChecksumError");
      expect(new Uint8Array(await readFile(join(dir, "out.bin")))).toEqual(bytes("pre-existing"));
      expect((await readdir(dir)).filter((e) => e.includes(".tmp-"))).toEqual([]);
    });
  });

  test("S6 size mismatch: error, no temp", async () => {
    await withTempDir(async (dir) => {
      const url = "https://example.test/sized.bin";
      const fake = makeFakeHttpClient({ bodies: { [url]: () => Stream.fromIterable([bytes("12345")]) } });

      const error = expectLeft(
        await download(
          {
            url,
            destination: { kind: "file", directory: dir, filename: "sized.bin" },
            expectedSizeBytes: 999,
          },
          fake.layer,
        ),
      );

      expect(error._tag).toBe("DownloadSizeMismatchError");
      expect((await readdir(dir)).filter((e) => e.includes(".tmp-"))).toEqual([]);
    });
  });

  test("S7 fetch/body failure: DownloadFetchError, no temp", async () => {
    await withTempDir(async (dir) => {
      const url = "https://example.test/broken.bin";
      const fake = makeFakeHttpClient({
        bodies: {
          [url]: () =>
            Stream.concat(
              Stream.fromIterable([bytes("partial")]),
              Stream.fail(new HttpStreamError({ message: "connection reset", url })),
            ),
        },
      });

      const error = expectLeft(
        await download(
          { url, destination: { kind: "file", directory: dir, filename: "broken.bin" } },
          fake.layer,
        ),
      );

      expect(error._tag).toBe("DownloadFetchError");
      expect((await readdir(dir)).filter((e) => e.includes(".tmp-"))).toEqual([]);
    });
  });

  test("S7b stream-open failure maps to DownloadFetchError", async () => {
    await withTempDir(async (dir) => {
      const url = "https://example.test/unknown.bin";
      const fake = makeFakeHttpClient(); // no body registered -> stream() fails

      const error = expectLeft(
        await download(
          { url, destination: { kind: "file", directory: dir, filename: "unknown.bin" } },
          fake.layer,
        ),
      );
      expect(error._tag).toBe("DownloadFetchError");
    });
  });

  test("S8 interrupt mid-stream removes the temp file", async () => {
    await withTempDir(async (dir) => {
      const url = "https://example.test/blocking.bin";
      const fake = makeFakeHttpClient({
        bodies: { [url]: () => Stream.concat(Stream.fromIterable([bytes("chunk")]), Stream.never) },
      });

      const program = Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Effect.gen(function* () {
              const downloader = yield* Downloader;
              return yield* downloader.download({
                url,
                destination: { kind: "file", directory: dir, filename: "blocking.bin" },
              });
            }),
          ).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(fake.layer)))),
        );
        yield* Effect.iterate(0, {
          while: (n) => n < 200,
          body: (n) =>
            Effect.gen(function* () {
              const entries = yield* Effect.promise(() => readdir(dir));
              if (entries.some((e) => e.includes(".tmp-"))) return 1000;
              yield* Effect.sleep("5 millis");
              return n + 1;
            }),
        });
        yield* Fiber.interrupt(fiber);
      });

      await Effect.runPromise(program);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("S9 memory mode: verify-only result with sha256+size, no path, no file", async () => {
    await withTempDir(async (dir) => {
      const payload = bytes("memory-only payload");
      const url = "https://example.test/mem.bin";
      const fake = makeFakeHttpClient({ bodies: { [url]: () => Stream.fromIterable([payload]) } });

      const result = expectRight(
        await download(
          {
            url,
            destination: { kind: "memory" },
            expectedSha256: sha256Hex(payload),
            expectedSizeBytes: payload.length,
          },
          fake.layer,
        ),
      );

      expect(result.kind).toBe("memory");
      expect(result.path).toBeUndefined();
      expect(result.sha256).toBe(sha256Hex(payload));
      expect(result.sizeBytes).toBe(payload.length);
      expect(result.fromCache).toBe(false);
      expect(await readdir(dir)).toEqual([]);
      expect(fake.calls.length).toBe(1);
    });
  });

  test("declares capabilities (https scheme, memory, cache-aware, offline)", async () => {
    const fake = makeFakeHttpClient();
    const caps = await Effect.runPromise(
      Effect.gen(function* () {
        const downloader = yield* Downloader;
        return downloader.capabilities;
      }).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(fake.layer)))),
    );
    expect(caps.schemes).toContain("https");
    expect(caps.memoryDownload).toBe(true);
    expect(caps.cacheAware).toBe(true);
    expect(caps.offline).toBe(true);
  });
});
