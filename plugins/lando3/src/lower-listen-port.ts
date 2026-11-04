import type { Lando3Path, Lando3ServiceFacts } from "./contract.ts";
import { normalizeAssignments } from "./environment.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import { needsReviewServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

export type ListenPortResolution = {
  readonly variable: string;
  readonly relative: Lando3Path;
  readonly raw: string;
} & (
  | { readonly kind: "literal"; readonly port: number }
  | { readonly kind: "dynamic" | "malformed" }
  | { readonly kind: "conflict"; readonly port: number; readonly authoredPort: unknown }
);

/** Resolve the same winning assignment that environment normalization will retain. */
export const resolveListenPort = (
  service: Readonly<Record<string, unknown>>,
  entry: Lando3ServiceFacts | undefined,
  ctx: ServiceLoweringContext,
): ListenPortResolution | undefined => {
  const variable = entry?.listener?.variable;
  if (variable === undefined) return undefined;
  const overrides = hasPlainObjectPrototype(service.overrides) ? service.overrides : {};
  for (const [environment, base] of [
    [overrides.environment, ["overrides", "environment"]],
    [service.environment, ["environment"]],
  ] as const) {
    const assignment = normalizeAssignments(
      environment,
      { ctx, relative: base },
      "environment",
    ).assignments.find((item) => item.name === variable);
    if (assignment === undefined) continue;
    const raw = assignment.value ?? "an unresolved assignment";
    const authored = { variable, relative: assignment.cell, raw };
    if (raw.includes("$") || raw.includes("{{")) return { ...authored, kind: "dynamic" };
    const port = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ...authored, kind: "malformed" };
    }
    if (service.port !== undefined && Number(service.port) !== port) {
      return { ...authored, kind: "conflict", port, authoredPort: service.port };
    }
    return { ...authored, kind: "literal", port };
  }
  return undefined;
};

/** Apply after merging: a deletion patch would resurrect the variable in the deep merge. */
export const lowerListenPort = (
  lowered: LoweringPatch,
  resolution: ListenPortResolution | undefined,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  if (lowered.blocked === true || resolution === undefined) return lowered;
  const { variable, relative, raw } = resolution;
  let message: string;
  let remediation = `Set port: to the TCP port the server should listen on and remove ${variable}.`;
  switch (resolution.kind) {
    case "literal": {
      const { environment, ...patch } = lowered.patch;
      const kept = hasPlainObjectPrototype(environment)
        ? Object.fromEntries(Object.entries(environment).filter(([key]) => key !== variable))
        : {};
      return {
        ...lowered,
        patch: {
          ...patch,
          port: patch.port ?? resolution.port,
          ...(Object.keys(kept).length === 0 ? {} : { environment: kept }),
        },
        diagnostics: [
          ...lowered.diagnostics,
          needsReviewServiceKey({
            ctx,
            relative,
            message: `Moved ${variable} to port: ${resolution.port}; Lando 4 sets ${variable} from port:.`,
            remediation: `Lando 3 never read ${variable}; if it only pointed clients in this container at another server, remove port: and configure that connection instead.`,
          }),
        ],
      };
    }
    case "dynamic":
      message = `Conversion cannot resolve ${variable} (${raw}) to a port; set port: explicitly.`;
      break;
    case "malformed":
      message = `${variable} is ${raw}, not a TCP port number; Lando 4 sets ${variable} from port:.`;
      break;
    case "conflict":
      message = `${variable} is ${resolution.port}, but port: is ${resolution.authoredPort}; Lando 4 sets ${variable} from port:.`;
      remediation = `Keep one value: set port: to the port the server should listen on and remove ${variable}.`;
      break;
    default:
      return resolution satisfies never;
  }
  return {
    ...lowered,
    diagnostics: [...lowered.diagnostics, unsupportedServiceKey({ ctx, relative, message, remediation })],
  };
};
