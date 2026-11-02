import { LandofileValidationError } from "@lando/sdk/errors";
import type { EndpointPlan } from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { PreparedServiceComposition } from "../services/feature-preparation.ts";
import type { PlannerIssue } from "./resolved-validation.ts";

export type Availability<T> =
  | { readonly _tag: "Available"; readonly value: T }
  | { readonly _tag: "Unavailable"; readonly reasons: readonly PlannerIssue[] };

export interface ServiceEndpointProjection {
  readonly preparation: Availability<PreparedServiceComposition>;
  readonly contributions: Availability<readonly EndpointPlan[]>;
  readonly endpoints: Availability<readonly EndpointPlan[]>;
}

export const unavailable = (reasons: readonly PlannerIssue[]): Availability<never> => ({
  _tag: "Unavailable",
  reasons: [...new Set(reasons)],
});

export const requireServiceProjection = (
  rows: ReadonlyMap<string, ServiceEndpointProjection>,
  name: string,
  appRoot: string,
): Effect.Effect<
  {
    readonly prepared: PreparedServiceComposition;
    readonly endpointContributions: readonly EndpointPlan[];
  },
  LandofileValidationError
> => {
  const row = rows.get(name);
  if (row === undefined || row.preparation._tag === "Unavailable" || row.contributions._tag === "Unavailable")
    return Effect.fail(
      new LandofileValidationError({
        message: `Service ${name} has no successful prepared endpoint contribution.`,
        remediation: "Resolve endpoint preparation failures before assembling the plan.",
        file: `${appRoot}/.lando.yml`,
        issues: [validationIssue(["services", name], "Endpoint preparation invariant failed.")],
      }),
    );
  return Effect.succeed({ prepared: row.preparation.value, endpointContributions: row.contributions.value });
};

export const blockContributions = (
  rows: Map<string, ServiceEndpointProjection>,
  names: readonly string[],
  reasons: readonly PlannerIssue[],
): void => {
  for (const name of names) {
    const row = rows.get(name);
    if (row === undefined) continue;
    rows.set(name, {
      ...row,
      contributions: unavailable([
        ...(row.contributions._tag === "Unavailable" ? row.contributions.reasons : []),
        ...reasons,
      ]),
    });
  }
};
