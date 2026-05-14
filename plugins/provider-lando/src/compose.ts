import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";

const PROVIDER_ID = "lando";

export interface EmitComposeOptions {
  readonly userDataRoot: string;
}

export interface EmitComposeResult {
  readonly path: string;
  readonly content: string;
}

interface ComposeService {
  readonly image: string;
  readonly ports?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
  readonly networks?: ReadonlyArray<string>;
}

interface ComposeDocument {
  readonly version: "3.9";
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly networks: Readonly<Record<string, { readonly driver: string }>>;
  readonly volumes?: Readonly<Record<string, { readonly driver?: string }>>;
}

const composeError = (message: string, details?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation: "emitCompose",
    message,
    details,
  });

const pathJoin = (...parts: ReadonlyArray<string>) =>
  parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/u, "") : part.replace(/^\/+|\/+$/gu, "")))
    .filter((part) => part.length > 0)
    .join("/");

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

const serviceVolumes = (service: ServicePlan): ReadonlyArray<string> => {
  const appMount =
    service.appMount === undefined
      ? []
      : [`${service.appMount.source}:${service.appMount.target}${mountSuffix(service.appMount.readOnly)}`];
  const mounts = service.mounts.map((mount) => {
    if (mount.type === "tmpfs") {
      return mount.target;
    }

    if (mount.source === undefined) {
      throw composeError("Compose bind and volume mounts require a source.", {
        service: service.name,
        mount,
      });
    }

    return `${mount.source}:${mount.target}${mountSuffix(mount.readOnly)}`;
  });
  const storage = service.storage.map(
    (storeMount) => `${storeMount.store}:${storeMount.target}${mountSuffix(storeMount.readOnly)}`,
  );

  return [...appMount, ...mounts, ...storage];
};

const servicePorts = (service: ServicePlan): ReadonlyArray<string> =>
  service.endpoints.flatMap((endpoint) => {
    if (endpoint.port === undefined) {
      return [];
    }

    const suffix = endpoint.protocol === "udp" ? "/udp" : "";
    return [`${endpoint.port}:${endpoint.port}${suffix}`];
  });

const removeEmpty = (service: ComposeService): ComposeService => ({
  image: service.image,
  ...(service.ports === undefined || service.ports.length === 0 ? {} : { ports: service.ports }),
  ...(service.environment === undefined || Object.keys(service.environment).length === 0
    ? {}
    : { environment: service.environment }),
  ...(service.volumes === undefined || service.volumes.length === 0 ? {} : { volumes: service.volumes }),
  ...(service.depends_on === undefined || service.depends_on.length === 0
    ? {}
    : { depends_on: service.depends_on }),
  ...(service.networks === undefined || service.networks.length === 0 ? {} : { networks: service.networks }),
});

const toComposeDocument = (plan: AppPlan): ComposeDocument => {
  const networkNames = plan.networks.map((network) => network.name);
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      removeEmpty({
        image: serviceImage(service),
        ports: servicePorts(service),
        environment: service.environment,
        volumes: serviceVolumes(service),
        depends_on: service.dependsOn.map((dependency) => String(dependency.service)),
        networks: networkNames,
      }),
    ]),
  );
  const networks = Object.fromEntries(
    plan.networks.map((network) => [network.name, { driver: network.driver ?? "bridge" }]),
  );
  const volumes = Object.fromEntries(
    plan.stores.map((store) => [store.name, store.driver === undefined ? {} : { driver: store.driver }]),
  );

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

    if (service.depends_on !== undefined) {
      lines.push("    depends_on:");
      writeScalarList(lines, "      ", service.depends_on);
    }

    if (service.networks !== undefined) {
      lines.push("    networks:");
      writeScalarList(lines, "      ", service.networks);
    }
  }

  lines.push("networks:");
  for (const [networkName, network] of Object.entries(document.networks)) {
    lines.push(`  ${networkName}:`, `    driver: ${scalar(network.driver)}`);
  }

  if (document.volumes !== undefined) {
    lines.push("volumes:");
    for (const [volumeName, volume] of Object.entries(document.volumes)) {
      lines.push(`  ${volumeName}:`);
      if (volume.driver !== undefined) {
        lines.push(`    driver: ${scalar(volume.driver)}`);
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
    const content = renderCompose(plan);

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
