import type { CommandAliasConflictError } from "@lando/sdk/errors";
import type { AppPlan, LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";

import { reservedToolingNameConflict } from "../operations/reserved-aliases.ts";

export type EffectiveTooling = Readonly<Record<string, ToolingTaskShape>>;

interface ToolingServiceContribution {
  readonly name: string;
  readonly serviceTypeId?: string;
  readonly tooling?: EffectiveTooling;
}

const effectiveToolingByPlan = new WeakMap<AppPlan, EffectiveTooling>();

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

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

  return sortedTooling(
    applyToolingDefaults({ ...contributed, ...input.landofile.tooling }, input.landofile.toolingDefaults) ??
      {},
  );
};

export const validateServiceTypeReservedToolingNames = (input: {
  readonly landofile: Pick<LandofileShape, "tooling">;
  readonly services: ReadonlyArray<ToolingServiceContribution>;
}): CommandAliasConflictError | undefined => {
  const contributed: Record<string, string> = {};
  for (const service of [...input.services].sort((left, right) => compareOrdinal(left.name, right.name))) {
    for (const name of Object.keys(service.tooling ?? {}).sort(compareOrdinal)) {
      if (contributed[name] !== undefined) continue;
      contributed[name] = service.serviceTypeId ?? service.name;
    }
  }

  const landofileTooling = input.landofile.tooling ?? {};
  for (const name of Object.keys(contributed).sort(compareOrdinal)) {
    if (Object.hasOwn(landofileTooling, name)) continue;
    const serviceTypeId = contributed[name];
    if (serviceTypeId === undefined) continue;
    const conflict = reservedToolingNameConflict(name, `service type ${serviceTypeId} task ${name}`);
    if (conflict !== undefined) return conflict;
  }
  return undefined;
};

export const attachEffectiveTooling = (plan: AppPlan, tooling: EffectiveTooling): AppPlan => {
  effectiveToolingByPlan.set(plan, sortedTooling(tooling));
  return plan;
};

export const effectiveToolingForPlan = (plan: AppPlan): EffectiveTooling | undefined =>
  effectiveToolingByPlan.get(plan);
