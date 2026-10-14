import type { ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";

const restartPolicy = (service: Pick<ServicePlan, "extensions">): unknown => {
  const compose = service.extensions.compose;
  return Predicate.isObject(compose) ? Reflect.get(compose, "restart") : undefined;
};

export const isSupervisedService = (service: Pick<ServicePlan, "extensions">): boolean => {
  const restart = restartPolicy(service);
  return restart === "always" || restart === "unless-stopped" || restart === "on-failure";
};

export const isServiceRestartExpected = (
  service: Pick<ServicePlan, "extensions">,
  exitCode?: number,
): boolean => {
  const restart = restartPolicy(service);
  return (
    restart === "always" ||
    restart === "unless-stopped" ||
    (restart === "on-failure" && exitCode !== undefined && exitCode !== 0)
  );
};
