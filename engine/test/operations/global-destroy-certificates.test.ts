import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, ProviderId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { GlobalAppService, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import { globalDestroy } from "../../src/operations/global-destroy.ts";
import { BuildOwner, openAppBuildResults, recordBuildResult } from "../../src/services/build-results.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";

for (const evidence of ["applied", "absent"] as const) {
  for (const scoped of [false, true]) {
    test(`global destroy (${evidence}, scoped=${scoped}) removes leaf certificates only when unscoped`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "global-destroy-certificates-")));
      try {
        // Given: the global owner's leaf directory, with or without an applied global app.
        const certsDir = makeLandoPaths({
          userDataRoot: root,
          userCacheRoot: join(root, "cache"),
          userConfRoot: join(root, "conf"),
          systemPluginRoot: join(root, "sys"),
          env: {},
          platform: "linux",
        }).certsDir;
        const appRoot = AbsolutePath.make(join(root, "global"));
        const { certPath } = serviceCertificatePaths(certsDir, appIdentityKey("owner", appRoot), "ssh-agent");
        await Bun.write(certPath, "certificate\n");
        const harness = await globalTeardownHarness(
          root,
          evidence === "applied" ? { plan: globalPlanAt(appRoot) } : {},
        );

        // When
        const result = await Effect.runPromise(
          globalDestroy({ yes: true, ...(scoped ? { providerId: ProviderId.make("lando") } : {}) }).pipe(
            Effect.provide(harness.layer),
          ),
        );

        // Then: a provider-scoped destroy keeps material another realization may mount, and the
        // absent path reports unchanged without tearing anything down.
        expect(result.outcome).toBe(evidence === "applied" ? "destroyed" : "unchanged");
        if (evidence === "absent") {
          expect(harness.calls).not.toContain("destroy");
          expect(harness.calls).not.toContain("removeObservedService");
          expect(harness.calls).not.toContain("ensureReady");
        }
        expect(await Bun.file(certPath).exists()).toBe(scoped);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("global destroy removes evidence at the applied root and preserves the configured root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "global-build-owner-")));
  try {
    const applied = globalPlanAt(AbsolutePath.make(join(root, "actual-global")));
    const configured = globalPlanAt(AbsolutePath.make(join(root, "global")));
    await mkdir(applied.root);
    await mkdir(configured.root);
    const harness = await globalTeardownHarness(root, { plan: applied });
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore;
        const buckets = [];
        for (const plan of [applied, configured]) {
          const owner = BuildOwner.fromPlan(plan);
          const path = AbsolutePath.make(
            join(root, "builds", "owners", owner.key, "app", "ssh-agent", "key.log"),
          );
          yield* Effect.promise(async () => {
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, plan.root);
          });
          const bucket = yield* openAppBuildResults(store, owner);
          yield* recordBuildResult(bucket, {
            phase: "app",
            step: "ssh-agent:app:install",
            buildKey: "key",
            service: ServiceName.make("ssh-agent"),
            outcome: "complete",
            durationMs: 1,
            transcriptPath: path,
          });
          buckets.push({ bucket, path });
        }
        const global = yield* GlobalAppService;
        yield* globalDestroy({ yes: true }).pipe(
          Effect.provideService(GlobalAppService, {
            ...global,
            root: Effect.succeed(applied.root),
            paths: global.paths.pipe(Effect.map((paths) => ({ ...paths, root: applied.root }))),
          }),
        );
        return yield* Effect.forEach(buckets, ({ bucket, path }) =>
          Effect.gen(function* () {
            return {
              entries: yield* bucket.get,
              output: yield* Effect.promise(() => Bun.file(path).exists()),
            };
          }),
        );
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(kept[0]).toEqual({ entries: [], output: false });
    expect(kept[1]?.entries).toHaveLength(1);
    expect(kept[1]?.output).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
