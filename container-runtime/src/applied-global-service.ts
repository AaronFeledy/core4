import { sameRealpath } from "@lando/paths";
import { type AbsolutePath, AppId, type AppPlan, type ServiceName, planAppIdentity } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";
import { ownsServiceContainer } from "./native-ownership.ts";

export const ownsAppliedGlobalService = (plan: AppPlan, row: ServiceRuntimeInfo): boolean =>
  row.app === plan.id &&
  row.appRoot === planAppIdentity(plan).appRoot &&
  row.providerId === plan.provider &&
  Object.hasOwn(plan.services, row.service) &&
  ownsServiceContainer(plan, row);

export const resolveAppliedGlobalPlan = Effect.fn("GlobalApp.resolveExactAppliedPlan")(function* (
  registry: RuntimeProviderRegistry["Service"],
  roots: { readonly appRoot: AbsolutePath; readonly dataRoot: string },
) {
  const id = AppId.make("global");
  const plan = yield* registry.resolveAppliedPlan(roots.appRoot, { kind: "global", id }, "exact");
  if (
    plan?.id !== id ||
    !sameRealpath(plan.root, roots.appRoot) ||
    (plan.identity?.dataRoot !== undefined && !sameRealpath(plan.identity.dataRoot, roots.dataRoot))
  )
    return undefined;
  return plan;
});

export const resolveAppliedGlobalService = Effect.fn("GlobalApp.resolveExactAppliedService")(function* (
  registry: RuntimeProviderRegistry["Service"],
  roots: { readonly appRoot: AbsolutePath; readonly dataRoot: string },
  service: ServiceName,
) {
  const plan = yield* resolveAppliedGlobalPlan(registry, roots);
  if (plan === undefined || !Object.hasOwn(plan.services, service)) return undefined;
  const provider = yield* registry.select(plan);
  if (
    provider.id !== plan.provider ||
    !(yield* provider.isAvailable) ||
    (yield* provider.getStatus).state === "idle"
  )
    return undefined;
  const observed = (yield* provider.list({ app: plan.id })).find(
    (row) => row.service === service && ownsAppliedGlobalService(plan, row),
  );
  return observed === undefined ? undefined : { plan, provider, observed };
});
