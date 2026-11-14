import { expect, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { openAppBuildResults, recordBuildResult } from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan, runDestroyTarget } from "./destroy-progress-topology-support.ts";

const buildEntry = (phase: "artifact" | "app", transcriptPath: string, step?: string) => ({
  buildKey: `${phase}-key`,
  service: ServiceName.make("web"),
  ...(phase === "app" ? { phase, step: step ?? "web:app:install" } : { phase }),
  outcome: "complete" as const,
  durationMs: 1,
  transcriptPath: AbsolutePath.make(transcriptPath),
});

test("destroy clears app results and build output only after successful teardown", async () => {
  // Given an app with image and app-step build output.
  const state = makeTestStateStore();
  let atDestroy: ReadonlyArray<{ readonly phase: string }> = [];
  const harness = makeHarness({
    stateStore: state.service,
    destroyEffect: Effect.gen(function* () {
      const bucket = yield* openAppBuildResults(state.service, BuildOwner.fromPlan(plan));
      atDestroy = (yield* bucket.get) ?? [];
    }).pipe(Effect.orDie),
  });
  const appDir = join(harness.userDataRoot, "builds", "owners", BuildOwner.fromPlan(plan).key);
  const transcript = join(appDir, "app", "web", "install.log");
  await mkdir(join(appDir, "app", "web"), { recursive: true });
  await mkdir(join(appDir, "artifact", "web"), { recursive: true });
  await writeFile(join(appDir, "artifact", "web", "image.log"), "image\n");
  await writeFile(transcript, "install\n");
  const bucket = await Effect.runPromise(openAppBuildResults(state.service, BuildOwner.fromPlan(plan)));
  await Effect.runPromise(
    recordBuildResult(bucket, buildEntry("artifact", join(appDir, "artifact", "web", "image.log"))),
  );
  await Effect.runPromise(recordBuildResult(bucket, buildEntry("app", transcript, "web:app:install")));
  const other = BuildOwner.root(AbsolutePath.make(join(plan.root, "other-root")));
  const otherBucket = await Effect.runPromise(openAppBuildResults(state.service, other));
  const otherTranscript = join(
    harness.userDataRoot,
    "builds",
    "owners",
    other.key,
    "app",
    "web",
    "install.log",
  );
  await mkdir(join(harness.userDataRoot, "builds", "owners", other.key, "app", "web"), { recursive: true });
  await writeFile(otherTranscript, "B output\n");
  await Effect.runPromise(
    recordBuildResult(otherBucket, buildEntry("app", otherTranscript, "web:app:install")),
  );

  // When
  const result = await runDestroyTarget(harness, { volumes: true });

  // Then: results survive until teardown succeeds, and only the image result stays afterwards.
  expect(result.outcome).toBe("destroyed");
  expect(atDestroy.map((entry) => entry.phase)).toEqual(["artifact", "app"]);
  await expect(lstat(appDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
  const remaining = await Effect.runPromise(bucket.get);
  expect(remaining?.map((entry) => entry.phase)).toEqual(["artifact"]);
  expect((await Effect.runPromise(otherBucket.get))?.map((entry) => entry.phase)).toEqual(["app"]);
  expect(await Bun.file(otherTranscript).text()).toBe("B output\n");
});

test("a failed teardown keeps app results and build transcripts", async () => {
  // Given an app whose provider destroy fails.
  const state = makeTestStateStore();
  const harness = makeHarness({
    stateStore: state.service,
    destroyEffect: Effect.fail(
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "destroy",
        message: "injected",
        remediation: "Install or start the provider and retry.",
      }),
    ),
  });
  const appDir = join(harness.userDataRoot, "builds", "owners", BuildOwner.fromPlan(plan).key);
  const transcript = join(appDir, "app", "web", "install.log");
  await mkdir(join(appDir, "app", "web"), { recursive: true });
  await writeFile(transcript, "output\n");
  const bucket = await Effect.runPromise(openAppBuildResults(state.service, BuildOwner.fromPlan(plan)));
  await Effect.runPromise(recordBuildResult(bucket, buildEntry("app", transcript, "web:app:install")));

  // When
  await expect(runDestroyTarget(harness, { volumes: true })).rejects.toBeInstanceOf(ProviderUnavailableError);

  // Then: failed teardown preserves the results and their transcripts.
  expect(await Bun.file(transcript).exists()).toBe(true);
  const remaining = await Effect.runPromise(bucket.get);
  expect(remaining).toHaveLength(1);
  expect(remaining?.[0]).toMatchObject({ phase: "app", step: "web:app:install", transcriptPath: transcript });
});
