import { type AppPlan, type LandofileShape, ServiceName, ToolingTaskShape } from "@lando/sdk/schema";
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
  readonly connectionClientNames?: readonly string[];
}

const TOOLING_PLAN_KEY = "@lando/core/effective-tooling";
const ToolingPlan = Schema.Struct({
  tasks: Schema.Record(Schema.String, ToolingTaskShape),
  internalNames: Schema.Array(Schema.String),
  connectionClients: Schema.optionalKey(Schema.Record(Schema.String, ServiceName)),
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

export const connectionClientOwners = (input: {
  readonly landofile: Pick<LandofileShape, "tooling">;
  readonly services: ReadonlyArray<ToolingServiceContribution>;
}): Readonly<Record<string, ServiceName>> => {
  const owners: Record<string, ServiceName> = {};
  const claimed = new Set(Object.keys(input.landofile.tooling ?? {}));
  for (const service of [...input.services].sort((a, b) => compareOrdinal(a.name, b.name))) {
    for (const name of Object.keys(service.tooling ?? {})) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      if (service.connectionClientNames?.includes(name)) owners[name] = ServiceName.make(service.name);
    }
  }
  return owners;
};

export const connectionClientsForPlan = (plan: AppPlan): Readonly<Record<string, ServiceName>> => {
  const value = plan.extensions[TOOLING_PLAN_KEY];
  return value === undefined ? {} : (Schema.decodeUnknownSync(ToolingPlan)(value).connectionClients ?? {});
};

export const attachEffectiveTooling = <Plan extends AppPlan>(
  plan: Plan,
  tooling: EffectiveTooling,
  connectionClients: Readonly<Record<string, ServiceName>> = {},
): Plan => {
  return {
    ...plan,
    extensions: {
      ...plan.extensions,
      [TOOLING_PLAN_KEY]: {
        tasks: tooling,
        internalNames: [...getInternalToolingTasks(tooling)],
        connectionClients,
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
