import { type AppPlan, type LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";
import { Schema } from "effect";

import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";

export type EffectiveTooling = Readonly<Record<string, ToolingTaskShape>>;

interface ToolingServiceContribution {
  readonly name: string;
  readonly serviceTypeId?: string;
  readonly tooling?: EffectiveTooling;
}

const TOOLING_PLAN_KEY = "@lando/core/effective-tooling";
const ToolingPlan = Schema.Struct({
  tasks: Schema.Record(Schema.String, ToolingTaskShape),
  internalNames: Schema.Array(Schema.String),
});

export const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedTooling = (tooling: EffectiveTooling): EffectiveTooling =>
  Object.fromEntries(Object.entries(tooling).sort(([left], [right]) => compareOrdinal(left, right)));

export const toolingBeforeDefaults = (input: {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults">;
  readonly services: ReadonlyArray<ToolingServiceContribution>;
}): EffectiveTooling => {
  const contributed: Record<string, ToolingTaskShape> = {};
  for (const service of [...input.services].sort((left, right) => compareOrdinal(left.name, right.name))) {
    for (const [name, task] of Object.entries(service.tooling ?? {}).sort(([left], [right]) =>
      compareOrdinal(left, right),
    )) {
      if (contributed[name] !== undefined) continue;
      contributed[name] = { service: service.name, ...task };
    }
  }

  return { ...contributed, ...input.landofile.tooling };
};

export const compileEffectiveTooling = (input: {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults">;
  readonly services: ReadonlyArray<ToolingServiceContribution>;
}): EffectiveTooling => {
  return rememberInternalToolingTasks(
    sortedTooling(applyToolingDefaults(toolingBeforeDefaults(input), input.landofile.toolingDefaults) ?? {}),
    getInternalToolingTasks(input.landofile),
  );
};

export const attachEffectiveTooling = <Plan extends AppPlan>(plan: Plan, tooling: EffectiveTooling): Plan => {
  return {
    ...plan,
    extensions: {
      ...plan.extensions,
      [TOOLING_PLAN_KEY]: {
        tasks: tooling,
        internalNames: [...getInternalToolingTasks(tooling)],
      },
    },
  };
};

export const effectiveToolingForPlan = (plan: AppPlan): EffectiveTooling | undefined => {
  const value = plan.extensions[TOOLING_PLAN_KEY];
  if (value === undefined) return undefined;
  const decoded = Schema.decodeUnknownSync(ToolingPlan)(value);
  return rememberInternalToolingTasks(decoded.tasks, decoded.internalNames);
};
