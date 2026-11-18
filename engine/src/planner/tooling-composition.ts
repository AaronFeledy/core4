import type { LandofileProvenance } from "@lando/landofile/provenance";
import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import { type LandofileShape, ServiceName, type ToolingTaskShape } from "@lando/sdk/schema";
import { primaryServiceName } from "./effective-events.ts";
import { lowerNodeLocalTooling } from "./node-local-tooling.ts";

export type EffectiveTooling = Readonly<Record<string, ToolingTaskShape>>;

export const enabledToolingEntries = (tooling: EffectiveTooling) =>
  Object.entries(tooling).filter(([, task]) => task.disabled !== true);

export interface ToolingServiceContribution {
  readonly name: string;
  readonly serviceTypeId?: string;
  readonly tooling?: EffectiveTooling;
  readonly metadata?: unknown;
  readonly connectionClientNames?: readonly string[];
}

export interface ToolingComposition {
  readonly landofile: Pick<LandofileShape, "tooling" | "toolingDefaults" | "services">;
  readonly provenance?: LandofileProvenance | undefined;
  readonly services: readonly ToolingServiceContribution[];
}

export const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const toolingContributors = (services: readonly ToolingServiceContribution[]) => {
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
  for (const service of [...services].sort((left, right) => compareOrdinal(left.name, right.name))) {
    for (const name of Object.keys(service.tooling ?? {}).sort(compareOrdinal)) {
      if (isNode(service) && nodeClaims.get(name) !== 1) continue;
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
  const serviceMetadata = new Map(input.services.map(({ name, metadata }) => [name, metadata]));
  // Lower against the service the task will run in: its own, the tooling default, then the primary.
  const fallbackService =
    input.landofile.toolingDefaults?.service ?? primaryServiceName(input.landofile.services);
  const authored = Object.entries(input.landofile.tooling ?? {}).map(([name, task]) => {
    const service = task.service ?? fallbackService;
    return [
      name,
      lowerNodeLocalTooling(task, service === undefined ? undefined : serviceMetadata.get(service)),
    ];
  });
  return { ...contributed, ...Object.fromEntries(authored) };
};

export const compileEffectiveTooling = (input: ToolingComposition): EffectiveTooling =>
  Object.fromEntries(
    Object.entries(
      applyToolingDefaults(toolingBeforeDefaults(input), input.landofile.toolingDefaults) ?? {},
    ).sort(([left], [right]) => compareOrdinal(left, right)),
  );

export const connectionClientOwners = (input: ToolingComposition): Readonly<Record<string, ServiceName>> =>
  Object.fromEntries(
    [...toolingContributors(input.services)].flatMap(([name, service]) =>
      !Object.hasOwn(input.landofile.tooling ?? {}, name) && service.connectionClientNames?.includes(name)
        ? [[name, ServiceName.make(service.name)]]
        : [],
    ),
  );
