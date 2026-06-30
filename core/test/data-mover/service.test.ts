import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Option, Queue, Schema, type Scope, Stream } from "effect";

import {
  ArchiveFormatError,
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  ProviderUnavailableError,
  SnapshotAmbiguousError,
  StateStoreError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  DataMover,
  type EventFor,
  EventService,
  type EventWaitOptions,
  type ExecChunk,
  type LandoEvent,
  PathsService,
  RuntimeProvider,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { collectVerifiedStream } from "@lando/sdk/verified-stream";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { providerImages } from "../../src/data-mover/generated/provider-images.ts";
import { DataMoverLive, __testOnlyEncodeTarOctal } from "../../src/data-mover/service.ts";
import { makeLandoRuntime } from "../../src/index.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { StateStoreLive } from "../../src/state/service.ts";
import { makeTestDataMover } from "../../src/testing/data-mover.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const app = AppId.make("data-app");
const service = ServiceName.make("web");
const servicePath = PortablePath.make("/data/payload");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);
const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const portable = (path: string) => Schema.decodeUnknownSync(PortablePath)(path);
const sha256 = (payload: string | Uint8Array): string => createHash("sha256").update(payload).digest("hex");

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

const invalidSizeTar = (): Uint8Array => {
  const archive = minimalEmptyTar();
  archive.set(encoder.encode("not-octal\0\0\0"), 124);
  return archive;
};

const dataPlaneCapabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...TestRuntimeProvider.capabilities,
  ...overrides,
});

const pinnedHelper = providerImages.images.dataHelper;

const verifyingPullArtifact: Context.Tag.Service<typeof RuntimeProvider>["pullArtifact"] = (spec) =>
  Effect.succeed({ providerId: ProviderId.make("test"), ref: spec.ref, digest: pinnedHelper.digest });

const providerLayer = (overrides: Partial<Context.Tag.Service<typeof RuntimeProvider>> = {}) =>
  Layer.mergeAll(
    StateStoreLive,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(RuntimeProvider, {
      ...TestRuntimeProvider,
      pullArtifact: verifyingPullArtifact,
      ...overrides,
      capabilities: overrides.capabilities ?? TestRuntimeProvider.capabilities,
    }),
  );

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
      expect(result.exportResult.digest).toBe(sha256("volume-payload"));
    });
  });

  test("host archive writes verify and report the payload digest", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "payload.txt");
      const archive = join(dir, "payload.tar");
      await writeFile(source, "archive-payload");

      const result = await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
            expectedDigest: sha256("archive-payload"),
            overwrite: true,
          });
        }),
      );

      expect(result.digest).toBe(sha256("archive-payload"));
      expect(result.sizeBytes).toBe(bytes("archive-payload").byteLength);
      expect(await readFile(archive, "utf8")).not.toBe("archive-payload");
    });
  });

  test("rejects tar payload sizes that do not fit the portable header", () => {
    const maxPortableTarSize = 0o77777777777;
    expect(__testOnlyEncodeTarOctal(maxPortableTarSize, 12)).toBe("77777777777");
    expect(() => __testOnlyEncodeTarOctal(maxPortableTarSize + 1, 12)).toThrow(ArchiveFormatError);
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

  test("rejects tar archives with invalid payload size fields", async () => {
    await withTempDir(async (dir) => {
      const archive = join(dir, "invalid-size.tar");
      const target = join(dir, "target.txt");
      await writeFile(archive, invalidSizeTar());
      await writeFile(target, "old");

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostArchive", path: absolute(archive), format: "tar" },
              to: { _tag: "hostPath", path: absolute(target) },
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
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ArchiveFormatError);
      }
      expect(await readFile(target, "utf8")).toBe("old");
    });
  });

  test("writes host targets under missing nested app-root directories", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source.txt");
      const target = join(dir, "missing", "nested", "target.txt");
      await writeFile(source, "nested-target-payload");

      await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(await readFile(target, "utf8")).toBe("nested-target-payload");
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

  test("verifies target payload digests before mutating provider targets", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source.txt");
      await writeFile(source, "digest-guard");

      let copyToServiceCalls = 0;
      let runCalls = 0;
      let importArtifactCalls = 0;
      let execCalls = 0;

      const exits = await Promise.all([
        Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(source) },
                to: { _tag: "servicePath", app, service, path: servicePath },
                expectedDigest: "not-the-right-digest",
                overwrite: true,
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                capabilities: dataPlaneCapabilities({ serviceFileCopy: "native" }),
                copyToService: () =>
                  Effect.sync(() => {
                    copyToServiceCalls += 1;
                  }),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        ),
        Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(source) },
                to: { _tag: "volume", app, store: "digest-guard" },
                expectedDigest: "not-the-right-digest",
                overwrite: true,
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                run: (spec) =>
                  Effect.sync(() => {
                    runCalls += 1;
                    return TestRuntimeProvider.run(spec);
                  }).pipe(Effect.flatten),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        ),
        Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(source) },
                to: { _tag: "artifact", ref: "digest-guard" },
                expectedDigest: "not-the-right-digest",
                overwrite: true,
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                importArtifact: () =>
                  Effect.sync(() => {
                    importArtifactCalls += 1;
                    return { providerId: ProviderId.make("test"), ref: "digest-guard" };
                  }),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        ),
        Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(source) },
                to: { _tag: "serviceCmd", app, service, command: ["import-db"] },
                expectedDigest: "not-the-right-digest",
                overwrite: true,
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                exec: () =>
                  Effect.sync(() => {
                    execCalls += 1;
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        ),
      ]);

      for (const exit of exits) {
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBeInstanceOf(DataChecksumMismatchError);
        }
      }
      expect(copyToServiceCalls).toBe(0);
      expect(runCalls).toBe(0);
      expect(importArtifactCalls).toBe(0);
      expect(execCalls).toBe(0);
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

        const traversalTarget = `${dir}/missing/../../../host-root-bypass.txt`;
        const escapedTarget = resolve(traversalTarget);
        const traversalExit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(inside) },
                to: { _tag: "hostPath", path: absolute(traversalTarget) },
                overwrite: true,
              });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(traversalExit._tag).toBe("Failure");
        if (traversalExit._tag === "Failure" && traversalExit.cause._tag === "Fail") {
          expect(traversalExit.cause.error).toBeInstanceOf(DataSourceOutsideRootError);
        }
        const escapedReadExit = await Effect.runPromiseExit(
          Effect.tryPromise(() => readFile(escapedTarget, "utf8")),
        );
        expect(escapedReadExit._tag).toBe("Failure");

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

  test("uses the discovered app root for host endpoint containment", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const siblingRoot = join(dir, "sibling");
      const source = join(appRoot, "nested", "source.txt");
      const allowedTarget = join(appRoot, "nested", "target.txt");
      const outsideTarget = join(siblingRoot, "target.txt");
      await mkdir(dirname(source), { recursive: true });
      await mkdir(siblingRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: data-root\n");
      await writeFile(source, "app-root-payload");

      await runDataMover(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(allowedTarget) },
            overwrite: true,
          });
        }),
      );
      expect(await readFile(allowedTarget, "utf8")).toBe("app-root-payload");

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(source) },
              to: { _tag: "hostPath", path: absolute(outsideTarget) },
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
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DataSourceOutsideRootError);
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
            capabilities: dataPlaneCapabilities({ volumeSnapshot: "native" }),
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

  test("persists copy-mode snapshots through StateStore and restores by id", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const restored = join(dir, "restored.txt");
      await writeFile(join(dir, "seed.txt"), "volume-payload");
      await writeFile(join(dir, "changed.txt"), "changed-payload");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "seed.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              const handle = yield* dataMover.snapshot(
                { app, store: "data" },
                { format: "tar", label: "snap-one" },
              );
              const listed = yield* dataMover.listSnapshots({ app, store: "data" });
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "changed.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              yield* dataMover.restore(handle.id, { app, store: "data" });
              yield* dataMover.transfer({
                from: { _tag: "volume", app, store: "data" },
                to: { _tag: "hostPath", path: absolute(restored) },
                overwrite: true,
              });
              return { handle, listed };
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(result.handle.id).toBe("snap-one");
        expect(result.listed).toHaveLength(1);
        expect(result.listed[0]?.digest).toBe(sha256("volume-payload"));
        expect(await readFile(restored, "utf8")).toBe("volume-payload");
        expect(await Bun.file(join(dataRoot, "snapshots", String(app), "index.bin")).exists()).toBe(true);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "snap-one.tar")).exists(),
        ).toBe(true);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "snap-one.json")).exists(),
        ).toBe(true);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("restores copy-mode snapshots from the returned handle and prunes through the index", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const restored = join(dir, "restored-from-handle.txt");
      await writeFile(join(dir, "seed.txt"), "handle-payload");
      await writeFile(join(dir, "changed.txt"), "changed-payload");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "seed.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              const first = yield* dataMover.snapshot(
                { app, store: "data" },
                { format: "tar", label: "snap-a" },
              );
              const second = yield* dataMover.snapshot(
                { app, store: "data" },
                { format: "tar", label: "snap-b" },
              );
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "changed.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              yield* dataMover.restore(first, { app, store: "data" });
              yield* dataMover.restore(first, { app, store: "alternate" });
              yield* dataMover.transfer({
                from: { _tag: "volume", app, store: "alternate" },
                to: { _tag: "hostPath", path: absolute(restored) },
                overwrite: true,
              });
              const pruned = yield* dataMover.pruneSnapshots({
                filter: { app, store: "data" },
                keepLatest: 1,
              });
              const listed = yield* dataMover.listSnapshots({ app, store: "data" });
              return { first, second, pruned, listed };
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(await readFile(restored, "utf8")).toBe("handle-payload");
        expect(result.pruned).toEqual([result.first.id]);
        expect(result.listed.map((entry) => entry.id)).toEqual([result.second.id]);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("pruneSnapshots with filter only and omitted keepLatest removes nothing", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      await writeFile(join(dir, "seed.txt"), "seed-payload");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "seed.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              const first = yield* dataMover.snapshot(
                { app, store: "data" },
                { format: "tar", label: "snap-a" },
              );
              const second = yield* dataMover.snapshot(
                { app, store: "data" },
                { format: "tar", label: "snap-b" },
              );
              const pruned = yield* dataMover.pruneSnapshots({
                filter: { app, store: "data" },
              });
              const listed = yield* dataMover.listSnapshots({ app, store: "data" });
              return { first, second, pruned, listed };
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(result.pruned).toEqual([]);
        expect(result.listed.map((entry) => entry.id).sort()).toEqual(
          [result.first.id, result.second.id].sort(),
        );
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("persists native snapshot refs in the sidecar without writing an archive", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;

      try {
        const listed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              const handle = yield* dataMover.snapshot(
                { app, store: "data" },
                { volumeSnapshot: "native", label: "native-one" },
              );
              yield* dataMover.restore(handle, { app, store: "data" });
              return yield* dataMover.listSnapshots({ app, store: "data" });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({ capabilities: dataPlaneCapabilities({ volumeSnapshot: "native" }) }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(listed[0]?.native).toEqual({ provider: "test", id: "native-one" });
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "native-one.tar")).exists(),
        ).toBe(false);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "native-one.json")).exists(),
        ).toBe(true);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("keeps distinct snapshot index rows when the same label is used on different stores", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      await writeFile(join(dir, "data-a.txt"), "data-a-payload");
      await writeFile(join(dir, "data-b.txt"), "data-b-payload");

      try {
        const listed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              for (const store of ["data-a", "data-b"] as const) {
                yield* dataMover.transfer({
                  from: { _tag: "hostPath", path: absolute(join(dir, `${store}.txt`)) },
                  to: { _tag: "volume", app, store },
                  overwrite: true,
                });
                yield* dataMover.snapshot({ app, store }, { format: "tar", label: "shared-label" });
              }
              return yield* dataMover.listSnapshots({ app, label: "shared-label" });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(listed).toHaveLength(2);
        expect(new Set(listed.map((entry) => entry.store.store))).toEqual(new Set(["data-a", "data-b"]));
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data-a", "shared-label.tar")).exists(),
        ).toBe(true);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data-b", "shared-label.tar")).exists(),
        ).toBe(true);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("removeSnapshot without store fails when the same id exists on multiple stores", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      await writeFile(join(dir, "left.txt"), "left-payload");
      await writeFile(join(dir, "right.txt"), "right-payload");

      try {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              for (const store of ["left", "right"] as const) {
                yield* dataMover.transfer({
                  from: { _tag: "hostPath", path: absolute(join(dir, `${store}.txt`)) },
                  to: { _tag: "volume", app, store },
                  overwrite: true,
                });
                yield* dataMover.snapshot({ app, store }, { format: "tar", label: "dup-id" });
              }
              yield* dataMover.removeSnapshot("dup-id");
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBeInstanceOf(SnapshotAmbiguousError);
        }
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("removeSnapshot with store deletes only the matching volume snapshot", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      await writeFile(join(dir, "keep.txt"), "keep-payload");
      await writeFile(join(dir, "drop.txt"), "drop-payload");

      try {
        const listed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              for (const store of ["keep", "drop"] as const) {
                yield* dataMover.transfer({
                  from: { _tag: "hostPath", path: absolute(join(dir, `${store}.txt`)) },
                  to: { _tag: "volume", app, store },
                  overwrite: true,
                });
                yield* dataMover.snapshot({ app, store }, { format: "tar", label: "same-id" });
              }
              yield* dataMover.removeSnapshot("same-id", { app, store: "drop" });
              return yield* dataMover.listSnapshots({ app, id: "same-id" });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(providerLayer()),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(listed).toHaveLength(1);
        expect(listed[0]?.store.store).toBe("keep");
        expect(await Bun.file(join(dataRoot, "snapshots", String(app), "drop", "same-id.tar")).exists()).toBe(
          false,
        );
        expect(await Bun.file(join(dataRoot, "snapshots", String(app), "keep", "same-id.tar")).exists()).toBe(
          true,
        );
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("keeps native provider snapshot alive until persistence finishes", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      await writeFile(join(dir, "payload.txt"), "native-persist-payload");

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.transfer({
                from: { _tag: "hostPath", path: absolute(join(dir, "payload.txt")) },
                to: { _tag: "volume", app, store: "data" },
                overwrite: true,
              });
              const handle = yield* dataMover.snapshot(
                { app, store: "data" },
                { volumeSnapshot: "native", label: "scope-hold" },
              );
              yield* dataMover.restore(handle, { app, store: "data" });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                capabilities: dataPlaneCapabilities({ volumeSnapshot: "native" }),
                snapshotVolume: (spec) =>
                  Effect.gen(function* () {
                    const ref = yield* TestRuntimeProvider.snapshotVolume(spec);
                    yield* Effect.addFinalizer(() =>
                      (TestRuntimeProvider.removeVolumeSnapshot?.(ref) ?? Effect.void).pipe(
                        Effect.catchAll(() => Effect.void),
                      ),
                    );
                    return ref;
                  }),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("removeSnapshot calls removeVolumeSnapshot for native snapshots", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      let removeNativeCalls = 0;
      const removedIds: string[] = [];

      try {
        const listed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.snapshot(
                { app, store: "data" },
                { volumeSnapshot: "native", label: "native-remove" },
              );
              yield* dataMover.removeSnapshot("native-remove", { app, store: "data" });
              return yield* dataMover.listSnapshots({ app, store: "data" });
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              providerLayer({
                capabilities: dataPlaneCapabilities({ volumeSnapshot: "native" }),
                removeVolumeSnapshot: (snapshot) =>
                  (TestRuntimeProvider.removeVolumeSnapshot?.(snapshot) ?? Effect.void).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        removeNativeCalls += 1;
                        removedIds.push(snapshot.id);
                      }),
                    ),
                  ),
              }),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(listed).toHaveLength(0);
        expect(removeNativeCalls).toBe(1);
        expect(removedIds).toEqual(["native-remove"]);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "native-remove.json")).exists(),
        ).toBe(false);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("rolls back native provider snapshots when snapshot index persistence fails", async () => {
    await withTempDir(async (dir) => {
      const dataRoot = join(dir, "data");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = dataRoot;
      const testStore = makeTestStateStore();
      let removeNativeCalls = 0;
      const failingStateStore = {
        ...testStore.service,
        open: (spec: Parameters<typeof testStore.service.open>[0]) =>
          testStore.service.open(spec).pipe(
            Effect.map((bucket) =>
              spec.key === "index.bin"
                ? {
                    ...bucket,
                    update: () =>
                      Effect.fail(
                        new StateStoreError({
                          reason: "io",
                          operation: "update",
                          remediation: "injected failure for regression test",
                        }),
                      ),
                  }
                : bucket,
            ),
          ),
      };

      try {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover.snapshot(
                { app, store: "data" },
                { volumeSnapshot: "native", label: "leak-test" },
              );
            }),
          ).pipe(
            Effect.provide(DataMoverLive),
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(StateStore, failingStateStore),
                Layer.succeed(PathsService, makeLandoPaths()),
                Layer.succeed(RuntimeProvider, {
                  ...TestRuntimeProvider,
                  capabilities: dataPlaneCapabilities({ volumeSnapshot: "native" }),
                  removeVolumeSnapshot: (snapshot) =>
                    (TestRuntimeProvider.removeVolumeSnapshot?.(snapshot) ?? Effect.void).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          removeNativeCalls += 1;
                        }),
                      ),
                    ),
                }),
              ),
            ),
            Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
          ),
        );

        expect(exit._tag).toBe("Failure");
        expect(removeNativeCalls).toBe(1);
        expect(
          await Bun.file(join(dataRoot, "snapshots", String(app), "data", "leak-test.json")).exists(),
        ).toBe(false);
      } finally {
        if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });

  test("snapshot lookup operations fail SnapshotNotFoundError for a missing id", async () => {
    await withTempDir(async (dir) => {
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
      const exit = await (async () => {
        try {
          return await Effect.runPromiseExit(
            Effect.scoped(
              Effect.gen(function* () {
                const dataMover = yield* DataMover;
                yield* dataMover.restore("missing", { app, store: "data" });
              }),
            ).pipe(
              Effect.provide(DataMoverLive),
              Effect.provide(providerLayer()),
              Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
            ),
          );
        } finally {
          if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
          else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
        }
      })();

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toMatchObject({ _tag: "SnapshotNotFoundError", snapshotId: "missing" });
      }
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
    expect(Array.from(progress)).toEqual([
      { phase: "started", transferredBytes: 0 },
      { phase: "completed", transferredBytes: 0 },
    ]);
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

describe("DataMoverLive hostPath -> hostPath directory transfers", () => {
  const countingProviderLayer = (counters: {
    pullArtifact: number;
    run: number;
    runStream: number;
  }) =>
    Layer.succeed(RuntimeProvider, {
      ...TestRuntimeProvider,
      pullArtifact: (spec) =>
        Effect.sync(() => {
          counters.pullArtifact += 1;
          return { providerId: ProviderId.make("lando"), ref: spec.ref };
        }),
      run: (spec) => {
        counters.run += 1;
        return TestRuntimeProvider.run(spec);
      },
      runStream: (spec) => {
        counters.runStream += 1;
        return TestRuntimeProvider.runStream(spec);
      },
    } satisfies Context.Tag.Service<typeof RuntimeProvider>);

  const runWithScratchDir = <A, E>(
    scratchDir: string,
    counters: { pullArtifact: number; run: number; runStream: number },
    effect: Effect.Effect<A, E, DataMover | Scope.Scope>,
  ) =>
    Effect.runPromiseExit(
      Effect.scoped(effect).pipe(
        Effect.provide(
          DataMoverLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                StateStoreLive,
                Layer.succeed(PathsService, { ...makeLandoPaths(), scratchDir }),
                countingProviderLayer(counters),
                captureEvents().layer,
                redactionLayer,
              ),
            ),
          ),
        ),
      ),
    );

  test("copies a directory tree into a scratch-dir target and never calls the provider", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const scratchRoot = join(dir, "scratch");
      const source = join(appRoot, "src");
      const target = join(scratchRoot, "inst-1", "root");
      await mkdir(join(source, "nested"), { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: tree-app\n");
      await writeFile(join(source, "marker.txt"), "source-content");
      await writeFile(join(source, "nested", "deep.txt"), "deep-content");

      const counters = { pullArtifact: 0, run: 0, runStream: 0 };
      const exit = await runWithScratchDir(
        scratchRoot,
        counters,
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value.accelerated).toBe(true);
        expect(exit.value.digest).toBeUndefined();
      }
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("source-content");
      expect(await readFile(join(target, "nested", "deep.txt"), "utf8")).toBe("deep-content");
      expect(await readFile(join(source, "marker.txt"), "utf8")).toBe("source-content");
      expect(counters).toEqual({ pullArtifact: 0, run: 0, runStream: 0 });
    });
  });

  test("preserves symlinks in the copied tree without dereferencing them", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const scratchRoot = join(dir, "scratch");
      const source = join(appRoot, "src");
      const target = join(scratchRoot, "inst-2", "root");
      await mkdir(source, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: link-app\n");
      await writeFile(join(source, "real.txt"), "real-content");
      await symlink("real.txt", join(source, "link.txt"));

      const counters = { pullArtifact: 0, run: 0, runStream: 0 };
      const exit = await runWithScratchDir(
        scratchRoot,
        counters,
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(exit._tag).toBe("Success");
      const linkStat = await lstat(join(target, "link.txt"));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await readlink(join(target, "link.txt"))).toBe("real.txt");
    });
  });

  test("preserves single-file digest behavior for a regular-file host -> host copy", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const scratchRoot = join(dir, "scratch");
      const source = join(appRoot, "payload.txt");
      const target = join(scratchRoot, "inst-3", "payload.txt");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: file-app\n");
      await writeFile(source, "file-payload");

      const counters = { pullArtifact: 0, run: 0, runStream: 0 };
      const exit = await runWithScratchDir(
        scratchRoot,
        counters,
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value.digest).toHaveLength(64);
      }
      expect(await readFile(target, "utf8")).toBe("file-payload");
      expect(counters).toEqual({ pullArtifact: 0, run: 0, runStream: 0 });
    });
  });

  test("rejects a host -> host copy whose target escapes both app root and scratch dir", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const scratchRoot = join(dir, "scratch");
      const source = join(appRoot, "src");
      const outsideTarget = join(dir, "outside", "root");
      await mkdir(source, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: escape-app\n");
      await writeFile(join(source, "marker.txt"), "x");

      const counters = { pullArtifact: 0, run: 0, runStream: 0 };
      const exit = await runWithScratchDir(
        scratchRoot,
        counters,
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(outsideTarget) },
            overwrite: true,
          });
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DataSourceOutsideRootError);
      }
    });
  });

  test("rejects a scratch-dir target whose parent escapes via a symlink", async () => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const scratchRoot = join(dir, "scratch");
      const outsideDir = join(dir, "outside");
      const source = join(appRoot, "src");
      await mkdir(source, { recursive: true });
      await mkdir(scratchRoot, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: symlink-escape-app\n");
      await writeFile(join(source, "marker.txt"), "x");
      await symlink(outsideDir, join(scratchRoot, "evil"));
      const target = join(scratchRoot, "evil", "root");

      const counters = { pullArtifact: 0, run: 0, runStream: 0 };
      const exit = await runWithScratchDir(
        scratchRoot,
        counters,
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          return yield* dataMover.transfer({
            from: { _tag: "hostPath", path: absolute(source) },
            to: { _tag: "hostPath", path: absolute(target) },
            overwrite: true,
          });
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DataSourceOutsideRootError);
      }
    });
  });
});

describe("DataMoverLive pinned helper image resolution", () => {
  const pinned = providerImages.images.dataHelper;
  const volumeCaps = dataPlaneCapabilities({ ephemeralMounts: true });

  const importToVolume = (dataMover: Context.Tag.Service<typeof DataMover>, source: string) =>
    dataMover.transfer({
      from: { _tag: "hostPath", path: absolute(source) },
      to: { _tag: "volume", app, store: "data" },
      overwrite: true,
    });

  test("pulls and runs the digest-qualified pinned ref before the helper container runs", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "seed.txt");
      await writeFile(source, "pinned-helper-payload");
      let pulledRef: string | undefined;
      let ranImage: string | undefined;

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* importToVolume(dataMover, source);
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              capabilities: volumeCaps,
              pullArtifact: (spec) =>
                Effect.sync(() => {
                  pulledRef = spec.ref;
                  return { providerId: ProviderId.make("test"), ref: spec.ref, digest: pinned.digest };
                }),
              run: (spec) => {
                ranImage = spec.image;
                return TestRuntimeProvider.run(spec);
              },
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(pulledRef).toBe(`${pinned.image}@${pinned.digest}`);
      expect(ranImage).toBe(`${pinned.image}@${pinned.digest}`);
    });
  });

  test("fails loudly before running the helper when the returned digest mismatches", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "seed.txt");
      await writeFile(source, "pinned-helper-payload");
      let runCalls = 0;

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* importToVolume(dataMover, source);
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              capabilities: volumeCaps,
              pullArtifact: (spec) =>
                Effect.succeed({
                  providerId: ProviderId.make("test"),
                  ref: spec.ref,
                  digest: `sha256:${"f".repeat(64)}`,
                }),
              run: (spec) => {
                runCalls += 1;
                return TestRuntimeProvider.run(spec);
              },
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(runCalls).toBe(0);
    });
  });

  test("fails loudly before running the helper when the returned digest is missing", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "seed.txt");
      await writeFile(source, "pinned-helper-payload");
      let runCalls = 0;

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* importToVolume(dataMover, source);
          }),
        ).pipe(
          Effect.provide(DataMoverLive),
          Effect.provide(
            providerLayer({
              capabilities: volumeCaps,
              pullArtifact: (spec) => Effect.succeed({ providerId: ProviderId.make("test"), ref: spec.ref }),
              run: (spec) => {
                runCalls += 1;
                return TestRuntimeProvider.run(spec);
              },
            }),
          ),
          Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(runCalls).toBe(0);
    });
  });

  test("warm cache resolves with no network access and runs idempotently", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "seed.txt");
      await writeFile(source, "pinned-helper-payload");
      let networkPulls = 0;
      const warmCache = new Set<string>();

      const provider = providerLayer({
        capabilities: volumeCaps,
        pullArtifact: (spec) =>
          Effect.sync(() => {
            if (!warmCache.has(spec.ref)) {
              networkPulls += 1;
              warmCache.add(spec.ref);
            }
            return { providerId: ProviderId.make("test"), ref: spec.ref, digest: pinned.digest };
          }),
      });

      const runImport = Effect.scoped(
        Effect.gen(function* () {
          const dataMover = yield* DataMover;
          yield* importToVolume(dataMover, source);
        }),
      ).pipe(
        Effect.provide(DataMoverLive),
        Effect.provide(provider),
        Effect.provide(Layer.merge(captureEvents().layer, redactionLayer)),
      );

      await Effect.runPromise(runImport);
      await Effect.runPromise(runImport);

      expect(networkPulls).toBe(1);
    });
  });
});
