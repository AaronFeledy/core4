import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Semaphore } from "effect";

import { FileNotFoundError } from "@lando/sdk/errors";
import type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import type { SchemeProbe } from "../src/port-acquisition.ts";
import { defaultDomainFile, routeFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { routeReloadLockKey } from "../src/route-reload-state.ts";

const app = AppId.make("race");
const paths = { platform: "win32", globalAppRoot: "/lando/global" } as const;
const config = { defaultDomain: "lndo.site" };
const route = [
  {
    hostname: "race.lndo.site",
    priority: 1,
    scheme: "http" as const,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8080 },
  },
];
const highPortOverride: { readonly http: SchemeProbe; readonly https: SchemeProbe } = {
  http: { bind: { kind: "other-error", code: "ECONNREFUSED" }, forward: { kind: "failure" } },
  https: { bind: { kind: "other-error", code: "ECONNREFUSED" }, forward: { kind: "failure" } },
};

const makeSharedStateStore = (onAttempt: (count: number) => Effect.Effect<void>): PluginStateStore => {
  const values = new Map<string, unknown>();
  const locks = new Map<string, Semaphore.Semaphore>();
  let attempts = 0;
  return {
    open: <A, I>(spec: PluginStateBucketSpec<A, I>) => {
      const key = [spec.namespace ?? "", spec.key].join("/");
      const current = (): A | null => (values.has(key) ? (values.get(key) as A) : null);
      const bucket: StateBucket<A> = {
        path: AbsolutePath.make(`/tmp/router-start-lock/${key}`),
        get: Effect.sync(current),
        set: (value) => Effect.sync(() => void values.set(key, value)),
        update: (f) =>
          Effect.sync(() => {
            const next = f(current());
            values.set(key, next);
            return next;
          }),
        modify: (f) =>
          Effect.sync(() => {
            const [result, next] = f(current());
            values.set(key, next);
            return result;
          }),
        remove: Effect.sync(() => void values.delete(key)),
        exists: Effect.sync(() => values.has(key)),
      };
      return Effect.succeed(bucket);
    },
    withLock: (key, body, options) =>
      Effect.gen(function* () {
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        if (key === routeReloadLockKey()) {
          expect(options?.timeoutMs).toBe(120_000);
          attempts++;
          yield* onAttempt(attempts);
        }
        return yield* lock.withPermits(1)(body);
      }),
  };
};

const makeHarness = () => {
  const files = new Map<string, string>();
  const setupEntered = Deferred.makeUnsafe<void>();
  const releaseSetup = Deferred.makeUnsafe<void>();
  const reloadEntered = Deferred.makeUnsafe<void>();
  const releaseReload = Deferred.makeUnsafe<void>();
  const watchedAttempt = Deferred.makeUnsafe<void>();
  let watchNumber = 0;
  let pauseSetup = false;
  let pauseReload = false;
  let ensured = 0;
  let restarted = 0;
  const stateStore = makeSharedStateStore((count) =>
    count === watchNumber ? Deferred.succeed(watchedAttempt, undefined).pipe(Effect.asVoid) : Effect.void,
  );
  const fileSystem = {
    mkdir: () => Effect.void,
    writeAtomic: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => void files.set(path, String(content))),
    writeSecretAtomic: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => void files.set(path, String(content))),
    remove: (path: string) => Effect.sync(() => void files.delete(path)),
    exists: (path: string) =>
      Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
    readDir: (path: string) =>
      Effect.succeed(
        [...files.keys()]
          .filter((file) => file.startsWith(`${path}/`))
          .map((file) => file.slice(path.length + 1)),
      ),
    readText: (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path) ?? "")
        : path.startsWith("/tmp/test-certs/")
          ? Effect.succeed("test pem")
          : Effect.fail(new FileNotFoundError({ message: "removed", path })),
  };
  const globalApp = {
    ensureRunning: () =>
      Effect.gen(function* () {
        if (pauseSetup) {
          yield* Deferred.succeed(setupEntered, undefined);
          yield* Deferred.await(releaseSetup);
        }
        ensured++;
        return [
          {
            name: "traefik",
            state: "running",
            endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
          },
        ];
      }),
    restartRunningService: () =>
      Effect.gen(function* () {
        if (pauseReload) {
          yield* Deferred.succeed(reloadEntered, undefined);
          yield* Deferred.await(releaseReload);
        }
        restarted++;
        return true;
      }),
  };
  const socketProxy = {
    user: "test",
    hasHostSystemd: () => false,
    exists: () => Effect.succeed(false),
    readText: () => Effect.fail(new Error("missing")),
    processRunner: {
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      stream: () => {
        throw new Error("unused");
      },
      streamWithExit: () => {
        throw new Error("unused");
      },
    },
    privilege: { elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
    classifyOverride: highPortOverride,
  };
  const makeRouter = () =>
    makeTraefikRouterService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem,
      paths,
      globalApp,
      socketProxy,
      stateStore,
    });
  return {
    files,
    makeRouter,
    setupEntered,
    releaseSetup,
    reloadEntered,
    releaseReload,
    watchedAttempt,
    watchAttempt: (count: number) => {
      watchNumber = count;
    },
    pauseSetup: () => {
      pauseSetup = true;
    },
    pauseReload: () => {
      pauseReload = true;
    },
    ensured: () => ensured,
    restarted: () => restarted,
  };
};

describe("Windows Traefik shared startup and route lock", () => {
  test("route reload waits for setup's final startup observation", async () => {
    const harness = makeHarness();
    const setupRouter = harness.makeRouter();
    const routeRouter = harness.makeRouter();
    harness.pauseSetup();
    harness.watchAttempt(2);

    const setup = Effect.runFork(Effect.scoped(setupRouter.setup(config)));
    await Effect.runPromise(Deferred.await(harness.setupEntered));
    const apply = Effect.runFork(routeRouter.applyRoutes(route, app));
    await Effect.runPromise(Deferred.await(harness.watchedAttempt));
    expect(harness.ensured()).toBe(0);
    expect(harness.restarted()).toBe(0);
    expect(harness.files.has(routeFile(paths, app))).toBe(false);

    await Effect.runPromise(Deferred.succeed(harness.releaseSetup, undefined));
    await Effect.runPromise(Fiber.join(setup));
    await Effect.runPromise(Fiber.join(apply));
    expect(harness.ensured()).toBe(1);
    expect(harness.restarted()).toBe(1);
    expect(harness.files.has(routeFile(paths, app))).toBe(true);
  });

  test("setup config writes wait for a route reload to finish", async () => {
    const harness = makeHarness();
    const setupRouter = harness.makeRouter();
    const routeRouter = harness.makeRouter();
    await Effect.runPromise(Effect.scoped(setupRouter.setup(config)));
    harness.pauseReload();
    harness.watchAttempt(3);

    const apply = Effect.runFork(routeRouter.applyRoutes(route, app));
    await Effect.runPromise(Deferred.await(harness.reloadEntered));
    const setup = Effect.runFork(Effect.scoped(setupRouter.setup({ defaultDomain: "lndo.test" })));
    await Effect.runPromise(Deferred.await(harness.watchedAttempt));
    expect(harness.ensured()).toBe(1);
    expect(harness.files.get(defaultDomainFile(paths))).toBe("lndo.site\n");

    await Effect.runPromise(Deferred.succeed(harness.releaseReload, undefined));
    await Effect.runPromise(Fiber.join(apply));
    await Effect.runPromise(Fiber.join(setup));
    expect(harness.restarted()).toBe(1);
    expect(harness.ensured()).toBe(2);
    expect(harness.files.get(defaultDomainFile(paths))).toBe("lndo.test\n");
  });
});
