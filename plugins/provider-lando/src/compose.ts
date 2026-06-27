import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServicePlan,
  fileSyncVolumeName,
  landoNetworkNames,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";

const networkNamesForPlan = landoNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;
const sharedNetworkName = landoSharedNetworkName;

const PROVIDER_ID = "lando";

export interface EmitComposeOptions {
  readonly userDataRoot: string;
}

export interface EmitComposeResult {
  readonly path: string;
  readonly content: string;
}

interface DependsOnEntry {
  readonly condition: string;
}

interface ComposeService {
  readonly image: string;
  readonly ports?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: ReadonlyArray<string>;
  readonly tmpfs?: ReadonlyArray<string>;
  readonly depends_on?: Readonly<Record<string, DependsOnEntry>>;
  readonly networks?: Readonly<Record<string, { readonly aliases?: ReadonlyArray<string> }>>;
}

interface ComposeDocument {
  readonly version: "3.9";
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly networks: Readonly<
    Record<string, { readonly driver?: string; readonly external?: boolean; readonly name?: string }>
  >;
  readonly volumes?: Readonly<
    Record<string, { readonly driver?: string; readonly labels?: Readonly<Record<string, string>> }>
  >;
}

const composeError = (message: string, details?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation: "emitCompose",
    message,
    details,
  });

// Strips redundant slashes while correctly preserving a leading slash on
// absolute paths (including the edge case where the first segment is "/").
const pathJoin = (...parts: ReadonlyArray<string>) => {
  const hasLeadingSlash = (parts[0] ?? "").startsWith("/");
  const segments = parts.map((part) => part.replace(/^\/+|\/+$/gu, "")).filter((part) => part.length > 0);
  return (hasLeadingSlash ? "/" : "") + segments.join("/");
};

const serviceImage = (service: ServicePlan) => {
  if (service.artifact?.kind === "ref") {
    return service.artifact.ref;
  }

  throw composeError("Compose emission requires pre-built artifact references.", {
    service: service.name,
    artifact: service.artifact,
  });
};

const mountSuffix = (readOnly: boolean) => (readOnly ? ":ro" : "");

const volumeSpec = (source: string, target: string, readOnly: boolean): string =>
  `${source}:${target}${mountSuffix(readOnly)}`;

const serviceVolumes = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> => {
  const appMount =
    service.appMount === undefined
      ? []
      : [
          volumeSpec(
            service.appMount.realization === "accelerated"
              ? fileSyncVolumeName(plan.name, String(service.name), "app-mount")
              : service.appMount.source,
            service.appMount.target,
            service.appMount.readOnly,
          ),
        ];
  const mounts = service.mounts.flatMap((mount, index) => {
    if (mount.type === "tmpfs") {
      // tmpfs mounts are emitted under the service-level `tmpfs:` key, not `volumes:`.
      return [];
    }

    if (mount.type === "bind" && sameAppMountTarget(service.appMount, mount)) return [];

    if (mount.source === undefined) {
      throw composeError("Compose bind and volume mounts require a source.", {
        service: service.name,
        mount,
      });
    }

    return [
      volumeSpec(
        mount.type === "bind" && mount.realization === "accelerated"
          ? fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`)
          : mount.source,
        mount.target,
        mount.readOnly,
      ),
    ];
  });
  const storage = service.storage.map(
    (storeMount) => `${storeMount.store}:${storeMount.target}${mountSuffix(storeMount.readOnly)}`,
  );

  return [...appMount, ...mounts, ...storage];
};

// Collects tmpfs mount targets for the service-level `tmpfs:` key in Compose.
const serviceTmpfs = (service: ServicePlan): ReadonlyArray<string> =>
  service.mounts.flatMap((mount) => (mount.type === "tmpfs" ? [mount.target] : []));

const servicePorts = (service: ServicePlan): ReadonlyArray<string> =>
  service.endpoints.flatMap((endpoint) => {
    if (endpoint.port === undefined) {
      return [];
    }

    const suffix = endpoint.protocol === "udp" ? "/udp" : "";
    return [`${endpoint.port}:${endpoint.port}${suffix}`];
  });

// Maps DependencyPlan conditions to Docker Compose long-form depends_on entries
// so that `condition: "healthy"` correctly produces `service_healthy` (not the
// default `service_started` implied by the short-form string list).
const serviceDependsOn = (service: ServicePlan): Readonly<Record<string, DependsOnEntry>> =>
  Object.fromEntries(
    service.dependsOn.map((dep) => [
      dep.service,
      { condition: dep.condition === "healthy" ? "service_healthy" : "service_started" },
    ]),
  );

const removeEmpty = (service: ComposeService): ComposeService => ({
  image: service.image,
  ...(service.ports === undefined || service.ports.length === 0 ? {} : { ports: service.ports }),
  ...(service.environment === undefined || Object.keys(service.environment).length === 0
    ? {}
    : { environment: service.environment }),
  ...(service.volumes === undefined || service.volumes.length === 0 ? {} : { volumes: service.volumes }),
  ...(service.tmpfs === undefined || service.tmpfs.length === 0 ? {} : { tmpfs: service.tmpfs }),
  ...(service.depends_on === undefined || Object.keys(service.depends_on).length === 0
    ? {}
    : { depends_on: service.depends_on }),
  ...(service.networks === undefined || Object.keys(service.networks).length === 0
    ? {}
    : { networks: service.networks }),
});

const toComposeDocument = (plan: AppPlan): ComposeDocument => {
  const networkNames = networkNamesForPlan(plan);
  const sharedName = sharedNetworkName(plan);
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      removeEmpty({
        image: serviceImage(service),
        ports: servicePorts(service),
        environment: service.environment,
        volumes: serviceVolumes(plan, service),
        tmpfs: serviceTmpfs(service),
        depends_on: serviceDependsOn(service),
        networks: Object.fromEntries(
          networkNames.map((networkName) => [
            networkName,
            networkName === sharedName ? { aliases: serviceNetworkAliases(plan, service) } : {},
          ]),
        ),
      }),
    ]),
  );
  const networks = Object.fromEntries(
    networkNames.map((name) => {
      if (name === sharedName) {
        return [name, { external: true, name }];
      }
      const planned = plan.networks.find((network) => network.name === name && network.shared === false);
      return [name, { driver: planned?.driver ?? "bridge" }];
    }),
  );
  const volumes = Object.fromEntries([
    ...plan.stores.map(
      (store): [string, { readonly driver?: string; readonly labels?: Readonly<Record<string, string>> }] => {
        const labels = store.kind === "cache" ? { "dev.lando.storage-kind": "cache" } : undefined;
        return [
          store.name,
          {
            ...(store.driver === undefined ? {} : { driver: store.driver }),
            ...(labels === undefined ? {} : { labels }),
          },
        ];
      },
    ),
    ...(plan.fileSync ?? []).flatMap(
      (entry): ReadonlyArray<[string, { readonly driver?: string }]> =>
        entry.session.target._tag === "volume" ? [[entry.session.target.name, {}]] : [],
    ),
  ]);

  return {
    version: "3.9",
    services,
    networks,
    ...(Object.keys(volumes).length === 0 ? {} : { volumes }),
  };
};

const scalar = (value: string) => JSON.stringify(value);

const writeScalarMap = (lines: string[], indent: string, entries: Readonly<Record<string, string>>) => {
  for (const [key, value] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${indent}${key}: ${scalar(value)}`);
  }
};

const writeScalarList = (lines: string[], indent: string, values: ReadonlyArray<string>) => {
  for (const value of values) {
    lines.push(`${indent}- ${scalar(value)}`);
  }
};

export const renderCompose = (plan: AppPlan): string => {
  const document = toComposeDocument(plan);
  const lines: string[] = [`version: ${scalar(document.version)}`, "services:"];

  for (const [serviceName, service] of Object.entries(document.services)) {
    lines.push(`  ${serviceName}:`, `    image: ${scalar(service.image)}`);

    if (service.ports !== undefined) {
      lines.push("    ports:");
      writeScalarList(lines, "      ", service.ports);
    }

    if (service.environment !== undefined) {
      lines.push("    environment:");
      writeScalarMap(lines, "      ", service.environment);
    }

    if (service.volumes !== undefined) {
      lines.push("    volumes:");
      writeScalarList(lines, "      ", service.volumes);
    }

    if (service.tmpfs !== undefined) {
      lines.push("    tmpfs:");
      writeScalarList(lines, "      ", service.tmpfs);
    }

    if (service.depends_on !== undefined) {
      lines.push("    depends_on:");
      for (const [depService, entry] of Object.entries(service.depends_on).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        lines.push(`      ${depService}:`, `        condition: ${scalar(entry.condition)}`);
      }
    }

    if (service.networks !== undefined) {
      lines.push("    networks:");
      for (const [networkName, network] of Object.entries(service.networks)) {
        lines.push(`      ${networkName}:`);
        if (network.aliases !== undefined && network.aliases.length > 0) {
          lines.push("        aliases:");
          writeScalarList(lines, "          ", network.aliases);
        }
      }
    }
  }

  lines.push("networks:");
  for (const [networkName, network] of Object.entries(document.networks)) {
    lines.push(`  ${networkName}:`);
    if (network.driver !== undefined) {
      lines.push(`    driver: ${scalar(network.driver)}`);
    }
    if (network.external !== undefined) {
      lines.push(`    external: ${network.external ? "true" : "false"}`);
    }
    if (network.name !== undefined) {
      lines.push(`    name: ${scalar(network.name)}`);
    }
  }

  if (document.volumes !== undefined) {
    lines.push("volumes:");
    for (const [volumeName, volume] of Object.entries(document.volumes)) {
      lines.push(`  ${volumeName}:`);
      if (volume.driver !== undefined) {
        lines.push(`    driver: ${scalar(volume.driver)}`);
      }
      if (volume.labels !== undefined) {
        lines.push("    labels:");
        writeScalarMap(lines, "      ", volume.labels);
      }
    }
  }

  return `${lines.join("\n")}\n`;
};

export const composePath = (plan: AppPlan, options: EmitComposeOptions): string =>
  pathJoin(options.userDataRoot, "apps", String(plan.id), "compose.yml");

export const emitCompose = (
  plan: AppPlan,
  options: EmitComposeOptions,
): Effect.Effect<EmitComposeResult, ProviderInternalError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const appRoot = pathJoin(options.userDataRoot, "apps", String(plan.id));
    const outputPath = pathJoin(appRoot, "compose.yml");
    // Wrap synchronous renderCompose in Effect.try so that any throw from
    // serviceImage/serviceVolumes surfaces as a typed ProviderInternalError
    // failure (not an unhandled defect bypassing the mapError handler below).
    const content = yield* Effect.try({
      try: () => renderCompose(plan),
      catch: (e) =>
        e instanceof ProviderInternalError
          ? e
          : composeError("Unexpected error rendering Compose.", { cause: e }),
    });

    yield* fileSystem.mkdir(pathJoin(options.userDataRoot, "apps"));
    yield* fileSystem.mkdir(appRoot);
    yield* fileSystem.writeAtomic(outputPath, content);

    return { path: outputPath, content };
  }).pipe(
    Effect.mapError((cause) => {
      if (cause instanceof ProviderInternalError) {
        return cause;
      }

      return composeError("Failed to emit provider-lando Compose file.", { cause });
    }),
  );
