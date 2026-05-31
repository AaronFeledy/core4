import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { GlobalAppError, GlobalDestroyConfirmationError, ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  type AppPlan,
  LandofileShape,
  PluginManifest,
  PortablePath,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  ServicePlan,
} from "@lando/core/schema";
import {
  type AppPlanner,
  type AppSelector,
  type ApplyOptions,
  type CacheService,
  type ConfigService,
  type DestroyOptions,
  type FileSystem,
  GlobalAppService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceSelector,
  type ServiceTypePlanInput,
  type ServiceTypeShape,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { globalConfig } from "../../src/cli/commands/meta/global-config.ts";
import { globalDestroy } from "../../src/cli/commands/meta/global-destroy.ts";
import { globalStart } from "../../src/cli/commands/meta/global-start.ts";
import { globalStatus } from "../../src/cli/commands/meta/global-status.ts";
import { globalStop } from "../../src/cli/commands/meta/global-stop.ts";
import { globalUninstall } from "../../src/cli/commands/meta/global-uninstall.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

interface ApplyCall {
  readonly plan: AppPlan;
  readonly options: ApplyOptions;
}

interface DestroyCall {
  readonly target: AppSelector;
  readonly options: DestroyOptions;
}

interface InspectCall {
  readonly target: ServiceSelector;
}

interface ProviderCalls {
  readonly apply: Array<ApplyCall>;
  readonly destroy: Array<DestroyCall>;
  readonly inspect: Array<InspectCall>;
}

type HarnessLayer = Layer.Layer<
  | AppPlanner
  | CacheService
  | ConfigService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry
>;

interface Harness {
  readonly dataRoot: string;
  readonly layer: HarnessLayer;
  readonly calls: ProviderCalls;
}

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-commands-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-commands-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: environment cleanup must preserve the originally unset state.
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: environment cleanup must preserve the originally unset state.
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const fakeServiceType: ServiceTypeShape = {
  id: "lando",
  toServicePlan: ({
    name,
    appRoot,
    provider = ProviderId.make("lando"),
    primary = false,
    metadata,
  }: ServiceTypePlanInput) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "lando",
      provider,
      primary,
      artifact: { kind: "ref", ref: "lando-global-service:test" },
      environment: {},
      workingDirectory: PortablePath.make("/app"),
      appMount: {
        source: AbsolutePath.make(appRoot),
        target: PortablePath.make("/app"),
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
      mounts: [],
      storage: [],
      endpoints: [{ protocol: "http", port: 8080, name: "http" }],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
};

const writeGlobalServiceModule = async (moduleRoot: string): Promise<string> => {
  const modulePath = join(moduleRoot, "fake-global-service.mjs");
  await writeFile(
    modulePath,
    'import { Effect } from "effect";\nexport default Effect.succeed({ api: 4, type: "lando" });\n',
  );
  return modulePath;
};

const makeHarness = async (
  dataRoot: string,
  moduleRoot: string,
  options: { readonly failInspect?: boolean } = {},
): Promise<Harness> => {
  const modulePath = await writeGlobalServiceModule(moduleRoot);
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-command",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [fakeServiceType.id],
      globalServices: [
        { id: "proxy", module: modulePath, enabledByDefault: true },
        { id: "mail", module: modulePath, enabledByDefault: true },
      ],
    },
  });
  const calls: ProviderCalls = { apply: [], destroy: [], inspect: [] };
  const providerId = ProviderId.make("lando");
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: String(providerId),
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
    apply: (plan, options) =>
      Effect.sync(() => {
        calls.apply.push({ plan, options });
        return { changed: true };
      }),
    destroy: (target, options) =>
      Effect.sync(() => {
        calls.destroy.push({ target, options });
      }),
    inspect: (target) => {
      calls.inspect.push({ target });
      if (options.failInspect) {
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: String(providerId),
            operation: "inspect",
            message: "provider unavailable",
          }),
        );
      }
      return Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: [{ protocol: "http", port: 8080, name: "http" }],
      });
    },
  };
  const pluginRegistry = {
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(fakeServiceType),
  };
  const layer = Layer.mergeAll(
    ConfigServiceLive,
    CacheServiceLive,
    FileSystemLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
    AppPlannerLive.pipe(
      Layer.provide(
        Layer.mergeAll(Layer.succeed(PluginRegistry, pluginRegistry), CacheServiceLive, ConfigServiceLive),
      ),
    ),
  );
  return { dataRoot, layer, calls };
};

const withHarness = async <T>(
  run: (harness: Harness) => Promise<T>,
  options: { readonly failInspect?: boolean } = {},
): Promise<T> =>
  withTempRoots(async (dataRoot) => {
    const moduleRoot = await mkdtemp(join(process.cwd(), ".lando-global-command-module-"));
    try {
      const harness = await makeHarness(dataRoot, moduleRoot, options);
      return await run(harness);
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });

const materializeDist = (
  harness: Harness,
  services: Record<string, ServiceConfig> = { proxy: { type: "lando" } },
) =>
  Effect.runPromise(
    Effect.flatMap(GlobalAppService, (globalApp) => globalApp.regenerateDist({ services })).pipe(
      Effect.provide(harness.layer),
    ),
  );

const distPath = (dataRoot: string): string => join(dataRoot, "global", ".lando.dist.yml");

const parseDist = async (path: string) => {
  const content = await readFile(path, "utf8");
  const parsed = await Effect.runPromise(parseLandofile({ file: path, content, cwd: join(path, "..") }));
  return Schema.decodeUnknownSync(LandofileShape)(parsed);
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("meta:global command effects", () => {
  test("start materializes the global app, applies the global-rooted plan, and inspects each service", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));

      expect(harness.calls.apply).toHaveLength(1);
      expect(String(harness.calls.apply[0]?.plan.id)).toBe("global");
      expect(harness.calls.apply[0]?.plan.name).toBe("global");
      expect(harness.calls.apply[0]?.plan.root).toBe(join(harness.dataRoot, "global"));
      expect(harness.calls.apply[0]?.options.reconcile).toBe(false);
      expect(Object.keys(harness.calls.apply[0]?.plan.services ?? {}).sort()).toEqual(["mail", "proxy"]);
      expect(harness.calls.inspect.map((call) => String(call.target.service)).sort()).toEqual([
        "mail",
        "proxy",
      ]);
      expect(result.servicesStarted.map((service) => service.name).sort()).toEqual(["mail", "proxy"]);
    });
  });

  test("start with --service applies and inspects only the selected subset", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.apply).toHaveLength(1);
      expect(Object.keys(harness.calls.apply[0]?.plan.services ?? {})).toEqual(["mail"]);
      expect(harness.calls.inspect.map((call) => String(call.target.service))).toEqual(["mail"]);
      expect(result.servicesStarted.map((service) => service.name)).toEqual(["mail"]);
    });
  });

  test("start with unknown --service fails before applying a plan", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        globalStart({ services: ["nope"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.apply).toEqual([]);
      expect(harness.calls.inspect).toEqual([]);
      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toContain("nope");
      expect(error.message).toContain("available: mail, proxy");
    });
  });

  test("stop destroys provider resources without volumes or state removal", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.destroy).toHaveLength(1);
      expect(String(harness.calls.destroy[0]?.target.app)).toBe("global");
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: false });
      expect(result.materialized).toBe(true);
      expect(result.servicesStopped).toEqual(["proxy"]);
    });
  });

  test("stop succeeds without provider calls when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.destroy).toEqual([]);
      expect(result.materialized).toBe(false);
      expect(result.servicesStopped).toEqual([]);
    });
  });

  test("status inspects planned global services and supports a service subset", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando" },
        mail: { type: "lando" },
      });

      const result = await Effect.runPromise(
        globalStatus({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.inspect.map((call) => String(call.target.service))).toEqual(["mail"]);
      expect(result.materialized).toBe(true);
      expect(result.services.map((service) => service.service)).toEqual(["mail"]);
    });
  });

  test("status returns an empty success when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.inspect).toEqual([]);
      expect(result.materialized).toBe(false);
      expect(result.services).toEqual([]);
    });
  });

  test("status degrades each service to unknown when the provider is unavailable", async () => {
    await withHarness(
      async (harness) => {
        await materializeDist(harness, { proxy: { type: "lando" }, mail: { type: "lando" } });

        const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

        expect(result.materialized).toBe(true);
        expect(result.services.map((service) => service.service).sort()).toEqual(["mail", "proxy"]);
        expect(result.services.every((service) => service.status === "unknown")).toBe(true);
        expect(result.services.every((service) => service.endpoints.length > 0)).toBe(true);
      },
      { failInspect: true },
    );
  });

  test("destroy requires --yes before any provider call", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const exit = await Effect.runPromiseExit(globalDestroy({}).pipe(Effect.provide(harness.layer)));
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalDestroyConfirmationError);
      expect(harness.calls.destroy).toEqual([]);
    });
  });

  test("destroy with --yes removes provider state while preserving volumes by default", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(
        globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: true });
      expect(result.materialized).toBe(true);
      expect(result.volumesRemoved).toBe(false);
    });
  });

  test("destroy --purge removes provider state and volumes", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(
        globalDestroy({ yes: true, purge: true }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: true, removeState: true });
      expect(result.volumesRemoved).toBe(true);
    });
  });

  test("uninstall rejects plugin arguments before provider or dist mutation", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const exit = await Effect.runPromiseExit(
        globalUninstall({ plugin: "@lando/proxy-traefik" }).pipe(Effect.provide(harness.layer)),
      );
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalAppError);
      expect(harness.calls.destroy).toEqual([]);
      expect((await parseDist(distPath(harness.dataRoot))).services).toHaveProperty("proxy");
    });
  });

  test("uninstall without a plugin regenerates an empty global dist", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(globalUninstall({}).pipe(Effect.provide(harness.layer)));
      const parsed = await parseDist(distPath(harness.dataRoot));

      expect(result.servicesRemoved).toEqual(["proxy"]);
      expect(parsed.services).toEqual({});
      expect(harness.calls.destroy).toEqual([]);
    });
  });

  test("uninstall --purge destroys provider resources before clearing services", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(
        globalUninstall({ purge: true }).pipe(Effect.provide(harness.layer)),
      );
      const parsed = await parseDist(distPath(harness.dataRoot));

      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: true, removeState: true });
      expect(result.purged).toBe(true);
      expect(parsed.services).toEqual({});
    });
  });

  test("config returns the parsed generated global Landofile and overlay path", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(globalConfig().pipe(Effect.provide(harness.layer)));

      expect(result.materialized).toBe(true);
      expect(result.app).toBe("global");
      expect(result.distLandofile).toBe(distPath(harness.dataRoot));
      expect(result.userLandofile).toBe(join(harness.dataRoot, "global", ".lando.yml"));
      expect(result.landofile.services).toHaveProperty("proxy");
    });
  });
});
