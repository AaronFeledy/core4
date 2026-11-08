import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, type Context, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { HttpTrustError } from "@lando/sdk/errors";
import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Downloader, EventService, type LandoEvent, OnlineAcquisition } from "@lando/sdk/services";

import { layer as DownloaderLayer } from "../src/downloader.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const payload = bytes("verified artifact contents");
const URL_ = "https://artifacts.test/pkg/artifact.bin";

/** Bun 1.4 fetch failures are TypeErrors carrying a socket `code`. */
const bunError = (code: string, message = `socket failure ${code}`) =>
  Object.assign(new TypeError(message), { code });

type Step =
  | { readonly kind: "ok" }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "open-error"; readonly cause: unknown }
  | { readonly kind: "body-error"; readonly cause: unknown }
  | { readonly kind: "status-error"; readonly status: number }
  | { readonly kind: "release-defect"; readonly cause: unknown }
  | { readonly kind: "die" };

interface Call {
  readonly tempFilesAtOpen: ReadonlyArray<string>;
  readonly releasedBeforeOpen: number;
}

/** Fake transport that plays one scripted step per GET and records attempt cleanup. */
const scriptedClient = (steps: ReadonlyArray<Step>, dir?: string) => {
  const calls: Call[] = [];
  let released = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const tempFilesAtOpen =
        dir === undefined
          ? []
          : (yield* Effect.promise(() => readdir(dir))).filter((entry) => entry.includes(".tmp-"));
      calls.push({ tempFilesAtOpen, releasedBeforeOpen: released });
      // Mirror the live client: the response abort finalizer joins the ambient scope.
      const scope = yield* Effect.serviceOption(Scope.Scope);
      if (Option.isSome(scope))
        yield* Scope.addFinalizer(
          scope.value,
          Effect.sync(() => {
            released += 1;
          }),
        );
      const step = steps[calls.length - 1] ?? { kind: "ok" };
      switch (step.kind) {
        case "ok":
          return HttpClientResponse.fromWeb(request, new Response(new Uint8Array(payload)));
        case "status":
          return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: step.status }));
        case "open-error":
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: step.cause }),
            }),
          );
        case "body-error": {
          const cause = step.cause;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payload.slice(0, 4));
              controller.error(cause);
            },
          });
          return HttpClientResponse.fromWeb(request, new Response(body));
        }
        case "status-error":
          // A contributed client that filters statuses reports them as StatusCodeError.
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.StatusCodeError({
                request,
                response: HttpClientResponse.fromWeb(request, new Response("busy", { status: step.status })),
              }),
            }),
          );
        case "release-defect":
          if (Option.isSome(scope)) yield* Scope.addFinalizer(scope.value, Effect.die("release failed"));
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: step.cause }),
            }),
          );
        case "die":
          return yield* Effect.die("transport bug");
      }
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, client), calls };
};

const capturingEvents = () => {
  const events: LandoEvent[] = [];
  const warned = Effect.runSync(Queue.unbounded<LandoEvent>());
  const service: Context.Service.Shape<typeof EventService> = {
    publish: (event) =>
      Effect.sync(() => void events.push(event)).pipe(
        Effect.andThen(event._tag === "message.warn" ? Queue.offer(warned, event) : Effect.void),
        Effect.asVoid,
      ),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  };
  return {
    layer: Layer.succeed(EventService, service),
    events,
    nextWarning: Queue.take(warned),
    ofTag: (tag: string) => events.filter((event) => event._tag === tag),
  };
};

const fileRequest = (dir: string, extra: Partial<DownloadRequest> = {}): DownloadRequest => ({
  url: URL_,
  destination: { kind: "file", directory: dir, filename: "artifact.bin" },
  expectedSha256: sha256Hex(payload),
  ...extra,
});

type Harness = ReturnType<typeof capturingEvents>;

/** Run one download under TestClock; `drive` advances virtual time between attempts. */
const runDownload = (
  request: DownloadRequest,
  transport: ReturnType<typeof scriptedClient>,
  drive: (fiber: Fiber.Fiber<DownloadResult, unknown>, harness: Harness) => Effect.Effect<void> = () =>
    Effect.void,
  onlineAcquisition = true,
) => {
  const harness = capturingEvents();
  const program = Effect.gen(function* () {
    const downloader = yield* Downloader;
    const fiber = yield* Effect.forkChild(Effect.scoped(downloader.download(request)));
    yield* drive(fiber, harness);
    return yield* Fiber.await(fiber);
  }).pipe(
    Effect.provideService(OnlineAcquisition, onlineAcquisition),
    Effect.provide(DownloaderLayer.pipe(Layer.provide(Layer.merge(transport.layer, harness.layer)))),
    Effect.provide(TestClock.layer()),
  );
  return Effect.runPromise(program).then((exit) => ({ exit, harness }));
};

const failureOf = (exit: Exit.Exit<DownloadResult, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the download to fail");
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as
    | { readonly _tag: string; readonly attempts?: number; readonly message: string }
    | undefined;
};

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-dl-retry-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("Downloader transient retry", () => {
  test("retries an opted-in connection reset after a 1 s backoff and pairs one pre/post event", async () => {
    await withTempDir(async (dir) => {
      // Given: the first GET resets before a response arrives.
      const transport = scriptedClient([
        { kind: "open-error", cause: bunError("ECONNRESET") },
        { kind: "ok" },
      ]);
      // When: virtual time advances to just before, then exactly at, the backoff.
      let getsBeforeBackoff = -1;
      const { exit, harness } = await runDownload(fileRequest(dir), transport, (_fiber, h) =>
        Effect.gen(function* () {
          yield* h.nextWarning;
          yield* TestClock.adjust("999 millis");
          getsBeforeBackoff = transport.calls.length;
          yield* TestClock.adjust("1 millis");
        }),
      );
      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(getsBeforeBackoff).toBe(1);
      expect(transport.calls.length).toBe(2);
      expect(harness.ofTag("pre-download").length).toBe(1);
      const posts = harness.ofTag("post-download");
      expect(posts.length).toBe(1);
      expect(posts[0]).toMatchObject({ outcome: "success", attempts: 2 });
      const warnings = harness.ofTag("message.warn");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatchObject({
        body: "Retrying artifact.bin from https://artifacts.test (attempt 2 of 3): the connection was reset (ECONNRESET).",
      });
    });
  });

  test("retries a mid-body reset after releasing the failed attempt's temp file and response", async () => {
    await withTempDir(async (dir) => {
      // Given: a 200 whose body read rejects with ECONNRESET (Effect maps it to DecodeError).
      const transport = scriptedClient(
        [
          {
            kind: "body-error",
            cause: bunError("ECONNRESET", "The socket connection was closed unexpectedly"),
          },
        ],
        dir,
      );
      // When
      const { exit } = await runDownload(fileRequest(dir), transport, (_fiber, h) =>
        Effect.andThen(h.nextWarning, TestClock.adjust("1 second")),
      );
      // Then: the second GET saw no stale temp file and the first response was already released.
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(transport.calls.length).toBe(2);
      expect(transport.calls[1]).toEqual({ tempFilesAtOpen: [], releasedBeforeOpen: 1 });
    });
  });

  test("retries HTTP 503 then succeeds; a clean opted-in transfer issues exactly one GET", async () => {
    await withTempDir(async (dir) => {
      const flaky = scriptedClient([{ kind: "status", status: 503 }]);
      const retried = await runDownload(fileRequest(dir), flaky, (_fiber, h) =>
        Effect.andThen(h.nextWarning, TestClock.adjust("1 second")),
      );
      expect(Exit.isSuccess(retried.exit)).toBe(true);
      expect(flaky.calls.length).toBe(2);
      expect(retried.harness.ofTag("message.warn")[0]).toMatchObject({
        body: expect.stringContaining("the origin returned HTTP 503"),
      });

      const clean = scriptedClient([{ kind: "ok" }]);
      const once = await runDownload(fileRequest(dir, { destination: { kind: "memory" } }), clean);
      expect(Exit.isSuccess(once.exit)).toBe(true);
      expect(clean.calls.length).toBe(1);
      expect(once.harness.ofTag("post-download")[0]).toMatchObject({ attempts: 1 });
    });
  });

  test("never retries a request that did not opt in", async () => {
    await withTempDir(async (dir) => {
      const transport = scriptedClient([{ kind: "open-error", cause: bunError("ECONNRESET") }]);
      const { exit, harness } = await runDownload(
        fileRequest(dir),
        transport,
        () => TestClock.adjust("3 seconds"),
        false,
      );
      expect(transport.calls.length).toBe(1);
      expect(failureOf(exit)).toMatchObject({
        _tag: "DownloadFetchError",
        reason: "connection-reset",
        transportCode: "ECONNRESET",
        attempts: 1,
      });
      expect(harness.ofTag("message.warn")).toEqual([]);
    });
  });

  const permanent: ReadonlyArray<readonly [string, Step, Partial<DownloadRequest>]> = [
    ["HTTP 404", { kind: "status", status: 404 }, {}],
    ["ENOTFOUND", { kind: "open-error", cause: bunError("ENOTFOUND") }, {}],
    ["EPROTO", { kind: "open-error", cause: bunError("EPROTO", "The TLS handshake failed") }, {}],
    ["an uncoded body failure", { kind: "body-error", cause: new Error("decoder exploded") }, {}],
    [
      "a trust failure",
      {
        kind: "open-error",
        cause: new HttpTrustError({
          message: "untrusted",
          urlOrigin: "https://artifacts.test",
          kind: "missing-custom-ca",
          remediation: "Add the issuer CA.",
          cause: bunError("ECONNRESET"),
        }),
      },
      {},
    ],
    ["a checksum mismatch", { kind: "ok" }, { expectedSha256: "0".repeat(64) }],
    [
      "a file:// source",
      { kind: "open-error", cause: bunError("ECONNRESET") },
      { url: "file:///tmp/artifact.bin", allowFileSource: true },
    ],
  ];
  for (const [label, step, extra] of permanent) {
    test(`does not retry ${label}`, async () => {
      await withTempDir(async (dir) => {
        const transport = scriptedClient([step]);
        const { exit, harness } = await runDownload(fileRequest(dir, extra), transport);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(transport.calls.length).toBe(1);
        expect(harness.ofTag("message.warn")).toEqual([]);
      });
    });
  }

  test("stops after three attempts with the attempt count on the error and event", async () => {
    await withTempDir(async (dir) => {
      const reset = { kind: "open-error", cause: bunError("ECONNRESET") } as const;
      const transport = scriptedClient([reset, reset, reset]);
      const { exit, harness } = await runDownload(fileRequest(dir), transport, (_fiber, h) =>
        Effect.gen(function* () {
          yield* h.nextWarning;
          yield* TestClock.adjust("1 second");
          yield* h.nextWarning;
          yield* TestClock.adjust("2 seconds");
        }),
      );
      expect(transport.calls.length).toBe(3);
      const error = failureOf(exit);
      expect(error).toMatchObject({ _tag: "DownloadFetchError", attempts: 3 });
      expect(error?.message).toBe(
        "Couldn't download artifact.bin from https://artifacts.test: the connection was reset (ECONNRESET). Gave up after 3 attempts.",
      );
      expect(harness.ofTag("message.warn").length).toBe(2);
      expect(harness.ofTag("post-download")).toMatchObject([{ outcome: "failure", attempts: 3 }]);
    });
  });

  test("interruption during backoff stops retrying and still publishes the paired post-download", async () => {
    await withTempDir(async (dir) => {
      const transport = scriptedClient([{ kind: "open-error", cause: bunError("ECONNREFUSED") }]);
      const { exit, harness } = await runDownload(fileRequest(dir), transport, (fiber, h) =>
        Effect.andThen(h.nextWarning, Fiber.interrupt(fiber)),
      );
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(transport.calls.length).toBe(1);
      expect(harness.ofTag("pre-download").length).toBe(1);
      expect(harness.ofTag("post-download")).toMatchObject([
        { outcome: "failure", failureDetail: "interrupted", attempts: 1 },
      ]);
    });
  });

  test("retries an opted-in 503 that a status-filtering client reports as StatusCodeError", async () => {
    await withTempDir(async (dir) => {
      const transport = scriptedClient([{ kind: "status-error", status: 503 }, { kind: "ok" }]);
      const { exit } = await runDownload(fileRequest(dir), transport, (_fiber, h) =>
        Effect.gen(function* () {
          yield* h.nextWarning;
          yield* TestClock.adjust("1 second");
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(transport.calls.length).toBe(2);
    });
  });

  test.each([true, false])(
    "a failed attempt whose release also dies keeps the defect and is not retried (opt-in: %p)",
    async (optIn) => {
      await withTempDir(async (dir) => {
        const transport = scriptedClient([{ kind: "release-defect", cause: bunError("ECONNRESET") }]);
        const { exit } = await runDownload(fileRequest(dir), transport, undefined, optIn);
        expect(transport.calls.length).toBe(1);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
      });
    },
  );

  test("a transport defect propagates unchanged and is not retried", async () => {
    await withTempDir(async (dir) => {
      const transport = scriptedClient([{ kind: "die" }]);
      const { exit } = await runDownload(fileRequest(dir), transport);
      expect(transport.calls.length).toBe(1);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe("transport bug");
    });
  });
});
