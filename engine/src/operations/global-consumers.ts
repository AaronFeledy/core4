import { GlobalAppError, causeMessage } from "@lando/sdk/errors";
import type { AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { routerEnabled } from "../config/router-config.ts";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";

export const GlobalConsumerSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["user", "scratch"]),
  root: Schema.String,
  provider: Schema.String,
  services: Schema.Array(Schema.String),
  globalServices: Schema.Array(Schema.String),
  routes: Schema.Array(Schema.String),
});
export type GlobalConsumer = typeof GlobalConsumerSchema.Type;

export const GlobalConsumerImpactSchema = Schema.Struct({
  consumers: Schema.Array(GlobalConsumerSchema),
  uncertainties: Schema.Array(Schema.String),
});
export type GlobalConsumerImpact = typeof GlobalConsumerImpactSchema.Type;

export class GlobalConsumerProtectionError extends Schema.TaggedError<GlobalConsumerProtectionError>()(
  "GlobalConsumerProtectionError",
  {
    message: Schema.String,
    operation: Schema.Literals(["disable", "reconcile"]),
    policySaved: Schema.Literal(false),
    consumers: Schema.Array(GlobalConsumerSchema),
    uncertainties: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

const active = new Set(["running", "paused", "restarting", "starting", "healthy", "unhealthy"]);
const inactive = new Set(["stopped", "exited", "dead", "created", "completed"]);

/** Join fresh ownership observations to applied intent; missing evidence never proves absence. */
export const resolveGlobalConsumerImpact = (input: {
  readonly providerId: ProviderId;
  readonly selectedIds: ReadonlyArray<string>;
  readonly routerId: string;
  readonly plans: ReadonlyArray<AppPlan>;
  readonly services: ReadonlyArray<ServiceRuntimeInfo>;
}): GlobalConsumerImpact => {
  const selected = new Set(input.selectedIds);
  const uncertainties = new Set<string>();
  const consumers: GlobalConsumer[] = [];
  const plans = input.plans.filter((plan) => {
    if (plan.provider !== input.providerId) {
      uncertainties.add(`Applied app ${plan.id} is attributed to a different provider (${plan.provider}).`);
      return false;
    }
    return String(plan.id) !== "global";
  });
  for (const observation of input.services) {
    if (String(observation.app) === "global") continue;
    const state = observation.state ?? observation.status;
    if (inactive.has(state)) continue;
    if (!active.has(state)) {
      uncertainties.add(`Runtime state for ${observation.app}/${observation.service} is unknown.`);
      continue;
    }
    if (!observation.appRoot || observation.providerId !== input.providerId || !observation.containerId) {
      uncertainties.add(`Ownership of active app ${observation.app}/${observation.service} is incomplete.`);
      continue;
    }
    const matching = plans.filter(
      (plan) => plan.id === observation.app && (plan.identity?.appRoot ?? plan.root) === observation.appRoot,
    );
    if (
      matching.length !== 1 ||
      !Object.values(matching[0]?.services ?? {}).some((service) => service.name === observation.service)
    )
      uncertainties.add(
        `Active service ${observation.app}/${observation.service} (${observation.appRoot}) has no unique readable applied service.`,
      );
    if (
      input.services.filter(
        (other) =>
          other.app === observation.app &&
          other.appRoot === observation.appRoot &&
          other.service === observation.service &&
          active.has(other.state ?? other.status),
      ).length > 1
    )
      uncertainties.add(
        `Active service ${observation.app}/${observation.service} has ambiguous runtime identities.`,
      );
  }
  for (const plan of plans) {
    const root = plan.identity?.appRoot ?? plan.root;
    const running = input.services.filter(
      (observation) =>
        observation.app === plan.id &&
        observation.appRoot === root &&
        observation.providerId === input.providerId &&
        !!observation.containerId &&
        active.has(observation.state ?? observation.status),
    );
    if (running.length === 0) continue;
    const requirements = (plan.requires?.globalServices ?? []).filter((id) => selected.has(id));
    const routed = selected.has(input.routerId) && routerEnabled(plan) && plan.routes.length > 0;
    if (requirements.length === 0 && !routed) continue;
    consumers.push({
      id: String(plan.id),
      name: plan.name,
      kind: Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY) ? "scratch" : "user",
      root,
      provider: String(plan.provider),
      services: [...new Set(running.map((service) => String(service.service)))].sort(),
      globalServices: [...new Set([...requirements, ...(routed ? [input.routerId] : [])])].sort(),
      routes: routed ? [...new Set(plan.routes.map((route) => route.hostname))].sort() : [],
    });
  }
  consumers.sort((a, b) => `${a.kind}:${a.root}:${a.id}`.localeCompare(`${b.kind}:${b.root}:${b.id}`));
  return { consumers, uncertainties: [...uncertainties].sort() };
};

/** Audit durable claims across providers; inspect relevant runtimes without starting them. */
export const readGlobalConsumerImpact = Effect.fn("GlobalPolicy.consumerImpact")(function* (input: {
  readonly providerId?: ProviderId;
  readonly selectedIds: ReadonlyArray<string>;
  readonly routerId: string;
}) {
  if (input.selectedIds.length === 0)
    return { consumers: [], uncertainties: [] } satisfies GlobalConsumerImpact;
  const registry = yield* RuntimeProviderRegistry;
  const providers = yield* Effect.result(registry.list);
  const uncertainties: string[] =
    input.providerId === undefined
      ? ["The global provider could not be determined; running app dependencies are unknown."]
      : [];
  if (providers._tag === "Failure")
    uncertainties.push(`Installed provider inventory could not be read. ${causeMessage(providers.failure)}`);
  const ids = new Set([
    ...(providers._tag === "Success" ? providers.success : []),
    ...(input.providerId === undefined ? [] : [input.providerId]),
  ]);
  const consumers: GlobalConsumer[] = [];
  const selectedIds = new Set(input.selectedIds);
  for (const providerId of ids) {
    const inventory =
      registry.appliedStateInventory === undefined
        ? undefined
        : yield* Effect.result(registry.appliedStateInventory(providerId));
    const plans = inventory?._tag === "Success" ? inventory.success.plans : [];
    if (inventory?._tag !== "Success")
      uncertainties.push(
        `Applied app inventory on ${providerId} is unavailable.${inventory?._tag === "Failure" ? ` ${causeMessage(inventory.failure)}` : " The provider registry exposes no strict inventory."}`,
      );
    else
      for (const unreadable of inventory.success.unreadable)
        uncertainties.push(
          `Applied app state is unreadable at ${unreadable.path}; dependency impact is unknown.`,
        );
    const potential = plans.some(
      (plan) =>
        String(plan.id) !== "global" &&
        ((plan.requires?.globalServices ?? []).some((id) => selectedIds.has(id)) ||
          (selectedIds.has(input.routerId) && routerEnabled(plan) && plan.routes.length > 0)),
    );
    if (
      providerId !== input.providerId &&
      inventory?._tag === "Success" &&
      inventory.success.unreadable.length === 0 &&
      !potential
    )
      continue;
    const selected = yield* Effect.result(registry.select(providerId));
    if (selected._tag === "Failure") {
      uncertainties.push(
        `Runtime inspection on ${providerId} is unavailable. ${causeMessage(selected.failure)}`,
      );
      continue;
    }
    const provider = selected.success;
    if (provider.id !== providerId) {
      uncertainties.push(
        `Runtime inspection for ${providerId} returned a different provider (${provider.id}).`,
      );
      continue;
    }
    const observations = yield* Effect.result(
      Effect.gen(function* () {
        if (!(yield* provider.isAvailable) || !(yield* provider.getStatus).running)
          return yield* Effect.fail(
            new GlobalAppError({
              operation: "consumerImpact",
              message: `Runtime ${providerId} is unreachable; running consumers cannot be verified.`,
              remediation: "Restore runtime access or explicitly acknowledge disruption.",
            }),
          );
        return yield* provider.list({ includeUnplanned: true, includeScratch: true });
      }),
    );
    if (observations._tag === "Failure") {
      uncertainties.push(causeMessage(observations.failure));
      continue;
    }
    const resolved = resolveGlobalConsumerImpact({
      ...input,
      providerId,
      plans,
      services: observations.success,
    });
    consumers.push(...resolved.consumers);
    uncertainties.push(...resolved.uncertainties);
  }
  return { consumers, uncertainties: [...new Set(uncertainties)] } satisfies GlobalConsumerImpact;
});
