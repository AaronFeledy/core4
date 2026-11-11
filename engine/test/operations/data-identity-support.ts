import { AppId, type AppPlan, LoadScopedLandofile, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { AppPlanner, type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { plan } from "./start-progress-topology-support.ts";

export const root = plan.root;
export const identity = { appRoot: root, ownerKey: appIdentityKey("owner", root) };
export const identityPlan = (name: string, dataName?: string): AppPlan => ({
  ...plan,
  name,
  id: AppId.make(name),
  slug: name,
  identity: { ...identity, ...(dataName === undefined ? {} : { dataName }) },
});
export const identityTarget = (plan: AppPlan, withLandofile = true) => ({
  plan,
  root,
  app: { kind: "user" as const, id: plan.id, root },
  ...(withLandofile
    ? {
        landofile: LoadScopedLandofile.make({
          stage: "load-scoped",
          document: { name: plan.name },
          pendingSites: [],
          context: { appRoot: root, env: {} },
        }),
      }
    : {}),
});
export const identityRegistry = (
  applied: readonly AppPlan[] = [],
  snapshots?: readonly ProviderRuntimeSnapshot[],
) =>
  RuntimeProviderRegistry.of({
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedPlansFor: () => Effect.succeed(applied),
    select: () => Effect.succeed({ ...TestRuntimeProvider, listVolumes: () => Effect.succeed([]) }),
    resolveAppliedPlan: () => Effect.succeed(applied[0]),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
    ...(snapshots === undefined ? {} : { observeRuntime: Effect.succeed(snapshots) }),
  });
export const identityPlanner = (plan: AppPlan) =>
  AppPlanner.of({
    plan: (_landofile, _caps, options) =>
      Effect.succeed({
        ...plan,
        identity: { ...identity, dataName: options?.dataName ?? plan.name },
        valueModel: 1,
      }),
  });
