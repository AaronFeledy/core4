import { isLegacyTagged } from "@lando/sdk/landofile";
import { ContainerUser } from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceCursor } from "./claims.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import { unsupportedServiceKey } from "./service-diagnostics.ts";

export const lowerHealthcheck = (service: V4Wire, ctx: ServiceLoweringContext): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const patch: Record<string, unknown> = {};
  const diagnostics: LoweringPatch["diagnostics"][number][] = [];
  let blocked = false;
  const health = cursor.take(["healthcheck"]);
  if (isLegacyTagged(health)) {
    blocked = true;
    diagnostics.push(
      cursor.rejectTree(
        ["healthcheck"],
        "Tagged healthchecks cannot be converted; referenced files are never read during conversion.",
        "Replace the reference with an explicit readiness command.",
      ),
    );
  } else if (service.type === "l337" && health !== undefined) {
    diagnostics.push(
      cursor.dropTree(
        ["healthcheck"],
        "Lando 3 never ran healthchecks for l337 services.",
        "Configure readiness by hand in Lando 4 if this service needs it.",
      ),
    );
  } else if (health === true) {
    diagnostics.push(
      cursor.dropTree(
        ["healthcheck"],
        "Lando 3 healthcheck: true supplied no command and had no effect.",
        "Configure an explicit readiness command in Lando 4 if needed.",
      ),
    );
  } else if (health === false) patch.readiness = false;
  else if (typeof health === "string" || Array.isArray(health)) {
    cursor.mapTo(["healthcheck"]);
    patch.readiness = health;
  } else if (hasPlainObjectPrototype(health)) {
    for (const key of ["command", "cmd", "user", "retry", "delay"]) cursor.mapTo(["healthcheck", key]);
    if (health.user !== undefined && !Schema.is(ContainerUser)(health.user)) {
      blocked = true;
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: ["healthcheck", "user"],
          message: "The healthcheck user is not a valid container identity.",
          remediation: "Use a container username, numeric uid, or user:group identity.",
        }),
      );
    }
    const command = health.command ?? health.cmd;
    patch.readiness = {
      ...(command === undefined ? {} : { command }),
      ...(health.user === undefined ? {} : { user: health.user }),
      ...(health.retry === undefined ? {} : { retries: health.retry }),
      ...(typeof health.delay === "number" ? { intervalSeconds: Math.round(health.delay / 1000) } : {}),
    };
  }
  return { patch, diagnostics, claims: cursor.claims, ...(blocked ? { blocked: true as const } : {}) };
};
