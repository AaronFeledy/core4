import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer, Queue, Stream } from "effect";

import { Downloader, EventService, type LandoEvent } from "@lando/sdk/services";

import { DownloaderLive } from "../../src/downloader/service.ts";
import {
  HttpClient,
  type HttpClientShape,
  HttpStreamError,
  type HttpStreamRequest,
} from "../../src/http-client/service.ts";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const makeFakeHttpClient = (bodies: Record<string, () => Stream.Stream<Uint8Array, HttpStreamError>>) => {
  const calls: HttpStreamRequest[] = [];
  const service: HttpClientShape = {
    id: "fake-http",
    stream: (request) =>
      Effect.suspend(() => {
        calls.push(request);
        const factory = bodies[request.url];
        if (factory === undefined) {
          return Effect.fail(
            new HttpStreamError({ message: "no fake response", url: request.url, status: 404 }),
          );
        }
        return Effect.succeed({
          status: 200,
          headers: new Map<string, string>(),
          body: factory(),
        });
      }),
  };
  return { layer: Layer.succeed(HttpClient, service), calls };
};

const makeCapturingEventService = () => {
  const captured: LandoEvent[] = [];
  const service: Context.Tag.Service<typeof EventService> = {
    publish: (event) => Effect.sync(() => void captured.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
  };
  return { layer: Layer.succeed(EventService, service), events: () => [...captured] };
};

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-dl-events-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("DownloaderLive event publication + redaction", () => {
  test("a successful download emits pre-download, download-progress, and post-download", async () => {
    await withTempDir(async (dir) => {
      const payload = bytes("verified artifact contents");
      const url = "https://artifacts.test/path/secret-bin?token=SIGNED-QUERY-SECRET";
      const fake = makeFakeHttpClient({ [url]: () => Stream.fromIterable([payload]) });
      const capture = makeCapturingEventService();

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const downloader = yield* Downloader;
            return yield* downloader.download({
              url,
              destination: { kind: "file", directory: dir, filename: "artifact.bin" },
              expectedSha256: sha256Hex(payload),
              callerId: "provider-lando",
            });
          }),
        ).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer))))),
      );

      const events = capture.events();
      const names = events.map((e) => e._tag);
      expect(names).toContain("pre-download");
      expect(names).toContain("download-progress");
      expect(names).toContain("post-download");

      const post = events.find((e) => e._tag === "post-download");
      expect(post?.outcome).toBe("success");
      expect(post?.fromCache).toBe(false);
    });
  });

  test("events never carry signed-URL query params, userinfo, or caller redaction tokens", async () => {
    await withTempDir(async (_dir) => {
      const secretToken = "ULW-DL-SECRET-d41d8cd9f00b2";
      const payload = bytes("payload");
      const url = `https://user:p4ss@artifacts.test/x?token=${secretToken}`;
      const fake = makeFakeHttpClient({ [url]: () => Stream.fromIterable([payload]) });
      const capture = makeCapturingEventService();

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const downloader = yield* Downloader;
            return yield* downloader.download({
              url,
              destination: { kind: "memory" },
              expectedSha256: sha256Hex(payload),
              callerId: `caller-${secretToken}`,
              redactionTokens: [secretToken, "p4ss"],
            });
          }),
        ).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer))))),
      );

      const serialized = JSON.stringify(capture.events());
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain("p4ss");
      expect(serialized).not.toContain("user:");
      const pre = capture.events().find((e) => e._tag === "pre-download");
      expect(pre?.urlOrigin).toBe("https://artifacts.test");
    });
  });

  test("a failed download emits post-download with a controlled, content-free failureDetail", async () => {
    const secretToken = "ULW-FAIL-SECRET-abc123";
    const url = `https://artifacts.test/x?token=${secretToken}`;
    const fake = makeFakeHttpClient({
      [url]: () => Stream.fail(new HttpStreamError({ message: `boom ${url}`, url, status: 500 })),
    });
    const capture = makeCapturingEventService();

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const downloader = yield* Downloader;
          return yield* downloader.download({
            url,
            destination: { kind: "memory" },
            redactionTokens: [secretToken],
          });
        }),
      ).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer))))),
    );

    expect(exit._tag).toBe("Failure");
    const post = capture.events().find((e) => e._tag === "post-download");
    expect(post?.outcome).toBe("failure");
    expect(JSON.stringify(capture.events())).not.toContain(secretToken);
    expect(typeof post?.failureDetail).toBe("string");
  });
});
