import { ComposePreservedPathKey } from "../schema/compose-preserved-path-capabilities.ts";

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
  path === "networks.*.x-*"
    ? {
        disposition: "preserved",
        rationale: "Retained in the Landofile as inert metadata; never interpreted or capability-gated.",
      }
    : path === "x-*"
      ? PRESERVED_INERT_EXTENSION_ENTRY
      : preservedExactPaths.has(path)
        ? PRESERVED_EXACT_PATH_ENTRY
        : PRESERVED_ENTRY;

const rejectedEntry = (path: string): ComposeDispositionEntry => {
  if (path === "networks.*.use_service_name_alias") {
    return {
      disposition: "rejected",
      rationale: "Lando decides which names a service gets on each network.",
      remediation: `Remove ${path}. Lando registers the service name on the app network only; add a name on another network with aliases.`,
    };
  }
  if (path.startsWith("networks.*.")) {
    return {
      disposition: "rejected",
      rationale: "Lando owns network address and interface settings.",
      remediation: `Lando doesn't pin network addresses or interface settings. Remove ${path} and reach the service by its name or an alias.`,
    };
  }
  if (path === "extends") {
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
  if (path === "hostname" || path === "domainname") {
    return {
      disposition: "rejected",
      rationale:
        "Lando sets each container's hostname to its container name, which resolves only to that container.",
      remediation: `Remove ${path}. Lando sets each container's hostname to its container name, lando-<app>--<service>. Reach the service by its service key or a hostnames: alias.`,
    };
  }
  if (path === "network_mode" || path === "links") {
    return {
      disposition: "rejected",
      rationale: "Legacy Compose network shortcuts bypass Lando network planning.",
      remediation: `Translate ${path} to Lando networks: configuration.`,
    };
  }
  if (path === "configs.uid" || path === "configs.gid") {
    return {
      disposition: "rejected",
      rationale: "Config grants mount a read-only copy of a host file; Lando cannot change its owner.",
      remediation: `Remove ${path} and set the grant's mode (for example "0444") so the service user can read the file.`,
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
  ["networks", ["networking"]],
  ["networks.*", ["networking"]],
  ["networks.*.aliases", ["networking"]],
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
  ["init", ["init"]],
  ["configs", ["mounts"]],
  ["configs.mode"],
  ["configs.source"],
  ["configs.target"],
  ["configs.x-*"],
  ["ports", ["endpoints"]],
  ["ports.app_protocol"],
  ["ports.host_ip"],
  ["ports.name"],
  ["ports.protocol"],
  ["ports.published"],
  ["ports.target"],
  ["user", ["user"]],
  ["volumes", ["mounts"]],
  // Type-specific volume options reach only their own destination, never the root's full set.
  ["volumes.bind", ["mounts"]],
  ["volumes.bind.create_host_path", ["mounts"]],
  ["volumes.read_only"],
  ["volumes.source"],
  ["volumes.target"],
  ["volumes.type"],
  ["volumes.volume", ["mounts"]],
  ["volumes.volume.subpath", ["mounts"]],
  ["tmpfs", ["mounts"]],
  ["volumes.tmpfs", ["mounts"]],
  ["volumes.tmpfs.mode", ["mounts"]],
  ["volumes.tmpfs.size", ["mounts"]],
  ["volumes.tmpfs.x-*", ["mounts"]],
  ["working_dir", ["workingDirectory"]],
] as const satisfies ReadonlyArray<NormalizedServicePath>;

const preservedServicePaths = [
  "cap_add",
  "cap_drop",
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
  "labels",
  "labels.*",
  "logging",
  "logging.driver",
  "logging.options",
  "logging.options.*",
  "logging.x-*",
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
  "ulimits",
  "ulimits.*",
  "ulimits.*.hard",
  "ulimits.*.soft",
  "ulimits.*.x-*",
  "x-*",
] as const;

const rejectedServicePaths = [
  "configs.gid",
  "configs.uid",
  "networks.*.driver_opts",
  "networks.*.gw_priority",
  "networks.*.interface_name",
  "networks.*.ipv4_address",
  "networks.*.ipv6_address",
  "networks.*.link_local_ips",
  "networks.*.mac_address",
  "networks.*.priority",
  "networks.*.use_service_name_alias",
  "annotations",
  "attach",
  "blkio_config",
  "build.additional_contexts",
  "build.cache_from",
  "build.cache_to",
  "build.entitlements",
  "build.extra_hosts",
  "build.isolation",
  "build.labels",
  "build.network",
  "build.no_cache",
  "build.no_cache_filter",
  "build.platforms",
  "build.privileged",
  "build.provenance",
  "build.pull",
  "build.sbom",
  "build.secrets",
  "build.shm_size",
  "build.ssh",
  "build.tags",
  "build.ulimits",
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
  "depends_on.*.x-*",
  "deploy.endpoint_mode",
  "deploy.labels",
  "deploy.mode",
  "deploy.placement",
  "deploy.replicas",
  "deploy.restart_policy",
  "deploy.rollback_config",
  "deploy.update_config",
  "deploy.x-*",
  "develop",
  "device_cgroup_rules",
  "domainname",
  "env_file.format",
  "env_file.path",
  "env_file.required",
  "extends",
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
  "network_mode",
  "oom_kill_disable",
  "oom_score_adj",
  "pid",
  "pids_limit",
  "ports.mode",
  "ports.x-*",
  "post_start",
  "pre_start",
  "pre_stop",
  "provider",
  "pull_refresh_after",
  "runtime",
  "scale",
  "stdin_open",
  "storage_opt",
  "tty",
  "umask",
  "use_api_socket",
  "userns_mode",
  "uts",
  "volumes.bind.propagation",
  "volumes.bind.recursive",
  "volumes.bind.selinux",
  "volumes.bind.x-*",
  "volumes.consistency",
  "volumes.image",
  "volumes.volume.labels",
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

/**
 * Resolves the disposition of a matrix path (dot-separated; `*` and `x-*` are literal pattern
 * segments). An exact key wins; otherwise a rejected key rejects everything nested under it, so the
 * nearest listed ancestor answers only when it is rejected. Nested keys of a rejected key are not
 * listed in the matrix.
 */
export const composeDispositionFor = (
  dispositions: Readonly<Record<string, ComposeDispositionEntry>>,
  path: string,
): ComposeDispositionEntry | undefined => {
  if (Object.hasOwn(dispositions, path)) return dispositions[path];
  for (let end = path.lastIndexOf("."); end > 0; end = path.lastIndexOf(".", end - 1)) {
    const ancestor = path.slice(0, end);
    if (Object.hasOwn(dispositions, ancestor)) {
      const entry = dispositions[ancestor];
      return entry?.disposition === "rejected" ? entry : undefined;
    }
  }
  return undefined;
};

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
    rationale: "Normalizes into AppPlan.networking when a service joins the declared network.",
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
  jobs: rejectedEntry("jobs"),
};

// YAML tag tokens are not schema key paths. Keep them separate because Compose coverage compares
// service and top-level matrix keys bidirectionally against the vendored JSON Schema.
export const composeTagDispositions: Readonly<Record<"!reset" | "!override", ComposeDispositionEntry>> = {
  "!reset": {
    disposition: "normalized",
    rationale: "Native Landofile layer merging consumes reset directives by removing mapping members.",
  },
  "!override": {
    disposition: "normalized",
    rationale: "Native Landofile layer merging consumes override directives by replacing inherited values.",
  },
};
