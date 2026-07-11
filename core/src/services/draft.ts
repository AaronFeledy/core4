/**
 * Core-private mutable plan-draft shape shared by the service-feature and
 * app-feature composition engines. A draft is the provider-neutral
 * in-memory representation a feature's `apply` mutates: it carries plan-intent
 * fields (env, mounts, build steps, endpoints, …) WITHOUT any provider
 * realization decision (that is finalization's job). The service-feature engine
 * (`feature.ts`) seeds it from a base + features and finalizes it into a
 * `ServicePlan`; the app-feature engine (`app-feature.ts`) mutates the already
 * resolved per-service drafts across the whole app.
 */
import { DateTime } from "effect";

import type { ServicePlan } from "@lando/sdk/schema";
import type { ServiceAppMountIntent, ServiceBuildStepIntent, ServiceMountIntent } from "@lando/sdk/services";

/** The mutable plan draft a feature mutates before finalization. */
export interface DraftServicePlan {
  name: ServicePlan["name"];
  type: string;
  provider: ServicePlan["provider"];
  primary: boolean;
  artifact?: ServicePlan["artifact"];
  command?: ServicePlan["command"];
  entrypoint?: ServicePlan["entrypoint"];
  environment: Record<string, string>;
  user?: string;
  workingDirectory?: ServicePlan["workingDirectory"];
  appMount?: ServiceAppMountIntent;
  mounts: ServiceMountIntent[];
  featureIds?: ReadonlyArray<string>;
  buildSteps: ServiceBuildStepIntent[];
  extensions?: Record<string, unknown>;
  storage: Array<ServicePlan["storage"][number]>;
  endpoints: Array<ServicePlan["endpoints"][number]>;
  dependsOn: Array<ServicePlan["dependsOn"][number]>;
  healthcheck?: ServicePlan["healthcheck"];
  certs?: ServicePlan["certs"];
  hostAliases: Array<ServicePlan["hostAliases"][number]>;
}

/** Deterministic metadata stamped on every composed plan (no wall-clock). */
export const deterministicMetadata: ServicePlan["metadata"] = {
  resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00Z"),
  source: "service-feature-composition",
  runtime: 4,
};

/** Returns a new record with keys sorted ascending; drops undefined values. */
export const sortRecord = <V>(input: Readonly<Record<string, V>>): Record<string, V> => {
  const output: Record<string, V> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
};
