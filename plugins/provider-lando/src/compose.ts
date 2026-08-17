import { Effect } from "effect";

import { commonContainerLabels, mountSuffix } from "@lando/container-runtime/plan";
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

import { volumeSelectorValue } from "./volume-prune.ts";

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
  readonly required: boolean;
}

interface ComposeBindVolume {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly bind: { readonly create_host_path: false };
}

interface ComposeStorageVolume {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly volume: { readonly subpath: string };
}

type ComposeVolumeEntry = string | ComposeBindVolume | ComposeStorageVolume;

interface ComposeService {
  readonly image: string;
  readonly ports?: ReadonlyArray<string>;
  readonly expose?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: ReadonlyArray<ComposeVolumeEntry>;
  readonly tmpfs?: ReadonlyArray<string>;
  readonly depends_on?: Readonly<Record<string, DependsOnEntry>>;
  readonly networks?: Readonly<Record<string, { readonly aliases?: ReadonlyArray<string> }>>;
  readonly labels?: Readonly<Record<string, string>>;
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

const volumeSpec = (source: string, target: string, readOnly: boolean): string =>
  `${source}:${target}${mountSuffix(readOnly)}`;

const serviceVolumes = (plan: AppPlan, service: ServicePlan): ReadonlyArray<ComposeVolumeEntry> => {
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
  const mounts = service.mounts.flatMap((mount, index): ReadonlyArray<ComposeVolumeEntry> => {
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

    if (mount.type === "bind" && mount.realization === "passthrough" && mount.createHostPath === false) {
      return [
        {
          type: "bind",
          source: mount.source,
          target: mount.target,
          read_only: mount.readOnly,
          bind: { create_host_path: false },
        },
      ];
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
    (storeMount): ComposeVolumeEntry =>
      storeMount.subpath === undefined
        ? `${storeMount.store}:${storeMount.target}${mountSuffix(storeMount.readOnly)}`
        : {
            type: "volume",
            source: storeMount.store,
            target: storeMount.target,
            read_only: storeMount.readOnly,
            volume: { subpath: storeMount.subpath },
          },
  );

  return [...appMount, ...mounts, ...storage];
};

const serviceTmpfs = (service: ServicePlan): ReadonlyArray<string> =>
  service.mounts.flatMap((mount) => (mount.type === "tmpfs" ? [mount.target] : []));

const servicePorts = (service: ServicePlan): ReadonlyArray<string> =>
  service.endpoints.flatMap((endpoint) => {
    if (endpoint._tag === "internal") return [];
    const suffix = endpoint.protocol === "udp" ? "/udp" : "";
    const bindAddress = endpoint.publication.bindAddress ?? "127.0.0.1";
    const hostPort = endpoint.publication.hostPort ?? "";
    return [`${bindAddress}:${hostPort}:${endpoint.port}${suffix}`];
  });

const serviceExpose = (service: ServicePlan): ReadonlyArray<string> =>
  service.endpoints.flatMap((endpoint) =>
    endpoint._tag === "internal" && endpoint.protocol !== "unix"
      ? [`${endpoint.port}${endpoint.protocol === "udp" ? "/udp" : ""}`]
      : [],
  );

const serviceDependsOn = (service: ServicePlan): Readonly<Record<string, DependsOnEntry>> =>
  Object.fromEntries(
    service.dependsOn.map((dep) => [dep.service, { condition: dep.condition, required: dep.required }]),
  );

const removeEmpty = (service: ComposeService): ComposeService => ({
  image: service.image,
  ...(service.ports === undefined || service.ports.length === 0 ? {} : { ports: service.ports }),
  ...(service.expose === undefined || service.expose.length === 0 ? {} : { expose: service.expose }),
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
  ...(service.labels === undefined || Object.keys(service.labels).length === 0
    ? {}
    : { labels: service.labels }),
});

const toComposeDocument = (plan: AppPlan): ComposeDocument => {
  const networkNames = landoNetworkNames(plan);
  const sharedName = landoSharedNetworkName(plan);
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      removeEmpty({
        image: serviceImage(service),
        ports: servicePorts(service),
        expose: serviceExpose(service),
        environment: service.environment,
        volumes: serviceVolumes(plan, service),
        tmpfs: serviceTmpfs(service),
        depends_on: serviceDependsOn(service),
        labels: commonContainerLabels(plan, service),
        networks: Object.fromEntries(
          networkNames.map((networkName) => {
            const aliases =
              networkName === sharedName ? landoServiceNetworkAliases(plan, service) : [service.name];
            return [networkName, aliases.length > 0 ? { aliases } : {}];
          }),
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
        const labels = {
          "dev.lando.app": plan.id,
          "dev.lando.provider": plan.provider,
          "dev.lando.store": store.name,
          "dev.lando.scope": store.scope,
          "dev.lando.volume-selector": volumeSelectorValue({
            providerId: plan.provider,
            appId: plan.id,
            volumeClass: store.kind === "cache" ? "cache" : "data",
          }),
          ...(store.kind === "cache" ? { "dev.lando.storage-kind": "cache" } : {}),
        };
        return [
          store.name,
          {
            ...(store.driver === undefined ? {} : { driver: store.driver }),
            labels,
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

const writeVolumeList = (lines: Array<string>, entries: ReadonlyArray<ComposeVolumeEntry>): void => {
  for (const entry of entries) {
    if (typeof entry === "string") {
      lines.push(`      - ${scalar(entry)}`);
      continue;
    }

    lines.push(
      `      - type: ${scalar(entry.type)}`,
      `        source: ${scalar(entry.source)}`,
      `        target: ${scalar(entry.target)}`,
      `        read_only: ${entry.read_only ? "true" : "false"}`,
    );
    switch (entry.type) {
      case "bind":
        lines.push("        bind:", "          create_host_path: false");
        break;
      case "volume":
        lines.push("        volume:", `          subpath: ${scalar(entry.volume.subpath)}`);
        break;
      default: {
        const unreachable: never = entry;
        throw composeError("Unsupported Compose volume entry.", { entry: unreachable });
      }
    }
  }
};

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

    if (service.expose !== undefined) {
      lines.push("    expose:");
      writeScalarList(lines, "      ", service.expose);
    }

    if (service.environment !== undefined) {
      lines.push("    environment:");
      writeScalarMap(lines, "      ", service.environment);
    }

    if (service.volumes !== undefined) {
      lines.push("    volumes:");
      writeVolumeList(lines, service.volumes);
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

    if (service.labels !== undefined) {
      lines.push("    labels:");
      writeScalarMap(lines, "      ", service.labels);
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
    const outputPath = composePath(plan, options);
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
