import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  type DestroyOptions,
  GlobalAppService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, type Result } from "effect";
import { switchGlobalProviderForSetup } from "../../src/operations/setup-provider-switch.ts";

const planAt = (root: AbsolutePath, id: string): AppPlan => ({
  id: AppId.make(id),
  root,
  name: id,
  slug: id,
  provider: ProviderId.make("lando"),
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  services: {},
  networks: [],
  stores: [],
  routes: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "test", runtime: 4 },
});

const withSwitch = async (
  input: { readonly dependent: "route" | "service" | "none"; readonly running: boolean },
  use: (fixture: {
    readonly run: () => Promise<
      Result.Result<
        Effect.Success<ReturnType<typeof switchGlobalProviderForSetup>>,
        Effect.Error<ReturnType<typeof switchGlobalProviderForSetup>>
      >
    >;
    readonly destroys: DestroyOptions[];
    readonly globalApplied: () => boolean;
    readonly routeFile: string;
    readonly user: AppPlan;
  }) => Promise<void>,
) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-setup-switch-"));
  try {
    const root = AbsolutePath.make(join(dataRoot, "global"));
    await mkdir(root);
    const routeFile = join(root, "retained-router.json");
    await writeFile(routeFile, "retained dynamic configuration");
    const global = planAt(root, "global");
    const baseUser = planAt(AbsolutePath.make(join(dataRoot, "user")), "user-app");
    const user: AppPlan = {
      ...baseUser,
      routes:
        input.dependent === "route"
          ? [
              {
                hostname: "user.lndo.site",
                scheme: "http",
                service: ServiceName.make("web"),
                priority: 1,
                backend: { service: ServiceName.make("web"), protocol: "http", host: "web", port: 80 },
              },
            ]
          : [],
      ...(input.dependent === "service" ? { requires: { globalServices: ["mailpit"] } } : {}),
    };
    let globalApplied = true;
    const destroys: DestroyOptions[] = [];
    const services: ServiceRuntimeInfo[] = input.running
      ? [
          {
            app: user.id,
            appRoot: user.root,
            providerId: user.provider,
            service: ServiceName.make("web"),
            status: "running",
            containerId: "user-container",
          },
        ]
      : [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      appliedPlans: Effect.sync(() => (globalApplied ? [global, user] : [user])),
      list: () => Effect.succeed(services),
      destroy: (_target: unknown, options: DestroyOptions) =>
        Effect.sync(() => {
          destroys.push(options);
          globalApplied = false;
          return { kind: "destroyed" as const };
        }),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(
        GlobalAppService,
        GlobalAppService.of({
          id: "global",
          providerId: Effect.succeed(ProviderId.make("lando")),
          root: Effect.succeed(root),
          paths: Effect.succeed({
            root,
            distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
            userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
          }),
          ensureRoot: Effect.void,
          ensureRunning: () => Effect.succeed([]),
          ensureUserLandofile: Effect.die("must not create"),
          regenerateDist: () => Effect.die("must not regenerate"),
        }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("docker")]),
          capabilities: Effect.succeed(provider.capabilities),
          appliedPlansFor: (target) => Effect.succeed(globalApplied && target === root ? [global] : []),
          resolveAppliedPlan: () => Effect.succeed(globalApplied ? global : undefined),
          resolveTeardownEvidence: () =>
            Effect.succeed(
              globalApplied ? { kind: "applied" as const, plan: global } : { kind: "absent" as const },
            ),
          select: (id) =>
            (typeof id === "string" ? id : id?.provider) === "lando"
              ? Effect.succeed(provider)
              : Effect.die("switch must contact only the previous provider"),
        }),
      ),
    );
    await use({
      run: () =>
        Effect.runPromise(
          switchGlobalProviderForSetup(ProviderId.make("docker")).pipe(Effect.provide(layer), Effect.result),
        ),
      destroys,
      globalApplied: () => globalApplied,
      routeFile,
      user,
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
};

for (const dependent of ["route", "service"] as const) {
  test(`setup refuses a running ${dependent} dependent before retiring the old global app`, async () => {
    await withSwitch({ dependent, running: true }, async (fixture) => {
      const result = await fixture.run();
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AppPlacementError", runningApps: [{ id: "user-app" }] },
      });
      expect(fixture.destroys).toEqual([]);
      expect(fixture.globalApplied()).toBe(true);
    });
  });
}

test("setup retires stopped global dependents, keeps volumes and router files, and reports old user apps", async () => {
  await withSwitch({ dependent: "service", running: false }, async (fixture) => {
    const result = await fixture.run();
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        fromProviderId: "lando",
        toProviderId: "docker",
        remainingApps: [{ kind: "user", id: "user-app", root: fixture.user.root }],
      },
    });
    expect(fixture.destroys).toEqual([{ volumes: false, removeState: true }]);
    expect(fixture.globalApplied()).toBe(false);
    expect(await readFile(fixture.routeFile, "utf8")).toBe("retained dynamic configuration");
  });
});

test("setup permits a running app that has no global dependency", async () => {
  await withSwitch({ dependent: "none", running: true }, async (fixture) => {
    const result = await fixture.run();
    expect(result).toMatchObject({ _tag: "Success", success: { remainingApps: [{ id: "user-app" }] } });
    expect(fixture.destroys).toHaveLength(1);
  });
});
