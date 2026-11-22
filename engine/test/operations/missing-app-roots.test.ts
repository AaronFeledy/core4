import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { FileIoError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  ServiceName,
  type VolumeInfo,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  FileSystem,
  PathsService,
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { type Context, DateTime, Effect } from "effect";
import { findMissingAppRoots, scanMissingAppRoots } from "../../src/operations/missing-app-roots.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const root = AbsolutePath.make("/missing/app");
const dataRoot = "/missing/test-data-root";
const labelsHere = { [LANDO_DATA_ROOT_LABEL]: dataRoot };
const app = AppId.make("app");
const providerId = ProviderId.make("lando");
const plan: AppPlan = {
  id: app,
  name: "app",
  slug: "app",
  root,
  identity: { appRoot: root, ownerKey: "owner" },
  provider: providerId,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
};
/** A plan recorded at `at`, the way every current build records it. */
const planAt = (at: string): AppPlan => ({
  ...plan,
  root: AbsolutePath.make(at),
  identity: { appRoot: AbsolutePath.make(at), ownerKey: "owner" },
});
const service = {
  app,
  appRoot: root,
  service: ServiceName.make("web"),
  providerId,
  status: "running" as const,
  publications: { status: "unknown" as const },
  containerId: "observed-container",
  labels: labelsHere,
};
const volume = (name: string, labels: Readonly<Record<string, string>> = {}): VolumeInfo => ({
  ref: { app, store: name },
  labels: { ...labelsHere, ...labels },
  identity: { coordinationKey: name, nativeName: name, generation: "1", ownerRoot: root, origin: "created" },
});
const snapshot = (overrides: Partial<ProviderRuntimeSnapshot> = {}): ProviderRuntimeSnapshot => ({
  providerId,
  runtimeObserved: true,
  appliedPlans: [],
  services: [],
  volumes: [],
  ...overrides,
});
const run = (
  snapshots: ReadonlyArray<ProviderRuntimeSnapshot> | undefined,
  exists: Context.Service.Shape<typeof FileSystem>["exists"] = () => Effect.succeed(false),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* findMissingAppRoots.pipe(
        Effect.provideService(FileSystem, { ...fs, exists }),
        Effect.provideService(RuntimeProviderRegistry, {
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
          ...(snapshots === undefined ? {} : { observeRuntime: Effect.succeed(snapshots) }),
        }),
      );
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(PathsService, makeLandoPaths({ userDataRoot: dataRoot })),
    ),
  );

test("retains applied state without counting a service whose container is gone", async () => {
  const { containerId: _containerId, ...gone } = service;
  const result = await run([snapshot({ appliedPlans: [plan], services: [gone] })]);
  expect(result).toMatchObject([{ appliedState: true, services: [] }]);
});

test("groups applied state, services and native data/cache volumes across providers", async () => {
  const result = await run([
    snapshot({
      appliedPlans: [plan],
      services: [service, service],
      volumes: [volume("data"), volume("cache", { "dev.lando.storage-kind": "cache" })],
    }),
    snapshot({
      providerId: ProviderId.make("docker"),
      services: [{ ...service, app: AppId.make("other"), service: ServiceName.make("db") }],
    }),
  ]);
  expect(result).toEqual([
    {
      root,
      apps: [app, AppId.make("other")],
      providers: [ProviderId.make("docker"), providerId],
      appliedState: true,
      runtimeObserved: true,
      fileSyncCopiesRemovable: true,
      services: ["app/web", "other/db"],
      dataVolumes: ["data"],
      cacheVolumes: ["cache"],
      journals: [],
    },
  ]);
});

test("returns only missing roots and treats filesystem failures as present", async () => {
  const result = await run(
    [
      snapshot({
        appliedPlans: [plan, planAt("/present"), planAt("/denied")],
      }),
    ],
    (path) =>
      path === "/denied"
        ? Effect.fail(
            new FileIoError({
              path,
              message: "denied",
              remediation:
                "Ensure the reported path exists and is readable/writable by this user, then re-run the command.",
            }),
          )
        : Effect.succeed(path === "/present"),
  );
  expect(result.map((item) => item.root)).toEqual([root]);
});

test("supports registries without the optional observer", async () => {
  expect(await run(undefined)).toEqual([]);
});

test.each([
  "global-plan",
  "global-service",
  "global-volume",
  "global-scope",
  "scratch-plan",
  "scratch-service",
  "scratch-volume",
  "unowned-volume",
  "unowned-service",
])("excludes %s evidence", async (kind) => {
  const evidence = {
    "global-plan": snapshot({ appliedPlans: [{ ...plan, id: AppId.make("global") }] }),
    "global-service": snapshot({ services: [{ ...service, app: AppId.make("global") }] }),
    "global-volume": snapshot({
      volumes: [{ ...volume("data"), ref: { app: AppId.make("global"), store: "data" } }],
    }),
    "global-scope": snapshot({ volumes: [volume("data", { "dev.lando.scope": "global" })] }),
    "scratch-plan": snapshot({ appliedPlans: [{ ...plan, extensions: { "@lando/core/scratch": {} } }] }),
    "scratch-service": snapshot({
      services: [{ ...service, labels: { ...labelsHere, "dev.lando.scratch": "TRUE" } }],
    }),
    "scratch-volume": snapshot({ volumes: [volume("data", { "dev.lando.scratch": "TRUE" })] }),
    "unowned-volume": snapshot({ volumes: [{ ref: { app, store: "data" } }] }),
    "unowned-service": snapshot({
      services: [
        { app, service: service.service, providerId, status: "running", publications: { status: "unknown" } },
      ],
    }),
  }[kind];
  expect(await run(evidence === undefined ? [] : [evidence])).toEqual([]);
});

test("groups plans by their recorded identity root and sorts roots deterministically", async () => {
  const result = await run([
    snapshot({ appliedPlans: [{ ...plan, root: AbsolutePath.make("/unused") }, planAt("/aaa")] }),
  ]);
  expect(result.map((item) => item.root)).toEqual([AbsolutePath.make("/aaa"), root]);
});

test("ignores applied plans without an identity, which teardown cannot target", async () => {
  const { identity: _identity, ...withoutIdentity } = plan;
  const result = await run([snapshot({ appliedPlans: [withoutIdentity] })]);
  expect(result).toEqual([]);
});

test("marks a root partially observed only when a contributing provider was not observed", async () => {
  const result = await run([
    snapshot({ appliedPlans: [plan] }),
    snapshot({
      providerId: ProviderId.make("docker"),
      runtimeObserved: false,
      appliedPlans: [{ ...plan, provider: ProviderId.make("docker") }],
    }),
    snapshot({
      providerId: ProviderId.make("podman"),
      runtimeObserved: false,
      appliedPlans: [planAt("/other")],
    }),
  ]);
  expect(result.find((item) => item.root === root)).toMatchObject({
    runtimeObserved: false,
    providers: ["docker", "lando"],
  });
});

test("ignores unrelated unobserved providers", async () => {
  const result = await run([
    snapshot({
      services: [
        service,
        {
          ...service,
          appRoot: AbsolutePath.make("/missing/foreign"),
          labels: { [LANDO_DATA_ROOT_LABEL]: "/missing/foreign-data-root" },
        },
      ],
    }),
    snapshot({ providerId: ProviderId.make("docker"), runtimeObserved: false }),
  ]);
  expect(result).toMatchObject([{ appliedState: false, runtimeObserved: true, providers: ["lando"] }]);
});

test.each(["none", "plan", "ownership", "unreadable"] as const)(
  "scan records provider state from %s without launching it",
  async (source) => {
    const inventory = await Effect.runPromise(
      scanMissingAppRoots().pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("State inventory must not select a runtime without journal copies"),
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          hasRecordedOwnership: () => Effect.succeed(source === "ownership"),
          appliedStateInventory: () =>
            Effect.succeed({
              plans: source === "plan" ? [plan] : [],
              unreadable: source === "unreadable" ? [{ path: "/state/broken" }] : [],
            }),
          observeRuntime: Effect.succeed([snapshot({ runtimeObserved: false })]),
        }),
        Effect.provideService(PathsService, makeLandoPaths({ userDataRoot: dataRoot })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    expect(inventory.scans[0]?.recordedState).toBe(source !== "none");
  },
);

test("keeps the local applied record but does not claim its unlabeled services", async () => {
  const historical = {
    ...plan,
    identity: { appRoot: root, ownerKey: "owner" },
    services: { [String(service.service)]: {} as never },
  };
  const { labels: _omitLabels, ...unlabeled } = service;
  const result = await run([
    snapshot({
      appliedPlans: [historical],
      services: [
        unlabeled,
        {
          ...unlabeled,
          containerId: "foreign",
          labels: { [LANDO_DATA_ROOT_LABEL]: "/missing/foreign-data-root" },
        },
      ],
    }),
  ]);
  expect(result).toMatchObject([
    {
      root,
      appliedState: true,
      services: [],
    },
  ]);
});

test("drops unlabeled services without local plan membership under a data root", async () => {
  const { labels: _omitLabels, ...unlabeled } = service;
  expect(await run([snapshot({ services: [unlabeled] })])).toEqual([]);
});

test.each(["unreadable", "missing"] as const)(
  "reports an %s ownership inventory accurately in the GC scan",
  async (state) => {
    const otherProvider = ProviderId.make("docker");
    const { labels: _labels, ...legacy } = service;
    const result = await Effect.runPromise(
      scanMissingAppRoots().pipe(
        Effect.provide(BunFileSystem.layer),
        Effect.provideService(PathsService, makeLandoPaths({ userDataRoot: dataRoot })),
        Effect.provideService(RuntimeProviderRegistry, {
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
          list: Effect.succeed([providerId, otherProvider]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
          observeRuntime: Effect.succeed([
            snapshot({ services: [legacy] }),
            snapshot({ providerId: otherProvider }),
          ]),
          resourceOwnership: (id) =>
            state === "unreadable" && id === providerId
              ? Effect.fail(
                  new ProviderUnavailableError({
                    providerId,
                    operation: "resource-ownership",
                    message: "Resource ownership inventory could not be read.",
                    remediation: "Repair the provider plugin state.",
                  }),
                )
              : Effect.succeed(undefined),
        }),
      ),
    );

    expect(result.candidates).toEqual([]);
    expect(result.scans).toMatchObject([
      state === "unreadable"
        ? {
            providerId,
            runtimeObserved: true,
            complete: false,
            errorTag: "ProviderUnavailableError",
            remediation: expect.stringMatching(/ownership inventory/i),
          }
        : { providerId, runtimeObserved: true, complete: true },
      { providerId: otherProvider, complete: true },
    ]);
    if (state === "missing") expect(result.scans[0]?.errorTag).toBeUndefined();
  },
);

test("verified adoption receipts keep unlabeled missing-root services", async () => {
  const { labels: _labels, ...unlabeled } = service;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* findMissingAppRoots.pipe(
        Effect.provideService(FileSystem, { ...fs, exists: () => Effect.succeed(false) }),
        Effect.provideService(RuntimeProviderRegistry, {
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
          resourceOwnership: () =>
            Effect.succeed({
              appRoot: root,
              ownerKey: appIdentityKey("owner", root),
              providerId,
              appIds: [app],
              members: [
                {
                  kind: "container" as const,
                  nativeName: "observed-container",
                  nativeId: "observed-container",
                  dataRoot: AbsolutePath.make(dataRoot),
                  appId: app,
                  service: ServiceName.make("web"),
                },
              ],
            }),
          observeRuntime: Effect.succeed([
            snapshot({ services: [{ ...unlabeled, nativeName: "observed-container" }] }),
          ]),
        }),
      );
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(PathsService, makeLandoPaths({ userDataRoot: dataRoot })),
    ),
  );
  expect(result).toMatchObject([{ root, services: ["app/web"], appliedState: false }]);
});
