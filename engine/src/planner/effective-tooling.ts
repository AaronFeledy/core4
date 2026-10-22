import type { AppPlan, LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

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

const effectiveToolingByPlan = new WeakMap<AppPlan, EffectiveTooling>();

export const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedTooling = (tooling: EffectiveTooling): EffectiveTooling =>
  Object.fromEntries(Object.entries(tooling).sort(([left], [right]) => compareOrdinal(left, right)));

export const compileEffectiveTooling = (input: {
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

  return rememberInternalToolingTasks(
    sortedTooling(
      applyToolingDefaults({ ...contributed, ...input.landofile.tooling }, input.landofile.toolingDefaults) ??
        {},
    ),
    getInternalToolingTasks(input.landofile),
  );
};

export const attachEffectiveTooling = (plan: AppPlan, tooling: EffectiveTooling): AppPlan => {
  effectiveToolingByPlan.set(plan, tooling);
  return plan;
};

export const effectiveToolingForPlan = (plan: AppPlan): EffectiveTooling | undefined =>
  effectiveToolingByPlan.get(plan);
