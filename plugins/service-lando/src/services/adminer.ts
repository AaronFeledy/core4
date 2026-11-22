import { AppFeatureSelectorMatchedNothingError } from "@lando/sdk/errors";
import { AbsolutePath, type EnvironmentValue, PortablePath, canonicalSqlitePath } from "@lando/sdk/schema";
import { AdminerServiceConfig } from "@lando/sdk/schema/services/adminer";
import type {
  AppFeatureDefinition,
  AppFeatureServiceView,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";
import { Effect } from "effect";

import { adminerPlugin } from "./_adminer-plugin.ts";
import { UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION } from "./_extra-args.ts";
import { serviceFeatureApply, serviceTypeResolve } from "./_feature-helpers.ts";
import { landoImageFilesBuildStep } from "./_image-files.ts";
import {
  assertListenerConfig,
  launcherAuthority,
  primaryPortSelector,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";
import { appMountTarget } from "./_volume-helpers.ts";

const IMAGE = "adminer:6";
const FEATURE_ID = "service-lando.adminer";
const DOCROOT = "/var/www/html";
const PLUGIN_PATH = `${DOCROOT}/plugins-enabled/000-lando.php`;
const launcherSetting = (port: number) => `[::]:${port}`;
export const ADMINER_LISTENER = {
  port: 8080,
  daemon: "Adminer",
  when: "All Adminer services",
  launcher: { setting: (port: number) => `php -S ${launcherSetting(port)}` },
} as const;

export const adminerServiceFeature: ServiceFeatureDefinition = {
  id: FEATURE_ID,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: selectPort(ctx.normalizedConfig),
        protocol: "http",
      }).map((endpoint) => ({ ...endpoint, scan: { path: "/?manifest=1" } })),
    ),
  apply: serviceFeatureApply(FEATURE_ID, "Adminer service feature failed to apply", (ctx) => {
    const service = ctx.normalizedConfig;
    const port = selectPort(service);
    ctx.setArtifact({ kind: "ref", ref: service.image ?? IMAGE });
    ctx.setHealthcheck(tcpProbe(port, 20));
    ctx.setWorkingDirectory(PortablePath.make(service.working_dir ?? DOCROOT));
    if (service.command === undefined) {
      ctx.setCommand([
        "php",
        "-S",
        launcherSetting(port),
        "-t",
        DOCROOT,
        "-d",
        `auto_prepend_file=${PLUGIN_PATH}`,
      ]);
    }
    if (service.command !== undefined || service.entrypoint !== undefined) {
      ctx.setListenerAuthority(launcherAuthority(ADMINER_LISTENER, port));
    }
    applyAuthoredProcessFields(ctx);
    ctx.addBuildStep(
      landoImageFilesBuildStep(FEATURE_ID, [
        {
          path: PLUGIN_PATH,
          content: adminerPlugin,
        },
      ]),
    );
  }),
};

const selectPort = primaryPortSelector(ADMINER_LISTENER);
const makeAdminerServiceType = (id: string): ServiceType => ({
  id,
  name: "adminer",
  base: "lando",
  plannedPort: selectPort,
  extraArgsRemediation: UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION(
    "Adminer",
    "Put flags in command: or remove extraArgs.",
  ),
  versions: ["6"],
  artifacts: { "6": IMAGE },
  identity: {
    defaultUser: "adminer",
    homes: { adminer: "/home/adminer" },
    projectUser: { name: "adminer", uid: 100, gid: 101 },
  },
  schema: AdminerServiceConfig,
  resolve: ({ service }) =>
    serviceTypeResolve(id, "Adminer service type failed to resolve", () => {
      assertListenerConfig(service, ADMINER_LISTENER);
      return {
        base: "lando",
        normalizedConfig: { ...service, type: "adminer", image: service.image ?? IMAGE, appMount: false },
        features: [{ id: FEATURE_ID }],
      };
    }),
});

export const adminerServiceType = makeAdminerServiceType("adminer");
export const adminer6ServiceType = makeAdminerServiceType("adminer:6");

const ENGINES = {
  postgres: { driver: "pgsql", label: "PostgreSQL" },
  mysql: { driver: "server", label: "MySQL" },
  mariadb: { driver: "server", label: "MariaDB" },
} as const;

const discoverTarget = (service: AppFeatureServiceView) => {
  const {
    connection,
    serviceName,
    normalizedConfig: { sqlite, appMount },
  } = service;
  if (sqlite !== undefined && appMount !== false) {
    const mount = appMountTarget(appMount);
    const database = `${mount}/${canonicalSqlitePath(sqlite.path)}`;
    return {
      driver: "sqlite",
      label: `${serviceName} (SQLite: ${database})`,
      host: "",
      user: "",
      database,
      mount,
    };
  }
  if (connection === undefined || connection.family === "mongodb" || connection.family === "mssql") return;
  const { family, creds, port } = connection;
  const { driver, label } = ENGINES[family];
  return {
    driver,
    label: `${serviceName} (${label})`,
    host: `${serviceName}:${port}`,
    user: creds.user,
    database: creds.database,
    password: creds.password,
  };
};

export const adminerWireFeature: AppFeatureDefinition = {
  id: `${FEATURE_ID}.wire`,
  priority: 100,
  activatedBy: { services: { type: "adminer" } },
  apply: Effect.fn("AdminerWireFeature.apply")(function* (ctx) {
    const targets = ctx.selected
      .toSorted((left, right) => left.serviceName.localeCompare(right.serviceName))
      .flatMap((service) => {
        const target = discoverTarget(service);
        return target === undefined ? [] : [{ name: service.serviceName, ...target }];
      });
    if (targets.length === 0) {
      return yield* new AppFeatureSelectorMatchedNothingError({
        message: "Adminer found no browsable database in this app.",
        feature: ctx.featureId,
        remediation: "Add a postgres, mysql, or mariadb service, or declare sqlite.path on an app service.",
      });
    }
    const source = AbsolutePath.make(ctx.appRoot);
    const mounts = [
      ...new Set(targets.flatMap((target) => (target.mount === undefined ? [] : [target.mount]))),
    ];
    const passwords: Record<string, EnvironmentValue> = {};
    const servers = Object.fromEntries(
      targets.map(({ name, password, mount: _mount, ...target }, index) => {
        const passwordEnv = `LANDO_ADMINER_${index}_PASSWORD`;
        if (password !== undefined) passwords[passwordEnv] = password;
        return [name, { ...target, passwordEnv }];
      }),
    );
    ctx.forEachSelected((mutator) => {
      if (mutator.service.serviceType !== "adminer") return;
      mutator.addEnv("LANDO_ADMINER_SERVERS", JSON.stringify(servers));
      for (const [name, password] of Object.entries(passwords)) mutator.addEnv(name, password);
      const [first, ...rest] = mounts;
      if (first !== undefined) {
        mutator.setAppMount({
          source,
          target: PortablePath.make(first),
          readOnly: false,
          excludes: [],
          includes: [],
        });
        for (const target of rest)
          mutator.addMount({ type: "bind", source, target: PortablePath.make(target), readOnly: false });
      }
    });
  }),
};
