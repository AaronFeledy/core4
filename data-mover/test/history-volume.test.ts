import { describe, expect, test } from "bun:test";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";

import * as BunDataMover from "@lando/data-mover/service";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { DataEndpointUnsupportedError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, historyStoreName } from "@lando/sdk/schema";
import { DataMover, EventService, PathsService, RuntimeProvider } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";

const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));
const app = AppId.make("histapp");
const store = historyStoreName("histapp");

const silentEvents = Layer.succeed(
  EventService,
  EventService.of({
    publish: () => Effect.void,
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.never,
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  }),
);

const passthroughRedaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    payloadValues: () => Effect.succeed(() => []),
    forProfile: () =>
      Effect.succeed({
        redactString: (input: string) => input,
        redactValue: (input: unknown) => input,
      }),
  }),
);

const runMover = <A, E>(effect: Effect.Effect<A, E, DataMover>) =>
  Effect.runPromiseExit(
    Effect.scoped(effect).pipe(
      Effect.provide(BunDataMover.layer),
      Effect.provide(Layer.succeed(RuntimeProvider, RuntimeProvider.of({ ...TestRuntimeProvider }))),
      Effect.provide(
        Layer.mergeAll(
          stateStoreLayer,
          silentEvents,
          passthroughRedaction,
          Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
        ),
      ),
    ),
  );

const expectHistoryUnsupported = (exit: Awaited<ReturnType<typeof runMover>>) => {
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(DataEndpointUnsupportedError);
    expect(String(error.message)).toMatch(/History volume/);
  }
};

describe("history volume is excluded from snapshots and exports", () => {
  test("refuses transfer from a history volume", async () => {
    expectHistoryUnsupported(
      await runMover(
        Effect.flatMap(DataMover, (mover) =>
          mover.transfer({
            from: { _tag: "volume", app, store },
            to: { _tag: "hostPath", path: Schema.decodeUnknownSync(AbsolutePath)("/tmp/history.tar") },
          }),
        ),
      ),
    );
  });

  test("refuses snapshot of a history volume", async () => {
    expectHistoryUnsupported(
      await runMover(Effect.flatMap(DataMover, (mover) => mover.snapshot({ app, store }))),
    );
  });

  test("refuses restore onto a history volume", async () => {
    expectHistoryUnsupported(
      await runMover(Effect.flatMap(DataMover, (mover) => mover.restore("snap-id", { app, store }))),
    );
  });
});
