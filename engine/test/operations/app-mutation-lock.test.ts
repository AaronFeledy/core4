import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AppLockTimeoutError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { EventService, PathsService } from "@lando/sdk/services";
import { ADVISORY_LOCK_SUFFIX, resolveOperationLockTimeoutMs } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";

import {
  APP_LOCK_HOLDERS_ENV,
  appMutationLockIdentity,
  appMutationLockKey,
  canonicalAppRoot,
  canonicalAppRootSync,
  isSelfOrAncestorPid,
  withAppMutationLock,
} from "../../src/operations/app-mutation-lock.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const APP_LOCK_TIMEOUT_ENV = "LANDO_LOCK_TIMEOUT_MS";
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
  const waitAnnounced = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Schema.is(LandoEventSchema)(event)
            ? Effect.gen(function* () {
                events.push(event);
                if (event._tag === "lock.wait")
                  yield* Deferred.succeed(waitAnnounced, undefined).pipe(Effect.ignore);
              })
            : Effect.die(new TypeError(`Unexpected event in app mutation lock test: ${String(event)}`)),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return { userDataRoot, appRoot, events, layer, waitAnnounced };
};

const lockPathFor = (userDataRoot: string, appId: string, appRoot: string): string => {
  const key = appMutationLockKey(appId, canonicalAppRootSync(appRoot));
  return join(userDataRoot, "operation-locks", `${key}${ADVISORY_LOCK_SUFFIX}`);
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const waitWarnings = (events: ReadonlyArray<LandoEvent>) =>
  events.filter((event) => event._tag === "lock.wait");

describe("per-app mutation lock", () => {
  test("acquires over a stale diagnostic record with an inherited token without a wait event", async () => {
    // Given a leftover sentinel with a dead command's diagnostic bytes and no kernel hold.
    const isolated = await isolate();
    const app = { id: "dead-holder", root: isolated.appRoot };
    const path = lockPathFor(isolated.userDataRoot, app.id, await realpath(app.root));
    await mkdir(join(isolated.userDataRoot, "operation-locks"), { recursive: true });
    await writeFile(path, JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }), {
      mode: 0o600,
    });
    process.env[APP_LOCK_HOLDERS_ENV] = `${appMutationLockKey(app.id, await realpath(app.root))}:dead`;
    try {
      // When the next mutation acquires that lock.
      const result = await Effect.runPromise(
        withAppMutationLock(
          app,
          Effect.promise(() => Bun.file(path).json()),
        ).pipe(Effect.provide(isolated.layer)),
      );
      // Then it proceeds without reporting live contention.
      expect(result.pid).toBe(process.pid);
      expect(result.token).not.toBe("dead");
      expect(waitWarnings(isolated.events)).toHaveLength(0);
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });
  test("reads LANDO_LOCK_TIMEOUT_MS and rejects invalid values", () => {
    expect(resolveOperationLockTimeoutMs({})).toBe(120_000);
    expect(resolveOperationLockTimeoutMs({ [APP_LOCK_TIMEOUT_ENV]: "2500" })).toBe(2500);
    expect(resolveOperationLockTimeoutMs({ [APP_LOCK_TIMEOUT_ENV]: "nope" })).toBe(120_000);
    expect(isSelfOrAncestorPid(process.pid)).toBe(true);
    expect(isSelfOrAncestorPid(process.ppid)).toBe(true);
    expect(isSelfOrAncestorPid(1)).toBe(process.ppid === 1);
  });

  test("mutating start holds the lock record for the canonical app key", async () => {
    const held = await Deferred.make<void>().pipe(Effect.runPromise);
    const release = await Deferred.make<void>().pipe(Effect.runPromise);
    const harness = makeHarness({
      applyEffect: Deferred.succeed(held, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
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
    const during = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string };
    expect(during.pid).toBe(process.pid);
    expect(during.token.length).toBeGreaterThan(0);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await exists(path)).toBe(process.platform === "win32");
    if (process.platform === "win32") expect(await readFile(path, "utf8")).toBe("");
  });

  test("info, logs, and config lint stay off the mutate lock", async () => {
    const [info, logs, lint, activation, stop, destroy] = await Promise.all([
      Bun.file(new URL("../../src/operations/info.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/logs.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/app-config-lint.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/app-activation.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/stop.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/operations/destroy.ts", import.meta.url)).text(),
    ]);
    for (const source of [info, logs, lint]) {
      expect(source).not.toContain("withAppMutationLock");
    }
    for (const source of [activation, stop, destroy]) {
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
        appMutationLockIdentity({ id: "stale", root: join(isolated.appRoot, "missing") }),
      );
      const throughAlias = await Effect.runPromise(
        appMutationLockIdentity({ id: "stale", root: join(alias, "missing") }),
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
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(held));
      const second = Effect.runFork(
        withAppMutationLock(app, Effect.succeed("entered")).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(isolated.waitAnnounced).pipe(Effect.timeout("2 seconds")));
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

  test.each(["inherited", "removed", "zero budget"] as const)(
    "child refuses borrowed ownership immediately (%s)",
    async (scenario) => {
      const isolated = await isolate();
      try {
        const app = { id: "child-reentry", root: isolated.appRoot };
        const observed = await Effect.runPromise(
          withAppMutationLock(
            app,
            Effect.promise(async () => {
              const path = lockPathFor(isolated.userDataRoot, app.id, isolated.appRoot);
              const before = await readFile(path, "utf8");
              const env = {
                ...process.env,
                [APP_LOCK_TIMEOUT_ENV]: scenario === "zero budget" ? "0" : "10000",
              };
              if (scenario === "removed") Reflect.deleteProperty(env, APP_LOCK_HOLDERS_ENV);
              const child = Bun.spawn(
                [
                  process.execPath,
                  "--eval",
                  `
          import { Effect, Layer } from ${JSON.stringify(import.meta.resolve("effect"))};
          import { PathsService } from ${JSON.stringify(import.meta.resolve("@lando/sdk/services"))};
          import { makeLandoPaths } from ${JSON.stringify(import.meta.resolve("@lando/paths"))};
          import { PrivateFileAccessService } from ${JSON.stringify(import.meta.resolve("@lando/state-store/private-file-access"))};
          import { withAppMutationLock } from ${JSON.stringify(import.meta.resolve("../../src/operations/app-mutation-lock.ts"))};
          const layer = Layer.mergeAll(PrivateFileAccessService.layer,Layer.succeed(PathsService,makeLandoPaths({userDataRoot:${JSON.stringify(isolated.userDataRoot)}})));
          let entered = false;
          const started=Date.now();
          const result=await Effect.runPromise(withAppMutationLock(${JSON.stringify(app)},Effect.sync(()=>{entered=true})).pipe(Effect.result,Effect.provide(layer)));
          const independent=await Effect.runPromise(withAppMutationLock({kind:"scratch",id:"independent",root:${JSON.stringify(app.root)}},Effect.succeed("own lease")).pipe(Effect.provide(layer)));
          console.log(JSON.stringify({result,entered,elapsed:Date.now()-started,independent}));
        `,
                ],
                { env, stdout: "pipe", stderr: "pipe" },
              );
              const deadline = setTimeout(() => child.kill(), 5000);
              try {
                const [code, stdout, stderr] = await Promise.all([
                  child.exited,
                  new Response(child.stdout).text(),
                  new Response(child.stderr).text(),
                ]);
                return {
                  code,
                  stderr,
                  receipt: JSON.parse(stdout),
                  sameOwner: before === (await readFile(path, "utf8")),
                };
              } finally {
                clearTimeout(deadline);
              }
            }),
          ).pipe(Effect.provide(isolated.layer)),
        );
        expect(observed.code).toBe(0);
        expect(observed.stderr).toBe("");
        expect(observed.sameOwner).toBe(true);
        expect(observed.receipt).toMatchObject({
          entered: false,
          independent: "own lease",
          result: {
            _tag: "Failure",
            failure: {
              _tag: "StateStoreError",
              reason: "lock",
              operation: "nestedAppMutation",
              lockFailure: "refused",
            },
          },
        });
        expect(observed.receipt.elapsed).toBeLessThan(2000);
      } finally {
        await rm(isolated.userDataRoot, { recursive: true, force: true });
        await rm(isolated.appRoot, { recursive: true, force: true });
      }
    },
  );

  test("fiber interrupt releases the app lock", async () => {
    const isolated = await isolate();
    try {
      const app = { id: "interrupt", root: isolated.appRoot };
      const acquired = await Deferred.make<void>().pipe(Effect.runPromise);
      const fiber = Effect.runFork(
        withAppMutationLock(
          app,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const path = lockPathFor(isolated.userDataRoot, app.id, app.root);
      expect(await exists(path)).toBe(true);
      const during = JSON.parse(await readFile(path, "utf8")) as { pid: number };
      expect(during.pid).toBe(process.pid);
      const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
      expect(Exit.hasInterrupts(exit)).toBe(true);
      // Sentinel may remain; the next acquire must succeed immediately.
      expect(
        await Effect.runPromise(
          withAppMutationLock(app, Effect.succeed("reacquired")).pipe(
            Effect.provide(isolated.layer),
            Effect.timeout("1 second"),
          ),
        ),
      ).toBe("reacquired");
    } finally {
      await rm(isolated.userDataRoot, { recursive: true, force: true });
      await rm(isolated.appRoot, { recursive: true, force: true });
    }
  });

  test("a second mutate waits then fails after LANDO_LOCK_TIMEOUT_MS", async () => {
    process.env[APP_LOCK_TIMEOUT_ENV] = "400";
    const isolated = await isolate();
    try {
      const app = { id: "timeout", root: isolated.appRoot };
      const acquired = await Deferred.make<void>().pipe(Effect.runPromise);
      const release = await Deferred.make<void>().pipe(Effect.runPromise);
      const holder = Effect.runFork(
        withAppMutationLock(
          app,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const started = Date.now();
      const result = await Effect.runPromise(
        Effect.result(
          withAppMutationLock(app, Effect.succeed("should-not-run")).pipe(Effect.provide(isolated.layer)),
        ),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AppLockTimeoutError);
        expect(result.failure).toMatchObject({ app: "timeout", timeoutMs: 400 });
      }
      expect(waitWarnings(isolated.events)).toHaveLength(0);
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
            Effect.andThen(Deferred.succeed(acquired, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(leave),
          ),
        ).pipe(Effect.provide(isolated.layer)),
      );
      await Effect.runPromise(Deferred.await(acquired));
      const waiter = Effect.runFork(
        withAppMutationLock(app, enter.pipe(Effect.as("second"), Effect.tap(leave))).pipe(
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
