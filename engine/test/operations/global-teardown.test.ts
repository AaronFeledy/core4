import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type VolumeInfo,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  GlobalAppService,
  PathsService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { executeGlobalTeardown, resolveGlobalTeardown } from "../../src/operations/global-teardown.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("global");
const planAt = (root: AbsolutePath): AppPlan => ({
  id: appId,
  name: "global",
  slug: "global",
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  provider: providerId,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "applied-state", runtime: 4 },
  extensions: {},
});

const withRoot = async (use: (dataRoot: string, root: AbsolutePath) => Promise<void>) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-teardown-"));
  const root = AbsolutePath.make(join(dataRoot, "global"));
  await mkdir(root);
  try {
    await use(dataRoot, root);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
};

const serviceAt = (root: AbsolutePath): ServiceRuntimeInfo => ({
  app: appId,
  appRoot: root,
  providerId,
  service: ServiceName.make("orphan"),
  status: "running",
  containerId: "observed-container",
});

const volumeAt = (root: AbsolutePath, scope: "app" | "global"): VolumeInfo => ({
  ref: { app: appId, store: scope },
  labels: { "dev.lando.scope": scope },
  identity: {
    ownerRoot: root,
    nativeName: scope,
    coordinationKey: scope,
    generation: `generation-${scope}`,
    origin: "created",
  },
});

const harnessAt = (
  dataRoot: string,
  input: {
    readonly plan?: AppPlan;
    readonly services?: ReadonlyArray<ServiceRuntimeInfo>;
    readonly volumes?: ReadonlyArray<VolumeInfo>;
  },
) => {
  const root = AbsolutePath.make(join(dataRoot, "global"));
  const selected: Array<string | undefined> = [];
  const removedServices: ServiceRuntimeInfo[] = [];
  const removedVolumes: string[] = [];
  const destroyed: AppPlan[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    appliedPlans: Effect.succeed(input.plan === undefined ? [] : [input.plan]),
    list: () => Effect.succeed(input.services ?? []),
    listVolumes: () => Effect.succeed(input.volumes ?? []),
    removeObservedService: (service: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        removedServices.push(service);
        return { kind: "removed" as const };
      }),
    removeVolume: (ref: VolumeInfo["ref"]) =>
      Effect.sync(() => {
        removedVolumes.push(ref.store);
      }),
    destroy: (target: { readonly plan?: AppPlan }) =>
      Effect.sync(() => {
        if (target.plan !== undefined) destroyed.push(target.plan);
        return { kind: "destroyed" as const };
      }),
  };
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: dataRoot, env: {}, platform: "linux" })),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(root),
        ensureRoot: Effect.die("no desired root mutation"),
        paths: Effect.succeed({
          root,
          distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
          userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
        }),
        ensureUserLandofile: Effect.die("no desired YAML"),
        ensureRunning: () => Effect.die("no startup"),
        regenerateDist: () => Effect.die("no desired materialization"),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([providerId, ProviderId.make("docker")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: (target) => {
          const id = typeof target === "string" ? target : target?.provider;
          selected.push(id);
          return id === "lando" ? Effect.succeed(provider) : Effect.die("must not select default Docker");
        },
        resolveTeardownEvidence: () => Effect.die("must not gather evidence from all providers"),
      }),
    ),
  );
  return { layer, selected, removedServices, removedVolumes, destroyed };
};

test("global teardown selects only managed-provider evidence at the explicit global root", async () => {
  await withRoot(async (dataRoot, root) => {
    // Given a default Docker provider and a managed applied plan without a dist file.
    const plan = planAt(root);
    const harness = harnessAt(dataRoot, { plan });
    // When global evidence resolves independently of cwd and desired materialization.
    const resolved = await Effect.runPromise(resolveGlobalTeardown().pipe(Effect.provide(harness.layer)));
    // Then managed applied evidence is available while materialized keeps its dist-existence meaning.
    expect(resolved.evidence).toEqual({ kind: "applied", plan });
    expect(resolved.materialized).toBe(false);
    expect(harness.selected).toEqual(["lando", "lando"]);
  });
});

for (const detail of ["owner-key", "canonical-root", "applied-state-provider"] as const) {
  test(`global teardown refuses mismatched ${detail} before mutation`, async () => {
    await withRoot(async (dataRoot, root) => {
      const plan = planAt(root);
      const invalid =
        detail === "owner-key"
          ? { ...plan, identity: { appRoot: root, ownerKey: "wrong" } }
          : detail === "canonical-root"
            ? { ...plan, root: AbsolutePath.make(join(dataRoot, "other")) }
            : { ...plan, provider: ProviderId.make("docker") };
      const harness = harnessAt(dataRoot, { plan: invalid });
      const result = await Effect.runPromise(
        resolveGlobalTeardown().pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AppResolveError", reason: "mismatch", detail },
      });
      expect(harness.destroyed).toEqual([]);
      expect(harness.removedServices).toEqual([]);
    });
  });
}

for (const volumes of [false, true]) {
  test(`global orphan teardown removes observed containers with volumes=${volumes}`, async () => {
    await withRoot(async (dataRoot, root) => {
      // Given owned global orphans, a foreign-root container, and both volume scopes.
      const owned = serviceAt(root);
      const foreign = {
        ...owned,
        appRoot: AbsolutePath.make(join(dataRoot, "foreign")),
        containerId: "foreign-container",
      };
      const harness = harnessAt(dataRoot, {
        services: [owned, foreign],
        volumes: [volumeAt(root, "app"), volumeAt(root, "global")],
      });
      // When teardown uses the observed-identity orphan path and its scoped lock.
      const receipt = await Effect.runPromise(
        Effect.gen(function* () {
          const resolved = yield* resolveGlobalTeardown();
          return yield* executeGlobalTeardown(resolved, { volumes, removeState: volumes });
        }).pipe(Effect.provide(harness.layer)),
      );
      // Then only owned containers and requested app-scoped data are removed.
      expect(receipt).toEqual({ changed: true, services: ["orphan"], volumesRemoved: volumes });
      expect(harness.removedServices).toEqual([owned]);
      expect(harness.removedVolumes).toEqual(volumes ? ["app"] : []);
      expect(harness.destroyed).toEqual([]);
      expect(harness.selected).toEqual(["lando", "lando"]);
    });
  });
}

test("global teardown ignores foreign-root applied and observed resources", async () => {
  await withRoot(async (dataRoot) => {
    const foreignRoot = AbsolutePath.make(join(dataRoot, "foreign"));
    const harness = harnessAt(dataRoot, {
      plan: planAt(foreignRoot),
      services: [serviceAt(foreignRoot)],
      volumes: [volumeAt(foreignRoot, "app")],
    });
    const resolved = await Effect.runPromise(resolveGlobalTeardown().pipe(Effect.provide(harness.layer)));
    expect(resolved.evidence).toEqual({ kind: "absent" });
    expect(harness.destroyed).toEqual([]);
    expect(harness.removedServices).toEqual([]);
    expect(harness.removedVolumes).toEqual([]);
  });
});
