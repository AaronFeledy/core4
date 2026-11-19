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

type RestartInput = (
  | { readonly source: "planned"; readonly service: Pick<ServicePlan, "extensions"> }
  | { readonly source: "observed"; readonly policy?: string | undefined }
) & { readonly state: "restarting" | "exited" | "dead"; readonly exitCode?: number | undefined };

export const restartVerdict = (input: RestartInput): "expected" | "not-expected" | "unknown" => {
  if (input.state === "restarting") return "expected";
  const policy = input.source === "planned" ? restartPolicy(input.service) : input.policy;
  switch (policy) {
    case "always":
    case "unless-stopped":
      return "expected";
    case "no":
      return "not-expected";
    case "":
      return input.source === "observed" ? "not-expected" : "unknown";
    case undefined:
      return input.source === "planned" ? "not-expected" : "unknown";
    case "on-failure":
      if (
        input.state === "dead" ||
        input.exitCode === undefined ||
        !Number.isSafeInteger(input.exitCode) ||
        input.exitCode < 0
      )
        return "unknown";
      return input.exitCode === 0 ? "not-expected" : "expected";
    default:
      return "unknown";
  }
};
