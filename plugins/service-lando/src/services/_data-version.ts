import {
  PortablePath,
  type ServiceConfig,
  ServiceDataVersion,
  canonicalImageReference,
} from "@lando/sdk/schema";
import type { FeatureRef, ServiceFeatureContext } from "@lando/sdk/services";
import { Schema } from "effect";

export const MYSQL_DATA = PortablePath.make("/var/lib/mysql");
export const POSTGRES_DATA = PortablePath.make("/var/lib/postgresql/data");
export const MONGO_DATA = PortablePath.make("/data/db");

const mysqlRefusal = (direction: "downgrade" | "upgrade") => ({
  direction,
  pattern: String.raw`Invalid MySQL server ${direction}: Cannot ${direction} from (?<dataMajor>\d+)(?<dataMinor>\d{2})\d{2} to (?<imageMajor>\d+)(?<imageMinor>\d{2})\d{2}\b`,
});

const contracts = {
  mariadb: {
    target: MYSQL_DATA,
    label: "MariaDB",
    series: {
      depth: 2,
      records: ["mariadb_upgrade_info", "mysql_upgrade_info"].map((file) => ({
        path: PortablePath.make(`${MYSQL_DATA}/${file}`),
        pattern: String.raw`^(\d+\.\d+\.\d+)`,
      })),
      upgrade: "in-place",
    },
    refusals: [],
  },
  mysql: {
    target: MYSQL_DATA,
    label: "MySQL",
    series: {
      depth: 2,
      records: [
        {
          path: PortablePath.make(`${MYSQL_DATA}/mysql_upgrade_history`),
          pattern: String.raw`"version"\s*:\s*"(\d+\.\d+\.\d+)"`,
        },
      ],
      upgrade: "in-place",
    },
    refusals: [mysqlRefusal("downgrade"), mysqlRefusal("upgrade")],
  },
  postgres: {
    target: POSTGRES_DATA,
    label: "PostgreSQL",
    series: {
      depth: 1,
      records: [{ path: PortablePath.make(`${POSTGRES_DATA}/PG_VERSION`), pattern: String.raw`^(\d+)` }],
      upgrade: "unsupported",
    },
    refusals: [
      {
        direction: "compare",
        pattern: String.raw`initialized by PostgreSQL version (?<data>\d+).*this version (?<image>\d+)`,
      },
    ],
  },
  mongo: {
    target: MONGO_DATA,
    label: "MongoDB",
    refusals: [
      {
        direction: "incompatible",
        pattern: "Invalid featureCompatibilityVersion",
        exitCodes: [62],
        hint: "Use MongoDB's supported upgrade sequence: start the old version and use the setFeatureCompatibilityVersion command to set FCV to that version. Upgrade through each required intermediate series (for example, from 7.0 through 8.0 before a later 8.x) and set FCV as required before moving on.",
      },
    ],
  },
} satisfies Record<string, ServiceDataVersion>;

type Repository = keyof typeof contracts;

export const stockDatabaseImage = (service: ServiceConfig, image: string, repository: Repository) => {
  if (service.build !== undefined || service.command !== undefined || service.entrypoint !== undefined)
    return undefined;
  const reference = canonicalImageReference(image);
  return reference.replace(/[:@][^/]*$/u, "") === `docker.io/library/${repository}` ? reference : undefined;
};

export const databaseVersionFeature = (
  repository: Repository,
  input: { readonly id: string; readonly service: ServiceConfig; readonly image: string },
): FeatureRef => {
  const { id, service, image } = input;
  const reference = stockDatabaseImage(service, image, repository);
  if (reference === undefined) return { id };
  const base: ServiceDataVersion = contracts[repository];
  const { series, ...contract } = base;
  const pgdata = service.environment?.PGDATA;
  if (series === undefined || (repository === "postgres" && pgdata !== undefined && pgdata !== base.target))
    return { id, config: { dataVersion: contract } };

  const tag = reference.includes("@") ? undefined : /:([^:@/]+)$/u.exec(reference)?.[1];
  const numericTag = /^(\d+(?:\.\d+)*)(?:-[\w.-]+)?$/u.exec(tag ?? "")?.[1];
  const parts = numericTag?.split(".");
  const version =
    parts !== undefined && parts.length >= series.depth ? parts.slice(0, series.depth).join(".") : undefined;
  return {
    id,
    config: {
      dataVersion: {
        ...contract,
        series: { ...series, ...(version === undefined ? {} : { image: version }) },
      },
    },
  };
};

const isDataVersion = Schema.is(ServiceDataVersion);
export const applyDatabaseVersion = (ctx: ServiceFeatureContext) => {
  const contract = ctx.config.dataVersion;
  if (isDataVersion(contract)) ctx.setDataVersion(contract);
};
