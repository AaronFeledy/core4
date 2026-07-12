import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { DateTime, Effect, Exit, Schema, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type ImagePullProgressEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";

import {
  buildImagePullRequest,
  makePodmanApiClient,
  makeProviderLayer,
  parseImagePullFrame,
  pullImage,
} from "@lando/provider-lando";
import type { PodmanApiClient } from "@lando/provider-lando";
import { type EventService, RuntimeProvider } from "@lando/sdk/services";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const FIXED = DateTime.unsafeMake("2026-07-08T03:30:00Z");
const now = (): DateTime.Utc => FIXED;
const imagePullLive = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_IMAGE_PULL === "1",
    reason: "LANDO_TEST_IMAGE_PULL=1 is required",
  },
  { available: resolveLiveProviderSocket() !== undefined, reason: "a live Podman socket is required" },
]);

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const unsafeText = "s3cr3tPass";
const encodedUnsafeText = encodeURIComponent(unsafeText);
type PublishedEvent = Parameters<typeof EventService.Service.publish>[0];
const isImagePullProgressEvent = (event: PublishedEvent): event is ImagePullProgressEvent =>
  event._tag === "image-pull-progress" && "eventName" in event && event.eventName === "image-pull-progress";
const captureImagePullProgress = (events: ImagePullProgressEvent[], event: PublishedEvent): void => {
  if (isImagePullProgressEvent(event)) events.push(event);
};

const withClosingSocket = async <T>(run: (socketPath: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-provider-lando-pull-"));
  const socketPath = join(dir, "podman.sock");
  const server = createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await rm(dir, { recursive: true, force: true });
  }
};

interface CapturedPull {
  readonly events: ReadonlyArray<ImagePullProgressEvent>;
  readonly exit: Exit.Exit<void, ProviderUnavailableError | ProviderInternalError>;
}

const runPull = async (
  reference: string,
  chunks: ReadonlyArray<Uint8Array>,
  streamFactory?: (
    chunks: ReadonlyArray<Uint8Array>,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>,
): Promise<CapturedPull> => {
  const events: ImagePullProgressEvent[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    stream: () => (streamFactory ? streamFactory(chunks) : Stream.fromIterable(chunks)),
  };
  const exit = await Effect.runPromiseExit(
    pullImage(api, reference, {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      now,
    }),
  );
  return { events, exit };
};

describe("buildImagePullRequest", () => {
  test("targets the libpod pull endpoint with pullProgress=true and an encoded reference", () => {
    const request = buildImagePullRequest("docker.io/library/alpine:3.20.3");
    expect(request.method).toBe("POST");
    expect(request.path.startsWith("/libpod/images/pull")).toBe(true);
    expect(request.path).toContain("pullProgress=true");
    expect(request.path).toContain(`reference=${encodeURIComponent("docker.io/library/alpine:3.20.3")}`);
  });
});

describe("parseImagePullFrame", () => {
  test("maps a Podman {stream} frame to a progress frame", () => {
    expect(parseImagePullFrame('{"stream":"Trying to pull alpine..."}')).toEqual({
      kind: "progress",
      stream: "Trying to pull alpine...",
    });
  });

  test("maps a Docker-style {status,progressDetail} frame to progress with current/total", () => {
    expect(
      parseImagePullFrame(
        '{"status":"Downloading","id":"abc","progressDetail":{"current":1048576,"total":1234567}}',
      ),
    ).toEqual({
      kind: "progress",
      stream: "Downloading",
      current: 1048576,
      total: 1234567,
    });
  });

  test("maps an {error} frame to an error frame", () => {
    expect(parseImagePullFrame('{"error":"manifest unknown"}')).toEqual({
      kind: "error",
      message: "manifest unknown",
    });
  });

  test("ignores blank lines and unparseable JSON without throwing", () => {
    expect(parseImagePullFrame("")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("   ")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("not-json")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame('{"id":"onlyid"}')).toEqual({ kind: "ignore" });
  });
});

describe("pullImage", () => {
  test("publishes a redacted ImagePullProgressEvent per progress frame that decodes against LandoEvent", async () => {
    const { events, exit } = await runPull("docker.io/library/alpine:3.20.3", [
      bytes('{"stream":"Trying to pull docker.io/library/alpine:3.20.3..."}\n'),
      bytes('{"status":"Downloading","progressDetail":{"current":100,"total":200}}\n'),
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toHaveLength(2);
    const isLandoEvent = Schema.is(LandoEventSchema);
    for (const event of events) {
      expect(event._tag).toBe("image-pull-progress");
      expect(isLandoEvent(event)).toBe(true);
      expect(event.reference).toBe("docker.io/library/alpine:3.20.3");
      expect(DateTime.formatIso(event.timestamp)).toBe(DateTime.formatIso(FIXED));
    }
    expect(events[1]?.current).toBe(100);
    expect(events[1]?.total).toBe(200);
  });

  test("reassembles a single frame split across two byte chunks", async () => {
    const { events, exit } = await runPull("docker.io/library/alpine:3.20.3", [
      bytes('{"stream":"Trying to '),
      bytes('pull..."}\n'),
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.stream).toBe("Trying to pull...");
  });

  test("flushes a trailing frame with no terminating newline", async () => {
    const { events, exit } = await runPull("docker.io/library/alpine:3.20.3", [
      bytes('{"stream":"final frame"}'),
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.stream).toBe("final frame");
  });

  test("redacts credentials in the reference and progress stream text of published events", async () => {
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";
    const { events, exit } = await runPull(reference, [
      bytes(`{"stream":"Trying to pull ${reference}..."}\n`),
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("s3cr3tPass");
    expect(serialized).toContain("[redacted]");
  });

  test("maps an in-stream {error} frame to ProviderUnavailableError(operation=pullImage) with redacted message", async () => {
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";
    const value = await Effect.runPromise(
      pullImage(
        {
          info: Effect.succeed({}),
          ping: Effect.succeed(undefined),
          stream: () =>
            Stream.fromIterable([bytes(`{"error":"pull failed for ${reference}: unauthorized"}\n`)]),
        },
        reference,
        { publish: () => Effect.void, now },
      ).pipe(Effect.flip),
    );
    expect(value).toBeInstanceOf(ProviderUnavailableError);
    expect((value as ProviderUnavailableError).operation).toBe("pullImage");
    expect((value as ProviderUnavailableError).message).not.toContain("s3cr3tPass");
    expect(JSON.stringify((value as ProviderUnavailableError).details ?? {})).not.toContain("s3cr3tPass");
  });

  test("propagates a transport non-2xx ProviderUnavailableError unchanged", async () => {
    const transportError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "podman-api",
      message: "Container runtime stream request failed with HTTP 500.",
    });
    const value = await Effect.runPromise(
      pullImage(
        {
          info: Effect.succeed({}),
          ping: Effect.succeed(undefined),
          stream: () => Stream.fail(transportError),
        },
        "docker.io/library/alpine:3.20.3",
        { publish: () => Effect.void, now },
      ).pipe(Effect.flip),
    );
    expect(value).toBeInstanceOf(ProviderUnavailableError);
    expect((value as ProviderUnavailableError).operation).toBe("podman-api");
  });

  test("redacts credentials from unknown Podman stream transport failures", async () => {
    const reference = `https://user:${unsafeText}@registry.internal/team/img:1.0`;
    const value = await withClosingSocket((socketPath) =>
      Effect.runPromise(
        pullImage(makePodmanApiClient(socketPath), reference, { publish: () => Effect.void, now }).pipe(
          Effect.flip,
        ),
      ),
    );

    expect(value).toBeInstanceOf(ProviderUnavailableError);
    if (!(value instanceof ProviderUnavailableError)) throw new Error("expected ProviderUnavailableError");
    const serialized = JSON.stringify({ message: value.message, details: value.details, cause: value.cause });
    const inspected = inspect({ message: value.message, details: value.details, cause: value.cause });
    for (const text of [serialized, inspected]) {
      expect(text).not.toContain(unsafeText);
      expect(text).not.toContain(encodedUnsafeText);
    }
  });

  test("fails with ProviderInternalError when the client cannot stream", async () => {
    const value = await Effect.runPromise(
      pullImage(
        { info: Effect.succeed({}), ping: Effect.succeed(undefined) },
        "docker.io/library/alpine:3.20.3",
        {
          publish: () => Effect.void,
          now,
        },
      ).pipe(Effect.flip),
    );
    expect(value).toBeInstanceOf(ProviderInternalError);
  });

  test("emits no output through console or process std streams", async () => {
    const calls: string[] = [];
    const originals = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      stdout: process.stdout.write,
      stderr: process.stderr.write,
    };
    const record = (label: string): ((...args: ReadonlyArray<unknown>) => void) => {
      return (...args) => {
        calls.push(`${label}:${String(args[0])}`);
      };
    };
    const recordWrite = (label: string): typeof process.stdout.write =>
      ((chunk: unknown) => {
        calls.push(`${label}:${String(chunk)}`);
        return true;
      }) as typeof process.stdout.write;
    console.log = record("log");
    console.error = record("error");
    console.warn = record("warn");
    console.info = record("info");
    process.stdout.write = recordWrite("stdout");
    process.stderr.write = recordWrite("stderr");
    try {
      await runPull("docker.io/library/alpine:3.20.3", [
        bytes('{"stream":"Trying to pull..."}\n'),
        bytes('{"error":"boom"}\n'),
      ]);
    } finally {
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
      console.info = originals.info;
      process.stdout.write = originals.stdout;
      process.stderr.write = originals.stderr;
    }
    expect(calls).toHaveLength(0);
  });
});

describe("provider pullArtifact", () => {
  test("pulls an artifact ref through the provider and publishes progress events", async () => {
    const events: ImagePullProgressEvent[] = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: {
              info: Effect.succeed({ host: { arch: "x64" } }),
              ping: Effect.succeed(undefined),
              stream: () =>
                Stream.fromIterable([
                  bytes('{"stream":"Trying to pull docker.io/library/alpine:3.20.3..."}\n'),
                  bytes('{"status":"Downloading","progressDetail":{"current":100,"total":200}}\n'),
                ]),
            },
            eventService: {
              publish: (event) =>
                Effect.sync(() => {
                  captureImagePullProgress(events, event);
                }),
            },
          }),
        ),
      ),
    );

    const artifact = await Effect.runPromise(
      provider.pullArtifact({ ref: "docker.io/library/alpine:3.20.3" }),
    );

    expect(String(artifact.providerId)).toBe("lando");
    expect(artifact.ref).toBe("docker.io/library/alpine:3.20.3");
    expect(events).toHaveLength(2);
    expect(events[1]?.current).toBe(100);
    expect(events[1]?.total).toBe(200);
  });

  test("provider pullArtifact redacts registry credentials from progress events", async () => {
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";
    const events: ImagePullProgressEvent[] = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: {
              info: Effect.succeed({ host: { arch: "x64" } }),
              ping: Effect.succeed(undefined),
              stream: () => Stream.fromIterable([bytes(`{"stream":"Trying to pull ${reference}..."}\n`)]),
            },
            eventService: {
              publish: (event) =>
                Effect.sync(() => {
                  captureImagePullProgress(events, event);
                }),
            },
          }),
        ),
      ),
    );

    await Effect.runPromise(provider.pullArtifact({ ref: reference }));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("s3cr3tPass");
    expect(serialized).toContain("[redacted]");
  });

  test.skipIf(!imagePullLive.available)(
    liveIntegrationTestName(
      "pulls a live image through the Podman socket when explicitly enabled",
      imagePullLive,
    ),
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const events: ImagePullProgressEvent[] = [];
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              platform: "linux",
              podmanApi: makePodmanApiClient(socketPath ?? ""),
              eventService: {
                publish: (event) =>
                  Effect.sync(() => {
                    captureImagePullProgress(events, event);
                  }),
              },
            }),
          ),
        ),
      );

      const artifact = await Effect.runPromise(
        provider.pullArtifact({ ref: "docker.io/library/alpine:3.20.3" }),
      );

      expect(artifact.ref).toBe("docker.io/library/alpine:3.20.3");
      expect(events.length).toBeGreaterThan(0);
    },
  );
});
