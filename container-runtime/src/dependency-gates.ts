import type { ServiceDependencyCondition } from "@lando/sdk/schema";

/**
 * The single source of the synthetic dependency-gate id vocabulary.
 *
 * A gate is the point in an orchestration graph where a `depends_on` condition
 * becomes satisfiable: `<service>:running`, `<service>:healthy`, or
 * `<service>:completed`. Core's app-build graph and the providers' service-start
 * graphs both address gates by these ids, so the spelling lives here rather than
 * being re-derived on either side.
 */
const SUFFIX_BY_CONDITION = {
  service_started: "running",
  service_healthy: "healthy",
  service_completed_successfully: "completed",
} as const satisfies Readonly<Record<ServiceDependencyCondition, string>>;

type GateSuffix = (typeof SUFFIX_BY_CONDITION)[ServiceDependencyCondition];

const CONDITION_BY_SUFFIX = {
  running: "service_started",
  healthy: "service_healthy",
  completed: "service_completed_successfully",
} as const satisfies Readonly<Record<GateSuffix, ServiceDependencyCondition>>;

/** Every dependency condition, in the order the Compose vocabulary declares them. */
export const GATE_CONDITIONS: ReadonlyArray<ServiceDependencyCondition> = [
  "service_started",
  "service_healthy",
  "service_completed_successfully",
];

export interface ParsedGateId {
  readonly service: string;
  readonly condition: ServiceDependencyCondition;
}

/** The synthetic node id that satisfies `condition` for `service`. */
export const gateId = (service: string, condition: ServiceDependencyCondition): string =>
  `${service}:${SUFFIX_BY_CONDITION[condition]}`;

/** Internal schedule-node id for a user-facing dependency gate label. */
export const gateNodeId = (service: string, condition: ServiceDependencyCondition): string =>
  `gate:${gateId(service, condition)}`;

const isGateSuffix = (value: string): value is GateSuffix =>
  Object.hasOwn(CONDITION_BY_SUFFIX, value) && value !== "__proto__";

/**
 * Reads a gate id back into its service and condition. Returns `undefined` for
 * anything else — notably build-step ids such as `web:app:install`, which carry
 * their own colons and must never be mistaken for a gate.
 */
export const parseGateId = (id: string): ParsedGateId | undefined => {
  const separator = id.indexOf(":");
  if (separator <= 0) return undefined;
  const service = id.slice(0, separator);
  const suffix = id.slice(separator + 1);
  if (!isGateSuffix(suffix)) return undefined;
  return { service, condition: CONDITION_BY_SUFFIX[suffix] };
};
