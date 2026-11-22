import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ProviderRuntimeSnapshot } from "@lando/sdk/services";
import { DateTime } from "effect";
import { localAppliedRecord, scopeRuntimeSnapshot } from "../../src/operations/data-root-scope.ts";

const dataRoot = AbsolutePath.make("/data/local");
const foreignRoot = AbsolutePath.make("/data/foreign");
const appRoot = AbsolutePath.make("/apps/demo");
const providerId = ProviderId.make("lando");
const app = AppId.make("demo");
const web = ServiceName.make("web");

const webPlan: ServicePlan = {
  name: web,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};

const basePlan = (): AppPlan => ({
  id: app,
  name: "demo",
  slug: "demo",
  root: appRoot,
  identity: { appRoot, ownerKey: "owner", dataRoot },
  provider: providerId,
  services: { [web]: webPlan },
  routes: [],
  stores: [{ name: "data", scope: "app", kind: "data" }],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
});

const snapshot = (overrides: Partial<ProviderRuntimeSnapshot> = {}): ProviderRuntimeSnapshot => ({
  providerId,
  runtimeObserved: true,
  appliedPlans: [],
  services: [],
  volumes: [],
  ...overrides,
});

test("localAppliedRecord keeps historical plans without a data root stamp", () => {
  const historical = { ...basePlan(), identity: { appRoot, ownerKey: "owner" } };
  const stamped = basePlan();
  const foreign = {
    ...basePlan(),
    identity: { appRoot, ownerKey: "owner", dataRoot: foreignRoot },
  };
  expect(localAppliedRecord(historical, dataRoot)).toBe(true);
  expect(localAppliedRecord(stamped, dataRoot)).toBe(true);
  expect(localAppliedRecord(foreign, dataRoot)).toBe(false);
});

test("scopeRuntimeSnapshot retains local plans without treating them as proof for unlabeled resources", () => {
  const historical = { ...basePlan(), identity: { appRoot, ownerKey: "owner" } };
  const unlabeled = {
    app,
    appRoot,
    service: web,
    providerId,
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "web-1",
  };
  const foreignLabeled = {
    ...unlabeled,
    containerId: "web-foreign",
    labels: { [LANDO_DATA_ROOT_LABEL]: foreignRoot },
  };
  const localLabeled = {
    ...unlabeled,
    containerId: "web-local",
    labels: { [LANDO_DATA_ROOT_LABEL]: dataRoot },
  };
  const input = snapshot({
    appliedPlans: [
      historical,
      { ...basePlan(), identity: { appRoot, ownerKey: "owner", dataRoot: foreignRoot } },
    ],
    services: [unlabeled, foreignLabeled, localLabeled],
    volumes: [
      {
        ref: { app, store: "data" },
        identity: {
          coordinationKey: "data",
          nativeName: "data",
          generation: "1",
          ownerRoot: appRoot,
          origin: "created" as const,
        },
      },
      {
        ref: { app, store: "data" },
        labels: { [LANDO_DATA_ROOT_LABEL]: foreignRoot },
        identity: {
          coordinationKey: "foreign-data",
          nativeName: "foreign-data",
          generation: "1",
          ownerRoot: appRoot,
          origin: "created" as const,
        },
      },
    ],
  });
  const scoped = scopeRuntimeSnapshot(input, dataRoot);
  expect(scoped.appliedPlans).toEqual([historical]);
  expect(scoped.services.map((service) => service.containerId)).toEqual(["web-local"]);
  expect(scoped.volumes).toEqual([]);
});

test("scopeRuntimeSnapshot keeps only the exact unlabeled container named by a receipt", () => {
  const unlabeled = {
    app,
    appRoot,
    service: web,
    providerId,
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "inventory-web",
    nativeName: "web-native",
  };
  const other = {
    ...unlabeled,
    service: ServiceName.make("db"),
    containerId: "other-web",
  };
  const scoped = scopeRuntimeSnapshot(snapshot({ services: [unlabeled, other] }), dataRoot, [
    {
      providerId,
      appRoot,
      appId: app,
      kind: "container",
      nativeName: "web-native",
      dataRoot,
      nativeId: "inventory-web",
    },
  ]);
  expect(scoped.services.map((service) => service.containerId)).toEqual(["inventory-web"]);
});
