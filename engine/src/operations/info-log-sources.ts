import type { InfoLogSource } from "@lando/sdk/app";
import type { ServicePlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";

export const infoLogSources = (
  service: ServicePlan,
  capabilities: RuntimeProviderShape["capabilities"],
): readonly InfoLogSource[] =>
  (service.logSources ?? []).map((source): InfoLogSource => {
    switch (source.strategy) {
      case "console":
        return {
          id: String(source.id),
          strategy: source.strategy,
          stream: source.stream,
          availability: capabilities.serviceLogs ? "available" : "unavailable",
          ...(capabilities.serviceLogs
            ? {}
            : { reason: "This provider cannot stream service console logs." }),
        };
      case "redirect":
        return {
          id: String(source.id),
          path: String(source.path),
          strategy: source.strategy,
          availability: "redirected-to-console",
        };
      case "follow":
        return {
          id: String(source.id),
          path: String(source.path),
          strategy: source.strategy,
          availability: capabilities.serviceLogSources ? "available" : "unavailable",
          ...(capabilities.serviceLogSources
            ? {}
            : {
                reason:
                  "This provider cannot follow log files. Use a provider with file-log support, or configure the process to write to console and read it with `lando logs`.",
              }),
        };
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
    }
  });
