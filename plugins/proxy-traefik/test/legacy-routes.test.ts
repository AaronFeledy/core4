import { expect, test } from "bun:test";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { Deferred, Effect, Fiber } from "effect";

import { certificateDir, dynamicConfigDir, joinFor } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { routeReloadLockKey } from "../src/route-reload-state.ts";
import { legacyContent, legacyHttpContent, legacyName } from "./legacy-route-fixture.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

const fixture = (platform: "linux" | "win32", reload: Effect.Effect<void> = Effect.void) => {
  const harness = makeHarness();
  const paths = { ...harness.dependencies.paths, platform };
  const join = joinFor(paths);
  const directory = dynamicConfigDir(paths);
  const certs = certificateDir(paths);
  let locked = false;
  let failReload = false;
  let failedRemoval: string | undefined;
  let reloads = 0;
  const stateStore: PluginStateStore = {
    open: () => Effect.die("migration does not use buckets"),
    withLock: (key, body) =>
      Effect.gen(function* () {
        expect(key).toBe(routeReloadLockKey());
        expect(locked).toBe(false);
        locked = true;
        return yield* body.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              locked = false;
            }),
          ),
        );
      }),
  };
  const makeService = () =>
    makeTraefikRouterService({
      ...harness.dependencies,
      paths,
      stateStore,
      fileSystem: {
        ...harness.dependencies.fileSystem,
        exists: (path) => Effect.sync(() => path === directory || path === certs || harness.files.has(path)),
        readDir: (path) =>
          Effect.sync(() =>
            [...harness.files.keys()]
              .filter((name) => name.startsWith(join(path, "")))
              .map((name) => name.slice(join(path, "").length + 1))
              .filter((name) => !name.includes("/") && !name.includes("\\")),
          ),
        remove: (path) =>
          Effect.suspend(() => {
            if (platform === "win32") expect(locked).toBe(true);
            if (path === failedRemoval) return Effect.fail(new Error("removal failed"));
            harness.operations.push(`remove:${path}`);
            harness.files.delete(path);
            return Effect.void;
          }),
      },
      globalApp: {
        ...harness.dependencies.globalApp,
        ensureRunning: (services) =>
          Effect.suspend(() => {
            expect(harness.files.has(join(directory, legacyName))).toBe(false);
            return harness.dependencies.globalApp.ensureRunning(services);
          }),
        restartRunningService: () =>
          Effect.suspend(() => {
            expect(locked).toBe(true);
            expect(harness.files.has(join(directory, legacyName))).toBe(false);
            expect(harness.files.has(join(directory, "routes-plain.yml"))).toBe(false);
            reloads++;
            return reload.pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  failReload ? Effect.fail(new Error("reload failed")) : Effect.succeed(true),
                ),
              ),
            );
          }),
      },
    });
  harness.files.set(join(directory, legacyName), legacyContent);
  harness.files.set(join(directory, "routes-plain.yml"), legacyHttpContent);
  const kept = new Map([
    [join(directory, "routes-custom.yml"), "http:\n  routers: {}\n"],
    [join(directory, `routes-${"ab".repeat(32)}.yml`), legacyContent],
    [
      join(directory, "routes-metadata.yml"),
      `# lando-route-file: {"version":1,"app":"metadata"}\n${legacyContent}`,
    ],
    [join(certs, "plain.crt"), "untied cert"],
    [join(certs, "plain.key"), "untied key"],
    [join(certs, "custom.crt"), "custom cert"],
  ]);
  for (const [path, content] of kept) harness.files.set(path, content);
  harness.files.set(join(certs, "old%2Fapp.crt"), "legacy cert");
  harness.files.set(join(certs, "old%2Fapp.key"), "legacy key");
  return {
    ...harness,
    paths,
    directory,
    certs,
    join,
    kept,
    makeService,
    reloads: () => reloads,
    failReload: (fail: boolean) => {
      failReload = fail;
    },
    failRemoval: (path: string | undefined) => {
      failedRemoval = path;
    },
  };
};

test.each(["prepare", "setup"] as const)(
  "%s migrates generated legacy routes while preserving referenced certificate bytes, idempotently",
  async (method) => {
    const harness = fixture("linux");
    const run = () => {
      const operation = harness.makeService()[method];
      if (operation === undefined) throw new Error("missing router operation");
      return Effect.runPromise(Effect.scoped(operation({ defaultDomain: "lndo.site" })));
    };

    await run();
    await run();

    for (const name of [legacyName, "routes-plain.yml"])
      expect(harness.files.has(harness.join(harness.directory, name))).toBe(false);
    expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.crt"))).toBe("legacy cert");
    expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
    for (const [path, content] of harness.kept) expect(harness.files.get(path)).toBe(content);
    expect(harness.operations.filter((operation) => operation.startsWith("remove:"))).toHaveLength(2);
    expect(harness.reloads()).toBe(0);
  },
);

test.each(["prepare", "setup"] as const)(
  "Windows %s batches removals under the route lock with one reload",
  async (method) => {
    const harness = fixture("win32");
    const operation = harness.makeService()[method];
    if (operation === undefined) throw new Error("missing router operation");

    await Effect.runPromise(Effect.scoped(operation({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(Effect.scoped(operation({ defaultDomain: "lndo.site" })));

    expect(harness.reloads()).toBe(1);
    expect(harness.files.has(harness.join(harness.directory, legacyName))).toBe(false);
    for (const [path, content] of harness.kept) expect(harness.files.get(path)).toBe(content);
  },
);

test("failed Windows reload preserves detectable evidence and retries in a fresh service", async () => {
  const harness = fixture("win32");
  harness.failReload(true);

  const first = await Effect.runPromiseExit(
    Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })),
  );

  expect(first._tag).toBe("Failure");
  expect(harness.files.get(harness.join(harness.directory, legacyName))).toBe(legacyContent);
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
  harness.failReload(false);
  await Effect.runPromise(Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })));
  expect(harness.reloads()).toBe(2);
  expect(harness.files.has(harness.join(harness.directory, legacyName))).toBe(false);
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
});

test("interrupted Windows reload restores route evidence before releasing the lock", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const harness = fixture(
    "win32",
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
  );
  const fiber = Effect.runFork(Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })));
  await Effect.runPromise(Deferred.await(entered));

  await Effect.runPromise(Fiber.interrupt(fiber));

  expect(harness.files.get(harness.join(harness.directory, legacyName))).toBe(legacyContent);
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await Effect.runPromise(Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })));
  expect(harness.reloads()).toBe(2);
  expect(harness.files.has(harness.join(harness.directory, legacyName))).toBe(false);
});

test("partial route removal restores route evidence while preserving certificates for a retry", async () => {
  const harness = fixture("linux");
  harness.failRemoval(harness.join(harness.directory, "routes-plain.yml"));

  const first = await Effect.runPromiseExit(
    Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })),
  );

  expect(first._tag).toBe("Failure");
  expect(harness.files.get(harness.join(harness.directory, legacyName))).toBe(legacyContent);
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.crt"))).toBe("legacy cert");
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
  harness.failRemoval(undefined);
  await Effect.runPromise(Effect.scoped(harness.makeService().setup({ defaultDomain: "lndo.site" })));
  expect(harness.files.has(harness.join(harness.directory, legacyName))).toBe(false);
  expect(harness.files.get(harness.join(harness.certs, "old%2Fapp.key"))).toBe("legacy key");
});
