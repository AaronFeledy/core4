import { MessageWarnEvent } from "@lando/sdk/events";
import { type AppPlan, type CommandWarning, groupLogicalEndpoints } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";

export const selectLowPortWarnings = (plan: AppPlan): readonly CommandWarning[] =>
  Object.values(plan.services).flatMap((service) => {
    const user = service.user;
    if (user === undefined || user.length === 0 || /^(?:root|0+)(?::|$)/u.test(user)) return [];
    const ports = new Set(groupLogicalEndpoints(service.endpoints).map((endpoint) => endpoint.port));
    return [...ports]
      .filter((port) => port < 1024)
      .map(
        (port): CommandWarning => ({
          code: "LANDO_NONROOT_LOW_PORT_UNVERIFIED",
          message: `Service ${service.name} declares container port ${port} as ${user} on ${plan.provider}; low-port permission is unverified.`,
          remediation:
            "If this account is non-root, use an unprivileged listen port (for PHP, port: 8080) or verify runtime bind permission.",
          context: {
            service: service.name,
            provider: plan.provider,
            user,
            port: String(port),
            policy: "unknown",
          },
        }),
      );
  });

export const publishLowPortWarnings = Effect.fnUntraced(function* (plan: AppPlan) {
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = yield* EventService;
  for (const warning of selectLowPortWarnings(plan)) {
    yield* recordCommandWarning(warning);
    if (!machineOutput) {
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      );
    }
  }
});
