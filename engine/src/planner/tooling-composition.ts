import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";
import { type LandofileShape, ServiceName, type ToolingTaskShape } from "@lando/sdk/schema";

export type EffectiveTooling = Readonly<Record<string, ToolingTaskShape>>;

export const enabledToolingEntries = (tooling: EffectiveTooling) =>
  Object.entries(tooling).filter(([, task]) => task.disabled !== true);

export interface ToolingServiceContribution {
  readonly name: string;
  readonly serviceTypeId?: string;
  readonly tooling?: EffectiveTooling;
  readonly connectionClientNames?: readonly string[];
}

export interface ToolingComposition {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults">;
  readonly services: readonly ToolingServiceContribution[];
}

export const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const toolingContributors = (services: readonly ToolingServiceContribution[]) => {
  const winners = new Map<string, ToolingServiceContribution>();
  for (const service of [...services].sort((left, right) => compareOrdinal(left.name, right.name))) {
    for (const name of Object.keys(service.tooling ?? {}).sort(compareOrdinal)) {
      if (!winners.has(name)) winners.set(name, service);
    }
  }
  return winners;
};

export const toolingBeforeDefaults = (input: ToolingComposition): EffectiveTooling => {
  const contributed: Record<string, ToolingTaskShape> = {};
  for (const [name, service] of toolingContributors(input.services)) {
    const task = service.tooling?.[name];
    if (task !== undefined) contributed[name] = { service: service.name, ...task };
  }
  return { ...contributed, ...input.landofile.tooling };
};

export const compileEffectiveTooling = (input: ToolingComposition): EffectiveTooling =>
  rememberInternalToolingTasks(
    Object.fromEntries(
      Object.entries(
        applyToolingDefaults(toolingBeforeDefaults(input), input.landofile.toolingDefaults) ?? {},
      ).sort(([left], [right]) => compareOrdinal(left, right)),
    ),
    getInternalToolingTasks(input.landofile),
  );

export const connectionClientOwners = (input: ToolingComposition): Readonly<Record<string, ServiceName>> =>
  Object.fromEntries(
    [...toolingContributors(input.services)].flatMap(([name, service]) =>
      !Object.hasOwn(input.landofile.tooling ?? {}, name) && service.connectionClientNames?.includes(name)
        ? [[name, ServiceName.make(service.name)]]
        : [],
    ),
  );
