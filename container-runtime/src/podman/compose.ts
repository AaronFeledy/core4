import { join as pathJoin } from "node:path";
import {
  APP_LABEL,
  PROVIDER_LABEL,
  STORAGE_KIND_LABEL,
  STORAGE_SCOPE_LABEL,
  STORE_LABEL,
} from "../labels.ts";

import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServicePlan,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { quoteYamlScalar, yamlMappingKeyText } from "@lando/sdk/yaml";

import { bindSourceForComposeConfig, composeConfigMounts } from "../compose-configs.ts";
import type { ProviderErrorContext } from "../engine-api.ts";
import { previewEnvironmentValue } from "../environment-values.ts";
import { type HostAliasMap, serviceHostAliases, writeHostAliases } from "../host-aliases.ts";
import { requiresLongMountSyntax } from "../mount-syntax.ts";
import { physicalListenerPorts, physicalPublications } from "../physical-publications.ts";
import { commonContainerLabels, composeConfigBindStrings } from "../plan.ts";
import { volumeOwnershipLabels } from "../volume-ownership.ts";
import { composeHealthcheck } from "./compose-healthcheck.ts";
import { type ComposeVolumeEntry, serviceComposeMounts } from "./compose-mounts.ts";
import { podmanNetworkNames } from "./networks.ts";

export interface EmitComposeOptions {
  readonly userDataRoot: string;
  readonly ctx: ProviderErrorContext;
}

export interface EmitComposeResult {
  readonly path: string;
  readonly content: string;
}

interface DependsOnEntry {
  readonly condition: string;
  readonly required: boolean;
}

interface ComposeService {
  readonly image: string;
  readonly ports?: ReadonlyArray<string>;
  readonly expose?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly extra_hosts?: HostAliasMap;
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

const composeError = (ctx: ProviderErrorContext, message: string, details?: unknown) =>
  new ProviderInternalError({
    providerId: ctx.providerId,
    operation: "emitCompose",
    message,
    details,
    remediation: ctx.remediation,
  });

const serviceImage = (ctx: ProviderErrorContext, service: ServicePlan) => {
  if (service.artifact?.kind === "ref") {
    return service.artifact.ref;
  }

  throw composeError(ctx, "Compose emission requires pre-built artifact references.", {
    service: service.name,
    artifact: service.artifact,
  });
};

const serviceMountLists = (
  ctx: ProviderErrorContext,
  plan: AppPlan,
  service: ServicePlan,
): { readonly volumes: ReadonlyArray<ComposeVolumeEntry>; readonly tmpfs: ReadonlyArray<string> } => {
  const planned = serviceComposeMounts(plan, service, (message, details) => {
    throw composeError(ctx, message, details);
  });
  const configs = composeConfigMounts(plan, service).flatMap(
    (mount): ReadonlyArray<ComposeVolumeEntry> =>
      requiresLongMountSyntax(mount.target)
        ? [{ type: "bind", source: bindSourceForComposeConfig(mount), target: mount.target, read_only: true }]
        : [],
  );
  return {
    volumes: [...planned.volumes, ...composeConfigBindStrings(plan, service), ...configs],
    tmpfs: planned.tmpfs,
  };
};

const servicePorts = (service: ServicePlan): ReadonlyArray<string> =>
  physicalPublications(service.endpoints).map((endpoint) => {
    const suffix = endpoint.transport === "udp" ? "/udp" : "";
    const bindAddress = endpoint.bindAddress.includes(":")
      ? `[${endpoint.bindAddress}]`
      : endpoint.bindAddress;
    const hostPort = endpoint.hostPort ?? "";
    return `${bindAddress}:${hostPort}:${endpoint.port}${suffix}`;
  });

const serviceExpose = (service: ServicePlan): ReadonlyArray<string> =>
  physicalListenerPorts(service.endpoints.filter((endpoint) => endpoint._tag === "internal")).map((port) =>
    port.endsWith("/tcp") ? port.slice(0, -4) : port,
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
  ...(service.extra_hosts === undefined || Object.keys(service.extra_hosts).length === 0
    ? {}
    : { extra_hosts: service.extra_hosts }),
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

const toComposeDocument = (ctx: ProviderErrorContext, plan: AppPlan): ComposeDocument => {
  const networkNames = podmanNetworkNames(plan);
  const sharedName = landoSharedNetworkName(plan);
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => {
      const mounts = serviceMountLists(ctx, plan, service);
      return [
        name,
        removeEmpty({
          image: serviceImage(ctx, service),
          ports: servicePorts(service),
          expose: serviceExpose(service),
          environment: Object.fromEntries(
            Object.entries(service.environment).map(([key, value]) => [key, previewEnvironmentValue(value)]),
          ),
          extra_hosts: serviceHostAliases(service, (message, details) => {
            throw composeError(ctx, message, details);
          }),
          volumes: mounts.volumes,
          tmpfs: mounts.tmpfs,
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
      ];
    }),
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
          [APP_LABEL]: plan.id,
          [PROVIDER_LABEL]: plan.provider,
          [STORE_LABEL]: store.name,
          [STORAGE_SCOPE_LABEL]: store.scope,
          ...volumeOwnershipLabels(plan, store),
          ...(store.kind === "cache" ? { [STORAGE_KIND_LABEL]: "cache" } : {}),
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

const writeVolumeList = (
  ctx: ProviderErrorContext,
  lines: Array<string>,
  entries: ReadonlyArray<ComposeVolumeEntry>,
): void => {
  for (const entry of entries) {
    if (typeof entry === "string") {
      lines.push(`      - ${quoteYamlScalar(entry)}`);
      continue;
    }

    lines.push(
      `      - type: ${quoteYamlScalar(entry.type)}`,
      ...(entry.type === "tmpfs" ? [] : [`        source: ${quoteYamlScalar(entry.source)}`]),
      `        target: ${quoteYamlScalar(entry.target)}`,
      `        read_only: ${entry.read_only ? "true" : "false"}`,
    );
    switch (entry.type) {
      case "bind":
        if (entry.bind !== undefined) lines.push("        bind:", "          create_host_path: false");
        break;
      case "volume":
        if (entry.volume !== undefined)
          lines.push("        volume:", `          subpath: ${quoteYamlScalar(entry.volume.subpath)}`);
        break;
      case "tmpfs":
        if (entry.tmpfs !== undefined) {
          lines.push("        tmpfs:");
          if (entry.tmpfs.size !== undefined) {
            lines.push(
              `          size: ${
                typeof entry.tmpfs.size === "number"
                  ? String(entry.tmpfs.size)
                  : quoteYamlScalar(entry.tmpfs.size)
              }`,
            );
          }
          if (entry.tmpfs.mode !== undefined) {
            lines.push(`          mode: ${String(entry.tmpfs.mode)}`);
          }
        }
        break;
      default: {
        const unreachable: never = entry;
        throw composeError(ctx, "Unsupported Compose volume entry.", { entry: unreachable });
      }
    }
  }
};

const writeScalarMap = (lines: string[], indent: string, entries: Readonly<Record<string, string>>) => {
  for (const [key, value] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${indent}${yamlMappingKeyText(key)}: ${quoteYamlScalar(value)}`);
  }
};

const writeScalarList = (lines: string[], indent: string, values: ReadonlyArray<string>) => {
  for (const value of values) {
    lines.push(`${indent}- ${quoteYamlScalar(value)}`);
  }
};

export const renderCompose = (plan: AppPlan, ctx: ProviderErrorContext): string => {
  const document = toComposeDocument(ctx, plan);
  const lines: string[] = [`version: ${quoteYamlScalar(document.version)}`, "services:"];

  for (const [serviceName, service] of Object.entries(document.services)) {
    lines.push(`  ${yamlMappingKeyText(serviceName)}:`, `    image: ${quoteYamlScalar(service.image)}`);
    const plannedService = Object.values(plan.services).find((candidate) => candidate.name === serviceName);
    if (plannedService !== undefined) lines.push(...composeHealthcheck(plan, plannedService));

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

    if (service.extra_hosts !== undefined) {
      lines.push("    extra_hosts:");
      writeHostAliases(lines, service.extra_hosts);
    }

    if (service.volumes !== undefined) {
      lines.push("    volumes:");
      writeVolumeList(ctx, lines, service.volumes);
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
        lines.push(
          `      ${yamlMappingKeyText(depService)}:`,
          `        condition: ${quoteYamlScalar(entry.condition)}`,
        );
      }
    }

    if (service.networks !== undefined) {
      lines.push("    networks:");
      for (const [networkName, network] of Object.entries(service.networks)) {
        lines.push(`      ${yamlMappingKeyText(networkName)}:`);
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
    lines.push(`  ${yamlMappingKeyText(networkName)}:`);
    if (network.driver !== undefined) {
      lines.push(`    driver: ${quoteYamlScalar(network.driver)}`);
    }
    if (network.external !== undefined) {
      lines.push(`    external: ${network.external ? "true" : "false"}`);
    }
    if (network.name !== undefined) {
      lines.push(`    name: ${quoteYamlScalar(network.name)}`);
    }
  }

  if (document.volumes !== undefined) {
    lines.push("volumes:");
    for (const [volumeName, volume] of Object.entries(document.volumes)) {
      lines.push(`  ${yamlMappingKeyText(volumeName)}:`);
      if (volume.driver !== undefined) {
        lines.push(`    driver: ${quoteYamlScalar(volume.driver)}`);
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

export const emitCompose = Effect.fn("RuntimeProvider.emitCompose")(
  function* (plan: AppPlan, options: EmitComposeOptions) {
    const fileSystem = yield* FileSystem;
    const appRoot = pathJoin(options.userDataRoot, "apps", String(plan.id));
    const outputPath = composePath(plan, options);
    // Wrap synchronous renderCompose in Effect.try so that any throw from
    // serviceImage/serviceVolumes surfaces as a typed ProviderInternalError
    // failure (not an unhandled defect bypassing the mapError handler below).
    const content = yield* Effect.try({
      try: () => renderCompose(plan, options.ctx),
      catch: (e) =>
        e instanceof ProviderInternalError
          ? e
          : composeError(options.ctx, "Unexpected error rendering Compose.", { cause: e }),
    });

    yield* fileSystem.mkdir(pathJoin(options.userDataRoot, "apps"));
    yield* fileSystem.mkdir(appRoot);
    yield* fileSystem.writeAtomic(outputPath, content);

    return { path: outputPath, content };
  },
  (effect, _plan, options) =>
    Effect.mapError(effect, (cause) => {
      if (cause instanceof ProviderInternalError) {
        return cause;
      }

      return composeError(options.ctx, `Failed to emit provider-${options.ctx.providerId} Compose file.`, {
        cause,
      });
    }),
);
