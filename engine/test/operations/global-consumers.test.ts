import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  readGlobalConsumerImpact,
  resolveGlobalConsumerImpact,
} from "../../src/operations/global-consumers.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { plan as base } from "./global-stop-selection-fixture.ts";

const providerId = ProviderId.make("lando");
const firstService = Object.values(base.services)[0];
const firstRoute = base.routes[0];
if (firstService === undefined || firstRoute === undefined)
  throw new Error("Expected global service fixtures.");
const app = (
  id = "user",
  options: {
    scratch?: boolean;
    requires?: string[];
    routed?: boolean;
    routing?: boolean;
    provider?: string;
  } = {},
): AppPlan => ({
  ...base,
  id: AppId.make(id),
  name: id,
  provider: ProviderId.make(options.provider ?? "lando"),
  root: AbsolutePath.make("/tmp/consumer/source"),
  identity: { appRoot: AbsolutePath.make("/tmp/consumer/source"), ownerKey: id },
  routes: options.routed ? base.routes : [],
  router: { enabled: options.routing ?? true },
  requires: { globalServices: options.requires ?? ["mail"] },
  extensions: options.scratch ? { [SCRATCH_EXTENSION_KEY]: {} } : {},
});
const row = (plan: AppPlan, extra: Partial<ServiceRuntimeInfo> = {}): ServiceRuntimeInfo => ({
  app: plan.id,
  appRoot: plan.root,
  providerId: plan.provider,
  service: firstService.name,
  status: "running",
  containerId: `container-${plan.id}`,
  publications: { status: "unknown" },
  ...extra,
});
const resolve = (
  plans: AppPlan[],
  services: ServiceRuntimeInfo[],
  selectedIds = ["mail"],
  routerId = "router-custom",
) => resolveGlobalConsumerImpact({ providerId, selectedIds, routerId, plans, services });

test("reports user and scratch consumers separately even when they share a source root", () => {
  const user = app();
  const scratch = app("scratch-1", { scratch: true });
  const impact = resolve([user, scratch], [row(user), row(scratch)]);
  expect(impact.consumers.map((consumer) => [consumer.id, consumer.kind])).toEqual([
    ["scratch-1", "scratch"],
    ["user", "user"],
  ]);
  expect(impact.uncertainties).toEqual([]);
});

test("protects legacy routed apps using the actual configured router id", () => {
  const routed = app("legacy", { requires: [], routed: true });
  expect(resolve([routed], [row(routed)], ["router-custom"]).consumers[0]).toMatchObject({
    id: "legacy",
    globalServices: ["router-custom"],
    routes: expect.arrayContaining([firstRoute.hostname]),
  });
  expect(resolve([routed], [row(routed)], ["mail"]).consumers).toEqual([]);
  const disabled = app("routing-off", { requires: [], routed: true, routing: false });
  expect(resolve([disabled], [row(disabled)], ["router-custom"]).consumers).toEqual([]);
});

test("ignores stopped consumers and records active service-level orphan uncertainty", () => {
  const plan = app();
  expect(resolve([plan], [row(plan, { status: "stopped" })]).consumers).toEqual([]);
  const orphan = { ...plan, services: {} };
  const impact = resolve([orphan], [row(plan)]);
  expect(impact.uncertainties.join(" ")).toContain("no unique readable applied service");
});

test("incomplete roots, foreign provider claims and duplicate identities cannot prove absence", () => {
  const plan = app();
  const { appRoot: _root, ...missingRoot } = row(plan);
  expect(resolve([plan], [missingRoot]).uncertainties.join(" ")).toContain("incomplete");
  expect(
    resolve([plan], [row(plan, { providerId: ProviderId.make("docker") })]).uncertainties.join(" "),
  ).toContain("incomplete");
  expect(
    resolve([plan], [row(plan), row(plan, { containerId: "duplicate" })]).uncertainties.join(" "),
  ).toContain("ambiguous");
});

test("strict inspection retains known consumers alongside unreadable evidence and never starts runtimes", async () => {
  const plan = app();
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedPlansFor: () => Effect.die("Root-only enumeration cannot prove consumer absence."),
    resolveAppliedPlan: () => Effect.die("not used"),
    resolveTeardownEvidence: () => Effect.die("not used"),
    appliedStateInventory: () =>
      Effect.succeed({ plans: [plan], unreadable: [{ path: "/state/broken.json" }] }),
    select: () =>
      Effect.succeed({
        ...TestRuntimeProvider,
        id: providerId,
        ensureReady: Effect.die("Consumer inspection must never start the runtime."),
        list: (filter) => {
          expect(filter).toEqual({ includeUnplanned: true, includeScratch: true });
          return Effect.succeed([row(plan)]);
        },
      }),
  });
  const impact = await Effect.runPromise(
    readGlobalConsumerImpact({ providerId, selectedIds: ["mail"], routerId: "custom" }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
    ),
  );
  expect(impact.consumers[0]?.id).toBe("user");
  expect(impact.uncertainties.join(" ")).toContain("/state/broken.json");
});

test("audits old cross-provider requirement claims but does not probe unrelated empty providers", async () => {
  const docker = ProviderId.make("docker");
  const empty = ProviderId.make("unused");
  const legacy = app("legacy-cross-provider", { provider: "docker" });
  const selected: string[] = [];
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([providerId, docker, empty]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedPlansFor: () => Effect.die("not used"),
    resolveAppliedPlan: () => Effect.die("not used"),
    resolveTeardownEvidence: () => Effect.die("not used"),
    appliedStateInventory: (id) => Effect.succeed({ plans: id === docker ? [legacy] : [], unreadable: [] }),
    select: (id) =>
      Effect.sync(() => {
        selected.push(String(id));
        return {
          ...TestRuntimeProvider,
          id: String(id),
          list: () => Effect.succeed(id === docker ? [row(legacy)] : []),
        };
      }),
  });
  const impact = await Effect.runPromise(
    readGlobalConsumerImpact({ providerId, selectedIds: ["mail"], routerId: "custom" }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
    ),
  );
  expect(impact.consumers[0]).toMatchObject({ id: "legacy-cross-provider", provider: "docker" });
  expect(selected).toEqual(["lando", "docker"]);
});

test("offline inspection is uncertainty and empty selections avoid all provider work", async () => {
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedPlansFor: () => Effect.die("not used"),
    resolveAppliedPlan: () => Effect.die("not used"),
    resolveTeardownEvidence: () => Effect.die("not used"),
    appliedStateInventory: () => Effect.succeed({ plans: [app()], unreadable: [] }),
    select: () =>
      Effect.succeed({ ...TestRuntimeProvider, id: providerId, isAvailable: Effect.succeed(false) }),
  });
  const impact = await Effect.runPromise(
    readGlobalConsumerImpact({ providerId, selectedIds: ["mail"], routerId: "custom" }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
    ),
  );
  expect(impact.consumers).toEqual([]);
  expect(impact.uncertainties.join(" ")).toContain("unreachable");
  const empty = await Effect.runPromise(
    readGlobalConsumerImpact({ selectedIds: [], routerId: "custom" }).pipe(
      Effect.provideService(RuntimeProviderRegistry, {
        ...registry,
        list: Effect.die("Empty selections must not inspect providers."),
      }),
    ),
  );
  expect(empty).toEqual({ consumers: [], uncertainties: [] });
});
