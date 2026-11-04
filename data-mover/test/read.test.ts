import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";

import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTransferError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import {
  DataMover,
  type EventFor,
  EventService,
  type ExecChunk,
  type LandoEvent,
  PathsService,
  RuntimeProvider,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";

import { makeDataMoverService } from "../src/service.ts";
import * as BunDataMover from "./support.ts";

const app = AppId.make("data-app");
const service = ServiceName.make("web");
const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));

const captureEvents = () => {
  const captured: LandoEvent[] = [];
  const serviceLayer = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          captured.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<LandoEvent>(),
      waitFor: <Name extends string>(name: Name) =>
        Effect.sync(() => {
          const found = captured.find((event): event is EventFor<Name> => event.eventName === name);
          if (found === undefined) throw new Error(`missing event ${name}`);
          return found;
        }),
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: <Name extends string>(name: Name) =>
        Effect.sync(() => captured.filter((event): event is EventFor<Name> => event.eventName === name)),
    }),
  );
  return { layer: serviceLayer, events: () => [...captured] };
};

const redactionLayer = Layer.effect(
  RedactionService,
  Effect.gen(function* () {
    const service = makeRedactionService();
    yield* service.registerValues(["secret-token"]);
    return service;
  }),
);

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-data-mover-read-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

describe("DataMover.read", () => {
  test("streams exact serviceCmd bytes and publishes stream destination events", async () => {
    await withTempDir(async (_dir) => {
      const payload = new Uint8Array([0, 255, 195, 169, 0, ...bytes("exact-serviceCmd-bytes")]);
      const capture = captureEvents();
      const dumpChunks: ExecChunk[] = [
        ...Array.from(payload, (byte): ExecChunk => ({ kind: "stdout", chunk: new Uint8Array([byte]) })),
        { exitCode: 0 },
      ];

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            return yield* dataMover
              .read({ _tag: "serviceCmd", app, service, command: ["export-db"] })
              .pipe(Stream.runCollect);
          }),
        ).pipe(
          Effect.provide(BunDataMover.layer),
          Effect.provide(
            Layer.mergeAll(
              stateStoreLayer,
              Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
              Layer.succeed(
                RuntimeProvider,
                RuntimeProvider.of({
                  ...TestRuntimeProvider,
                  execStream: () => Stream.fromIterable(dumpChunks),
                }),
              ),
              capture.layer,
              redactionLayer,
            ),
          ),
        ),
      );

      expect(concatChunks(Array.from(collected))).toEqual(payload);
      expect(capture.events().map((event) => event.eventName)).toEqual([
        "pre-data-transfer",
        "post-data-transfer",
      ]);
      const pre = capture.events().find((event) => event.eventName === "pre-data-transfer");
      const post = capture.events().find((event) => event.eventName === "post-data-transfer");
      expect(pre).toMatchObject({ toEndpoint: "stream", app, service });
      expect(post).toMatchObject({
        toEndpoint: "stream",
        outcome: "success",
        accelerated: false,
        sizeBytes: payload.byteLength,
      });
    });
  });

  test("preserves serviceCmd nonzero exitCode and redacted stderrTail", async () => {
    await withTempDir(async (dir) => {
      const secret = "secret-token";
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const provider = RuntimeProvider.of({
            ...TestRuntimeProvider,
            execStream: () =>
              Stream.make(
                { kind: "stderr" as const, chunk: bytes(`dump failed ${secret}\n`) },
                { exitCode: 9 },
              ),
          });
          const mover = makeDataMoverService(
            Effect.succeed(provider),
            { redactText: (text) => text, publish: () => Effect.void },
            { paths: { ...makeLandoPaths(), scratchDir: join(dir, "scratch") }, stateStore },
          );
          return yield* mover
            .read({
              _tag: "serviceCmd",
              app,
              service,
              command: ["export-db"],
              env: { MYSQL_PWD: secret },
              secrets: { substring: [secret], wholeToken: [] },
            })
            .pipe(Stream.runCollect, Effect.result);
        }).pipe(Effect.scoped, Effect.provide(stateStoreLayer)),
      );

      if (result._tag !== "Failure") throw new Error("Expected producer failure");
      expect(result.failure).toBeInstanceOf(DataTransferError);
      if (!(result.failure instanceof DataTransferError)) throw new Error("Expected DataTransferError");
      expect(result.failure.exitCode).toBe(9);
      expect(result.failure.stderrTail).toBe("dump failed [redacted]\n");
      expect(JSON.stringify(result.failure).includes(secret)).toBe(false);
    });
  });

  test("rejects stream endpoint sources", async () => {
    await withTempDir(async (_dir) => {
      const capture = captureEvents();
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            return yield* dataMover.read({ _tag: "stream" }).pipe(Stream.runCollect, Effect.result);
          }),
        ).pipe(
          Effect.provide(BunDataMover.layer),
          Effect.provide(
            Layer.mergeAll(
              stateStoreLayer,
              Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
              Layer.succeed(RuntimeProvider, RuntimeProvider.of({ ...TestRuntimeProvider })),
              capture.layer,
              redactionLayer,
            ),
          ),
        ),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "DataEndpointUnsupportedError",
          fromEndpoint: "stream",
          toEndpoint: "stream",
        },
      });
      if (result._tag !== "Failure") throw new Error("Expected unsupported endpoint failure");
      expect(result.failure).toBeInstanceOf(DataEndpointUnsupportedError);
      expect(capture.events().map((event) => event.eventName)).toEqual([
        "pre-data-transfer",
        "post-data-transfer",
      ]);
      expect(capture.events().at(-1)).toMatchObject({ outcome: "failure", toEndpoint: "stream" });
    });
  });

  test("rejects untrusted hostPath sources outside the app root", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "lando-data-mover-read-outside-"));
    try {
      await withTempDir(async (dir) => {
        const outside = join(outsideDir, "outside.txt");
        await writeFile(outside, "outside-payload");
        await writeFile(join(dir, ".lando.yml"), "name: data-root\n");
        const inside = join(dir, "nested", "inside.txt");
        await mkdir(dirname(inside), { recursive: true });
        await writeFile(inside, "inside-payload");

        const outsideExit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              yield* dataMover
                .read({ _tag: "hostPath", path: AbsolutePath.make(outside) })
                .pipe(Stream.runCollect);
            }),
          ).pipe(
            Effect.provide(BunDataMover.layer),
            Effect.provide(
              Layer.mergeAll(
                stateStoreLayer,
                Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
                Layer.succeed(RuntimeProvider, RuntimeProvider.of({ ...TestRuntimeProvider })),
                captureEvents().layer,
                redactionLayer,
              ),
            ),
          ),
        );
        expect(outsideExit._tag).toBe("Failure");
        if (outsideExit._tag === "Failure") {
          expect(Option.getOrThrow(Cause.findErrorOption(outsideExit.cause))).toBeInstanceOf(
            DataSourceOutsideRootError,
          );
        }

        const insideBytes = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dataMover = yield* DataMover;
              return yield* dataMover
                .read({ _tag: "hostPath", path: AbsolutePath.make(inside) })
                .pipe(Stream.runCollect);
            }),
          ).pipe(
            Effect.provide(BunDataMover.layer),
            Effect.provide(
              Layer.mergeAll(
                stateStoreLayer,
                Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
                Layer.succeed(RuntimeProvider, RuntimeProvider.of({ ...TestRuntimeProvider })),
                captureEvents().layer,
                redactionLayer,
              ),
            ),
          ),
        );
        expect(Buffer.from(concatChunks(Array.from(insideBytes))).toString("utf8")).toBe("inside-payload");
        expect(await readFile(inside, "utf8")).toBe("inside-payload");
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
