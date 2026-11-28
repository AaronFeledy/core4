import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "@lando/sdk/expressions";
import {
  type EnvironmentValue,
  PortablePath,
  type ServiceConfig,
  type ServiceCreds,
  ServiceName,
} from "@lando/sdk/schema";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { dataNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { claimsCreds, familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { MONGO_DATA as DATA_TARGET, applyDatabaseVersion, databaseVersionFeature } from "./_data-version.ts";
import {
  RESERVED_LONG_PORT,
  catalogDbExtraArgsRemediation,
  extraArgsCommandOptions,
  isNonCatalogArtifact,
} from "./_extra-args.ts";
import { addEnvRecord, rootIdentity, serviceFeatureApply, serviceTypeResolve } from "./_feature-helpers.ts";
import {
  assertListenerConfig,
  launcherAuthority,
  primaryPortSelector,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";
import { mongodbProbes } from "./mongodb-probes.ts";

const DEFAULT_IMAGE = "mongo:7";
const VERSIONS = ["7"] as const;
const ARTIFACTS = { "7": DEFAULT_IMAGE } as const;
export const MONGODB_LISTENER = {
  port: 27017,
  daemon: "MongoDB",
  when: "All MongoDB services",
  launcher: { setting: (port: number) => `--port ${port}` },
} as const;
export const DEFAULT_PORT = MONGODB_LISTENER.port;
const selectPort = primaryPortSelector(MONGODB_LISTENER);
const FAMILY = "mongodb" as const;
export const MONGODB_FEATURE_ID = "service-lando.mongodb";
export const MONGODB_CONFIG_TARGET = PortablePath.make("/etc/lando/mongod.conf");

const credsFor = (
  input: {
    readonly appName?: string | undefined;
    readonly dataName?: string | undefined;
    readonly appRoot: string;
  },
  service: ServiceConfig,
): ServiceCreds => {
  const creds = service.creds;
  return resolveServiceCreds({
    family: FAMILY,
    ...(creds === undefined ? {} : { authored: creds }),
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    defaults: { user: "lando", password: DEFAULT_PASSWORD, database: dataNameFor(input) },
  });
};

const mongoUri = (creds: ServiceCreds, port: number): EnvironmentValue =>
  concatenateEnvironmentValues([
    "mongodb://",
    encodeEnvironmentComponent(creds.user),
    ":",
    encodeEnvironmentComponent(creds.password),
    `@127.0.0.1:${port}/`,
    encodeEnvironmentComponent(creds.database),
    "?authSource=admin",
  ]);

const connectMongo =
  '(async () => { try { db=await connect(process.env.MONGO_URI); } catch (error) { if (error.code === 18 || error.codeName === "AuthenticationFailed") { error.message += " MongoDB rejected the configured credentials. Existing volumes retain their original users; restore the matching credentials or update the user with an authorized administrator. Your data has been retained."; } throw error; } })()';

const applyMongodbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { creds, port } = connectionFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, {
    ...familyEnvFor(FAMILY, creds),
    ...landoDbEnvFor(creds, port),
  });
  ctx.addStorage({
    store: ctx.serviceStoreName("mongodb-data"),
    target: DATA_TARGET,
    readOnly: false,
  });

  const catalogImages = Object.values(ARTIFACTS);
  const custom = isNonCatalogArtifact(service, catalogImages);
  const serverConfig = addServerConfigMount(ctx, MONGODB_CONFIG_TARGET);
  const hasExtraArgs = (service.extraArgs?.length ?? 0) > 0;
  const processOwned = service.command !== undefined || service.entrypoint !== undefined;
  const ownsLauncher =
    !processOwned && (serverConfig || service.port !== undefined || (!custom && hasExtraArgs));
  if (ownsLauncher) {
    ctx.setCommand(
      ["mongod", ...(serverConfig ? ["--config", MONGODB_CONFIG_TARGET] : []), "--port", String(port)],
      custom
        ? undefined
        : extraArgsCommandOptions([
            RESERVED_LONG_PORT,
            {
              form: "long",
              name: "config",
              remediation: "Set config.server instead of --config in extraArgs.",
              takesValue: true,
            },
            {
              form: "short",
              name: "f",
              remediation: "Set config.server instead of -f in extraArgs.",
              takesValue: true,
            },
            {
              form: "long-prefix",
              prefix: "bind_ip",
              remediation: "Lando manages MongoDB bind settings; remove bind_ip flags from extraArgs.",
            },
          ]),
    );
  } else if ((serverConfig || service.port !== undefined) && processOwned) {
    ctx.setListenerAuthority(launcherAuthority(MONGODB_LISTENER, port));
  }

  applyAuthoredProcessFields(ctx);
  applyDatabaseVersion(ctx);

  const probes = mongodbProbes(port);
  ctx.setHealthcheck(probes.healthcheck);
  ctx.setReadiness(probes.readiness);
};

export const mongodbServiceFeature: ServiceFeatureDefinition = {
  id: MONGODB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: claimsCreds(MONGODB_FEATURE_ID),
  declareEndpoints: (ctx) =>
    Effect.sync(() => servicePortEndpoints(ctx, { port: connectionFor(ctx).port, protocol: "tcp" })),
  apply: serviceFeatureApply(
    MONGODB_FEATURE_ID,
    "mongodb service feature failed to apply",
    applyMongodbFeature,
  ),
};

const mongodbToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "mongodb"
    ? {}
    : {
        mongosh: {
          service: name,
          cmd: [
            "sh",
            "-c",
            `for arg do case "$arg" in --eval|--eval=*|--json|--json=*|--shell|-f|--file|--file=*|*.js|*.mongodb) exec mongosh --nodb --eval '${connectMongo}' "$@";; esac; done; exec mongosh --nodb --eval '${connectMongo}' --shell "$@"`,
            "mongosh",
          ],
          wrapper: true,
          env: { MONGO_URI: mongoUri(connection.creds, connection.port) },
        },
      };

export const mongodbServiceType: ServiceType = {
  id: "mongodb",
  name: "mongodb",
  base: "lando",
  plannedPort: selectPort,
  extraArgsRemediation: catalogDbExtraArgsRemediation(
    Object.values(ARTIFACTS),
    "Put MongoDB flags in command:, set config.server or port: so Lando owns the launcher, or remove extraArgs.",
  ),
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  toolingForConnection: mongodbToolingForConnection,
  resolve: (input) => {
    return serviceTypeResolve("mongodb", "mongodb service type failed to resolve", () => {
      const creds = credsFor(input, input.service);
      assertListenerConfig(input.service, MONGODB_LISTENER);
      const port = selectPort(input.service);
      return {
        base: "lando",
        connection: { family: "mongodb", creds, port },
        normalizedConfig: {
          ...input.service,
          type: "mongodb",
          creds,
          environment: {
            ...input.service.environment,
            ...familyEnvFor(FAMILY, creds),
          },
        },
        features: [
          databaseVersionFeature("mongo", {
            id: MONGODB_FEATURE_ID,
            service: input.service,
            image: input.service.image ?? DEFAULT_IMAGE,
          }),
        ],
        tooling: mongodbToolingForConnection(ServiceName.make(input.name), {
          family: "mongodb",
          creds,
          port,
        }),
      };
    });
  },
};
