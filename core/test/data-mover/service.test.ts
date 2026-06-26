import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Option, Queue, Schema, type Scope, Stream } from "effect";

import { DataChecksumMismatchError, DataEndpointUnsupportedError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, type ProviderCapabilities, ServiceName } from "@lando/sdk/schema";
import { DataMover, EventService, type LandoEvent, RuntimeProvider } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { collectVerifiedStream } from "@lando/sdk/verified-stream";
import { DataMoverLive } from "../../src/data-mover/service.ts";
import { makeLandoRuntime } from "../../src/index.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { makeTestDataMover } from "../../src/testing/data-mover.ts";

const app = AppId.make("data-app");
const service = ServiceName.make("web");
const servicePath = PortablePath.make("/data/payload");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);
const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const portable = (path: string) => Schema.decodeUnknownSync(PortablePath)(path);

const dataPlaneCapabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...TestRuntimeProvider.capabilities,
  ...overrides,
});

const providerLayer = (overrides: Partial<Context.Tag.Service<typeof RuntimeProvider>> = {}) =>
  Layer.succeed(RuntimeProvider, {
    ...TestRuntimeProvider,
    ...overrides,
    capabilities: overrides.capabilities ?? TestRuntimeProvider.capabilities,
  });

const captureEvents = () => {
  const captured: LandoEvent[] = [];
  const serviceLayer = Layer.succeed(EventService, {
    publish: (event) =>
      Effect.sync(() => {
        captured.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: (name, filter) =>
      Effect.sync(() => {
        const found = captured.find((event) => event.eventName === name && (filter?.(event) ?? true));
        if (found === undefined) throw new Error(`missing event ${name}`);
        return found;
      }),
  } satisfies Context.Tag.Service<typeof EventService>);
  return { layer: serviceLayer, events: () => [...captured] };
};

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () =>
    Effect.succeed({
      redactString: (input: string) => input.replaceAll("secret-token", "[redacted]"),
      redactValue: (input: unknown) => input,
    }),
} satisfies Context.Tag.Service<typeof RedactionService>);

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-mover-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runDataMover = <A, E>(effect: Effect.Effect<A, E, DataMover | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        DataMoverLive.pipe(
          Layer.provide(Layer.mergeAll(providerLayer(), captureEvents().layer, redactionLayer)),
        ),
      ),
    ),
  );

describe("DataMoverLive", () => {
  test("provider bootstrap exposes DataMover while minimal bootstrap does not", async () => {
    const providerContext = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "provider" }))),
    );
    const minimalContext = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "minimal" }))),
    );

    expect(Option.isSome(Context.getOption(providerContext, DataMover))).toBe(true);
    expect(Option.isNone(Context.getOption(minimalContext, DataMover))).toBe(true);
  });

  test("dispatches native service file copies and reports accelerated", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "payload.txt");
      const target = join(dir, "roundtrip.txt");
      await writeFile(source, "native-payload");

      const mover = Effect.gen(function* () {
        const dataMover = yield* DataMover;
        const copyIn = yield* dataMover.transfer({
          from: { _tag: "hostPath", path: absolute(source) },
          to: { _tag: "servicePath", app, service, path: servicePath },
          overwrite: true,
        });
        const copyOut = yield* dataMover.transfer({
          from: { _tag: "servicePath", app, service, path: servicePath },
          to: { _tag: "hostPath", path: absolute(target) },
          overwrite: true,
        });
        return { copyIn, copyOut };
      });

      const result = await Effect.runPromise(
        Effect.scoped(mover).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({ capabilities: dataPlaneCapabilities({ serviceFileCopy: "native" }) }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(result.copyIn.accelerated).toBe(true);
      expect(result.copyOut.accelerated).toBe(true);
      expect(await readFile(target, "utf8")).toBe("native-payload");
    });
  });

  test("falls back through ephemeral run for volume archive export/import", async () => {
    await withTempDir(async (dir) => {
      const archive = join(dir, "volume.tar");
      const seed = join(dir, "seed.txt");
      const restored = join(dir, "restored.txt");
      await writeFile(seed, "volume-payload");

      const result = await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          const importResult = yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(seed) },
            to: { _tag: "volume", app, store: "data" },
            overwrite: true,
          });
          const exportResult = yield* dataMover.transfer({
            from: { _tag: "volume", app, store: "data" },
            to: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
            overwrite: true,
          });
          yield* dataMover.transfer({
            from: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
            to: { _tag: "volume", app, store: "restored" },
            overwrite: true,
          });
          yield* dataMover.transfer({
            from: { _tag: "volume", app, store: "restored" },
            to: { _tag: "hostPath", path: absolute(restored) },
            overwrite: true,
          });
          return { importResult, exportResult };
        }),
      );

      expect(result.importResult.accelerated).toBe(false);
      expect(result.exportResult.accelerated).toBe(false);
      expect(await readFile(archive, "utf8")).not.toBe("volume-payload");
      expect(await readFile(restored, "utf8")).toBe("volume-payload");
      expect(result.exportResult.digest).toBeDefined();
    });
  });

  test("rejects unsupported pairs and checksum mismatches without clobbering the destination", async () => {
    await withTempDir(async (dir) => {
      const archive = join(dir, "volume.tar");
      const seed = join(dir, "seed.txt");
      await writeFile(seed, "volume-payload");
      await writeFile(archive, "old");

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(seed) },
              to: { _tag: "volume", app, store: "checksum" },
              overwrite: true,
            });
            yield* dataMover.transfer({
              from: { _tag: "volume", app, store: "checksum" },
              to: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
              expectedDigest: "not-the-right-digest",
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(providerLayer()),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Fail");
        if (exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBeInstanceOf(DataChecksumMismatchError);
        }
      }
      expect(await readFile(archive, "utf8")).toBe("old");

      const unsupported = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "artifact", ref: "missing" },
              to: { _tag: "serviceCmd", app, service, command: ["sh", "-c", "cat"] },
            });
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(providerLayer({ capabilities: dataPlaneCapabilities({ artifactExport: false }) })),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );
      expect(unsupported._tag).toBe("Failure");
      if (unsupported._tag === "Failure" && unsupported.cause._tag === "Fail") {
        expect(unsupported.cause.error).toBeInstanceOf(DataEndpointUnsupportedError);
      }
    });
  });

  test("publishes redacted Data lifecycle events", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "secret-token.txt");
      const target = join(dir, "target.txt");
      await writeFile(source, "secret-token");
      const capture = captureEvents();

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(source) },
              to: { _tag: "hostPath", path: absolute(target) },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(providerLayer()),
          Effect.provide(Layer.merge(capture.layer, redactionLayer)),
        ),
      );

      const payload = JSON.stringify(capture.events());
      expect(capture.events().map((event) => event.eventName)).toEqual([
        "pre-data-transfer",
        "data-transfer-progress",
        "post-data-transfer",
      ]);
      expect(payload).not.toContain("secret-token");
      expect(payload).toContain("[redacted]");
    });
  });

  test("publishes volume snapshot lifecycle events", async () => {
    const capture = captureEvents();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.snapshot({ app, store: "data" }, { format: "tar", label: "snap-one" });
        }),
      ).pipe(
        Effect.provide(DataMoverLive),
        Effect.provide(providerLayer()),
        Effect.provide(Layer.merge(capture.layer, redactionLayer)),
      ),
    );

    expect(capture.events().map((event) => event.eventName)).toEqual([
      "pre-volume-snapshot",
      "post-volume-snapshot",
    ]);
    expect(capture.events()[1]).toMatchObject({ eventName: "post-volume-snapshot", snapshotId: "snap-one" });
  });

  test("exports an in-memory TestDataMover for unit tests", async () => {
    const handle = makeTestDataMover();
    const { result, progress } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* handle.service.transfer({
            from: { _tag: "hostPath", path: absolute(resolve("sample.txt")) },
            to: { _tag: "stream" },
          });
          const progress = yield* handle.service
            .transferStream({ from: { _tag: "stream" }, to: { _tag: "stream" } })
            .pipe(Stream.runCollect);
          return { result, progress };
        }),
      ),
    );

    expect(result.accelerated).toBe(false);
    expect(Array.from(progress)).toEqual([{ phase: "completed", transferredBytes: 0 }]);
    expect(await Effect.runPromise(handle.transfers())).toHaveLength(1);
    expect(await Effect.runPromise(handle.streams())).toHaveLength(1);
  });
});

describe("DataMover helpers", () => {
  test("collectVerifiedStream remains the checksum primitive used by archive tests", async () => {
    const verified = await Effect.runPromise(collectVerifiedStream({ body: Stream.make(bytes("payload")) }));

    expect(verified.sizeBytes).toBe(7);
    expect(verified.sha256).toHaveLength(64);
    expect(text(bytes("payload"))).toBe("payload");
    expect(String(portable("/data/payload"))).toBe("/data/payload");
  });
});
