import { ConfigExpressionError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { primaryRouteCandidates } from "../operations/connection-url.ts";

export const routeUrlConsumers = (plan: Pick<AppPlan, "services">) =>
  Object.values(plan.services).flatMap((consumer) =>
    Object.entries(consumer.environment).flatMap(([key, value]) =>
      typeof value !== "string" && value._tag === "RouteText"
        ? value.parts.flatMap((part) =>
            typeof part === "string" ? [] : [{ consumer: consumer.name, key, service: part.service }],
          )
        : [],
    ),
  );

export const validateRouteUrls = Effect.fn("AppPlanner.validateRouteUrls")(function* (input: {
  readonly plan: Pick<AppPlan, "services" | "routes">;
  readonly filePath: string;
  readonly enabled: boolean;
  readonly global: boolean;
}) {
  const services = new Map(Object.entries(input.plan.services));
  for (const { consumer, key, service } of routeUrlConsumers(input.plan)) {
    const expression = `services.${service}.url`;
    const target = services.get(service);
    const issue = input.global
      ? {
          message: "global apps do not bind public service URLs",
          remediation: "Remove the public URL expression from the global Landofile.",
        }
      : !input.enabled
        ? {
            message: "the router is disabled",
            remediation: "Enable the router for this app.",
          }
        : target === undefined ||
            primaryRouteCandidates(input.plan.routes, target, { concreteOnly: true }).length === 0
          ? {
              message: input.plan.routes.some((route) => route.service === service)
                ? "the service has only wildcard routes"
                : "the service has no route",
              remediation: "Add a route with a concrete hostname for the referenced service.",
            }
          : undefined;
    if (issue !== undefined)
      return yield* new ConfigExpressionError({
        message: `Cannot bind ${expression}${consumer === service ? " (also available as service.url)" : ""}: ${issue.message}.`,
        remediation: issue.remediation,
        path: ["services", consumer, "environment", key],
        filePath: input.filePath,
        expression,
      });
  }
});
