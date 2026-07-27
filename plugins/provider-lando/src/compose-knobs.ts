import { Either, ParseResult, Schema } from "effect";

import { ComposeServiceKnobKey, type HostPlatform, ServiceConfig, type ServicePlan } from "@lando/sdk/schema";

import {
  type InvalidKnob,
  deviceMappings,
  extraHostEntries,
  groupEntries,
  knobBoolean,
  logConfig,
  nonNegativeInteger,
  positiveInteger,
  scalarTextMap,
  tmpfsMounts,
  ulimitEntries,
} from "./compose-knobs-values.ts";

// =============================================================================
// Podman Compose runtime-knob realization — preserved Compose knobs to the
// docker-compatible `POST /containers/create` request. `HostConfig.*` targets
// are flat inside `HostConfig` because Docker embeds `Resources` into it.
// =============================================================================

/**
 * Provider-edge revalidation schema. `ServicePlan.extensions` is typed
 * `Record<string, unknown>`, so canonicalized knob values arrive here untyped.
 * The property signatures are picked straight off `ServiceConfig` — which
 * spreads `ComposeServiceKnobFields` verbatim — so the provider never re-spells
 * an SDK schema. Decoding runs the full field transforms: a `ServiceConfig`
 * field transform must accept its own canonical output as an input variant
 * (`sdk/AGENTS.md`), so re-decoding a canonical value is idempotent and still
 * rejects anything core could not have produced.
 */
const PodmanComposeKnobs = ServiceConfig.pick(
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "tmpfs",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "init",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "logging",
);
type PodmanComposeKnobValues = typeof PodmanComposeKnobs.Type;
type PodmanKnobKey = keyof PodmanComposeKnobValues;

/**
 * Where one knob lands in the create request. Absent slots mean the knob was
 * not present on the service.
 */
interface KnobFragment {
  readonly hostConfig?: Record<string, unknown>;
  readonly topLevel?: Record<string, unknown>;
  readonly query?: Record<string, string>;
}

interface KnobRealizer {
  /**
   * Host platforms whose Podman honors the knob. Every knob currently supports
   * all three: Podman always runs the container in a Linux runtime (native on
   * Linux, a Podman machine VM on darwin and win32), so the compat create
   * handler behaves identically. The field stays so future divergence is
   * expressible without reshaping the registry.
   */
  readonly supportedOn: ReadonlyArray<HostPlatform>;
  readonly realize: (knobs: PodmanComposeKnobValues, fail: InvalidKnob) => KnobFragment;
}

type KnobReader = (knobs: PodmanComposeKnobValues, fail: InvalidKnob) => unknown;

const PODMAN_KNOB_PLATFORMS: ReadonlyArray<HostPlatform> = ["linux", "darwin", "win32"];

const hostConfigKnob = (field: string, read: KnobReader): KnobRealizer => ({
  supportedOn: PODMAN_KNOB_PLATFORMS,
  realize: (knobs, fail) => {
    const value = read(knobs, fail);
    return value === undefined ? {} : { hostConfig: { [field]: value } };
  },
});

const topLevelKnob = (field: string, read: KnobReader): KnobRealizer => ({
  supportedOn: PODMAN_KNOB_PLATFORMS,
  realize: (knobs, fail) => {
    const value = read(knobs, fail);
    return value === undefined ? {} : { topLevel: { [field]: value } };
  },
});

const queryKnob = (
  parameter: string,
  read: (knobs: PodmanComposeKnobValues) => string | undefined,
): KnobRealizer => ({
  supportedOn: PODMAN_KNOB_PLATFORMS,
  realize: (knobs) => {
    const value = read(knobs);
    return value === undefined ? {} : { query: { [parameter]: value } };
  },
});

/**
 * Three preserved knobs are deliberately absent, and stay absent so the
 * planner's fail-closed capability gate rejects them before this code runs:
 *
 * - `pull_policy` — Podman's compat `POST /containers/create` has no
 *   pull-policy field (pulls go through `/images/create`), and
 *   `ArtifactPullSpec` is `{ ref }` only. Realizing it would need a new
 *   provider-neutral plan field, which this wave forbids.
 * - `gpus` — Podman's compat handler honors `HostConfig.DeviceRequests` only
 *   for `Driver: "cdi"` plus `DeviceIDs`; `count`, `capabilities`, and
 *   `options` are parsed and ignored, so the mapping cannot be total.
 * - `deploy.resources` — core classifies `reservations.cpus` and
 *   `reservations.generic_resources` as preserved, and Podman has no
 *   equivalent. The capability surface is per-key, so declaring the coarse key
 *   would claim support for subfields that would then be silently dropped.
 */
const PODMAN_COMPOSE_KNOB_REGISTRY = {
  restart: hostConfigKnob("RestartPolicy", ({ restart }) =>
    restart === undefined ? undefined : { Name: restart },
  ),
  cap_add: hostConfigKnob("CapAdd", ({ cap_add }) => cap_add),
  cap_drop: hostConfigKnob("CapDrop", ({ cap_drop }) => cap_drop),
  privileged: hostConfigKnob("Privileged", ({ privileged }, fail) =>
    knobBoolean("privileged", privileged, fail),
  ),
  devices: hostConfigKnob("Devices", ({ devices }) => deviceMappings(devices)),
  ulimits: hostConfigKnob("Ulimits", ({ ulimits }, fail) => ulimitEntries(ulimits, fail)),
  sysctls: hostConfigKnob("Sysctls", ({ sysctls }) => scalarTextMap(sysctls)),
  tmpfs: hostConfigKnob("Tmpfs", ({ tmpfs }, fail) => tmpfsMounts(tmpfs, fail)),
  shm_size: hostConfigKnob("ShmSize", ({ shm_size }, fail) => positiveInteger("shm_size", shm_size, fail)),
  dns: hostConfigKnob("Dns", ({ dns }) => dns),
  dns_search: hostConfigKnob("DnsSearch", ({ dns_search }) => dns_search),
  dns_opt: hostConfigKnob("DnsOptions", ({ dns_opt }) => dns_opt),
  extra_hosts: hostConfigKnob("ExtraHosts", ({ extra_hosts }) => extraHostEntries(extra_hosts)),
  init: hostConfigKnob("Init", ({ init }, fail) => knobBoolean("init", init, fail)),
  stop_signal: topLevelKnob("StopSignal", ({ stop_signal }) => stop_signal),
  stop_grace_period: topLevelKnob("StopTimeout", ({ stop_grace_period }, fail) =>
    nonNegativeInteger("stop_grace_period", stop_grace_period, fail),
  ),
  security_opt: hostConfigKnob("SecurityOpt", ({ security_opt }) => security_opt),
  group_add: hostConfigKnob("GroupAdd", ({ group_add }) => groupEntries(group_add)),
  read_only: hostConfigKnob("ReadonlyRootfs", ({ read_only }, fail) =>
    knobBoolean("read_only", read_only, fail),
  ),
  platform: queryKnob("platform", ({ platform }) => platform),
  logging: hostConfigKnob("LogConfig", ({ logging }, fail) => logConfig(logging, fail)),
} satisfies Partial<Record<ComposeServiceKnobKey, KnobRealizer>>;

// Published knob order, so realization and capability declaration are both
// deterministic; membership comes from the revalidation schema itself.
const PODMAN_KNOB_KEYS: ReadonlyArray<PodmanKnobKey> = ComposeServiceKnobKey.literals.filter(
  (key): key is PodmanKnobKey => Object.hasOwn(PodmanComposeKnobs.fields, key),
);

export const podmanComposeKnobsForPlatform = (platform: HostPlatform): ReadonlyArray<ComposeServiceKnobKey> =>
  PODMAN_KNOB_KEYS.filter((key) => PODMAN_COMPOSE_KNOB_REGISTRY[key].supportedOn.includes(platform));

interface PodmanComposeKnobRealization {
  readonly hostConfig: Record<string, unknown>;
  readonly topLevel: Record<string, unknown>;
  readonly query: Record<string, string>;
}

interface RealizePodmanComposeKnobsOptions {
  readonly onInvalid: InvalidKnob;
}

const decodeComposeKnobs = Schema.decodeUnknownEither(PodmanComposeKnobs);

const serviceKnobValues = (service: ServicePlan, fail: InvalidKnob): PodmanComposeKnobValues => {
  const compose = service.extensions.compose;
  if (compose === undefined) return {};

  const decoded = decodeComposeKnobs(compose);
  if (Either.isRight(decoded)) return decoded.right;

  const issues = ParseResult.ArrayFormatter.formatErrorSync(decoded.left);
  const knobs = Array.from(new Set(issues.map((issue) => String(issue.path[0] ?? "compose"))));
  const names = knobs.map((knob) => `\`${knob}\``).join(", ");
  return fail(`Compose runtime knob${knobs.length === 1 ? "" : "s"} ${names} could not be realized.`, {
    knobs,
    issues,
  });
};

/**
 * Realize every supported preserved Compose knob on `service` into the Podman
 * create request. Synchronous and loud: an unusable value raises through
 * `onInvalid`, which the caller wraps in `Effect.try`.
 */
export const realizePodmanComposeKnobs = (
  service: ServicePlan,
  options: RealizePodmanComposeKnobsOptions,
): PodmanComposeKnobRealization => {
  const fail: InvalidKnob = (message, details) =>
    options.onInvalid(message, { service: service.name, ...details });
  const knobs = serviceKnobValues(service, fail);

  const hostConfig: Record<string, unknown> = {};
  const topLevel: Record<string, unknown> = {};
  const query: Record<string, string> = {};

  for (const key of PODMAN_KNOB_KEYS) {
    const fragment = PODMAN_COMPOSE_KNOB_REGISTRY[key].realize(knobs, fail);
    Object.assign(hostConfig, fragment.hostConfig);
    Object.assign(topLevel, fragment.topLevel);
    Object.assign(query, fragment.query);
  }

  return { hostConfig, topLevel, query };
};
