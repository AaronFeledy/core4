import { expect, test } from "bun:test";
import { SCRATCH_LABEL } from "@lando/container-runtime/labels";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime } from "effect";
import { scopeRuntimeSnapshot } from "../../src/operations/data-root-scope.ts";
import { deriveRunningTargets } from "../../src/operations/running-inventory.ts";

test("selects scratch containers with uncertain status and skips terminal containers", () => {
  const providerId = ProviderId.make("lando");
  const services: ServiceRuntimeInfo[] = (["unknown", "removing", "exited", "dead", "absent"] as const).map(
    (status) => ({
      app: AppId.make(`scratch-${status}`),
      appRoot: AbsolutePath.make(`/scratch/${status}`),
      service: ServiceName.make("web"),
      providerId,
      status,
      labels: { [SCRATCH_LABEL]: "TRUE" },
      publications: { status: "unknown" },
    }),
  );
  const result = deriveRunningTargets(
    [{ providerId, runtimeObserved: true, appliedPlans: [], services, volumes: [] }],
    [],
  );
  expect([...result.scratchObserved.keys()]).toEqual(["scratch-unknown", "scratch-removing"]);
  expect([...result.userTargets]).toEqual([]);
  expect(result.failures).toEqual([]);
});

test("poweroff inventory keeps only the native container proved by an adoption receipt", () => {
  const dataRoot = "/running/data";
  const appRoot = AbsolutePath.make("/running/app");
  const providerId = ProviderId.make("lando");
  const app = AppId.make("app");
  const web = ServiceName.make("web");
  const plan = {
    id: app,
    name: "app",
    slug: "app",
    root: appRoot,
    identity: { appRoot, ownerKey: "owner" },
    provider: providerId,
    services: { [String(web)]: {} as never },
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
  } satisfies AppPlan;
  const unlabeled = {
    app,
    appRoot,
    service: web,
    providerId,
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "running-web",
    nativeName: "legacy-web",
  };
  const foreign = {
    ...unlabeled,
    containerId: "foreign-web",
    labels: { [LANDO_DATA_ROOT_LABEL]: "/running/foreign" },
  };
  const scoped = scopeRuntimeSnapshot(
    {
      providerId,
      runtimeObserved: true,
      appliedPlans: [plan],
      services: [unlabeled, foreign],
      volumes: [],
    },
    dataRoot,
    [
      {
        kind: "container",
        nativeName: "legacy-web",
        nativeId: "running-web",
        appRoot,
        appId: app,
        providerId,
        dataRoot,
      },
    ],
  );
  expect(scoped.services.map((service) => service.containerId)).toEqual(["running-web"]);
  const targets = deriveRunningTargets([scoped], []);
  expect([...targets.userTargets.values()].map((target) => String(target.appRoot))).toEqual([
    String(appRoot),
  ]);
});
