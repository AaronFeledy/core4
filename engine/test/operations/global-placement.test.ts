import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Schema } from "effect";
import {
  globalCreateProviderId,
  globalObserveProviderId,
  resolveGlobalPlacement,
} from "../../src/global-app/placement.ts";
import { loadObservedGlobalPlan } from "../../src/operations/global-plan.ts";
import { HostProviderOverride, hostProviderId } from "../../src/providers/host-provider.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const root = AbsolutePath.make("/tmp/global-placement/global");
const plan = (provider: string): AppPlan => ({
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root,
  identity: { appRoot: root, ownerKey: "global-owner" },
  provider: ProviderId.make(provider),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "test", runtime: 4 },
});
const layers = (plans: ReadonlyArray<AppPlan>, globalRoot: AbsolutePath = root) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "docker" });
  return Layer.mergeAll(
    BunFileSystem.layer,
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({ plan: () => Effect.die("observation must not plan desired state") }),
    ),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        providerId: Effect.die("placement must resolve through the registry"),
        root: Effect.succeed(globalRoot),
        paths: Effect.succeed({
          root: globalRoot,
          distLandofile: AbsolutePath.make(`${root}/.lando.dist.yml`),
          userLandofile: AbsolutePath.make(`${root}/.lando.yml`),
        }),
        ensureRoot: Effect.void,
        ensureRunning: () => Effect.succeed([]),
        ensureUserLandofile: Effect.succeed({
          path: AbsolutePath.make(`${root}/.lando.yml`),
          created: false,
        }),
        regenerateDist: () => Effect.die("placement must not materialize desired state"),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("docker")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        // Exact canonical-root equality, as the production registry filters.
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: (target) =>
          Effect.succeed(plans.filter((applied) => applied.identity?.appRoot === target)),
        select: () => Effect.die("placement must not construct providers"),
      }),
    ),
  );
};

test("unrealized global creation follows configured Docker", async () => {
  const result = await Effect.runPromise(globalCreateProviderId().pipe(Effect.provide(layers([]))));
  expect(result).toBe(ProviderId.make("docker"));
});

test("setup override wins over a stale configured Docker host", async () => {
  const result = await Effect.runPromise(
    hostProviderId.pipe(
      Effect.provide(layers([])),
      Effect.provideService(HostProviderOverride, ProviderId.make("podman")),
    ),
  );
  expect(result).toBe(ProviderId.make("podman"));
});

test("creation refuses a different realized provider with placement remediation", async () => {
  const result = await Effect.runPromise(
    globalCreateProviderId().pipe(Effect.provide(layers([plan("lando")])), Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "AppPlacementError",
      desiredProviderId: "docker",
      realizedProviderId: "lando",
    },
  });
});

test("placement finds a realization recorded under the canonical root of a symlinked data root", async () => {
  // Given
  const base = await mkdtemp(join(tmpdir(), "lando-global-placement-"));
  try {
    await mkdir(join(base, "real", "global"), { recursive: true });
    await symlink(join(base, "real"), join(base, "link"));
    const canonical = AbsolutePath.make(join(await realpath(join(base, "real")), "global"));
    const applied = {
      ...plan("lando"),
      root: canonical,
      identity: { appRoot: canonical, ownerKey: "global-owner" },
    };
    // When
    const result = await Effect.runPromise(
      globalObserveProviderId.pipe(
        Effect.provide(layers([applied], AbsolutePath.make(join(base, "link", "global")))),
      ),
    );
    // Then
    expect(result).toBe(ProviderId.make("lando"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test.each([
  ["podman", true],
  [undefined, false],
] as const)(
  "LANDO_PROVIDER=%s decides whether placement remediation names the environment",
  async (env, named) => {
    // Given
    const previous = process.env.LANDO_PROVIDER;
    if (env === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
    else process.env.LANDO_PROVIDER = env;
    try {
      // When
      const result = await Effect.runPromise(
        globalCreateProviderId().pipe(Effect.provide(layers([plan("lando")])), Effect.flip),
      );
      // Then
      expect(result.remediation?.includes("LANDO_PROVIDER")).toBe(named);
      expect(result.remediation).toContain("lando global:destroy --provider=lando --yes");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      else process.env.LANDO_PROVIDER = previous;
    }
  },
);

test("observation follows the realized provider and reuses its applied plan", async () => {
  const applied = plan("lando");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* globalObserveProviderId;
      const observed = yield* loadObservedGlobalPlan();
      return { provider, observed };
    }).pipe(Effect.provide(layers([applied]))),
  );
  expect(result).toMatchObject({ provider: "lando", observed: { materialized: true, plan: applied } });
});

test("two realized providers fail closed without runtime initialization", async () => {
  const result = await Effect.runPromise(
    resolveGlobalPlacement().pipe(Effect.provide(layers([plan("lando"), plan("docker")])), Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "AppResolveError", reason: "ambiguous" },
  });
});

test("two applied plans on one provider fail closed as ambiguous", async () => {
  // Given
  const duplicates = [plan("docker"), { ...plan("docker"), id: AppId.make("global-duplicate") }];
  // When
  const error = await Effect.runPromise(
    resolveGlobalPlacement().pipe(Effect.provide(layers(duplicates)), Effect.flip),
  );
  // Then
  expect(error).toMatchObject({
    _tag: "AppResolveError",
    reason: "ambiguous",
    detail: "provider-resources",
    remediation: expect.any(String),
  });
});
