import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { DataTransferError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect, Layer, Stream } from "effect";
import { layer } from "../src/service.ts";

test("missing applied plans preserve the app identity and start remediation", async () => {
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([]),
    capabilities: Effect.die("No provider was selected"),
    select: () => Effect.die("Do not use the host provider for an unknown app"),
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  });
  const result = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.flatMap(DataMover, (mover) =>
          mover.transfer({
            from: {
              _tag: "serviceCmd",
              app: AppId.make("unstarted-app"),
              service: ServiceName.make("db"),
              command: ["export"],
            },
            to: { _tag: "hostPath", path: AbsolutePath.make(`${process.cwd()}/.tmp-p3-unstarted-output`) },
            overwrite: true,
          }),
        ),
      ),
    ).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(RuntimeProviderRegistry, registry),
              Layer.succeed(PathsService, makeLandoPaths()),
              Layer.succeed(StateStore, makeTestStateStore().service),
              RedactionService.layer,
              Layer.succeed(
                EventService,
                EventService.of({
                  publish: () => Effect.void,
                  subscribe: () => Stream.empty,
                  subscribeQueue: Effect.never,
                  waitFor: () => Effect.never,
                  waitForAny: () => Effect.never,
                  query: () => Effect.succeed([]),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(DataTransferError);
    if (result.failure instanceof DataTransferError) {
      expect(result.failure.message).toContain("unstarted-app");
      expect(result.failure.remediation).toContain("lando start");
      expect(result.failure.operation).toBe("select");
    }
  }
});
