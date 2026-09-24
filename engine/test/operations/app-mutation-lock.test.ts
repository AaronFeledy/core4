import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AppLockTimeoutError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { EventService, PathsService } from "@lando/sdk/services";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";

import {
  APP_LOCK_HOLDERS_ENV,
  APP_LOCK_TIMEOUT_ENV,
  APP_LOCK_WAIT_MESSAGE,
  appMutationLockIdentity,
  appMutationLockKey,
  canonicalAppRoot,
  canonicalAppRootSync,
  isSelfOrAncestorPid,
  resolveAppLockTimeoutMs,
  withAppMutationLock,
} from "../../src/operations/app-mutation-lock.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const previousTimeout = process.env[APP_LOCK_TIMEOUT_ENV];
const previousHolders = process.env[APP_LOCK_HOLDERS_ENV];

afterEach(() => {
  if (previousTimeout === undefined) delete process.env[APP_LOCK_TIMEOUT_ENV];
  else process.env[APP_LOCK_TIMEOUT_ENV] = previousTimeout;
  if (previousHolders === undefined) delete process.env[APP_LOCK_HOLDERS_ENV];
  else process.env[APP_LOCK_HOLDERS_ENV] = previousHolders;
});

const isolate = async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-app-lock-"));
  const appRoot = await mkdtemp(join(tmpdir(), "lando-app-root-"));
  const events: LandoEvent[] = [];
  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
    Layer.succeed(EventService, {
      publish: (event) =>
        Schema.is(LandoEventSchema)(event)
          ? Effect.sync(() => {
              events.push(event);
            })
          : Effect.die(new TypeError(`Unexpected event in app mutation lock test: ${String(event)}`)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );
  return { userDataRoot, appRoot, events, layer };
};

const lockPathFor = (userDataRoot: string, appId: string, appRoot: string): string => {
  const key = appMutationLockKey(appId, canonicalAppRootSync(appRoot));
  return join(userDataRoot, "operation-locks", `${key}.lock`);
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("per-app mutation lock", () => {
  test("reads LANDO_APP_LOCK_TIMEOUT_MS and rejects invalid values", () => {
    expect(resolveAppLockTimeoutMs({})).toBe(120_000);
    expect(resolveAppLockTimeoutMs({ [APP_LOCK_TIMEOUT_ENV]: "2500" })).toBe(2500);
    expect(resolveAppLockTimeoutMs({ [APP_LOCK_TIMEOUT_ENV]: "nope" })).toBe(120_000);
    expect(isSelfOrAncestorPid(process.pid)).toBe(true);
    expect(isSelfOrAncestorPid(process.ppid)).toBe(true);
    expect(isSelfOrAncestorPid(1)).toBe(process.ppid === 1);
  });

  test("mutating start holds the lock file for the canonical app key", async () => {
    const held = await Deferred.make<void>().pipe(Effect.runPromise);
    const release = await Deferred.make<void>().pipe(Effect.runPromise);
    const harness = makeHarness({
      applyEffect: Deferred.succeed(held, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
        Effect.as({ changed: true }),
      ),
    });
    const fiber = Effect.runFork(
      startAppForTarget(undefined, {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      }).pipe(Effect.provide(harness.layer)),
    );
    await Effect.runPromise(Deferred.await(held));
    const path = lockPathFor(harness.userDataRoot, String(plan.id), String(plan.root));
    expect(await exists(path)).toBe(true);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await exists(path)).toBe(false);
  });

  test("info, logs, and config lint stay off the mutate lock", async () => {
    const [info, logs, lint, start, stop, rebuild, restart, destroy] = await Promise.all([
      Bun.file(new URL("../../src/operations/info.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/logs.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/app-config-lint.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/start.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/stop.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/rebuild.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/restart.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/destroy.ts", import.meta.url)).text(),
    ]);
    for (const source of [info, logs, lint]) {
      expect(source).not.toContain("withAppMutationLock");
    }
    for (const source of [start, stop, rebuild, restart, destroy]) {
      expect(source).toContain("withAppMutationLock");
    }
  });

  test("pins the canonical root while a symlink is retargeted", async () => {
    const isolated = await isolate();
    const otherRoot = await mkdtemp(join(tmpdir(), "lando-app-root-other-"));
    const alias = join(isolated.userDataRoot, "app-alias");
    try {
      await symlink(isolated.appRoot, alias, "dir");
      const result = await Effect.runPromise(
        withAppMutationLock(
          { id: "pin-root", root: alias },
          Effect.gen(function* () {
            const before = yield* canonicalAppRoot(alias);
            yield* Effect.promise(async () => {
              await rm(alias);
              await symlink(otherRoot, alias, "dir");
            });
            return { before, after: yield* canonicalAppRoot(alias) };
          }),
        ).pipe(Effect.provide(isolated.layer)),
      );
      expect(result).toEqual({
        before: await realpath(isolated.appRoot),
        after: await realpath(isolated.appRoot),
      });
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("missing-root inventory lock shares the canonical key across a parent symlink", async () => {
    const isolated = await isolate();
    const alias = join(isolated.userDataRoot, "parent-alias");
    try {
      await symlink(isolated.appRoot, alias, "dir");
      const direct = await Effect.runPromise(
        appMutationLockIdentity({ id: "stale", root: join(isolated.appRoot, "missing") }, true),
      );
      const throughAlias = await Effect.runPromise(
        appMutationLockIdentity({ id: "stale", root: join(alias, "missing") }, true),
      );
      expect(throughAlias.key).toBe(direct.key);
      expect(throughAlias.canonicalRoot).toBe(direct.canonicalRoot);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("lock keys accept missing roots but reject dangling symlinks", async () => {
    const isolated = await isolate();
    const missingRoot = join(isolated.appRoot, "missing");
    const danglingRoot = join(isolated.userDataRoot, "dangling-root");
    try {
      const strict = await Effect.runPromiseExit(canonicalAppRoot(missingRoot));
      expect(Exit.isFailure(strict)).toBe(true);

      const identity = await Effect.runPromise(appMutationLockIdentity({ id: "missing", root: missingRoot }));
      expect(identity.canonicalRoot).toBe(join(await realpath(isolated.appRoot), "missing"));
      const entered = await Effect.runPromise(
        withAppMutationLock({ id: "missing", root: missingRoot }, Effect.succeed(true)).pipe(
          Effect.provide(isolated.layer),
        ),
      );
      expect(entered).toBe(true);

      await symlink(join(isolated.appRoot, "absent-target"), danglingRoot, "dir");
      const dangling = await Effect.runPromiseExit(
        withAppMutationLock({ id: "dangling", root: danglingRoot }, Effect.succeed(true)).pipe(
          Effect.provide(isolated.layer),
        ),
      );
      expect(Exit.isFailure(dangling)).toBe(true);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("missing-root inventory lock rejects a retargeted parent before entering", async () => {
    const isolated = await isolate();
    const otherRoot = await mkdtemp(join(tmpdir(), "lando-app-root-other-"));
    const alias = join(isolated.userDataRoot, "parent-alias");
    const app = { id: "stale", root: join(alias, "missing") };
    const held = await Deferred.make<void>().pipe(Effect.runPromise);
    const release = await Deferred.make<void>().pipe(Effect.runPromise);
    try {
      await symlink(isolated.appRoot, alias, "dir");
      const first = Effect.runFork(
        withAppMutationLock(
          app,
          Deferred.succeed(held, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          { allowMissingRoot: true },
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(held));
      const second = Effect.runFork(
        withAppMutationLock(app, Effect.succeed("entered"), { allowMissingRoot: true }).pipe(
          Effect.provide(isolated.layer),
        ),
      );
      for (let attempts = 0; attempts < 100 && isolated.events.length === 0; attempts++) {
        await Bun.sleep(10);
      }
      expect(isolated.events.length).toBeGreaterThan(0);
      await rm(alias);
      await symlink(otherRoot, alias, "dir");
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.await(first));
      const result = await Effect.runPromise(Fiber.await(second));
      expect(Exit.isFailure(result)).toBe(true);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("nested same-app acquire is a no-op and does not hang", async () => {
    const isolated = await isolate();
    try {
      const app = { id: "nested", root: isolated.appRoot };
      const result = await Effect.runPromise(
        withAppMutationLock(app, withAppMutationLock(app, Effect.succeed("inner"))).pipe(
          Effect.provide(isolated.layer),
        ),
      );
      expect(result).toBe("inner");
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("parent-held lock lets a child mutate on the same app without hanging", async () => {
    const isolated = await isolate();
    try {
      const app = { id: "child-reentry", root: isolated.appRoot };
      const started = await Effect.runPromise(
        withAppMutationLock(
          app,
          Effect.promise(async () => {
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
              import { Effect, Layer } from ${JSON.stringify(import.meta.resolve("effect"))};
              import { PathsService } from ${JSON.stringify(import.meta.resolve("@lando/sdk/services"))};
              import { makeLandoPaths } from ${JSON.stringify(import.meta.resolve("@lando/paths"))};
              import { PrivateFileAccessLive } from ${JSON.stringify(import.meta.resolve("@lando/state-store/private-file-access"))};
              import { withAppMutationLock } from ${JSON.stringify(import.meta.resolve("../../src/operations/app-mutation-lock.ts"))};
              const userDataRoot = ${JSON.stringify(isolated.userDataRoot)};
              const app = { id: "child-reentry", root: ${JSON.stringify(isolated.appRoot)} };
              const started = Date.now();
              await Effect.runPromise(
                withAppMutationLock(app, Effect.succeed("ok")).pipe(
                  Effect.provide(Layer.mergeAll(
                    PrivateFileAccessLive,
                    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
                  )),
                ),
              );
              if (Date.now() - started > 2000) throw new Error("child hung on inherited app lock");
              process.stdout.write("ok");
            `,
              ],
              { stdout: "pipe", stderr: "pipe" },
            );
            const [exitCode, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            return { exitCode, stdout, stderr };
          }),
        ).pipe(Effect.provide(isolated.layer)),
      );
      expect(started).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("fiber interrupt releases the app lock", async () => {
    const isolated = await isolate();
    try {
      const app = { id: "interrupt", root: isolated.appRoot };
      const acquired = await Deferred.make<void>().pipe(Effect.runPromise);
      const fiber = Effect.runFork(
        withAppMutationLock(
          app,
          Deferred.succeed(acquired, undefined).pipe(Effect.zipRight(Effect.never)),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const path = lockPathFor(isolated.userDataRoot, app.id, app.root);
      expect(await exists(path)).toBe(true);
      const exit = await Effect.runPromise(Fiber.interrupt(fiber));
      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(await exists(path)).toBe(false);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("a second mutate waits then fails after LANDO_APP_LOCK_TIMEOUT_MS", async () => {
    process.env[APP_LOCK_TIMEOUT_ENV] = "400";
    const isolated = await isolate();
    try {
      const app = { id: "timeout", root: isolated.appRoot };
      const acquired = await Deferred.make<void>().pipe(Effect.runPromise);
      const release = await Deferred.make<void>().pipe(Effect.runPromise);
      const holder = Effect.runFork(
        withAppMutationLock(
          app,
          Deferred.succeed(acquired, undefined).pipe(Effect.zipRight(Deferred.await(release))),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const started = Date.now();
      const result = await Effect.runPromise(
        Effect.either(
          withAppMutationLock(app, Effect.succeed("should-not-run")).pipe(Effect.provide(isolated.layer)),
        ),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(AppLockTimeoutError);
        expect(result.left.message).toBe(APP_LOCK_WAIT_MESSAGE);
      }
      expect(
        isolated.events.some(
          (event) => event._tag === "message.warn" && event.body === APP_LOCK_WAIT_MESSAGE,
        ),
      ).toBe(true);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.await(holder));
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("a second mutate succeeds after the first releases", async () => {
    const isolated = await isolate();
    try {
      const app = { id: "handoff", root: isolated.appRoot };
      let inCritical = 0;
      let maxInCritical = 0;
      const acquired = await Deferred.make<void>().pipe(Effect.runPromise);
      const release = await Deferred.make<void>().pipe(Effect.runPromise);
      const enter = Effect.sync(() => {
        inCritical += 1;
        maxInCritical = Math.max(maxInCritical, inCritical);
      });
      const leave = Effect.sync(() => {
        inCritical -= 1;
      });
      const holder = Effect.runFork(
        withAppMutationLock(
          app,
          enter.pipe(
            Effect.zipRight(Deferred.succeed(acquired, undefined)),
            Effect.zipRight(Deferred.await(release)),
            Effect.zipRight(leave),
          ),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const waiter = Effect.runFork(
        withAppMutationLock(app, enter.pipe(Effect.as("second"), Effect.zipLeft(leave))).pipe(
          Effect.provide(isolated.layer),
        ),
      );
      await Effect.sleep("50 millis").pipe(Effect.runPromise);
      expect(inCritical).toBe(1);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      const [holderExit, waited] = await Promise.all([
        Effect.runPromise(Fiber.await(holder)),
        Effect.runPromise(Fiber.await(waiter)),
      ]);
      expect(Exit.isSuccess(holderExit)).toBe(true);
      expect(Exit.isSuccess(waited) && waited.value).toBe("second");
      expect(maxInCritical).toBe(1);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });
});
