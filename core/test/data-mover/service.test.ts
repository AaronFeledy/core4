import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Option, Queue, Schema, type Scope, Stream } from "effect";

import {
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, type ProviderCapabilities, ServiceName } from "@lando/sdk/schema";
import {
  DataMover,
  type EventFor,
  EventService,
  type EventWaitOptions,
  type ExecChunk,
  type LandoEvent,
  RuntimeProvider,
} from "@lando/sdk/services";
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

const minimalEmptyTar = (): Uint8Array => {
  const header = new Uint8Array(512);
  const write = (offset: number, value: string, length: number) => {
    header.set(encoder.encode(value.slice(0, length)), offset);
  };
  write(0, "empty", 100);
  write(100, "0000644\0", 8);
  write(108, "0000000\0", 8);
  write(116, "0000000\0", 8);
  write(124, "00000000000\0", 12);
  write(136, "00000000000\0", 12);
  header.fill(0x20, 148, 156);
  write(156, "0", 1);
  write(257, "ustar\0", 6);
  write(263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
  return header;
};

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
    waitFor: <Name extends string>(name: Name, options?: EventWaitOptions<Name>) =>
      Effect.sync(() => {
        const found = captured.find(
          (event): event is EventFor<Name> =>
            event.eventName === name && (options?.filter?.(event as EventFor<Name>) ?? true),
        );
        if (found === undefined) throw new Error(`missing event ${name}`);
        return found;
      }),
    waitForAny: () => Effect.never,
    query: <Name extends string>(name: Name, filter?: (event: EventFor<Name>) => boolean) =>
      Effect.sync(() =>
        captured.filter(
          (event): event is EventFor<Name> =>
            event.eventName === name && (filter?.(event as EventFor<Name>) ?? true),
        ),
      ),
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
      let observedRunStdin: "inherit" | "ignore" | undefined;

      const result = await Effect.runPromise(
        Effect.scoped(
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
            });
            yield* dataMover.transfer({
              from: { _tag: "volume", app, store: "restored" },
              to: { _tag: "hostPath", path: absolute(restored) },
              overwrite: true,
            });
            return { importResult, exportResult };
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              listVolumes: ({ store }) =>
                Effect.succeed([{ ref: { app, store: store === "restored" ? "other-store" : "data" } }]),
              run: (spec) => {
                observedRunStdin = spec.stdin;
                return TestRuntimeProvider.run(spec);
              },
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(result.importResult.accelerated).toBe(false);
      expect(result.exportResult.accelerated).toBe(false);
      expect(observedRunStdin).toBeUndefined();
      expect(await readFile(archive, "utf8")).not.toBe("volume-payload");
      expect(await readFile(restored, "utf8")).toBe("volume-payload");
      expect(result.exportResult.digest).toBeDefined();
    });
  });

  test("imports to volumes when existence preflight is unavailable", async () => {
    await withTempDir(async (dir) => {
      const seed = join(dir, "seed.txt");
      const restored = join(dir, "restored.txt");
      await writeFile(seed, "unlisted-volume-payload");

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(seed) },
              to: { _tag: "volume", app, store: "unlisted" },
            });
            yield* dataMover.transfer({
              from: { _tag: "volume", app, store: "unlisted" },
              to: { _tag: "hostPath", path: absolute(restored) },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              listVolumes: () =>
                Effect.fail(
                  new ProviderUnavailableError({
                    providerId: "test",
                    operation: "listVolumes",
                    message: "volume listing unavailable",
                  }),
                ),
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(await readFile(restored, "utf8")).toBe("unlisted-volume-payload");
    });
  });

  test("round-trips tar.zst host archives with native compression streams", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "payload.txt");
      const archive = join(dir, "payload.tar.zst");
      const target = join(dir, "roundtrip.txt");
      await writeFile(source, "zstd-payload");

      await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostArchive", path: absolute(archive), format: "tar.zst" },
            overwrite: true,
          });
          yield* dataMover.transfer({
            from: { _tag: "hostArchive", path: absolute(archive), format: "tar.zst" },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(await readFile(target, "utf8")).toBe("zstd-payload");
    });
  });

  test("imports a 512-byte valid tar archive with an empty payload", async () => {
    await withTempDir(async (dir) => {
      const archive = join(dir, "empty.tar");
      const target = join(dir, "empty.txt");
      await writeFile(archive, minimalEmptyTar());

      await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.transfer({
            from: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(await readFile(target, "utf8")).toBe("");
    });
  });

  test("dispatches serviceCmd through exec APIs while preserving env off argv", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source.txt");
      const target = join(dir, "target.txt");
      await writeFile(source, "service-input");
      let observedEnv: Readonly<Record<string, string>> | undefined;
      let observedCommand: ReadonlyArray<string> | undefined;
      let observedStdin = "";
      let observedStdinMode: "inherit" | "ignore" | undefined;

      const execStreamChunks: ExecChunk[] = [
        { kind: "stdout", chunk: bytes("service-output") },
        { exitCode: 0 },
      ];

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(source) },
              to: {
                _tag: "serviceCmd",
                app,
                service,
                command: ["import-db"],
                env: { DB_PASSWORD: "secret-token" },
              },
              overwrite: true,
            });
            yield* dataMover.transfer({
              from: {
                _tag: "serviceCmd",
                app,
                service,
                command: ["export-db"],
                env: { DB_PASSWORD: "secret-token" },
              },
              to: { _tag: "hostPath", path: absolute(target) },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              exec: (_target, command) =>
                Effect.promise(async () => {
                  observedEnv = command.env;
                  observedCommand = command.command;
                  observedStdinMode = command.stdin;
                  for await (const chunk of command.stdinStream ?? []) observedStdin += text(chunk);
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
              execStream: (_target, command) => {
                observedEnv = command.env;
                observedCommand = command.command;
                return Stream.fromIterable(execStreamChunks);
              },
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(observedEnv).toEqual({ DB_PASSWORD: "secret-token" });
      expect(observedCommand).toEqual(["export-db"]);
      expect(observedCommand?.join(" ")).not.toContain("secret-token");
      expect(observedStdinMode).toBeUndefined();
      expect(observedStdin).toBe("service-input");
      expect(await readFile(target, "utf8")).toBe("service-output");
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

  test("rejects host endpoints outside the app root and existing volumes without overwrite", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "lando-data-mover-outside-"));
    try {
      await withTempDir(async (dir) => {
        const outside = join(outsideDir, "outside.txt");
        const target = join(dir, "target.txt");
        const inside = join(dir, "inside.txt");
        await writeFile(outside, "outside");
        await writeFile(inside, "inside");

        const outsideExit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(outside) },
                to: { _tag: "hostPath", path: absolute(target) },
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(outsideExit._tag).toBe("Failure");
        if (outsideExit._tag === "Failure" && outsideExit.cause._tag === "Fail") {
          expect(outsideExit.cause.error).toBeInstanceOf(DataSourceOutsideRootError);
        }

        const existsExit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(inside) },
                to: { _tag: "volume", app, store: "existing" },
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                listVolumes: () => Effect.succeed([{ ref: { app, store: "existing" } }]),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(existsExit._tag).toBe("Failure");
        if (existsExit._tag === "Failure" && existsExit.cause._tag === "Fail") {
          expect(existsExit.cause.error).toBeInstanceOf(DataTargetExistsError);
        }
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
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

  test("publishes the generated snapshot id when snapshot creation fails", async () => {
    const capture = captureEvents();
    let providerSnapshotId: string | undefined;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.snapshot({ app, store: "data" });
        }),
      ).pipe(
        Effect.provide(DataMoverLive),
        Effect.provide(
          providerLayer({
            snapshotVolume: (spec) => {
              providerSnapshotId = spec.snapshotId;
              return Effect.fail(
                new ProviderUnavailableError({
                  providerId: "test",
                  operation: "snapshotVolume",
                  message: "snapshot failed",
                }),
              );
            },
          }),
        ),
        Effect.provide(Layer.merge(capture.layer, redactionLayer)),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(providerSnapshotId?.startsWith("data-")).toBe(true);
    expect(capture.events()[1]).toMatchObject({
      eventName: "post-volume-snapshot",
      outcome: "failure",
      snapshotId: providerSnapshotId,
    });
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
