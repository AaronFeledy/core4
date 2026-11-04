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

import type {
  DatabaseConnection,
  Environment,
  EnvironmentValue,
  ListenerAuthority,
  ServiceCreds,
  ServicePlan,
  VolumeMountPlan,
} from "@lando/sdk/schema";
import type {
  ServiceAppMountIntent,
  ServiceBuildStepIntent,
  ServiceFeatureDefinition,
  ServiceMountIntent,
} from "@lando/sdk/services";

export interface BaseSeed {
  readonly name: ServicePlan["name"];
  readonly type: ServicePlan["type"];
  readonly serviceTypeId?: string;
  readonly provider: ServicePlan["provider"];
  readonly primary: ServicePlan["primary"];
  readonly environment?: Environment;
  readonly connection?: DatabaseConnection;
  readonly nonSqlCreds?: ServiceCreds;
  readonly defaultFeatures: ReadonlyArray<ServiceFeatureDefinition>;
}

/**
 * Optional ServicePlan keys the draft path copies without transformation when
 * present. Keys that need mounts/credentials/extensions handling stay outside.
 */
export const DRAFT_OPTIONAL_PASS_THROUGH_KEYS = [
  "serviceTypeId",
  "artifact",
  "command",
  "entrypoint",
  "init",
  "user",
  "workingDirectory",
  "healthcheck",
  "readiness",
  "readinessSource",
  "listenerAuthority",
  "certs",
  "provenance",
] as const satisfies ReadonlyArray<keyof ServicePlan>;

export type DraftOptionalPassThroughKey = (typeof DRAFT_OPTIONAL_PASS_THROUGH_KEYS)[number];

/**
 * Optional ServicePlan keys owned outside the shared draft pass-through:
 * planner-only fields and mutual-exclusion credentials.
 */
type DraftExternalOptionalServicePlanKey = "home" | "scanner" | "logSources" | "connection" | "nonSqlCreds";

type OptionalServicePlanKey = {
  [K in keyof ServicePlan]-?: undefined extends ServicePlan[K] ? K : never;
}[keyof ServicePlan];

type MissingOptionalServicePlanKey = Exclude<
  OptionalServicePlanKey,
  DraftOptionalPassThroughKey | DraftExternalOptionalServicePlanKey
>;
type ExtraPassThroughKey = Exclude<DraftOptionalPassThroughKey, OptionalServicePlanKey>;

// Compile-time: every optional ServicePlan key is either pass-through or external.
const _optionalServicePlanCoverage: [MissingOptionalServicePlanKey] extends [never]
  ? [ExtraPassThroughKey] extends [never]
    ? true
    : never
  : never = true;
void _optionalServicePlanCoverage;

/**
 * Source shape for draft optional pass-through. Explicit `| undefined` is
 * required under exactOptionalPropertyTypes so draft fields and plan optionals
 * both assign.
 */
export type DraftOptionalPassThroughSource = {
  readonly [K in DraftOptionalPassThroughKey]?: ServicePlan[K] | undefined;
};

/** Copy defined optional ServicePlan pass-through fields from a draft or plan. */
export const pickDraftOptionalServicePlanFields = (
  source: DraftOptionalPassThroughSource,
): Partial<Pick<ServicePlan, DraftOptionalPassThroughKey>> => {
  const picked: Partial<Pick<ServicePlan, DraftOptionalPassThroughKey>> = {};
  for (const key of DRAFT_OPTIONAL_PASS_THROUGH_KEYS) {
    const value = source[key];
    if (value !== undefined) Object.assign(picked, { [key]: value });
  }
  return picked;
};

/** The mutable plan draft a feature mutates before finalization. */
export interface DraftServicePlan {
  name: ServicePlan["name"];
  type: string;
  readonly serviceTypeId?: string;
  provider: ServicePlan["provider"];
  primary: boolean;
  artifact?: ServicePlan["artifact"];
  command?: ServicePlan["command"];
  entrypoint?: ServicePlan["entrypoint"];
  init?: boolean;
  environment: Record<string, EnvironmentValue>;
  readonly connection?: DatabaseConnection;
  readonly nonSqlCreds?: ServiceCreds;
  user?: string;
  workingDirectory?: ServicePlan["workingDirectory"];
  appMount?: ServiceAppMountIntent;
  mounts: ServiceMountIntent[];
  featureIds?: ReadonlyArray<string>;
  buildSteps: ServiceBuildStepIntent[];
  extensions?: Record<string, unknown>;
  storage: Array<Omit<VolumeMountPlan, "type">>;
  /** Mounted trees the planned service user must own, by container target. */
  storageOwnership?: Array<{ target: string; seededOwners: ReadonlyArray<string> }>;
  endpoints: Array<ServicePlan["endpoints"][number]>;
  dependsOn: Array<ServicePlan["dependsOn"][number]>;
  healthcheck?: ServicePlan["healthcheck"];
  readiness?: ServicePlan["readiness"];
  readinessSource?: ServicePlan["readinessSource"];
  listenerAuthority?: ListenerAuthority;
  certs?: ServicePlan["certs"];
  hostAliases: Array<ServicePlan["hostAliases"][number]>;
  provenance?: ServicePlan["provenance"];
}

/** Deterministic metadata stamped on every composed plan (no wall-clock). */
export const deterministicMetadata: ServicePlan["metadata"] = {
  resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"),
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

export const makeDraft = (base: BaseSeed): DraftServicePlan => ({
  name: base.name,
  type: base.type,
  ...(base.serviceTypeId === undefined ? {} : { serviceTypeId: base.serviceTypeId }),
  provider: base.provider,
  primary: base.primary,
  environment: sortRecord(base.environment ?? {}),
  ...(base.connection === undefined ? {} : { connection: base.connection }),
  ...(base.nonSqlCreds === undefined ? {} : { nonSqlCreds: base.nonSqlCreds }),
  mounts: [],
  featureIds: base.defaultFeatures.map((feature) => feature.id),
  buildSteps: [],
  storage: [],
  storageOwnership: [],
  endpoints: [],
  dependsOn: [],
  hostAliases: [],
});
