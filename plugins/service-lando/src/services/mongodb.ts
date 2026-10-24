import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "@lando/sdk/expressions";
import { Schema } from "effect";

import {
  type EnvironmentValue,
  PortNumber,
  PortablePath,
  type ServiceConfig,
  type ServiceCreds,
} from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { addEnvRecord, rootIdentity, serviceFeatureApply, serviceTypeResolve } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";
import { mongodbProbes } from "./mongodb-probes.ts";

const DEFAULT_IMAGE = "mongo:7";
const VERSIONS = ["7"] as const;
const ARTIFACTS = { "7": DEFAULT_IMAGE } as const;
const DEFAULT_PORT = 27017;
const DATA_TARGET = PortablePath.make("/data/db");
const FAMILY = "mongodb" as const;
export const MONGODB_FEATURE_ID = "service-lando.mongodb";
export const MONGODB_CONFIG_TARGET = PortablePath.make("/etc/lando/mongod.conf");

const credsFor = (
  input: { readonly appName?: string | undefined; readonly appRoot: string },
  service: ServiceConfig,
): ServiceCreds => {
  const creds = service.creds;
  return resolveServiceCreds({
    family: FAMILY,
    ...(creds === undefined
      ? {}
      : {
          authored: {
            user: creds.user,
            password: creds.password,
            database: creds.database,
            ...(creds.rootPassword === undefined ? {} : { rootPassword: creds.rootPassword }),
          },
        }),
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    defaults: { user: "lando", password: DEFAULT_PASSWORD, database: appNameFor(input) },
    ...(service.database === undefined ? {} : { topLevelDatabase: service.database }),
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
  const appName = appNameFor(ctx);
  const { creds, port } = connectionFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, {
    ...familyEnvFor(FAMILY, creds),
    ...landoDbEnvFor(creds, port),
  });
  ctx.addStorage({
    store: `${appName}-mongodb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });

  const serverConfig = addServerConfigMount(ctx, MONGODB_CONFIG_TARGET);
  if (
    (serverConfig || service.port !== undefined) &&
    service.command === undefined &&
    service.entrypoint === undefined
  ) {
    ctx.setCommand([
      "mongod",
      ...(serverConfig ? ["--config", MONGODB_CONFIG_TARGET] : []),
      "--port",
      String(port),
    ]);
  }

  applyAuthoredProcessFields(ctx);

  const probes = mongodbProbes(port);
  ctx.setHealthcheck(probes.healthcheck);
  ctx.setReadiness(probes.readiness);
};

export const mongodbServiceFeature: ServiceFeatureDefinition = {
  id: MONGODB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
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
          env: { MONGO_URI: mongoUri(connection.creds, connection.port) },
        },
      };

export const mongodbServiceType: ServiceType = {
  id: "mongodb",
  name: "mongodb",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  toolingForConnection: mongodbToolingForConnection,
  resolve: (input) => {
    return serviceTypeResolve("mongodb", "mongodb service type failed to resolve", () => {
      const creds = credsFor(input, input.service);
      const port = PortNumber.make(input.service.port ?? DEFAULT_PORT);
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
        features: [{ id: MONGODB_FEATURE_ID }],
        tooling: mongodbToolingForConnection(ServiceName.make(input.name), {
          family: "mongodb",
          creds,
          port,
        }),
      };
    });
  },
};
