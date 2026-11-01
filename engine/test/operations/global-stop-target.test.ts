import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { EventService, FileSystem, GlobalAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { readGlobalReconciliation, recordGlobalReconciliation } from "../../src/global-app/reconciliation.ts";
import { makeGlobalAppServiceForRoot, renderGlobalDist } from "../../src/global-app/service.ts";
import { appMutationLockKey } from "../../src/operations/app-mutation-lock.ts";
import { globalStop } from "../../src/operations/global-stop.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";

test.each([false, true])("targets discovery with route failure=%s", async (routeFailure) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-global-stop-target-")));
  try {
    const actualData = join(root, "actual");
    const configuredData = join(root, "configured");
    await mkdir(actualData);
    await mkdir(configuredData);
    const actualRoot = AbsolutePath.make(join(actualData, "global"));
    const plan = globalPlanAt(actualRoot);
    const configured = await globalTeardownHarness(configuredData, { plan, routeFailure });
    const actual = await globalTeardownHarness(actualData);
    const pending = [
      { phase: "containers" as const, services: ["ssh-agent"], message: "Remove containers." },
      { phase: "routes" as const, services: ["ssh-agent"], message: "Withdraw routes." },
      { phase: "generation" as const, services: [], message: "Regenerate configuration." },
    ] as const;
    const seed = recordGlobalReconciliation({
      revision: 7,
      contributions: ["ssh-agent"],
      servicesRemoved: [],
      pending,
    });
    await Effect.runPromise(seed.pipe(Effect.provide(actual.layer)));
    await Effect.runPromise(seed.pipe(Effect.provide(configured.layer)));

    const result = await Effect.runPromise(
      globalStop({
        target: { root: actualRoot, providerId: ProviderId.make("lando") },
        triggeredBy: "apps:poweroff",
      }).pipe(Effect.result, Effect.provide(configured.layer)),
    );

    expect(result._tag).toBe(routeFailure ? "Failure" : "Success");
    expect(configured.destroyed).toEqual([plan]);
    expect(configured.destroyOptions).toEqual([{ volumes: false, removeState: false }]);
    expect(configured.events[0]).toMatchObject({
      _tag: "pre-global-stop",
      app: { root: actualRoot },
      triggeredBy: "apps:poweroff",
    });
    expect(configured.eventRoots).toEqual(routeFailure ? [actualRoot] : [actualRoot, actualRoot]);
    expect(configured.routeRoots).toEqual([actualRoot]);
    expect(configured.calls).toEqual([
      "pre-global-stop",
      "destroy",
      "removeRoutes",
      ...(routeFailure ? [] : ["post-global-stop"]),
    ]);
    const actualReceipt = await Effect.runPromise(
      readGlobalReconciliation().pipe(Effect.provide(actual.layer)),
    );
    const configuredReceipt = await Effect.runPromise(
      readGlobalReconciliation().pipe(Effect.provide(configured.layer)),
    );
    expect(actualReceipt.pending).toEqual(routeFailure ? pending : [pending[2]]);
    expect(configuredReceipt.pending).toEqual(pending);
    expect(await readdir(actualData)).toContain(`.lando-global-${appMutationLockKey("global", actualRoot)}`);
    expect(await readdir(configuredData)).not.toContain(
      `.lando-global-${appMutationLockKey("global", join(configuredData, "global"))}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["yaml", "typescript"])("keeps pre-stop files on the %s target", async (form) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-global-stop-hook-")));
  try {
    const actualRoot = AbsolutePath.make(join(root, "actual", "global"));
    const configuredData = join(root, "configured");
    const configuredRoot = AbsolutePath.make(join(configuredData, "global"));
    const configuredOverlay = "name: configured\nruntime: 4\n";
    const configuredDist = renderGlobalDist({ configured: { image: "configured:test" } });
    await mkdir(configuredRoot, { recursive: true });
    await writeFile(join(configuredRoot, ".lando.yml"), configuredOverlay);
    await writeFile(join(configuredRoot, ".lando.dist.yml"), configuredDist);
    const typescript = "export default { runtime: 4 };\n";
    if (form === "typescript") {
      await mkdir(actualRoot, { recursive: true });
      await writeFile(join(actualRoot, ".lando.ts"), typescript);
    }
    const configured = await globalTeardownHarness(configuredData, { plan: globalPlanAt(actualRoot) });
    const hookPaths: string[] = [];
    const services = { hooked: { image: "hooked:test", mounts: ["./hook-state:/state"] } };

    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const fileSystem = yield* FileSystem;
        const configuredApp = makeGlobalAppServiceForRoot(Effect.succeed(configuredRoot), fileSystem);
        yield* globalStop({ target: { root: actualRoot, providerId: ProviderId.make("lando") } }).pipe(
          Effect.provideService(GlobalAppService, configuredApp),
          Effect.provideService(EventService, {
            ...events,
            publish: (event) =>
              Effect.gen(function* () {
                if (event._tag === "pre-global-stop") {
                  const app = yield* GlobalAppService;
                  yield* Effect.scoped(app.ensureRoot).pipe(Effect.orDie);
                  const overlay = yield* app.ensureUserLandofile.pipe(Effect.orDie);
                  const dist = yield* app.regenerateDist({ services }).pipe(Effect.orDie);
                  hookPaths.push(overlay.path, dist.path);
                }
                yield* events.publish(event);
              }),
          }),
        );
      }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(configured.layer)),
    );

    expect(hookPaths).toEqual([
      join(actualRoot, form === "typescript" ? ".lando.ts" : ".lando.yml"),
      join(actualRoot, ".lando.dist.yml"),
    ]);
    expect(await readFile(join(actualRoot, ".lando.dist.yml"), "utf8")).toBe(renderGlobalDist(services));
    expect(await readdir(actualRoot)).toContain("hook-state");
    if (form === "typescript") {
      expect(await readFile(join(actualRoot, ".lando.ts"), "utf8")).toBe(typescript);
      expect(await Bun.file(join(actualRoot, ".lando.yml")).exists()).toBe(false);
    } else {
      expect(await Bun.file(join(actualRoot, ".lando.yml")).exists()).toBe(true);
    }
    expect(await readFile(join(configuredRoot, ".lando.yml"), "utf8")).toBe(configuredOverlay);
    expect(await readFile(join(configuredRoot, ".lando.dist.yml"), "utf8")).toBe(configuredDist);
    expect(await readdir(configuredRoot)).toEqual([".lando.dist.yml", ".lando.yml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
