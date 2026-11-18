import { MessageWarnEvent } from "@lando/sdk/events";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { ServicePlan } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import { nodePackageManagerEvidence } from "../planner/node-local-tooling.ts";

const pin = (service: ServicePlan | undefined) => {
  const raw = nodePackageManagerEvidence(service?.provenance);
  if (raw === null) return null;
  if (
    !isPlainRecord(raw) ||
    typeof raw.name !== "string" ||
    typeof raw.version !== "string" ||
    typeof raw.launcher !== "string" ||
    (raw.integrity !== undefined && typeof raw.integrity !== "string")
  )
    return undefined;
  return { name: raw.name, version: raw.version, launcher: raw.launcher, integrity: raw.integrity };
};

export const publishNodePackageManagerWarning = Effect.fnUntraced(function* (
  desired: ServicePlan | undefined,
  applied: ServicePlan | undefined,
) {
  if (desired === undefined || applied === undefined) return;
  const before = pin(applied);
  const after = pin(desired);
  if (before === undefined || after === undefined) return;
  if (
    before === null
      ? after === null
      : after !== null &&
        before.name === after.name &&
        before.version === after.version &&
        before.integrity === after.integrity &&
        before.launcher === after.launcher
  )
    return;
  const warning = {
    code: "LANDO_NODE_PACKAGE_MANAGER_STALE",
    message: `Node package-manager build inputs changed for service ${desired.name}.`,
    remediation: "Run `lando start`.",
    context: { service: desired.name },
  };
  yield* recordCommandWarning(warning);
  if (yield* commandWarningsUseMachineOutput) return;
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventService));
  if (events !== undefined)
    yield* events
      .publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      )
      .pipe(Effect.catchTag("EventError", () => Effect.void));
});
