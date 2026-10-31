import { Schema } from "effect";
import { type EndpointPlan, EndpointRef, type EndpointScan } from "./endpoint.ts";

// ============================================================================
// Pure logical listener grouping, invariants, and HTTP route selection.
// ============================================================================

export const LogicalEndpoint = EndpointRef.pipe(
  Schema.fieldsAssign({
    protocols: Schema.Array(Schema.Literals(["http", "https", "tcp", "udp"])).annotate({
      description: "Distinct explicitly declared protocols of the listener.",
    }),
  }),
);
export type LogicalEndpoint = typeof LogicalEndpoint.Type;

export const EndpointInvariantIssue = Schema.Struct({
  kind: Schema.Literals([
    "alias-collision",
    "protocol-conflict",
    "multiple-primary",
    "scan-conflict",
  ]).annotate({
    description: "Logical listener invariant violated by the declarations.",
  }),
  identities: Schema.Array(Schema.String).annotate({
    description: "Logical identities involved in the violation.",
  }),
  name: Schema.optionalKey(Schema.String).annotate({ description: "Colliding alias, when applicable." }),
});
export type EndpointInvariantIssue = typeof EndpointInvariantIssue.Type;

export const HttpEndpointSelection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("selected").annotate({
      description: "Exactly one eligible listener was selected.",
    }),
    endpoint: EndpointRef.pipe(
      Schema.fieldsAssign({
        transport: Schema.Literal("tcp").annotate({ description: "HTTP listeners use TCP transport." }),
        protocol: Schema.Literals(["http", "https"]).annotate({
          description: "The single selected HTTP listener protocol.",
        }),
      }),
    ).annotate({ description: "Selected logical HTTP listener." }),
  }),
  Schema.Struct({
    status: Schema.Literal("none").annotate({ description: "No eligible HTTP listener exists." }),
  }),
  Schema.Struct({
    status: Schema.Literal("ambiguous").annotate({
      description: "Selection cannot identify one consistent HTTP listener.",
    }),
    candidates: Schema.Array(LogicalEndpoint).annotate({
      description: "Conflicting eligible logical listeners.",
    }),
  }),
]);
export type HttpEndpointSelection = typeof HttpEndpointSelection.Type;

export const logicalEndpointIdentity = (endpoint: EndpointPlan | EndpointRef): string =>
  "protocol" in endpoint
    ? endpoint.protocol === "unix"
      ? `unix:${endpoint.socketPath}`
      : `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`
    : `${endpoint.port}/${endpoint.transport}`;

export const groupLogicalEndpoints = (endpoints: readonly EndpointPlan[]): readonly LogicalEndpoint[] => {
  const groups = new Map<string, LogicalEndpoint>();
  for (const endpoint of endpoints) {
    if (endpoint.protocol === "unix") continue;
    const identity = logicalEndpointIdentity(endpoint);
    const previous = groups.get(identity);
    groups.set(identity, {
      port: endpoint.port,
      transport: endpoint.protocol === "udp" ? "udp" : "tcp",
      primary: endpoint.primary === true || previous?.primary === true,
      names: [
        ...new Set([...(previous?.names ?? []), ...(endpoint.name === undefined ? [] : [endpoint.name])]),
      ].sort(),
      protocols: [...new Set([...(previous?.protocols ?? []), endpoint.protocol])].sort(),
    });
  }
  return [...groups.values()];
};

export const endpointInvariantIssues = (
  endpoints: readonly EndpointPlan[],
): readonly EndpointInvariantIssue[] => {
  const groups = groupLogicalEndpoints(endpoints);
  const issues: EndpointInvariantIssue[] = [];
  const aliases = new Map<string, Set<string>>();
  const scans = new Map<string, EndpointScan>();
  const scanConflicts = new Set<string>();
  for (const endpoint of endpoints) {
    if (endpoint.scan === undefined) continue;
    const identity = logicalEndpointIdentity(endpoint);
    const previous = scans.get(identity);
    const { path, okCodes } = endpoint.scan;
    if (
      (previous?.path !== undefined && path !== undefined && previous.path !== path) ||
      (previous?.okCodes !== undefined &&
        okCodes !== undefined &&
        (previous.okCodes.some((code) => !okCodes.includes(code)) ||
          okCodes.some((code) => !previous.okCodes?.includes(code))))
    )
      scanConflicts.add(identity);
    scans.set(identity, { ...previous, ...endpoint.scan });
  }
  for (const identity of scanConflicts) issues.push({ kind: "scan-conflict", identities: [identity] });
  for (const group of groups) {
    const identity = logicalEndpointIdentity(group);
    if (group.protocols.length > 1) issues.push({ kind: "protocol-conflict", identities: [identity] });
  }
  for (const endpoint of endpoints) {
    if (endpoint.name === undefined) continue;
    const identities = aliases.get(endpoint.name) ?? new Set<string>();
    identities.add(logicalEndpointIdentity(endpoint));
    aliases.set(endpoint.name, identities);
  }
  for (const [name, identities] of aliases) {
    if (identities.size > 1) issues.push({ kind: "alias-collision", name, identities: [...identities] });
  }
  const primaries = groups.filter((group) => group.primary);
  if (primaries.length > 1)
    issues.push({
      kind: "multiple-primary",
      identities: primaries.map(logicalEndpointIdentity),
    });
  return issues;
};

export const selectHttpEndpoint = (
  endpoints: readonly EndpointPlan[],
  selector?: string | number,
): HttpEndpointSelection => {
  const groups = groupLogicalEndpoints(endpoints);
  const matching =
    selector === undefined
      ? groups
      : groups.filter((group) =>
          typeof selector === "number" ? group.port === selector : group.names.includes(selector),
        );
  const http = matching.filter((group) =>
    group.protocols.some((protocol) => protocol === "http" || protocol === "https"),
  );
  const primary = http.filter((group) => group.primary);
  const candidates = selector === undefined && primary.length > 0 ? primary : http;
  const candidate = candidates[0];
  if (candidate === undefined) return { status: "none" };
  const protocol = candidate.protocols[0];
  if (
    candidates.length > 1 ||
    candidate.protocols.length !== 1 ||
    (protocol !== "http" && protocol !== "https")
  )
    return { status: "ambiguous", candidates };
  return {
    status: "selected",
    endpoint: {
      port: candidate.port,
      transport: "tcp",
      names: candidate.names,
      primary: candidate.primary,
      protocol,
    },
  };
};
