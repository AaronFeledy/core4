import { expect, test } from "bun:test";
import { FileIoError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type VolumeInfo,
} from "@lando/sdk/schema";
import { FileSystem, type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { type Context, DateTime, Effect } from "effect";
import { findMissingAppRoots } from "../../src/operations/missing-app-roots.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const root = AbsolutePath.make("/missing/app");
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
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.unsafeMake("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
};
const service = { app, appRoot: root, service: ServiceName.make("web"), providerId, status: "running" };
const volume = (name: string, labels: Readonly<Record<string, string>> = {}): VolumeInfo => ({
  ref: { app, store: name },
  labels,
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
  exists: Context.Tag.Service<typeof FileSystem>["exists"] = () => Effect.succeed(false),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* findMissingAppRoots.pipe(
        Effect.provideService(FileSystem, { ...fs, exists }),
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
          ...(snapshots === undefined ? {} : { observeRuntime: Effect.succeed(snapshots) }),
        }),
      );
    }).pipe(Effect.provide(FileSystemLive)),
  );

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
      services: ["app/web", "other/db"],
      dataVolumes: ["data"],
      cacheVolumes: ["cache"],
    },
  ]);
});

test("returns only missing roots and treats filesystem failures as present", async () => {
  const result = await run(
    [
      snapshot({
        appliedPlans: [
          plan,
          { ...plan, root: AbsolutePath.make("/present"), identity: undefined },
          { ...plan, root: AbsolutePath.make("/denied"), identity: undefined },
        ],
      }),
    ],
    (path) =>
      path === "/denied"
        ? Effect.fail(new FileIoError({ path, message: "denied" }))
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
    "scratch-service": snapshot({ services: [{ ...service, labels: { "dev.lando.scratch": "TRUE" } }] }),
    "scratch-volume": snapshot({ volumes: [volume("data", { "dev.lando.scratch": "TRUE" })] }),
    "unowned-volume": snapshot({ volumes: [{ ref: { app, store: "data" } }] }),
    "unowned-service": snapshot({ services: [{ app, service: service.service, providerId, status: "running" }] }),
  }[kind];
  expect(await run(evidence === undefined ? [] : [evidence])).toEqual([]);
});

test("uses identity roots before legacy roots and sorts roots deterministically", async () => {
  const result = await run([
    snapshot({
      appliedPlans: [
        { ...plan, root: AbsolutePath.make("/unused") },
        { ...plan, root: AbsolutePath.make("/aaa"), identity: undefined },
      ],
    }),
  ]);
  expect(result.map((item) => item.root)).toEqual([AbsolutePath.make("/aaa"), root]);
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
      appliedPlans: [{ ...plan, root: AbsolutePath.make("/other"), identity: undefined }],
    }),
  ]);
  expect(result.find((item) => item.root === root)).toMatchObject({
    runtimeObserved: false,
    providers: ["docker", "lando"],
  });
});

test("ignores unrelated unobserved providers", async () => {
  const result = await run([
    snapshot({ services: [service] }),
    snapshot({ providerId: ProviderId.make("docker"), runtimeObserved: false }),
  ]);
  expect(result).toMatchObject([{ appliedState: false, runtimeObserved: true, providers: ["lando"] }]);
});
