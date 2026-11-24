import { expect, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect } from "effect";
import { destroyApp } from "../../src/operations/destroy.ts";
import { artifactBuildStoreKey } from "../../src/services/build-artifact-name.ts";
import {
  openArtifactBuildResults,
  recordArtifactBuildResult,
} from "../../src/services/build-artifact-results.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { openAppBuildResults, recordBuildResult } from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan, runDestroyTarget } from "./destroy-progress-topology-support.ts";

const buildEntry = (phase: "app", transcriptPath: string, step?: string) => ({
  buildKey: `${phase}-key`,
  service: ServiceName.make("web"),
  phase,
  step: step ?? "web:app:install",
  outcome: "complete" as const,
  durationMs: 1,
  transcriptPath: AbsolutePath.make(transcriptPath),
});

test.each([false, true])(
  "destroy releases an image, then cache purge removes it or reports its containers (inUse=%s)",
  async (inUse) => {
    const state = makeTestStateStore();
    const harness = makeHarness({ stateStore: state.service });
    let present = true;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const paths = yield* PathsService;
        const key = yield* artifactBuildStoreKey(paths.roots.userCacheRoot);
        const ref = `lando-build-${key}-test-web-image`;
        const registry = yield* RuntimeProviderRegistry;
        const base = yield* registry.select(plan);
        const provider = {
          ...base,
          listArtifacts: () => Effect.sync(() => (present ? [{ id: "image-id", refs: [ref] }] : [])),
          removeArtifact: () =>
            Effect.sync(() => {
              if (inUse)
                return {
                  kind: "in-use" as const,
                  containers: ["retained-web"],
                  reason: "container holds image",
                };
              present = false;
              return { kind: "removed" as const };
            }),
        };
        const bucket = yield* openArtifactBuildResults(state.service);
        yield* recordArtifactBuildResult(bucket, {
          owner: BuildOwner.fromPlan(plan).key,
          providerId: "lando",
          phase: "artifact",
          service: ServiceName.make("web"),
          buildKey: "key",
          artifactRef: ref,
          artifactOrigin: "build",
          outcome: "complete",
          durationMs: 1,
          transcriptPath: AbsolutePath.make("/tmp/release.log"),
        });
        const target = {
          plan,
          root: plan.root,
          app: { kind: "user" as const, id: plan.id, root: plan.root },
        };
        const selected = makeTestRuntimeProviderRegistry({
          ...registry,
          select: () => Effect.succeed(provider),
        });
        const first = yield* destroyApp({}, target).pipe(
          Effect.provideService(RuntimeProviderRegistry, selected),
        );
        const retained = yield* bucket.get;
        const second = yield* destroyApp({ purgeCaches: true }, target).pipe(
          Effect.provideService(RuntimeProviderRegistry, selected),
        );
        return { first, retained, second, after: yield* bucket.get, ref };
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(result.first.builtImages).toEqual({ removed: 0, released: 1, inUse: [] });
    expect(result.retained?.results).toMatchObject([{ releasedAt: expect.anything() }]);
    expect(result.second.builtImages).toEqual(
      inUse
        ? {
            removed: 0,
            released: 0,
            inUse: [{ ref: result.ref, containers: ["retained-web"], reason: "container holds image" }],
          }
        : { removed: 1, released: 0, inUse: [] },
    );
    expect(result.after?.results).toEqual([]);
    expect(present).toBe(inUse);
  },
);

test("destroy clears app results and build output only after successful teardown", async () => {
  // Given an app with image and app-step build output.
  const state = makeTestStateStore();
  let atDestroy: ReadonlyArray<{ readonly phase: string }> = [];
  const harness = makeHarness({
    stateStore: state.service,
    destroyEffect: Effect.gen(function* () {
      const bucket = yield* openAppBuildResults(state.service, BuildOwner.fromPlan(plan));
      atDestroy = [
        ...((yield* (yield* openArtifactBuildResults(state.service)).get)?.results ?? []),
        ...((yield* bucket.get) ?? []),
      ];
    }).pipe(Effect.orDie),
  });
  const appDir = join(harness.userDataRoot, "builds", "owners", BuildOwner.fromPlan(plan).key);
  const transcript = join(appDir, "app", "web", "install.log");
  await mkdir(join(appDir, "app", "web"), { recursive: true });
  await mkdir(join(appDir, "artifact", "web"), { recursive: true });
  await writeFile(join(appDir, "artifact", "web", "image.log"), "image\n");
  await writeFile(transcript, "install\n");
  const bucket = await Effect.runPromise(openAppBuildResults(state.service, BuildOwner.fromPlan(plan)));
  const artifacts = await Effect.runPromise(openArtifactBuildResults(state.service));
  await Effect.runPromise(
    recordArtifactBuildResult(artifacts, {
      owner: BuildOwner.fromPlan(plan).key,
      providerId: String(plan.provider),
      phase: "artifact",
      service: ServiceName.make("web"),
      buildKey: "image-key",
      artifactRef: "lando-built:test",
      artifactOrigin: "build",
      outcome: "complete",
      durationMs: 1,
      transcriptPath: AbsolutePath.make(join(appDir, "artifact", "web", "image.log")),
    }),
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

  // Then: results survive until teardown succeeds.
  expect(result.outcome).toBe("destroyed");
  expect(atDestroy.map((entry) => entry.phase)).toEqual(["artifact", "app"]);
  await expect(lstat(appDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
  const remaining = await Effect.runPromise(bucket.get);
  expect(remaining).toEqual([]);
  expect((await Effect.runPromise(artifacts.get))?.results).toMatchObject([
    { artifactRef: "lando-built:test", releasedAt: expect.anything() },
  ]);
  expect(result.builtImages).toEqual({ removed: 0, released: 1, inUse: [] });
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

for (const scoped of [false, true])
  test(`cache purge removes only its owner's artifact entries (provider scoped=${scoped})`, async () => {
    const state = makeTestStateStore();
    const harness = makeHarness({ stateStore: state.service });
    const artifacts = await Effect.runPromise(openArtifactBuildResults(state.service));
    const owner = BuildOwner.fromPlan(plan);
    const bucket = await Effect.runPromise(openAppBuildResults(state.service, owner));
    await Effect.runPromise(recordBuildResult(bucket, buildEntry("app", "/tmp/scoped-destroy.log")));
    for (const [entryOwner, providerId, buildKey] of [
      [owner.key, "lando", "owned"],
      [owner.key, "docker", "other-provider"],
      ["other-owner", "lando", "foreign"],
      ["scratch-one", "lando", "scratch"],
    ]) {
      if (entryOwner === undefined || providerId === undefined || buildKey === undefined)
        throw new TypeError("Missing fixture entry");
      await Effect.runPromise(
        recordArtifactBuildResult(artifacts, {
          owner: entryOwner,
          providerId,
          buildKey,
          service: ServiceName.make("web"),
          phase: "artifact",
          artifactRef: `built-${buildKey}`,
          artifactOrigin: "build",
          outcome: "complete",
          durationMs: 1,
          transcriptPath: AbsolutePath.make("/tmp/scoped-image.log"),
        }),
      );
    }

    await Effect.runPromise(
      destroyApp(
        { purgeCaches: true, ...(scoped ? { providerId: ProviderId.make("lando") } : {}) },
        {
          plan,
          root: plan.root,
          app: { kind: "user", id: plan.id, root: plan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    );

    expect((await Effect.runPromise(artifacts.get))?.results.map((entry) => entry.buildKey)).toEqual(
      scoped ? ["other-provider", "foreign", "scratch"] : ["foreign", "scratch"],
    );
    expect(await Effect.runPromise(bucket.exists)).toBe(false);
  });
