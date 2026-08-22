import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";

import { DataMoverLive } from "@lando/data-mover/service";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import { DataMover, EventService, PathsService, RuntimeProvider } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { StateStoreLive } from "@lando/state-store/service";

const app = AppId.make("data-app");
const service = ServiceName.make("web");
const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);

const silentEvents = Layer.succeed(EventService, {
  publish: () => Effect.void,
  subscribe: () => Stream.empty,
  subscribeQueue: Effect.never,
  waitFor: () => Effect.never,
  waitForAny: () => Effect.never,
  query: () => Effect.succeed([]),
});

const passthroughRedaction = Layer.succeed(RedactionService, {
  forProfile: () =>
    Effect.succeed({
      redactString: (input: string) => input,
      redactValue: (input: unknown) => input,
    }),
});

describe("DataMoverLive call-time provider", () => {
  test("uses the RuntimeProvider provided at call time, not the construction stub", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-mover-call-time-"));
    const target = resolve(dir, "out.txt");
    try {
      const stub = {
        ...TestRuntimeProvider,
        execStream: () => Stream.empty,
      };
      const selected = {
        ...TestRuntimeProvider,
        execStream: () =>
          Stream.fromIterable([
            { kind: "stdout" as const, chunk: new TextEncoder().encode("selected-output") },
            { exitCode: 0 },
          ]),
      };

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "serviceCmd", app, service, command: ["export-db"] },
              to: { _tag: "hostPath", path: absolute(target) },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provideService(RuntimeProvider, selected),
          Effect.provide(
            DataMoverLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  StateStoreLive,
                  Layer.succeed(PathsService, makeLandoPaths()),
                  Layer.succeed(RuntimeProvider, stub),
                  silentEvents,
                  passthroughRedaction,
                ),
              ),
            ),
          ),
        ),
      );

      expect(await readFile(target, "utf8")).toBe("selected-output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
