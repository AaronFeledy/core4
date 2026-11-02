import { Struct } from "effect";
import { SchemaIssue } from "effect";
import { Result, Schema } from "effect";

import { ComposeServiceKnobKey, ServiceConfig, type ServicePlan } from "@lando/sdk/schema";
import type { EngineDialect } from "../dialect.ts";
import { extraHostEntries, realizeHostAliases } from "../host-aliases.ts";

import {
  type InvalidKnob,
  deviceMappings,
  groupEntries,
  knobBoolean,
  logConfig,
  nonNegativeInteger,
  positiveInteger,
  scalarTextMap,
  ulimitEntries,
} from "./compose-knobs-values.ts";

/**
 * Provider-edge revalidation schema. `ServicePlan.extensions` is typed
 * `Record<string, unknown>`, so canonicalized knob values arrive here untyped.
 * The property signatures come from `ServiceConfig`, so the provider does not
 * duplicate the SDK schema. Its field transforms accept canonical output,
 * making re-decoding idempotent while rejecting values core could not produce.
 *
 * `tmpfs` is intentionally absent: planned tmpfs lives on `ServicePlan.mounts`
 * and is realized by the mount renderers, not the Compose knob registry.
 */
const PodmanComposeKnobs = Schema.Struct(
  Struct.pick(ServiceConfig.fields, [
    "restart",
    "cap_add",
    "cap_drop",
    "privileged",
    "devices",
    "ulimits",
    "sysctls",
    "shm_size",
    "dns",
    "dns_search",
    "dns_opt",
    "extra_hosts",
    "stop_signal",
    "stop_grace_period",
    "security_opt",
    "group_add",
    "read_only",
    "platform",
    "logging",
  ]),
);
type PodmanComposeKnobValues = typeof PodmanComposeKnobs.Type;

interface KnobFragment {
  readonly hostConfig?: Record<string, unknown>;
  readonly topLevel?: Record<string, unknown>;
  readonly query?: Record<string, string>;
}

interface KnobRealizer {
  readonly dialects: ReadonlyArray<EngineDialect>;
  readonly realize: (knobs: PodmanComposeKnobValues, fail: InvalidKnob, service: ServicePlan) => KnobFragment;
}

type KnobReader = (knobs: PodmanComposeKnobValues, fail: InvalidKnob, service: ServicePlan) => unknown;

const hostConfigKnob = (
  dialects: ReadonlyArray<EngineDialect>,
  field: string,
  read: KnobReader,
): KnobRealizer => ({
  dialects,
  realize: (knobs, fail, service) => {
    const value = read(knobs, fail, service);
    return value === undefined ? {} : { hostConfig: { [field]: value } };
  },
});

const topLevelKnob = (
  dialects: ReadonlyArray<EngineDialect>,
  field: string,
  read: KnobReader,
): KnobRealizer => ({
  dialects,
  realize: (knobs, fail, service) => {
    const value = read(knobs, fail, service);
    return value === undefined ? {} : { topLevel: { [field]: value } };
  },
});

const queryKnob = (
  dialects: ReadonlyArray<EngineDialect>,
  parameter: string,
  read: (knobs: PodmanComposeKnobValues) => string | undefined,
): KnobRealizer => ({
  dialects,
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
 *   `ArtifactPullSpec.policy` carries only a per-command policy. Realizing
 *   per-service pull policy would need a provider-neutral plan field that does not exist.
 * - `gpus` — Podman's compat handler honors `HostConfig.DeviceRequests` only
 *   for `Driver: "cdi"` plus `DeviceIDs`; `count`, `capabilities`, and
 *   `options` are parsed and ignored, so the mapping cannot be total.
 * - `deploy.resources` — core classifies `reservations.cpus` and
 *   `reservations.generic_resources` as preserved, and Podman has no
 *   equivalent. The capability surface is per-key, so declaring the coarse key
 *   would claim support for subfields that would then be silently dropped.
 */
const PODMAN_COMPOSE_KNOB_REGISTRY = {
  restart: hostConfigKnob(["libpod", "docker"], "RestartPolicy", ({ restart }) =>
    restart === undefined ? undefined : { Name: restart },
  ),
  cap_add: hostConfigKnob(["libpod", "docker"], "CapAdd", ({ cap_add }) => cap_add),
  cap_drop: hostConfigKnob(["libpod", "docker"], "CapDrop", ({ cap_drop }) => cap_drop),
  privileged: hostConfigKnob(["libpod", "docker"], "Privileged", ({ privileged }, fail) =>
    knobBoolean("privileged", privileged, fail),
  ),
  devices: hostConfigKnob(["libpod", "docker"], "Devices", ({ devices }) => deviceMappings(devices)),
  ulimits: hostConfigKnob(["libpod", "docker"], "Ulimits", ({ ulimits }, fail) =>
    ulimitEntries(ulimits, fail),
  ),
  sysctls: hostConfigKnob(["libpod", "docker"], "Sysctls", ({ sysctls }) => scalarTextMap(sysctls)),
  shm_size: hostConfigKnob(["libpod", "docker"], "ShmSize", ({ shm_size }, fail) =>
    positiveInteger("shm_size", shm_size, fail),
  ),
  dns: hostConfigKnob(["libpod", "docker"], "Dns", ({ dns }) => dns),
  dns_search: hostConfigKnob(["libpod", "docker"], "DnsSearch", ({ dns_search }) => dns_search),
  dns_opt: hostConfigKnob(["libpod", "docker"], "DnsOptions", ({ dns_opt }) => dns_opt),
  extra_hosts: hostConfigKnob(["libpod", "docker"], "ExtraHosts", ({ extra_hosts }, _fail, service) =>
    extraHostEntries(realizeHostAliases(service.hostAliases, extra_hosts)),
  ),
  stop_signal: topLevelKnob(["libpod", "docker"], "StopSignal", ({ stop_signal }) => stop_signal),
  stop_grace_period: topLevelKnob(["libpod", "docker"], "StopTimeout", ({ stop_grace_period }, fail) =>
    nonNegativeInteger("stop_grace_period", stop_grace_period, fail),
  ),
  security_opt: hostConfigKnob(["libpod", "docker"], "SecurityOpt", ({ security_opt }) => security_opt),
  group_add: hostConfigKnob(["libpod", "docker"], "GroupAdd", ({ group_add }) => groupEntries(group_add)),
  read_only: hostConfigKnob(["libpod", "docker"], "ReadonlyRootfs", ({ read_only }, fail) =>
    knobBoolean("read_only", read_only, fail),
  ),
  platform: queryKnob(["libpod", "docker"], "platform", ({ platform }) => platform),
  logging: hostConfigKnob(["libpod", "docker"], "LogConfig", ({ logging }, fail) => logConfig(logging, fail)),
} satisfies Partial<Record<ComposeServiceKnobKey, KnobRealizer>>;

// Published knob order is deterministic; membership and dialect support belong to the realizers.
type PodmanKnobKey = keyof typeof PODMAN_COMPOSE_KNOB_REGISTRY;
const PODMAN_KNOB_KEYS: ReadonlyArray<PodmanKnobKey> = ComposeServiceKnobKey.literals.filter(
  (key): key is PodmanKnobKey => Object.hasOwn(PODMAN_COMPOSE_KNOB_REGISTRY, key),
);

/** Capabilities come from the realizers, never a provider-maintained allowlist. */
export const composeKnobsForDialect = (dialect: EngineDialect): ReadonlyArray<ComposeServiceKnobKey> =>
  PODMAN_KNOB_KEYS.filter((key) => PODMAN_COMPOSE_KNOB_REGISTRY[key].dialects.includes(dialect));

interface PodmanComposeKnobRealization {
  readonly hostConfig: Record<string, unknown>;
  readonly topLevel: Record<string, unknown>;
  readonly query: Record<string, string>;
}

interface RealizePodmanComposeKnobsOptions {
  readonly onInvalid: InvalidKnob;
  readonly dialect?: EngineDialect;
}

const decodeComposeKnobs = Schema.decodeUnknownResult(PodmanComposeKnobs);

const serviceKnobValues = (service: ServicePlan, fail: InvalidKnob): PodmanComposeKnobValues => {
  const compose = service.extensions.compose;
  if (compose === undefined) return {};

  const decoded = decodeComposeKnobs(compose);
  if (Result.isSuccess(decoded)) return decoded.success;

  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues;
  const knobs = Array.from(new Set(issues.map((issue) => String(issue.path?.[0] ?? "compose"))));
  const names = knobs.map((knob) => `\`${knob}\``).join(", ");
  return fail(`Compose runtime knob${knobs.length === 1 ? "" : "s"} ${names} could not be realized.`, {
    knobs,
    issues,
  });
};

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
    if (!PODMAN_COMPOSE_KNOB_REGISTRY[key].dialects.includes(options.dialect ?? "libpod")) continue;
    const fragment = PODMAN_COMPOSE_KNOB_REGISTRY[key].realize(knobs, fail, service);
    Object.assign(hostConfig, fragment.hostConfig);
    Object.assign(topLevel, fragment.topLevel);
    Object.assign(query, fragment.query);
  }

  return { hostConfig, topLevel, query };
};
