import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";
import { type AppPlan, ServiceName, ToolingTaskShape, type ValidationIssuePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import type { EffectiveTooling } from "./tooling-composition.ts";
import {
  ToolingProvenance,
  UNKNOWN_TOOLING_ORIGIN,
  toolingIssueLocations,
  toolingIssueSource,
  toolingOriginAt,
} from "./tooling-provenance.ts";

export {
  type EffectiveTooling,
  compareOrdinal,
  compileEffectiveTooling,
  connectionClientOwners,
  toolingBeforeDefaults,
  toolingContributors,
} from "./tooling-composition.ts";
export {
  type EffectiveToolingResolution,
  type ToolingProvenance,
  resolveEffectiveTooling,
  toolingIssueLocations,
  toolingIssueSource,
  toolingOriginAt,
} from "./tooling-provenance.ts";

const TOOLING_PLAN_KEY = "@lando/core/effective-tooling";
const ToolingPlan = Schema.Struct({
  version: Schema.Literal(2),
  tasks: Schema.Record(Schema.String, ToolingTaskShape),
  internalNames: Schema.Array(Schema.String),
  connectionClients: Schema.Record(Schema.String, ServiceName),
  provenance: ToolingProvenance,
}).check(
  Schema.makeFilter(
    (value) => Object.keys(value.tasks).every((name) => Object.hasOwn(value.provenance, name)),
    { expected: "provenance for every effective tooling task" },
  ),
);
// Applied plans are durable intent: read their historical shape without rewriting or replanning it.
// Derived plan caches reject the previous revision before reaching this decoder.
const LegacyAppliedToolingPlan = Schema.Struct({
  version: Schema.optionalKey(Schema.Never),
  tasks: Schema.Record(Schema.String, ToolingTaskShape),
  internalNames: Schema.Array(Schema.String),
  connectionClients: Schema.optionalKey(Schema.Record(Schema.String, ServiceName)),
  disabledSources: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeToolingPlan = Schema.decodeUnknownSync(Schema.Union([ToolingPlan, LegacyAppliedToolingPlan]));
const toolingPlanFor = (plan: AppPlan) => {
  const value = plan.extensions[TOOLING_PLAN_KEY];
  return value === undefined ? undefined : decodeToolingPlan(value);
};
const provenanceForPlan = (plan: AppPlan): ToolingProvenance => {
  const value = toolingPlanFor(plan);
  return value?.version === 2 ? value.provenance : {};
};

export const connectionClientsForPlan = (plan: AppPlan): Readonly<Record<string, ServiceName>> =>
  toolingPlanFor(plan)?.connectionClients ?? {};

export interface ToolingPlanOptions {
  readonly connectionClients?: Readonly<Record<string, ServiceName>>;
  readonly provenance?: ToolingProvenance;
}

export const attachEffectiveTooling = <Plan extends AppPlan>(
  plan: Plan,
  tooling: EffectiveTooling,
  options: ToolingPlanOptions = {},
): Plan => ({
  ...plan,
  extensions: {
    ...plan.extensions,
    [TOOLING_PLAN_KEY]: {
      version: 2,
      tasks: tooling,
      internalNames: [...getInternalToolingTasks(tooling)],
      connectionClients: options.connectionClients ?? {},
      provenance: Object.fromEntries(
        Object.keys(tooling).map((name) => [
          name,
          options.provenance?.[name] ?? { origin: UNKNOWN_TOOLING_ORIGIN, overrides: [] },
        ]),
      ),
    },
  },
});

export const effectiveToolingForPlan = (plan: AppPlan): EffectiveTooling | undefined => {
  const decoded = toolingPlanFor(plan);
  return decoded === undefined
    ? undefined
    : rememberInternalToolingTasks(decoded.tasks, decoded.internalNames);
};

export const toolingIssueSourceForPlan = (plan: AppPlan, name: string, relativePath: ValidationIssuePath) =>
  toolingIssueSource(provenanceForPlan(plan), name, relativePath);

export const toolingOriginForPlan = (plan: AppPlan, name: string, relativePath: ValidationIssuePath) =>
  toolingOriginAt(provenanceForPlan(plan), name, relativePath);

export const toolingRelatedLocationsForPlan = (
  plan: AppPlan,
  name: string,
  relativePaths: readonly ValidationIssuePath[],
) => toolingIssueLocations(provenanceForPlan(plan), name, relativePaths);

export const disabledToolingSourceForPlan = (plan: AppPlan, name: string): string | undefined => {
  const source = toolingIssueSourceForPlan(plan, name, ["disabled"]);
  return source !== undefined && "file" in source ? source.file : undefined;
};

/** Recorded metadata is overall invocation context, not proof of an authored issue location. */
export const toolingSourcePathForPlan = (plan: AppPlan, name: string): string => {
  const value = toolingPlanFor(plan);
  const source = toolingIssueSource(
    value?.version === 2 ? value.provenance : {},
    name,
    value?.tasks[name]?.disabled === true ? ["disabled"] : [],
  );
  return source !== undefined && "file" in source ? source.file : plan.metadata.source;
};
