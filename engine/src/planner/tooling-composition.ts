import type { LandofileProvenance } from "@lando/landofile/provenance";
import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import { type LandofileShape, ServiceName, type ToolingTaskShape } from "@lando/sdk/schema";
import type { ServiceLaunchers } from "@lando/sdk/services";

export type EffectiveTooling = Readonly<Record<string, ToolingTaskShape>>;

export const enabledToolingEntries = (tooling: EffectiveTooling) =>
  Object.entries(tooling).filter(([, task]) => task.disabled !== true);

export interface ToolingServiceContribution {
  readonly name: string;
  readonly serviceTypeId?: string;
  readonly tooling?: EffectiveTooling;
  readonly launchers?: ServiceLaunchers;
  readonly connectionClientNames?: readonly string[];
}

export interface ToolingComposition {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults" | "services">;
  readonly provenance?: LandofileProvenance | undefined;
  readonly primary?: string | undefined;
  readonly services: readonly ToolingServiceContribution[];
}

export const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const toolingContributors = ({
  services,
  primary,
}: Pick<ToolingComposition, "services" | "primary">) => {
  const winners = new Map<string, ToolingServiceContribution>();
  const nodeClaims = new Map<string, number>();
  const isNode = (service: ToolingServiceContribution) =>
    service.serviceTypeId === "node" || service.serviceTypeId?.startsWith("node:");
  for (const service of services) {
    if (isNode(service)) {
      for (const name of Object.keys(service.tooling ?? {}))
        nodeClaims.set(name, (nodeClaims.get(name) ?? 0) + 1);
    }
  }
  const ordered = [...services].sort(
    (left, right) =>
      Number(right.name === primary) - Number(left.name === primary) || compareOrdinal(left.name, right.name),
  );
  for (const service of ordered) {
    for (const name of Object.keys(service.tooling ?? {}).sort(compareOrdinal)) {
      if (isNode(service) && nodeClaims.get(name) !== 1) continue;
      if (!winners.has(name)) winners.set(name, service);
    }
  }
  return winners;
};

export const toolingBeforeDefaults = (input: ToolingComposition): EffectiveTooling => {
  const contributed: Record<string, ToolingTaskShape> = {};
  for (const [name, service] of toolingContributors(input)) {
    const task = service.tooling?.[name];
    if (task !== undefined) contributed[name] = { service: service.name, ...task };
  }
  return { ...contributed, ...input.landofile.tooling };
};

export const compileEffectiveTooling = (input: ToolingComposition): EffectiveTooling =>
  Object.fromEntries(
    Object.entries(
      applyToolingDefaults(toolingBeforeDefaults(input), input.landofile.toolingDefaults) ?? {},
    ).sort(([left], [right]) => compareOrdinal(left, right)),
  );

export const connectionClientOwners = (input: ToolingComposition): Readonly<Record<string, ServiceName>> =>
  Object.fromEntries(
    [...toolingContributors(input)].flatMap(([name, service]) =>
      !Object.hasOwn(input.landofile.tooling ?? {}, name) && service.connectionClientNames?.includes(name)
        ? [[name, ServiceName.make(service.name)]]
        : [],
    ),
  );
