import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, StateStore } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { makeStateStore } from "@lando/state-store/service";

import { withGlobalMutation } from "../../src/global-app/mutation.ts";
import {
  appMutationLockKey,
  canonicalAppRoot,
  withAppMutationLock,
} from "../../src/operations/app-mutation-lock.ts";

const fixture = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-global-mutation-")));
  const root = join(directory, "embedded-global");
  await mkdir(root);
  const paths = makeLandoPaths({
    userDataRoot: join(directory, "data"),
    userConfRoot: join(directory, "conf"),
  });
  const service = (appRoot: string) =>
    GlobalAppService.of({
      id: "global",
      root: Effect.succeed(AbsolutePath.make(appRoot)),
      paths: Effect.succeed({
        root: AbsolutePath.make(appRoot),
        distLandofile: AbsolutePath.make(join(appRoot, ".lando.dist.yml")),
        userLandofile: AbsolutePath.make(join(appRoot, ".lando.yml")),
      }),
      providerId: Effect.succeed(ProviderId.make("docker")),
      ensureRoot: Effect.void,
      ensureUserLandofile: Effect.die("No global materialization in lock tests."),
      ensureRunning: () => Effect.die("No provider startup in lock tests."),
      regenerateDist: () => Effect.die("No generation in lock tests."),
    });
  const base = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(GlobalAppService, service(root)),
  );
  const layer = Layer.effect(
    StateStore,
    Effect.map(PrivateFileAccessService, (access) =>
      makeStateStore({ privateFileAccess: access, roots: paths.roots }),
    ),
  ).pipe(Layer.provideMerge(base));
  const lockPath = (appRoot: string) =>
    join(
      dirname(appRoot),
      `.lando-global-${appMutationLockKey("global", appRoot)}`,
      `${appMutationLockKey("global", appRoot)}.lock`,
    );
  return { directory, root, paths, service, layer, lockPath };
};

test("global mutations lock the actual embedded root and nested calls reuse that lock", async () => {
  const isolated = await fixture();
  try {
    const tokens = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => Bun.file(isolated.lockPath(isolated.root)).json());
          const nested = yield* withGlobalMutation(
            Effect.promise(() => Bun.file(isolated.lockPath(isolated.root)).json()),
          );
          return { first, nested };
        }),
      ).pipe(Effect.provide(isolated.layer)),
    );
    expect(tokens.first.pid).toBe(process.pid);
    expect(tokens.nested.token).toBe(tokens.first.token);
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(false);
    expect(await Bun.file(isolated.lockPath(isolated.paths.globalAppRoot)).exists()).toBe(false);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("nested embedded globals with different roots refuse before acquiring another lock", async () => {
  const isolated = await fixture();
  const secondRoot = join(isolated.directory, "second-global");
  await mkdir(secondRoot);
  try {
    const result = await Effect.runPromise(
      withGlobalMutation(
        withGlobalMutation(Effect.succeed("must not enter")).pipe(
          Effect.provideService(GlobalAppService, isolated.service(secondRoot)),
          Effect.result,
        ),
      ).pipe(Effect.provide(isolated.layer)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "GlobalAppError",
        cause: { _tag: "StateStoreError", operation: "nestedGlobalPolicyMutation" },
      },
    });
    expect(await Bun.file(isolated.lockPath(secondRoot)).exists()).toBe(false);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("cancellation releases the global lock before a later command acquires it", async () => {
  const isolated = await fixture();
  const acquired = Deferred.makeUnsafe<void>();
  try {
    const fiber = Effect.runFork(
      withGlobalMutation(Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never))).pipe(
        Effect.provide(isolated.layer),
      ),
    );
    await Effect.runPromise(Deferred.await(acquired));
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(false);
    expect(
      await Effect.runPromise(
        withGlobalMutation(Effect.succeed("entered")).pipe(Effect.provide(isolated.layer)),
      ),
    ).toBe("entered");
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("body failures retain their identity instead of becoming coordination failures", async () => {
  const isolated = await fixture();
  const failure = new StateStoreError({
    reason: "io",
    operation: "read-policy",
    path: "/policy",
    remediation: "Repair policy permissions.",
  });
  try {
    const result = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.fail(failure))).pipe(Effect.provide(isolated.layer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe(failure);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("coordination failures retain lock remediation rather than blaming policy booleans", async () => {
  const isolated = await fixture();
  try {
    const result = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.void)).pipe(
        Effect.provideService(PrivateFileAccessService, {
          enforce: async () => {
            throw new Error("private lock access denied");
          },
          verify: async () => undefined,
        }),
        Effect.provide(isolated.layer),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(GlobalAppError);
      expect(result.failure.operation).toBe("coordination");
      expect(result.failure.remediation).not.toContain("boolean");
    }
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("different global policy roots stay independent, and cross-policy nesting refuses without waiting", async () => {
  const isolated = await fixture();
  const otherPaths = makeLandoPaths({
    userDataRoot: join(isolated.directory, "other-data"),
    userConfRoot: join(isolated.directory, "other-conf"),
  });
  const otherRoot = join(isolated.directory, "other-global");
  await mkdir(otherRoot);
  const otherBase = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, otherPaths),
    Layer.succeed(GlobalAppService, isolated.service(otherRoot)),
  );
  const otherLayer = Layer.effect(
    StateStore,
    Effect.map(PrivateFileAccessService, (access) =>
      makeStateStore({ privateFileAccess: access, roots: otherPaths.roots }),
    ),
  ).pipe(Layer.provideMerge(otherBase));
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  try {
    const owner = Effect.runFork(
      withGlobalMutation(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.provide(isolated.layer)),
    );
    await Effect.runPromise(Deferred.await(entered));
    try {
      expect(
        await Effect.runPromise(
          withGlobalMutation(Effect.succeed("independent")).pipe(
            Effect.provide(otherLayer),
            Effect.timeout("2 seconds"),
          ),
        ),
      ).toBe("independent");
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.join(owner));
    }
    const nested = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          expect(yield* canonicalAppRoot(isolated.root)).toBe(isolated.root);
          return yield* withGlobalMutation(Effect.succeed("must not run")).pipe(
            Effect.provide(otherLayer),
            Effect.result,
          );
        }),
      ).pipe(Effect.provide(isolated.layer), Effect.timeout("2 seconds")),
    );
    expect(nested).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "GlobalAppError",
        cause: { _tag: "StateStoreError", operation: "nestedGlobalPolicyMutation" },
      },
    });
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("shared policy excludes a separate process using different data and global roots", async () => {
  const isolated = await fixture();
  const script = join(isolated.directory, "shared-policy-child.ts");
  const otherRoot = join(isolated.directory, "other-global");
  await mkdir(otherRoot);
  const repo = process.cwd();
  await Bun.write(
    script,
    `
 import {Effect,Layer} from "${repo}/node_modules/effect/dist/index.js";
 import {makeLandoPaths} from "${repo}/paths/src/paths.ts";
 import {GlobalAppService,PathsService,StateStore} from "${repo}/sdk/src/services/index.ts";
 import {AbsolutePath,ProviderId} from "${repo}/sdk/src/schema/index.ts";
 import {PrivateFileAccessService} from "${repo}/state-store/src/private-file-access.ts";
 import {makeStateStore} from "${repo}/state-store/src/service.ts";
 import {withGlobalMutation} from "${repo}/engine/src/global-app/mutation.ts";
 const root=AbsolutePath.make(${JSON.stringify(otherRoot)});
 const paths=makeLandoPaths({userDataRoot:${JSON.stringify(join(isolated.directory, "other-data"))},userConfRoot:${JSON.stringify(isolated.paths.roots.userConfRoot)}});
 const base=Layer.mergeAll(PrivateFileAccessService.layer,Layer.succeed(PathsService,paths),Layer.succeed(GlobalAppService,{id:"global",paths:Effect.succeed({root}),root:Effect.succeed(root),providerId:Effect.succeed(ProviderId.make("docker"))}));
 const layer=Layer.effect(StateStore,Effect.map(PrivateFileAccessService,access=>makeStateStore({privateFileAccess:access,roots:paths.roots}))).pipe(Layer.provideMerge(base));
 const result=await Effect.runPromise(withGlobalMutation(Effect.succeed("must not enter")).pipe(Effect.result,Effect.provide(layer)));
 console.log(JSON.stringify(result));
 `,
  );
  try {
    const result = await Effect.runPromise(
      withGlobalMutation(
        Effect.promise(async () => {
          const env = { ...process.env, LANDO_APP_LOCK_TIMEOUT_MS: "1000" };
          Reflect.deleteProperty(env, "LANDO_APP_LOCK_HOLDERS");
          const child = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
          const [code, out, err] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code).toBe(0);
          expect(err).toBe("");
          return JSON.parse(out);
        }),
      ).pipe(Effect.provide(isolated.layer), Effect.timeout("4 seconds")),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GlobalAppError", cause: { _tag: "StateStoreError", operation: "nestedAppMutation" } },
    });
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test.each(["shared-policy", "shared-runtime"] as const)(
  "%s excludes independent peer processes across data profiles and hands off after release",
  async (domain) => {
    const isolated = await fixture();
    const repo = process.cwd();
    const ready = join(isolated.directory, "owner-ready");
    const release = join(isolated.directory, "release-owner");
    const peerRoot = domain === "shared-runtime" ? isolated.root : join(isolated.directory, "peer-global");
    const peerConf =
      domain === "shared-policy" ? isolated.paths.roots.userConfRoot : join(isolated.directory, "peer-conf");
    await mkdir(peerRoot, { recursive: true });
    const script = join(isolated.directory, "peer.ts");
    await Bun.write(
      script,
      `
      import {Effect,Layer} from "${repo}/node_modules/effect/dist/index.js";
      import {makeLandoPaths} from "${repo}/paths/src/paths.ts";
      import {GlobalAppService,PathsService,StateStore} from "${repo}/sdk/src/services/index.ts";
      import {PrivateFileAccessService} from "${repo}/state-store/src/private-file-access.ts";
 import {makeStateStore} from "${repo}/state-store/src/service.ts";
      import {withGlobalMutation} from "${repo}/engine/src/global-app/mutation.ts";
      const owner=process.argv[2]==="owner";
      const root=owner?${JSON.stringify(isolated.root)}:${JSON.stringify(peerRoot)};
      const paths=makeLandoPaths({userDataRoot:owner?${JSON.stringify(isolated.paths.roots.userDataRoot)}:${JSON.stringify(join(isolated.directory, "peer-data"))},userConfRoot:owner?${JSON.stringify(isolated.paths.roots.userConfRoot)}:${JSON.stringify(peerConf)}});
      const base=Layer.mergeAll(PrivateFileAccessService.layer,Layer.succeed(PathsService,paths),Layer.succeed(GlobalAppService,{id:"global",paths:Effect.succeed({root})}));
 const layer=Layer.effect(StateStore,Effect.map(PrivateFileAccessService,access=>makeStateStore({privateFileAccess:access,roots:paths.roots}))).pipe(Layer.provideMerge(base));
      const result=await Effect.runPromise(withGlobalMutation(Effect.promise(async()=>{
        if(owner){await Bun.write(${JSON.stringify(ready)},"ready");while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(5)}
        return "owned";
      })).pipe(Effect.result,Effect.provide(layer)));
      console.log(JSON.stringify(result));
    `,
    );
    const spawn = (mode: string) =>
      Bun.spawn([process.execPath, script, mode], {
        env: { ...process.env, LANDO_APP_LOCK_TIMEOUT_MS: "180" },
        stdout: "pipe",
        stderr: "pipe",
      });
    const resultOf = async (child: ReturnType<typeof spawn>) => {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      return JSON.parse(out);
    };
    const owner = spawn("owner");
    const deadline = setTimeout(() => owner.kill(), 10000);
    try {
      for (let attempt = 0; attempt < 1000 && !(await Bun.file(ready).exists()); attempt++)
        await Bun.sleep(5);
      expect(await Bun.file(ready).exists()).toBe(true);
      const peer = await resultOf(spawn("peer"));
      expect(peer).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GlobalAppError", cause: { _tag: "AppLockTimeoutError" } },
      });
      await Bun.write(release, "release");
      expect(await resultOf(owner)).toMatchObject({ _tag: "Success", value: "owned" });
      expect(await resultOf(spawn("peer"))).toMatchObject({ _tag: "Success", value: "owned" });
    } finally {
      await Bun.write(release, "release");
      await owner.exited;
      clearTimeout(deadline);
      await rm(isolated.directory, { recursive: true, force: true });
    }
  },
);

test("direct actual-global lease cannot upgrade to the policy coordinator", async () => {
  const isolated = await fixture();
  try {
    const result = await Effect.runPromise(
      withAppMutationLock(
        { id: "global", root: isolated.root },
        withGlobalMutation(Effect.succeed("must not enter")).pipe(Effect.result),
      ).pipe(Effect.provide(isolated.layer), Effect.timeout("2 seconds")),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "GlobalAppError",
        cause: { _tag: "StateStoreError", operation: "globalPolicyLockUpgrade" },
      },
    });
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("policy coordination follows the bound StateStore bucket instead of overridden PathsService", async () => {
  const isolated = await fixture();
  const otherPaths = makeLandoPaths({
    userDataRoot: join(isolated.directory, "other-data"),
    userConfRoot: join(isolated.directory, "unrelated-conf"),
  });
  try {
    const result = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          return yield* withGlobalMutation(Effect.succeed("same captured policy")).pipe(
            Effect.provideService(PathsService, otherPaths),
          );
        }),
      ).pipe(Effect.provide(isolated.layer)),
    );
    expect(result).toBe("same captured policy");
    expect(await Bun.file(join(otherPaths.roots.userConfRoot, "operation-locks")).exists()).toBe(false);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});
