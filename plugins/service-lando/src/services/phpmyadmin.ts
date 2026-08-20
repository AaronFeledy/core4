import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { AppFeatureSelectorMatchedNothingError, ServiceFeatureError } from "@lando/sdk/errors";
import { PortNumber, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { PhpMyAdminServiceConfig } from "@lando/sdk/schema/services/phpmyadmin";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceView,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(80);
const DEFAULT_PMA_USER = "lando";
const DEFAULT_PMA_PASSWORD = "lando";
const DB_TYPES = ["mysql", "mariadb"] as const;
const VERSIONS = ["5", "latest"] as const;
const ARTIFACTS = {
  "5": "phpmyadmin:5",
  latest: "phpmyadmin:latest",
} as const;

export const PHPMYADMIN_FEATURE_ID = "service-lando.phpmyadmin";
export const PHPMYADMIN_WIRE_FEATURE_ID = "service-lando.phpmyadmin.wire";

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const applyPhpMyAdminFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS.latest });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(port),
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 20,
  });

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const phpmyadminServiceFeature: ServiceFeatureDefinition = {
  id: PHPMYADMIN_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyPhpMyAdminFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "phpmyadmin service feature failed to apply",
          feature: PHPMYADMIN_FEATURE_ID,
          cause,
        }),
    }),
};

const makePhpMyAdminServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "phpmyadmin",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  schema: PhpMyAdminServiceConfig,
  resolve: (input) => {
    const appName = appNameFor(input);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "phpmyadmin",
        image: input.service.image ?? image,
        certs: input.service.certs ?? true,
        routes: input.service.routes ?? [
          { hostname: `${input.name}.${appName}.lndo.site`, endpoint: input.service.port ?? DEFAULT_PORT },
        ],
      },
      features: [{ id: PHPMYADMIN_FEATURE_ID }],
    });
  },
});

export const phpmyadmin5ServiceType = makePhpMyAdminServiceType("phpmyadmin:5", ARTIFACTS["5"]);
export const phpmyadminLatestServiceType = makePhpMyAdminServiceType("phpmyadmin:latest", ARTIFACTS.latest);
export const phpmyadminServiceType = makePhpMyAdminServiceType("phpmyadmin", ARTIFACTS.latest);

const isDbType = (serviceType: string): boolean => DB_TYPES.some((candidate) => candidate === serviceType);

const authoredHosts = (config: ServiceConfig): ReadonlyArray<string> | undefined => {
  const hosts = config.hosts;
  if (hosts === undefined) return undefined;
  return typeof hosts === "string" ? [hosts] : hosts;
};

const discoveredSiblings = (
  selected: ReadonlyArray<AppFeatureServiceView>,
): ReadonlyArray<AppFeatureServiceView> =>
  selected
    .filter((view) => isDbType(view.serviceType))
    .slice()
    .sort((left, right) => left.serviceName.localeCompare(right.serviceName));

const credentialsFor = (
  siblings: ReadonlyArray<AppFeatureServiceView>,
): { readonly user: string; readonly password: string } => {
  const sibling = siblings.length === 1 ? siblings[0] : undefined;
  if (sibling === undefined) return { user: DEFAULT_PMA_USER, password: DEFAULT_PMA_PASSWORD };
  const environment = sibling.normalizedConfig.environment ?? {};
  const user = environment.MYSQL_USER;
  const password = environment.MYSQL_PASSWORD;
  if (user !== undefined && password !== undefined) return { user, password };
  return { user: DEFAULT_PMA_USER, password: DEFAULT_PMA_PASSWORD };
};

const applyPhpMyAdminWire = (ctx: AppFeatureContext): void => {
  const siblings = discoveredSiblings(ctx.selected);
  ctx.forEachSelected((mutator) => {
    if (mutator.service.serviceType !== "phpmyadmin") return;
    const override = authoredHosts(mutator.service.normalizedConfig);
    if (override !== undefined) {
      mutator.addEnv("PMA_HOSTS", override.join(","));
      mutator.addEnv("PMA_USER", DEFAULT_PMA_USER);
      mutator.addEnv("PMA_PASSWORD", DEFAULT_PMA_PASSWORD);
      return;
    }
    const credentials = credentialsFor(siblings);
    mutator.addEnv("PMA_HOSTS", siblings.map((sibling) => sibling.serviceName).join(","));
    mutator.addEnv("PMA_USER", credentials.user);
    mutator.addEnv("PMA_PASSWORD", credentials.password);
    for (const sibling of siblings) {
      mutator.addDependency({
        service: ServiceName.make(sibling.serviceName),
        condition: "service_healthy",
        required: true,
      });
    }
  });
};

export const phpMyAdminWireFeature: AppFeatureDefinition = {
  id: PHPMYADMIN_WIRE_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { type: "phpmyadmin" } },
  selectors: { types: ["phpmyadmin", "mysql", "mariadb"] },
  apply: (ctx) =>
    Effect.gen(function* () {
      const needsDiscovery = ctx.selected.some(
        (view) => view.serviceType === "phpmyadmin" && authoredHosts(view.normalizedConfig) === undefined,
      );
      if (needsDiscovery && discoveredSiblings(ctx.selected).length === 0) {
        return yield* Effect.fail(
          new AppFeatureSelectorMatchedNothingError({
            message: `App feature ${ctx.featureId} found no mysql/mariadb siblings and no hosts: override`,
            feature: ctx.featureId,
            remediation: "Add a mysql or mariadb service, or author hosts: on the phpmyadmin service.",
          }),
        );
      }
      applyPhpMyAdminWire(ctx);
    }),
};
