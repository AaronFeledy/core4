import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Queue, Stream } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import {
  appCommandCachePath,
  appPlanCachePath,
  appToolingCompilationCachePath,
} from "@lando/engine/cache/paths";
import { CacheServiceLive } from "@lando/engine/cache/service";
import { landofileRuntimeInputs } from "@lando/engine/composition";
import { GlobalAppServiceLive } from "@lando/engine/global-app/service";
import { startApp } from "@lando/engine/operations/start";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { appSteps } from "@lando/engine/services/build-app-plan";
import { BuildOrchestratorLive } from "@lando/engine/services/build-orchestrator";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { EventServiceLive } from "@lando/engine/services/event-service";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { AppPlannerLive } from "@lando/engine/services/planner";
import { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
import { resolveLandofileIncludes } from "@lando/landofile/includes";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ProviderInternalError } from "@lando/sdk/errors";
import { type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  ManagedFileTransactionGuard,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  SecretStore,
  StateStore,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { appConfig } from "../../src/cli/commands/app-config.ts";

test.each([
  ["canary-956-f6d042c1-opaque-resolved-value", false],
  ["1234", false],
  ["1234", true],
] as const)(
  "keeps user profile secret %s out of config, disk caches, events, transcripts, and errors (failure=%s)",
  async (sentinel, fails) => {
    // Given: an opaque env name and a secret value available only through the fake store.
    const root = await mkdtemp(join(tmpdir(), "lando-profile-canary-"));
    const previousEnv = {
      cache: process.env.LANDO_USER_CACHE_ROOT,
      data: process.env.LANDO_USER_DATA_ROOT,
      conf: process.env.LANDO_USER_CONF_ROOT,
    };
    process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");
    process.env.LANDO_USER_CONF_ROOT = join(root, "conf");
    const paths = makeLandoPaths();
    const appRoot = join(root, "app");
    const reference = "${secret:OPAQUE}";
    const web = ServiceName.make("web");
    let providerValue: string | undefined;
    let appliedPlan: AppPlan | undefined;
    let executions = 0;
    const store = makeStateStore({
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    });
    const secretStore = {
      id: "canary",
      get: (id: string) => {
        expect(id).toBe("OPAQUE");
        return Effect.succeed(sentinel);
      },
      has: () => Effect.succeed(true),
      list: Effect.succeed(["OPAQUE"]),
    };
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      apply: (plan, options) =>
        Effect.sync(() => {
          appliedPlan = plan;
          providerValue = options.serviceEnvironment?.[web]?.VALUE;
          return { changed: true };
        }),
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: ProviderId.make("lando"),
          status: "running",
          state: "running",
          endpoints: [],
        }),
      execStream: () => {
        executions += 1;
        const output = `build output ${providerValue}\n`;
        const split = output.indexOf(sentinel) + Math.floor(sentinel.length / 2);
        const chunks = Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode(output.slice(0, split)) },
          { kind: "stdout" as const, chunk: new TextEncoder().encode(output.slice(split)) },
        );
        return Stream.concat(
          chunks,
          fails
            ? Stream.fail(
                new ProviderInternalError({
                  providerId: "lando",
                  operation: "execStream",
                  message: sentinel,
                }),
              )
            : Stream.make({ exitCode: 0 }),
        );
      },
    };
    const dependencies = Layer.mergeAll(
      CacheServiceLive,
      FileSystemLive,
      PluginRegistryLive,
      EventServiceLive,
      PrivateFileAccessLive,
      Layer.succeed(PathsService, paths),
      Layer.succeed(StateStore, store),
      Layer.succeed(ManagedFileTransactionGuard, {
        ensureConsistent: () => Effect.void,
        pending: () => Effect.succeed(null),
      }),
      Layer.succeed(SecretStore, secretStore),
      Layer.succeed(RedactionService, makeRedactionService(secretStore)),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(RouterService, TestRouterService),
      makeShellRunnerLive(() => {
        throw new TypeError("No host shell is expected");
      }),
      GlobalAppServiceLive.pipe(Layer.provide(Layer.merge(ConfigServiceLive, FileSystemLive))),
      Layer.succeed(LandofileService, {
        discover: resolveLandofileIncludes({
          landofile: { name: "profile-canary", includes: ["user:profile.yml"] },
          appRoot,
          cacheRoot: paths.roots.userCacheRoot,
          ports: { ...landofileRuntimeInputs().ports, resolveUserIncludesDir: () => paths.userIncludesDir },
          stateStore: store,
        }),
      }),
    );
    const layer = Layer.mergeAll(
      dependencies,
      AppPlannerLive.pipe(Layer.provide(dependencies)),
      BuildOrchestratorLive.pipe(Layer.provide(dependencies)),
    );
    try {
      await mkdir(appRoot, { recursive: true });
      await mkdir(paths.userIncludesDir, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: profile-canary\nincludes:\n  - user:profile.yml\n");
      await writeFile(
        join(paths.userIncludesDir, "profile.yml"),
        `services:\n  web:\n    type: compose\n    image: alpine:3.21\n    home: false\n    environment:\n      VALUE: '${reference}'\n    build:\n      app:\n        - echo build\n`,
      );

      // When: config, planning, caching, start, and app builds run through their real implementations.
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* EventService;
            const queue = yield* events.subscribeQueue;
            const view = yield* appConfig();
            const get = yield* appConfig({ subcommand: "get", key: "services.web.environment.VALUE" });
            const landofile = yield* (yield* LandofileService).discover;
            const planner = yield* AppPlanner;
            const plan = yield* planner.plan(landofile, provider.capabilities);
            yield* writeAppCommandCacheStrict({
              landofile,
              entries: [{ id: "app:check", summary: "Check", hidden: false, service: "web" }],
              cwd: appRoot,
              cacheRoot: paths.roots.userCacheRoot,
            });
            const buildIdentity = appSteps(plan);
            const outcome = yield* startApp(
              {},
              { plan, landofile, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
            ).pipe(Effect.either);
            const cachedPlan = yield* planner.plan(landofile, provider.capabilities);
            return {
              view,
              get,
              plan,
              cachedPlan,
              buildIdentity,
              outcome,
              events: [...(yield* Queue.takeAll(queue))],
            };
          }),
        ).pipe(Effect.provide(layer)),
      );

      // Then: provider action sees the value; durable identities and every observed surface do not.
      expect(providerValue).toBe(sentinel);
      expect(result.outcome._tag).toBe(fails ? "Left" : "Right");
      expect(appliedPlan?.services[web]?.environment.VALUE).toBe(reference);
      expect(result.plan.services[web]?.environment.VALUE).toBe(reference);
      expect(result.cachedPlan).toEqual(result.plan);
      expect(result.get.value).toBe(reference);
      expect(appSteps(result.cachedPlan)).toEqual(result.buildIdentity);
      expect(result.buildIdentity).toHaveLength(1);
      expect(executions).toBe(1);
      expect(JSON.stringify(result)).not.toContain(sentinel);

      const cachePaths = [
        appPlanCachePath(paths.roots.userCacheRoot, "profile-canary", appRoot),
        appCommandCachePath(paths.roots.userCacheRoot, "profile-canary", appRoot),
        appToolingCompilationCachePath(paths.roots.userCacheRoot, appRoot),
      ];
      for (const path of cachePaths)
        expect((await readFile(path)).includes(Buffer.from(sentinel))).toBe(false);
      const artifacts = (
        await Promise.all(
          [paths.roots.userDataRoot, paths.roots.userCacheRoot].map((path) =>
            readdir(path, { recursive: true, withFileTypes: true }),
          ),
        )
      ).flat();
      const files = artifacts
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
      expect(files.some((path) => path.endsWith(".log"))).toBe(true);
      expect(files.some((path) => path.includes("build-results") && path.endsWith(".bin"))).toBe(true);
      for (const path of files) expect((await readFile(path)).includes(Buffer.from(sentinel))).toBe(false);
      const transcripts = await Promise.all(
        files.filter((path) => path.endsWith(".log")).map((path) => readFile(path, "utf8")),
      );
      expect(transcripts.join("\n")).toContain("[redacted]");
    } finally {
      for (const [key, value] of [
        ["LANDO_USER_CACHE_ROOT", previousEnv.cache],
        ["LANDO_USER_DATA_ROOT", previousEnv.data],
        ["LANDO_USER_CONF_ROOT", previousEnv.conf],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
