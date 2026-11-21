import { type PathSegment, expressionScopeMembers } from "@lando/sdk/expressions";
import { servicePortExpression } from "@lando/sdk/landofile/execution-sites";
import {
  type LandofileShape,
  type ParsedPendingSite,
  type ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import type { PluginRegistry, ServiceType } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";
import { loadServiceTypeWithVersion, serviceTypeFor } from "./service-types.ts";

export const plannedPortFor = (select: ServiceType["plannedPort"], service: ServiceConfig) => {
  const { port, via, framework, type } = service;
  return select?.({
    ...(port === undefined ? {} : { port }),
    ...(via === undefined ? {} : { via }),
    ...(framework === undefined ? {} : { framework }),
    ...(type === undefined ? {} : { type }),
  });
};

const literalMember = (segment: PathSegment | undefined) =>
  segment?.type === "prop" ? segment.name : segment?.type === "key" ? segment.key : undefined;

export const ownPortReplacement = Effect.fnUntraced(function* (input: {
  readonly landofile: LandofileShape;
  readonly deferredSites: readonly ParsedPendingSite[];
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly name: string;
  readonly site: ParsedPendingSite;
}) {
  const { name, site } = input;
  const reads = site.template.segments
    .filter((segment) => segment.kind === "InterpolationSegment")
    .filter((segment) =>
      expressionScopeMembers({ whole: true, segments: [segment] }, "services").members.has(name),
    );
  const first = reads[0];
  if (
    first === undefined ||
    !reads.every(
      ({ expression }) =>
        expression.kind === "Path" &&
        expression.head === "services" &&
        expression.segments.length === 2 &&
        literalMember(expression.segments[0]) === name &&
        literalMember(expression.segments[1]) === "port",
    )
  )
    return false;
  const replacement = {
    ...site.template,
    segments: [
      {
        ...first,
        expression: { kind: "Path", head: "service", segments: [{ type: "prop", name: "port" }] },
      },
    ],
  } as const;
  if (servicePortExpression(replacement, site.path) !== "supported") return false;
  const service = input.landofile.services?.[ServiceName.make(name)];
  if (service === undefined) return false;
  const readiness = site.path[2] === "readiness";
  if (readiness && service.readiness && service.readiness.target === "host") return false;
  if (
    input.deferredSites.some(
      ({ path: [section, owner, field, child] }) =>
        section === "services" &&
        owner === name &&
        (field === "type" ||
          field === "image" ||
          field === "port" ||
          field === "via" ||
          field === "framework" ||
          (readiness && field === "readiness" && child === "target")),
    )
  )
    return false;
  const loaded = yield* loadServiceTypeWithVersion(
    input.pluginRegistry,
    serviceTypeFor(name, service, input.registeredServiceTypeIds),
  ).pipe(Effect.result);
  if (Result.isFailure(loaded)) return false;
  const { serviceType, version } = loaded.success;
  if (version !== undefined && !serviceType.versions?.includes(version)) return false;
  return plannedPortFor(serviceType.plannedPort, service) !== undefined;
});
