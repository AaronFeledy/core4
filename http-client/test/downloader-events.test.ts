import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { type Context, Effect, Layer, Option, Queue, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Downloader, EventService, type LandoEvent } from "@lando/sdk/services";

import { makeDownloaderEvents } from "../src/downloader-events.ts";
import { layer as DownloaderLayer } from "../src/downloader.ts";

test("downloader event text masks values registered after event seam construction", async () => {
  // Given
  const redaction = makeRedactionService();
  const events = makeDownloaderEvents(Option.none(), Effect.runSync(redaction.forProfile("secrets")));
  const secret = "downloader-registered-canary";
  await Effect.runPromise(redaction.registerValues([secret]));
  // When
  const text = events.redactText(`download failed with ${secret}`);
  // Then
  expect(text).toBe("download failed with [redacted]");
});

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const makeFakeHttpClient = (bodies: Record<string, Uint8Array | "fail">) => {
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = bodies[url.href] ?? bodies[request.url];
      if (body === undefined || body === "fail") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: body === "fail" ? `boom ${url.href}` : "no fake response",
              description: "request failed",
            }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(request, new Response(new Uint8Array(body), { status: 200 }));
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const makeCapturingEventService = () => {
  const captured: LandoEvent[] = [];
  const service: Context.Service.Shape<typeof EventService> = {
    publish: (event) => Effect.sync(() => void captured.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
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

describe("Downloader layer event publication + redaction", () => {
  test.each([false, true])(
    "masks environment secrets in events (runtime service=%s)",
    async (withService) => {
      // Given: the caller id contains a secret not labelled in the emitted text.
      const secret = "downloader-environment-canary";
      const previous = process.env.P5_DOWNLOADER_SECRET;
      process.env.P5_DOWNLOADER_SECRET = secret;
      const payload = bytes("verified payload");
      const url = "https://artifacts.test/environment";
      const fake = makeFakeHttpClient({ [url]: payload });
      const capture = makeCapturingEventService();
      const dependencies = Layer.mergeAll(
        fake.layer,
        capture.layer,
        withService ? Layer.succeed(RedactionService, makeRedactionService()) : Layer.empty,
      );
      try {
        // When: the production Downloader layer publishes its lifecycle events.
        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(Downloader, (downloader) =>
              downloader.download({
                url,
                destination: { kind: "memory" },
                expectedSha256: sha256Hex(payload),
                callerId: secret,
              }),
            ),
          ).pipe(Effect.provide(DownloaderLayer.pipe(Layer.provide(dependencies)))),
        );
        // Then: both optional-service paths mask the secret before publishing.
        expect(capture.events().length).toBeGreaterThan(0);
        expect(JSON.stringify(capture.events())).not.toContain(secret);
        expect(capture.events().find((event) => event._tag === "pre-download")?.callerId).toBe("[redacted]");
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "P5_DOWNLOADER_SECRET");
        else process.env.P5_DOWNLOADER_SECRET = previous;
      }
    },
  );

  test("a successful download emits pre-download, download-progress, and post-download", async () => {
    await withTempDir(async (dir) => {
      const payload = bytes("verified artifact contents");
      const url = "https://artifacts.test/path/secret-bin?token=SIGNED-QUERY-SECRET";
      const fake = makeFakeHttpClient({ [url]: payload });
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
        ).pipe(
          Effect.provide(DownloaderLayer.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer)))),
        ),
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
      const fake = makeFakeHttpClient({ [url]: payload });
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
        ).pipe(
          Effect.provide(DownloaderLayer.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer)))),
        ),
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
    const fake = makeFakeHttpClient({ [url]: "fail" });
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
      ).pipe(Effect.provide(DownloaderLayer.pipe(Layer.provide(Layer.mergeAll(fake.layer, capture.layer))))),
    );

    expect(exit._tag).toBe("Failure");
    const post = capture.events().find((e) => e._tag === "post-download");
    expect(post?.outcome).toBe("failure");
    expect(JSON.stringify(capture.events())).not.toContain(secretToken);
    expect(typeof post?.failureDetail).toBe("string");
  });
});
