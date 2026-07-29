import { ComposePreservedPathKey } from "@lando/sdk/schema";

export type ComposeDisposition = "normalized" | "preserved" | "rejected";

export interface ComposeDispositionEntry {
  readonly disposition: ComposeDisposition;
  readonly rationale: string;
  readonly remediation?: string;
  readonly planTarget?: ReadonlyArray<string>;
}

export class ComposeDispositionMatrixError extends Error {
  constructor(message = "Compose service disposition paths must be unique") {
    super(message);
    this.name = "ComposeDispositionMatrixError";
  }
}

const NORMALIZED_ENTRY = {
  disposition: "normalized",
  rationale: "Normalizes into provider-neutral service plan fields.",
} as const satisfies ComposeDispositionEntry;

const PRESERVED_ENTRY = {
  disposition: "preserved",
  rationale: "Preserved losslessly in ServicePlan.extensions.compose and capability-checked.",
} as const satisfies ComposeDispositionEntry;

const PRESERVED_INERT_EXTENSION_ENTRY = {
  disposition: "preserved",
  rationale: "Preserved losslessly in ServicePlan.extensions.compose; inert and not capability-gated.",
} as const satisfies ComposeDispositionEntry;

const PRESERVED_EXACT_PATH_ENTRY = {
  disposition: "preserved",
  rationale:
    "Preserved losslessly at its exact path in ServicePlan.extensions.compose and capability-checked against composePreservedPaths; planning fails with CapabilityError when the selected provider does not declare the exact path.",
} as const satisfies ComposeDispositionEntry;

const preservedExactPaths: ReadonlySet<string> = new Set(ComposePreservedPathKey.literals);

const preservedEntry = (path: string): ComposeDispositionEntry =>
  path === "x-*"
    ? PRESERVED_INERT_EXTENSION_ENTRY
    : preservedExactPaths.has(path)
      ? PRESERVED_EXACT_PATH_ENTRY
      : PRESERVED_ENTRY;

const rejectedEntry = (path: string): ComposeDispositionEntry => {
  if (path === "extends" || path.startsWith("extends.")) {
    return {
      disposition: "rejected",
      rationale: "Compose service inheritance is replaced by Lando composition primitives.",
      remediation: `Replace ${path} with Lando type: inheritance.`,
    };
  }
  if (path === "container_name") {
    return {
      disposition: "rejected",
      rationale: "Lando owns container naming for multi-app isolation.",
      remediation: `Remove ${path} and use the Lando service key as the container identity.`,
    };
  }
  if (path === "network_mode" || path === "links") {
    return {
      disposition: "rejected",
      rationale: "Legacy Compose network shortcuts bypass Lando network planning.",
      remediation: `Translate ${path} to Lando networks: configuration.`,
    };
  }
  if (path.startsWith("deploy.") && !path.startsWith("deploy.resources")) {
    return {
      disposition: "rejected",
      rationale: "Swarm orchestration is outside the per-service Compose vocabulary.",
      remediation: `Move ${path} to a provider extension.`,
    };
  }
  return {
    disposition: "rejected",
    rationale: "This upstream Compose key has no documented Lando plan or preservation contract.",
    remediation: `Translate ${path} with a Compose-to-Lando config translator.`,
  };
};

type NormalizedServicePath = readonly [path: string, planTarget?: ReadonlyArray<string>];

const normalizedServicePaths = [
  ["build", ["artifact"]],
  ["build.args"],
  ["build.args.*"],
  ["build.context"],
  ["build.dockerfile"],
  ["build.dockerfile_inline"],
  ["build.target"],
  ["command", ["command"]],
  ["depends_on", ["dependsOn"]],
  ["depends_on.*"],
  ["depends_on.*.condition"],
  ["depends_on.*.required"],
  ["entrypoint", ["entrypoint"]],
  ["env_file", ["environment"]],
  ["environment", ["environment"]],
  ["environment.*"],
  ["expose", ["endpoints"]],
  ["healthcheck", ["healthcheck"]],
  ["healthcheck.disable"],
  ["healthcheck.interval"],
  ["healthcheck.retries"],
  ["healthcheck.start_period"],
  ["healthcheck.test"],
  ["healthcheck.timeout"],
  ["image", ["artifact"]],
  ["ports", ["endpoints"]],
  ["ports.app_protocol"],
  ["ports.host_ip"],
  ["ports.name"],
  ["ports.protocol"],
  ["ports.published"],
  ["ports.target"],
  ["user", ["user"]],
  ["volumes", ["mounts", "storage", "extensions.compose.tmpfs"]],
  // Type-specific volume options reach only their own destination, never the root's full set.
  ["volumes.bind", ["mounts"]],
  ["volumes.bind.create_host_path", ["mounts"]],
  ["volumes.read_only"],
  ["volumes.source"],
  ["volumes.target"],
  ["volumes.type"],
  ["volumes.volume", ["storage"]],
  ["volumes.volume.subpath", ["storage"]],
  ["working_dir", ["workingDirectory"]],
] as const satisfies ReadonlyArray<NormalizedServicePath>;

const preservedServicePaths = [
  "cap_add",
  "cap_drop",
  "configs",
  "configs.gid",
  "configs.mode",
  "configs.source",
  "configs.target",
  "configs.uid",
  "configs.x-*",
  "depends_on.*.restart",
  "deploy",
  "deploy.resources",
  "deploy.resources.limits",
  "deploy.resources.limits.cpus",
  "deploy.resources.limits.memory",
  "deploy.resources.limits.pids",
  "deploy.resources.limits.x-*",
  "deploy.resources.reservations",
  "deploy.resources.reservations.cpus",
  "deploy.resources.reservations.devices",
  "deploy.resources.reservations.devices.capabilities",
  "deploy.resources.reservations.devices.count",
  "deploy.resources.reservations.devices.device_ids",
  "deploy.resources.reservations.devices.driver",
  "deploy.resources.reservations.devices.options",
  "deploy.resources.reservations.devices.options.*",
  "deploy.resources.reservations.devices.x-*",
  "deploy.resources.reservations.generic_resources",
  "deploy.resources.reservations.generic_resources.discrete_resource_spec",
  "deploy.resources.reservations.generic_resources.discrete_resource_spec.kind",
  "deploy.resources.reservations.generic_resources.discrete_resource_spec.value",
  "deploy.resources.reservations.generic_resources.discrete_resource_spec.x-*",
  "deploy.resources.reservations.generic_resources.x-*",
  "deploy.resources.reservations.memory",
  "deploy.resources.reservations.x-*",
  "deploy.resources.x-*",
  "devices",
  "devices.permissions",
  "devices.source",
  "devices.target",
  "devices.x-*",
  "dns",
  "dns_opt",
  "dns_search",
  "extra_hosts",
  "extra_hosts.*",
  "gpus",
  "gpus.capabilities",
  "gpus.count",
  "gpus.device_ids",
  "gpus.driver",
  "gpus.options",
  "gpus.options.*",
  "gpus.x-*",
  "group_add",
  "healthcheck.start_interval",
  "init",
  "labels",
  "labels.*",
  "logging",
  "logging.driver",
  "logging.options",
  "logging.options.*",
  "logging.x-*",
  "networks",
  "networks.*",
  "networks.*.aliases",
  "networks.*.driver_opts",
  "networks.*.driver_opts.*",
  "networks.*.gw_priority",
  "networks.*.interface_name",
  "networks.*.ipv4_address",
  "networks.*.ipv6_address",
  "networks.*.link_local_ips",
  "networks.*.mac_address",
  "networks.*.priority",
  "networks.*.x-*",
  "platform",
  "privileged",
  "profiles",
  "pull_policy",
  "read_only",
  "restart",
  "secrets",
  "secrets.gid",
  "secrets.mode",
  "secrets.source",
  "secrets.target",
  "secrets.uid",
  "secrets.x-*",
  "security_opt",
  "shm_size",
  "stop_grace_period",
  "stop_signal",
  "sysctls",
  "sysctls.*",
  "tmpfs",
  "ulimits",
  "ulimits.*",
  "ulimits.*.hard",
  "ulimits.*.soft",
  "ulimits.*.x-*",
  "volumes.tmpfs",
  "volumes.tmpfs.mode",
  "volumes.tmpfs.size",
  "volumes.tmpfs.x-*",
  "x-*",
] as const;

const rejectedServicePaths = [
  "annotations",
  "annotations.*",
  "attach",
  "blkio_config",
  "blkio_config.device_read_bps",
  "blkio_config.device_read_bps.path",
  "blkio_config.device_read_bps.rate",
  "blkio_config.device_read_iops",
  "blkio_config.device_read_iops.path",
  "blkio_config.device_read_iops.rate",
  "blkio_config.device_write_bps",
  "blkio_config.device_write_bps.path",
  "blkio_config.device_write_bps.rate",
  "blkio_config.device_write_iops",
  "blkio_config.device_write_iops.path",
  "blkio_config.device_write_iops.rate",
  "blkio_config.weight",
  "blkio_config.weight_device",
  "blkio_config.weight_device.path",
  "blkio_config.weight_device.weight",
  "build.additional_contexts",
  "build.additional_contexts.*",
  "build.cache_from",
  "build.cache_to",
  "build.entitlements",
  "build.extra_hosts",
  "build.extra_hosts.*",
  "build.isolation",
  "build.labels",
  "build.labels.*",
  "build.network",
  "build.no_cache",
  "build.no_cache_filter",
  "build.platforms",
  "build.privileged",
  "build.provenance",
  "build.pull",
  "build.sbom",
  "build.secrets",
  "build.secrets.gid",
  "build.secrets.mode",
  "build.secrets.source",
  "build.secrets.target",
  "build.secrets.uid",
  "build.secrets.x-*",
  "build.shm_size",
  "build.ssh",
  "build.ssh.*",
  "build.tags",
  "build.ulimits",
  "build.ulimits.*",
  "build.ulimits.*.hard",
  "build.ulimits.*.soft",
  "build.ulimits.*.x-*",
  "build.x-*",
  "cgroup",
  "cgroup_parent",
  "container_name",
  "cpu_count",
  "cpu_percent",
  "cpu_period",
  "cpu_quota",
  "cpu_rt_period",
  "cpu_rt_runtime",
  "cpu_shares",
  "cpus",
  "cpuset",
  "credential_spec",
  "credential_spec.config",
  "credential_spec.file",
  "credential_spec.registry",
  "credential_spec.x-*",
  "depends_on.*.x-*",
  "deploy.endpoint_mode",
  "deploy.labels",
  "deploy.labels.*",
  "deploy.mode",
  "deploy.placement",
  "deploy.placement.constraints",
  "deploy.placement.max_replicas_per_node",
  "deploy.placement.preferences",
  "deploy.placement.preferences.spread",
  "deploy.placement.preferences.x-*",
  "deploy.placement.x-*",
  "deploy.replicas",
  "deploy.restart_policy",
  "deploy.restart_policy.condition",
  "deploy.restart_policy.delay",
  "deploy.restart_policy.max_attempts",
  "deploy.restart_policy.window",
  "deploy.restart_policy.x-*",
  "deploy.rollback_config",
  "deploy.rollback_config.delay",
  "deploy.rollback_config.failure_action",
  "deploy.rollback_config.max_failure_ratio",
  "deploy.rollback_config.monitor",
  "deploy.rollback_config.order",
  "deploy.rollback_config.parallelism",
  "deploy.rollback_config.x-*",
  "deploy.update_config",
  "deploy.update_config.delay",
  "deploy.update_config.failure_action",
  "deploy.update_config.max_failure_ratio",
  "deploy.update_config.monitor",
  "deploy.update_config.order",
  "deploy.update_config.parallelism",
  "deploy.update_config.x-*",
  "deploy.x-*",
  "develop",
  "develop.watch",
  "develop.watch.action",
  "develop.watch.exec",
  "develop.watch.exec.command",
  "develop.watch.exec.environment",
  "develop.watch.exec.environment.*",
  "develop.watch.exec.privileged",
  "develop.watch.exec.user",
  "develop.watch.exec.working_dir",
  "develop.watch.exec.x-*",
  "develop.watch.ignore",
  "develop.watch.include",
  "develop.watch.initial_sync",
  "develop.watch.path",
  "develop.watch.target",
  "develop.watch.x-*",
  "develop.x-*",
  "device_cgroup_rules",
  "domainname",
  "env_file.format",
  "env_file.path",
  "env_file.required",
  "extends",
  "extends.file",
  "extends.service",
  "external_links",
  "healthcheck.x-*",
  "hostname",
  "ipc",
  "isolation",
  "label_file",
  "links",
  "mac_address",
  "mem_limit",
  "mem_reservation",
  "mem_swappiness",
  "memswap_limit",
  "models",
  "models.*",
  "models.*.endpoint_var",
  "models.*.model_var",
  "models.*.x-*",
  "network_mode",
  "oom_kill_disable",
  "oom_score_adj",
  "pid",
  "pids_limit",
  "ports.mode",
  "ports.x-*",
  "post_start",
  "post_start.command",
  "post_start.environment",
  "post_start.environment.*",
  "post_start.privileged",
  "post_start.user",
  "post_start.working_dir",
  "post_start.x-*",
  "pre_start",
  "pre_start.command",
  "pre_start.environment",
  "pre_start.environment.*",
  "pre_start.image",
  "pre_start.per_replica",
  "pre_start.privileged",
  "pre_start.user",
  "pre_start.working_dir",
  "pre_start.x-*",
  "pre_stop",
  "pre_stop.command",
  "pre_stop.environment",
  "pre_stop.environment.*",
  "pre_stop.privileged",
  "pre_stop.user",
  "pre_stop.working_dir",
  "pre_stop.x-*",
  "provider",
  "provider.options",
  "provider.options.*",
  "provider.type",
  "provider.x-*",
  "pull_refresh_after",
  "runtime",
  "scale",
  "stdin_open",
  "storage_opt",
  "tty",
  "use_api_socket",
  "userns_mode",
  "uts",
  "volumes.bind.propagation",
  "volumes.bind.recursive",
  "volumes.bind.selinux",
  "volumes.bind.x-*",
  "volumes.consistency",
  "volumes.image",
  "volumes.image.subpath",
  "volumes.image.x-*",
  "volumes.volume.labels",
  "volumes.volume.labels.*",
  "volumes.volume.nocopy",
  "volumes.volume.x-*",
  "volumes.x-*",
  "volumes_from",
] as const;

const normalizedPlanTargets = new Map<string, ReadonlyArray<string>>(
  normalizedServicePaths.flatMap(([path, planTarget]) =>
    path.includes(".") || planTarget === undefined ? [] : [[path, planTarget] as const],
  ),
);

const normalizedEntry = (
  path: string,
  planTarget: ReadonlyArray<string> | undefined,
): ComposeDispositionEntry => {
  const [root = path] = path.split(".", 1);
  const resolvedPlanTarget = planTarget ?? normalizedPlanTargets.get(root);
  if (resolvedPlanTarget === undefined) {
    throw new ComposeDispositionMatrixError(
      `Normalized Compose service disposition ${path} must include a planTarget`,
    );
  }
  return { ...NORMALIZED_ENTRY, planTarget: resolvedPlanTarget };
};

const serviceEntries = [
  ...normalizedServicePaths.map(([path, planTarget]) => [path, normalizedEntry(path, planTarget)] as const),
  ...preservedServicePaths.map((path) => [path, preservedEntry(path)] as const),
  ...rejectedServicePaths.map((path) => [path, rejectedEntry(path)] as const),
];

export const composeServiceDispositions: Readonly<Record<string, ComposeDispositionEntry>> =
  Object.fromEntries(serviceEntries);

if (Object.keys(composeServiceDispositions).length !== serviceEntries.length) {
  throw new ComposeDispositionMatrixError();
}

const missingPlanTarget = Object.entries(composeServiceDispositions).find(
  ([, entry]) =>
    entry.disposition === "normalized" && (entry.planTarget === undefined || entry.planTarget.length === 0),
);
if (missingPlanTarget !== undefined) {
  throw new ComposeDispositionMatrixError(
    `Normalized Compose service disposition ${missingPlanTarget[0]} must include a planTarget`,
  );
}

export const composeTopLevelDispositions: Readonly<Record<string, ComposeDispositionEntry>> = {
  services: {
    disposition: "normalized",
    rationale: "Normalizes into AppPlan.services.",
  },
  volumes: {
    disposition: "normalized",
    rationale: "Normalizes into AppPlan.stores.",
  },
  networks: {
    disposition: "normalized",
    rationale: "Normalizes into AppPlan.networks.",
  },
  configs: {
    disposition: "preserved",
    rationale:
      "Preserved losslessly in AppPlan.extensions.compose and capability-checked against composeProjectFields; planning fails with CapabilityError when the provider does not declare configs.",
  },
  secrets: {
    disposition: "preserved",
    rationale:
      "Preserved losslessly in AppPlan.extensions.compose and capability-checked against composeProjectFields; planning fails with CapabilityError when the provider does not declare secrets.",
  },
  include: {
    disposition: "normalized",
    rationale: "Normalizes into Lando includes.",
  },
  version: {
    disposition: "normalized",
    rationale: "Accepted and ignored after a deprecation notice as normalized compatibility handling.",
  },
  name: {
    disposition: "normalized",
    rationale: "Normalizes into AppPlan.name.",
  },
  "x-*": {
    disposition: "preserved",
    rationale:
      "Preserved losslessly in AppPlan.extensions.compose as inert metadata and never capability-gated.",
  },
  models: rejectedEntry("models"),
};

// YAML tag tokens are not schema key paths. Keep them separate because Compose coverage compares
// service and top-level matrix keys bidirectionally against the vendored JSON Schema.
export const composeTagDispositions: Readonly<Record<"!reset" | "!override", ComposeDispositionEntry>> = {
  "!reset": {
    disposition: "rejected",
    rationale: "Compose multi-file reset tags are replaced by Landofile layer merge semantics.",
    remediation: "Remove !reset and express the override through Landofile layer merge semantics.",
  },
  "!override": {
    disposition: "rejected",
    rationale: "Compose multi-file override tags are replaced by Landofile layer merge semantics.",
    remediation: "Remove !override and express the override through Landofile layer merge semantics.",
  },
};
