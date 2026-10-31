import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGlobalPolicy, globalPolicyBucket, readGlobalPolicy } from "@lando/engine/global-app/enablement";
import { withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  captureGlobalConsumerAdmission,
  withGlobalConsumerAdmission,
} from "@lando/engine/operations/global-consumer-admission";
import { globalDisable, globalEnable } from "@lando/engine/operations/global-policy";
import { rebuildApp } from "@lando/engine/operations/rebuild";
import { restartApp } from "@lando/engine/operations/restart";
import { startApp } from "@lando/engine/operations/start";
import { ScratchRegistry } from "@lando/engine/scratch-app/registry";
import { ScratchResourceScanner } from "@lando/engine/scratch-app/scanner";
import * as Scratch from "@lando/engine/scratch-app/service";
import { EventDispatchControl, layerRuntime as realEventLayer } from "@lando/engine/services/event-service";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { PreServiceStartEvent } from "@lando/sdk/events";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EnvironmentValueResolver,
  EventService,
  GlobalAppService,
  LandofileService,
  RouterService,
  RuntimeProviderRegistry,
  ScratchAppService,
  ShellRunner,
  StateStore,
} from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { APP_LOCK_HOLDERS_ENV } from "../../../engine/src/operations/app-mutation-lock.ts";
import { readGlobalConsumerReservations } from "../../../engine/src/operations/global-consumer-lease.ts";
import { applyScratchStartup } from "../../../engine/src/scratch-app/startup.ts";
import { literalTestLandofile } from "../../../engine/test/compiled-landofile.ts";
import { emptySnapshotsLayer } from "../../../engine/test/operations/data-mover-support.ts";
import { makeHarness } from "../_support/ensure-global-harness.ts";
import { layerTransactionGuard } from "../_support/landofile-layer.ts";

const setEnabled = (enabled: boolean) =>
  Effect.gen(function* () {
    const bucket = yield* globalPolicyBucket();
    yield* bucket.update((previous) => ({
      ...(previous ?? emptyGlobalPolicy()),
      revision: (previous?.revision ?? 0) + 1,
      plugins: {
        ...previous?.plugins,
        "@lando/fake-global-ensure": { contributions: { traefik: { defaultEnabled: true, enabled } } },
      },
    }));
  });

const withFixture = async (
  body: (fixture: Awaited<ReturnType<typeof fixtureAt>>) => Promise<void>,
  services: ReadonlyArray<string> = ["traefik"],
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-consumer-admission-")));
  const modules = await mkdtemp(join(process.cwd(), ".lando-consumer-module-"));
  const before = {
    data: process.env.LANDO_USER_DATA_ROOT,
    conf: process.env.LANDO_USER_CONF_ROOT,
    cache: process.env.LANDO_USER_CACHE_ROOT,
  };
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  process.env.LANDO_USER_CONF_ROOT = join(root, "conf");
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
  try {
    await mkdir(join(root, "conf"), { recursive: true });
    await writeFile(
      join(root, "conf", "config.yml"),
      "defaultProviderId: docker\nrouter:\n  enabled: false\n",
    );
    await body(await fixtureAt(root, modules, services));
  } finally {
    if (before.data === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = before.data;
    if (before.conf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
    else process.env.LANDO_USER_CONF_ROOT = before.conf;
    if (before.cache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = before.cache;
    await rm(root, { recursive: true, force: true });
    await rm(modules, { recursive: true, force: true });
  }
};

const fixtureAt = async (root: string, modules: string, services: ReadonlyArray<string>) => {
  const harness = await makeHarness(join(root, "data"), modules, services);
  const appRoot = AbsolutePath.make(join(root, "app"));
  await mkdir(appRoot);
  const metadata = { resolvedAt: new Date().toISOString(), source: "consumer-admission", runtime: 4 };
  const plan: AppPlan = {
    id: AppId.make("consumer"),
    name: "consumer",
    slug: "consumer",
    root: appRoot,
    provider: ProviderId.make("docker"),
    router: { enabled: false },
    requires: { globalServices: ["traefik"] },
    services: {
      [ServiceName.make("web")]: {
        name: ServiceName.make("web"),
        type: "lando",
        provider: ProviderId.make("docker"),
        primary: true,
        artifact: { kind: "ref", ref: "fixture:1" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { ...metadata, resolvedAt: DateTime.nowUnsafe(), runtime: 4 },
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { ...metadata, resolvedAt: DateTime.nowUnsafe(), runtime: 4 },
    extensions: {},
  };
  const layer = Layer.mergeAll(
    harness.layer,
    layerTransactionGuard,
    Layer.succeed(RouterService, makeTestRouterService()),
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(
      LandofileService,
      LandofileService.of({ discover: Effect.die("explicit target must be used") }),
    ),
    Layer.succeed(
      ShellRunner,
      ShellRunner.of({
        exec: () => Effect.die("no shell execution in admission fixture"),
        run: () => Effect.die("no shell execution"),
        runScript: () => Effect.die("no shell script"),
        interactive: () => Effect.die("no interactive shell"),
      }),
    ),
  );
  return {
    harness,
    root,
    plan,
    layer,
    target: { app: { kind: "user" as const, id: plan.id, root: appRoot }, plan, root: appRoot },
  };
};

const scratchLayerFor = async (
  f: Awaited<ReturnType<typeof fixtureAt>>,
  gates?: {
    readonly applied: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    readonly waiting: Deferred.Deferred<void>;
    readonly order: string[];
  },
) => {
  const planner = await Effect.runPromise(AppPlanner.pipe(Effect.provide(f.layer)));
  const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(f.layer)));
  const events = await Effect.runPromise(EventService.pipe(Effect.provide(f.layer)));
  const dependencies = Layer.mergeAll(
    f.layer,
    emptySnapshotsLayer,
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile, capabilities) =>
          landofile.document.name === "global"
            ? planner.plan(landofile, capabilities)
            : Effect.succeed({
                ...f.plan,
                id: AppId.make(landofile.document.name ?? "source"),
                name: landofile.document.name ?? "source",
                valueModel: 1 as const,
              }),
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalTestLandofile({ name: "source", runtime: 4, services: {} }, f.plan.root),
        ),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        ...registry,
        select: (target) =>
          registry.select(target).pipe(
            Effect.map((provider) => ({
              ...provider,
              apply: (plan, options) =>
                provider.apply(plan, options).pipe(
                  Effect.tap(() =>
                    Object.hasOwn(plan.extensions, "@lando/core/scratch") && gates !== undefined
                      ? Effect.gen(function* () {
                          gates.order.push("scratch-apply");
                          yield* Deferred.succeed(gates.applied, undefined);
                          yield* Deferred.await(gates.release);
                        })
                      : Effect.void,
                  ),
                ),
              inspect: (target) =>
                provider.inspect(target).pipe(
                  Effect.tap(() =>
                    gates !== undefined && String(target.app).startsWith("scratch-")
                      ? Effect.sync(() => {
                          gates.order.push("scratch-ready");
                        })
                      : Effect.void,
                  ),
                ),
            })),
          ),
      }),
    ),
    Layer.succeed(EventService, {
      ...events,
      publish: (event) =>
        event._tag === "message.warn" && gates !== undefined
          ? Deferred.succeed(gates.waiting, undefined).pipe(Effect.asVoid)
          : events.publish(event),
    }),
    ScratchRegistry.layerWithPrivateFileAccess.pipe(Layer.provide(f.layer)),
    ScratchResourceScanner.layer.pipe(Layer.provide(f.layer)),
    Layer.succeed(
      Scratch.ScratchInitAppPort,
      Scratch.ScratchInitAppPort.of({
        initApp: () => Promise.reject(new Error("recipe rendering is not used")),
      }),
    ),
  );
  return Scratch.layer.pipe(Layer.provideMerge(dependencies));
};

test("start-first admission holds policy exclusion through consumer readiness", async () => {
  await withFixture(async (f) => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const waiting = Deferred.makeUnsafe<void>();
    const order: string[] = [];
    const events = await Effect.runPromise(EventService.pipe(Effect.provide(f.layer)));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const start = yield* Effect.forkScoped(
            withGlobalConsumerAdmission(
              { plan: f.plan },
              Effect.gen(function* () {
                order.push("apply");
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                order.push("ready");
              }),
            ),
          );
          yield* Deferred.await(entered);
          const disable = yield* Effect.forkScoped(
            withGlobalMutation(
              setEnabled(false).pipe(Effect.tap(() => Effect.sync(() => order.push("disabled")))),
            ),
          );
          yield* Deferred.await(waiting);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(start);
          yield* Fiber.join(disable);
        }),
      ).pipe(
        Effect.provideService(EventService, {
          ...events,
          publish: (event) =>
            event._tag === "message.warn"
              ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
              : events.publish(event),
        }),
        Effect.provide(f.layer),
        Effect.timeout("3 seconds"),
      ),
    );
    expect(order).toEqual(["apply", "ready", "disabled"]);
  });
});

test("disable-first admission rejects user and scratch activation without provider apply", async () => {
  await withFixture(async (f) => {
    await Effect.runPromise(withGlobalMutation(setEnabled(false)).pipe(Effect.provide(f.layer)));
    const result = await Effect.runPromise(
      withGlobalConsumerAdmission({ plan: f.plan }, Effect.die("consumer must not activate")).pipe(
        Effect.result,
        Effect.provide(f.layer),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAutoStartError" } });
    const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(f.layer)));
    const provider = await Effect.runPromise(registry.select(f.plan));
    const resolver = await Effect.runPromise(EnvironmentValueResolver.pipe(Effect.provide(f.layer)));
    const admissionContext = await Effect.runPromise(
      captureGlobalConsumerAdmission.pipe(Effect.provide(f.layer)),
    );
    if (admissionContext === undefined) throw new Error("fixture must provide admission services");
    const scratch = {
      ...f.plan,
      id: AppId.make("scratch-consumer"),
      extensions: { "@lando/core/scratch": {} },
    };
    const outcome = await Effect.runPromise(
      applyScratchStartup(
        { id: "scratch-consumer", plan: scratch },
        { provider, environmentResolver: resolver, admissionContext },
      ).pipe(Effect.result, Effect.provide(f.layer)),
    );
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "ScratchAppError" } });
    expect(f.harness.applyCalls).toEqual([]);
  });
});

test.each(["start", "selected-rebuild"] as const)(
  "%s rechecks disabled policy after its build",
  async (operation) => {
    await withFixture(async (f) => {
      const builds = await Effect.runPromise(BuildOrchestrator.pipe(Effect.provide(f.layer)));
      let built = false;
      const program =
        operation === "start"
          ? startApp({}, f.target).pipe(Effect.asVoid)
          : rebuildApp({ services: [ServiceName.make("web")] }, f.target).pipe(Effect.asVoid);
      const result = await Effect.runPromise(
        program.pipe(
          Effect.result,
          Effect.provideService(BuildOrchestrator, {
            ...builds,
            build: (plan, options) =>
              plan.id === f.plan.id
                ? withGlobalMutation(setEnabled(false)).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        built = true;
                      }),
                    ),
                    Effect.as(plan),
                  )
                : builds.build(plan, options),
          }),
          Effect.provide(f.layer),
        ),
      );
      expect(built).toBe(true);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAutoStartError" } });
      expect(f.harness.applyCalls.some((call) => call.plan.id === f.plan.id)).toBe(false);
    });
  },
);

test("selected restart rechecks policy after its pre-restart hook before stopping or applying", async () => {
  await withFixture(async (f) => {
    const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(f.layer)));
    const events = await Effect.runPromise(EventService.pipe(Effect.provide(f.layer)));
    let stopped = false;
    let hooked = false;
    const result = await Effect.runPromise(
      restartApp({ services: [ServiceName.make("web")] }, f.target).pipe(
        Effect.result,
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          resolveAppliedPlan: (root) =>
            root === f.plan.root ? Effect.succeed(f.plan) : registry.resolveAppliedPlan(root),
          select: (target) =>
            registry.select(target).pipe(
              Effect.map((provider) => ({
                ...provider,
                inspect: (target) =>
                  target.app === f.plan.id
                    ? Effect.succeed({
                        app: f.plan.id,
                        appRoot: f.plan.root,
                        service: target.service,
                        providerId: f.plan.provider,
                        containerId: "owned-web",
                        status: "running",
                        publications: { status: "unknown" as const },
                      })
                    : provider.inspect(target),
                stop: (target) =>
                  target.app === f.plan.id
                    ? Effect.sync(() => {
                        stopped = true;
                      })
                    : provider.stop(target),
              })),
            ),
        }),
        Effect.provideService(EventService, {
          ...events,
          publish: (event) =>
            event._tag === "pre-restart"
              ? withGlobalMutation(setEnabled(false)).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      hooked = true;
                    }),
                  ),
                )
              : events.publish(event),
        }),
        Effect.provide(f.layer),
      ),
    );
    expect(hooked).toBe(true);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAutoStartError" } });
    expect(stopped).toBe(false);
    expect(f.harness.applyCalls.some((call) => call.plan.id === f.plan.id)).toBe(false);
  });
});

test("a reentrant global post-start hook cannot authorize a consumer from stale policy", async () => {
  await withFixture(async (f) => {
    const events = await Effect.runPromise(EventService.pipe(Effect.provide(f.layer)));
    const result = await Effect.runPromise(
      withGlobalConsumerAdmission(
        { plan: f.plan },
        Effect.die("must not apply after hook disabled requirement"),
      ).pipe(
        Effect.result,
        Effect.provideService(EventService, {
          ...events,
          publish: (event) =>
            event._tag === "post-global-start"
              ? withGlobalMutation(setEnabled(false))
              : events.publish(event),
        }),
        Effect.provide(f.layer),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAutoStartError" } });
  });
});

test("aborting an admitted consumer releases the global guard and joins body finalizers", async () => {
  await withFixture(async (f) => {
    const entered = Deferred.makeUnsafe<void>();
    const finalized = Deferred.makeUnsafe<void>();
    const controller = new AbortController();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const start = yield* Effect.forkScoped(
            withGlobalConsumerAdmission(
              { plan: f.plan, signal: controller.signal },
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finalized, undefined)),
              ),
            ),
          );
          yield* Deferred.await(entered);
          controller.abort();
          expect(Exit.isFailure(yield* Fiber.await(start))).toBe(true);
          yield* Deferred.await(finalized);
          yield* withGlobalMutation(Effect.void);
        }),
      ).pipe(Effect.provide(f.layer), Effect.timeout("3 seconds")),
    );
  });
});

test("nonconsumers bypass global admission entirely", async () => {
  await withFixture(async (f) => {
    const global = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(f.layer)));
    const result = await Effect.runPromise(
      withGlobalConsumerAdmission(
        { plan: { ...f.plan, requires: { globalServices: [] } } },
        Effect.succeed("applied"),
      ).pipe(
        Effect.provideService(GlobalAppService, {
          ...global,
          paths: Effect.die("nonconsumer must not touch global root"),
        }),
        Effect.provide(f.layer),
      ),
    );
    expect(result).toBe("applied");
    expect(f.harness.applyCalls).toEqual([]);
  });
});

test("awaited pre-service subscribers cannot disable reserved globals even with disruption acknowledged", async () => {
  await withFixture(async (f) => {
    const layer = Layer.mergeAll(f.layer, realEventLayer);
    let activated = false;
    let subscriberRan = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* captureGlobalConsumerAdmission;
          if (context === undefined) return yield* Effect.die("fixture admission context missing");
          const control = yield* EventDispatchControl;
          yield* control.install({
            hasSubscribers: (name) => name === "pre-service-start",
            dispatch: (event) =>
              event._tag !== "pre-service-start"
                ? Effect.void
                : Effect.gen(function* () {
                    subscriberRan = true;
                    const before = yield* readGlobalPolicy();
                    const preview = yield* globalDisable({
                      selectors: ["traefik"],
                      allowDisruption: true,
                      dryRun: true,
                    });
                    expect(
                      preview.impact.uncertainties.some((message) => message.includes("reserves traefik")),
                    ).toBe(true);
                    const attempt = yield* globalDisable({
                      selectors: ["traefik"],
                      allowDisruption: true,
                    }).pipe(Effect.result);
                    expect(attempt).toMatchObject({
                      _tag: "Failure",
                      failure: { _tag: "GlobalConsumerProtectionError", policySaved: false },
                    });
                    expect(yield* readGlobalPolicy()).toEqual(before);
                  }).pipe(Effect.provide(context), Effect.orDie),
          });
          const events = yield* EventService;
          yield* withGlobalConsumerAdmission(
            { plan: f.plan },
            Effect.gen(function* () {
              yield* events.publish(
                PreServiceStartEvent.make({
                  eventName: "pre-service-start",
                  appRef: f.target.app,
                  serviceName: ServiceName.make("web"),
                  providerId: f.plan.provider,
                  timestamp: DateTime.nowUnsafe(),
                }),
              );
              activated = true;
            }),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(subscriberRan).toBe(true);
    expect(activated).toBe(true);
  });
});

test.each(["supported-disable", "direct-policy-write"] as const)(
  "runtime app build handles %s before route publication",
  async (mutation) => {
    await withFixture(async (f) => {
      const builds = await Effect.runPromise(BuildOrchestrator.pipe(Effect.provide(f.layer)));
      let built = false;
      let published = 0;
      const routed: AppPlan = {
        ...f.plan,
        router: { enabled: true },
        routes: [
          {
            service: ServiceName.make("web"),
            hostname: "consumer.lndo.site",
            priority: 2,
            scheme: "http",
            endpoint: 80,
            backend: { service: ServiceName.make("web"), port: 80, protocol: "http" },
          },
        ],
      };
      const router = makeTestRouterService();
      const result = await Effect.runPromise(
        startApp({}, { ...f.target, plan: routed }).pipe(
          Effect.result,
          Effect.provideService(BuildOrchestrator, {
            ...builds,
            buildApp: () =>
              Effect.gen(function* () {
                built = true;
                if (mutation === "direct-policy-write") yield* setEnabled(false);
                else {
                  const attempt = yield* globalDisable({
                    selectors: ["traefik"],
                    allowDisruption: true,
                  }).pipe(Effect.result);
                  expect(attempt).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "GlobalConsumerProtectionError", policySaved: false },
                  });
                }
              }).pipe(Effect.provide(f.layer), Effect.orDie),
          }),
          Effect.provideService(RouterService, {
            ...router,
            id: "traefik",
            applyRoutes: (routes, app) =>
              router.applyRoutes(routes, app).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (app === f.plan.id) published++;
                  }),
                ),
              ),
          }),
          Effect.provide(f.layer),
        ),
      );
      expect(built).toBe(true);
      expect(f.harness.applyCalls.some((call) => call.plan.id === f.plan.id)).toBe(true);
      if (mutation === "direct-policy-write") {
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAutoStartError" } });
        expect(published).toBe(0);
        expect(f.harness.events.some((event) => event._tag === "post-app-start")).toBe(false);
      } else {
        expect(result._tag).toBe("Success");
        expect(published).toBe(1);
      }
    });
  },
);

test("descendant policy operation without inherited holder environment refuses to borrow its parent lease", async () => {
  await withFixture(async (f) => {
    const script = join(f.root, "child.ts");
    const repo = process.cwd();
    const modules = await mkdtemp(join(repo, ".lando-reservation-child-"));
    try {
      await writeFile(
        script,
        `import "${repo}/core/src/runtime/engine-composition.ts";\nimport {Effect,Layer} from "${repo}/node_modules/effect/dist/index.js";\nimport {globalDisable} from "${repo}/engine/src/operations/global-policy.ts";\nimport {makeHarness} from "${repo}/core/test/_support/ensure-global-harness.ts";\nimport {RouterService} from "${repo}/sdk/src/services/index.ts";\nimport {makeTestRouterService} from "${repo}/sdk/src/test/index.ts";\nconst h=await makeHarness(${JSON.stringify(join(f.root, "data"))},${JSON.stringify(modules)});\nconst result=await Effect.runPromise(globalDisable({selectors:["traefik"],allowDisruption:true}).pipe(Effect.result,Effect.provide(Layer.mergeAll(h.layer,Layer.succeed(RouterService,makeTestRouterService())))));\nconsole.log(JSON.stringify({pid:process.pid,holderEnvPresent:process.env[${JSON.stringify(APP_LOCK_HOLDERS_ENV)}]!==undefined,result,applies:h.applyCalls.length}));\n`,
      );
      await Effect.runPromise(
        withGlobalConsumerAdmission(
          { plan: f.plan },
          Effect.promise(async () => {
            const env = { ...process.env, LANDO_APP_LOCK_TIMEOUT_MS: "200" };
            Reflect.deleteProperty(env, APP_LOCK_HOLDERS_ENV);
            const child = Bun.spawn([process.execPath, script], {
              cwd: repo,
              env,
              stdout: "pipe",
              stderr: "pipe",
            });
            const deadline = setTimeout(() => child.kill(), 5000);
            const [code, output, error] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            clearTimeout(deadline);
            expect(error).toBe("");
            expect(code).toBe(0);
            const result = JSON.parse(output.trim());
            expect(result.pid).not.toBe(process.pid);
            expect(result.holderEnvPresent).toBe(false);
            expect(result.result).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "GlobalAppError",
                operation: "coordination",
                cause: { _tag: "StateStoreError", reason: "lock", operation: "nestedAppMutation" },
              },
            });
            expect(result.applies).toBe(0);
          }),
        ).pipe(Effect.provide(f.layer), Effect.timeout("7 seconds")),
      );
    } finally {
      await rm(modules, { recursive: true, force: true });
    }
  });
});

test("unrelated nested policy changes remain allowed during activation", async () => {
  await withFixture(
    async (f) => {
      await Effect.runPromise(
        withGlobalConsumerAdmission(
          { plan: f.plan },
          Effect.gen(function* () {
            const result = yield* globalDisable({ selectors: ["other"], allowDisruption: true });
            expect(result.policySaved).toBe(true);
            expect(result.contributions).toEqual(["other"]);
            expect(
              (yield* readGlobalPolicy()).plugins["@lando/fake-global-ensure"]?.contributions.other?.enabled,
            ).toBe(false);
          }),
        ).pipe(Effect.provide(f.layer)),
      );
    },
    ["traefik", "other"],
  );
});

test("activation reservations protect shared policy across different embedded global roots", async () => {
  await withFixture(async (f) => {
    const global = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(f.layer)));
    const oldPaths = await Effect.runPromise(global.paths);
    const otherRoot = AbsolutePath.make(join(f.root, "other-global"));
    await mkdir(otherRoot);
    await Effect.runPromise(
      withGlobalConsumerAdmission(
        { plan: f.plan },
        Effect.gen(function* () {
          const before = yield* readGlobalPolicy();
          const access = yield* PrivateFileAccessService;
          const separate = makeLandoPaths({
            userDataRoot: join(f.root, "separate-data"),
            userConfRoot: join(f.root, "separate-conf"),
          });
          expect(
            yield* readGlobalConsumerReservations(["traefik"]).pipe(
              Effect.provideService(
                StateStore,
                makeStateStore({ privateFileAccess: access, roots: separate.roots }),
              ),
            ),
          ).toEqual([]);
          expect(
            yield* readGlobalConsumerReservations(["traefik"]).pipe(
              Effect.provideService(GlobalAppService, {
                ...global,
                root: Effect.succeed(otherRoot),
                paths: Effect.succeed({ ...oldPaths, root: otherRoot }),
              }),
            ),
          ).toHaveLength(1);
          const result = yield* globalDisable({ selectors: ["traefik"], allowDisruption: true }).pipe(
            Effect.provideService(GlobalAppService, {
              ...global,
              root: Effect.succeed(otherRoot),
              paths: Effect.succeed({ ...oldPaths, root: otherRoot }),
            }),
            Effect.result,
          );
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "GlobalAppError",
              cause: { _tag: "StateStoreError", operation: "nestedGlobalPolicyMutation" },
            },
          });
          expect(yield* readGlobalPolicy()).toEqual(before);
        }),
      ).pipe(Effect.provide(f.layer)),
    );
  });
});

test("bound scratch SDK admission reenters the caller guard and excludes disable through readiness", async () => {
  await withFixture(async (f) => {
    const gates = {
      applied: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
      waiting: Deferred.makeUnsafe<void>(),
      order: [] as string[],
    };
    const layer = await scratchLayerFor(f, gates);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          const acquisition = yield* Effect.forkScoped(
            withGlobalMutation(
              scratch.acquire({
                source: { kind: "fork" },
                isolate: "none",
                detached: true,
                keepOnFailure: true,
              }),
            ),
          );
          yield* Deferred.await(gates.applied);
          const disable = yield* Effect.forkScoped(
            withGlobalMutation(
              setEnabled(false).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    gates.order.push("disabled");
                  }),
                ),
              ),
            ),
          );
          yield* Deferred.await(gates.waiting);
          yield* Deferred.succeed(gates.release, undefined);
          const handle = yield* Fiber.join(acquisition);
          yield* Fiber.join(disable);
          expect(handle.app.root).toBe(f.plan.root);
          expect(handle.id).not.toBe(f.plan.id);
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
    );
    expect(gates.order[0]).toBe("scratch-apply");
    expect(gates.order).toContain("scratch-ready");
    expect(gates.order.at(-1)).toBe("disabled");
  });
});

test("bound scratch SDK refuses disabled globals before direct provider activation", async () => {
  await withFixture(async (f) => {
    const layer = await scratchLayerFor(f);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          yield* withGlobalMutation(setEnabled(false));
          return yield* scratch
            .acquire({ source: { kind: "fork" }, isolate: "none", detached: true, keepOnFailure: true })
            .pipe(Effect.result);
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ScratchAppError", cause: { _tag: "GlobalAutoStartError" } },
    });
    expect(f.harness.applyCalls).toEqual([]);
  });
});

test("sibling callbacks sharing a held coordinator observe activation reservations and their cleanup", async () => {
  await withFixture(async (f) => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    await Effect.runPromise(
      withGlobalMutation(
        Effect.scoped(
          Effect.gen(function* () {
            const activation = yield* Effect.forkScoped(
              withGlobalConsumerAdmission(
                { plan: f.plan },
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            );
            yield* Deferred.await(entered);
            const sibling = yield* Effect.forkScoped(
              Effect.gen(function* () {
                const preview = yield* globalDisable({
                  selectors: ["traefik"],
                  dryRun: true,
                  allowDisruption: true,
                });
                expect(
                  preview.impact.uncertainties.some((message) => message.includes("reserves traefik")),
                ).toBe(true);
                return yield* globalDisable({ selectors: ["traefik"], allowDisruption: true }).pipe(
                  Effect.result,
                );
              }),
            );
            const refused = yield* Fiber.join(sibling);
            expect(refused).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "GlobalConsumerProtectionError", policySaved: false },
            });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(activation);
            expect(yield* readGlobalConsumerReservations(["traefik"])).toEqual([]);
            expect(
              (yield* globalDisable({ selectors: ["traefik"], allowDisruption: true })).policySaved,
            ).toBe(true);
          }),
        ),
      ).pipe(Effect.provide(f.layer), Effect.timeout("5 seconds")),
    );
  });
});

test("a completed sibling activation invalidates the earlier consumer scan before policy commit", async () => {
  await withFixture(async (f) => {
    await Effect.runPromise(
      withGlobalConsumerAdmission({ plan: f.plan }, Effect.void).pipe(Effect.provide(f.layer)),
    );
    const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(f.layer)));
    const provider = await Effect.runPromise(registry.select(f.plan.provider));
    const scanned = Deferred.makeUnsafe<void>();
    const resumeScan = Deferred.makeUnsafe<void>();
    const activationEntered = Deferred.makeUnsafe<void>();
    const releaseActivation = Deferred.makeUnsafe<void>();
    let pause = true;
    const guarded = RuntimeProviderRegistry.of({
      ...registry,
      appliedStateInventory: () =>
        Effect.suspend(() => {
          const plans = [...new Map(f.harness.applyCalls.map((call) => [call.plan.id, call.plan])).values()];
          const snapshot = { plans, unreadable: [] };
          if (!pause) return Effect.succeed(snapshot);
          pause = false;
          return Deferred.succeed(scanned, undefined).pipe(
            Effect.andThen(Deferred.await(resumeScan)),
            Effect.as(snapshot),
          );
        }),
    });
    await Effect.runPromise(
      withGlobalMutation(
        Effect.scoped(
          Effect.gen(function* () {
            const before = yield* readGlobalPolicy();
            const activation = yield* Effect.forkScoped(
              withGlobalConsumerAdmission(
                { plan: f.plan },
                Deferred.succeed(activationEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseActivation)),
                  Effect.andThen(provider.apply(f.plan, { reconcile: false })),
                ),
              ),
            );
            yield* Deferred.await(activationEntered);
            const policy = yield* Effect.forkScoped(
              globalDisable({ selectors: ["traefik"], allowDisruption: true }).pipe(Effect.result),
            );
            yield* Deferred.await(scanned);
            yield* Deferred.succeed(releaseActivation, undefined);
            yield* Fiber.join(activation);
            expect(f.harness.applyCalls.some((call) => call.plan.id === f.plan.id)).toBe(true);
            expect(yield* readGlobalConsumerReservations(["traefik"])).toEqual([]);
            yield* Deferred.succeed(resumeScan, undefined);
            const result = yield* Fiber.join(policy);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "GlobalConsumerProtectionError", policySaved: false },
            });
            if (result._tag === "Failure" && result.failure._tag === "GlobalConsumerProtectionError")
              expect(
                result.failure.uncertainties.some((message) =>
                  message.includes("changed during the consumer impact scan"),
                ),
              ).toBe(true);
            expect(yield* readGlobalPolicy()).toEqual(before);
          }),
        ),
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, guarded),
        Effect.provide(f.layer),
        Effect.timeout("5 seconds"),
      ),
    );
  });
});

test("policy cleanup keeps its claim until completion and refuses sibling enable or activation", async () => {
  await withFixture(async (f) => {
    await Effect.runPromise(
      withGlobalConsumerAdmission({ plan: f.plan }, Effect.void).pipe(Effect.provide(f.layer)),
    );
    const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(f.layer)));
    const cleanup = Deferred.makeUnsafe<void>();
    const resume = Deferred.makeUnsafe<void>();
    let intercept = true;
    const guarded = RuntimeProviderRegistry.of({
      ...registry,
      select: (target) =>
        registry.select(target).pipe(
          Effect.map((provider) => ({
            ...provider,
            removeObservedService: (observed) => {
              const remove = provider.removeObservedService(observed);
              if (!intercept) return remove;
              intercept = false;
              return Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(remove),
              );
            },
          })),
        ),
    });
    await Effect.runPromise(
      withGlobalMutation(
        Effect.scoped(
          Effect.gen(function* () {
            const disable = yield* Effect.forkScoped(
              globalDisable({ selectors: ["traefik"], allowDisruption: true }).pipe(Effect.result),
            );
            yield* Deferred.await(cleanup);
            expect(
              (yield* readGlobalPolicy()).plugins["@lando/fake-global-ensure"]?.contributions.traefik
                ?.enabled,
            ).toBe(false);
            const enable = yield* globalEnable({ selectors: ["traefik"] }).pipe(Effect.result);
            expect(enable).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "GlobalAppError", operation: "policy-coordination" },
            });
            const preview = yield* globalEnable({ selectors: ["traefik"], dryRun: true });
            expect(
              preview.impact.uncertainties.some((message) => message.includes("still reconciling")),
            ).toBe(true);
            const activation = yield* withGlobalConsumerAdmission(
              { plan: f.plan },
              Effect.die("must not activate during cleanup"),
            ).pipe(Effect.result);
            expect(activation).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "GlobalAutoStartError",
                cause: { _tag: "GlobalAppError", operation: "consumer-admission" },
              },
            });
            expect(f.harness.applyCalls.some((call) => call.plan.id === f.plan.id)).toBe(false);
            yield* Deferred.succeed(resume, undefined);
            yield* Fiber.join(disable);
            expect((yield* globalEnable({ selectors: ["traefik"] })).policySaved).toBe(true);
          }),
        ),
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, guarded),
        Effect.provide(f.layer),
        Effect.timeout("5 seconds"),
      ),
    );
  });
});
