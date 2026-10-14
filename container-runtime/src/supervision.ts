import type { ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";

export const isSupervisedService = (service: Pick<ServicePlan, "extensions">): boolean => {
  const compose = service.extensions.compose;
  if (!Predicate.isObject(compose)) return false;
  const restart = Reflect.get(compose, "restart");
  return restart === "always" || restart === "unless-stopped" || restart === "on-failure";
};
