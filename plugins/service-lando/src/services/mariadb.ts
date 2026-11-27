import { DATABASE_FAMILY_LOCAL_CLIENT_ARGS } from "@lando/sdk/database-creds";
import {
  AbsolutePath,
  type Environment,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceCreds,
  type ServiceCredsConfig,
  ServiceName,
  canonicalImageReference,
} from "@lando/sdk/schema";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { dataNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { claimsCreds, familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import {
  MYSQL_FAMILY_EXTRA_ARGS,
  configFileDbExtraArgsRemediation,
  isNonCatalogArtifact,
} from "./_extra-args.ts";
import {
  addEnvRecord,
  commandHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import { assertListenerConfig, primaryPortSelector, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

const DEFAULT_IMAGE = "mariadb:11.4";
const VERSIONS = ["11.4"] as const;
const ARTIFACTS = { "11.4": DEFAULT_IMAGE } as const;
const CATALOG_IMAGES = Object.values(ARTIFACTS);
export const MARIADB_LISTENER = {
  port: 3306,
  variables: ["MYSQL_TCP_PORT"],
  daemon: "MariaDB",
  when: "All MariaDB services",
} as const;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
const GUARD_SCRIPT = `series() { sed -n '1s/^[^0-9]*\\([0-9][0-9]*\\)\\.\\([0-9][0-9]*\\)\\..*/\\1.\\2/p'; }
running=$(mariadbd --version 2>/dev/null | series)
for info in "${DATA_TARGET}/mariadb_upgrade_info" "${DATA_TARGET}/mysql_upgrade_info"; do
  [ -n "$running" ] && [ -f "$info" ] || continue
  data=$(series < "$info")
  [ -n "$data" ] || continue
  if [ "\${data%.*}" -gt "\${running%.*}" ] || { [ "\${data%.*}" -eq "\${running%.*}" ] && [ "\${data#*.}" -gt "\${running#*.}" ]; }; then
    printf "MariaDB %s can't open this data: MariaDB %s already created or upgraded it, and MariaDB doesn't support downgrading data files.\\nTo keep this data, set services.%s.image to mariadb:%s or newer, then run lando start.\\nTo move it to %s, run lando db:export on the newer version, then lando destroy --volumes (this deletes every service's data in the app), switch back, run lando start, and lando db:import the export.\\n" \\
      "$running" "$data" "$LANDO_SERVICE_NAME" "$data" "$running" >&2
    exit 1
  fi
done
exec docker-entrypoint.sh "$@"`;
export const MARIADB_FEATURE_ID = "service-lando.mariadb";
export const MARIADB_CONFIG_TARGET = PortablePath.make("/etc/mysql/conf.d/99-lando.cnf");

const LOCAL_CLIENT_ARGS = DATABASE_FAMILY_LOCAL_CLIENT_ARGS.mariadb;

const MARIADB_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("slow-query"),
    label: "MariaDB slow query log",
    path: AbsolutePath.make("/var/lib/mysql/slow.log"),
    stream: "stderr",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("general-query"),
    label: "MariaDB general query log",
    path: AbsolutePath.make("/var/lib/mysql/general.log"),
    stream: "stdout",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
];

const mariadbCreds = (
  input: {
    readonly appName?: string | undefined;
    readonly dataName?: string | undefined;
    readonly appRoot: string;
  },
  service: {
    readonly creds?: ServiceCredsConfig | undefined;
    readonly environment?: Environment | undefined;
  },
): ServiceCreds => {
  const appName = dataNameFor(input);
  const creds = service.creds;
  return resolveServiceCreds({
    family: "mariadb",
    ...(creds === undefined ? {} : { authored: creds }),
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    defaults: {
      user: "lando",
      password: DEFAULT_PASSWORD,
      database: appName,
      rootPassword: DEFAULT_PASSWORD,
    },
  });
};

const applyMariadbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { creds, port } = connectionFor(ctx);
  const image = service.image ?? DEFAULT_IMAGE;

  ctx.setArtifact({ kind: "ref", ref: image });
  addEnvRecord(ctx, {
    ...familyEnvFor("mariadb", creds),
    ...landoDbEnvFor(creds, port),
    MARIADB_AUTO_UPGRADE: "1",
    MYSQL_TCP_PORT: String(port),
  });
  ctx.addStorage({
    store: ctx.serviceStoreName("mariadb-data"),
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(
    commandHealthcheck(
      [
        "sh",
        "-c",
        `MYSQL_PWD="$MYSQL_PASSWORD" exec mariadb-admin ping -h 127.0.0.1 -P "$1" -u "$MYSQL_USER" ${LOCAL_CLIENT_ARGS.join(" ")} --silent`,
        "mariadb-healthcheck",
        String(port),
      ],
      60,
    ),
  );

  applyAuthoredProcessFields(ctx);

  const processOwned = service.command !== undefined || service.entrypoint !== undefined;
  const serverConfig = addServerConfigMount(ctx, MARIADB_CONFIG_TARGET);
  if (processOwned) return;

  const custom = isNonCatalogArtifact(service, CATALOG_IMAGES);
  const repository = canonicalImageReference(image).replace(/[:@][^/]*$/u, "");
  const official = service.build === undefined && repository === "docker.io/library/mariadb";
  const daemon = ["mariadbd", `--port=${port}`];
  const commandOptions = custom ? undefined : MYSQL_FAMILY_EXTRA_ARGS;
  if (official) {
    ctx.setCommand(["sh", "-c", GUARD_SCRIPT, "lando-mariadb", ...daemon], commandOptions);
  } else if (serverConfig || (!custom && (service.extraArgs?.length ?? 0) > 0)) {
    ctx.setCommand(daemon, commandOptions);
  }
};

export const mariadbServiceFeature: ServiceFeatureDefinition = {
  id: MARIADB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: claimsCreds(MARIADB_FEATURE_ID),
  declareEndpoints: (ctx) =>
    Effect.sync(() => servicePortEndpoints(ctx, { port: connectionFor(ctx).port, protocol: "tcp" })),
  apply: serviceFeatureApply(
    MARIADB_FEATURE_ID,
    "mariadb service feature failed to apply",
    applyMariadbFeature,
  ),
};

const mariadbToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "mariadb"
    ? {}
    : {
        mariadb: {
          description: "Open the MariaDB client for this service.",
          dir: PortablePath.make("/"),
          service: name,
          cmd: [
            "mariadb",
            "-h",
            "127.0.0.1",
            "-P",
            String(connection.port),
            "-u",
            connection.creds.user,
            ...LOCAL_CLIENT_ARGS,
            connection.creds.database,
          ],
          wrapper: true,
          env: { MYSQL_PWD: connection.creds.password },
        },
      };

const selectPort = primaryPortSelector(MARIADB_LISTENER);
export const mariadbServiceType: ServiceType = {
  id: "mariadb",
  name: "mariadb",
  base: "lando",
  plannedPort: selectPort,
  extraArgsRemediation: configFileDbExtraArgsRemediation(CATALOG_IMAGES, "MariaDB"),
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  toolingForConnection: mariadbToolingForConnection,
  resolve: (input) => {
    return serviceTypeResolve("mariadb", "mariadb service type failed to resolve", () => {
      const creds = mariadbCreds(input, input.service);
      const port = selectPort(input.service);
      assertListenerConfig(input.service, MARIADB_LISTENER);
      return {
        base: "lando",
        connection: { family: "mariadb", creds, port },
        normalizedConfig: {
          ...input.service,
          type: "mariadb",
          creds,
          environment: {
            ...input.service.environment,
            ...familyEnvFor("mariadb", creds),
          },
        },
        logSources: MARIADB_LOG_SOURCES,
        features: [{ id: MARIADB_FEATURE_ID }],
        tooling: mariadbToolingForConnection(ServiceName.make(input.name), {
          family: "mariadb",
          creds,
          port,
        }),
      };
    });
  },
};
