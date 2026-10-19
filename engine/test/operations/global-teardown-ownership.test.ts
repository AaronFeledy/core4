import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  type ResourceOwnership,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { GlobalAppService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { executeGlobalTeardown, resolveGlobalTeardown } from "../../src/operations/global-teardown.ts";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../../src/providers/managed.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const withHarness = async (
  input: { readonly applied?: boolean; readonly orphan?: boolean; readonly online?: boolean },
  use: (harness: ReturnType<typeof harnessAt>) => Promise<void>,
) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-ownership-"));
  const root = AbsolutePath.make(join(dataRoot, "global"));
  await mkdir(root);
  try {
    await use(harnessAt(dataRoot, input));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
};

const harnessAt = (
  dataRoot: string,
  input: { readonly applied?: boolean; readonly orphan?: boolean; readonly online?: boolean },
) => {
  const root = AbsolutePath.make(join(dataRoot, "global"));
  const app = AppId.make("global");
  const providerId = ProviderId.make("lando");
  const hint: ResourceOwnership = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    providerId,
    appIds: [app],
  };
  const actions: string[] = [];
  const inventoryReads: Array<{ readonly id: ProviderId; readonly root: AbsolutePath }> = [];
  const plan = {
    ...MANAGED_PROVIDER_SELECT_PLAN,
    root,
    identity: { appRoot: root, ownerKey: hint.ownerKey },
  };
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    isAvailable: Effect.succeed(input.online ?? true),
    appliedPlans: Effect.succeed(input.applied ? [plan] : []),
    list: () =>
      Effect.succeed(
        input.orphan
          ? [
              {
                app,
                appRoot: root,
                providerId,
                service: ServiceName.make("orphan"),
                status: "running" as const,
                containerId: "owned-container",
              },
            ]
          : [],
      ),
    listVolumes: () => Effect.succeed([]),
    destroy: () =>
      Effect.sync(() => {
        actions.push("destroy");
        return { kind: "destroyed" as const };
      }),
    removeObservedService: () =>
      Effect.sync(() => {
        actions.push("removeObservedService");
        return { kind: "removed" as const };
      }),
    cleanupOwnedResources: (cleanupRoot: AbsolutePath) =>
      Effect.sync(() => {
        expect(cleanupRoot).toBe(root);
        actions.push("cleanup");
        return {
          servicesRemoved: [ServiceName.make("inventory-service")],
          networksRemoved: 2,
          volumesRemoved: 3,
        };
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
          return id === "lando" ? Effect.succeed(provider) : Effect.die("must not select docker");
        },
        resourceOwnership: (id: ProviderId, inventoryRoot: AbsolutePath) => {
          inventoryReads.push({ id, root: inventoryRoot });
          return id === "lando" ? Effect.succeed(hint) : Effect.die("must not read docker inventory");
        },
        resolveTeardownEvidence: () => Effect.die("must not gather evidence from all providers"),
      }),
    ),
  );
  const teardown = Effect.gen(function* () {
    const resolved = yield* resolveGlobalTeardown();
    return yield* executeGlobalTeardown(resolved, { volumes: true, removeState: true });
  }).pipe(Effect.provide(layer));
  return { root, layer, teardown, actions, inventoryReads };
};

test("global teardown merges managed cleanup into the receipt after destroying applied state", async () => {
  // Given managed applied state and a filesystem ownership inventory at the global root.
  await withHarness({ applied: true }, async (harness) => {
    // When global teardown removes the applied state and owned leftovers.
    const receipt = await Effect.runPromise(harness.teardown);
    // Then cleanup follows destroy and its service/volume counts affect the receipt.
    expect(harness.actions).toEqual(["destroy", "cleanup"]);
    expect(receipt).toEqual({ changed: true, services: ["inventory-service"], volumesRemoved: true });
  });
});

test("global teardown queries only managed inventory when docker is also registered", async () => {
  // Given inventory-only resources and a Docker inventory that must never be queried.
  await withHarness({}, async (harness) => {
    // When global teardown resolves and cleans ownership without an applied plan.
    const receipt = await Effect.runPromise(harness.teardown);
    // Then neither the all-provider resolver nor Docker is needed to find and remove leftovers.
    expect(harness.inventoryReads).toEqual([{ id: ProviderId.make("lando"), root: harness.root }]);
    expect(harness.actions).toEqual(["cleanup"]);
    expect(receipt).toEqual({ changed: true, services: ["inventory-service"], volumesRemoved: true });
  });
});

test("global teardown fails before mutation when managed inventory survives an offline runtime", async () => {
  // Given managed applied state and nonempty inventory but an unavailable runtime.
  await withHarness({ applied: true, online: false }, async (harness) => {
    // When teardown attempts to use that ownership evidence.
    const result = await Effect.runPromise(harness.teardown.pipe(Effect.result));
    // Then the provider failure precedes destroy, observed removal, and cleanup.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", providerId: "lando" },
    });
    expect(harness.actions).toEqual([]);
  });
});

test("global orphan teardown uses prepared managed cleanup without all-provider resolution", async () => {
  // Given a managed orphan and an inventory without applied state.
  await withHarness({ orphan: true }, async (harness) => {
    // When global orphan teardown removes the observed container and owned leftovers.
    const receipt = await Effect.runPromise(harness.teardown);
    // Then managed cleanup runs once, after observed removal, and contributes to the receipt.
    expect(harness.actions).toEqual(["removeObservedService", "cleanup"]);
    expect(harness.inventoryReads).toEqual([{ id: ProviderId.make("lando"), root: harness.root }]);
    expect(receipt).toEqual({
      changed: true,
      services: ["orphan", "inventory-service"],
      volumesRemoved: true,
    });
  });
});
