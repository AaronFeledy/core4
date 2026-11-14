import { expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  BuildOwner,
  findCompleteBuildResult,
  invalidateAppBuildResult,
  openAppBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("dispatch of another key retires historical app eligibility without losing output or sibling evidence", async () => {
  const store = makeTestStateStore();
  const bucket = await Effect.runPromise(
    openAppBuildResults(store.service, BuildOwner.root(AbsolutePath.make("/tmp/eligibility"))),
  );
  const app = {
    phase: "app",
    service: ServiceName.make("web"),
    step: "web:app:install",
    containerId: "native-1",
    outcome: "complete",
    exitCode: 0,
    durationMs: 1,
  } as const;
  const artifact = {
    phase: "artifact",
    service: app.service,
    buildKey: "image",
    artifactRef: "web:built",
    outcome: "complete",
    durationMs: 1,
    transcriptPath: AbsolutePath.make("/tmp/image.log"),
  } as const;
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const buildKey of ["a", "b", "c", "d", "e"]) {
        yield* recordBuildResult(bucket, {
          ...app,
          buildKey,
          transcriptPath: AbsolutePath.make(`/tmp/${buildKey}.log`),
        });
      }
      yield* recordBuildResult(bucket, {
        ...app,
        step: "web:app:sibling",
        buildKey: "sibling",
        transcriptPath: AbsolutePath.make("/tmp/sibling.log"),
      });
      yield* recordBuildResult(bucket, artifact);
    }),
  );
  const before = await Effect.runPromise(bucket.get);

  // Dispatch can be interrupted before a replacement attempt is recorded.
  await Effect.runPromise(invalidateAppBuildResult(bucket, { ...app, buildKey: "unrecorded" }));

  const after = (await Effect.runPromise(bucket.get)) ?? [];
  expect(after).toHaveLength(7);
  expect(after).toMatchObject(before ?? []);
  for (const buildKey of ["a", "b", "c", "d", "e"]) {
    expect(findCompleteBuildResult(after, { ...app, buildKey })).toBeUndefined();
  }
  expect(
    findCompleteBuildResult(after, { ...app, step: "web:app:sibling", buildKey: "sibling" }),
  ).toMatchObject({ step: "web:app:sibling", buildKey: "sibling", containerId: "native-1" });
  expect(findCompleteBuildResult(after, artifact)).toEqual(
    before?.find((entry) => entry.phase === "artifact"),
  );
});
