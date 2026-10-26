import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type BindMountPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";

const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "info-storage", runtime: 4 as const };
export const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("podman"),
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
export const plan: AppPlan = {
  id: AppId.make("storage-info"),
  name: "storage-info",
  slug: "storage-info",
  root: AbsolutePath.make("/host/app"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
/** Full resolved app-source bind; used as ServiceInfo.appMount projection shape and plan fixture. */
export const appMount = {
  type: "bind" as const,
  role: "app" as const,
  source: plan.root,
  target: PortablePath.make("/app"),
  readOnly: false,
  includes: [".git"],
  excludes: ["node_modules"],
  realization: "passthrough" as const,
};

/** ServicePlan with the app bind in the one mounts list. */
export const withAppMount = (base: ServicePlan = service, bind: BindMountPlan = appMount): ServicePlan => ({
  ...base,
  mounts: [...base.mounts.filter((m) => !(m.type === "bind" && m.role === "app")), bind],
});

export const runInfo = async (
  selected: ServicePlan,
  mounts?: ServiceRuntimeInfo["mounts"],
  labels?: ServiceRuntimeInfo["labels"],
) => {
  const calls: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.sync(() => {
        calls.push(`inspect:${target.service}`);
        return {
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "running",
          publications: { status: "present" as const, bindings: [] },
          ...(mounts === undefined ? {} : { mounts }),
          ...(labels === undefined ? {} : { labels }),
        };
      }),
  };
  const layer = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      list: Effect.succeed([plan.provider]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () =>
        Effect.sync(() => {
          calls.push("select");
          return provider;
        }),
    }),
  );
  const result = await Effect.runPromise(
    infoForPlan({ ...plan, services: { [selected.name]: selected } }).pipe(Effect.provide(layer)),
  );
  return { row: result.services[0], calls };
};
